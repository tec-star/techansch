// The backtest runner for walk-forward-core.ts in the browser (the index page): the backtests run in the page one at
// a time, and the browser gets a turn between them so the page stays responsive.

import { BacktestResult, backtestResult } from './optimize-ver6'
import { Evaluate } from './walk-forward-core'

// a zero delay turn for the browser (setTimeout waits at least 4ms once nested)
const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null
const nextTurn = () => new Promise<void>(resolve => {
  if (!channel)
    return setTimeout(resolve, 0)

  channel.port1.onmessage = () => resolve()
  channel.port2.postMessage(0)
})

// `evaluate` for walkForwardCandles on `candles`, onBacktest is called after every backtest
export function browserEvaluate(candles: any[], onBacktest: () => void = () => {}): Evaluate {
  return async tasks => {
    const results: BacktestResult[] = []

    for (const { params, from, to, parts } of tasks) {
      results.push(await backtestResult(candles.slice(from, to), params, parts))
      onBacktest()
      await nextTurn()
    }

    return results
  }
}
