(function () {
if (sessionStorage.getItem('azdo_workspace_active') === 'true') {
document.documentElement.classList.add('restore-workspace-page');
}
})();
let chartInstance = null;
let currentFocusTarget = null;
let cachedRepos = [];
let currentChartData = { labels: [], values: [], label: 'Overview' };
let currentChartType = 'bar';
let activeViewSection = 'view-repositories';
let activeCategory = 'repositories';
const PAGE_SIZE = 10;
const PIPELINE_PAGE_SIZE = 25;
let rawStore = {
repos: [], repoIndex: 0,
repoPrs: [], repoPrsIndex: 0,
access: [], accessIndex: 0,
commits: [], commitsIndex: 0,
pipelines: [], pipelineIndex: 0,
pipelineSummaries: [], pipelineSummariesIndex: 0,
workitems: [], workitemsIndex: 0,
serviceConnections: [], serviceConnectionsIndex: 0,
agents: [], agentsIndex: 0,
agentPools: [],
userEntitlements: [], userDirectoryIndex: 0
};
let workspaceDisplayStore = {};
window.__getAzdoRawStore = () => rawStore;
function sortByLatestDate(items, dateKeys = []) {
if (!Array.isArray(items) || items.length < 2) return items;
const keys = Array.isArray(dateKeys) ? dateKeys : [dateKeys];
const getTimestamp = (item) => {
if (!item || typeof item !== 'object') return null;
for (const key of keys) {
const value = item[key];
if (value === undefined || value === null || value === '' || value === '—' || value === 'N/A') continue;
if (typeof value === 'number' && Number.isFinite(value)) return value;
const date = value instanceof Date ? value : new Date(value);
const time = date.getTime();
if (Number.isFinite(time)) return time;
}
return null;
};
const sorted = items
.map((item, originalIndex) => ({ item, originalIndex, timestamp: getTimestamp(item) }))
.sort((a, b) => {
const aHasDate = a.timestamp !== null;
const bHasDate = b.timestamp !== null;
if (aHasDate && bHasDate) {
const diff = b.timestamp - a.timestamp;
return diff !== 0 ? diff : a.originalIndex - b.originalIndex;
}
if (aHasDate) return -1;
if (bHasDate) return 1;
return a.originalIndex - b.originalIndex;
})
.map(entry => entry.item);
items.splice(0, items.length, ...sorted);
return items;
}
window.sortByLatestDate = sortByLatestDate;
function workspaceHasData(category) {
switch (category) {
case 'repositories':
return (rawStore.repos?.length || 0) > 0 || (rawStore.repoPrs?.length || 0) > 0;
case 'pipelines':
return (rawStore.pipelineSummaries?.length || 0) > 0 || (rawStore.pipelines?.length || 0) > 0;
case 'work_items':
return (rawStore.workitems?.length || 0) > 0;
case 'user_access':
return (rawStore.access?.length || 0) > 0;
case 'user_activity':
return (rawStore.commits?.length || 0) > 0;
case 'service_agents':
return (rawStore.serviceConnections?.length || 0) > 0 ||
(rawStore.agents?.length || 0) > 0 ||
(rawStore.agentPools?.length || 0) > 0;
case 'users':
return (rawStore.userEntitlements?.length || 0) > 0;
default:
return false;
}
}
function saveWorkspaceDisplayState(category) {
if (!category || !workspaceHasData(category)) return;
const kpis = {};
for (let i = 1; i <= 5; i++) {
const label = document.getElementById(`kpi-${i}-label`);
const value = document.getElementById(`kpi-${i}-val`);
if (label && value) {
kpis[i] = {
label: label.textContent,
value: value.textContent,
className: value.className
};
}
}
const statusBarEl = document.getElementById('statusBar');
const statusMsg = statusBarEl && !statusBarEl.classList.contains('hidden') ? statusBarEl.textContent : '';
workspaceDisplayStore[category] = {
kpis,
statusMsg,
chart: {
labels: Array.isArray(currentChartData?.labels) ? [...currentChartData.labels] : [],
values: Array.isArray(currentChartData?.values) ? [...currentChartData.values] : [],
label: currentChartData?.label || 'Overview',
type: currentChartType || 'bar'
}
};
}
function setWorkspaceDefaultKpis(category) {
const defaults = {
repositories: [['Repository', '-'], ['Branches', '0'], ['Total PRs', '0'], ['Active PRs', '0'], ['Completed PRs', '0']],
pipelines: [['Active Scope', '—'], ['Total Pipelines', '0'], ['Successful Builds', '0'], ['Auto / CI Triggers', '0'], ['Scanned Runs', '0']],
work_items: [['Total Work Items', '0'], ['Active / New', '0'], ['In Progress', '0'], ['Resolved', '0'], ['Closed / Done', '0']],
user_access: [['Active Scope', '—'], ['Groups & Teams', '0'], ['Total Memberships', '0'], ['Mode', 'Security Access'], ['Status', 'Ready']],
user_activity: [['Active Scope', '—'], ['Active Repos', '0'], ['Commits Made', '0'], ['Pull Requests', '0'], ['Status', 'No Commits']],
service_agents: [['Total Service Connections', '0'], ['Microsoft-hosted Pools', '0'], ['Self-hosted Agents', '0']],
users: [['Total Users', '0'], ['Active Users', '0'], ['Basic / Stakeholder', '0'], ['Project Access', '0'], ['Scope', 'Organization']]
};
const values = defaults[category] || defaults.repositories;
for (let i = 1; i <= 5; i++) {
const label = document.getElementById(`kpi-${i}-label`);
const value = document.getElementById(`kpi-${i}-val`);
const item = values[i - 1];
if (label && value && item) {
label.textContent = item[0];
value.textContent = item[1];
value.className = 'text-2xl font-extrabold text-slate-800 mt-1 truncate';
}
}
}
function restoreWorkspaceDisplayState(category) {
const state = workspaceDisplayStore[category];
if (!state) {
setWorkspaceDefaultKpis(category);
setStatus('');
if (typeof renderChart === 'function') {
renderChart([], [], 'Overview');
}
return;
}
for (let i = 1; i <= 5; i++) {
const label = document.getElementById(`kpi-${i}-label`);
const value = document.getElementById(`kpi-${i}-val`);
const item = state.kpis?.[i];
if (label && value && item) {
label.textContent = item.label;
value.textContent = item.value;
value.className = item.className;
}
}
if (state.statusMsg) {
setStatus(state.statusMsg, 'success');
} else {
setStatus('');
}
if (state.chart) {
currentChartType = state.chart.type || 'bar';
if (typeof renderChart === 'function') {
renderChart(state.chart.labels || [], state.chart.values || [], state.chart.label || 'Overview');
}
} else {
if (typeof renderChart === 'function') {
renderChart([], [], 'Overview');
}
}
}
function extractOrgName(input) {
let cleaned = input.trim().replace(/^https?:\/\//, '').replace(/^dev\.azure\.com\//, '');
return cleaned.split('/')[0] || '';
}
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
target.classList.add('ring-2', 'ring-red-400');
setTimeout(() => target.classList.remove('ring-2', 'ring-red-400'), 1500);
}
}
}
function setStatus(msg, type = 'info') {
const el = document.getElementById('statusBar') || document.getElementById('landingStatusBar');
if (!el) return;
if (!msg) {
el.classList.add('hidden');
el.textContent = '';
return;
}
el.classList.remove('hidden', 'bg-red-50', 'text-red-700', 'bg-green-50', 'text-green-700', 'bg-blue-50', 'text-blue-700');
if (type === 'error') el.classList.add('bg-red-50', 'text-red-700');
else if (type === 'success') el.classList.add('bg-green-50', 'text-green-700');
else el.classList.add('bg-blue-50', 'text-blue-700');
const partial = type === 'success' ? getAzDoPartialResultMessage() : '';
el.textContent = `${msg || ''}${partial}`;
if (typeof renderCancelFetchButton === 'function') renderCancelFetchButton();
}
function renderCancelFetchButton() {
const statusBar = document.getElementById('statusBar');
if (!statusBar || !azdoActiveAbortController || azdoActiveAbortController.signal.aborted) return;
let btn = document.getElementById('btnCancelAzDoFetch');
if (!btn) {
  btn = document.createElement('button');
  btn.id = 'btnCancelAzDoFetch';
  btn.type = 'button';
  btn.className = 'ml-3 inline-flex items-center rounded bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700';
  btn.textContent = 'Cancel';
  btn.addEventListener('click', () => cancelAzDoOperation());
  statusBar.appendChild(btn);
}
}
function startFetching(message) {
const controller = beginAzDoOperation();
setStatus(message, 'info');
document.getElementById('statusBar')?.classList.add('fetching');
renderCancelFetchButton();
return { id: azdoApiRunState?.id || 0, signal: controller.signal };
}
function stopFetching() {
document.getElementById('statusBar')?.classList.remove('fetching');
document.getElementById('btnCancelAzDoFetch')?.remove();
azdoActiveAbortController = null;
azdoApiRunActive = false;
}
function showWorkspacePage() {
document.getElementById('connectionPage')?.classList.add('hidden');
document.getElementById('workspacePage')?.classList.remove('hidden');
}
function showConnectionPage() {
document.getElementById('workspacePage')?.classList.add('hidden');
document.getElementById('connectionPage')?.classList.remove('hidden');
}
function updatePathPreview(org = '', project = '') {
const linkEl = document.getElementById('generatedUrlLink');
let url = 'https://dev.azure.com/';
if (org) url += org;
if (org && project) url += `/${project}`;
linkEl.textContent = url;
linkEl.href = url;
const activePath = document.getElementById('activePathLink');
if (activePath) { activePath.textContent = url; activePath.href = url; }
if (org) {
linkEl.className = 'text-blue-600 font-mono underline hover:text-blue-800 cursor-pointer';
linkEl.target = '_blank';
} else {
linkEl.className = 'text-slate-400 font-mono underline cursor-default';
linkEl.removeAttribute('target');
}
}
function initCredentials() {
const savedOrg = localStorage.getItem('azdo_org');
if (savedOrg) document.getElementById('targetOrg').value = savedOrg;
if (savedOrg) document.getElementById('chkRememberCreds').checked = true;
handleOrgChange();
}
function toggleRememberCreds() {
const isChecked = document.getElementById('chkRememberCreds').checked;
if (isChecked) {
localStorage.setItem('azdo_org', document.getElementById('targetOrg').value.trim());
} else {
localStorage.removeItem('azdo_org');
}
}
function handleOrgChange() {
const org = extractOrgName(document.getElementById('targetOrg').value);
updatePathPreview(org);
const projectBadge = document.getElementById('overviewProjectBadge');
if (projectBadge) projectBadge.textContent = '—';
resetDropdown('projectSelect', '-- Load PAT first --');
if (typeof resetServiceAgentsScope === 'function') resetServiceAgentsScope();
document.getElementById('step5Container').classList.add('hidden');
if (document.getElementById('chkRememberCreds').checked) {
localStorage.setItem('azdo_org', document.getElementById('targetOrg').value.trim());
}
setConnectionBadge(false);
}
function resetDropdown(id, placeholder) {
const el = document.getElementById(id);
setSafeInnerHTML(el, `<option value="">${placeholder}</option>`);
el.disabled = true;
el.classList.add('bg-slate-100', 'cursor-not-allowed');
el.classList.remove('bg-white');
}
function enableDropdown(id) {
const el = document.getElementById(id);
el.disabled = false;
el.classList.remove('bg-slate-100', 'cursor-not-allowed');
el.classList.add('bg-white');
}
async function loadProjectsList() {
const org = extractOrgName(document.getElementById('targetOrg').value);
const pat = document.getElementById('targetPat').value.trim();
if (!org) return showModal('Please enter the Organization Name or URL first.', 'targetOrg');
if (!pat) return showModal('Please enter your Personal Access Token (PAT).', 'targetPat');
const loadBtn = document.getElementById('btnLoadProjects');
if (loadBtn) {
loadBtn.disabled = true;
loadBtn.textContent = 'Loading projects...';
loadBtn.classList.add('loading');
}
if (document.getElementById('chkRememberCreds').checked) {
localStorage.setItem('azdo_org', org);
}
const authHeader = createBasicAuthHeader(pat);
beginAzDoOperation();
setStatus(`Loading projects from https://dev.azure.com/${org}...`, 'info');
try {
const url = `https://dev.azure.com/${org}/_apis/projects?api-version=${API_VERSION}&$top=500`;
const data = await fetchAzDoPaged(url, authHeader, { pageSize: 500 });
const projects = data.value || [];
const projDropdown = document.getElementById('projectSelect');
setSafeInnerHTML(projDropdown, '<option value="">-- Select a Project --</option>');
projects.forEach(p => {
const opt = document.createElement('option');
opt.value = p.name;
opt.textContent = p.name;
projDropdown.appendChild(opt);
});
enableDropdown('projectSelect');
updateProjectRequirementUI();
document.getElementById('step5Container').classList.add('hidden');
sessionStorage.setItem('azdo_workspace_active', 'true');
sessionStorage.setItem('azdo_session_org', org);
setConnectionBadge(true);
showWorkspacePage();
const projStatus = document.getElementById('projectStatusMsg');
if (projStatus) {
projStatus.textContent = `Loaded ${projects.length} projects successfully! Please choose a project.`;
projStatus.classList.remove('hidden');
}
const statusBar = document.getElementById('statusBar');
if (statusBar) {
statusBar.classList.add('hidden');
statusBar.textContent = '';
}
} catch (err) {
setStatus(`Error loading projects: ${err.message}`, 'error');
setConnectionBadge(false);
} finally {
if (loadBtn) {
loadBtn.disabled = false;
loadBtn.textContent = 'Load projects';
loadBtn.classList.remove('loading');
}
}
}
function updateProjectRequirementUI() {
const mark = document.getElementById('projectRequiredMark');
const note = document.getElementById('projectRequirementText');
const select = document.getElementById('projectSelect');
const serviceAgentsActive = activeCategory === 'service_agents';
const usersActive = activeCategory === 'users';
const projectOptional = serviceAgentsActive || usersActive;
if (mark) mark.classList.toggle('hidden', projectOptional);
if (note) {
note.textContent = serviceAgentsActive
? 'Project is optional for Service Connections & Agent Pools. Leave it blank for organization-wide information.'
: usersActive
? 'Project is optional for User Directory. Leave it blank for organization-wide users, or select a project for project-level access.'
: 'Project selection is required for Repositories, Access & Teams, User Activity, Pipelines & Builds, and Work Items.';
}
if (select) select.setAttribute('aria-required', projectOptional ? 'false' : 'true');
}
function switchToOrganizationServiceAgents() {
const projectSelect = document.getElementById('projectSelect');
if (projectSelect) projectSelect.value = '';
activeCategory = 'repositories';
activeViewSection = 'view-repositories';
const categorySelect = document.getElementById('categorySelect');
if (categorySelect) categorySelect.value = 'repositories';
if (typeof resetServiceAgentsScope === 'function') resetServiceAgentsScope();
if (typeof showSection === 'function') showSection('repositories');
if (typeof configureServiceAgentsOverview === 'function') configureServiceAgentsOverview(false);
if (typeof updateProjectRequirementUI === 'function') updateProjectRequirementUI();
const step5 = document.getElementById('step5Container');
if (step5) step5.classList.add('hidden');
const projectBadge = document.getElementById('overviewProjectBadge');
if (projectBadge) projectBadge.textContent = '—';
showConnectionPage();
setStatus('Returned to Azure DevOps Connection.', 'info');
}
async function handleProjectSelection() {
const org = extractOrgName(document.getElementById('targetOrg').value);
const project = document.getElementById('projectSelect').value;
const pat = document.getElementById('targetPat').value.trim();
updateProjectRequirementUI();
setStatus('');
if (!project) {
if (activeCategory === 'service_agents') {
updatePathPreview(org);
if (typeof updateServiceAgentsScopeText === 'function') updateServiceAgentsScopeText();
renderActiveSubstep();
} else if (activeCategory === 'users') {
updatePathPreview(org);
if (typeof updateUserDirectoryScopeText === 'function') updateUserDirectoryScopeText();
renderActiveSubstep();
} else {
document.getElementById('step5Container').classList.add('hidden');
updatePathPreview(org);
}
return;
}
updatePathPreview(org, project);
if (typeof updateServiceAgentsScopeText === 'function') updateServiceAgentsScopeText();
const projectBadge = document.getElementById('overviewProjectBadge');
if (projectBadge) projectBadge.textContent = project || '—';
sessionStorage.setItem('azdo_session_project', project);
const authHeader = createBasicAuthHeader(pat);
try {
const url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories?api-version=${API_VERSION}`;
const data = await fetchAzDoPaged(url, authHeader, { pageSize: 500 });
cachedRepos = data.value || [];
} catch (e) {
console.warn('Could not prefetch repos:', e);
}
renderActiveSubstep();
}
function renderActiveSubstep() {
updateProjectRequirementUI();
const project = document.getElementById('projectSelect').value;
const step5 = document.getElementById('step5Container');
const subRepo = document.getElementById('substepRepo');
const subAccess = document.getElementById('substepAccess');
const subActivity = document.getElementById('substepActivity');
const subPipelines = document.getElementById('substepPipelines');
const subWorkItems = document.getElementById('substepWorkItems');
const subServiceAgents = document.getElementById('substepServiceAgents');
const subUsers = document.getElementById('substepUsers');
if (!project && !['service_agents', 'users'].includes(activeCategory)) {
step5.classList.add('hidden');
return;
}
step5.classList.remove('hidden');
[subRepo, subAccess, subActivity, subPipelines, subWorkItems, subServiceAgents, subUsers].forEach(el => el?.classList.add('hidden'));
if (activeCategory === 'repositories') {
subRepo.classList.remove('hidden');
populateRepoDropdown();
} else if (activeCategory === 'user_access') {
subAccess.classList.remove('hidden');
} else if (activeCategory === 'user_activity') {
subActivity.classList.remove('hidden');
} else if (activeCategory === 'pipelines') {
subPipelines.classList.remove('hidden');
} else if (activeCategory === 'service_agents') {
subServiceAgents.classList.remove('hidden');
if (typeof updateServiceAgentsScopeText === 'function') updateServiceAgentsScopeText();
} else if (activeCategory === 'users') {
subUsers.classList.remove('hidden');
if (typeof updateUserDirectoryScopeText === 'function') updateUserDirectoryScopeText();
} else if (activeCategory === 'work_items') {
subWorkItems.classList.remove('hidden');
}
}
function showSection(viewId) {
activeViewSection = `view-${viewId}`;
['repositories', 'access', 'activity', 'pipelines', 'serviceagents', 'users', 'workitems'].forEach(v => {
document.getElementById(`view-${v}`).classList.toggle('hidden', v !== viewId);
});
}
function selectExplore(category) {
if (activeCategory && workspaceHasData(activeCategory)) {
saveWorkspaceDisplayState(activeCategory);
}
activeCategory = category;
sessionStorage.setItem('azdo_session_category', category);
updateProjectRequirementUI();
const categorySelect = document.getElementById('categorySelect');
if (categorySelect) categorySelect.value = category;
const viewMap = {
repositories: 'repositories',
pipelines: 'pipelines',
work_items: 'workitems',
user_activity: 'activity',
user_access: 'access',
service_agents: 'serviceagents',
users: 'users'
};
const viewId = viewMap[category] || 'repositories';
document.querySelectorAll('.sidebar-item').forEach(btn => {
btn.classList.toggle('active', btn.dataset.view === viewId);
});
if (typeof showSection === 'function') showSection(viewId);
if (typeof configureServiceAgentsOverview === 'function') {
configureServiceAgentsOverview(viewId === 'serviceagents');
}
renderActiveSubstep();
restoreWorkspaceDisplayState(category);
}
function setConnectionBadge(connected) {
const text = document.getElementById('connectionBadgeText');
const badge = document.getElementById('connectionBadge');
const disconnectBtn = document.getElementById('btnDisconnect');
if (!text || !badge) return;
text.textContent = connected ? 'Connected' : 'Ready to connect';
badge.classList.toggle('connected', !!connected);
if (disconnectBtn) {
disconnectBtn.classList.toggle('hidden', !connected);
}
}
function disconnectSession() {
rawStore = {
repos: [], repoIndex: 0,
repoPrs: [], repoPrsIndex: 0,
access: [], accessIndex: 0,
commits: [], commitsIndex: 0,
pipelines: [], pipelineIndex: 0,
pipelineSummaries: [], pipelineSummariesIndex: 0,
workitems: [], workitemsIndex: 0,
serviceConnections: [], serviceConnectionsIndex: 0,
agents: [], agentsIndex: 0,
agentPools: [],
userEntitlements: [], userDirectoryIndex: 0
};
cachedRepos = [];
workspaceDisplayStore = {};
document.getElementById('targetPat').value = '';
resetDropdown('projectSelect', '-- Load PAT first --');
if (typeof resetServiceAgentsScope === 'function') resetServiceAgentsScope();
document.getElementById('step5Container').classList.add('hidden');
document.getElementById('overviewProjectBadge').textContent = '—';
const projStatus = document.getElementById('projectStatusMsg');
if (projStatus) {
projStatus.textContent = '';
projStatus.classList.add('hidden');
}
document.getElementById('kpi-1-label').textContent = 'Repository';
document.getElementById('kpi-1-val').textContent = '-';
document.getElementById('kpi-1-val').className = 'text-2xl font-extrabold text-slate-800 mt-1 truncate';
document.getElementById('kpi-2-label').textContent = 'Branches';
document.getElementById('kpi-2-val').textContent = '0';
document.getElementById('kpi-3-label').textContent = 'Total PRs';
document.getElementById('kpi-3-val').textContent = '0';
document.getElementById('kpi-4-label').textContent = 'Active PRs';
document.getElementById('kpi-4-val').textContent = '0';
document.getElementById('kpi-5-label').textContent = 'Completed PRs';
document.getElementById('kpi-5-val').textContent = '0';
setSafeInnerHTML(document.getElementById('branchesTableBody'), `<tr><td colspan="7" class="p-4 text-center text-slate-400">Select a project & repository to inspect.</td></tr>`);
setSafeInnerHTML(document.getElementById('policyBranchesTableBody'), `<tr><td colspan="6" class="p-4 text-center text-slate-400">Select a project & repository to inspect.</td></tr>`);
setSafeInnerHTML(document.getElementById('repoPrsTableBody'), `<tr><td colspan="7" class="p-4 text-center text-slate-400">Select a project & repository to inspect.</td></tr>`);
setSafeInnerHTML(document.getElementById('accessTableBody'), `<tr><td colspan="4" class="p-4 text-center text-slate-400">Enter a User ID or click "Fetch User Access" to load access permissions.</td></tr>`);
setSafeInnerHTML(document.getElementById('userCommitsTableBody'), `<tr><td colspan="5" class="p-4 text-center text-slate-400">Enter a user email/ID and click search.</td></tr>`);
setSafeInnerHTML(document.getElementById('userPrTableBody'), `<tr><td colspan="5" class="p-4 text-center text-slate-400">No pull request activity loaded.</td></tr>`);
setSafeInnerHTML(document.getElementById('pipelineSummaryTableBody'), `<tr><td colspan="7" class="p-4 text-center text-slate-400">Click "Fetch Pipeline Runs" to scan pipeline definitions.</td></tr>`);
setSafeInnerHTML(document.getElementById('pipelineTableBody'), `<tr><td colspan="7" class="p-4 text-center text-slate-400">No build runs loaded.</td></tr>`);
setSafeInnerHTML(document.getElementById('workItemsTableBody'), `<tr><td colspan="6" class="p-4 text-center text-slate-400">Query work items to view backlog.</td></tr>`);
const serviceConnectionsBody = document.getElementById('serviceConnectionsTableBody');
if (serviceConnectionsBody) setSafeInnerHTML(serviceConnectionsBody, `<tr><td colspan="6" class="p-4 text-center text-slate-400">Click "Fetch Connections &amp; Agents" to load service connections.</td></tr>`);
const agentsBody = document.getElementById('agentsTableBody');
if (agentsBody) setSafeInnerHTML(agentsBody, `<tr><td colspan="9" class="p-4 text-center text-slate-400">Click "Fetch Connections &amp; Agents" to load agent pools and agents.</td></tr>`);
['seeMoreRepoContainer', 'seeMorePolicyBranchesContainer', 'seeMoreRepoPrsContainer', 'seeMoreAccessContainer', 'seeMoreCommitsContainer', 'seeMorePipelineSummaryContainer', 'seeMorePipelinesContainer', 'seeMoreWorkItemsContainer', 'seeMoreServiceConnectionsContainer', 'seeMoreAgentsContainer'].forEach(id => {
const el = document.getElementById(id);
if (el) el.classList.add('hidden');
});
renderChart([], [], 'Overview');
setConnectionBadge(false);
sessionStorage.removeItem('azdo_workspace_active');
sessionStorage.removeItem('azdo_session_org');
sessionStorage.removeItem('azdo_session_project');
sessionStorage.removeItem('azdo_session_category');
const loadBtn = document.getElementById('btnLoadProjects');
if (loadBtn) {
loadBtn.disabled = false;
loadBtn.textContent = 'Load projects';
loadBtn.classList.remove('loading');
}
document.documentElement.classList.remove('restore-workspace-page');
showConnectionPage();
setStatus('Disconnected from Azure DevOps. Enter credentials to connect again.', 'info');
}
function filterActiveTable() {
const query = document.getElementById('tableFilterInput').value.toLowerCase();
const scope = document.getElementById('tableFilterScope')?.value || 'all';
const activeSection = document.getElementById(activeViewSection);
if (!activeSection) return;
const tables = activeSection.querySelectorAll('table');
tables.forEach(table => {
const isTarget = scope === 'all' || table.id === scope;
const rows = table.querySelectorAll('tbody tr');
rows.forEach(r => {
if (!isTarget) {
r.style.display = '';
} else {
const text = r.textContent.toLowerCase();
r.style.display = text.includes(query) ? '' : 'none';
}
});
});
}
function exportToExcelFile(sheetsData, baseFileName) {
if (typeof XLSX === 'undefined') {
alert('Excel library is still loading, please try again in a moment.');
return;
}
const wb = XLSX.utils.book_new();
let hasData = false;
for (const [sheetName, data] of Object.entries(sheetsData)) {
if (data && data.length > 0) {
const ws = XLSX.utils.json_to_sheet(data);
XLSX.utils.book_append_sheet(wb, ws, sheetName.substring(0, 31));
hasData = true;
}
}
if (!hasData) return;
XLSX.writeFile(wb, `${baseFileName}_${Date.now()}.xlsx`);
}
function exportCurrentTableToXLSX() {
const scope = document.getElementById('tableFilterScope')?.value || 'all';
if (activeViewSection === 'view-repositories') {
const sheetsToExport = {};
let exportFileName = "AzureDevOps_Repositories_Full_Telemetry";
if (scope === 'all' || scope === 'table-repositories') {
const branchData = (rawStore.repos || []).map(b => ({
"Repository": b.repo,
"Branch Name": b.branch,
"Status / Health": b.isStale ? "Stale" : "Active",
"Branch Policies": b.policies && b.policies.length ? b.policies.join(', ') : "None",
"Required Reviewers": b.minReviewers || 0,
"Last Author": b.author,
"Last Commit Date": b.date,
"Commit Message": b.msg
}));
sheetsToExport["All Branches"] = branchData;
if (scope === 'table-repositories') {
exportFileName = "AzureDevOps_Repositories_Active_Branches";
}
}
if (scope === 'all' || scope === 'table-policy-branches') {
const policyBranches = (rawStore.repos || []).filter(
b => b.hasPolicy === true && Array.isArray(b.policies) && b.policies.length > 0
);
const policyBranchData = policyBranches.map(b => ({
"Repository": b.repo,
"Branch Name": b.branch,
"Required Reviewers": b.minReviewers || 0,
"Branch Policies": b.policies.join(', '),
"Last Author": b.author || "Unknown",
"Last Commit Date": b.date || "N/A",
"Commit Message": b.msg || ""
}));
sheetsToExport["Branches With Policies"] = policyBranchData;
if (scope === 'table-policy-branches') {
exportFileName = "AzureDevOps_Branches_With_Policies";
}
}
if (scope === 'all' || scope === 'table-repo-prs') {
const prData = (rawStore.repoPrs || []).map(p => ({
"Repository": p.repo,
"PR Title": p.title,
"Source Branch": p.source,
"Target Branch": p.target,
"Target Branch Policies": p.targetPolicies && p.targetPolicies.length ? p.targetPolicies.join(', ') : "None",
"Min Required Reviewers": p.minRequiredReviewers || 0,
"Assigned Reviewers": p.reviewersCount || 0,
"Creator": p.creator,
"Status": p.status,
"Created Date": p.createdDate
}));
sheetsToExport["Pull Requests"] = prData;
if (scope === 'table-repo-prs') {
exportFileName = "AzureDevOps_Pull_Requests";
}
}
exportToExcelFile(sheetsToExport, exportFileName);
}
else if (activeViewSection === 'view-access') {
const accessData = (rawStore.access || []).map(a => ({
"Team / Group Name": a.team,
"Type / Scope": a.type,
"User Display Name": a.name,
"User Principal / Email": a.email
}));
exportToExcelFile({ "Access & Permissions": accessData }, "AzureDevOps_Security_Access");
}
else if (activeViewSection === 'view-activity') {
const commitData = (rawStore.commits || []).map(c => ({
"Repository": c.repo,
"Branch": c.branch,
"Commit ID": c.commitId,
"Commit Date": c.date,
"Message": c.comment
}));
const prData = (rawStore.repoPrs || []).map(p => ({
"Repository": p.repo,
"PR Title": p.title,
"Source": p.source,
"Target": p.target,
"Status": p.status,
"Created Date": p.createdDate
}));
exportToExcelFile({ "User Commits": commitData, "User PRs": prData }, "AzureDevOps_User_Activity");
}
else if (activeViewSection === 'view-pipelines') {
exportPipelinesToXLSX();
}
else if (activeViewSection === 'view-serviceagents') {
exportServiceConnectionsAndAgentsToXLSX();
}
else if (activeViewSection === 'view-workitems') {
const wiData = (rawStore.workitems || []).map(w => ({
"ID": w.id,
"Work Item Type": w.type,
"Title": w.title,
"Assigned To": w.assignedTo,
"State": w.state,
"Created Date": w.createdDate
}));
exportToExcelFile({ "Work Items": wiData }, "AzureDevOps_WorkItems");
}
}
function exportAccessToXLSX() {
const accessData = (rawStore.access || []).map(a => ({
"Team / Group Name": a.team,
"Type / Scope": a.type,
"User Display Name": a.name,
"User Principal / Email": a.email
}));
if (!accessData.length) {
if (typeof showModal === 'function') showModal('No access and permission records are available to export.');
return;
}
exportToExcelFile({ "Access & Permissions": accessData }, "AzureDevOps_Security_Access");
}

function changeChartType(type) {
currentChartType = type.toLowerCase() === 'pie' ? 'pie' : type;
renderChart(currentChartData.labels, currentChartData.values, currentChartData.label);
}
function renderChart(labels, data, datasetLabel) {
currentChartData = { labels, values: data, label: datasetLabel };
const ctx = document.getElementById('analyticsChart').getContext('2d');
if (chartInstance) chartInstance.destroy();
const palette = ['#3b82f6', '#10b981', '#6366f1', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#84cc16', '#f43f5e', '#a855f7'];
const isPie = currentChartType === 'pie' || currentChartType === 'doughnut';
const isLine = currentChartType === 'line';
if (typeof ChartDataLabels !== 'undefined') {
Chart.register(ChartDataLabels);
}
chartInstance = new Chart(ctx, {
type: currentChartType,
data: {
labels: labels.length ? labels : ['No Data'],
datasets: [{
label: datasetLabel,
data: data.length ? data : [0],
backgroundColor: isPie ? palette : '#3b82f6',
borderColor: isLine ? '#2563eb' : undefined,
pointBackgroundColor: isLine ? '#2563eb' : undefined,
pointRadius: isLine ? 5 : undefined,
fill: isLine ? false : undefined,
borderRadius: currentChartType === 'bar' ? 6 : 0
}]
},
options: {
responsive: true,
maintainAspectRatio: false,
layout: {
padding: {
top: isPie ? 10 : 25,
bottom: 10
}
},
plugins: {
legend: {
display: isPie,
position: 'right'
},
datalabels: {
display: true,
color: isPie ? '#ffffff' : '#1e293b',
font: {
weight: 'bold',
size: 11
},
anchor: isPie ? 'center' : 'end',
align: isPie ? 'center' : 'top',
offset: isPie ? 0 : 2,
formatter: function(value) {
return value > 0 ? value : (isPie ? '' : '0');
}
}
},
scales: isPie ? {} : {
y: {
beginAtZero: true,
grid: { color: '#f1f5f9' },
ticks: { precision: 0 }
},
x: {
grid: { display: false },
ticks: {
autoSkip: false,
maxRotation: 45,
minRotation: 20
}
}
}
}
});
}
document.addEventListener('DOMContentLoaded', async function () {
initCredentials();
const workspaceActive = sessionStorage.getItem('azdo_workspace_active');
if (workspaceActive === 'true') {
const savedOrg = sessionStorage.getItem('azdo_session_org');
const savedProject = sessionStorage.getItem('azdo_session_project');
const savedCategory = sessionStorage.getItem('azdo_session_category');
if (savedOrg) document.getElementById('targetOrg').value = savedOrg;
if (savedCategory) activeCategory = savedCategory;
// PATs are deliberately never restored from browser storage. The user must re-enter it.
if (savedOrg) {
handleOrgChange();
setStatus('Previous workspace details were found, but the PAT was not stored. Re-enter your PAT to reconnect.', 'info');
}
if (savedProject) {
const projectSelect = document.getElementById('projectSelect');
if (projectSelect) projectSelect.value = savedProject;
}
if (savedCategory) selectExplore(savedCategory);
showConnectionPage();
} else {
selectExplore('repositories');
}
});
