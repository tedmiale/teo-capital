// /api/archive — manages sprint history.
//   GET  → public read of the archive list (anyone can see Teo's track record)
//   POST → operator-gated; moves current active sprint into archive, clears active state.
//          Only archives if there's a real sprint (snapshots > 0); otherwise just clears.

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const STATE_KEY = "teo:state";
const ARCHIVE_KEY = "teo:archive";

const BLANK = {
  config: null, holdings: [], cash: 0, totalValue: 0,
  snapshots: [], history: [], grade: null,
};

async function redisGet(key) {
  const r = await fetch(UPSTASH_URL + "/get/" + key, {
    headers: { Authorization: "Bearer " + UPSTASH_TOKEN },
  });
  if (!r.ok) throw new Error("Upstash GET failed: " + r.status);
  const body = await r.json();
  return body && body.result != null ? body.result : null;
}

async function redisSet(key, value) {
  const r = await fetch(UPSTASH_URL + "/set/" + key, {
    method: "POST",
    headers: { Authorization: "Bearer " + UPSTASH_TOKEN, "Content-Type": "text/plain" },
    body: value,
  });
  if (!r.ok) throw new Error("Upstash SET failed: " + r.status);
}

export default async function handler(req, res) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return res.status(500).json({ error: "Upstash env vars not configured." });
  }

  if (req.method === "GET") {
    try {
      const raw = await redisGet(ARCHIVE_KEY);
      if (!raw) return res.status(200).json({ sprints: [] });
      const parsed = JSON.parse(raw);
      return res.status(200).json(parsed && Array.isArray(parsed.sprints) ? parsed : { sprints: [] });
    } catch (e) {
      return res.status(502).json({ error: "Failed to read archive: " + (e.message || String(e)) });
    }
  }

  if (req.method === "POST") {
    const opCode = req.headers["x-operator-code"];
    const expected = process.env.OPERATOR_CODE;
    if (!expected) return res.status(500).json({ error: "OPERATOR_CODE not configured on the server." });
    if (!opCode || opCode !== expected) {
      return res.status(403).json({ error: "Not authorized. Operator code required." });
    }

    try {
      const stateRaw = await redisGet(STATE_KEY);
      const current = stateRaw ? JSON.parse(stateRaw) : BLANK;

      // If there are no snapshots, the sprint never actually started — just clear, don't archive empty.
      const hasContent = current.snapshots && current.snapshots.length > 0;

      if (hasContent) {
        const archiveRaw = await redisGet(ARCHIVE_KEY);
        const archive = archiveRaw ? JSON.parse(archiveRaw) : { sprints: [] };
        if (!Array.isArray(archive.sprints)) archive.sprints = [];

        const archivedSprint = Object.assign({}, current, {
          archivedAt: new Date().toISOString(),
        });
        archive.sprints.push(archivedSprint);

        await redisSet(ARCHIVE_KEY, JSON.stringify(archive));
      }

      // Always clear active state, whether we archived or not.
      await redisSet(STATE_KEY, JSON.stringify(BLANK));

      return res.status(200).json({
        ok: true,
        archived: hasContent,
        reason: hasContent ? "sprint archived" : "no snapshots; nothing to archive",
      });
    } catch (e) {
      return res.status(502).json({ error: "Archive failed: " + (e.message || String(e)) });
    }
  }

  return res.status(405).json({ error: "GET or POST only." });
}
