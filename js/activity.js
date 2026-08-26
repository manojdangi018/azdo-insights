async function resolveAzureIdentity(org, query, authHeader) {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(query)) return query;
  try {
    const url = `https://vssps.dev.azure.com/${encodeURIComponent(org)}/_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(query)}&queryMembership=None&api-version=7.1-preview.1`;
    const data = await fetchAzDo(url, authHeader);
    return data.value?.[0]?.id || null;
  } catch (_) { return null; }
}

async function fetchUserActivityData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim() || sessionStorage.getItem('azdo_pat') || '';
  const user = document.getElementById('targetUserQuery').value.trim();
  const days = Number(document.getElementById('userTimeframeDays').value || 90);
  if (!org || !project) return showModal('Select an organization and project first.', 'projectSelect');
  if (!pat) return showModal('Enter a PAT before searching user activity.', 'targetPat');
  if (!user) return showModal('Enter a user email, display name, or identity ID.', 'targetUserQuery');

  showSection('activity');
  setStatus(`Searching activity for "${user}"...`, 'info');
  const authHeader = buildAuthHeader(pat);
  const fromDate = days > 0 ? new Date(Date.now() - days * 86400000).toISOString() : null;

  try {
    const repos = cachedRepos.length ? cachedRepos : (await fetchAzDo(`https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories?api-version=${API_VERSION}`, authHeader)).value || [];
    const commitRows = [];
    const userPrs = [];
    const normalized = user.toLowerCase();
    const identityId = await resolveAzureIdentity(org, user, authHeader);

    await Promise.all(repos.map(async repo => {
      const commitUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo.id)}/commits?searchCriteria.author=${encodeURIComponent(user)}&$top=100&api-version=${API_VERSION}`;
      try {
        const data = await fetchAzDo(commitUrl, authHeader);
        (data.value || []).forEach(commit => {
          const date = commit.author?.date ? new Date(commit.author.date) : null;
          const authorText = `${commit.author?.name || ''} ${commit.author?.email || ''}`.toLowerCase();
          if (normalized && !authorText.includes(normalized) && commit.author?.name !== user && commit.author?.email !== user) return;
          if (fromDate && date && date < new Date(fromDate)) return;
          commitRows.push({ repo: repo.name, commitId: String(commit.commitId || '').slice(0, 12), date: date ? date.toLocaleString() : 'N/A', comment: commit.comment || '' });
        });
      } catch (_) { /* skip repository-level errors */ }

      try {
        const base = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo.id)}/pullrequests?searchCriteria.status=all&$top=100&api-version=${API_VERSION}`;
        const data = await fetchAzDo(base, authHeader);
        (data.value || []).forEach(pr => {
          const creatorId = pr.createdBy?.id;
          const creatorText = `${pr.createdBy?.displayName || ''} ${pr.createdBy?.uniqueName || ''} ${pr.createdBy?.mail || ''}`.toLowerCase();
          const matches = identityId ? creatorId === identityId : creatorText.includes(normalized);
          const created = pr.creationDate ? new Date(pr.creationDate) : null;
          if (!matches || (fromDate && created && created < new Date(fromDate))) return;
          userPrs.push({ repo: repo.name, title: pr.title || 'Untitled PR', source: String(pr.sourceRefName || '').replace('refs/heads/', ''), target: String(pr.targetRefName || '').replace('refs/heads/', ''), status: pr.status || 'unknown', createdDate: created ? created.toLocaleDateString() : 'N/A' });
        });
      } catch (_) { /* skip repository-level errors */ }
    }));

    rawStore.commits = commitRows.sort((a,b) => new Date(b.date) - new Date(a.date));
    rawStore.commitsIndex = 0;
    rawStore.userPrs = userPrs.sort((a,b) => new Date(b.createdDate) - new Date(a.createdDate));

    const activePRs = rawStore.userPrs.filter(pr => pr.status === 'active').length;
    setKpis(user, [
      { label: 'Commits found', value: rawStore.commits.length },
      { label: 'Authored PRs', value: rawStore.userPrs.length },
      { label: 'Active PRs', value: activePRs },
      { label: 'Repositories', value: new Set([...rawStore.commits.map(c => c.repo), ...rawStore.userPrs.map(p => p.repo)]).size }
    ]);
    renderCommitsTableBatch(false);
    renderUserPrTable();
    const repoCounts = {};
    rawStore.commits.forEach(commit => { repoCounts[commit.repo] = (repoCounts[commit.repo] || 0) + 1; });
    renderChart(Object.keys(repoCounts), Object.values(repoCounts), 'Commits by repository');
    setStatus(`Found ${rawStore.commits.length.toLocaleString()} commits and ${rawStore.userPrs.length.toLocaleString()} authored pull requests.`, 'success');
  } catch (err) {
    setStatus(`User activity search failed: ${err.message}`, 'error');
  }
}

function renderCommitsTableBatch(append = false) {
  const tbody = document.getElementById('userCommitsTableBody');
  const container = document.getElementById('seeMoreCommitsContainer');
  const remaining = document.getElementById('commitsRemainingCount');
  if (!append) tbody.innerHTML = '';
  if (!rawStore.commits.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-row">No commits matched the selected user and timeframe.</td></tr>';
    container.classList.add('hidden');
    renderUserPrTable();
    return;
  }
  const batch = rawStore.commits.slice(rawStore.commitsIndex, rawStore.commitsIndex + PAGE_SIZE);
  rawStore.commitsIndex += batch.length;
  tbody.insertAdjacentHTML('beforeend', batch.map(commit => `
    <tr><td><strong class="text-slate-900">${escapeHtml(commit.repo)}</strong></td><td><span class="font-mono text-[10px] text-blue-700">${escapeHtml(commit.commitId)}</span></td><td>${escapeHtml(commit.date)}</td><td class="max-w-[480px] truncate" title="${escapeHtml(commit.comment)}">${escapeHtml(commit.comment || '—')}</td></tr>`).join(''));
  const count = rawStore.commits.length - rawStore.commitsIndex;
  remaining.textContent = count.toLocaleString();
  container.classList.toggle('hidden', count <= 0);
}

function renderUserPrTable() {
  const tbody = document.getElementById('userPrTableBody');
  tbody.innerHTML = rawStore.userPrs.length ? rawStore.userPrs.map(pr => `
    <tr><td><strong class="text-slate-900">${escapeHtml(pr.repo)}</strong></td><td>${escapeHtml(pr.title)}</td><td class="font-mono text-[10px]">${escapeHtml(pr.source)} → ${escapeHtml(pr.target)}</td><td><span class="status-pill ${statusClass(pr.status)}">${escapeHtml(pr.status)}</span></td><td>${escapeHtml(pr.createdDate)}</td></tr>`).join('') : '<tr><td colspan="5" class="empty-row">No authored pull requests found.</td></tr>';
}
