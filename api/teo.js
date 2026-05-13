// /api/teo — proxy to Anthropic, gated by operator code.
// Only requests bearing the correct x-operator-code header reach Anthropic.
// Visitors without the code get 403 immediately — no tokens spent.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const opCode = req.headers["x-operator-code"];
  const expected = process.env.OPERATOR_CODE;
  if (!expected) {
    return res.status(500).json({ error: "OPERATOR_CODE env var not configured on the server." });
  }
  if (!opCode || opCode !== expected) {
    return res.status(403).json({ error: "Not authorized. Operator code required to spend tokens." });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY env var not set on the server." });
  }

  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify(req.body),
    });

    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", "application/json");
    return res.send(text);
  } catch (e) {
    return res.status(502).json({ error: "Upstream fetch failed: " + (e.message || String(e)) });
  }
}

export const config = {
  maxDuration: 300,
};
