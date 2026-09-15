import { Router } from "express";
import crypto from "crypto";
import { sql, ensureSchema, DB_ENABLED } from "../db.js";
import { requireAuth } from "../auth.js";

const router = Router();

router.use((req, res, next) => {
  if (!DB_ENABLED) {
    return res.status(501).json({ error: "Accounts aren't configured on this server - set DATABASE_URL to enable them (see README)." });
  }
  next();
});

router.use(requireAuth);

function newId() {
  return crypto.randomBytes(6).toString("base64url");
}

// Every route below acts on an org the caller belongs to - membership is
// checked with a plain SELECT rather than a reusable helper middleware,
// since some routes need the role (only an owner can add a member) and some
// don't, and there are few enough routes here that a shared abstraction
// would cost more clarity than it saves.
async function membershipOf(orgId, userId) {
  const rows = await sql`SELECT role FROM org_members WHERE org_id = ${orgId} AND user_id = ${userId}`;
  return rows[0]?.role ?? null;
}

router.post("/", async (req, res) => {
  try {
    const { name } = req.body || {};
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Enter an organization name." });
    }
    await ensureSchema();
    const id = newId();
    const trimmed = name.trim();
    await sql`INSERT INTO organizations (id, name, created_by) VALUES (${id}, ${trimmed}, ${req.user.id})`;
    await sql`INSERT INTO org_members (org_id, user_id, role) VALUES (${id}, ${req.user.id}, 'owner')`;
    res.status(201).json({ id, name: trimmed, role: "owner" });
  } catch (err) {
    console.error("org create error:", err);
    res.status(500).json({ error: "Failed to create organization." });
  }
});

router.get("/", async (req, res) => {
  try {
    await ensureSchema();
    const rows = await sql`
      SELECT o.id, o.name, o.created_at, m.role
      FROM organizations o JOIN org_members m ON m.org_id = o.id
      WHERE m.user_id = ${req.user.id}
      ORDER BY o.created_at ASC
    `;
    res.json({ orgs: rows.map((r) => ({ id: r.id, name: r.name, role: r.role, createdAt: r.created_at })) });
  } catch (err) {
    console.error("org list error:", err);
    res.status(500).json({ error: "Failed to load organizations." });
  }
});

router.get("/:orgId/members", async (req, res) => {
  try {
    await ensureSchema();
    const role = await membershipOf(req.params.orgId, req.user.id);
    if (!role) return res.status(404).json({ error: "Organization not found." });
    const rows = await sql`
      SELECT u.id, u.email, u.name, m.role, m.joined_at
      FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE m.org_id = ${req.params.orgId}
      ORDER BY m.joined_at ASC
    `;
    res.json({ members: rows.map((r) => ({ userId: r.id, email: r.email, name: r.name, role: r.role, joinedAt: r.joined_at })) });
  } catch (err) {
    console.error("org members error:", err);
    res.status(500).json({ error: "Failed to load members." });
  }
});

// No email-sending in this project at all - adding someone only works if
// they already have their own account. A pending-invite/invite-link flow is
// a real alternative but needs its own table and token, more than this
// portfolio-scale tool needs right now.
router.post("/:orgId/members", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ error: "Enter an email address." });
    }
    await ensureSchema();
    const role = await membershipOf(req.params.orgId, req.user.id);
    if (!role) return res.status(404).json({ error: "Organization not found." });
    if (role !== "owner") return res.status(403).json({ error: "Only an owner can add members." });

    const userRows = await sql`SELECT id, name FROM users WHERE email = ${email.trim().toLowerCase()}`;
    const target = userRows[0];
    if (!target) {
      return res.status(404).json({ error: "No ProductSift account exists for that email yet - they'll need to sign up first." });
    }
    const existing = await membershipOf(req.params.orgId, target.id);
    if (existing) return res.status(409).json({ error: "That person is already a member." });

    await sql`INSERT INTO org_members (org_id, user_id, role) VALUES (${req.params.orgId}, ${target.id}, 'member')`;
    res.status(201).json({ userId: target.id, name: target.name, role: "member" });
  } catch (err) {
    console.error("org add member error:", err);
    res.status(500).json({ error: "Failed to add member." });
  }
});

router.post("/:orgId/projects", async (req, res) => {
  try {
    const { name } = req.body || {};
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Enter a project name." });
    }
    await ensureSchema();
    const role = await membershipOf(req.params.orgId, req.user.id);
    if (!role) return res.status(404).json({ error: "Organization not found." });

    const id = newId();
    const trimmed = name.trim();
    await sql`INSERT INTO projects (id, org_id, name, created_by) VALUES (${id}, ${req.params.orgId}, ${trimmed}, ${req.user.id})`;
    res.status(201).json({ id, name: trimmed, orgId: req.params.orgId });
  } catch (err) {
    console.error("project create error:", err);
    res.status(500).json({ error: "Failed to create project." });
  }
});

router.get("/:orgId/projects", async (req, res) => {
  try {
    await ensureSchema();
    const role = await membershipOf(req.params.orgId, req.user.id);
    if (!role) return res.status(404).json({ error: "Organization not found." });

    const rows = await sql`
      SELECT p.id, p.name, p.created_at, p.last_analysis_at,
             (SELECT COUNT(*) FROM feedback_drops d WHERE d.project_id = p.id)::int AS drop_count
      FROM projects p
      WHERE p.org_id = ${req.params.orgId}
      ORDER BY p.created_at DESC
    `;
    res.json({
      projects: rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        lastAnalysisAt: r.last_analysis_at,
        dropCount: r.drop_count,
      })),
    });
  } catch (err) {
    console.error("project list error:", err);
    res.status(500).json({ error: "Failed to load projects." });
  }
});

export default router;
