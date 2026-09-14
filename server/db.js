import { neon } from "@neondatabase/serverless";

// Sharing is entirely optional - the rest of the app works with no database
// at all. DATABASE_URL unset just means the /api/projects routes return a
// clear "not configured" error instead of the app crashing on startup.
export const DB_ENABLED = Boolean(process.env.DATABASE_URL);

export const sql = DB_ENABLED ? neon(process.env.DATABASE_URL) : null;

// Runs on first use rather than at startup, so a misconfigured/unreachable
// DATABASE_URL doesn't take down the whole server - only the sharing routes
// that actually need it.
let schemaReady = null;
export function ensureSchema() {
  if (!DB_ENABLED) return Promise.resolve();
  if (!schemaReady) {
    schemaReady = sql`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.catch((err) => {
      schemaReady = null; // let the next request retry instead of staying broken forever
      throw err;
    });
  }
  return schemaReady;
}
