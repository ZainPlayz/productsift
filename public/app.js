// All state lives in memory for the session only - no backend persistence,
// matching the "no database needed for v1" scope. Refreshing the page loses it.
let clusteredThemes = []; // each carries supporting_item_numbers/frequency/item_fit, kept live-mutated as the PM reassigns items
let unclassifiedItems = []; // item numbers with no theme assigned - a real, expected state, not an error
let unclassifiedReasons = {}; // item_number -> { type: "ambiguous"|"validation_failed"|"no_match"|"manual", detail }
let rankedThemes = [];
let feedbackItems = []; // numbered (1-based) split of the submitted feedback, from /api/cluster
let lastPrdMarkdown = ""; // raw markdown of the most recently generated PRD, for "Copy PRD"
let lastPrdTheme = null; // the theme that PRD was generated for, for the decision badge

let isMockMode = false; // set from /api/status below - mock mode's canned response is the same regardless of input, so Analyze forces the bundled sample data instead of pretending arbitrary text drives it

// --- Sharing (persisted "living" project link, e.g. /p/abc123) ---
let currentProjectId = null; // null until the first Share click, or until hydrated from a /p/:id link
let saveTimer = null;
let hydrating = false; // true while restoreState() is applying a loaded project, so autosave doesn't immediately re-save what it just loaded

const DECISIONS = ["Build", "Investigate", "Defer", "Reject"];

// Shown as a tooltip on each decision button AND as a one-line hint under the
// button group once picked - a PM shouldn't have to already know this tool's
// specific meaning for "Investigate" vs. "Defer" to use it correctly, and
// the real point of the control (it changes how the PRD gets WRITTEN, not
// just a label on a card) isn't obvious unless stated.
const DECISION_INFO = {
  Build: "Approved to move forward - the PRD will read as a commitment (\"we will build...\").",
  Investigate: "Not yet approved - the PRD reads as a recommendation pending validation, with open questions on what to validate first.",
  Defer: "Deprioritized, not rejected - the PRD documents it as a real problem worth revisiting later.",
  Reject: "Considered and passed on - the PRD reads as a decision record, not a pitch.",
};
const DECISION_HINT_DEFAULT = "Choose a decision - it changes how the generated PRD is written, not just this card's label.";

const $ = (id) => document.getElementById(id);

const feedbackInput = $("feedbackInput");
const fileInput = $("fileInput");
const sampleBtn = $("sampleBtn");
const demoBtn = $("demoBtn");
const analyzeBtn = $("analyzeBtn");
const themesStage = $("themesStage");
const themesList = $("themesList");
const unclassifiedSection = $("unclassifiedSection");
const prioritizeBtn = $("prioritizeBtn");
const addThemeBtn = $("addThemeBtn");
const priorityStage = $("priorityStage");
const priorityTableBody = $("priorityTableBody");
const summaryStage = $("summaryStage");
const summaryList = $("summaryList");
const prdStage = $("prdStage");
const prdContent = $("prdContent");
const prdDecisionBadge = $("prdDecisionBadge");
const exportStage = $("exportStage");
const printExportBtn = $("printExportBtn");
const copyPrdBtn = $("copyPrdBtn");
const copySummaryBtn = $("copySummaryBtn");
const statusBanner = $("statusBanner");
const modeBanner = $("modeBanner");
const themeToggle = $("themeToggle");
const resetBtn = $("resetBtn");
const shareBtn = $("shareBtn");

// --- Theme (light/dark) ---
// The <head> script already applied any saved choice before first paint, to
// avoid a flash of the wrong theme. This just keeps the toggle button's
// label in sync and handles the click - localStorage is the right tool here
// (a per-viewer display preference, not app data), unlike the analysis
// state above which intentionally lives only in memory.
function systemPrefersDark() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || (systemPrefersDark() ? "dark" : "light");
}

function updateThemeToggleLabel() {
  const isDark = currentTheme() === "dark";
  themeToggle.textContent = isDark ? "Light mode" : "Dark mode";
}

themeToggle.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("theme", next);
  updateThemeToggleLabel();
});

updateThemeToggleLabel();

function setStatus(message, isError = false) {
  if (!message) {
    statusBanner.hidden = true;
    return;
  }
  statusBanner.hidden = false;
  statusBanner.textContent = message;
  statusBanner.classList.toggle("error", isError);
}

function setLoading(button, loading, label) {
  button.disabled = loading;
  button.dataset.label = button.dataset.label || button.textContent;
  if (loading) {
    button.innerHTML = `<span class="spinner" aria-hidden="true"></span>Working...`;
  } else {
    button.textContent = label || button.dataset.label;
  }
}

// Cycles the status banner through a few messages while a multi-step
// backend call (e.g. clustering's discover -> classify -> validate pipeline)
// is in flight - the server doesn't stream progress, so this doesn't make
// the wait shorter, but a static "Clustering..." for 10+ seconds reads as
// stuck, while a message that visibly changes reads as working. Returns a
// function that stops the cycle; call it as soon as the awaited call settles,
// before setting the final status message.
function cycleStatus(messages, intervalMs = 2200) {
  let i = 0;
  setStatus(messages[0]);
  const id = setInterval(() => {
    i = (i + 1) % messages.length;
    setStatus(messages[i]);
  }, intervalMs);
  return () => clearInterval(id);
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request to ${url} failed (${res.status})`);
  }
  return data;
}

// --- Stage 1: Input ---

sampleBtn.addEventListener("click", () => loadSampleData());

// Shared by "Load Sample Data", runAnalysis() (mock mode), and runDemo()
// below - all three just need "fetch a bundled file into the textarea".
// runDemo() deliberately points at the smaller demo-feedback.txt rather than
// the full 52-item sample.txt - a live analysis of the full file was
// measured taking 100+ seconds end to end, which defeats the point of a
// one-click demo (see the /demo-feedback.txt route in server/index.js).
async function loadSampleData(url = "/sample-feedback.txt") {
  try {
    const res = await fetch(url);
    feedbackInput.value = await res.text();
    updateFeedbackCount();
    return true;
  } catch (err) {
    setStatus(`Could not load ${url}`, true);
    return false;
  }
}

// Real feedback almost never arrives as hand-typed lines - it arrives as a
// CSV export from whatever tool collected it (App Store Connect, Play
// Console, Zendesk, Intercom, a Google Form). Parse those properly instead
// of dumping raw CSV syntax (commas, quoted fields) into the textarea.

// Minimal RFC4180-ish parser: handles quoted fields containing commas,
// newlines, and escaped `""` quotes - the actual shape real exports use,
// which a naive split(",")/split("\n") breaks on.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length));
}

const LIKELY_TEXT_HEADERS = ["review", "comment", "comments", "feedback", "message", "body", "text", "description", "note", "notes", "content"];

// Picks the column most likely to hold free-text feedback: an exact header
// name match first (covers the common export tools), then falls back to
// whichever column has the longest average cell length - IDs, ratings, and
// dates are short and uniform, actual feedback text isn't.
function pickTextColumn(rows) {
  const header = rows[0];
  const dataRows = rows.slice(1);
  const byName = header.findIndex((h) => LIKELY_TEXT_HEADERS.includes(h.trim().toLowerCase()));
  if (byName !== -1) return { index: byName, label: header[byName].trim(), dataRows };

  let bestIndex = 0;
  let bestAvgLen = -1;
  for (let col = 0; col < header.length; col++) {
    const lengths = dataRows.map((r) => (r[col] || "").length);
    const avg = lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1);
    if (avg > bestAvgLen) {
      bestAvgLen = avg;
      bestIndex = col;
    }
  }
  return { index: bestIndex, label: header[bestIndex]?.trim() || `column ${bestIndex + 1}`, dataRows };
}

function extractFeedbackFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { lines: rows.flat().map((c) => c.trim()).filter(Boolean), column: null };
  const { index, label, dataRows } = pickTextColumn(rows);
  const lines = dataRows.map((r) => (r[index] || "").trim()).filter(Boolean);
  return { lines, column: label };
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  const text = await file.text();

  if (file.name.toLowerCase().endsWith(".csv") || file.type === "text/csv") {
    const { lines, column } = extractFeedbackFromCsv(text);
    feedbackInput.value = lines.join("\n");
    setStatus(
      column
        ? `Loaded ${lines.length} feedback item(s) from the "${column}" column of ${file.name}. Check the text below - edit it if the wrong column got picked.`
        : `Loaded ${lines.length} feedback item(s) from ${file.name}.`,
    );
  } else {
    feedbackInput.value = text;
  }
  updateFeedbackCount();
});

analyzeBtn.addEventListener("click", () => runAnalysis());

// Pulled out of the click listener so runDemo() (below) can await the
// same logic instead of simulating a click and hoping it finished - returns
// true/false so a chained caller knows whether to continue to the next stage.
async function runAnalysis() {
  // Guards the brief window before setLoading() below actually disables the
  // button - e.g. runDemo() is already mid-flight and a fast click lands
  // before that happens. A real click on an already-disabled button never
  // reaches here at all; this only matters for that narrow race.
  if (analyzeBtn.disabled) return false;
  let feedback = feedbackInput.value.trim();
  if (!feedback && !isMockMode) {
    setStatus("Paste some feedback first, or click 'Load Sample Data'.", true);
    return false;
  }

  // Mock mode's response is a fixed canned dataset - it does not read the
  // submitted text at all. Silently accepting arbitrary input (e.g. "hello")
  // and returning an elaborate 8-theme analysis anyway is actively
  // misleading about what demo mode is doing, so force the actual bundled
  // sample data here and show it in the box, rather than pretend the two are
  // connected.
  if (isMockMode) {
    if (!(await loadSampleData())) return false;
    feedback = feedbackInput.value.trim();
  }

  // Reset downstream stages so an old table/summary/PRD never shows alongside a new analysis.
  priorityStage.hidden = true;
  summaryStage.hidden = true;
  prdStage.hidden = true;
  exportStage.hidden = true;
  lastPrdMarkdown = "";
  lastPrdTheme = null;

  setLoading(analyzeBtn, true);
  const stopCycle = cycleStatus([
    "Discovering themes...",
    "Classifying feedback against each theme...",
    "Double-checking uncertain classifications...",
  ]);
  try {
    const data = await postJSON("/api/cluster", { feedback });
    stopCycle();
    clusteredThemes = data.themes;
    feedbackItems = data.items;
    unclassifiedItems = data.unclassified_item_numbers ?? [];
    unclassifiedReasons = data.unclassified_reasons ?? {};
    renderThemes();
    themesStage.hidden = false;
    themesStage.scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus(
      `Found ${clusteredThemes.length} distinct theme(s) across ${feedbackItems.length} feedback item(s)` +
        (unclassifiedItems.length ? `, ${unclassifiedItems.length} unclassified.` : "."),
    );
    return true;
  } catch (err) {
    stopCycle();
    setStatus(err.message, true);
    return false;
  } finally {
    setLoading(analyzeBtn, false);
  }
}

// --- Stage 2: Themes ---

// Evidence for every theme is owned by this state, not re-fetched: each
// theme's supporting_item_numbers/frequency/item_fit came from the server's
// three-call pipeline (discover -> classify -> validate, gated in code - see
// cluster.js), and stay mutated in place here as the PM reassigns an item -
// the same "edit in place, full re-render" pattern the priority table already
// uses for overrides.

function themeById(themeId) {
  return clusteredThemes.find((t) => t.theme_id === themeId);
}

// Moves one item from its current theme (or unclassified) to a new one (or
// unclassified), keeping supporting_item_numbers/frequency/item_fit
// consistent on both sides - this is the "PM says nope, that's wrong" fix
// for a bad AI classification, applied entirely client-side. The item's
// primary_issue text (if it had one) carries over so it isn't lost on a move.
function reassignItem(itemNumber, fromThemeId, toThemeId) {
  let carriedPrimaryIssue = null;

  if (fromThemeId) {
    const from = themeById(fromThemeId);
    carriedPrimaryIssue = from.item_fit[itemNumber]?.primary_issue ?? null;
    from.supporting_item_numbers = from.supporting_item_numbers.filter((n) => n !== itemNumber);
    delete from.item_fit[itemNumber];
    from.frequency = from.supporting_item_numbers.length;
  } else {
    unclassifiedItems = unclassifiedItems.filter((n) => n !== itemNumber);
    delete unclassifiedReasons[itemNumber];
  }

  if (toThemeId) {
    const to = themeById(toThemeId);
    to.supporting_item_numbers = [...to.supporting_item_numbers, itemNumber].sort((a, b) => a - b);
    to.item_fit[itemNumber] = { bucket: "manual", fit: null, keyword_overlap: null, primary_issue: carriedPrimaryIssue };
    to.frequency = to.supporting_item_numbers.length;
  } else {
    unclassifiedItems = [...unclassifiedItems, itemNumber].sort((a, b) => a - b);
    unclassifiedReasons[itemNumber] = { type: "manual", detail: "Manually unclassified by PM." };
  }

  renderThemes();
  setStatus(
    `Moved feedback #${itemNumber} to ${toThemeId ? `"${themeById(toThemeId).theme}"` : "Unclassified"}.` +
      (!priorityStage.hidden ? " Re-run 'Prioritize' to reflect the updated frequency." : ""),
  );
}

// "Fit", not "confidence" - the model doesn't actually know there's a 96%
// probability it's correct, so the UI shouldn't imply that kind of
// objective certainty. Only 2 buckets apply to ACCEPTED items (strong/
// moderate - anything below cluster.js's threshold never becomes evidence
// at all); "manual" marks a PM's own reassignment, not an AI judgment.
const FIT_LABEL = { strong: "Strong fit", moderate: "Moderate fit", manual: "PM reassigned" };

function themeSelectHtml(currentThemeId) {
  const options = [`<option value="" ${!currentThemeId ? "selected" : ""}>Unclassified</option>`]
    .concat(
      clusteredThemes.map(
        (t) => `<option value="${t.theme_id}" ${t.theme_id === currentThemeId ? "selected" : ""}>${escapeHtml(t.theme)}</option>`,
      ),
    )
    .join("");
  return `<select class="reassign-select" aria-label="Reassign to theme">${options}</select>`;
}

// fitEntry is set for an item classified into a theme; unclassifiedReason is
// set for an item in the Unclassified bucket - exactly one of the two is
// ever non-null, and it's the unclassified case that got the most attention:
// showing *why* ("too close to call between X and Y", "validation rejected
// this", "manually moved here") beats a bare "unclassified" every time.
function evidenceItemHtml(itemNumber, themeId, fitEntry, unclassifiedReason) {
  const flagged = fitEntry?.bucket === "moderate" || (unclassifiedReason && unclassifiedReason.type !== "manual");
  const fitBadge = fitEntry ? `<span class="fit-badge fit-${fitEntry.bucket}">${FIT_LABEL[fitEntry.bucket]}</span>` : "";
  const keywordNote =
    fitEntry && fitEntry.keyword_overlap === false
      ? `<span class="keyword-note" title="This theme's sanity-check keywords don't appear in the item's primary issue - not necessarily wrong, just worth a second look">no keyword match</span>`
      : "";
  const reasonLine = unclassifiedReason ? `<div class="unclassified-reason">${escapeHtml(unclassifiedReason.detail)}</div>` : "";

  return `
    <li class="evidence-item ${flagged ? "flagged" : ""}" data-item-number="${itemNumber}">
      <div class="evidence-text">
        <span class="item-number">#${itemNumber}</span> "${escapeHtml(feedbackItems[itemNumber - 1] ?? "")}"
        ${reasonLine}
      </div>
      <div class="evidence-controls no-print">
        ${fitBadge}
        ${keywordNote}
        ${themeSelectHtml(themeId)}
      </div>
      <div class="evidence-print-only">${fitEntry ? FIT_LABEL[fitEntry.bucket] : ""}${themeId ? "" : ` - Unclassified${unclassifiedReason ? `: ${unclassifiedReason.detail}` : ""}`}</div>
    </li>
  `;
}

function wireEvidenceReassignment(container, currentThemeId) {
  container.querySelectorAll(".evidence-item").forEach((li) => {
    const itemNumber = Number(li.dataset.itemNumber);
    li.querySelector(".reassign-select").addEventListener("change", (e) => {
      reassignItem(itemNumber, currentThemeId, e.target.value || null);
    });
  });
}

// Reassigning an item re-runs renderThemes() from scratch (simplest way to
// keep frequency/evidence consistent everywhere), which would otherwise
// re-collapse every evidence panel back to its default hidden state - so a
// PM working through a list of unclassified items had to re-open the panel
// after every single reassignment. Tracking which panels are open here (by
// theme_id, or the literal string "unclassified") lets the render restore
// that state instead of resetting it.
const expandedEvidencePanels = new Set();

function renderThemes() {
  themesList.innerHTML = "";
  clusteredThemes.forEach((t) => {
    const moderateCount = Object.values(t.item_fit).filter((f) => f.bucket === "moderate").length;
    const isExpanded = expandedEvidencePanels.has(t.theme_id);
    const card = document.createElement("div");
    card.className = "theme-card";
    card.innerHTML = `
      <h3>${escapeHtml(t.theme)}</h3>
      <div class="badge-row">
        <span class="badge">${t.frequency} feedback item${t.frequency === 1 ? "" : "s"}</span>
        <span class="badge sev-${t.severity}">Severity: ${t.severity}/5</span>
        ${moderateCount > 0 ? `<span class="badge warning-badge">&#9888; ${moderateCount} moderate fit</span>` : ""}
      </div>
      <p>${escapeHtml(t.definition)}</p>
      <p class="hint">${escapeHtml(t.severity_reasoning)}</p>
      ${t.example_quotes.map((q) => `<div class="quote">"${escapeHtml(q)}"</div>`).join("")}
      <button type="button" class="evidence-toggle">${t.frequency === 0 ? "No" : isExpanded ? "Hide" : "View"} supporting feedback &middot; ${t.frequency}</button>
      <ul class="evidence-list${isExpanded ? "" : " hidden"}">
        ${t.supporting_item_numbers.map((n) => evidenceItemHtml(n, t.theme_id, t.item_fit[n], null)).join("")}
      </ul>
    `;
    // Evidence list is populated upfront (cheap - no API call) rather than
    // lazily on first click, so the print/PDF export always includes it even
    // for a theme the PM never manually expanded on screen.

    const toggleBtn = card.querySelector(".evidence-toggle");
    const evidenceList = card.querySelector(".evidence-list");
    wireEvidenceReassignment(evidenceList, t.theme_id);

    toggleBtn.addEventListener("click", () => {
      if (t.frequency === 0) return;
      const isHidden = evidenceList.classList.toggle("hidden");
      toggleBtn.textContent = `${isHidden ? "View" : "Hide"} supporting feedback · ${t.frequency}`;
      if (isHidden) expandedEvidencePanels.delete(t.theme_id);
      else expandedEvidencePanels.add(t.theme_id);
    });

    themesList.appendChild(card);
  });

  renderUnclassifiedSection();
  scheduleSave();
}

// A deliberately visible "these didn't fit anywhere" bucket - forcing every
// item into some theme was the original bug (a dark-mode request landing in
// "performance" because both mention the app). Rejecting a classification
// costs nothing; a wrong one contaminates a theme's evidence.
function renderUnclassifiedSection() {
  if (unclassifiedItems.length === 0) {
    unclassifiedSection.innerHTML = "";
    return;
  }
  const isExpanded = expandedEvidencePanels.has("unclassified");
  unclassifiedSection.innerHTML = `
    <div class="unclassified-card">
      <button type="button" class="evidence-toggle">${unclassifiedItems.length} feedback item${unclassifiedItems.length === 1 ? "" : "s"} weren't assigned to a theme</button>
      <ul class="evidence-list${isExpanded ? "" : " hidden"}">
        ${unclassifiedItems.map((n) => evidenceItemHtml(n, null, null, unclassifiedReasons[n] ?? null)).join("")}
      </ul>
    </div>
  `;
  const toggleBtn = unclassifiedSection.querySelector(".evidence-toggle");
  const evidenceList = unclassifiedSection.querySelector(".evidence-list");
  wireEvidenceReassignment(evidenceList, null);
  toggleBtn.addEventListener("click", () => {
    const isHidden = evidenceList.classList.toggle("hidden");
    if (isHidden) expandedEvidencePanels.delete("unclassified");
    else expandedEvidencePanels.add("unclassified");
  });
}

// A PM should be able to name a theme the AI didn't come up with, not just
// pick between what it discovered and Unclassified. Starts empty (frequency
// 0) - reassign items into it from any theme's evidence list, or from
// Unclassified, the same way an AI-discovered theme's items get moved.
addThemeBtn.addEventListener("click", () => {
  const name = prompt("Name this theme:");
  if (!name || !name.trim()) return;

  const newTheme = {
    theme_id: `manual-${Date.now()}`,
    theme: name.trim(),
    definition: "Manually created by PM - not an AI-discovered theme.",
    severity: 3,
    severity_reasoning: "No AI severity estimate for a manually created theme - based purely on whatever items you move into it.",
    frequency: 0,
    supporting_item_numbers: [],
    item_fit: {},
    keywords: [],
    example_quotes: [],
  };
  clusteredThemes.push(newTheme);
  renderThemes();
  setStatus(`Created theme "${newTheme.theme}". Move items into it from any theme's evidence list, or from Unclassified.`);
});

prioritizeBtn.addEventListener("click", () => runPrioritize());

async function runPrioritize() {
  if (prioritizeBtn.disabled) return false; // see the matching guard in runAnalysis()
  summaryStage.hidden = true;
  prdStage.hidden = true;
  exportStage.hidden = true;
  lastPrdMarkdown = "";
  lastPrdTheme = null;

  setLoading(prioritizeBtn, true);
  setStatus("Estimating impact...");
  try {
    const data = await postJSON("/api/prioritize", { themes: clusteredThemes });
    rankedThemes = data.themes;
    renderPriorityTable();
    priorityStage.hidden = false;
    priorityStage.scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus("Themes ranked by priority score (Impact × Severity). Edit Impact to override the AI's estimate - the score recalculates instantly.");
    return true;
  } catch (err) {
    setStatus(err.message, true);
    return false;
  } finally {
    setLoading(prioritizeBtn, false);
  }
}

// --- Stage 3: Prioritization table ---

function recomputePriority(theme) {
  theme.priority_score = Number((theme.impact * theme.severity).toFixed(2));
}

// Renders the one editable field (Impact) as a table cell: the input itself,
// plus - only once a PM has actually changed it away from the AI's original
// estimate - a small highlighted "AI: <original>" note with a one-click
// reset. This is what makes an override visually obvious rather than a
// silent edit indistinguishable from the AI's own number.
function riceFieldCell(t, field, inputHtml) {
  const overridden = t[field] !== t.ai_estimate[field];
  return `
    <td class="rice-cell ${overridden ? "overridden" : ""}">
      ${inputHtml}
      ${
        overridden
          ? `<div class="ai-original">AI: ${t.ai_estimate[field]}
               <button type="button" class="reset-btn" data-field="${field}" title="Reset to AI estimate">&#8634;</button>
             </div>`
          : ""
      }
    </td>
  `;
}

function renderPriorityTable() {
  rankedThemes.sort((a, b) => b.priority_score - a.priority_score);
  priorityTableBody.innerHTML = "";

  rankedThemes.forEach((t, index) => {
    const row = document.createElement("tr");
    row.className = index === 0 ? "rank-1" : "";
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${escapeHtml(t.theme)}</td>
      <td class="frequency-cell" title="Fact from your feedback sample">${t.frequency}</td>
      <td class="severity-cell" title="Set during clustering - see the theme card">${t.severity}/5</td>
      ${riceFieldCell(
        t,
        "impact",
        `<select class="rice-input" data-field="impact">
          ${[1, 2, 3, 4, 5]
            .map((v) => `<option value="${v}" ${t.impact === v ? "selected" : ""}>${v}</option>`)
            .join("")}
        </select>`,
      )}
      <td class="rice-score">${t.priority_score}</td>
      <td class="no-print"><button class="reasoning-toggle" type="button">Details</button></td>
    `;

    const reasoningRow = document.createElement("tr");
    reasoningRow.className = "reasoning-row hidden";
    reasoningRow.innerHTML = `
      <td></td>
      <td colspan="6">
        <div class="reasoning-grid">
          <div><strong>Frequency</strong> — a count of feedback items, computed directly from the themes returned by clustering, not an AI judgment call.</div>
          <div><strong>Severity — why?</strong> ${escapeHtml(t.severity_reasoning ?? "")}</div>
          <div><strong>Impact — why?</strong> ${escapeHtml(t.impact_reasoning)}</div>
        </div>
      </td>
    `;

    row.querySelector(".reasoning-toggle").addEventListener("click", () => {
      reasoningRow.classList.toggle("hidden");
    });

    row.querySelectorAll("[data-field].rice-input").forEach((input) => {
      input.addEventListener("change", () => {
        const field = input.dataset.field;
        t[field] = Number(input.value);
        recomputePriority(t);
        renderPriorityTable(); // re-sort + re-render so rank/highlight/override state stay correct
      });
    });

    row.querySelectorAll(".reset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const field = btn.dataset.field;
        t[field] = t.ai_estimate[field];
        recomputePriority(t);
        renderPriorityTable();
      });
    });

    priorityTableBody.appendChild(row);
    priorityTableBody.appendChild(reasoningRow);
  });

  // Keep the roadmap summary in sync if the PM edits the priority table after
  // it's already been generated once, so the recommendation, its explanation, and
  // its sensitivity analysis never go stale relative to the current inputs.
  if (!summaryStage.hidden) {
    renderRoadmapSummary();
  }
  scheduleSave();
}

const summaryBtn = $("summaryBtn");
summaryBtn.addEventListener("click", () => showSummary());

function showSummary() {
  renderRoadmapSummary();
  summaryStage.hidden = false;
  summaryStage.scrollIntoView({ behavior: "smooth", block: "start" });
}

// --- Stage 4: Roadmap Summary ---

// Ranks a value against the full set of theme values on that same field and
// Both factors are fixed 1-5 scales (not sample-relative like the old
// Reach/Effort were), so labels use the same absolute thresholds the
// severity badges already use elsewhere, rather than a second bucketing
// scheme a reader would have to learn.
function scoreLabel(n) {
  if (n >= 4) return "High";
  if (n <= 2) return "Low";
  return "Moderate";
}

// Builds the #1 theme's ranking explanation entirely from numbers already on
// screen - no LLM call.
function computeRankingExplanation(theme) {
  const impactLbl = scoreLabel(theme.impact);
  const severityLbl = scoreLabel(theme.severity);

  const sentence = `"${theme.theme}" ranked highest because it combines ${impactLbl.toLowerCase()} impact with ${severityLbl.toLowerCase()} severity.`;

  return {
    sentence,
    factors: [
      { label: "Impact", value: impactLbl },
      { label: "Severity", value: severityLbl },
    ],
  };
}

// Computes, purely algebraically (no AI call), the Impact threshold at which
// the #1 theme would be tied with the #2 theme - priority_score = impact *
// severity, and severity isn't PM-editable here (it's set during
// clustering), so Impact is the only lever that can actually move. Solving
// impact * top.severity = second.priority_score for impact gives the exact
// threshold.
function computeSensitivity(top, second) {
  if (!second) return null;
  const result = { comparedTo: second.theme, lines: [] };
  if (top.severity > 0) {
    const impactThreshold = Math.floor(second.priority_score / top.severity);
    if (impactThreshold >= 1 && impactThreshold < top.impact) {
      result.lines.push(`Impact drops to ${impactThreshold} or below`);
    }
  }
  return result;
}

function decisionControlHtml(t) {
  const buttons = DECISIONS.map((d) => {
    const active = t.decision === d;
    return `<button type="button" class="decision-btn decision-btn-${d.toLowerCase()}${active ? " active" : ""}" data-decision="${d}" title="${escapeHtml(DECISION_INFO[d])}">${d}</button>`;
  }).join("");
  return `
    <div class="decision-buttons" role="group" aria-label="Decision">${buttons}</div>
    <p class="decision-hint">${escapeHtml(t.decision ? DECISION_INFO[t.decision] : DECISION_HINT_DEFAULT)}</p>
    <span class="decision-print-only">${t.decision ? escapeHtml(t.decision) : "not yet decided"}</span>
  `;
}

function renderRoadmapSummary() {
  const top3 = rankedThemes.slice(0, 3);
  summaryList.innerHTML = "";

  top3.forEach((t, i) => {
    const card = document.createElement("div");
    card.className = `summary-card${i === 0 ? " recommended" : ""}`;

    let extra = "";
    if (i === 0) {
      const explanation = computeRankingExplanation(t);
      const sensitivity = computeSensitivity(t, rankedThemes[1]);

      extra += `
        <div class="why-panel">
          <strong>Why this is #1</strong>
          <p>${escapeHtml(explanation.sentence)}</p>
          <div class="factor-row">
            ${explanation.factors.map((f) => `<span class="factor-badge">${f.value} ${f.label}</span>`).join("")}
          </div>
        </div>
      `;

      extra += `<div class="sensitivity-panel"><strong>Decision sensitivity</strong>`;
      if (!sensitivity) {
        extra += `<p class="hint">Only one theme was ranked - nothing else to overtake it.</p>`;
      } else if (sensitivity.lines.length === 0) {
        extra += `<p class="hint">This ranking is not sensitive to a single-factor change within valid ranges relative to "${escapeHtml(sensitivity.comparedTo)}" (#2).</p>`;
      } else {
        extra += `
          <p class="hint">This initiative remains #1 unless, relative to "${escapeHtml(sensitivity.comparedTo)}" (#2):</p>
          <ul>${sensitivity.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>
        `;
      }
      extra += `</div>`;
    }

    card.innerHTML = `
      ${i === 0 ? '<div class="recommended-badge">Recommended next initiative</div>' : ""}
      <h3>${i + 1}. ${escapeHtml(t.theme)}</h3>
      <p class="summary-meta">
        ${t.frequency} feedback item${t.frequency === 1 ? "" : "s"} &bull; Severity ${t.severity}/5 &bull; Priority ${t.priority_score}
      </p>
      <p class="hint">${escapeHtml(t.definition)}</p>
      ${extra}
      <div class="decision-row">
        <span class="decision-label">Decision</span>
        ${decisionControlHtml(t)}
      </div>
      <button type="button" class="btn btn-primary generate-prd-btn">Generate PRD</button>
    `;

    // Clicking the already-active decision clears it back to undecided -
    // re-rendering (rather than patching classes/text in place) keeps this
    // in sync with the button group, the hint line, and the print-only
    // fallback in one place instead of updating each by hand.
    card.querySelectorAll(".decision-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.dataset.decision;
        t.decision = t.decision === value ? null : value;
        renderRoadmapSummary();
      });
    });

    card.querySelector(".generate-prd-btn").addEventListener("click", (e) => {
      generatePRDFor(t, e.target);
    });

    summaryList.appendChild(card);
  });
  scheduleSave();
}

// --- Stage 5: PRD ---

async function generatePRDFor(theme, triggerBtn) {
  const originalLabel = triggerBtn.textContent;
  triggerBtn.disabled = true;
  triggerBtn.textContent = "Working...";
  setStatus(`Drafting PRD for "${theme.theme}"...`);
  try {
    const data = await postJSON("/api/prd", { theme });
    lastPrdMarkdown = data.prd;
    lastPrdTheme = theme;
    prdContent.innerHTML = marked.parse(data.prd);

    if (theme.decision) {
      prdDecisionBadge.hidden = false;
      prdDecisionBadge.textContent = `Decision: ${theme.decision}`;
      prdDecisionBadge.className = `decision-badge decision-${theme.decision.toLowerCase()}`;
    } else {
      prdDecisionBadge.hidden = true;
    }

    prdStage.hidden = false;
    exportStage.hidden = false;
    prdStage.scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus("PRD generated. Use the Export section below for a presentable copy.");
    scheduleSave();
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    triggerBtn.disabled = false;
    triggerBtn.textContent = originalLabel;
  }
}

// --- Stage 6: Export ---

printExportBtn.addEventListener("click", () => window.print());

async function copyToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`${label} copied to clipboard.`);
  } catch (err) {
    setStatus(`Could not copy ${label.toLowerCase()} - your browser may be blocking clipboard access.`, true);
  }
}

copyPrdBtn.addEventListener("click", () => {
  if (!lastPrdMarkdown) return;
  const decisionLine = lastPrdTheme?.decision ? `\n\nDecision: ${lastPrdTheme.decision}` : "";
  copyToClipboard(lastPrdMarkdown + decisionLine, "PRD");
});

copySummaryBtn.addEventListener("click", () => {
  if (rankedThemes.length === 0) return;
  const top3 = rankedThemes.slice(0, 3);
  const lines = ["ROADMAP RECOMMENDATION", ""];
  top3.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.theme}`);
    lines.push(`   Priority: ${t.priority_score} • Severity ${t.severity}/5 • ${t.frequency} feedback item${t.frequency === 1 ? "" : "s"}`);
    lines.push(`   Decision: ${t.decision || "not yet decided"}`);
    lines.push("");
  });
  copyToClipboard(lines.join("\n").trim(), "Roadmap summary");
});

// --- Utilities ---

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// A one-click way to see the whole pipeline (Analyze -> Prioritize ->
// Roadmap Summary) run on the bundled sample dataset instead of hunting for
// real feedback to paste in first. Deliberately opt-in (a button, not
// something that fires on load) - stops at the Roadmap Summary (the fullest
// single view of what this tool does); PRD/Export stay for the visitor to
// trigger themselves once they're exploring on their own terms. The wording
// below depends on isMockMode because the result genuinely differs: in mock
// mode this is canned data, but with a real GROQ_API_KEY configured (the
// default now) it's a real live analysis - just of the sample dataset
// instead of whatever the visitor would have typed themselves.
async function runDemo() {
  if (demoBtn.disabled) return; // already running
  setLoading(demoBtn, true);
  setStatus(
    isMockMode
      ? "Running a demo on sample feedback data - canned results, not live Groq output."
      : "Running the demo on sample feedback data - real live analysis, just using the bundled sample instead of your own feedback.",
  );
  try {
    // In live mode runAnalysis() only forces sample data for isMockMode - it
    // has no reason to otherwise overwrite whatever a visitor may have typed
    // in the box. The demo's whole point is running sample data specifically,
    // so load it into the textarea itself before analyzing - the smaller
    // demo-feedback.txt, not sample-feedback.txt (that one's full 52 items
    // measured 100+ seconds for a live analysis; irrelevant in mock mode,
    // where runAnalysis() below unconditionally reloads the full file anyway).
    if (!(await loadSampleData("/demo-feedback.txt"))) return;
    if (!(await runAnalysis())) return;
    if (!(await runPrioritize())) return;
    showSummary();
    setStatus(
      isMockMode
        ? "This demo used canned sample results, not live Groq output. Paste your own feedback and click Analyze for the real thing."
        : "This demo ran on the bundled sample dataset, not your own feedback - paste your own above and click Analyze to try it for real.",
    );
  } finally {
    setLoading(demoBtn, false);
  }
}
demoBtn.addEventListener("click", () => runDemo());

(async function showModeBanner() {
  try {
    const res = await fetch("/api/status");
    const { mockMode, sharingEnabled } = await res.json();
    isMockMode = mockMode;
    if (mockMode) {
      modeBanner.hidden = false;
      modeBanner.textContent = "Demo mode: this is a test run on sample data, not live Groq output.";
    }
    if (!sharingEnabled) {
      shareBtn.disabled = true;
      shareBtn.title = "Sharing isn't configured on this server (needs DATABASE_URL) - see the README.";
    }
  } catch (_) {
    /* server not reachable yet on first paint - ignore */
  }
})();

// Keep navigation aligned with the stages available in this analysis.
const stepButtons = [...document.querySelectorAll(".step")];
function activateStep(id) {
  stepButtons.forEach(button => {
    const active = button.dataset.stage === id;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
}
stepButtons.forEach(button => button.addEventListener("click", () => {
  const stage = $(button.dataset.stage);
  if (!stage.hidden) {
    activateStep(stage.id);
    stage.scrollIntoView({ behavior: "smooth", block: "start" });
    stage.focus({ preventScroll: true });
  }
}));
const stageObserver = new MutationObserver(records => {
  stepButtons.forEach(button => { button.disabled = $(button.dataset.stage).hidden; });
  const opened = records.filter(record => !record.target.hidden).at(-1);
  if (opened) activateStep(opened.target.id);
  else if (stepButtons.some(button => button.disabled && button.classList.contains("active"))) activateStep("inputStage");
});
stepButtons.forEach(button => {
  const stage = $(button.dataset.stage);
  stage.tabIndex = -1;
  stageObserver.observe(stage, { attributes: true, attributeFilter: ["hidden"] });
});
const visibleStages = new IntersectionObserver(entries => {
  const visible = entries.filter(entry => entry.isIntersecting && !entry.target.hidden);
  if (visible.length) activateStep(visible[0].target.id);
}, { rootMargin: "-15% 0px -55% 0px" });
stepButtons.forEach(button => visibleStages.observe($(button.dataset.stage)));
function updateFeedbackCount() {
  $("feedbackCount").textContent = `${feedbackInput.value.length.toLocaleString()} characters`;
}
feedbackInput.addEventListener("input", updateFeedbackCount);

// --- Reset ---

// Clears every in-memory stage so a PM can start a new analysis without a
// page refresh (which would also lose the theme toggle's read of localStorage
// mid-load and re-trigger the mode-banner fetch for no reason). Hiding each
// downstream stage - rather than removing it - is enough: the MutationObserver
// wired up above (stageObserver) already reacts to a stage's `hidden` flag
// flipping by disabling its nav button and, once the active step is disabled,
// falling back to "Feedback" - so step nav state doesn't need to be touched here.
resetBtn.addEventListener("click", () => {
  const hasProgress = clusteredThemes.length > 0 || feedbackInput.value.trim().length > 0;
  if (hasProgress && !confirm("Reset and start over? This clears the current analysis, priority edits, and any generated PRD.")) {
    return;
  }

  clusteredThemes = [];
  unclassifiedItems = [];
  unclassifiedReasons = {};
  rankedThemes = [];
  feedbackItems = [];
  lastPrdMarkdown = "";
  lastPrdTheme = null;
  currentProjectId = null; // detach from any shared link - starting over shouldn't overwrite it with an empty project
  clearTimeout(saveTimer);
  if (location.pathname !== "/") history.replaceState(null, "", "/");

  feedbackInput.value = "";
  fileInput.value = "";
  updateFeedbackCount();

  themesList.innerHTML = "";
  unclassifiedSection.innerHTML = "";
  priorityTableBody.innerHTML = "";
  summaryList.innerHTML = "";
  prdContent.innerHTML = "";
  prdDecisionBadge.hidden = true;

  themesStage.hidden = true;
  priorityStage.hidden = true;
  summaryStage.hidden = true;
  prdStage.hidden = true;
  exportStage.hidden = true;

  setStatus(null);
  $("inputStage").scrollIntoView({ behavior: "smooth", block: "start" });
  feedbackInput.focus();
});

// --- Sharing ---

// Everything needed to reconstruct the workspace on another machine. Decisions
// live on the theme objects themselves (t.decision, set by the decision
// buttons in renderRoadmapSummary), so they're already captured via
// rankedThemes without a separate field.
function snapshotState() {
  return {
    feedbackInputValue: feedbackInput.value,
    clusteredThemes,
    unclassifiedItems,
    unclassifiedReasons,
    rankedThemes,
    feedbackItems,
    lastPrdMarkdown,
    lastPrdThemeId: lastPrdTheme ? lastPrdTheme.theme_id : null,
    visibleStages: {
      themes: !themesStage.hidden,
      priority: !priorityStage.hidden,
      summary: !summaryStage.hidden,
      prd: !prdStage.hidden,
      exportS: !exportStage.hidden,
    },
  };
}

// Rebuilds the whole workspace from a saved snapshot by re-running the same
// render functions every other stage transition already uses, rather than
// hand-writing a second copy of that rendering logic here.
function restoreState(data) {
  hydrating = true;

  feedbackInput.value = data.feedbackInputValue || "";
  updateFeedbackCount();

  clusteredThemes = data.clusteredThemes || [];
  unclassifiedItems = data.unclassifiedItems || [];
  unclassifiedReasons = data.unclassifiedReasons || {};
  rankedThemes = data.rankedThemes || [];
  feedbackItems = data.feedbackItems || [];
  lastPrdMarkdown = data.lastPrdMarkdown || "";
  lastPrdTheme = data.lastPrdThemeId ? rankedThemes.find((t) => t.theme_id === data.lastPrdThemeId) : null;

  const stages = data.visibleStages || {};

  if (clusteredThemes.length) {
    renderThemes();
    themesStage.hidden = !stages.themes;
  }
  if (rankedThemes.length) {
    renderPriorityTable();
    priorityStage.hidden = !stages.priority;
  }
  if (stages.summary && rankedThemes.length) {
    summaryStage.hidden = false;
    renderRoadmapSummary();
  }
  if (stages.prd && lastPrdMarkdown) {
    prdContent.innerHTML = marked.parse(lastPrdMarkdown);
    if (lastPrdTheme?.decision) {
      prdDecisionBadge.hidden = false;
      prdDecisionBadge.textContent = `Decision: ${lastPrdTheme.decision}`;
      prdDecisionBadge.className = `decision-badge decision-${lastPrdTheme.decision.toLowerCase()}`;
    } else {
      prdDecisionBadge.hidden = true;
    }
    prdStage.hidden = false;
  }
  exportStage.hidden = !stages.exportS;

  hydrating = false;
}

async function saveNow() {
  const res = await fetch(`/api/projects/${currentProjectId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: snapshotState() }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Autosave failed (${res.status})`);
  }
}

// Called from every render function below once a project has a shareable
// link, so edits (priority overrides, reassignments, decisions, a new PRD) reach
// anyone else with the link without the PM having to click Share again. A
// failed background save is swallowed - the next edit's save will retry - so
// a flaky connection doesn't interrupt anyone's work with an error popup.
function scheduleSave() {
  if (!currentProjectId || hydrating) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveNow().catch(() => {});
  }, 800);
}

shareBtn.addEventListener("click", async () => {
  if (!clusteredThemes.length) {
    setStatus("Analyze some feedback first, then share the link.", true);
    return;
  }
  setLoading(shareBtn, true);
  try {
    if (!currentProjectId) {
      const res = await postJSON("/api/projects", { data: snapshotState() });
      currentProjectId = res.id;
      history.replaceState(null, "", `/p/${currentProjectId}`);
    } else {
      clearTimeout(saveTimer);
      await saveNow();
    }
    await copyToClipboard(`${location.origin}/p/${currentProjectId}`, "Share link");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setLoading(shareBtn, false, "Share");
  }
});

// Loading /p/abc123 directly (server routes it to this same index.html - see
// server/index.js) hydrates the workspace from whatever was last saved there,
// instead of starting from an empty Stage 1.
(async function hydrateFromShareLink() {
  const match = location.pathname.match(/^\/p\/([A-Za-z0-9_-]+)$/);
  if (!match) return;
  currentProjectId = match[1];
  try {
    const res = await fetch(`/api/projects/${currentProjectId}`);
    const body = await res.json();
    if (!res.ok) {
      setStatus(body.error || "Could not load this shared project.", true);
      currentProjectId = null;
      return;
    }
    restoreState(body.data);
    setStatus("Loaded shared project - your edits here save back to this same link.");
  } catch (err) {
    setStatus("Could not load this shared project.", true);
    currentProjectId = null;
  }
})();
