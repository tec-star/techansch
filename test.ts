import { getKlines } from "./helpers/price"
import { sleep } from "./helpers/ver6"
import { createLiveOptimizer } from "./helpers/live-ver6"
import { execSync } from "node:child_process";
import axios from "axios";
import crypto from "crypto";

const MEXC_API_KEY = process.env.MEXC_API_KEY!;
const MEXC_API_SECRET = process.env.MEXC_API_SECRET!;
const BASE_URL = "https://contract.mexc.com";
const MAX_LIMIT = 100000


interface FuturesOrderParams {
  symbol: string;
  price?: number;
  vol: number;
  side: number;
  type: number;
  openType: number;
  leverage?: number;
  externalOid?: string;
  stopLossPrice?: number;
  takeProfitPrice?: number;
}

export async function placeFuturesOrder(
    order: FuturesOrderParams
) {
    const timestamp = Date.now();

    const params: Record<string, any> = {
        symbol: order.symbol,
        vol: order.vol,
        side: order.side,
        type: order.type,
        openType: order.openType,
    };

    if (order.price !== undefined) {
        params.price = order.price;
    }

    if (order.leverage !== undefined) {
        params.leverage = order.leverage;
    }

    if (order.externalOid) {
        params.externalOid = order.externalOid;
    }

    if (order.stopLossPrice !== undefined) {
        params.stopLossPrice = order.stopLossPrice;
    }

    if (order.takeProfitPrice !== undefined) {
        params.takeProfitPrice = order.takeProfitPrice;
    }

    const queryString = buildQueryString(params);
    const signature = createSignature(queryString);  

    try {
        const response = await axios.post(
        `${BASE_URL}/api/v1/private/order/create?${queryString}&signature=${signature}`,
        params,
        {
            headers: {
            ApiKey: MEXC_API_KEY,
            "Content-Type": "application/json",
            },
        }
        );

        return response.data;
    } catch (error: any) {
        console.error(
        "MEXC order error:",
        error.response?.data || error.message
        );

        throw error;
    }
}

function createSignature(queryString: string): string {
    return crypto
        .createHmac('sha256', MEXC_API_SECRET)
        .update(queryString)
        .digest('hex');
}

function buildQueryString(
    params: Record<string, string | number>,
): string {
    return Object.entries(params)
        .map(
        ([key, value]) =>
            `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
        )
        .join('&');
}

const
    CONTRACT_SIZE = 0.01,
    LEVERAGE = 30,
    MARGIN_AMOUNT = 1000,
    CANDLE_SECONDS = 300

// allInOne options re-optimized like the walk-forward CHOSEN setup: 50k candle window, drawdown break,
// ±5% around DEFAULT_OPTIONS; the current options are kept in data/live-ver6-state.json
const live = createLiveOptimizer()

let data: any[] = [], prevCandle: any = null, order: any = null
async function test() {
    try {
        const output = execSync(`npx ts-node --esm price.ts`, {
            cwd: './',
            encoding: "utf8",
            stdio: "pipe",
        });
    } catch (error) {
        console.error("get recent price data error:", error);
    }

    data = await getKlines('XMR_USDT', 'Min5', MAX_LIMIT)

    // price.ts also saves the candle that is still forming, it is added once it completes
    data = data.filter(candle => candle.time + CANDLE_SECONDS <= Date.now() / 1000)

    // optimizes on the last 50k candles when there is no saved state, otherwise checks the saved options' break
    await live.update(data)

    let ws: any = null, currentOpen = 0, newCandle = false
    const connect = () => {
        ws = new WebSocket('wss://contract.mexc.com/edge');
    
        ws.onopen = function() {
            console.log('ws connected', new Date())
        
            ws.send(JSON.stringify({
                "method":"sub.kline",
                "param":{
                    "symbol": 'XMR_USDT',
                    "interval":"Min5"
                }
            }))
        }    
        
        ws.onclose = async function() {
            console.log('ws disconnected, reconnecting in 2 seconds...', new Date())
        
            await sleep(2000, 100)
            connect();
        }
        
        ws.onerror = function(event: any) {
            console.log('Error: ', event, new Date())
        
            ws.close();
        }
        
        ws.onmessage = async function(msg: any) {
            const message = JSON.parse(msg.data)
        
            if (message.channel === 'push.kline') {
                const { o: open, h: high, l: low, c: close, t: time, q: volume } = message.data
        
                if (currentOpen === 0)
                    currentOpen = open
        
                if (open !== currentOpen) {
                    currentOpen = open
                    console.log('new candle detected!', new Date(), { open, high, low, close, time, volume })

                    newCandle = true

                    // replace a candle we already have instead of adding it twice
                    if (data.length && data[data.length - 1].time === prevCandle.time)
                        data[data.length - 1] = prevCandle
                    else
                        data.push(prevCandle)
                }

                prevCandle = { time, open, high, low, close, volume }
                
                if (newCandle) {
                    newCandle = false

                    // allInOne with the current options; re-optimizes instead (no trade this candle) when the break hits
                    const { result } = await live.update(data)
                    if (!result)
                        return

                    const { currentOrder, shouldOpen } = result

                    if (shouldOpen) {
                        const { type, amount, limit, stop, enterPrice } = currentOrder

                        placeFuturesOrder({
                            symbol: "XMR_USDT",

                            // Number of contracts
                            vol: MARGIN_AMOUNT * LEVERAGE / (enterPrice * CONTRACT_SIZE) * amount,

                            // Example: open long
                            side: type === 1 ? 1 : 3,  // 1 open long, 2 close short, 3 open short, 4 close long

                            // Market order
                            type: 5,  // 1: limit,2: Post Only (maker only),3: IOC,4: FOK,5: market

                            // Isolated margin
                            openType: 2,  // 1: isolated,2: cross

                            leverage: LEVERAGE,

                            stopLossPrice: stop,

                            takeProfitPrice: limit
                        })
                    }
                }
            }
        }
    }
    
    connect();
    
    setInterval(() => {
        //Subscribe to the channel
        ws.send(JSON.stringify({
            "method":"ping"
        }))
    }, 10000)
}

test()