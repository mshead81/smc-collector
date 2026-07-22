// smc.mjs
// Smart Money Concepts feature detection from raw OHLCV candles.
// Everything here works off arrays of candles shaped:
//   { time:<ms>, open:<n>, high:<n>, low:<n>, close:<n>, volume:<n> }
// ordered oldest -> newest. No external deps.

// ---------- helpers ----------

const last = (a) => a[a.length - 1];

function ema(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  // seed with simple average of first `period` values
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's ATR
function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    ));
  }
  // Wilder smoothing
  let a = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < trs.length; i++) {
    a = (a * (period - 1) + trs[i]) / period;
  }
  return a;
}

// ---------- swings (fractal pivots) ----------
// A swing high at i means high[i] is the highest across [i-n, i+n].
// Returns [{ idx, price, type:'high'|'low', time }] oldest->newest.
function swings(candles, n = 2) {
  const out = [];
  for (let i = n; i < candles.length - n; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - n; j <= i + n; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) out.push({ idx: i, price: candles[i].high, type: 'high', time: candles[i].time });
    if (isLow) out.push({ idx: i, price: candles[i].low, type: 'low', time: candles[i].time });
  }
  return out;
}

// ---------- market structure + BOS / CHoCH ----------
// Walks the alternating swing sequence and records structure breaks.
// BOS  = break of structure  (continuation: breaks last swing in trend direction)
// CHoCH = change of character (first break against the prevailing trend)
function marketStructure(candles, sw) {
  if (sw.length < 2) {
    return { trend: 'undefined', lastBreak: null, events: [] };
  }
  const events = [];
  let trend = 'undefined';
  let lastHigh = null, lastLow = null;

  for (const s of sw) {
    if (s.type === 'high') {
      if (lastHigh && s.price > lastHigh.price) {
        const kind = trend === 'down' ? 'CHoCH' : 'BOS';
        events.push({ kind, dir: 'bullish', price: lastHigh.price, brokenAt: s.time });
        trend = 'up';
      }
      lastHigh = s;
    } else {
      if (lastLow && s.price < lastLow.price) {
        const kind = trend === 'up' ? 'CHoCH' : 'BOS';
        events.push({ kind, dir: 'bearish', price: lastLow.price, brokenAt: s.time });
        trend = 'down';
      }
      lastLow = s;
    }
  }
  return { trend, lastBreak: last(events) || null, events: events.slice(-6) };
}

// ---------- fair value gaps (3-candle imbalance) ----------
// Bullish FVG: low[i] > high[i-2]  -> gap between high[i-2] and low[i]
// Bearish FVG: high[i] < low[i-2]  -> gap between high[i] and low[i-2]
// Reports only gaps not yet fully filled by later price.
function fairValueGaps(candles) {
  const gaps = [];
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2], c = candles[i];
    if (c.low > a.high) gaps.push({ dir: 'bullish', top: c.low, bottom: a.high, idx: i, time: c.time });
    else if (c.high < a.low) gaps.push({ dir: 'bearish', top: a.low, bottom: c.high, idx: i, time: c.time });
  }
  // keep unfilled: no later candle has traded fully through the gap
  const unfilled = gaps.filter((g) => {
    for (let k = g.idx + 1; k < candles.length; k++) {
      if (g.dir === 'bullish' && candles[k].low <= g.bottom) return false;
      if (g.dir === 'bearish' && candles[k].high >= g.top) return false;
    }
    return true;
  });
  return unfilled.slice(-5);
}

// ---------- order blocks ----------
// Bullish OB: last down-close candle before an up-move that breaks the prior swing high.
// Bearish OB: last up-close candle before a down-move that breaks the prior swing low.
// Simplified but practical: anchored to the candle before the impulse leg.
function orderBlocks(candles, sw) {
  const obs = [];
  const highs = sw.filter((s) => s.type === 'high');
  const lows = sw.filter((s) => s.type === 'low');

  // bullish OB: find a swing low, then the down candle just before price rallied off it
  for (const lo of lows.slice(-4)) {
    let obIdx = lo.idx;
    for (let k = lo.idx; k >= Math.max(0, lo.idx - 5); k--) {
      if (candles[k].close < candles[k].open) { obIdx = k; break; }
    }
    obs.push({ dir: 'bullish', top: candles[obIdx].high, bottom: candles[obIdx].low, time: candles[obIdx].time });
  }
  // bearish OB: find a swing high, then the up candle just before price dropped off it
  for (const hi of highs.slice(-4)) {
    let obIdx = hi.idx;
    for (let k = hi.idx; k >= Math.max(0, hi.idx - 5); k--) {
      if (candles[k].close > candles[k].open) { obIdx = k; break; }
    }
    obs.push({ dir: 'bearish', top: candles[obIdx].high, bottom: candles[obIdx].low, time: candles[obIdx].time });
  }
  return obs.slice(-6);
}

// ---------- liquidity pools ----------
// Equal highs / equal lows (clustered swing levels) = resting liquidity.
// tol is fraction of price (e.g. 0.001 = 0.1%).
function liquidity(sw, tol = 0.0015) {
  const cluster = (arr) => {
    const groups = [];
    for (const s of arr) {
      const g = groups.find((gr) => Math.abs(gr.price - s.price) / gr.price <= tol);
      if (g) { g.count++; g.price = (g.price + s.price) / 2; }
      else groups.push({ price: s.price, count: 1, time: s.time });
    }
    return groups.filter((g) => g.count >= 2);
  };
  return {
    equalHighs: cluster(sw.filter((s) => s.type === 'high')).slice(-4),
    equalLows: cluster(sw.filter((s) => s.type === 'low')).slice(-4),
  };
}

// ---------- top-level analyse ----------
export function analyse(candles, { swingN = 2 } = {}) {
  if (!candles || candles.length < 30) {
    return { error: 'not enough candles', count: candles ? candles.length : 0 };
  }
  const closes = candles.map((c) => c.close);
  const price = last(candles).close;
  const sw = swings(candles, swingN);

  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const e200 = ema(closes, 200);
  const v20 = last(e20), v50 = last(e50), v200 = last(e200);

  let stack = 'mixed';
  if (v20 != null && v50 != null && v200 != null) {
    if (v20 > v50 && v50 > v200) stack = 'bullish';       // 20>50>200
    else if (v20 < v50 && v50 < v200) stack = 'bearish';   // 20<50<200
  }

  const ms = marketStructure(candles, sw);
  const a = atr(candles, 14);

  return {
    price,
    atr: a,
    atrPct: a != null ? +(a / price * 100).toFixed(2) : null,
    structure: ms,
    ema: {
      e20: v20 ?? null, e50: v50 ?? null, e200: v200 ?? null,
      stack,
      priceVsE200: v200 != null ? (price > v200 ? 'above' : 'below') : null,
    },
    orderBlocks: orderBlocks(candles, sw),
    fvgs: fairValueGaps(candles),
    liquidity: liquidity(sw),
    swingsRecent: sw.slice(-6),
  };
}
