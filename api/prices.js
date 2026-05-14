// /api/prices — public price proxy. No auth, no Anthropic, no token cost.
// Browser sends a comma-separated ticker list, server fetches from a free
// upstream and returns { ticker: price }. Yahoo first, Stooq as fallback.

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

  // Yahoo: single-call batch via /v7/finance/quote
  try {
    const url = "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" + encodeURIComponent(tickers.join(","));
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TeoCapital/1.0)" },
    });
    if (r.ok) {
      const data = await r.json();
      const quotes = (data && data.quoteResponse && data.quoteResponse.result) || [];
      quotes.forEach(q => {
        const sym = q.symbol;
        const px = q.regularMarketPrice ?? q.postMarketPrice ?? q.preMarketPrice;
        if (sym && typeof px === "number") results[sym] = px;
      });
    } else {
      errors.yahoo = "HTTP " + r.status;
    }
  } catch (e) {
    errors.yahoo = e.message || String(e);
  }

  // For anything Yahoo missed, try Stooq one ticker at a time (CSV).
  const missing = tickers.filter(t => !(t in results));
  for (const t of missing) {
    try {
      // Stooq uses lowercase + .us suffix for US tickers
      const url = "https://stooq.com/q/l/?s=" + encodeURIComponent(t.toLowerCase()) + ".us&f=sd2t2ohlcv&h&e=csv";
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (!r.ok) continue;
      const txt = await r.text();
      // CSV: Symbol,Date,Time,Open,High,Low,Close,Volume
      const lines = txt.trim().split("\n");
      if (lines.length < 2) continue;
      const cols = lines[1].split(",");
      const close = parseFloat(cols[6]);
      if (Number.isFinite(close)) results[t] = close;
    } catch (e) {
      // swallow per-ticker errors; we'll just return what we got
    }
  }

  return res.status(200).json({
    prices: results,
    asOf: new Date().toISOString(),
    errors: Object.keys(errors).length ? errors : undefined,
  });
}
