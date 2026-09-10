// ===== Config =====
const CONFIG = {
  SHEET_ID: '1AQex7Jtq5BDQZPBOa2j3abpKg6G-TK01CGM0a565AvM',
  GID: null,           // null = default (first) sheet/tab
  POLL_MS: 15000,      // realtime polling interval
  TREND_WINDOW_DAYS: 14,
  STEPS_WINDOW_DAYS: 14,
  // แผนโภชนาการ 18 สัปดาห์ (periodization) — วันไหนตรงช่วงไหนก็ใช้ตัวเลขของช่วงนั้น
  // start/end เป็น 'YYYY-MM-DD' แบบรวมวันแรก-วันสุดท้าย (inclusive)
  NUTRITION_PHASES: [
    { name: 'Phase 0 – TDEE Reset', start: '2026-09-07', end: '2026-09-27', calories: 2650, protein: 180, carb: 320, fat: 70 },
    { name: 'Phase 1 – Controlled Cut', start: '2026-09-28', end: '2026-11-08', calories: 2150, protein: 190, carb: 200, fat: 65 },
    { name: 'Diet Break 1', start: '2026-11-09', end: '2026-11-15', calories: 2500, protein: 180, carb: 290, fat: 65 },
    { name: 'Phase 2 – Deep Cut', start: '2026-11-16', end: '2026-12-27', calories: 1975, protein: 190, carb: 160, fat: 60 },
    { name: 'Diet Break 2', start: '2026-12-28', end: '2027-01-03', calories: 2400, protein: 180, carb: 270, fat: 65 },
    { name: 'Phase 3 – Final Push', start: '2027-01-04', end: '2027-01-31', calories: 1900, protein: 190, carb: 150, fat: 60 },
  ],
};

function parseISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function getNutritionTarget(date) {
  const phases = CONFIG.NUTRITION_PHASES;
  for (const p of phases) {
    if (date >= parseISODate(p.start) && date <= parseISODate(p.end)) {
      return p;
    }
  }
  if (date < parseISODate(phases[0].start)) return phases[0];
  return phases[phases.length - 1];
}

// ===== Theme (kept in sync with style.css custom properties) =====
const THEME = {
  ink: '#14150f',
  inkSoft: '#8b8d84',
  inkFaint: '#b6b8ae',
  line: '#eceee4',
  surface2: '#f5f7ef',
  lime: '#d8f34f',
  limeDeep: '#a8c81f',
  pink: '#f7cdee',
  pinkDeepSoft: '#f0a8dc',
  blue: '#8fd3ec',
};

// Vertical fade used under the weight line; needs the chart area, so it is
// resolved lazily per render rather than built once up front.
function areaGradient(context, topColor) {
  const { ctx, chartArea } = context.chart;
  if (!chartArea) return topColor;
  const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
  g.addColorStop(0, topColor);
  g.addColorStop(1, 'rgba(216,243,79,0)');
  return g;
}

function tooltipStyle(labelFn) {
  return {
    backgroundColor: THEME.ink,
    padding: 10,
    cornerRadius: 10,
    displayColors: false,
    titleFont: { size: 11, weight: '500' },
    bodyFont: { size: 12, weight: '600' },
    callbacks: { label: labelFn },
  };
}

const targetLinePlugin = {
  id: 'targetLine',
  afterDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    if (!scales.y || scales.y.max < 100) return;
    const y = scales.y.getPixelForValue(100);
    ctx.save();
    ctx.strokeStyle = THEME.inkFaint;
    ctx.setLineDash([5, 5]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.restore();
  },
};

const barValueLabelPlugin = {
  id: 'barValueLabel',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    const meta = chart.getDatasetMeta(0);
    ctx.save();
    ctx.font = "600 11px Prompt, sans-serif";
    ctx.fillStyle = THEME.ink;
    ctx.textAlign = 'center';
    meta.data.forEach((bar, i) => {
      const value = chart.data.datasets[0].data[i];
      if (value == null) return;
      ctx.fillText(`${value}%`, bar.x, bar.y - 7);
    });
    ctx.restore();
  },
};

// ===== State =====
let dailyRecords = [];   // [{date, weight, isWorkout, workoutTypes:[], steps, caloriesIn, protein, carb, fat}], sorted ascending
let colIndex = { date: -1, workout: -1, weight: -1, step: -1, caloriesIn: -1, protein: -1, carb: -1, fat: -1, mood: -1 };
let stepColumnExists = false;
let weightChart = null;
let stepsChart = null;
let calPctChart = null;
let calendarCursor = new Date();       // month currently shown in calendar
let weekCursor = new Date();           // week currently shown in the % chart
let scheduleByDate = new Map();  // 'YYYY-MM-DD' -> [{emoji,label,start,end}]
let pollTimer = null;

// ===== Gviz fetch (script-tag JSONP technique, avoids CORS entirely) =====
function fetchGvizTable() {
  return new Promise((resolve, reject) => {
    window.google = window.google || {};
    window.google.visualization = window.google.visualization || {};
    window.google.visualization.Query = window.google.visualization.Query || {};
    window.google.visualization.Query.setResponse = function (data) {
      resolve(data);
    };

    let url = `https://docs.google.com/spreadsheets/d/${CONFIG.SHEET_ID}/gviz/tq?tqx=out:json`;
    if (CONFIG.GID) url += `&gid=${CONFIG.GID}`;
    url += `&_=${Date.now()}`;

    const script = document.createElement('script');
    script.src = url;
    const timer = setTimeout(() => {
      script.remove();
      reject(new Error('หมดเวลาโหลดข้อมูลจาก Google Sheet'));
    }, 12000);

    script.onload = () => { clearTimeout(timer); script.remove(); };
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      reject(new Error('โหลดข้อมูลจาก Google Sheet ไม่สำเร็จ (ตรวจสอบว่า Sheet เปิดเป็น public แล้ว)'));
    };
    document.body.appendChild(script);
  });
}

// ===== Parsing =====
function buildColumnIndex(cols) {
  const idx = { date: -1, workout: -1, weight: -1, step: -1, caloriesIn: -1, protein: -1, carb: -1, fat: -1, mood: -1 };
  cols.forEach((col, i) => {
    const label = (col.label || '').toLowerCase();
    if (idx.date === -1 && col.type === 'date') idx.date = i;
    if (idx.workout === -1 && label.includes('ออกกำลังกาย')) idx.workout = i;
    if (idx.weight === -1 && label.includes('น้ำหนัก')) idx.weight = i;
    if (idx.step === -1 && (label.includes('step') || label.includes('ก้าว'))) idx.step = i;
    if (idx.caloriesIn === -1 && label.includes('แคลอรี่') && !label.includes('เผาผลาญ') && !label.includes('active')) {
      idx.caloriesIn = i;
    }
    if (idx.protein === -1 && (label.includes('โปรตีน') || label.includes('protein'))) idx.protein = i;
    if (idx.carb === -1 && (label.includes('คาร์บ') || label.includes('carb'))) idx.carb = i;
    if (idx.fat === -1 && (label.includes('ไขมัน') || label.includes('fat'))) idx.fat = i;
    if (idx.mood === -1 && (label.includes('mood') || label.includes('อารมณ์'))) idx.mood = i;
  });
  return idx;
}

function parseGvizDate(v) {
  if (typeof v !== 'string') return null;
  const m = /^Date\((\d+),(\d+),(\d+)\)$/.exec(v);
  if (!m) return null;
  return new Date(+m[1], +m[2], +m[3]);
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function aggregateByDay(table, idx) {
  const map = new Map();
  (table.rows || []).forEach((row) => {
    const cells = row.c || [];
    const dateCell = cells[idx.date];
    if (!dateCell || dateCell.v == null) return;
    const date = parseGvizDate(dateCell.v);
    if (!date) return;
    const key = dateKey(date);

    if (!map.has(key)) {
      map.set(key, { date, weight: null, isWorkout: false, workoutTypes: [], plannedTitles: [], steps: null, caloriesIn: 0, protein: 0, carb: 0, fat: 0, mood: null });
    }
    const rec = map.get(key);

    if (idx.weight !== -1) {
      const c = cells[idx.weight];
      const val = c ? c.v : null;
      if (rec.weight == null && typeof val === 'number' && val > 0) rec.weight = val;
    }
    if (idx.workout !== -1) {
      const c = cells[idx.workout];
      const val = c ? c.v : null;
      if (typeof val === 'string' && val.trim() !== '') {
        rec.isWorkout = true;
        rec.workoutTypes.push(val.trim());
      }
    }
    if (idx.step !== -1) {
      const c = cells[idx.step];
      const val = c ? c.v : null;
      if (rec.steps == null && typeof val === 'number' && val > 0) rec.steps = val;
    }
    if (idx.mood !== -1) {
      const c = cells[idx.mood];
      const val = c ? c.v : null;
      if (rec.mood == null && typeof val === 'number' && val > 0) rec.mood = val;
    }
    if (idx.caloriesIn !== -1) {
      const c = cells[idx.caloriesIn];
      const val = c ? c.v : null;
      if (typeof val === 'number') rec.caloriesIn += val;
    }
    if (idx.protein !== -1) {
      const c = cells[idx.protein];
      const val = c ? c.v : null;
      if (typeof val === 'number') rec.protein += val;
    }
    if (idx.carb !== -1) {
      const c = cells[idx.carb];
      const val = c ? c.v : null;
      if (typeof val === 'number') rec.carb += val;
    }
    if (idx.fat !== -1) {
      const c = cells[idx.fat];
      const val = c ? c.v : null;
      if (typeof val === 'number') rec.fat += val;
    }
  });
  return Array.from(map.values()).sort((a, b) => a.date - b.date);
}

// ===== Planned workouts, from Google Calendar =====
// Two different things are tracked per day, and they must not overwrite
// each other: `isWorkout` is what actually happened (logged in the Sheet),
// while `plannedTitles` is what was scheduled (events in Google Calendar,
// which can be in the future).
//
// Populated by .github/workflows/sync-calendar.yml every ~3 days from an
// ICS feed (see scripts/sync_calendar.py). Fetched same-origin as a static
// JSON file to avoid Google's ICS CORS restrictions.
async function fetchCalendarWorkoutDays() {
  try {
    const res = await fetch(`workout-days.json?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function applyScheduleData(calendarData) {
  scheduleByDate = new Map();
  if (!calendarData || !Array.isArray(calendarData.schedule)) return;
  calendarData.schedule.forEach((entry) => {
    if (entry && entry.date) scheduleByDate.set(entry.date, entry.items || []);
  });
}

function applyPlannedWorkouts(calendarData) {
  if (!calendarData || !Array.isArray(calendarData.days)) return;

  const map = new Map(dailyRecords.map((r) => [dateKey(r.date), r]));
  calendarData.days.forEach((entry) => {
    // Older syncs wrote plain "YYYY-MM-DD" strings; newer ones write
    // { date, titles }. Accept both so a stale file can't break the page.
    const iso = typeof entry === 'string' ? entry : entry.date;
    const titles = typeof entry === 'string' ? [] : entry.titles || [];
    if (!iso) return;
    const [y, m, d] = iso.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const key = dateKey(date);
    let rec = map.get(key);
    if (!rec) {
      // A planned day with no Sheet activity yet (typically in the future).
      rec = { date, weight: null, isWorkout: false, workoutTypes: [], plannedTitles: [], steps: null, caloriesIn: 0, protein: 0, carb: 0, fat: 0, mood: null };
      dailyRecords.push(rec);
      map.set(key, rec);
    }
    rec.plannedTitles = titles;
  });
  dailyRecords.sort((a, b) => a.date - b.date);
}

// ===== Load cycle =====
async function loadData() {
  try {
    const [data, calendarData] = await Promise.all([fetchGvizTable(), fetchCalendarWorkoutDays()]);
    if (data.status === 'error') {
      const msg = (data.errors || []).map((e) => e.detailed_message || e.message).join(', ');
      throw new Error(msg || 'Google Sheet ตอบกลับข้อผิดพลาด');
    }
    const table = data.table;
    colIndex = buildColumnIndex(table.cols || []);
    stepColumnExists = colIndex.step !== -1;
    dailyRecords = aggregateByDay(table, colIndex);
    applyPlannedWorkouts(calendarData);
    applyScheduleData(calendarData);
    hideError();
    renderAll();
    setStatus(`อัปเดตล่าสุด ${new Date().toLocaleTimeString('th-TH')}`);
  } catch (err) {
    showError(err.message || String(err));
  }
}

function startPolling() {
  loadData();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(loadData, CONFIG.POLL_MS);
}

// ===== UI: status / error =====
function setStatus(text) {
  const el = document.getElementById('status-text');
  if (el) el.textContent = text;
}

function showError(msg) {
  const el = document.getElementById('error-banner');
  if (!el) return;
  el.textContent = `⚠️ ${msg}`;
  el.hidden = false;
}

function hideError() {
  const el = document.getElementById('error-banner');
  if (el) el.hidden = true;
}

// ===== Render: Home =====
function computeTrend() {
  const withWeight = dailyRecords.filter((d) => d.weight != null);
  if (withWeight.length < 2) return null;
  const last = withWeight[withWeight.length - 1];
  const targetTime = last.date.getTime() - CONFIG.TREND_WINDOW_DAYS * 24 * 3600 * 1000;

  let compare = withWeight[0];
  for (const d of withWeight) {
    if (d.date.getTime() <= targetTime) compare = d;
    else break;
  }
  if (compare === last) compare = withWeight[Math.max(0, withWeight.length - 2)];

  const diff = last.weight - compare.weight;
  const days = Math.max(1, Math.round((last.date - compare.date) / (24 * 3600 * 1000)));
  const direction = diff < -0.05 ? 'down' : diff > 0.05 ? 'up' : 'flat';
  return { diff, days, latest: last.weight, direction };
}

function renderTrend() {
  const badge = document.getElementById('trend-badge');
  const latestEl = document.getElementById('weight-latest');
  const trend = computeTrend();
  if (!trend) {
    badge.className = 'trend-badge flat';
    badge.textContent = 'ยังไม่มีข้อมูลน้ำหนักพอสำหรับวิเคราะห์เทรนด์';
    latestEl.textContent = '–';
    return;
  }
  latestEl.textContent = trend.latest.toFixed(1);
  badge.className = `trend-badge ${trend.direction}`;
  const arrow = trend.direction === 'down' ? '↓' : trend.direction === 'up' ? '↑' : '→';
  const absDiff = Math.abs(trend.diff).toFixed(1);
  const label =
    trend.direction === 'down'
      ? `ลดลง ${absDiff} กก. ใน ${trend.days} วัน`
      : trend.direction === 'up'
      ? `เพิ่มขึ้น ${absDiff} กก. ใน ${trend.days} วัน`
      : `คงที่ในช่วง ${trend.days} วัน`;
  badge.textContent = `${arrow} ${label}`;
}

function renderWeightChart() {
  const withWeight = dailyRecords.filter((d) => d.weight != null);
  const ctx = document.getElementById('weight-chart');
  const labels = withWeight.map((d) => d.date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }));
  const values = withWeight.map((d) => d.weight);

  if (weightChart) {
    weightChart.data.labels = labels;
    weightChart.data.datasets[0].data = values;
    weightChart.update();
    return;
  }

  weightChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'น้ำหนัก (กก.)',
        data: values,
        borderColor: THEME.ink,
        borderWidth: 2.5,
        backgroundColor: (c) => areaGradient(c, 'rgba(216,243,79,0.55)'),
        pointBackgroundColor: THEME.ink,
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        tension: 0.4,
        fill: true,
        pointRadius: (c) => (c.dataIndex === c.dataset.data.length - 1 ? 6 : 0),
        pointHoverRadius: 6,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: tooltipStyle((item) => `${item.parsed.y.toFixed(1)} กก.`),
      },
      scales: {
        y: {
          ticks: { color: THEME.inkFaint, font: { size: 11 } },
          grid: { color: THEME.line, drawTicks: false },
          border: { display: false },
        },
        x: {
          ticks: { color: THEME.inkFaint, maxRotation: 0, autoSkip: true, font: { size: 11 } },
          grid: { display: false },
          border: { display: false },
        },
      },
    },
  });
}

// ===== Weekly calories-vs-target (%) =====
function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - d.getDay()); // Sunday-first, matching the calendar page
  return d;
}

function barColorForPct(pct) {
  if (pct == null) return THEME.surface2;
  if (pct < 90) return THEME.blue;
  if (pct <= 110) return THEME.lime;
  return THEME.pinkDeepSoft;
}

function renderCaloriePercentChart() {
  const start = startOfWeek(weekCursor);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return d;
  });

  const recordMap = new Map(dailyRecords.map((r) => [dateKey(r.date), r]));
  const pcts = days.map((d) => {
    const rec = recordMap.get(dateKey(d));
    if (!rec || !rec.caloriesIn) return null;
    const target = getNutritionTarget(d);
    return Math.round((rec.caloriesIn / target.calories) * 100);
  });

  const endOfWeek = days[6];
  document.getElementById('week-label').textContent =
    `${start.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })} – ${endOfWeek.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' })}`;

  const labels = days.map((d, i) => `${DOW_TH[i]} ${d.getDate()}`);
  const colors = pcts.map(barColorForPct);
  const maxPct = Math.max(120, ...pcts.filter((p) => p != null));

  if (calPctChart) {
    calPctChart.data.labels = labels;
    calPctChart.data.datasets[0].data = pcts;
    calPctChart.data.datasets[0].backgroundColor = colors;
    calPctChart.options.scales.y.max = Math.ceil((maxPct + 15) / 10) * 10;
    calPctChart.update();
    return;
  }

  calPctChart = new Chart(document.getElementById('calpct-chart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: '% ของเป้าหมาย', data: pcts, backgroundColor: colors, borderRadius: 10, borderSkipped: false, maxBarThickness: 34 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 22 } },
      plugins: {
        legend: { display: false },
        tooltip: tooltipStyle((item) => `${item.parsed.y}% ของเป้าหมาย`),
      },
      scales: {
        y: {
          beginAtZero: true,
          max: Math.ceil((maxPct + 15) / 10) * 10,
          ticks: { color: THEME.inkFaint, font: { size: 11 }, callback: (v) => `${v}%` },
          grid: { color: THEME.line, drawTicks: false },
          border: { display: false },
        },
        x: {
          ticks: { color: THEME.inkFaint, font: { size: 11 } },
          grid: { display: false },
          border: { display: false },
        },
      },
    },
    plugins: [targetLinePlugin, barValueLabelPlugin],
  });
}

function changeWeek(delta) {
  weekCursor = new Date(weekCursor.getFullYear(), weekCursor.getMonth(), weekCursor.getDate() + delta * 7);
  renderCaloriePercentChart();
}

function renderHomeWorkoutCalendar() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const grid = document.getElementById('home-cal-grid');
  const label = document.getElementById('home-cal-label');
  label.textContent = now.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });

  grid.innerHTML = '';
  DOW_TH.forEach((d) => {
    const el = document.createElement('div');
    el.className = 'mini-dow';
    el.textContent = d;
    grid.appendChild(el);
  });

  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dateKey(now);
  const recordMap = new Map(dailyRecords.map((r) => [dateKey(r.date), r]));

  for (let i = 0; i < firstDow; i++) {
    const el = document.createElement('div');
    el.className = 'mini-day empty';
    grid.appendChild(el);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const key = dateKey(new Date(year, month, day));
    const rec = recordMap.get(key);
    const el = document.createElement('div');
    el.className = 'mini-day';
    if (rec && rec.isWorkout) el.classList.add('workout');
    if (key === todayKey) el.classList.add('today');
    el.textContent = day;
    grid.appendChild(el);
  }

  const thisMonthCount = dailyRecords.filter(
    (d) => d.isWorkout && d.date.getFullYear() === year && d.date.getMonth() === month
  ).length;
  document.getElementById('home-cal-caption').textContent =
    `เดือนนี้ออกกำลังกาย ${thisMonthCount} วัน · รวมทั้งหมด ${dailyRecords.filter((d) => d.isWorkout).length} วัน`;
}

let currentNutritionDay = null; // { withData, target } — used by the macro popup

function renderCaloriesCard() {
  const targetValueEl = document.getElementById('cal-target-value');
  const inValueEl = document.getElementById('cal-in-value');
  const dateEl = document.getElementById('calories-date');

  if (colIndex.caloriesIn === -1) {
    targetValueEl.textContent = '—';
    inValueEl.textContent = '—';
    dateEl.textContent = 'ยังไม่มีคอลัมน์แคลอรี่รับเข้าใน Sheet';
    currentNutritionDay = null;
    return;
  }
  const withData = [...dailyRecords].reverse().find((d) => d.caloriesIn > 0);
  if (!withData) {
    targetValueEl.textContent = '—';
    inValueEl.textContent = '—';
    dateEl.textContent = 'ยังไม่มีข้อมูล';
    currentNutritionDay = null;
    return;
  }
  const target = getNutritionTarget(withData.date);
  currentNutritionDay = { withData, target };

  targetValueEl.textContent = `${target.calories.toLocaleString('th-TH')} kcal`;
  inValueEl.textContent = `${Math.round(withData.caloriesIn).toLocaleString('th-TH')} kcal`;

  const isToday = dateKey(withData.date) === dateKey(new Date());
  const dayLabel = isToday ? 'วันนี้' : withData.date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
  dateEl.textContent = `${dayLabel} · ${target.name}`;
}

function macroChipHtml(label, exists, value, compareTarget) {
  if (!exists) {
    return `<div class="macro-chip"><span class="macro-label">${label}</span><span class="macro-remain">ไม่มีข้อมูล</span></div>`;
  }
  if (compareTarget == null) {
    return `<div class="macro-chip"><span class="macro-label">${label}</span><span class="macro-remain">${Math.round(value)}g</span></div>`;
  }
  const remain = compareTarget - value;
  const text = remain >= 0 ? `เหลือ ${Math.round(remain)}g` : `เกิน ${Math.round(-remain)}g`;
  const cls = remain >= 0 ? 'ok' : 'over';
  return `<div class="macro-chip ${cls}"><span class="macro-label">${label}</span><span class="macro-remain">${text}</span></div>`;
}

function openMacroPopup(kind) {
  if (!currentNutritionDay) return;
  const { withData, target } = currentNutritionDay;
  const titleEl = document.getElementById('macro-popup-title');
  const subEl = document.getElementById('macro-popup-sub');
  const gridEl = document.getElementById('macro-popup-grid');

  if (kind === 'target') {
    titleEl.textContent = target.name;
    subEl.textContent = `เป้าหมาย ${target.calories.toLocaleString('th-TH')} kcal/วัน`;
    gridEl.innerHTML = [
      macroChipHtml('คาร์บ', true, target.carb, null),
      macroChipHtml('โปรตีน', true, target.protein, null),
      macroChipHtml('ไขมัน', true, target.fat, null),
    ].join('');
  } else {
    const isToday = dateKey(withData.date) === dateKey(new Date());
    titleEl.textContent = isToday
      ? 'วันนี้'
      : withData.date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
    subEl.textContent = `กินไปแล้ว ${Math.round(withData.caloriesIn).toLocaleString('th-TH')} kcal (เทียบเป้าหมาย ${target.name})`;
    gridEl.innerHTML = [
      macroChipHtml('คาร์บ', colIndex.carb !== -1, withData.carb, target.carb),
      macroChipHtml('โปรตีน', colIndex.protein !== -1, withData.protein, target.protein),
      macroChipHtml('ไขมัน', colIndex.fat !== -1, withData.fat, target.fat),
    ].join('');
  }
  document.getElementById('macro-popup-overlay').hidden = false;
}

function closeMacroPopup() {
  document.getElementById('macro-popup-overlay').hidden = true;
}

function renderStepsCard() {
  const wrap = document.getElementById('steps-card-body');
  if (!stepColumnExists) {
    wrap.innerHTML = `<div class="placeholder-note">ยังไม่มีคอลัมน์ "Step" ใน Sheet นี้<br>เมื่อเพิ่มคอลัมน์ที่มีคำว่า "Step" หรือ "ก้าว" ในหัวตาราง กราฟนี้จะแสดงข้อมูลอัตโนมัติ โดยไม่ต้องแก้โค้ด</div>`;
    return;
  }
  const withSteps = dailyRecords.filter((d) => d.steps != null).slice(-CONFIG.STEPS_WINDOW_DAYS);
  if (withSteps.length === 0) {
    wrap.innerHTML = `<div class="placeholder-note">ยังไม่มีข้อมูล Step ที่บันทึกไว้</div>`;
    return;
  }
  if (!document.getElementById('steps-chart')) {
    wrap.innerHTML = `<div class="chart-wrap small"><canvas id="steps-chart"></canvas></div>`;
  }
  const ctx = document.getElementById('steps-chart');
  const labels = withSteps.map((d) => d.date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }));
  const values = withSteps.map((d) => d.steps);

  if (stepsChart) {
    stepsChart.data.labels = labels;
    stepsChart.data.datasets[0].data = values;
    stepsChart.update();
    return;
  }
  stepsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Step',
        data: values,
        backgroundColor: THEME.pink,
        hoverBackgroundColor: THEME.pinkDeepSoft,
        borderRadius: 8,
        borderSkipped: false,
        maxBarThickness: 22,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: tooltipStyle((item) => `${item.parsed.y.toLocaleString('th-TH')} ก้าว`),
      },
      scales: {
        y: {
          ticks: { color: THEME.inkFaint, font: { size: 11 } },
          grid: { color: THEME.line, drawTicks: false },
          border: { display: false },
        },
        x: {
          ticks: { color: THEME.inkFaint, maxRotation: 0, autoSkip: true, font: { size: 11 } },
          grid: { display: false },
          border: { display: false },
        },
      },
    },
  });
}

function formatScheduleTime(item) {
  if (!item.start) return 'ทั้งวัน';
  return item.end ? `${item.start}–${item.end}` : item.start;
}

function renderTodaySchedule() {
  const wrap = document.getElementById('schedule-body');
  const items = scheduleByDate.get(dateKey(new Date())) || [];
  if (items.length === 0) {
    wrap.innerHTML = `<div class="placeholder-note">วันนี้ไม่มีนัดในปฏิทิน (หรือยังไม่ได้ตั้งค่า Calendar sync)</div>`;
    return;
  }
  wrap.innerHTML = `<div class="sched-row">${items
    .map(
      (it) => `<div class="sched-chip">
        <div class="sched-ico">${it.emoji}</div>
        <div class="sched-label">${it.label}</div>
        <div class="sched-time">${formatScheduleTime(it)}</div>
      </div>`
    )
    .join('')}</div>`;
}

// Mood is stored 1–5; a sheet using a 1–10 scale is mapped down so both work.
const MOOD_FACES = ['😠', '😣', '😐', '🙂', '😄'];

function moodLevel(value) {
  if (value == null) return null;
  const scaled = value > 5 ? Math.round(value / 2) : Math.round(value);
  return Math.min(5, Math.max(1, scaled));
}

function renderMoodCard() {
  const wrap = document.getElementById('mood-body');
  if (colIndex.mood === -1) {
    wrap.innerHTML = `<div class="placeholder-note">ยังไม่มีคอลัมน์ Mood ใน Sheet<br>เพิ่มคอลัมน์ที่หัวตารางมีคำว่า "Mood" หรือ "อารมณ์" แล้วกรอกคะแนน 1–5 (หรือ 1–10) ของแต่ละเช้า การ์ดนี้จะขึ้นให้เอง</div>`;
    return;
  }

  const recordMap = new Map(dailyRecords.map((r) => [dateKey(r.date), r]));
  const today = new Date();
  const cells = [];
  for (let i = 4; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const rec = recordMap.get(dateKey(d));
    const level = moodLevel(rec ? rec.mood : null);
    const dow = DOW_TH[d.getDay()];
    cells.push(
      level
        ? `<div class="mood-cell"><div class="mood-face mood-${level}">${MOOD_FACES[level - 1]}</div><span>${dow}</span></div>`
        : `<div class="mood-cell"><div class="mood-face mood-empty">–</div><span>${dow}</span></div>`
    );
  }
  wrap.innerHTML = `<div class="mood-row">${cells.join('')}</div>`;
}

function renderStatTiles() {
  const now = new Date();
  const monthCount = dailyRecords.filter(
    (d) => d.isWorkout && d.date.getFullYear() === now.getFullYear() && d.date.getMonth() === now.getMonth()
  ).length;
  document.getElementById('tile-workout').textContent = `${monthCount} วัน`;

  const latest = [...dailyRecords].reverse().find((d) => d.caloriesIn > 0);
  const pctEl = document.getElementById('tile-calpct');
  if (!latest) {
    pctEl.textContent = '–';
    return;
  }
  const pct = Math.round((latest.caloriesIn / getNutritionTarget(latest.date).calories) * 100);
  pctEl.textContent = `${pct}%`;
}

function renderHome() {
  renderTodaySchedule();
  renderMoodCard();
  renderTrend();
  renderWeightChart();
  renderCaloriePercentChart();
  renderHomeWorkoutCalendar();
  renderCaloriesCard();
  renderStepsCard();
  renderStatTiles();
}

// ===== Render: Calendar =====
const DOW_TH = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

function renderCalendar() {
  const label = document.getElementById('cal-month-label');
  label.textContent = calendarCursor.toLocaleDateString('th-TH', { month: 'long', year: 'numeric' });

  const grid = document.getElementById('calendar-grid');
  grid.innerHTML = '';
  DOW_TH.forEach((d) => {
    const el = document.createElement('div');
    el.className = 'cal-dow';
    el.textContent = d;
    grid.appendChild(el);
  });

  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = dateKey(new Date());

  const recordMap = new Map(dailyRecords.map((r) => [dateKey(r.date), r]));

  for (let i = 0; i < firstDow; i++) {
    const el = document.createElement('div');
    el.className = 'cal-day empty';
    grid.appendChild(el);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    const key = dateKey(d);
    const rec = recordMap.get(key);
    const planned = rec && rec.plannedTitles && rec.plannedTitles.length > 0;
    const el = document.createElement('div');
    el.className = 'cal-day';
    if (key === todayKey) el.classList.add('today');
    if (planned) el.classList.add('planned');
    if (rec) el.classList.add('clickable');

    let html = `<div class="daynum">${day}</div>`;
    if (rec && rec.isWorkout) html += `<div class="dumbbell" title="ทำจริงแล้ว">🏋️</div>`;
    const sched = scheduleByDate.get(key) || [];
    if (sched.length > 0) {
      const emojis = [...new Set(sched.map((s) => s.emoji))].join('');
      html += `<span class="sched-emojis" title="${sched.map((s) => `${s.label} ${formatScheduleTime(s)}`).join(', ')}">${emojis}</span>`;
    }
    if (planned) html += `<span class="plan-tag">${rec.plannedTitles.join(', ')}</span>`;
    el.innerHTML = html;

    if (rec) {
      el.addEventListener('click', () => showDayDetail(rec));
    }
    grid.appendChild(el);
  }
}

function showDayDetail(rec) {
  const el = document.getElementById('day-detail');
  const dateLabel = rec.date.toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const planned = rec.plannedTitles && rec.plannedTitles.length > 0;
  let html = `<h3>${dateLabel}</h3>`;
  html += `<p><strong>แผนที่วางไว้:</strong> ${planned ? '📋 ' + rec.plannedTitles.join(', ') : 'ไม่ได้วางแผนไว้'}</p>`;
  html += `<p><strong>ทำจริง:</strong> ${rec.isWorkout ? '✅ ' + rec.workoutTypes.join(', ') : 'ไม่มีบันทึก'}</p>`;
  html += `<p><strong>น้ำหนัก:</strong> ${rec.weight != null ? rec.weight.toFixed(1) + ' กก.' : '—'}</p>`;
  if (stepColumnExists) {
    html += `<p><strong>Step:</strong> ${rec.steps != null ? rec.steps.toLocaleString('th-TH') : '—'}</p>`;
  }
  el.innerHTML = html;
  el.hidden = false;
}

function changeMonth(delta) {
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + delta, 1);
  renderCalendar();
  document.getElementById('day-detail').hidden = true;
}

// ===== Render dispatch =====
function renderAll() {
  renderHome();
  renderCalendar();
}

// ===== Nav / routing =====
function showPage(name) {
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('visible', p.id === `page-${name}`));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  window.location.hash = name;
}

function initNav() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => showPage(btn.dataset.page));
  });
  const initial = (window.location.hash || '#home').slice(1);
  showPage(['home', 'calendar', 'photos'].includes(initial) ? initial : 'home');
}

function renderAppHeader() {
  const now = new Date();
  const hour = now.getHours();
  const greeting =
    hour < 12 ? 'สวัสดีตอนเช้า ☀️' : hour < 18 ? 'สวัสดีตอนบ่าย 🌤️' : 'สวัสดีตอนค่ำ 🌙';
  document.getElementById('greet-line').textContent = greeting;
  document.getElementById('today-pill').textContent = now.toLocaleDateString('th-TH', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  Chart.defaults.font.family = "'Prompt', sans-serif";
  Chart.defaults.color = THEME.inkSoft;

  renderAppHeader();
  initNav();
  document.getElementById('cal-prev').addEventListener('click', () => changeMonth(-1));
  document.getElementById('cal-next').addEventListener('click', () => changeMonth(1));
  document.getElementById('week-prev').addEventListener('click', () => changeWeek(-1));
  document.getElementById('week-next').addEventListener('click', () => changeWeek(1));
  document.getElementById('refresh-btn').addEventListener('click', loadData);
  document.getElementById('cal-target-row').addEventListener('click', () => openMacroPopup('target'));
  document.getElementById('cal-in-row').addEventListener('click', () => openMacroPopup('intake'));
  document.getElementById('macro-popup-close').addEventListener('click', closeMacroPopup);
  document.getElementById('macro-popup-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'macro-popup-overlay') closeMacroPopup();
  });
  initPhotoPage();
  startPolling();
});
