// Generic parameter optimizer.
//
// Maximizes objective(result) subject to violation(result) === 0 (all constraints met).
// Candidates are compared with the feasibility rule: lower violation wins, then higher objective,
// so the search is pulled towards the feasible region first and then climbs the objective inside it.
//
// 1. exploration: random points in the space mixed with perturbations of the best point so far
// 2. pattern search: from the best point try every param +/- delta (delta starts at ~16% of the
//    param range and halves down to one step), move to the best improving neighbour (or to the
//    combination of all improving moves when that is even better)
// 3. at a local optimum restart from a perturbation of the global best until the budget is spent

export interface ParamRange {
  min: number
  max: number
  step: number
}

export type ParamSpace = Record<string, ParamRange>
export type Params = Record<string, number>

export interface Candidate<R> {
  params: Params
  result: R
  objective: number
  violation: number
}

export interface OptimizeConfig<R> {
  space: ParamSpace
  // starting point, e.g. the current defaults; missing keys start in the middle of their range
  start?: Params
  // evaluates a batch of params, results must be in the same order (lets the caller run them in parallel)
  evaluate: (batch: Params[]) => Promise<R[]>
  // value to maximize
  objective: (result: R) => number
  // 0 when the result satisfies all constraints, otherwise how far it is from satisfying them
  violation?: (result: R) => number
  // rejects param combinations before they are evaluated
  isValid?: (params: Params) => boolean
  maxEvaluations?: number
  // share of the budget used for the exploration phase
  explorationRatio?: number
  batchSize?: number
  seed?: number
  onImprove?: (best: Candidate<R>, evaluations: number) => void
  onRestart?: (restarts: number, evaluations: number) => void
}

export interface OptimizeResult<R> {
  best: Candidate<R>
  evaluations: number
  restarts: number
}

// small seeded PRNG so runs are reproducible
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function decimals(value: number) {
  const text = String(value)
  return text.includes('.') ? text.split('.')[1].length : 0
}

export function isBetter<R>(a: Candidate<R>, b: Candidate<R>) {
  if (a.violation !== b.violation)
    return a.violation < b.violation

  return a.objective > b.objective
}

export async function optimize<R>(config: OptimizeConfig<R>): Promise<OptimizeResult<R>> {
  const {
    space,
    start = {},
    evaluate,
    objective,
    violation = () => 0,
    isValid = () => true,
    maxEvaluations = 2000,
    explorationRatio = 0.2,
    batchSize = 32,
    seed = 1,
    onImprove,
    onRestart
  } = config

  const keys = Object.keys(space)
  const random = mulberry32(seed)

  // number of steps between min and max of each param
  const gridSize: Record<string, number> = {}
  const precision: Record<string, number> = {}
  for (const key of keys) {
    const { min, max, step } = space[key]
    gridSize[key] = Math.floor((max - min) / step + 1e-9)
    precision[key] = Math.max(decimals(step), decimals(min))
  }

  const valueAt = (key: string, index: number) => {
    const { min, step } = space[key]
    index = Math.min(gridSize[key], Math.max(0, index))
    return Number((min + index * step).toFixed(precision[key]))
  }

  const indexOf = (key: string, value: number) => Math.round((value - space[key].min) / space[key].step)

  const snap = (params: Params) => {
    const result: Params = {}
    for (const key of keys)
      result[key] = valueAt(key, indexOf(key, params[key] ?? (space[key].min + space[key].max) / 2))
    return result
  }

  const keyOf = (params: Params) => keys.map(key => params[key]).join('|')

  const randomInt = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))

  const randomParams = () => {
    const params: Params = {}
    for (const key of keys)
      params[key] = valueAt(key, randomInt(0, gridSize[key]))
    return params
  }

  // moves roughly a third of the params by up to `strength` of their range
  const perturb = (params: Params, strength: number) => {
    const result = { ...params }
    const forced = keys[randomInt(0, keys.length - 1)]

    for (const key of keys) {
      if (key !== forced && random() > 1 / 3)
        continue

      const maxShift = Math.max(1, Math.round(strength * gridSize[key]))
      const shift = randomInt(1, maxShift) * (random() < 0.5 ? -1 : 1)
      result[key] = valueAt(key, indexOf(key, params[key]) + shift)
    }

    return result
  }

  // retries a generator until it returns valid params
  const sample = (generate: () => Params) => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const params = snap(generate())
      if (isValid(params))
        return params
    }
    return undefined
  }

  const cache = new Map<string, Candidate<R>>()
  let best: Candidate<R> | undefined
  let evaluations = 0
  let restarts = 0

  // evaluates new params (skipping invalid and already evaluated ones), returns candidates for every valid input
  const run = async (list: Array<Params | undefined>) => {
    const fresh: Params[] = []
    const freshKeys = new Set<string>()
    const requested: string[] = []

    for (const item of list) {
      if (!item)
        continue

      const params = snap(item)
      if (!isValid(params))
        continue

      const key = keyOf(params)
      requested.push(key)

      if (!cache.has(key) && !freshKeys.has(key) && evaluations + fresh.length < maxEvaluations) {
        fresh.push(params)
        freshKeys.add(key)
      }
    }

    if (fresh.length) {
      const results = await evaluate(fresh)
      evaluations += fresh.length

      fresh.forEach((params, index) => {
        const result = results[index]
        const value = objective(result)
        const candidate: Candidate<R> = {
          params,
          result,
          objective: Number.isFinite(value) ? value : -Infinity,
          violation: violation(result)
        }

        cache.set(keyOf(params), candidate)

        if (!best || isBetter(candidate, best)) {
          best = candidate
          onImprove?.(best, evaluations)
        }
      })
    }

    return {
      fresh: fresh.length,
      candidates: requested.filter(key => cache.has(key)).map(key => cache.get(key)!)
    }
  }

  const pickBest = (candidates: Candidate<R>[]) =>
    candidates.reduce<Candidate<R> | undefined>((result, item) => (!result || isBetter(item, result) ? item : result), undefined)

  // 1. exploration
  await run([sample(() => ({ ...start }))])
  if (!best)
    await run([sample(randomParams)])

  const explorationBudget = Math.floor(maxEvaluations * explorationRatio)
  let idle = 0
  while (evaluations < explorationBudget && idle < 20) {
    const batch: Array<Params | undefined> = []
    for (let i = 0; i < batchSize && evaluations + batch.length < explorationBudget; i++)
      batch.push(best && random() < 0.5 ? sample(() => perturb(best!.params, 0.15)) : sample(randomParams))

    const { fresh } = await run(batch)
    idle = fresh ? 0 : idle + 1
  }

  if (!best)
    throw new Error('No valid params found, check the param space and isValid')

  // 2. pattern search with restarts
  let current: Candidate<R> = best
  let fraction = 0.16
  idle = 0

  while (evaluations < maxEvaluations && idle < 50) {
    const deltas: Record<string, number> = {}
    for (const key of keys)
      deltas[key] = Math.max(1, Math.round(fraction * gridSize[key]))

    const neighbours: Params[] = []
    for (const key of keys) {
      const index = indexOf(key, current.params[key])
      neighbours.push({ ...current.params, [key]: valueAt(key, index - deltas[key]) })
      neighbours.push({ ...current.params, [key]: valueAt(key, index + deltas[key]) })
    }

    const { fresh, candidates } = await run(neighbours)
    idle = fresh ? 0 : idle + 1

    const improving = candidates.filter(item => isBetter(item, current))
    let next = pickBest(improving)

    if (next) {
      // combine the best improving move of every param into one step
      if (improving.length > 1) {
        const combined = { ...current.params }
        for (const key of keys) {
          const moves = improving.filter(item => item.params[key] !== current.params[key])
          const move = pickBest(moves)
          if (move)
            combined[key] = move.params[key]
        }

        const { candidates: [candidate] } = await run([combined])
        if (candidate && isBetter(candidate, next))
          next = candidate
      }

      current = next
    } else if (keys.some(key => deltas[key] > 1)) {
      fraction /= 2
    } else {
      // local optimum, restart near the global best
      restarts++
      onRestart?.(restarts, evaluations)

      const { candidates: [candidate] } = await run([sample(() => perturb(best!.params, 0.25))])
      if (candidate)
        current = candidate
      fraction = 0.16
    }
  }

  return { best, evaluations, restarts }
}
