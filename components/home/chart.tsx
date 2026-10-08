'use client'
import moment from 'moment'
import { useEffect, useState } from 'react'
import Chart from '../common/chart'
import { allInOne, sleep } from '../../helpers/ver5'
import { getKlines } from '../../helpers/price'

function HomeChart () {
    const MAX_LIMIT = 100000

    const [chartData, setChartData] = useState<any>(null)
    const [priceData, setPriceData] = useState<any>(null)
    const [data, setData] = useState<any[]>([])

    useEffect(() => {
        const updateData = async () => {
            const rawData = await getKlines('XMR_USDT', 'Min5', MAX_LIMIT)

            setData(rawData)
        }

        updateData()

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
                        setData((prev: any[]) => [ ...prev.slice(1), { time, open, high, low, close, volume } ])
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
    }, [])

    useEffect(() => {
        const updateChartData = async (data: any[]) => {

            const { total, count, drawdown, orders, price } = await allInOne(data)


            setChartData([{
                name: 'Chart',
                data: orders.map((item: any) => [moment.unix(item.exitTime).toDate(), item.total]),
                type: 'line',
                yAxis: 'value',
            }])

            // setPriceData([{
            //     name: 'Price',
            //     data: price.map((item: any) => [moment.unix(item.time).toDate(), item.open, item.close, item.low, item.high]),
            //     type: 'candlestick',
            //     yAxis: 'price',
            // }])
        }
        console.log('data: ', data)

        updateChartData(data)
    }, [data])

    return (
        <>
            {chartData && (
                <div className='w-full h-[500px]'>
                    <Chart 
                        data={chartData}
                        className='h-full'
                    />
                </div>
            )}
            {/* {priceData && (
                <div className='w-full h-[500px]'>
                    <Chart 
                        data={priceData}
                        className='h-full'
                    />
                </div>
            )} */}
        </>
    )
}

export default HomeChart