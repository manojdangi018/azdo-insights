async function fetchUserAccessData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim() || sessionStorage.getItem('azdo_pat') || '';
  const query = document.getElementById('targetAccessUserQuery').value.trim().toLowerCase();
  if (!org || !project) return showModal('Select an organization and project first.', 'projectSelect');
  if (!pat) return showModal('Enter a PAT before loading access data.', 'targetPat');

  showSection('access');
  setStatus('Loading project teams and members...', 'info');
  const authHeader = buildAuthHeader(pat);

  try {
    const teamsUrl = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects/${encodeURIComponent(project)}/teams?api-version=${API_VERSION}`;
    const teamsData = await fetchAzDo(teamsUrl, authHeader);
    const teams = teamsData.value || [];
    const rows = [];

    await Promise.all(teams.map(async team => {
      try {
        const membersUrl = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects/${encodeURIComponent(project)}/teams/${encodeURIComponent(team.id)}/members?api-version=${API_VERSION}`;
        const membersData = await fetchAzDo(membersUrl, authHeader);
        (membersData.value || []).forEach(member => {
          const memberName = normalizeDisplayName(member.identity || member);
          const principal = member.identity?.uniqueName || member.identity?.mail || member.uniqueName || member.mail || memberName;
          rows.push({ team: team.name, scope: 'Project team', member: memberName, principal });
        });
      } catch (_) {
        rows.push({ team: team.name, scope: 'Project team', member: 'Members unavailable', principal: 'PAT may need team/member scope' });
      }
    }));

    rawStore.access = query
      ? rows.filter(row => `${row.team} ${row.member} ${row.principal}`.toLowerCase().includes(query))
      : rows;
    rawStore.accessIndex = 0;

    const teamCount = teams.length;
    const memberCount = rawStore.access.filter(row => row.member !== 'Members unavailable').length;
    const uniqueMembers = new Set(rawStore.access.map(row => row.principal)).size;
    setKpis(query || project, [
      { label: 'Teams found', value: teamCount },
      { label: 'Membership rows', value: rawStore.access.length },
      { label: 'Unique members', value: uniqueMembers },
      { label: 'Filtered matches', value: rawStore.access.length }
    ]);
    renderAccessTableBatch(false);
    renderChart(teams.map(team => team.name), teams.map(team => rawStore.access.filter(row => row.team === team.name).length), 'Members by team');
    setStatus(`Loaded ${teamCount} team(s) and ${memberCount} membership record(s).`, 'success');
  } catch (err) {
    setStatus(`Access data could not be loaded: ${err.message}`, 'error');
  }
}

function renderAccessTableBatch(append = false) {
  const tbody = document.getElementById('accessTableBody');
  const container = document.getElementById('seeMoreAccessContainer');
  const remaining = document.getElementById('accessRemainingCount');
  if (!append) tbody.innerHTML = '';
  if (!rawStore.access.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-row">No team membership matched the selected filter.</td></tr>';
    container.classList.add('hidden');
    return;
  }
  const batch = rawStore.access.slice(rawStore.accessIndex, rawStore.accessIndex + PAGE_SIZE);
  rawStore.accessIndex += batch.length;
  tbody.insertAdjacentHTML('beforeend', batch.map(row => `
    <tr><td><strong class="text-slate-900">${escapeHtml(row.team)}</strong></td><td><span class="status-pill info">${escapeHtml(row.scope)}</span></td><td>${escapeHtml(row.member)}</td><td class="font-mono text-[10px]">${escapeHtml(row.principal)}</td></tr>`).join(''));
  const count = rawStore.access.length - rawStore.accessIndex;
  remaining.textContent = count.toLocaleString();
  container.classList.toggle('hidden', count <= 0);
}

function exportAccessToXLSX() {
  exportToExcelFile({ Access: rawStore.access.map(row => ({ 'Team / Group': row.team, Scope: row.scope, Member: row.member, 'Principal / Email': row.principal })) }, 'AzureDevOps_Access');
}
