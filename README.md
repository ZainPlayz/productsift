# ProductSift

Turns a batch of messy, unstructured user feedback into evidence-backed themes, a transparent
Impact/Severity-prioritized roadmap, a PM decision on each item, and an auto-drafted, decision-aware
PRD — exportable as a presentable artifact, not just a webpage.

Built as a portfolio project to demonstrate the full PM loop: **raw feedback → evidence-backed
themes → transparent prioritization → PM decision → decision-sensitive roadmap → actionable PRD →
exportable artifact.**

## What it does

On a `MOCK_MODE=true` deployment, landing on an empty textarea auto-runs the full demo (Analyze →
Prioritize → Roadmap Summary) on the bundled sample data, so the first thing a visitor sees is the
tool actually working, not a blank form - the mode banner and status text make clear throughout
that it's a test run on sample data, not live output (see **Why demo mode runs itself** below).

1. **Input** — paste raw feedback, or upload a `.txt` file, or upload a `.csv` export straight from
   App Store Connect, Play Console, Zendesk, Intercom, or a form tool. The CSV parser (real
   RFC4180-style parsing — quoted fields, embedded commas/newlines — not a naive `split(",")`)
   auto-picks the free-text column by header name first, then by longest average cell length, and
   tells you which column it picked so you can sanity-check or just edit the result.
2. **Synthesis** — three single-purpose LLM calls with a code-owned gate between them: discover
   themes with explicit definitions, classify each item's distilled primary issue against those
   definitions with a fit score, then a separate skeptical pass validates every classification
   that clears the fit threshold before it's accepted. **Frequency is computed in code**, never
   asked of the model, so a theme's evidence can only ever contain items that passed both gates.
   Anything ambiguous, unvalidated, or simply unmatched becomes `unclassified` with a stated
   reason — never forced into the nearest-sounding theme. Every theme's "View supporting feedback"
   panel shows the full numbered list with a fit flag on borderline classifications, and lets a PM
   reassign any item on the spot if the AI got it wrong — frequency updates immediately.
3. **Prioritization** — each theme is scored as **Impact × Severity** (both 1-5). Severity comes
   from clustering (grounded in the theme's actual evidence); Impact is a separate AI call, with
   its reasoning shown, not just the final number. Impact is editable and recalculates instantly,
   marked as a PM override with a one-click reset back to the AI's number when changed. (v1 scored
   this with RICE - Reach × Impact × Confidence / Effort - see **Why RICE got dropped** below for
   why that changed.)
4. **Roadmap Summary** — the top 3 themes, with a **"Why this is #1"** explanation and a
   **decision sensitivity** analysis (what would have to change for the ranking to flip) computed
   directly from the priority numbers, no extra AI call. Each item gets an explicit PM
   **Decision** — Build / Investigate / Defer / Reject — independent of its rank.
5. **PRD generation** — draft a one-pager for any of the top 3 themes: problem statement,
   proposed solution, scope (in/out), background, user stories, success metrics, and open
   questions. The PRD's framing adapts to the PM's decision (an "Investigate" PRD reads as a
   validated recommendation, not a commitment; a "Reject" PRD reads as a decision record).
6. **Export** — Print/Save as PDF (the full pipeline, top to bottom, with decisions), Copy PRD,
   or Copy Roadmap Summary as plain text — a tangible output, not just a page you leave open.
7. **Share** — click Share to get a persistent link (`/p/abc123`) backed by a real database, not
   a snapshot. Anyone with the link sees the current state on load, and every edit anyone makes
   after that — a reassignment, a priority override, a decision, a new PRD — autosaves back to the
   same link (roughly a second after the edit, debounced) so the next person to open it sees it
   too. Requires `DATABASE_URL` to be set (see [Setup](#setup)); without it the button just
   disables itself with an explanatory tooltip instead of breaking.

## Whose API quota gets used?

One deployment = one server-side `GROQ_API_KEY` = every visitor shares that quota. A per-IP rate
limiter (`server/index.js`, 10 LLM requests/minute) is what actually stands between that and
abuse - it stops one IP from burning through the quota in a burst, though it doesn't cap total
requests across many different real visitors. If you want a public deployment to stay demo-only
regardless of traffic, set `MOCK_MODE=true` instead (see **Deploy** below) - every visitor gets
canned sample results, never a real API call.

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

To enable the **Share** button (optional):

1. Create a free Postgres database at [neon.tech](https://neon.tech) (no credit card, and unlike
   some free-tier databases it doesn't pause after a week of inactivity, which matters for a link
   meant to stay live).
2. Copy its connection string into `.env` as `DATABASE_URL=postgresql://...`.

The `projects` table is created automatically on first use - no migration step. Leave
`DATABASE_URL` unset and the rest of the app works exactly the same; only the Share button
disables itself.

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
   for any var marked `sync: false` — the key never gets committed to the repo). Optionally add
   `DATABASE_URL` too (a free Neon Postgres string) to enable the Share button on this deployment.
3. Deploy. Render builds with `npm install` and starts with `npm start`.

**Public deployments default to `MOCK_MODE=false`** (set in `render.yaml`) — every visitor shares
this deployment's `GROQ_API_KEY`, protected by the per-IP rate limiter in `server/index.js` (10 LLM
requests/minute) rather than by defaulting to demo data. That limiter stops one IP from bursting
through the quota; it doesn't cap total requests across many different real visitors, so a shared
free-tier quota (1,000 requests/day for the default model) can still run out under enough genuine
traffic. Flip `MOCK_MODE` to `true` in the Render dashboard if you'd rather a given deployment stay
demo-only regardless of how much traffic it gets.

Any other Node host works too (Railway, Fly.io, etc.) — the app only needs `npm install` /
`npm start`, a `PORT` env var (already read from `process.env.PORT`), and the vars above.

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
   validate pipeline, 1 for prioritize, 1 for PRD). Groq's free tier for the model this project
   settled on allows **1,000 requests/day** — about 200 full runs/day, roughly a 50x improvement,
   without changing anything about the three-call architecture that caused the original quota
   pressure.

Both are free, no-credit-card tiers, which matters for a project you re-run constantly while
building and demoing it — the rate-limiting practices below (per-IP limits, retry-with-backoff)
apply the same way regardless of provider.

**The model actually used isn't Llama, despite that being the original plan** - a live check
against `groq.models.list()` with a real key showed no Llama chat model currently available on
Groq, only GPT-OSS, Qwen, and a few non-chat models (this changed at some point after the
research that suggested Llama would be there; live API state beat search results). Of what's
actually available, `openai/gpt-oss-120b` is both the largest general-purpose option and one of
only two model families on Groq that support *strict* JSON-schema mode (100%-guaranteed
structural adherence via constrained decoding) - a genuine reliability upgrade over what Llama's
best-effort schema-following would have given this project, not just a fallback choice.

**What live testing against gpt-oss-120b actually found - the honest version, not just the best
number:**

- **Small/typical batches are dramatically faster and more reliable.** A 5-item batch: full
  3-call cluster + prioritize + PRD pipeline in ~10 seconds total, vs. the 60+ seconds (or
  outright failure) that was routine under Gemini.
- **`gpt-oss-120b` is a *reasoning* model** (per its own metadata - `"supported_features":
  ["reasoning", ...]`), which trades speed for quality via hidden reasoning tokens before the
  visible answer. This scales worse than linearly with batch size: even after setting
  `reasoning_effort: "low"` (bug #5 below - the fix for correctness, not primarily for speed),
  the bundled 52-item `sample-feedback.txt` (a deliberately large stress-test-sized dataset) still
  took over a minute, while a 12-theme prioritize call on that same batch completed in ~20
  seconds. Small/typical batches remain the dramatic win; large batches are now *correct*
  (previously they weren't even that) but still genuinely slow. `qwen/qwen3.8-27b` is the other
  strict-mode option on Groq and is untested here - worth trying if large-batch latency matters
  more than what's already been verified.
- **Several real bugs were found and fixed by testing against the live API, not assumed away:**
  1. With no `max_completion_tokens` set, a 52-item discovery call generated all 52 extracted
     issues completely, then hit the API's implicit output cap before generating the required
     `themes` field - strict mode correctly rejected the incomplete JSON as a 400 rather than
     returning bad data, but the real fix was giving generation enough room to finish.
  2. The free tier's tokens-per-minute limit for this model is a tight **8,000 TPM**, checked as
     input + reserved `max_completion_tokens` *before* generation starts - so naively setting the
     completion budget high enough to fix #1 (e.g. 8000) backfired as a `413` on exactly the
     large-batch requests it was meant to help, especially for classification, whose *input*
     (every primary issue plus every theme definition) is already substantial. Each call in
     `cluster.js` now has its own tuned `max_completion_tokens`, sized empirically to that call's
     actual input/output profile within the shared 8,000 TPM ceiling.
  3. A subtler failure mode: when classification's budget was still slightly too tight for a
     52-item batch, the response came back as *valid* JSON covering only the first ~22 items -
     strict mode's constrained decoding appears to auto-close the JSON array when it runs out of
     room rather than erroring. This app's own defensive fallback (any item with no
     classification returned defaults to `unclassified`) meant nothing got a *wrong* answer, but
     30 items that should have matched clear themes went unclassified with no error thrown
     anywhere - a real gap between "the request succeeded" and "the result was actually
     complete," worth knowing about if output coverage ever looks suspiciously thin.
  4. Groq's *strict* mode doesn't fully enforce every JSON Schema keyword despite the "100%
     guaranteed" framing - it generated 7 items for an array schema capped at `max(6)` (the
     `keywords` field), rejected by this app's own Zod validation. Since `keywords` is only ever
     an informational sanity-check (never a gate - see `hasKeywordOverlap` in `cluster.js`), the
     schema cap was loosened to `max(8)` rather than fighting an enforcement gap that isn't this
     app's to fix.
  5. **The real root cause behind #1-#3, found after initial testing looked clean but real usage
     immediately surfaced "many items unclassified" and RICE prioritization failing outright**:
     `gpt-oss` models default to `reasoning_effort: "medium"`, meaning a real, variable chunk of
     every `max_completion_tokens` budget was going to hidden reasoning tokens the app never sees,
     not the visible JSON output it actually needs - tightening the visible-output budget without
     accounting for this was fighting the wrong variable, no matter how carefully each number was
     tuned. None of this app's calls are the kind of multi-step problem reasoning effort is meant
     for (they're well-specified extraction/classification/scoring), so `reasoning_effort: "low"`
     is now set as the default for every call in `llmClient.js` - confirmed live to fully resolve
     both symptoms: the 52-item sample batch that previously left 30 items unclassified now
     classifies all 52 with zero left over, and a 12-theme prioritize call that previously
     returned too few estimates (or nothing at all) now reliably returns all of them.
- **A union of numeric literals (Zod `z.union([z.literal(0.25), ...])`) worked fine as JSON
  Schema for Gemini's best-effort mode, but Groq's strict-mode compiler rejected it live**
  (`"cannot include both 'integer' and 'number'"` when mixing whole and fractional consts under
  one property). At the time (RICE's 0.25/0.5/1/2/3 impact scale) this was fixed by having the
  model return a qualitative label instead of a raw number, with code mapping the label back to
  its multiplier. When RICE was dropped for a plain 1-5 Impact scale (v1.6, see **Why RICE got
  dropped** below), the whole workaround became unnecessary - a single consistent integer range
  (`z.number().int().min(1).max(5)`) never mixes int/float literal types in the first place, so
  it doesn't hit this constraint at all. Worth keeping as a historical note: sometimes fixing the
  actual design problem removes the need for the workaround entirely.

If you exhaust Groq's quota, the API returns a `429`; `MOCK_MODE=true` keeps the app fully
demoable while you wait. `GROQ_MODEL=qwen/qwen3.8-27b` in `.env` is the other strict-mode-capable
model currently on Groq's free tier, worth trying if `gpt-oss-120b`'s reasoning-model latency on
large batches (see above) matters more than what's already been verified with it — check current
model availability and limits at
[console.groq.com/docs/rate-limits](https://console.groq.com/docs/rate-limits), since this has
already changed once during this project's own development.

## Security & rate limiting

- **The API key never reaches the browser.** It lives only in `.env`, read server-side by
  `server/llmClient.js`. The frontend only ever talks to this app's own `/api/*` routes.
- **Per-IP rate limiting** (`express-rate-limit`, in `server/index.js`) caps the three
  LLM-calling routes (`/api/cluster`, `/api/prioritize`, `/api/prd`) at 10 requests/minute per
  IP. This protects a shared free-tier quota (or a paid bill) from a runaway client loop or one
  abusive IP, and returns a clear `429` with a JSON error the frontend already displays. It's a
  burst guard, not a total-spend cap - it doesn't limit the sum of requests across many distinct
  real visitors, so a busy public deployment can still exhaust a shared daily quota under genuine
  traffic (see **Deploy** above for the `MOCK_MODE` fallback if that risk matters for your case).
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
  frequency/severity/priority numbers present in the theme data, and to describe metrics
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

**Why RICE got dropped in favor of Impact × Severity (v1.6).**
v1-v1.4 scored themes with RICE (Reach × Impact × Confidence / Effort), each of the four inputs
AI-estimated and PM-editable. Direct user testing found that in practice nobody touched Reach,
Confidence, or Effort — Reach and Confidence were AI guesses layered on top of an AI guess with
no real data behind either, and Effort (engineering estimation in person-weeks) is squarely a
Jira/Asana/Linear job, not something a feedback-synthesis tool should be pretending to estimate.
Carrying three fields nobody used didn't make the tool look more rigorous, it just made the table
harder to read and the "RICE" framing harder to defend under questioning. What replaced it -
`priority_score = impact × severity` - uses only inputs actually grounded in the feedback itself:
Severity comes from clustering, backed by real evidence quotes; Impact is a separate, focused AI
call. Simpler, and every number on screen is defensible instead of half of them being decoration.
The RICE formula, `ai_estimate`-based override tracking, and "explain the ranking with pure
arithmetic, no extra LLM call" design principles all carried over unchanged - see below.

**Why frequency and severity are separate axes, not one blended score (v1.1).**
A theme can be mentioned constantly but be low-stakes (a cosmetic nitpick), or mentioned
rarely but be severe (a data-loss bug one power user hit). Collapsing those into a single
"importance" number would hide that distinction - frequency stays a plain fact from clustering,
severity stays a separate AI judgment call, and neither is allowed to stand in for the other.

**Why priority scores are always computed in code, never trusted from the model.**
The LLM estimates Impact with reasoning — see `server/routes/prioritize.js`. The actual
`priority_score = impact × severity` arithmetic always happens in JavaScript, both server-side
and again client-side when a user edits Impact. This guarantees the score is never inconsistent
with its inputs, and makes the recalculation instant without a network round-trip.

**Why Impact is editable, not fixed — and why an edit is visually marked as a PM override,
not silently blended in (v1.1).**
An LLM's Impact estimate is a *starting point*, not ground truth — a real PM would override it
with their own judgment. Making it editable in the UI is a deliberate acknowledgment that this
tool assists judgment, it doesn't replace it. The original AI estimate is kept in memory
(`ai_estimate` on the theme object) even after editing, so the moment the value diverges from it
the cell gets a visible highlight, an "AI: &lt;original&gt;" note, and a one-click reset — the
interface should never let "the AI's number" and "the PM's judgment call" look identical once
they've diverged.

**Why the model's prioritization response is matched back to themes by array position, not
trusted to echo the theme's identity fields (v1.1).**
Early on, `prioritize.js` asked the model to return the full theme object (name, summary,
frequency, severity) alongside its estimate, and just trusted that copy back. Now the schema
only asks for Impact plus its reasoning, in the same order as the input themes; the route
re-attaches every identity field from the original clustered theme by index. One less thing an
LLM could subtly alter (a reworded summary, a dropped feedback item number) on a call that was
never supposed to touch it.

**Why there's a mock mode.**
The build was done in dependency order (input plumbing → clustering → prioritization → PRD),
each stage tested before the next was built, per typical incremental PM/eng workflow. Mock
mode (`MOCK_MODE=true`) let every stage be verified end-to-end — including the priority-score
math and the UI — without needing an API key or spending anything on LLM calls during
development.

**Why demo mode runs itself instead of waiting for a click.**
A visitor landing on an empty textarea has to already know this tool does something before
they'll click "Load Sample Data" then "Analyze" themselves - most won't, and a portfolio demo
that requires the viewer to already understand it defeats its own purpose. `runAutoDemo()` in
`app.js` fires once, only when the page loads fresh in mock mode with nothing already in progress
(guarded against a `/p/:id` shared-project link, which should hydrate its own saved state instead,
and against a race with whatever the visitor may have already started themselves in the moment
`/api/status` took to resolve) - it chains `runAnalysis()` → `runPrioritize()` → `showSummary()`,
stopping at the Roadmap Summary (the fullest single view of what this tool does) rather than
auto-generating a PRD, which stays a deliberate per-theme choice for the visitor to make
themselves. Both `runAnalysis()` and `runPrioritize()` were factored out of their button click
listeners specifically so this could `await` the real logic instead of simulating clicks and
hoping they landed in order; each also bails out (`return false`) if its button is already
disabled, guarding the narrow case where a real click and the auto-demo could otherwise both
start the same call.

**Why per-visitor Groq keys were tried, then reverted back to one shared server key (v1.7).**
Briefly, every visitor could paste their own Groq key (stored client-side, sent per-request on a
header) so a public deployment's traffic never touched the deployer's own quota - each `/api/*`
route resolved a fresh Groq client per request instead of importing one shared singleton. Reverted
in favor of the simpler model this project now uses: one server-side key, one rate limiter. The
per-visitor version added real surface area (a client-side credential store, a resolve-per-request
code path threaded through three sequential LLM calls in `cluster.js`, 401-handling written to be
actionable for an arbitrary visitor's key rather than just the deployer's) for a problem the
existing rate limiter already covers the common case of - a runaway loop or one abusive IP. What
it doesn't cover - a shared quota exhausted by many distinct legitimate visitors on a busy public
deployment - is a real, named tradeoff (see **Deploy** and **Security & rate limiting** above), not
one this project is currently solving for.

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
Between the priority table and the PRD, a Roadmap Summary now shows the top 3 themes with their
score and evidence at a glance and lets the PM choose which one to draft a PRD for (not always
just #1) — a closer analog to how a real prioritization review ends: with a short list and a
decision, not a jump straight into writing.

**Why the priority score ranks but a separate Decision field is what a PM actually commits to
(v1.2).**
A priority score is an input to a decision, not a decision-maker - a lower-scoring item can still
be worth investigating if the evidence behind it is thin, and a high scorer can still be deferred
for reasons the score doesn't capture (a dependency, a strategic call). So every roadmap item gets
an explicit Build/Investigate/Defer/Reject control, independent of its rank, and that decision
then shapes how the PRD is framed (see `DECISION_FRAMING` in `prd.js`) - "Investigate" reads as a
recommendation pending validation, not a commitment; "Reject" reads as a decision record, not a
pitch.

**Why "Why this is #1" and "Decision sensitivity" are computed in JavaScript, with zero
additional LLM calls (v1.2, simplified in v1.6).**
Both panels are pure arithmetic over numbers already on screen. The ranking explanation labels
Impact and Severity Low/Moderate/High against fixed 1-5 bands (the same bands the severity badges
already use, so a reader only has to learn one scale) and composes a sentence from those labels.
The sensitivity analysis solves `priority_score = impact × severity` for the Impact value at
which the #1 theme would tie the #2 theme - Severity isn't PM-editable, so Impact is the only
input that can actually move, which is what makes the v1.6 version of this simpler than the old
four-variable RICE version (that one held three inputs fixed and solved for each of the other
three in turn). Neither needed a prompt: the interesting product idea here isn't "ask the AI to
explain itself," it's "the numbers already imply this explanation, so compute it directly and
it's instant, free, and exactly reproducible." Both stay live - editing Impact re-renders them
along with the rest of the roadmap summary.

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
the same reasoning behind labeling Impact/Severity for the v1.2 "Why this is #1" panel. A theme card
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
classification, not just quietly blended back in. This only touches the clustering stage; if
prioritization was already run, the status bar tells the PM to re-run "Prioritize" to pick up the
corrected frequency, rather than silently patching numbers in a table that's supposed to represent
one coherent scoring pass.

**Why the prioritization prompt is trimmed to just theme/definition/severity/frequency.**
Theme objects also carry `supporting_item_numbers` and per-item fit data - useful to the evidence
UI, irrelevant to impact estimation, and just extra tokens on a free tier where the daily request
quota turned out to be tight enough to matter (see below). `prioritize.js` sends a trimmed copy to
the model and merges the result back onto the full original objects.

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
the accept/reject boundary, keyword sanity flagging, and manual reassignment all pass), and
separately against live `gpt-oss-120b` output at multiple scales (5, 19, and 52 items - see **Why
Groq instead of a paid API** above for what that testing actually found, bugs and all). Running
`adversarial-100.txt` specifically through the live pipeline - the full 100-item adversarial set,
not just the sample data - remains the natural next verification step.

**Why the database is optional, not required.**
The core analysis loop deliberately has zero persistence dependency — state lives in the
browser's JS memory, and the app is fully usable with nothing but Node and a Groq key. Sharing
(`/p/:id`) is a separate, additive layer on top: one `projects` table (`id`, `data jsonb`,
timestamps) storing a full snapshot of that in-memory state, behind routes that no-op cleanly
(`501`, button disabled) when `DATABASE_URL` isn't set. That's a deliberate boundary, not an
oversight — a demo tool shouldn't *require* infrastructure just to run, but a "share this with my
team" feature legitimately needs somewhere durable to write to, so it gets its own optional
dependency instead of forcing one on everybody. Edits autosave (800ms debounced) rather than
requiring an explicit "save" step, so a shared link stays current without the owner having to
remember to re-share it.

## Project structure

```
server/
  index.js              Express app: helmet, rate limiting, serves public/, mounts routes, serves /p/:id
  llmClient.js            Groq client + MODEL + MOCK_MODE + Zod-to-JSON-Schema helper
  schemas.js              Zod schemas shared by the cluster & prioritize routes
  feedbackItems.js         Splits raw feedback into the numbered items themes trace back to
  db.js                    Optional Neon/Postgres client - DB_ENABLED is false with no DATABASE_URL
  routes/
    cluster.js            POST /api/cluster    - 3-call pipeline (discover, classify, validate), evidence gated + built in code
    prioritize.js          POST /api/prioritize  - Impact x Severity scoring
    prd.js                  POST /api/prd         - PRD generation
    projects.js             POST/GET/PUT /api/projects - save/load a shared project snapshot
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
- `groq-sdk`, model `openai/gpt-oss-120b` (Groq free tier, no credit card) - runs on Groq's LPU
  hardware for low-latency inference, chosen specifically to fix multi-minute analysis waits hit
  under Gemini, and one of only two model families on Groq with *strict* JSON-schema support
  (see **Why Groq instead of a paid API** above for the full story, including the real bugs found
  tuning this integration and the honest large-batch latency finding). Overridable via
  `GROQ_MODEL` in `.env` without a code change if a future model swap or deprecation is ever
  needed - which has now happened once already, going from the originally-planned Llama to this.
- Zod v4, for schema-driven structured output (`z.toJSONSchema()`) and response validation
- `@neondatabase/serverless` (optional - only used if `DATABASE_URL` is set), Neon's HTTP-based
  Postgres driver - chosen over a normal TCP `pg` client because it works over plain `fetch()`,
  which fits a free host like Render better than holding a persistent DB connection open
- Plain HTML/CSS/JS frontend, no framework or build step (`marked.js` via CDN for rendering
  the PRD's Markdown)
