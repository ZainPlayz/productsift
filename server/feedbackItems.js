// Splits raw pasted/uploaded feedback into numbered items (1-based), one per
// non-empty line. This numbering is what the cluster prompt shows the model
// and what supporting_item_numbers refers back to, so cluster.js returns the
// same split items array to the frontend rather than have the browser
// re-derive it - one source of truth for "item #N" instead of two split
// implementations that could quietly drift apart.
export function splitFeedbackItems(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}
