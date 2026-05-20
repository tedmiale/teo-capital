// /api/clear-archive — operator-gated nuclear option for the entire sprint history.
// Requires { confirm: "WIPE" } in body to prevent accidental data loss.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ARCHIVE_KEY = "teo:archive";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only." });

  const opCode = req.headers["x-operator-code"];
  const expected = process.env.OPERATOR_CODE;
  if (!expected) return res.status(500).json({ error: "OPERATOR_CODE not configured on the server." });
  if (!opCode || opCode !== expected) {
    return res.status(403).json({ error: "Not authorized. Operator code required." });
  }

  const body = req.body;
  if (!body || body.confirm !== "WIPE") {
    return res.status(400).json({ error: 'Refusing to clear without explicit confirmation. Include { confirm: "WIPE" } in the request body.' });
  }

  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ error: "Upstash env vars not configured." });
  }

  try {
    const r = await fetch(UPSTASH_URL + "/del/" + ARCHIVE_KEY, {
      method: "POST",
      headers: { Authorization: "Bearer " + UPSTASH_TOKEN },
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(502).json({ error: "Delete failed: " + r.status + " " + t.slice(0, 200) });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(502).json({ error: "Clear failed: " + (e.message || String(e)) });
  }
}
