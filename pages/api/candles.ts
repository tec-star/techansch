// The candles of a data file for the index page in dev (`next dev`), read on every request so the page has the same
// candles test.ts keeps saving. The static extension build (`next export`) has no API, out.js copies the file instead.
import type { NextApiRequest, NextApiResponse } from 'next'
import { createReadStream, existsSync } from 'fs'
import path from 'path'

// the data files are tens of MB
export const config = { api: { responseLimit: false } }

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const coin = String(req.query.coin ?? 'XMR_USDT')
  const interval = String(req.query.interval ?? 'Min5')

  if (!/^[A-Z0-9]+_[A-Z0-9]+$/.test(coin) || !/^[A-Za-z0-9]+$/.test(interval))
    return res.status(400).json({ error: 'invalid coin or interval' })

  const file = path.join(process.cwd(), 'data', `${coin}-${interval}.json`)
  if (!existsSync(file))
    return res.status(404).json({ error: `no data file for ${coin} ${interval}` })

  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  createReadStream(file).pipe(res)
}
