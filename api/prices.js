// /api/prices — public price proxy. No auth from the browser, no Anthropic, no token cost.
// Primary: Finnhub (free tier, 60 calls/min, requires FINNHUB_API_KEY env var).
// Fallback: Stooq CSV (free, no key, occasionally rate-limited).

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

export default async function handler(req, res) {
  const tickersParam = (req.query.tickers || "").toString().trim();
  if (!tickersParam) {
    return res.status(400).json({ error: "tickers query param required, e.g. ?tickers=AAPL,NVDA" });
  }
  const tickers = tickersParam.split(",").map(t => t.trim().toUpperCase()).filter(Boolean).slice(0, 30);
  if (!tickers.length) {
    return res.status(400).json({ error: "no valid tickers parsed" });
  }

  const results = {};
  const errors = {};

  // Primary: Finnhub /quote endpoint, one ticker at a time but parallel.
  if (FINNHUB_KEY) {
    await Promise.all(tickers.map(async function(t) {
      try {
        const url = "https://finnhub.io/api/v1/quote?symbol=" + encodeURIComponent(t) + "&token=" + encodeURIComponent(FINNHUB_KEY);
        const r = await fetch(url);
        if (!r.ok) { errors[t] = "finnhub HTTP " + r.status; return; }
        const data = await r.json();
        // Finnhub returns { c: current, h, l, o, pc, ... }. c=0 means no data for symbol.
        if (data && typeof data.c === "number" && data.c > 0) {
          results[t] = data.c;
        }
      } catch (e) {
        errors[t] = "finnhub: " + (e.message || String(e));
      }
    }));
  } else {
    errors._key = "FINNHUB_API_KEY not set on server";
  }

  // Fallback: Stooq CSV for any ticker we still don't have a price for.
  const missing = tickers.filter(t => !(t in results));
  for (const t of missing) {
    try {
      const url = "https://stooq.com/q/l/?s=" + encodeURIComponent(t.toLowerCase()) + ".us&f=sd2t2ohlcv&h&e=csv";
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) continue;
      const txt = await r.text();
      const lines = txt.trim().split("\n");
      if (lines.length < 2) continue;
      const cols = lines[1].split(",");
      const close = parseFloat(cols[6]);
      if (Number.isFinite(close) && close > 0) results[t] = close;
    } catch (e) {
      // per-ticker failures are silent; we return what we got
    }
  }

  return res.status(200).json({
    prices: results,
    asOf: new Date().toISOString(),
    errors: Object.keys(errors).length ? errors : undefined,
  });
}
