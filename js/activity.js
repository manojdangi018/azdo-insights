async function fetchUserActivityData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim();
  const userQuery = document.getElementById('targetUserQuery').value.trim();
  const timeframeDays = parseInt(document.getElementById('userTimeframeDays').value, 10);

  if (!userQuery) return showModal('Please enter a User Email or Name to search.', 'targetUserQuery');

  const authHeader = 'Basic ' + btoa(':' + pat);
  showSection('activity');
  startFetching(`Scanning all repositories, branches & commits for "${userQuery}"...`);

  let reposToScan = cachedRepos;
  if (!reposToScan || reposToScan.length === 0) {
    try {
      const repoData = await fetchAzDo(`https://dev.azure.com/${org}/${project}/_apis/git/repositories?api-version=${API_VERSION}`, authHeader);
      reposToScan = repoData.value || [];
      cachedRepos = reposToScan;
    } catch(e) {}
  }

  const queryLower = userQuery.toLowerCase();
  const queryNamePart = queryLower.includes('@') ? queryLower.split('@')[0].replace(/[\._\-]/g, ' ') : queryLower;
  
  let userCommits = [];
  let userPRs = [];
  let reposTouched = new Set();

  let fromDateStr = '';
  if (timeframeDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() - timeframeDays);
    fromDateStr = `&searchCriteria.fromDate=${encodeURIComponent(d.toISOString())}`;
  }

  try {
    const BATCH_SIZE = 6;
    for (let i = 0; i < reposToScan.length; i += BATCH_SIZE) {
      const batch = reposToScan.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (r) => {
        let branches = ['main'];
        try {
          const refsUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/refs?filter=heads/&api-version=${API_VERSION}`;
          const refsData = await fetchAzDo(refsUrl, authHeader);
          if (refsData?.value && refsData.value.length > 0) {
            branches = refsData.value.map(ref => ref.name.replace(/^refs\/heads\//, ''));
          }
        } catch(e){}

        const commitsPromise = (async () => {
          try {
            const url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/commits?$top=1000${fromDateStr}&api-version=${API_VERSION}`;
            const res = await fetchAzDo(url, authHeader);
            
            (res.value || []).forEach(c => {
              const authorEmail = (c.author?.email || '').toLowerCase();
              const authorName = (c.author?.name || '').toLowerCase();
              const committerEmail = (c.committer?.email || '').toLowerCase();
              const committerName = (c.committer?.name || '').toLowerCase();

              const isMatch = authorEmail.includes(queryLower) || 
                              authorName.includes(queryLower) || 
                              committerEmail.includes(queryLower) || 
                              committerName.includes(queryLower) ||
                              (queryNamePart && (authorName.includes(queryNamePart) || committerName.includes(queryNamePart)));

              if (isMatch) {
                reposTouched.add(r.name);
                userCommits.push({
                  repo: r.name,
                  branch: (r.defaultBranch ? r.defaultBranch.replace(/^refs\/heads\//, '') : (branches[0] || 'main')),
                  commitId: (c.commitId || '').substring(0, 8),
                  date: c.author?.date ? new Date(c.author.date).toLocaleString() : 'N/A',
                  comment: c.comment || ''
                });
              }
            });
          } catch (e) {
            console.warn(`Commits fetch failed for repo ${r.name}:`, e);
          }
        })();

        const prsPromise = (async () => {
          try {
            const url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/pullrequests?searchCriteria.status=all&$top=200&api-version=${API_VERSION}`;
            const res = await fetchAzDo(url, authHeader);
            (res.value || []).forEach(pr => {
              const creatorEmail = (pr.createdBy?.uniqueName || '').toLowerCase();
              const creatorName = (pr.createdBy?.displayName || '').toLowerCase();
              
              const isMatch = creatorEmail.includes(queryLower) || 
                              creatorName.includes(queryLower) ||
                              (queryNamePart && creatorName.includes(queryNamePart));

              if (isMatch) {
                reposTouched.add(r.name);
                userPRs.push({
                  repo: r.name,
                  title: pr.title || 'Untitled PR',
                  source: (pr.sourceRefName || '').replace('refs/heads/', ''),
                  target: (pr.targetRefName || '').replace('refs/heads/', ''),
                  status: pr.status || 'unknown',
                  createdDate: pr.creationDate ? new Date(pr.creationDate).toLocaleDateString() : 'N/A'
                });
              }
            });
          } catch (e) {
            console.warn(`PRs fetch failed for repo ${r.name}:`, e);
          }
        })();

        return Promise.all([commitsPromise, prsPromise]);
      }));
    }

    const seenCommits = new Set();
    userCommits = userCommits.filter(c => {
      const k = `${c.repo}_${c.commitId}`;
      if (seenCommits.has(k)) return false;
      seenCommits.add(k);
      return true;
    });

    rawStore.commits = userCommits;
    rawStore.commitsIndex = 0;

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

    document.getElementById('userPrTableBody').innerHTML = userPRs.length === 0
      ? `<tr><td colspan="5" class="p-4 text-center text-slate-400">No pull requests found for "${userQuery}".</td></tr>`
      : userPRs.map(pr => `
          <tr class="hover:bg-slate-50 transition">
            <td class="p-4 font-semibold text-slate-900">${pr.repo}</td>
            <td class="p-4 font-medium text-slate-800">${pr.title}</td>
            <td class="p-4 font-mono text-xs text-slate-500">${pr.source} &rarr; ${pr.target}</td>
            <td class="p-4"><span class="px-2 py-0.5 rounded-full text-xs font-semibold ${pr.status === 'completed' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}">${pr.status}</span></td>
            <td class="p-4 text-xs text-slate-500">${pr.createdDate}</td>
          </tr>
        `).join('');

    const repoCommitMap = {};
    userCommits.forEach(c => repoCommitMap[c.repo] = (repoCommitMap[c.repo] || 0) + 1);
    renderChart(Object.keys(repoCommitMap), Object.values(repoCommitMap), `Commits by ${userQuery}`);
    stopFetching();


    setStatus(`Found ${userCommits.length} commits and ${userPRs.length} PRs for "${userQuery}".`, 'success');

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
    container.classList.add('hidden');
    return;
  }

  const nextBatch = rawStore.commits.slice(rawStore.commitsIndex, rawStore.commitsIndex + PAGE_SIZE);
  rawStore.commitsIndex += nextBatch.length;

  const html = nextBatch.map(c => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-semibold text-slate-900">${c.repo}</td>
      <td class="p-4"><span class="font-mono text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded font-semibold">${c.branch}</span></td>
      <td class="p-4 font-mono text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded font-semibold">${c.commitId}</td>
      <td class="p-4 text-xs text-slate-500">${c.date}</td>
      <td class="p-4 text-xs text-slate-700">${c.comment}</td>
    </tr>
  `).join('');

  tbody.insertAdjacentHTML('beforeend', html);

  const remaining = rawStore.commits.length - rawStore.commitsIndex;
  if (remaining > 0) {
    container.classList.remove('hidden');
    remainingEl.textContent = remaining;
  } else {
    container.classList.add('hidden');
  }
}