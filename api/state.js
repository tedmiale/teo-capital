// /api/state — public read of portfolio state from Upstash Redis.
// No auth required: this is the dashboard that anyone visiting the site can see.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = "teo:state";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ error: "Upstash env vars not configured." });
  }
  try {
    const r = await fetch(UPSTASH_URL + "/get/" + KEY, {
      headers: { Authorization: "Bearer " + UPSTASH_TOKEN },
    });
    const body = await r.json();
    // Upstash returns { result: <string|null> }
    if (!body || body.result == null) {
      return res.status(200).json({ state: null });
    }
    let parsed;
    try { parsed = JSON.parse(body.result); }
    catch(e) { return res.status(500).json({ error: "Stored state is not valid JSON." }); }
    return res.status(200).json({ state: parsed });
  } catch (e) {
    return res.status(502).json({ error: "Failed to read state: " + (e.message || String(e)) });
  }
}
