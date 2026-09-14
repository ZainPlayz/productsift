// Canned data for MOCK_MODE=true. The cluster fixture is hand-written (real
// clustering needs an LLM's judgment - there's no cheap heuristic substitute),
// but the prioritize and PRD "mocks" below are genuine template functions that
// operate on WHATEVER themes array they're given, mock or real. That means
// MOCK_MODE exercises the exact same rendering and priority-score code paths
// the live API path uses - the only thing being skipped is the network call.
//
// CLUSTER_MOCK_RESULT represents the FINAL output of the v1.4 three-call
// pipeline (discovery -> classification -> validation, gated in code - see
// cluster.js) rather than simulating each raw call, and lines up with
// sample-feedback.txt's 52 non-blank lines in order. It's written to
// demonstrate all three reasons an item can end up unclassified:
// - #46 "the mobile app is slow" -> AMBIGUOUS: Performance (74%) vs Mobile
//   experience (71%) is too close a margin to accept either automatically.
// - #48 "notifications delayed 30 min" -> VALIDATION_FAILED: tentatively
//   passed the fit/margin gate under Performance, but the validation pass
//   caught that "delayed" here means late delivery, not slow responsiveness.
// - #50 "wish you had a purple logo" -> NO_MATCH: nothing plausibly fits.
// Contrast with #49 "wish there was a dark mode" -> now correctly and
// confidently classified into its own theme - the exact bug this
// architecture exists to prevent, fixed.

const IT = (n, primary_issue, bucket, fit, keyword_overlap = true) => ({
  n,
  fit_entry: { bucket, fit, keyword_overlap, primary_issue },
});

function themeWithEvidence(theme, itemEntries) {
  const supporting_item_numbers = itemEntries.map((e) => e.n).sort((a, b) => a - b);
  const item_fit = Object.fromEntries(itemEntries.map((e) => [e.n, e.fit_entry]));
  return { ...theme, supporting_item_numbers, frequency: supporting_item_numbers.length, item_fit };
}

const T1_ITEMS = [
  IT(1, "App is slow to show tasks in the morning", "strong", 0.95),
  IT(2, "Loading time is brutal on first open", "strong", 0.95),
  IT(3, "App gets slower as more projects are added", "strong", 0.93),
  IT(4, "Dashboard takes forever to open", "strong", 0.95),
  IT(5, "App lags when switching projects", "strong", 0.93),
  IT(6, "Performance has gotten worse over recent updates", "strong", 0.95),
  IT(7, "Loading spinner is too slow on phone", "strong", 0.9),
  IT(8, "Dashboard is sluggish in the morning", "strong", 0.95),
  IT(9, "Considering switching tools due to slowness", "strong", 0.92),
  IT(10, "App hangs for seconds after being idle", "strong", 0.94),
  IT(11, "Loading tasks is annoyingly slow", "strong", 0.95),
];

const T2_ITEMS = [
  IT(12, "Notified on every checkbox edit, had to mute app", "strong", 0.94),
  IT(13, "Wants notifications only for @mentions", "strong", 0.9),
  IT(14, "Too many notifications, can't tell what matters", "strong", 0.93),
  IT(15, "No way to turn off notifications per project", "strong", 0.92),
  IT(16, "Every shared-board change pings phone", "strong", 0.91),
  IT(17, "Muted all notifications, no in-between option", "strong", 0.93),
  IT(18, "Wants to choose push vs in-app badge per event", "strong", 0.9),
  IT(19, "Notification settings are all-or-nothing", "strong", 0.94),
  IT(20, "Phone buzzes constantly when team is active", "strong", 0.9),
];

const T3_ITEMS = [
  IT(21, "Charged for team plan despite being sole user", "strong", 0.95),
  IT(22, "Pricing page doesn't match account settings", "strong", 0.93),
  IT(23, "Billed after trying to downgrade plan", "strong", 0.94),
  IT(24, "Support took a week to explain a double charge", "strong", 0.91),
  IT(25, "Unclear which features come with which tier", "strong", 0.9),
  IT(26, "Charged again after cancelling", "strong", 0.95),
  IT(27, "Billing page is confusing", "strong", 0.93),
  IT(28, "No clear breakdown of invoice charges", "strong", 0.92),
];

const T4_ITEMS = [
  IT(29, "Wants deadlines to show up in Google Calendar", "strong", 0.94),
  IT(30, "No Outlook sync unlike other tools", "strong", 0.92),
  IT(31, "Wants calendar sync instead of manual copying", "strong", 0.93),
  IT(32, "No calendar integration is a dealbreaker", "strong", 0.94),
  IT(33, "Wants two-way calendar sync", "strong", 0.93),
  IT(34, "Would pay extra for Google Calendar integration", "strong", 0.92),
  IT(35, "Team asking about Outlook sync", "strong", 0.9),
  IT(36, "Re-entering due dates weekly is tedious", "strong", 0.91),
];

const T5_ITEMS = [
  IT(37, "Old task not found by search", "strong", 0.93),
  IT(38, "Archive search seems broken or missing", "strong", 0.9),
  IT(39, "Can't find tasks from completed projects", "strong", 0.94),
  IT(40, "Search only covers recent items, not full history", "strong", 0.93),
  IT(41, "Lost track of an old task search couldn't find", "strong", 0.91),
];

const T6_ITEMS = [
  IT(42, "Hard to figure out how to grant view-only access", "strong", 0.92),
  IT(43, "Permissions settings spread across three menus", "strong", 0.93),
  IT(44, "New teammates confused about permission levels", "strong", 0.91),
  IT(45, "Wants sharing settings in one place", "strong", 0.9),
];

const T7_ITEMS = [
  IT(47, "Mobile app crashes when opening notifications", "strong", 0.92, false),
  IT(51, "Mobile buttons are cut off and hard to tap", "strong", 0.93),
  IT(52, "Mobile buttons unreachable without side-scrolling", "strong", 0.91),
];

const T8_ITEMS = [IT(49, "No dark mode for nighttime use", "strong", 0.97)];

export const CLUSTER_MOCK_RESULT = {
  themes: [
    themeWithEvidence(
      {
        theme_id: "T1",
        theme: "App feels slow / laggy on open",
        definition:
          "The app or a specific screen (especially the dashboard/task list) takes noticeably long to load, feels sluggish, or is unresponsive on general use - not mobile-specific crashes (Mobile experience) and not late notification delivery (Notifications).",
        keywords: ["slow", "lag", "loading", "sluggish", "hang", "performance"],
        severity: 4,
        severity_reasoning:
          "Performance issues hit every session and were the most common reason users cited for considering alternatives.",
        example_quotes: [
          "It takes like 5 seconds just to see my tasks every morning.",
          "Feels like it gets slower the more projects I add.",
        ],
      },
      T1_ITEMS,
    ),
    themeWithEvidence(
      {
        theme_id: "T2",
        theme: "Notification overload with no granular controls",
        definition:
          "Complaints about too many notifications, or no way to filter/customize which events trigger one - not about notifications arriving late (a timing complaint) and not about the app crashing on a screen that happens to be notifications-related.",
        keywords: ["notification", "push", "mute", "alert", "granular"],
        severity: 3,
        severity_reasoning:
          "Annoying rather than blocking, but it's pushing users to miss notifications they do want by disabling everything.",
        example_quotes: [
          "I get a push every time someone edits a checkbox. I had to just mute the whole app.",
          "Wish I could only get notified for @mentions.",
        ],
      },
      T2_ITEMS,
    ),
    themeWithEvidence(
      {
        theme_id: "T3",
        theme: "Billing and subscription tier confusion",
        definition:
          "Users being surprised by charges, billed incorrectly, or unable to tell which plan features they're paying for.",
        keywords: ["charge", "billing", "invoice", "plan", "subscription", "refund"],
        severity: 5,
        severity_reasoning:
          "Directly tied to revenue and trust - billing surprises are a top driver of churn and support escalations.",
        example_quotes: [
          "Got charged for the team plan but I'm the only user, no idea why.",
          "The pricing page doesn't match what I see in my account settings.",
        ],
      },
      T3_ITEMS,
    ),
    themeWithEvidence(
      {
        theme_id: "T4",
        theme: "No calendar integration (Google/Outlook)",
        definition: "Requests for due dates to sync two-way with an external calendar app instead of living only inside the product.",
        keywords: ["calendar", "sync", "outlook", "google calendar", "due date"],
        severity: 2,
        severity_reasoning:
          "A frequently requested convenience feature, but users have workarounds (manual entry) so it doesn't block usage.",
        example_quotes: [
          "Would love if my deadlines just showed up in Google Calendar automatically.",
          "Every other tool I use syncs with Outlook, this one doesn't.",
        ],
      },
      T4_ITEMS,
    ),
    themeWithEvidence(
      {
        theme_id: "T5",
        theme: "Search doesn't find older or archived tasks",
        definition: "Search fails to surface tasks from completed, archived, or otherwise non-recent projects.",
        keywords: ["search", "archive", "find", "history", "old task"],
        severity: 3,
        severity_reasoning:
          "Breaks trust in the tool as a system of record, though it mostly affects users with a long project history.",
        example_quotes: [
          "Searched for a task I know I made months ago and got nothing.",
          "Archive search feels broken, or maybe it just doesn't exist?",
        ],
      },
      T5_ITEMS,
    ),
    themeWithEvidence(
      {
        theme_id: "T6",
        theme: "Team sharing/permissions are confusing to set up",
        definition:
          "Admins struggling to understand or locate permission/sharing settings when inviting collaborators - a setup-time usability issue, not a bug.",
        keywords: ["permission", "sharing", "access", "invite", "view-only"],
        severity: 2,
        severity_reasoning: "A one-time setup friction point rather than an ongoing daily annoyance, limited to admins.",
        example_quotes: [
          "Took me way too long to figure out how to give someone view-only access.",
          "The permissions settings are spread across three different menus.",
        ],
      },
      T6_ITEMS,
    ),
    themeWithEvidence(
      {
        theme_id: "T7",
        theme: "Mobile experience feels unpolished",
        definition:
          "Mobile-app-specific stability or layout problems - crashes, freezes, cut-off or unreachable UI elements on the phone app specifically. Not general slowness (Performance) and not what a mobile crash happens to be near, like a notifications screen.",
        keywords: ["mobile", "crash", "freeze", "button", "layout", "phone"],
        severity: 3,
        severity_reasoning:
          "Not a full outage, but stability and usability issues on mobile specifically push users toward the desktop app or a competitor's mobile app.",
        example_quotes: [
          "The mobile app crashes when opening notifications.",
          "The mobile app feels like an afterthought - buttons are cut off and hard to tap.",
        ],
      },
      T7_ITEMS,
    ),
    themeWithEvidence(
      {
        theme_id: "T8",
        theme: "Dark mode request",
        definition: "Requests for a dark color theme, usually framed around low-light/nighttime use.",
        keywords: ["dark mode", "theme", "night", "brightness"],
        severity: 1,
        severity_reasoning: "A cosmetic preference request, not a blocker for any workflow.",
        example_quotes: ["I wish there was a dark mode. Using the app at night is way too bright."],
      },
      T8_ITEMS,
    ),
  ],
  unclassified_item_numbers: [46, 48, 50],
  unclassified_reasons: {
    46: {
      type: "ambiguous",
      detail: 'Too close to call: "App feels slow / laggy on open" (74%) vs "Mobile experience feels unpolished" (71%).',
    },
    48: {
      type: "validation_failed",
      detail:
        "The primary issue is notifications arriving late, not app responsiveness - this is a delivery-timing problem, not a performance one.",
    },
    50: {
      type: "no_match",
      detail: "No theme's definition plausibly matched this item's primary issue.",
    },
  },
};

// Returns estimates in the SAME ORDER as the input themes array - the caller
// (prioritize.js) matches estimates back to themes by array position, the
// same way the live Groq path does, so this must not re-sort.
export function mockPrioritizeThemes(themes) {
  return themes.map((t) => {
    // Impact tracks severity directly in mock mode (a defensible baseline -
    // the real prompt tells the live model the same thing, "usually tracks
    // severity closely") - mock mode doesn't need to be clever, just
    // representative enough to exercise the full prioritization flow.
    const impact = t.severity;
    return {
      impact,
      impact_reasoning: `Mock estimate: impact tracks this theme's severity (${t.severity}/5) directly.`,
    };
  });
}

export function mockGeneratePRD(theme) {
  return `# PRD: ${theme.theme}

## Problem Statement
${theme.definition} This theme was raised in ${theme.frequency} pieces of feedback with a severity rating of ${theme.severity}/5, and ranked #1 in this analysis with a priority score of ${theme.priority_score}.${theme.decision ? ` [Mock mode] Decision status: ${theme.decision}.` : ""}

## Proposed Solution
[Mock mode] A concrete solution direction would go here in a real run - e.g. the specific mechanism that addresses the root cause described above, not just a restatement of the problem.

## Scope

**In scope**
- The core fix directly addressing the problem statement above
- Communicating the change to affected users

**Out of scope**
- [Mock mode] Adjacent work a real PRD would explicitly rule out to prevent scope creep

## Background
Representative feedback:

${theme.example_quotes.map((q) => `> "${q}"`).join("\n\n")}

## User Stories
- As a user, I want this issue resolved so that I can complete my workflow without friction.
- As a returning user, I want a visible signal that this has improved so that I trust the product is getting better.
- As a support team member, I want fewer tickets about this issue so that I can focus on higher-value work.

## Success Metrics
- Reduction in feedback/support volume mentioning this theme (target: -50% within one quarter of shipping a fix)
- Improvement in the relevant satisfaction or retention metric for the affected user segment
- [Mock mode] Replace with metrics tied to real product analytics once available

## Open Questions
- Is this one root cause or several distinct issues being described the same way?
- What does real engineering scoping say about effort? (Not estimated by this tool - that
  belongs in your ticket tracker once this is prioritized.)
- Are there smaller, faster wins worth shipping ahead of a full fix?

---
*Generated in MOCK_MODE - this is a templated PRD used to verify the pipeline end-to-end without calling the Groq API. Set GROQ_API_KEY and turn MOCK_MODE off for a real, AI-drafted PRD.*
`;
}
