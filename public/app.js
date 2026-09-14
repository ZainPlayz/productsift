// All state lives in memory for the session only - no backend persistence,
// matching the "no database needed for v1" scope. Refreshing the page loses it.
let clusteredThemes = []; // each carries supporting_item_numbers/frequency/item_fit, kept live-mutated as the PM reassigns items
let unclassifiedItems = []; // item numbers with no theme assigned - a real, expected state, not an error
let unclassifiedReasons = {}; // item_number -> { type: "ambiguous"|"validation_failed"|"no_match"|"manual", detail }
let rankedThemes = [];
let feedbackItems = []; // numbered (1-based) split of the submitted feedback, from /api/cluster
let lastPrdMarkdown = ""; // raw markdown of the most recently generated PRD, for "Copy PRD"
let lastPrdTheme = null; // the theme that PRD was generated for, for the decision badge

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
const analyzeBtn = $("analyzeBtn");
const themesStage = $("themesStage");
const themesList = $("themesList");
const unclassifiedSection = $("unclassifiedSection");
const prioritizeBtn = $("prioritizeBtn");
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

sampleBtn.addEventListener("click", async () => {
  try {
    const res = await fetch("/sample-feedback.txt");
    feedbackInput.value = await res.text();
    updateFeedbackCount();
  } catch (err) {
    setStatus("Could not load sample-feedback.txt", true);
  }
});

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

analyzeBtn.addEventListener("click", async () => {
  const feedback = feedbackInput.value.trim();
  if (!feedback) {
    setStatus("Paste some feedback first, or click 'Load Sample Data'.", true);
    return;
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
  } catch (err) {
    stopCycle();
    setStatus(err.message, true);
  } finally {
    setLoading(analyzeBtn, false);
  }
});

// --- Stage 2: Themes ---

// Evidence for every theme is owned by this state, not re-fetched: each
// theme's supporting_item_numbers/frequency/item_fit came from the server's
// three-call pipeline (discover -> classify -> validate, gated in code - see
// cluster.js), and stay mutated in place here as the PM reassigns an item -
// the same "edit in place, full re-render" pattern the RICE table already
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
      (!priorityStage.hidden ? " Re-run 'Prioritize with RICE' to reflect the updated frequency." : ""),
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

function renderThemes() {
  themesList.innerHTML = "";
  clusteredThemes.forEach((t) => {
    const moderateCount = Object.values(t.item_fit).filter((f) => f.bucket === "moderate").length;
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
      <button type="button" class="evidence-toggle">${t.frequency === 0 ? "No" : "View"} supporting feedback &middot; ${t.frequency}</button>
      <ul class="evidence-list hidden">
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
  unclassifiedSection.innerHTML = `
    <div class="unclassified-card">
      <button type="button" class="evidence-toggle">${unclassifiedItems.length} feedback item${unclassifiedItems.length === 1 ? "" : "s"} weren't assigned to a theme</button>
      <ul class="evidence-list hidden">
        ${unclassifiedItems.map((n) => evidenceItemHtml(n, null, null, unclassifiedReasons[n] ?? null)).join("")}
      </ul>
    </div>
  `;
  const toggleBtn = unclassifiedSection.querySelector(".evidence-toggle");
  const evidenceList = unclassifiedSection.querySelector(".evidence-list");
  wireEvidenceReassignment(evidenceList, null);
  toggleBtn.addEventListener("click", () => {
    evidenceList.classList.toggle("hidden");
  });
}

prioritizeBtn.addEventListener("click", async () => {
  summaryStage.hidden = true;
  prdStage.hidden = true;
  exportStage.hidden = true;
  lastPrdMarkdown = "";
  lastPrdTheme = null;

  setLoading(prioritizeBtn, true);
  setStatus("Scoring themes with RICE...");
  try {
    const data = await postJSON("/api/prioritize", { themes: clusteredThemes });
    rankedThemes = data.themes;
    renderPriorityTable();
    priorityStage.hidden = false;
    priorityStage.scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus("Themes ranked by RICE score. Edit any input to override the AI's estimate - the score recalculates instantly.");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    setLoading(prioritizeBtn, false);
  }
});

// --- Stage 3: Prioritization table (RICE) ---

function recomputeRice(theme) {
  theme.rice_score = Number(
    ((theme.reach * theme.impact * (theme.confidence / 100)) / theme.effort).toFixed(2),
  );
}

function formatRiceValue(field, value) {
  if (field === "confidence") return `${value}%`;
  if (field === "effort") return `${value} wks`;
  if (field === "reach") return Number(value).toLocaleString();
  return String(value);
}

// Renders one editable RICE field as a table cell: the input itself, plus -
// only once a PM has actually changed the value away from what the AI first
// estimated - a small highlighted "AI: <original>" note with a one-click
// reset. This is what makes an override visually obvious rather than a
// silent edit indistinguishable from the AI's own number.
function riceFieldCell(t, field, inputHtml) {
  const overridden = t[field] !== t.ai_estimate[field];
  return `
    <td class="rice-cell ${overridden ? "overridden" : ""}">
      ${inputHtml}
      ${
        overridden
          ? `<div class="ai-original">AI: ${formatRiceValue(field, t.ai_estimate[field])}
               <button type="button" class="reset-btn" data-field="${field}" title="Reset to AI estimate">&#8634;</button>
             </div>`
          : ""
      }
    </td>
  `;
}

function renderPriorityTable() {
  rankedThemes.sort((a, b) => b.rice_score - a.rice_score);
  priorityTableBody.innerHTML = "";

  rankedThemes.forEach((t, index) => {
    const row = document.createElement("tr");
    row.className = index === 0 ? "rank-1" : "";
    row.innerHTML = `
      <td>${index + 1}</td>
      <td>${escapeHtml(t.theme)}</td>
      <td class="frequency-cell" title="Fact from your feedback sample - not editable, not the same as Reach">${t.frequency}</td>
      ${riceFieldCell(t, "reach", `<input class="rice-input" type="number" min="0" step="1" data-field="reach" value="${t.reach}" />`)}
      ${riceFieldCell(
        t,
        "impact",
        `<select class="rice-input" data-field="impact">
          ${[0.25, 0.5, 1, 2, 3]
            .map((v) => `<option value="${v}" ${t.impact === v ? "selected" : ""}>${v}</option>`)
            .join("")}
        </select>`,
      )}
      ${riceFieldCell(t, "confidence", `<input class="rice-input" type="number" min="0" max="100" step="1" data-field="confidence" value="${t.confidence}" />`)}
      ${riceFieldCell(t, "effort", `<input class="rice-input" type="number" min="0.25" step="0.25" data-field="effort" value="${t.effort}" />`)}
      <td class="rice-score">${t.rice_score}</td>
      <td class="no-print"><button class="reasoning-toggle" type="button">Details</button></td>
    `;

    const reasoningRow = document.createElement("tr");
    reasoningRow.className = "reasoning-row hidden";
    reasoningRow.innerHTML = `
      <td></td>
      <td colspan="8">
        <div class="reasoning-grid">
          <div><strong>Frequency</strong> — a count of feedback items, computed directly from the themes returned by clustering, not an AI judgment call.</div>
          <div><strong>Reach — why?</strong> ${escapeHtml(t.reach_reasoning)}</div>
          <div><strong>Impact — why?</strong> ${escapeHtml(t.impact_reasoning)}</div>
          <div><strong>Confidence — why?</strong> ${escapeHtml(t.confidence_reasoning)}</div>
          <div><strong>Effort — why?</strong> ${escapeHtml(t.effort_reasoning)}</div>
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
        recomputeRice(t);
        renderPriorityTable(); // re-sort + re-render so rank/highlight/override state stay correct
      });
    });

    row.querySelectorAll(".reset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const field = btn.dataset.field;
        t[field] = t.ai_estimate[field];
        recomputeRice(t);
        renderPriorityTable();
      });
    });

    priorityTableBody.appendChild(row);
    priorityTableBody.appendChild(reasoningRow);
  });

  // Keep the roadmap summary in sync if the PM edits RICE inputs after it's
  // already been generated once, so the recommendation, its explanation, and
  // its sensitivity analysis never go stale relative to the current inputs.
  if (!summaryStage.hidden) {
    renderRoadmapSummary();
  }
  scheduleSave();
}

const summaryBtn = $("summaryBtn");
summaryBtn.addEventListener("click", () => {
  renderRoadmapSummary();
  summaryStage.hidden = false;
  summaryStage.scrollIntoView({ behavior: "smooth", block: "start" });
});

// --- Stage 4: Roadmap Summary ---

// Ranks a value against the full set of theme values on that same field and
// buckets it Low/Moderate/High - relative to THIS dataset, not an arbitrary
// fixed cutoff, since "high reach" means something different for a 5-theme
// batch than a 30-theme one. Ties share the average rank so identical values
// always get the same label.
function percentileOf(value, allValues) {
  if (allValues.length <= 1) return 50;
  const sorted = [...allValues].sort((a, b) => a - b);
  const n = sorted.length;
  const first = sorted.indexOf(value);
  let last = first;
  while (last + 1 < n && sorted[last + 1] === value) last++;
  return (((first + last) / 2) / (n - 1)) * 100;
}

function bucketLabel(percentile) {
  if (percentile >= 66) return "High";
  if (percentile <= 33) return "Low";
  return "Moderate";
}

function impactLabel(impact) {
  if (impact >= 2) return "High";
  if (impact <= 0.5) return "Low";
  return "Moderate";
}

function confidenceLabel(confidence) {
  if (confidence >= 75) return "High";
  if (confidence < 50) return "Low";
  return "Moderate";
}

// Builds the #1 theme's ranking explanation entirely from numbers already on
// screen - no LLM call. Labels are relative to the current theme set (reach,
// effort) or fixed PM-standard bands (impact, confidence), never invented.
function computeRankingExplanation(theme, allThemes) {
  const reachLbl = bucketLabel(percentileOf(theme.reach, allThemes.map((t) => t.reach)));
  const impactLbl = impactLabel(theme.impact);
  const confLbl = confidenceLabel(theme.confidence);
  const effortLbl = bucketLabel(percentileOf(theme.effort, allThemes.map((t) => t.effort)));

  const sentence = `"${theme.theme}" ranked highest because it combines ${reachLbl.toLowerCase()} reach, ${impactLbl.toLowerCase()} impact, and ${confLbl.toLowerCase()} confidence relative to its ${effortLbl.toLowerCase()} estimated effort.`;

  return {
    sentence,
    factors: [
      { label: "Reach", value: reachLbl },
      { label: "Impact", value: impactLbl },
      { label: "Confidence", value: confLbl },
      { label: "Effort", value: effortLbl },
    ],
  };
}

// Computes, purely algebraically (no AI call), the single-factor thresholds
// at which the #1 theme would be tied with the #2 theme, holding the other
// two RICE inputs fixed - e.g. rice_score = reach*impact*confidence/100/effort,
// so solving for the reach that ties top's score to second's score is just
// rearranging that equation. Each threshold is independent of the others
// (this is "what if only THIS changed", not a joint sensitivity analysis).
function computeSensitivity(top, second) {
  if (!second) return null;
  const targetScore = second.rice_score;
  const result = { comparedTo: second.theme, lines: [] };

  if (targetScore > 0) {
    const effortThreshold = Math.round(((top.reach * top.impact * (top.confidence / 100)) / targetScore) * 10) / 10;
    if (effortThreshold > top.effort) {
      result.lines.push(`Estimated effort increases above ${effortThreshold} weeks`);
    }
  }

  const impactConf = top.impact * (top.confidence / 100);
  if (impactConf > 0) {
    const reachThreshold = Math.round((targetScore * top.effort) / impactConf);
    if (reachThreshold >= 0 && reachThreshold < top.reach) {
      result.lines.push(`Reach estimate falls below ${reachThreshold.toLocaleString()} users`);
    }
  }

  const reachImpact = top.reach * top.impact;
  if (reachImpact > 0) {
    const confidenceThreshold = Math.round(((targetScore * top.effort) / reachImpact) * 100);
    if (confidenceThreshold >= 0 && confidenceThreshold < top.confidence && confidenceThreshold <= 100) {
      result.lines.push(`Confidence falls below ${confidenceThreshold}%`);
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
      const explanation = computeRankingExplanation(t, rankedThemes);
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
        ${t.frequency} feedback item${t.frequency === 1 ? "" : "s"} &bull; Severity ${t.severity}/5 &bull; RICE ${t.rice_score}
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
    lines.push(`   RICE: ${t.rice_score} • Severity ${t.severity}/5 • ${t.frequency} feedback item${t.frequency === 1 ? "" : "s"}`);
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

(async function showModeBanner() {
  try {
    const res = await fetch("/api/status");
    const { mockMode, sharingEnabled } = await res.json();
    if (mockMode) {
      modeBanner.hidden = false;
      modeBanner.textContent = "Demo mode: showing sample results, not live Groq output.";
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
  if (hasProgress && !confirm("Reset and start over? This clears the current analysis, RICE edits, and any generated PRD.")) {
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
// link, so edits (RICE overrides, reassignments, decisions, a new PRD) reach
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
