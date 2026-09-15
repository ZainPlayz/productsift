import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import clusterRouter from "./routes/cluster.js";
import prioritizeRouter from "./routes/prioritize.js";
import prdRouter from "./routes/prd.js";
import projectsRouter from "./routes/projects.js";
import authRouter from "./routes/authRoutes.js";
import orgsRouter from "./routes/orgs.js";
import { DB_ENABLED } from "./db.js";
import { MOCK_MODE } from "./llmClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Render (and most hosts) terminate TLS at a proxy in front of the app -
// without this, req.secure (and therefore the session cookie's "secure"
// flag) never reflects reality in production.
app.set("trust proxy", 1);

// Standard secure headers. The default CSP is tightened to same-origin, with
// one explicit exception for the jsdelivr CDN this page's index.html loads
// marked.js from - everything else (app.js, style.css) is same-origin.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "https://cdn.jsdelivr.net"],
      },
    },
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

// The 3 routes below call an LLM API - often a free tier with a strict daily/
// per-minute quota - so they're rate-limited per IP to stop a runaway client
// loop or casual abuse from burning through that quota (or, on a paid key,
// from running up a bill) in one burst.
const llmRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests - wait a moment before trying again." },
});

app.get("/api/status", (req, res) => {
  res.json({ mockMode: MOCK_MODE, collabEnabled: DB_ENABLED });
});

// Lives at the project root (not public/) so it reads as bundled sample data,
// not a static frontend asset - served explicitly here for the "Load Sample
// Data" button.
app.get("/sample-feedback.txt", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "sample-feedback.txt"));
});

// A separate, much smaller (9-item) file for "Try a Demo" specifically - a
// live analysis of the full 52-item sample.txt was measured taking 100+
// seconds end to end (a reasoning model's latency on a large batch, see
// server/llmClient.js), which defeats the point of a quick one-click demo.
// This trims to ~3 clear themes, fast enough to actually feel instant.
app.get("/demo-feedback.txt", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "demo-feedback.txt"));
});

app.use("/api/cluster", llmRateLimiter, clusterRouter);
app.use("/api/prioritize", llmRateLimiter, prioritizeRouter);
app.use("/api/prd", llmRateLimiter, prdRouter);

// Org/project CRUD and drop uploads don't call an LLM, so they get a much
// more generous limit than the LLM routes above - it only needs to stop
// outright abuse of the DB, not ration a scarce daily quota.
const dbRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests - wait a moment before trying again." },
});
app.use("/api/orgs", dbRateLimiter, orgsRouter);
app.use("/api/projects", dbRateLimiter, projectsRouter);

// Its own, tighter limiter - brute-forcing a password or enumerating emails
// via signup/login is a different threat than the LLM-quota and DB-abuse
// tiers above, and deserves a tighter budget than either.
const authRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests - wait a moment before trying again." },
});
app.use("/api/auth", authRateLimiter, authRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ProductSift running at http://localhost:${PORT}`);
  console.log(MOCK_MODE ? "Mock mode: ON (no Groq API calls, no API key needed)" : "Mock mode: OFF (calling the live Groq API)");
});
