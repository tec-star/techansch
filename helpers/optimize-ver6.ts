// The search space and rules for optimizing ver6's aggregated, wt and allInOne options:
// biggest total with drawdown < maxDrawdown and count > minCount.
// No node imports, so the browser (the index page) uses the same code as the node tools:
// optimize-ver6-node.ts runs it on backtest processes and has the `npm run optimize` command.

import { allInOne, DEFAULT_OPTIONS } from './ver6'
import { optimize, Candidate, ParamSpace, Params } from './optimizer'

export interface BacktestResult {
  total: number
  drawdown: number
  count: number
  parts?: number[]
}

type Result = BacktestResult

// allInOne on `candles` reduced to what the optimizer needs; with `parts` also the net total of that many equal
// stretches of the candles (by exit time), the fee is whatever allInOne takes off its total per order
export async function backtestResult(candles: any[], params: Params, parts?: number): Promise<BacktestResult> {
  const { total, drawdown, count, orders } = await allInOne(candles, params)

  if (!parts)
    return { total, drawdown, count }

  const fee = count ? (orders.reduce((sum: number, order: any) => sum + order.pnl, 0) - total) / count : 0
  const first = candles[0].time
  const span = candles[candles.length - 1].time - first + 1
  const totals = new Array(parts).fill(0)

  for (const order of orders)
    totals[Math.min(parts - 1, Math.floor((order.exitTime - first) / span * parts))] += order.pnl - fee

  return { total, drawdown, count, parts: totals }
}

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
export function criteria({ maxDrawdown = 15, minCount = 150, robust }: { maxDrawdown?: number, minCount?: number, robust?: RobustRule } = {}) {
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

export interface OptimizeOptionsArgs {
  // defaults to SPACE
  space?: ParamSpace
  // starting point, missing keys come from DEFAULT_OPTIONS
  start?: Params
  maxDrawdown?: number
  minCount?: number
  robust?: RobustRule
  maxEvaluations?: number
  // params per evaluate call while exploring, changes the search path (the node tools use 24)
  batchSize?: number
  seed?: number
  onImprove?: (best: Candidate<Result>, evaluations: number) => void
  onRestart?: (restarts: number, evaluations: number) => void
}

// optimizes ver6's options with any backtest runner: `evaluate` backtests a batch of params on the optimization
// candles (backtest processes in node, the page itself in the browser)
export async function optimizeOptions(evaluate: (batch: Params[]) => Promise<Result[]>, {
  space = SPACE,
  start = {},
  maxDrawdown = 15,
  minCount = 150,
  robust,
  maxEvaluations = 3000,
  batchSize = 24,
  seed = 1,
  onImprove,
  onRestart
}: OptimizeOptionsArgs = {}) {
  const { violation, objective } = criteria({ maxDrawdown, minCount, robust })

  const { best, evaluations, restarts } = await optimize<Result>({
    space,
    start: { ...DEFAULT_OPTIONS, ...start },
    evaluate,
    objective,
    violation,
    isValid,
    maxEvaluations,
    batchSize,
    seed,
    onImprove,
    onRestart
  })

  const options: Params = { ...DEFAULT_OPTIONS, ...best.params }

  return { options, result: best.result, feasible: best.violation === 0, evaluations, restarts, best }
}
