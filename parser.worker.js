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

/**
 * Scans the first up to 10 rows to find the actual header row.
 * A header row is the first row that has ≥2 non-empty cells where the
 * majority of values are non-numeric strings — and is followed by at
 * least one non-empty row of data.
 * Falls back to row 0 if no better candidate is found (normal CSVs).
 */
function detectHeaderRow(rows) {
  const maxScan = Math.min(10, rows.length);
  for (let i = 0; i < maxScan; i++) {
    const row = rows[i];
    const nonEmpty = row.filter(v => v !== '' && v !== null && v !== undefined);
    if (nonEmpty.length < 2) continue; // need at least 2 columns

    // Count cells that look like header labels (strings that aren't plain numbers)
    const labelCount = nonEmpty.filter(v => {
      if (typeof v === 'number') return false;
      const s = String(v).trim();
      return s !== '' && isNaN(parseFloat(s));
    }).length;

    if (labelCount / nonEmpty.length >= 0.5) {
      // Confirm there's actual data after this row
      const hasDataAfter = rows.slice(i + 1).some(r =>
        Array.isArray(r) && r.some(c => c !== '' && c !== null && c !== undefined)
      );
      if (hasDataAfter) return i;
    }
  }
  return 0; // default: first row is the header
}

function processRawRows(rows, fileName) {
  if (!rows || rows.length < 2) {
    throw new Error('File has fewer than 2 rows. Need at least a header row and one data row.');
  }

  // --- 0. Detect header row (handles files with leading metadata rows) ---
  const headerRowIdx = detectHeaderRow(rows);
  if (headerRowIdx > 0) {
    progress(`Metadata detected — using row ${headerRowIdx + 1} as column headers.`);
  }

  // --- 1. Extract headers ---
  const rawHeaders = rows[headerRowIdx].map(h => String(h ?? '').trim());
  // Clean up testmy.net-style "Date format: ..." prefix in the first column header
  const headers = rawHeaders
    .map(h => h.replace(/^date format:\s*/i, 'Date').trim())
    .filter(h => h !== '');
  const colCount = headers.length;

  if (colCount === 0) throw new Error('No column headers found in the first row.');

  progress(`Found ${colCount} column(s): ${headers.join(', ')}`);

  // --- 2. Extract data rows (drop fully empty rows) ---
  let dataRows = rows.slice(headerRowIdx + 1).filter(row =>
    row.some(c => c !== '' && c !== null && c !== undefined)
  );

  const originalRowCount = dataRows.length;
  progress(`${originalRowCount} data row(s) found.`);

  // --- 2.5 Sort by Date (if a date column exists) ---
  const dateColIdx = headers.findIndex(h => {
    const firstVal = dataRows[0][headers.indexOf(h)];
    return parseFlexibleDate(firstVal) !== null;
  });

  if (dateColIdx !== -1) {
    progress(`Sorting dataset by column: "${headers[dateColIdx]}"...`);
    dataRows.sort((a, b) => {
      const da = parseFlexibleDate(a[dateColIdx]);
      const db = parseFlexibleDate(b[dateColIdx]);
      return (da?.getTime() || 0) - (db?.getTime() || 0);
    });
  }

  // --- 3. Downsample if needed ---
  const DOWNSAMPLE_THRESHOLD = 1000;
  let downsampled = false;
  if (originalRowCount > DOWNSAMPLE_THRESHOLD) {
  progress(`Downsampling ${originalRowCount} rows to ${DOWNSAMPLE_THRESHOLD} using LTTB for visual fidelity...`);
  dataRows = downsampleLTTB(dataRows, DOWNSAMPLE_THRESHOLD);
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
    const nums = rawValues.map(v => {
      if (typeof v === 'number') return v;
      if (v === '' || v === null || v === undefined) return null;
      const s = String(v).replace(/[$,%\s]/g, '');
      const n = parseFloat(s);
      return isNaN(n) ? null : n; // Return null instead of 0 for non-parsable values to avoid skewing stats
    });

    // Compute stats only on non-empty values for better accuracy
    const validNums = nums.filter(v => v !== null);
    const stats = computeNumericStats(validNums);
    const labels = rawValues.map((_, i) => String(i + 1));

    return { name, role, values: nums, labels, stats };
  }

  if (role === 'date') {
    const parsed  = rawValues.map(v => parseFlexibleDate(v));
    const valid   = parsed.filter(d => d !== null);

    // Upgrade to 'datetime' if ≥10% of parsed values have a non-midnight time component.
    // This handles columns like "Sun Mar 29 2026 @ 5:00:37 pm" where multiple rows
    // share the same calendar day but differ by time.
    const withTime = valid.filter(d => d.getHours() !== 0 || d.getMinutes() !== 0 || d.getSeconds() !== 0);
    const isDatetime = valid.length > 0 && (withTime.length / valid.length) >= 0.1;
    const actualRole = isDatetime ? 'datetime' : 'date';

    const labels  = parsed.map(d => d ? (isDatetime ? formatDatetimeLabel(d) : formatDateLabel(d)) : '');
    const values  = parsed.map(d => d ? d.getTime() : null);

    return { name, role: actualRole, values, labels, stats: null, dateObjects: valid };
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
    values: rawValues.map(v => {
      const s = String(v ?? '').trim();
      return s === '' ? '(Empty)' : s;
    }),
    labels: rawValues.map(v => {
      const s = String(v ?? '').trim();
      return s === '' ? '(Empty)' : s;
    }),
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

  // testmy.net format: "Sun Mar 29 2026 @ 3:47:37 pm"
  // The "@" separator breaks the standard Date parser — strip it first.
  const testmyMatch = s.match(/^(\w+\s+\w+\s+\d+\s+\d{4})\s*@\s*(\d+:\d+:\d+\s*[ap]m)$/i);
  if (testmyMatch) {
    const d = new Date(`${testmyMatch[1]} ${testmyMatch[2]}`);
    if (!isNaN(d.getTime()) && d.getFullYear() > 1900 && d.getFullYear() < 2100) return d;
  }

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

function formatDatetimeLabel(d) {
  // Returns a label that includes time — used when multiple rows share the same
  // calendar day but have different timestamps (role === 'datetime').
  // Seconds are included to ensure uniqueness for sub-minute data.
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit',
    hour12: true,
  });
}

/* ============================================================
   NUMERIC STATISTICS
============================================================ */

function computeNumericStats(nums) {
  // 1. Filter to ensure we only operate on real numbers
  const cleanNums = nums.filter(v => v !== null && !isNaN(v) && typeof v === 'number');
  
  if (cleanNums.length === 0) return null;

  const sorted = [...cleanNums].sort((a, b) => a - b);
  const n      = cleanNums.length;
  const sum    = cleanNums.reduce((s, v) => s + v, 0);
  
  // 2. Basic Descriptive Statistics
  const mean   = sum / n;
  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)];
  
  const variance = cleanNums.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / n;
  const std      = Math.sqrt(variance);
  const min      = sorted[0];
  const max      = sorted[n - 1];

  // 3. Peak and Trough Indices 
  // Find the index in the ORIGINAL 'nums' array to maintain alignment with X-axis labels 
  const peakIdx   = nums.indexOf(max);
  const troughIdx = nums.indexOf(min);

  // 4. Linear Regression for Trend Analysis
  // Note: Using 'cleanNums' indices (0 to n-1) for the regression slope
  const xMean = (n - 1) / 2;
  const ssX   = cleanNums.reduce((s, _, x) => s + Math.pow(x - xMean, 2), 0);
  
  // Slope calculation: (sum of (x - xMean) * (y - yMean)) / ssX
  const slope = ssX === 0 ? 0
    : cleanNums.reduce((s, y, x) => s + (x - xMean) * (y - mean), 0) / ssX;

  // 5. Trend Classification 
  // Threshold (0.005) determines if the movement is significant relative to the mean
  const relSlope = mean !== 0 ? Math.abs(slope / mean) : 0;
  const trend = relSlope < 0.005 ? 'stable'
              : slope > 0        ? 'upward'
              :                    'downward';

  // 6. Growth Rate 
  // Simple percentage change from the first valid point to the last valid point
  const firstVal = cleanNums[0];
  const lastVal  = cleanNums[n - 1];
  const growth_rate = (firstVal !== 0 && firstVal !== null)
    ? ((lastVal - firstVal) / Math.abs(firstVal)) * 100
    : null;

  return { 
    mean, 
    median, 
    std, 
    min, 
    max, 
    trend, 
    growth_rate, 
    peakIdx, 
    troughIdx, 
    slope 
  };
}

/* ============================================================
   DOWNSAMPLING — LTTB (Largest Triangle Three Buckets)
   Preserves visual characteristics (peaks/troughs) better than 
   uniform sampling for large time-series datasets.
============================================================ */

function downsampleLTTB(data, threshold) {
  const dataLength = data.length;
  if (threshold >= dataLength || threshold === 0) return data;

  const sampled = [];
  let sampledIndex = 0;

  // Need a numeric Y-axis to calculate the "area". 
  // Use the first numeric column we find in the row.
  const firstNumericIdx = data[0].findIndex(v => typeof v === 'number');
  const yIdx = firstNumericIdx !== -1 ? firstNumericIdx : 0;

  // Bucket size. Leave room for start and end points
  const bucketSize = (dataLength - 2) / (threshold - 2);

  let a = 0; // The fixed point
  let maxAreaBucketNext, maxArea, area, nextA;

  sampled[sampledIndex++] = data[a]; // Always add the first point

  for (let i = 0; i < threshold - 2; i++) {
    // Calculate point average for next bucket (b)
    let avgX = 0, avgY = 0, avgRangeStart = Math.floor((i + 1) * bucketSize) + 1;
    let avgRangeEnd = Math.floor((i + 2) * bucketSize) + 1;
    avgRangeEnd = avgRangeEnd < dataLength ? avgRangeEnd : dataLength;

    const avgRangeLength = avgRangeEnd - avgRangeStart;

    for (; avgRangeStart < avgRangeEnd; avgRangeStart++) {
      avgX += avgRangeStart; 
      avgY += (typeof data[avgRangeStart][yIdx] === 'number' ? data[avgRangeStart][yIdx] : 0);
    }
    avgX /= avgRangeLength;
    avgY /= avgRangeLength;

    // Get the range for this bucket
    let rangeOffs = Math.floor((i + 0) * bucketSize) + 1;
    const rangeTo = Math.floor((i + 1) * bucketSize) + 1;

    // Point a
    const pointAX = a;
    const pointAY = (typeof data[a][yIdx] === 'number' ? data[a][yIdx] : 0);

    maxArea = area = -1;

    for (; rangeOffs < rangeTo; rangeOffs++) {
      // Calculate triangle area over three buckets
      area = Math.abs((pointAX - avgX) * ((typeof data[rangeOffs][yIdx] === 'number' ? data[rangeOffs][yIdx] : 0) - pointAY) -
             (pointAX - rangeOffs) * (avgY - pointAY)) * 0.5;
      
      if (area > maxArea) {
        maxArea = area;
        maxAreaBucketNext = data[rangeOffs];
        nextA = rangeOffs; // Next fixed point
      }
    }

    sampled[sampledIndex++] = maxAreaBucketNext;
    a = nextA;
  }

  sampled[sampledIndex++] = data[dataLength - 1]; // Always add the last point
  return sampled;
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
  const dates      = columns.filter(c => c.role === 'date' || c.role === 'datetime');
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
    if (col.role === 'date' || col.role === 'datetime') {
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