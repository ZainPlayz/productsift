import { Router } from "express";
import { MODEL, MOCK_MODE, toGroqResponseFormat, createChatCompletionWithRetry } from "../llmClient.js";
import {
  DiscoveryResponseSchema,
  ClassificationResponseSchema,
  ValidationResponseSchema,
  NONE_THEME,
} from "../schemas.js";
import { CLUSTER_MOCK_RESULT } from "../mocks/fixtures.js";
import { splitFeedbackItems } from "../feedbackItems.js";

const router = Router();

// Caps input size well above what a real feedback batch needs, but far below
// anything that could quietly burn through a free-tier daily token quota -
// doubly important now that clustering costs 3 LLM calls, not 1 (see below).
const MAX_FEEDBACK_CHARS = 20000;

// A classification is only tentatively accepted if it's both confident AND
// unambiguous relative to the runner-up - precision over recall, on purpose.
// Both are configurable here, not scattered through prompt text, because
// this is the actual decision boundary the product is built around.
const ACCEPT_MIN_FIT = 0.8;
const ACCEPT_MIN_MARGIN = 0.15;

router.post("/", async (req, res) => {
  try {
    const { feedback } = req.body;
    if (!feedback || typeof feedback !== "string" || !feedback.trim()) {
      return res.status(400).json({ error: "Provide feedback text in the 'feedback' field." });
    }
    if (feedback.length > MAX_FEEDBACK_CHARS) {
      return res.status(400).json({
        error: `Feedback is too long (${feedback.length} chars). Keep it under ${MAX_FEEDBACK_CHARS} characters.`,
      });
    }

    const items = splitFeedbackItems(feedback);
    if (items.length === 0) {
      return res.status(400).json({ error: "No feedback items found (each item should be on its own line)." });
    }

    const result = MOCK_MODE ? CLUSTER_MOCK_RESULT : await clusterWithGroq(items);
    res.json({ ...result, items });
  } catch (err) {
    console.error("cluster error:", err);
    res.status(500).json({ error: "Failed to cluster feedback.", detail: err.message });
  }
});

// --- Call 1: discovery (primary-issue extraction + theme definitions) ---

const DISCOVERY_PROMPT = `You are a product manager doing the first pass over a numbered batch of
raw user feedback. Do two things, in order:

1. For EVERY item, extract its "primary_issue" - a short, clean restatement of the ONE main
   problem or request, stripped of greetings, praise, and incidental context. This distilled
   text is what a later step will classify against theme definitions - NOT the raw sentence -
   specifically so that an incidental word (e.g. "notifications" mentioned only as the screen
   where a crash happens) can't later hijack a classification the way raw text can.
2. Propose the distinct themes present among those primary issues, deduplicated - near-duplicate
   rewordings merged into one theme. For each theme, write an explicit DEFINITION precise enough
   to judge a primary issue against (what belongs, and what a reader might mistakenly assume
   belongs but doesn't), plus a short keyword list used later only as a sanity check, never as
   the classifier itself.

Do not assign items to themes here - that happens in a separate step.`;

async function discoverThemes(items) {
  const numberedList = items.map((item, i) => `${i + 1}. ${item}`).join("\n");
  const response = await createChatCompletionWithRetry({
    model: MODEL,
    messages: [
      { role: "system", content: DISCOVERY_PROMPT },
      { role: "user", content: `Numbered feedback batch:\n\n${numberedList}` },
    ],
    response_format: toGroqResponseFormat(DiscoveryResponseSchema, "discovery_response"),
  });
  return DiscoveryResponseSchema.parse(JSON.parse(response.choices[0].message.content));
}

// --- Call 2: classification (primary issue vs. theme DEFINITIONS only) ---

const CLASSIFICATION_PROMPT = `You will be given a list of primary issues (already distilled from
raw feedback - you will NOT see the raw text) and a list of theme definitions. For EACH primary
issue, evaluate it against every theme's definition and report the best-fitting and second-best-
fitting theme, each with a 0-1 fit score reflecting how well the primary issue matches that
theme's DEFINITION specifically - not how many words overlap, not general topical similarity.

If a different theme shares an incidental keyword or topic with the item but isn't actually what
the item is complaining about, name that explicitly in "reason" and do not let it win - this is
the single most important judgment in this task. Use theme_id "${NONE_THEME}" for best_theme (and
0 for its fit) if truly nothing plausible fits; same for second_best_theme if there's no real
runner-up. A classification you are only moderately sure about should get a moderate fit score,
not be rounded up - a downstream system, not you, decides whether a score is high enough to act on.`;

async function classifyIssues(itemPrimaryIssues, themes) {
  const themesForPrompt = themes.map((t) => ({ theme_id: t.theme_id, theme: t.theme, definition: t.definition }));
  const response = await createChatCompletionWithRetry({
    model: MODEL,
    messages: [
      { role: "system", content: CLASSIFICATION_PROMPT },
      {
        role: "user",
        content: `Primary issues:\n${JSON.stringify(itemPrimaryIssues, null, 2)}\n\nTheme definitions:\n${JSON.stringify(themesForPrompt, null, 2)}`,
      },
    ],
    response_format: toGroqResponseFormat(ClassificationResponseSchema, "classification_response"),
  });
  const parsed = ClassificationResponseSchema.parse(JSON.parse(response.choices[0].message.content));
  return parsed.classifications;
}

// --- Call 3: validation (a genuinely separate, skeptical pass) ---

const VALIDATION_PROMPT = `You are reviewing classifications someone else already made, looking
for mistakes - you did not make these classifications and have no stake in defending them. For
each item, you're given the ORIGINAL raw feedback, its extracted primary issue, and the theme
definition it was assigned to. Answer one question: does that theme definition genuinely
represent this item's primary issue? Be skeptical - if the connection is a stretch, an incidental
mention, or addresses a secondary detail rather than the main complaint, answer false. You may
only confirm or reject - you cannot reassign the item to a different theme.`;

async function validateClassifications(toValidate, items, primaryIssueByItem, themeById) {
  const forPrompt = toValidate.map((c) => ({
    item_number: c.item_number,
    original_feedback: items[c.item_number - 1],
    primary_issue: primaryIssueByItem.get(c.item_number),
    assigned_theme: themeById.get(c.tentativeThemeId).theme,
    theme_definition: themeById.get(c.tentativeThemeId).definition,
  }));
  const response = await createChatCompletionWithRetry({
    model: MODEL,
    messages: [
      { role: "system", content: VALIDATION_PROMPT },
      { role: "user", content: `Classifications to review:\n\n${JSON.stringify(forPrompt, null, 2)}` },
    ],
    response_format: toGroqResponseFormat(ValidationResponseSchema, "validation_response"),
  });
  const parsed = ValidationResponseSchema.parse(JSON.parse(response.choices[0].message.content));
  return parsed.validations;
}

// --- Orchestration + the code-owned acceptance gate ---

async function clusterWithGroq(items) {
  const { item_primary_issues, themes } = await discoverThemes(items);
  const primaryIssueByItem = new Map(item_primary_issues.map((p) => [p.item_number, p.primary_issue]));
  const themeByIdMap = mapThemesById(themes);

  const classifications = themes.length > 0 ? await classifyIssues(item_primary_issues, themes) : [];
  const classificationByItem = new Map(classifications.map((c) => [c.item_number, c]));

  // Gate 1 (code, not the model): accept only if the top match is both
  // confident AND clearly ahead of the runner-up. Anything else is
  // tentatively unclassified, but keeps its score breakdown so the UI can
  // show *why* ("Performance 61% vs Mobile Stability 58% - too close to call")
  // instead of a bare "unclassified" with no explanation.
  const tentative = [];
  for (let n = 1; n <= items.length; n++) {
    const c = classificationByItem.get(n);
    if (!c || c.best_theme === NONE_THEME || !themeByIdMap.has(c.best_theme)) {
      tentative.push({ item_number: n, tentativeThemeId: null, classification: c ?? null });
      continue;
    }
    const margin = c.best_fit - (c.second_best_theme !== NONE_THEME ? c.second_best_fit : 0);
    const accepted = c.best_fit >= ACCEPT_MIN_FIT && margin >= ACCEPT_MIN_MARGIN;
    tentative.push({ item_number: n, tentativeThemeId: accepted ? c.best_theme : null, classification: c });
  }

  // Gate 2: a real second model pass, skeptical by framing, that can only
  // confirm or reject - never propose an alternative theme itself (the
  // schema has no field for that), so it can't become a second classifier
  // capable of the same mistake it's meant to catch.
  const toValidate = tentative.filter((t) => t.tentativeThemeId);
  const validations =
    toValidate.length > 0 ? await validateClassifications(toValidate, items, primaryIssueByItem, themeByIdMap) : [];
  const validationByItem = new Map(validations.map((v) => [v.item_number, v]));

  const resolved = tentative.map((t) => {
    if (!t.tentativeThemeId) return { ...t, theme_id: null, validation: null };
    const validation = validationByItem.get(t.item_number) ?? null;
    const themeId = validation?.valid ? t.tentativeThemeId : null;
    return { ...t, theme_id: themeId, validation };
  });

  return buildEvidence(themes, resolved, primaryIssueByItem);
}

function fitBucket(fit) {
  return fit >= 0.9 ? "strong" : "moderate";
}

// Purely informational cross-check, never a gate: does the item's primary
// issue text contain any of the assigned theme's model-supplied keywords?
// A miss doesn't mean the classification is wrong (paraphrasing is normal),
// it's just one more data point surfaced to the PM alongside everything else.
function hasKeywordOverlap(primaryIssue, theme) {
  const lower = primaryIssue.toLowerCase();
  return theme.keywords.some((k) => lower.includes(k.toLowerCase()));
}

// The only place supporting_item_numbers/frequency are ever set - built
// entirely from `resolved` (already gated by fit threshold + validation),
// never from anything a single model call claims about itself.
function buildEvidence(themes, resolved, primaryIssueByItem) {
  const themeMap = mapThemesById(themes);

  const themesWithEvidence = themes.map((t) => {
    const supporting = [];
    const itemFit = {};
    for (const r of resolved) {
      if (r.theme_id === t.theme_id) {
        supporting.push(r.item_number);
        const primaryIssue = primaryIssueByItem.get(r.item_number) ?? "";
        itemFit[r.item_number] = {
          bucket: fitBucket(r.classification.best_fit),
          fit: r.classification.best_fit,
          keyword_overlap: hasKeywordOverlap(primaryIssue, t),
          primary_issue: primaryIssue,
        };
      }
    }
    supporting.sort((a, b) => a - b);
    return { ...t, supporting_item_numbers: supporting, frequency: supporting.length, item_fit: itemFit };
  });

  const unclassifiedItemNumbers = [];
  const unclassifiedReasons = {};
  for (const r of resolved) {
    if (r.theme_id !== null) continue;
    unclassifiedItemNumbers.push(r.item_number);
    unclassifiedReasons[r.item_number] = describeUnclassified(r, themeMap);
  }
  unclassifiedItemNumbers.sort((a, b) => a - b);

  return { themes: themesWithEvidence, unclassified_item_numbers: unclassifiedItemNumbers, unclassified_reasons: unclassifiedReasons };
}

function mapThemesById(themes) {
  return new Map(themes.map((t) => [t.theme_id, t]));
}

// Explains WHY an item ended up unclassified - three distinct cases a PM
// would want to distinguish: nothing plausible at all, a too-close-to-call
// tie between two themes, or a classification that looked fine until the
// validation pass specifically rejected it (that reason is usually the most
// informative of the three, so it's shown verbatim when available).
function describeUnclassified(r, themeMap) {
  if (r.tentativeThemeId && r.validation && !r.validation.valid) {
    return { type: "validation_failed", detail: r.validation.reason };
  }
  const c = r.classification;
  if (!c || c.best_theme === NONE_THEME || !themeMap.has(c.best_theme)) {
    return { type: "no_match", detail: "No theme's definition plausibly matched this item's primary issue." };
  }
  const bestTheme = themeMap.get(c.best_theme)?.theme ?? c.best_theme;
  const secondTheme = c.second_best_theme !== NONE_THEME ? themeMap.get(c.second_best_theme)?.theme : null;
  const detail = secondTheme
    ? `Too close to call: "${bestTheme}" (${Math.round(c.best_fit * 100)}%) vs "${secondTheme}" (${Math.round(c.second_best_fit * 100)}%).`
    : `Best guess was "${bestTheme}" at only ${Math.round(c.best_fit * 100)}% fit - below the threshold to accept.`;
  return { type: "ambiguous", detail };
}

export default router;
