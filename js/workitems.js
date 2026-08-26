async function fetchWorkItemsData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim() || sessionStorage.getItem('azdo_pat') || '';
  const targetUser = document.getElementById('targetWorkItemUser').value.trim();
  if (!org || !project) return showModal('Select an organization and project first.', 'projectSelect');
  if (!pat) return showModal('Enter a PAT before querying work items.', 'targetPat');

  showSection('workitems');
  setStatus(targetUser ? `Querying work items assigned to "${targetUser}"...` : 'Querying recent work items and backlog state...', 'info');
  const authHeader = buildAuthHeader(pat);

  try {
    let wiql = `SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = '${project.replace(/'/g, "''")}'`;
    if (targetUser) wiql += ` AND [System.AssignedTo] CONTAINS '${targetUser.replace(/'/g, "''")}'`;
    wiql += ' ORDER BY [System.ChangedDate] DESC';

    const queryUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=${API_VERSION}`;
    const queryRes = await fetchAzDo(queryUrl, authHeader, { method: 'POST', body: JSON.stringify({ query: wiql }) });
    const ids = (queryRes.workItems || []).slice(0, 200).map(item => item.id);

    if (!ids.length) {
      rawStore.workitems = []; rawStore.workitemsIndex = 0;
      renderWorkItemsTableBatch(false);
      setKpis(targetUser || project, [{ label: 'Total work items', value: 0 }, { label: 'Active / in progress', value: 0 }, { label: 'Resolved', value: 0 }, { label: 'Closed / done', value: 0 }]);
      renderChart([], [], 'Work item states');
      return setStatus('No work items matched the selected criteria.', 'info');
    }

    const fields = 'System.Id,System.Title,System.WorkItemType,System.State,System.AssignedTo,System.IterationPath,System.CreatedDate';
    const detailsUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems?ids=${ids.join(',')}&fields=${fields}&api-version=${API_VERSION}`;
    const details = await fetchAzDo(detailsUrl, authHeader);
    const stateCounts = {};
    let active = 0, resolved = 0, closed = 0;

    rawStore.workitems = (details.value || []).map(item => {
      const fields = item.fields || {};
      const state = fields['System.State'] || 'New';
      const lower = state.toLowerCase();
      stateCounts[state] = (stateCounts[state] || 0) + 1;
      if (['resolved'].includes(lower)) resolved++;
      else if (['closed', 'done', 'completed'].includes(lower)) closed++;
      else active++;
      return {
        id: item.id,
        type: fields['System.WorkItemType'] || 'Work Item',
        title: fields['System.Title'] || 'Untitled',
        assignedTo: normalizeDisplayName(fields['System.AssignedTo']) === 'Unknown' ? 'Unassigned' : normalizeDisplayName(fields['System.AssignedTo']),
        state,
        createdDate: fields['System.CreatedDate'] ? new Date(fields['System.CreatedDate']).toLocaleDateString() : 'N/A'
      };
    });
    rawStore.workitemsIndex = 0;

    setKpis(targetUser || project, [
      { label: 'Total work items', value: rawStore.workitems.length },
      { label: 'Active / in progress', value: active },
      { label: 'Resolved', value: resolved },
      { label: 'Closed / done', value: closed }
    ]);
    renderWorkItemsTableBatch(false);
    renderChart(Object.keys(stateCounts), Object.values(stateCounts), 'Work items by state');
    setStatus(`Loaded ${rawStore.workitems.length.toLocaleString()} work items.`, 'success');
  } catch (err) {
    setStatus(`Work item query failed: ${err.message}`, 'error');
  }
}

function renderWorkItemsTableBatch(append = false) {
  const tbody = document.getElementById('workItemsTableBody');
  const container = document.getElementById('seeMoreWorkItemsContainer');
  const remaining = document.getElementById('workItemsRemainingCount');
  if (!append) tbody.innerHTML = '';
  if (!rawStore.workitems.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No work items found.</td></tr>';
    container.classList.add('hidden');
    return;
  }
  const batch = rawStore.workitems.slice(rawStore.workitemsIndex, rawStore.workitemsIndex + PAGE_SIZE);
  rawStore.workitemsIndex += batch.length;
  tbody.insertAdjacentHTML('beforeend', batch.map(item => `
    <tr><td><strong class="font-mono text-blue-700">#${escapeHtml(item.id)}</strong></td><td><span class="status-pill neutral">${escapeHtml(item.type)}</span></td><td class="max-w-[360px] truncate" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</td><td>${escapeHtml(item.assignedTo)}</td><td><span class="status-pill ${statusClass(item.state)}">${escapeHtml(item.state)}</span></td><td>${escapeHtml(item.createdDate)}</td></tr>`).join(''));
  const count = rawStore.workitems.length - rawStore.workitemsIndex;
  remaining.textContent = count.toLocaleString();
  container.classList.toggle('hidden', count <= 0);
}
