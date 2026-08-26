function populateRepoDropdown() {
  const datalist = document.getElementById('repoDatalist');
  datalist.innerHTML = '';
  const all = document.createElement('option');
  all.value = '-- All Repositories --';
  datalist.appendChild(all);
  cachedRepos.forEach(repo => {
    const option = document.createElement('option');
    option.value = repo.name;
    datalist.appendChild(option);
  });
  document.getElementById('repoSelect').value = '-- All Repositories --';
}

async function fetchRepositoryData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const rawInput = document.getElementById('repoSelect').value.trim();
  const pat = document.getElementById('targetPat').value.trim() || sessionStorage.getItem('azdo_pat') || '';

  if (!org || !project) return showModal('Select an organization and project first.', 'projectSelect');
  if (!pat) return showModal('Enter a PAT before inspecting repository data.', 'targetPat');
  if (!rawInput) return showModal('Select all repositories or type a repository name.', 'repoSelect');

  const authHeader = buildAuthHeader(pat);
  showSection('repositories');
  setStatus('Scanning branches and pull requests. This may take a moment for projects with many branches...', 'info');

  let targetRepos = cachedRepos;
  if (rawInput !== '-- All Repositories --' && rawInput !== '__ALL__') {
    targetRepos = cachedRepos.filter(repo => repo.name.toLowerCase() === rawInput.toLowerCase());
    if (!targetRepos.length) targetRepos = cachedRepos.filter(repo => repo.name.toLowerCase().includes(rawInput.toLowerCase()));
  }
  if (!targetRepos.length) return setStatus(`No repository found matching "${rawInput}".`, 'error');

  const branchCounts = {};
  const allPRs = [];
  const now = Date.now();
  const repoResults = [];

  try {
    for (const repo of targetRepos) {
      const refsUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo.id)}/refs?filter=heads/&api-version=${API_VERSION}`;
      const prUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo.id)}/pullrequests?searchCriteria.status=all&$top=100&api-version=${API_VERSION}`;
      const [refsResult, prsResult] = await Promise.allSettled([fetchAzDo(refsUrl, authHeader), fetchAzDo(prUrl, authHeader)]);

      const refs = refsResult.status === 'fulfilled' ? (refsResult.value.value || []) : [];
      branchCounts[repo.name] = refs.length;
      const branchDetails = [];

      // Keep branch commit requests concurrent within each repository.
      const branchPromises = refs.map(async ref => {
        const branch = String(ref.name || '').replace(/^refs\/heads\//, '');
        const commitUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo.id)}/commits?searchCriteria.itemVersion.version=${encodeURIComponent(branch)}&searchCriteria.itemVersion.versionType=branch&$top=1&api-version=${API_VERSION}`;
        try {
          const commitData = await fetchAzDo(commitUrl, authHeader);
          const commit = commitData.value?.[0] || null;
          const commitDate = commit?.author?.date ? new Date(commit.author.date) : null;
          const stale = commitDate ? ((now - commitDate.getTime()) / 86400000) > 90 : false;
          return { repo: repo.name, branch, author: commit?.author?.name || 'Unknown', date: commitDate ? commitDate.toLocaleString() : 'N/A', isStale: stale, msg: commit?.comment || '' };
        } catch (_) {
          return { repo: repo.name, branch, author: 'Unavailable', date: 'N/A', isStale: false, msg: 'Commit details unavailable' };
        }
      });
      branchDetails.push(...await Promise.all(branchPromises));
      repoResults.push(...branchDetails);

      if (prsResult.status === 'fulfilled') {
        (prsResult.value.value || []).forEach(pr => {
          allPRs.push({
            repo: repo.name,
            title: pr.title || 'Untitled PR',
            source: String(pr.sourceRefName || '').replace('refs/heads/', ''),
            target: String(pr.targetRefName || '').replace('refs/heads/', ''),
            creator: normalizeDisplayName(pr.createdBy),
            status: pr.status || 'unknown',
            createdDate: pr.creationDate ? new Date(pr.creationDate).toLocaleDateString() : 'N/A'
          });
        });
      }
    }

    rawStore.repos = repoResults;
    rawStore.repoIndex = 0;
    rawStore.repoPrs = allPRs;
    rawStore.repoPrsIndex = 0;

    const stale = repoResults.filter(branch => branch.isStale).length;
    const activePRs = allPRs.filter(pr => pr.status === 'active').length;
    const completedPRs = allPRs.filter(pr => pr.status === 'completed').length;
    const scope = targetRepos.length === 1 ? targetRepos[0].name : `${targetRepos.length} repositories`;

    setKpis(scope, [
      { label: 'Total branches', value: repoResults.length },
      { label: 'Stale branches', value: stale },
      { label: 'Active PRs', value: activePRs },
      { label: 'Completed PRs', value: completedPRs }
    ]);
    renderRepoTableBatch(false);
    renderRepoPrsTableBatch(false);
    renderChart(Object.keys(branchCounts), Object.values(branchCounts), 'Branches per repository');
    setStatus(`Loaded ${repoResults.length.toLocaleString()} branches and ${allPRs.length.toLocaleString()} pull requests.`, 'success');
  } catch (err) {
    setStatus(`Repository scan failed: ${err.message}`, 'error');
  }
}

function renderRepoTableBatch(append = false) {
  const tbody = document.getElementById('branchesTableBody');
  const container = document.getElementById('seeMoreRepoContainer');
  const remaining = document.getElementById('repoRemainingCount');
  if (!append) tbody.innerHTML = '';
  if (!rawStore.repos.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No branch data found.</td></tr>';
    container.classList.add('hidden');
    return;
  }
  const batch = rawStore.repos.slice(rawStore.repoIndex, rawStore.repoIndex + PAGE_SIZE);
  rawStore.repoIndex += batch.length;
  tbody.insertAdjacentHTML('beforeend', batch.map(branch => `
    <tr>
      <td><strong class="text-slate-900">${escapeHtml(branch.repo)}</strong></td>
      <td><span class="font-mono text-[10px] text-blue-700 bg-blue-50 px-2 py-1 rounded">${escapeHtml(branch.branch)}</span></td>
      <td><span class="status-pill ${branch.isStale ? 'warning' : 'success'}">${branch.isStale ? 'Stale' : 'Active'}</span></td>
      <td>${escapeHtml(branch.author)}</td><td>${escapeHtml(branch.date)}</td>
      <td class="max-w-[360px] truncate" title="${escapeHtml(branch.msg)}">${escapeHtml(branch.msg || '—')}</td>
    </tr>`).join(''));
  const count = rawStore.repos.length - rawStore.repoIndex;
  remaining.textContent = count.toLocaleString();
  container.classList.toggle('hidden', count <= 0);
}

function renderRepoPrsTableBatch(append = false) {
  const tbody = document.getElementById('repoPrsTableBody');
  const container = document.getElementById('seeMoreRepoPrsContainer');
  const remaining = document.getElementById('repoPrsRemainingCount');
  if (!append) tbody.innerHTML = '';
  if (!rawStore.repoPrs.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-row">No pull requests found.</td></tr>';
    container.classList.add('hidden');
    return;
  }
  const batch = rawStore.repoPrs.slice(rawStore.repoPrsIndex, rawStore.repoPrsIndex + PAGE_SIZE);
  rawStore.repoPrsIndex += batch.length;
  tbody.insertAdjacentHTML('beforeend', batch.map(pr => `
    <tr><td><strong class="text-slate-900">${escapeHtml(pr.repo)}</strong></td><td class="max-w-[300px] truncate" title="${escapeHtml(pr.title)}">${escapeHtml(pr.title)}</td><td class="font-mono text-[10px]">${escapeHtml(pr.source)} → ${escapeHtml(pr.target)}</td><td>${escapeHtml(pr.creator)}</td><td><span class="status-pill ${statusClass(pr.status)}">${escapeHtml(pr.status)}</span></td><td>${escapeHtml(pr.createdDate)}</td></tr>`).join(''));
  const count = rawStore.repoPrs.length - rawStore.repoPrsIndex;
  remaining.textContent = count.toLocaleString();
  container.classList.toggle('hidden', count <= 0);
}

function exportBranchesToXLSX() {
  exportToExcelFile({ Branches: rawStore.repos.map(branch => ({ Repository: branch.repo, 'Branch Name': branch.branch, Health: branch.isStale ? 'Stale' : 'Active', 'Last Author': branch.author, 'Last Commit Date': branch.date, 'Commit Message': branch.msg })) }, 'AzureDevOps_Branches');
}

function exportRepoPrsToXLSX() {
  exportToExcelFile({ 'Pull Requests': rawStore.repoPrs.map(pr => ({ Repository: pr.repo, 'PR Title': pr.title, 'Source Branch': pr.source, 'Target Branch': pr.target, Creator: pr.creator, Status: pr.status, 'Created Date': pr.createdDate })) }, 'AzureDevOps_PullRequests');
}
