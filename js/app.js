let chartPrimaryInstance = null;
let chartSecondaryInstance = null;
let currentFocusTarget = null;
let cachedRepos = [];
let activeTabId = 'repositories';
const PAGE_SIZE = 10;

let rawStore = {
  repos: [], repoIndex: 0,
  repoPrs: [], repoPrsIndex: 0,
  access: [], accessIndex: 0,
  commits: [], commitsIndex: 0,
  pipelines: [], pipelineIndex: 0,
  releases: [], releaseIndex: 0,
  workitems: [], workitemsIndex: 0,
  sprints: [],
  artifacts: []
};

function showModal(message, targetFocusId) {
  currentFocusTarget = targetFocusId;
  document.getElementById('modalMessage').textContent = message;
  document.getElementById('validationModal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('validationModal').classList.add('hidden');
  if (currentFocusTarget) {
    const target = document.getElementById(currentFocusTarget);
    if (target) {
      target.focus();
      target.classList.add('ring-2', 'ring-blue-400');
      setTimeout(() => target.classList.remove('ring-2', 'ring-blue-400'), 1500);
    }
  }
}

function setStatus(msg, type = 'info') {
  const el = document.getElementById('statusBar');
  el.classList.remove('hidden', 'bg-red-500/10', 'text-red-400', 'border-red-500/30', 'bg-emerald-500/10', 'text-emerald-400', 'border-emerald-500/30', 'bg-blue-500/10', 'text-blue-400', 'border-blue-500/30');
  el.classList.add('border');

  if (type === 'error') {
    el.classList.add('bg-red-500/10', 'text-red-400', 'border-red-500/30');
  } else if (type === 'success') {
    el.classList.add('bg-emerald-500/10', 'text-emerald-400', 'border-emerald-500/30');
  } else {
    el.classList.add('bg-blue-500/10', 'text-blue-400', 'border-blue-500/30');
  }
  el.textContent = msg;
}

function updatePathPreview(org = '', project = '') {
  const linkEl = document.getElementById('generatedUrlLink');
  let url = 'https://dev.azure.com/';
  if (org) url += org;
  if (org && project) url += `/${project}`;

  linkEl.textContent = url;
  linkEl.href = url;
  if (org) {
    linkEl.className = 'text-blue-400 font-mono underline hover:text-blue-300 cursor-pointer';
    linkEl.target = '_blank';
  } else {
    linkEl.className = 'text-slate-500 font-mono underline cursor-default';
    linkEl.removeAttribute('target');
  }
}

function initCredentials() {
  const savedOrg = localStorage.getItem('azdo_org');
  const savedPat = localStorage.getItem('azdo_pat');
  if (savedOrg) document.getElementById('targetOrg').value = savedOrg;
  if (savedPat) {
    document.getElementById('targetPat').value = savedPat;
    document.getElementById('chkRememberCreds').checked = true;
  }
  handleOrgChange();
}

function toggleRememberCreds() {
  const isChecked = document.getElementById('chkRememberCreds').checked;
  if (isChecked) {
    localStorage.setItem('azdo_org', document.getElementById('targetOrg').value.trim());
    localStorage.setItem('azdo_pat', document.getElementById('targetPat').value.trim());
  } else {
    localStorage.removeItem('azdo_org');
    localStorage.removeItem('azdo_pat');
  }
}

function handleOrgChange() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  updatePathPreview(org);
  const el = document.getElementById('projectSelect');
  el.innerHTML = '<option value="">-- Connect with PAT first --</option>';
  el.disabled = true;
  el.className = 'w-full text-xs bg-slate-900/50 border border-slate-700 rounded-xl px-3.5 py-2.5 text-slate-500 cursor-not-allowed font-medium';
}

async function loadProjectsList() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const pat = document.getElementById('targetPat').value.trim();

  if (!org) return showModal('Please enter your Azure DevOps Organization name first.', 'targetOrg');
  if (!pat) return showModal('Please enter your Personal Access Token (PAT).', 'targetPat');

  if (document.getElementById('chkRememberCreds').checked) {
    localStorage.setItem('azdo_org', org);
    localStorage.setItem('azdo_pat', pat);
  }

  const authHeader = 'Basic ' + btoa(':' + pat);
  setStatus(`Connecting to https://dev.azure.com/${org}...`, 'info');

  try {
    const url = `https://dev.azure.com/${org}/_apis/projects?api-version=${API_VERSION}&$top=500`;
    const data = await fetchAzDo(url, authHeader);
    const projects = data.value || [];

    const projDropdown = document.getElementById('projectSelect');
    projDropdown.innerHTML = '<option value="">-- Select Project Scope --</option>';

    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      projDropdown.appendChild(opt);
    });

    projDropdown.disabled = false;
    projDropdown.className = 'w-full text-xs bg-slate-900 border border-slate-700 rounded-xl px-3.5 py-2.5 text-slate-200 focus:ring-2 focus:ring-blue-500 focus:outline-none transition font-medium cursor-pointer shadow-inner';
    setStatus(`Connected! Loaded ${projects.length} projects. Select a project scope to proceed.`, 'success');
  } catch (err) {
    setStatus(`Connection Error: ${err.message}`, 'error');
  }
}

async function handleProjectSelection() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim();

  if (!project) {
    updatePathPreview(org);
    document.getElementById('activeScopeLabel').textContent = 'Awaiting Project Connection';
    return;
  }

  updatePathPreview(org, project);
  document.getElementById('activeScopeLabel').textContent = `Connected Scope: ${project}`;
  document.getElementById('kpi-1-val').textContent = project;

  const authHeader = 'Basic ' + btoa(':' + pat);
  try {
    const url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories?api-version=${API_VERSION}`;
    const data = await fetchAzDo(url, authHeader);
    cachedRepos = data.value || [];
    populateRepoDropdown();
  } catch (e) {}

  // Auto trigger the currently active tab
  triggerActiveTabScan();
}

// Level 3 Navigation Switcher
function switchDetailTab(tabKey) {
  activeTabId = tabKey;

  // Toggle Tab Header Styles
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.remove('active-tab', 'text-white', 'bg-blue-600', 'shadow-lg');
    btn.classList.add('text-slate-400');
  });
  const activeBtn = document.getElementById(`tab-${tabKey}`);
  if (activeBtn) {
    activeBtn.classList.add('active-tab');
    activeBtn.classList.remove('text-slate-400');
  }

  // Toggle Tab Filters
  document.querySelectorAll('.detail-filter').forEach(f => f.classList.add('hidden'));
  const activeFilter = document.getElementById(`filter-${tabKey}`);
  if (activeFilter) activeFilter.classList.remove('hidden');

  // Toggle Tab Views
  document.querySelectorAll('.detail-view').forEach(v => v.classList.add('hidden'));
  const activeView = document.getElementById(`view-${tabKey}`);
  if (activeView) activeView.classList.remove('hidden');

  triggerActiveTabScan();
}

function triggerActiveTabScan() {
  const project = document.getElementById('projectSelect').value;
  if (!project) return;

  if (activeTabId === 'repositories') fetchRepositoryData();
  else if (activeTabId === 'pipelines') fetchPipelineData();
  else if (activeTabId === 'workitems') fetchWorkItemsData();
  else if (activeTabId === 'access') fetchUserAccessData();
  else if (activeTabId === 'artifacts') fetchArtifactsData();
}

function filterActiveTable() {
  const query = document.getElementById('tableFilterInput').value.toLowerCase();
  const activeView = document.getElementById(`view-${activeTabId}`);
  if (!activeView) return;

  const rows = activeView.querySelectorAll('tbody tr');
  rows.forEach(r => {
    const text = r.textContent.toLowerCase();
    r.style.display = text.includes(query) ? '' : 'none';
  });
}

function exportToExcelFile(sheetsData, baseFileName) {
  if (typeof XLSX === 'undefined') return;
  const wb = XLSX.utils.book_new();
  let hasData = false;

  for (const [sheetName, data] of Object.entries(sheetsData)) {
    if (data && data.length > 0) {
      const ws = XLSX.utils.json_to_sheet(data);
      XLSX.utils.book_append_sheet(wb, ws, sheetName.substring(0, 31));
      hasData = true;
    }
  }

  if (hasData) XLSX.writeFile(wb, `${baseFileName}_${Date.now()}.xlsx`);
}

function exportCurrentTableToXLSX() {
  if (activeTabId === 'repositories') exportBranchesToXLSX();
  else if (activeTabId === 'pipelines') exportPipelinesToXLSX();
  else if (activeTabId === 'workitems') exportWorkItemsToXLSX();
  else if (activeTabId === 'access') exportAccessToXLSX();
  else if (activeTabId === 'activity') exportActivityToXLSX();
  else if (activeTabId === 'artifacts') exportArtifactsToXLSX();
}

function renderDualCharts(primary, secondary) {
  if (typeof ChartDataLabels !== 'undefined') Chart.register(ChartDataLabels);

  document.getElementById('chartTitlePrimary').textContent = primary.title;
  document.getElementById('chartTitleSecondary').textContent = secondary.title;

  const darkPalette = ['#3b82f6', '#10b981', '#6366f1', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#84cc16'];

  // Chart 1
  const ctx1 = document.getElementById('analyticsChartPrimary').getContext('2d');
  if (chartPrimaryInstance) chartPrimaryInstance.destroy();

  const isPie1 = primary.type === 'pie' || primary.type === 'doughnut';
  chartPrimaryInstance = new Chart(ctx1, {
    type: primary.type || 'bar',
    data: {
      labels: primary.labels.length ? primary.labels : ['No Data'],
      datasets: [{
        label: primary.label || 'Distribution',
        data: primary.data.length ? primary.data : [0],
        backgroundColor: isPie1 ? darkPalette : '#3b82f6',
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: isPie1, position: 'right', labels: { color: '#94a3b8' } },
        datalabels: {
          display: true,
          color: '#ffffff',
          font: { weight: 'bold', size: 10 },
          formatter: (v) => v > 0 ? v : ''
        }
      },
      scales: isPie1 ? {} : {
        y: { beginAtZero: true, grid: { color: 'rgba(51, 65, 85, 0.4)' }, ticks: { color: '#94a3b8', precision: 0 } },
        x: { grid: { display: false }, ticks: { color: '#94a3b8', autoSkip: false, maxRotation: 45 } }
      }
    }
  });

  // Chart 2
  const ctx2 = document.getElementById('analyticsChartSecondary').getContext('2d');
  if (chartSecondaryInstance) chartSecondaryInstance.destroy();

  const isPie2 = secondary.type === 'pie' || secondary.type === 'doughnut';
  chartSecondaryInstance = new Chart(ctx2, {
    type: secondary.type || 'bar',
    data: {
      labels: secondary.labels.length ? secondary.labels : ['No Data'],
      datasets: [{
        label: secondary.label || 'Velocity / Metric',
        data: secondary.data.length ? secondary.data : [0],
        backgroundColor: isPie2 ? darkPalette : '#10b981',
        borderColor: secondary.type === 'line' ? '#10b981' : undefined,
        fill: false,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: isPie2, position: 'right', labels: { color: '#94a3b8' } },
        datalabels: {
          display: true,
          color: '#ffffff',
          font: { weight: 'bold', size: 10 },
          formatter: (v) => v > 0 ? v : ''
        }
      },
      scales: isPie2 ? {} : {
        y: { beginAtZero: true, grid: { color: 'rgba(51, 65, 85, 0.4)' }, ticks: { color: '#94a3b8', precision: 0 } },
        x: { grid: { display: false }, ticks: { color: '#94a3b8', autoSkip: false, maxRotation: 45 } }
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', initCredentials);