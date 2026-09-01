async function fetchWorkItemStateMetadata(org, project, workItemTypes, authHeader) {
const typeNames = [...new Set((workItemTypes || []).filter(Boolean))];
const map = new Map();
const results = await Promise.allSettled(typeNames.map(async typeName => {
  const url = `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/wit/workitemtypes/${encodeURIComponent(typeName)}/states?api-version=${AZDO_API_VERSION}`;
  const data = await fetchAzDo(url, authHeader);
  return { typeName, states: Array.isArray(data?.value) ? data.value : [] };
}));
results.forEach(r => {
  if (r.status !== 'fulfilled') return;
  r.value.states.forEach(state => {
    const name = String(state?.name || '').trim();
    const category = String(state?.category || '').trim();
    if (name) map.set(`${r.value.typeName.toLowerCase()}|${name.toLowerCase()}`, category || 'Unknown');
  });
});
return map;
}
function normalizeWorkItemStateCategory(category, state) {
const c = String(category || '').toLowerCase();
const s = String(state || '').toLowerCase();
if (c.includes('proposed')) return 'Proposed';
if (c.includes('in progress') || c.includes('inprogress')) return 'In Progress';
if (c.includes('resolved')) return 'Resolved';
if (c.includes('completed')) return 'Completed';
if (c.includes('removed')) return 'Removed';
// If the state metadata endpoint is unavailable for a custom process, retain a
// conservative name-based fallback instead of losing all KPI classification.
if (['new','active','to do','todo'].includes(s)) return 'Proposed';
if (['in progress','in-progress','doing'].includes(s)) return 'In Progress';
if (['resolved'].includes(s)) return 'Resolved';
if (['closed','done','completed'].includes(s)) return 'Completed';
return 'Other';
}
async function fetchWorkItemsData() {
const org = extractOrgName(document.getElementById('targetOrg').value);
const project = document.getElementById('projectSelect').value;
const pat = document.getElementById('targetPat').value.trim();
const targetUser = document.getElementById('targetWorkItemUser').value.trim();
const authHeader = createBasicAuthHeader(pat);
showSection('workitems');
startFetching(targetUser ? `Querying work items assigned to "${targetUser}"...` : `Querying all active work items and sprint status...`);
try {
let wiql = `SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], [System.AssignedTo], [System.IterationPath], [System.CreatedDate], [System.ChangedDate] FROM workitems WHERE [System.TeamProject] = @project`;
if (targetUser) {
wiql += ` AND [System.AssignedTo] CONTAINS '${targetUser.replace(/'/g, "''")}'`;
}
wiql += ` ORDER BY [System.ChangedDate] DESC`;
const queryUrl = `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/wit/wiql?$top=20000&api-version=${AZDO_API_VERSION}`;
let queryRes;
try {
queryRes = await fetchAzDo(queryUrl, authHeader, {
method: 'POST',
body: JSON.stringify({ query: wiql })
});
} catch (e) {
const fallbackProject = project.replace(/'/g, "''");
const fallbackUser = targetUser.replace(/'/g, "''");
let fallbackWiql = `SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = '${fallbackProject}'`;
if (targetUser) {
fallbackWiql += ` AND [System.AssignedTo] CONTAINS '${fallbackUser}'`;
}
fallbackWiql += ` ORDER BY [System.ChangedDate] DESC`;
queryRes = await fetchAzDo(`https://dev.azure.com/${org}/_apis/wit/wiql?$top=20000&api-version=${AZDO_API_VERSION}`, authHeader, {
method: 'POST',
body: JSON.stringify({ query: fallbackWiql })
});
}
const wiList = Array.isArray(queryRes.workItems) ? queryRes.workItems : [];
const wiIds = wiList.map(w => w.id).filter(Boolean);
if (wiIds.length === 0) {
setSafeInnerHTML(document.getElementById('workItemsTableBody'), `<tr><td colspan="6" class="p-4 text-center text-slate-400">No work items found in project "${project}".</td></tr>`);
document.getElementById('seeMoreWorkItemsContainer').classList.add('hidden');
renderChart([], [], 'Work Item States');
setStatus(`No work items found matching criteria.`, 'info');
return;
}
const fields = 'System.Id,System.Title,System.WorkItemType,System.State,System.AssignedTo,System.IterationPath,System.CreatedDate,System.ChangedDate';
const ID_BATCH_SIZE = 200;
const idBatches = [];
for (let i = 0; i < wiIds.length; i += ID_BATCH_SIZE) idBatches.push(wiIds.slice(i, i + ID_BATCH_SIZE));
const detailResults = await Promise.allSettled(idBatches.map(ids => {
const detailsUrl = `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${fields}&api-version=${AZDO_API_VERSION}`;
return fetchAzDo(detailsUrl, authHeader);
}));
const workItems = detailResults.flatMap(result => result.status === 'fulfilled' ? (result.value?.value || []) : []);
let stateCounts = {};
let stateCategoryCounts = { Proposed: 0, 'In Progress': 0, Resolved: 0, Completed: 0, Removed: 0, Other: 0 };
const workItemTypes = [...new Set(workItems.map(w => w.fields?.['System.WorkItemType']).filter(Boolean))];
const stateMetadata = await fetchWorkItemStateMetadata(org, project, workItemTypes, authHeader);
rawStore.workitems = workItems.map(w => {
const fields = w.fields || {};
const type = fields['System.WorkItemType'] || 'Work Item';
const state = fields['System.State'] || 'New';
let assignedName = 'Unassigned';
if (fields['System.AssignedTo']) {
assignedName = fields['System.AssignedTo'].displayName ||
fields['System.AssignedTo'].name ||
fields['System.AssignedTo'].uniqueName ||
fields['System.AssignedTo'];
}
stateCounts[state] = (stateCounts[state] || 0) + 1;
const stateCategory = normalizeWorkItemStateCategory(stateMetadata.get(`${type.toLowerCase()}|${state.toLowerCase()}`), state);
stateCategoryCounts[stateCategory] = (stateCategoryCounts[stateCategory] || 0) + 1;
return {
id: w.id,
type: type,
title: fields['System.Title'] || 'Untitled',
assignedTo: assignedName,
state: state,
stateCategory: stateCategory,
createdDate: fields['System.CreatedDate'] ? new Date(fields['System.CreatedDate']).toLocaleDateString() : 'N/A',
changedDate: fields['System.ChangedDate'] ? new Date(fields['System.ChangedDate']).toLocaleString() : 'N/A',
rawChangedTimestamp: fields['System.ChangedDate'] ? new Date(fields['System.ChangedDate']).getTime() : null
};
});
sortByLatestDate(rawStore.workitems, ['rawChangedTimestamp', 'createdDate']);
rawStore.workitemsIndex = 0;
document.getElementById('kpi-1-label').textContent = 'Total Work Items';
document.getElementById('kpi-1-val').textContent = rawStore.workitems.length;
document.getElementById('kpi-1-val').className = 'text-2xl font-extrabold text-blue-600 mt-1 truncate';
document.getElementById('kpi-2-label').textContent = 'Proposed / Open';
document.getElementById('kpi-2-val').textContent = stateCategoryCounts.Proposed || 0;
document.getElementById('kpi-3-label').textContent = 'In Progress';
document.getElementById('kpi-3-val').textContent = stateCategoryCounts['In Progress'] || 0;
document.getElementById('kpi-4-label').textContent = 'Resolved';
document.getElementById('kpi-4-val').textContent = stateCategoryCounts.Resolved || 0;
document.getElementById('kpi-5-label').textContent = 'Completed';
document.getElementById('kpi-5-val').textContent = stateCategoryCounts.Completed || 0;
renderWorkItemsTableBatch(false);
const chartLabels = Object.keys(stateCounts);
const chartData = Object.values(stateCounts);
renderChart(chartLabels, chartData, 'Work Items by State');
stopFetching();
setStatus(`Loaded ${rawStore.workitems.length} work items successfully.`, 'success');
} catch (err) {
stopFetching();
setStatus(isAzDoCancellation(err) ? 'The work item operation was cancelled.' : `Error fetching work items: ${err.message}`, isAzDoCancellation(err) ? 'info' : 'error');
}
}
function renderWorkItemsTableBatch(append = false) {
const tbody = document.getElementById('workItemsTableBody');
const container = document.getElementById('seeMoreWorkItemsContainer');
const remainingEl = document.getElementById('workItemsRemainingCount');
if (!append) setSafeInnerHTML(tbody, '');
if (rawStore.workitems.length === 0) {
setSafeInnerHTML(tbody, `<tr><td colspan="6" class="p-4 text-center text-slate-400">No work items found.</td></tr>`);
container.classList.add('hidden');
return;
}
const nextBatch = rawStore.workitems.slice(rawStore.workitemsIndex, rawStore.workitemsIndex + PAGE_SIZE);
const batchStartIndex = rawStore.workitemsIndex;
rawStore.workitemsIndex += nextBatch.length;
const html = nextBatch.map((r, rowIndex) => `
<tr class="hover:bg-slate-50 transition" data-detail-type="work-item" data-detail-index="${batchStartIndex + rowIndex}">
<td class="p-4 font-mono text-xs font-bold text-blue-600">#${r.id}</td>
<td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-700">${r.type}</span></td>
<td class="p-4 font-medium text-slate-900 max-w-sm truncate" title="${r.title}">${r.title}</td>
<td class="p-4 text-xs font-semibold ${r.assignedTo === 'Unassigned' ? 'text-slate-400 italic' : 'text-slate-800'}">${r.assignedTo}</td>
<td class="p-4 text-xs">
<span class="px-2 py-0.5 rounded-full font-semibold ${
r.stateCategory === 'Completed' || r.stateCategory === 'Resolved' ? 'bg-emerald-100 text-emerald-700' :
r.stateCategory === 'In Progress' ? 'bg-amber-100 text-amber-700' :
r.stateCategory === 'Proposed' ? 'bg-blue-100 text-blue-700' :
'bg-slate-100 text-slate-700'
}">${r.state}</span>
</td>
<td class="p-4 text-xs text-slate-500">${r.createdDate}</td>
</tr>
`).join('');
insertSafeAdjacentHTML(tbody, 'beforeend', html);
const remaining = rawStore.workitems.length - rawStore.workitemsIndex;
if (remaining > 0) {
container.classList.remove('hidden');
remainingEl.textContent = remaining;
} else {
container.classList.add('hidden');
}
}
