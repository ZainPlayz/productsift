import { Router } from "express";
import crypto from "crypto";
import { sql, DB_ENABLED, ensureSchema } from "../db.js";

const router = Router();

// Generous but not unbounded - a full analysis (themes, quotes, RICE
// reasoning, a PRD draft) is a few KB of JSON; this just guards against a
// pathological payload eating into Neon's free-tier storage.
const MAX_DATA_BYTES = 500_000;

// 8 URL-safe characters - short enough to read out loud, ~2.8e14 possible
// values so collisions are not a practical concern at this project's scale.
function newId() {
  return crypto.randomBytes(6).toString("base64url");
}

router.use((req, res, next) => {
  if (!DB_ENABLED) {
    return res.status(501).json({
      error: "Sharing isn't configured on this server - set DATABASE_URL to enable it (see README).",
    });
  }
  next();
});

function validateData(body) {
  const { data } = body;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const json = JSON.stringify(data);
  if (json.length > MAX_DATA_BYTES) return null;
  return json;
}

router.post("/", async (req, res) => {
  try {
    const json = validateData(req.body);
    if (!json) {
      return res.status(400).json({ error: "Missing or oversized project data." });
    }
    await ensureSchema();
    const id = newId();
    await sql`INSERT INTO projects (id, data) VALUES (${id}, ${json}::jsonb)`;
    res.status(201).json({ id });
  } catch (err) {
    console.error("project create error:", err);
    res.status(500).json({ error: "Failed to save project." });
  }
});

router.get("/:id", async (req, res) => {
  try {
    await ensureSchema();
    const rows = await sql`SELECT data, updated_at FROM projects WHERE id = ${req.params.id}`;
    if (!rows.length) return res.status(404).json({ error: "Project not found - the link may be wrong, or the project was never saved." });
    res.json({ data: rows[0].data, updatedAt: rows[0].updated_at });
  } catch (err) {
    console.error("project fetch error:", err);
    res.status(500).json({ error: "Failed to load project." });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const json = validateData(req.body);
    if (!json) {
      return res.status(400).json({ error: "Missing or oversized project data." });
    }
    await ensureSchema();
    const result = await sql`
      UPDATE projects SET data = ${json}::jsonb, updated_at = now()
      WHERE id = ${req.params.id}
      RETURNING id
    `;
    if (!result.length) return res.status(404).json({ error: "Project not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error("project update error:", err);
    res.status(500).json({ error: "Failed to update project." });
  }
});

export default router;
