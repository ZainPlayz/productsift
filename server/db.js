import { neon } from "@neondatabase/serverless";

// The collaborative platform (auth, orgs, projects) is entirely optional -
// the anonymous single-paste flow works with no database at all. DATABASE_URL
// unset just means the /api/auth, /api/orgs, /api/projects routes return a
// clear "not configured" error instead of the app crashing on startup.
export const DB_ENABLED = Boolean(process.env.DATABASE_URL);

export const sql = DB_ENABLED ? neon(process.env.DATABASE_URL) : null;

// Runs on first use rather than at startup, so a misconfigured/unreachable
// DATABASE_URL doesn't take down the whole server - only the routes that
// actually need it. Several CREATE TABLE statements in FK-dependency order
// (users -> sessions/organizations -> org_members/projects -> feedback_drops)
// - Neon's tagged-template sql function is one statement per call, so this is
// an async IIFE awaiting each in turn rather than the single template literal
// this used to be back when there was only the one anonymous "projects" table.
let schemaReady = null;
export function ensureSchema() {
  if (!DB_ENABLED) return Promise.resolve();
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          name TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      // id is sha256(cookie token), never the raw token - so a database read
      // alone (a backup, a leaked query log) can't be replayed as a session.
      await sql`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at TIMESTAMPTZ NOT NULL
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS org_members (
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'member',
          joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (org_id, user_id)
        )
      `;
      // last_analysis/last_analysis_at cache the most recently computed
      // clustering+prioritization result (the same shape app.js's
      // snapshotState() already produces) so opening a project shows
      // something instantly without forcing a fresh LLM run - "Analyze"
      // always recomputes fully from every drop below, this is just a cache
      // of that result, never a second source of truth for it.
      await sql`
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_analysis JSONB,
          last_analysis_at TIMESTAMPTZ
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS feedback_drops (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id),
          content TEXT NOT NULL,
          item_count INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql`CREATE INDEX IF NOT EXISTS idx_drops_project ON feedback_drops(project_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`;
    })().catch((err) => {
      schemaReady = null; // let the next request retry instead of staying broken forever
      throw err;
    });
  }
  return schemaReady;
}
