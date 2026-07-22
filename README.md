# SMC Collector

Scheduled hybrid feed for the crypto trading tool. Every hour it:

1. Pulls OHLCV candles from **Bybit** (free, no key) for each symbol/timeframe
2. Computes **SMC features** — market structure (BOS/CHoCH), order blocks, fair value gaps, liquidity pools, EMA stack, ATR
3. Pulls **24h turnover + open interest** (liquidity gate) for each symbol
4. Grabs a **TradingView chart image** via chart-img (optional, on a slower cadence)
5. Writes everything to `data/latest.json` for the tool to read

No always-on PC. Runs on GitHub Actions' servers.

### Cadence & chart-img quota
Data runs **hourly**. Images are the expensive bit (chart-img has a request cap), so by default they only refresh **every 4 hours** — set by the `IMAGE_EVERY_HOURS` repo variable (Settings → Secrets and variables → Actions → Variables). Set it to `1` to pull images every hour (needs a paid chart-img plan), or higher to save more. On non-image hours the SMC data and prices still refresh; the chart slots just won't auto-fill (paste your own, or use the data-only read). Math: 5 coins × 3 timeframes = 15 image calls per image-run → hourly 360/day, 4-hourly 90/day, 6-hourly 60/day.

## Setup (10 min)

1. **New GitHub repo** (private is fine). Drop these files in.
2. **chart-img key** (optional, for the images):
   - Sign in at https://chart-img.com with Google → copy your API key
   - Repo → Settings → Secrets and variables → Actions → New secret
   - Name `CHART_IMG_KEY`, paste the key
   - *(optional)* `CHART_IMG_LAYOUT` = your saved TradingView layout ID (so your own SMC indicators come through). Leave unset to use the default EMA20/50/200 + volume setup.
3. **Enable Actions**: repo → Actions tab → enable workflows.
4. **Test it**: Actions → SMC Collector → *Run workflow*. Check `data/latest.json` updates.

That's it — it now runs itself every 4h. Data-only mode works fine with no chart-img key.

## Config

Edit the top of `collector.mjs`:
- `SYMBOLS` — add/remove coins. `dataSymbol` = Bybit perp, `tvSymbol` = TradingView ticker for the image. **Verify each ticker exists on Bybit** before relying on it (newer listings like ASTER may differ).
- `TIMEFRAMES` — currently 1h / 4h / 1D.

## Wire into the tool

Your tool fetches the JSON from the repo's raw URL:

```
https://raw.githubusercontent.com/<you>/<repo>/main/data/latest.json
```

Each symbol gives you a multi-timeframe `bias` plus, per timeframe, the full `smc` object (structure, order blocks, FVGs, liquidity, EMA stack) and an `image` URL. Feed the image to Claude vision as you do now, and pass the `smc` numbers in the prompt so the model reasons off hard data, not just the picture.

## Local run

```
node collector.mjs --mock   # offline, synthetic candles — proves the pipeline
node collector.mjs          # live
```

## Notes / honest limitations

- SMC detection here is **rules-based and deliberately simple** (fractal swings, 3-candle FVGs, last-opposing-candle order blocks). It's a solid first read, not gospel — treat it as confluence alongside your own eyes.
- chart-img free tier has a request cap. 5 symbols × 3 timeframes = 15 image calls per run, 6 runs/day = 90/day. Check that fits your plan or trim timeframes.
- History files accumulate in `data/`. Prune them occasionally or add a cleanup step.
