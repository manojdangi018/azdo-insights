async function fetchUserActivityData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim();
  const userQuery = document.getElementById('targetUserQuery').value.trim();
  const rawTimeframe = document.getElementById('userTimeframeDays')?.value;
  const timeframeDays = rawTimeframe !== undefined && rawTimeframe !== '' ? parseInt(rawTimeframe, 10) : 0;

  if (!userQuery) {
    return showModal('Please enter a User Email or Name to search.', 'targetUserQuery');
  }

  const authHeader = 'Basic ' + btoa(':' + pat);
  showSection('activity');
  startFetching(`Searching complete activity history for "${userQuery}"...`);

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
      console.warn('Could not fetch repositories:', e);
    }
  }

  const queryLower = userQuery.toLowerCase();
  const queryNamePart = queryLower.includes('@')
    ? queryLower.split('@')[0].replace(/[\._\-]/g, ' ')
    : queryLower;

  let userCommits = [];
  let userPRs = [];
  const reposTouched = new Set();

  // Date filter: Only calculate if timeframe is strictly greater than 0
  let fromDateIso = null;
  let cutoffDate = null;
  if (timeframeDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() - timeframeDays);
    cutoffDate = d;
    fromDateIso = d.toISOString();
  }

  try {
    const BATCH_SIZE = 4; // Lower batch size to prevent hitting Azure API rate limits
    for (let i = 0; i < reposToScan.length; i += BATCH_SIZE) {
      const batch = reposToScan.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (r) => {
          // 1. Get all branch heads so commits in feature/dev branches are not missed
          let branchNames = [];
          try {
            const refsUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/refs?filter=heads/&api-version=${API_VERSION}`;
            const refsRes = await fetchAzDo(refsUrl, authHeader);
            if (refsRes?.value && refsRes.value.length > 0) {
              branchNames = refsRes.value.map(ref => ref.name.replace(/^refs\/heads\//, ''));
            }
          } catch (e) {
            console.warn(`Could not get branches for ${r.name}`, e);
          }

          if (branchNames.length === 0) {
            branchNames = [r.defaultBranch ? r.defaultBranch.replace(/^refs\/heads\//, '') : 'main'];
          }

          // 2. Fetch Commits across branches
          const commitsPromise = (async () => {
            // Check the main branch first, plus up to 5 other active branches per repo
            const targetBranches = branchNames.slice(0, 6);

            for (const branch of targetBranches) {
              try {
                let skip = 0;
                let fetchMore = true;
                const pageSize = 1000;

                while (fetchMore) {
                  let url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/commits?itemVersion.version=${encodeURIComponent(branch)}&$top=${pageSize}&$skip=${skip}&api-version=${API_VERSION}`;
                  
                  if (fromDateIso) {
                    url += `&searchCriteria.fromDate=${encodeURIComponent(fromDateIso)}`;
                  }

                  const res = await fetchAzDo(url, authHeader);
                  const commits = res?.value || [];

                  if (commits.length === 0) {
                    fetchMore = false;
                    break;
                  }

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
                      (queryNamePart && (authorName.includes(queryNamePart) || committerName.includes(queryNamePart)));

                    if (isMatch) {
                      const commitDate = new Date(c.author?.date || c.committer?.date);

                      if (!cutoffDate || commitDate >= cutoffDate) {
                        reposTouched.add(r.name);
                        userCommits.push({
                          repo: r.name,
                          branch: branch,
                          commitId: (c.commitId || '').substring(0, 8),
                          rawDate: commitDate,
                          date: isNaN(commitDate.getTime()) ? 'N/A' : commitDate.toLocaleString(),
                          comment: c.comment || 'No commit message'
                        });
                      }
                    }
                  });

                  // For All Time, keep fetching older pages if a full page was returned
                  if (commits.length === pageSize && timeframeDays === 0 && skip < 10000) {
                    skip += pageSize;
                  } else {
                    fetchMore = false;
                  }
                }
              } catch (e) {
                // Ignore empty/unreachable branches
              }
            }
          })();

          // 3. Fetch Pull Requests
          const prsPromise = (async () => {
            try {
              let prSkip = 0;
              let fetchMorePrs = true;
              const prTop = 1000;

              while (fetchMorePrs) {
                const url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/pullrequests?searchCriteria.status=all&$top=${prTop}&$skip=${prSkip}&api-version=${API_VERSION}`;
                const res = await fetchAzDo(url, authHeader);
                const prList = res?.value || [];

                if (prList.length === 0) {
                  fetchMorePrs = false;
                  break;
                }

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

                if (prList.length === prTop && timeframeDays === 0 && prSkip < 5000) {
                  prSkip += prTop;
                } else {
                  fetchMorePrs = false;
                }
              }
            } catch (e) {
              console.warn(`PR fetch failed for ${r.name}`, e);
            }
          })();

          return Promise.all([commitsPromise, prsPromise]);
        })
      );
    }

    // Deduplicate commits that exist in multiple branches
    const seenCommits = new Set();
    userCommits = userCommits.filter((c) => {
      const key = `${c.repo}_${c.commitId}`;
      if (seenCommits.has(key)) return false;
      seenCommits.add(key);
      return true;
    });

    // Deduplicate PRs
    const seenPRs = new Set();
    userPRs = userPRs.filter((p) => {
      const key = `${p.repo}_${p.title}_${p.createdDate}`;
      if (seenPRs.has(key)) return false;
      seenPRs.add(key);
      return true;
    });

    // Sort chronologically newest first
    userCommits.sort((a, b) => b.rawDate - a.rawDate);
    userPRs.sort((a, b) => b.rawDate - a.rawDate);

    rawStore.commits = userCommits;
    rawStore.commitsIndex = 0;
    rawStore.repoPrs = userPRs;

    // Update Overview Cards
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
