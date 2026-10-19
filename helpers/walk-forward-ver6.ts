// Walk-forward re-optimization of ver6:
// 1. optimize the options on the `window` candles before t: biggest total with drawdown < maxDrawdown and
//    count > minCount (minCountPer100k scaled to the window, 150 per 100k candles = the original criteria)
// 2. trade forward from t with those options
// 3. when the forward trades hit the break rule, derived from the in-sample trades of step 1,
//    go back to 1 at the candle after that trade
// When no options meet the constraints it sits out `retryGap` candles and tries again.
//
// npm run walk-forward                 runs the chosen setup (CHOSEN below)
// npm run walk-forward -- --compare    runs every window x break rule plus the baselines

import path from 'path'
import { writeFileSync } from 'fs'
import { parseArgs } from 'util'
import { allInOne, DEFAULT_OPTIONS } from './ver6'
import { criteria, isValid, middleOptions, narrowSpace, optimizeVer6, RobustRule, SPACE } from './optimize-ver6'
import { Params } from './optimizer'
import { DEFAULT_POOL_SIZE, Pool, createPool, loadCandles } from './backtest-pool'

export type BreakRule =
  // forward drawdown reaches `multiplier` x the in-sample max drawdown
  | { type: 'drawdown', multiplier: number }
  // more losses in a row than the worst in-sample losing streak
  | { type: 'streak' }
  // forward pnl after n trades falls below n * mean - z * std * sqrt(n) of the in-sample trades
  | { type: 'control', z: number }
  // re-optimize every `candles` candles no matter what (classic walk-forward)
  | { type: 'periodic', candles: number }
  // optimize once
  | { type: 'never' }

export interface WalkForwardConfig {
  name?: string
  coin?: string
  interval?: string
  // candles before t used for each optimization
  window: number
  breakRule: BreakRule
  // index of the first traded candle, defaults to `window`
  start?: number
  end?: number
  maxDrawdown?: number
  minCountPer100k?: number
  firstEvaluations?: number
  // later optimizations start from the previous options, so they need fewer evaluations
  nextEvaluations?: number
  retryGap?: number
  // false trades DEFAULT_OPTIONS without optimizing (baseline)
  optimize?: boolean
  // every optimization may move each option at most this fraction of its SPACE range away from the anchor
  trustRegion?: number
  // 'defaults': start from DEFAULT_OPTIONS and keep the trust region around them
  // 'previous': start from the middle of SPACE, search the full SPACE until the first feasible options,
  //             then keep the trust region around the previous optimization's options (no DEFAULT_OPTIONS involved)
  anchor?: 'defaults' | 'previous'
  // changes the optimizer's random choices (0 = the seeds used so far), to check a result isn't luck
  seed?: number
  // extra rule for every optimization, see RobustRule
  robust?: RobustRule
  // optimizations with different seeds per re-optimization, their per-option median is traded (1 = plain)
  consensus?: number
  pool?: Pool
  log?: (message: string) => void
}

export interface TradeStats {
  count: number
  total: number
  winRate: number
  mean: number
  std: number
  maxDrawdown: number
  maxLossStreak: number
}

export function tradeStats(pnls: number[]): TradeStats {
  let equity = 0, peak = 0, maxDrawdown = 0, streak = 0, maxLossStreak = 0, wins = 0

  for (const pnl of pnls) {
    equity += pnl
    peak = Math.max(peak, equity)
    maxDrawdown = Math.max(maxDrawdown, peak - equity)
    streak = pnl < 0 ? streak + 1 : 0
    maxLossStreak = Math.max(maxLossStreak, streak)
    if (pnl > 0)
      wins++
  }

  const count = pnls.length
  const mean = count ? equity / count : 0
  const std = count > 1 ? Math.sqrt(pnls.reduce((sum, pnl) => sum + (pnl - mean) ** 2, 0) / (count - 1)) : 0

  return { count, total: equity, winRate: count ? wins / count : 0, mean, std, maxDrawdown, maxLossStreak }
}

// orders of an allInOne result with `net` = pnl minus the fee allInOne takes off its total
export function netOrders({ orders, total, count }: { orders: any[], total: number, count: number }) {
  const fee = count ? (orders.reduce((sum: number, order: any) => sum + order.pnl, 0) - total) / count : 0
  return orders.map((order: any) => ({ ...order, net: order.pnl - fee }))
}

// orders of allInOne on candles [from, to) with `net`
async function backtestOrders(candles: any[], from: number, to: number, options: Params) {
  return netOrders(await allInOne(candles.slice(from, to), options))
}

export function isBroken(rule: BreakRule, inSample: TradeStats, forward: { count: number, total: number, drawdown: number, lossStreak: number }) {
  switch (rule.type) {
    case 'drawdown':
      return forward.drawdown > 0 && forward.drawdown >= rule.multiplier * inSample.maxDrawdown
    case 'streak':
      return forward.lossStreak > inSample.maxLossStreak
    case 'control':
      return forward.total < forward.count * inSample.mean - rule.z * inSample.std * Math.sqrt(forward.count)
    default:
      return false
  }
}

const day = (time: number) => new Date(time * 1000).toISOString().slice(0, 10)

// per-option median of several optimizations' results (the lower median for an even count, so it stays on the grid),
// or the result closest to that median when the median itself doesn't pass
async function consensusOptions(list: Params[], passes: (options: Params) => Promise<boolean>) {
  const median: Params = { ...list[0] }
  for (const key of Object.keys(SPACE)) {
    const values = list.map(options => options[key]).sort((a, b) => a - b)
    median[key] = values[Math.floor((values.length - 1) / 2)]
  }

  if (await passes(median))
    return median

  const distance = (options: Params) =>
    Object.entries(SPACE).reduce((sum, [key, { min, max }]) => sum + Math.abs(options[key] - median[key]) / (max - min), 0)

  return list.reduce((best, options) => (distance(options) < distance(best) ? options : best))
}

export const WALK_FORWARD_DEFAULTS = {
  coin: 'XMR_USDT',
  interval: 'Min5',
  maxDrawdown: 20,
  minCountPer100k: 150,
  firstEvaluations: 1200,
  nextEvaluations: 500,
  retryGap: 2000,
  anchor: 'defaults' as 'defaults' | 'previous'
}

// the optimizeVer6 arguments of one re-optimization, shared by walkForward and the live optimizer (live-ver6.ts)
// options: the current options, found: an earlier optimization passed, optimizations: optimizations so far
export function optimizationArgs(config: Omit<WalkForwardConfig, 'breakRule'>, { options, found, optimizations }: { options: Params, found: boolean, optimizations: number }) {
  const { window, trustRegion, anchor, maxDrawdown, minCountPer100k, firstEvaluations, nextEvaluations, robust } = { ...WALK_FORWARD_DEFAULTS, ...config }
  const fullSearch = trustRegion === undefined || (anchor === 'previous' && !found)

  return {
    space: fullSearch ? SPACE : narrowSpace(anchor === 'previous' ? options : DEFAULT_OPTIONS, trustRegion!),
    start: options,
    maxDrawdown,
    minCount: minCountPer100k * window / 100000,
    robust,
    maxEvaluations: !optimizations || (anchor === 'previous' && !found) ? firstEvaluations : nextEvaluations
  }
}

export async function walkForward(config: WalkForwardConfig) {
  const {
    name = 'walk-forward',
    coin,
    interval,
    window,
    breakRule,
    start = window,
    end,
    maxDrawdown,
    minCountPer100k,
    firstEvaluations,
    nextEvaluations,
    retryGap,
    optimize = true,
    trustRegion,
    anchor,
    seed = 0,
    robust,
    consensus = 1,
    log = () => {}
  } = { ...WALK_FORWARD_DEFAULTS, ...config }

  const candles = await loadCandles(coin, interval)
  const last = Math.min(end ?? candles.length, candles.length)
  const indexOfTime = new Map<number, number>(candles.map((candle: any, index: number) => [candle.time, index]))
  const minCount = minCountPer100k * window / 100000

  if (start < window)
    throw new Error(`start (${start}) must be >= window (${window})`)

  const ownPool = optimize && !config.pool ? createPool(DEFAULT_POOL_SIZE) : undefined
  const pool = config.pool ?? ownPool

  const segments: any[] = []
  const trades: any[] = []
  // options outside SPACE (increment, incrementCountMax, emaLen5) always keep their DEFAULT_OPTIONS values
  let options: Params = anchor === 'previous' ? { ...DEFAULT_OPTIONS, ...middleOptions() } : { ...DEFAULT_OPTIONS }
  let found = false
  let optimizations = 0
  let idleCandles = 0
  let t = start

  try {
    while (t < last - 1) {
      // 1. optimize on the window before t
      if (optimize) {
        const slice = { coin, interval, from: t - window, to: t }
        const args = optimizationArgs(config, { options, found, optimizations })
        const runs = await Promise.all(Array.from({ length: consensus }, (_, run) => optimizeVer6({
          ...args,
          pool,
          slice,
          seed: t + seed * 1000003 + run * 7919,
          log: false
        })))
        optimizations++

        const passed = runs.filter(run => run.feasible)

        if (!passed.length) {
          const next = Math.min(t + retryGap, last)
          log(`${name} ${day(candles[t].time)} no options meet the constraints on the last ${window} candles, sitting out ${next - t} candles`)
          segments.push({ from: t, to: next, date: day(candles[t].time), feasible: false })
          idleCandles += next - t
          t = next
          continue
        }

        if (passed.length === 1) {
          options = passed[0].options
        } else {
          const { violation } = criteria({ maxDrawdown, minCount, robust })
          options = await consensusOptions(passed.map(run => run.options), async candidate => {
            const [result] = await pool!.evaluate([{ params: candidate, slice, parts: robust?.parts }])
            return isValid(candidate) && violation(result) === 0
          })
        }
        found = true
      }

      const inSample = tradeStats((await backtestOrders(candles, t - window, t, options)).map((order: any) => order.net))

      // 2. trade forward from t, 3. until the break rule hits
      const forward = (await backtestOrders(candles, t - window, last, options)).filter((order: any) => order.enterTime >= candles[t].time)
      const periodEnd = breakRule.type === 'periodic' ? t + breakRule.candles : Infinity

      let equity = 0, peak = 0, lossStreak = 0, count = 0, lastExit = t - 1
      let next = last
      let reason = 'end of data'

      for (const order of forward) {
        if (indexOfTime.get(order.enterTime)! >= periodEnd)
          break

        count++
        equity += order.net
        peak = Math.max(peak, equity)
        lossStreak = order.net < 0 ? lossStreak + 1 : 0
        lastExit = indexOfTime.get(order.exitTime)!
        trades.push({ ...order, segment: segments.length })

        if (isBroken(breakRule, inSample, { count, total: equity, drawdown: peak - equity, lossStreak })) {
          next = lastExit + 1
          reason = `${breakRule.type} break`
          break
        }
      }

      if (breakRule.type === 'periodic' && reason === 'end of data' && periodEnd < last) {
        next = Math.max(periodEnd, lastExit + 1)
        reason = 'period end'
      }

      const segmentStats = tradeStats(trades.filter(order => order.segment === segments.length).map(order => order.net))
      segments.push({
        from: t,
        to: next,
        date: day(candles[t].time),
        feasible: true,
        options: optimize ? options : undefined,
        inSample,
        forward: segmentStats,
        reason
      })

      log(`${name} ${day(candles[t].time)} in-sample ${inSample.count} trades total ${inSample.total.toFixed(1)} dd ${inSample.maxDrawdown.toFixed(1)} | forward ${segmentStats.count} trades ${segmentStats.total >= 0 ? '+' : ''}${segmentStats.total.toFixed(1)} -> ${reason}`)

      t = next
    }
  } finally {
    ownPool?.close()
  }

  // first and second half of the traded period, used to pick a setup on one half and check it on the other
  const middleTime = candles[start + Math.floor((last - start) / 2)].time
  const half = (first: boolean) => tradeStats(trades.filter(order => (order.enterTime < middleTime) === first).map(order => order.net))

  return {
    name,
    config: { coin, interval, window, breakRule, start, end: last, maxDrawdown, minCount, firstEvaluations, nextEvaluations, retryGap, optimize, trustRegion, anchor, seed, robust, consensus },
    period: { from: day(candles[start].time), middle: day(middleTime), to: day(candles[last - 1].time) },
    summary: { ...tradeStats(trades.map(order => order.net)), optimizations, idleCandles },
    firstHalf: half(true),
    secondHalf: half(false),
    segments,
    trades
  }
}

export type WalkForwardResult = Awaited<ReturnType<typeof walkForward>>

// picked with `--compare --trust full,0.05,0.1,0.2` on XMR_USDT Min5 (2025-08-10 - 2026-10-14):
// - searching the full SPACE overfits every window, forward drawdowns reached 31 - 58
// - ±5% around DEFAULT_OPTIONS was the only width where all 15 window x break rule setups stayed under
//   drawdown 20 in both halves of the period
// - within ±5%, 50k candles + drawdown break was the best first half result of the result based break rules
export const CHOSEN: Omit<WalkForwardConfig, 'pool' | 'log'> = {
  name: 'chosen',
  window: 50000,
  breakRule: { type: 'drawdown', multiplier: 1 },
  trustRegion: 0.05,
  start: 50000
}

// trustRegions: undefined = search the full SPACE, a number = narrowSpace around the anchor
// anchor 'previous' never uses DEFAULT_OPTIONS (see WalkForwardConfig.anchor) and gives the first, full search more evaluations
export function compareConfigs(start = 50000, trustRegions: Array<number | undefined> = [undefined], anchor: 'defaults' | 'previous' = 'defaults'): Array<Omit<WalkForwardConfig, 'pool' | 'log'>> {
  const configs: Array<Omit<WalkForwardConfig, 'pool' | 'log'>> = [
    { name: 'defaults, no optimization', window: 50000, breakRule: { type: 'never' }, start, optimize: false }
  ]

  if (anchor === 'previous')
    configs.push({ ...CHOSEN, name: 'CHOSEN (±5% around defaults)', start })

  for (const trustRegion of trustRegions) {
    for (const window of [20000, 35000, 50000]) {
      const rules: Array<[string, BreakRule]> = [
        ['optimize once', { type: 'never' }],
        [`every ${window / 4} candles`, { type: 'periodic', candles: window / 4 }],
        ['drawdown >= in-sample max', { type: 'drawdown', multiplier: 1 }],
        ['loss streak > in-sample max', { type: 'streak' }],
        ['control limit z=2', { type: 'control', z: 2 }]
      ]

      const region = anchor === 'previous'
        ? (trustRegion === undefined ? 'free, ' : `±${trustRegion * 100}% prev, `)
        : (trustRegion === undefined ? '' : `±${trustRegion * 100}%, `)
      for (const [label, breakRule] of rules)
        configs.push({
          name: `${region}window ${window / 1000}k, ${label}`,
          window,
          breakRule,
          start,
          trustRegion,
          anchor,
          ...(anchor === 'previous' ? { firstEvaluations: 2400 } : {})
        })
    }
  }

  return configs
}

const row = (r: WalkForwardResult) => {
  const cell = (s: TradeStats) => `${s.total.toFixed(1).padStart(7)} ${String(s.count).padStart(4)} ${s.maxDrawdown.toFixed(1).padStart(6)}`
  return `${r.name.padEnd(46)} ${cell(r.summary)} | ${cell(r.firstHalf)} | ${cell(r.secondHalf)} | ${String(r.summary.optimizations).padStart(4)}`
}

const header = `${'setup'.padEnd(46)} ${'total'.padStart(7)} ${'n'.padStart(4)} ${'dd'.padStart(6)} | ${'1st half'.padStart(18)} | ${'2nd half'.padStart(18)} | opts`

if (require.main === module) {
  const { values } = parseArgs({
    options: {
      compare: { type: 'boolean' },
      // comma separated trust regions for --compare, e.g. 0.05,0.15 ("full" = whole SPACE)
      trust: { type: 'string' },
      // 'previous' = no DEFAULT_OPTIONS: start from the middle of SPACE, trust region around the previous options
      anchor: { type: 'string' },
      concurrency: { type: 'string' },
      out: { type: 'string' }
    }
  })

  const outFile = values.out ? path.resolve(values.out) : path.join(__dirname, '../data/walk-forward-ver6.json')

  ;(async () => {
    const pool = createPool()
    const startedAt = Date.now()
    const log = (message: string) => console.log(`[${((Date.now() - startedAt) / 1000).toFixed(0)}s] ${message}`)

    try {
      if (!values.compare) {
        const result = await walkForward({ ...CHOSEN, pool, log })
        writeFileSync(outFile, JSON.stringify(result, null, 2))

        console.log(`\n${result.period.from} - ${result.period.to}`)
        console.log(header)
        console.log(row(result))
        console.log(`\nsegments, trades and options saved to ${outFile}`)
        return
      }

      // runs a few setups at a time so their batches keep every backtest process busy
      const trustRegions = (values.trust ?? 'full').split(',').map(value => (value === 'full' ? undefined : Number(value)))
      const configs = compareConfigs(50000, trustRegions, values.anchor === 'previous' ? 'previous' : 'defaults')
      const results: WalkForwardResult[] = new Array(configs.length)
      let nextConfig = 0
      const runner = async () => {
        while (nextConfig < configs.length) {
          const index = nextConfig++
          results[index] = await walkForward({ ...configs[index], pool, log })
          log(`done: ${row(results[index])}`)
        }
      }
      await Promise.all(Array.from({ length: Number(values.concurrency ?? 3) }, runner))

      // pick on the first half, check on the second half
      const valid = results.filter(r => r.firstHalf.maxDrawdown < 20)
      const pick = (valid.length ? valid : results).reduce((best, r) => (r.firstHalf.total > best.firstHalf.total ? r : best))

      console.log(`\n${results[0].period.from} - ${results[0].period.to}, halves split at ${results[0].period.middle}`)
      console.log(header)
      for (const r of results)
        console.log(row(r) + (r === pick ? '  <- best 1st half' : ''))

      writeFileSync(outFile, JSON.stringify(results.map(({ trades, ...r }) => r), null, 2))
      console.log(`\nreports saved to ${outFile}`)
    } finally {
      pool.close()
    }
  })().catch(error => {
    console.error(error)
    process.exit(1)
  })
}
