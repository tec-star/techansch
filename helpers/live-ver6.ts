// Live re-optimization of ver6, done the way the walk-forward CHOSEN setup does it in backtests:
// 1. optimize on the last `window` completed candles (CHOSEN: 50k candles, ±5% around DEFAULT_OPTIONS)
// 2. trade with those options
// 3. once the strategy's trades since step 1 hit the break rule (CHOSEN: forward drawdown >= the in-sample
//    max drawdown), go back to 1 on the latest candles; nothing is traded on the candle that triggered it
// When no options meet the criteria it doesn't trade for `retryGap` candles and then tries again.
// The state is saved to `stateFile`, so a restart keeps the current options and break level.
//
//   const live = createLiveOptimizer()
//   const { result } = await live.update(candles)   // after every completed candle, candles = all candles so far
//   if (result?.shouldOpen) ... result.currentOrder

import { existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { allInOne, DEFAULT_OPTIONS } from './ver6'
import { middleOptions, optimizeVer6 } from './optimize-ver6'
import { Params } from './optimizer'
import { createPool } from './backtest-pool'
import { CHOSEN, TradeStats, WALK_FORWARD_DEFAULTS, WalkForwardConfig, isBroken, netOrders, optimizationArgs, tradeStats } from './walk-forward-ver6'

export interface LiveState {
  // time of the last candle the options were optimized on, trades entered after it count towards the break
  optimizedThrough: number
  // options of the last optimization that met the criteria (DEFAULT_OPTIONS / the middle of SPACE before that)
  options: Params
  // trades of `options` on the optimization candles, the break rule compares the live trades with these
  inSample: TradeStats | null
  // set while sitting out after an optimization found no options that meet the criteria
  sittingOutUntil?: number
  optimizations: number
  found: boolean
  history: Array<{ optimizedThrough: string, reason: string, feasible: boolean, inSample?: TradeStats }>
}

export interface LiveOptimizerOptions {
  config?: Omit<WalkForwardConfig, 'pool' | 'log' | 'start' | 'end'>
  stateFile?: string
  log?: (message: string) => void
}

const iso = (time: number) => new Date(time * 1000).toISOString()

export function createLiveOptimizer({
  config = CHOSEN,
  stateFile = path.join(__dirname, '../data/live-ver6-state.json'),
  log = console.log
}: LiveOptimizerOptions = {}) {
  const { coin, interval, window, breakRule, retryGap, anchor } = { ...WALK_FORWARD_DEFAULTS, ...config }

  if (breakRule.type === 'periodic')
    throw new Error('live re-optimization supports the drawdown, streak, control and never break rules')

  let state: LiveState | null = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null
  const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2))

  if (state)
    log(`live: loaded ${stateFile}, options optimized through ${iso(state.optimizedThrough)}`)

  const reoptimize = async (candles: any[], reason: string) => {
    const to = candles.length
    const from = Math.max(0, to - window)
    // only the fields allInOne reads, these candles are sent to every backtest process
    const windowCandles = candles.slice(from, to).map(({ time, open, high, low, close, volume }: any) => ({ time, open, high, low, close, volume }))
    const optimizedThrough = windowCandles[windowCandles.length - 1].time
    const candleSeconds = windowCandles[windowCandles.length - 1].time - windowCandles[windowCandles.length - 2].time

    const previous: LiveState = state ?? {
      optimizedThrough,
      options: anchor === 'previous' ? { ...DEFAULT_OPTIONS, ...middleOptions() } : { ...DEFAULT_OPTIONS },
      inSample: null,
      optimizations: 0,
      found: false,
      history: []
    }

    if (windowCandles.length < window)
      log(`live: only ${windowCandles.length} candles for a ${window} candle window`)

    log(`live: optimizing on ${windowCandles.length} candles up to ${iso(optimizedThrough)} (${reason})`)
    const startedAt = Date.now()
    const pool = createPool()
    let result: Awaited<ReturnType<typeof optimizeVer6>>

    try {
      await pool.setCandles(coin, interval, windowCandles)
      result = await optimizeVer6({
        ...optimizationArgs(config, previous),
        pool,
        slice: { coin, interval, from: 0, to: windowCandles.length },
        seed: optimizedThrough,
        log: false
      })
    } finally {
      pool.close()
    }

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(0)

    if (!result.feasible) {
      state = {
        ...previous,
        optimizedThrough,
        sittingOutUntil: optimizedThrough + retryGap * candleSeconds,
        optimizations: previous.optimizations + 1,
        history: [...previous.history, { optimizedThrough: iso(optimizedThrough), reason, feasible: false }]
      }
      log(`live: no options meet the criteria (${seconds}s), not trading until ${iso(state.sittingOutUntil!)}`)
      save()
      return
    }

    const inSample = tradeStats(netOrders(await allInOne(windowCandles, result.options)).map((order: any) => order.net))

    state = {
      optimizedThrough,
      options: result.options,
      inSample,
      optimizations: previous.optimizations + 1,
      found: true,
      history: [...previous.history, { optimizedThrough: iso(optimizedThrough), reason, feasible: true, inSample }]
    }
    log(`live: new options (${seconds}s), in-sample ${inSample.count} trades, total ${inSample.total.toFixed(1)}, max drawdown ${inSample.maxDrawdown.toFixed(1)}`)
    save()
  }

  const run = async (candles: any[]) => {
    const latest = candles[candles.length - 1].time

    if (!state) {
      await reoptimize(candles, 'no saved state')
      return { result: null, reoptimized: true }
    }

    if (state.sittingOutUntil !== undefined) {
      if (latest < state.sittingOutUntil)
        return { result: null, reoptimized: false }

      await reoptimize(candles, 'retry after sitting out')
      return { result: null, reoptimized: true }
    }

    // same candles as the walk-forward trades on: from `window` candles before the optimization point onwards
    let end = candles.length - 1
    while (end >= 0 && candles[end].time > state.optimizedThrough)
      end--
    const result = await allInOne(candles.slice(Math.max(0, end + 1 - window)), state.options)

    // trades since the optimization, checked in order like walkForward does
    let equity = 0, peak = 0, lossStreak = 0, count = 0
    for (const order of netOrders(result).filter((order: any) => order.enterTime > state!.optimizedThrough)) {
      count++
      equity += order.net
      peak = Math.max(peak, equity)
      lossStreak = order.net < 0 ? lossStreak + 1 : 0

      if (state.inSample && isBroken(breakRule, state.inSample, { count, total: equity, drawdown: peak - equity, lossStreak })) {
        await reoptimize(candles, `${breakRule.type} break after ${count} trades: drawdown ${(peak - equity).toFixed(1)}, in-sample max ${state.inSample.maxDrawdown.toFixed(1)}`)
        return { result: null, reoptimized: true }
      }
    }

    return { result, reoptimized: false, forward: { count, total: equity, drawdown: peak - equity, lossStreak } }
  }

  // updates run one after another, a candle that arrives during an optimization waits for it
  let queue: Promise<unknown> = Promise.resolve()

  return {
    // result: allInOne on the trading candles with the current options (shouldOpen, currentOrder, ...),
    // null when this candle isn't traded (just optimized, or sitting out)
    update: (candles: any[]) => {
      const job = queue.then(() => run(candles))
      queue = job.catch(() => {})
      return job
    },
    state: () => state
  }
}
