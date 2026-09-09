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

// ===== State =====
let dailyRecords = [];   // [{date, weight, isWorkout, workoutTypes:[], steps, caloriesIn, protein, carb, fat}], sorted ascending
let colIndex = { date: -1, workout: -1, weight: -1, step: -1, caloriesIn: -1, protein: -1, carb: -1, fat: -1 };
let stepColumnExists = false;
let weightChart = null;
let stepsChart = null;
let calendarCursor = new Date();       // month currently shown in calendar
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
  const idx = { date: -1, workout: -1, weight: -1, step: -1, caloriesIn: -1, protein: -1, carb: -1, fat: -1 };
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
      map.set(key, { date, weight: null, isWorkout: false, workoutTypes: [], steps: null, caloriesIn: 0, protein: 0, carb: 0, fat: 0 });
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

// ===== Calendar-derived workout days (replaces the Sheet's workout column) =====
// Populated by .github/workflows/sync-calendar.yml every ~3 days from a
// public Google Calendar ICS feed (see scripts/sync_calendar.py). Fetched
// same-origin as a static JSON file to avoid Google's ICS CORS restrictions.
async function fetchCalendarWorkoutDays() {
  try {
    const res = await fetch(`workout-days.json?_=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function applyCalendarWorkoutDays(calendarData) {
  // Calendar data is meant to fully replace the Sheet's "ออกกำลังกาย" column,
  // but until the sync has actually produced at least one day, keep using
  // the Sheet so the app isn't left showing zero workout days.
  const hasCalendarData = calendarData && Array.isArray(calendarData.days) && calendarData.days.length > 0;
  if (!hasCalendarData) return;

  dailyRecords.forEach((r) => {
    r.isWorkout = false;
    r.workoutTypes = [];
  });

  const map = new Map(dailyRecords.map((r) => [dateKey(r.date), r]));
  calendarData.days.forEach((entry) => {
    const [y, m, d] = entry.date.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const key = dateKey(date);
    let rec = map.get(key);
    if (!rec) {
      rec = { date, weight: null, isWorkout: false, workoutTypes: [], steps: null, caloriesIn: 0, protein: 0, carb: 0, fat: 0 };
      dailyRecords.push(rec);
      map.set(key, rec);
    }
    rec.isWorkout = true;
    rec.workoutTypes = entry.titles || [];
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
    applyCalendarWorkoutDays(calendarData);
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
  const trend = computeTrend();
  if (!trend) {
    badge.className = 'trend-badge flat';
    badge.textContent = 'ยังไม่มีข้อมูลน้ำหนักพอสำหรับวิเคราะห์เทรนด์';
    return;
  }
  badge.className = `trend-badge ${trend.direction}`;
  const arrow = trend.direction === 'down' ? '↓' : trend.direction === 'up' ? '↑' : '→';
  const absDiff = Math.abs(trend.diff).toFixed(1);
  const label =
    trend.direction === 'down'
      ? `น้ำหนักลดลง ${absDiff} กก. ในช่วง ${trend.days} วันที่ผ่านมา`
      : trend.direction === 'up'
      ? `น้ำหนักเพิ่มขึ้น ${absDiff} กก. ในช่วง ${trend.days} วันที่ผ่านมา`
      : `น้ำหนักค่อนข้างคงที่ในช่วง ${trend.days} วันที่ผ่านมา`;
  badge.textContent = `${arrow} ${label} (ล่าสุด ${trend.latest.toFixed(1)} กก.)`;
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
        borderColor: '#a6792c',
        backgroundColor: 'rgba(217,173,79,0.25)',
        pointBackgroundColor: '#a6792c',
        tension: 0.3,
        fill: true,
        pointRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { ticks: { color: '#6b5236' }, grid: { color: 'rgba(107,82,54,0.1)' } },
        x: { ticks: { color: '#6b5236', maxRotation: 0, autoSkip: true }, grid: { display: false } },
      },
    },
  });
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
        backgroundColor: 'rgba(92,58,34,0.75)',
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { ticks: { color: '#6b5236' }, grid: { color: 'rgba(107,82,54,0.1)' } },
        x: { ticks: { color: '#6b5236', maxRotation: 0, autoSkip: true }, grid: { display: false } },
      },
    },
  });
}

function renderHome() {
  renderTrend();
  renderWeightChart();
  renderHomeWorkoutCalendar();
  renderCaloriesCard();
  renderStepsCard();
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
    const el = document.createElement('div');
    el.className = 'cal-day';
    if (key === todayKey) el.classList.add('today');
    if (rec && rec.isWorkout) el.classList.add('workout');
    if (rec) el.classList.add('clickable');

    let html = `<div class="daynum">${day}</div>`;
    if (rec && rec.isWorkout) html += `<div class="dumbbell">🏋️</div>`;
    if (rec && rec.weight != null) html += `<span class="weight-tag">${rec.weight.toFixed(1)} กก.</span>`;
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
  let html = `<h3>${dateLabel}</h3>`;
  html += `<p><strong>น้ำหนัก:</strong> ${rec.weight != null ? rec.weight.toFixed(1) + ' กก.' : '—'}</p>`;
  html += `<p><strong>ออกกำลังกาย:</strong> ${rec.isWorkout ? '✅ ' + rec.workoutTypes.join(', ') : 'ไม่มีบันทึก'}</p>`;
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

// ===== Init =====
document.addEventListener('DOMContentLoaded', () => {
  initNav();
  document.getElementById('cal-prev').addEventListener('click', () => changeMonth(-1));
  document.getElementById('cal-next').addEventListener('click', () => changeMonth(1));
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
