// collector.mjs
// Runs on a schedule. For each symbol/timeframe:
//   1. pull OHLCV candles from Bybit (free, no key)
//   2. compute SMC features (smc.mjs)
//   3. grab a TradingView chart image via chart-img (optional, needs key)
// Then writes everything to data/latest.json for the trading tool to read.
//
// Run:  node collector.mjs            (live)
//       node collector.mjs --mock     (no network; proves assembly)

import { writeFile, mkdir } from 'node:fs/promises';
import { analyse } from './smc.mjs';

// ----------------------------------------------------------------------------
// CONFIG — edit these
// ----------------------------------------------------------------------------
const SYMBOLS = [
  // dataSymbol = Bybit linear perp; tvSymbol = TradingView ticker for the image
  // hlCoin = Hyperliquid perp name (data source); tvSymbol = TradingView ticker for the chart image
  { name: 'BTC',   hlCoin: 'BTC',   tvSymbol: 'BYBIT:BTCUSDT.P' },
  { name: 'ETH',   hlCoin: 'ETH',   tvSymbol: 'BYBIT:ETHUSDT.P' },
  { name: 'SOL',   hlCoin: 'SOL',   tvSymbol: 'BYBIT:SOLUSDT.P' },
  { name: 'HYPE',  hlCoin: 'HYPE',  tvSymbol: 'BYBIT:HYPEUSDT.P' },
  { name: 'ASTER', hlCoin: 'ASTER', tvSymbol: 'BYBIT:ASTERUSDT.P' },
];

// Hyperliquid candle intervals -> chart-img interval strings
const TIMEFRAMES = [
  { label: '1h', hl: '1h', chartImg: '1h' },
  { label: '4h', hl: '4h', chartImg: '4h' },
  { label: '1D', hl: '1d', chartImg: '1D' },
];

const CANDLE_LIMIT = 300;           // enough for EMA200 + structure history
const CHART_IMG_KEY = process.env.CHART_IMG_KEY || '';
const CHART_IMG_LAYOUT = process.env.CHART_IMG_LAYOUT || ''; // optional saved layout id
const IMAGE_EVERY_HOURS = Math.max(1, parseInt(process.env.IMAGE_EVERY_HOURS || '1', 10)); // fetch images only every N hours
const MOCK = process.argv.includes('--mock');
// data always runs; images only on hours divisible by IMAGE_EVERY_HOURS (keeps chart-img quota sane at hourly cadence)
const DO_IMAGES = !MOCK && CHART_IMG_KEY && (new Date().getUTCHours() % IMAGE_EVERY_HOURS === 0);

// ----------------------------------------------------------------------------
// FETCHERS
// ----------------------------------------------------------------------------
const HL_URL = 'https://api.hyperliquid.xyz/info';
const IV_MS = { '1h': 3600e3, '4h': 4 * 3600e3, '1d': 24 * 3600e3 };

async function hlPost(body) {
  const res = await fetch(HL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`hyperliquid ${res.status}`);
  return res.json();
}

async function fetchCandles(hlCoin, hlInterval) {
  const endTime = Date.now();
  const startTime = endTime - CANDLE_LIMIT * (IV_MS[hlInterval] || 3600e3);
  const rows = await hlPost({
    type: 'candleSnapshot',
    req: { coin: hlCoin, interval: hlInterval, startTime, endTime },
  });
  if (!Array.isArray(rows)) throw new Error(`hyperliquid bad candles for ${hlCoin} ${hlInterval}`);
  // each row: { t:openMs, T:closeMs, o,h,l,c,v: strings, n:trades } — oldest first already
  return rows.map((r) => ({
    time: +r.t, open: +r.o, high: +r.h, low: +r.l, close: +r.c, volume: +r.v,
  }));
}

// one call for ALL perps → map of coin -> { turnover24h, oiValue, lastPrice }
async function fetchTickers() {
  const data = await hlPost({ type: 'metaAndAssetCtxs' });
  // data = [ meta, assetCtxs ] parallel by index
  const universe = data?.[0]?.universe ?? [];
  const ctxs = data?.[1] ?? [];
  const map = {};
  universe.forEach((u, i) => {
    const c = ctxs[i] || {};
    const mark = +c.markPx || +c.oraclePx || 0;
    map[u.name] = {
      turnover24h: +c.dayNtlVlm || 0,          // 24h notional (USD) traded — the liquidity measure
      oiValue: (+c.openInterest || 0) * mark,   // OI is in base units → × mark = USD
      lastPrice: mark,
    };
  });
  return map;
}

async function fetchChartImage(tvSymbol, chartImgInterval) {
  if (!CHART_IMG_KEY) return null; // image optional
  const body = CHART_IMG_LAYOUT
    ? { interval: chartImgInterval }                       // use your saved layout's studies
    : { symbol: tvSymbol, interval: chartImgInterval,
        studies: [
          { name: 'Moving Average Exponential', input: { length: 20 } },
          { name: 'Moving Average Exponential', input: { length: 50 } },
          { name: 'Moving Average Exponential', input: { length: 200 } },
          { name: 'Volume' },
        ] };
  const endpoint = CHART_IMG_LAYOUT
    ? `https://api.chart-img.com/v2/tradingview/layout-chart/${CHART_IMG_LAYOUT}/storage`
    : `https://api.chart-img.com/v2/tradingview/advanced-chart/storage`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'x-api-key': CHART_IMG_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`chart-img ${res.status}`);
  const json = await res.json();
  return json.url ?? null;
}

// ----------------------------------------------------------------------------
// MOCK (offline) candle generator so the pipeline can be tested without network
// ----------------------------------------------------------------------------
function mockCandles(seed = 1) {
  const out = [];
  let price = 100 * seed, t = Date.now() - CANDLE_LIMIT * 4 * 3600e3;
  for (let i = 0; i < CANDLE_LIMIT; i++) {
    const drift = i < 150 ? 0.4 : i < 220 ? -0.6 : 0.8;
    const noise = (Math.sin(i * 0.7 + seed) + Math.cos(i * 0.31)) * 0.9;
    const open = price, close = price + drift + noise;
    out.push({
      time: t + i * 4 * 3600e3, open,
      high: Math.max(open, close) + Math.abs(noise) * 0.6 + 0.3,
      low: Math.min(open, close) - Math.abs(noise) * 0.6 - 0.3,
      close, volume: 1000 + i,
    });
    price = close;
  }
  return out;
}

// ----------------------------------------------------------------------------
// MAIN
// ----------------------------------------------------------------------------
async function run() {
  const startedAt = new Date().toISOString();
  const results = [];

  // pull liquidity once for all symbols (skip in mock)
  let tickers = {};
  if (!MOCK) {
    try { tickers = await fetchTickers(); }
    catch (e) { console.error('tickers fetch failed:', e.message); }
  }

  for (const [si, sym] of SYMBOLS.entries()) {
    const perTf = {};
    for (const tf of TIMEFRAMES) {
      try {
        const candles = MOCK
          ? mockCandles(si + 1)
          : await fetchCandles(sym.hlCoin, tf.hl);

        const smc = analyse(candles);

        let image = null;
        if (DO_IMAGES) {
          try { image = await fetchChartImage(sym.tvSymbol, tf.chartImg); }
          catch (e) { image = { error: String(e.message || e) }; }
        }

        perTf[tf.label] = { smc, image, candleCount: candles.length };
      } catch (e) {
        perTf[tf.label] = { error: String(e.message || e) };
      }
    }

    // quick multi-timeframe confluence read
    const trends = TIMEFRAMES.map((tf) => perTf[tf.label]?.smc?.structure?.trend).filter(Boolean);
    const bull = trends.filter((t) => t === 'up').length;
    const bear = trends.filter((t) => t === 'down').length;
    const bias = bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'mixed';

    // liquidity gate data
    const tk = tickers[sym.hlCoin];
    const turnover24h = MOCK ? 1e9 * (si + 1) : (tk?.turnover24h ?? null);
    const oiValue = MOCK ? 5e8 : (tk?.oiValue ?? null);
    // tier: high >= $1B/24h, mid >= $100M, low below (or unknown)
    const tier = turnover24h == null ? "unknown"
      : turnover24h >= 1e9 ? "high"
      : turnover24h >= 1e8 ? "mid" : "low";

    results.push({
      symbol: sym.name, tvSymbol: sym.tvSymbol, bias,
      liquidity: { turnover24h, oiValue, tier },
      timeframes: perTf,
    });
  }

  const payload = { generatedAt: startedAt, mock: MOCK, symbols: results };
  await mkdir('./data', { recursive: true });
  await writeFile('./data/latest.json', JSON.stringify(payload, null, 2));

  // also keep a timestamped history file (handy for the trade journal)
  const stamp = startedAt.replace(/[:.]/g, '-');
  await writeFile(`./data/history-${stamp}.json`, JSON.stringify(payload));

  console.log(`Wrote data/latest.json — ${results.length} symbols @ ${startedAt}` +
    (MOCK ? ' (mock)' : DO_IMAGES ? ' · images: yes' : ` · images: skipped (every ${IMAGE_EVERY_HOURS}h)`));
  for (const r of results) {
    console.log(`  ${r.symbol.padEnd(6)} bias=${r.bias.padEnd(8)} liq=${(r.liquidity.tier || '?').padEnd(7)} ` +
      TIMEFRAMES.map((tf) => `${tf.label}:${r.timeframes[tf.label]?.smc?.structure?.trend ?? 'err'}`).join('  '));
  }
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
