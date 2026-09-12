import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import clusterRouter from "./routes/cluster.js";
import prioritizeRouter from "./routes/prioritize.js";
import prdRouter from "./routes/prd.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

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
  res.json({ mockMode: process.env.MOCK_MODE === "true" });
});

// Lives at the project root (not public/) so it reads as bundled sample data,
// not a static frontend asset - served explicitly here for the "Load Sample
// Data" button.
app.get("/sample-feedback.txt", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "sample-feedback.txt"));
});

app.use("/api/cluster", llmRateLimiter, clusterRouter);
app.use("/api/prioritize", llmRateLimiter, prioritizeRouter);
app.use("/api/prd", llmRateLimiter, prdRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const mock = process.env.MOCK_MODE === "true";
  console.log(`ProductSift running at http://localhost:${PORT}`);
  console.log(mock ? "Mock mode: ON (no Gemini API calls, no API key needed)" : "Mock mode: OFF (calling the live Gemini API)");
});
