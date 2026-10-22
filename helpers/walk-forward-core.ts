// Walk-forward re-optimization of ver6, without node imports so the index page runs the same code as the node tools
// (walk-forward-ver6.ts, live-ver6.ts):
// 1. optimize the options on the `window` candles before t: biggest total with drawdown < maxDrawdown and
//    count > minCount (minCountPer100k scaled to the window, 150 per 100k candles = the original criteria)
// 2. trade forward from t with those options
// 3. when the forward trades hit the break rule, derived from the in-sample trades of step 1,
//    go back to 1 at the candle after that trade
// When no options meet the constraints it sits out `retryGap` candles and tries again.

import { allInOne, DEFAULT_OPTIONS } from './ver6'
import { BacktestResult, RobustRule, SPACE, backtestResult, criteria, isValid, middleOptions, narrowSpace, optimizeOptions } from './optimize-ver6'
import { Params } from './optimizer'


export const WALK_FORWARD_DEFAULTS = {
  coin: 'XMR_USDT',
  interval: 'Min5',
  maxDrawdown: 15,
  minCountPer100k: 200,
  firstEvaluations: 1200,
  nextEvaluations: 500,
  retryGap: 2000,
  anchor: 'defaults' as 'defaults' | 'previous'
}

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
  // what the optimizer's seeds are based on: 'index' (position in the candles, the backtests) or 'time' (candle
  // time, so the bot and the index page get the same seeds whatever candles they start their arrays with)
  seedBy?: 'index' | 'time'
  // live trading: optimize as soon as the window candles exist, so when a segment ends on the latest candle the next
  // one is optimized right away and its options are ready for the next candle
  live?: boolean
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
export async function backtestOrders(candles: any[], from: number, to: number, options: Params) {
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

export const day = (time: number) => new Date(time * 1000).toISOString().slice(0, 10)

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

// picked with `--compare --trust full,0.05,0.1,0.2` on XMR_USDT Min5 (2025-08-10 - 2026-10-14):
// - searching the full SPACE overfits every window, forward drawdowns reached 31 - 58
// - ±5% around DEFAULT_OPTIONS was the only width where all 15 window x break rule setups stayed under
//   drawdown 20 in both halves of the period
// - within ±5%, 50k candles + drawdown break was the best first half result of the result based break rules
export const CHOSEN: Omit<WalkForwardConfig, 'log'> = {
  name: 'chosen',
  window: 50000,
  breakRule: { type: 'drawdown', multiplier: 1 },
  trustRegion: 0.05,
  start: 50000
}

// the optimizeOptions arguments of one re-optimization, shared by the walk-forward and the live runner
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

// backtests params on candles [from, to) of the walk-forward's candles
export type Evaluate = (tasks: Array<{ params: Params, from: number, to: number, parts?: number }>) => Promise<BacktestResult[]>

// where a walk-forward stopped, to continue it later on the same candles plus newer ones (the index page)
export interface WalkForwardResume {
  // index of the next segment's start in the candles
  t: number
  options: Params
  found: boolean
  optimizations: number
  // the segment starting at t is still open: continue it with `options` instead of optimizing at t
  open: boolean
}

// the walk-forward on `candles`; batchSize is the optimizer's batch size (24 = what the node tools use);
// with `resume` it continues an earlier walk-forward on the same candles: same result as running it from the start
export async function walkForwardCandles(candles: any[], config: WalkForwardConfig, evaluate: Evaluate, batchSize = 24, resume?: WalkForwardResume) {
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
    seedBy = 'index',
    live = false,
    log = () => {}
  } = { ...WALK_FORWARD_DEFAULTS, ...config }

  const last = Math.min(end ?? candles.length, candles.length)
  const indexOfTime = new Map<number, number>(candles.map((candle: any, index: number) => [candle.time, index]))
  const minCount = minCountPer100k * window / 100000
  // time of candle i, also of the candles after the last one (a live segment can start on the next candle)
  const candleSeconds = candles[1].time - candles[0].time
  const timeAt = (i: number) => (i < last ? candles[i].time : candles[last - 1].time + (i - last + 1) * candleSeconds)
  // a segment can start at t: live as soon as its window exists, backtests need candles to trade
  const canStart = (i: number) => (live ? i <= last : i < last - 1)

  if (start < window)
    throw new Error(`start (${start}) must be >= window (${window})`)

  const segments: any[] = []
  const trades: any[] = []
  // options outside SPACE (increment, incrementCountMax, emaLen5) always keep their DEFAULT_OPTIONS values
  let options: Params = resume?.options ?? (anchor === 'previous' ? { ...DEFAULT_OPTIONS, ...middleOptions() } : { ...DEFAULT_OPTIONS })
  let found = resume?.found ?? false
  let optimizations = resume?.optimizations ?? 0
  let idleCandles = 0
  let t = resume?.t ?? start
  let continueOpen = resume?.open ?? false

  while (canStart(t)) {
    // 1. optimize on the window before t (unless it continues the open segment of `resume`)
    if (optimize && !continueOpen) {
      const from = t - window
      const args = optimizationArgs(config, { options, found, optimizations })
      const seedBase = seedBy === 'time' ? timeAt(t) : t
      const runs = await Promise.all(Array.from({ length: consensus }, (_, run) => optimizeOptions(
        batch => evaluate(batch.map(params => ({ params, from, to: t, parts: robust?.parts }))),
        { ...args, batchSize, seed: seedBase + seed * 1000003 + run * 7919 }
      )))
      optimizations++

      const passed = runs.filter(run => run.feasible)

      if (!passed.length) {
        const retry = t + retryGap
        const next = Math.min(retry, last)
        log(`${name} ${day(timeAt(t))} no options meet the constraints on the last ${window} candles, sitting out ${retryGap} candles`)
        segments.push({ from: t, to: next, date: day(timeAt(t)), feasible: false })
        idleCandles += next - t
        t = next
        // the retry candle isn't there yet
        if (!canStart(retry))
          break
        continue
      }

      if (passed.length === 1) {
        options = passed[0].options
      } else {
        const { violation } = criteria({ maxDrawdown, minCount, robust })
        options = await consensusOptions(passed.map(run => run.options), async candidate => {
          const [result] = await evaluate([{ params: candidate, from, to: t, parts: robust?.parts }])
          return isValid(candidate) && violation(result) === 0
        })
      }
      found = true
    }

    // the open segment of `resume`, continued instead of optimized
    const continued = continueOpen
    continueOpen = false

    const inSample = tradeStats((await backtestOrders(candles, t - window, t, options)).map((order: any) => order.net))

    // 2. trade forward from t, 3. until the break rule hits (a live segment starting on the next candle has no trades yet)
    const forward = t < last ? (await backtestOrders(candles, t - window, last, options)).filter((order: any) => order.enterTime >= candles[t].time) : []
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
      date: day(timeAt(t)),
      feasible: true,
      options: optimize ? options : undefined,
      inSample,
      forward: segmentStats,
      reason,
      continued
    })

    log(`${name} ${day(timeAt(t))} in-sample ${inSample.count} trades total ${inSample.total.toFixed(1)} dd ${inSample.maxDrawdown.toFixed(1)} | forward ${segmentStats.count} trades ${segmentStats.total >= 0 ? '+' : ''}${segmentStats.total.toFixed(1)} -> ${reason}`)

    t = next
    if (reason === 'end of data')
      break
  }

  // first and second half of the traded period, used to pick a setup on one half and check it on the other
  const middleTime = candles[start + Math.floor((last - start) / 2)].time
  const half = (first: boolean) => tradeStats(trades.filter(order => (order.enterTime < middleTime) === first).map(order => order.net))

  // where to continue on more candles: the still open last segment, else the next optimization (after sitting out:
  // the retry candle, which may be past the end of these candles)
  const lastSegment = segments[segments.length - 1]
  const next: WalkForwardResume = !lastSegment
    ? { t, options, found, optimizations, open: resume?.open ?? false }
    : lastSegment.feasible && lastSegment.reason === 'end of data'
      ? { t: lastSegment.from, options, found, optimizations, open: true }
      : { t: lastSegment.feasible ? t : lastSegment.from + retryGap, options, found, optimizations, open: false }

  return {
    name,
    config: { coin, interval, window, breakRule, start, end: last, maxDrawdown, minCount, firstEvaluations, nextEvaluations, retryGap, optimize, trustRegion, anchor, seed, robust, consensus, seedBy, live },
    period: { from: day(candles[start].time), middle: day(middleTime), to: day(candles[last - 1].time) },
    summary: { ...tradeStats(trades.map(order => order.net)), optimizations, idleCandles, found },
    firstHalf: half(true),
    secondHalf: half(false),
    segments,
    trades,
    resume: next
  }
}

export type WalkForwardResult = Awaited<ReturnType<typeof walkForwardCandles>>

// ---- live: the walk-forward the bot (test.ts) trades and the index page shows ----

// Both continue the same walk-forward from LIVE_START as candles come in: same settings, seeds from candle times and
// a fixed batch size, so with the same candles they re-optimize at the same candles with the same options.
// The earliest start with the window's 50k candles before it (the data begins 2025-02-17 19:10), the same candle the
// backtest comparisons start at
export const LIVE_START = '2025-08-10T09:50:00Z'
export const LIVE_CONFIG: Omit<WalkForwardConfig, 'log'> = { ...CHOSEN, name: 'live', start: CHOSEN.window, seedBy: 'time', live: true }

export interface LiveWalkForward {
  // settings + strategy it was made with, see liveFingerprint
  fingerprint: string
  // where it stopped; tTime is the time of the candle at resume.t, to find it again in a grown candle array
  resume?: WalkForwardResume & { tTime: number }
  // trades of finished segments, the open segment is redone with every update
  closedTrades: Array<{ enterTime: number, exitTime: number, net: number }>
  // start times of the segments, i.e. when it (re-)optimized
  reoptimizations: number[]
  processedThrough: number
}

export const hash = (text: string) => {
  let value = 5381
  for (let i = 0; i < text.length; i++)
    value = (value * 33 + text.charCodeAt(i)) | 0
  return (value >>> 0).toString(36)
}

// the candles the live walk-forward runs on: from `window` candles before LIVE_START, so LIVE_START is candle `window`
export function liveCandles(candles: any[]) {
  const index = candles.findIndex((candle: any) => candle.time >= Date.parse(LIVE_START) / 1000)
  if (index < LIVE_CONFIG.window)
    throw new Error(`the live walk-forward needs ${LIVE_CONFIG.window} candles before ${LIVE_START}${index < 0 ? ' and candles after it' : ''}`)
  return candles.slice(index - LIVE_CONFIG.window)
}

// identifies the settings and the strategy (its trades on the fixed candles before LIVE_START), a saved live
// walk-forward with another fingerprint starts over; `candles` = liveCandles(...)
export async function liveFingerprint(candles: any[]) {
  const defaults = await backtestResult(candles.slice(0, LIVE_CONFIG.window), DEFAULT_OPTIONS)
  return hash(JSON.stringify([LIVE_START, { ...WALK_FORWARD_DEFAULTS, ...LIVE_CONFIG }, SPACE, DEFAULT_OPTIONS, defaults]))
}

export const emptyLiveWalkForward = (fingerprint: string): LiveWalkForward => ({ fingerprint, closedTrades: [], reoptimizations: [], processedThrough: 0 })

// continues the live walk-forward on `candles` (liveCandles of all candles so far, newest last); it only optimizes
// where a segment starts: at LIVE_START and after a drawdown break.
// signal: allInOne of the open segment's options on the latest candle (shouldOpen, currentOrder) for the bot, null when
// that candle isn't traded (the open segment starts on the next candle, or it's sitting out)
export async function advanceLive(candles: any[], state: LiveWalkForward, evaluate: Evaluate, log: (message: string) => void = () => {}) {
  const lastTime = candles[candles.length - 1].time
  const candleSeconds = candles[1].time - candles[0].time
  const timeOf = (i: number) => (i < candles.length ? candles[i].time : lastTime + (i - candles.length + 1) * candleSeconds)

  // the resume point in these candles; if it isn't there, the candles changed and it starts over
  let resume: WalkForwardResume | undefined
  if (state.resume) {
    const { tTime } = state.resume
    const t = tTime > lastTime ? candles.length - 1 + Math.round((tTime - lastTime) / candleSeconds) : candles.findIndex((candle: any) => candle.time === tTime)

    if (t < 0) {
      log(`live: the saved walk-forward doesn't match the candles, starting over from ${LIVE_START}`)
      state = emptyLiveWalkForward(state.fingerprint)
    } else {
      resume = { ...state.resume, t }
    }
  }

  const result = await walkForwardCandles(candles, { ...LIVE_CONFIG, log }, evaluate, 24, resume)
  const open = result.resume.open ? result.segments.length - 1 : -1
  const slim = ({ enterTime, exitTime, net }: any) => ({ enterTime, exitTime, net })
  const { t, options } = result.resume

  const next: LiveWalkForward = {
    fingerprint: state.fingerprint,
    resume: { ...result.resume, tTime: timeOf(t) },
    closedTrades: [...state.closedTrades, ...result.trades.filter((trade: any) => trade.segment !== open).map(slim)],
    reoptimizations: [...state.reoptimizations, ...result.segments.filter((segment: any) => segment.feasible && !segment.continued).map((segment: any) => timeOf(segment.from))],
    processedThrough: lastTime
  }

  return {
    state: next,
    // the open segment (from, inSample = the break level, ...) and its trades so far
    segment: open >= 0 ? { ...result.segments[open], fromTime: timeOf(result.segments[open].from) } : null,
    currentTrades: result.trades.filter((trade: any) => trade.segment === open).map(slim),
    signal: result.resume.open && t < candles.length ? await allInOne(candles.slice(t - LIVE_CONFIG.window), options) : null,
    reoptimized: result.segments.some((segment: any) => !segment.continued)
  }
}
