'use client'
import moment from 'moment'
import { useEffect, useState } from 'react'
import Chart from '../common/chart'
import { allInOne, DEFAULT_OPTIONS, sleep } from '../../helpers/ver6'
import { LIVE_START, LiveWalkForward, advanceLive, emptyLiveWalkForward, liveCandles, liveFingerprint, netOrders } from '../../helpers/walk-forward-core'
import { browserEvaluate } from '../../helpers/walk-forward-browser'

const COIN = 'XMR_USDT'
const INTERVAL = 'Min5'

// both lines trade from LIVE_START. The auto-optimized line is the live walk-forward the bot (test.ts) trades: the
// same code and settings (50k candle window, drawdown break, ±5% around DEFAULT_OPTIONS), continued as candles
// come in, so with the same candles it re-optimizes at the same candles with the same options as the bot.

// browser storage: the walk-forward so far, and live candles the data file doesn't have yet (e.g. while the bot is off)
const WALK_FORWARD_KEY = `live-walk-forward:${COIN}-${INTERVAL}`
const LIVE_CANDLES_KEY = `live-candles:${COIN}-${INTERVAL}`
const MAX_LIVE_CANDLES = 20000

// in dev the API reads the data file test.ts keeps saving; the static extension build has no API, out.js copies the
// data file next to the page (the candles are never bundled, that makes the page tens of MB)
const DATA_URL = process.env.NODE_ENV === 'production'
    ? `./data/${COIN}-${INTERVAL}.json`
    : `/api/candles?coin=${COIN}&interval=${INTERVAL}`

const loadDataFile = async (): Promise<any[]> => {
    const response = await fetch(DATA_URL)
    if (!response.ok)
        throw new Error(`loading candles failed: ${response.status} ${await response.text()}`)
    return response.json()
}

const date = (time: number) => moment.unix(time).format('YYYY-MM-DD HH:mm')

// cumulative net profit after each closed trade, from 0 where trading starts
const profitLine = (trades: any[], startTime: number) => {
    let total = 0
    return [
        [moment.unix(startTime).toDate(), 0],
        ...trades.map((trade: any) => [moment.unix(trade.exitTime).toDate(), +(total += trade.net).toFixed(2)])
    ]
}

const read = (key: string) => {
    try {
        const value = localStorage.getItem(key)
        return value ? JSON.parse(value) : null
    } catch {
        return null
    }
}

const write = (key: string, value: any) => {
    try {
        localStorage.setItem(key, JSON.stringify(value))
    } catch {}
}

function HomeChart () {
    const [chartData, setChartData] = useState<any>(null)
    const [status, setStatus] = useState<string>('Loading candles...')

    useEffect(() => {
        let disposed = false, ws: any = null, ping: any = null
        let candles: any[] = [], fileLastTime = 0, startTime = 0
        let walkForward: LiveWalkForward | null = null
        // the open segment and its trades so far
        let segment: any = null, currentTrades: any[] = []
        let running = false, pending = false

        const drawChart = async () => {
            const defaults = netOrders(await allInOne(candles, DEFAULT_OPTIONS)).filter((order: any) => order.enterTime >= startTime)
            const auto = [...(walkForward?.closedTrades ?? []), ...currentTrades]

            if (disposed)
                return

            setChartData([
                {
                    name: 'Default params',
                    data: profitLine(defaults, startTime),
                    yAxis: 'Profit'
                },
                {
                    name: 'Auto-optimized',
                    data: profitLine(auto, startTime),
                    yAxis: 'Profit',
                    markLine: {
                        symbol: ['none', 'none'],
                        silent: true,
                        lineStyle: { type: 'dashed', color: '#999', width: 1 },
                        label: { formatter: 're-optimized', fontSize: 10, color: '#999' },
                        data: (walkForward?.reoptimizations ?? []).map(time => ({ xAxis: time * 1000 }))
                    }
                }
            ])

            if (!walkForward?.resume)
                return

            const sum = (trades: any[]) => trades.reduce((total, trade) => total + trade.net, 0).toFixed(1)
            const profits = `Default params ${sum(defaults)} vs auto-optimized ${sum(auto)} since ${date(startTime)}. `
            const optimizations = `${walkForward.resume.optimizations} optimizations`

            if (segment) {
                let equity = 0, peak = 0
                for (const trade of currentTrades) {
                    equity += trade.net
                    peak = Math.max(peak, equity)
                }
                setStatus(profits + `${optimizations}, current options from ${date(segment.fromTime)}, `
                    + `re-optimizes when the drawdown reaches ${segment.inSample.maxDrawdown.toFixed(1)} (now ${(peak - equity).toFixed(1)}).`)
            } else {
                setStatus(profits + `${optimizations}, no options met the criteria, the next optimization is at ${date(walkForward.resume.tTime)}.`)
            }
        }

        // continues the walk-forward on the candles it hasn't seen; it only optimizes where a segment starts
        const advance = async () => {
            // a fixed copy, live candles keep coming in meanwhile
            const snapshot = candles.slice()
            let backtests = 0
            const evaluate = browserEvaluate(snapshot, () => {
                if (++backtests % 50 === 0 && !disposed)
                    setStatus(`Auto-optimizing... ${backtests} backtests`)
            })

            const advanced = await advanceLive(snapshot, walkForward!, evaluate, console.log)
            if (disposed)
                return

            walkForward = advanced.state
            segment = advanced.segment
            currentTrades = advanced.currentTrades
            write(WALK_FORWARD_KEY, walkForward)
            await drawChart()
        }

        // one update at a time, candles that arrive meanwhile are picked up right after
        const update = async () => {
            if (running) {
                pending = true
                return
            }

            running = true
            try {
                do {
                    pending = false
                    await advance()
                } while (pending && !disposed)
            } finally {
                running = false
            }
        }

        const addCandle = (candle: any) => {
            const last = candles[candles.length - 1]

            if (last && last.time === candle.time)
                candles[candles.length - 1] = candle
            else if (!last || candle.time > last.time)
                candles.push(candle)
            else
                return

            write(LIVE_CANDLES_KEY, candles.filter(item => item.time > fileLastTime).slice(-MAX_LIVE_CANDLES))
            if (walkForward)
                update()
        }

        const start = async () => {
            const file = await loadDataFile()
            fileLastTime = file[file.length - 1].time

            // live candles from earlier visits that the data file doesn't have yet
            const live = (read(LIVE_CANDLES_KEY) ?? []).filter((candle: any) => candle.time > fileLastTime)

            try {
                candles = liveCandles([...file, ...live])
            } catch (error: any) {
                setStatus(error.message)
                return
            }
            startTime = candles[candles.findIndex(candle => candle.time >= Date.parse(LIVE_START) / 1000)].time

            // a saved walk-forward made with other settings or another strategy starts over
            const fingerprint = await liveFingerprint(candles)
            const saved: LiveWalkForward | null = read(WALK_FORWARD_KEY)
            walkForward = saved?.fingerprint === fingerprint ? saved : emptyLiveWalkForward(fingerprint)

            await drawChart()
            if (!walkForward.resume)
                setStatus(`Auto-optimizing on the candles before ${date(startTime)}...`)

            await update()
        }

        const connect = () => {
            let currentOpen = 0, prevCandle: any = null
            ws = new WebSocket('wss://contract.mexc.com/edge');

            ws.onopen = function() {
                console.log('ws connected', new Date())

                ws.send(JSON.stringify({
                    "method":"sub.kline",
                    "param":{
                        "symbol": COIN,
                        "interval": INTERVAL
                    }
                }))
            }

            ws.onclose = async function() {
                if (disposed)
                    return

                console.log('ws disconnected, reconnecting in 2 seconds...', new Date())

                await sleep(2000, 100)
                connect();
            }

            ws.onerror = function(event: any) {
                console.log('Error: ', event, new Date())

                ws.close();
            }

            ws.onmessage = function(msg: any) {
                const message = JSON.parse(msg.data)

                if (message.channel === 'push.kline') {
                    const { o: open, h: high, l: low, c: close, t: time, q: volume } = message.data

                    if (currentOpen === 0)
                        currentOpen = open

                    // a new candle started, the previous one is complete
                    if (open !== currentOpen) {
                        currentOpen = open
                        console.log('new candle detected!', new Date(), prevCandle)

                        if (prevCandle && candles.length)
                            addCandle(prevCandle)
                    }

                    prevCandle = { time, open, high, low, close, volume }
                }
            }
        }

        start().catch(error => {
            console.error(error)
            if (!disposed)
                setStatus(error.message)
        })
        connect()

        ping = setInterval(() => {
            //Subscribe to the channel
            if (ws?.readyState === WebSocket.OPEN)
                ws.send(JSON.stringify({
                    "method":"ping"
                }))
        }, 10000)

        return () => {
            disposed = true
            clearInterval(ping)
            ws?.close()
        }
    }, [])

    return (
        <>
            <p className='text-sm text-gray-600 my-2'>{status}</p>
            {chartData && (
                <div className='w-full h-[500px]' style={{ height: 500 }}>
                    <Chart
                        data={chartData}
                        className='h-full'
                    />
                </div>
            )}
        </>
    )
}

export default HomeChart
