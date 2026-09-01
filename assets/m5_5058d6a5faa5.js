// Azure DevOps Graph endpoints are preview-versioned even when the rest of the app uses stable 7.1 APIs.
// Keep these versions local to this module so the global API version remains centralized for stable endpoints.
const AZDO_GRAPH_API_VERSION = '7.1-preview.1';
const AZDO_GRAPH_DESCRIPTOR_API_VERSION = '7.1';

function accessNormalize(value) {
return String(value ?? '').trim().toLowerCase();
}

function accessIdentityKey(identity = {}) {
return accessNormalize(identity.descriptor || identity.id || identity.email || identity.uniqueName || identity.displayName || identity.name);
}

async function resolveAccessUser(query, org, authHeader) {
const q = String(query || '').trim();
if (!q) return null;
const variants = typeof buildIdentitySearchVariants === 'function' ? buildIdentitySearchVariants(q) : [q];
const filters = [];
if (q.includes('@')) filters.push('MailAddress', 'AccountName');
else filters.push('DisplayName', 'AccountName', 'General');
const candidates = [];
for (const filter of filters) {
  for (const variant of variants.slice(0, 4)) {
    try {
      const url = `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/identities?searchFilter=${encodeURIComponent(filter)}&filterValue=${encodeURIComponent(variant)}&api-version=${API_VERSION}`;
      const data = await fetchAzDo(url, authHeader);
      for (const item of (data?.value || [])) candidates.push(item);
    } catch (e) {}
  }
}
const unique = [];
const seen = new Set();
for (const item of candidates) {
  const key = accessIdentityKey(item);
  if (!key || seen.has(key)) continue;
  seen.add(key);
  unique.push(item);
}
if (!unique.length) return null;
const exact = unique.find(item => {
  const values = [item.providerDisplayName, item.customDisplayName, item.displayName, item.properties?.Mail?.$value, item.properties?.Account?.$value, item.uniqueName, item.principalName].filter(Boolean).map(accessNormalize);
  return values.includes(accessNormalize(q));
});
const item = exact || unique[0];
const email = item.properties?.Mail?.$value || item.properties?.Account?.$value || item.uniqueName || item.mailAddress || item.principalName || 'N/A';
const name = item.providerDisplayName || item.customDisplayName || item.displayName || item.name || q;
const descriptor = item.descriptor || item.subjectDescriptor || item.subjectDescriptorString || null;
return descriptor ? { descriptor, name, email, raw: item } : null;
}

async function resolveAccessDescriptor(descriptor, org, authHeader, cache) {
if (!descriptor) return null;
if (cache.has(descriptor)) return cache.get(descriptor);
let result = null;
try {
  const userUrl = `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/graph/users/${encodeURIComponent(descriptor)}?api-version=${AZDO_GRAPH_API_VERSION}`;
  const data = await fetchAzDo(userUrl, authHeader);
  if (data) result = {
    descriptor,
    name: data.displayName || data.principalName || 'Unknown',
    email: data.mailAddress || data.principalName || 'N/A'
  };
} catch (e) {}
if (!result) {
  try {
    const idUrl = `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/identities?subjectDescriptors=${encodeURIComponent(descriptor)}&api-version=${API_VERSION}`;
    const data = await fetchAzDo(idUrl, authHeader);
    const item = data?.value?.[0];
    if (item) result = {
      descriptor,
      name: item.providerDisplayName || item.customDisplayName || item.displayName || 'Unknown',
      email: item.properties?.Mail?.$value || item.properties?.Account?.$value || item.uniqueName || item.principalName || 'N/A'
    };
  } catch (e) {}
}
cache.set(descriptor, result);
return result;
}

function accessRowKey(row) {
return `${accessNormalize(row.team)}|${accessNormalize(row.type)}|${accessNormalize(row.email)}|${accessNormalize(row.name)}`;
}

function addAccessRow(rows, row, counts) {
const key = accessRowKey(row);
if (!rows._seen) rows._seen = new Set();
if (rows._seen.has(key)) return;
rows._seen.add(key);
rows.push(row);
counts[row.team] = (counts[row.team] || 0) + 1;
}

async function fetchUserAccessData() {
const org = extractOrgName(document.getElementById('targetOrg').value);
const project = document.getElementById('projectSelect').value;
const pat = document.getElementById('targetPat').value.trim();
const userQuery = document.getElementById('targetAccessUserQuery').value.trim();
const authHeader = createBasicAuthHeader(pat);
showSection('access');
startFetching(userQuery ? `Resolving project access for "${userQuery}"...` : `Fetching all project teams, security groups, and members...`);
let accessRows = [];
accessRows._seen = new Set();
const groupMemberCounts = {};
const identityCache = new Map();
try {
  let projectInfo = null;
  let projectDescriptor = '';
  const projInfoUrl = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects/${encodeURIComponent(project)}?api-version=${API_VERSION}`;
  projectInfo = await fetchAzDo(projInfoUrl, authHeader);
  if (projectInfo?.id) {
    try {
      const descUrl = `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/graph/descriptors/${encodeURIComponent(projectInfo.id)}?api-version=${AZDO_GRAPH_DESCRIPTOR_API_VERSION}`;
      const descData = await fetchAzDo(descUrl, authHeader);
      projectDescriptor = descData?.value || '';
    } catch (e) {}
  }

  const scopeParam = projectDescriptor ? `&scopeDescriptor=${encodeURIComponent(projectDescriptor)}` : '';
  const groupsUrl = `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/graph/groups?api-version=${AZDO_GRAPH_API_VERSION}${scopeParam}`;
  const teamsUrl = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects/${encodeURIComponent(project)}/teams?$expandIdentity=true&$top=500&api-version=${API_VERSION}`;
  const [groupsData, teamsData] = await Promise.all([
    fetchAzDoPaged(groupsUrl, authHeader, { pageSize: 500 }),
    fetchAzDoPaged(teamsUrl, authHeader, { pageSize: 500 })
  ]);
  const graphGroups = (groupsData?.value || []).filter(g => g.subjectKind === 'group');
  const teams = teamsData?.value || [];
  const teamByName = new Map(teams.map(t => [accessNormalize(t.name), t]));
  const groupByDescriptor = new Map(graphGroups.filter(g => g.descriptor).map(g => [g.descriptor, g]));
  const projectGroupRows = graphGroups.map(g => ({
    entity: g,
    name: (g.displayName || g.principalName || 'Unnamed Group').replace(`[${project}]\\`, ''),
    type: 'Group'
  }));

  if (userQuery) {
    const targetUser = await resolveAccessUser(userQuery, org, authHeader);
    if (!targetUser) throw new Error(`Azure DevOps user not found for "${userQuery}".`);

    // 1) Security-group membership: query the user's graph memberships upward.
    // This is the authoritative direction for "which groups is this user a member of?".
    try {
      const membershipsUrl = `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/graph/Memberships/${encodeURIComponent(targetUser.descriptor)}?direction=Up&depth=1&api-version=${AZDO_GRAPH_API_VERSION}`;
      const memberships = await fetchAzDoPaged(membershipsUrl, authHeader, { pageSize: 500 });
      for (const membership of (memberships?.value || [])) {
        let group = groupByDescriptor.get(membership.containerDescriptor);
        // Resolve the container directly when the scoped group list did not return it.
        // This is important for project permission groups such as Deployment Team.
        if (!group) {
          try {
            const groupUrl = `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/graph/groups/${encodeURIComponent(membership.containerDescriptor)}?api-version=${AZDO_GRAPH_API_VERSION}`;
            group = await fetchAzDo(groupUrl, authHeader);
          } catch (e) {}
        }
        if (!group || group.subjectKind !== 'group') continue;
        const isProjectGroup = !group.scopeType || group.scopeType === 'TeamProject' ||
          accessNormalize(group.scopeName) === accessNormalize(project) ||
          accessNormalize(group.principalName).startsWith(`[${accessNormalize(project)}]\\`);
        if (!isProjectGroup) continue;
        const groupName = (group.displayName || group.principalName || 'Unnamed Group').replace(`[${project}]\\`, '');
        addAccessRow(accessRows, { team: groupName, type: 'Group', name: targetUser.name, email: targetUser.email }, groupMemberCounts);
      }
    } catch (e) {
      console.warn('User group membership lookup failed:', e);
    }

    // 2) Team membership: check the selected project teams independently.
    // Teams are not interchangeable with Graph security groups.
    await Promise.all(teams.map(async t => {
      try {
        const mUrl = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects/${encodeURIComponent(project)}/teams/${encodeURIComponent(t.id)}/members?$top=500&api-version=${API_VERSION}`;
        const mData = await fetchAzDoPaged(mUrl, authHeader, { pageSize: 500 });
        const members = mData?.value || [];
        const found = members.some(m => {
          const i = m.identity || m;
          const email = i.uniqueName || i.mailAddress || i.email || '';
          const name = i.displayName || i.providerDisplayName || '';
          return accessNormalize(email) === accessNormalize(targetUser.email) || accessNormalize(name) === accessNormalize(targetUser.name) || accessNormalize(i.id) === accessNormalize(targetUser.raw?.id);
        });
        if (found) addAccessRow(accessRows, { team: t.name, type: 'Team', name: targetUser.name, email: targetUser.email }, groupMemberCounts);
      } catch (e) {
        console.warn(`Team membership lookup failed for ${t.name}:`, e);
      }
    }));

    // A user-specific chart should show exactly where the selected user belongs.
    const membershipCount = accessRows.length;
    document.getElementById('kpi-1-label').textContent = 'Active Scope';
    document.getElementById('kpi-1-val').textContent = targetUser.name;
    document.getElementById('kpi-1-val').title = targetUser.email;
    document.getElementById('kpi-2-label').textContent = 'Teams';
    document.getElementById('kpi-2-val').textContent = accessRows.filter(r => r.type === 'Team').length;
    document.getElementById('kpi-3-label').textContent = 'Groups';
    document.getElementById('kpi-3-val').textContent = accessRows.filter(r => r.type === 'Group').length;
    document.getElementById('kpi-4-label').textContent = 'Total Memberships';
    document.getElementById('kpi-4-val').textContent = membershipCount;
    document.getElementById('kpi-5-label').textContent = 'Status';
    document.getElementById('kpi-5-val').textContent = membershipCount ? 'Active' : 'No Access Found';
    renderAccessTableBatch(false);
    renderChart(Object.keys(groupMemberCounts), Object.values(groupMemberCounts), 'Selected User Memberships');
    stopFetching();
    setStatus(membershipCount ? `Found ${membershipCount} active project team/group memberships for "${targetUser.name}".` : `No project team/group membership found for "${targetUser.name}".`, membershipCount ? 'success' : 'info');
    return;
  }

  // Project-level view: enumerate every project team and project-scoped security group.
  graphGroups.forEach(g => {
    const name = (g.displayName || g.principalName || 'Unnamed Group').replace(`[${project}]\\`, '');
    groupMemberCounts[name] = 0;
  });
  teams.forEach(t => { if (groupMemberCounts[t.name] === undefined) groupMemberCounts[t.name] = 0; });

  await Promise.all(graphGroups.map(async g => {
    const groupName = (g.displayName || g.principalName || 'Unnamed Group').replace(`[${project}]\\`, '');
    try {
      const memUrl = `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/graph/Memberships/${encodeURIComponent(g.descriptor)}?direction=Down&api-version=${AZDO_GRAPH_API_VERSION}`;
      const memData = await fetchAzDoPaged(memUrl, authHeader, { pageSize: 500 });
      for (const m of (memData?.value || [])) {
        const identity = await resolveAccessDescriptor(m.memberDescriptor, org, authHeader, identityCache);
        if (!identity) continue;
        addAccessRow(accessRows, { team: groupName, type: 'Group', name: identity.name, email: identity.email }, groupMemberCounts);
      }
    } catch (e) { console.warn(`Group membership lookup failed for ${groupName}:`, e); }
  }));

  await Promise.all(teams.map(async t => {
    try {
      const mUrl = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects/${encodeURIComponent(project)}/teams/${encodeURIComponent(t.id)}/members?$top=500&api-version=${API_VERSION}`;
      const mData = await fetchAzDoPaged(mUrl, authHeader, { pageSize: 500 });
      for (const m of (mData?.value || [])) {
        const i = m.identity || m;
        addAccessRow(accessRows, {
          team: t.name,
          type: 'Team',
          name: i.displayName || i.providerDisplayName || 'Unknown',
          email: i.uniqueName || i.mailAddress || i.email || 'N/A'
        }, groupMemberCounts);
      }
    } catch (e) { console.warn(`Team membership lookup failed for ${t.name}:`, e); }
  }));

  const totalUniqueMembers = new Set(accessRows.map(r => accessNormalize(r.email || r.name)).filter(Boolean)).size;
  document.getElementById('kpi-1-label').textContent = 'Active Scope';
  document.getElementById('kpi-1-val').textContent = project;
  document.getElementById('kpi-1-val').title = project;
  document.getElementById('kpi-2-label').textContent = 'Teams';
  document.getElementById('kpi-2-val').textContent = teams.length;
  document.getElementById('kpi-3-label').textContent = 'Groups';
  document.getElementById('kpi-3-val').textContent = graphGroups.length;
  document.getElementById('kpi-4-label').textContent = 'Total Members';
  document.getElementById('kpi-4-val').textContent = totalUniqueMembers;
  document.getElementById('kpi-5-label').textContent = 'Status';
  document.getElementById('kpi-5-val').textContent = 'Active';
  renderAccessTableBatch(false);
  renderChart(Object.keys(groupMemberCounts), Object.values(groupMemberCounts), 'Members by Project Group / Team');
  stopFetching();
  setStatus(`Loaded ${teams.length} teams, ${graphGroups.length} project groups, and ${totalUniqueMembers} unique members for project "${project}".`, 'success');
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
setSafeInnerHTML(tbody, `<tr><td colspan="4" class="p-4 text-center text-slate-400">No project team or security-group memberships found.</td></tr>`);
container.classList.add('hidden');
return;
}
const nextBatch = rawStore.access.slice(rawStore.accessIndex, rawStore.accessIndex + PAGE_SIZE);
rawStore.accessIndex += nextBatch.length;
const batchStartIndex = rawStore.accessIndex - nextBatch.length;
const html = nextBatch.map((a, rowIndex) => `
<tr class="hover:bg-slate-50 transition" data-detail-type="access" data-detail-index="${batchStartIndex + rowIndex}">
<td class="p-4 font-semibold text-slate-900">${a.team}</td>
<td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold ${a.type === 'Group' ? 'bg-purple-50 text-purple-700 border border-purple-200' : 'bg-blue-50 text-blue-700 border border-blue-200'}">${a.type}</span></td>
<td class="p-4 font-medium">${a.name}</td>
<td class="p-4 text-xs font-mono text-slate-600">${a.email}</td>
</tr>
`).join('');
insertSafeAdjacentHTML(tbody, 'beforeend', html);
const remaining = rawStore.access.length - rawStore.accessIndex;
if (remaining > 0) { container.classList.remove('hidden'); remainingEl.textContent = remaining; }
else container.classList.add('hidden');
}
