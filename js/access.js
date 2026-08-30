async function fetchUserAccessData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim();
  const userQuery = document.getElementById('targetAccessUserQuery').value.trim().toLowerCase();

  const authHeader = 'Basic ' + btoa(':' + pat);
  showSection('access');
  startFetching(userQuery ? `Scanning groups and teams for "${userQuery}"...` : `Fetching all project security groups, teams, and members...`);

  let accessRows = [];
  let groupMemberCounts = {};
  const resolvedDescriptors = new Map();

  async function resolveSubjectDescriptor(descriptor) {
    if (!descriptor) return null;
    if (resolvedDescriptors.has(descriptor)) return resolvedDescriptors.get(descriptor);

    try {
      const userUrl = `https://vssps.dev.azure.com/${org}/_apis/graph/users/${descriptor}?api-version=${API_VERSION}`;
      const res = await fetchAzDo(userUrl, authHeader);
      if (res) {
        const data = {
          name: res.displayName || 'Unknown',
          email: res.mailAddress || res.principalName || 'N/A'
        };
        resolvedDescriptors.set(descriptor, data);
        return data;
      }
    } catch (e) {
      try {
        const idUrl = `https://vssps.dev.azure.com/${org}/_apis/identities?subjectDescriptors=${encodeURIComponent(descriptor)}&api-version=${API_VERSION}`;
        const idRes = await fetchAzDo(idUrl, authHeader);
        const val = idRes?.value?.[0];
        if (val) {
          const data = {
            name: val.providerDisplayName || val.customDisplayName || 'Unknown',
            email: val.properties?.Mail?.$value || val.properties?.Account?.$value || val.descriptor?.split('\\')?.[1] || 'N/A'
          };
          resolvedDescriptors.set(descriptor, data);
          return data;
        }
      } catch (err) {}
    }
    return null;
  }

  try {
    let projectDescriptor = '';
    try {
      const projInfoUrl = `https://dev.azure.com/${org}/_apis/projects/${project}?api-version=${API_VERSION}`;
      const projInfo = await fetchAzDo(projInfoUrl, authHeader);
      if (projInfo && projInfo.id) {
        const descUrl = `https://vssps.dev.azure.com/${org}/_apis/graph/descriptors/${projInfo.id}?api-version=${API_VERSION}`;
        const descData = await fetchAzDo(descUrl, authHeader);
        projectDescriptor = descData?.value || '';
      }
    } catch (e) {
      console.warn('Could not resolve project descriptor:', e);
    }

    let graphGroups = [];
    try {
      let contToken = '';
      do {
        const tokenParam = contToken ? `&continuationToken=${encodeURIComponent(contToken)}` : '';
        const scopeParam = projectDescriptor ? `&scopeDescriptor=${encodeURIComponent(projectDescriptor)}` : '';
        const gUrl = `https://vssps.dev.azure.com/${org}/_apis/graph/groups?api-version=${API_VERSION}${scopeParam}${tokenParam}`;
        
        const gData = await fetchAzDo(gUrl, authHeader);
        const list = gData?.value || [];
        graphGroups.push(...list);
        contToken = gData?.continuationToken || '';
      } while (contToken);
    } catch (e) {
      console.warn('Graph group listing fallback:', e);
    }

    let teams = [];
    try {
      const teamsUrl = `https://dev.azure.com/${org}/_apis/projects/${project}/teams?$expandIdentity=true&$top=500&api-version=${API_VERSION}`;
      const tData = await fetchAzDo(teamsUrl, authHeader);
      teams = tData?.value || [];
    } catch (e) {
      console.warn('Teams query fallback:', e);
    }

    graphGroups.forEach(g => {
      const name = (g.displayName || '').replace(`[${project}]\\`, '');
      groupMemberCounts[name] = 0;
    });

    teams.forEach(t => {
      if (groupMemberCounts[t.name] === undefined) {
        groupMemberCounts[t.name] = 0;
      }
    });

    const groupTasks = graphGroups.map(async (g) => {
      const groupName = (g.displayName || '').replace(`[${project}]\\`, '');
      try {
        const memUrl = `https://vssps.dev.azure.com/${org}/_apis/graph/Memberships/${g.descriptor}?direction=Down&api-version=${API_VERSION}`;
        const memData = await fetchAzDo(memUrl, authHeader);
        const members = memData?.value || [];

        await Promise.all(members.map(async (m) => {
          const identity = await resolveSubjectDescriptor(m.memberDescriptor);
          if (identity) {
            if (!userQuery || identity.name.toLowerCase().includes(userQuery) || identity.email.toLowerCase().includes(userQuery)) {
              accessRows.push({
                team: groupName,
                type: 'Security Group',
                name: identity.name,
                email: identity.email
              });
              groupMemberCounts[groupName] = (groupMemberCounts[groupName] || 0) + 1;
            }
          }
        }));
      } catch (err) {}
    });

    const teamTasks = teams.map(async (t) => {
      try {
        const mUrl = `https://dev.azure.com/${org}/_apis/projects/${project}/teams/${t.id}/members?$top=500&api-version=${API_VERSION}`;
        const mData = await fetchAzDo(mUrl, authHeader);
        const members = mData?.value || [];

        members.forEach(m => {
          const name = m.identity?.displayName || 'Unknown';
          const email = m.identity?.uniqueName || m.identity?.mailAddress || 'N/A';

          if (!userQuery || name.toLowerCase().includes(userQuery) || email.toLowerCase().includes(userQuery)) {
            accessRows.push({
              team: t.name,
              type: 'Team',
              name: name,
              email: email
            });
            groupMemberCounts[t.name] = (groupMemberCounts[t.name] || 0) + 1;
          }
        });
      } catch (err) {}
    });

    await Promise.all([...groupTasks, ...teamTasks]);

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
    document.getElementById('kpi-2-val').textContent = Object.keys(groupMemberCounts).length;
    document.getElementById('kpi-3-label').textContent = 'Total Memberships';
    document.getElementById('kpi-3-val').textContent = accessRows.length;
    document.getElementById('kpi-4-label').textContent = 'Mode';
    document.getElementById('kpi-4-val').textContent = 'Security Access';
    document.getElementById('kpi-5-label').textContent = 'Status';
    document.getElementById('kpi-5-val').textContent = 'Ready';

    renderAccessTableBatch(false);
    renderChart(Object.keys(groupMemberCounts), Object.values(groupMemberCounts), 'Members per Group / Team');
    stopFetching();


    setStatus(`Loaded ${accessRows.length} member assignments across all ${Object.keys(groupMemberCounts).length} groups & teams.`, 'success');

    } catch (err) {

      stopFetching();
    setStatus(`Error querying security access: ${err.message}`, 'error');
  }
}

function renderAccessTableBatch(append = false) {
  const tbody = document.getElementById('accessTableBody');
  const container = document.getElementById('seeMoreAccessContainer');
  const remainingEl = document.getElementById('accessRemainingCount');

  if (!append) tbody.innerHTML = '';

  if (rawStore.access.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-400">No security groups or team memberships found.</td></tr>`;
    container.classList.add('hidden');
    return;
  }

  const nextBatch = rawStore.access.slice(rawStore.accessIndex, rawStore.accessIndex + PAGE_SIZE);
  rawStore.accessIndex += nextBatch.length;

  const html = nextBatch.map(a => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-semibold text-slate-900">${a.team}</td>
      <td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold ${a.type === 'Security Group' ? 'bg-purple-50 text-purple-700 border border-purple-200' : 'bg-blue-50 text-blue-700 border border-blue-200'}">${a.type}</span></td>
      <td class="p-4 font-medium">${a.name}</td>
      <td class="p-4 text-xs font-mono text-slate-600">${a.email}</td>
    </tr>
  `).join('');

  tbody.insertAdjacentHTML('beforeend', html);

  const remaining = rawStore.access.length - rawStore.accessIndex;
  if (remaining > 0) {
    container.classList.remove('hidden');
    remainingEl.textContent = remaining;
  } else {
    container.classList.add('hidden');
  }
}