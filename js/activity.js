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
  startFetching(`Searching complete lifetime activity for "${rawQuery}"...`);

  // Parse search terms and query aliases
  const queryLower = rawQuery.toLowerCase();
  const emailPrefix = queryLower.includes('@') ? queryLower.split('@')[0] : queryLower;
  const nameTokens = emailPrefix.split(/[\._\-\s]+/).filter(t => t.length >= 2);

  let targetDisplayName = '';
  let targetUniqueName = queryLower;
  let userCreatedDate = null;

  // 1. Resolve User Profile & Join/Created Date from Azure DevOps Graph/Entitlements
  try {
    const userEntitleUrl = `https://vsaex.dev.azure.com/${org}/_apis/userentitlements?$filter=name eq '${encodeURIComponent(rawQuery)}' or email eq '${encodeURIComponent(rawQuery)}'&api-version=7.1-preview.3`;
    const userEntitleRes = await fetchAzDo(userEntitleUrl, authHeader).catch(() => null);
    
    if (userEntitleRes?.members && userEntitleRes.members.length > 0) {
      const member = userEntitleRes.members[0];
      targetDisplayName = member.user?.displayName || '';
      targetUniqueName = (member.user?.uniqueName || member.user?.mailAddress || queryLower).toLowerCase();
      userCreatedDate = member.dateCreated ? new Date(member.dateCreated) : (member.lastAccessedDate ? new Date(member.lastAccessedDate) : null);
    }
  } catch (e) {
    console.warn('Could not retrieve user entitlement metadata:', e);
  }

  // Matching helper function across Git commit signatures and PR objects
  function isUserMatch(name, email) {
    const n = (name || '').toLowerCase();
    const e = (email || '').toLowerCase();

    if (e.includes(queryLower) || n.includes(queryLower) ||
        e.includes(emailPrefix) || n.includes(emailPrefix) ||
        (targetDisplayName && n.includes(targetDisplayName.toLowerCase())) ||
        (targetUniqueName && e.includes(targetUniqueName))) {
      return true;
    }

    if (nameTokens.length > 0) {
      const matchName = nameTokens.every(token => n.includes(token) || e.includes(token));
      if (matchName) return true;
    }

    return false;
  }

  // Date filtering: Only set if timeframe > 0 (0 = Lifetime / All Time)
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
  let earliestActivityDate = userCreatedDate;

  try {
    // 2. Fetch all repositories in the selected project
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

    // 3. Scan repositories in parallel batches
    const BATCH_SIZE = 4;
    for (let i = 0; i < repos.length; i += BATCH_SIZE) {
      const batch = repos.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (r) => {
          // --- FETCH COMMITS (ALL TIME PAGINATION) ---
          const commitsPromise = (async () => {
            try {
              let skip = 0;
              let keepFetching = true;
              const top = 1000;

              while (keepFetching) {
                let url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/commits?$top=${top}&$skip=${skip}&api-version=${API_VERSION}`;
                if (fromDateIso) {
                  url += `&searchCriteria.fromDate=${encodeURIComponent(fromDateIso)}`;
                }

                const res = await fetchAzDo(url, authHeader);
                const commits = res?.value || [];

                if (commits.length === 0) {
                  keepFetching = false;
                  break;
                }

                commits.forEach((c) => {
                  const authorMatch = isUserMatch(c.author?.name, c.author?.email);
                  const committerMatch = isUserMatch(c.committer?.name, c.committer?.email);

                  if (authorMatch || committerMatch) {
                    const commitDate = new Date(c.author?.date || c.committer?.date);

                    if (!cutoffDate || commitDate >= cutoffDate) {
                      reposTouched.add(r.name);
                      
                      if (!earliestActivityDate || commitDate < earliestActivityDate) {
                        earliestActivityDate = commitDate;
                      }

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

                // Continue pagination if searching all time
                if (commits.length === top && timeframeDays === 0 && skip < 10000) {
                  skip += top;
                } else {
                  keepFetching = false;
                }
              }
            } catch (err) {
              console.warn(`Commits fetch skipped for repo ${r.name}:`, err);
            }
          })();

          // --- FETCH PULL REQUESTS (CREATED + REVIEWED) ---
          const prsPromise = (async () => {
            try {
              let prSkip = 0;
              let keepPrFetching = true;
              const prTop = 1000;

              while (keepPrFetching) {
                const prUrl = `https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/pullrequests?searchCriteria.status=all&$top=${prTop}&$skip=${prSkip}&api-version=${API_VERSION}`;
                const prRes = await fetchAzDo(prUrl, authHeader);
                const prList = prRes?.value || [];

                if (prList.length === 0) {
                  keepPrFetching = false;
                  break;
                }

                prList.forEach((pr) => {
                  const creatorMatch = isUserMatch(pr.createdBy?.displayName, pr.createdBy?.uniqueName);
                  const reviewerMatch = (pr.reviewers || []).some(rev => isUserMatch(rev.displayName, rev.uniqueName));

                  if (creatorMatch || reviewerMatch) {
                    const prDate = new Date(pr.creationDate);

                    if (!cutoffDate || prDate >= cutoffDate) {
                      reposTouched.add(r.name);
                      
                      if (!earliestActivityDate || prDate < earliestActivityDate) {
                        earliestActivityDate = prDate;
                      }

                      userPRs.push({
                        repo: r.name,
                        title: pr.title || 'Untitled PR',
                        source: (pr.sourceRefName || '').replace('refs/heads/', ''),
                        target: (pr.targetRefName || '').replace('refs/heads/', ''),
                        status: pr.status || 'unknown',
                        role: creatorMatch ? 'Author' : 'Reviewer',
                        createdDate: isNaN(prDate.getTime()) ? 'N/A' : prDate.toLocaleDateString(),
                        rawDate: prDate
                      });
                    }
                  }
                });

                if (prList.length === prTop && timeframeDays === 0 && prSkip < 5000) {
                  prSkip += prTop;
                } else {
                  keepPrFetching = false;
                }
              }
            } catch (err) {
              console.warn(`PR fetch skipped for repo ${r.name}:`, err);
            }
          })();

          return Promise.all([commitsPromise, prsPromise]);
        })
      );
    }

    // Deduplicate commits & PRs
    const seenCommits = new Set();
    userCommits = userCommits.filter((c) => {
      const key = `${c.repo}_${c.commitId}`;
      if (seenCommits.has(key)) return false;
      seenCommits.add(key);
      return true;
    });

    const seenPrs = new Set();
    userPRs = userPRs.filter((p) => {
      const key = `${p.repo}_${p.title}_${p.createdDate}`;
      if (seenPrs.has(key)) return false;
      seenPrs.add(key);
      return true;
    });

    // Chronological Sort: Newest to Oldest
    userCommits.sort((a, b) => b.rawDate - a.rawDate);
    userPRs.sort((a, b) => b.rawDate - a.rawDate);

    rawStore.commits = userCommits;
    rawStore.commitsIndex = 0;
    rawStore.repoPrs = userPRs;

    // Update KPIs & Metadata
    document.getElementById('kpi-1-label').textContent = 'Active Scope';
    document.getElementById('kpi-1-val').textContent = targetDisplayName || rawQuery;
    document.getElementById('kpi-1-val').className = 'text-2xl font-extrabold text-slate-800 mt-1 truncate';
    
    document.getElementById('kpi-2-label').textContent = 'Active Repos';
    document.getElementById('kpi-2-val').textContent = reposTouched.size;
    
    document.getElementById('kpi-3-label').textContent = 'Commits Made';
    document.getElementById('kpi-3-val').textContent = userCommits.length;
    
    document.getElementById('kpi-4-label').textContent = 'Pull Requests';
    document.getElementById('kpi-4-val').textContent = userPRs.length;
    
    document.getElementById('kpi-5-label').textContent = earliestActivityDate ? 'Member Since' : 'Status';
    document.getElementById('kpi-5-val').textContent = earliestActivityDate 
      ? new Date(earliestActivityDate).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })
      : (userCommits.length > 0 ? 'Active' : 'No Commits');

    renderCommitsTableBatch(false);

    document.getElementById('userPrTableBody').innerHTML =
      userPRs.length === 0
        ? `<tr><td colspan="5" class="p-4 text-center text-slate-400">No pull requests found for "${rawQuery}".</td></tr>`
        : userPRs
            .map(
              (pr) => `
          <tr class="hover:bg-slate-50 transition">
            <td class="p-4 font-semibold text-slate-900">${pr.repo}</td>
            <td class="p-4 font-medium text-slate-800">
              ${pr.title}
              <span class="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded ${pr.role === 'Author' ? 'bg-cyan-100 text-cyan-800' : 'bg-purple-100 text-purple-800'}">${pr.role}</span>
            </td>
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
      `Lifetime Commits by ${targetDisplayName || rawQuery}`
    );

    stopFetching();
    setStatus(
      `Found ${userCommits.length} commits and ${userPRs.length} PRs across ${reposTouched.size} repositories for "${targetDisplayName || rawQuery}".`,
      'success'
    );
  } catch (err) {
    stopFetching();
    setStatus(`Error fetching lifetime user activity: ${err.message}`, 'error');
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
