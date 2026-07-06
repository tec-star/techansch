import axios from 'axios'
import moment from 'moment'

console.log('inject script loaded')

// const setting = await chrome.storage.local.get(/* String or Array */["tap"])
// const { coin } = setting ? JSON.parse(setting.tap) : { coin: 'SOL_USDT' }
const coin = 'SOL_USDT', 
    quantity = 20, 
    leverage = 30

let currentOpen = 0, 
    highest = 0, 
    lowest = 20000, 
    type = '', 
    positionOpen = false, 
    trailingActive = false,
    trailingActivation = 0,
    trailingOffset = 0,
    entryTime = '',
    entryPrice = 0, 
    stopLoss = 0, 
    limitTake = 0, 
    entryOriginal = 0,
    positionSize = 100, 
    pnl = 0,
    accumulativePnl = 0, 
    trades = [],
    timestamp = 0,
    newCandle = false

let ws = null

const connect = () => {
    ws = new WebSocket('wss://contract.mexc.com/edge');

    ws.onopen = function() {
        console.log('ws connected', new Date())
    
        ws.send(JSON.stringify({
            "method":"sub.kline",
            "param":{
                "symbol": coin,
                "interval":"Min5"
            }
        }))
    }    
    
    ws.onclose = async function() {
        console.log('ws disconnected, reconnecting in 2 seconds...', new Date())
    
        await sleep(2000, 100)
        connect();
    }
    
    ws.onerror = function(event) {
        console.log('Error: ', event, new Date())
    
        ws.close();
    }
    
    ws.onmessage = async function(msg) {
        const message = JSON.parse(msg.data)
    
        if (message.channel === 'push.kline') {
            const { o: open, h: high, l: low, c: close, t: time, q: volume } = message.data
            timestamp = time
    
            if (currentOpen === 0)
                currentOpen = open
    
            if (open !== currentOpen) {
                currentOpen = open
                console.log('new candle detected!', new Date(), { open, high, low, close, time, volume })
                newCandle = true
            }
    
            highest = Math.max(highest, close)
            lowest = Math.min(lowest, close)
    
            if (!positionOpen) {
                if (!newCandle) {
                    return
                }
                
                newCandle = false
    
                const response = await axios.post('http://localhost:5000/predict', {
                    symbol: coin
                })
    
                const { status, data } = response.data
    
                if (!status)
                    return 
    
                const { status: predStatus, data: pred } = data
                console.log('result: ', pred)
    
                if (!predStatus)
                    return
    
                const { enter, signal, limit, stop, activation, offset } = pred
    
                if (!signal) 
                    return
    
                entryTime = time
                entryPrice = close
                trailingActive = false
                entryOriginal = enter
                trailingActivation = activation
                trailingOffset = offset
                pnl = 0
    
                if (signal === 1) {
                    positionOpen = true
                    type = 'long'
                    stopLoss = entryOriginal - stop
                    limitTake = entryOriginal + limit
                } else if (signal === -1) {
                    positionOpen = true
                    type = 'short'
                    stopLoss = entryOriginal + stop
                    limitTake = entryOriginal - limit
                }
                console.log('position opened!', entryOriginal, type, entryPrice, limitTake, stopLoss, new Date())
            } else {
                newCandle = false
                
                if (type === 'long') {
                    // Exit Logic
                    if (close <= stopLoss) {
                        pnl = (stopLoss - entryPrice) / entryPrice * positionSize
                        accumulativePnl += pnl
                        trades.push({
                            entryType: type,
                            exitType: 'SL',
                            entryTime: moment(entryTime * 1000).format('YYYY-MM-DD HH:mm:ss'),
                            entryPrice,
                            entryOriginal,
                            exitTime: moment().format('YYYY-MM-DD HH:mm:ss'),
                            exitPrice: stopLoss,
                            pnl,
                            accumulativePnl,
                            limitTake,
                            stopLoss
                        })
                        positionOpen = false
                        highest = 0
                        console.log('stop loss hit, position closed', stopLoss, new Date())
                    } else if (close >= limitTake) {
                        pnl = (limitTake - entryPrice) / entryPrice * positionSize
                        accumulativePnl += pnl
                        trades.push({
                            entryType: type,
                            exitType: 'TP',
                            entryTime: moment(entryTime * 1000).format('YYYY-MM-DD HH:mm:ss'),
                            entryPrice,
                            entryOriginal,
                            exitTime: moment().format('YYYY-MM-DD HH:mm:ss'),
                            exitPrice: limitTake,
                            pnl,
                            accumulativePnl,
                            limitTake,
                            stopLoss
                        })
                        positionOpen = false
                        highest = 0
                        console.log('take profit hit, position closed', limitTake, new Date())
                    }
    
                    if (close > entryOriginal + trailingActivation && !trailingActive) {
                        trailingActive = true
                        console.log('trailing active!', new Date())
                    }
    
                    if (trailingActive && highest < limitTake) {
                        stopLoss = Math.max(stopLoss, highest - trailingOffset)
                        console.log('trailing stop loss updated!', stopLoss, ':', close, '/', highest, '/', trailingOffset, new Date())
                    }
    
                } else if (type == 'short') {
                    if (close >= stopLoss) {
                        pnl = (entryPrice - stopLoss) / stopLoss * positionSize
                        accumulativePnl += pnl
                        trades.push({
                            entryType: type,
                            exitType: 'SL',
                            entryTime: moment(entryTime * 1000).format('YYYY-MM-DD HH:mm:ss'),
                            entryPrice,
                            entryOriginal,
                            exitTime: moment().format('YYYY-MM-DD HH:mm:ss'),
                            exitPrice: stopLoss,
                            pnl,
                            accumulativePnl,
                            limitTake,
                            stopLoss
                        })
                        positionOpen = false
                        lowest = 20000
                        console.log('stop loss hit, position closed', stopLoss, new Date())
                    } else if (close <= limitTake) {
                        pnl = (entryPrice - limitTake) / limitTake * positionSize
                        accumulativePnl += pnl
                        trades.push({
                            entryType: type,
                            exitType: 'TP',
                            entryTime: moment(entryTime * 1000).format('YYYY-MM-DD HH:mm:ss'),
                            entryPrice,
                            entryOriginal,
                            exitTime: moment().format('YYYY-MM-DD HH:mm:ss'),
                            exitPrice: limitTake,
                            pnl,
                            accumulativePnl,
                            limitTake,
                            stopLoss
                        })
                        positionOpen = false
                        lowest = 20000
                        console.log('take profit hit, position closed', limitTake, new Date())
                    }
    
                    if (close < entryOriginal - trailingActivation && !trailingActive) {
                        trailingActive = true
                        console.log('trailing active!', close, new Date())
                    }
    
                    if (trailingActive && lowest > limitTake) {
                        stopLoss = Math.min(stopLoss, lowest + trailingOffset)
                        console.log('trailing stop loss updated!', stopLoss, ':', close, '/', lowest, '/', trailingOffset, new Date())
                    }
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

setInterval(() => {
    console.log('trades: ', trades, new Date())
}, 120000)

// setInterval(() => {
//     const ms = moment().valueOf()
    
//     if (ms > timestamp * 1000 + 2000) {
//         ws.send(JSON.stringify({
//             "method":"sub.kline",
//             "param":{
//                 "symbol": coin,
//                 "interval":"Min5"
//             }
//         }))
//     }
// }, 1000)

function sleep(min, tolerance = 0) {
    return new Promise(resolve => setTimeout(resolve, min + Math.random() * tolerance));
}

async function openOrder(price, quantity, leverage, type) {
    console.log('start open order')
    
    // click open tab
    const openTabSelector = 'span[data-testid="contract-trade-order-form-tab-open"]'
    const openTab = document.querySelector(openTabSelector)
    if (!openTab.className?.includes('active'))
        openTab.click()
    
    for (let i = 0; i < 50; i++) {
        await sleep(100)
        if (openTab.className?.includes('active'))
            break

        return false
    }
    await sleep(100, 10)
    console.log('open tab clicked')

    // click limit tab
    const limitTabSelector = 'div#mexc_contract_v_open_position > div:first-child > div:first-child > div:first-child > span:first-child'
    const limitTab = document.querySelector(limitTabSelector)
    if (!limitTab.className?.includes('active'))
        limitTab.click()

    for (let i = 0; i < 50; i++) {
        await sleep(100)
        if (limitTab.className?.includes('active'))
            break

        return false
    }
    await sleep(100, 10)
    console.log('limit tab clicked')
    
    // input price
    const priceInputSelector = 'div#mexc_contract_v_open_position > div > div:last-child input:first-child'
    let priceInput = document.querySelector(priceInputSelector);
    priceInput.focus()
    await sleep(50, 10)
    priceInput.dispatchEvent(new KeyboardEvent("keydown", {
        "key": "End",
        "keyCode": 35,
        "which": 35,
        "code": "End",
        "location": 0,
        "altKey": false,
        "ctrlKey": false,
        "metaKey": false,
        "shiftKey": false,
        "repeat": false
    }));
    await sleep(100, 10)

    for (let i = 0 ;; i++) {
        document.execCommand('delete')
        await sleep(50, 15)
        if (!priceInput.value.length)
            break
    }
    for (let i = 0; i < price.toString().length; i++) {
        document.execCommand('insertText', false, price.toString()[i])
        await sleep(50, 20)
    }
    if (priceInput.value != price)
        return false

    await sleep(100, 10)
    console.log('price input')

    // input quantity
    const quantityInputSelector = 'div#mexc_contract_v_open_position > div > div:last-child input:last-child'
    let quantityInput = document.querySelector(quantityInputSelector);
    quantityInput.focus()
    await sleep(50, 10)
    quantityInput.dispatchEvent(new KeyboardEvent("keydown", {
        "key": "End",
        "keyCode": 35,
        "which": 35,
        "code": "End",
        "location": 0,
        "altKey": false,
        "ctrlKey": false,
        "metaKey": false,
        "shiftKey": false,
        "repeat": false
    }));
    await sleep(100, 10)

    for (let i = 0 ;; i++) {
        document.execCommand('delete')
        await sleep(50, 15)
        if (!quantityInput.value.length)
            break
    }
    for (let i = 0; i < quantity.toString().length; i++) {
        document.execCommand('insertText', false, quantity.toString()[i])
        await sleep(50, 20)
    }
    if (quantityInput.value != quantity)
        return false

    await sleep(100, 10)
    console.log('quantity input')

    // set leverage
    // click lev tab
    const leverageButtonSelector = 'div.LeverageEdit_short__lEyru.LeverageEdit_leverage_simple__Q0KkI'
    const leverageButton = document.querySelector(leverageButtonSelector)

    // check if the current lev is correct
    const currentLeverage = parseInt(leverageButton.innerText)
    if (currentLeverage === leverage) {
        console.log('leverage already set')
    } else {
        leverageButton.click()
        console.log('leverage button clicked')
    
        // wait loding done
        const leverageConfirmButtonSelector = 'div.LeverageSimpleMode_marginModalFooter__SA0qS button:last-child'
        for (let i = 0; i < 100; i++) {
            await sleep(100, 10)
            if (document.querySelector(leverageConfirmButtonSelector).children.length <= 1)
                break;
        }
        await sleep(100, 10)
    
        // input lev
        const leverageInputSelector = 'input.LeverageProgress_leverageInput__iWDFl'
        const leverageInput = document.querySelector(leverageInputSelector)
        leverageInput.focus()
        await sleep(50, 10)
        leverageInput.dispatchEvent(new KeyboardEvent("keydown", {
            "key": "End",
            "keyCode": 35,
            "which": 35,
            "code": "End",
            "location": 0,
            "altKey": false,
            "ctrlKey": false,
            "metaKey": false,
            "shiftKey": false,
            "repeat": false
        }));
        for (let i = 0 ;; i++) {
            document.execCommand('delete')
            await sleep(50, 15)
            if (!leverageInput.value.length)
                break
        }
        for (let i = 0; i < leverage.toString().length; i++) {
            document.execCommand('insertText', false, leverage.toString()[i])
            await sleep(50, 20)
        }
        console.log('leverage input')
    
        // confirm lev
        const leverageConfirmButton = document.querySelector(leverageConfirmButtonSelector)
        leverageConfirmButton.click()
    
        for (let i = 0; i < 100; i++) {
            await sleep(100, 10)
            if (!document.querySelector(leverageInputSelector))
                break;
        }
        await sleep(100, 20)
        console.log('leverage confirmed')
    }

    const orderButtonSelector = `button[data-testid="contract-trade-open-${type}-btn"]`
    const orderButton = document.querySelector(orderButtonSelector)
    await orderButton.click()
    console.log('order opened')
}

async function closePosition() {

}

async function changeOrder(dir, upLimit, downLimit) {
    const price = dir === 'up'
        ?  downLimit
        : upLimit
    
    
}

setTimeout(() => openOrder(22.5, quantity, leverage, 'long'), 10000)
