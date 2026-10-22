// Walk-forward re-optimization of ver6 on backtest processes (the loop itself is in walk-forward-core.ts):
// 1. optimize the options on the `window` candles before t: biggest total with drawdown < maxDrawdown and
//    count > minCount (minCountPer100k scaled to the window, 150 per 100k candles = the original criteria)
// 2. trade forward from t with those options
// 3. when the forward trades hit the break rule, derived from the in-sample trades of step 1,
//    go back to 1 at the candle after that trade
// When no options meet the constraints it sits out `retryGap` candles and tries again.
//
// npm run walk-forward                 runs the chosen setup (CHOSEN in walk-forward-core.ts)
// npm run walk-forward -- --compare    runs every window x break rule plus the baselines

import path from 'path'
import { writeFileSync } from 'fs'
import { parseArgs } from 'util'
import { Pool, createPool, loadCandles } from './backtest-pool'
import { BreakRule, CHOSEN, TradeStats, WALK_FORWARD_DEFAULTS, WalkForwardConfig, WalkForwardResult, walkForwardCandles } from './walk-forward-core'

export * from './walk-forward-core'

export async function walkForward(config: WalkForwardConfig & { pool?: Pool }) {
  const { coin, interval, optimize = true } = { ...WALK_FORWARD_DEFAULTS, ...config }
  const candles = await loadCandles(coin, interval)

  const ownPool = optimize && !config.pool ? createPool() : undefined
  const pool = config.pool ?? ownPool

  try {
    return await walkForwardCandles(
      candles,
      config,
      tasks => pool!.evaluate(tasks.map(({ params, from, to, parts }) => ({ params, slice: { coin, interval, from, to }, parts }))),
      Math.max(8, (pool?.size ?? 1) * 2)
    )
  } finally {
    ownPool?.close()
  }
}

// trustRegions: undefined = search the full SPACE, a number = narrowSpace around the anchor
// anchor 'previous' never uses DEFAULT_OPTIONS (see WalkForwardConfig.anchor) and gives the first, full search more evaluations
export function compareConfigs(start = 50000, trustRegions: Array<number | undefined> = [undefined], anchor: 'defaults' | 'previous' = 'defaults'): Array<Omit<WalkForwardConfig, 'log'>> {
  const configs: Array<Omit<WalkForwardConfig, 'log'>> = [
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
