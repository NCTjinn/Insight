# Insight — Data Analytics Dashboard

> **Turn any spreadsheet into an interactive, AI-powered dashboard — entirely in your browser.**

Insight is a zero-install, single page web application that lets you drag-and-drop Excel or CSV files (or connect a live Google Sheet) and instantly build a rich, interactive analytics dashboard — complete with statistical KPI cards, multi-series charts, advanced filtering, AI-generated summaries, and professional PDF exports. Because all data processing happens client-side, your raw data never leaves your device.

---

## Table of Contents

1. [Privacy & Security](#privacy--security)
2. [Key Features](#key-features)
3. [Usage — How to Use](#usage--how-to-use)
   - [Step 1 — Open the Dashboard](#step-1--open-the-dashboard)
   - [Step 2 — Upload Your Data](#step-2--upload-your-data)
   - [Step 3 — Build Your First Chart](#step-3--build-your-first-chart)
   - [Step 4 — Add KPI Stat Cards](#step-4--add-kpi-stat-cards)
   - [Step 5 — Scale by Time](#step-5--scale-by-time)
   - [Step 6 — Generate an AI Summary](#step-6--generate-an-ai-summary)
   - [Step 7 — Customise the Layout](#step-7--customise-the-layout)
   - [Step 8 — Save, Export & Templates](#step-8--save-export--templates)

---

## Privacy & Security

Insight is designed from the ground up with a **privacy-first architecture**. Here is exactly what happens to your data at every step:

| Stage | What happens | What leaves your device |
|---|---|---|
| File upload | Parsed in-browser by PapaParse / XLSX.js | **Nothing** |
| Chart rendering | Computed entirely in browser memory | **Nothing** |
| AI Summary | Only a tiny JSON of derived stats is sent | High-level stats only (e.g. `mean: 42`, `trend: upward`) |
| Export | PDF/PNG generated locally by jsPDF / dom-to-image | **Nothing** |

### How We Handle Your Data

- **Local Parsing** — Excel and CSV files are read and parsed by client-side libraries ([PapaParse](https://www.papaparse.com/) and [XLSX.js](https://sheetjs.com/)) running entirely within your browser's memory tab. The raw bytes of your file are never transmitted anywhere.

- **Stat-Only Transmission** — When you click **"Generate AI Summary"**, the application extracts a minimal JSON payload containing only high-level statistical metadata — things like column means, detected trends, and value ranges. Your actual row data is never included in that payload.

- **Stateless AI** — The AI backend (Google Gemini) receives only the statistical metadata, generates a natural-language summary, and returns it. The backend holds no session state, stores no data, and never has visibility into your original spreadsheet.

- **No Authentication** — Insight requires no user account, no login, no cookies, and no database of any kind. There is nothing to sign up for and no personal information collected.

---

## Key Features

### 1. Privacy & Security — The "Trust" Factor

- **Zero-Cloud Processing** — Raw data is parsed and processed entirely within the browser using client-side libraries (PapaParse and XLSX.js). The original spreadsheet never touches a server.
- **Privacy-Preserving AI** — Only derived statistical metadata (means, peaks, trends) is sent to the AI backend for summarisation. Your actual rows never leave the device.
- **No Authentication** — No accounts, cookies, or databases are required to use the tool.

### 2. Smart Data Ingestion

- **Multi-Format Support** — Drag-and-drop support for Excel (`.xlsx`, `.xls`) and `.csv` files, with instant parsing and schema detection.
- **Live Google Sheets Integration** — Connect to any public Google Sheet by pasting its URL for real-time data visualisation without a manual export step.
- **Auto-Schema Detection** — The system automatically identifies the role of each column — **Numeric**, **Date**, **Datetime**, or **Categorical** — and uses those roles to suggest the most appropriate chart types and axes.

### 3. Dynamic Visualisation Engine

- **Interactive Chart Types** — Support for **Line**, **Bar**, **Area**, and **Donut** charts, all powered by [ApexCharts](https://apexcharts.com/) with smooth animations and hover tooltips.
- **Statistical Quick-Cards** — Generate high-level KPI cards showing **Mean**, **Median**, **Mode**, **Min**, and **Max** for any numeric column at a glance.
- **Advanced Filtering & Grouping**
  - Apply logic filters (`>`, `<`, `=`, `>=`, `<=`, `≠`) to any dataset to focus on a specific subset of your data.
  - Create multi-series charts by grouping data on a categorical column — each unique category becomes its own series, automatically coloured and labelled.
- **Global Time-Scaling** — Instantly slice all dashboard charts simultaneously using preset time ranges (**1M**, **3M**, **6M**, **1Y**) or a custom date-range picker. Every chart updates in unison.

### 4. AI-Powered Insights

- **Automated Summaries** — One-click generation of natural-language summaries using **Google Gemini** that explain what the data actually means, not just what the numbers are.
- **Context-Aware Analysis** — The AI is aware of the specific time range and filters currently applied to the chart, so summaries always reflect what is visible on screen, not the full raw dataset.

### 5. Dashboard Management & Export

- **Customisable Layout** — Drag-and-drop reordering of chart cards. Toggle any chart between half-width and full-width with a single click.
- **Session Persistence** — Save your entire dashboard configuration — charts, filters, AI summaries, and layout — as a portable `.json` file. Reload it later to resume exactly where you left off, without re-uploading your data.
- **Template System** — Save a dashboard "layout" as a reusable template and apply it to a different dataset that shares the same column names. Perfect for recurring reports.
- **High-Fidelity Export**
  - Export individual charts as **PNG** images or single-chart **PDFs**.
  - Export the entire dashboard as a **multi-page PDF report**.

### 6. User Experience

- **Adaptive Theming** — Fully integrated **Dark** and **Light** modes, toggled with a single button. Both themes are carefully tuned for readability and visual contrast.
- **Responsive Design** — Optimised for a range of screen sizes, from large desktop monitors to tablets.
- **In-Place Editing** — Edit chart titles and swap chart configurations directly on the dashboard without opening a separate settings panel.

## Usage — How to Use

### Step 1 — Open the Dashboard

Open https://nctjinn.github.io/Insight/ directly in any modern browser (Chrome, Edge, Firefox, Safari). No server, build step, or installation is required.

![Step 1 — Landing screen showing the Insight wordmark and upload card](docs/screenshots/step-01-landing.png)

> **Tip:** The theme toggle (☾/☀) in the top-right corner lets you switch between Dark and Light mode at any time.

---

### Step 2 — Upload Your Data

You have three ways to load data:

**Option A — Drag & Drop a file**

Drag any `.xlsx`, `.xls`, or `.csv` file onto the dashed drop-zone and release. The file is parsed instantly in-browser.

![Step 2a — Drag-and-drop zone with a file being dragged over it](docs/screenshots/step-02a-drag-drop.png)

**Option B — Click to browse**

Click anywhere inside the drop-zone to open your system file picker and select a file manually.

**Option C — Google Sheets URL**

Switch to the **Google Sheets** tab, paste the public share URL of your sheet, and click **Load Spreadsheet**. The data loads directly from the Google Sheets JSON export API.

![Step 2b — Google Sheets URL tab with a URL entered in the input field](docs/screenshots/step-02b-google-sheets.png)

> **Note:** The Google Sheet must be published to the web or shared with "Anyone with the link can view."

**Option D — Resume a Session**

If you previously saved a session (`.json`) file, switch to the **Load Session** tab, drag or select the session (`.json`) file to restore your full dashboard exactly as you left it.

---

### Step 3 — Build Your First Chart

Once data is loaded, you are taken to the dashboard. Click **"+ Add Chart"** in the top toolbar to open the chart builder panel.

![Step 3a — Dashboard with the "+ Add Chart" button highlighted in the toolbar](docs/screenshots/step-03a-empty-dashboard.png)

In the panel:

1. Choose a **Chart Type** — Line, Bar, Area, or Donut.
2. Select the **X-Axis** column (usually a date or category).
3. Select the **Y-Axis** column (a numeric measure).
4. **(OPTIONAL)** Select the **Group By** column (must be categorical). Each unique value in that column becomes a separate coloured series on the chart.
5. **(OPTIONAL)** Select the **Filter** column to filter on, an **Operator** (`>`, `<`, `=`, `>=`, `<=`, `≠`), and a **Value** to compare against.
6. Give your chart a **Title**.
7. Click **Add Chart**.

![Step 3b — Chart builder side-panel with fields filled in](docs/screenshots/step-03b-chart-builder.png)

The chart appears on the dashboard grid immediately, fully interactive with hover tooltips.

![Step 3c — A line chart rendered on the dashboard](docs/screenshots/step-03c-chart-rendered.png)

---

### Step 4 — Add KPI Stat Cards

To surface a key metric at a glance, click **"+ Add Chart"** and choose **Stat Card** in the **Chart Type**.

1. Choose the **Value Column** you want to measure.
2. Choose the **Statistic** — Mean, Median, Mode, Min, or Max.
3. **(OPTIONAL)** Select the **Filter** column to filter on, an **Operator** (`>`, `<`, `=`, `>=`, `<=`, `≠`), and a **Value** to compare against.
4. Give your chart a **Title**.
5. Click **Add Chart**.

![Step 4 — Stat card builder side-panel with fields filled in](docs/screenshots/step-04-stat-card-builder.png)

---

### Step 5 — Scale by Time

The **global time toolbar** at the top of the dashboard lets you slice all charts simultaneously:

- Click **1M**, **3M**, **6M**, or **1Y** to show only the most recent month, three months, six months, or year of data.
- Click **Custom range** to open a date-range picker and specify exact start and end dates.

![Step 5 — Toolbar with the "6M" time button active and charts showing a 6-month window](docs/screenshots/step-05-time-filter.png)

---

### Step 6 — Generate an AI Summary

Click the **✦ Generate AI summary** button on any chart card.

![Step 6a — A chart card with the AI sparkle button highlighted](docs/screenshots/step-06a-ai-button.png)

Insight extracts a statistical snapshot of the chart's currently-visible data (respecting active time and filters) and sends it — and only it — to Google Gemini. Within seconds, a concise natural-language summary appears beneath the chart explaining what the data means.

![Step 6b — The same chart with an AI summary paragraph displayed beneath it](docs/screenshots/step-06b-ai-summary.png)

> The AI summary is saved as part of your session JSON if you export the session later.

---

### Step 7 — Customise the Layout

**Reorder cards** by dragging a chart card to a new position in the grid.

**Toggle width** by clicking the **⤢** icon on a chart card to switch it between half-width (default, two per row) and full-width (spanning the entire grid row).

![Step 7 — Dashboard with one full-width chart and two half-width charts below it](docs/screenshots/step-07-layout.png)

**Edit titles in place** by clicking directly on a chart's title text and typing a new name.

**Delete a chart** by clicking the **⋮** icon, then **Remove chart** on any card.

---

### Step 8 — Save, Export & Templates

**Save Session**

Click the **Save** dropdown  in the top toolbar, then **Save Session**. A `.json` file is downloaded containing your complete dashboard state — chart configs, filters, time range, AI summaries, and layout order. Drag this file back onto the upload screen at any time to restore everything.

![Step 8a — "Save Session" button in the toolbar](docs/screenshots/step-08a-save-session.png)

**Export Charts**

Click the **⋮ menu** on any chart card to access export options:

- **Export as PDF** — Downloads a single-chart PDF.
- **Export as Image** — Downloads a high-resolution PNG of just that chart.

**Export Full Dashboard as PDF**

Click the **Export** dropdown in the top toolbar to access export options:

- **Select charts to export** — Manually select charts to export by clicking the checkbox at the top left of each chart card.
- **Export all as PDF** — Generate a multi-page PDF of every chart and stat card on the dashboard.
- **Export all as images** — Downloads high-resolution PNGs of every chart and stat card on the dashboard.

![Step 8b — "Export" button in the toolbar](docs/screenshots/step-08b-export.png)

**Save & Load Templates**

- **Save Template** — Click the **Save** dropdown  in the top toolbar, then **Save Template**. This saves only the *layout* (chart types, axes, groupings, and widths) — not the data or AI summaries — as a `insight-template.json` file.
- **Load Template** — Click the **Load Template** button to upload a template file when a different dataset is already loaded. Insight re-creates the same chart configuration using the new dataset's columns, making it easy to apply a consistent reporting layout to weekly or monthly data exports.

---

## Tech Stack

| Library | Role |
|---|---|
| [ApexCharts 3.45](https://apexcharts.com/) | Interactive chart rendering |
| [PapaParse 5.4](https://www.papaparse.com/) | Client-side CSV parsing |
| [XLSX.js 0.18](https://sheetjs.com/) | Client-side Excel parsing |
| [jsPDF 2.5](https://parall.ax/products/jspdf) | PDF generation |
| [dom-to-image-more 3.1](https://github.com/1904labs/dom-to-image-more) | PNG chart export |
| [Google Gemini API](https://ai.google.dev/) | AI summary generation |
| [Outfit (Google Fonts)](https://fonts.google.com/specimen/Outfit) | Typography |

---

## License

This project is released under the [MIT License](LICENSE).