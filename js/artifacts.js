async function fetchArtifactsData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim();

  const authHeader = 'Basic ' + btoa(':' + pat);
  setStatus('Scanning project artifact feeds & package repositories...', 'info');

  try {
    const feedsUrl = `https://feeds.dev.azure.com/${org}/${project}/_apis/packaging/feeds?api-version=${API_VERSION}`;
    let feeds = [];
    try {
      const data = await fetchAzDo(feedsUrl, authHeader);
      feeds = data.value || [];
    } catch (e) {
      const globalFeedsUrl = `https://feeds.dev.azure.com/${org}/_apis/packaging/feeds?api-version=${API_VERSION}`;
      const globalData = await fetchAzDo(globalFeedsUrl, authHeader);
      feeds = globalData.value || [];
    }

    rawStore.artifacts = feeds.map(f => ({
      name: f.name || 'Unnamed Feed',
      id: f.id,
      upstream: f.upstreamEnabled ? 'Enabled' : 'Disabled',
      role: f.role || 'Contributor'
    }));

    document.getElementById('kpi-1-val').textContent = `${project} (Feeds)`;
    document.getElementById('kpi-2-label').textContent = 'Total Feeds';
    document.getElementById('kpi-2-val').textContent = feeds.length;
    document.getElementById('kpi-3-label').textContent = 'Upstream Feeds';
    document.getElementById('kpi-3-val').textContent = feeds.filter(f => f.upstreamEnabled).length;
    document.getElementById('kpi-4-label').textContent = 'Project Feeds';
    document.getElementById('kpi-4-val').textContent = feeds.filter(f => f.project).length;
    document.getElementById('kpi-5-label').textContent = 'Artifact Scope';
    document.getElementById('kpi-5-val').textContent = 'Active';

    renderArtifactsTable();

    const upstreamCounts = {
      'Upstream Enabled': feeds.filter(f => f.upstreamEnabled).length,
      'Upstream Disabled': feeds.filter(f => !f.upstreamEnabled).length
    };

    renderDualCharts(
      { title: 'Feeds Upstream Configuration', labels: Object.keys(upstreamCounts), data: Object.values(upstreamCounts), type: 'pie' },
      { title: 'Package Feeds by Role', labels: feeds.map(f => f.name), data: feeds.map(() => 1), type: 'bar' }
    );

    setStatus(`Loaded ${feeds.length} package feeds.`, 'success');
  } catch (err) {
    setStatus(`Error fetching artifact feeds: ${err.message}`, 'error');
  }
}

function renderArtifactsTable() {
  const tbody = document.getElementById('artifactsTableBody');
  if (!tbody) return;

  if (rawStore.artifacts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-500">No package feeds found for this project scope.</td></tr>`;
    return;
  }

  tbody.innerHTML = rawStore.artifacts.map(f => `
    <tr class="hover:bg-slate-800/40 transition">
      <td class="p-3.5 font-bold text-slate-200">${f.name}</td>
      <td class="p-3.5 font-mono text-[11px] text-blue-400">${f.id}</td>
      <td class="p-3.5">
        <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${f.upstream === 'Enabled' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-slate-700/50 text-slate-400'}">${f.upstream}</span>
      </td>
      <td class="p-3.5 text-xs text-slate-300">${f.role}</td>
    </tr>
  `).join('');
}

function exportArtifactsToXLSX() {
  const data = (rawStore.artifacts || []).map(f => ({
    "Feed Name": f.name,
    "Feed ID": f.id,
    "Upstream Enabled": f.upstream,
    "User Role": f.role
  }));
  exportToExcelFile({ "Artifact Feeds": data }, "AzureDevOps_Artifacts");
}