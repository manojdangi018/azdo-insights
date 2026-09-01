async function fetchUserActivityData() {
const org = extractOrgName(document.getElementById('targetOrg').value);
const selectedProject = document.getElementById('projectSelect').value;
const pat = document.getElementById('targetPat').value.trim();
const rawQuery = document.getElementById('targetUserQuery').value.trim();
const rawTimeframe = document.getElementById('userTimeframeDays')?.value;
const timeframeDays = rawTimeframe !== undefined && rawTimeframe !== '' ? parseInt(rawTimeframe, 10) : 0;
if (!selectedProject) {
return showModal('Please select a project first.', 'projectSelect');
}
if (!rawQuery) {
return showModal('Please enter a User Email or Name to search.', 'targetUserQuery');
}
const authHeader = createBasicAuthHeader(pat);
showSection('activity');
startFetching(`Searching activity in project "${selectedProject}" for "${rawQuery}"...`);
const queryLower = normalizeIdentityText(rawQuery);
const searchAuthors = buildIdentitySearchVariants(rawQuery);
function matchesUser(authorName, authorEmail, committerName, committerEmail) {
return identityMatchesQuery(rawQuery, {
  displayName: authorName,
  mailAddress: authorEmail,
  name: committerName,
  email: committerEmail
});
}
let cutoffDate = null;
let fromDateIso = null;
if (timeframeDays > 0) {
const d = new Date();
d.setDate(d.getDate() - timeframeDays);
cutoffDate = d;
fromDateIso = d.toISOString();
}
let userCommits = [];
let userPRs = [];
const reposTouched = new Set();
let foundDisplayName = '';
async function resolveCommitBranches(repoId, commitRows) {
  const result = new Map();
  const pushKeys = new Map();
  for (const c of commitRows || []) {
    const pushId = c?.push?.pushId;
    if (pushId !== undefined && pushId !== null) {
      pushKeys.set(String(pushId), c.commitId);
    }
  }
  if (!pushKeys.size) return result;
  const entries = [...pushKeys.entries()];
  const BATCH = 6;
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH);
    await Promise.all(batch.map(async ([pushId, commitId]) => {
      try {
        const pushUrl = `https://dev.azure.com/${org}/${encodeURIComponent(selectedProject)}/_apis/git/repositories/${repoId}/pushes/${encodeURIComponent(pushId)}?includeRefUpdates=true&api-version=${API_VERSION}`;
        const push = await fetchAzDo(pushUrl, authHeader);
        const refs = (push?.refUpdates || []).map(r => String(r?.name || '').replace(/^refs\/heads\//i, '')).filter(Boolean);
        const key = String(commitId || '').toLowerCase();
        if (key && refs.length === 1) result.set(key, refs);
        else if (key && refs.length > 1) result.set(key, [`Ambiguous push refs: ${refs.join(', ')}`]);
      } catch (_) {}
    }));
  }
  return result;
}
try {
const projReposUrl = `https://dev.azure.com/${org}/${encodeURIComponent(selectedProject)}/_apis/git/repositories?api-version=${API_VERSION}`;
const projReposRes = await fetchAzDoPaged(projReposUrl, authHeader, { pageSize: 500 });
const repos = projReposRes?.value || [];
if (!repos || repos.length === 0) {
throw new Error(`No Git repositories found in project "${selectedProject}".`);
}
const BATCH_SIZE = 4;
for (let i = 0; i < repos.length; i += BATCH_SIZE) {
const batch = repos.slice(i, i + BATCH_SIZE);
await Promise.all(batch.map(async (r) => {
const commitsPromise = (async () => {
for (const authorParam of searchAuthors) {
try {
let url = `https://dev.azure.com/${org}/${encodeURIComponent(selectedProject)}/_apis/git/repositories/${r.id}/commits?searchCriteria.author=${encodeURIComponent(authorParam)}&$top=1000&api-version=${API_VERSION}`;
if (fromDateIso) {
url += `&searchCriteria.fromDate=${encodeURIComponent(fromDateIso)}`;
}
const res = await fetchAzDoPaged(url, authHeader, { pageSize: 1000 });
const commits = res?.value || [];
commits.forEach((c) => {
if (matchesUser(c.author?.name, c.author?.email, c.committer?.name, c.committer?.email)) {
const commitDate = new Date(c.author?.date || c.committer?.date);
if (!cutoffDate || commitDate >= cutoffDate) {
reposTouched.add(r.name);
if (!foundDisplayName && c.author?.name) {
foundDisplayName = c.author.name;
}
userCommits.push({
repo: r.name,
repoId: r.id,
branch: 'Resolving...',
branchSource: 'push metadata',
commitSha: c.commitId || '',
rawPush: c.push || null,
commitId: (c.commitId || '').substring(0, 8),
rawDate: commitDate,
date: isNaN(commitDate.getTime()) ? 'N/A' : commitDate.toLocaleDateString(),
comment: c.comment || 'No commit message'
});
}
}
});
if (commits.some(c => matchesUser(c.author?.name, c.author?.email, c.committer?.name, c.committer?.email))) break; // Stop only when this variant actually matched the requested identity
} catch (err) {
}
}
})();
const prsPromise = (async () => {
try {
const prUrl = `https://dev.azure.com/${org}/${encodeURIComponent(selectedProject)}/_apis/git/repositories/${r.id}/pullrequests?searchCriteria.status=all&$top=500&api-version=${API_VERSION}`;
const prRes = await fetchAzDoPaged(prUrl, authHeader, { pageSize: 500 });
const prList = prRes?.value || [];
prList.forEach((pr) => {
const creatorEmail = pr.createdBy?.uniqueName || '';
const creatorName = pr.createdBy?.displayName || '';
if (matchesUser(creatorName, creatorEmail, null, null)) {
const prDate = new Date(pr.creationDate);
if (!cutoffDate || prDate >= cutoffDate) {
reposTouched.add(r.name);
userPRs.push({
id: pr.pullRequestId || pr.id || '',
repo: r.name,
repoId: r.id,
title: pr.title || 'Untitled PR',
source: (pr.sourceRefName || '').replace('refs/heads/', ''),
target: (pr.targetRefName || '').replace('refs/heads/', ''),
status: pr.status || 'unknown',
createdDate: isNaN(prDate.getTime()) ? 'N/A' : prDate.toLocaleDateString(),
rawDate: prDate,
closedDate: pr.closedDate ? new Date(pr.closedDate).toLocaleDateString() : 'N/A',
rawClosedTimestamp: pr.closedDate ? new Date(pr.closedDate).getTime() : null
});
}
}
});
} catch (err) {}
})();
return Promise.all([commitsPromise, prsPromise]);
}));
}
const commitsByRepo = new Map();
userCommits.forEach(c => {
  if (!commitsByRepo.has(c.repoId)) commitsByRepo.set(c.repoId, []);
  commitsByRepo.get(c.repoId).push(c);
});
for (const [repoId, rows] of commitsByRepo.entries()) {
  const branchMap = await resolveCommitBranches(repoId, rows.map(r => ({ commitId: r.commitSha, push: r.rawPush })));
  rows.forEach(r => {
    const branches = branchMap.get(String(r.commitSha || '').toLowerCase()) || [];
    r.branch = branches.length ? branches.join(', ') : 'Branch not resolved';
    r.branchSource = branches.length === 1 && !String(branches[0]).startsWith('Ambiguous push refs:') ? 'push ref update' : branches.length ? 'push contains multiple ref updates' : 'commit push metadata unavailable';
    delete r.rawPush;
  });
}
const seen = new Set();
userCommits = userCommits.filter((c) => {
const key = `${c.repo}_${c.commitSha || c.commitId}`;
if (seen.has(key)) return false;
seen.add(key);
return true;
});
const seenPrs = new Set();
userPRs = userPRs.filter((p) => {
const key = `${p.repo}_${p.title}_${p.createdDate}`;
if (seenPrs.has(key)) return false;
seenPrs.add(key);
return true;
});
userCommits.sort((a, b) => b.rawDate - a.rawDate);
userPRs.sort((a, b) => b.rawDate - a.rawDate);
rawStore.commits = userCommits;
sortByLatestDate(rawStore.commits, ['rawDate']);
rawStore.commitsIndex = 0;
rawStore.repoPrs = userPRs;
document.getElementById('kpi-1-label').textContent = 'Active Scope';
document.getElementById('kpi-1-val').textContent = foundDisplayName || rawQuery;
document.getElementById('kpi-1-val').className = 'text-2xl font-extrabold text-slate-800 mt-1 truncate';
document.getElementById('kpi-2-label').textContent = 'Project Repos Touched';
document.getElementById('kpi-2-val').textContent = reposTouched.size;
document.getElementById('kpi-3-label').textContent = 'Commits Made';
document.getElementById('kpi-3-val').textContent = userCommits.length;
document.getElementById('kpi-4-label').textContent = 'Pull Requests';
document.getElementById('kpi-4-val').textContent = userPRs.length;
document.getElementById('kpi-5-label').textContent = 'Status';
document.getElementById('kpi-5-val').textContent = userCommits.length > 0 ? 'Active' : 'No Commits';
renderCommitsTableBatch(false);
setSafeInnerHTML(document.getElementById('userPrTableBody'), userPRs.length === 0
? `<tr><td colspan="5" class="p-4 text-center text-slate-400">No pull requests found for "${rawQuery}" in project ${selectedProject}.</td></tr>`
: userPRs
.map(
(pr, rowIndex) => `
<tr class="hover:bg-slate-50 transition" data-detail-type="user-pr" data-detail-index="${rowIndex}">
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
.join(''));
const repoCommitMap = {};
userCommits.forEach((c) => {
repoCommitMap[c.repo] = (repoCommitMap[c.repo] || 0) + 1;
});
renderChart(
Object.keys(repoCommitMap),
Object.values(repoCommitMap),
`Commits in ${selectedProject} by ${foundDisplayName || rawQuery}`
);
stopFetching();
setStatus(
`Found ${userCommits.length} commits and ${userPRs.length} PRs in project "${selectedProject}" for "${rawQuery}".`,
'success'
);
} catch (err) {
stopFetching();
setStatus(isAzDoCancellation(err) ? 'The user activity operation was cancelled.' : `Error fetching user activity: ${err.message}`, isAzDoCancellation(err) ? 'info' : 'error');
}
}
function renderCommitsTableBatch(append = false) {
const tbody = document.getElementById('userCommitsTableBody');
const container = document.getElementById('seeMoreCommitsContainer');
const remainingEl = document.getElementById('commitsRemainingCount');
if (!append) setSafeInnerHTML(tbody, '');
if (rawStore.commits.length === 0) {
setSafeInnerHTML(tbody, `<tr><td colspan="5" class="p-4 text-center text-slate-400">No commits found in this project for the selected timeframe.</td></tr>`);
if (container) container.classList.add('hidden');
return;
}
const nextBatch = rawStore.commits.slice(
rawStore.commitsIndex,
rawStore.commitsIndex + PAGE_SIZE
);
rawStore.commitsIndex += nextBatch.length;
const batchStartIndex = rawStore.commitsIndex - nextBatch.length;
const html = nextBatch
.map(
(c, rowIndex) => `
<tr class="hover:bg-slate-50 transition" data-detail-type="user-commit" data-detail-index="${batchStartIndex + rowIndex}">
<td class="p-4 font-semibold text-slate-900">${c.repo}</td>
<td class="p-4"><span class="font-mono text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded font-semibold">${c.branch}</span></td>
<td class="p-4 font-mono text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded font-semibold">${c.commitId}</td>
<td class="p-4 text-xs text-slate-500">${c.date}</td>
<td class="p-4 text-xs text-slate-700">${c.comment}</td>
</tr>
`
)
.join('');
insertSafeAdjacentHTML(tbody, 'beforeend', html);
const remaining = rawStore.commits.length - rawStore.commitsIndex;
if (remaining > 0) {
if (container) container.classList.remove('hidden');
if (remainingEl) remainingEl.textContent = remaining;
} else {
if (container) container.classList.add('hidden');
}
}
