import { Router } from "express";
import { MODEL, MOCK_MODE, toGroqResponseFormat, createChatCompletionWithRetry } from "../llmClient.js";
import { PrioritizeResponseSchema, IMPACT_SCALE } from "../schemas.js";
import { mockPrioritizeThemes } from "../mocks/fixtures.js";

const router = Router();

const SYSTEM_PROMPT = `You are a product manager scoring themes using the RICE framework
(Reach x Impact x Confidence / Effort). You will be given a JSON array of themes, each already
carrying a "frequency" (how many feedback items raised it) and "severity" (1-5). For each theme,
in the exact order given, estimate:

- reach: how many users/customers this would affect in the next quarter if left unaddressed.
  IMPORTANT: reach is NOT frequency. Frequency is a fact about the feedback sample you were
  given (a count of items). Reach is a judgment call projecting onto the broader user base -
  use the theme's frequency and definition as evidence, not as a formula to multiply by a constant.
  A theme raised by 3 feedback items could still plausibly affect thousands of silent users if
  the underlying problem (e.g. a core workflow) is broad enough - or barely extend past those
  3 people if it's a narrow edge case. Say which case this is and why in reach_reasoning.
- impact_label: one of minimal, low, medium, high, massive - how much fixing this theme would
  move the needle for an affected user. Should track the theme's severity but use your
  judgment, not a rigid lookup.
- confidence: 0-100, how confident you are in the reach/impact estimates given the evidence
  in the theme (a theme with many consistent quotes deserves higher confidence than one with
  a single ambiguous mention). Be honest when the evidence for reach specifically is thin -
  frequency tells you about the sample, not the population, and confidence should reflect that
  gap when it's not bridged by other evidence.
- effort: your best estimate of engineering effort in person-weeks to address the root cause,
  not just a surface patch. Be realistic - most fixes are NOT trivial.

Provide one sentence of reasoning for each of the four estimates, written so a PM could defend
the number to a stakeholder who asks "why?". Return exactly one estimate object per input theme,
in the same order - do not add, remove, or reorder themes.`;

const MAX_THEMES = 30;

router.post("/", async (req, res) => {
  try {
    const { themes } = req.body;
    if (!Array.isArray(themes) || themes.length === 0) {
      return res.status(400).json({ error: "Provide a non-empty 'themes' array." });
    }
    if (themes.length > MAX_THEMES) {
      return res.status(400).json({ error: `Too many themes (${themes.length}). Max is ${MAX_THEMES}.` });
    }

    const estimates = MOCK_MODE
      ? mockPrioritizeThemes(themes)
      : await prioritizeWithGroq(themes);

    // Identity fields (theme/definition/frequency/severity/supporting_item_numbers/
    // example_quotes) always come from the original clustered theme, matched
    // back by array position - never from what the model echoes, the same
    // "don't trust the model's copy of ground truth" pattern rice_score uses
    // for its own arithmetic. Only the 4 RICE fields + their reasoning are
    // taken from the model's response.
    const scored = themes
      .map((original, i) => {
        const est = estimates[i];
        const merged = {
          ...original,
          reach: est.reach,
          reach_reasoning: est.reach_reasoning,
          impact: est.impact,
          impact_reasoning: est.impact_reasoning,
          confidence: est.confidence,
          confidence_reasoning: est.confidence_reasoning,
          effort: est.effort,
          effort_reasoning: est.effort_reasoning,
        };
        merged.rice_score = Number(
          ((merged.reach * merged.impact * (merged.confidence / 100)) / merged.effort).toFixed(2),
        );
        // The pristine AI estimate is kept alongside the editable fields so
        // the UI can show "AI estimate" vs "PM override" once a user edits
        // an input, without needing a second round-trip to remember it.
        merged.ai_estimate = {
          reach: merged.reach,
          impact: merged.impact,
          confidence: merged.confidence,
          effort: merged.effort,
        };
        return merged;
      })
      .sort((a, b) => b.rice_score - a.rice_score);

    res.json({ themes: scored });
  } catch (err) {
    console.error("prioritize error:", err);
    res.status(500).json({ error: "Failed to prioritize themes.", detail: err.message });
  }
});

async function prioritizeWithGroq(themes) {
  // Only what the model needs to reason about RICE - theme objects also
  // carry supporting_item_numbers and per-item confidence (evidence-layer
  // detail from clustering) that would just be extra tokens here, on a free
  // tier where every token has a real, small daily budget.
  const forPrompt = themes.map((t) => ({
    theme: t.theme,
    definition: t.definition,
    severity: t.severity,
    frequency: t.frequency,
  }));

  const response = await createChatCompletionWithRetry({
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Score these themes using RICE:\n\n${JSON.stringify(forPrompt, null, 2)}` },
    ],
    response_format: toGroqResponseFormat(PrioritizeResponseSchema, "prioritize_response"),
    // The wrapper's 2000-token default (see llmClient.js) was found live to
    // be too small once theme count grows - a 12-theme batch either
    // returned fewer RICE estimates than themes given, or occasionally
    // nothing at all. 4 reasoning sentences per theme adds up faster than
    // it looks; this leaves real headroom under the 8,000 TPM ceiling
    // alongside reasoning_effort:"low" (set by default in llmClient.js).
    max_completion_tokens: 4000,
  });

  const parsed = PrioritizeResponseSchema.parse(JSON.parse(response.choices[0].message.content));
  if (parsed.themes.length !== themes.length) {
    throw new Error(
      `Model returned ${parsed.themes.length} RICE estimates for ${themes.length} input themes.`,
    );
  }
  // Translate impact_label to its RICE multiplier here, so this function
  // returns the same shape mockPrioritizeThemes() does and the merge step
  // in the route handler below doesn't need to know which path produced it.
  return parsed.themes.map((t) => ({ ...t, impact: IMPACT_SCALE[t.impact_label] }));
}

export default router;
