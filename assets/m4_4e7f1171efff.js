function populateRepoDropdown() {
const datalist = document.getElementById('repoDatalist');
setSafeInnerHTML(datalist, '');
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
async function fetchBranchPolicies(org, project, repoId, branchName, authHeader, defaultBranchName = "") {
const refName = branchName.startsWith('refs/')
? branchName
: `refs/heads/${branchName}`;
const cacheKey = `${repoId}|${refName}`;
if (!window.__azdoBranchPolicyCache) {
window.__azdoBranchPolicyCache = new Map();
}
if (window.__azdoBranchPolicyCache.has(cacheKey)) {
return window.__azdoBranchPolicyCache.get(cacheKey);
}
const request = (async () => {
const gitPolicyUrl =
`https://dev.azure.com/${encodeURIComponent(org)}` +
`/${encodeURIComponent(project)}` +
`/_apis/git/policy/configurations` +
`?repositoryId=${encodeURIComponent(repoId)}` +
`&refName=${encodeURIComponent(refName)}` +
`&$top=1000` +
`&api-version=${AZDO_API_VERSION}`;
try {
console.log(
`[Azure DevOps Policy] Fetching policies for ${repoId} ${refName}`
);
const data = await fetchAzDo(
gitPolicyUrl,
authHeader
);
const policies =
Array.isArray(data?.value)
? data.value
: [];
console.log(
`[Azure DevOps Policy] ${repoId} ${refName}: ${policies.length} policy(s) found`,
policies
);
if (policies.length > 0) {
return policies;
}
} catch (err) {
console.warn(
`[Azure DevOps Policy] Git policy API failed for ${repoId} ${refName}:`,
err
);
}
const fallbackUrl =
`https://dev.azure.com/${encodeURIComponent(org)}` +
`/${encodeURIComponent(project)}` +
`/_apis/policy/configurations` +
`?$top=1000` +
`&api-version=${AZDO_API_VERSION}`;
try {
console.log(
`[Azure DevOps Policy] Trying fallback policy API for ${repoId} ${refName}`
);
const data = await fetchAzDo(
fallbackUrl,
authHeader
);
const allPolicies =
Array.isArray(data?.value)
? data.value
: [];
const currentRepo =
String(repoId).toLowerCase();
const currentRef =
refName.toLowerCase();
const normalizedDefaultBranch = String(defaultBranchName || '')
.replace(/^refs\/heads\//i, '')
.toLowerCase();
const currentBranchName = currentRef.replace(/^refs\/heads\//i, '');
const applicablePolicies =
allPolicies.filter(policy => {
if (!policy) {
return false;
}
if (policy.isDeleted === true) {
return false;
}
if (policy.isEnabled === false) {
return false;
}
const scopes =
Array.isArray(policy.settings?.scope)
? policy.settings.scope
: [];
if (scopes.length === 0) {
// Do not assume an unscoped configuration protects every branch. That can
// create false-positive branch protection results when using the fallback API.
return false;
}
return scopes.some(scope => {
const scopeRepo =
String(
scope.repositoryId || ''
).toLowerCase();
const scopeRef =
String(
scope.refName || scope.ref || ''
).toLowerCase();
if (
scopeRepo &&
scopeRepo !== currentRepo
) {
return false;
}
if (
!scopeRef ||
scopeRef === 'refs/heads/*' ||
scopeRef === '*'
) {
return true;
}
const matchKind =
String(
scope.matchKind || 'Exact'
).toLowerCase();
if (
matchKind === 'defaultbranch'
) {
return Boolean(normalizedDefaultBranch) && currentBranchName === normalizedDefaultBranch;
}
if (
matchKind === 'prefix'
) {
const normalizedScope = scopeRef.endsWith('*') ? scopeRef.slice(0, -1) : scopeRef;
return currentRef.startsWith(normalizedScope);
}
return currentRef === scopeRef;
});
});
console.log(
`[Azure DevOps Policy] ${repoId} ${refName}: ` +
`${applicablePolicies.length} fallback policy(s) found`,
applicablePolicies
);
return applicablePolicies;
} catch (err) {
console.error(
`[Azure DevOps Policy] Fallback policy API failed for ${repoId} ${refName}:`,
err
);
return [];
}
})();
window.__azdoBranchPolicyCache.set(
cacheKey,
request
);
return request;
}
function parsePolicyInformation(policies) {
let minReviewers = 0;
let blockingPolicyCount = 0;
let requiredReviewerCount = 0;
const policyList = [];
const POLICY_TYPES = {
MIN_REVIEWERS:
'fa4e907d-c16b-4a4c-9dfa-4906e5d171dd',
BUILD:
'0609b952-1397-4640-95ec-e00a01b2c241',
REQUIRED_REVIEWERS:
'fd2167ab-b0be-447a-8ec8-39368250530e',
WORK_ITEM_LINKING:
'40e92b44-2fe1-4dd6-b3d8-74a9c21d0c6e',
COMMENT_RESOLUTION:
'c6a1889d-b943-4856-b76f-9e46bb6b0df2',
MERGE_STRATEGY:
'fa4e907d-c16b-4a4c-9dfa-4916e5d171ab',
STATUS_CHECK:
'cbdc66da-9728-4af8-aada-9a5a32e4a226'
};
(policies || []).forEach(policy => {
if (
!policy ||
policy.isDeleted === true ||
policy.isEnabled === false
) {
return;
}
const typeId =
(policy.type?.id || '')
.toLowerCase();
const typeName =
(policy.type?.displayName || '')
.trim();
const typeNameLower =
typeName.toLowerCase();
const settings =
policy.settings || {};
if (policy.isBlocking === true || settings.isBlocking === true) blockingPolicyCount += 1;
if (
typeId === POLICY_TYPES.MIN_REVIEWERS
) {
const count =
Number(
settings.minimumApproverCount
) || 1;
minReviewers =
Math.max(
minReviewers,
count
);
policyList.push(
`${count} Required Reviewer${count > 1 ? 's' : ''}`
);
return;
}
if (
typeId === POLICY_TYPES.BUILD ||
typeNameLower === 'build' ||
typeNameLower.includes(
'build validation'
)
) {
policyList.push(
settings.displayName ||
'Build Validation'
);
return;
}
if (
typeId ===
POLICY_TYPES.REQUIRED_REVIEWERS ||
typeNameLower.includes(
'required reviewer'
)
) {
requiredReviewerCount += Array.isArray(settings.requiredReviewerIds) ? settings.requiredReviewerIds.length : 1;
policyList.push(
'Required Reviewers'
);
return;
}
if (
typeId ===
POLICY_TYPES.WORK_ITEM_LINKING ||
typeNameLower.includes(
'work item'
)
) {
policyList.push(
'Work Item Linking'
);
return;
}
if (
typeId ===
POLICY_TYPES.COMMENT_RESOLUTION ||
typeNameLower.includes(
'comment'
)
) {
policyList.push(
'Comment Resolution'
);
return;
}
if (
typeId ===
POLICY_TYPES.MERGE_STRATEGY ||
typeNameLower.includes(
'merge strategy'
)
) {
policyList.push(
'Merge Strategy'
);
return;
}
if (
typeId ===
POLICY_TYPES.STATUS_CHECK ||
typeNameLower.includes(
'status'
)
) {
policyList.push(
typeName ||
'Status Check'
);
return;
}
policyList.push(
typeName ||
'Branch Policy'
);
});
return {
hasPolicy:
policyList.length > 0,
minReviewers:
minReviewers,
policies:
[...new Set(policyList)],
blockingPolicyCount,
requiredReviewerCount,
policyCount: [...new Set(policyList)].length
};
}
function clearBranchPolicyCache() {
if (
window.__azdoBranchPolicyCache
) {
window.__azdoBranchPolicyCache.clear();
}
}
function ensurePolicyTableHeaders() {
const branchTable =
document.getElementById(
'table-repos'
);
const prTable =
document.getElementById(
'table-repo-prs'
);
if (branchTable) {
const headerRow =
branchTable.querySelector(
'thead tr'
);
if (headerRow) {
setSafeInnerHTML(headerRow, `
<th class="p-4">Repository</th>
<th class="p-4">Branch Name</th>
<th class="p-4">Status / Health</th>
<th class="p-4">Branch Policies</th>
<th class="p-4">Last Author</th>
<th class="p-4">Last Commit Date</th>
<th class="p-4">Commit Message</th>
`);
}
}
if (prTable) {
const headerRow =
prTable.querySelector(
'thead tr'
);
if (headerRow) {
setSafeInnerHTML(headerRow, `
<th class="p-4">Repository</th>
<th class="p-4">PR Title</th>
<th class="p-4">Source &rarr; Target</th>
<th class="p-4">Target Branch Policies</th>
<th class="p-4">Creator</th>
<th class="p-4">Status</th>
<th class="p-4">Created Date</th>
`);
}
}
}
function getStaleBranchThresholdDays() {
const el = document.getElementById('staleBranchThresholdDays');
const value = Number.parseInt(el?.value || '90', 10);
return Number.isFinite(value) && value > 0 ? value : 90;
}
function updateStaleBranchThresholdLabel() {
const days = getStaleBranchThresholdDays();
const label = document.getElementById('staleBranchThresholdLabel');
if (label) label.textContent = `${days} days`;
}
window.getStaleBranchThresholdDays = getStaleBranchThresholdDays;
window.updateStaleBranchThresholdLabel = updateStaleBranchThresholdLabel;
async function fetchRepositoryData() {
const org =
extractOrgName(
document.getElementById(
'targetOrg'
).value
);
const project =
document.getElementById(
'projectSelect'
).value;
const rawInput =
document.getElementById(
'repoSelect'
).value.trim();
const pat =
document.getElementById(
'targetPat'
).value.trim();
if (!rawInput) {
return showModal(
'Please select or type a repository name.',
'repoSelect'
);
}
const authHeader = createBasicAuthHeader(pat);
showSection(
'repositories'
);
startFetching(
'Fetching branches, branch policies, and PR telemetry across selected repository...'
);
ensurePolicyTableHeaders();
updateStaleBranchThresholdLabel();
clearBranchPolicyCache();
let targetRepos =
cachedRepos;
if (
rawInput !== '-- All Repositories --' &&
rawInput !== '__ALL__'
) {
const exactMatches =
cachedRepos.filter(
r =>
r.name.toLowerCase() ===
rawInput.toLowerCase()
);
targetRepos =
exactMatches.length > 0
? exactMatches
: cachedRepos.filter(
r =>
r.name
.toLowerCase()
.includes(
rawInput.toLowerCase()
)
);
}
if (
targetRepos.length === 0
) {
setStatus(
`No repository found matching "${rawInput}".`,
'error'
);
stopFetching();
return;
}
let repoBranchCounts = {};
let allPRs = [];
const now =
new Date();
const staleThresholdDays = getStaleBranchThresholdDays();
try {
const repoPromises =
targetRepos.map(
async r => {
const refsUrl =
`https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/refs?filter=heads/&api-version=${API_VERSION}`;
const prUrl =
`https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/pullrequests?searchCriteria.status=all&$top=100&api-version=${API_VERSION}`;
const [
refsPromise,
prsPromise
] =
await Promise.allSettled([
fetchAzDoPaged(
refsUrl,
authHeader,
{ pageSize: 500 }
),
fetchAzDoPaged(
prUrl,
authHeader,
{ pageSize: 100 }
)
]);
let branchDetails =
[];
if (
refsPromise.status ===
'fulfilled' &&
refsPromise.value
) {
const refs =
refsPromise.value.value ||
[];
repoBranchCounts[r.name] =
refs.length;
branchDetails =
await Promise.all(
refs.map(
async ref => {
const bName =
ref.name.replace(
/^refs\/heads\//,
''
);
const commitUrl =
`https://dev.azure.com/${org}/${project}/_apis/git/repositories/${r.id}/commits?searchCriteria.itemVersion.version=${encodeURIComponent(bName)}&searchCriteria.itemVersion.versionType=branch&$top=1&api-version=${API_VERSION}`;
const [
commitResult,
policyResult
] =
await Promise.allSettled([
fetchAzDo(
commitUrl,
authHeader
),
fetchBranchPolicies(
org,
project,
r.id,
bName,
authHeader,
r.defaultBranch
)
]);
const commitData =
commitResult.status ===
'fulfilled'
? commitResult.value
: null;
const policies =
policyResult.status ===
'fulfilled'
? policyResult.value
: [];
const policyInfo =
parsePolicyInformation(
policies
);
const topCommit =
(
commitData?.value &&
commitData.value[0]
)
? commitData.value[0]
: null;
const commitDate =
topCommit?.author?.date
? new Date(
topCommit.author.date
)
: null;
const isStale =
commitDate
? (
(now - commitDate) /
(1000 * 60 * 60 * 24)
) > staleThresholdDays
: false;
return {
repo:
r.name,
branch:
bName,
author:
topCommit?.author?.name ||
'Unknown',
date:
commitDate
? commitDate.toLocaleString()
: 'N/A',
rawCommitTimestamp:
commitDate && !isNaN(commitDate.getTime())
? commitDate.getTime()
: null,
isStale:
isStale,
staleThresholdDays:
staleThresholdDays,
msg:
topCommit?.comment ||
'',
hasPolicy:
policyInfo.hasPolicy,
minReviewers:
policyInfo.minReviewers,
policies:
policyInfo.policies,
blockingPolicyCount: policyInfo.blockingPolicyCount,
requiredReviewerCount: policyInfo.requiredReviewerCount,
policyCount: policyInfo.policyCount
};
}
)
);
}
if (
prsPromise.status ===
'fulfilled' &&
prsPromise.value
) {
const prList =
prsPromise.value.value ||
[];
const prRows =
await Promise.all(
prList.map(
async pr => {
const sourceBranch =
(
pr.sourceRefName ||
''
).replace(
/^refs\/heads\//,
''
);
const targetBranch =
(
pr.targetRefName ||
''
).replace(
/^refs\/heads\//,
''
);
const policies =
await fetchBranchPolicies(
org,
project,
r.id,
targetBranch,
authHeader,
r.defaultBranch
);
const policyInfo =
parsePolicyInformation(
policies
);
const actualReviewers =
(
pr.reviewers ||
[]
).length;
return {
id:
pr.pullRequestId ||
pr.id ||
'',
repo:
r.name,
repoId:
r.id,
title:
pr.title ||
'Untitled PR',
source:
sourceBranch,
target:
targetBranch,
creator:
pr.createdBy?.displayName ||
'Unknown',
status:
pr.status ||
'unknown',
createdDate:
pr.creationDate
? new Date(
pr.creationDate
).toLocaleDateString()
: 'N/A',
rawCreatedTimestamp:
pr.creationDate
? new Date(pr.creationDate).getTime()
: null,
reviewersCount:
actualReviewers,
minRequiredReviewers:
policyInfo.minReviewers,
targetPolicies:
policyInfo.policies,
blockingPolicyCount: policyInfo.blockingPolicyCount,
requiredReviewerCount: policyInfo.requiredReviewerCount,
policyCount: policyInfo.policyCount
};
}
)
);
allPRs.push(
...prRows
);
}
return branchDetails;
}
);
const results =
await Promise.all(
repoPromises
);
rawStore.repos =
results.flat();
sortByLatestDate(rawStore.repos, ['rawCommitTimestamp']);
rawStore.repoIndex =
0;
rawStore.policyBranchesIndex =
0;
rawStore.repoPrs =
allPRs;
sortByLatestDate(rawStore.repoPrs, ['rawCreatedTimestamp']);
rawStore.repoPrsIndex =
0;
const activePRsCount =
allPRs.filter(
p =>
p.status ===
'active'
).length;
const completedPRsCount =
allPRs.filter(
p =>
p.status ===
'completed'
).length;
document.getElementById(
'kpi-1-label'
).textContent =
'Repository';
document.getElementById(
'kpi-1-val'
).textContent =
(
targetRepos.length > 1
)
? `${targetRepos.length} Repos`
: targetRepos[0]?.name;
document.getElementById(
'kpi-1-val'
).className =
'text-2xl font-extrabold text-slate-800 mt-1 truncate';
document.getElementById(
'kpi-2-label'
).textContent =
'Branches';
document.getElementById(
'kpi-2-val'
).textContent =
`${rawStore.repos.length} ` +
`(${rawStore.repos.filter(
b => b.isStale
).length} Stale)`;
document.getElementById(
'kpi-3-label'
).textContent =
'Total PRs';
document.getElementById(
'kpi-3-val'
).textContent =
allPRs.length;
document.getElementById(
'kpi-4-label'
).textContent =
'Active PRs';
document.getElementById(
'kpi-4-val'
).textContent =
activePRsCount;
document.getElementById(
'kpi-5-label'
).textContent =
'Completed PRs';
document.getElementById(
'kpi-5-val'
).textContent =
completedPRsCount;
renderRepoTableBatch(
false
);
renderPolicyBranchesTableBatch(
false
);
renderRepoPrsTableBatch(
false
);
renderChart(
Object.keys(
repoBranchCounts
),
Object.values(
repoBranchCounts
),
'Branches per Repository'
);
const branchPolicyCount =
rawStore.repos.filter(
b => b.hasPolicy
).length;
const prPolicyCount =
allPRs.filter(
p =>
p.targetPolicies &&
p.targetPolicies.length > 0
).length;
setStatus(
`Loaded ${rawStore.repos.length} branches (stale threshold: ${staleThresholdDays} days), ` +
`${branchPolicyCount} branches with policies, ` +
`${allPRs.length} pull requests, and ` +
`${prPolicyCount} PR target branches with policies ` +
`across ${targetRepos.length} repositories.`,
'success'
);
stopFetching();
} catch (err) {
setStatus(isAzDoCancellation(err) ? 'The repository and branch policy operation was cancelled.' : `Error fetching branches and policies: ${err.message}`, isAzDoCancellation(err) ? 'info' : 'error');
stopFetching();
}
}
function renderRepoTableBatch(
append = false
) {
ensurePolicyTableHeaders();
const tbody =
document.getElementById(
'branchesTableBody'
);
const container =
document.getElementById(
'seeMoreRepoContainer'
);
const remainingEl =
document.getElementById(
'repoRemainingCount'
);
if (!append) {
setSafeInnerHTML(tbody, '');
}
if (
rawStore.repos.length === 0
) {
setSafeInnerHTML(tbody, `<tr>
<td colspan="7"
class="p-4 text-center text-slate-400">
No branches found.
</td>
</tr>`);
container.classList.add(
'hidden'
);
return;
}
const nextBatch =
rawStore.repos.slice(
rawStore.repoIndex,
rawStore.repoIndex +
PAGE_SIZE
);
rawStore.repoIndex +=
nextBatch.length;
const batchStartIndex = rawStore.repoIndex - nextBatch.length;
const html =
nextBatch.map(
(b, rowIndex) => {
const policiesHtml =
b.hasPolicy
? `<div class="flex flex-wrap gap-1 max-w-xs">
${
b.minReviewers > 0
? `<span
class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold px-1.5 py-0.5 rounded">
${b.minReviewers}
Min Reviewer${b.minReviewers > 1 ? 's' : ''}
</span>`
: ''
}
${
b.policies
.map(
p =>
`<span
class="bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-semibold px-1.5 py-0.5 rounded">
${p}
</span>`
)
.join('')
}
</div>`
: `<span
class="text-xs text-slate-400 italic">
No Policies Set
</span>`;
return `
<tr class="hover:bg-slate-50 transition" data-detail-type="repository-branch" data-detail-index="${batchStartIndex + rowIndex}">
<td class="p-4 font-semibold text-slate-900">
${b.repo}
</td>
<td class="p-4">
<span
class="font-mono text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded font-semibold">
${b.branch}
</span>
</td>
<td class="p-4">
${
b.isStale
? '<span class="bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full font-semibold">Stale</span>'
: '<span class="bg-emerald-100 text-emerald-700 text-xs px-2 py-0.5 rounded-full font-semibold">Active</span>'
}
</td>
<td class="p-4">
${policiesHtml}
</td>
<td class="p-4 text-xs font-medium">
${b.author}
</td>
<td class="p-4 text-xs text-slate-500">
${b.date}
</td>
<td
class="p-4 text-xs text-slate-600 max-w-xs truncate"
title="${b.msg}">
${b.msg}
</td>
</tr>
`;
}
).join('');
insertSafeAdjacentHTML(tbody, 'beforeend', html);
const remaining =
rawStore.repos.length -
rawStore.repoIndex;
if (remaining > 0) {
container.classList.remove(
'hidden'
);
remainingEl.textContent =
remaining;
} else {
container.classList.add(
'hidden'
);
}
}
function getPolicyBranches() {
if (!Array.isArray(rawStore.repos)) {
return [];
}
return rawStore.repos.filter(
b => b.hasPolicy === true &&
Array.isArray(b.policies) &&
b.policies.length > 0
);
}
function renderPolicyBranchesTableBatch(
append = false
) {
const tbody =
document.getElementById(
'policyBranchesTableBody'
);
const container =
document.getElementById(
'seeMorePolicyBranchesContainer'
);
const remainingEl =
document.getElementById(
'policyBranchesRemainingCount'
);
if (!tbody || !container || !remainingEl) {
return;
}
const policyBranches =
getPolicyBranches();
if (!append) {
setSafeInnerHTML(tbody, '');
rawStore.policyBranchesIndex = 0;
}
if (policyBranches.length === 0) {
setSafeInnerHTML(tbody, `
<tr>
<td colspan="6" class="p-4 text-center text-slate-400">
No branches with policies found.
</td>
</tr>
`);
container.classList.add('hidden');
remainingEl.textContent = '0';
return;
}
const nextBatch =
policyBranches.slice(
rawStore.policyBranchesIndex,
rawStore.policyBranchesIndex + PAGE_SIZE
);
rawStore.policyBranchesIndex += nextBatch.length;
const batchStartIndex = rawStore.policyBranchesIndex - nextBatch.length;
const html = nextBatch.map((b, rowIndex) => {
const policiesHtml =
`<div class="flex flex-wrap gap-1 max-w-xl">` +
(b.minReviewers > 0
? `<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[10px] font-bold px-1.5 py-0.5 rounded">${b.minReviewers} Required Reviewer${b.minReviewers > 1 ? 's' : ''}</span>`
: '') +
b.policies.map(p =>
`<span class="bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-semibold px-1.5 py-0.5 rounded">${p}</span>`
).join('') +
`</div>`;
return `
<tr class="hover:bg-slate-50 transition" data-detail-type="policy-branch" data-detail-index="${rawStore.repos.indexOf(b)}">
<td class="p-4 font-semibold text-slate-900">${b.repo}</td>
<td class="p-4">
<span class="font-mono text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded font-semibold">
${b.branch}
</span>
</td>
<td class="p-4">
<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-bold px-2 py-1 rounded">
${b.minReviewers > 0 ? b.minReviewers : '0'}
</span>
</td>
<td class="p-4">${policiesHtml}</td>
<td class="p-4 text-xs font-medium text-slate-700">${b.author || 'Unknown'}</td>
<td class="p-4 text-xs text-slate-500">${b.date || 'N/A'}</td>
</tr>
`;
}).join('');
insertSafeAdjacentHTML(tbody, 'beforeend', html);
const remaining =
policyBranches.length - rawStore.policyBranchesIndex;
if (remaining > 0) {
container.classList.remove('hidden');
remainingEl.textContent = remaining;
} else {
container.classList.add('hidden');
remainingEl.textContent = '0';
}
}
function exportPolicyBranchesToXLSX() {
const policyBranches =
getPolicyBranches();
if (policyBranches.length === 0) {
if (typeof showModal === 'function') {
showModal('No branches with policies are available to export.');
}
return;
}
const data = policyBranches.map(b => ({
"Repository": b.repo,
"Branch Name": b.branch,
"Required Reviewers": b.minReviewers || 0,
"Branch Policies": Array.isArray(b.policies) ? b.policies.join(', ') : 'None',
"Last Author": b.author || 'Unknown',
"Last Commit Date": b.date || 'N/A',
"Commit Message": b.msg || '',
"Stale Threshold (Days)": b.staleThresholdDays || 90
}));
exportToExcelFile(
{ "Branches With Policies": data },
"AzureDevOps_Branches_With_Policies"
);
}
function renderRepoPrsTableBatch(
append = false
) {
ensurePolicyTableHeaders();
const tbody =
document.getElementById(
'repoPrsTableBody'
);
const container =
document.getElementById(
'seeMoreRepoPrsContainer'
);
const remainingEl =
document.getElementById(
'repoPrsRemainingCount'
);
if (!append) {
setSafeInnerHTML(tbody, '');
}
if (
rawStore.repoPrs.length === 0
) {
setSafeInnerHTML(tbody, `<tr>
<td colspan="7"
class="p-4 text-center text-slate-400">
No pull requests found.
</td>
</tr>`);
container.classList.add(
'hidden'
);
return;
}
const nextBatch =
rawStore.repoPrs.slice(
rawStore.repoPrsIndex,
rawStore.repoPrsIndex +
PAGE_SIZE
);
rawStore.repoPrsIndex +=
nextBatch.length;
const batchStartIndex = rawStore.repoPrsIndex - nextBatch.length;
const html =
nextBatch.map(
(pr, rowIndex) => {
let policyBadge =
'';
if (
pr.minRequiredReviewers > 0
) {
policyBadge =
`<div
class="flex flex-wrap gap-1 max-w-xs">
<span
class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-bold px-2 py-0.5 rounded">
${pr.minRequiredReviewers}
Min Required
(${pr.reviewersCount} Assigned)
</span>
${
pr.targetPolicies
.filter(
p =>
!p
.toLowerCase()
.includes(
'required reviewer'
)
)
.map(
p =>
`<span
class="bg-blue-50 text-blue-700 border border-blue-200 text-xs font-semibold px-2 py-0.5 rounded">
${p}
</span>`
)
.join('')
}
</div>`;
} else if (
pr.targetPolicies &&
pr.targetPolicies.length > 0
) {
policyBadge =
`<div
class="flex flex-wrap gap-1 max-w-xs">
${
pr.targetPolicies
.map(
p =>
`<span
class="bg-blue-50 text-blue-700 border border-blue-200 text-xs font-semibold px-2 py-0.5 rounded">
${p}
</span>`
)
.join('')
}
</div>`;
} else {
policyBadge =
`<span
class="text-xs text-slate-400">
${
pr.reviewersCount > 0
? pr.reviewersCount +
' Reviewer(s)'
: 'No Policies Set'
}
</span>`;
}
return `
<tr class="hover:bg-slate-50 transition" data-detail-type="repository-pr" data-detail-index="${batchStartIndex + rowIndex}">
<td
class="p-4 font-semibold text-slate-900">
${pr.repo}
</td>
<td
class="p-4 font-medium text-slate-800 max-w-xs truncate"
title="${pr.title}">
${pr.title}
</td>
<td
class="p-4 font-mono text-xs text-slate-500">
${pr.source}
&rarr;
${pr.target}
</td>
<td class="p-4">
${policyBadge}
</td>
<td
class="p-4 text-xs font-medium text-slate-700">
${pr.creator}
</td>
<td class="p-4">
<span
class="px-2 py-0.5 rounded-full text-xs font-semibold ${
pr.status === 'completed'
? 'bg-emerald-100 text-emerald-700'
:
pr.status === 'active'
? 'bg-blue-100 text-blue-700'
:
'bg-slate-100 text-slate-600'
}">
${pr.status}
</span>
</td>
<td
class="p-4 text-xs text-slate-500">
${pr.createdDate}
</td>
</tr>
`;
}
).join('');
insertSafeAdjacentHTML(tbody, 'beforeend', html);
const remaining =
rawStore.repoPrs.length -
rawStore.repoPrsIndex;
if (remaining > 0) {
container.classList.remove(
'hidden'
);
remainingEl.textContent =
remaining;
} else {
container.classList.add(
'hidden'
);
}
}
function exportBranchesToXLSX() {
if (
!rawStore.repos ||
rawStore.repos.length === 0
) {
return;
}
const data =
rawStore.repos.map(
b => ({
"Repository":
b.repo,
"Branch Name":
b.branch,
"Status / Health":
b.isStale
? "Stale"
: "Active",
"Branch Policies":
b.policies
? b.policies.join(', ')
: 'None',
"Required Reviewers":
b.minReviewers || 0,
"Last Author":
b.author,
"Last Commit Date":
b.date,
"Commit Message":
b.msg
})
);
exportToExcelFile(
{
"Branches & Policies":
data
},
"AzureDevOps_Branches_Policies"
);
}
function exportRepoPrsToXLSX() {
if (
!rawStore.repoPrs ||
rawStore.repoPrs.length === 0
) {
return;
}
const data =
rawStore.repoPrs.map(
p => ({
"Repository":
p.repo,
"PR Title":
p.title,
"Source Branch":
p.source,
"Target Branch":
p.target,
"Target Branch Policies":
p.targetPolicies
? p.targetPolicies.join(', ')
: 'None',
"Min Required Reviewers":
p.minRequiredReviewers || 0,
"Assigned Reviewers":
p.reviewersCount || 0,
"Creator":
p.creator,
"Status":
p.status,
"Created Date":
p.createdDate
})
);
exportToExcelFile(
{
"Pull Requests":
data
},
"AzureDevOps_PullRequests_Policies"
);
}
