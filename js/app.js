/* =========================================================
   FAST Regional Ops KPI Dashboard — app logic
   Vanilla JS + Chart.js. Tries to pull live from each
   principal's published Google Sheet CSV (data/sheets-config.json);
   falls back to the bundled data/sales-data.json if no sources
   are configured or a fetch fails.
========================================================= */

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const BRAND = { blue: "#0057A0", blueDark: "#003D73", red: "#D62828", gray: "#9AA7B4" };
const STATIC_DATA_URL = "data/sales-data.json";
const SHEETS_CONFIG_URL = "data/sheets-config.json";

const REQUIRED_CSV_COLUMNS = [
  "Branch/Site", "Principal/Supplier", "Channel", "Category",
  "Month", "Year", "Target Sales", "Actual Sales",
];

const state = {
  raw: [],
  source: "sample",     // "live" | "sample"
  sourceErrors: [],
  principals: new Set(), // multi-select; empty = "All"
  branches: new Set(),   // multi-select; empty = "All"
  periods: new Set(),    // Set of "<year>-<monthIndex>", multi-select; never empty once data loads
  channels: new Set(),   // multi-select; empty = "All"
  categories: new Set(), // multi-select; empty = "All" (unchanged UI — chip toggles)
};

let trendChart, yoyChart;
let principalPieChart, branchPieChart;
let toplineCharts = {};
let dimensionCharts = {};

const cssId = (s) => String(s).replace(/[^a-zA-Z0-9]/g, "_");
const PIE_COLORS = ["#0057A0", "#D62828", "#1C7CC7", "#F0A202", "#6C4AB6", "#2E8B57", "#9AA7B4", "#003D73"];

const $ = (sel) => document.querySelector(sel);
const fmtPeso = (n) => "₱" + Math.round(n).toLocaleString("en-PH");
const fmtCompact = (n) => "₱" + new Intl.NumberFormat("en-PH", { notation: "compact", maximumFractionDigits: 1 }).format(n);
const fmtMillions = (n) => "₱" + (n / 1_000_000).toFixed(1) + "M";
const sortKey = (r) => r.year * 100 + MONTHS.indexOf(r.month);

/* ---------------- CSV parsing (RFC4180-ish) ---------------- */

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && next === "\n") i++;
        row.push(field); field = "";
        if (row.some((v) => v !== "")) rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];

  // dedupe/clean header row: drop blanks, keep first occurrence of duplicates
  const rawHeader = rows[0].map((h) => h.trim());
  const seen = new Set();
  const header = []; // [{ index, name }]
  rawHeader.forEach((name, index) => {
    if (!name || seen.has(name)) return;
    seen.add(name);
    header.push({ index, name });
  });

  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach(({ index, name }) => { obj[name] = (r[index] ?? "").trim(); });
    return obj;
  });
}

// internal field names that are part of the core schema — anything else
// found in a CSV/sheet is treated as an auto-detected extra dimension
// (Salesman, Area, Supervisor, etc.)
const KNOWN_FIELDS = new Set(["branch", "principal", "channel", "category", "month", "year", "target", "actual", "achievement"]);

function csvRowsToData(csvRows, sourceLabel) {
  const missing = REQUIRED_CSV_COLUMNS.filter((c) => csvRows.length && !(c in csvRows[0]));
  if (missing.length) throw new Error(`${sourceLabel}: missing column(s) ${missing.join(", ")}`);
  const extraCols = csvRows.length ? Object.keys(csvRows[0]).filter((c) => !REQUIRED_CSV_COLUMNS.includes(c)) : [];

  return csvRows
    .filter((r) => r["Branch/Site"] && r["Target Sales"])
    .map((r) => {
      const target = parseFloat(r["Target Sales"]);
      const actual = parseFloat(r["Actual Sales"]);
      const row = {
        branch: r["Branch/Site"],
        principal: r["Principal/Supplier"],
        channel: r["Channel"],
        category: r["Category"],
        month: r["Month"],
        year: parseInt(r["Year"], 10),
        target,
        actual,
        achievement: target ? Math.round((actual / target) * 1000) / 10 : 0,
      };
      // pass through any extra columns as-is (e.g. Salesman, Area, Supervisor)
      extraCols.forEach((c) => { if (r[c]) row[c] = r[c]; });
      return row;
    })
    .filter((r) => r.branch && r.principal && !Number.isNaN(r.year) && !Number.isNaN(r.target));
}

/** Every distinct extra-dimension column name present across all rows
 * (e.g. "Salesman", "Area", "Supervisor"), excluding the core schema. */
function detectExtraDimensions(rows) {
  const keys = new Set();
  rows.forEach((r) => {
    Object.keys(r).forEach((k) => {
      if (!KNOWN_FIELDS.has(k) && r[k]) keys.add(k);
    });
  });
  return [...keys].sort();
}

async function loadSheetsConfig() {
  try {
    const res = await fetch(SHEETS_CONFIG_URL, { cache: "no-store" });
    if (!res.ok) return { sources: [] };
    return res.json();
  } catch {
    return { sources: [] };
  }
}

async function loadStaticData() {
  const res = await fetch(STATIC_DATA_URL, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load sales-data.json");
  return res.json();
}

/**
 * Tries every configured published-Sheet CSV URL. Returns combined rows
 * from whichever sources succeeded, plus a list of per-source errors.
 * Falls back entirely to the bundled sample JSON if no source succeeds.
 */
async function loadData() {
  const config = await loadSheetsConfig();
  const sources = (config.sources || []).filter((s) => s.url && s.url.trim());

  if (!sources.length) {
    const rows = await loadStaticData();
    return { rows, source: "sample", errors: [] };
  }

  const results = await Promise.all(
    sources.map(async (s) => {
      try {
        const res = await fetch(s.url, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        const rows = csvRowsToData(parseCSV(text), s.label);
        return { ok: true, label: s.label, rows };
      } catch (err) {
        return { ok: false, label: s.label, error: err.message };
      }
    })
  );

  const rows = results.filter((r) => r.ok).flatMap((r) => r.rows);
  const errors = results.filter((r) => !r.ok).map((r) => `${r.label}: ${r.error}`);

  if (!rows.length) {
    const fallback = await loadStaticData();
    return { rows: fallback, source: "sample", errors: [...errors, "No live sources returned data — showing bundled sample data."] };
  }
  return { rows, source: "live", errors };
}

function uniq(arr) { return [...new Set(arr)]; }

// Inclusion-based multi-select: each Set holds the values currently INCLUDED
// (checkbox checked). All available values are selected by default; unchecking
// excludes that value. An empty set means "nothing matches" (all unchecked).
function scoped(rows, { ignorePrincipal = false, ignoreBranch = false, ignoreChannel = false, ignoreCategory = false } = {}) {
  return rows.filter((r) => {
    if (!ignorePrincipal && !state.principals.has(r.principal)) return false;
    if (!ignoreBranch && !state.branches.has(r.branch)) return false;
    if (!ignoreChannel && !state.channels.has(r.channel)) return false;
    if (!ignoreCategory && !state.categories.has(r.category)) return false;
    return true;
  });
}

/* ---------------- Filter population (5 unified dropdown checklists) ---------------- */

const FIELD_TO_STATE_KEY = { principal: "principals", branch: "branches", channel: "channels", category: "categories", period: "periods" };
const DROPDOWN_FIELDS = ["principal", "branch", "period", "channel", "category"];
// Principal & Branch relate to EACH OTHER via checkbox state only — their
// dropdown lists always show every value; checking/unchecking one just
// checks/unchecks the related values in the other.
const PRIMARY_FIELDS = ["principal", "branch"];
// Channel & Category are DERIVED from the current Principal + Branch
// selection — their dropdown lists actually shrink to only what's reachable.
const SECONDARY_FIELDS = ["channel", "category"];

// Tracks every value ever seen per field, so a data refresh can tell a
// genuinely NEW value (default it to included) from one the user
// deliberately unchecked (leave it excluded).
const knownValues = { principal: new Set(), branch: new Set(), channel: new Set(), category: new Set() };

/** The row pool a field's option list is computed from: Principal/Branch
 * always draw from the full dataset; Channel/Category draw only from rows
 * matching the current Principal + Branch selection. */
function poolForField(field) {
  if (SECONDARY_FIELDS.includes(field)) {
    return state.raw.filter((r) => state.principals.has(r.principal) && state.branches.has(r.branch));
  }
  return state.raw;
}

/** What a dropdown actually displays. Principal/Branch: always the full
 * list — relationships are reflected only via checkbox state, never by
 * hiding options. Channel/Category: shrinks to match the Principal+Branch
 * selection. */
function displayValues(field) {
  if (field === "period") return allPeriods();
  return uniq(poolForField(field).map((r) => r[field])).sort();
}

function periodLabelFor(value) {
  const [y, mi] = value.split("-").map(Number);
  return `${MONTHS[mi]} ${y}`;
}

function labelForValue(field, v) {
  return field === "period" ? periodLabelFor(v) : v;
}

/** All available (year, month-index) periods across the whole dataset,
 * newest first. Value format: "<year>-<monthIndex>", e.g. "2026-6" = Jul 2026. */
function allPeriods() {
  return uniq(state.raw.map((r) => `${r.year}-${MONTHS.indexOf(r.month)}`)).sort((a, b) => {
    const [ay, am] = a.split("-").map(Number);
    const [by, bm] = b.split("-").map(Number);
    return by - ay || bm - am;
  });
}

/** Sync a checkbox-list field's included Set against its current pool
 * (see poolForField): newly-reachable values default to included; values no
 * longer reachable are pruned; values already known and still reachable
 * keep whatever checked/unchecked state the user left them in. Used at
 * init/Refresh time, and to re-sync Channel/Category whenever Principal or
 * Branch's selection changes. */
function syncCheckField(field) {
  const values = displayValues(field);
  const stateKey = FIELD_TO_STATE_KEY[field];
  const included = state[stateKey];
  const known = knownValues[field];

  values.forEach((v) => {
    if (!known.has(v)) { known.add(v); included.add(v); } // brand-new/newly-reachable value → included by default
  });
  [...included].forEach((v) => { if (!values.includes(v)) included.delete(v); });
  [...known].forEach((v) => { if (!values.includes(v)) known.delete(v); });
}

/** "<year>-<monthIndex>" for today's real-world calendar month. */
function currentMonthPeriodValue() {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth()}`;
}

/** Reporting Period defaults to the CURRENT calendar month (falling back to
 * the most recent period in the data if the current month isn't present
 * yet). This resets every time populateFilters() runs — i.e. on initial
 * load and every time Refresh is clicked. */
function syncPeriods() {
  const periods = allPeriods();
  if (!periods.length) { state.periods = new Set(); return; }
  const currentValue = currentMonthPeriodValue();
  state.periods = new Set([periods.includes(currentValue) ? currentValue : periods[0]]);
}

/** Principal and Branch stay mutually consistent via CHECKBOX STATE ONLY —
 * their lists are never hidden (see displayValues). Checking a value
 * auto-checks whatever co-occurs with it (same rows) in the other field;
 * any value in either field no longer reachable given the other's current
 * selection gets unchecked. `justChecked` is `{ field, value }` when
 * triggered by checking a box, or omitted for an uncheck (prune-only). */
function reconcilePrimaryFields(justChecked) {
  if (justChecked) {
    const { field, value } = justChecked;
    const other = field === "principal" ? "branch" : "principal";
    const rows = state.raw.filter((r) => r[field] === value);
    uniq(rows.map((r) => r[other])).forEach((v) => state[FIELD_TO_STATE_KEY[other]].add(v));
  }
  PRIMARY_FIELDS.forEach((field) => {
    const other = field === "principal" ? "branch" : "principal";
    const otherSet = state[FIELD_TO_STATE_KEY[other]];
    if (otherSet.size === 0) return; // nothing checked on the other side — don't constrain
    const reachable = new Set(state.raw.filter((r) => otherSet.has(r[other])).map((r) => r[field]));
    const set = state[FIELD_TO_STATE_KEY[field]];
    [...set].forEach((v) => { if (!reachable.has(v)) set.delete(v); });
  });
}

/** Re-sync Channel/Category against the current Principal+Branch pool.
 * Call this any time Principal or Branch's checked state changes. */
function cascadeToSecondaryFields() {
  SECONDARY_FIELDS.forEach(syncCheckField);
}

function renderDropdown(field) {
  const stateKey = FIELD_TO_STATE_KEY[field];
  const set = state[stateKey];
  const values = displayValues(field);

  const optionsEl = document.querySelector(`[data-options="${field}"]`);
  optionsEl.innerHTML = values.length
    ? values.map((v) => `
        <label class="dropdown-option">
          <input type="checkbox" data-field="${field}" value="${v}" ${set.has(v) ? "checked" : ""}>
          <span>${labelForValue(field, v)}</span>
        </label>
      `).join("")
    : `<div class="state-banner" style="padding:16px;">No related options.</div>`;

  const valueEl = document.querySelector(`[data-value-for="${field}"]`);
  if (!values.length) valueEl.textContent = "None";
  else if (set.size === 0) valueEl.textContent = "None";
  else if (set.size === values.length) valueEl.textContent = field === "period" ? "Latest" : "All";
  else if (set.size === 1) valueEl.textContent = labelForValue(field, [...set][0]);
  else valueEl.textContent = `${set.size} selected`;
}

function renderPrimaryDropdowns() { PRIMARY_FIELDS.forEach(renderDropdown); }
function renderSecondaryDropdowns() { SECONDARY_FIELDS.forEach(renderDropdown); }

function populateFilters() {
  PRIMARY_FIELDS.forEach(syncCheckField);
  SECONDARY_FIELDS.forEach(syncCheckField); // pool now reflects the freshly-synced Principal/Branch baseline
  syncPeriods();
  DROPDOWN_FIELDS.forEach(renderDropdown);
}

function selectionSummaryText(field) {
  const stateKey = FIELD_TO_STATE_KEY[field];
  const set = state[stateKey];
  const values = displayValues(field);
  if (!set.size) return "no selection";
  if (set.size === values.length) return field === "principal" ? "All principals" : `All ${field}s`;
  if (set.size === 1) return labelForValue(field, [...set][0]);
  return `${set.size} ${field}s selected`;
}

function wireFilterEvents() {
  // checkbox toggles
  document.body.addEventListener("change", (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-field]');
    if (!cb) return;
    const field = cb.dataset.field;
    const stateKey = FIELD_TO_STATE_KEY[field];
    const set = state[stateKey];

    if (field === "period" && !cb.checked && set.size <= 1) {
      cb.checked = true; // never allow zero periods selected
      return;
    }

    if (cb.checked) set.add(cb.value); else set.delete(cb.value);

    if (PRIMARY_FIELDS.includes(field)) {
      reconcilePrimaryFields(cb.checked ? { field, value: cb.value } : undefined);
      renderPrimaryDropdowns();
      cascadeToSecondaryFields();
      renderSecondaryDropdowns();
    } else {
      renderDropdown(field); // Channel/Category/Period: purely local toggle
    }
    render();
  });

  // Select All / Uncheck All bulk actions, and open/close toggling
  document.body.addEventListener("click", (e) => {
    const bulkBtn = e.target.closest("[data-bulk]");
    if (bulkBtn) {
      const panel = bulkBtn.closest(".dropdown-panel");
      const field = panel.dataset.panel;
      const stateKey = FIELD_TO_STATE_KEY[field];
      const values = displayValues(field);
      const isSelectAll = bulkBtn.dataset.bulk === "all";

      state[stateKey] = isSelectAll
        ? new Set(values)
        : (field === "period" && values.length ? new Set([values[0]]) : new Set());
      renderDropdown(field);

      if (PRIMARY_FIELDS.includes(field)) {
        // local only w.r.t. Principal<->Branch (no reconcile, avoids an
        // immediate partial "undo" of Select All) — but Channel/Category
        // still need to re-sync downstream from the new Principal/Branch state
        cascadeToSecondaryFields();
        renderSecondaryDropdowns();
      }
      render();
      return;
    }

    const btn = e.target.closest(".dropdown-btn");
    if (btn) {
      const filter = btn.closest(".dropdown-filter");
      const wasOpen = filter.classList.contains("open");
      document.querySelectorAll(".dropdown-filter.open").forEach((f) => f.classList.remove("open"));
      if (!wasOpen) filter.classList.add("open");
      return;
    }

    if (!e.target.closest(".dropdown-filter")) {
      document.querySelectorAll(".dropdown-filter.open").forEach((f) => f.classList.remove("open"));
    }
  });

  $("#refreshBtn").addEventListener("click", async () => {
    const btn = $("#refreshBtn");
    btn.classList.add("spinning");
    try {
      const result = await loadData();
      state.raw = result.rows;
      state.source = result.source;
      state.sourceErrors = result.errors;
      populateFilters();
      render();
      setLastUpdated();
    } catch (err) {
      console.error(err);
    } finally {
      setTimeout(() => btn.classList.remove("spinning"), 500);
    }
  });
}

function setLastUpdated() {
  const now = new Date();
  $("#lastUpdated").textContent = now.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
  const scope = state.raw.length
    ? `${uniq(state.raw.map((r) => r.principal)).length} principals · ${uniq(state.raw.map((r) => r.branch)).length} sites`
    : "";
  const badge = $("#dataSourceBadge");
  if (badge) {
    badge.textContent = state.source === "live" ? "● Live from Google Sheets" : "● Sample data";
    badge.className = "source-badge" + (state.source === "live" ? " live" : "");
    badge.title = state.sourceErrors.length ? state.sourceErrors.join(" | ") : "";
  }
  $("#dataScope").textContent = scope;
}

/* ---------------- Rendering ---------------- */

function render() {
  const rows = scoped(state.raw);
  renderSummary(rows);
  renderTrendChart(rows);
  renderYoyChart(rows);
  renderHeatmap(rows);
  renderShareCharts(); // period + principal only — intentionally ignores Site/Channel/Category filters
  renderTopline(rows);
  renderDimensionCharts(rows);
  renderRecommendations();
}

function periodRows(rows) {
  if (!state.periods.size) return [];
  return rows.filter((r) => state.periods.has(`${r.year}-${MONTHS.indexOf(r.month)}`));
}

/* ---------------- Theoretical Target (pacing) ---------------- */

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/** Days elapsed in a given (year, monthIndex), for pacing purposes:
 * a fully-past month counts as 100% elapsed, a not-yet-started future
 * month as 0% elapsed, and the current month as "today's date so far". */
function daysElapsedInPeriod(year, monthIndex) {
  const total = daysInMonth(year, monthIndex);
  const now = new Date();
  const curY = now.getFullYear();
  const curM = now.getMonth();
  if (year < curY || (year === curY && monthIndex < curM)) return total; // past month — fully elapsed
  if (year > curY || (year === curY && monthIndex > curM)) return 0; // future month — not started
  return Math.min(now.getDate(), total); // current month — elapsed so far
}

/** Theoretical Target = Σ over each (year, month) present in `rows` of:
 *   (days elapsed in that month ÷ total days in that month) × that month's Target
 * Computed per-month before summing, so a multi-period selection prorates
 * each month independently rather than using one blended day-count. */
function theoreticalTarget(rows) {
  const byPeriod = new Map();
  rows.forEach((r) => {
    const mi = MONTHS.indexOf(r.month);
    const key = `${r.year}-${mi}`;
    if (!byPeriod.has(key)) byPeriod.set(key, { year: r.year, mi, target: 0 });
    byPeriod.get(key).target += r.target;
  });
  let total = 0;
  byPeriod.forEach(({ year, mi, target }) => {
    const days = daysInMonth(year, mi);
    const elapsed = daysElapsedInPeriod(year, mi);
    total += days ? (elapsed / days) * target : 0;
  });
  return total;
}

function renderSummary(rows) {
  const grid = $("#summaryGrid");
  if (!rows.length) {
    grid.innerHTML = `<div class="state-banner">No data matches the current filters.</div>`;
    return;
  }
  const current = periodRows(rows);
  const target = current.reduce((s, r) => s + r.target, 0);
  const actual = current.reduce((s, r) => s + r.actual, 0);
  const achievement = target ? (actual / target) * 100 : 0;
  const theoreticalTgt = theoreticalTarget(current);
  const theoreticalBalance = actual - theoreticalTgt; // negative = behind pace, positive/zero = on or ahead of pace
  const balance = target - actual; // positive = shortfall, negative = surplus

  // YoY: compare the same span of months between the latest year present
  // and the year before it, using whatever the latest month actually in
  // the data is (not a hardcoded cutoff) — full (unfiltered-by-period) rows
  const yearsPresent = uniq(rows.map((r) => r.year)).sort((a, b) => b - a);
  const yoyYear = yearsPresent[0];
  const priorYear = yoyYear - 1;
  const yoyMonthIndices = uniq(rows.filter((r) => r.year === yoyYear).map((r) => MONTHS.indexOf(r.month)));
  const yoyMaxMonth = yoyMonthIndices.length ? Math.max(...yoyMonthIndices) : 11;
  const yoy2025 = rows.filter((r) => r.year === priorYear && MONTHS.indexOf(r.month) <= yoyMaxMonth);
  const yoy2026 = rows.filter((r) => r.year === yoyYear);
  const sum2025 = yoy2025.reduce((s, r) => s + r.actual, 0);
  const sum2026 = yoy2026.reduce((s, r) => s + r.actual, 0);
  const yoyGrowth = sum2025 ? ((sum2026 - sum2025) / sum2025) * 100 : 0;
  const yoyRangeLabel = `${MONTHS[0]}–${MONTHS[yoyMaxMonth]}`;

  const bySite = {};
  current.forEach((r) => {
    const key = `${r.branch} · ${r.channel}`;
    if (!bySite[key]) bySite[key] = { target: 0, actual: 0 };
    bySite[key].target += r.target;
    bySite[key].actual += r.actual;
  });
  let best = null, worst = null;
  Object.entries(bySite).forEach(([key, v]) => {
    const pct = v.target ? (v.actual / v.target) * 100 : 0;
    if (!best || pct > best.pct) best = { key, pct };
    if (!worst || pct < worst.pct) worst = { key, pct };
  });

  const sortedPeriods = [...state.periods].sort((a, b) => {
    const [ay, am] = a.split("-").map(Number);
    const [by, bm] = b.split("-").map(Number);
    return ay - by || am - bm;
  });
  const periodLabel = sortedPeriods.length <= 2
    ? sortedPeriods.map(periodLabelFor).join(" + ")
    : `${sortedPeriods.length} periods selected`;

  grid.innerHTML = `
    <div class="summary-card ${achievement < 90 ? "alert" : ""}">
      <div class="label">Target Achievement — ${periodLabel}</div>
      <div class="value">${achievement.toFixed(1)}%</div>
      <div class="delta ${achievement >= 100 ? "up" : "down"}">${fmtCompact(actual)} of ${fmtCompact(target)} target</div>
    </div>
    <div class="summary-card">
      <div class="label">Total Sellout — ${periodLabel}</div>
      <div class="value">${fmtCompact(actual)}</div>
      <div class="delta">Target ${fmtCompact(target)}</div>
    </div>
    <div class="summary-card ${yoyGrowth < 0 ? "alert" : ""}">
      <div class="label">YoY Growth (${yoyRangeLabel}, ${priorYear} vs ${yoyYear})</div>
      <div class="value">${yoyGrowth >= 0 ? "+" : ""}${yoyGrowth.toFixed(1)}%</div>
      <div class="delta ${yoyGrowth >= 0 ? "up" : "down"}">${fmtCompact(sum2025)} → ${fmtCompact(sum2026)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Best Performing Segment</div>
      <div class="value" style="font-size:18px;">${best ? best.key : "—"}</div>
      <div class="delta up">${best ? best.pct.toFixed(1) + "% achieved" : ""}</div>
    </div>
    <div class="summary-card ${actual < theoreticalTgt ? "alert" : ""}">
      <div class="label">Theoretical Target — ${periodLabel}</div>
      <div class="value">${fmtCompact(theoreticalTgt)}</div>
      <div class="delta ${actual >= theoreticalTgt ? "up" : "down"}">${actual >= theoreticalTgt ? "Ahead of" : "Behind"} pace by ${fmtCompact(Math.abs(actual - theoreticalTgt))}</div>
    </div>
    <div class="summary-card ${balance > 0 ? "alert" : ""}">
      <div class="label">Balance — ${periodLabel}</div>
      <div class="value">${fmtCompact(Math.abs(balance))}</div>
      <div class="delta ${balance <= 0 ? "up" : "down"}">${balance > 0 ? "Short of target" : "Over target"}</div>
    </div>
    <div class="summary-card ${theoreticalBalance < 0 ? "alert" : ""}">
      <div class="label">Theoretical Balance — ${periodLabel}</div>
      <div class="value">${theoreticalBalance >= 0 ? "+" : "-"}${fmtCompact(Math.abs(theoreticalBalance))}</div>
      <div class="delta ${theoreticalBalance >= 0 ? "up" : "down"}">${theoreticalBalance >= 0 ? "At or ahead of pace" : "Behind pace"}</div>
    </div>
    <div class="summary-narrative">
      <strong>${periodLabel}:</strong> ${selectionSummaryText("principal")} reached
      <strong>${achievement.toFixed(1)}%</strong> of target (${fmtCompact(actual)} of ${fmtCompact(target)}),
      ${actual >= theoreticalTgt ? "running ahead of" : "trailing"} the theoretical (day-prorated) target of ${fmtCompact(theoreticalTgt)}.
      ${worst ? `The segment needing the most attention is <strong>${worst.key}</strong> at ${worst.pct.toFixed(1)}% achievement.` : ""}
      Year-over-year sellout is ${yoyGrowth >= 0 ? "up" : "down"} ${Math.abs(yoyGrowth).toFixed(1)}% versus the same months last year.
    </div>
  `;
}

function renderTrendChart(rows) {
  const periods = uniq(rows.map((r) => `${r.year}-${String(MONTHS.indexOf(r.month)).padStart(2, "0")}`)).sort();
  const labels = periods.map((p) => {
    const [y, mi] = p.split("-");
    return `${MONTHS[+mi]} '${y.slice(2)}`;
  });
  const targetByPeriod = periods.map((p) => {
    const [y, mi] = p.split("-");
    return rows.filter((r) => r.year === +y && MONTHS.indexOf(r.month) === +mi).reduce((s, r) => s + r.target, 0);
  });
  const actualByPeriod = periods.map((p) => {
    const [y, mi] = p.split("-");
    return rows.filter((r) => r.year === +y && MONTHS.indexOf(r.month) === +mi).reduce((s, r) => s + r.actual, 0);
  });

  if (trendChart) trendChart.destroy();
  trendChart = new Chart($("#trendChart"), {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Actual", data: actualByPeriod, borderColor: BRAND.blue, backgroundColor: BRAND.blue + "22", fill: true, tension: 0.35, pointRadius: 2 },
        { label: "Target", data: targetByPeriod, borderColor: BRAND.red, borderDash: [6, 4], fill: false, tension: 0.35, pointRadius: 0 },
      ],
    },
    options: chartBaseOptions((ctx) => `${ctx.dataset.label}: ${fmtPeso(ctx.parsed.y)}`),
  });
}

function renderYoyChart(rows) {
  const years = uniq(rows.map((r) => r.year)).sort((a, b) => b - a);
  const currentYear = years[0];
  const priorYear = currentYear !== undefined ? currentYear - 1 : undefined;

  // show exactly as many months as actually exist for the current year
  // (e.g. through August if August data is present) — never a hardcoded cutoff
  const monthIndices = uniq(rows.filter((r) => r.year === currentYear).map((r) => MONTHS.indexOf(r.month)));
  const maxMonthIdx = monthIndices.length ? Math.max(...monthIndices) : 11;
  const monthsToShow = MONTHS.slice(0, maxMonthIdx + 1);

  const dataFor = (year) => monthsToShow.map((m) => rows.filter((r) => r.year === year && r.month === m).reduce((s, r) => s + r.actual, 0));
  const dPrior = dataFor(priorYear);
  const dCurrent = dataFor(currentYear);

  if (yoyChart) yoyChart.destroy();
  yoyChart = new Chart($("#yoyChart"), {
    type: "bar",
    data: {
      labels: monthsToShow,
      datasets: [
        { label: String(priorYear), data: dPrior, backgroundColor: BRAND.red + "cc", borderRadius: 4, maxBarThickness: 18 },
        { label: String(currentYear), data: dCurrent, backgroundColor: BRAND.blue, borderRadius: 4, maxBarThickness: 18 },
      ],
    },
    options: chartBaseOptions((ctx) => `${ctx.dataset.label}: ${fmtPeso(ctx.parsed.y)}`),
  });
}

function chartBaseOptions(tooltipLabel) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { position: "bottom", labels: { font: { family: "Open Sans", size: 12 }, boxWidth: 12, usePointStyle: true } },
      tooltip: { callbacks: { label: tooltipLabel } },
    },
    scales: {
      x: { grid: { display: false }, ticks: { font: { size: 11 } } },
      y: { grid: { color: "#EEF1F4" }, ticks: { font: { size: 11 }, callback: (v) => fmtCompact(v) } },
    },
  };
}

function heatColor(pct) {
  if (pct >= 100) return "#1E7B3E";
  if (pct >= 90) return "#4C9A2A";
  if (pct >= 80) return "#E0A800";
  if (pct >= 70) return "#E0641A";
  return "#D62828";
}

function renderHeatmap(rows) {
  const wrap = $("#heatmapWrap");
  const current = periodRows(rows);
  if (!current.length) {
    wrap.innerHTML = `<div class="state-banner">No data for this period.</div>`;
    return;
  }
  const branches = uniq(current.map((r) => r.branch)).sort();
  const categories = uniq(current.map((r) => r.category)).sort();

  let html = `<table class="heatmap-table"><thead><tr><th>Branch</th>${categories.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>`;
  branches.forEach((b) => {
    html += `<tr><td><strong>${b}</strong></td>`;
    categories.forEach((c) => {
      const cell = current.filter((r) => r.branch === b && r.category === c);
      if (!cell.length) { html += `<td>—</td>`; return; }
      const target = cell.reduce((s, r) => s + r.target, 0);
      const actual = cell.reduce((s, r) => s + r.actual, 0);
      const pct = target ? (actual / target) * 100 : 0;
      html += `<td><span class="heat-cell" style="background:${heatColor(pct)}">${pct.toFixed(0)}%</span></td>`;
    });
    html += `</tr>`;
  });
  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

/* ---------------- Business share pie charts (reporting period only) ---------------- */

function pieLegendAndTooltip() {
  return {
    legend: {
      position: "right",
      labels: {
        font: { family: "Open Sans", size: 12 },
        boxWidth: 12,
        usePointStyle: true,
        generateLabels: (chart) => {
          const data = chart.data;
          const values = data.datasets[0].data;
          const total = values.reduce((a, b) => a + b, 0);
          return data.labels.map((label, i) => {
            const pct = total ? (values[i] / total) * 100 : 0;
            return {
              text: `${label} — ${pct.toFixed(1)}% (${fmtMillions(values[i])})`,
              fillStyle: data.datasets[0].backgroundColor[i],
              strokeStyle: data.datasets[0].backgroundColor[i],
              index: i,
            };
          });
        },
      },
    },
    tooltip: {
      callbacks: {
        label: (ctx) => {
          const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
          const pct = total ? (ctx.parsed / total) * 100 : 0;
          return `${ctx.label}: ${pct.toFixed(1)}% (${fmtMillions(ctx.parsed)})`;
        },
      },
    },
  };
}

function buildShareData(rows, field) {
  const values = uniq(rows.map((r) => r[field])).sort();
  return {
    labels: values,
    data: values.map((v) => rows.filter((r) => r[field] === v).reduce((s, r) => s + r.actual, 0)),
  };
}

function renderShareCharts() {
  // Scoped by Reporting Period + Principal/Supplier ONLY — deliberately
  // ignores Site/Channel/Category filters per spec.
  const rows = periodRows(scoped(state.raw, { ignoreBranch: true, ignoreChannel: true, ignoreCategory: true }));

  if (principalPieChart) { principalPieChart.destroy(); principalPieChart = null; }
  if (branchPieChart) { branchPieChart.destroy(); branchPieChart = null; }

  const principalWrap = $("#principalPieWrap");
  const branchWrap = $("#branchPieWrap");

  if (!rows.length) {
    principalWrap.innerHTML = `<div class="state-banner">No data for this period.</div>`;
    branchWrap.innerHTML = `<div class="state-banner">No data for this period.</div>`;
    return;
  }

  // rebuild fresh canvases every time — a prior render may have replaced
  // them with a "no data" banner
  principalWrap.innerHTML = `<canvas id="principalPieChart"></canvas>`;
  branchWrap.innerHTML = `<canvas id="branchPieChart"></canvas>`;

  const principalShare = buildShareData(rows, "principal");
  principalPieChart = new Chart($("#principalPieChart"), {
    type: "pie",
    data: {
      labels: principalShare.labels,
      datasets: [{ data: principalShare.data, backgroundColor: PIE_COLORS, borderColor: "#fff", borderWidth: 2 }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: pieLegendAndTooltip() },
  });

  const branchShare = buildShareData(rows, "branch");
  branchPieChart = new Chart($("#branchPieChart"), {
    type: "pie",
    data: {
      labels: branchShare.labels,
      datasets: [{ data: branchShare.data, backgroundColor: PIE_COLORS, borderColor: "#fff", borderWidth: 2 }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: pieLegendAndTooltip() },
  });
}

function warningIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
}

/* ---------------- Topline per-site quick reference ---------------- */

function computeSiteTopline(rows) {
  const branches = uniq(rows.map((r) => r.branch)).sort();
  const histPeriods = new Set(
    [...state.periods].map((p) => {
      const [y, mi] = p.split("-").map(Number);
      return `${y - 1}-${mi}`;
    })
  );

  return branches.map((branch) => {
    const branchRows = rows.filter((r) => r.branch === branch);
    const current = periodRows(branchRows);
    const target = current.reduce((s, r) => s + r.target, 0);
    const actual = current.reduce((s, r) => s + r.actual, 0);
    const achievement = target ? (actual / target) * 100 : 0;
    const balance = target - actual; // positive = shortfall, negative = surplus
    const theoreticalTgt = theoreticalTarget(current);
    const historical = branchRows
      .filter((r) => histPeriods.has(`${r.year}-${MONTHS.indexOf(r.month)}`))
      .reduce((s, r) => s + r.actual, 0);
    const growth = historical ? ((actual / historical) - 1) * 100 : null;
    return { branch, target, actual, achievement, balance, theoreticalTgt, historical, growth };
  });
}

function renderTopline(rows) {
  const grid = $("#toplineGrid");
  const sites = computeSiteTopline(rows);

  Object.values(toplineCharts).forEach((c) => c.destroy());
  toplineCharts = {};

  if (!sites.length) {
    grid.innerHTML = `<div class="state-banner">No data matches the current filters.</div>`;
    return;
  }

  grid.innerHTML = sites
    .map((s) => {
      const met = s.actual >= s.target;
      return `
        <div class="topline-card">
          <div class="topline-head">
            <span class="topline-site">${s.branch}</span>
            <span class="topline-badge ${met ? "green" : "red"}">${met ? "🟢" : "🔴"} ${s.achievement.toFixed(0)}%</span>
          </div>
          <div class="chart-wrap small"><canvas id="topline-${cssId(s.branch)}"></canvas></div>
          <div class="topline-metrics">
            <div>
              <span class="m-label">Balance</span>
              <span class="m-value ${s.balance > 0 ? "down" : "up"}">${fmtCompact(Math.abs(s.balance))} ${s.balance > 0 ? "short" : "over"}</span>
            </div>
            <div>
              <span class="m-label">Growth YoY</span>
              <span class="m-value ${s.growth == null ? "" : s.growth >= 0 ? "up" : "down"}">${s.growth == null ? "—" : (s.growth >= 0 ? "+" : "") + s.growth.toFixed(1) + "%"}</span>
            </div>
          </div>
        </div>
      `;
    })
    .join("");

  sites.forEach((s) => {
    const canvas = $(`#topline-${cssId(s.branch)}`);
    if (!canvas) return;
    toplineCharts[s.branch] = new Chart(canvas, {
      type: "bar",
      data: {
        labels: ["Historical", "Target", "Theoretical", "Actual"],
        datasets: [{
          data: [s.historical, s.target, s.theoreticalTgt, s.actual],
          backgroundColor: [BRAND.gray, BRAND.blue, "#F0A202", s.actual >= s.target ? "#1E7B3E" : BRAND.red],
          borderRadius: 4,
          maxBarThickness: 34,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => fmtPeso(ctx.parsed.y) } },
        },
        scales: {
          x: { grid: { display: false }, ticks: { font: { size: 10.5 } } },
          y: { grid: { color: "#EEF1F4" }, ticks: { font: { size: 10 }, callback: (v) => fmtCompact(v) } },
        },
      },
    });
  });
}

/* ---------------- Auto-detected dimension charts (Salesman, Area, Supervisor, ...) ---------------- */

function renderDimensionCharts(rows) {
  const section = $("#dimensionSection");
  const dims = detectExtraDimensions(state.raw);

  Object.values(dimensionCharts).forEach((c) => c.destroy());
  dimensionCharts = {};

  if (!dims.length) {
    section.classList.add("hidden");
    return;
  }
  section.classList.remove("hidden");

  const current = periodRows(rows);
  const grid = $("#dimensionGrid");
  grid.innerHTML = dims
    .map((dim) => `
      <div class="panel">
        <p class="panel-title">By ${dim}</p>
        <div class="chart-wrap"><canvas id="dim-${cssId(dim)}"></canvas></div>
        <div id="dim-table-${cssId(dim)}"></div>
      </div>
    `)
    .join("");

  dims.forEach((dim) => {
    const values = uniq(current.map((r) => r[dim]).filter(Boolean)).sort();
    if (!values.length) return;
    const perValue = values.map((v) => {
      const vRows = current.filter((r) => r[dim] === v);
      const target = vRows.reduce((s, r) => s + r.target, 0);
      const actual = vRows.reduce((s, r) => s + r.actual, 0);
      const achievement = target ? (actual / target) * 100 : 0;
      const balance = target - actual;
      return { value: v, target, actual, achievement, balance };
    });

    const canvas = $(`#dim-${cssId(dim)}`);
    dimensionCharts[dim] = new Chart(canvas, {
      type: "bar",
      data: {
        labels: perValue.map((p) => p.value),
        datasets: [
          { label: "Target", data: perValue.map((p) => p.target), backgroundColor: BRAND.blue + "55", borderRadius: 4, maxBarThickness: 28 },
          { label: "Actual", data: perValue.map((p) => p.actual), backgroundColor: perValue.map((p) => (p.actual >= p.target ? "#1E7B3E" : BRAND.red)), borderRadius: 4, maxBarThickness: 28 },
        ],
      },
      options: chartBaseOptions((ctx) => `${ctx.dataset.label}: ${fmtPeso(ctx.parsed.y)}`),
    });

    const tableWrap = $(`#dim-table-${cssId(dim)}`);
    tableWrap.innerHTML = `
      <table class="dim-table">
        <thead><tr><th>${dim}</th><th>Achievement</th><th>Balance</th></tr></thead>
        <tbody>
          ${perValue
            .map((p) => `
              <tr>
                <td>${p.value}</td>
                <td class="num ${p.achievement >= 100 ? "up" : "down"}">${p.achievement.toFixed(0)}%</td>
                <td class="num ${p.balance <= 0 ? "up" : "down"}">${fmtCompact(Math.abs(p.balance))}${p.balance > 0 ? " short" : " over"}</td>
              </tr>
            `)
            .join("")}
        </tbody>
      </table>
    `;
  });
}

function renderRecommendations() {
  const grid = $("#recGrid");
  const principals = uniq(state.raw.map((r) => r.principal)).filter((p) => state.principals.has(p)).sort();
  const cards = [];

  principals.forEach((principal) => {
    // respect branch/channel/category filters, but iterate every principal
    // (ignoring the principal filter itself) so each supplier gets coverage
    const segRows = scoped(state.raw, { ignorePrincipal: true }).filter((r) => r.principal === principal);
    const current = periodRows(segRows);
    if (!current.length) return;

    const bySeg = {};
    current.forEach((r) => {
      const key = `${r.branch} · ${r.channel} · ${r.category}`;
      if (!bySeg[key]) bySeg[key] = { target: 0, actual: 0 };
      bySeg[key].target += r.target;
      bySeg[key].actual += r.actual;
    });
    const segs = Object.entries(bySeg)
      .map(([key, v]) => ({ key, pct: v.target ? (v.actual / v.target) * 100 : 0 }))
      .sort((a, b) => a.pct - b.pct);

    segs.slice(0, 2).forEach((seg) => {
      const verdict = seg.pct < 80
        ? `Achievement is only ${seg.pct.toFixed(0)}% — prioritize a corrective push (merchandising, promo support, or route coverage review) in this segment.`
        : `Achievement is trailing at ${seg.pct.toFixed(0)}% — reinforce distribution and shelf visibility to close the gap before period-end.`;
      cards.push({ principal, text: `${seg.key}: ${verdict}` });
    });

    const best = Object.entries(bySeg).map(([key, v]) => ({ key, pct: v.target ? (v.actual / v.target) * 100 : 0 })).sort((a, b) => b.pct - a.pct)[0];
    if (best) {
      cards.push({ principal, text: `${best.key} is the strongest segment at ${best.pct.toFixed(0)}% — replicate the same channel/category mix in underperforming sites.` });
    }
  });

  if (!cards.length) {
    grid.innerHTML = `<div class="state-banner">No recommendations available for the current filters.</div>`;
    return;
  }

  grid.innerHTML = cards
    .map((c) => `
      <div class="rec-card">
        <div class="rec-icon">${warningIcon()}</div>
        <div class="rec-body">
          <span class="principal-tag">${c.principal}</span>
          <p>${c.text}</p>
        </div>
      </div>
    `)
    .join("");
}

/* ---------------- Init ---------------- */

(async function init() {
  wireFilterEvents();
  try {
    const result = await loadData();
    state.raw = result.rows;
    state.source = result.source;
    state.sourceErrors = result.errors;
    populateFilters();
    render();
    setLastUpdated();
  } catch (err) {
    $("#summaryGrid").innerHTML = `<div class="state-banner error">Could not load sales data. Check data/sheets-config.json and data/sales-data.json.</div>`;
    console.error(err);
  }
})();
