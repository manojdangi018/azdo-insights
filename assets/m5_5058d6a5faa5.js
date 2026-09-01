
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

function accessIdentityObject(identity = {}, descriptor = '') {
  return {
    name: accessIdentityName(identity),
    email: accessIdentityEmail(identity),
    descriptor: descriptor || identity.descriptor || '',
    subjectKind: identity.subjectKind || 'user'
  };
}

async function resolveAccessIdentityByDescriptor(org, descriptor, authHeader, cache) {
  if (!descriptor) return null;
  if (cache.has(descriptor)) return cache.get(descriptor);

  const promise = (async () => {
    // Graph users are preview API.
    try {
      const userUrl =
        `https://vssps.dev.azure.com/${encodeURIComponent(org)}` +
        `/_apis/graph/users/${encodeURIComponent(descriptor)}` +
        `?api-version=${ACCESS_GRAPH_API_VERSION}`;
      const user = await fetchAzDo(userUrl, authHeader);
      if (user) return accessIdentityObject(user, descriptor);
    } catch (_) {}

    // A member descriptor can also be another group. We resolve it so that
    // nested project groups can be expanded rather than being shown as users.
    try {
      const groupUrl =
        `https://vssps.dev.azure.com/${encodeURIComponent(org)}` +
        `/_apis/graph/groups/${encodeURIComponent(descriptor)}` +
        `?api-version=${ACCESS_GRAPH_API_VERSION}`;
      const group = await fetchAzDo(groupUrl, authHeader);
      if (group) {
        return {
          name: accessIdentityName(group),
          email: group.mailAddress || group.principalName || 'N/A',
          descriptor,
          subjectKind: 'group'
        };
      }
    } catch (_) {}

    // Stable Identities API is a useful final fallback for legacy AAD identities.
    try {
      const idUrl =
        `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/identities` +
        `?subjectDescriptors=${encodeURIComponent(descriptor)}` +
        `&api-version=${AZDO_STABLE_API_VERSION}`;
      const idRes = await fetchAzDo(idUrl, authHeader);
      const val = idRes?.value?.[0];
      if (val) return accessIdentityObject({
        displayName: val.providerDisplayName || val.customDisplayName,
        mailAddress:
          val.properties?.Mail?.$value ||
          val.properties?.Account?.$value ||
          val.properties?.[ 'Mail Address' ]?.$value,
        principalName: val.properties?.Account?.$value
      }, descriptor);
    } catch (_) {}

    return null;
  })();

  cache.set(descriptor, promise);
  return promise;
}

async function resolveRequestedAccessUser(org, query, authHeader) {
  const variants = typeof buildIdentitySearchVariants === 'function'
    ? buildIdentitySearchVariants(query)
    : [String(query || '').trim()];

  const candidates = [];
  const seenIds = new Set();

  for (const variant of variants) {
    if (!variant) continue;
    try {
      const url =
        `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/identities` +
        `?searchFilter=General` +
        `&filterValue=${encodeURIComponent(variant)}` +
        `&queryMembership=None` +
        `&api-version=${AZDO_STABLE_API_VERSION}`;
      const res = await fetchAzDo(url, authHeader);
      for (const item of (res?.value || [])) {
        const key = item.id || item.descriptor || JSON.stringify(item);
        if (!seenIds.has(key)) {
          seenIds.add(key);
          candidates.push(item);
        }
      }
    } catch (_) {}
  }

  if (!candidates.length) return null;

  // Prefer an exact email/account/display-name match.
  const exact = candidates.find(identity =>
    typeof identityMatchesQuery === 'function'
      ? identityMatchesQuery(query, {
          displayName: identity.providerDisplayName || identity.customDisplayName,
          mailAddress: identity.properties?.Mail?.$value,
          uniqueName: identity.properties?.Account?.$value,
          principalName: identity.properties?.Account?.$value,
          descriptor: identity.descriptor
        })
      : true
  );

  const chosen = exact || candidates[0];
  const descriptor = chosen.descriptor;
  if (!descriptor) return null;

  let graphUser = null;
  try {
    const url =
      `https://vssps.dev.azure.com/${encodeURIComponent(org)}` +
      `/_apis/graph/users/${encodeURIComponent(descriptor)}` +
      `?api-version=${ACCESS_GRAPH_API_VERSION}`;
    graphUser = await fetchAzDo(url, authHeader);
  } catch (_) {}

  const identity = accessIdentityObject(graphUser || {
    displayName: chosen.providerDisplayName || chosen.customDisplayName,
    mailAddress:
      chosen.properties?.Mail?.$value ||
      chosen.properties?.Account?.$value,
    principalName: chosen.properties?.Account?.$value
  }, descriptor);

  return {
    ...identity,
    id: chosen.id || '',
    descriptor
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
    const key = String(
      user.descriptor ||
      user.email ||
      user.name
    ).trim().toLowerCase();
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
    return {
      name: accessIdentityName(identity),
      email: accessIdentityEmail(identity),
      descriptor: identity.descriptor || '',
      subjectKind: 'user'
    };
  });
}

function makeAccessRow(containerName, type, user) {
  return {
    team: containerName,
    type,
    name: user.name || 'Unknown',
    email: user.email || 'N/A',
    descriptor: user.descriptor || ''
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
  const user = await resolveRequestedAccessUser(org, userQuery, authHeader);
  if (!user) {
    return {
      user: null,
      rows: [],
      groupCounts: {},
      teamMemberships: [],
      groupMemberships: []
    };
  }

  const projectGroupByDescriptor = new Map(
    context.groups.map(g => [String(g.descriptor), g])
  );

  // Graph memberships are the authoritative source for group membership.
  // Direction=Up returns containers in which the selected user is a member.
  const membershipUrl =
    `https://vssps.dev.azure.com/${encodeURIComponent(org)}` +
    `/_apis/graph/Memberships/${encodeURIComponent(user.descriptor)}` +
    `?direction=Up&api-version=${ACCESS_GRAPH_API_VERSION}`;

  const membershipsResult = await fetchAzDoPaged(membershipUrl, authHeader, {
    pageSize: 500,
    maxPages: AZDO_API_MAX_PAGES
  });

  const directGroupDescriptors = new Set(
    (membershipsResult?.value || [])
      .map(m => m?.containerDescriptor)
      .filter(d => projectGroupByDescriptor.has(String(d)))
  );

  // Traverse upward from project groups as well, so inherited/nested project
  // groups can be represented without treating organization-wide groups as
  // project groups unless they are explicitly connected to a project group.
  const inheritedGroupDescriptors = new Set(directGroupDescriptors);

  async function addParentProjectGroups(groupDescriptor, depth = 0) {
    if (!groupDescriptor || depth >= 5) return;
    try {
      const parentUrl =
        `https://vssps.dev.azure.com/${encodeURIComponent(org)}` +
        `/_apis/graph/Memberships/${encodeURIComponent(groupDescriptor)}` +
        `?direction=Up&api-version=${ACCESS_GRAPH_API_VERSION}`;
      const parentResult = await fetchAzDoPaged(parentUrl, authHeader, {
        pageSize: 500,
        maxPages: AZDO_API_MAX_PAGES
      });

      for (const item of (parentResult?.value || [])) {
        const parentDescriptor = String(item?.containerDescriptor || '');
        if (!projectGroupByDescriptor.has(parentDescriptor)) continue;
        if (inheritedGroupDescriptors.has(parentDescriptor)) continue;
        inheritedGroupDescriptors.add(parentDescriptor);
        await addParentProjectGroups(parentDescriptor, depth + 1);
      }
    } catch (_) {}
  }

  for (const descriptor of [...directGroupDescriptors]) {
    await addParentProjectGroups(descriptor);
  }

  let userActive = null;
  try {
    const stateUrl =
      `https://vssps.dev.azure.com/${encodeURIComponent(org)}` +
      `/_apis/graph/membershipstates/${encodeURIComponent(user.descriptor)}` +
      `?api-version=${ACCESS_GRAPH_API_VERSION}`;
    const state = await fetchAzDo(stateUrl, authHeader);
    if (typeof state?.active === 'boolean') userActive = state.active;
  } catch (_) {}

  const rows = [];
  const groupCounts = {};
  const groupMemberships = [];

  for (const descriptor of inheritedGroupDescriptors) {
    const group = projectGroupByDescriptor.get(descriptor);
    if (!group) continue;

    const groupName = String(group.displayName || group.principalName || 'Unnamed Group')
      .replace(new RegExp(`^\\[${String(project).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\\\`), '');

    groupCounts[groupName] = 1;
    groupMemberships.push({
      name: groupName,
      descriptor,
      type: 'Group'
    });

    rows.push(makeAccessRow(groupName, 'Group', user));
  }

  const teamMemberships = [];
  for (const team of context.teams) {
    try {
      const members = await fetchTeamMembers(org, project, team.id, authHeader);
      const matches = members.filter(member =>
        identityMatchesQuery(userQuery, {
          displayName: member.name,
          mailAddress: member.email,
          uniqueName: member.email,
          descriptor: member.descriptor
        }) ||
        (user.descriptor && member.descriptor === user.descriptor)
      );

      if (matches.length) {
        groupCounts[team.name] = 1;
        teamMemberships.push({
          name: team.name,
          id: team.id,
          type: 'Team'
        });
        rows.push(makeAccessRow(team.name, 'Team', user));
      }
    } catch (_) {}
  }

  return {
    user,
    rows: sortAccessRows(rows),
    groupCounts,
    teamMemberships,
    groupMemberships,
    userActive
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
          ? `Found ${result.teamMemberships.length} team membership(s), ${result.groupMemberships.length} group membership(s), and ${accessRows.length} total project membership(s) for "${result.user.name}".`
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
