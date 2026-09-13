# ProductSift

Turns a batch of messy, unstructured user feedback into evidence-backed themes, a transparent
RICE-prioritized roadmap, a PM decision on each item, and an auto-drafted, decision-aware PRD —
exportable as a presentable artifact, not just a webpage.

Built as a portfolio project to demonstrate the full PM loop: **raw feedback → evidence-backed
themes → transparent RICE → PM decision → decision-sensitive roadmap → actionable PRD →
exportable artifact.**

## What it does

1. **Input** — paste raw feedback (app reviews, survey responses, support tickets) or upload a `.txt` file.
2. **Synthesis** — three single-purpose LLM calls with a code-owned gate between them: discover
   themes with explicit definitions, classify each item's distilled primary issue against those
   definitions with a fit score, then a separate skeptical pass validates every classification
   that clears the fit threshold before it's accepted. **Frequency is computed in code**, never
   asked of the model, so a theme's evidence can only ever contain items that passed both gates.
   Anything ambiguous, unvalidated, or simply unmatched becomes `unclassified` with a stated
   reason — never forced into the nearest-sounding theme. Every theme's "View supporting feedback"
   panel shows the full numbered list with a fit flag on borderline classifications, and lets a PM
   reassign any item on the spot if the AI got it wrong — frequency updates immediately.
3. **Prioritization** — each theme is scored with **RICE** (Reach × Impact × Confidence / Effort),
   with the model's reasoning shown for every input, not just the final number. **Frequency and
   Reach are shown as two distinct columns** — one a fact about your sample, the other an AI
   projection onto your user base. Every RICE input is editable, recalculates instantly, and an
   edited value is visibly marked as a PM override with a one-click reset back to the AI's number.
4. **Roadmap Summary** — the top 3 themes, with a **"Why this is #1"** explanation and a
   **decision sensitivity** analysis (what would have to change for the ranking to flip) computed
   directly from the RICE numbers, no extra AI call. Each item gets an explicit PM
   **Decision** — Build / Investigate / Defer / Reject — independent of its rank.
5. **PRD generation** — draft a one-pager for any of the top 3 themes: problem statement,
   proposed solution, scope (in/out), background, user stories, success metrics, and open
   questions. The PRD's framing adapts to the PM's decision (an "Investigate" PRD reads as a
   validated recommendation, not a commitment; a "Reject" PRD reads as a decision record).
6. **Export** — Print/Save as PDF (the full pipeline, top to bottom, with decisions), Copy PRD,
   or Copy Roadmap Summary as plain text — a tangible output, not just a page you leave open.

## Setup

```bash
npm install
cp .env.example .env
```

By default `.env` has `MOCK_MODE=true`, so you can run the whole app immediately with **no
API key** — every step returns realistic templated data instead of calling Groq. This is
how the pipeline was built and tested end-to-end.

To get real, AI-generated clustering/scoring/PRD output:

1. Get a **free** key (no credit card needed) at
   [console.groq.com/keys](https://console.groq.com/keys).
2. In `.env`, set `GROQ_API_KEY=...` and `MOCK_MODE=false`.

Then run:

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000). Click **Load Sample Data** to try it
instantly with the bundled `sample-feedback.txt` (fictional feedback for a task-management app).

Use `npm run dev` instead of `npm start` during development — it auto-restarts the server on
file changes (`node --watch`). Note: `--watch`'s file-watcher has been unreliable in some Windows
setups during this project's development (spurious restarts, occasional unexplained exits) - if
the dev server keeps dying for no obvious reason, fall back to plain `npm start` and restart
manually after edits.

## Deploy

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ZainPlayz/productsift)

This repo includes a `render.yaml` blueprint, so Render auto-detects the service config. Three
steps to go live:

1. Click the button above (or **New +** → **Blueprint** on [Render](https://dashboard.render.com)
   and point it at this repo).
2. When prompted, add `GROQ_API_KEY` as an environment variable (Render's blueprint flow asks
   for any var marked `sync: false` — the key never gets committed to the repo).
3. Deploy. Render builds with `npm install` and starts with `npm start`.

**Public deployments default to `MOCK_MODE=true`** (set in `render.yaml`) — a shared free-tier
Groq quota (1,000 requests/day for the default model) would otherwise be exhausted by enough
visitors clicking around, breaking the demo for everyone including you. Flip it to `false` in
the Render dashboard if you want a specific deployment to run real live analysis instead,
understanding that tradeoff.

Any other Node host works too (Railway, Fly.io, etc.) — the app only needs `npm install` /
`npm start`, a `PORT` env var (already read from `process.env.PORT`), and the two vars above.

## Why Groq instead of a paid API (and why it replaced Gemini)

**This project originally ran on Google Gemini** (`gemini-3.6-flash`) and switched to Groq
during development, for two concrete, measured reasons rather than a hunch:

1. **Speed.** Live testing repeatedly showed full analysis runs taking 60+ seconds under
   Gemini's free-tier load, occasionally ending in a `503` ("high demand") after all retries
   were exhausted — confirmed via server logs, not assumed. Groq runs inference on custom LPU
   hardware built specifically for low-latency generation, which is the actual product Groq
   sells; it's the direct fix for "analysis takes too long," not a workaround.
2. **Quota.** Gemini's free tier allowed **20 requests/day** — confirmed by hitting it more than
   once during development (each full run costs 5 requests: 3 for clustering's discover/classify/
   validate pipeline, 1 for prioritize, 1 for PRD, so ~4 full runs/day). Groq's free tier for
   `llama-3.3-70b-versatile` allows **1,000 requests/day** — about 200 full runs/day, roughly a
   50x improvement, without changing anything about the three-call architecture that caused the
   original quota pressure.

Both are free, no-credit-card tiers, which matters for a project you re-run constantly while
building and demoing it — the rate-limiting practices below (per-IP limits, retry-with-backoff)
apply the same way regardless of provider.

**One tradeoff worth being upfront about**: Groq serves open-weight models (Llama, in this
project's case), not Gemini's proprietary flash models — a genuinely different model, not just a
faster host for the same one. Output quality (RICE reasoning, PRD prose, classification judgment)
needed to be re-verified after the switch, the same diligence originally applied to Gemini, not
assumed to transfer. Also note: Groq's *strict* JSON-schema mode (100%-guaranteed structural
adherence) is currently limited to GPT-OSS/Qwen models on Groq, not Llama - see `llmClient.js`.
Llama's schema-following is best-effort, validated by the same Zod `.parse()` safety net the app
already relied on with Gemini, not a new risk introduced by the switch.

If you exhaust Groq's quota, the API returns a `429`; `MOCK_MODE=true` keeps the app fully
demoable while you wait. `GROQ_MODEL=llama-3.1-8b-instant` in `.env` trades reasoning quality for
an even higher daily cap (14,400/day) if that tradeoff is ever worth making — see current limits
at [console.groq.com/docs/rate-limits](https://console.groq.com/docs/rate-limits).

## Security & rate limiting

- **The API key never reaches the browser.** It lives only in `.env`, read server-side by
  `server/llmClient.js`. The frontend only ever talks to this app's own `/api/*` routes.
- **Per-IP rate limiting** (`express-rate-limit`, in `server/index.js`) caps the three
  LLM-calling routes (`/api/cluster`, `/api/prioritize`, `/api/prd`) at 10 requests/minute per
  IP. This protects a free-tier quota (or a paid bill) from a runaway client loop or casual
  abuse, and returns a clear `429` with a JSON error the frontend already displays.
- **Standard security headers** (`helmet`) — CSP, no-sniff, frame-ancestors, etc. The CSP is
  locked to same-origin with one explicit exception for the jsdelivr CDN `index.html` loads
  `marked.js` from.
- **Input caps, not just payload-size limits.** Beyond the 1 MB JSON body limit, `cluster.js`
  caps feedback text at 20,000 characters and `prioritize.js` caps the themes array at 30
  entries — defense in depth against a request quietly costing far more than intended.
- **No secrets committed.** `.env` and `.claude/settings.local.json` are gitignored;
  `.env.example` documents the shape without real values.
- **Retries with backoff on transient provider errors.** A free tier occasionally returns `429`
  (rate limited) or a `5xx` (server-side issue) briefly before succeeding on retry -
  `createChatCompletionWithRetry()` in `server/llmClient.js` retries those specifically (up to
  3x, exponential backoff), and only those - a `400` (bad request) fails immediately rather than
  retrying a request that will never succeed.
- **PRD generation has a hard anti-hallucination guardrail.** Early testing surfaced the model
  inventing plausible-sounding but fake numbers (e.g. "1,200 active users") in the PRD prose.
  The system prompt in `server/routes/prd.js` now restricts it to only the exact
  frequency/severity/RICE-input numbers present in the theme data, and to describe metrics
  directionally ("reduce load time materially") rather than assert invented targets.

This is still a local single-user demo, not a hardened multi-tenant service — there's no auth,
and the rate limiter's per-IP state resets if the process restarts. Good enough for a portfolio
demo and a real starting point, not a substitute for review before any public deployment.

## Why it's built this way (for interviews)

**Why every theme carries full traceability back to the original feedback (v1.1).**
Early versions only showed 2-3 example quotes per theme, which is functionally "trust me, this
is a theme." The model now returns `supporting_item_numbers` — every feedback item number that
raised the theme, not just the illustrative ones — and `frequency` is computed in code as the
length of that list rather than asked of the model directly (see `cluster.js`), the same
"never trust the model's arithmetic" pattern `rice_score` already used. The UI's "View
supporting feedback" panel renders the full numbered list, so a PM (or an interviewer) can
click through from "17 feedback items" to the actual 17 items.

**Why frequency and severity are separate axes, not one blended score — and why frequency and
reach are two different numbers, not the same one (v1.1).**
A theme can be mentioned constantly but be low-stakes (a cosmetic nitpick), or mentioned
rarely but be severe (a data-loss bug one power user hit). Collapsing those into a single
"importance" number would hide that distinction. The same discipline applies one step further
down: frequency (how many feedback items raised it) and reach (the AI's projection of how many
users in the wider base are affected) are related but not interchangeable — 30 complaints in a
sample doesn't mean 30% of the user base is affected. The RICE table shows both columns side by
side rather than deriving one from the other with a fixed multiplier, and the prompt in
`prioritize.js` explicitly tells the model not to just scale frequency by a constant.

**Why RICE scores are always computed in code, never trusted from the model.**
The LLM estimates the four RICE inputs (Reach, Impact, Confidence, Effort) with reasoning for
each — see `server/routes/prioritize.js`. The actual `rice_score = (reach × impact ×
confidence/100) / effort` arithmetic always happens in JavaScript, both server-side and again
client-side when a user edits an input. This guarantees the score is never inconsistent with
its inputs, and makes the recalculation instant without a network round-trip.

**Why RICE inputs are editable, not fixed — and why an edit is visually marked as a PM override,
not silently blended in (v1.1).**
An LLM's Reach/Effort estimates are a *starting point*, not ground truth — a real PM would
override them with actual analytics and engineering estimates. Making them editable in the UI
is a deliberate acknowledgment that this tool assists judgment, it doesn't replace it. The
original AI estimate for each field is kept in memory (`ai_estimate` on the theme object) even
after editing, so the moment a value diverges from it the cell gets a visible highlight, an
"AI: &lt;original&gt;" note, and a one-click reset — the interface should never let "the AI's
number" and "the PM's judgment call" look identical once they've diverged.

**Why the model's RICE response is matched back to themes by array position, not trusted to
echo the theme's identity fields (v1.1).**
Early on, `prioritize.js` asked the model to return the full theme object (name, summary,
frequency, severity) alongside its 4 RICE estimates, and just trusted that copy back. Now the
schema only asks for the 4 RICE fields plus their reasoning, in the same order as the input
themes; the route re-attaches every identity field from the original clustered theme by index.
One less thing an LLM could subtly alter (a reworded summary, a dropped feedback item number)
on a call that was never supposed to touch it.

**Why there's a mock mode.**
The build was done in dependency order (input plumbing → clustering → prioritization → PRD),
each stage tested before the next was built, per typical incremental PM/eng workflow. Mock
mode (`MOCK_MODE=true`) let every stage be verified end-to-end — including the RICE math and
the UI — without needing an API key or spending anything on LLM calls during development.

**Why structured outputs (Zod schemas) instead of asking the model to "return JSON".**
`server/schemas.js` defines the exact shape expected back from the clustering and
prioritization calls. Zod v4's built-in `z.toJSONSchema()` converts those schemas into the JSON
Schema Groq's `response_format: {type: "json_schema", ...}` config expects (see
`toGroqResponseFormat()` in `server/llmClient.js`), and the response is validated against the
same Zod schema again on the way back in. One schema drives both the request and the
validation — nothing is duplicated by hand, and there's no free-text JSON to parse/repair.

**Why the PRD has a Proposed Solution and a Scope section, and why the pipeline has a Roadmap
Summary step before the PRD (v1.1).**
The original PRD jumped straight from "here's the problem" to user stories, which reads more
like a well-organized bug report than a handoff document. `prd.js` now asks for a concrete
(if lightweight) Proposed Solution, and an explicit In Scope / Out of Scope list — the same
anti-hallucination guardrail that stops the model from inventing user counts applies here too,
so Out of Scope has to name real, plausible-sounding adjacent work rather than generic filler.
Between the RICE table and the PRD, a Roadmap Summary now shows the top 3 themes with their
score and evidence at a glance and lets the PM choose which one to draft a PRD for (not always
just #1) — a closer analog to how a real prioritization review ends: with a short list and a
decision, not a jump straight into writing.

**Why RICE ranks but a separate Decision field is what a PM actually commits to (v1.2).**
RICE is a prioritization framework, not a decision-maker - a lower-scoring item can still be
worth investigating if the evidence behind it is thin, and a high scorer can still be deferred
for reasons RICE doesn't capture (a dependency, a strategic call). So every roadmap item gets an
explicit Build/Investigate/Defer/Reject control, independent of its rank, and that decision then
shapes how the PRD is framed (see `DECISION_FRAMING` in `prd.js`) - "Investigate" reads as a
recommendation pending validation, not a commitment; "Reject" reads as a decision record, not a
pitch.

**Why "Why this is #1" and "Decision sensitivity" are computed in JavaScript, with zero
additional LLM calls (v1.2).**
Both panels are pure arithmetic over numbers already on screen. The ranking explanation buckets
each RICE input as Low/Moderate/High - reach and effort relative to the *current* theme set
(a percentile rank, since "high reach" means something different in a 5-theme batch than a
30-theme one), impact and confidence against fixed PM-standard bands - and composes a sentence
from those buckets. The sensitivity analysis rearranges `rice_score = reach*impact*confidence/
100/effort` algebraically to solve for the reach/confidence/effort value at which the #1 theme
would tie the #2 theme, holding the other inputs fixed. Neither needed a prompt: the interesting
product idea here isn't "ask the AI to explain itself," it's "the numbers already imply this
explanation, so compute it directly and it's instant, free, and exactly reproducible." Both stay
live - editing any RICE input re-renders them along with the rest of the roadmap summary.

**Why the PRD and Roadmap Summary get their own Export step instead of relying on a passive
print stylesheet alone (v1.2).**
Print CSS already existed (v1), but "the browser happens to render this reasonably when you hit
Ctrl+P" isn't the same as an intentional export action. The Export section makes it explicit -
Print/PDF, Copy PRD (raw Markdown, decision appended), Copy Roadmap Summary (plain text) - and a
few small print-specific rules were needed to make the printed artifact match what a PM would
actually want to hand someone: theme cards' supporting-feedback lists print in full even if never
expanded on screen, and each decision `<select>` swaps for its selected value as plain text
(a dropdown control doesn't mean anything on paper).

**How the clustering architecture evolved - v1.1 → v1.3 → v1.4.** This is the single biggest
change in the project's history and worth walking through as a sequence, not just a final state:
- **v1.1**: one model call, asked to invent themes AND independently decide which feedback items
  support each one. This let incidental wording hijack a classification - a dark-mode request got
  swept into "performance" because both happened to mention the app at night.
- **v1.3**: split into two narrower questions in one call - discover themes, then classify every
  item into the ONE theme representing its primary complaint (or `"unclassified"`). Better, but
  still one call reasoning over the full noisy feedback text, and still trusting a single pass's
  self-reported confidence with no independent check.
- **v1.4 (current)**: three single-purpose calls with a code-owned gate between them, because the
  remaining failure mode was still "one model call doing too much at once," just at a smaller
  scale. See `cluster.js`:
  1. **Discovery** - extract a clean `primary_issue` per item (stripped of context/asides) *and*
     propose themes with an explicit **definition** (not just a name) from those extracted issues.
     No item-to-theme assignment happens here.
  2. **Classification** - given ONLY a primary issue and the theme definitions (never the raw
     feedback text), return the best *and* second-best matching theme with a 0-1 fit score each.
  3. **Code gate**: a classification is only tentatively accepted if `best_fit >= 0.8` AND it
     beats the runner-up by a margin `>= 0.15` (`ACCEPT_MIN_FIT` / `ACCEPT_MIN_MARGIN` in
     `cluster.js`) - precision over recall, deliberately. Anything else is unclassified, with the
     score breakdown kept so the UI can explain *why* ("74% vs 71% - too close to call").
  4. **Validation** - a genuinely separate model pass, skeptical by framing, run only on
     tentatively-accepted items: given the original feedback + the assigned theme's definition, it
     can only confirm or reject (the schema has no field for proposing a different theme), so it
     structurally cannot become a second classifier capable of the same mistake.
  `buildEvidence()` then builds `supporting_item_numbers` and `frequency` entirely from
  classifications that passed *both* gates - never from anything a single model call asserts about
  itself. **The real cost of this**: clustering now takes 3 LLM calls instead of 1 - a real
  quota/latency cost regardless of provider, and specifically what motivated the move from Gemini
  to Groq below once it collided with Gemini's 20/day free-tier limit.

**Why `unclassified` is mandatory, not a fallback - and why an unclassified item shows a reason,
not just a bare label (v1.4).**
The discovery/classification prompts are explicit: a wrong classification contaminates a theme's
evidence, frequency, and everything computed from it downstream; an honest `unclassified` costs
nothing. `describeUnclassified()` in `cluster.js` distinguishes three cases a PM would actually
want to tell apart - **ambiguous** (failed the fit/margin gate, so the UI shows both candidate
themes and their scores), **validation_failed** (passed the gate but the validator's skeptical
pass rejected it - its stated reason is shown verbatim, usually the most useful of the three), and
**no_match** (nothing plausible at all). A manual PM unclassification gets its own fourth reason
so it's never confused with an AI decision.

**Why classification "fit" is the word used, not "confidence" - and why low/medium get a visible
warning, not just a number.**
The model doesn't actually know there's a 96% probability it's correct, so labeling a score
"confidence" implies an objectivity it doesn't have. Every accepted classification carries a 0-1
fit score, bucketed in code (`fitBucket()`) into **strong** or **moderate** - deliberately bucketed
server-side with fixed thresholds rather than trusting the model's own qualitative self-labeling,
the same reasoning behind bucketing RICE inputs for the v1.2 "Why this is #1" panel. A theme card
surfaces a "⚠ N moderate fit" badge the moment it has any, and every evidence item shows its fit
badge inline - uncertainty is a property of the evidence, not something to hide until a PM happens
to click into it.

**Why theme keywords exist but are explicitly a sanity check, never the classifier.**
Each theme definition also carries 2-6 keywords a real match would typically contain (e.g. "slow,"
"lag," "freeze" for a performance theme). Code checks for keyword overlap between an item's
primary issue and its assigned theme purely as an additional signal shown in the UI ("no keyword
match") - never as a gate, because correct classifications get paraphrased and won't always
literally contain the theme's keywords. Keyword matching was deliberately kept out of the
acceptance decision itself; it's there to give a PM one more data point, not a second, cruder
classifier.

**Why a PM can reassign any item's classification, and why that's better than trying to make the
model perfect.**
This is a copilot, not an autonomous PM - "nope, that's wrong, move it" needs to be one click, not
a re-run of the whole analysis. `reassignItem()` in `app.js` moves an item between theme evidence
lists (or to/from Unclassified) entirely client-side, recomputing both themes' `frequency`
immediately - the reassigned item is tagged `"manual"` fit so it's visually distinct from an AI
classification, not just quietly blended back in. This only touches the clustering stage; if RICE
was already run, the status bar tells the PM to re-run "Prioritize with RICE" to pick up the
corrected frequency, rather than silently patching numbers in a table that's supposed to represent
one coherent scoring pass.

**Why the RICE prompt is trimmed to just theme/definition/severity/frequency.**
Theme objects also carry `supporting_item_numbers` and per-item fit data - useful to the evidence
UI, irrelevant to RICE scoring, and just extra tokens on a free tier where the daily request quota
turned out to be tight enough to matter (see below). `prioritize.js` sends a trimmed copy to the
model and merges the RICE result back onto the full original objects.

**A live-testing finding that directly caused the Gemini → Groq switch (v1.5).** Retrying a
transient `503` (which `llmClient.js` already did automatically, up to 3x) still counted each
attempt against the same daily quota under Gemini - so a model under heavy load didn't just fail
slowly, it burned through the budget faster per logical request. Combined with v1.4's clustering
step costing 3 calls instead of 1, a full analysis run cost 5 calls total (cluster + prioritize +
PRD) against Gemini's 20/day limit - roughly 4 full runs/day in the best case, fewer under any
retry pressure, and full analysis runs were regularly taking 60+ seconds. That combination of
slow *and* quota-starved (rather than either alone) is what made switching providers the right
call instead of tuning retry constants - see **Why Groq instead of a paid API** above for the
actual comparison and the tradeoff it introduces.

**`adversarial-100.txt`** is a 100-item stress-test dataset (not blended into the main sample data)
covering obvious matches, genuinely overlapping themes, incidental keyword mentions, multi-issue
complaints, vague complaints, unrelated feedback, sarcasm/contradictory wording, one-line
feedback, and long multi-concept paragraphs - built specifically to validate the classification
architecture against edge cases beyond the original bug report. The full three-call pipeline and
code-side gating logic were verified thoroughly in `MOCK_MODE` (all three `unclassified` reasons,
the accept/reject boundary, keyword sanity flagging, and manual reassignment all pass) before the
Groq switch; running it through the live Groq pipeline - to verify Llama's classification quality
holds up the way Gemini's was verified to - is the natural next step once a real `GROQ_API_KEY`
is in place.

**Why there's no database.**
Scoped as a single-session demo (v1) — state lives in the browser's JS memory for the
session. A next iteration would persist analyses so a PM could revisit or compare past runs.

## Project structure

```
server/
  index.js              Express app: helmet, rate limiting, serves public/, mounts the 3 routes
  llmClient.js            Groq client + MODEL + MOCK_MODE + Zod-to-JSON-Schema helper
  schemas.js              Zod schemas shared by the cluster & prioritize routes
  feedbackItems.js         Splits raw feedback into the numbered items themes trace back to
  routes/
    cluster.js            POST /api/cluster    - 3-call pipeline (discover, classify, validate), evidence gated + built in code
    prioritize.js          POST /api/prioritize  - RICE scoring
    prd.js                  POST /api/prd         - PRD generation
  mocks/
    fixtures.js             MOCK_MODE canned/templated responses
public/
  index.html, style.css, app.js   Static frontend, no build step
sample-feedback.txt       Bundled 52-item sample dataset for an instant demo
adversarial-100.txt       100-item classification stress test (see v1.4 notes above)
```

## Tech stack

- Node.js + Express (serves the static frontend and proxies the 3 LLM calls — a backend is
  required so the Groq API key never reaches the browser), `helmet` for security headers,
  `express-rate-limit` for per-IP rate limiting
- `groq-sdk`, model `llama-3.3-70b-versatile` (Groq free tier, no credit card) - runs on Groq's
  LPU hardware for low-latency inference, chosen specifically to fix multi-minute analysis waits
  hit under Gemini (see **Why Groq instead of a paid API** above). Overridable via `GROQ_MODEL`
  in `.env` without a code change if a future model swap or deprecation is ever needed.
- Zod v4, for schema-driven structured output (`z.toJSONSchema()`) and response validation
- Plain HTML/CSS/JS frontend, no framework or build step (`marked.js` via CDN for rendering
  the PRD's Markdown)
