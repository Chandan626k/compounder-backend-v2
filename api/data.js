/**
 * api/data.js — Vercel Serverless Function
 * POST /api/data
 * Body: { type: 'summary'|'chart'|'news', ticker?, query? }
 */

import { isRateLimited } from '../lib/cache.js';

const CACHE = new Map();
const TTL   = 30 * 60 * 1000;  // 30 min

const YAHOO_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept'         : 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer'        : 'https://finance.yahoo.com/',
};

const CORS = {
  'Access-Control-Allow-Origin' : process.env.ALLOWED_ORIGIN || '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const VALID_SYMBOL = /^[A-Z0-9.\-^]{1,20}$/;

function cacheGet(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() > e.exp) { CACHE.delete(key); return null; }
  return e.data;
}
function cacheSet(key, data) {
  if (CACHE.size > 500) {
    const oldest = [...CACHE.keys()][0];
    CACHE.delete(oldest);
  }
  CACHE.set(key, { data, exp: Date.now() + TTL });
}

async function yahooFetch(url) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, { headers: YAHOO_HEADERS, signal: controller.signal });
    if (!resp.ok) throw new Error(`Yahoo ${resp.status}: ${resp.statusText}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).set(CORS).end();
  if (req.method !== 'POST')   return res.status(405).set(CORS).json({ error: 'POST only' });

  const ip   = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const rate = isRateLimited(ip);
  if (rate.limited) return res.status(429).set(CORS).json({ error: 'Rate limit exceeded', resetAt: rate.resetAt });

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const { type, ticker, query } = body || {};

  if (!type) return res.status(400).set(CORS).json({ error: 'type required: summary|chart|news' });

  try {
    let result, cacheKey;

    if (type === 'summary') {
      if (!ticker || !VALID_SYMBOL.test(ticker))
        return res.status(400).set(CORS).json({ error: `Invalid ticker: ${ticker}` });
      cacheKey = `summary:${ticker}`;
      result   = cacheGet(cacheKey);
      if (!result) {
        const modules = 'summaryDetail,defaultKeyStatistics,financialData,assetProfile,price';
        const raw     = await yahooFetch(`https://query1.finance.yahoo.com/v11/finance/quoteSummary/${ticker}?modules=${modules}`);
        const err     = raw?.quoteSummary?.error;
        if (err) throw new Error(err.description || 'Yahoo quoteSummary error');
        result = raw?.quoteSummary?.result?.[0];
        if (!result) throw new Error(`No data for ${ticker}`);
        cacheSet(cacheKey, result);
      }
    }

    else if (type === 'chart') {
      if (!ticker || !VALID_SYMBOL.test(ticker))
        return res.status(400).set(CORS).json({ error: `Invalid ticker: ${ticker}` });
      cacheKey = `chart:${ticker}`;
      result   = cacheGet(cacheKey);
      if (!result) {
        const raw    = await yahooFetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1y`);
        const chunk  = raw?.chart?.result?.[0];
        if (!chunk) throw new Error(`No chart data for ${ticker}`);
        const ts     = chunk.timestamp || [];
        const closes = chunk.indicators?.quote?.[0]?.close || [];
        const prices = ts.map((t, i) => ({ t, c: closes[i] })).filter(p => p.c != null && p.c > 0);
        if (prices.length < 50) throw new Error(`Insufficient history: ${prices.length} days`);
        result = prices;
        cacheSet(cacheKey, result);
      }
    }

    else if (type === 'news') {
      if (!query || typeof query !== 'string' || query.length > 100)
        return res.status(400).set(CORS).json({ error: 'Invalid query' });
      cacheKey = `news:${query.toLowerCase().replace(/\s+/g,'_')}`;
      result   = cacheGet(cacheKey);
      if (!result) {
        const raw   = await yahooFetch(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=8&quotesCount=0`);
        const items = raw?.news || [];
        result = items.slice(0, 5).map(n => ({
          title      : n.title       || '',
          publisher  : n.publisher   || '',
          link       : n.link        || '#',
          publishedAt: n.providerPublishTime
            ? new Date(n.providerPublishTime * 1000).toLocaleDateString('en-IN') : '',
        }));
        if (!result.length) throw new Error('No news found');
        cacheSet(cacheKey, result);
      }
    }

    else {
      return res.status(400).set(CORS).json({ error: `Unknown type: ${type}` });
    }

    return res.status(200).set(CORS).json({ success: true, data: result });

  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    return res.status(502).set(CORS).json({
      error: isTimeout ? 'Yahoo Finance timeout (10s). Retry karo.' : err.message,
    });
  }
}
