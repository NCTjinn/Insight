// --- DATA & STATE ---
const mockData = [
    { id: 1, title: "Server CPU Load", x: "Time (h)", y: "CPU (%)", type: "line", labels: ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"], data: [12, 15, 45, 78, 55, 20], ai: "Peak CPU usage observed at 12:00 PM reaching 78%. Consider scaling resources during this window." },
    { id: 2, title: "Monthly Sales Revenue", x: "Month", y: "Revenue ($)", type: "bar", labels: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"], data: [12000, 19000, 15000, 22000, 24000, 28000], ai: "Consistent growth trend detected. Sales increased by 133% from January to June." },
    { id: 3, title: "User Retention", x: "Week", y: "Active Users", type: "line", labels: ["W1", "W2", "W3", "W4", "W5", "W6"], data: [1000, 950, 920, 880, 900, 875], ai: "Retention is stable with a minor dip in Week 4. Campaign interventions may have helped recovery." },
    { id: 4, title: "Device Distribution", x: "Device", y: "Share (%)", type: "doughnut", labels: ["Mobile", "Desktop", "Tablet"], data: [60, 30, 10], ai: "Mobile traffic dominates with 60% share. UI optimization for small screens should be a priority." }
];

let selectedCharts = new Set();
let generatedSummaryIds = new Set(); // Track which charts have generated summaries
let charts = {}; // Store Chart.js instances

// --- DOM ELEMENTS ---
const uploadSection = document.getElementById('upload-section');
const dashboardSection = document.getElementById('dashboard-section');
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const urlInput = document.getElementById('url-input');
const analyzeBtn = document.getElementById('analyze-btn');
const chartGrid = document.getElementById('chart-grid');
const massExportWidget = document.getElementById('mass-export-widget');
const countDisplay = document.getElementById('selected-count');
const themeBtn = document.getElementById('theme-btn');
const btnExportAllSummary = document.getElementById('btn-export-all-summary');

// --- THEME LOGIC ---
let isDarkMode = false;
themeBtn.addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    isDarkMode = !isDarkMode;
    // Update icon
    themeBtn.innerHTML = isDarkMode 
        ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`
        : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>`;
});

// --- UPLOAD LOGIC ---
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        urlInput.value = ''; 
        activateAnalyze(e.target.files[0].name);
    }
});
urlInput.addEventListener('input', () => {
    if (urlInput.value.length > 5) {
        fileInput.value = '';
        activateAnalyze("URL provided");
    }
});

function activateAnalyze(name) {
    analyzeBtn.disabled = false;
    analyzeBtn.textContent = `Analyze Data: ${name}`;
}

analyzeBtn.addEventListener('click', () => {
    // Simulate processing
    analyzeBtn.textContent = "Processing...";
    setTimeout(() => {
        uploadSection.style.display = 'none';
        dashboardSection.style.display = 'block';
        initDashboard();
    }, 1000);
});

// --- RESET FUNCTION ---
function resetApp() {
    // Clear data
    selectedCharts.clear();
    generatedSummaryIds.clear();
    chartGrid.innerHTML = '';
    charts = {};
    
    // Reset UI
    dashboardSection.style.display = 'none';
    uploadSection.style.display = 'block';
    massExportWidget.classList.remove('active');
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = "Analyze Data";
    fileInput.value = '';
    urlInput.value = '';
}

// --- DASHBOARD GENERATION ---
function initDashboard() {
    // Get computed CSS colors for Chart.js
    const styles = getComputedStyle(document.body);
    const primaryColor = styles.getPropertyValue('--primary').trim();
    const gridColor = styles.getPropertyValue('--chart-grid').trim();

    // CHANGE 1: Force Chart Text to Blue (#2563eb)
    Chart.defaults.color = '#2563eb'; 
    Chart.defaults.borderColor = gridColor;

    mockData.forEach(item => {
        const card = document.createElement('div');
        card.className = 'chart-card';
        card.id = `card-${item.id}`;
        card.innerHTML = `
            <div class="loading-overlay" id="load-${item.id}">
                <div style="color:var(--primary); font-weight:bold;">Generating AI Insights...</div>
            </div>
            <div class="card-top">
                <div class="card-title">
                    <h3>${item.title}</h3>
                    <div class="card-subtitle">${item.y} against ${item.x}</div>
                </div>
                <button class="select-btn" onclick="toggleSelect(${item.id})">Select</button>
            </div>
            <div class="canvas-container">
                <canvas id="canvas-${item.id}"></canvas>
            </div>
            <div class="ai-summary" id="ai-${item.id}">
                <span class="ai-header">AI-Generated Insight</span>
                <p class="ai-content">${item.ai}</p>
            </div>
            <div class="card-footer">
                <!-- CHANGE 4: ID added to AI button for transformation -->
                <button class="action-btn ai-btn" id="ai-btn-${item.id}" onclick="generateAI(${item.id})">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Generate AI
                </button>
                <button class="action-btn" id="exp-btn-${item.id}" onclick="singleExport(${item.id})">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                    Export PDF
                </button>
            </div>
        `;
        chartGrid.appendChild(card);

        // Init Chart
        const ctx = document.getElementById(`canvas-${item.id}`).getContext('2d');
        const bg = item.type === 'line' ? primaryColor + '20' : primaryColor; // Add transparency for line
        
        charts[item.id] = new Chart(ctx, {
            type: item.type,
            data: {
                labels: item.labels,
                datasets: [{
                    label: item.y,
                    data: item.data,
                    backgroundColor: bg,
                    borderColor: primaryColor,
                    borderWidth: 2,
                    fill: item.type === 'line',
                    tension: 0.3
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: item.type === 'doughnut' } }
            }
        });
    });
}

// --- INTERACTIONS ---

// 1. Select Toggle
function toggleSelect(id) {
    const card = document.getElementById(`card-${id}`);
    const btn = card.querySelector('.select-btn');
    
    if (selectedCharts.has(id)) {
        selectedCharts.delete(id);
        card.classList.remove('selected');
        btn.textContent = "Select";
    } else {
        selectedCharts.add(id);
        card.classList.add('selected');
        btn.textContent = "Selected";
    }
    updateWidget();
}

function updateWidget() {
    const count = selectedCharts.size;
    countDisplay.innerText = count;
    
    if (count > 0) {
        massExportWidget.classList.add('active');
    } else {
        massExportWidget.classList.remove('active');
        // Hide widget entirely if 0 selected
        return;
    }

    // CHANGE 3: Check if selected charts have summaries to enable "Export All Charts+Summaries"
    const hasGeneratedSummary = Array.from(selectedCharts).some(id => generatedSummaryIds.has(id));
    
    if (hasGeneratedSummary) {
        btnExportAllSummary.classList.remove('disabled');
        btnExportAllSummary.disabled = false;
    } else {
        btnExportAllSummary.classList.add('disabled');
        btnExportAllSummary.disabled = true;
    }
}

// 2. Generate AI
function generateAI(id) {
    const loader = document.getElementById(`load-${id}`);
    const summaryBox = document.getElementById(`ai-${id}`);
    const aiBtn = document.getElementById(`ai-btn-${id}`);
    
    // Show loading
    loader.classList.add('active');
    
    // Simulate API delay
    setTimeout(() => {
        loader.classList.remove('active');
        summaryBox.classList.add('visible');
        
        // CHANGE 4: Transform AI Button to "Export with Insights"
        aiBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Export with Insights`;
        
        // Update the onclick handler of this button to export with summary
        aiBtn.onclick = function() { singleExportWithSummary(id); };

        // Track that this chart has a summary
        generatedSummaryIds.add(id);
        
        // Update widget state
        updateWidget();
    }, 1200);
}

// 3. Single Export (Chart Only)
function singleExport(id) {
    alert(`Generating PDF for Chart #${id}...\n\nIncludes: Chart Visual Only.`);
}

// 3b. Single Export (Chart + Summary) - Used by transformed button
function singleExportWithSummary(id) {
    alert(`Generating PDF Report for Chart #${id}...\n\nIncludes: Chart Visual + AI Summary.`);
}

// 4. Mass Export
function massExport(type) {
    const ids = Array.from(selectedCharts);
    const count = ids.length;
    
    if (type === 'charts') {
        alert(`Exporting ${count} charts as individual PDF files...`);
    } else {
        alert(`Exporting ${count} comprehensive reports (Charts + AI Summaries) as a single PDF file...`);
    }
}