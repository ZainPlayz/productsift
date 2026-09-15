import crypto from "crypto";
import { sql, ensureSchema } from "./db.js";

// Hand-rolled auth (Node's crypto + Express's own res.cookie()) instead of
// bcrypt/argon2/express-session/jsonwebtoken/cookie-parser - none of this
// project's few dependencies (@neondatabase/serverless, express,
// express-rate-limit, groq-sdk, helmet, zod) do auth, and a few dozen lines
// of stdlib code cover what's actually needed here. Matches the same
// instinct behind e.g. hand-rolling share-link IDs with crypto.randomBytes
// rather than a slug-generator package.

const SESSION_COOKIE = "sid";
const SESSION_DAYS = 30;

function newId() {
  return crypto.randomBytes(6).toString("base64url");
}

// scrypt over bcrypt/argon2 specifically because it's built into Node - no
// native addon, nothing to compile on deploy. Params are embedded in the
// stored string (scrypt:N:r:p:salt:hash) so they can be tuned later without
// invalidating existing hashes, the same "don't hardcode what might need to
// change" instinct behind GROQ_MODEL being env-overridable rather than
// hardcoded in llmClient.js.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const parts = stored.split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  // timingSafeEqual throws on length mismatch rather than returning false -
  // guard that first so a malformed/corrupted hash fails closed, not with a
  // 500.
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId) {
  await ensureSchema();
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await sql`INSERT INTO sessions (id, user_id, expires_at) VALUES (${hashToken(token)}, ${userId}, ${expiresAt.toISOString()})`;
  return { token, expiresAt };
}

export async function destroySession(token) {
  if (!token) return;
  await ensureSchema();
  await sql`DELETE FROM sessions WHERE id = ${hashToken(token)}`;
}

// No cookie-parser dependency for this - the Cookie header is one line to
// split by hand, and this is the only cookie this app ever sets or reads.
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export async function getSessionUser(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  await ensureSchema();
  const rows = await sql`
    SELECT u.id, u.email, u.name
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id = ${hashToken(token)} AND s.expires_at > now()
  `;
  return rows[0] ?? null;
}

// Render terminates TLS at a proxy in front of the app (see
// app.set("trust proxy", 1) in index.js) - req.secure/NODE_ENV alone would
// otherwise make the "secure" cookie flag unreliable in production.
function cookieOptions(expiresAt) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  };
}

export function setSessionCookie(res, token, expiresAt) {
  res.cookie(SESSION_COOKIE, token, cookieOptions(expiresAt));
}

export function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
}

export function getCookieToken(req) {
  return readCookie(req, SESSION_COOKIE);
}

// Mirrors the DB_ENABLED gate pattern already used in routes/projects.js -
// mount this as router.use(requireAuth) on any router that needs a logged-in
// user, same "gate at the top, handlers below can trust req.user" shape.
export async function requireAuth(req, res, next) {
  const user = await getSessionUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in." });
  req.user = user;
  next();
}

export function newUserId() {
  return newId();
}
