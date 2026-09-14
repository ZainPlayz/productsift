import { z } from "zod";

// A cluster is deliberately scored on two separate axes instead of one blended
// "importance" number: a theme can be mentioned constantly but be low-stakes
// (a cosmetic nitpick), or mentioned rarely but be severe (a data-loss bug one
// power user hit). Keeping frequency and severity apart lets the prioritization
// step weigh them independently via Severity and (a separate call's) Impact.
//
// v1.4: v1.3 still asked one model call to both discover themes AND decide
// item membership from the raw, noisy feedback text - which meant incidental
// keyword overlap (a mobile crash mentioning "notifications") could still
// hijack a classification even with unclassified available as an escape
// valve. v1.4 splits this into three narrower, single-purpose LLM calls,
// each of which is deliberately not allowed to see or do the others' job,
// plus a code-owned acceptance gate between them:
//
//   1. DISCOVERY (this file's DiscoveryResponseSchema) - extract a clean
//      "primary issue" per item (stripped of context/asides), then propose
//      themes with an explicit DEFINITION from those extracted issues. No
//      item-to-theme assignment happens here.
//   2. CLASSIFICATION (ClassificationResponseSchema) - given ONLY a primary
//      issue and the theme definitions (never the raw feedback text), return
//      the best AND second-best matching theme with a 0-1 fit score for
//      each. Code then applies a hard threshold (cluster.js) - a classification
//      is only tentatively accepted if best_fit is high AND clearly beats
//      second_best_fit by a margin; otherwise it's unclassified, with the
//      score breakdown kept so the UI can show *why* it's ambiguous.
//   3. VALIDATION (ValidationResponseSchema) - a genuinely separate pass,
//      run only on tentatively-accepted items, given the original feedback +
//      the assigned theme's definition, asked one skeptical yes/no question
//      ("does this really represent the primary issue?"). It can only
//      confirm or reject - the schema has no field for proposing a
//      different theme, so it structurally cannot become a second
//      classifier making the same kind of mistake.
//
// cluster.js's buildEvidence() then builds supporting_item_numbers and
// frequency from ONLY classifications that passed both the fit threshold
// and validation - never from anything a single model call asserts about
// itself. See cluster.js for the full three-call orchestration.
export const PrimaryIssueSchema = z.object({
  item_number: z.number().int().min(1).describe("The feedback item's number from the numbered input list"),
  primary_issue: z
    .string()
    .describe(
      "A short (5-12 word), clean restatement of the ONE main problem or request in this item - " +
        "strip incidental context, greetings, praise, or secondary details. E.g. 'The mobile app " +
        "crashes when opening notifications' -> 'Mobile app crashes when opening notifications', " +
        "not 'Notifications' and not a copy of the full sentence.",
    ),
});

export const ThemeDefinitionSchema = z.object({
  theme_id: z.string().describe("Short stable id, e.g. 'T1', 'T2' - referenced by classification calls. Must be unique."),
  theme: z.string().describe("Short theme name, e.g. 'Confusing checkout flow'"),
  definition: z
    .string()
    .describe(
      "1-2 sentences defining exactly what DOES and does NOT belong in this theme - specific enough " +
        "that a primary issue can be judged against it, not just a topic label. E.g. not 'Mobile " +
        "issues' but 'Crashes, freezes, or unexpected termination of the mobile app specifically - " +
        "not general slowness (that's Performance) and not notification content (that's Notifications).'",
    ),
  // max is intentionally loose (8, not the "2-6" the prompt asks for): Groq's
  // strict mode was found live to not fully enforce array maxItems even with
  // strict:true (a real gap in "100% schema adherence" - it generated 7 for
  // a max(6) schema, rejected by our own Zod validation with no useful
  // recourse). Since keywords are purely informational (never a gate - see
  // hasKeywordOverlap in cluster.js), a slightly loose cap costs nothing;
  // it's cheaper than fighting an enforcement gap that isn't ours to fix.
  keywords: z
    .array(z.string())
    .min(2)
    .max(8)
    .describe(
      "2-6 short words/phrases a primary issue truly belonging to this theme would typically contain " +
        "(e.g. 'slow', 'lag', 'freeze' for a performance theme). Used only as a secondary sanity check " +
        "in code, never as the basis for the classification itself.",
    ),
  severity: z.number().int().min(1).max(5).describe("1 (cosmetic) to 5 (blocks core usage or causes churn)"),
  severity_reasoning: z.string().describe("One sentence justifying the severity score"),
  example_quotes: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe("1-3 short excerpts from the input feedback that illustrate this theme"),
});

export const DiscoveryResponseSchema = z.object({
  item_primary_issues: z
    .array(PrimaryIssueSchema)
    .min(1)
    .describe("EXACTLY one entry per feedback item in the numbered input list, in order 1..N."),
  themes: z
    .array(ThemeDefinitionSchema)
    .min(1)
    .describe(
      "Distinct themes found among the primary issues above, deduplicated - near-duplicate rewordings merged into one theme.",
    ),
});

// "none" (not null) for the same reason v1.3 used the string "unclassified" -
// Gemini's structured-output JSON Schema subset is ambiguous on nullable
// fields, so a plain string sentinel sidesteps that entirely.
export const NONE_THEME = "none";

export const ClassificationSchema = z.object({
  item_number: z.number().int().min(1).describe("The feedback item's number this classification is for"),
  best_theme: z.string().describe(`theme_id of the best-fitting theme, or the literal string "${NONE_THEME}" if nothing plausibly fits.`),
  best_fit: z.number().min(0).max(1).describe("0-1: how well the primary issue matches best_theme's DEFINITION specifically."),
  second_best_theme: z.string().describe(`theme_id of the next-best-fitting theme, or "${NONE_THEME}" if there is no real second candidate.`),
  second_best_fit: z.number().min(0).max(1).describe(`0-1 fit for second_best_theme. 0 if second_best_theme is "${NONE_THEME}".`),
  reason: z
    .string()
    .describe(
      "One sentence: why best_theme fits. If a DIFFERENT theme shares an incidental keyword with this " +
        "item but isn't the primary issue, say so explicitly and explain why it was not chosen.",
    ),
});

export const ClassificationResponseSchema = z.object({
  classifications: z
    .array(ClassificationSchema)
    .min(1)
    .describe("EXACTLY one entry per primary issue given, in the same order."),
});

export const ValidationSchema = z.object({
  item_number: z.number().int().min(1),
  valid: z
    .boolean()
    .describe("Does the assigned theme's DEFINITION genuinely represent this item's primary issue? Be skeptical - if there's real doubt, answer false."),
  reason: z
    .string()
    .describe("One sentence. If false, name what the item's actual primary issue is instead of the assigned theme."),
});

export const ValidationResponseSchema = z.object({
  validations: z
    .array(ValidationSchema)
    .min(1)
    .describe("EXACTLY one entry per item being validated, in the same order given."),
});

// v1.5: dropped Reach/Confidence/Effort. In practice nobody was editing them
// (this is a synthesis/prioritization tool, not a ticket tracker - effort
// estimation in person-weeks belongs in Jira/Asana/Linear, not here), and
// Reach/Confidence in particular were AI guesses layered on top of an AI
// guess with no real data behind either. What's left - Impact (this call)
// and Severity (already produced during clustering, from real evidence) -
// are both grounded in the actual feedback rather than invented numbers.
// priority_score = impact * severity, computed in code (prioritize.js), same
// "never trust the model's own arithmetic" pattern this project has used
// throughout.
export const PriorityEstimateSchema = z.object({
  impact: z
    .number()
    .int()
    .min(1)
    .max(5)
    .describe(
      "1-5: how much fixing this would move the needle for an affected user. Related to severity " +
        "(how bad the reported problem is) but not identical to it - severity is about how bad the " +
        "problem is today, impact is about how much value fixing it delivers. Usually tracks severity " +
        "closely, but use judgment: a severe-but-rare edge case can have lower impact than a moderate " +
        "problem affecting a core workflow.",
    ),
  impact_reasoning: z.string().describe("One sentence a PM could defend to a stakeholder who asks 'why?'"),
});

export const PrioritizeResponseSchema = z.object({
  themes: z
    .array(PriorityEstimateSchema)
    .min(1)
    .describe(
      "Exactly one impact estimate per input theme, in the exact same order the themes were given - " +
        "do not add, remove, merge, or reorder themes.",
    ),
});
