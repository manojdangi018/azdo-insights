async function fetchUserActivityData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim();
  const rawQuery = document.getElementById('targetUserQuery').value.trim();
  const rawTimeframe = document.getElementById('userTimeframeDays')?.value;
  const timeframeDays = rawTimeframe !== undefined && rawTimeframe !== '' ? parseInt(rawTimeframe, 10) : 0;

  if (!rawQuery) {
    return showModal('Please enter a User Email or Name to search.', 'targetUserQuery');
  }

  const authHeader = 'Basic ' + btoa(':' + pat);
  showSection('activity');
  startFetching(`Searching complete project activity for "${rawQuery}"...`);

  // Build match tokens (e.g. from "hitesh.bawane@cornerstone-bb.com" -> ["hitesh.bawane", "hitesh", "bawane"])
  const queryLower = rawQuery.toLowerCase();
  const emailPrefix = queryLower.includes('@') ? queryLower.split('@')[0] : queryLower;
  const nameParts = emailPrefix.split(/[\._\-\s]+/).filter(p => p.length >= 2);

  function matchesUser(authorName, authorEmail, committerName, committerEmail) {
    const aName = (authorName || '').toLowerCase();
    const aEmail = (authorEmail || '').toLowerCase();
    const cName = (committerName || '').toLowerCase();
    const cEmail = (committerEmail || '').toLowerCase();

    // 1. Direct match on full query or email prefix
    if (aEmail.includes(queryLower) || cEmail.includes(queryLower) ||
        aName.includes(queryLower) || cName.includes(queryLower) ||
        aEmail.includes(emailPrefix) || cEmail.includes(emailPrefix) ||
        aName.includes(emailPrefix) || cName.includes(emailPrefix)) {
      return true;
    }

    // 2. Tokenized name match (matches "Hitesh" and "Bawane" in display name)
    if (nameParts.length > 0) {
      const allPartsInAuthor = nameParts.every(p => aName.includes(p) || aEmail.includes(p));
      const allPartsInCommitter = nameParts.every(p => cName.includes(p) || cEmail.includes(p));
      if (allPartsInAuthor || allPartsInCommitter) return true;
    }

    return false;
  }

  // Date threshold calculation
  let fromDateIso = null;
  let cutoffDate = null;
  if (timeframeDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() - timeframeDays);
    cutoffDate = d;
    fromDateIso = d.toISOString();
  }

  let userCommits = [];
  let userPRs = [];
  const reposTouched = new Set();

  try {
    // 1. Fetch all repositories in the selected project
    let repos = cachedRepos;
    if (!repos || repos.length === 0) {
      const repoData = await fetchAzDo(
        `https://dev.azure.com/${org}/${project}/_apis/git/repositories?api-version=${API_VERSION}`,
        authHeader
      );
      repos = repoData.value || [];
      cachedRepos = repos;
    }

    if (!repos || repos.length === 0) {
      throw new Error('No Git repositories found in this project.');
    }

    // 2. Scan repositories concurrently in batches
    const BATCH_SIZE = 5;
    for (let i = 0; i < repos.length; i += BATCH_SIZE) {
      const batch = repos.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (r) => {
          // --- FETCH COMMITS ---
          const commitsPromise = (async () => {
            try {
              let url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/commits?$top=2000&api-version=${API_VERSION}`;
              if (fromDateIso) {
                url += `&searchCriteria.fromDate=${encodeURIComponent(fromDateIso)}`;
              }

              const res = await fetchAzDo(url, authHeader);
              const commits = res?.value || [];

              commits.forEach((c) => {
                if (matchesUser(c.author?.name, c.author?.email, c.committer?.name, c.committer?.email)) {
                  const commitDate = new Date(c.author?.date || c.committer?.date);
                  if (!cutoffDate || commitDate >= cutoffDate) {
                    reposTouched.add(r.name);
                    userCommits.push({
                      repo: r.name,
                      branch: r.defaultBranch ? r.defaultBranch.replace(/^refs\/heads\//, '') : 'main',
                      commitId: (c.commitId || '').substring(0, 8),
                      rawDate: commitDate,
                      date: isNaN(commitDate.getTime()) ? 'N/A' : commitDate.toLocaleString(),
                      comment: c.comment || 'No commit message'
                    });
                  }
                }
              });
            } catch (err) {
              console.warn(`Commits fetch error for repo ${r.name}:`, err);
            }
          })();

          // --- FETCH PULL REQUESTS ---
          const prsPromise = (async () => {
            try {
              const prUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/pullrequests?searchCriteria.status=all&$top=1000&api-version=${API_VERSION}`;
              const prRes = await fetchAzDo(prUrl, authHeader);
              const prList = prRes?.value || [];

              prList.forEach((pr) => {
                const creatorEmail = pr.createdBy?.uniqueName || '';
                const creatorName = pr.createdBy?.displayName || '';

                if (matchesUser(creatorName, creatorEmail, null, null)) {
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
            } catch (err) {
              console.warn(`PRs fetch error for repo ${r.name}:`, err);
            }
          })();

          return Promise.all([commitsPromise, prsPromise]);
        })
      );
    }

    // Deduplicate commits
    const seen = new Set();
    userCommits = userCommits.filter((c) => {
      const key = `${c.repo}_${c.commitId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort newest first
    userCommits.sort((a, b) => b.rawDate - a.rawDate);
    userPRs.sort((a, b) => b.rawDate - a.rawDate);

    rawStore.commits = userCommits;
    rawStore.commitsIndex = 0;
    rawStore.repoPrs = userPRs;

    // Update KPIs
    document.getElementById('kpi-1-label').textContent = 'Active Scope';
    document.getElementById('kpi-1-val').textContent = rawQuery;
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
        ? `<tr><td colspan="5" class="p-4 text-center text-slate-400">No pull requests found for "${rawQuery}".</td></tr>`
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
      `Commits by ${rawQuery}`
    );

    stopFetching();
    setStatus(
      `Found ${userCommits.length} commits and ${userPRs.length} PRs across ${reposTouched.size} repositories for "${rawQuery}".`,
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
