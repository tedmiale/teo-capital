// Vercel serverless function. Lives at the URL /api/teo on your deployed site.
// The app's front-end posts here instead of directly to Anthropic, so the API key
// stays on the server and never reaches the browser.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
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

// Tell Vercel to allow up to 5 minutes for this function (Anthropic web_search can be slow).
export const config = {
  maxDuration: 300,
};
