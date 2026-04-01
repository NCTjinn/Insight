'use strict';

/* ============================================================
   STATE
============================================================ */
const state={
  parsedDataset:   null,   // { columns, rowCount, downsampled, fileName, suggestions, derivedData }
  charts:          [],
  selectedCards:   new Set(),
  selectionMode:   false,
  timeRange:       '1Y',
  customDateRange: null,
  selectedChartType:'line',
  nextId:          1,
  _worker:         null,
};

/* ============================================================
   TEMPLATE AUTO-DETECTION RULES
   ─────────────────────────────────────────────────────────────
   Each rule maps a set of required column names → a template
   file path. Rules are evaluated in order; the first full match
   wins. Column matching is case-insensitive.

   To add a new rule, append an object to the array:
   {
     columns:  ['ColA', 'ColB'],       // ALL must exist in the dataset
     template: 'templates/my.json',   // path served by your web server
     name:     'My Template',          // label shown in toast messages
   }
============================================================ */
const TEMPLATE_RULES = [
  {
    columns:  ['Type', 'Mbps'],
    template: 'templates/testmynet.json',
    name:     'TestMyNet',
  },
  // ── Add more rules below ───────────────────────────────────
  // {
  //   columns:  ['Date', 'Revenue', 'Region'],
  //   template: 'templates/sales.json',
  //   name:     'Sales Dashboard',
  // },
];

/**
 * Check whether a dataset's column names satisfy a rule's required list.
 * Comparison is case-insensitive so "type" and "TYPE" both match "Type".
 */
function datasetMatchesRule(dataset, rule) {
  const datasetCols = new Set(
    dataset.columns.map(c => c.name.toLowerCase())
  );
  return rule.columns.every(required => datasetCols.has(required.toLowerCase()));
}

/**
 * After a file is parsed, scan TEMPLATE_RULES for a matching rule.
 * If found, fetch its template JSON and apply it; otherwise fall
 * back to the normal suggestion-based initDashboard().
 *
 * Returns a Promise that resolves when the dashboard is ready.
 */
async function detectAndApplyTemplate(dataset) {
  for (const rule of TEMPLATE_RULES) {
    if (!datasetMatchesRule(dataset, rule)) continue;

    // ── Match found ───────────────────────────────────────────
    showToast(`Detected "${rule.name}" layout — loading template…`, 'success');

    try {
      const res = await fetch(rule.template);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tpl = await res.json();

      state.charts  = [];
      state.nextId  = 1;
      document.getElementById('chart-grid').innerHTML = '';

      applyTemplate(tpl);
      console.log(`[Insight] Auto-applied template "${rule.name}" from ${rule.template}`);
    } catch (err) {
      console.error(`[Insight] Failed to load template "${rule.name}":`, err);
      showToast(`Template load failed (${err.message}) — using auto charts`, 'error');
      initDashboard();  // graceful fallback
    }
    return;
  }

  // ── No rule matched — default behaviour ───────────────────
  initDashboard();
}

/* ============================================================
   WORKER ORCHESTRATION
   Spins up parser.worker.js, forwards progress to the overlay,
   and calls onParseComplete() when done.
============================================================ */
function dispatchToWorker(type, payload){
  // Terminate any previous run
  if(state._worker){ state._worker.terminate(); state._worker=null; }

  showParseOverlay('Initialising parser…');

  const worker = new Worker('parser.worker.js');
  state._worker = worker;

  worker.onmessage = function(e){
    const {type:t, payload:p, message, error} = e.data;

    if(t === 'PARSE_PROGRESS'){
      // Stream worker status to overlay AND console
      setParseStatus(message);
      console.log('[Insight Worker]', message);
      return;
    }

    if(t === 'PARSE_COMPLETE'){
      worker.terminate(); state._worker = null;
      hideParseOverlay();
      onParseComplete(p);
      return;
    }

    if(t === 'PARSE_ERROR'){
      worker.terminate(); state._worker = null;
      hideParseOverlay();
      showToast('Parse error: ' + error, 'error');
      console.error('[Insight Worker] PARSE_ERROR:', error);
    }
  };

  worker.onerror = function(err){
    worker.terminate(); state._worker = null;
    hideParseOverlay();
    showToast('Worker crashed: ' + err.message, 'error');
    console.error('[Insight Worker] Uncaught error:', err);
  };

  worker.postMessage({ type, payload });
}

/* ============================================================
   PARSE COMPLETE — called when the worker finishes
============================================================ */
function onParseComplete(dataset){
  state.parsedDataset = dataset;

  // ---- Console verification report ----
  logParsedDataset(dataset);

  document.getElementById('dataset-name').textContent = dataset.fileName;

  // Populate modal axis dropdowns with real column names
  populateAxisDropdowns(dataset.columns);

  showPage('dashboard');
  showToast(`"${dataset.fileName}" loaded — ${dataset.rowCount} rows, ${dataset.columns.length} columns${dataset.downsampled?' (downsampled)':''}`, 'success');

  // Auto-detect a matching template and apply it; falls back to initDashboard()
  detectAndApplyTemplate(dataset);
}

/* ============================================================
   CONSOLE VERIFICATION REPORT
   Call logParsedDataset(state.parsedDataset) in the console
   at any time to re-print the full report.
============================================================ */
function logParsedDataset(ds){
  if(!ds){ console.warn('[Insight] No dataset loaded yet.'); return; }

  console.group('%c[Insight] Parsed Dataset Report', 'color:#00d4aa;font-weight:700;font-size:13px;');
  console.log('File:      ', ds.fileName);
  console.log('Rows:      ', ds.rowCount, ds.downsampled ? `(downsampled to ${ds.columns[0]?.values?.length})` : '');
  console.log('Columns:   ', ds.columns.length);
  console.groupEnd();

  // Per-column breakdown
  console.group('%c[Insight] Columns', 'color:#f59e0b;font-weight:700;');
  ds.columns.forEach((col, i) => {
    const g = `%c  [${i}] "${col.name}"  (${col.role})`;
    const style = col.role==='numeric'   ? 'color:#3fb950;font-weight:600;'
                : col.role==='date' || col.role==='datetime' ? 'color:#0099ff;font-weight:600;'
                :                          'color:#7d8590;font-weight:600;';
    if(col.role === 'numeric' && col.stats){
      const s = col.stats;
      console.groupCollapsed(g, style);
      console.log('Values (first 10):', col.values.slice(0,10));
      console.table({
        mean:         s.mean.toFixed(2),
        median:       s.median.toFixed(2),
        std:          s.std.toFixed(2),
        min:          s.min,
        max:          s.max,
        trend:        s.trend,
        growth_rate:  s.growth_rate !== null ? s.growth_rate.toFixed(2)+'%' : 'n/a',
        peak_index:   s.peakIdx,
        trough_index: s.troughIdx,
      });
      console.groupEnd();
    } else if(col.role === 'date' || col.role === 'datetime'){
      console.groupCollapsed(g, style);
      console.log('Labels (first 10):', col.labels.slice(0,10));
      console.groupEnd();
    } else {
      console.groupCollapsed(g, style);
      console.log('Top categories:', col.categories ? col.categories.slice(0,10) : col.values.slice(0,10));
      console.groupEnd();
    }
  });
  console.groupEnd();

  // Derived data (what gets sent to Gemini)
  console.group('%c[Insight] Derived Data (sent to backend)', 'color:#f85149;font-weight:700;');
  console.log('This is the ONLY data forwarded to the AI. Raw values never leave the browser.');
  console.log(JSON.stringify(ds.derivedData, null, 2));
  console.groupEnd();

  // Chart suggestions
  console.group('%c[Insight] Chart Suggestions', 'color:#00d4aa;font-weight:700;');
  ds.suggestions.forEach((s,i) => console.log(`  [${i}] "${s.title}"  type:${s.type}  x:"${s.xColumn}"  y:"${s.yColumn}"`));
  console.groupEnd();

  console.log('%c[Insight] Tip: call logParsedDataset(state.parsedDataset) to reprint this report.', 'color:#7d8590;font-style:italic;');
}

// Expose helpers for manual console use
window.insight = { state, logParsedDataset: ()=>logParsedDataset(state.parsedDataset) };

/* ============================================================
   LOADING OVERLAY HELPERS
============================================================ */
function showParseOverlay(msg){
  const el=document.getElementById('parse-overlay');
  el.style.display='flex';
  setParseStatus(msg);
}
function hideParseOverlay(){
  document.getElementById('parse-overlay').style.display='none';
}
function setParseStatus(msg){
  document.getElementById('parse-status').textContent=msg;
}

/* ============================================================
   POPULATE AXIS DROPDOWNS from real columns
============================================================ */
function populateAxisDropdowns(columns){
  const xSel=document.getElementById('modal-x-axis');
  const ySel=document.getElementById('modal-y-axis');
  const gbSel=document.getElementById('modal-groupby');
  const statsSel=document.getElementById('modal-stats-col');
  const filterSel=document.getElementById('modal-filter-col');
  xSel.innerHTML='';
  ySel.innerHTML='';
  gbSel.innerHTML='<option value="">None (single series)</option>';
  statsSel.innerHTML='';
  filterSel.innerHTML='<option value="">No filter</option>';
  columns.forEach(col=>{
    const ox=document.createElement('option');
    ox.value=col.name; ox.textContent=`${col.name} (${col.role})`;
    xSel.appendChild(ox);
    const oy=document.createElement('option');
    oy.value=col.name; oy.textContent=`${col.name} (${col.role})`;
    ySel.appendChild(oy);
    // Filter column: all columns
    const of2=document.createElement('option');
    of2.value=col.name; of2.textContent=`${col.name} (${col.role})`;
    filterSel.appendChild(of2);
    // Only categorical columns make sense as group-by keys
    if(col.role==='categorical'){
      const og=document.createElement('option');
      og.value=col.name; og.textContent=`${col.name} (${col.role})`;
      gbSel.appendChild(og);
    }
    // Stats column: prefer numeric, but allow any
    if(col.role==='numeric'){
      const os=document.createElement('option');
      os.value=col.name; os.textContent=`${col.name} (${col.role})`;
      statsSel.appendChild(os);
    }
  });
  // Default: x = first date/datetime/categorical, y = first numeric
  const xDefault=columns.find(c=>c.role!=='numeric');
  const yDefault=columns.find(c=>c.role==='numeric');
  if(xDefault) xSel.value=xDefault.name;
  if(yDefault) ySel.value=yDefault.name;
  if(yDefault) statsSel.value=yDefault.name;
}

/* ============================================================
   THEME
============================================================ */
function toggleTheme(){
  const h=document.documentElement;
  const next=h.getAttribute('data-theme')==='dark'?'light':'dark';
  h.setAttribute('data-theme',next);
  try{localStorage.setItem('insight-theme',next);}catch{}
  state.charts.forEach(c=>{if(c.apexInstance)c.apexInstance.updateOptions(themeOpts(),false,false)});
}
function themeOpts(){
  const d=document.documentElement.getAttribute('data-theme')==='dark';
  return{theme:{mode:d?'dark':'light'},chart:{background:'transparent',foreColor:d?'#7d8590':'#6b7280'},grid:{borderColor:d?'#21282f':'#e5e7eb'},tooltip:{theme:d?'dark':'light'}};
}
// Restore persisted theme before first paint
(function(){try{const t=localStorage.getItem('insight-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t);}catch{}})();

/* ============================================================
   SPA NAVIGATION
============================================================ */
function showPage(n){document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));document.getElementById('page-'+n).classList.add('active');window.scrollTo(0,0);if(n==='upload'){const fi=document.querySelector('#dropzone input[type="file"]');if(fi)fi.value='';const si=document.querySelector('#tab-session input[type="file"]');if(si)si.value='';}}
function switchUploadTab(btn,id){document.querySelectorAll('.upload-tab').forEach(t=>t.classList.remove('active'));document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));btn.classList.add('active');document.getElementById(id).classList.add('active')}

/* ============================================================
   FILE UPLOAD
============================================================ */
function onDragOver(e){e.preventDefault();e.currentTarget.classList.add('drag-over')}
function onDragLeave(e){e.currentTarget.classList.remove('drag-over')}
function onDrop(e){e.preventDefault();e.currentTarget.classList.remove('drag-over');const f=e.dataTransfer.files[0];if(f)processFile(f)}
function handleFileInput(e){const f=e.target.files[0];if(f)processFile(f)}

function processFile(file){
  const ext=file.name.split('.').pop().toLowerCase();
  if(!['xlsx','xls','csv'].includes(ext)){showToast('Unsupported file type. Please use .xlsx, .xls, or .csv','error');return;}
  const reader=new FileReader();
  if(ext==='csv'){
    reader.onload=ev=>dispatchToWorker('PARSE_CSV_TEXT',{text:ev.target.result,fileName:file.name});
    reader.readAsText(file);
  } else {
    reader.onload=ev=>dispatchToWorker('PARSE_EXCEL',{buffer:ev.target.result,fileName:file.name});
    reader.readAsArrayBuffer(file);
  }
}

function handleSheetsURL(){
  const raw=document.getElementById('sheets-url').value.trim();
  if(!raw||!raw.includes('docs.google.com/spreadsheets')){showToast('Please enter a valid Google Sheets URL','error');return;}
  const idMatch=raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  const gidMatch=raw.match(/[#&?]gid=(\d+)/);
  if(!idMatch){showToast('Could not extract spreadsheet ID from URL','error');return;}
  const csvUrl=`https://docs.google.com/spreadsheets/d/${idMatch[1]}/export?format=csv&gid=${gidMatch?gidMatch[1]:'0'}`;
  showParseOverlay('Fetching Google Sheet…');
  fetch(csvUrl)
    .then(r=>{if(!r.ok)throw new Error(`HTTP ${r.status} — ensure the sheet is set to "Anyone with the link can view".`);return r.text();})
    .then(text=>dispatchToWorker('PARSE_CSV_TEXT',{text,fileName:`sheets_${idMatch[1].slice(0,8)}.csv`}))
    .catch(err=>{hideParseOverlay();showToast('Failed to fetch sheet: '+err.message,'error');console.error('[Insight] Sheets fetch error:',err);});
}

function handleSessionLoad(e){const f=e.target.files[0];if(!f)return;const r=new FileReader();r.onload=ev=>{try{loadSession(JSON.parse(ev.target.result))}catch{showToast('Invalid session file','error')}};r.readAsText(f)}

/* ============================================================
   DASHBOARD INIT
============================================================ */
function initDashboard(){
  state.charts=[];state.nextId=1;
  document.getElementById('chart-grid').innerHTML='';

  // Real data: use suggestions from the worker
  const suggs=state.parsedDataset.suggestions;
  if(suggs.length===0){
    showToast('No chart suggestions could be generated. Try adding one manually.','error');
    return;
  }
  suggs.forEach(s=>addChart({title:s.title,type:s.type,xColumn:s.xColumn,yColumn:s.yColumn}));
}

/* ============================================================
   CHART ADD / REMOVE
============================================================ */
function addChart(opts){
  const id='chart-'+(state.nextId++);
  const entry={
    id,
    title:    opts.title||'New Chart',
    type:     opts.type||'line',
    // Regular chart keys
    xColumn:  opts.xColumn||null,
    yColumn:  opts.yColumn||null,
    groupByColumn: opts.groupByColumn||null,
    // Stats card keys
    statColumn:  opts.statColumn||null,
    statMetric:  opts.statMetric||'mean',
    // Filter
    filterColumn:   opts.filterColumn||null,
    filterOperator: opts.filterOperator||'=',
    filterValue:    opts.filterValue||'',
    apexInstance:null,summaryText:null,summaryLoaded:false,
  };
  state.charts.push(entry);
  const card=buildCardDOM(entry);
  document.getElementById('chart-grid').appendChild(card);
  requestAnimationFrame(()=>{initApexChart(entry);setupCardDrag(card)});
  return entry;
}
function removeChart(id){
  const i=state.charts.findIndex(c=>c.id===id);if(i===-1)return;
  state.charts[i].apexInstance?.destroy();
  state.charts.splice(i,1);
  document.getElementById(id)?.remove();
  showToast('Chart removed','success');
}
function buildCardDOM(entry){
  const card=document.createElement('div');
  const isStats = entry.type === 'stats';
  card.className = `chart-card ${isStats ? 'stats-card-variant' : ''}`;
  
  card.id=entry.id;
  card.setAttribute('draggable','true');
  card.setAttribute('data-id',entry.id);

  // Hint text below title
  let titleHint = 'Click title to edit';
  if (entry.type === 'stats') {
    const metricLabels={mean:'Mean',median:'Median',mode:'Mode',min:'Min',max:'Max'};
    titleHint = `${metricLabels[entry.statMetric]||entry.statMetric} of <strong>${entry.statColumn||'—'}</strong>`;
    if (entry.filterColumn && entry.filterValue !== '') {
      titleHint += ` · ${entry.filterColumn} ${entry.filterOperator} "${entry.filterValue}"`;
    }
  } else if (entry.groupByColumn) {
    titleHint = `Grouped by <strong>${entry.groupByColumn}</strong>`;
    if (entry.filterColumn && entry.filterValue !== '') {
      titleHint += ` · filtered`;
    }
  } else if (entry.filterColumn && entry.filterValue !== '') {
    titleHint = `Filtered: ${entry.filterColumn} ${entry.filterOperator} "${entry.filterValue}"`;
  }

  const bodyContent = isStats
    ? `<div class="stats-card-body" id="stats-${entry.id}">
        <div class="stats-metric-label" id="stats-metric-${entry.id}">—</div>
        <div class="stats-value" id="stats-value-${entry.id}">—</div>
        <div class="stats-column-label" id="stats-col-label-${entry.id}"></div>
        <div id="stats-filter-pill-${entry.id}"></div>
      </div>`
    : `<div class="card-chart" id="apex-${entry.id}"></div>`;
  
  const aiSection = isStats ? '' : `
    <div class="card-ai-section">
      <button class="ai-generate-btn" id="ai-btn-${entry.id}" onclick="generateSummary('${entry.id}')">
        <span class="ai-icon">✦</span>Generate AI summary
      </button>
      <div class="ai-skeleton" id="ai-skeleton-${entry.id}">
        <div class="skeleton-line" style="width:85%"></div>
        <div class="skeleton-line" style="width:93%"></div>
        <div class="skeleton-line"></div>
      </div>
      <div class="ai-summary-box" id="ai-summary-${entry.id}"></div>
      <div class="ai-error-box" id="ai-error-${entry.id}">⚠️ Failed to generate summary. Please try again — your dashboard is unaffected.</div>
    </div>`;

  card.innerHTML=`
    <input type="checkbox" class="card-checkbox" id="chk-${entry.id}" onchange="toggleCardSelection('${entry.id}')" />
    <div class="card-inner">
      <div class="card-header">
        <div class="card-title-wrap">
          <div class="card-title" contenteditable="true" spellcheck="false"
               onblur="updateChartTitle('${entry.id}',this.textContent)">${entry.title}</div>
          <div class="card-title-hint">${titleHint}</div>
        </div>
        <div class="card-actions">
          <span class="drag-handle" title="Drag to reorder">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/>
              <circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/>
              <circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>
            </svg>
          </span>
          <button class="card-resize-btn" onclick="toggleCardSize('${entry.id}')" data-tip="Expand/collapse">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
          </button>
          <div class="dropdown" id="card-dd-${entry.id}">
            <button class="card-resize-btn" onclick="toggleDropdown('card-dd-${entry.id}')" data-tip="More options">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="5" r="1" fill="currentColor"/>
                <circle cx="12" cy="12" r="1" fill="currentColor"/>
                <circle cx="12" cy="19" r="1" fill="currentColor"/>
              </svg>
            </button>
            <div class="dropdown-menu" id="card-dd-${entry.id}-menu">
              <button class="dropdown-item" onclick="exportCardPDF('${entry.id}'); closeAllDropdowns()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                Export as PDF
              </button>
              <button class="dropdown-item" onclick="exportCardImage('${entry.id}'); closeAllDropdowns()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>
                Export as Image
              </button>
              <div class="dropdown-separator"></div>
              <button class="dropdown-item" style="color:var(--danger)" onclick="removeChart('${entry.id}'); closeAllDropdowns()">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/></svg>
                Remove chart
              </button>
            </div>
          </div>
        </div>
      </div>
      ${bodyContent}
      ${aiSection}
    </div>`;
  return card;
}

/* ============================================================
   ROW FILTER HELPER
   Returns a Set of row indices that pass entry's filter,
   or null if no filter is configured.
============================================================ */
function getFilteredRowSet(entry) {
  const ds = state.parsedDataset;
  if (!ds || !entry.filterColumn || entry.filterValue === '' || entry.filterValue == null) return null;
  const fCol = ds.columns.find(c => c.name === entry.filterColumn);
  if (!fCol) return null;
  const op  = entry.filterOperator || '=';
  const fVal = String(entry.filterValue);
  const fNum = parseFloat(fVal);
  const set  = new Set();
  fCol.values.forEach((v, i) => {
    const vStr = String(v ?? '');
    const vNum = parseFloat(v);
    let match = false;
    if (op === '=')  match = vStr === fVal || (isFinite(vNum) && isFinite(fNum) && vNum === fNum);
    else if (op === '<')  match = isFinite(vNum) && isFinite(fNum) && vNum < fNum;
    else if (op === '>')  match = isFinite(vNum) && isFinite(fNum) && vNum > fNum;
    else if (op === '<=') match = isFinite(vNum) && isFinite(fNum) && vNum <= fNum;
    else if (op === '>=') match = isFinite(vNum) && isFinite(fNum) && vNum >= fNum;
    if (match) set.add(i);
  });
  return set;
}

/* ============================================================
   STATS CARD COMPUTATION & RENDER
============================================================ */
function computeStatsValue(entry) {
  const ds = state.parsedDataset;
  if (!ds || !entry.statColumn) return null;
  const col = ds.columns.find(c => c.name === entry.statColumn);
  if (!col) return null;

  const filterSet = getFilteredRowSet(entry);
  let rawValues = col.values;
  if (filterSet !== null) rawValues = col.values.filter((_, i) => filterSet.has(i));

  const nums = rawValues.map(v => typeof v === 'number' ? v : parseFloat(v)).filter(v => isFinite(v));
  if (nums.length === 0) return { value: null, count: 0 };

  const metric = entry.statMetric || 'mean';
  let value;
  if (metric === 'mean')   value = nums.reduce((a, b) => a + b, 0) / nums.length;
  else if (metric === 'median') {
    const s = [...nums].sort((a, b) => a - b);
    const n = s.length;
    value = n % 2 === 0 ? (s[n/2-1] + s[n/2]) / 2 : s[Math.floor(n/2)];
  }
  else if (metric === 'mode') {
    const freq = new Map();
    nums.forEach(v => freq.set(v, (freq.get(v) || 0) + 1));
    let maxF = 0; value = nums[0];
    freq.forEach((f, v) => { if (f > maxF) { maxF = f; value = v; } });
  }
  else if (metric === 'min') value = Math.min(...nums);
  else if (metric === 'max') value = Math.max(...nums);
  return { value, count: nums.length };
}

function renderStatsCard(entry) {
  const result = computeStatsValue(entry);
  const metricLabels = { mean:'Mean', median:'Median', mode:'Mode', min:'Minimum', max:'Maximum' };

  const metricEl   = document.getElementById('stats-metric-' + entry.id);
  const valueEl    = document.getElementById('stats-value-'  + entry.id);
  const colLabelEl = document.getElementById('stats-col-label-' + entry.id);
  const pillEl     = document.getElementById('stats-filter-pill-' + entry.id);

  if (!valueEl) return;

  const metricName = metricLabels[entry.statMetric] || entry.statMetric || 'Mean';
  if (metricEl)   metricEl.textContent = metricName;
  if (colLabelEl) colLabelEl.textContent = entry.statColumn || '—';

  if (!result || result.value === null) {
    valueEl.textContent = '—';
    return;
  }

  // Format number
  const v = result.value;
  let display;
  if (Math.abs(v) >= 1e9)       display = (v / 1e9).toFixed(2) + 'B';
  else if (Math.abs(v) >= 1e6)  display = (v / 1e6).toFixed(2) + 'M';
  else if (Math.abs(v) >= 1000) display = (v / 1000).toFixed(1) + 'K';
  else if (Number.isInteger(v)) display = v.toLocaleString();
  else                           display = +v.toFixed(4) % 1 === 0 ? v.toFixed(0) : parseFloat(v.toFixed(2)).toLocaleString(undefined,{minimumFractionDigits:0,maximumFractionDigits:2});
  valueEl.textContent = display;

  if (pillEl) {
    if (entry.filterColumn && entry.filterValue !== '') {
      pillEl.innerHTML = `<span class="stats-filter-pill">
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
        ${entry.filterColumn} ${entry.filterOperator} "${entry.filterValue}"
      </span>`;
    } else {
      pillEl.innerHTML = '';
    }
  }
}

/* ============================================================
   GET CHART DATA
   Returns { labels, values, raw } for both real and demo data.
   For real data, pairs xColumn (labels) with yColumn (values).
============================================================ */
function getPointLimit(id) {
  const card = document.getElementById(id);
  const width = card ? card.offsetWidth : 600;
  const entry = state.charts.find(c => c.id === id);
  const xCol  = entry && state.parsedDataset
    ? state.parsedDataset.columns.find(c => c.name === entry.xColumn)
    : null;
  // Datetime axes carry unique per-second timestamps — allow more points so
  // no measurements are hidden.  Regular date/cat axes use the coarser limit.
  const pixelsPerPoint = (xCol?.role === 'datetime') ? 30 : 60;
  return Math.max(6, Math.floor(width / pixelsPerPoint));
}

function getChartData(entry) {
  const ds = state.parsedDataset;
  if (!ds) return { labels: [], values: [] };

  const xCol = ds.columns.find(c => c.name === entry.xColumn);
  const yCol = ds.columns.find(c => c.name === entry.yColumn);
  
  if (!xCol || !yCol) return { labels: [], values: [] };

  // Pre-compute row filter set (null = no filter, include all rows)
  const filterSet = getFilteredRowSet(entry);

  let labels = xCol.labels;
  let values = yCol.values.map(v => typeof v === 'number' ? v : parseFloat(v) || 0);

  // Track whether a time-range slice already happened (so we know if we need
  // to apply the row filter separately afterwards).
  let sliced = false;

  // 1. Time range slicing
  if ((xCol.role === 'date' || xCol.role === 'datetime') && xCol.values.length > 0) {
    // ── Date / Datetime x-axis: filter directly on xCol timestamps ───────────
    const limits = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, 'ALL': Infinity };
    const days = state.timeRange === 'CUSTOM' && state.customDateRange
      ? dateDiffDays(state.customDateRange.from, state.customDateRange.to)
      : (limits[state.timeRange] || Infinity);

    if (days < Infinity) {
      let idxs;
      if (state.timeRange === 'CUSTOM' && state.customDateRange) {
        const fromMs = new Date(state.customDateRange.from).getTime();
        const toMs   = new Date(state.customDateRange.to).getTime() + 86399999;
        idxs = xCol.values.map((v, i) => ({ v, i })).filter(({ v }) => v !== null && v >= fromMs && v <= toMs).map(({ i }) => i);
      } else {
        const maxDateInData = Math.max(...xCol.values.filter(v => v !== null));
        const cutoff = maxDateInData - (days * 86400000);
        idxs = xCol.values.map((v, i) => ({ v, i })).filter(({ v }) => v !== null && v >= cutoff).map(({ i }) => i);
      }
      if (filterSet !== null) idxs = idxs.filter(i => filterSet.has(i));
      labels = idxs.map(i => xCol.labels[i]);
      values = idxs.map(i => yCol.values[i] || 0);
      sliced = true;
    }
  } else if (xCol.role === 'categorical') {
    // ── Categorical x-axis (bar / donut): locate a date column and use it
    //    to filter rows before aggregation, so the time range control works. ──
    const dateCol = ds.columns.find(c => c.role === 'date');
    if (dateCol && dateCol.values.length > 0) {
      const limits = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, 'ALL': Infinity };
      const days = state.timeRange === 'CUSTOM' && state.customDateRange
        ? dateDiffDays(state.customDateRange.from, state.customDateRange.to)
        : (limits[state.timeRange] || Infinity);

      if (days < Infinity) {
        let idxs;
        if (state.timeRange === 'CUSTOM' && state.customDateRange) {
          const fromMs = new Date(state.customDateRange.from).getTime();
          const toMs   = new Date(state.customDateRange.to).getTime() + 86399999;
          idxs = dateCol.values.map((v, i) => ({ v, i })).filter(({ v }) => v !== null && v >= fromMs && v <= toMs).map(({ i }) => i);
        } else {
          const maxDate = Math.max(...dateCol.values.filter(v => v !== null));
          const cutoff  = maxDate - (days * 86400000);
          idxs = dateCol.values.map((v, i) => ({ v, i })).filter(({ v }) => v !== null && v >= cutoff).map(({ i }) => i);
        }
        if (filterSet !== null) idxs = idxs.filter(i => filterSet.has(i));
        labels = idxs.map(i => xCol.labels ? xCol.labels[i] : String(xCol.values[i]));
        values = idxs.map(i => yCol.values[i] || 0);
        sliced = true;
      }
    }
  }

  // If no time-range slice happened but a row filter is active, apply it now.
  if (!sliced && filterSet !== null) {
    const totalRows = xCol.values ? xCol.values.length : (xCol.labels ? xCol.labels.length : 0);
    const idxs = Array.from({length: totalRows}, (_, i) => i).filter(i => filterSet.has(i));
    labels = idxs.map(i => xCol.labels ? xCol.labels[i] : String(xCol.values?.[i] ?? ''));
    values = idxs.map(i => { const v = yCol.values[i]; return typeof v === 'number' ? v : parseFloat(v) || 0; });
  }

  // 2. AGGREGATION: Group values by label to prevent chart clutter.
  //    For 'datetime' columns every label already encodes a unique timestamp, so
  //    aggregation would falsely collapse points that happen to land on the same
  //    second. Skip it and return the rows as-is.
  if (xCol.role === 'datetime') {
    const limit = getPointLimit(entry.id);
    return {
      labels: labels.slice(0, limit),
      values: values.slice(0, limit),
    };
  }

  const aggMap = new Map();
  labels.forEach((l, i) => {
    const val = values[i] || 0;
    aggMap.set(l, (aggMap.get(l) || 0) + val);
  });
  
  const finalLabels = Array.from(aggMap.keys());
  const finalValues = Array.from(aggMap.values());

  const limit = getPointLimit(entry.id);
  return {
    labels: finalLabels.slice(0, limit),
    values: finalValues.slice(0, limit)
  };
}

function dateDiffDays(from,to){
  return Math.abs(new Date(to)-new Date(from))/86400000;
}

/* ============================================================
   GET COMBINED (MULTI-SERIES) CHART DATA
   Used when entry.groupByColumn is set.
   Returns { labels, series: [{name, data}] } where every series
   shares the same x-axis labels array.
============================================================ */
function getCombinedChartData(entry) {
  const ds = state.parsedDataset;
  if (!ds) return { labels: [], series: [] };

  const xCol      = ds.columns.find(c => c.name === entry.xColumn);
  const yCol      = ds.columns.find(c => c.name === entry.yColumn);
  const groupCol  = ds.columns.find(c => c.name === entry.groupByColumn);

  if (!xCol || !yCol || !groupCol) return { labels: [], series: [] };

  // --- 1. Build index list (optionally time-filtered + row-filtered) ---
  let idxs = xCol.values.map((_, i) => i);

  // Apply row filter first
  const filterSet = getFilteredRowSet(entry);
  if (filterSet !== null) idxs = idxs.filter(i => filterSet.has(i));

  if (xCol.role === 'date' || xCol.role === 'datetime') {
    const limits = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, 'ALL': Infinity };
    const days = state.timeRange === 'CUSTOM' && state.customDateRange
      ? dateDiffDays(state.customDateRange.from, state.customDateRange.to)
      : (limits[state.timeRange] || Infinity);

    if (days < Infinity) {
      if (state.timeRange === 'CUSTOM' && state.customDateRange) {
        const fromMs = new Date(state.customDateRange.from).getTime();
        const toMs   = new Date(state.customDateRange.to).getTime() + 86399999;
        idxs = idxs.filter(i => xCol.values[i] !== null && xCol.values[i] >= fromMs && xCol.values[i] <= toMs);
      } else {
        const maxDate = Math.max(...xCol.values.filter(v => v !== null));
        const cutoff  = maxDate - (days * 86400000);
        idxs = idxs.filter(i => xCol.values[i] !== null && xCol.values[i] >= cutoff);
      }
    }
  } else if (xCol.role === 'categorical') {
    // Filter by date column if one exists
    const dateCol = ds.columns.find(c => c.role === 'date');
    if (dateCol && dateCol.values.length > 0) {
      const limits = { '1M': 30, '3M': 90, '6M': 180, '1Y': 365, 'ALL': Infinity };
      const days = state.timeRange === 'CUSTOM' && state.customDateRange
        ? dateDiffDays(state.customDateRange.from, state.customDateRange.to)
        : (limits[state.timeRange] || Infinity);
      if (days < Infinity) {
        if (state.timeRange === 'CUSTOM' && state.customDateRange) {
          const fromMs = new Date(state.customDateRange.from).getTime();
          const toMs   = new Date(state.customDateRange.to).getTime() + 86399999;
          idxs = idxs.filter(i => dateCol.values[i] !== null && dateCol.values[i] >= fromMs && dateCol.values[i] <= toMs);
        } else {
          const maxDate = Math.max(...dateCol.values.filter(v => v !== null));
          const cutoff  = maxDate - (days * 86400000);
          idxs = idxs.filter(i => dateCol.values[i] !== null && dateCol.values[i] >= cutoff);
        }
      }
    }
  }

  // --- 2. Build { groupKey → { xLabel → aggregatedValue } } map ---
  // Preserve insertion order so series are in the order they first appear
  const groupMap = new Map(); // groupKey → Map(xLabel → sum)
  const xLabelSet = new Map(); // xLabel → original x-value (for ordering)

  idxs.forEach(i => {
    const xLabel   = xCol.labels ? xCol.labels[i] : String(xCol.values[i]);
    const yVal     = typeof yCol.values[i] === 'number' ? yCol.values[i] : (parseFloat(yCol.values[i]) || 0);
    const groupKey = String(groupCol.values[i] ?? '(Empty)');

    if (!xLabelSet.has(xLabel)) xLabelSet.set(xLabel, xCol.values[i]);
    if (!groupMap.has(groupKey)) groupMap.set(groupKey, new Map());
    const inner = groupMap.get(groupKey);
    inner.set(xLabel, (inner.get(xLabel) || 0) + yVal);
  });

  // --- 3. Sort x labels ---
  // For datetime, they are already chronological. For date/categorical, sort by first occurrence.
  let allLabels;
  if (xCol.role === 'datetime') {
    // Preserve order as they appear in the filtered index (already time-sorted)
    allLabels = [];
    const seen = new Set();
    idxs.forEach(i => {
      const l = xCol.labels[i];
      if (!seen.has(l)) { seen.add(l); allLabels.push(l); }
    });
  } else {
    allLabels = Array.from(xLabelSet.keys());
  }

  // --- 4. Point-limit: use the widest card estimate ---
  const card = document.getElementById(entry.id);
  const width = card ? card.offsetWidth : 600;
  const pixelsPerPoint = (xCol.role === 'datetime') ? 30 : 60;
  const limit = Math.max(6, Math.floor(width / pixelsPerPoint));
  allLabels = allLabels.slice(0, limit);

  // --- 5. Build series array ---
  const series = Array.from(groupMap.entries()).map(([groupKey, innerMap]) => ({
    name: groupKey,
    data: allLabels.map(l => innerMap.get(l) ?? null),
  }));

  return { labels: allLabels, series };
}

/* ============================================================
   APEX CHARTS
============================================================ */
function initApexChart(entry){
  // Stats card — no ApexCharts needed, render the stat value directly
  if (entry.type === 'stats') {
    renderStatsCard(entry);
    return;
  }

  const d=document.documentElement.getAttribute('data-theme')==='dark';
  const ac='#00d4aa',ac2='#f59e0b',dng='#f85149',suc='#3fb950';
  const PALETTE=[ac,'#0099ff','#7c3aed',ac2,suc,dng,'#ec4899','#14b8a6','#f97316','#8b5cf6'];

  // Smart value formatter: detect currency vs plain number vs large int
  const isRevEntry = entry.yColumn && /revenue|sales|amount|price|cost|profit|income/i.test(entry.yColumn);
  const fmt = v => {
    if(isRevEntry) return '$'+(v>=1e6?(v/1e6).toFixed(1)+'M':v>=1000?(v/1000).toFixed(0)+'K':v);
    return v>=1000?(v/1000).toFixed(1)+'K':String(v);
  };

  const base={
    chart:{type:entry.type==='donut'?'donut':entry.type,background:'transparent',foreColor:d?'#7d8590':'#6b7280',toolbar:{show:false},animations:{enabled:true,speed:500},fontFamily:"'Outfit',sans-serif",height:240},
    theme:{mode:d?'dark':'light'},
    grid:{borderColor:d?'#21282f':'#e5e7eb',strokeDashArray:3,padding:{left:10,right:10,top:0,bottom:0}},
    stroke:{curve:'smooth',width:2},dataLabels:{enabled:false},
    tooltip:{theme:d?'dark':'light',style:{fontFamily:"'Outfit',sans-serif",fontSize:'12px'},y:{formatter:fmt}},
  };

  // ── COMBINED (multi-series) chart ────────────────────────────────────────────
  if (entry.groupByColumn && entry.type !== 'donut') {
    const { labels, series } = getCombinedChartData(entry);

    const xCol = state.parsedDataset
      ? state.parsedDataset.columns.find(c => c.name === entry.xColumn)
      : null;
    const isDatetime = xCol?.role === 'datetime';

    let xFormatter = undefined;
    if (isDatetime && labels.length > 0) {
      const firstDate = labels[0]?.split(',')[0];
      const allSameDay = labels.every(l => l.split(',')[0] === firstDate);
      xFormatter = allSameDay
        ? (val) => { if (!val || typeof val !== 'string') return val; return val.replace(/^[A-Za-z]+ \d+,\s*/, ''); }
        : (val) => { if (!val || typeof val !== 'string') return val; return val.replace(/:\d{2}\s*(AM|PM)/i, ' $1'); };
    }

    const opts = {
      ...base,
      series,
      colors: PALETTE,
      legend: { show: true, position: 'top', fontSize: '12px', fontFamily: "'Outfit',sans-serif", labels: { colors: d ? '#7d8590' : '#6b7280' } },
      xaxis: {
        type: 'category',
        categories: labels,
        labels: {
          style: { fontSize: '11px', fontFamily: "'Outfit',sans-serif" },
          rotate: -35,
          rotateAlways: isDatetime || labels.length > 12,
          formatter: xFormatter,
        },
        axisBorder: { show: false },
        axisTicks:  { show: false },
      },
      yaxis: { labels: { style: { fontSize: '11px', fontFamily: "'Outfit',sans-serif" }, formatter: fmt } },
      fill: entry.type === 'area'
        ? { type: 'gradient', gradient: { shadeIntensity: 1, opacityFrom: .35, opacityTo: .01, stops: [0, 100] } }
        : {},
      plotOptions: entry.type === 'bar'
        ? { bar: { borderRadius: 3, columnWidth: '60%', distributed: false } }
        : {},
      // Prevent ghost markers: disable dynamic animation and suppress hover/active
      // colour filters which cause SVG elements to linger after mouse-out.
      // Extra left grid padding stops the clip-path from cutting off the first
      // 1–2 marker circles that sit right at the chart edge.
      chart: {
        ...base.chart,
        animations: { enabled: true, speed: 500, dynamicAnimation: { enabled: false } },
      },
      grid: {
        ...base.grid,
        padding: { left: 16, right: 10, top: 0, bottom: 0 },
      },
      markers: {
        size: 4,
        colors: Array(30).fill('#111827'),
        strokeColors: '#ffffff',
        strokeWidth: 2,
        hover: { size: 5, sizeOffset: 0 },
      },
      states: {
        hover:  { filter: { type: 'none' } },
        active: { filter: { type: 'none' } },
      },
    };

    const el = document.getElementById('apex-' + entry.id); if (!el) return;
    const apex = new ApexCharts(el, opts); apex.render(); entry.apexInstance = apex;
    return;
  }

  // ── SINGLE-SERIES chart (original behaviour) ─────────────────────────────────
  const{labels,values}=getChartData(entry);

  let opts;
  if(entry.type === 'donut') {
    // Extract specific categorical counts for the donut
    const donutData = getChartData(entry);
    opts = {
      ...base,
      series: donutData.values,
      labels: donutData.labels,
      legend:{show:false},
      colors: [ac, ac2, '#0099ff', '#7c3aed', suc, dng],
      plotOptions: {
        pie: {
          donut: {
            size: '68%',
            labels: {
              show: true,
              total: {
                show: true,
                label: 'Total',
                formatter: w => {
                  const t = w.globals.seriesTotals.reduce((a, b) => a + b, 0);
                  return t >= 1000 ? (t / 1000).toFixed(1) + 'K' : t.toLocaleString();
                }
              }
            }
          }
        }
      }
    };
  } else {
    // Detect if the x column is a datetime so we can apply smarter axis formatting.
    const xCol = state.parsedDataset
      ? state.parsedDataset.columns.find(c => c.name === entry.xColumn)
      : null;
    const isDatetime = xCol?.role === 'datetime';

    // For datetime axes: determine whether all visible points share the same calendar
    // day so the axis tick can drop the date portion and show only the time.
    let xFormatter = undefined;
    if (isDatetime && labels.length > 0) {
      const firstDate = labels[0]?.split(',')[0]; // e.g. "Mar 29"
      const allSameDay = labels.every(l => l.split(',')[0] === firstDate);
      if (allSameDay) {
        xFormatter = (val) => {
          if (!val || typeof val !== 'string') return val;
          const timePart = val.replace(/^[A-Za-z]+ \d+,\s*/, '');
          return timePart;
        };
      } else {
        xFormatter = (val) => {
          if (!val || typeof val !== 'string') return val;
          return val.replace(/:\d{2}\s*(AM|PM)/i, ' $1');
        };
      }
    }

    opts={...base,series:[{name:entry.yColumn||entry.title,data:values}],
      legend:{show:false},
      xaxis:{
        type: 'category',
        categories: labels,
        labels: {
          style:       { fontSize:'11px', fontFamily:"'Outfit',sans-serif" },
          rotate:      -35,
          rotateAlways: isDatetime || labels.length > 12,
          formatter:   xFormatter,
        },
        axisBorder: { show:false },
        axisTicks:  { show:false },
      },
      yaxis:{labels:{style:{fontSize:'11px',fontFamily:"'Outfit',sans-serif"},formatter:fmt}},
      colors:entry.type==='bar'?[ac,ac2,'#0099ff','#7c3aed',suc,dng]:[ac],
      fill:entry.type==='area'?{type:'gradient',gradient:{shadeIntensity:1,opacityFrom:.4,opacityTo:.01,stops:[0,100]}}:{},
      plotOptions:entry.type==='bar'?{bar:{borderRadius:4,columnWidth:'55%',distributed:true}}:{}};
  }
  const el=document.getElementById('apex-'+entry.id);if(!el)return;
  const apex=new ApexCharts(el,opts);apex.render();entry.apexInstance=apex;
}

function updateAllCharts(){
  state.charts.forEach(entry=>{
    // Stats cards re-compute their value in place
    if (entry.type === 'stats') {
      renderStatsCard(entry);
      return;
    }

    if(!entry.apexInstance)return;

    // ── Combined multi-series ────────────────────────────────────────────────
    if(entry.groupByColumn && entry.type !== 'donut'){
      // Destroy & rebuild — ApexCharts can't reliably update a variable number of series in place
      entry.apexInstance.destroy();
      entry.apexInstance = null;
      initApexChart(entry);
      return;
    }

    const{labels,values}=getChartData(entry);
    if(entry.type==='donut'){
      entry.apexInstance.updateSeries(values);
    } else if(entry.type==='bar'){
      // distributed:true bar charts can't update in place when the category
      // count changes (ApexCharts silently drops the re-render).
      // Safest fix: destroy the old instance and build a fresh one.
      entry.apexInstance.destroy();
      entry.apexInstance = null;
      initApexChart(entry);
    } else {
      // For datetime columns, re-derive the axis formatter so the compact tick
      // label stays correct after a time-range change (which may shift all points
      // to a different day or span multiple days).
      const xCol = state.parsedDataset
        ? state.parsedDataset.columns.find(c => c.name === entry.xColumn)
        : null;
      const isDatetime = xCol?.role === 'datetime';
      let xaxisOpts = { type: 'category', categories: labels };
      if (isDatetime && labels.length > 0) {
        const firstDate = labels[0]?.split(',')[0];
        const allSameDay = labels.every(l => l.split(',')[0] === firstDate);
        xaxisOpts.labels = {
          rotateAlways: true,
          formatter: allSameDay
            ? (val) => { if (!val || typeof val !== 'string') return val; return val.replace(/^[A-Za-z]+ \d+,\s*/, ''); }
            : (val) => { if (!val || typeof val !== 'string') return val; return val.replace(/:\d{2}\s*(AM|PM)/i, ' $1'); },
        };
      }
      entry.apexInstance.updateSeries([{name:entry.yColumn||entry.title,data:values}]);
      entry.apexInstance.updateOptions({xaxis: xaxisOpts});
    }
  });
}

/* ============================================================
   TIME RANGE
============================================================ */
function setTimeRange(btn,range){
  document.querySelectorAll('.time-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');state.timeRange=range;state.customDateRange=null;
  updateAllCharts();closeDatePopover();
  refreshSummaryButtonLabels();
}
function toggleDatePicker() {
  document.getElementById('date-picker-popover').classList.toggle('open');
}
function closeDatePopover() {
  document.getElementById('date-picker-popover').classList.remove('open');
}
function applyCustomRange(){
  const from=document.getElementById('date-from').value;
  const to=document.getElementById('date-to').value;

  if (!from || !to || from > to) {
    showToast('Please select a valid date range', 'error');
    return;
  }

  state.timeRange='CUSTOM';
  state.customDateRange={from,to};

  document.getElementById('date-range-label').textContent = `${from} - ${to}`;
  document.getElementById('date-range-trigger').classList.add('has-value');
  document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));

  updateAllCharts();
  closeDatePopover();
  refreshSummaryButtonLabels();
  showToast('Range applied','success');
}
document.addEventListener('click', e => {
  if (!document.getElementById('date-range-wrap')?.contains(e.target)) {
    closeDatePopover();
  }
});

/* ============================================================
   CHART TITLE EDITING
============================================================ */
function updateChartTitle(id, t) {
  const entry = state.charts.find(c => c.id === id); if (!entry) return;
  entry.title = t.trim() || entry.title;
  if (!entry.apexInstance) return;

  // Combined multi-series: series names come from group keys, not the title
  if (entry.groupByColumn && entry.type !== 'donut') return;

  if (entry.type !== 'donut') {
    const { labels, values } = getChartData(entry);
    const xCol = state.parsedDataset
      ? state.parsedDataset.columns.find(c => c.name === entry.xColumn)
      : null;
    const isDatetime = xCol?.role === 'datetime';
    let xaxisOpts = { type: 'category', categories: labels };
    if (isDatetime && labels.length > 0) {
      const firstDate = labels[0]?.split(',')[0];
      const allSameDay = labels.every(l => l.split(',')[0] === firstDate);
      xaxisOpts.labels = {
        rotateAlways: true,
        formatter: allSameDay
          ? (val) => { if (!val || typeof val !== 'string') return val; return val.replace(/^[A-Za-z]+ \d+,\s*/, ''); }
          : (val) => { if (!val || typeof val !== 'string') return val; return val.replace(/:\d{2}\s*(AM|PM)/i, ' $1'); },
      };
    }
    entry.apexInstance.updateOptions({
      series: [{ name: entry.title, data: values }],
      xaxis: xaxisOpts,
    });
  }
}

/* ============================================================
   CARD RESIZE
============================================================ */
function toggleCardSize(id) {
  document.getElementById(id)?.classList.toggle('full-width');
  setTimeout(() => {
    const entry = state.charts.find(c => c.id === id);
    if (!entry?.apexInstance) return;

    // Combined multi-series: rebuild to recalculate point limit at new width
    if (entry.groupByColumn && entry.type !== 'donut') {
      entry.apexInstance.destroy();
      entry.apexInstance = null;
      initApexChart(entry);
      return;
    }

    const { labels, values } = getChartData(entry); // now re-slices at new width
    if (entry.type === 'donut') {
      entry.apexInstance.updateSeries(values);
    } else {
      const xCol = state.parsedDataset
        ? state.parsedDataset.columns.find(c => c.name === entry.xColumn)
        : null;
      const isDatetime = xCol?.role === 'datetime';
      let xaxisOpts = { type: 'category', categories: labels };
      if (isDatetime && labels.length > 0) {
        const firstDate = labels[0]?.split(',')[0];
        const allSameDay = labels.every(l => l.split(',')[0] === firstDate);
        xaxisOpts.labels = {
          rotateAlways: true,
          formatter: allSameDay
            ? (val) => { if (!val || typeof val !== 'string') return val; return val.replace(/^[A-Za-z]+ \d+,\s*/, ''); }
            : (val) => { if (!val || typeof val !== 'string') return val; return val.replace(/:\d{2}\s*(AM|PM)/i, ' $1'); },
        };
      }
      entry.apexInstance.updateSeries([{ name: entry.yColumn || entry.title, data: values }]);
      entry.apexInstance.updateOptions({ xaxis: xaxisOpts });
    }
  }, 120); // wait for CSS transition to finish so offsetWidth is correct
}

/* ============================================================
   AI SUMMARY
   Calls the Cloud Run backend → Gemini API when a real dataset
   is loaded.
   Set BACKEND_URL to your deployed Cloud Run service URL.
============================================================ */

// ── Replace this with your Cloud Run service URL after deployment ──────────────
// e.g. 'https://insight-backend-abc123-as.a.run.app'
const BACKEND_URL = 'https://insight-backend-54324702893.asia-southeast1.run.app';

// Cache keyed by "chartId:timeRangeKey" — never wiped on clear, only on explicit
// cache invalidation. This means switching ranges and back re-uses prior results.
const _summaryCache = {};

/** Returns a stable string key for the current time range selection. */
function getTimeRangeKey() {
  if (state.timeRange === 'CUSTOM' && state.customDateRange) {
    return `CUSTOM:${state.customDateRange.from}|${state.customDateRange.to}`;
  }
  return state.timeRange; // '1M' | '3M' | '6M' | '1Y' | 'ALL'
}

/** Human-readable label for the current range, shown in the summary header. */
function getTimeRangeLabel(key) {
  if (!key || key === 'ALL') return 'All time';
  if (key.startsWith('CUSTOM:')) {
    const [from, to] = key.replace('CUSTOM:', '').split('|');
    return `${from} – ${to}`;
  }
  const map = { '1M': 'Last month', '3M': 'Last 3 months', '6M': 'Last 6 months', '1Y': 'Last year' };
  return map[key] || key;
}

/**
 * Compute summary statistics from an already-filtered values array.
 * Mirrors the worker's computeNumericStats so the AI sees range-accurate numbers.
 */
function computeFilteredStats(values) {
  const nums = values.filter(v => typeof v === 'number' && isFinite(v));
  if (nums.length === 0) return null;
  const n = nums.length;
  const sorted = [...nums].sort((a, b) => a - b);
  const mean = nums.reduce((s, v) => s + v, 0) / n;
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];
  const std = Math.sqrt(nums.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
  const min = sorted[0];
  const max = sorted[n - 1];
  // Linear regression slope for trend
  const xMean = (n - 1) / 2;
  const ssX = nums.reduce((s, _, x) => s + (x - xMean) ** 2, 0);
  const slope = ssX === 0 ? 0
    : nums.reduce((s, y, x) => s + (x - xMean) * (y - mean), 0) / ssX;
  const relSlope = mean !== 0 ? Math.abs(slope / mean) : 0;
  const trend = relSlope < 0.005 ? 'stable' : slope > 0 ? 'upward' : 'downward';
  const growth_rate = (nums[0] !== 0 && nums[0] != null)
    ? ((nums[n - 1] - nums[0]) / Math.abs(nums[0])) * 100
    : null;
  return {
    mean: +mean.toFixed(4),
    median: +median.toFixed(4),
    std: +std.toFixed(4),
    min, max, trend,
    growth_rate: growth_rate != null ? +growth_rate.toFixed(2) : null,
    row_count: n,
  };
}

async function generateSummary(id) {
  const entry = state.charts.find(c => c.id === id);
  if (!entry) return;

  const rangeKey  = getTimeRangeKey();
  const cacheKey  = `${id}:${rangeKey}`;

  // ── Cache hit: serve stored result, no API call ──────────────────────────────
  if (_summaryCache[cacheKey]) {
    applySummary(id, entry, _summaryCache[cacheKey], rangeKey);
    return;
  }

  document.getElementById('ai-btn-' + id).style.display = 'none';
  document.getElementById('ai-skeleton-' + id).classList.add('visible');
  document.getElementById('ai-error-' + id).classList.remove('visible');

  try {
    if (!BACKEND_URL || !state.parsedDataset || !entry.yColumn) {
      throw new Error('No backend URL configured or no dataset loaded.');
    }

    // ── Combined chart: compute per-series stats ─────────────────────────────
    let yStats, xSample, filteredLabels;
    if (entry.groupByColumn && entry.type !== 'donut') {
      const { labels, series } = getCombinedChartData(entry);
      filteredLabels = labels;
      // Build a merged flat values array across all series for overall stats
      const allVals = series.flatMap(s => s.data.filter(v => v !== null));
      yStats = computeFilteredStats(allVals);
    } else {
      const { labels: fl, values: filteredValues } = getChartData(entry);
      filteredLabels = fl;
      yStats = computeFilteredStats(filteredValues);
    }

    if (!yStats) {
      throw new Error('No numeric data available for the selected time range.');
    }

    xSample = filteredLabels.filter((_, i) =>
      i % Math.ceil(filteredLabels.length / 20) === 0
    ).slice(0, 20);

    const body = {
      chart_title: entry.title,
      chart_type:  entry.type,
      x_column:    entry.xColumn,
      y_column:    entry.yColumn,
      y_stats:     yStats,
      x_sample:    xSample,
    };

    console.log('[Insight] Calling backend /summarise for range', rangeKey, body);

    const res = await fetch(BACKEND_URL + '/summarise', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(25000),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      throw new Error(`Backend ${res.status}: ${err.detail || res.statusText}`);
    }

    const data = await res.json();
    console.log('[Insight] Backend response:', data);

    const result = {
      text:        formatSummaryHTML(data),
      fromBackend: true,
      highlights:  data.highlights || [],
      rangeKey,               // store which range this was generated for
    };

    _summaryCache[cacheKey] = result;
    applySummary(id, entry, result, rangeKey);

  } catch (err) {
    console.error('[Insight] AI error:', err);
    document.getElementById('ai-skeleton-' + id).classList.remove('visible');
    document.getElementById('ai-error-' + id).classList.add('visible');
    const btn = document.getElementById('ai-btn-' + id);
    btn.style.display = 'flex';
    btn.innerHTML = '<span class="ai-icon">↻</span> Retry AI summary';
  }
}

/** Render the Gemini response into display HTML. */
function formatSummaryHTML(data) {
  let text = data.summary || '';
  // Bold numeric patterns
  text = text.replace(/(\d[\d,]*\.?\d*%?)/g, '<strong>$1</strong>');
  // Append highlights list
  if (data.highlights && data.highlights.length) {
    text += '<ul style="margin:8px 0 0 0;padding-left:16px;font-size:13px;color:var(--text-muted);">'
      + data.highlights.map(h => `<li>${h}</li>`).join('')
      + '</ul>';
  }
  return text;
}

function applySummary(id, entry, sd, rangeKey) {
  document.getElementById('ai-skeleton-' + id).classList.remove('visible');
  entry.summaryText          = sd.text;
  entry.summaryLoaded        = true;
  entry.summaryRangeKey      = rangeKey;   // track which range is currently displayed

  const rangeLabel = getTimeRangeLabel(rangeKey);
  const box = document.getElementById('ai-summary-' + id);
  box.innerHTML = `
    <div class="ai-summary-header">
      <div class="ai-label">
        <div class="ai-label-dot"></div> AI Analysis
        <span class="ai-range-pill">${rangeLabel}</span>
      </div>
      <button class="btn btn-ghost" style="padding:3px 8px;font-size:11px;" onclick="clearSummary('${id}')">Clear</button>
    </div>
    <div class="ai-summary-text">${sd.text}</div>`;
  box.classList.add('visible');
  document.getElementById('ai-btn-' + id).style.display = 'none';
}

/**
 * Clear only hides the displayed summary and reveals the generate button.
 * The cache is intentionally left intact — if the user regenerates for the
 * same time range it will be served from cache without an API call.
 */
function clearSummary(id) {
  const entry = state.charts.find(c => c.id === id);
  if (!entry) return;

  const box = document.getElementById('ai-summary-' + id);
  const btn = document.getElementById('ai-btn-' + id);

  entry.summaryLoaded   = false;
  entry.summaryText     = null;
  entry.summaryRangeKey = null;

  box.innerHTML = '';
  box.classList.remove('visible');

  if (btn) {
    btn.style.display = 'flex';
    // Hint that a cache exists for the current range (no API needed)
    const currentKey = `${id}:${getTimeRangeKey()}`;
    if (_summaryCache[currentKey]) {
      btn.innerHTML = '<span class="ai-icon">✦</span> Restore AI summary';
    } else {
      btn.innerHTML = '<span class="ai-icon">✦</span> Generate AI summary';
    }
  }
}

/**
 * After a time range change, update every visible "Generate" button label
 * to either "Restore AI summary" (cache hit for new range) or the default.
 * Charts that already have a summary displayed are left untouched.
 */
function refreshSummaryButtonLabels() {
  state.charts.forEach(entry => {
    if (entry.summaryLoaded) return;  // summary is showing — don't touch the button
    const btn = document.getElementById('ai-btn-' + entry.id);
    if (!btn || btn.style.display === 'none') return;
    const cacheKey = `${entry.id}:${getTimeRangeKey()}`;
    btn.innerHTML = _summaryCache[cacheKey]
      ? '<span class="ai-icon">✦</span> Restore AI summary'
      : '<span class="ai-icon">✦</span> Generate AI summary';
  });
}

let autoIdx=0;
function autoGenerateChart(){
  if(state.parsedDataset){
    // Cycle through real column combinations
    const ds=state.parsedDataset;
    const nums=ds.columns.filter(c=>c.role==='numeric');
    const xs=ds.columns.filter(c=>c.role!=='numeric');
    if(nums.length&&xs.length){
      const xc=xs[autoIdx%xs.length];
      const yc=nums[autoIdx%nums.length];
      autoIdx++;
      addChart({title:`${yc.name} by ${xc.name} (auto)`,type:'bar',xColumn:xc.name,yColumn:yc.name});
      showToast('Chart auto-generated','success');
      return;
    }
  } else {
     showToast('Please upload a file first to use Auto Generate.', 'error');
  }
}

/* ============================================================
   ADD CHART MODAL
============================================================ */
function openModal(){
  // Reset selections back to line type
  document.querySelectorAll('.chart-type-btn').forEach(b=>b.classList.remove('selected'));
  const lineBtn = document.querySelector('.chart-type-btn[data-type="line"]');
  if (lineBtn) lineBtn.classList.add('selected');
  state.selectedChartType = 'line';

  // Reset group-by, filter, stats fields
  const gbSel = document.getElementById('modal-groupby');
  if (gbSel) gbSel.value = '';
  const filterCol = document.getElementById('modal-filter-col');
  if (filterCol) filterCol.value = '';
  const filterVal = document.getElementById('modal-filter-val');
  if (filterVal) filterVal.value = '';
  const filterOp = document.getElementById('modal-filter-op');
  if (filterOp) filterOp.value = '=';

  // Show/hide correct panels for line type
  const axesWrap = document.getElementById('modal-axes-wrap');
  if (axesWrap) axesWrap.style.display = '';
  const statsWrap = document.getElementById('modal-stats-wrap');
  if (statsWrap) statsWrap.style.display = 'none';
  const gbWrap = document.getElementById('modal-groupby-wrap');
  if (gbWrap) gbWrap.style.display = '';

  document.getElementById('modal-overlay').classList.add('open');
}
function closeModal(e){if(!e||e.target===document.getElementById('modal-overlay'))document.getElementById('modal-overlay').classList.remove('open')}
function selectChartType(btn){
  document.querySelectorAll('.chart-type-btn').forEach(b=>b.classList.remove('selected'));
  btn.classList.add('selected');
  state.selectedChartType=btn.getAttribute('data-type');
  const isStats = state.selectedChartType === 'stats';
  // Axes row and group-by: hidden for stats type
  const axesWrap = document.getElementById('modal-axes-wrap');
  if (axesWrap) axesWrap.style.display = isStats ? 'none' : '';
  // Stats-specific fields: shown only for stats type
  const statsWrap = document.getElementById('modal-stats-wrap');
  if (statsWrap) statsWrap.style.display = isStats ? '' : 'none';
  // Group By is not applicable for donut or stats charts
  const gbWrap=document.getElementById('modal-groupby-wrap');
  if(gbWrap) gbWrap.style.display=(state.selectedChartType==='donut'||isStats)?'none':'';
}
function addChartFromModal(){
  const title       = document.getElementById('modal-title').value.trim();
  const filterCol   = document.getElementById('modal-filter-col').value || null;
  const filterOp    = document.getElementById('modal-filter-op').value || '=';
  const filterVal   = document.getElementById('modal-filter-val').value.trim();

  if(!state.parsedDataset){
    showToast('Upload a file to create custom charts.', 'error'); return;
  }

  const isStats = state.selectedChartType === 'stats';

  if (isStats) {
    const statCol    = document.getElementById('modal-stats-col').value;
    const statMetric = document.getElementById('modal-stats-metric').value;
    const metricLabels = { mean:'Mean', median:'Median', mode:'Mode', min:'Min', max:'Max' };
    let autoTitle = `${metricLabels[statMetric]||statMetric} of ${statCol}`;
    if (filterCol && filterVal) autoTitle += ` (${filterCol} ${filterOp} "${filterVal}")`;
    addChart({
      title:          title || autoTitle,
      type:           'stats',
      statColumn:     statCol,
      statMetric,
      filterColumn:   filterCol,
      filterOperator: filterOp,
      filterValue:    filterVal,
    });
  } else {
    const xCol      = document.getElementById('modal-x-axis').value;
    const yCol      = document.getElementById('modal-y-axis').value;
    const groupByCol= document.getElementById('modal-groupby').value || null;
    const autoTitle = groupByCol
      ? `${yCol} by ${groupByCol} over ${xCol}`
      : `${yCol} by ${xCol}`;
    addChart({
      title:          title || autoTitle,
      type:           state.selectedChartType,
      xColumn:        xCol,
      yColumn:        yCol,
      groupByColumn:  state.selectedChartType === 'donut' ? null : groupByCol,
      filterColumn:   filterCol,
      filterOperator: filterOp,
      filterValue:    filterVal,
    });
  }

  closeModal();
  document.getElementById('modal-title').value = '';
  document.getElementById('modal-groupby').value = '';
  showToast('Chart added','success');
}

/* ============================================================
   DRAG TO REORDER
============================================================ */
function syncStateOrder() {
  const currentIds = Array.from(document.getElementById('chart-grid').children)
    .map(el => el.getAttribute('data-id'));
    
  state.charts.sort((a, b) => currentIds.indexOf(a.id) - currentIds.indexOf(b.id));
}

let dragSrcId=null;
function setupCardDrag(card){
  card.addEventListener('dragstart',e=>{dragSrcId=card.getAttribute('data-id');card.classList.add('dragging');e.dataTransfer.effectAllowed='move'});
  card.addEventListener('dragend',()=>{card.classList.remove('dragging');document.querySelectorAll('.chart-card').forEach(c=>c.classList.remove('drag-target'));dragSrcId=null});
  card.addEventListener('dragover',e=>{e.preventDefault();if(card.getAttribute('data-id')!==dragSrcId)card.classList.add('drag-target')});
  card.addEventListener('dragleave',()=>card.classList.remove('drag-target'));
  card.addEventListener('drop', e => {
    e.preventDefault();
    card.classList.remove('drag-target');
    if(!dragSrcId || card.getAttribute('data-id') === dragSrcId) return;
    
    const grid = document.getElementById('chart-grid');
    const src = document.getElementById(dragSrcId);
    const kids = Array.from(grid.children);
    
    if(kids.indexOf(src) < kids.indexOf(card)) {
      grid.insertBefore(src, card.nextSibling);
    } else {
      grid.insertBefore(src, card);
    }
    
    syncStateOrder();
  });
}

/* ============================================================
   SELECTION MODE
============================================================ */
function enterSelectionMode(){state.selectionMode=true;state.selectedCards.clear();document.getElementById('chart-grid').classList.add('selection-mode');updateSelectionBar()}
function clearSelection(){state.selectionMode=false;state.selectedCards.clear();document.getElementById('chart-grid').classList.remove('selection-mode');document.querySelectorAll('.card-checkbox').forEach(c=>c.checked=false);document.getElementById('selection-bar').classList.remove('visible')}
function toggleCardSelection(id){state.selectedCards.has(id)?state.selectedCards.delete(id):state.selectedCards.add(id);updateSelectionBar()}
function updateSelectionBar(){document.getElementById('selection-count').textContent=state.selectedCards.size+' selected';document.getElementById('selection-bar').classList.toggle('visible',state.selectedCards.size>0||state.selectionMode)}

/* ============================================================
   EXPORT
============================================================ */
/* ============================================================
   EXPORT — shared helpers
============================================================ */

/**
 * Freeze a single card into light-mode capture state.
 * Returns the dataUrl and a cleanup function.
 *
 * Options:
 *   transparent {boolean} – omit bgcolor for PNG alpha (image export)
 *   scale       {number}  – device-pixel ratio multiplier
 */
async function _freezeAndCapture(card, entry, { transparent = true, scale = 3 } = {}) {
  // ── Strategy ──────────────────────────────────────────────────────────────
  // dom-to-image-more and html2canvas both fail on ApexCharts SVGs because the
  // SVG's inline <style> blocks use CSS variables that the capture library
  // cannot resolve in its cloned iframe/document — every chart fill and stroke
  // becomes transparent.
  //
  // Solution: compose the export image manually on an HTML5 Canvas:
  //   1. Use ApexCharts' own dataURI() to get a correct PNG of the chart.
  //   2. Read the card title and (optional) AI summary text directly from the DOM.
  //   3. Draw background → title → chart PNG → summary text onto a canvas.
  //
  // This completely bypasses dom-to-image for the chart area and always works.

  const DPR    = scale;
  const BG     = null;
  const FG     = '#111827';
  const MUTED  = '#6b7280';
  const BORDER = '#e5e7eb';
  const RADIUS = 12;
  const PAD    = 20;          // inner padding (px, logical)
  const TITLE_SIZE  = 15;
  const BODY_SIZE   = 13;
  const LINE_HEIGHT = 1.65;

  // ── 1. Collect card metrics ──────────────────────────────────────────────
  const cardW = card.offsetWidth;

  // Title
  const titleEl = card.querySelector('.card-title');
  const titleText = (titleEl?.textContent || entry?.title || '').trim();

  // Stats card values (for type === 'stats' cards which have no apexInstance)
  const isStats = entry?.type === 'stats';
  const statsData = isStats ? {
    metric:   card.querySelector('[id^="stats-metric-"]')?.textContent?.trim() || '',
    value:    card.querySelector('[id^="stats-value-"]')?.textContent?.trim()  || '—',
    colLabel: card.querySelector('[id^="stats-col-label-"]')?.textContent?.trim() || '',
    filter:   card.querySelector('[id^="stats-filter-pill-"] .stats-filter-pill')?.textContent?.trim() || '',
    count:    card.querySelector('[id^="stats-count-"]')?.textContent?.trim()  || '',
  } : null;

  // Chart image via ApexCharts' own renderer.
  // Temporarily switch to a light-mode / dark-foreground theme so axis labels,
  // grid lines and legend text render as visible dark colours in the export PNG.
  let chartImg = null;
  let chartNaturalH = 0;
  if (entry?.apexInstance) {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

    // Shared marker style used everywhere
    const MARKERS = { size: 4, colors: Array(30).fill('#111827'), strokeColors: '#ffffff', strokeWidth: 2 };

    // Switch to export-friendly colours before capture
    if (isDark) {
      try {
        await entry.apexInstance.updateOptions({
          theme:  { mode: 'light' },
          chart:  { foreColor: '#111827', background: 'transparent' },
          grid:   { borderColor: '#e5e7eb' },
          legend: { labels: { colors: '#111827' } },
          markers: MARKERS,
        }, false, false);
        await new Promise(r => requestAnimationFrame(r));
      } catch (_) {}
    } else {
      // Light mode: only markers need forcing; everything else is already export-safe
      try {
        await entry.apexInstance.updateOptions({ markers: MARKERS }, false, false);
        await new Promise(r => requestAnimationFrame(r));
      } catch (_) {}
    }

    // Capture
    try {
      const { imgURI } = await entry.apexInstance.dataURI();
      if (imgURI && imgURI !== 'data:,') {
        chartImg = await new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = imgURI;
        });
        chartNaturalH = chartImg.naturalHeight / (chartImg.naturalWidth / (cardW - PAD * 2)) || 0;
      }
    } catch (_) {}

    // Restore original theme
    if (isDark) {
      try {
        entry.apexInstance.updateOptions({
          theme:  { mode: 'dark' },
          chart:  { foreColor: '#7d8590', background: 'transparent' },
          grid:   { borderColor: '#21282f' },
          legend: { labels: { colors: '#7d8590' } },
          markers: MARKERS,
        }, false, false);
      } catch (_) {}
    }
    // Light mode restore: markers were already correct before capture, nothing to undo
  }

  // AI summary text (only if visible)
  const summaryBox = card.querySelector('.ai-summary-box');
  const summaryVisible = summaryBox && summaryBox.classList.contains('visible');
  const summaryTextEl = summaryVisible ? summaryBox.querySelector('.ai-summary-text') : null;
  const summaryText = summaryTextEl
    ? (summaryTextEl.innerText || summaryTextEl.textContent || '').trim()
    : '';

  // ── 2. Measure total canvas height ──────────────────────────────────────
  // We need to know the wrapped-text height for the summary before drawing.
  // Use an offscreen canvas to pre-measure line wrapping.
  const drawW = cardW - PAD * 2;

  function measureWrappedText(ctx, text, fontSize, maxWidth) {
    if (!text) return 0;
    ctx.font = `${fontSize}px 'Outfit', sans-serif`;
    const words = text.split(' ');
    let line = '', lines = 1;
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && line) {
        line = w; lines++;
      } else { line = test; }
    }
    return lines * fontSize * LINE_HEIGHT;
  }

  const offscreen = document.createElement('canvas');
  offscreen.width = cardW * DPR;
  const octx = offscreen.getContext('2d');
  octx.scale(DPR, DPR);

  const titleH   = TITLE_SIZE * LINE_HEIGHT + 12;   // title row + gap below
  const chartH   = chartImg ? chartNaturalH : 0;
  const summaryH = summaryText
    ? (24 + measureWrappedText(octx, summaryText, BODY_SIZE, drawW - PAD * 2) + PAD)
    : 0;

  // Stats card body height: metric pill + big value + col label + optional filter
  const STATS_VALUE_SIZE = 48;
  const statsBodyH = isStats
    ? (PAD + 22 + 12 + STATS_VALUE_SIZE + 12 + 18 + (statsData.filter ? 28 : 0) + PAD)
    : 0;

  const totalH = PAD + titleH + chartH + statsBodyH + (summaryText ? PAD / 2 : 0) + summaryH + PAD;

  // ── 3. Draw onto the real canvas ─────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.width  = cardW  * DPR;
  canvas.height = totalH * DPR;
  const ctx = canvas.getContext('2d');
  ctx.scale(DPR, DPR);

  // Background + rounded rect
  if (BG) {
    ctx.fillStyle = BG;
    roundRect(ctx, 0, 0, cardW, totalH, RADIUS);
    ctx.fill();
  } else {
    ctx.clearRect(0, 0, cardW, totalH);
  }

  let y = PAD;

  // Title
  ctx.fillStyle = FG;
  ctx.font = `700 ${TITLE_SIZE}px 'Outfit', sans-serif`;
  ctx.fillText(titleText, PAD, y + TITLE_SIZE);
  y += titleH;

  // Chart image
  if (chartImg) {
    ctx.drawImage(chartImg, PAD, y, drawW, chartNaturalH);
    y += chartH;
  }

  // Stats card body
  if (isStats && statsData) {
    const cx = cardW / 2;  // centre x for centred text

    // Metric pill
    const pillText = statsData.metric.toUpperCase();
    ctx.font = `700 11px 'Outfit', sans-serif`;
    const pillW = ctx.measureText(pillText).width + 24;
    const pillH = 22;
    const pillX = cx - pillW / 2;
    ctx.fillStyle = '#f0f4f8';
    roundRect(ctx, pillX, y, pillW, pillH, 11);
    ctx.fill();
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    roundRect(ctx, pillX, y, pillW, pillH, 11);
    ctx.stroke();
    ctx.fillStyle = MUTED;
    ctx.textAlign = 'center';
    ctx.fillText(pillText, cx, y + 15);
    y += pillH + 12;

    // Big value
    ctx.fillStyle = '#008f72';
    ctx.font = `800 ${STATS_VALUE_SIZE}px 'Outfit', sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(statsData.value, cx, y + STATS_VALUE_SIZE);
    y += STATS_VALUE_SIZE + 12;

    // Column label
    ctx.fillStyle = MUTED;
    ctx.font = `500 13px 'Outfit', sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(statsData.colLabel, cx, y + 13);
    y += 13 + (statsData.filter ? 10 : 0);

    // Filter pill (optional)
    if (statsData.filter) {
      const fpText = statsData.filter.replace(/\s+/g, ' ').trim();
      ctx.font = `500 11px 'Outfit', sans-serif`;
      const fpW = ctx.measureText(fpText).width + 24;
      const fpH = 22;
      const fpX = cx - fpW / 2;
      ctx.fillStyle = 'rgba(245,158,11,0.1)';
      roundRect(ctx, fpX, y, fpW, fpH, 11);
      ctx.fill();
      ctx.strokeStyle = 'rgba(245,158,11,0.3)';
      ctx.lineWidth = 1;
      roundRect(ctx, fpX, y, fpW, fpH, 11);
      ctx.stroke();
      ctx.fillStyle = '#c47b00';
      ctx.textAlign = 'center';
      ctx.fillText(fpText, cx, y + 15);
      y += fpH + 10;
    }

    y += PAD;
    ctx.textAlign = 'left'; // reset
  }

  // AI summary box
  if (summaryText) {
    y += PAD / 2;
    const boxX = PAD, boxY = y, boxW = drawW, boxH = summaryH;

    // Box background
    ctx.fillStyle = '#f6f8fa';
    roundRect(ctx, boxX, boxY, boxW, boxH, 8);
    ctx.fill();
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    roundRect(ctx, boxX, boxY, boxW, boxH, 8);
    ctx.stroke();

    // Summary label
    ctx.fillStyle = '#008f72';
    ctx.font = `600 10px 'Outfit', sans-serif`;
    ctx.fillText('AI SUMMARY', boxX + PAD, boxY + 16);

    // Summary body — word-wrap
    ctx.fillStyle = MUTED;
    ctx.font = `${BODY_SIZE}px 'Outfit', sans-serif`;
    let ty = boxY + 16 + BODY_SIZE * LINE_HEIGHT;
    const words = summaryText.replace(/\n+/g, ' ').split(' ');
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > boxW - PAD * 2 && line) {
        ctx.fillText(line, boxX + PAD, ty);
        ty += BODY_SIZE * LINE_HEIGHT;
        line = w;
      } else { line = test; }
    }
    if (line) ctx.fillText(line, boxX + PAD, ty);
  }

  return canvas.toDataURL('image/png');
}

/** Draw a rounded rectangle path (does not stroke/fill). */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Add a card image to an existing jsPDF instance.
 * Scales proportionally to fill the usable area (margin on all sides)
 * without ever overflowing the page height.
 */
function _addCardToPdf(pdf, dataUrl, cardW, cardH) {
  const A4_W   = pdf.internal.pageSize.getWidth();   // 210 mm
  const A4_H   = pdf.internal.pageSize.getHeight();  // 297 mm
  const MARGIN = 14; // mm on each side

  const availW = A4_W - MARGIN * 2;
  const availH = A4_H - MARGIN * 2;

  // Scale to fill available width; shrink further if height overflows
  let imgW = availW;
  let imgH = (cardH / cardW) * imgW;

  if (imgH > availH) {
    imgH = availH;
    imgW = (cardW / cardH) * imgH;
  }

  // Centre horizontally; pin to top margin vertically
  const x = MARGIN + (availW - imgW) / 2;
  const y = MARGIN;

  pdf.setFillColor(255, 255, 255);
  pdf.rect(0, 0, A4_W, A4_H, 'F');
  pdf.addImage(dataUrl, 'PNG', x, y, imgW, imgH);
}

/* ── Individual card → PDF ──────────────────────────────────────────────── */
async function exportCardPDF(id) {
  const card  = document.getElementById(id);
  const entry = state.charts.find(c => c.id === id);
  if (!card || !entry) return;

  try {
    const dataUrl = await _freezeAndCapture(card, entry, { transparent: true, scale: 2 });

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF('p', 'mm', 'a4');
    _addCardToPdf(pdf, dataUrl, card.offsetWidth, card.offsetHeight);
    pdf.save(`Insight-${id}.pdf`);
  } catch (err) {
    console.error('exportCardPDF:', err);
    showToast('Export failed', 'error');
  }
}

/* ── Individual card → PNG (transparent background) ────────────────────── */
async function exportCardImage(id) {
  const card  = document.getElementById(id);
  const entry = state.charts.find(c => c.id === id);
  if (!card || !entry) return;

  showToast('Preparing export…', 'success');

  try {
    // transparent: true → PNG carries an alpha channel; card bg is see-through
    const dataUrl = await _freezeAndCapture(card, entry, { transparent: true, scale: 3 });

    const a = document.createElement('a');
    a.download = `Insight-${id}.png`;
    a.href = dataUrl;
    a.click();
  } catch (err) {
    console.error('exportCardImage:', err);
    showToast('Export failed', 'error');
  }
}

/* ── Selected cards (batch) ─────────────────────────────────────────────── */
async function exportSelected(fmt) {
  if (state.selectedCards.size === 0) return;

  const selectedIds = Array.from(state.selectedCards);
  showToast(`Exporting ${selectedIds.length} chart${selectedIds.length > 1 ? 's' : ''}…`, 'success');

  for (const id of selectedIds) {
    if (fmt === 'pdf') await exportCardPDF(id);
    else               await exportCardImage(id);
    await new Promise(r => setTimeout(r, 500)); // prevent download queuing
  }

  clearSelection();
}

/* ── All cards → single multi-page PDF ─────────────────────────────────── */
async function exportAllPDF() {
  const cards = document.querySelectorAll('.chart-card');
  if (cards.length === 0) return;

  showToast('Generating report…', 'success');

  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF('p', 'mm', 'a4');

  for (let i = 0; i < cards.length; i++) {
    const card  = cards[i];
    const entry = state.charts.find(c => c.id === card.id);

    try {
      const dataUrl = await _freezeAndCapture(card, entry, { transparent: true, scale: 2 });
      if (i > 0) pdf.addPage();
      _addCardToPdf(pdf, dataUrl, card.offsetWidth, card.offsetHeight);
    } catch (err) {
      console.error(`exportAllPDF card ${card.id}:`, err);
    }
  }

  pdf.save('Insight-Full-Dashboard.pdf');
  showToast('Full report exported', 'success');
}

/* ── All cards → individual PNG files ──────────────────────────────────── */
async function exportAllImages() {
  const cards = document.querySelectorAll('.chart-card');
  if (cards.length === 0) return;

  showToast('Exporting all charts…', 'success');

  for (const card of cards) {
    await exportCardImage(card.id);
    await new Promise(r => setTimeout(r, 400));
  }
}

/* ============================================================
   SESSION SAVE / LOAD
============================================================ */
function saveSession(){
  // Use DOM order so drag-reordered positions are preserved
  const cardOrder = Array.from(document.getElementById('chart-grid').querySelectorAll('.chart-card')).map(c => c.id);
  const session = {
    version: '1.0',
    savedAt: new Date().toISOString(),
    datasetName: document.getElementById('dataset-name').textContent,
    // Store the full dataset structure for full functionality on reload
    parsedDataset: state.parsedDataset,
    charts: cardOrder.map(id => {
      const c = state.charts.find(c => c.id === id);
      if (!c) return null;
      const card = document.getElementById(id);
      return {
        id: c.id, title: c.title, type: c.type,
        xColumn: c.xColumn, yColumn: c.yColumn,
        groupByColumn: c.groupByColumn || null,
        statColumn: c.statColumn || null,
        statMetric: c.statMetric || 'mean',
        filterColumn:   c.filterColumn   || null,
        filterOperator: c.filterOperator || '=',
        filterValue:    c.filterValue    || '',
        summaryText: c.summaryText,
        fullWidth: card ? card.classList.contains('full-width') : false,
      };
    }).filter(Boolean),
  };
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([JSON.stringify(session,null,2)],{type:'application/json'}));
  a.download='insight-session.json';a.click();
  showToast('Session saved','success');
}
function loadSession(session){
  if(!session.version || !session.charts){showToast('Invalid session file','error'); return;}
  
  // Restore the dataset state
  state.parsedDataset = session.parsedDataset;
  if(state.parsedDataset) {
    populateAxisDropdowns(state.parsedDataset.columns);
  }

  document.getElementById('dataset-name').textContent = session.datasetName || 'session.json';
  document.getElementById('chart-grid').innerHTML = '';
  state.charts = []; 
  state.nextId = 1;

  session.charts.forEach(cfg=>{
    const entry=addChart({
      title:cfg.title, type:cfg.type,
      xColumn:cfg.xColumn, yColumn:cfg.yColumn,
      groupByColumn:cfg.groupByColumn||null,
      statColumn:cfg.statColumn||null,
      statMetric:cfg.statMetric||'mean',
      filterColumn:cfg.filterColumn||null,
      filterOperator:cfg.filterOperator||'=',
      filterValue:cfg.filterValue||'',
    });
    if(cfg.fullWidth){
      requestAnimationFrame(()=>{
        const card=document.getElementById(entry.id);
        if(card){ card.classList.add('full-width'); setTimeout(()=>entry.apexInstance?.updateOptions({}),120); }
      });
    }
    if(cfg.summaryText){
      // Restore into the cache under a SESSION key so it can be served without an API call
      const sessionRangeKey = 'SESSION';
      const cacheKey = `${entry.id}:${sessionRangeKey}`;
      const cached = { text: cfg.summaryText, fromBackend: true, highlights: [], rangeKey: sessionRangeKey };
      _summaryCache[cacheKey] = cached;
      entry.summaryText=cfg.summaryText;entry.summaryLoaded=true;entry.summaryRangeKey=sessionRangeKey;
      requestAnimationFrame(()=>{
        const box=document.getElementById('ai-summary-'+entry.id);if(!box)return;
        box.innerHTML=`<div class="ai-summary-header"><div class="ai-label"><div class="ai-label-dot"></div> AI Analysis <span class="ai-range-pill">Saved session</span></div><button class="btn btn-ghost" style="padding:3px 8px;font-size:11px;" onclick="clearSummary('${entry.id}')">Clear</button></div><div class="ai-summary-text">${cfg.summaryText}</div>`;
        box.classList.add('visible');document.getElementById('ai-btn-'+entry.id).style.display='none';
      });
    }
  });
  showPage('dashboard');showToast('Session loaded','success');
}

/* ============================================================
   TEMPLATE SAVE / LOAD
============================================================ */
function saveTemplate(){
  const grid = document.getElementById('chart-grid');
  // Preserve the visual DOM order for position fidelity
  const cardOrder = Array.from(grid.querySelectorAll('.chart-card')).map(c => c.id);

  const template = {
    version: '1.0',
    type: 'template',
    savedAt: new Date().toISOString(),
    dateRange: {
      timeRange: state.timeRange,
      customDateRange: state.customDateRange || null,
    },
    charts: cardOrder.map(id => {
      const entry = state.charts.find(c => c.id === id);
      if (!entry) return null;
      const card = document.getElementById(id);
      return {
        title:          entry.title,
        type:           entry.type,
        xColumn:        entry.xColumn,
        yColumn:        entry.yColumn,
        groupByColumn:  entry.groupByColumn  || null,
        statColumn:     entry.statColumn     || null,
        statMetric:     entry.statMetric     || 'mean',
        filterColumn:   entry.filterColumn   || null,
        filterOperator: entry.filterOperator || '=',
        filterValue:    entry.filterValue    || '',
        fullWidth: card ? card.classList.contains('full-width') : false,
      };
    }).filter(Boolean),
  };

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' }));
  a.download = 'insight-template.json';
  a.click();
  showToast('Template saved', 'success');
}

/** Apply a loaded template object to the current dataset. */
function applyTemplate(tpl){
  if (!tpl || tpl.type !== 'template' || !Array.isArray(tpl.charts)){
    showToast('Invalid template file', 'error'); return;
  }

  // ── Restore date range ──────────────────────────────────────────────────────
  const dr = tpl.dateRange || {};
  state.timeRange      = dr.timeRange      || '1Y';
  state.customDateRange= dr.customDateRange|| null;

  document.querySelectorAll('.time-btn').forEach(b => {
    b.classList.toggle('active', b.textContent.trim() === state.timeRange);
  });

  if (state.timeRange === 'CUSTOM' && state.customDateRange) {
    document.getElementById('date-from').value = state.customDateRange.from;
    document.getElementById('date-to').value   = state.customDateRange.to;
    document.getElementById('date-range-label').textContent =
      `${state.customDateRange.from} – ${state.customDateRange.to}`;
    document.getElementById('date-range-trigger').classList.add('has-value');
    document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
  } else {
    document.getElementById('date-range-trigger').classList.remove('has-value');
    document.getElementById('date-range-label').textContent = 'Custom range';
  }

  // ── Clear existing charts ───────────────────────────────────────────────────
  state.charts.forEach(c => c.apexInstance?.destroy());
  document.getElementById('chart-grid').innerHTML = '';
  state.charts = [];
  state.nextId = 1;

  // ── Re-create charts in template order ─────────────────────────────────────
  tpl.charts.forEach(cfg => {
    const entry = addChart({
      title:          cfg.title,
      type:           cfg.type,
      xColumn:        cfg.xColumn,
      yColumn:        cfg.yColumn,
      groupByColumn:  cfg.groupByColumn  || null,
      statColumn:     cfg.statColumn     || null,
      statMetric:     cfg.statMetric     || 'mean',
      filterColumn:   cfg.filterColumn   || null,
      filterOperator: cfg.filterOperator || '=',
      filterValue:    cfg.filterValue    || '',
    });
    if (cfg.fullWidth) {
      // Apply full-width after the card is in the DOM
      requestAnimationFrame(() => {
        const card = document.getElementById(entry.id);
        if (card) {
          card.classList.add('full-width');
          setTimeout(() => entry.apexInstance?.updateOptions({}), 120);
        }
      });
    }
  });

  showToast('Template applied', 'success');
}

/** Dashboard toolbar: load and immediately apply a template to the live dataset. */
function handleTemplateDashboardLoad(e){
  const f = e.target.files[0]; if (!f) return;
  if (!state.parsedDataset){
    showToast('No dataset loaded. Please upload a spreadsheet first.', 'error'); return;
  }
  const r = new FileReader();
  r.onload = ev => {
    try { applyTemplate(JSON.parse(ev.target.result)); }
    catch { showToast('Invalid template file', 'error'); }
  };
  r.readAsText(f);
  // Reset input so the same file can be reloaded if needed
  e.target.value = '';
}

/* ============================================================
   DROPDOWNS
============================================================ */
function toggleDropdown(id){const menu=document.getElementById(id+'-menu');if(!menu)return;const was=menu.classList.contains('open');closeAllDropdowns();if(!was)menu.classList.add('open')}
function closeAllDropdowns(){document.querySelectorAll('.dropdown-menu').forEach(m=>m.classList.remove('open'))}
document.addEventListener('click',e=>{if(!e.target.closest('.dropdown'))closeAllDropdowns()});

/* ============================================================
   TOAST
============================================================ */
function showToast(msg,type='success'){const t=document.createElement('div');t.className='toast '+type;t.textContent=msg;document.getElementById('toast-container').appendChild(t);setTimeout(()=>{t.style.opacity='0';t.style.transition='opacity .3s';setTimeout(()=>t.remove(),300)},3500)}

/* ============================================================
   KEYBOARD + RESIZE
============================================================ */
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal();clearSelection();closeAllDropdowns();closeDatePopover()}});
const _deb=(fn,d)=>{let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),d)}};

window.addEventListener('resize', _deb(() => {
  state.charts.forEach(c => {
    if (!c.apexInstance) return;

    // Combined multi-series: destroy & rebuild to recalculate point limit
    if (c.groupByColumn && c.type !== 'donut') {
      c.apexInstance.destroy();
      c.apexInstance = null;
      initApexChart(c);
      return;
    }

    const { labels, values } = getChartData(c);
    if (c.type === 'donut') {
      c.apexInstance.updateSeries(values);
    } else {
      const xCol = state.parsedDataset
        ? state.parsedDataset.columns.find(col => col.name === c.xColumn)
        : null;
      const isDatetime = xCol?.role === 'datetime';
      let xaxisOpts = { type: 'category', categories: labels };
      if (isDatetime && labels.length > 0) {
        const firstDate = labels[0]?.split(',')[0];
        const allSameDay = labels.every(l => l.split(',')[0] === firstDate);
        xaxisOpts.labels = {
          rotateAlways: true,
          formatter: allSameDay
            ? (val) => { if (!val || typeof val !== 'string') return val; return val.replace(/^[A-Za-z]+ \d+,\s*/, ''); }
            : (val) => { if (!val || typeof val !== 'string') return val; return val.replace(/:\d{2}\s*(AM|PM)/i, ' $1'); },
        };
      }
      c.apexInstance.updateSeries([{ name: c.yColumn || c.title, data: values }]);
      c.apexInstance.updateOptions({ xaxis: xaxisOpts });
    }
  });
}, 200));