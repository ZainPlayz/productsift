import { Router } from "express";
import { MODEL, MOCK_MODE, generateContentWithRetry } from "../llmClient.js";
import { mockGeneratePRD } from "../mocks/fixtures.js";

const router = Router();

const BASE_SYSTEM_PROMPT = `You are a product manager drafting a one-page PRD for a theme
surfaced from a batch of user feedback. Write it the way you'd hand it to a manager or an
engineering lead - concise, concrete, no filler.

Output valid Markdown with exactly these sections, in this order:
# PRD: <theme name>
## Problem Statement
## Proposed Solution
## Scope
## Background
## User Stories
## Success Metrics
## Open Questions

- Problem Statement: 2-4 sentences grounded in the theme's definition and evidence (frequency,
  severity out of 5, RICE score) - state the problem, not the solution.
- Proposed Solution: 2-4 sentences describing ONE concrete, plausible solution direction that
  addresses the root cause named in the Problem Statement - not a restatement of the problem,
  and not a full spec. This is a recommendation to react to, not a final decision.
- Scope: two labeled lists, "**In scope**" then "**Out of scope**", 2-4 bullets each. In scope
  is what this initiative covers to ship the proposed solution. Out of scope is adjacent,
  plausible-sounding work a stakeholder might assume is included but isn't - naming it explicitly
  is what prevents scope creep, so pick real candidates (e.g. a related-but-bigger redesign, a
  platform the fix won't cover yet), not vague filler.
- Background: include the theme's example quotes as blockquotes, each on its own line with a
  blank line between them so they render as separate quote blocks, not one merged paragraph.
- User Stories: 3-5 stories in "As a ___, I want ___ so that ___" format.
- Success Metrics: 3-4 measurable metrics that would prove this was worth doing.
- Open Questions: 2-4 genuinely open questions a team would need to answer before scoping this.

HARD RULE - no fabricated statistics: the only numbers you may state anywhere in the PRD are
the exact frequency, severity, reach, impact, confidence, effort, and rice_score values given
in the input JSON below (you may do simple arithmetic on them, e.g. quoting rice_score to 1
decimal place). Never invent a specific user count, percentage, dollar figure, or date that
does not come directly from those fields - Success Metrics and Open Questions should describe
*what* to measure or investigate, not assert a number you don't have (e.g. write "reduce
[metric] materially" or "define a target once real analytics are available", not "reduce by
40%" unless 40% is literally one of the input values).`;

// The PM's decision status changes how the PRD should read - a document
// drafted for something still under investigation should not sound like an
// engineering commitment, and one already rejected should read as a record
// of why, not a pitch. Same HARD RULE about fabricated numbers still applies
// to whatever framing is added here.
const DECISION_FRAMING = {
  Build: `Decision status: BUILD. The team has approved this to move forward. Write the PRD as
an active commitment - "we will build..." framing throughout is appropriate.`,
  Investigate: `Decision status: INVESTIGATE. This has NOT been approved to build - it's flagged
for further investigation, likely because the evidence (reach, confidence, or the theme itself)
needs validation first. Frame the Problem Statement and Proposed Solution as a recommendation
pending validation, not a commitment ("a likely direction, pending validation" rather than "we
will"). Open Questions MUST include what specifically needs to be validated before this could
move to Build.`,
  Defer: `Decision status: DEFER. This is deprioritized for now, not rejected - a real problem
worth revisiting later, just not next. Frame the PRD as documentation of a validated problem to
revisit, not as active work ("when this is picked back up" rather than "we will"). Open
Questions should include what would need to change (capacity, a priority shift, more evidence)
to bring this back into scope.`,
  Reject: `Decision status: REJECTED. This was considered and explicitly not moved forward.
Frame the PRD as a decision record, not a pitch: still state the problem plainly, but the
Proposed Solution section should describe what was considered rather than recommend building
it, and Open Questions should focus on what evidence or circumstances would justify revisiting
this decision - not on how to scope it.`,
};

router.post("/", async (req, res) => {
  try {
    const { theme } = req.body;
    if (!theme || typeof theme !== "object" || !theme.theme) {
      return res.status(400).json({ error: "Provide the top-ranked theme object in the 'theme' field." });
    }

    if (MOCK_MODE) {
      return res.json({ prd: mockGeneratePRD(theme) });
    }

    const decisionFraming = DECISION_FRAMING[theme.decision] || "";
    const systemPrompt = decisionFraming ? `${BASE_SYSTEM_PROMPT}\n\n${decisionFraming}` : BASE_SYSTEM_PROMPT;

    const response = await generateContentWithRetry({
      model: MODEL,
      contents: `Draft the PRD for this theme:\n\n${JSON.stringify(theme, null, 2)}`,
      config: { systemInstruction: systemPrompt },
    });

    if (!response.text) {
      throw new Error("Model response contained no text content.");
    }

    res.json({ prd: response.text });
  } catch (err) {
    console.error("prd error:", err);
    res.status(500).json({ error: "Failed to generate PRD.", detail: err.message });
  }
});

export default router;
