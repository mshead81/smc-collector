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
  { name: 'BTC',   dataSymbol: 'BTCUSDT',   tvSymbol: 'BYBIT:BTCUSDT.P' },
  { name: 'ETH',   dataSymbol: 'ETHUSDT',   tvSymbol: 'BYBIT:ETHUSDT.P' },
  { name: 'SOL',   dataSymbol: 'SOLUSDT',   tvSymbol: 'BYBIT:SOLUSDT.P' },
  { name: 'HYPE',  dataSymbol: 'HYPEUSDT',  tvSymbol: 'BYBIT:HYPEUSDT.P' },
  { name: 'ASTER', dataSymbol: 'ASTERUSDT', tvSymbol: 'BYBIT:ASTERUSDT.P' },
];

// Bybit interval codes (minutes, or D/W/M) -> chart-img interval strings
const TIMEFRAMES = [
  { label: '1h', bybit: '60',  chartImg: '1h'  },
  { label: '4h', bybit: '240', chartImg: '4h'  },
  { label: '1D', bybit: 'D',   chartImg: '1D'  },
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
async function fetchCandles(dataSymbol, bybitInterval) {
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${dataSymbol}&interval=${bybitInterval}&limit=${CANDLE_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bybit ${res.status} for ${dataSymbol} ${bybitInterval}`);
  const json = await res.json();
  if (json.retCode !== 0) throw new Error(`bybit retCode ${json.retCode}: ${json.retMsg}`);
  // result.list rows: [start, open, high, low, close, volume, turnover] — NEWEST first
  const rows = json.result?.list ?? [];
  return rows
    .map((r) => ({
      time: +r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
    }))
    .reverse(); // -> oldest first
}

// one call for ALL linear tickers → map of symbol -> { turnover24h, oiValue, lastPrice }
async function fetchTickers() {
  const url = `https://api.bybit.com/v5/market/tickers?category=linear`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bybit tickers ${res.status}`);
  const json = await res.json();
  if (json.retCode !== 0) throw new Error(`bybit tickers retCode ${json.retCode}`);
  const map = {};
  for (const t of json.result?.list ?? []) {
    map[t.symbol] = {
      turnover24h: +t.turnover24h || 0,          // 24h USD(T) traded — the liquidity measure
      oiValue: +t.openInterestValue || 0,         // open interest in USD(T)
      lastPrice: +t.lastPrice || 0,
    };
  }
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
          : await fetchCandles(sym.dataSymbol, tf.bybit);

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
    const tk = tickers[sym.dataSymbol];
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
