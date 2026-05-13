// /api/save — persist portfolio state to Upstash Redis.
// Requires operator code. Visitors without the code cannot modify shared state.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = "teo:state";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const opCode = req.headers["x-operator-code"];
  const expected = process.env.OPERATOR_CODE;
  if (!expected) return res.status(500).json({ error: "OPERATOR_CODE env var not configured." });
  if (!opCode || opCode !== expected) {
    return res.status(403).json({ error: "Not authorized. Operator code required to modify state." });
  }

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ error: "Upstash env vars not configured." });
  }

  const body = req.body;
  if (!body || typeof body.state !== "object" || body.state == null) {
    return res.status(400).json({ error: "Body must be { state: <object> }." });
  }

  try {
    const value = JSON.stringify(body.state);
    // Upstash REST: POST with the value as the body to /set/<key>
    const r = await fetch(UPSTASH_URL + "/set/" + KEY, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + UPSTASH_TOKEN,
        "Content-Type": "text/plain",
      },
      body: value,
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(502).json({ error: "Upstash write failed: " + r.status + " " + t.slice(0,200) });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(502).json({ error: "Failed to save state: " + (e.message || String(e)) });
  }
}
