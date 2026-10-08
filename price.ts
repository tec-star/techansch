import axios from 'axios'
import moment from 'moment'
import { promises as fs } from 'fs'


const saveKlines = async (coin: string = 'XMR_USDT', interval: string = 'Min5', start: string = '2020-01-01', delay: number = 1) => {
    
    let data: any = []

    try {
        data = await fs.readFile(`./data/${coin}-${interval}.json`, 'utf-8')
        data = JSON.parse(data)
    } catch(e) {
        console.log('error with coin:', coin, e)
    }

    // fetch data from api
    const baseUrl = 'https://contract.mexc.com'
    const result = []
    let startTime = data?.length 
        ? data[data.length - 1].time
        : moment(start).unix()

    let endTime = moment().unix()
    for (;;) {
        try {
            const res = await axios({
                method: 'get',
                headers: {
                    // 'X-MEXC-APIKEY': accessKey,
                    'Content-Type': 'application/json',
                },
                url: `${baseUrl}/api/v1/contract/kline/${coin}`,
                params: {
                    interval,
                    end: endTime
                }
            })
    
            const item = res.data.data

            const formatted = []
            for (let i = 0; i < item.time?.length; i++) {
                formatted.push({
                    time: item.time[i],
                    open: item.open[i],
                    close: item.close[i],
                    high: item.high[i],
                    low: item.low[i],
                    volume: item.vol[i],
                    amount: item.amount[i],
                    realOpen: item.realOpen[i],
                    realClose: item.realClose[i],
                    realHigh: item.realHigh[i],
                    realLow: item.realLow[i]
                })
            }
            
            endTime = formatted.splice(0, 1)[0].time

            const shouldBreak = formatted.length < 1999 || endTime < startTime
            console.log('data: ', coin, interval, moment.unix(endTime).toISOString(), formatted.length)

            if (formatted?.length)
                result.push(...formatted)

            if (shouldBreak)
                break;
                    
        } catch(e) {
            console.log('error with coin:', coin, e)
            break
        }
    }
    result.sort((a, b) => a.time > b.time ? 1 : -1)

    const newOnes = data?.length
        ? result.filter(item => item.time > data[data.length - 1].time)
        : result
    const allData = [ ...data, ...newOnes ]

    await fs.writeFile(`./data/${coin}-${interval}.json`, JSON.stringify(allData))

    return allData
}

saveKlines('XMR_USDT', 'Min5')
// setInterval(() => saveKlines(), 24 * 3600 * 1000)
// saveKlines('BTC_USDT', 'Min5')