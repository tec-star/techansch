// Optimizes the aggregated, wt and allInOne options of ver6 for getOrders:
// biggest total with drawdown < maxDrawdown and count > minCount.
//
// npm run optimize -- --evals 3000 --workers 12 --seed 1 --max-drawdown 20 --min-count 150

import { writeFileSync } from 'fs'
import path from 'path'
import { parseArgs } from 'util'
import { DEFAULT_OPTIONS } from './ver6'
import { optimize, Candidate, ParamSpace, Params } from './optimizer'
import { BacktestResult, BacktestTask, DEFAULT_POOL_SIZE, Pool, createPool, runBacktest } from './backtest-pool'

type Result = BacktestResult

// left out, so they keep their DEFAULT_OPTIONS values:
// - emaLen5: ver6 computes ema5 but no signal uses it
// - increment, incrementCountMax: position sizing is fixed on purpose
export const SPACE: ParamSpace = {
  // aggregated
  emaLen1: { min: 5, max: 10, step: 1 },
  emaLen2: { min: 10, max: 50, step: 2 },
  emaLen3: { min: 20, max: 120, step: 5 },
  emaLen4: { min: 60, max: 300, step: 10 },
  rsiLen: { min: 8, max: 80, step: 2 },
  macdFastLen: { min: 3, max: 24, step: 1 },
  macdSlowLen: { min: 8, max: 60, step: 2 },
  macdSiglLen: { min: 2, max: 20, step: 1 },
  volAvgLen: { min: 12, max: 64, step: 4 },
  obvEmaLen: { min: 4, max: 32, step: 2 },
  bbLen: { min: 12, max: 64, step: 2 },
  bbMul: { min: 1.6, max: 3.2, step: 0.1 },
  atrLen: { min: 320, max: 840, step: 40 },
  emaUpCoeff: { min: 1, max: 1.008, step: 0.001 },
  emaDownCoeff: { min: 0.992, max: 1, step: 0.001 },
  rsiUpLimit: { min: 55, max: 85, step: 5 },
  rsiDownLimit: { min: 5, max: 35, step: 5 },
  rsiStartLimit: { min: 40, max: 60, step: 5 },
  macdUpCoeff: { min: 1, max: 1.2, step: 0.02 },
  macdDownCoeff: { min: 0.8, max: 1, step: 0.02 },
  volAvgCoeff: { min: 1.6, max: 3, step: 0.1 },
  bbWidthLimit: { min: 0.03, max: 0.07, step: 0.001 },
  bbUpLimit: { min: 0.98, max: 1.02, step: 0.001 },
  bbDownLimit: { min: 0.98, max: 1.02, step: 0.001 },
  // absolute ATR in price units (XMR 5m ATR(560) is ~0.6 - 4.7)
  atrLimit: { min: 0.8, max: 3.2, step: 0.1 },

  // wt
  n1: { min: 6, max: 24, step: 1 },
  n2: { min: 12, max: 48, step: 1 },
  obLevel: { min: 40, max: 80, step: 1 },
  osLevel: { min: -80, max: -40, step: 1 },
  ciCoeff: { min: 0.005, max: 0.03, step: 0.001 },
  wt2Coeff: { min: 2, max: 6, step: 1 },

  // allInOne
  validGap: { min: 0, max: 20, step: 1 },
  limit: { min: 0.5, max: 3.6, step: 0.1 }
}

// keeps the indicators meaningful: fast < slow lengths, ordered rsi levels, os below ob
// options left out of the space are checked with their DEFAULT_OPTIONS values
export const isValid = (params: Params) => {
  const p: Params = { ...DEFAULT_OPTIONS, ...params }
  return (
    p.emaLen1 < p.emaLen2 && p.emaLen2 < p.emaLen3 && p.emaLen3 < p.emaLen4 &&
    p.macdFastLen < p.macdSlowLen &&
    p.rsiDownLimit < p.rsiStartLimit && p.rsiStartLimit < p.rsiUpLimit &&
    p.osLevel < p.obLevel
  )
}

// the middle grid value of every param, a starting point that doesn't depend on DEFAULT_OPTIONS
export function middleOptions(space: ParamSpace = SPACE): Params {
  const result: Params = {}

  for (const [key, { min, max, step }] of Object.entries(space)) {
    const digits = Math.max(String(step).split('.')[1]?.length ?? 0, String(min).split('.')[1]?.length ?? 0)
    result[key] = Number((min + Math.round((max - min) / step / 2) * step).toFixed(digits))
  }

  return result
}

// SPACE narrowed to `fraction` of each param's range on both sides of `center` (kept on the grid),
// 0 fixes the param at its center value
export function narrowSpace(center: Params, fraction: number, space: ParamSpace = SPACE): ParamSpace {
  const result: ParamSpace = {}

  for (const [key, { min, max, step }] of Object.entries(space)) {
    const value = center[key]
    const steps = Math.floor(fraction * (max - min) / step + 1e-9)
    const digits = Math.max(String(step).split('.')[1]?.length ?? 0, String(value).split('.')[1]?.length ?? 0)
    result[key] = {
      min: Math.max(min, Number((value - steps * step).toFixed(digits))),
      max: Math.min(max, Number((value + steps * step).toFixed(digits))),
      step
    }
  }

  return result
}

// splits the optimization candles into `parts` equal stretches (needs `slice`):
// - 'every-part-profitable': options only pass when every stretch makes a net profit, the biggest total still wins
// - 'worst-part': the objective is the worst stretch's profit (x parts, to stay on the scale of a total)
export interface RobustRule {
  parts: number
  rule: 'every-part-profitable' | 'worst-part'
}

// what the optimizer checks: violation 0 = options pass, objective = value to maximize
export function criteria({ maxDrawdown = 20, minCount = 150, robust }: { maxDrawdown?: number, minCount?: number, robust?: RobustRule } = {}) {
  const violation = (r: Result) => {
    const parts = robust?.rule === 'every-part-profitable' ? r.parts ?? [] : []

    return (
      (r.drawdown >= maxDrawdown ? (r.drawdown - maxDrawdown) / maxDrawdown + 1e-9 : 0) +
      (r.count <= minCount ? (minCount + 1 - r.count) / minCount : 0) +
      parts.reduce((sum, part) => sum + (part > 0 ? 0 : (1 - part) / maxDrawdown), 0)
    )
  }

  const objective = (r: Result) => (robust?.rule === 'worst-part' && r.parts ? Math.min(...r.parts) * r.parts.length : r.total)

  return { violation, objective }
}

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
  maxDrawdown = 20,
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

  const { violation, objective } = criteria({ maxDrawdown, minCount, robust })

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
    const { best, evaluations, restarts } = await optimize<Result>({
      space,
      start: { ...DEFAULT_OPTIONS, ...start },
      evaluate,
      objective,
      violation,
      isValid,
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
