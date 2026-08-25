async function fetchUserActivityData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim();
  const userQuery = document.getElementById('targetUserQuery').value.trim();
  const timeframeDays = parseInt(document.getElementById('userTimeframeDays').value, 10);

  if (!userQuery) return showModal('Please enter a User Email or Name to search.', 'targetUserQuery');

  const authHeader = 'Basic ' + btoa(':' + pat);
  showSection('activity');
  setStatus(`Scanning commits and PRs across repos in parallel for "${userQuery}"...`, 'info');

  const queryLower = userQuery.toLowerCase();
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
    const fetchPromises = cachedRepos.map(async (r) => {
      const commitsPromise = (async () => {
        try {
          const url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/commits?$top=500${fromDateStr}&api-version=${API_VERSION}`;
          const res = await fetchAzDo(url, authHeader);
          (res.value || []).forEach(c => {
            const email = (c.author?.email || '').toLowerCase();
            const name = (c.author?.name || '').toLowerCase();
            if (email.includes(queryLower) || name.includes(queryLower)) {
              reposTouched.add(r.name);
              userCommits.push({
                repo: r.name,
                commitId: (c.commitId || '').substring(0, 8),
                date: new Date(c.author?.date).toLocaleString(),
                comment: c.comment || ''
              });
            }
          });
        } catch (e) { console.warn(e); }
      })();

      const prsPromise = (async () => {
        try {
          const url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/pullrequests?searchCriteria.status=all&$top=50&api-version=${API_VERSION}`;
          const res = await fetchAzDo(url, authHeader);
          (res.value || []).forEach(pr => {
            const creatorEmail = (pr.createdBy?.uniqueName || '').toLowerCase();
            const creatorName = (pr.createdBy?.displayName || '').toLowerCase();
            if (creatorEmail.includes(queryLower) || creatorName.includes(queryLower)) {
              userPRs.push({
                repo: r.name,
                title: pr.title,
                source: pr.sourceRefName?.replace('refs/heads/', ''),
                target: pr.targetRefName?.replace('refs/heads/', ''),
                status: pr.status,
                createdDate: new Date(pr.creationDate).toLocaleDateString()
              });
            }
          });
        } catch (e) { console.warn(e); }
      })();

      return Promise.all([commitsPromise, prsPromise]);
    });

    await Promise.all(fetchPromises);

    rawStore.commits = userCommits;
    rawStore.commitsIndex = 0;

    document.getElementById('kpi-1-val').textContent = userQuery;
    document.getElementById('kpi-2-label').textContent = 'Active Repos';
    document.getElementById('kpi-2-val').textContent = reposTouched.size;
    document.getElementById('kpi-3-label').textContent = 'Pull Requests';
    document.getElementById('kpi-3-val').textContent = userPRs.length;
    document.getElementById('kpi-4-label').textContent = 'Commits Made';
    document.getElementById('kpi-4-val').textContent = userCommits.length;
    document.getElementById('kpi-5-label').textContent = 'Timeframe';
    document.getElementById('kpi-5-val').textContent = timeframeDays > 0 ? `${timeframeDays} Days` : 'All Time';

    renderCommitsTableBatch(false);

    document.getElementById('userPrTableBody').innerHTML = userPRs.length === 0
      ? `<tr><td colspan="5" class="p-4 text-center text-slate-400">No pull requests found.</td></tr>`
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
    setStatus(`Found ${userCommits.length} commits and ${userPRs.length} PRs.`, 'success');
  } catch (err) {
    setStatus(`Error fetching user activity: ${err.message}`, 'error');
  }
}

function renderCommitsTableBatch(append = false) {
  const tbody = document.getElementById('userCommitsTableBody');
  const container = document.getElementById('seeMoreCommitsContainer');
  const remainingEl = document.getElementById('commitsRemainingCount');

  if (!append) tbody.innerHTML = '';

  if (rawStore.commits.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-400">No commits found.</td></tr>`;
    container.classList.add('hidden');
    return;
  }

  const nextBatch = rawStore.commits.slice(rawStore.commitsIndex, rawStore.commitsIndex + PAGE_SIZE);
  rawStore.commitsIndex += nextBatch.length;

  const html = nextBatch.map(c => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-semibold text-slate-900">${c.repo}</td>
      <td class="p-4 font-mono text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded">${c.commitId}</td>
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