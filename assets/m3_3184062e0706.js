function displayIdentity(identity) {
if (!identity) return '—';
return identity.displayName || identity.uniqueName || identity.providerDisplayName || identity.id || '—';
}
function getServiceAgentsProject() {
return (document.getElementById('projectSelect')?.value || '').trim();
}
function updateServiceAgentsScopeText() {
const el = document.getElementById('serviceAgentsScopeText');
if (!el) return;
const project = getServiceAgentsProject();
el.textContent = project
? `Project-level scan: showing service connections and agent pools connected to ${project} only.`
: 'Organization-level scan: showing service connections and agent pools across the connected organization.';
}
function configureServiceAgentsOverview(isActive) {
const chartSection = document.getElementById('chartSection');
const kpiGrid = document.querySelector('.kpi-grid');
const cards = [1, 2, 3, 4, 5].map(i => document.getElementById(`kpi-card-${i}`));
if (chartSection) chartSection.classList.toggle('hidden', isActive);
if (kpiGrid) kpiGrid.classList.toggle('serviceagents-kpi-grid', isActive);
if (isActive) {
cards.forEach((card, index) => { if (card) card.classList.toggle('hidden', index >= 3); });
updateServiceAgentsOverview();
updateServiceAgentsScopeText();
} else {
cards.forEach(card => { if (card) card.classList.remove('hidden'); });
if (kpiGrid) kpiGrid.classList.remove('serviceagents-kpi-grid');
}
}
function updateServiceAgentsOverview() {
const serviceConnectionCount = (rawStore.serviceConnections || []).length;
const validAgents = (rawStore.agents || []).filter(a => !a.isSyntheticHosted && a.name && a.name !== 'Unable to read agents');
const hostedPoolCount = (rawStore.agentPools || []).filter(p => p.isHosted === true).length;
const selfHostedAgentCount = validAgents.filter(a => a.isHosted === 'No').length;
const values = [serviceConnectionCount, hostedPoolCount, selfHostedAgentCount];
const labels = ['Total Service Connections', 'Microsoft-hosted Pools', 'Self-hosted Agents'];
const classes = [
'text-2xl font-extrabold text-slate-800 mt-1 truncate',
'text-2xl font-extrabold text-blue-600 mt-1',
'text-2xl font-extrabold text-emerald-600 mt-1'
];
for (let i = 0; i < 3; i++) {
const label = document.getElementById(`kpi-${i + 1}-label`);
const value = document.getElementById(`kpi-${i + 1}-val`);
if (label) label.textContent = labels[i];
if (value) {
value.textContent = values[i];
value.className = classes[i];
}
}
}
function mapServiceConnection(endpoint, projectName = '') {
return {
id: endpoint.id || '',
name: endpoint.name || '—',
type: endpoint.type || '—',
url: endpoint.url || '—',
status: endpoint.isReady === true ? 'Active' : 'Inactive',
isReady: endpoint.isReady === true ? 'Yes' : endpoint.isReady === false ? 'No' : '—',
isShared: endpoint.isShared ? 'Yes' : 'No',
createdBy: displayIdentity(endpoint.createdBy),
projectName: projectName || endpoint.serviceEndpointProjectReferences?.[0]?.projectReference?.name || '—',
rawCreatedTimestamp: endpoint.creationDate ? new Date(endpoint.creationDate).getTime() : null
};
}
function statusBadge(status) {
const normalized = String(status || '').toLowerCase();
let cls = 'bg-slate-100 text-slate-600';
if (normalized === 'active' || normalized === 'online') cls = 'bg-emerald-100 text-emerald-700';
else if (normalized === 'inactive' || normalized === 'offline') cls = 'bg-red-100 text-red-700';
return `<span class="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${cls}">${escapeHtml(status || '—')}</span>`;
}
async function fetchAgentsForPools(org, authHeader, pools, options = {}) {
const projectScoped = options.projectScoped === true;
const rows = [];
for (const pool of (pools || [])) {
if (pool.isHosted === true) {
rows.push({
poolId: pool.id,
queueId: pool.queueId ?? null,
poolName: pool.name || `Pool ${pool.id}`,
isHosted: 'Yes',
poolType: pool.poolType || '—',
name: 'Microsoft-hosted pool',
status: 'Online',
enabled: 'Yes',
os: '—',
version: '—',
createdOn: '—',
isSyntheticHosted: true,
projectScoped
});
continue;
}
try {
const agentsUrl = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/distributedtask/pools/${encodeURIComponent(pool.id)}/agents?includeAssignedRequest=true&includeLastCompletedRequest=true&api-version=${AZDO_STABLE_API_VERSION}`;
const agentData = await fetchAzDoPaged(agentsUrl, authHeader, { pageSize: 500 });
const agents = agentData.value || [];
agents.forEach(agent => rows.push({
poolId: pool.id,
poolName: pool.name || `Pool ${pool.id}`,
isHosted: 'No',
poolType: pool.poolType || '—',
agentId: agent.id ?? null,
name: agent.name || '—',
status: agent.status || '—',
enabled: agent.enabled === true ? 'Yes' : agent.enabled === false ? 'No' : '—',
os: agent.osDescription || '—',
version: agent.version || '—',
createdOn: agent.createdOn ? new Date(agent.createdOn).toLocaleString() : '—',
rawCreatedTimestamp: agent.createdOn ? new Date(agent.createdOn).getTime() : null,
assignedRequest: agent.assignedRequest || null,
lastCompletedRequest: agent.lastCompletedRequest || null,
projectScoped
}));
} catch (error) {
console.warn(`Could not fetch agents for pool ${pool.name || pool.id}:`, error);
rows.push({
poolId: pool.id,
poolName: pool.name || `Pool ${pool.id}`,
isHosted: 'No',
poolType: pool.poolType || '—',
name: 'Unable to read agents',
status: error.message || 'Access denied',
enabled: '—', os: '—', version: '—', createdOn: '—', rawCreatedTimestamp: null, projectScoped
});
}
}
return rows;
}
async function getProjectAgentPools(org, project, authHeader) {
const projectInfoUrl = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects/${encodeURIComponent(project)}?api-version=${AZDO_STABLE_API_VERSION}`;
const queueUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/distributedtask/queues?$top=1000&api-version=${AZDO_STABLE_API_VERSION}`;
const [projectInfo, queueData] = await Promise.all([
fetchAzDo(projectInfoUrl, authHeader),
fetchAzDoPaged(queueUrl, authHeader, { pageSize: 500 })
]);
const projectId = projectInfo.id ? String(projectInfo.id).toLowerCase() : '';
const poolRefs = new Map();
(queueData.value || []).forEach(queue => {
if (projectId && queue.projectId && String(queue.projectId).toLowerCase() !== projectId) return;
const pool = queue.pool || {};
if (pool.id !== undefined && pool.id !== null) {
poolRefs.set(String(pool.id), {
id: Number(pool.id),
queueId: queue.id ?? null,
name: pool.name || queue.name || `Pool ${pool.id}`,
isHosted: pool.isHosted === true,
poolType: pool.poolType || '—'
});
}
});
const ids = [...poolRefs.keys()];
if (!ids.length) return [];
const poolUrl = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/distributedtask/pools?poolIds=${ids.map(encodeURIComponent).join(',')}&api-version=${AZDO_STABLE_API_VERSION}`;
const poolData = await fetchAzDo(poolUrl, authHeader);
const poolById = new Map((poolData.value || []).map(pool => [String(pool.id), pool]));
return ids.map(id => {
const ref = poolRefs.get(id);
const pool = poolById.get(id) || {};
return {
...pool,
id: Number(id),
queueId: ref.queueId ?? pool.queueId ?? null,
name: pool.name || ref.name || `Pool ${id}`,
isHosted: pool.isHosted === true || ref.isHosted === true,
poolType: pool.poolType || ref.poolType || '—',
projectId: projectId
};
});
}
async function getOrganizationProjects() {
const projectSelect = document.getElementById('projectSelect');
if (!projectSelect) return [];
return [...projectSelect.options]
.filter(option => option.value && !option.disabled)
.map(option => ({ name: option.value }));
}
async function fetchOrganizationServiceConnections(org, authHeader, projects) {
const results = await Promise.all((projects || []).map(async project => {
try {
const url = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project.name)}/_apis/serviceendpoint/endpoints?api-version=${AZDO_STABLE_API_VERSION}`;
const data = await fetchAzDoPaged(url, authHeader, { pageSize: 500 });
return (data.value || []).map(endpoint => mapServiceConnection(endpoint, project.name));
} catch (error) {
console.warn(`Could not fetch service connections for project ${project.name}:`, error);
return [];
}
}));
const byId = new Map();
results.flat().forEach(connection => {
if (connection.id && !byId.has(connection.id)) byId.set(connection.id, connection);
});
return [...byId.values()];
}
async function fetchServiceConnectionAgentData() {
const org = extractOrgName(document.getElementById('targetOrg').value);
const scopeProject = getServiceAgentsProject();
const pat = document.getElementById('targetPat').value.trim();
if (!org) return showModal('Please enter the Organization Name or URL first.', 'targetOrg');
if (!pat) return showModal('Please enter your Personal Access Token (PAT).', 'targetPat');
const authHeader = createBasicAuthHeader(pat);
const serviceBody = document.getElementById('serviceConnectionsTableBody');
const agentsBody = document.getElementById('agentsTableBody');
if (serviceBody) setSafeInnerHTML(serviceBody, '<tr><td colspan="6" class="p-4 text-center text-slate-400">Loading service connections...</td></tr>');
if (agentsBody) setSafeInnerHTML(agentsBody, '<tr><td colspan="9" class="p-4 text-center text-slate-400">Loading agent pools and agents...</td></tr>');
updateServiceAgentsScopeText();
const scopeText = scopeProject ? `project ${scopeProject}` : 'organization-wide';
startFetching(`Fetching ${scopeText} service connections, agent pools and agents...`);
try {
let serviceConnections = [];
let pools = [];
const projectScoped = Boolean(scopeProject);
if (projectScoped) {
const serviceUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(scopeProject)}/_apis/serviceendpoint/endpoints?api-version=${AZDO_STABLE_API_VERSION}`;
const [serviceData, projectPools] = await Promise.all([
fetchAzDoPaged(serviceUrl, authHeader, { pageSize: 500 }),
getProjectAgentPools(org, scopeProject, authHeader)
]);
serviceConnections = (serviceData.value || []).map(endpoint => mapServiceConnection(endpoint, scopeProject));
pools = projectPools;
} else {
const projects = await getOrganizationProjects();
if (!projects.length) throw new Error('No projects are loaded. Load projects from the Azure DevOps connection first.');
const [orgServiceConnections, poolData] = await Promise.all([
fetchOrganizationServiceConnections(org, authHeader, projects),
fetchAzDoPaged(`https://dev.azure.com/${encodeURIComponent(org)}/_apis/distributedtask/pools?api-version=${AZDO_STABLE_API_VERSION}`, authHeader, { pageSize: 500 })
]);
serviceConnections = orgServiceConnections;
pools = poolData.value || [];
}
rawStore.serviceConnections = serviceConnections;
sortByLatestDate(rawStore.serviceConnections, ['rawCreatedTimestamp']);
rawStore.serviceConnectionsIndex = 0;
rawStore.agentPools = pools;
rawStore.agents = await fetchAgentsForPools(org, authHeader, pools, { projectScoped });
sortByLatestDate(rawStore.agents, ['rawCreatedTimestamp']);
rawStore.agentsIndex = 0;
renderServiceConnectionsTableBatch(false);
renderAgentsTableBatch(false);
updateServiceAgentsOverview();
const realAgentCount = rawStore.agents.filter(a => !a.isSyntheticHosted && a.name !== 'Unable to read agents').length;
const hostedPoolCount = pools.filter(p => p.isHosted === true).length;
stopFetching();
setStatus(`Loaded ${serviceConnections.length} service connections, ${pools.length} ${projectScoped ? 'project-connected' : 'organization'} agent pools, ${realAgentCount} self-hosted agents and ${hostedPoolCount} Microsoft-hosted pools (${scopeText}).`, 'success');
} catch (error) {
stopFetching();
if (serviceBody) setSafeInnerHTML(serviceBody, `<tr><td colspan="7" class="p-4 text-center text-red-500">${escapeHtml(error.message)}</td></tr>`);
if (agentsBody) setSafeInnerHTML(agentsBody, `<tr><td colspan="9" class="p-4 text-center text-red-500">${escapeHtml(error.message)}</td></tr>`);
setStatus(isAzDoCancellation(error) ? 'The service connections and agents operation was cancelled.' : `Error fetching service connections and agents: ${error.message}`, isAzDoCancellation(error) ? 'info' : 'error');
}
}
function renderServiceConnectionsTableBatch(loadMore = false) {
const body = document.getElementById('serviceConnectionsTableBody');
const container = document.getElementById('seeMoreServiceConnectionsContainer');
const count = document.getElementById('serviceConnectionsRemainingCount');
if (!body) return;
const data = rawStore.serviceConnections || [];
const start = loadMore ? rawStore.serviceConnectionsIndex : 0;
const end = Math.min(start + PAGE_SIZE, data.length);
if (!loadMore) setSafeInnerHTML(body, '');
data.slice(start, end).forEach((s, rowOffset) => {
const row = document.createElement('tr');
row.dataset.detailType = 'service-connection';
row.dataset.detailIndex = String(start + rowOffset);
setSafeInnerHTML(row, `
<td class="p-4 font-medium text-slate-800">${escapeHtml(s.name)}</td>
<td class="p-4">${escapeHtml(s.type)}</td>
<td class="p-4 max-w-[320px] truncate" title="${escapeHtml(s.url)}">${escapeHtml(s.url)}</td>
<td class="p-4">${statusBadge(s.status)}</td>
<td class="p-4">${escapeHtml(s.isShared)}</td>
<td class="p-4">${escapeHtml(s.createdBy)}</td>`);
body.appendChild(row);
});
rawStore.serviceConnectionsIndex = end;
const remaining = Math.max(0, data.length - end);
if (count) count.textContent = remaining;
if (container) container.classList.toggle('hidden', remaining === 0);
if (!data.length) setSafeInnerHTML(body, '<tr><td colspan="6" class="p-4 text-center text-slate-400">No service connections found for the selected scope.</td></tr>');
}
function renderAgentsTableBatch(loadMore = false) {
const body = document.getElementById('agentsTableBody');
const container = document.getElementById('seeMoreAgentsContainer');
const count = document.getElementById('agentsRemainingCount');
if (!body) return;
const data = rawStore.agents || [];
const start = loadMore ? rawStore.agentsIndex : 0;
const end = Math.min(start + PAGE_SIZE, data.length);
if (!loadMore) setSafeInnerHTML(body, '');
data.slice(start, end).forEach((a, rowOffset) => {
const row = document.createElement('tr');
row.dataset.detailType = 'agent';
row.dataset.detailIndex = String(start + rowOffset);
setSafeInnerHTML(row, `
<td class="p-4 font-medium text-slate-800">${escapeHtml(a.poolName)}</td>
<td class="p-4">${escapeHtml(a.isHosted)}</td>
<td class="p-4">${escapeHtml(a.poolType)}</td>
<td class="p-4 font-medium">${escapeHtml(a.name)}</td>
<td class="p-4">${statusBadge(a.status)}</td>
<td class="p-4">${escapeHtml(a.enabled)}</td>
<td class="p-4">${escapeHtml(a.os)}</td>
<td class="p-4">${escapeHtml(a.version)}</td>
<td class="p-4">${escapeHtml(a.createdOn)}</td>`);
body.appendChild(row);
});
rawStore.agentsIndex = end;
const remaining = Math.max(0, data.length - end);
if (count) count.textContent = remaining;
if (container) container.classList.toggle('hidden', remaining === 0);
if (!data.length) setSafeInnerHTML(body, '<tr><td colspan="9" class="p-4 text-center text-slate-400">No agents or connected hosted pools found in the selected scope.</td></tr>');
}
function exportServiceConnectionsToXLSX() {
const data = (rawStore.serviceConnections || []).map(s => ({
'Service Connection': s.name,
'Type': s.type,
'URL': s.url,
'Status': s.status,
'Shared': s.isShared,
'Created By': s.createdBy,
...(s.projectName && s.projectName !== '—' ? {'Project': s.projectName} : {})
}));
exportToExcelFile({ 'Service Connections': data }, 'AzureDevOps_Service_Connections');
}
function exportAgentsToXLSX() {
const data = (rawStore.agents || []).map(a => ({
'Agent Pool': a.poolName,
'Hosted': a.isHosted,
'Pool Type': a.poolType,
'Agent Name': a.name,
'Status': a.status,
'Enabled': a.enabled,
'OS': a.os,
'Version': a.version,
'Created On': a.createdOn
}));
exportToExcelFile({ 'Agents': data }, 'AzureDevOps_Agents');
}
function exportServiceConnectionsAndAgentsToXLSX() {
exportToExcelFile({
'Service Connections': (rawStore.serviceConnections || []).map(s => ({
'Service Connection': s.name,
'Type': s.type,
'URL': s.url,
'Status': s.status,
'Shared': s.isShared,
'Created By': s.createdBy,
...(s.projectName && s.projectName !== '—' ? {'Project': s.projectName} : {})
})),
'Agents': (rawStore.agents || []).map(a => ({
'Agent Pool': a.poolName,
'Hosted': a.isHosted,
'Pool Type': a.poolType,
'Agent Name': a.name,
'Status': a.status,
'Enabled': a.enabled,
'OS': a.os,
'Version': a.version,
'Created On': a.createdOn
}))
}, 'AzureDevOps_ServiceConnections_Agents');
}
