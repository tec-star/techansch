// Runs ver6 backtests in child processes.
//
// Worker threads share one process and stopped scaling past ~4 threads here: every backtest allocates
// dozens of large arrays and the threads end up waiting on the process' memory allocator.
// Separate processes with a single threaded GC scale to ~12 processes on a 20 thread i7-12700.

import os from 'os'
import { fork, ChildProcess } from 'child_process'
import { getOrders } from './ver6'
import { getKlines } from './price'
import { BacktestResult, backtestResult } from './optimize-ver6'

export type { BacktestResult }

export interface BacktestTask {
  params: Record<string, number>
  // backtest candles [from, to) of a dataset instead of the data getOrders uses
  slice?: { coin: string, interval: string, from: number, to: number }
  // also return the net total of each of `parts` equal stretches of the slice (by exit time)
  parts?: number
}

export const DEFAULT_POOL_SIZE = Math.max(1, Math.min(12, os.cpus().length - 2))

const datasets = new Map<string, any[]>()

export async function loadCandles(coin: string, interval: string): Promise<any[]> {
  const key = `${coin}-${interval}`
  if (!datasets.has(key))
    datasets.set(key, await getKlines(coin, interval, Infinity))
  return datasets.get(key)!
}

export async function runBacktest({ params, slice, parts }: BacktestTask): Promise<BacktestResult> {
  if (!slice) {
    const { total, drawdown, count } = await getOrders(params, false)
    return { total, drawdown, count }
  }

  return backtestResult((await loadCandles(slice.coin, slice.interval)).slice(slice.from, slice.to), params, parts)
}

export function createPool(size = DEFAULT_POOL_SIZE) {
  type Job = { task: BacktestTask, resolve: (result: BacktestResult) => void, reject: (error: Error) => void }

  const idle: ChildProcess[] = []
  const queue: Job[] = []
  const running = new Map<ChildProcess, Job>()
  const loading = new Map<ChildProcess, () => void>()

  const next = () => {
    while (idle.length && queue.length) {
      const child = idle.pop()!
      const job = queue.shift()!
      running.set(child, job)
      child.send(job.task)
    }
  }

  const children = Array.from({ length: size }, () => {
    const child = fork(__filename, [], {
      execArgv: ['--single-threaded-gc', '--max-semi-space-size=64', '-r', require.resolve('ts-node/register')],
      env: {
        ...process.env,
        BACKTEST_POOL_CHILD: '1',
        TS_NODE_TRANSPILE_ONLY: 'true',
        TS_NODE_COMPILER_OPTIONS: '{"module":"commonjs","moduleResolution":"node10"}'
      }
    })

    child.on('message', ({ result, error, loaded }: any) => {
      if (loaded) {
        loading.get(child)?.()
        loading.delete(child)
        return
      }

      const job = running.get(child)!
      running.delete(child)
      error ? job.reject(new Error(error)) : job.resolve(result)
      idle.push(child)
      next()
    })

    child.on('exit', code => {
      running.get(child)?.reject(new Error(`backtest process exited with code ${code}`))
      running.delete(child)
    })

    idle.push(child)
    return child
  })

  return {
    size,
    evaluate: (tasks: BacktestTask[]) => Promise.all(tasks.map(task => new Promise<BacktestResult>((resolve, reject) => {
      queue.push({ task, resolve, reject })
      next()
    }))),
    // replaces the candles every backtest process uses for `coin`/`interval`, e.g. live candles that aren't in the
    // data file yet; slices of later tasks index into these candles. Only while no backtests are running.
    setCandles: (coin: string, interval: string, candles: any[]) => {
      if (running.size || queue.length)
        throw new Error('setCandles while backtests are running')

      return Promise.all(children.map(child => new Promise<void>(resolve => {
        loading.set(child, resolve)
        child.send({ candles: { key: `${coin}-${interval}`, list: candles } })
      })))
    },
    close: () => {
      for (const child of children) {
        child.removeAllListeners('exit')
        child.kill()
      }
    }
  }
}

export type Pool = ReturnType<typeof createPool>

if (process.env.BACKTEST_POOL_CHILD && process.send) {
  process.on('message', async (task: BacktestTask & { candles?: { key: string, list: any[] } }) => {
    if (task.candles) {
      datasets.set(task.candles.key, task.candles.list)
      process.send!({ loaded: true })
      return
    }

    try {
      process.send!({ result: await runBacktest(task) })
    } catch (error: any) {
      process.send!({ error: error?.stack || String(error) })
    }
  })
}
