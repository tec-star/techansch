// Optimizes the aggregated, wt and allInOne options of ver6 for getOrders:
// biggest total with drawdown < maxDrawdown and count > minCount.
//
// npm run optimize -- --evals 3000 --workers 18 --seed 1 --max-drawdown 20 --min-count 150

import os from 'os'
import { writeFileSync } from 'fs'
import path from 'path'
import { parseArgs } from 'util'
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads'
import { DEFAULT_OPTIONS, getOrders } from './ver6'
import { optimize, Candidate, ParamSpace, Params } from './optimizer'

type Result = Awaited<ReturnType<typeof getOrders>>

// left out, so they keep their DEFAULT_OPTIONS values:
// - emaLen5: ver6 computes ema5 but no signal uses it
// - increment, incrementCountMax: position sizing is fixed on purpose
export const SPACE: ParamSpace = {
  // aggregated
  emaLen1: { min: 2, max: 30, step: 1 },
  emaLen2: { min: 5, max: 80, step: 1 },
  emaLen3: { min: 10, max: 200, step: 5 },
  emaLen4: { min: 30, max: 500, step: 5 },
  rsiLen: { min: 5, max: 120, step: 1 },
  macdFastLen: { min: 3, max: 40, step: 1 },
  macdSlowLen: { min: 8, max: 100, step: 1 },
  macdSiglLen: { min: 2, max: 30, step: 1 },
  volAvgLen: { min: 5, max: 100, step: 1 },
  obvEmaLen: { min: 2, max: 60, step: 1 },
  bbLen: { min: 5, max: 80, step: 1 },
  bbMul: { min: 1, max: 4, step: 0.1 },
  atrLen: { min: 20, max: 1000, step: 20 },
  emaUpCoeff: { min: 1, max: 1.012, step: 0.0005 },
  emaDownCoeff: { min: 0.988, max: 1, step: 0.0005 },
  rsiUpLimit: { min: 55, max: 95, step: 1 },
  rsiDownLimit: { min: 5, max: 45, step: 1 },
  rsiStartLimit: { min: 40, max: 60, step: 1 },
  macdUpCoeff: { min: 0.8, max: 1.6, step: 0.02 },
  macdDownCoeff: { min: 0.4, max: 1.2, step: 0.02 },
  volAvgCoeff: { min: 1, max: 5, step: 0.1 },
  bbWidthLimit: { min: 0.005, max: 0.1, step: 0.001 },
  bbUpLimit: { min: 0.98, max: 1.02, step: 0.001 },
  bbDownLimit: { min: 0.98, max: 1.02, step: 0.001 },
  // absolute ATR in price units (XMR 5m ATR(560) is ~0.6 - 4.7)
  atrLimit: { min: 0.5, max: 5, step: 0.05 },

  // wt
  n1: { min: 3, max: 40, step: 1 },
  n2: { min: 5, max: 60, step: 1 },
  obLevel: { min: 10, max: 100, step: 1 },
  osLevel: { min: -100, max: -10, step: 1 },
  ciCoeff: { min: 0.005, max: 0.05, step: 0.0005 },
  wt2Coeff: { min: 2, max: 12, step: 1 },

  // allInOne
  validGap: { min: 0, max: 60, step: 1 },
  limit: { min: 0.5, max: 8, step: 0.1 }
}

// keeps the indicators meaningful: fast < slow lengths, ordered rsi levels, os below ob
export const isValid = (p: Params) =>
  p.emaLen1 < p.emaLen2 && p.emaLen2 < p.emaLen3 && p.emaLen3 < p.emaLen4 &&
  p.macdFastLen < p.macdSlowLen &&
  p.rsiDownLimit < p.rsiStartLimit && p.rsiStartLimit < p.rsiUpLimit &&
  p.osLevel < p.obLevel

// runs getOrders in worker threads, each worker loads ts-node and this file again
function createPool(size: number) {
  const code = `
    require(${JSON.stringify(require.resolve('ts-node'))}).register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } })
    require(${JSON.stringify(__filename)})
  `

  type Task = { params: Params, resolve: (result: Result) => void, reject: (error: Error) => void }

  const idle: Worker[] = []
  const queue: Task[] = []
  const running = new Map<Worker, Task>()

  const next = () => {
    while (idle.length && queue.length) {
      const worker = idle.pop()!
      const task = queue.shift()!
      running.set(worker, task)
      worker.postMessage(task.params)
    }
  }

  const workers = Array.from({ length: size }, () => {
    const worker = new Worker(code, { eval: true, workerData: { optimizeVer6Worker: true } })

    worker.on('message', ({ result, error }) => {
      const task = running.get(worker)!
      running.delete(worker)
      error ? task.reject(new Error(error)) : task.resolve(result)
      idle.push(worker)
      next()
    })

    worker.on('error', error => {
      running.get(worker)?.reject(error)
      running.delete(worker)
    })

    idle.push(worker)
    return worker
  })

  return {
    evaluate: (batch: Params[]) => Promise.all(batch.map(params => new Promise<Result>((resolve, reject) => {
      queue.push({ params, resolve, reject })
      next()
    }))),
    close: () => Promise.all(workers.map(worker => worker.terminate()))
  }
}

export async function optimizeVer6({
  maxDrawdown = 20,
  minCount = 150,
  maxEvaluations = 3000,
  workers = Math.max(1, os.cpus().length - 2),
  seed = 1,
  outFile = path.join(__dirname, '../data/ver6-optimized.json'),
  log = true
} = {}) {
  const isFeasible = (r: Result) => r.drawdown < maxDrawdown && r.count > minCount

  const violation = (r: Result) => {
    if (isFeasible(r))
      return 0

    return (
      (r.drawdown >= maxDrawdown ? (r.drawdown - maxDrawdown) / maxDrawdown + 1e-9 : 0) +
      (r.count <= minCount ? (minCount + 1 - r.count) / minCount : 0)
    )
  }

  const pool = workers > 0 ? createPool(workers) : undefined
  const evaluate = pool
    ? pool.evaluate
    : async (batch: Params[]) => {
      const results: Result[] = []
      for (const params of batch)
        results.push(await getOrders(params, false))
      return results
    }

  const startedAt = Date.now()
  const elapsed = () => `${((Date.now() - startedAt) / 1000).toFixed(0)}s`

  const save = (best: Candidate<Result>, evaluations: number) => {
    writeFileSync(outFile, JSON.stringify({
      options: { ...DEFAULT_OPTIONS, ...best.params },
      result: best.result,
      feasible: best.violation === 0,
      constraints: { maxDrawdown, minCount },
      evaluations,
      seed,
      date: new Date().toISOString()
    }, null, 2))
  }

  try {
    const { best, evaluations, restarts } = await optimize<Result>({
      space: SPACE,
      start: DEFAULT_OPTIONS,
      evaluate,
      objective: r => r.total,
      violation,
      isValid,
      maxEvaluations,
      batchSize: Math.max(8, workers * 2),
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

    const options: Params = { ...DEFAULT_OPTIONS, ...best.params }

    return {
      options,
      result: best.result,
      feasible: best.violation === 0,
      evaluations,
      restarts,
      outFile
    }
  } finally {
    await pool?.close()
  }
}

if (!isMainThread && workerData?.optimizeVer6Worker) {
  parentPort!.on('message', async (params: Params) => {
    try {
      const { total, drawdown, count } = await getOrders(params, false)
      parentPort!.postMessage({ result: { total, drawdown, count } })
    } catch (error: any) {
      parentPort!.postMessage({ error: error?.stack || String(error) })
    }
  })
}

if (isMainThread && require.main === module) {
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
    outFile: values.out && path.resolve(values.out)
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
