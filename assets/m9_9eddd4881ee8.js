function escapeUserHtml(value) {
return String(value ?? '').replace(/[&<>'"`]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;','`':'&#96;'}[ch]));
}
function getUserDirectoryProject() {
return (document.getElementById('projectSelect')?.value || '').trim();
}
function updateUserDirectoryScopeText() {
const el = document.getElementById('userDirectoryScopeText');
const subtitle = document.getElementById('userDirectoryTableSubtitle');
const project = getUserDirectoryProject();
if (el) {
el.textContent = project
? `Project-level scan: showing users with access to ${project}, including their effective project group/team access.`
: 'Organization-level scan: showing all users, organization license/status, dates, and every project they can access.';
}
if (subtitle) {
subtitle.textContent = project
? `Project scope: ${project} — user identity, organization license and effective project permissions`
: 'Organization scope: all users, licenses, dates and project access';
}
}
function formatUserDirectoryDate(value) {
if (!value) return '—';
const d = new Date(value);
if (!Number.isFinite(d.getTime())) return '—';
return d.toLocaleString('en-GB', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });
}
function userAccessBadge(text, tone = 'blue') {
const tones = {
green: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
amber: 'bg-amber-100 text-amber-700 border border-amber-200',
red: 'bg-red-100 text-red-700 border border-red-200',
blue: 'bg-blue-50 text-blue-700 border border-blue-200',
purple: 'bg-purple-50 text-purple-700 border border-purple-200',
slate: 'bg-slate-100 text-slate-700 border border-slate-200'
};
return `<span class="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold ${tones[tone] || tones.blue}">${escapeUserHtml(text || '—')}</span>`;
}
function normalizeAccessLevel(entitlement) {
const level = entitlement?.accessLevel || {};
return level.licenseDisplayName || level.accountLicenseType || 'Unknown';
}
function normalizeUserStatus(entitlement) {
const status = entitlement?.accessLevel?.status || entitlement?.user?.metaType || 'Unknown';
return String(status).replace(/([a-z])([A-Z])/g, '$1 $2');
}
function projectAccessSummary(entitlement) {
const projects = Array.isArray(entitlement?.projectEntitlements) ? entitlement.projectEntitlements : [];
return projects.map(p => {
const projectName = p?.projectRef?.name || 'Unknown Project';
const group = p?.group?.displayName || p?.group?.groupType || 'Project access';
const teams = Array.isArray(p?.teamRefs) ? p.teamRefs.map(t => t?.name).filter(Boolean) : [];
return { projectName, group, teams, assignmentSource: p?.assignmentSource || 'unknown', inherited: p?.projectPermissionInherited || 'notSet' };
});
}
function flattenUserEntitlement(entitlement) {
const user = entitlement?.user || {};
const projects = projectAccessSummary(entitlement);
return {
id: entitlement?.id || '',
name: user.displayName || user.principalName || user.mailAddress || 'Unknown',
email: user.mailAddress || user.principalName || 'N/A',
accessLevel: normalizeAccessLevel(entitlement),
status: normalizeUserStatus(entitlement),
dateCreated: entitlement?.dateCreated || '',
lastAccessedDate: entitlement?.lastAccessedDate || '',
licensingSource: entitlement?.accessLevel?.licensingSource || '—',
licenseAssignmentSource: entitlement?.accessLevel?.assignmentSource || '—',
projects,
projectCount: projects.length,
raw: entitlement
};
}
async function fetchAllUserEntitlements(org, authHeader) {
const params = new URLSearchParams();
params.set('api-version', AZDO_STABLE_API_VERSION || '7.1');
params.set('select', 'projects');
params.set('$orderBy', 'lastAccessed desc');
const url = `https://vsaex.dev.azure.com/${encodeURIComponent(org)}/_apis/userentitlements?${params.toString()}`;
const data = await fetchAzDoPaged(url, authHeader, { itemProperty: 'items', pageSize: 100 });
return data?.items || [];
}
async function fetchUserDirectoryData() {
const org = extractOrgName(document.getElementById('targetOrg')?.value || '');
const pat = (document.getElementById('targetPat')?.value || '').trim();
const project = getUserDirectoryProject();
const query = (document.getElementById('targetDirectoryUserQuery')?.value || '').trim();
if (!org || !pat) {
setStatus('Organization and PAT are required.', 'error');
return;
}
startFetching(project ? `Loading users for project: ${project}...` : 'Loading organization users and project access...');
try {
const authHeader = createBasicAuthHeader(pat);
const entitlements = await fetchAllUserEntitlements(org, authHeader);
const rows = entitlements.map(flattenUserEntitlement).filter(u => {
if (!query) return true;
return identityMatchesQuery(query, { displayName: u.name, mailAddress: u.email, uniqueName: u.email });
});
let scopedRows = rows;
if (project) {
const projectLower = project.toLowerCase();
scopedRows = rows.filter(u => u.projects.some(p => p.projectName.toLowerCase() === projectLower));
}
sortByLatestDate(scopedRows, ['lastAccessedDate', 'dateCreated']);
rawStore.userEntitlements = scopedRows;
rawStore.userDirectoryIndex = 0;
const totalUsers = scopedRows.length;
const activeUsers = scopedRows.filter(u => String(u.status).toLowerCase() === 'active').length;
const basicStakeholder = scopedRows.filter(u => /basic|stakeholder|express|professional/i.test(u.accessLevel)).length;
const projectAccessCount = project
? scopedRows.length
: scopedRows.reduce((sum, u) => sum + u.projectCount, 0);
const kpis = [
['Total Users', totalUsers, 'text-2xl font-extrabold text-slate-800 mt-1 truncate'],
['Active Users', activeUsers, 'text-2xl font-extrabold text-emerald-600 mt-1'],
['Licensed Users', basicStakeholder, 'text-2xl font-extrabold text-blue-600 mt-1'],
[project ? 'Project Users' : 'Project Access', projectAccessCount, 'text-2xl font-extrabold text-indigo-600 mt-1'],
['Scope', project || 'Organization', 'text-2xl font-extrabold text-slate-800 mt-1 truncate']
];
kpis.forEach((item, i) => {
const label = document.getElementById(`kpi-${i + 1}-label`);
const value = document.getElementById(`kpi-${i + 1}-val`);
if (label) label.textContent = item[0];
if (value) { value.textContent = item[1]; value.className = item[2]; }
});
updateUserDirectoryScopeText();
renderUserDirectoryTableBatch(false);
stopFetching();
setStatus(`Loaded ${totalUsers} user entitlement record${totalUsers === 1 ? '' : 's'}${project ? ` for project ${project}` : ' across the organization'}.`, 'success');
} catch (err) {
stopFetching();
rawStore.userEntitlements = [];
rawStore.userDirectoryIndex = 0;
const message = String(err?.message || err);
if (/403|forbidden/i.test(message)) {
setStatus('User Directory requires the Azure DevOps Member Entitlement Management read permission (vso.memberentitlementmanagement) on the PAT.', 'error');
} else {
setStatus(isAzDoCancellation(err) ? 'The user directory operation was cancelled.' : `Error loading organization users: ${message}`, isAzDoCancellation(err) ? 'info' : 'error');
}
}
}
function renderUserDirectoryTableBatch(append = false) {
const tbody = document.getElementById('userDirectoryTableBody');
const container = document.getElementById('seeMoreUserDirectoryContainer');
const remainingEl = document.getElementById('userDirectoryRemainingCount');
const project = getUserDirectoryProject();
if (!tbody) return;
const thead = document.getElementById('userDirectoryTableHead');
if (thead) {
setSafeInnerHTML(thead, project ? `
<tr class="bg-slate-50 border-b border-slate-200 text-slate-600 text-xs uppercase font-semibold">
<th class="p-4">User Name</th>
<th class="p-4">Email Address</th>
<th class="p-4">Organization Access</th>
<th class="p-4">Project Role</th>
<th class="p-4">Assignment</th>
<th class="p-4">Permission Source</th>
<th class="p-4">Date Added</th>
<th class="p-4">Last Access</th>
</tr>` : `
<tr class="bg-slate-50 border-b border-slate-200 text-slate-600 text-xs uppercase font-semibold">
<th class="p-4">User Name</th>
<th class="p-4">Email Address</th>
<th class="p-4">Organization Access</th>
<th class="p-4">Status</th>
<th class="p-4">Date Added</th>
<th class="p-4">Last Access</th>
<th class="p-4">Project Access</th>
</tr>`);
}
if (!append) setSafeInnerHTML(tbody, '');
if (!rawStore.userEntitlements.length) {
setSafeInnerHTML(tbody, `<tr><td colspan="${project ? 8 : 7}" class="p-4 text-center text-slate-400">No users found for the selected scope.</td></tr>`);
container?.classList.add('hidden');
return;
}
const next = rawStore.userEntitlements.slice(rawStore.userDirectoryIndex, rawStore.userDirectoryIndex + 10);
const start = rawStore.userDirectoryIndex;
rawStore.userDirectoryIndex += next.length;
let html = '';
if (project) {
html = next.map((u, idx) => {
const p = u.projects.find(x => x.projectName.toLowerCase() === project.toLowerCase()) || {};
const teams = p.teams?.length ? p.teams.join(', ') : '—';
const inherited = p.inherited === 'inherited' ? 'Inherited' : 'Direct / Effective';
return `<tr class="hover:bg-slate-50 transition cursor-pointer" data-detail-type="user-directory" data-detail-index="${start + idx}">
<td class="p-4 font-semibold text-slate-900">${escapeUserHtml(u.name)}</td>
<td class="p-4 text-xs text-slate-600">${escapeUserHtml(u.email)}</td>
<td class="p-4">${userAccessBadge(u.accessLevel, 'blue')}</td>
<td class="p-4">${userAccessBadge(p.group || 'Project access', 'purple')}<div class="mt-1 text-[11px] text-slate-500">${escapeUserHtml(teams)}</div></td>
<td class="p-4 text-xs text-slate-600">${escapeUserHtml(p.assignmentSource || '—')}</td>
<td class="p-4 text-xs text-slate-600">${escapeUserHtml(inherited)}</td>
<td class="p-4 text-xs text-slate-600">${formatUserDirectoryDate(u.dateCreated)}</td>
<td class="p-4 text-xs text-slate-600">${formatUserDirectoryDate(u.lastAccessedDate)}</td>
</tr>`;
}).join('');
} else {
html = next.map((u, idx) => {
const projects = u.projects.length
? u.projects.map(p => `<div class="mb-1"><span class="font-semibold text-slate-700">${escapeUserHtml(p.projectName)}</span> — ${userAccessBadge(p.group, 'purple')} ${p.teams?.length ? `<span class="text-[11px] text-slate-500">(${escapeUserHtml(p.teams.join(', '))})</span>` : ''}</div>`).join('')
: '<span class="text-slate-400">No project access listed</span>';
const statusTone = String(u.status).toLowerCase() === 'active' ? 'green' : String(u.status).toLowerCase() === 'disabled' ? 'red' : 'amber';
return `<tr class="hover:bg-slate-50 transition cursor-pointer" data-detail-type="user-directory" data-detail-index="${start + idx}">
<td class="p-4 font-semibold text-slate-900">${escapeUserHtml(u.name)}</td>
<td class="p-4 text-xs text-slate-600">${escapeUserHtml(u.email)}</td>
<td class="p-4">${userAccessBadge(u.accessLevel, 'blue')}<div class="mt-1 text-[11px] text-slate-500">${escapeUserHtml(u.licensingSource)}</div></td>
<td class="p-4">${userAccessBadge(u.status, statusTone)}</td>
<td class="p-4 text-xs text-slate-600">${formatUserDirectoryDate(u.dateCreated)}</td>
<td class="p-4 text-xs text-slate-600">${formatUserDirectoryDate(u.lastAccessedDate)}</td>
<td class="p-4 min-w-[320px]">${projects}</td>
</tr>`;
}).join('');
}
insertSafeAdjacentHTML(tbody, 'beforeend', html);
const remaining = rawStore.userEntitlements.length - rawStore.userDirectoryIndex;
if (remaining > 0) {
container?.classList.remove('hidden');
if (remainingEl) remainingEl.textContent = remaining;
} else {
container?.classList.add('hidden');
}
}
function exportUserDirectoryToXLSX() {
const project = getUserDirectoryProject();
const rows = (rawStore.userEntitlements || []).map(u => ({
'User Name': u.name,
'Email Address': u.email,
'Organization Access Level': u.accessLevel,
'Organization Status': u.status,
'Date Added': u.dateCreated,
'Last Access Date': u.lastAccessedDate,
'Licensing Source': u.licensingSource,
'Project Access': u.projects.map(p => `${p.projectName} | ${p.group} | Teams: ${p.teams.join(', ') || '—'} | ${p.inherited}`).join(' ; ')
}));
exportToExcelFile({ Users: rows }, project ? `AzureDevOps_${project}_Users` : 'AzureDevOps_Organization_Users');
}
window.updateUserDirectoryScopeText = updateUserDirectoryScopeText;
