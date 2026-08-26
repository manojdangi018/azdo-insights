let chartInstance = null;
let currentFocusTarget = null;
let cachedRepos = [];
let currentChartData = { labels: [], values: [], label: 'Overview' };
let currentChartType = 'bar';
let activeViewSection = 'view-repositories';
const PAGE_SIZE = 10;

let rawStore = {
  repos: [], repoIndex: 0,
  repoPrs: [], repoPrsIndex: 0,
  access: [], accessIndex: 0,
  commits: [], commitsIndex: 0,
  userPrs: [],
  pipelines: [], pipelineIndex: 0,
  pipelineSummary: [],
  workitems: [], workitemsIndex: 0
};

const CATEGORY_META = {
  repositories: { label: 'Repositories', view: 'repositories' },
  user_access: { label: 'Access & Teams', view: 'access' },
  user_activity: { label: 'User Activity', view: 'activity' },
  pipelines: { label: 'Pipelines & Builds', view: 'pipelines' },
  work_items: { label: 'Work Items', view: 'workitems' }
};

function el(id) { return document.getElementById(id); }

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toLocaleString() : '0';
}

function showModal(message, targetFocusId) {
  currentFocusTarget = targetFocusId;
  el('modalMessage').textContent = message;
  el('validationModal').classList.remove('hidden');
}

function closeModal() {
  el('validationModal').classList.add('hidden');
  if (currentFocusTarget) {
    const target = el(currentFocusTarget);
    if (target) {
      target.focus();
      target.classList.add('ring-2', 'ring-red-400');
      setTimeout(() => target.classList.remove('ring-2', 'ring-red-400'), 1200);
    }
  }
}

function setStatus(msg, type = 'info') {
  const status = el('statusBar');
  if (!status) return;
  status.className = `status-bar status-${type}`;
  status.textContent = msg;
  status.classList.remove('hidden');
}

function setConnectionStatus(online, text) {
  const badge = el('connectionBadge');
  const label = el('connectionBadgeText');
  badge.classList.toggle('online', online);
  badge.classList.toggle('offline', !online);
  label.textContent = text || (online ? 'Connected' : 'Not connected');
}

function updatePathPreview(org = '', project = '') {
  const link = el('generatedUrlLink');
  let url = 'https://dev.azure.com/';
  if (org) url += encodeURIComponent(org);
  if (org && project) url += `/${encodeURIComponent(project)}`;
  link.textContent = url;
  link.href = url;
  if (org) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
  else link.removeAttribute('target');
}

function updateScope(project = '') {
  el('activeScopeLabel').textContent = project || 'No project selected';
}

function setLoading(isLoading) {
  const button = el('btnLoadProjects');
  const text = el('loadProjectsText');
  const spinner = el('loadProjectsSpinner');
  button.disabled = isLoading;
  text.classList.toggle('hidden', isLoading);
  spinner.classList.toggle('hidden', !isLoading);
}

function initCredentials() {
  const savedOrg = localStorage.getItem('azdo_org');
  if (savedOrg) el('targetOrg').value = savedOrg;
  el('targetPat').value = sessionStorage.getItem('azdo_pat') || '';
  el('chkRememberCreds').checked = Boolean(savedOrg);
  handleOrgChange();
  setConnectionStatus(false, 'Not connected');
  resetDashboard();
  selectCategory('repositories', false);
}

function toggleRememberCreds() {
  const checked = el('chkRememberCreds').checked;
  const org = el('targetOrg').value.trim();
  if (checked && org) localStorage.setItem('azdo_org', org);
  else localStorage.removeItem('azdo_org');
  // PAT deliberately remains in sessionStorage only; it is not persisted in localStorage.
}

function handleOrgChange() {
  const org = extractOrgName(el('targetOrg').value);
  updatePathPreview(org);
  resetDropdown('projectSelect', '-- Load PAT first --');
  resetDropdown('categorySelect', '-- Select Project first --');
  el('step5Container').classList.add('hidden');
  updateScope('');
  if (el('chkRememberCreds').checked && org) localStorage.setItem('azdo_org', org);
  setConnectionStatus(false, 'Not connected');
}

function resetDropdown(id, placeholder) {
  const dropdown = el(id);
  dropdown.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>`;
  dropdown.disabled = true;
}

function enableDropdown(id) { el(id).disabled = false; }

async function loadProjectsList() {
  const org = extractOrgName(el('targetOrg').value);
  const pat = el('targetPat').value.trim();
  if (!org) return showModal('Please enter the Azure DevOps organization name or URL first.', 'targetOrg');
  if (!pat) return showModal('Please enter your Personal Access Token (PAT).', 'targetPat');

  if (el('chkRememberCreds').checked) localStorage.setItem('azdo_org', org);
  sessionStorage.setItem('azdo_pat', pat);
  const authHeader = buildAuthHeader(pat);
  setLoading(true);
  setStatus(`Connecting to ${org} and loading projects...`, 'info');

  try {
    const url = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects?api-version=${API_VERSION}&$top=500`;
    const data = await fetchAzDo(url, authHeader);
    const projects = data.value || [];
    const dropdown = el('projectSelect');
    dropdown.innerHTML = '<option value="">-- Select a project --</option>';
    projects.sort((a, b) => String(a.name).localeCompare(String(b.name))).forEach(project => {
      const option = document.createElement('option');
      option.value = project.name;
      option.textContent = project.name;
      dropdown.appendChild(option);
    });
    enableDropdown('projectSelect');
    resetDropdown('categorySelect', '-- Select project first --');
    el('step5Container').classList.add('hidden');
    setConnectionStatus(true, 'Connected');
    setStatus(`Connected successfully. ${projects.length.toLocaleString()} project(s) available.`, 'success');
  } catch (err) {
    setConnectionStatus(false, 'Connection failed');
    setStatus(`Unable to load projects: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

async function handleProjectSelection() {
  const org = extractOrgName(el('targetOrg').value);
  const project = el('projectSelect').value;
  const pat = el('targetPat').value.trim() || sessionStorage.getItem('azdo_pat') || '';
  if (!project) {
    resetDropdown('categorySelect', '-- Select project first --');
    el('step5Container').classList.add('hidden');
    updatePathPreview(org);
    updateScope('');
    return;
  }

  updatePathPreview(org, project);
  updateScope(project);
  const category = el('categorySelect');
  category.innerHTML = `
    <option value="">-- Choose an analysis --</option>
    <option value="repositories">Repositories & Branches</option>
    <option value="user_access">Access & Teams</option>
    <option value="user_activity">User Activity & Commits</option>
    <option value="pipelines">Pipelines & Builds</option>
    <option value="work_items">Work Items & Backlog</option>`;
  enableDropdown('categorySelect');

  try {
    cachedRepos = (await fetchAzDo(`https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories?api-version=${API_VERSION}`, buildAuthHeader(pat))).value || [];
    populateRepoDropdown();
    setStatus(`Project selected. ${cachedRepos.length.toLocaleString()} repositories are available.`, 'success');
  } catch (err) {
    cachedRepos = [];
    setStatus(`Project selected, but repository inventory could not be preloaded: ${err.message}`, 'error');
  }
}

function selectCategory(category, requireProject = true) {
  if (!CATEGORY_META[category]) return;
  document.querySelectorAll('.nav-item[data-category]').forEach(item => item.classList.toggle('active', item.dataset.category === category));
  document.querySelectorAll('.category-chip[data-category-chip]').forEach(item => item.classList.toggle('active', item.dataset.categoryChip === category));

  const project = el('projectSelect')?.value;
  if (requireProject && !project) {
    el('categorySelect').value = '';
    el('step5Container').classList.add('hidden');
    return showModal('Select a project first, then choose an analysis category.', 'projectSelect');
  }
  if (el('categorySelect')) {
    el('categorySelect').value = category;
    handleCategorySelection();
  }
}

function handleCategorySelection() {
  const category = el('categorySelect').value;
  const step5 = el('step5Container');
  const sections = ['substepRepo', 'substepAccess', 'substepActivity', 'substepPipelines', 'substepWorkItems'];
  sections.forEach(id => el(id).classList.add('hidden'));
  document.querySelectorAll('.nav-item[data-category]').forEach(item => item.classList.toggle('active', item.dataset.category === category));
  document.querySelectorAll('.category-chip[data-category-chip]').forEach(item => item.classList.toggle('active', item.dataset.categoryChip === category));

  if (!category) { step5.classList.add('hidden'); return; }
  step5.classList.remove('hidden');
  const map = { repositories: 'substepRepo', user_access: 'substepAccess', user_activity: 'substepActivity', pipelines: 'substepPipelines', work_items: 'substepWorkItems' };
  el(map[category]).classList.remove('hidden');
  showSection(CATEGORY_META[category].view);
  el('tableFilterInput').value = '';
}

function showSection(viewId) {
  activeViewSection = `view-${viewId}`;
  ['repositories', 'access', 'activity', 'pipelines', 'workitems'].forEach(view => {
    el(`view-${view}`).classList.toggle('hidden', view !== viewId);
  });
  el('tableResultLabel').textContent = `${CATEGORY_META[Object.keys(CATEGORY_META).find(k => CATEGORY_META[k].view === viewId)]?.label || 'Live'} data`;
}

function resetDashboard() {
  ['kpi-2-val','kpi-3-val','kpi-4-val','kpi-5-val'].forEach(id => el(id).textContent = '0');
  el('kpi-1-val').textContent = '—';
  el('kpi-2-label').textContent = 'Primary metric';
  el('kpi-3-label').textContent = 'Secondary metric';
  el('kpi-4-label').textContent = 'Third metric';
  el('kpi-5-label').textContent = 'Total volume';
  currentChartData = { labels: [], values: [], label: 'Activity overview' };
  renderChart([], [], 'Activity overview');
}

function setKpis(scope, metrics) {
  el('kpi-1-val').textContent = scope || '—';
  el('kpi-2-label').textContent = metrics[0]?.label || 'Primary metric';
  el('kpi-2-val').textContent = formatNumber(metrics[0]?.value);
  el('kpi-3-label').textContent = metrics[1]?.label || 'Secondary metric';
  el('kpi-3-val').textContent = formatNumber(metrics[1]?.value);
  el('kpi-4-label').textContent = metrics[2]?.label || 'Third metric';
  el('kpi-4-val').textContent = formatNumber(metrics[2]?.value);
  el('kpi-5-label').textContent = metrics[3]?.label || 'Total volume';
  el('kpi-5-val').textContent = formatNumber(metrics[3]?.value);
}

function filterActiveTable() {
  const query = el('tableFilterInput').value.toLowerCase().trim();
  const section = el(activeViewSection);
  if (!section) return;
  section.querySelectorAll('tbody tr').forEach(row => {
    row.style.display = !query || row.textContent.toLowerCase().includes(query) ? '' : 'none';
  });
}

function exportToExcelFile(sheetsData, baseFileName) {
  if (typeof XLSX === 'undefined') return setStatus('Excel export library is still loading. Please retry.', 'error');
  const workbook = XLSX.utils.book_new();
  let hasData = false;
  Object.entries(sheetsData).forEach(([sheetName, data]) => {
    if (Array.isArray(data) && data.length) {
      const worksheet = XLSX.utils.json_to_sheet(data);
      XLSX.utils.book_append_sheet(workbook, worksheet, sheetName.slice(0, 31));
      hasData = true;
    }
  });
  if (!hasData) return setStatus('There is no data available to export yet.', 'info');
  XLSX.writeFile(workbook, `${baseFileName}_${new Date().toISOString().slice(0,10)}.xlsx`);
}

function exportCurrentTableToXLSX() {
  if (activeViewSection === 'view-repositories') return exportToExcelFile({ Branches: rawStore.repos.map(b => ({ Repository: b.repo, 'Branch Name': b.branch, Health: b.isStale ? 'Stale' : 'Active', 'Last Author': b.author, 'Last Commit Date': b.date, 'Commit Message': b.msg })), 'Pull Requests': rawStore.repoPrs.map(p => ({ Repository: p.repo, 'PR Title': p.title, 'Source Branch': p.source, 'Target Branch': p.target, Creator: p.creator, Status: p.status, 'Created Date': p.createdDate })) }, 'AzureDevOps_Repositories');
  if (activeViewSection === 'view-access') return exportAccessToXLSX();
  if (activeViewSection === 'view-activity') return exportToExcelFile({ 'User Commits': rawStore.commits.map(c => ({ Repository: c.repo, 'Commit ID': c.commitId, 'Commit Date': c.date, Message: c.comment })), 'User Pull Requests': rawStore.userPrs.map(p => ({ Repository: p.repo, 'PR Title': p.title, 'Source Branch': p.source, 'Target Branch': p.target, Status: p.status, 'Created Date': p.createdDate })) }, 'AzureDevOps_UserActivity');
  if (activeViewSection === 'view-pipelines') return exportPipelinesToXLSX();
  if (activeViewSection === 'view-workitems') return exportToExcelFile({ 'Work Items': rawStore.workitems.map(w => ({ ID: w.id, 'Work Item Type': w.type, Title: w.title, 'Assigned To': w.assignedTo, State: w.state, 'Created Date': w.createdDate })) }, 'AzureDevOps_WorkItems');
}

function changeChartType(type) {
  currentChartType = type === 'pie' ? 'doughnut' : type;
  document.querySelectorAll('[data-chart-type]').forEach(button => button.classList.toggle('active', button.dataset.chartType === currentChartType));
  renderChart(currentChartData.labels, currentChartData.values, currentChartData.label);
}

function renderChart(labels, data, datasetLabel) {
  currentChartData = { labels: labels || [], values: data || [], label: datasetLabel || 'Overview' };
  const canvas = el('analyticsChart');
  const empty = el('chartEmptyState');
  const wrap = canvas?.parentElement;
  if (!canvas || !wrap) return;

  const hasData = currentChartData.labels.length > 0 && currentChartData.values.length > 0;
  canvas.classList.toggle('hidden', !hasData);
  empty.classList.toggle('hidden', hasData);
  if (!hasData) { if (chartInstance) { chartInstance.destroy(); chartInstance = null; } return; }

  if (chartInstance) chartInstance.destroy();
  const ctx = canvas.getContext('2d');
  const isDonut = currentChartType === 'doughnut';
  const isLine = currentChartType === 'line';
  const palette = ['#2563eb','#0ea5e9','#10b981','#f59e0b','#7c3aed','#ec4899','#06b6d4','#84cc16','#f43f5e','#8b5cf6'];
  if (typeof ChartDataLabels !== 'undefined') Chart.register(ChartDataLabels);

  chartInstance = new Chart(ctx, {
    type: currentChartType,
    data: { labels: currentChartData.labels, datasets: [{ label: datasetLabel, data: currentChartData.values, backgroundColor: isDonut ? palette : 'rgba(37,99,235,.82)', borderColor: isLine ? '#2563eb' : '#2563eb', borderWidth: isLine ? 2 : 0, borderRadius: isLine || isDonut ? 0 : 6, tension: .35, fill: false, pointRadius: isLine ? 3 : 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: isDonut, position: 'right', labels: { boxWidth: 10, font: { size: 10 } } },
        datalabels: { display: !isLine, color: isDonut ? '#fff' : '#334155', font: { weight: '700', size: 9 }, formatter: v => Number(v) > 0 ? v : '' }
      },
      scales: isDonut ? {} : { y: { beginAtZero: true, grid: { color: '#eef2f7' }, ticks: { precision: 0, font: { size: 9 } } }, x: { grid: { display: false }, ticks: { font: { size: 9 }, maxRotation: 35, minRotation: 0 } } }
    }
  });
}

function setSelectedCategory(category) {
  if (!el('categorySelect')?.disabled) {
    el('categorySelect').value = category;
    handleCategorySelection();
  }
}

document.addEventListener('DOMContentLoaded', initCredentials);
