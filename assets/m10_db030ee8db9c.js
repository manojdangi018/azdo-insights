(function () {
'use strict';
const DETAIL_TYPES = {
'repository-branch': {
title: row => `${row.repo || 'Repository'} / ${row.branch || 'Branch'}`,
subtitle: 'Git Branch Matrix & Policy Compliance Telemetry',
icon: 'branch'
},
'policy-branch': {
title: row => `${row.repo || 'Repository'} / ${row.branch || 'Branch'}`,
subtitle: 'Branch Policy Compliance Telemetry',
icon: 'branch'
},
'repository-pr': {
title: row => row.title || 'Pull Request',
subtitle: 'Pull Request & Branch Policy Telemetry',
icon: 'pr'
},
'access': {
title: row => row.name || 'User Access',
subtitle: 'Security Group & Team Membership Telemetry',
icon: 'users'
},
'user-commit': {
title: row => row.comment || 'Commit',
subtitle: 'User Commit & Repository Activity Telemetry',
icon: 'commit'
},
'user-pr': {
title: row => row.title || 'Pull Request',
subtitle: 'User Pull Request Activity Telemetry',
icon: 'pr'
},
'pipeline-summary': {
title: row => row.name || 'Pipeline',
subtitle: 'Pipeline Run Summary Telemetry',
icon: 'pipeline'
},
'pipeline-run': {
title: row => `${row.name || 'Pipeline'} #${row.buildNumber || '—'}`,
subtitle: 'Pipeline Build Run Telemetry',
icon: 'pipeline'
},
'service-connection': {
title: row => row.name || 'Service Connection',
subtitle: 'Azure DevOps Service Connection Telemetry',
icon: 'connection'
},
'agent': {
title: row => row.name || 'Agent',
subtitle: 'Azure DevOps Agent Pool Telemetry',
icon: 'agent'
},
'user-directory': {
title: row => row.name || 'User',
subtitle: 'Organization & Project User Entitlement Telemetry',
icon: 'users'
},
'work-item': {
title: row => `#${row.id || '—'} · ${row.title || 'Work Item'}`,
subtitle: 'Work Item & Backlog Telemetry',
icon: 'work'
}
};
const ICONS = {
branch: '<path d="M6 3v10a4 4 0 0 0 4 4h8"></path><circle cx="6" cy="3" r="2"></circle><circle cx="18" cy="17" r="2"></circle><path d="M6 7a4 4 0 0 1 4-4h2"></path><circle cx="12" cy="3" r="2"></circle>',
pr: '<path d="M6 3v18"></path><circle cx="6" cy="3" r="2"></circle><circle cx="6" cy="21" r="2"></circle><path d="M18 7v14"></path><circle cx="18" cy="7" r="2"></circle><path d="M6 9c0 2.2 1.8 4 4 4h8"></path>',
users: '<circle cx="9" cy="8" r="3"></circle><path d="M3 21a6 6 0 0 1 12 0"></path><path d="M16 4.5a3 3 0 0 1 0 7"></path><path d="M18 15a5 5 0 0 1 3 4.5"></path>',
commit: '<circle cx="12" cy="12" r="8"></circle><path d="M2 12h5m10 0h5"></path>',
pipeline: '<path d="M4 16.5c-1.5 1.2-2 4.5-2 4.5s3.3-.5 4.5-2c.7-.8.7-2-.1-2.8a2 2 0 0 0-2.4.3Z"></path><path d="M12 15 9 12a20 20 0 0 1 2-4A13 13 0 0 1 22 2c0 3-1 7.5-6 13l-4 0Z"></path><path d="M9 12H4"></path><path d="M15 12v5"></path>',
connection: '<rect x="3" y="4" width="18" height="16" rx="3"></rect><path d="M7 8h10M7 12h7M7 16h4"></path>',
agent: '<circle cx="12" cy="12" r="8"></circle><circle cx="12" cy="12" r="3"></circle><path d="M12 4V2M12 22v-2M4 12H2M22 12h-2"></path>',
work: '<rect x="3" y="4" width="18" height="16" rx="3"></rect><path d="M7 8h10M7 12h6M7 16h4"></path>'
};
function esc(value) {
if (value === null || value === undefined) return '—';
if (typeof value === 'object') {
try { value = JSON.stringify(value); } catch (_) { value = String(value); }
}
return String(value)
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#039;');
}
function prettyLabel(key) {
return String(key)
.replace(/([a-z])([A-Z])/g, '$1 $2')
.replace(/[_-]+/g, ' ')
.replace(/\b\w/g, c => c.toUpperCase());
}
function valueText(value) {
if (value === null || value === undefined || value === '') return '—';
if (Array.isArray(value)) return value.length ? value.join(', ') : 'None';
if (typeof value === 'object') {
const preferred = value.displayName || value.name || value.uniqueName || value.email;
if (preferred) return String(preferred);
return JSON.stringify(value);
}
return String(value);
}
function formatDetailDate(value) {
if (!value) return '—';
const d = value instanceof Date ? value : new Date(value);
if (!Number.isFinite(d.getTime())) return valueText(value);
return d.toLocaleString('en-GB', {
day: '2-digit', month: '2-digit', year: 'numeric',
hour: '2-digit', minute: '2-digit', second: '2-digit',
hour12: false
});
}
function isDateField(key) {
const k = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
return /(^|date|time|timestamp)$/.test(k) ||
['datecreated','lastaccesseddate','createdon','finishdate','finishtime','createddate','changeddate','rawcreatedtimestamp'].includes(k);
}
function statusClass(value) {
const v = String(value || '').toLowerCase();
if (['active', 'active branch', 'online', 'succeeded', 'completed', 'protected with policies', 'yes', 'enabled'].includes(v)) {
return 'detail-status detail-status-success';
}
if (['failed', 'inactive', 'offline', 'no', 'disabled', 'stale'].includes(v)) {
return 'detail-status detail-status-danger';
}
if (['in progress', 'queued', 'running', 'pending'].includes(v)) {
return 'detail-status detail-status-warning';
}
return 'detail-status detail-status-neutral';
}
function renderValue(key, value) {
const lowerKey = String(key).toLowerCase();
const text = isDateField(key) ? formatDetailDate(value) : valueText(value);
const lowerText = text.toLowerCase();
if (
['status', 'result', 'healthstatus', 'policyenforcement', 'isready', 'enabled', 'hosted', 'isshared'].includes(lowerKey) ||
['active', 'active branch', 'inactive', 'online', 'offline', 'succeeded', 'failed', 'stale', 'protected with policies'].includes(lowerText)
) {
return `<span class="${statusClass(text)}">${esc(text)}</span>`;
}
if (Array.isArray(value)) {
return value.length
? `<div class="detail-tags">${value.map(v => `<span class="detail-tag">${esc(valueText(v))}</span>`).join('')}</div>`
: '<span class="text-slate-400">None</span>';
}
return `<span class="detail-value">${esc(text)}</span>`;
}
function makeFields(row, type) {
const omit = new Set(['rawDate', 'rawTimestamp', 'isSyntheticHosted', 'projectScoped', 'raw']);
const entries = Object.entries(row || {}).filter(([key]) => !omit.has(key));
if (type === 'repository-branch') {
const primary = [
['Repository', row.repo],
['Branch Ref', row.branch ? `refs/heads/${row.branch}` : '—'],
['Health Status', row.isStale ? 'Stale' : 'Active Branch'],
['Policy Enforcement', row.hasPolicy ? 'Protected with Policies' : 'No Active Policies'],
['Last Commit Author', row.author],
['Last Commit Date', row.date],
['Branch Association Source', row.branchSource || 'Branch tip lookup']
];
const secondary = [
['Required Reviewers', row.minReviewers || 0],
['Branch Policies', row.policies || []],
['Last Commit Message', row.msg || 'No commit message']
];
return { primary, secondary };
}
if (type === 'policy-branch') {
return {
primary: [
['Repository', row.repo],
['Branch Ref', row.branch ? `refs/heads/${row.branch}` : '—'],
['Required Reviewers', row.minReviewers || 0],
['Policy Count', Array.isArray(row.policies) ? row.policies.length : 0],
['Last Author', row.author],
['Last Commit Date', row.date]
],
secondary: [['Branch Policies', row.policies || []], ['Commit Message', row.msg || 'No commit message']]
};
}
const preferredOrder = {
'repository-pr': ['repo', 'title', 'source', 'target', 'status', 'creator', 'createdDate', 'reviewersCount', 'minRequiredReviewers', 'targetPolicies'],
'user-pr': ['repo', 'title', 'source', 'target', 'status', 'createdDate'],
'access': ['team', 'type', 'name', 'email'],
'user-commit': ['repo', 'branch', 'commitId', 'date', 'comment'],
'pipeline-summary': ['name', 'pipelineType', 'pipelineId', 'total', 'succeeded', 'failed', 'autoTriggers', 'manualTriggers'],
'pipeline-run': ['name', 'pipelineType', 'pipelineId', 'buildNumber', 'branch', 'reason', 'rawReason', 'triggerCategory', 'author', 'result', 'finishTime'],
'service-connection': ['name', 'type', 'status', 'isReady', 'isShared', 'url', 'createdBy', 'projectName'],
'agent': ['poolName', 'hosted', 'isHosted', 'poolType', 'name', 'status', 'enabled', 'os', 'version', 'createdOn'],
'user-directory': ['name', 'email', 'accessLevel', 'status', 'dateCreated', 'lastAccessedDate', 'licensingSource', 'licenseAssignmentSource', 'projectCount'],
'work-item': ['id', 'type', 'title', 'assignedTo', 'state', 'createdDate']
}[type] || entries.map(([key]) => key);
const ordered = preferredOrder
.filter(key => Object.prototype.hasOwnProperty.call(row || {}, key))
.map(key => [prettyLabel(key), row[key]]);
const used = new Set(preferredOrder);
entries.forEach(([key, value]) => {
if (!used.has(key)) ordered.push([prettyLabel(key), value]);
});
const split = Math.ceil(ordered.length / 2);
return { primary: ordered.slice(0, split), secondary: ordered.slice(split) };
}
function fieldGrid(fields) {
return fields.map(([label, value]) => `
<div class="detail-field">
<div class="detail-field-label">${esc(label)}</div>
<div class="detail-field-value">${renderValue(label.replace(/\s/g, ''), value)}</div>
</div>
`).join('');
}
function getAzDoAuthContext() {
const orgValue = document.getElementById('targetOrg')?.value || '';
const pat = document.getElementById('targetPat')?.value?.trim() || '';
const org = typeof extractOrgName === 'function' ? extractOrgName(orgValue) : '';
if (!org || !pat || typeof fetchAzDo !== 'function') return null;
return { org, pat, authHeader: createBasicAuthHeader(pat) };
}
function getNestedBuildId(request) {
if (!request || typeof request !== 'object') return null;
const directCandidates = [
request.buildId,
request.buildID,
request.owner?.id,
request.definition?.id,
request.data?.buildId,
request.data?.buildID,
request.data?.BuildId,
request.data?.build?.id,
request.data?.build?.buildId
];
for (const candidate of directCandidates) {
const n = Number(candidate);
if (Number.isInteger(n) && n > 0) return n;
}
return null;
}
function getRequestPipelineName(request) {
return request?.definition?.name || request?.owner?.name || request?.definition?.displayName || request?.owner?.displayName || 'Unknown pipeline';
}
function getRequestTriggerFallback(request) {
return request?.requestedBy?.displayName || request?.requestedFor?.displayName || request?.data?.requestedBy || request?.data?.requestedFor || '—';
}
function formatRunDateTime(value) {
if (!value) return '—';
const date = new Date(value);
return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value);
}
function formatPipelineRunStatus(value) {
const status = String(value || '').trim().toLowerCase();
if (status === 'succeeded' || status === 'success' || status === 'successful') {
return { label: 'Succeeded', className: 'pipeline-status-succeeded' };
}
if (status === 'failed' || status === 'failure') {
return { label: 'Failed', className: 'pipeline-status-failed' };
}
if (status === 'canceled' || status === 'cancelled') {
return { label: 'Canceled', className: 'pipeline-status-canceled' };
}
if (status === 'partiallysucceeded' || status === 'partiallysucceeded') {
return { label: 'Partially Succeeded', className: 'pipeline-status-partial' };
}
if (status === 'inprogress' || status === 'in progress') {
return { label: 'In Progress', className: 'pipeline-status-progress' };
}
if (status === 'notstarted' || status === 'not started') {
return { label: 'Not Started', className: 'pipeline-status-pending' };
}
return { label: value ? String(value) : 'Unknown', className: 'pipeline-status-unknown' };
}
function buildPipelineHistoryTable(pipelineRow, runs) {
const pipelineName = pipelineRow?.name || 'Unknown Pipeline';
const pipelineRuns = (Array.isArray(runs) ? runs : [])
.filter(run => pipelineRow?.identityKey ? String(run?.pipelineIdentityKey || '') === String(pipelineRow.identityKey) : String(run?.name || '').toLowerCase() === String(pipelineName).toLowerCase())
.sort((a, b) => (Number(b?.triggerTimestamp) || Number(b?.rawTimestamp) || 0) - (Number(a?.triggerTimestamp) || Number(a?.rawTimestamp) || 0));
if (!pipelineRuns.length) {
return `
<div class="pipeline-history-empty">
No pipeline run history is available for <strong>${esc(pipelineName)}</strong>.
</div>`;
}
const rows = pipelineRuns.map(run => {
const status = formatPipelineRunStatus(run.result || run.status);
return `
<tr>
<td>${esc(run.branch || 'Unknown Branch')}</td>
<td>${esc(run.buildNumber ?? run.id ?? '—')}</td>
<td>${esc(run.author || '—')}</td>
<td>${esc(run.triggerDate || run.finishTime || '—')}</td>
<td><span class="pipeline-status-badge ${status.className}">${esc(status.label)}</span></td>
</tr>`;
}).join('');
return `
<div class="pipeline-history-title">${esc(pipelineName)}</div>
<div class="pipeline-run-summary">
<span class="pipeline-run-count">${pipelineRuns.length}</span>
<span>Pipeline run${pipelineRuns.length === 1 ? '' : 's'} shown</span>
</div>
<div class="pipeline-history-table-wrap">
<table class="pipeline-history-table">
<thead>
<tr>
<th>Trigger Branch Name</th>
<th>Build Number</th>
<th>Triggered By</th>
<th>Trigger Date &amp; Time</th>
<th>Status</th>
</tr>
</thead>
<tbody>${rows}</tbody>
</table>
</div>
`;
}
function buildAgentRunsTable(runs) {
if (!runs.length) {
return `<div class="agent-run-empty">No pipeline run history was returned for this agent/pool.</div>`;
}
const rows = runs.map(run => `
<tr>
<td>${esc(run.pipelineName)}</td>
<td>${esc(run.buildNumber)}</td>
<td>${esc(run.triggeredBy)}</td>
<td>${esc(run.dateTime)}</td>
<td><span class="pipeline-status-badge ${formatPipelineRunStatus(run.status).className}">${esc(formatPipelineRunStatus(run.status).label)}</span></td>
</tr>
`).join('');
return `
<div class="agent-run-summary">
<span class="agent-run-count">${runs.length}</span>
<span>Recent pipeline run${runs.length === 1 ? '' : 's'} shown</span>
</div>
<div class="agent-run-table-wrap">
<table class="agent-run-table">
<thead><tr><th>Pipeline Name</th><th>Build #</th><th>Triggered By</th><th>Date &amp; Time</th><th>Status</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>
`;
}
async function fetchAgentPipelineRuns(agentRow) {
const context = getAzDoAuthContext();
if (!context || !agentRow?.poolId) {
return { runs: [], error: 'Agent history is unavailable because the Azure DevOps connection or agent pool is missing.' };
}
const apiVersion = typeof AZDO_STABLE_API_VERSION !== 'undefined' ? AZDO_STABLE_API_VERSION : '7.1';
const project = document.getElementById('projectSelect')?.value?.trim() || '';
if (agentRow.isSyntheticHosted || agentRow.isHosted === 'Yes') {
try {
if (!project) {
return { runs: [], error: 'Select a project to view Microsoft-hosted pipeline run history.' };
}
let queueId = agentRow.queueId ?? null;
if (!queueId) {
const queueUrl = `https://dev.azure.com/${encodeURIComponent(context.org)}/${encodeURIComponent(project)}/_apis/distributedtask/queues?$top=1000&api-version=${apiVersion}`;
const queueData = await fetchAzDo(queueUrl, context.authHeader);
const queue = (queueData?.value || []).find(q => Number(q?.pool?.id) === Number(agentRow.poolId));
queueId = queue?.id ?? null;
}
if (!queueId) {
return { runs: [], error: 'The Microsoft-hosted pool is not mapped to a build queue in the selected project.' };
}
const buildUrl = `https://dev.azure.com/${encodeURIComponent(context.org)}/${encodeURIComponent(project)}/_apis/build/builds?queues=${encodeURIComponent(queueId)}&$top=25&queryOrder=finishTimeDescending&api-version=${AZDO_API_VERSION}`;
const buildData = await fetchAzDo(buildUrl, context.authHeader);
const builds = Array.isArray(buildData?.value) ? buildData.value : [];
const runs = builds.map(build => {
const dateValue = build.finishTime || build.startTime || build.queueTime || build.buildNumber;
return {
pipelineName: build.definition?.name || build.definition?.path || 'Unknown pipeline',
buildId: build.id || '—',
buildNumber: build.buildNumber || build.name || (build.id != null ? `#${build.id}` : '—'),
triggeredBy: build.requestedBy?.displayName || build.requestedFor?.displayName || '—',
dateTime: formatRunDateTime(dateValue),
timestamp: dateValue ? new Date(dateValue).getTime() || 0 : 0,
status: build.result || build.status || '—'
};
}).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
return { runs };
} catch (error) {
console.warn(`Could not fetch pipeline history for Microsoft-hosted pool ${agentRow.poolId}:`, error);
return { runs: [], error: error.message || 'Unable to load Microsoft-hosted pipeline run history.' };
}
}
if (!agentRow.agentId) {
return { runs: [], error: 'Agent history is unavailable because the self-hosted agent identifier is missing.' };
}
const url = `https://dev.azure.com/${encodeURIComponent(context.org)}/_apis/distributedtask/pools/${encodeURIComponent(agentRow.poolId)}/jobrequests?agentId=${encodeURIComponent(agentRow.agentId)}&completedRequestCount=25&api-version=${apiVersion}`;
try {
const data = await fetchAzDo(url, context.authHeader);
const requests = Array.isArray(data?.value) ? data.value : [];
const buildIds = [...new Set(requests.map(getNestedBuildId).filter(Boolean))];
let buildsById = new Map();
if (project && buildIds.length) {
try {
const buildUrl = `https://dev.azure.com/${encodeURIComponent(context.org)}/${encodeURIComponent(project)}/_apis/build/builds?buildIds=${buildIds.join(',')}&api-version=${AZDO_API_VERSION}`;
const buildData = await fetchAzDo(buildUrl, context.authHeader);
buildsById = new Map((buildData?.value || []).map(build => [Number(build.id), build]));
} catch (buildError) {
console.warn('Could not enrich agent job requests with build details:', buildError);
}
}
const runs = requests.map(request => {
const buildId = getNestedBuildId(request);
const build = buildId ? buildsById.get(buildId) : null;
const pipelineName = build?.definition?.name || getRequestPipelineName(request);
const triggeredBy = build?.requestedBy?.displayName || build?.requestedFor?.displayName || getRequestTriggerFallback(request);
const dateValue = build?.finishTime || build?.startTime || request.finishTime || request.assignTime || request.queueTime;
return {
pipelineName,
buildId: buildId || '—',
buildNumber: build?.buildNumber || build?.name || request?.buildNumber || request?.data?.buildNumber || (buildId ? `#${buildId}` : '—'),
triggeredBy,
dateTime: formatRunDateTime(dateValue),
timestamp: dateValue ? new Date(dateValue).getTime() : 0,
status: build?.result || request.result || request.statusMessage || '—'
};
}).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
const seen = new Set();
const uniqueRuns = runs.filter(run => {
const key = `${run.buildId}|${run.pipelineName}|${run.dateTime}`;
if (seen.has(key)) return false;
seen.add(key);
return true;
});
return { runs: uniqueRuns };
} catch (error) {
console.warn(`Could not fetch pipeline history for agent ${agentRow.name}:`, error);
return { runs: [], error: error.message || 'Unable to load pipeline run history.' };
}
}
function getAzDoUrl(type, row) {
const org = typeof extractOrgName === 'function'
? extractOrgName(document.getElementById('targetOrg')?.value || '')
: '';
const project = document.getElementById('projectSelect')?.value || '';
if (!org || !project) return '';
const projectPath = encodeURIComponent(project);
if (type === 'repository-branch' || type === 'policy-branch') {
return `https://dev.azure.com/${encodeURIComponent(org)}/${projectPath}/_git/${encodeURIComponent(row.repo || '')}?version=GB${encodeURIComponent(row.branch || '')}`;
}
if (type === 'repository-pr' || type === 'user-pr') {
if (row.id) return `https://dev.azure.com/${encodeURIComponent(org)}/${projectPath}/_git/${encodeURIComponent(row.repo || '')}/pullrequest/${encodeURIComponent(row.id)}`;
return `https://dev.azure.com/${encodeURIComponent(org)}/${projectPath}/_git/${encodeURIComponent(row.repo || '')}/pullrequests`;
}
if (type === 'work-item' && row.id) {
return `https://dev.azure.com/${encodeURIComponent(org)}/${projectPath}/_workitems/edit/${encodeURIComponent(row.id)}`;
}
if (type === 'pipeline-run' && row.id) {
return `https://dev.azure.com/${encodeURIComponent(org)}/${projectPath}/_build/results?buildId=${encodeURIComponent(row.id)}`;
}
if (type === 'pipeline-summary') {
return `https://dev.azure.com/${encodeURIComponent(org)}/${projectPath}/_build?definitionId=${encodeURIComponent(row.id || '')}`;
}
return '';
}
function iconSvg(icon) {
return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[icon] || ICONS.work}</svg>`;
}
function ensureModal() {
if (document.getElementById('dataDetailModal')) return;
const wrapper = document.createElement('div');
wrapper.id = 'dataDetailModal';
wrapper.className = 'data-detail-modal hidden';
setSafeInnerHTML(wrapper, `
<div class="data-detail-backdrop" data-detail-close="true"></div>
<aside class="data-detail-panel" role="dialog" aria-modal="true" aria-labelledby="dataDetailTitle">
<div class="data-detail-header">
<div class="data-detail-breadcrumb" id="dataDetailBreadcrumb"></div>
<button class="data-detail-close" type="button" aria-label="Close" data-detail-action="close">&times;</button>
<div class="data-detail-title-row">
<div class="data-detail-icon" id="dataDetailIcon"></div>
<div class="min-w-0">
<h2 id="dataDetailTitle"></h2>
<p id="dataDetailSubtitle"></p>
</div>
</div>
</div>
<div class="data-detail-actions">
<a id="dataDetailOpenLink" class="data-detail-action-btn hidden" target="_blank" rel="noopener noreferrer">
<span>↗</span> Open in Azure DevOps
</a>
<button id="dataDetailCopyBtn" class="data-detail-action-btn" type="button" data-detail-action="copy">
<span>▣</span> Copy Telemetry
</button>
</div>
<div class="data-detail-tabs" role="tablist">
<button type="button" class="data-detail-tab active" data-detail-tab="overview">Overview</button>
<button type="button" class="data-detail-tab" data-detail-tab="details">Details</button>
<button type="button" class="data-detail-tab" data-detail-tab="json">JSON Payload</button>
</div>
<div class="data-detail-content">
<section id="dataDetailOverview" class="data-detail-tab-content"></section>
<section id="dataDetailDetails" class="data-detail-tab-content hidden"></section>
<section id="dataDetailJson" class="data-detail-tab-content hidden">
<pre id="dataDetailJsonPre" class="data-detail-json"></pre>
</section>
</div>
</aside>
`);
document.body.appendChild(wrapper);
wrapper.addEventListener('click', event => {
const tab = event.target.closest('[data-detail-tab]');
if (tab) {
switchDataDetailTab(tab.dataset.detailTab);
return;
}
if (event.target.closest('[data-detail-close="true"]')) {
closeDataDetail();
return;
}
const action = event.target.closest('[data-detail-action]')?.dataset.detailAction;
if (action === 'close') {
closeDataDetail();
return;
}
if (action === 'copy') {
copyDataDetailTelemetry();
}
});
}
let currentDetail = null;
async function openDataDetail(type, index) {
ensureModal();
const store = typeof window.__getAzdoRawStore === 'function' ? window.__getAzdoRawStore() : null;
const row = store?.[detailStoreKey(type)]?.[Number(index)];
if (!row) return;
currentDetail = { type, index: Number(index), row };
const config = DETAIL_TYPES[type];
if (!config) return;
const title = typeof config.title === 'function' ? config.title(row) : config.title;
const project = document.getElementById('projectSelect')?.value || 'Project';
const typeLabel = prettyLabel(type.replace(/-/g, ' '));
const fields = makeFields(row, type);
setSafeInnerHTML(document.getElementById('dataDetailBreadcrumb'), `
<span>⌂</span><span>/</span><span>${esc(project)}</span><span>/</span><span>${esc(typeLabel)}</span>
`);
setSafeInnerHTML(document.getElementById('dataDetailIcon'), iconSvg(config.icon));
document.getElementById('dataDetailTitle').textContent = title;
document.getElementById('dataDetailSubtitle').textContent = config.subtitle;
const openLink = document.getElementById('dataDetailOpenLink');
const url = getAzDoUrl(type, row);
if (url) {
openLink.href = url;
openLink.classList.remove('hidden');
} else {
openLink.removeAttribute('href');
openLink.classList.add('hidden');
}
setSafeInnerHTML(document.getElementById('dataDetailOverview'), `
<div class="detail-section-card">
<div class="detail-section-heading"><span class="detail-section-icon">◷</span> ${esc(type === 'repository-branch' || type === 'policy-branch' ? 'Branch Health & Metadata' : 'Record Overview')}</div>
<div class="detail-grid">${fieldGrid(fields.primary)}</div>
</div>
`);
if (type === 'user-directory') {
const projects = Array.isArray(row.projects) ? row.projects : [];
const projectRows = projects.length ? projects.map(p => {
const permissions = [
p.group ? `Role: ${p.group}` : '',
p.teams?.length ? `Teams: ${p.teams.join(', ')}` : '',
p.assignmentSource && p.assignmentSource !== 'unknown' ? `Assignment: ${p.assignmentSource}` : '',
p.inherited && p.inherited !== 'notSet' ? `Permission Source: ${p.inherited}` : ''
].filter(Boolean);
return `
<div class="user-project-row">
<div class="user-project-name">${esc(p.projectName || 'Unknown Project')}</div>
<div class="user-project-permissions">${permissions.length ? permissions.map(x => `<span class="user-project-permission">${esc(x)}</span>`).join('') : '<span class="text-slate-400">No project permission details</span>'}</div>
</div>`;
}).join('') : '<div class="user-project-empty">No project access listed</div>';
setSafeInnerHTML(document.getElementById('dataDetailDetails'), `
<div class="detail-section-card user-projects-card">
<div class="detail-section-heading"><span class="detail-section-icon">⌁</span> PROJECT ACCESS &amp; PERMISSIONS</div>
<div class="user-project-table">
<div class="user-project-header"><div>PROJECT NAME</div><div>PERMISSIONS</div></div>
${projectRows}
</div>
</div>
`);
} else if (type === 'pipeline-summary') {
const allPipelineRuns = Array.isArray(store?.pipelines) ? store.pipelines : [];
setSafeInnerHTML(document.getElementById('dataDetailDetails'), `
<div class="detail-section-card pipeline-history-card">
<div class="detail-section-heading"><span class="detail-section-icon">⌁</span> PIPELINE RUN HISTORY</div>
${buildPipelineHistoryTable(row, allPipelineRuns)}
</div>
`);
} else if (type === 'agent') {
setSafeInnerHTML(document.getElementById('dataDetailDetails'), `
<div class="detail-section-card agent-runs-card">
<div class="detail-section-heading"><span class="detail-section-icon">⌁</span> Pipeline Run History</div>
<div id="agentPipelineRunsContent" class="agent-runs-content">
<div class="agent-run-loading"><span class="agent-run-spinner"></span> Loading recent pipeline runs for this agent/pool...</div>
</div>
</div>
`);
} else {
setSafeInnerHTML(document.getElementById('dataDetailDetails'), `
<div class="detail-section-card">
<div class="detail-section-heading"><span class="detail-section-icon">⌁</span> Additional Details</div>
<div class="detail-grid">${fieldGrid(fields.secondary.length ? fields.secondary : [['Record Type', typeLabel]])}</div>
</div>
`);
}
document.getElementById('dataDetailJsonPre').textContent = JSON.stringify(row, null, 2);
switchDataDetailTab('overview');
const modal = document.getElementById('dataDetailModal');
modal.classList.remove('hidden');
requestAnimationFrame(() => modal.classList.add('is-open'));
document.body.classList.add('data-detail-open');
if (type === 'agent') {
const detailSnapshot = currentDetail;
const result = await fetchAgentPipelineRuns(row);
if (currentDetail !== detailSnapshot) return;
const target = document.getElementById('agentPipelineRunsContent');
if (!target) return;
setSafeInnerHTML(target, result.error
? `<div class="agent-run-error">${esc(result.error)}</div>`
: buildAgentRunsTable(result.runs));
}
}
function detailStoreKey(type) {
return ({
'repository-branch': 'repos',
'policy-branch': 'repos',
'repository-pr': 'repoPrs',
'access': 'access',
'user-commit': 'commits',
'user-pr': 'repoPrs',
'pipeline-summary': 'pipelineSummaries',
'pipeline-run': 'pipelines',
'service-connection': 'serviceConnections',
'agent': 'agents',
'user-directory': 'userEntitlements',
'work-item': 'workitems'
})[type];
}
function switchDataDetailTab(tabName) {
document.querySelectorAll('.data-detail-tab').forEach(tab => {
tab.classList.toggle('active', tab.dataset.detailTab === tabName);
});
document.querySelectorAll('.data-detail-tab-content').forEach(section => {
section.classList.toggle('hidden', section.id !== `dataDetail${tabName.charAt(0).toUpperCase() + tabName.slice(1)}` && !(tabName === 'json' && section.id === 'dataDetailJson'));
});
document.getElementById('dataDetailOverview').classList.toggle('hidden', tabName !== 'overview');
document.getElementById('dataDetailDetails').classList.toggle('hidden', tabName !== 'details');
document.getElementById('dataDetailJson').classList.toggle('hidden', tabName !== 'json');
}
function closeDataDetail() {
const modal = document.getElementById('dataDetailModal');
if (!modal) return;
modal.classList.remove('is-open');
setTimeout(() => modal.classList.add('hidden'), 180);
document.body.classList.remove('data-detail-open');
currentDetail = null;
}
async function copyDataDetailTelemetry() {
if (!currentDetail) return;
const payload = JSON.stringify(currentDetail.row, null, 2);
try {
await navigator.clipboard.writeText(payload);
const button = document.getElementById('dataDetailCopyBtn');
const original = button.innerHTML;
setSafeInnerHTML(button, '<span>✓</span> Copied');
setTimeout(() => { setSafeInnerHTML(button, original); }, 1400);
} catch (_) {
const area = document.createElement('textarea');
area.value = payload;
document.body.appendChild(area);
area.select();
document.execCommand('copy');
area.remove();
}
}
const boundDetailRows = new WeakSet();
function bindRows() {
document.querySelectorAll('table tbody tr[data-detail-type]').forEach(row => {
row.classList.add('data-detail-row');
row.setAttribute('tabindex', '0');
row.setAttribute('role', 'button');
row.setAttribute('aria-label', 'Open details');
if (boundDetailRows.has(row)) return;
boundDetailRows.add(row);
row.addEventListener('click', event => {
if (event.target.closest('button, a, input, select, textarea')) return;
openDataDetail(row.dataset.detailType, row.dataset.detailIndex);
});
row.addEventListener('keydown', event => {
if (event.key === 'Enter' || event.key === ' ') {
event.preventDefault();
openDataDetail(row.dataset.detailType, row.dataset.detailIndex);
}
});
});
}
document.addEventListener('keydown', event => {
if (event.key === 'Escape') closeDataDetail();
});
window.openDataDetail = openDataDetail;
window.closeDataDetail = closeDataDetail;
window.copyDataDetailTelemetry = copyDataDetailTelemetry;
window.switchDataDetailTab = switchDataDetailTab;
window.bindDataDetailRows = bindRows;
const detailObserver = new MutationObserver(() => bindRows());
detailObserver.observe(document.body, { childList: true, subtree: true });
bindRows();
ensureModal();
})();
