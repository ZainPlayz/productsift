import { Router } from "express";
import crypto from "crypto";
import { sql, DB_ENABLED, ensureSchema } from "../db.js";
import { requireAuth } from "../auth.js";
import { splitFeedbackItems } from "../feedbackItems.js";

const router = Router();

// Generous but not unbounded - a full analysis (themes, quotes, priority
// reasoning, a PRD draft) is a few KB of JSON; this just guards against a
// pathological payload eating into Neon's free-tier storage.
const MAX_DATA_BYTES = 500_000;

// Same cap cluster.js applies to a single paste, applied per drop here -
// a project can still accumulate far more than this across many drops, this
// just stops one drop from being pathologically large.
const MAX_DROP_CHARS = 20000;

function newId() {
  return crypto.randomBytes(6).toString("base64url");
}

router.use((req, res, next) => {
  if (!DB_ENABLED) {
    return res.status(501).json({
      error: "Projects aren't configured on this server - set DATABASE_URL to enable them (see README).",
    });
  }
  next();
});

router.use(requireAuth);

function validateAnalysisData(body) {
  const { data } = body;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const json = JSON.stringify(data);
  if (json.length > MAX_DATA_BYTES) return null;
  return json;
}

// Every route below acts on one project - this joins through to org_members
// so "not a member" and "project doesn't exist" both surface as a 404, never
// a 403 that would confirm a project ID is real to someone who can't see it.
async function projectAccess(projectId, userId) {
  const rows = await sql`
    SELECT p.id, p.org_id, p.name, p.created_at, p.last_analysis, p.last_analysis_at, o.name AS org_name
    FROM projects p
    JOIN organizations o ON o.id = p.org_id
    JOIN org_members m ON m.org_id = p.org_id AND m.user_id = ${userId}
    WHERE p.id = ${projectId}
  `;
  return rows[0] ?? null;
}

router.get("/:projectId", async (req, res) => {
  try {
    await ensureSchema();
    const project = await projectAccess(req.params.projectId, req.user.id);
    if (!project) return res.status(404).json({ error: "Project not found." });

    const drops = await sql`
      SELECT d.id, d.user_id, u.name AS user_name, d.content, d.item_count, d.created_at
      FROM feedback_drops d JOIN users u ON u.id = d.user_id
      WHERE d.project_id = ${req.params.projectId}
      ORDER BY d.created_at ASC
    `;

    // Oldest-first concatenation, one drop's content per line-group - this is
    // handed straight to /api/cluster unchanged, exactly like a single paste
    // today. splitFeedbackItems() (used both here for a running item count
    // and again inside cluster.js on the concatenated whole) is what turns
    // this into the numbered items evidence/attribution line up against.
    const feedback = drops.map((d) => d.content).join("\n");

    res.json({
      id: project.id,
      name: project.name,
      orgId: project.org_id,
      orgName: project.org_name,
      createdAt: project.created_at,
      lastAnalysis: project.last_analysis,
      lastAnalysisAt: project.last_analysis_at,
      drops: drops.map((d) => ({
        id: d.id,
        userId: d.user_id,
        userName: d.user_name,
        content: d.content,
        itemCount: d.item_count,
        createdAt: d.created_at,
      })),
      feedback,
    });
  } catch (err) {
    console.error("project fetch error:", err);
    res.status(500).json({ error: "Failed to load project." });
  }
});

router.post("/:projectId/drops", async (req, res) => {
  try {
    const { content } = req.body || {};
    if (typeof content !== "string" || !content.trim()) {
      return res.status(400).json({ error: "Paste some feedback to add." });
    }
    if (content.length > MAX_DROP_CHARS) {
      return res.status(400).json({ error: `That's too much text in one drop (${content.length} chars). Keep each drop under ${MAX_DROP_CHARS} characters - split it into a couple of drops instead.` });
    }

    await ensureSchema();
    const project = await projectAccess(req.params.projectId, req.user.id);
    if (!project) return res.status(404).json({ error: "Project not found." });

    const itemCount = splitFeedbackItems(content).length;
    if (itemCount === 0) {
      return res.status(400).json({ error: "No feedback items found (each item should be on its own line)." });
    }

    const id = newId();
    await sql`
      INSERT INTO feedback_drops (id, project_id, user_id, content, item_count)
      VALUES (${id}, ${req.params.projectId}, ${req.user.id}, ${content}, ${itemCount})
    `;
    res.status(201).json({ id, itemCount, createdAt: new Date().toISOString() });
  } catch (err) {
    console.error("drop create error:", err);
    res.status(500).json({ error: "Failed to add to project." });
  }
});

// Caches the last computed clustering+prioritization result (same shape as
// the anonymous flow's snapshotState()) so opening a project shows it
// instantly - "Analyze" in the UI always recomputes fresh from every drop
// via the existing /api/cluster -> /api/prioritize sequence; this route only
// ever stores the result of that, never computes anything itself.
router.put("/:projectId/analysis", async (req, res) => {
  try {
    const json = validateAnalysisData(req.body);
    if (!json) {
      return res.status(400).json({ error: "Missing or oversized analysis data." });
    }
    await ensureSchema();
    const project = await projectAccess(req.params.projectId, req.user.id);
    if (!project) return res.status(404).json({ error: "Project not found." });

    await sql`UPDATE projects SET last_analysis = ${json}::jsonb, last_analysis_at = now() WHERE id = ${req.params.projectId}`;
    res.json({ ok: true });
  } catch (err) {
    console.error("project analysis save error:", err);
    res.status(500).json({ error: "Failed to save analysis." });
  }
});

export default router;
