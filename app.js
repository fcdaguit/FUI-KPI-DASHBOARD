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
  principal: "All",
  branch: "All",
  period: "latest",     // "latest" | "2025" | "2026"
  channels: new Set(),
  categories: new Set(),
};

let trendChart, yoyChart;

const $ = (sel) => document.querySelector(sel);
const fmtPeso = (n) => "₱" + Math.round(n).toLocaleString("en-PH");
const fmtCompact = (n) => "₱" + new Intl.NumberFormat("en-PH", { notation: "compact", maximumFractionDigits: 1 }).format(n);
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
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = (r[i] ?? "").trim(); });
    return obj;
  });
}

function csvRowsToData(csvRows, sourceLabel) {
  const missing = REQUIRED_CSV_COLUMNS.filter((c) => csvRows.length && !(c in csvRows[0]));
  if (missing.length) throw new Error(`${sourceLabel}: missing column(s) ${missing.join(", ")}`);
  return csvRows
    .filter((r) => r["Branch/Site"] && r["Target Sales"])
    .map((r) => {
      const target = parseFloat(r["Target Sales"]);
      const actual = parseFloat(r["Actual Sales"]);
      return {
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
    })
    .filter((r) => r.branch && r.principal && !Number.isNaN(r.year) && !Number.isNaN(r.target));
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

function scoped(rows, { ignorePrincipal = false, ignoreBranch = false, ignoreChannel = false, ignoreCategory = false } = {}) {
  return rows.filter((r) => {
    if (!ignorePrincipal && state.principal !== "All" && r.principal !== state.principal) return false;
    if (!ignoreBranch && state.branch !== "All" && r.branch !== state.branch) return false;
    if (!ignoreChannel && state.channels.size && !state.channels.has(r.channel)) return false;
    if (!ignoreCategory && state.categories.size && !state.categories.has(r.category)) return false;
    return true;
  });
}

/* ---------------- Filter population ---------------- */

function populateFilters() {
  const principals = uniq(state.raw.map((r) => r.principal)).sort();
  const principalSelect = $("#principalSelect");
  principalSelect.innerHTML = ["All Principals", ...principals]
    .map((p) => `<option value="${p === "All Principals" ? "All" : p}">${p}</option>`)
    .join("");
  principalSelect.value = state.principal;

  refreshBranchOptions();
  refreshChips("#channelChips", "channel");
  refreshChips("#categoryChips", "category");

  populatePeriodOptions();
}

function populatePeriodOptions() {
  const periodSelect = $("#periodSelect");
  if (!state.raw.length) {
    periodSelect.innerHTML = `<option value="latest">Latest Month</option>`;
    return;
  }
  const years = uniq(state.raw.map((r) => r.year)).sort((a, b) => b - a);
  const currentYear = years[0]; // most recent year present = "current" year

  const monthOptions = uniq(
    state.raw.filter((r) => r.year === currentYear).map((r) => MONTHS.indexOf(r.month))
  )
    .sort((a, b) => a - b)
    .map((mi) => `<option value="${currentYear}-${mi}">${MONTHS[mi]} ${currentYear}</option>`)
    .join("");

  const yearOptions = years
    .map((y) => `<option value="${y}">Full Year ${y}${y === currentYear ? " (YTD)" : ""}</option>`)
    .join("");

  periodSelect.innerHTML = `
    <option value="latest">Latest Month</option>
    <optgroup label="Specific Month (${currentYear})">${monthOptions}</optgroup>
    <optgroup label="Full Year">${yearOptions}</optgroup>
  `;

  // keep current selection if still valid, otherwise default to "latest"
  const validValues = [...periodSelect.querySelectorAll("option")].map((o) => o.value);
  if (!validValues.includes(state.period)) state.period = "latest";
  periodSelect.value = state.period;
}

function refreshBranchOptions() {
  const pool = scoped(state.raw, { ignoreBranch: true, ignoreChannel: true, ignoreCategory: true });
  const branches = uniq(pool.map((r) => r.branch)).sort();
  const branchSelect = $("#branchSelect");
  branchSelect.innerHTML = ["All Sites", ...branches]
    .map((b) => `<option value="${b === "All Sites" ? "All" : b}">${b}</option>`)
    .join("");
  if (!branches.includes(state.branch)) state.branch = "All";
  branchSelect.value = state.branch;
}

function refreshChips(containerSel, field) {
  const pool = scoped(state.raw, { ignoreChannel: field === "channel", ignoreCategory: field === "category" });
  const values = uniq(pool.map((r) => r[field])).sort();
  const activeSet = field === "channel" ? state.channels : state.categories;
  // prune stale selections, default to "all active" (empty set = no filter)
  [...activeSet].forEach((v) => { if (!values.includes(v)) activeSet.delete(v); });

  const container = $(containerSel);
  container.innerHTML = values
    .map((v) => `<button type="button" class="chip${activeSet.has(v) ? " active" : ""}" data-field="${field}" data-value="${v}">${v}</button>`)
    .join("");
}

function wireFilterEvents() {
  $("#principalSelect").addEventListener("change", (e) => {
    state.principal = e.target.value;
    state.branch = "All";
    refreshBranchOptions();
    refreshChips("#channelChips", "channel");
    refreshChips("#categoryChips", "category");
    render();
  });
  $("#branchSelect").addEventListener("change", (e) => { state.branch = e.target.value; render(); });
  $("#periodSelect").addEventListener("change", (e) => { state.period = e.target.value; render(); });

  document.body.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const field = chip.dataset.field;
    const value = chip.dataset.value;
    const set = field === "channel" ? state.channels : state.categories;
    set.has(value) ? set.delete(value) : set.add(value);
    chip.classList.toggle("active");
    render();
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
  renderRecommendations();
}

function periodRows(rows) {
  if (state.period === "latest") {
    if (!rows.length) return [];
    const latest = Math.max(...rows.map(sortKey));
    return rows.filter((r) => sortKey(r) === latest);
  }
  if (state.period.includes("-")) {
    const [year, mi] = state.period.split("-").map(Number);
    return rows.filter((r) => r.year === year && MONTHS.indexOf(r.month) === mi);
  }
  return rows.filter((r) => String(r.year) === state.period);
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

  // YoY: compare same months across 2025 vs 2026 within full (unfiltered-by-period) rows
  const yoy2025 = rows.filter((r) => r.year === 2025 && MONTHS.indexOf(r.month) < 7);
  const yoy2026 = rows.filter((r) => r.year === 2026);
  const sum2025 = yoy2025.reduce((s, r) => s + r.actual, 0);
  const sum2026 = yoy2026.reduce((s, r) => s + r.actual, 0);
  const yoyGrowth = sum2025 ? ((sum2026 - sum2025) / sum2025) * 100 : 0;

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

  const periodLabel = state.period === "latest"
    ? (current[0] ? `${current[0].month} ${current[0].year}` : "—")
    : state.period.includes("-")
    ? (current[0] ? `${current[0].month} ${current[0].year}` : "—")
    : `Full Year ${state.period}`;

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
      <div class="label">YoY Growth (Jan–Jul, 2025 vs 2026)</div>
      <div class="value">${yoyGrowth >= 0 ? "+" : ""}${yoyGrowth.toFixed(1)}%</div>
      <div class="delta ${yoyGrowth >= 0 ? "up" : "down"}">${fmtCompact(sum2025)} → ${fmtCompact(sum2026)}</div>
    </div>
    <div class="summary-card">
      <div class="label">Best Performing Segment</div>
      <div class="value" style="font-size:18px;">${best ? best.key : "—"}</div>
      <div class="delta up">${best ? best.pct.toFixed(1) + "% achieved" : ""}</div>
    </div>
    <div class="summary-narrative">
      <strong>${periodLabel}:</strong> ${state.principal === "All" ? "All principals" : state.principal} reached
      <strong>${achievement.toFixed(1)}%</strong> of target (${fmtCompact(actual)} of ${fmtCompact(target)}).
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
  const months2025 = MONTHS.slice(0, 12);
  const dataFor = (year) => months2025.map((m) => rows.filter((r) => r.year === year && r.month === m).reduce((s, r) => s + r.actual, 0));
  const d2025 = dataFor(2025);
  const d2026 = MONTHS.slice(0, 7).map((m) => rows.filter((r) => r.year === 2026 && r.month === m).reduce((s, r) => s + r.actual, 0));

  if (yoyChart) yoyChart.destroy();
  yoyChart = new Chart($("#yoyChart"), {
    type: "bar",
    data: {
      labels: months2025,
      datasets: [
        { label: "2025", data: d2025, backgroundColor: BRAND.red + "cc", borderRadius: 4, maxBarThickness: 18 },
        { label: "2026", data: [...d2026, ...Array(5).fill(null)], backgroundColor: BRAND.blue, borderRadius: 4, maxBarThickness: 18 },
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

function warningIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
}

function renderRecommendations() {
  const grid = $("#recGrid");
  const principals = state.principal === "All" ? uniq(state.raw.map((r) => r.principal)).sort() : [state.principal];
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
