import axios, { AxiosError } from "axios";
import clipboard from "clipboardy";
import crypto from "crypto";
import * as dotenv from 'dotenv'

dotenv.config()

// const BASE_URL = process.env.BASE_URL;
const BASE_URL = 'https://api.mexc.com'

async function wd() {
    const { AC_KEY, SC_KEY, prefix, coin, network, address, amount } = process.env as any

    const params = new URLSearchParams({
        coin: prefix === 't' ? 'USDT' : 'USDC',
        netWork: 'TRX',
        address,
        amount: String(getAmount(amount) + 0.5),
        timestamp: Date.now().toString(),
    });

    const signature = crypto
        .createHmac("sha256", decrypt(SC_KEY, CIPHER_KEY))
        .update(params.toString())
        .digest("hex");

    params.append("signature", signature);

    const response = await axios({
        method: 'POST',
        headers: {
            "X-MEXC-APIKEY": decrypt(AC_KEY, CIPHER_KEY),
            'Content-Type': 'application/json',
        },
        url: `${BASE_URL}/api/v3/capital/withdraw?${params.toString()}`,
    })

    const data = response.data;

    console.log(data);
}

const CIPHER_KEY = 'Ac7Q3RbtpqTPVv9ZO6qhj7FKrW0I0Jb4dT37gK0qJevSR_T6kP2TootQESMC3bDWmY7fzn0iVksN76TY__cd728c2eefa1998ffe8c9757d13cb2d83354cda9c794c55408ba5c8735bb9f61'

function getAmount(input: string) {
    const val = input.at(-1)
    let original = input.slice(0, -1)
    if (original.endsWith('.')) {
        original = original.slice(0, -1)
    }

    return parseFloat(original) * Math.pow(10, parseInt(val!))
}

// encoding & decoding
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

function deriveKey(secret: string): Buffer {
  // For a production system, prefer a proper KDF such as scrypt.
  return createHash('sha256').update(secret, 'utf8').digest()
}

function encrypt(value: string, secret: string): string {
  const key = deriveKey(secret)
  const iv = randomBytes(IV_LENGTH)

  const cipher = createCipheriv(ALGORITHM, key, iv)

  const encrypted = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ])

  const authTag = cipher.getAuthTag()

  // iv + authTag + ciphertext
  return Buffer.concat([iv, authTag, encrypted]).toString('base64url')
}

function decrypt(encoded: string, secret: string): string {
  const data = Buffer.from(encoded, 'base64url')

  if (data.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted value')
  }

  const iv = data.subarray(0, IV_LENGTH)
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH)
  const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH)

  const key = deriveKey(secret)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ])

  return decrypted.toString('utf8')
}

async function getClipboardText(): Promise<string> {
  return clipboard.read()
}

import { writeFile, appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'

async function createFile(
  fileName: string,
  content: string
): Promise<void> {
  const filePath = path.join(process.cwd(), fileName)

  await writeFile(filePath, content, 'utf8')
}

async function appendLine(
  filePath: string,
  value: string
): Promise<void> {
  await appendFile(filePath, `\n${value}`, 'utf8')
}

async function appendNewLine(
  filePath: string,
  value: string
): Promise<void> {
  const existing = await readFile(filePath, 'utf8')

  const prefix = existing.length > 0 && !existing.endsWith('\n')
    ? '\n'
    : ''

  await appendFile(filePath, `${prefix}${value}\n`, 'utf8')
}


const MEXC_BASE_URL = 'https://api.mexc.com';

const apiKey = decrypt(process.env.AC_KEY!, CIPHER_KEY)
const apiSecret = decrypt(process.env.SC_KEY!, CIPHER_KEY)

if (!apiKey || !apiSecret) {
  throw new Error('Missing MEXC_API_KEY or MEXC_API_SECRET');
}

type OrderSide = 'BUY' | 'SELL';

interface CreateMarketOrderParams {
  symbol?: string;
  side?: OrderSide;

  type?: 'MARKET' | 'LIMIT'

  /**
   * For BUY MARKET:
   *   quoteOrderQty = amount of quote currency to spend
   *   Example: spend 20 USDT on BTCUSDT
   *
   * For SELL MARKET:
   *   quantity = amount of base currency to sell
   *   Example: sell 0.001 BTC
   */
  quantity?: string;
  quoteOrderQty?: string;

  /**
   * Optional client-generated identifier.
   */
  newClientOrderId?: string;
}

interface MexcOrderResponse {
  symbol: string;
  orderId: string | number;
  orderListId?: string | number;
  price?: string;
  origQty?: string;
  type: string;
  side: string;
  transactTime?: number;
  status?: string;
}

function createSignature(queryString: string): string {
  return crypto
    .createHmac('sha256', apiSecret)
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

export async function createOrder(
  params: CreateMarketOrderParams,
): Promise<MexcOrderResponse> {
  const {
    symbol = 'USDCUSDT',
    side = 'SELL',
    type = 'MARKET',
    quantity = 4470,
    quoteOrderQty,
    newClientOrderId,
  } = params;

  if (!symbol) {
    throw new Error('symbol is required');
  }

  if (side === 'BUY' && !quoteOrderQty) {
    throw new Error(
      'For a BUY MARKET order, quoteOrderQty is required in this example',
    );
  }

  if (side === 'SELL' && !quantity) {
    throw new Error(
      'For a SELL MARKET order, quantity is required',
    );
  }

  if (quantity && quoteOrderQty) {
    throw new Error(
      'Provide either quantity or quoteOrderQty, not both',
    );
  }

  const requestParams: Record<string, string | number> = {
    symbol: symbol.toUpperCase(),
    side,
    type,
    timestamp: Date.now(),
    recvWindow: 5000,
  };

  if (quantity) {
    requestParams.quantity = quantity;
  }

  if (quoteOrderQty) {
    requestParams.quoteOrderQty = quoteOrderQty;
  }

  if (newClientOrderId) {
    requestParams.newClientOrderId = newClientOrderId;
  }

  const queryString = buildQueryString(requestParams);
  const signature = createSignature(queryString);

  try {
    const response = await axios.post<MexcOrderResponse>(
      `${MEXC_BASE_URL}/api/v3/order?${queryString}&signature=${signature}`,
      null,
      {
        headers: {
          'X-MEXC-APIKEY': apiKey,
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      },
    );
    console.log(response.data)

    return response.data;
  } catch (error) {
    const axiosError = error as AxiosError;

    if (axiosError.response) {
      console.error(
        'MEXC error:',
        axiosError.response.status,
        axiosError.response.data,
      );
    }

    throw error;
  }
}

// (async function() {

// const timestamp = Date.now()

//   const params = new URLSearchParams({
//     timestamp: timestamp.toString(),
//     recvWindow: '5000',
//   })

//   const signature = crypto
//     .createHmac('sha256', decrypt(process.env.SC_KEY!, CIPHER_KEY))
//     .update(params.toString())
//     .digest('hex')

//   params.append('signature', signature)

//   const response = await fetch(
//     `https://api.mexc.com/api/v3/capital/config/getall?${params.toString()}`,
//     {
//       method: 'GET',
//       headers: {
//         'X-MEXC-APIKEY': decrypt(process.env.AC_KEY!, CIPHER_KEY),
//       },
//     }
//   )

//   const data = await response.json()

//   console.log(data.find((item: any) => item.coin === 'USDT'))

//   return data
// })()
createOrder({})