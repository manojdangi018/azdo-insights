function populateRepoDropdown() {
  const datalist = document.getElementById('repoDatalist');
  datalist.innerHTML = '';

  const allOpt = document.createElement('option');
  allOpt.value = '-- All Repositories --';
  datalist.appendChild(allOpt);

  cachedRepos.forEach(r => {
    const opt = document.createElement('option');
    opt.value = r.name;
    datalist.appendChild(opt);
  });
  document.getElementById('repoSelect').value = '-- All Repositories --';
}

async function fetchRepositoryData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const rawInput = document.getElementById('repoSelect').value.trim();
  const pat = document.getElementById('targetPat').value.trim();

  if (!rawInput) return showModal('Please select or type a repository name.', 'repoSelect');

  const authHeader = 'Basic ' + btoa(':' + pat);
  showSection('repositories');
  setStatus('Fetching branches and PR telemetry across selected repository...', 'info');

  let targetRepos = cachedRepos;
  if (rawInput !== '-- All Repositories --' && rawInput !== '__ALL__') {
    const exactMatches = cachedRepos.filter(r => r.name.toLowerCase() === rawInput.toLowerCase());
    targetRepos = exactMatches.length > 0 
      ? exactMatches 
      : cachedRepos.filter(r => r.name.toLowerCase().includes(rawInput.toLowerCase()));
  }

  if (targetRepos.length === 0) {
    setStatus(`No repository found matching "${rawInput}".`, 'error');
    return;
  }

  let repoBranchCounts = {};
  let allPRs = [];
  const now = new Date();

  try {
    const repoPromises = targetRepos.map(async (r) => {
      const refsUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/refs?filter=heads/&api-version=${API_VERSION}`;
      const prUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/pullrequests?searchCriteria.status=all&$top=100&api-version=${API_VERSION}`;

      const [refsPromise, prsPromise] = await Promise.allSettled([
        fetchAzDo(refsUrl, authHeader),
        fetchAzDo(prUrl, authHeader)
      ]);

      let branchDetails = [];

      if (refsPromise.status === 'fulfilled' && refsPromise.value) {
        const refs = refsPromise.value.value || [];
        repoBranchCounts[r.name] = refs.length;

        branchDetails = await Promise.all(refs.map(async (ref) => {
          const bName = ref.name.replace(/^refs\/heads\//, '');
          const commitUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/commits?searchCriteria.itemVersion.version=${encodeURIComponent(bName)}&searchCriteria.itemVersion.versionType=branch&$top=1&api-version=${API_VERSION}`;
          const commitData = await fetchAzDo(commitUrl, authHeader);
          const topCommit = (commitData.value && commitData.value[0]) ? commitData.value[0] : null;

          const commitDate = topCommit?.author?.date ? new Date(topCommit.author.date) : null;
          const isStale = commitDate ? ((now - commitDate) / (1000 * 60 * 60 * 24)) > 90 : false;

          return {
            repo: r.name,
            branch: bName,
            author: topCommit?.author?.name || 'Unknown',
            date: commitDate ? commitDate.toLocaleString() : 'N/A',
            isStale: isStale,
            msg: topCommit?.comment || ''
          };
        }));
      }

      if (prsPromise.status === 'fulfilled' && prsPromise.value) {
        const prList = prsPromise.value.value || [];
        prList.forEach(pr => {
          allPRs.push({
            repo: r.name,
            title: pr.title || 'Untitled PR',
            source: (pr.sourceRefName || '').replace('refs/heads/', ''),
            target: (pr.targetRefName || '').replace('refs/heads/', ''),
            creator: pr.createdBy?.displayName || 'Unknown',
            status: pr.status || 'unknown',
            createdDate: pr.creationDate ? new Date(pr.creationDate).toLocaleDateString() : 'N/A'
          });
        });
      }

      return branchDetails;
    });

    const results = await Promise.all(repoPromises);
    rawStore.repos = results.flat();
    rawStore.repoIndex = 0;

    rawStore.repoPrs = allPRs;
    rawStore.repoPrsIndex = 0;

    const activePRsCount = allPRs.filter(p => p.status === 'active').length;
    const completedPRsCount = allPRs.filter(p => p.status === 'completed').length;

    document.getElementById('kpi-1-val').textContent = (targetRepos.length > 1) ? `${project} (${targetRepos.length} Repos)` : targetRepos[0]?.name;
    document.getElementById('kpi-2-label').textContent = 'Total Branches';
    document.getElementById('kpi-2-val').textContent = rawStore.repos.length;
    document.getElementById('kpi-3-label').textContent = 'Stale Branches';
    document.getElementById('kpi-3-val').textContent = rawStore.repos.filter(b => b.isStale).length;
    document.getElementById('kpi-4-label').textContent = 'Active PRs';
    document.getElementById('kpi-4-val').textContent = activePRsCount;
    document.getElementById('kpi-5-label').textContent = 'Completed PRs';
    document.getElementById('kpi-5-val').textContent = completedPRsCount;

    renderRepoTableBatch(false);
    renderRepoPrsTableBatch(false);
    renderChart(Object.keys(repoBranchCounts), Object.values(repoBranchCounts), 'Branches per Repository');
    setStatus(`Loaded ${rawStore.repos.length} branches and ${allPRs.length} pull requests.`, 'success');
  } catch (err) {
    setStatus(`Error fetching branches: ${err.message}`, 'error');
  }
}

function renderRepoTableBatch(append = false) {
  const tbody = document.getElementById('branchesTableBody');
  const container = document.getElementById('seeMoreRepoContainer');
  const remainingEl = document.getElementById('repoRemainingCount');

  if (!append) tbody.innerHTML = '';

  if (rawStore.repos.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400">No branches found.</td></tr>`;
    container.classList.add('hidden');
    return;
  }

  const nextBatch = rawStore.repos.slice(rawStore.repoIndex, rawStore.repoIndex + PAGE_SIZE);
  rawStore.repoIndex += nextBatch.length;

  const html = nextBatch.map(b => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-semibold text-slate-900">${b.repo}</td>
      <td class="p-4"><span class="font-mono text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded font-semibold">${b.branch}</span></td>
      <td class="p-4">${b.isStale 
        ? '<span class="bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full font-semibold">Stale</span>' 
        : '<span class="bg-emerald-100 text-emerald-700 text-xs px-2 py-0.5 rounded-full font-semibold">Active</span>'}
      </td>
      <td class="p-4 text-xs font-medium">${b.author}</td>
      <td class="p-4 text-xs text-slate-500">${b.date}</td>
      <td class="p-4 text-xs text-slate-600 max-w-xs truncate">${b.msg}</td>
    </tr>
  `).join('');

  tbody.insertAdjacentHTML('beforeend', html);

  const remaining = rawStore.repos.length - rawStore.repoIndex;
  if (remaining > 0) {
    container.classList.remove('hidden');
    remainingEl.textContent = remaining;
  } else {
    container.classList.add('hidden');
  }
}

function renderRepoPrsTableBatch(append = false) {
  const tbody = document.getElementById('repoPrsTableBody');
  const container = document.getElementById('seeMoreRepoPrsContainer');
  const remainingEl = document.getElementById('repoPrsRemainingCount');

  if (!append) tbody.innerHTML = '';

  if (rawStore.repoPrs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400">No pull requests found.</td></tr>`;
    container.classList.add('hidden');
    return;
  }

  const nextBatch = rawStore.repoPrs.slice(rawStore.repoPrsIndex, rawStore.repoPrsIndex + PAGE_SIZE);
  rawStore.repoPrsIndex += nextBatch.length;

  const html = nextBatch.map(pr => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-semibold text-slate-900">${pr.repo}</td>
      <td class="p-4 font-medium text-slate-800 max-w-xs truncate">${pr.title}</td>
      <td class="p-4 font-mono text-xs text-slate-500">${pr.source} &rarr; ${pr.target}</td>
      <td class="p-4 text-xs font-medium text-slate-700">${pr.creator}</td>
      <td class="p-4">
        <span class="px-2 py-0.5 rounded-full text-xs font-semibold ${
          pr.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
          pr.status === 'active' ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-600'
        }">${pr.status}</span>
      </td>
      <td class="p-4 text-xs text-slate-500">${pr.createdDate}</td>
    </tr>
  `).join('');

  tbody.insertAdjacentHTML('beforeend', html);

  const remaining = rawStore.repoPrs.length - rawStore.repoPrsIndex;
  if (remaining > 0) {
    container.classList.remove('hidden');
    remainingEl.textContent = remaining;
  } else {
    container.classList.add('hidden');
  }
}

function exportBranchesToXLSX() {
  if (!rawStore.repos || rawStore.repos.length === 0) return;
  const data = rawStore.repos.map(b => ({
    "Repository": b.repo,
    "Branch Name": b.branch,
    "Status / Health": b.isStale ? "Stale" : "Active",
    "Last Author": b.author,
    "Last Commit Date": b.date,
    "Commit Message": b.msg
  }));
  exportToExcelFile({ "Branches": data }, "AzureDevOps_Branches");
}

function exportRepoPrsToXLSX() {
  if (!rawStore.repoPrs || rawStore.repoPrs.length === 0) return;
  const data = rawStore.repoPrs.map(p => ({
    "Repository": p.repo,
    "PR Title": p.title,
    "Source Branch": p.source,
    "Target Branch": p.target,
    "Creator": p.creator,
    "Status": p.status,
    "Created Date": p.createdDate
  }));
  exportToExcelFile({ "Pull Requests": data }, "AzureDevOps_PullRequests");
}