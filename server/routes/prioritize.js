import { Router } from "express";
import { MODEL, MOCK_MODE, toGroqResponseFormat, createChatCompletionWithRetry } from "../llmClient.js";
import { PrioritizeResponseSchema } from "../schemas.js";
import { mockPrioritizeThemes } from "../mocks/fixtures.js";

const router = Router();

const SYSTEM_PROMPT = `You are a product manager estimating the impact of fixing each of a set of
feedback themes. You will be given a JSON array of themes, each already carrying a "frequency"
(how many feedback items raised it) and "severity" (1-5, how bad the reported problem is - already
judged during an earlier clustering step). For each theme, in the exact order given, estimate:

- impact: 1-5, how much fixing this would move the needle for an affected user. Related to
  severity but not identical to it - severity is about how bad the problem is today, impact is
  about how much value fixing it delivers. Usually tracks severity closely, but use judgment: a
  severe-but-rare edge case can have lower impact than a moderate problem affecting a core
  workflow.

Provide one sentence of reasoning per theme, written so a PM could defend the number to a
stakeholder who asks "why?". Return exactly one estimate object per input theme, in the same
order - do not add, remove, or reorder themes.`;

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
    // "don't trust the model's copy of ground truth" pattern priority_score
    // uses for its own arithmetic. Only impact + its reasoning are taken from
    // the model's response.
    const scored = themes
      .map((original, i) => {
        const est = estimates[i];
        const merged = {
          ...original,
          impact: est.impact,
          impact_reasoning: est.impact_reasoning,
        };
        // Both factors are already 1-5 scales grounded in the actual
        // feedback (severity from clustering, impact from this call) - no
        // invented Reach/Confidence/Effort numbers layered on top.
        merged.priority_score = Number((merged.impact * merged.severity).toFixed(2));
        // The pristine AI estimate is kept alongside the editable field so
        // the UI can show "AI estimate" vs "PM override" once a user edits
        // it, without needing a second round-trip to remember it.
        merged.ai_estimate = { impact: merged.impact };
        return merged;
      })
      .sort((a, b) => b.priority_score - a.priority_score);

    res.json({ themes: scored });
  } catch (err) {
    console.error("prioritize error:", err);
    res.status(500).json({ error: "Failed to prioritize themes.", detail: err.message });
  }
});

async function prioritizeWithGroq(themes) {
  // Only what the model needs to estimate impact - theme objects also carry
  // supporting_item_numbers and per-item confidence (evidence-layer detail
  // from clustering) that would just be extra tokens here, on a free tier
  // where every token has a real, small daily budget.
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
      { role: "user", content: `Estimate impact for these themes:\n\n${JSON.stringify(forPrompt, null, 2)}` },
    ],
    response_format: toGroqResponseFormat(PrioritizeResponseSchema, "prioritize_response"),
    // One number + one reasoning sentence per theme (down from four of each
    // pre-v1.5) - well under half the old 4000-token budget covers even a
    // large batch, leaving more headroom under the 8,000 TPM ceiling.
    max_completion_tokens: 1800,
  });

  const parsed = PrioritizeResponseSchema.parse(JSON.parse(response.choices[0].message.content));
  if (parsed.themes.length !== themes.length) {
    throw new Error(
      `Model returned ${parsed.themes.length} impact estimates for ${themes.length} input themes.`,
    );
  }
  return parsed.themes;
}

export default router;
