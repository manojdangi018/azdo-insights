async function fetchUserActivityData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim();
  const userQuery = document.getElementById('targetUserQuery').value.trim();
  const rawTimeframe = document.getElementById('userTimeframeDays')?.value;
  const timeframeDays = rawTimeframe ? parseInt(rawTimeframe, 10) : 0;

  if (!userQuery) {
    return showModal('Please enter a User Email or Name to search.', 'targetUserQuery');
  }

  const authHeader = 'Basic ' + btoa(':' + pat);
  showSection('activity');
  startFetching(`Scanning all repositories, branches & commits for "${userQuery}"...`);

  let reposToScan = cachedRepos;
  if (!reposToScan || reposToScan.length === 0) {
    try {
      const repoData = await fetchAzDo(
        `https://dev.azure.com/${org}/${project}/_apis/git/repositories?api-version=${API_VERSION}`,
        authHeader
      );
      reposToScan = repoData.value || [];
      cachedRepos = reposToScan;
    } catch (e) {
      console.warn('Could not fetch repository list:', e);
    }
  }

  const queryLower = userQuery.toLowerCase();
  const queryNamePart = queryLower.includes('@')
    ? queryLower.split('@')[0].replace(/[\._\-]/g, ' ')
    : queryLower;

  let userCommits = [];
  let userPRs = [];
  let reposTouched = new Set();

  // 1. Date Filter: Only apply date cutoff if timeframe > 0 (Skip for "All Time")
  let fromDateStr = '';
  let cutoffDate = null;
  if (timeframeDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() - timeframeDays);
    cutoffDate = d;
    fromDateStr = `&searchCriteria.fromDate=${encodeURIComponent(d.toISOString())}`;
  }

  try {
    const BATCH_SIZE = 6;
    for (let i = 0; i < reposToScan.length; i += BATCH_SIZE) {
      const batch = reposToScan.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (r) => {
          let branches = ['main'];
          try {
            const refsUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/refs?filter=heads/&api-version=${API_VERSION}`;
            const refsData = await fetchAzDo(refsUrl, authHeader);
            if (refsData?.value && refsData.value.length > 0) {
              branches = refsData.value.map((ref) => ref.name.replace(/^refs\/heads\//, ''));
            }
          } catch (e) {
            console.warn(`Branch refs fetch failed for repo ${r.name}:`, e);
          }

          // Commits Scanner with multi-page handling
          const commitsPromise = (async () => {
            try {
              let skip = 0;
              const top = 1000;
              let hasMoreCommits = true;
              const defaultBranchName = r.defaultBranch
                ? r.defaultBranch.replace(/^refs\/heads\//, '')
                : branches[0] || 'main';

              while (hasMoreCommits) {
                const url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/commits?$top=${top}&$skip=${skip}${fromDateStr}&api-version=${API_VERSION}`;
                const res = await fetchAzDo(url, authHeader);
                const commits = res.value || [];

                commits.forEach((c) => {
                  const authorEmail = (c.author?.email || '').toLowerCase();
                  const authorName = (c.author?.name || '').toLowerCase();
                  const committerEmail = (c.committer?.email || '').toLowerCase();
                  const committerName = (c.committer?.name || '').toLowerCase();

                  const isMatch =
                    authorEmail.includes(queryLower) ||
                    authorName.includes(queryLower) ||
                    committerEmail.includes(queryLower) ||
                    committerName.includes(queryLower) ||
                    (queryNamePart &&
                      (authorName.includes(queryNamePart) || committerName.includes(queryNamePart)));

                  if (isMatch) {
                    const commitDate = new Date(c.author?.date || c.committer?.date);

                    // If "All Time" (cutoffDate is null), keep everything; otherwise check threshold
                    if (!cutoffDate || commitDate >= cutoffDate) {
                      reposTouched.add(r.name);
                      userCommits.push({
                        repo: r.name,
                        branch: defaultBranchName,
                        commitId: (c.commitId || '').substring(0, 8),
                        rawDate: commitDate,
                        date: isNaN(commitDate.getTime()) ? 'N/A' : commitDate.toLocaleString(),
                        comment: c.comment || 'No commit message'
                      });
                    }
                  }
                });

                // Continue fetching if full 1000-item page was returned and we're looking across all time
                if (commits.length === top && timeframeDays === 0 && skip < 5000) {
                  skip += top;
                } else {
                  hasMoreCommits = false;
                }
              }
            } catch (e) {
              console.warn(`Commits fetch failed for repo ${r.name}:`, e);
            }
          })();

          // Pull Requests Scanner
          const prsPromise = (async () => {
            try {
              const url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/pullrequests?searchCriteria.status=all&$top=500&api-version=${API_VERSION}`;
              const res = await fetchAzDo(url, authHeader);
              const prList = res.value || [];

              prList.forEach((pr) => {
                const creatorEmail = (pr.createdBy?.uniqueName || '').toLowerCase();
                const creatorName = (pr.createdBy?.displayName || '').toLowerCase();

                const isMatch =
                  creatorEmail.includes(queryLower) ||
                  creatorName.includes(queryLower) ||
                  (queryNamePart && creatorName.includes(queryNamePart));

                if (isMatch) {
                  const prDate = new Date(pr.creationDate);

                  if (!cutoffDate || prDate >= cutoffDate) {
                    reposTouched.add(r.name);
                    userPRs.push({
                      repo: r.name,
                      title: pr.title || 'Untitled PR',
                      source: (pr.sourceRefName || '').replace('refs/heads/', ''),
                      target: (pr.targetRefName || '').replace('refs/heads/', ''),
                      status: pr.status || 'unknown',
                      createdDate: isNaN(prDate.getTime()) ? 'N/A' : prDate.toLocaleDateString(),
                      rawDate: prDate
                    });
                  }
                }
              });
            } catch (e) {
              console.warn(`PRs fetch failed for repo ${r.name}:`, e);
            }
          })();

          return Promise.all([commitsPromise, prsPromise]);
        })
      );
    }

    // Deduplicate commits by repo and commitId
    const seenCommits = new Set();
    userCommits = userCommits.filter((c) => {
      const key = `${c.repo}_${c.commitId}`;
      if (seenCommits.has(key)) return false;
      seenCommits.add(key);
      return true;
    });

    // Sort newest to oldest
    userCommits.sort((a, b) => b.rawDate - a.rawDate);
    userPRs.sort((a, b) => b.rawDate - a.rawDate);

    rawStore.commits = userCommits;
    rawStore.commitsIndex = 0;
    rawStore.repoPrs = userPRs;

    // Update Overview Cards / KPIs
    document.getElementById('kpi-1-label').textContent = 'Active Scope';
    document.getElementById('kpi-1-val').textContent = userQuery;
    document.getElementById('kpi-1-val').className = 'text-2xl font-extrabold text-slate-800 mt-1 truncate';
    document.getElementById('kpi-2-label').textContent = 'Active Repos';
    document.getElementById('kpi-2-val').textContent = reposTouched.size;
    document.getElementById('kpi-3-label').textContent = 'Commits Made';
    document.getElementById('kpi-3-val').textContent = userCommits.length;
    document.getElementById('kpi-4-label').textContent = 'Pull Requests';
    document.getElementById('kpi-4-val').textContent = userPRs.length;
    document.getElementById('kpi-5-label').textContent = 'Status';
    document.getElementById('kpi-5-val').textContent = userCommits.length > 0 ? 'Active' : 'No Commits';

    renderCommitsTableBatch(false);

    document.getElementById('userPrTableBody').innerHTML =
      userPRs.length === 0
        ? `<tr><td colspan="5" class="p-4 text-center text-slate-400">No pull requests found for "${userQuery}".</td></tr>`
        : userPRs
            .map(
              (pr) => `
          <tr class="hover:bg-slate-50 transition">
            <td class="p-4 font-semibold text-slate-900">${pr.repo}</td>
            <td class="p-4 font-medium text-slate-800">${pr.title}</td>
            <td class="p-4 font-mono text-xs text-slate-500">${pr.source} &rarr; ${pr.target}</td>
            <td class="p-4"><span class="px-2 py-0.5 rounded-full text-xs font-semibold ${
              pr.status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'
            }">${pr.status}</span></td>
            <td class="p-4 text-xs text-slate-500">${pr.createdDate}</td>
          </tr>
        `
            )
            .join('');

    const repoCommitMap = {};
    userCommits.forEach((c) => {
      repoCommitMap[c.repo] = (repoCommitMap[c.repo] || 0) + 1;
    });

    renderChart(
      Object.keys(repoCommitMap),
      Object.values(repoCommitMap),
      `Commits by ${userQuery}`
    );

    stopFetching();
    setStatus(
      `Found ${userCommits.length} commits and ${userPRs.length} PRs across ${reposTouched.size} repositories for "${userQuery}".`,
      'success'
    );
  } catch (err) {
    stopFetching();
    setStatus(`Error fetching user activity: ${err.message}`, 'error');
  }
}

function renderCommitsTableBatch(append = false) {
  const tbody = document.getElementById('userCommitsTableBody');
  const container = document.getElementById('seeMoreCommitsContainer');
  const remainingEl = document.getElementById('commitsRemainingCount');

  if (!append) tbody.innerHTML = '';

  if (rawStore.commits.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-400">No commits found for selected timeframe.</td></tr>`;
    if (container) container.classList.add('hidden');
    return;
  }

  const nextBatch = rawStore.commits.slice(
    rawStore.commitsIndex,
    rawStore.commitsIndex + PAGE_SIZE
  );
  rawStore.commitsIndex += nextBatch.length;

  const html = nextBatch
    .map(
      (c) => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-semibold text-slate-900">${c.repo}</td>
      <td class="p-4"><span class="font-mono text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded font-semibold">${c.branch}</span></td>
      <td class="p-4 font-mono text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded font-semibold">${c.commitId}</td>
      <td class="p-4 text-xs text-slate-500">${c.date}</td>
      <td class="p-4 text-xs text-slate-700">${c.comment}</td>
    </tr>
  `
    )
    .join('');

  tbody.insertAdjacentHTML('beforeend', html);

  const remaining = rawStore.commits.length - rawStore.commitsIndex;
  if (remaining > 0) {
    if (container) container.classList.remove('hidden');
    if (remainingEl) remainingEl.textContent = remaining;
  } else {
    if (container) container.classList.add('hidden');
  }
}
