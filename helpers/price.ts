
export const getKlines: any = async (coin: string = 'XMR_USDT', interval: string = 'Min5', limit: number = 50000) => {
    const data = require(`../data/${coin}-${interval}.json`)
    return data.slice(data.length - limit)
}
  