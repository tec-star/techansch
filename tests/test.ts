import { getKlines } from "../helpers/price"
import { allInOne, sleep } from "../helpers/ver5"

const MAX_LIMIT = 100000

let data: any[] = []
async function test() {
    const rawData = await getKlines('XMR_USDT', 'Min5', MAX_LIMIT)

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
                }   
                
                if (newCandle) {
                    newCandle = false
                    data.push({ time, open, high, low, close, volume })

                    const { total, count, drawdown, orders, price } = await allInOne(data)


                    // setChartData([{
                    //     name: 'Chart',
                    //     data: orders.map((item: any) => [moment.unix(item.exitTime).toDate(), item.total]),
                    //     type: 'line',
                    //     yAxis: 'value',
                    // }])
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

import axios from "axios";
import crypto from "crypto";

const MEXC_API_KEY = process.env.MEXC_API_KEY!;
const MEXC_API_SECRET = process.env.MEXC_API_SECRET!;

const BASE_URL = "https://contract.mexc.com";

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

const result1 = await placeFuturesOrder({
  symbol: "BTC_USDT",

  // Number of contracts
  vol: 1,

  // Example: open long
  side: 1,  // 1 open long, 2 close short, 3 open short, 4 close long

  // Market order
  type: 5,  // 1: limit,2: Post Only (maker only),3: IOC,4: FOK,5: market

  // Isolated margin
  openType: 1,  // 1: isolated,2: cross

  leverage: 10,
});

console.log("Order result:", result1);

const result2 = await placeFuturesOrder({
  symbol: "BTC_USDT",
  vol: 1,

  price: 2342342,

  // Open short
  side: 3,

  // Market order
  type: 5,

  // Isolated
  openType: 1,

  leverage: 10,

  stopLossPrice: 123134,

  takeProfitPrice: 1234233
});

console.log(result2);