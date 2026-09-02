
/*
 * User Access & Permissions
 *
 * Data model:
 *   Project mode  -> all project teams + project-scoped security groups.
 *   User mode     -> the selected user's actual team memberships + Graph group memberships.
 *
 * Azure DevOps Graph APIs are preview APIs in REST 7.1 and must use 7.1-preview.1.
 * Core Teams and Identities APIs remain on stable 7.1.
 */

const ACCESS_GRAPH_API_VERSION =
  (typeof window !== 'undefined' && window.AZDO_GRAPH_API_VERSION) ||
  '7.1-preview.1';

function accessGraphUrl(path, query = '') {
  return `https://vssps.dev.azure.com/${encodeURIComponent(extractOrgName(document.getElementById('targetOrg').value))}/_apis/graph/${path}?api-version=${ACCESS_GRAPH_API_VERSION}${query ? `&${query}` : ''}`;
}

function accessCoreUrl(org, path, query = '') {
  return `https://dev.azure.com/${encodeURIComponent(org)}/${path}${query ? `?${query}&api-version=${AZDO_API_VERSION}` : `?api-version=${AZDO_API_VERSION}`}`;
}

function accessIdentityEmail(identity = {}) {
  return identity.mailAddress ||
    identity.uniqueName ||
    identity.principalName ||
    identity.email ||
    identity.accountName ||
    'N/A';
}

function accessIdentityName(identity = {}) {
  return identity.displayName ||
    identity.providerDisplayName ||
    identity.customDisplayName ||
    identity.name ||
    'Unknown';
}

/*
 * Canonical identity model used by User Access.
 *
 * Important: id / originId / descriptor are authoritative Azure DevOps
 * identity identifiers. Email/name are presentation and controlled fallback
 * fields only. We intentionally do not use partial-name or email-local-part
 * matching here because that can associate the wrong user with access.
 */
function accessIdentityObject(identity = {}, descriptor = '') {
  const properties = identity.properties || {};
  return {
    id: identity.id || identity.identityId || '',
    originId: identity.originId || identity.origin || '',
    descriptor: descriptor || identity.descriptor || '',
    name: accessIdentityName(identity),
    email: accessIdentityEmail(identity),
    uniqueName: identity.uniqueName || properties.Account?.$value || '',
    principalName: identity.principalName || properties.Account?.$value || '',
    mailAddress: identity.mailAddress || properties.Mail?.$value || '',
    subjectKind: identity.subjectKind || 'user'
  };
}

function accessIdentityKey(identity = {}) {
  const normalize = value => String(value || '').trim().toLowerCase();
  return normalize(identity.id) ||
    normalize(identity.originId) ||
    normalize(identity.descriptor) ||
    normalize(identity.uniqueName) ||
    normalize(identity.principalName) ||
    normalize(identity.mailAddress) ||
    normalize(identity.email) ||
    '';
}

function accessIdentityExactFieldMatch(query, identity = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return { matched: false, confidence: 0, method: 'none' };

  const fields = [
    ['id', identity.id],
    ['descriptor', identity.descriptor],
    ['originId', identity.originId],
    ['mailAddress', identity.mailAddress],
    ['email', identity.email],
    ['uniqueName', identity.uniqueName],
    ['principalName', identity.principalName]
  ];

  for (const [method, value] of fields) {
    if (value && String(value).trim().toLowerCase() === q) {
      return { matched: true, confidence: 100, method };
    }
  }

  if (identity.name && String(identity.name).trim().toLowerCase() === q) {
    return { matched: true, confidence: 90, method: 'displayName' };
  }

  return { matched: false, confidence: 0, method: 'none' };
}

async function resolveAccessIdentityByDescriptor(org, descriptor, authHeader, cache) {
  if (!descriptor) return null;
  if (cache.has(descriptor)) return cache.get(descriptor);

  const promise = (async () => {
    // Graph users are preview API. Descriptor lookup is authoritative.
    try {
      const userUrl =
        `https://vssps.dev.azure.com/${encodeURIComponent(org)}` +
        `/_apis/graph/users/${encodeURIComponent(descriptor)}` +
        `?api-version=${ACCESS_GRAPH_API_VERSION}`;
      const user = await fetchAzDo(userUrl, authHeader);
      if (user) return accessIdentityObject(user, descriptor);
    } catch (_) {}

    // A member descriptor can also be another group.
    try {
      const groupUrl =
        `https://vssps.dev.azure.com/${encodeURIComponent(org)}` +
        `/_apis/graph/groups/${encodeURIComponent(descriptor)}` +
        `?api-version=${ACCESS_GRAPH_API_VERSION}`;
      const group = await fetchAzDo(groupUrl, authHeader);
      if (group) {
        return {
          ...accessIdentityObject(group, descriptor),
          name: accessIdentityName(group),
          email: group.mailAddress || group.principalName || 'N/A',
          subjectKind: 'group'
        };
      }
    } catch (_) {}

    // Stable Identities API is a fallback for legacy/AAD-backed identities.
    try {
      const idUrl =
        `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/identities` +
        `?subjectDescriptors=${encodeURIComponent(descriptor)}` +
        `&api-version=${AZDO_STABLE_API_VERSION}`;
      const idRes = await fetchAzDo(idUrl, authHeader);
      const val = idRes?.value?.[0];
      if (val) {
        return accessIdentityObject({
          ...val,
          displayName: val.providerDisplayName || val.customDisplayName || val.displayName,
          mailAddress:
            val.properties?.Mail?.$value ||
            val.properties?.Account?.$value ||
            val.properties?.['Mail Address']?.$value,
          uniqueName: val.properties?.Account?.$value,
          principalName: val.properties?.Account?.$value
        }, descriptor);
      }
    } catch (_) {}

    return null;
  })();

  cache.set(descriptor, promise);
  return promise;
}

async function resolveRequestedAccessUser(org, query, authHeader) {
  const rawQuery = String(query || '').trim();
  if (!rawQuery) return null;

  const variants = [rawQuery];
  const normalized = rawQuery.toLowerCase();
  if (normalized !== rawQuery) variants.push(normalized);

  const candidates = [];
  const seen = new Set();

  for (const variant of variants) {
    try {
      const url =
        `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/identities` +
        `?searchFilter=General` +
        `&filterValue=${encodeURIComponent(variant)}` +
        `&queryMembership=None` +
        `&api-version=${AZDO_STABLE_API_VERSION}`;
      const res = await fetchAzDo(url, authHeader);

      for (const item of (res?.value || [])) {
        const identity = accessIdentityObject({
          ...item,
          displayName: item.providerDisplayName || item.customDisplayName || item.displayName,
          mailAddress:
            item.properties?.Mail?.$value ||
            item.properties?.['Mail Address']?.$value ||
            item.properties?.Account?.$value,
          uniqueName: item.properties?.Account?.$value,
          principalName: item.properties?.Account?.$value
        }, item.descriptor || '');
        const key = accessIdentityKey(identity);
        if (key && !seen.has(key)) {
          seen.add(key);
          candidates.push(identity);
        }
      }
    } catch (_) {}
  }

  if (!candidates.length) return null;

  const scored = candidates
    .map(identity => ({ identity, match: accessIdentityExactFieldMatch(rawQuery, identity) }))
    .filter(item => item.match.matched)
    .sort((a, b) => b.match.confidence - a.match.confidence);

  if (!scored.length) return null;

  // Exact identifier/email wins. An exact display name is accepted only when
  // it uniquely identifies one candidate; never choose an arbitrary result.
  const top = scored[0];
  const sameConfidence = scored.filter(x => x.match.confidence === top.match.confidence);
  if (top.match.confidence === 90 && sameConfidence.length !== 1) return null;

  const chosen = top.identity;
  let resolved = chosen;

  if (chosen.descriptor) {
    try {
      const graphUser = await resolveAccessIdentityByDescriptor(
        org,
        chosen.descriptor,
        authHeader,
        new Map()
      );
      if (graphUser && graphUser.subjectKind !== 'group') {
        resolved = {
          ...chosen,
          ...graphUser,
          id: chosen.id || graphUser.id || '',
          originId: chosen.originId || graphUser.originId || '',
          descriptor: chosen.descriptor || graphUser.descriptor || ''
        };
      }
    } catch (_) {}
  }

  return {
    ...resolved,
    confidence: top.match.confidence,
    matchMethod: top.match.method
  };
}

async function fetchProjectAccessContext(org, project, authHeader) {
  const projectInfoUrl =
    `https://dev.azure.com/${encodeURIComponent(org)}` +
    `/_apis/projects/${encodeURIComponent(project)}` +
    `?api-version=${AZDO_STABLE_API_VERSION}`;
  const projectInfo = await fetchAzDo(projectInfoUrl, authHeader);
  if (!projectInfo?.id) {
    throw new Error('Azure DevOps did not return the selected project ID.');
  }

  // Graph Descriptors is a Graph endpoint; use the Graph preview version.
  const descriptorUrl =
    `https://vssps.dev.azure.com/${encodeURIComponent(org)}` +
    `/_apis/graph/descriptors/${encodeURIComponent(projectInfo.id)}` +
    `?api-version=${ACCESS_GRAPH_API_VERSION}`;
  const descriptorData = await fetchAzDo(descriptorUrl, authHeader);

  const projectDescriptor = descriptorData?.value || '';
  if (!projectDescriptor) {
    throw new Error('Azure DevOps did not return a Graph descriptor for the selected project.');
  }

  // Graph Groups is project-scope aware and uses the Graph preview API.
  const groupsUrl =
    `https://vssps.dev.azure.com/${encodeURIComponent(org)}` +
    `/_apis/graph/groups` +
    `?scopeDescriptor=${encodeURIComponent(projectDescriptor)}` +
    `&api-version=${ACCESS_GRAPH_API_VERSION}`;

  const groupResult = await fetchAzDoPaged(groupsUrl, authHeader, {
    pageSize: 500,
    maxPages: AZDO_API_MAX_PAGES
  });

  // Core Teams is a stable 7.1 API.
  const teamsUrl =
    `https://dev.azure.com/${encodeURIComponent(org)}` +
    `/_apis/projects/${encodeURIComponent(project)}/teams` +
    `?$expandIdentity=true&$top=500` +
    `&api-version=${AZDO_STABLE_API_VERSION}`;

  const teamResult = await fetchAzDoPaged(teamsUrl, authHeader, {
    pageSize: 500,
    maxPages: AZDO_API_MAX_PAGES
  });

  return {
    projectInfo,
    projectDescriptor,
    groups: (groupResult?.value || []).filter(g =>
      g && g.subjectKind === 'group' && g.descriptor
    ),
    teams: (teamResult?.value || []).filter(t => t && t.id)
  };
}

async function getGroupDirectMembers(org, groupDescriptor, authHeader) {
  const url =
    `https://vssps.dev.azure.com/${encodeURIComponent(org)}` +
    `/_apis/graph/Memberships/${encodeURIComponent(groupDescriptor)}` +
    `?direction=Down&api-version=${ACCESS_GRAPH_API_VERSION}`;
  const result = await fetchAzDoPaged(url, authHeader, {
    pageSize: 500,
    maxPages: AZDO_API_MAX_PAGES
  });
  return result?.value || [];
}

async function expandGroupUsers(org, groupDescriptor, authHeader, descriptorCache, visited = new Set(), depth = 0) {
  if (!groupDescriptor || visited.has(groupDescriptor) || depth > 5) return [];
  visited.add(groupDescriptor);

  const members = await getGroupDirectMembers(org, groupDescriptor, authHeader);
  const users = [];

  for (const member of members) {
    const descriptor = member?.memberDescriptor;
    if (!descriptor) continue;

    const identity = await resolveAccessIdentityByDescriptor(
      org,
      descriptor,
      authHeader,
      descriptorCache
    );
    if (!identity) continue;

    if (identity.subjectKind === 'group') {
      const nestedUsers = await expandGroupUsers(
        org,
        descriptor,
        authHeader,
        descriptorCache,
        visited,
        depth + 1
      );
      users.push(...nestedUsers);
    } else {
      users.push(identity);
    }
  }

  return users;
}

function uniqueAccessUsers(users) {
  const map = new Map();
  for (const user of users || []) {
    const key = accessIdentityKey(user);
    if (!key) continue;
    if (!map.has(key)) map.set(key, user);
  }
  return [...map.values()];
}

async function fetchTeamMembers(org, project, teamId, authHeader) {
  const url =
    `https://dev.azure.com/${encodeURIComponent(org)}` +
    `/_apis/projects/${encodeURIComponent(project)}/teams/${encodeURIComponent(teamId)}/members` +
    `?$top=500&api-version=${AZDO_STABLE_API_VERSION}`;

  const result = await fetchAzDoPaged(url, authHeader, {
    pageSize: 500,
    maxPages: AZDO_API_MAX_PAGES
  });

  return (result?.value || []).map(m => {
    const identity = m?.identity || m || {};
    return accessIdentityObject(identity, identity.descriptor || '');
  });
}

function makeAccessRow(containerName, type, user) {
  return {
    team: containerName,
    type,
    name: user.name || 'Unknown',
    email: user.email || user.mailAddress || user.uniqueName || user.principalName || 'N/A',
    descriptor: user.descriptor || '',
    id: user.id || '',
    originId: user.originId || '',
    uniqueName: user.uniqueName || '',
    principalName: user.principalName || ''
  };
}

function sortAccessRows(rows) {
  return rows.sort((a, b) => {
    const groupCompare = String(a.team).localeCompare(String(b.team));
    if (groupCompare !== 0) return groupCompare;
    const typeCompare = String(a.type).localeCompare(String(b.type));
    if (typeCompare !== 0) return typeCompare;
    return String(a.name).localeCompare(String(b.name));
  });
}

async function fetchProjectLevelAccess(context, org, project, authHeader) {
  const descriptorCache = new Map();
  const rows = [];
  const groupCounts = {};
  const groupUserSets = new Map();

  for (const group of context.groups) {
    const groupName = String(group.displayName || group.principalName || 'Unnamed Group')
      .replace(new RegExp(`^\\[${String(project).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\\\`), '');

    try {
      const users = uniqueAccessUsers(
        await expandGroupUsers(org, group.descriptor, authHeader, descriptorCache)
      );

      groupUserSets.set(group.descriptor, users);
      groupCounts[groupName] = users.length;

      users.forEach(user => {
        rows.push(makeAccessRow(groupName, 'Group', user));
      });
    } catch (error) {
      groupUserSets.set(group.descriptor, []);
      groupCounts[groupName] = 0;
      console.warn(`[User Access] Unable to read group "${groupName}":`, error);
    }
  }

  for (const team of context.teams) {
    try {
      const users = uniqueAccessUsers(
        await fetchTeamMembers(org, project, team.id, authHeader)
      );
      groupCounts[team.name] = users.length;
      users.forEach(user => {
        rows.push(makeAccessRow(team.name, 'Team', user));
      });
    } catch (error) {
      groupCounts[team.name] = 0;
      console.warn(`[User Access] Unable to read team "${team.name}":`, error);
    }
  }

  const uniqueMembers = uniqueAccessUsers(
    rows.map(r => ({
      name: r.name,
      email: r.email,
      descriptor: r.descriptor
    }))
  );

  return {
    rows: sortAccessRows(rows),
    groupCounts,
    totalTeams: context.teams.length,
    totalGroups: context.groups.length,
    totalMembers: uniqueMembers.length
  };
}

async function fetchSpecificUserAccess(context, org, project, userQuery, authHeader) {
  const query = String(userQuery || '').trim();
  if (!query) {
    return {
      user: null,
      rows: [],
      groupCounts: {},
      teamMemberships: [],
      groupMemberships: [],
      userActive: null
    };
  }

  // Resolve the requested person first using Azure DevOps identity records.
  // We then match project membership rows by authoritative identifiers.
  const resolvedUser = await resolveRequestedAccessUser(org, query, authHeader);

  if (!resolvedUser) {
    return {
      user: null,
      rows: [],
      groupCounts: {},
      teamMemberships: [],
      groupMemberships: [],
      userActive: null
    };
  }

  const projectResult = await fetchProjectLevelAccess(
    context,
    org,
    project,
    authHeader
  );

  const allRows = projectResult.rows || [];

  const normalize = value => String(value || '').trim().toLowerCase();
  const selectedIds = new Set(
    [resolvedUser.id, resolvedUser.originId, resolvedUser.descriptor]
      .map(normalize)
      .filter(Boolean)
  );
  const selectedEmails = new Set(
    [resolvedUser.mailAddress, resolvedUser.email, resolvedUser.uniqueName, resolvedUser.principalName]
      .map(normalize)
      .filter(Boolean)
  );

  const matchesResolvedIdentity = row => {
    const rowIds = [row.id, row.originId, row.descriptor]
      .map(normalize)
      .filter(Boolean);

    // Strongest match: Azure DevOps identity ID / origin ID / descriptor.
    if (rowIds.some(id => selectedIds.has(id))) return true;

    // Controlled fallback for membership payloads that omit identity IDs.
    const rowEmails = [row.email, row.uniqueName, row.principalName]
      .map(normalize)
      .filter(Boolean);
    return rowEmails.some(email => selectedEmails.has(email));
  };

  const matchingRows = allRows.filter(matchesResolvedIdentity);
  const teamMemberships = [];
  const groupMemberships = [];
  const groupCounts = {};

  for (const row of matchingRows) {
    const containerName = String(row.team || 'Unnamed');
    const type = String(row.type || 'Group');
    groupCounts[containerName] = 1;

    if (type === 'Team') {
      if (!teamMemberships.some(x => x.name === containerName)) {
        teamMemberships.push({
          name: containerName,
          id: context.teams.find(t => String(t.name) === containerName)?.id || '',
          type: 'Team'
        });
      }
    } else if (!groupMemberships.some(x => x.name === containerName)) {
      const matchingGroup = context.groups.find(g => {
        const displayName = String(g.displayName || g.principalName || '').replace(
          new RegExp(
            `^\\[${String(project).replace(/[.*+?^${}()|[\\]\\]/g, '\\\\$&')}\\]\\\\`
          ),
          ''
        );
        return displayName === containerName;
      });

      groupMemberships.push({
        name: containerName,
        descriptor: matchingGroup?.descriptor || '',
        type: 'Group'
      });
    }
  }

  return {
    user: resolvedUser,
    rows: sortAccessRows(matchingRows),
    groupCounts,
    teamMemberships,
    groupMemberships,
    userActive: true,
    identityConfidence: resolvedUser.confidence,
    identityMatchMethod: resolvedUser.matchMethod
  };
}

async function fetchUserAccessData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim();
  const userQuery = document.getElementById('targetAccessUserQuery').value.trim();
  const authHeader = createBasicAuthHeader(pat);

  showSection('access');
  beginAzDoOperation();
  startFetching(
    userQuery
      ? `Resolving project access for "${userQuery}"...`
      : `Fetching project teams, security groups, and members...`
  );

  try {
    const context = await fetchProjectAccessContext(org, project, authHeader);

    let result;
    if (userQuery) {
      result = await fetchSpecificUserAccess(
        context,
        org,
        project,
        userQuery,
        authHeader
      );
    } else {
      result = await fetchProjectLevelAccess(
        context,
        org,
        project,
        authHeader
      );
    }

    const accessRows = result.rows || [];
    rawStore.access = accessRows;
    rawStore.accessIndex = 0;
    rawStore.accessMode = userQuery ? 'user' : 'project';
    rawStore.accessSummary = result;

    // KPI 1: active scope
    document.getElementById('kpi-1-label').textContent = 'Active Scope';
    document.getElementById('kpi-1-val').textContent =
      userQuery
        ? (result.user?.name || userQuery)
        : project;

    // KPI 2/3 are intentionally different in the two modes.
    if (userQuery) {
      document.getElementById('kpi-2-label').textContent = 'Teams';
      document.getElementById('kpi-2-val').textContent =
        result.teamMemberships?.length || 0;

      document.getElementById('kpi-3-label').textContent = 'Groups';
      document.getElementById('kpi-3-val').textContent =
        result.groupMemberships?.length || 0;

      document.getElementById('kpi-4-label').textContent = 'Total Memberships';
      document.getElementById('kpi-4-val').textContent = accessRows.length;

      document.getElementById('kpi-5-label').textContent = 'Status';
      document.getElementById('kpi-5-val').textContent =
        result.user
          ? (result.userActive === false
              ? 'Inactive'
              : (accessRows.length ? 'Active' : 'No Project Access'))
          : 'User Not Found';
    } else {
      document.getElementById('kpi-2-label').textContent = 'Total Teams';
      document.getElementById('kpi-2-val').textContent = result.totalTeams || 0;

      document.getElementById('kpi-3-label').textContent = 'Total Groups';
      document.getElementById('kpi-3-val').textContent = result.totalGroups || 0;

      document.getElementById('kpi-4-label').textContent = 'Total Members';
      document.getElementById('kpi-4-val').textContent = result.totalMembers || 0;

      document.getElementById('kpi-5-label').textContent = 'Status';
      document.getElementById('kpi-5-val').textContent = 'Active';
    }

    document.getElementById('kpi-1-val').className =
      'text-2xl font-extrabold text-slate-800 mt-1 truncate';

    renderAccessTableBatch(false);

    const labels = Object.keys(result.groupCounts || {});
    const values = Object.values(result.groupCounts || {});
    renderChart(
      labels,
      values,
      userQuery
        ? 'Selected User Memberships by Group / Team'
        : 'Members by Project Group / Team'
    );

    const summaryText = userQuery
      ? (
        result.user
          ? `Found ${result.teamMemberships.length} team membership(s), ${result.groupMemberships.length} group membership(s), and ${accessRows.length} total project membership(s) for "${result.user.name}". Identity resolved by ${result.identityMatchMethod || 'authoritative identity'} (${result.identityConfidence || 0}% confidence).`
          : `No Azure DevOps identity matched "${userQuery}".`
      )
      : `Loaded ${result.totalTeams} teams, ${result.totalGroups} project groups, and ${result.totalMembers} unique project members.`;

    const partial = getAzDoPartialResultMessage();
    stopFetching();
    setStatus(
      partial ? `${summaryText} ${partial}` : summaryText,
      partial ? 'info' : 'success'
    );
  } catch (err) {
    stopFetching();
    setStatus(
      isAzDoCancellation(err)
        ? 'The project access operation was cancelled.'
        : `Error querying security access: ${err.message}`,
      isAzDoCancellation(err) ? 'info' : 'error'
    );
  }
}

function renderAccessTableBatch(append = false) {
  const tbody = document.getElementById('accessTableBody');
  const container = document.getElementById('seeMoreAccessContainer');
  const remainingEl = document.getElementById('accessRemainingCount');

  if (!append) setSafeInnerHTML(tbody, '');

  if (rawStore.access.length === 0) {
    setSafeInnerHTML(
      tbody,
      `<tr><td colspan="4" class="p-4 text-center text-slate-400">No project access records found.</td></tr>`
    );
    container.classList.add('hidden');
    return;
  }

  const nextBatch = rawStore.access.slice(
    rawStore.accessIndex,
    rawStore.accessIndex + PAGE_SIZE
  );
  rawStore.accessIndex += nextBatch.length;
  const batchStartIndex = rawStore.accessIndex - nextBatch.length;

  const html = nextBatch.map((a, rowIndex) => `
<tr class="hover:bg-slate-50 transition" data-detail-type="access" data-detail-index="${batchStartIndex + rowIndex}">
<td class="p-4 font-semibold text-slate-900">${escapeHtml(a.team)}</td>
<td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold ${a.type === 'Group' ? 'bg-purple-50 text-purple-700 border border-purple-200' : 'bg-blue-50 text-blue-700 border border-blue-200'}">${escapeHtml(a.type)}</span></td>
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
