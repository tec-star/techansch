// The live walk-forward of walk-forward-core.ts for the bot (test.ts): the same walk-forward the index page shows,
// continued from LIVE_START as candles come in (LIVE_CONFIG = the walk-forward CHOSEN setup: 50k candle window,
// drawdown break, ±5% around DEFAULT_OPTIONS):
// 1. optimize on the `window` candles before a segment's start
// 2. trade with those options
// 3. once the segment's trades hit the drawdown break, the next segment starts on the next candle: back to 1
// Optimizations run on backtest processes, the walk-forward is saved to `stateFile` so a restart continues it.
//
//   const live = createLiveOptimizer()
//   const { result } = await live.update(candles)   // after every completed candle, candles = all candles so far
//   if (result?.shouldOpen) ... result.currentOrder

import { existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { Pool, createPool } from './backtest-pool'
import { Evaluate, LIVE_CONFIG, LiveWalkForward, WALK_FORWARD_DEFAULTS, advanceLive, emptyLiveWalkForward, liveCandles, liveFingerprint } from './walk-forward-core'

export interface LiveOptimizerOptions {
  stateFile?: string
  log?: (message: string) => void
}

export function createLiveOptimizer({
  stateFile = path.join(__dirname, '../data/live-ver6-state.json'),
  log = console.log
}: LiveOptimizerOptions = {}) {
  const { coin, interval } = { ...WALK_FORWARD_DEFAULTS, ...LIVE_CONFIG }

  let state: LiveWalkForward | null = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null
  let fingerprint: string | undefined

  const run = async (all: any[]) => {
    const candles = liveCandles(all)

    // the candles before LIVE_START don't change, so once per process is enough
    fingerprint ??= await liveFingerprint(candles)
    if (state?.fingerprint !== fingerprint) {
      log(state ? 'live: settings or strategy changed, starting over' : 'live: no saved walk-forward, starting')
      state = emptyLiveWalkForward(fingerprint)
    }

    // backtest processes only start when an optimization is needed
    let pool: Pool | undefined
    const evaluate: Evaluate = async tasks => {
      if (!pool) {
        pool = createPool()
        // the processes backtest these candles, the data file may not have the latest ones
        await pool.setCandles(coin, interval, candles.map(({ time, open, high, low, close, volume }: any) => ({ time, open, high, low, close, volume })))
      }
      return pool.evaluate(tasks.map(({ params, from, to, parts }) => ({ params, slice: { coin, interval, from, to }, parts })))
    }

    try {
      const advanced = await advanceLive(candles, state, evaluate, log)
      state = advanced.state
      writeFileSync(stateFile, JSON.stringify(state, null, 2))

      if (advanced.reoptimized && advanced.segment)
        log(`live: options for the segment from ${new Date(advanced.segment.fromTime * 1000).toISOString()}, re-optimizes when the drawdown reaches ${advanced.segment.inSample.maxDrawdown.toFixed(1)}`)

      // result: allInOne on the latest candle with the current options, null when this candle isn't traded
      return { result: advanced.signal, reoptimized: advanced.reoptimized, segment: advanced.segment, trades: advanced.currentTrades }
    } finally {
      pool?.close()
    }
  }

  // updates run one after another, a candle that arrives during an optimization waits for it
  let queue: Promise<unknown> = Promise.resolve()

  return {
    update: (candles: any[]) => {
      const job = queue.then(() => run(candles))
      queue = job.catch(() => {})
      return job
    },
    state: () => state
  }
}
