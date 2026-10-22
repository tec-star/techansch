// Runs optimizeOptions (optimize-ver6.ts) on backtest processes, and the `npm run optimize` command:
// biggest total with drawdown < maxDrawdown and count > minCount on the data getOrders uses.
//
// npm run optimize -- --evals 3000 --workers 12 --seed 1 --max-drawdown 15 --min-count 150

import { writeFileSync } from 'fs'
import path from 'path'
import { parseArgs } from 'util'
import { DEFAULT_OPTIONS } from './ver6'
import { Candidate, ParamSpace, Params } from './optimizer'
import { BacktestResult, RobustRule, SPACE, optimizeOptions } from './optimize-ver6'
import { BacktestTask, DEFAULT_POOL_SIZE, Pool, createPool, runBacktest } from './backtest-pool'

type Result = BacktestResult

export interface OptimizeVer6Options {
  // defaults to SPACE
  space?: ParamSpace
  maxDrawdown?: number
  minCount?: number
  robust?: RobustRule
  maxEvaluations?: number
  // backtest processes, 0 runs everything in this process; ignored when `pool` is given
  workers?: number
  // reuse an existing pool (the walk-forward runs many optimizations)
  pool?: Pool
  // optimize on these candles instead of the data getOrders uses
  slice?: BacktestTask['slice']
  // starting point, missing keys come from DEFAULT_OPTIONS
  start?: Params
  seed?: number
  // writes the best options found so far after every improvement
  outFile?: string
  log?: boolean
}

export async function optimizeVer6({
  space = SPACE,
  maxDrawdown = 15,
  minCount = 150,
  maxEvaluations = 3000,
  workers = DEFAULT_POOL_SIZE,
  pool,
  slice,
  start = {},
  seed = 1,
  outFile,
  robust,
  log = true
}: OptimizeVer6Options = {}) {
  if (robust && !slice)
    throw new Error('robust needs a slice')

  const ownPool = !pool && workers > 0 ? createPool(workers) : undefined
  const activePool = pool ?? ownPool

  const evaluate = async (batch: Params[]) => {
    const tasks = batch.map(params => ({ params, slice, parts: robust?.parts }))
    if (activePool)
      return activePool.evaluate(tasks)

    const results: Result[] = []
    for (const task of tasks)
      results.push(await runBacktest(task))
    return results
  }

  const startedAt = Date.now()
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(0)}s`

  const save = (best: Candidate<Result>, evaluations: number) => {
    if (!outFile)
      return

    writeFileSync(outFile, JSON.stringify({
      options: { ...DEFAULT_OPTIONS, ...best.params },
      result: best.result,
      feasible: best.violation === 0,
      constraints: { maxDrawdown, minCount, robust },
      evaluations,
      seed,
      date: new Date().toISOString()
    }, null, 2))
  }

  try {
    const { best, options, result, feasible, evaluations, restarts } = await optimizeOptions(evaluate, {
      space,
      start,
      maxDrawdown,
      minCount,
      robust,
      maxEvaluations,
      batchSize: Math.max(8, (activePool?.size ?? 1) * 2),
      seed,
      onImprove: (best, evaluations) => {
        const { total, count, drawdown } = best.result
        if (log)
          console.log(`[${evaluations} evals, ${elapsed()}] total=${total.toFixed(2)} count=${count} drawdown=${drawdown.toFixed(2)} ${best.violation === 0 ? 'feasible' : `violation=${best.violation.toFixed(3)}`}`)
        save(best, evaluations)
      },
      onRestart: (restarts, evaluations) => {
        if (log)
          console.log(`[${evaluations} evals, ${elapsed()}] local optimum, restart #${restarts}`)
      }
    })

    save(best, evaluations)

    return { options, result, feasible, evaluations, restarts, outFile }
  } finally {
    ownPool?.close()
  }
}

if (require.main === module) {
  const { values } = parseArgs({
    options: {
      evals: { type: 'string' },
      workers: { type: 'string' },
      seed: { type: 'string' },
      'max-drawdown': { type: 'string' },
      'min-count': { type: 'string' },
      out: { type: 'string' }
    }
  })

  const number = (value: string | undefined) => (value === undefined ? undefined : Number(value))

  optimizeVer6({
    maxEvaluations: number(values.evals),
    workers: number(values.workers),
    seed: number(values.seed),
    maxDrawdown: number(values['max-drawdown']),
    minCount: number(values['min-count']),
    outFile: values.out ? path.resolve(values.out) : path.join(__dirname, '../data/ver6-optimized.json')
  }).then(({ options, result, feasible, evaluations, restarts, outFile }) => {
    console.log(`\ndone: ${evaluations} evaluations, ${restarts} restarts`)
    console.log(feasible ? 'best feasible result:' : 'no feasible result found, closest one:', result)

    console.log('\nchanged options (default -> optimized):')
    for (const key of Object.keys(SPACE)) {
      const before = (DEFAULT_OPTIONS as Params)[key]
      if (before !== options[key])
        console.log(`  ${key}: ${before} -> ${options[key]}`)
    }

    console.log(`\nfull options saved to ${outFile}`)
  }).catch(error => {
    console.error(error)
    process.exit(1)
  })
}
