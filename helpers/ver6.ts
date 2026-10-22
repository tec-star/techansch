import moment from 'moment'

export function sleep(min: number, tolerance = 0) {
  return new Promise(resolve => setTimeout(resolve, min + Math.random() * tolerance));
}

export function ema(values: number[], length: number): number[] {
  if (values.length < length) return [];
  const lastUndefinedIndex = values.findLastIndex((item: any) => item === undefined || isNaN(item))
  values = values.slice(lastUndefinedIndex + 1);

  const result: number[] = [];
  const k = 2 / (length + 1);

  // 1️⃣ First EMA = SMA
  let sum = 0;
  for (let i = 0; i < length; i++) {
    sum += values[i];
  }
  let prevEma = sum / length;
  result[length + lastUndefinedIndex] = prevEma;

  // 2️⃣ EMA calculation
  for (let i = length; i < values.length; i++) {
    const currentEma = values[i] * k + prevEma * (1 - k);
    result[i + lastUndefinedIndex + 1] = currentEma;
    prevEma = currentEma;
  }

  return result;
}

export function sma(values: number[], length: number): number[] {
  if (values.length < length) return [];
  const lastUndefinedIndex = values.findLastIndex((item: any) => item === undefined || isNaN(item))
  values = values.slice(lastUndefinedIndex + 1);

  const result: number[] = [];
  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    sum += values[i];

    if (i >= length) {
      sum -= values[i - length];
    }

    if (i >= length - 1) {
      result[i + lastUndefinedIndex + 1] = sum / length;
    }
  }

  return result;
}

export function atr(
  highs: number[],
  lows: number[],
  closes: number[],
  length: number
): number[] {
  const size = Math.min(highs.length, lows.length, closes.length);
  if (size < length + 1) return [];

  const tr: number[] = [];
  const atr: number[] = [];

  // 1️⃣ True Range (TR)
  for (let i = 0; i < size; i++) {
    if (i === 0) {
      tr[i] = highs[i] - lows[i];
    } else {
      tr[i] = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
    }
  }

  // 2️⃣ First ATR = SMA of TR
  let sumTR = 0;
  for (let i = 0; i < length; i++) {
    sumTR += tr[i];
  }

  let prevATR = sumTR / length;
  atr[length - 1] = prevATR;

  // 3️⃣ Wilder's RMA smoothing
  for (let i = length; i < size; i++) {
    const currentATR = (prevATR * (length - 1) + tr[i]) / length;
    atr[i] = currentATR;
    prevATR = currentATR;
  }

  return atr;
}

export function supertrend(
  highs: number[],
  lows: number[],
  closes: number[],
  factor: number,
  atrLength: number
): { trend: number[]; direction: number[] } {
  const size = Math.min(highs.length, lows.length, closes.length);
  if (size < atrLength + 1) {
    return { trend: [], direction: [] };
  }

  // --- ATR (Wilder RMA) ---
  const atr: number[] = [];
  const tr: number[] = [];

  for (let i = 0; i < size; i++) {
    if (i === 0) {
      tr[i] = highs[i] - lows[i];
    } else {
      tr[i] = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
    }
  }

  let trSum = 0;
  for (let i = 0; i < atrLength; i++) trSum += tr[i];
  atr[atrLength - 1] = trSum / atrLength;

  for (let i = atrLength; i < size; i++) {
    atr[i] = (atr[i - 1] * (atrLength - 1) + tr[i]) / atrLength;
  }

  // --- Supertrend ---
  const upperBand: number[] = [];
  const lowerBand: number[] = [];
  const finalUpperBand: number[] = [];
  const finalLowerBand: number[] = [];
  const supertrend: number[] = [];
  const direction: number[] = [];

  for (let i = atrLength - 1; i < size; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    upperBand[i] = hl2 + factor * atr[i];
    lowerBand[i] = hl2 - factor * atr[i];

    if (i === atrLength - 1) {
      finalUpperBand[i] = upperBand[i];
      finalLowerBand[i] = lowerBand[i];
      direction[i] = 1;
      supertrend[i] = lowerBand[i];
      continue;
    }

    // Carry forward bands
    finalUpperBand[i] =
      upperBand[i] < finalUpperBand[i - 1] || closes[i - 1] > finalUpperBand[i - 1]
        ? upperBand[i]
        : finalUpperBand[i - 1];

    finalLowerBand[i] =
      lowerBand[i] > finalLowerBand[i - 1] || closes[i - 1] < finalLowerBand[i - 1]
        ? lowerBand[i]
        : finalLowerBand[i - 1];

    // Direction
    if (direction[i - 1] === -1 && closes[i] > finalUpperBand[i - 1]) {
      direction[i] = 1;
    } else if (direction[i - 1] === 1 && closes[i] < finalLowerBand[i - 1]) {
      direction[i] = -1;
    } else {
      direction[i] = direction[i - 1];
    }

    supertrend[i] =
      direction[i] === 1 ? finalLowerBand[i] : finalUpperBand[i];
  }

  return { trend: supertrend, direction };
}

export function rsi(values: number[], length: number): number[] {
  if (values.length < length + 1) return [];

  const rsiArr: number[] = [];
  let gainSum = 0;
  let lossSum = 0;

  // 1️⃣ Initial SMA of gains/losses
  for (let i = 1; i <= length; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }

  let avgGain = gainSum / length;
  let avgLoss = lossSum / length;

  // 2️⃣ First RSI value
  rsiArr[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // 3️⃣ Wilder RMA smoothing
  for (let i = length + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;

    rsiArr[i] =
      avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsiArr;
}

export function macd(
  values: number[],
  fastLength = 12,
  slowLength = 26,
  signalLength = 9
): {
  macd: number[];
  signal: number[];
  histogram: number[];
} {
  const fastEma = ema(values, fastLength);
  const slowEma = ema(values, slowLength);

  const macdLine: number[] = [];

  for (let i = 0; i < values.length; i++) {
    if (fastEma[i] !== undefined && slowEma[i] !== undefined) {
      macdLine[i] = fastEma[i] - slowEma[i];
    }
  }

  let signalLine = ema(macdLine, signalLength);
  const histogram: number[] = [];

  for (let i = 0; i < values.length; i++) {
    if (macdLine[i] !== undefined && signalLine[i] !== undefined) {
      histogram[i] = macdLine[i] - signalLine[i];
    }
  }

  return {
    macd: macdLine,
    signal: signalLine,
    histogram
  };
}

export function vwma(
  values: number[],
  volumes: number[],
  length: number
): number[] {
  const size = Math.min(values.length, volumes.length);
  if (size < length) return [];

  const result: number[] = [];
  let pvSum = 0; // price * volume sum
  let volSum = 0;

  for (let i = 0; i < size; i++) {
    const pv = values[i] * volumes[i];
    pvSum += pv;
    volSum += volumes[i];

    if (i >= length) {
      pvSum -= values[i - length] * volumes[i - length];
      volSum -= volumes[i - length];
    }

    if (i >= length - 1) {
      result[i] = volSum === 0 ? NaN : pvSum / volSum;
    }
  }

  return result;
}

export function bb(
  values: number[],
  length: number,
  mult: number
): {
  basis: number[];
  upper: number[];
  lower: number[];
} {
  if (values.length < length) {
    return { basis: [], upper: [], lower: [] };
  }

  const basis: number[] = [];
  const upper: number[] = [];
  const lower: number[] = [];

  let sum = 0;
  let sumSq = 0;

  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    sumSq += values[i] * values[i];

    if (i >= length) {
      sum -= values[i - length];
      sumSq -= values[i - length] * values[i - length];
    }

    if (i >= length - 1) {
      const mean = sum / length;
      const variance = sumSq / length - mean * mean;
      const stdev = Math.sqrt(variance);

      basis[i] = mean;
      upper[i] = mean + mult * stdev;
      lower[i] = mean - mult * stdev;
    }
  }

  return { basis, upper, lower };
}

export function obv(close: number[], volume: number[]): number[] {
  if (close.length !== volume.length) {
    throw new Error("close and volume arrays must have the same length");
  }

  const obv: number[] = new Array(close.length).fill(0);

  for (let i = 1; i < close.length; i++) {
    if (close[i] > close[i - 1]) {
      obv[i] = obv[i - 1] + volume[i];
    } else if (close[i] < close[i - 1]) {
      obv[i] = obv[i - 1] - volume[i];
    } else {
      obv[i] = obv[i - 1];
    }
  }

  return obv;
}


// default options
export const DEFAULT_AGG_OPTIONS = {
  emaLen1: 7,
  emaLen2: 20,
  emaLen3: 45,
  emaLen4: 120,
  emaLen5: 450,
  rsiLen: 48,
  macdFastLen: 9,
  macdSlowLen: 21,
  macdSiglLen: 6,
  volAvgLen: 18,
  obvEmaLen: 8,
  bbLen: 16,
  bbMul: 2.3,
  atrLen: 560,
  emaUpCoeff: 1.004,
  emaDownCoeff: 0.997,
  rsiUpLimit: 70,
  rsiDownLimit: 30,
  rsiStartLimit: 50,
  macdUpCoeff: 1.08,
  macdDownCoeff: 0.92,
  volAvgCoeff: 2.3,
  bbWidthLimit: 0.042,
  bbUpLimit: 0.998,
  bbDownLimit: 1.002,
  atrLimit: 1.3
}

export const DEFAULT_WT_OPTIONS = {
  n1: 10,
  n2: 21,
  obLevel: 50,
  osLevel: -50,
  ciCoeff: 0.015,
  wt2Coeff: 3
}

export const DEFAULT_ALL_IN_ONE_OPTIONS = {
  validGap: 10,
  limit: 2.5,
  increment: 2,
  incrementCountMax: 0
}

// all options in one flat object, allInOne passes it to aggregated and wt
export const DEFAULT_OPTIONS = {
  ...DEFAULT_AGG_OPTIONS,
  ...DEFAULT_WT_OPTIONS,
  ...DEFAULT_ALL_IN_ONE_OPTIONS
}

// functions
const aggregated = (
  data: Array<{ time: string, open: number, high: number, low: number, close: number, volume: number }>,
  options: any = {}
) => {
  const {
    emaLen1,
    emaLen2,
    emaLen3,
    emaLen4,
    emaLen5,
    rsiLen,
    macdFastLen,
    macdSlowLen,
    macdSiglLen,
    volAvgLen,
    obvEmaLen,
    bbLen,
    bbMul,
    atrLen,
    emaUpCoeff,
    emaDownCoeff,
    rsiUpLimit,
    rsiDownLimit,
    rsiStartLimit,
    macdUpCoeff,
    macdDownCoeff,
    volAvgCoeff,
    bbWidthLimit,
    bbUpLimit,
    bbDownLimit,
    atrLimit
  } = { ...DEFAULT_AGG_OPTIONS, ...options }

  const opens: number[] = [], lows: number[] = [], highs: number[] = [], closes: number[] = [], volumes: number[] = [];
  for (const item of data) {
    opens.push(item.open)
    highs.push(item.high)
    lows.push(item.low)
    closes.push(item.close)
    volumes.push(item.volume)
  }

  const ema1 = ema(closes, emaLen1)
  const ema2 = ema(closes, emaLen2)
  const ema3 = ema(closes, emaLen3)
  const ema4 = ema(closes, emaLen4)
  const ema5 = ema(closes, emaLen5)
  // const { trend: supertrend1, direction } = supertrend(highs, lows, closes, 3, 11)
  const rsi1 = rsi(closes, rsiLen)
  const { macd: macdLine1, signal: signalLine1, histogram: histLine1 } = macd(closes, macdFastLen, macdSlowLen, macdSiglLen)
  // const vwma1 = vwma(closes, volumes, 16)
  const volumeAvg1 = sma(volumes, volAvgLen)
  const obv1 = obv(closes, volumes)
  const obvEma1 = ema(obv1, obvEmaLen)
  const { upper: bbUpper1, lower: bbLower1, basis: bbBasis1 } = bb(closes, bbLen, bbMul)
  const atr1 = atr(highs, lows, closes, atrLen)

  const result: number[] = []
  for (let i = 100; i < data.length; i++) {
    // const bullTrend = ema1[i] > ema2[i] * 1.006 && ema2[i] > ema3[i] * 1.000 && ema3[i] > ema4[i] * 0.996 
    // const bearTrend = ema1[i] < ema2[i] * 0.994 && ema2[i] < ema3[i] * 1.000 && ema3[i] < ema4[i] * 1.004

    const bullTrend = ema1[i] > ema2[i] * emaUpCoeff && ema2[i] > ema3[i] * emaUpCoeff && ema3[i] > ema4[i] * emaUpCoeff
    const bearTrend = ema1[i] < ema2[i] * emaDownCoeff && ema2[i] < ema3[i] * emaDownCoeff && ema3[i] < ema4[i] * emaDownCoeff

    const rsiBullish = rsi1[i] > rsiStartLimit && rsi1[i] < rsiUpLimit && rsi1[i] > rsi1[i - 1] && rsi1[i - 1] > rsi1[i - 2]
    const rsiBearish = rsi1[i] < rsiStartLimit && rsi1[i] > rsiDownLimit && rsi1[i] < rsi1[i - 1] && rsi1[i - 1] < rsi1[i - 2]

    const macdBullish = histLine1[i] > 0 && histLine1[i] > histLine1[i - 1] * macdUpCoeff
    const macdBearish = histLine1[i] < 0 && histLine1[i] < histLine1[i - 1] * macdDownCoeff

    const volumeSpike = volumes[i] > volumeAvg1[i] * volAvgCoeff

    const obvRising = obv1[i] > obvEma1[i] && obv1[i] > obv1[i - 1] && obv1[i - 1] > obv1[i - 2]
    const obvFalling = obv1[i] < obvEma1[i] && obv1[i] < obv1[i - 1] && obv1[i - 1] < obv1[i - 2]

    const insideBB = closes[i] < bbUpper1[i] && closes[i] > bbLower1[i]
    const bbWidth = (bbUpper1[i] - bbLower1[i]) / bbBasis1[i]
    const squeeze = bbWidth < bbWidthLimit && insideBB

    const long = 
      bullTrend &&
      // closes[i] > supertrend1[i] * 1.002 &&  // 0.2% buffer
      // closes[i] > vwma1[i] * 1.003 &&
      rsiBullish &&
      macdBullish &&
      (volumeSpike || obvRising) &&  // More flexible volume
      // (volumeSpike) &&  // More flexible volume
      (squeeze || closes[i] > bbUpper1[i] * bbUpLimit) // Early breakout allowed

    const short = 
      bearTrend &&
      // closes[i] < supertrend1[i] * 0.998 &&
      // closes[i] < vwma1[i] * 0.997 &&
      rsiBearish &&
      macdBearish &&
      (volumeSpike || obvFalling) &&
      // (volumeSpike) &&
      (squeeze || closes[i] < bbLower1[i] * bbDownLimit)

    const atrCoeff = atr1[i] < atrLimit ? 1 : 0

    result[i] = (long ? 1 : short ? -1 : 0) * atrCoeff
  }

  return result
}
const wt = (
  data: Array<{ time: string, open: number, high: number, low: number, close: number, volume: number }>,
  options: any = {}
) => {
  const {
    n1,
    n2,
    obLevel,
    osLevel,
    ciCoeff,
    wt2Coeff
  } = { ...DEFAULT_WT_OPTIONS, ...options }

  const opens: number[] = [], lows: number[] = [], highs: number[] = [], closes: number[] = [], volumes: number[] = [], hlc3s: number[] = [];
  for (const item of data) {
    opens.push(item.open)
    highs.push(item.high)
    lows.push(item.low)
    closes.push(item.close)
    volumes.push(item.volume)
    hlc3s.push((item.high + item.low + item.close) / 3)
  }

  const ap = hlc3s
  const esa = ema(hlc3s, n1)
  const d = ema(hlc3s.map((item: number, index: number) => Math.abs(item - esa[index])), n1)
  const ci = hlc3s.map((item: number, index: number) => (item - esa[index]) / (ciCoeff * d[index]))
  const tci = ema(ci, n2)

  const wt1 = tci
  // return wt1;

  const wt2 = sma(wt1, wt2Coeff)
  
  const result: Array<{enter: number, exit: number}> = []
  for (let i = 100; i < data.length; i++) {
    let enter = 0, exit = 0
    if (wt1[i - 1] < wt2[i - 1] && wt1[i] > wt2[i] && wt2[i] < osLevel)
      enter = 1
    else if (wt1[i - 1] > wt2[i - 1] && wt1[i] < wt2[i] && wt2[i] > obLevel)
      enter = -1

    if (wt1[i] > wt2[i])
      exit = 1
    else if (wt1[i] < wt2[i])
      exit = -1

    result[i] = { enter, exit }
  }

  return result
}

const getOrderParams = ({
  type,
  enterPrice,
  enterTime,
  percent = 2.5,
  amount
}: any) => {
  if (type === 1) {
    return {
      type,
      enterTime,
      enterPrice,
      limit: enterPrice * (100 + percent) / 100,
      stop: enterPrice * (100 - percent) / 100,
      amount
    }
  } else {
    return {
      type,
      enterTime,
      enterPrice,
      limit: enterPrice * 100 / (100 + percent),
      stop: enterPrice * 100 / (100 - percent),
      amount
    }
  }
}

export const allInOne = async (
  data: any[],
  options: any = {}
) => {
  const {
    validGap,
    limit,
    increment,
    incrementCountMax
  } = { ...DEFAULT_ALL_IN_ONE_OPTIONS, ...options }

  const agg = aggregated(data, options)
  const wts = wt(data, options)

  let 
    max = 0, 
    drawdown = 0, 
    total = 0, 
    flag = 0, 
    open = 0, 
    validcount = 0, 
    order: any = {}, 
    orders: any[] = [], 
    pnl = 0,
    amount = 1,
    incrementCount = 0,

    shouldClose = false,
    shouldOpen = false

  for (let i = 100; i < data.length; i++) {
    const item = data[i]
    const aggItem = agg[i]
    const wt: any = wts[i]

    shouldOpen = false
    shouldClose = false

    if (aggItem && flag === -aggItem) {
      validcount = 0
    }

    if (open) {
      if (open === 1) {
        if (item.low <= order.stop) {
          pnl = (order.stop - order.enterPrice) / order.enterPrice * 100 * order.amount
          total += pnl

          order = {
            ...order,
            exitTime: item.time,
            exitPrice: order.stop,
            pnl,
            total,
            exitType: 'sl'
          }

          orders.push(order)
          
          if (incrementCount >= incrementCountMax) {
            shouldClose = true
          } else {
            shouldClose = true
            shouldOpen = true

            incrementCount++
            order = getOrderParams({
              type: order.type,
              enterTime: item.time,
              enterPrice: item.close,
              amount: order.amount * increment,
              percent: limit
            })
          }
        } else if (item.high >= order.limit) {
          shouldClose = true
          pnl = (order.limit - order.enterPrice) / order.enterPrice * 100 * order.amount
          total += pnl

          order = {
            ...order,
            exitTime: item.time,
            exitPrice: order.limit,
            pnl, 
            total,
            exitType: 'tp'
          }

          orders.push(order)
        }
      } else {
        if (item.high >= order.stop) {
          pnl = (order.enterPrice - order.stop) / order.stop * 100 * order.amount
          total += pnl

          order = {
            ...order,
            exitTime: item.time,
            exitPrice: order.stop,
            pnl,
            total,
            exitType: 'sl'
          }

          orders.push(order)

          if (incrementCount >= incrementCountMax) {
            shouldClose = true
          } else {
            shouldClose = true
            shouldOpen = true
            
            incrementCount++
            order = getOrderParams({
              type: order.type,
              enterTime: item.time,
              enterPrice: item.close,
              amount: order.amount * increment,
              percent: limit
            })
          }
        } else if (item.low <= order.limit) {
          shouldClose = true
          pnl = (order.enterPrice - order.limit) / order.limit * 100 * order.amount
          total += pnl

          order = {
            ...order,
            exitTime: item.time,
            exitPrice: order.limit,
            pnl, 
            total,
            exitType: 'tp'
          }

          orders.push(order)
        } 
      }

      if (shouldClose && !shouldOpen) {
        pnl = 0
        flag = 0
        open = 0
        validcount = 0
        order = null
        amount = 1
        incrementCount = 0

        max = Math.max(max, total)
        const gap = max - total
        drawdown = Math.max(drawdown, gap)
      }
    }
    
    if (flag) {
      if (!open) {
        if (validcount <= validGap) {
          if (flag === wt.enter) {
            open = flag
            shouldOpen = true
  
            if (flag === 1) {
              order = getOrderParams({
                type: open,
                enterTime: item.time,
                enterPrice: item.close,
                amount,
                percent: limit
              })

            } else {
              order = getOrderParams({
                type: open,
                enterTime: item.time,
                enterPrice: item.close,
                amount,
                percent: limit
              })
            }
          } else {
            validcount++
          }
        } else {
          validcount = 0
          flag = 0
          open = 0
        }
      } 
    } else {
      if (aggItem === 1) {
        flag = -1
      } else if (aggItem === -1) {
        flag = 1
      }
    }
  }
  const result = {
    total: total - orders.length * 0.2,
    count: orders.length,
    drawdown,
    orders,
    price: data,
    lastOrder: orders.at(-1),
    currentOrder: order,
    shouldOpen,
    shouldClose
  }

  return result
}

// options: any subset of DEFAULT_OPTIONS, missing keys fall back to the defaults
export async function getOrders(options: any = {}, log = true) {
  const MAX_LIMIT = 100000
  // loaded here, not at the top: price.ts requires every data file, the index page imports ver6 and mustn't bundle them
  const { getKlines } = await import(/* webpackIgnore: true */ './price')
  const data = await getKlines('XMR_USDT', 'Min5', MAX_LIMIT)
  const { total, count, drawdown, orders, price } = await allInOne(data, options)

  if (log) {
    console.log('result: ',
      total, count, orders.filter((item: any) => item.pnl > 0).length / orders.filter((item: any) => item.pnl < 0).length,
      drawdown,
      orders.slice(-10).map((item: any) => ({ ...item, enterTime: moment.unix(item.enterTime).toISOString(), exitTime: moment.unix(item.exitTime).toISOString() })))
  }

  return {
    total, drawdown, count
  }
}