/**
 * parser.worker.js — Insight Data Parser Web Worker
 *
 * Runs off the main thread. Receives file data, parses it with
 * SheetJS (Excel) or PapaParse (CSV), performs column analysis,
 * and returns a structured dataset to the main thread.
 *
 * Message protocol:
 *   IN  → { type: 'PARSE_EXCEL',    payload: { buffer: ArrayBuffer, fileName } }
 *   IN  → { type: 'PARSE_CSV_TEXT', payload: { text: string,        fileName } }
 *   OUT → { type: 'PARSE_COMPLETE', payload: DatasetResult }
 *   OUT → { type: 'PARSE_ERROR',    error: string }
 *   OUT → { type: 'PARSE_PROGRESS', message: string }  (status updates)
 */

importScripts(
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js'
);

/* ============================================================
   ENTRY POINT
============================================================ */
self.onmessage = function (e) {
  const { type, payload } = e.data;
  try {
    if (type === 'PARSE_EXCEL')    parseExcel(payload);
    else if (type === 'PARSE_CSV_TEXT') parseCSVText(payload);
    else throw new Error('Unknown message type: ' + type);
  } catch (err) {
    self.postMessage({ type: 'PARSE_ERROR', error: err.message });
  }
};

/* ============================================================
   PARSERS
============================================================ */

function parseExcel({ buffer, fileName }) {
  progress('Reading Excel workbook…');
  const wb = XLSX.read(new Uint8Array(buffer), {
    type: 'array',
    cellDates: true,   // parse date cells as JS Date objects
    cellNF: false,
    cellText: false,
  });

  const sheetName = wb.SheetNames[0];
  progress(`Using sheet: "${sheetName}" (${wb.SheetNames.length} sheet(s) found)`);

  const ws = wb.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json(ws, {
    header: 1,      // return array-of-arrays
    defval: '',     // empty cells → ''
    raw: false,     // use formatted strings for numbers/dates
  });

  // Re-read with raw:true to get actual numbers/Date objects
  const rawRowsTyped = XLSX.utils.sheet_to_json(ws, {
    header: 1,
    defval: '',
    raw: true,
  });

  processRawRows(rawRowsTyped, fileName);
}

function parseCSVText({ text, fileName }) {
  progress('Parsing CSV…');
  const result = Papa.parse(text.trim(), {
    header: false,
    skipEmptyLines: true,
    dynamicTyping: true,  // auto-convert numbers/booleans
  });

  if (result.errors.length > 0) {
    const serious = result.errors.filter(e => e.type !== 'FieldMismatch');
    if (serious.length > 0) {
      throw new Error('CSV parse error: ' + serious[0].message);
    }
  }

  processRawRows(result.data, fileName);
}

/* ============================================================
   CORE PROCESSING PIPELINE
============================================================ */

function processRawRows(rows, fileName) {
  if (!rows || rows.length < 2) {
    throw new Error('File has fewer than 2 rows. Need at least a header row and one data row.');
  }

  // --- 1. Extract headers ---
  const headers = rows[0].map(h => String(h ?? '').trim()).filter(h => h !== '');
  const colCount = headers.length;

  if (colCount === 0) throw new Error('No column headers found in the first row.');

  progress(`Found ${colCount} column(s): ${headers.join(', ')}`);

  // --- 2. Extract data rows (drop fully empty rows) ---
  let dataRows = rows.slice(1).filter(row =>
    row.some(c => c !== '' && c !== null && c !== undefined)
  );

  const originalRowCount = dataRows.length;
  progress(`${originalRowCount} data row(s) found.`);

  // --- 3. Downsample if needed ---
  const DOWNSAMPLE_THRESHOLD = 1000;
  let downsampled = false;
  if (originalRowCount > DOWNSAMPLE_THRESHOLD) {
    progress(`Dataset exceeds ${DOWNSAMPLE_THRESHOLD} rows — downsampling to ${DOWNSAMPLE_THRESHOLD} rows using uniform sampling…`);
    dataRows = uniformSample(dataRows, DOWNSAMPLE_THRESHOLD);
    downsampled = true;
  }

  // --- 4. Build per-column raw value arrays ---
  const rawCols = headers.map((name, i) => ({
    name,
    rawValues: dataRows.map(row => (row[i] !== undefined ? row[i] : '')),
  }));

  // --- 5. Analyse each column ---
  progress('Analysing column types and computing statistics…');
  const columns = rawCols.map(col => analyseColumn(col));

  columns.forEach(col => {
    progress(`  Column "${col.name}" → role: ${col.role}${col.stats ? `, mean: ${col.stats.mean.toFixed(2)}, trend: ${col.stats.trend}` : ''}`);
  });

  // --- 6. Generate chart suggestions ---
  const suggestions = suggestCharts(columns);
  progress(`Generated ${suggestions.length} chart suggestion(s): ${suggestions.map(s => `"${s.title}" (${s.type})`).join(', ')}`);

  // --- 7. Build derived data summary (what would be sent to the backend/Gemini) ---
  const derivedData = buildDerivedData(columns);

  // --- 8. Done ---
  self.postMessage({
    type: 'PARSE_COMPLETE',
    payload: {
      fileName,
      rowCount: originalRowCount,
      downsampled,
      columns,
      suggestions,
      derivedData,
    },
  });
}

/* ============================================================
   COLUMN ANALYSIS
============================================================ */

function analyseColumn({ name, rawValues }) {
  const role = detectRole(rawValues);

  if (role === 'numeric') {
    const nums = rawValues
      .map(v => {
        if (typeof v === 'number') return v;
        const s = String(v).replace(/[$,%\s]/g, '');
        return s !== '' ? parseFloat(s) : NaN;
      })
      .filter(n => !isNaN(n) && isFinite(n));

    const stats = computeNumericStats(nums);
    // Labels: index strings by default; caller can pair with a date/cat column
    const labels = rawValues.map((_, i) => String(i + 1));

    return { name, role, values: nums, labels, stats };
  }

  if (role === 'date') {
    const parsed  = rawValues.map(v => parseFlexibleDate(v));
    const valid   = parsed.filter(d => d !== null);
    const labels  = parsed.map(d => d ? formatDateLabel(d) : '');
    const values  = parsed.map(d => d ? d.getTime() : null);

    return { name, role, values, labels, stats: null, dateObjects: valid };
  }

  // Categorical
  const freq = {};
  rawValues.forEach(v => {
    const k = String(v ?? '').trim();
    if (k !== '') freq[k] = (freq[k] || 0) + 1;
  });
  const categories = Object.entries(freq)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);

  return {
    name,
    role,
    values: rawValues.map(v => String(v ?? '').trim()),
    labels: rawValues.map(v => String(v ?? '').trim()),
    categories,
    stats: null,
  };
}

function detectRole(values) {
  const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
  if (nonEmpty.length === 0) return 'categorical';

  // If the raw values are already Date objects (from SheetJS cellDates:true)
  const dateObjCount = nonEmpty.filter(v => v instanceof Date && !isNaN(v.getTime())).length;
  if (dateObjCount / nonEmpty.length >= 0.7) return 'date';

  // Numeric check
  const numericCount = nonEmpty.filter(v => {
    if (typeof v === 'number') return isFinite(v);
    const s = String(v).replace(/[$,%\s]/g, '');
    return s !== '' && !isNaN(parseFloat(s)) && isFinite(parseFloat(s));
  }).length;
  if (numericCount / nonEmpty.length >= 0.8) return 'numeric';

  // Date string check
  const dateStrCount = nonEmpty.filter(v => parseFlexibleDate(v) !== null).length;
  if (dateStrCount / nonEmpty.length >= 0.7) return 'date';

  return 'categorical';
}

function parseFlexibleDate(v) {
  if (!v && v !== 0) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;

  // Excel serial number (XLSX raw:true returns numbers for date cells
  // when cellDates is false; here cellDates:true so mostly Date objects above)
  if (typeof v === 'number' && v > 1 && v < 2958466) {
    try {
      const info = XLSX.SSF.parse_date_code(v);
      if (info) return new Date(info.y, info.m - 1, info.d);
    } catch { /* ignore */ }
  }

  const s = String(v).trim();
  if (!s) return null;

  // Common date string patterns
  const d = new Date(s);
  if (!isNaN(d.getTime()) && d.getFullYear() > 1900 && d.getFullYear() < 2100) return d;

  // Try dd/mm/yyyy
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (dmy) {
    const [, dd, mm, yyyy] = dmy;
    const yr = yyyy.length === 2 ? 2000 + parseInt(yyyy) : parseInt(yyyy);
    const candidate = new Date(yr, parseInt(mm) - 1, parseInt(dd));
    if (!isNaN(candidate.getTime())) return candidate;
  }

  return null;
}

function formatDateLabel(d) {
  // Returns a short label suitable for chart x-axis
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

/* ============================================================
   NUMERIC STATISTICS
============================================================ */

function computeNumericStats(nums) {
  if (nums.length === 0) return null;

  const sorted = [...nums].sort((a, b) => a - b);
  const n      = nums.length;
  const sum    = nums.reduce((s, v) => s + v, 0);
  const mean   = sum / n;
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];
  const variance = nums.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / n;
  const std    = Math.sqrt(variance);
  const min    = sorted[0];
  const max    = sorted[n - 1];

  // Positions for peak and trough
  const peakIdx   = nums.indexOf(max);
  const troughIdx = nums.indexOf(min);

  // Simple linear regression slope (for trend detection)
  const xMean = (n - 1) / 2;
  const ssX   = nums.reduce((s, _, x) => s + Math.pow(x - xMean, 2), 0);
  const slope = ssX === 0 ? 0
    : nums.reduce((s, y, x) => s + (x - xMean) * (y - mean), 0) / ssX;

  // Trend: slope relative to mean magnitude
  const relSlope = mean !== 0 ? Math.abs(slope / mean) : 0;
  const trend = relSlope < 0.005 ? 'stable'
              : slope > 0        ? 'upward'
              :                    'downward';

  // Growth rate: (last - first) / |first| × 100
  const growth_rate = nums[0] !== 0
    ? ((nums[n - 1] - nums[0]) / Math.abs(nums[0])) * 100
    : null;

  return { mean, median, std, min, max, trend, growth_rate, peakIdx, troughIdx, slope };
}

/* ============================================================
   DOWNSAMPLING — Uniform sampling
   For time series with >1000 rows, LTTB would be ideal,
   but uniform sampling is implemented here for simplicity.
   Replace with LTTB for better visual fidelity on dense data.
============================================================ */

function uniformSample(rows, target) {
  const result = [];
  const step   = (rows.length - 1) / (target - 1);
  for (let i = 0; i < target; i++) {
    result.push(rows[Math.round(i * step)]);
  }
  return result;
}

/* ============================================================
   CHART SUGGESTIONS
   Rules:
   - date × numeric  → line (first), area (second numeric)
   - cat  × numeric  → bar
   - cat  × numeric  → donut (if ≤10 categories)
   Falls back to first two columns if nothing matches.
============================================================ */

function suggestCharts(columns) {
  const dates      = columns.filter(c => c.role === 'date');
  const cats       = columns.filter(c => c.role === 'categorical');
  const numerics   = columns.filter(c => c.role === 'numeric');
  const suggestions = [];

  // Rule 1: date column + first numeric → line
  if (dates.length > 0 && numerics.length > 0) {
    suggestions.push({
      title:   `${numerics[0].name} over time`,
      type:    'line',
      xColumn: dates[0].name,
      yColumn: numerics[0].name,
    });
    // Second numeric → area
    if (numerics[1]) {
      suggestions.push({
        title:   `${numerics[1].name} over time`,
        type:    'area',
        xColumn: dates[0].name,
        yColumn: numerics[1].name,
      });
    }
  }

  // Rule 2: categorical + numeric → bar
  if (cats.length > 0 && numerics.length > 0 && suggestions.length < 3) {
    suggestions.push({
      title:   `${numerics[0].name} by ${cats[0].name}`,
      type:    'bar',
      xColumn: cats[0].name,
      yColumn: numerics[0].name,
    });
  }

  // Rule 3: categorical (≤10 cats) + numeric → donut
  if (cats.length > 0 && numerics.length > 0 && suggestions.length < 3) {
    const catCol = cats.find(c => c.categories && c.categories.length <= 10);
    if (catCol) {
      suggestions.push({
        title:   `${numerics[0].name} distribution`,
        type:    'donut',
        xColumn: catCol.name,
        yColumn: numerics[0].name,
      });
    }
  }

  // Fallback: use first two columns as-is
  if (suggestions.length === 0 && columns.length >= 2) {
    suggestions.push({
      title:   `${columns[1].name} by ${columns[0].name}`,
      type:    'bar',
      xColumn: columns[0].name,
      yColumn: columns[1].name,
    });
  }

  return suggestions.slice(0, 3);
}

/* ============================================================
   DERIVED DATA SUMMARY
   Only this object is sent to the backend/Gemini API,
   never the raw values — preserving user privacy.
============================================================ */

function buildDerivedData(columns) {
  const derived = {};
  columns.forEach(col => {
    if (col.role === 'numeric' && col.stats) {
      const s = col.stats;
      derived[col.name] = {
        mean:        +s.mean.toFixed(4),
        median:      +s.median.toFixed(4),
        std:         +s.std.toFixed(4),
        min:         s.min,
        max:         s.max,
        trend:       s.trend,
        growth_rate: s.growth_rate !== null ? +s.growth_rate.toFixed(2) : null,
        peak_index:  s.peakIdx,
        trough_index:s.troughIdx,
        row_count:   col.values.length,
      };
    }
    if (col.role === 'categorical' && col.categories) {
      derived[col.name] = {
        type:           'categorical',
        unique_count:   col.categories.length,
        top_categories: col.categories.slice(0, 5).map(c => c.label),
        row_count:      col.values.length,
      };
    }
    if (col.role === 'date') {
      const valid = col.dateObjects;
      if (valid && valid.length > 0) {
        const sorted = [...valid].sort((a, b) => a - b);
        derived[col.name] = {
          type:      'date',
          min_date:  sorted[0].toISOString().slice(0, 10),
          max_date:  sorted[sorted.length - 1].toISOString().slice(0, 10),
          row_count: valid.length,
        };
      }
    }
  });
  return derived;
}

/* ============================================================
   UTILITY
============================================================ */

function progress(message) {
  self.postMessage({ type: 'PARSE_PROGRESS', message });
}
