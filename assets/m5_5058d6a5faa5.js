async function fetchUserAccessData() {
const org = extractOrgName(document.getElementById('targetOrg').value);
const project = document.getElementById('projectSelect').value;
const pat = document.getElementById('targetPat').value.trim();
const userQuery = document.getElementById('targetAccessUserQuery').value.trim();
const authHeader = createBasicAuthHeader(pat);
showSection('access');
startFetching(userQuery ? `Resolving effective security access for "${userQuery}"...` : `Fetching all project security groups, teams, and members...`);
let accessRows = [];
let groupMemberCounts = {};
const resolvedDescriptors = new Map();
const resolvedGroupDescriptors = new Map();

function identityFromIdentityApi(identity) {
if (!identity) return null;
return {
  id: identity.id || '',
  descriptor: identity.subjectDescriptor || identity.descriptor || '',
  name: identity.providerDisplayName || identity.customDisplayName || identity.displayName || 'Unknown',
  email: identity.properties?.Mail?.$value || identity.properties?.Account?.$value || identity.mailAddress || identity.uniqueName || identity.principalName || 'N/A',
  principalName: identity.properties?.Account?.$value || identity.uniqueName || identity.principalName || '',
  displayName: identity.providerDisplayName || identity.customDisplayName || identity.displayName || 'Unknown'
};
}

async function resolveSubjectDescriptor(descriptor) {
if (!descriptor) return null;
if (resolvedDescriptors.has(descriptor)) return resolvedDescriptors.get(descriptor);
try {
const userUrl = `https://vssps.dev.azure.com/${org}/_apis/graph/users/${encodeURIComponent(descriptor)}?api-version=${API_VERSION}`;
const res = await fetchAzDo(userUrl, authHeader);
if (res) {
const data = {
  descriptor: res.descriptor || descriptor,
  name: res.displayName || 'Unknown',
  email: res.mailAddress || res.principalName || 'N/A',
  principalName: res.principalName || '',
  displayName: res.displayName || 'Unknown'
};
resolvedDescriptors.set(descriptor, data);
return data;
}
} catch (e) {}
try {
const idUrl = `https://vssps.dev.azure.com/${org}/_apis/identities?subjectDescriptors=${encodeURIComponent(descriptor)}&api-version=7.1`;
const idRes = await fetchAzDo(idUrl, authHeader);
const data = identityFromIdentityApi(idRes?.value?.[0]);
if (data) {
resolvedDescriptors.set(descriptor, data);
return data;
}
} catch (err) {}
return null;
}

async function resolveGroupDescriptor(descriptor) {
if (!descriptor) return null;
if (resolvedGroupDescriptors.has(descriptor)) return resolvedGroupDescriptors.get(descriptor);
try {
const url = `https://vssps.dev.azure.com/${org}/_apis/graph/groups/${encodeURIComponent(descriptor)}?api-version=${API_VERSION}`;
const data = await fetchAzDo(url, authHeader);
if (data) {
const result = {
  descriptor: data.descriptor || descriptor,
  name: data.displayName || data.providerDisplayName || 'Unknown Group',
  subjectKind: data.subjectKind || 'group'
};
resolvedGroupDescriptors.set(descriptor, result);
return result;
}
} catch (e) {}
try {
const idUrl = `https://vssps.dev.azure.com/${org}/_apis/identities?subjectDescriptors=${encodeURIComponent(descriptor)}&api-version=7.1`;
const idRes = await fetchAzDo(idUrl, authHeader);
const data = identityFromIdentityApi(idRes?.value?.[0]);
if (data) {
const result = { descriptor, name: data.name, subjectKind: 'group' };
resolvedGroupDescriptors.set(descriptor, result);
return result;
}
} catch (e) {}
return null;
}

async function resolveTargetIdentity(query) {
if (!query) return null;
const filters = ['General', 'MailAddress', 'DisplayName', 'AccountName'];
for (const filter of filters) {
try {
const url = `https://vssps.dev.azure.com/${org}/_apis/identities?searchFilter=${encodeURIComponent(filter)}&filterValue=${encodeURIComponent(query)}&queryMembership=None&api-version=7.1`;
const res = await fetchAzDo(url, authHeader);
const candidates = (res?.value || []).map(identityFromIdentityApi).filter(Boolean);
const exact = candidates.find(identity => identityMatchesQuery(query, identity));
if (exact) return exact;
if (candidates.length === 1) return candidates[0];
} catch (e) {}
}
// Final fallback: project-scoped Graph users. This is paged and restricted to users.
try {
const projectInfoUrl = `https://dev.azure.com/${org}/_apis/projects/${encodeURIComponent(project)}?api-version=${API_VERSION}`;
const projectInfo = await fetchAzDo(projectInfoUrl, authHeader);
let scopeDescriptor = '';
if (projectInfo?.id) {
const descUrl = `https://vssps.dev.azure.com/${org}/_apis/graph/descriptors/${encodeURIComponent(projectInfo.id)}?api-version=${API_VERSION}`;
const descData = await fetchAzDo(descUrl, authHeader);
scopeDescriptor = descData?.value || '';
}
const url = `https://vssps.dev.azure.com/${org}/_apis/graph/users?subjectTypes=aad,msa,imp&${scopeDescriptor ? `scopeDescriptor=${encodeURIComponent(scopeDescriptor)}&` : ''}api-version=${API_VERSION}`;
const res = await fetchAzDoPaged(url, authHeader, { pageSize: 500 });
const candidates = (res?.value || []).map(u => ({
  id: u.originId || '', descriptor: u.descriptor || '', name: u.displayName || 'Unknown', displayName: u.displayName || 'Unknown', email: u.mailAddress || u.principalName || 'N/A', principalName: u.principalName || ''
}));
return candidates.find(identity => identityMatchesQuery(query, identity)) || null;
} catch (e) {}
return null;
}

function addAccessRow(team, type, identity, extra = {}) {
if (!identity) return;
accessRows.push({
  team,
  type,
  name: identity.name || identity.displayName || 'Unknown',
  email: identity.email || identity.principalName || 'N/A',
  descriptor: identity.descriptor || '',
  inherited: extra.inherited !== false,
  source: extra.source || type,
  scope: extra.scope || 'Project'
});
groupMemberCounts[team] = (groupMemberCounts[team] || 0) + 1;
}

try {
let projectDescriptor = '';
try {
const projInfoUrl = `https://dev.azure.com/${org}/_apis/projects/${encodeURIComponent(project)}?api-version=${API_VERSION}`;
const projInfo = await fetchAzDo(projInfoUrl, authHeader);
if (projInfo?.id) {
const descUrl = `https://vssps.dev.azure.com/${org}/_apis/graph/descriptors/${encodeURIComponent(projInfo.id)}?api-version=${API_VERSION}`;
const descData = await fetchAzDo(descUrl, authHeader);
projectDescriptor = descData?.value || '';
}
} catch (e) { console.warn('Could not resolve project descriptor:', e); }

let graphGroups = [];
try {
const scopeParam = projectDescriptor ? `&scopeDescriptor=${encodeURIComponent(projectDescriptor)}` : '';
const gUrl = `https://vssps.dev.azure.com/${org}/_apis/graph/groups?api-version=${API_VERSION}${scopeParam}`;
const gData = await fetchAzDoPaged(gUrl, authHeader, { pageSize: 500 });
graphGroups = gData?.value || [];
} catch (e) { console.warn('Graph group listing fallback:', e); }

let teams = [];
try {
const teamsUrl = `https://dev.azure.com/${org}/_apis/projects/${encodeURIComponent(project)}/teams?$expandIdentity=true&$top=500&api-version=${API_VERSION}`;
const tData = await fetchAzDoPaged(teamsUrl, authHeader, { pageSize: 500 });
teams = tData?.value || [];
} catch (e) { console.warn('Teams query fallback:', e); }

graphGroups.forEach(g => {
const name = (g.displayName || '').replace(`[${project}]\\`, '');
groupMemberCounts[name] = 0;
});
teams.forEach(t => { if (groupMemberCounts[t.name] === undefined) groupMemberCounts[t.name] = 0; });

if (userQuery) {
const target = await resolveTargetIdentity(userQuery);
if (!target?.descriptor) {
stopFetching();
rawStore.access = [];
rawStore.accessIndex = 0;
setStatus(`No Azure DevOps identity matched "${userQuery}". Try the exact email address or display name.`, 'warning');
renderAccessTableBatch(false);
return;
}

// Security-group access: ask Azure DevOps directly which groups contain this user.
try {
const membershipUrl = `https://vssps.dev.azure.com/${org}/_apis/graph/Memberships/${encodeURIComponent(target.descriptor)}?direction=Up&depth=1&api-version=${API_VERSION}`;
const membershipData = await fetchAzDoPaged(membershipUrl, authHeader, { pageSize: 500 });
const memberships = membershipData?.value || [];
await Promise.all(memberships.map(async membership => {
const containerDescriptor = membership?.containerDescriptor;
if (!containerDescriptor) return;
const group = graphGroups.find(g => String(g.descriptor || '') === String(containerDescriptor));
const resolvedGroup = group || await resolveGroupDescriptor(containerDescriptor);
if (!resolvedGroup) return;
const groupName = (resolvedGroup.displayName || resolvedGroup.name || 'Security Group').replace(`[${project}]\\`, '');
addAccessRow(groupName, 'Security Group', target, { inherited: true, source: 'Graph membership', scope: group ? 'Project' : 'Organization / inherited' });
}));
} catch (err) {
console.warn('Direct user membership query failed:', err);
}

// Team access: Azure DevOps project-team membership is a separate relationship from Graph security-group membership.
await Promise.all(teams.map(async t => {
try {
const mUrl = `https://dev.azure.com/${org}/_apis/projects/${encodeURIComponent(project)}/teams/${encodeURIComponent(t.id)}/members?$top=500&api-version=${API_VERSION}`;
const mData = await fetchAzDoPaged(mUrl, authHeader, { pageSize: 500 });
const members = mData?.value || [];
const matched = members.find(m => {
const identity = m.identity || m;
const descriptor = identity.descriptor || identity.subjectDescriptor || '';
if (descriptor && target.descriptor && descriptor === target.descriptor) return true;
return identityMatchesQuery(userQuery, {
  displayName: identity.displayName,
  name: identity.displayName,
  mailAddress: identity.mailAddress,
  email: identity.mailAddress,
  uniqueName: identity.uniqueName,
  principalName: identity.principalName,
  descriptor
});
});
if (matched) {
const identity = matched.identity || matched;
addAccessRow(t.name, 'Team', {
  descriptor: identity.descriptor || identity.subjectDescriptor || target.descriptor,
  name: identity.displayName || target.name,
  displayName: identity.displayName || target.name,
  email: identity.uniqueName || identity.mailAddress || target.email,
  principalName: identity.principalName || target.principalName
}, { inherited: false, source: 'Project team membership', scope: 'Project' });
}
} catch (err) { console.warn(`Could not read team membership for ${t.name}:`, err); }
}));

// If the user is directly present in a project group but Graph membership traversal did not expose it,
// fall back to scanning only project groups and comparing descriptors. This keeps the result accurate
// without returning unrelated users.
if (!accessRows.length) {
await Promise.all(graphGroups.map(async g => {
try {
const memUrl = `https://vssps.dev.azure.com/${org}/_apis/graph/Memberships/${encodeURIComponent(g.descriptor)}?direction=Down&depth=1&api-version=${API_VERSION}`;
const memData = await fetchAzDoPaged(memUrl, authHeader, { pageSize: 500 });
const members = memData?.value || [];
const found = members.some(m => String(m?.memberDescriptor || '') === String(target.descriptor || ''));
if (found) {
const groupName = (g.displayName || '').replace(`[${project}]\\`, '');
addAccessRow(groupName, 'Security Group', target, { inherited: true, source: 'Project group membership', scope: 'Project' });
}
} catch (err) {}
}));
}

} else {
// All-user mode retains the original complete group/team membership inventory.
await Promise.all(graphGroups.map(async g => {
const groupName = (g.displayName || '').replace(`[${project}]\\`, '');
try {
const memUrl = `https://vssps.dev.azure.com/${org}/_apis/graph/Memberships/${encodeURIComponent(g.descriptor)}?direction=Down&depth=1&api-version=${API_VERSION}`;
const memData = await fetchAzDoPaged(memUrl, authHeader, { pageSize: 500 });
const members = memData?.value || [];
await Promise.all(members.map(async m => {
const identity = await resolveSubjectDescriptor(m.memberDescriptor);
if (identity) addAccessRow(groupName, 'Security Group', identity, { inherited: true, source: 'Graph membership', scope: 'Project' });
}));
} catch (err) { console.warn(`Could not read group ${groupName}:`, err); }
}));
await Promise.all(teams.map(async t => {
try {
const mUrl = `https://dev.azure.com/${org}/_apis/projects/${encodeURIComponent(project)}/teams/${encodeURIComponent(t.id)}/members?$top=500&api-version=${API_VERSION}`;
const mData = await fetchAzDoPaged(mUrl, authHeader, { pageSize: 500 });
const members = mData?.value || [];
members.forEach(m => {
const identity = m.identity || m;
addAccessRow(t.name, 'Team', {
  descriptor: identity.descriptor || identity.subjectDescriptor || '',
  name: identity.displayName || 'Unknown',
  displayName: identity.displayName || 'Unknown',
  email: identity.uniqueName || identity.mailAddress || 'N/A',
  principalName: identity.principalName || ''
}, { inherited: false, source: 'Project team membership', scope: 'Project' });
});
} catch (err) { console.warn(`Could not read team ${t.name}:`, err); }
}));
}

const seen = new Set();
accessRows = accessRows.filter(r => {
const key = `${r.team}|${r.type}|${r.name}|${r.email}`.toLowerCase();
if (seen.has(key)) return false;
seen.add(key);
return true;
});
rawStore.access = accessRows;
rawStore.accessIndex = 0;
document.getElementById('kpi-1-label').textContent = 'Active Scope';
document.getElementById('kpi-1-val').textContent = userQuery ? userQuery : project;
document.getElementById('kpi-1-val').className = 'text-2xl font-extrabold text-slate-800 mt-1 truncate';
document.getElementById('kpi-2-label').textContent = 'Groups & Teams';
document.getElementById('kpi-2-val').textContent = Object.keys(groupMemberCounts).filter(k => groupMemberCounts[k] > 0).length;
document.getElementById('kpi-3-label').textContent = userQuery ? 'Effective Memberships' : 'Total Memberships';
document.getElementById('kpi-3-val').textContent = accessRows.length;
document.getElementById('kpi-4-label').textContent = 'Mode';
document.getElementById('kpi-4-val').textContent = userQuery ? 'User Access' : 'Security Access';
document.getElementById('kpi-5-label').textContent = 'Status';
document.getElementById('kpi-5-val').textContent = accessRows.length ? 'Ready' : 'No Access Found';
renderAccessTableBatch(false);
const chartLabels = Object.keys(groupMemberCounts).filter(k => groupMemberCounts[k] > 0);
renderChart(chartLabels, chartLabels.map(k => groupMemberCounts[k]), userQuery ? 'Groups / Teams for Selected User' : 'Members per Group / Team');
stopFetching();
setStatus(userQuery ? `Found ${accessRows.length} effective group/team assignments for "${userQuery}".` : `Loaded ${accessRows.length} member assignments across all ${chartLabels.length} groups & teams.`, accessRows.length ? 'success' : 'warning');
} catch (err) {
stopFetching();
setStatus(isAzDoCancellation(err) ? 'The security access operation was cancelled.' : `Error querying security access: ${err.message}`, isAzDoCancellation(err) ? 'info' : 'error');
}
}
function renderAccessTableBatch(append = false) {
const tbody = document.getElementById('accessTableBody');
const container = document.getElementById('seeMoreAccessContainer');
const remainingEl = document.getElementById('accessRemainingCount');
if (!append) setSafeInnerHTML(tbody, '');
if (rawStore.access.length === 0) {
setSafeInnerHTML(tbody, `<tr><td colspan="4" class="p-4 text-center text-slate-400">No security groups or team memberships found for the selected scope.</td></tr>`);
container.classList.add('hidden');
return;
}
const nextBatch = rawStore.access.slice(rawStore.accessIndex, rawStore.accessIndex + PAGE_SIZE);
rawStore.accessIndex += nextBatch.length;
const batchStartIndex = rawStore.accessIndex - nextBatch.length;
const html = nextBatch.map((a, rowIndex) => `
<tr class="hover:bg-slate-50 transition" data-detail-type="access" data-detail-index="${batchStartIndex + rowIndex}">
<td class="p-4 font-semibold text-slate-900">${escapeHtml(a.team)}</td>
<td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold ${a.type === 'Security Group' ? 'bg-purple-50 text-purple-700 border border-purple-200' : 'bg-blue-50 text-blue-700 border border-blue-200'}">${escapeHtml(a.type)}</span></td>
<td class="p-4 font-medium">${escapeHtml(a.name)}</td>
<td class="p-4 text-xs font-mono text-slate-600">${escapeHtml(a.email)}</td>
</tr>
`).join('');
insertSafeAdjacentHTML(tbody, 'beforeend', html);
const remaining = rawStore.access.length - rawStore.accessIndex;
if (remaining > 0) {
container.classList.remove('hidden');
remainingEl.textContent = remaining;
} else {
container.classList.add('hidden');
}
}
