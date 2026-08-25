async function fetchWorkItemsData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim();
  const targetUser = document.getElementById('targetWorkItemUser').value.trim();

  const authHeader = 'Basic ' + btoa(':' + pat);
  showSection('workitems');
  setStatus(targetUser ? `Querying work items assigned to "${targetUser}"...` : `Querying all active work items and sprint status...`, 'info');

  try {
    let wiql = `SELECT [System.Id], [System.Title], [System.WorkItemType], [System.State], [System.AssignedTo], [System.IterationPath], [System.CreatedDate] FROM workitems WHERE [System.TeamProject] = @project`;
    
    if (targetUser) {
      wiql += ` AND [System.AssignedTo] CONTAINS '${targetUser.replace(/'/g, "''")}'`;
    }
    wiql += ` ORDER BY [System.ChangedDate] DESC`;

    const queryUrl = `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=7.0`;
    let queryRes;
    try {
      queryRes = await fetchAzDo(queryUrl, authHeader, {
        method: 'POST',
        body: JSON.stringify({ query: wiql })
      });
    } catch (e) {
      const fallbackWiql = `SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = '${project.replace(/'/g, "''")}' ORDER BY [System.ChangedDate] DESC`;
      queryRes = await fetchAzDo(`https://dev.azure.com/${org}/_apis/wit/wiql?api-version=7.0`, authHeader, {
        method: 'POST',
        body: JSON.stringify({ query: fallbackWiql })
      });
    }

    const wiList = queryRes.workItems || [];
    const wiIds = wiList.slice(0, 200).map(w => w.id);

    if (wiIds.length === 0) {
      document.getElementById('workItemsTableBody').innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400">No work items found in project "${project}".</td></tr>`;
      document.getElementById('seeMoreWorkItemsContainer').classList.add('hidden');
      renderChart([], [], 'Work Item States');
      setStatus(`No work items found matching criteria.`, 'info');
      return;
    }

    const fields = 'System.Id,System.Title,System.WorkItemType,System.State,System.AssignedTo,System.IterationPath,System.CreatedDate';
    const detailsUrl = `https://dev.azure.com/${org}/${encodeURIComponent(project)}/_apis/wit/workitems?ids=${wiIds.join(',')}&fields=${fields}&api-version=7.0`;
    const detailsData = await fetchAzDo(detailsUrl, authHeader);
    const workItems = detailsData.value || [];

    let stateCounts = {};
    let activeInProgressCount = 0;
    let resolvedCount = 0;
    let closedCount = 0;

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

      const sLower = state.toLowerCase();
      if (sLower === 'resolved') {
        resolvedCount++;
      } else if (sLower === 'closed' || sLower === 'done' || sLower === 'completed') {
        closedCount++;
      } else if (['active', 'in progress', 'doing', 'new', 'to do'].includes(sLower)) {
        activeInProgressCount++;
      }

      return {
        id: w.id,
        type: type,
        title: fields['System.Title'] || 'Untitled',
        assignedTo: assignedName,
        state: state,
        createdDate: fields['System.CreatedDate'] ? new Date(fields['System.CreatedDate']).toLocaleDateString() : 'N/A'
      };
    });

    rawStore.workitemsIndex = 0;

    document.getElementById('kpi-1-val').textContent = targetUser ? targetUser : `${project} (All Backlog)`;
    document.getElementById('kpi-2-label').textContent = 'Total Work Items';
    document.getElementById('kpi-2-val').textContent = rawStore.workitems.length;
    document.getElementById('kpi-3-label').textContent = 'Active / In Progress';
    document.getElementById('kpi-3-val').textContent = activeInProgressCount;
    document.getElementById('kpi-4-label').textContent = 'Resolved';
    document.getElementById('kpi-4-val').textContent = resolvedCount;
    document.getElementById('kpi-5-label').textContent = 'Closed / Done';
    document.getElementById('kpi-5-val').textContent = closedCount;

    renderWorkItemsTableBatch(false);

    const chartLabels = Object.keys(stateCounts);
    const chartData = Object.values(stateCounts);
    renderChart(chartLabels, chartData, 'Work Items by State');

    setStatus(`Loaded ${rawStore.workitems.length} work items successfully.`, 'success');
  } catch (err) {
    setStatus(`Error fetching work items: ${err.message}`, 'error');
  }
}

function renderWorkItemsTableBatch(append = false) {
  const tbody = document.getElementById('workItemsTableBody');
  const container = document.getElementById('seeMoreWorkItemsContainer');
  const remainingEl = document.getElementById('workItemsRemainingCount');

  if (!append) tbody.innerHTML = '';

  if (rawStore.workitems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400">No work items found.</td></tr>`;
    container.classList.add('hidden');
    return;
  }

  const nextBatch = rawStore.workitems.slice(rawStore.workitemsIndex, rawStore.workitemsIndex + PAGE_SIZE);
  rawStore.workitemsIndex += nextBatch.length;

  const html = nextBatch.map(r => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-mono text-xs font-bold text-blue-600">#${r.id}</td>
      <td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-700">${r.type}</span></td>
      <td class="p-4 font-medium text-slate-900 max-w-sm truncate" title="${r.title}">${r.title}</td>
      <td class="p-4 text-xs font-semibold ${r.assignedTo === 'Unassigned' ? 'text-slate-400 italic' : 'text-slate-800'}">${r.assignedTo}</td>
      <td class="p-4 text-xs">
        <span class="px-2 py-0.5 rounded-full font-semibold ${
          ['closed', 'done', 'resolved', 'completed'].includes(r.state.toLowerCase()) ? 'bg-emerald-100 text-emerald-700' :
          ['active', 'in progress', 'doing'].includes(r.state.toLowerCase()) ? 'bg-blue-100 text-blue-700' :
          'bg-slate-100 text-slate-700'
        }">${r.state}</span>
      </td>
      <td class="p-4 text-xs text-slate-500">${r.createdDate}</td>
    </tr>
  `).join('');

  tbody.insertAdjacentHTML('beforeend', html);

  const remaining = rawStore.workitems.length - rawStore.workitemsIndex;
  if (remaining > 0) {
    container.classList.remove('hidden');
    remainingEl.textContent = remaining;
  } else {
    container.classList.add('hidden');
  }
}