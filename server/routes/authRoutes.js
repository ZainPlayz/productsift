import { Router } from "express";
import { sql, ensureSchema, DB_ENABLED } from "../db.js";
import { hashPassword, verifyPassword, createSession, destroySession, setSessionCookie, clearSessionCookie, getSessionUser, getCookieToken, newUserId } from "../auth.js";

const router = Router();

router.use((req, res, next) => {
  if (!DB_ENABLED) {
    return res.status(501).json({ error: "Accounts aren't configured on this server - set DATABASE_URL to enable them (see README)." });
  }
  next();
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name };
}

router.post("/signup", async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (typeof email !== "string" || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
    }
    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Enter your name." });
    }

    await ensureSchema();
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await sql`SELECT id FROM users WHERE email = ${normalizedEmail}`;
    if (existing.length) {
      return res.status(409).json({ error: "An account with that email already exists - log in instead." });
    }

    const id = newUserId();
    const passwordHash = hashPassword(password);
    await sql`INSERT INTO users (id, email, password_hash, name) VALUES (${id}, ${normalizedEmail}, ${passwordHash}, ${name.trim()})`;

    const { token, expiresAt } = await createSession(id);
    setSessionCookie(res, token, expiresAt);
    res.status(201).json({ user: { id, email: normalizedEmail, name: name.trim() } });
  } catch (err) {
    console.error("signup error:", err);
    res.status(500).json({ error: "Failed to create account." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Enter your email and password." });
    }

    await ensureSchema();
    const rows = await sql`SELECT id, email, name, password_hash FROM users WHERE email = ${email.trim().toLowerCase()}`;
    const user = rows[0];
    // Same generic message whether the email doesn't exist or the password
    // is wrong - don't let login responses reveal which accounts exist.
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "Incorrect email or password." });
    }

    const { token, expiresAt } = await createSession(user.id);
    setSessionCookie(res, token, expiresAt);
    res.json({ user: publicUser(user) });
  } catch (err) {
    console.error("login error:", err);
    res.status(500).json({ error: "Failed to log in." });
  }
});

router.post("/logout", async (req, res) => {
  try {
    await destroySession(getCookieToken(req));
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    console.error("logout error:", err);
    res.status(500).json({ error: "Failed to log out." });
  }
});

// Never 401s - this is how the frontend decides logged-in vs logged-out view
// on every page load, a missing/invalid session is just {user: null}, not an
// error.
router.get("/me", async (req, res) => {
  try {
    const user = await getSessionUser(req);
    res.json({ user: user ? publicUser(user) : null });
  } catch (err) {
    console.error("me error:", err);
    res.status(500).json({ error: "Failed to check session." });
  }
});

export default router;
