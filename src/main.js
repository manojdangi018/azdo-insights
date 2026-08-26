import * as SDK from "azure-devops-extension-sdk";
import { getClient, CommonServiceIds } from "azure-devops-extension-api";
import { GitRestClient } from "azure-devops-extension-api/Git";
import { BuildRestClient } from "azure-devops-extension-api/Build";
import { WorkItemTrackingRestClient } from "azure-devops-extension-api/WorkItemTracking";
import { CoreRestClient } from "azure-devops-extension-api/Core";

/* global Chart, ChartDataLabels, XLSX */
// Chart.js, the datalabels plugin, and SheetJS(xlsx) are loaded globally via
// CDN <script> tags in index.html — see webpack.config.js / index.html.

// ==========================================
// STATE
// ==========================================
let project = null; // { id, name }
let chartInstance = null;
let currentFocusTarget = null;
let cachedRepos = [];
let currentChartData = { labels: [], values: [], label: "Overview" };
let currentChartType = "bar";
let activeViewSection = "view-repositories";
const PAGE_SIZE = 10;

let rawStore = {
  repos: [], repoIndex: 0,
  repoPrs: [], repoPrsIndex: 0,
  access: [], accessIndex: 0,
  commits: [], commitsIndex: 0,
  pipelines: [], pipelineIndex: 0,
  workitems: [], workitemsIndex: 0
};
let pipelineSummaries = [];

// REST clients (initialized after SDK.ready())
let gitClient, buildClient, witClient, coreClient;

// ==========================================
// SDK BOOTSTRAP
// ==========================================
async function main() {
  await SDK.init({ loaded: false });
  await SDK.ready();

  gitClient = getClient(GitRestClient);
  buildClient = getClient(BuildRestClient);
  witClient = getClient(WorkItemTrackingRestClient);
  coreClient = getClient(CoreRestClient);

  const projectService = await SDK.getService(CommonServiceIds.ProjectPageService);
  project = await projectService.getProject();

  document.getElementById("projectContextLabel").textContent =
    `Project: ${project.name}`;

  wireStaticEventListeners();
  populateCategoryDropdown();

  // Pre-fetch repositories for the Repositories + Activity modules
  try {
    cachedRepos = await gitClient.getRepositories(project.id);
  } catch (e) {
    console.warn("Could not pre-fetch repositories:", e);
    cachedRepos = [];
  }

  SDK.notifyLoadSucceeded();
}

main().catch((err) => {
  console.error("Extension failed to initialize:", err);
  setStatus(`Failed to initialize: ${err.message}`, "error");
});

// ==========================================
// UI HELPERS
// ==========================================
function showModal(message, targetFocusId) {
  currentFocusTarget = targetFocusId;
  document.getElementById("modalMessage").textContent = message;
  document.getElementById("validationModal").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("validationModal").classList.add("hidden");
  if (currentFocusTarget) {
    const target = document.getElementById(currentFocusTarget);
    if (target) {
      target.focus();
      target.classList.add("ring-2", "ring-red-400");
      setTimeout(() => target.classList.remove("ring-2", "ring-red-400"), 1500);
    }
  }
}

function setStatus(msg, type = "info") {
  const el = document.getElementById("statusBar");
  el.classList.remove("hidden", "bg-red-50", "text-red-700", "bg-green-50", "text-green-700", "bg-blue-50", "text-blue-700");
  if (type === "error") el.classList.add("bg-red-50", "text-red-700");
  else if (type === "success") el.classList.add("bg-green-50", "text-green-700");
  else el.classList.add("bg-blue-50", "text-blue-700");
  el.textContent = msg;
}

function showSection(viewId) {
  activeViewSection = `view-${viewId}`;
  ["repositories", "access", "activity", "pipelines", "workitems"].forEach((v) => {
    document.getElementById(`view-${v}`).classList.toggle("hidden", v !== viewId);
  });
}

// ==========================================
// STATIC EVENT WIRING (buttons that don't get re-created)
// ==========================================
function wireStaticEventListeners() {
  document.getElementById("btnCloseModal").addEventListener("click", closeModal);
  document.getElementById("categorySelect").addEventListener("change", handleCategorySelection);
  document.getElementById("btnInspectRepo").addEventListener("click", fetchRepositoryData);
  document.getElementById("btnFetchAccess").addEventListener("click", fetchUserAccessData);
  document.getElementById("btnFetchActivity").addEventListener("click", fetchUserActivityData);
  document.getElementById("btnFetchPipelines").addEventListener("click", fetchPipelineData);
  document.getElementById("btnFetchWorkItems").addEventListener("click", fetchWorkItemsData);

  document.getElementById("tableFilterInput").addEventListener("input", filterActiveTable);
  document.getElementById("btnExportActive").addEventListener("click", exportCurrentTableToXLSX);
  document.getElementById("btnExportBranches").addEventListener("click", exportBranchesToXLSX);
  document.getElementById("btnExportRepoPrs").addEventListener("click", exportRepoPrsToXLSX);
  document.getElementById("btnExportAccess").addEventListener("click", exportAccessToXLSX);
  document.getElementById("btnExportPipelines").addEventListener("click", exportPipelinesToXLSX);

  document.getElementById("btnSeeMoreRepo").addEventListener("click", () => renderRepoTableBatch(true));
  document.getElementById("btnSeeMoreRepoPrs").addEventListener("click", () => renderRepoPrsTableBatch(true));
  document.getElementById("btnSeeMoreAccess").addEventListener("click", () => renderAccessTableBatch(true));
  document.getElementById("btnSeeMoreCommits").addEventListener("click", () => renderCommitsTableBatch(true));
  document.getElementById("btnSeeMorePipelines").addEventListener("click", () => renderPipelineTableBatch(true));
  document.getElementById("btnSeeMoreWorkItems").addEventListener("click", () => renderWorkItemsTableBatch(true));

  document.querySelectorAll(".chart-type-btn").forEach((btn) => {
    btn.addEventListener("click", () => changeChartType(btn.dataset.chartType));
  });
}

function populateCategoryDropdown() {
  const catSelect = document.getElementById("categorySelect");
  catSelect.innerHTML = `
    <option value="">-- Choose Category --</option>
    <option value="repositories">Repositories & Branches</option>
    <option value="user_access">User Access & Teams</option>
    <option value="user_activity">User Activity & Commits</option>
    <option value="pipelines">Pipelines & Builds</option>
    <option value="work_items">Work Items & Backlog</option>
  `;
  catSelect.disabled = false;
  catSelect.classList.remove("bg-slate-100", "cursor-not-allowed");
  catSelect.classList.add("bg-white");
}

function handleCategorySelection() {
  const cat = document.getElementById("categorySelect").value;
  const step2 = document.getElementById("step2Container");
  const subRepo = document.getElementById("substepRepo");
  const subAccess = document.getElementById("substepAccess");
  const subActivity = document.getElementById("substepActivity");
  const subPipelines = document.getElementById("substepPipelines");
  const subWorkItems = document.getElementById("substepWorkItems");

  if (!cat) {
    step2.classList.add("hidden");
    return;
  }

  step2.classList.remove("hidden");
  [subRepo, subAccess, subActivity, subPipelines, subWorkItems].forEach((el) => el.classList.add("hidden"));

  if (cat === "repositories") {
    subRepo.classList.remove("hidden");
    populateRepoDropdown();
  } else if (cat === "user_access") {
    subAccess.classList.remove("hidden");
  } else if (cat === "user_activity") {
    subActivity.classList.remove("hidden");
  } else if (cat === "pipelines") {
    subPipelines.classList.remove("hidden");
  } else if (cat === "work_items") {
    subWorkItems.classList.remove("hidden");
  }
}

function populateRepoDropdown() {
  const datalist = document.getElementById("repoDatalist");
  datalist.innerHTML = "";

  const allOpt = document.createElement("option");
  allOpt.value = "-- All Repositories --";
  datalist.appendChild(allOpt);

  cachedRepos.forEach((r) => {
    const opt = document.createElement("option");
    opt.value = r.name;
    datalist.appendChild(opt);
  });
  document.getElementById("repoSelect").value = "-- All Repositories --";
}

// ==========================================
// MODULE 1: REPOSITORIES, BRANCHES & PRs
// ==========================================
async function fetchRepositoryData() {
  const rawInput = document.getElementById("repoSelect").value.trim();
  if (!rawInput) return showModal("Please select or type a repository name.", "repoSelect");

  showSection("repositories");
  setStatus("Fetching branches and PR telemetry across selected repository...", "info");

  let targetRepos = cachedRepos;
  if (rawInput !== "-- All Repositories --") {
    const exact = cachedRepos.filter((r) => r.name.toLowerCase() === rawInput.toLowerCase());
    targetRepos = exact.length > 0
      ? exact
      : cachedRepos.filter((r) => r.name.toLowerCase().includes(rawInput.toLowerCase()));
  }

  if (targetRepos.length === 0) {
    setStatus(`No repository found matching "${rawInput}".`, "error");
    return;
  }

  let repoBranchCounts = {};
  let allPRs = [];
  const now = new Date();

  try {
    const repoPromises = targetRepos.map(async (r) => {
      let branchDetails = [];

      try {
        const refs = await gitClient.getRefs(r.id, project.id, "heads/");
        repoBranchCounts[r.name] = refs.length;

        branchDetails = await Promise.all(refs.map(async (ref) => {
          const bName = ref.name.replace(/^refs\/heads\//, "");
          let topCommit = null;
          try {
            const commits = await gitClient.getCommits(r.id, {
              itemVersion: { version: bName, versionType: 0 }, // 0 = branch
              $top: 1
            }, project.id, 0, 1);
            topCommit = (commits && commits[0]) || null;
          } catch (e) { /* ignore per-branch commit failures */ }

          const commitDate = topCommit?.author?.date ? new Date(topCommit.author.date) : null;
          const isStale = commitDate ? ((now - commitDate) / (1000 * 60 * 60 * 24)) > 90 : false;

          return {
            repo: r.name,
            branch: bName,
            author: topCommit?.author?.name || "Unknown",
            date: commitDate ? commitDate.toLocaleString() : "N/A",
            isStale,
            msg: topCommit?.comment || ""
          };
        }));
      } catch (e) {
        console.warn(`Refs fetch failed for ${r.name}:`, e);
      }

      try {
        const prList = await gitClient.getPullRequests(r.id, { status: 4 /* All */ }, project.id, 0, 100); // 4 = All
        prList.forEach((pr) => {
          allPRs.push({
            repo: r.name,
            title: pr.title || "Untitled PR",
            source: (pr.sourceRefName || "").replace("refs/heads/", ""),
            target: (pr.targetRefName || "").replace("refs/heads/", ""),
            creator: pr.createdBy?.displayName || "Unknown",
            status: pr.status || "unknown",
            createdDate: pr.creationDate ? new Date(pr.creationDate).toLocaleDateString() : "N/A"
          });
        });
      } catch (e) {
        console.warn(`PR fetch failed for ${r.name}:`, e);
      }

      return branchDetails;
    });

    const results = await Promise.all(repoPromises);
    rawStore.repos = results.flat();
    rawStore.repoIndex = 0;
    rawStore.repoPrs = allPRs;
    rawStore.repoPrsIndex = 0;

    const activePRsCount = allPRs.filter((p) => p.status === "active").length;
    const completedPRsCount = allPRs.filter((p) => p.status === "completed").length;

    document.getElementById("kpi-1-val").textContent = targetRepos.length > 1 ? `${project.name} (${targetRepos.length} Repos)` : targetRepos[0]?.name;
    document.getElementById("kpi-2-label").textContent = "Branches / Stale";
    document.getElementById("kpi-2-val").textContent = `${rawStore.repos.length} (${rawStore.repos.filter((b) => b.isStale).length})`;
    document.getElementById("kpi-3-label").textContent = "Active PRs";
    document.getElementById("kpi-3-val").textContent = activePRsCount;
    document.getElementById("kpi-4-label").textContent = "Completed PRs";
    document.getElementById("kpi-4-val").textContent = completedPRsCount;

    renderRepoTableBatch(false);
    renderRepoPrsTableBatch(false);
    renderChart(Object.keys(repoBranchCounts), Object.values(repoBranchCounts), "Branches per Repository");
    setStatus(`Loaded ${rawStore.repos.length} branches and ${allPRs.length} pull requests.`, "success");
  } catch (err) {
    setStatus(`Error fetching branches: ${err.message}`, "error");
  }
}

function renderRepoTableBatch(append = false) {
  const tbody = document.getElementById("branchesTableBody");
  const container = document.getElementById("seeMoreRepoContainer");
  const remainingEl = document.getElementById("repoRemainingCount");
  if (!append) tbody.innerHTML = "";

  if (rawStore.repos.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400">No branches found.</td></tr>`;
    container.classList.add("hidden");
    return;
  }

  const nextBatch = rawStore.repos.slice(rawStore.repoIndex, rawStore.repoIndex + PAGE_SIZE);
  rawStore.repoIndex += nextBatch.length;

  const html = nextBatch.map((b) => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-semibold text-slate-900">${b.repo}</td>
      <td class="p-4"><span class="font-mono text-xs text-blue-700 bg-blue-50 px-2 py-0.5 rounded font-semibold">${b.branch}</span></td>
      <td class="p-4">${b.isStale
        ? '<span class="bg-amber-100 text-amber-700 text-xs px-2 py-0.5 rounded-full font-semibold">Stale</span>'
        : '<span class="bg-emerald-100 text-emerald-700 text-xs px-2 py-0.5 rounded-full font-semibold">Active</span>'}</td>
      <td class="p-4 text-xs font-medium">${b.author}</td>
      <td class="p-4 text-xs text-slate-500">${b.date}</td>
      <td class="p-4 text-xs text-slate-600 max-w-xs truncate">${b.msg}</td>
    </tr>
  `).join("");

  tbody.insertAdjacentHTML("beforeend", html);
  const remaining = rawStore.repos.length - rawStore.repoIndex;
  container.classList.toggle("hidden", remaining <= 0);
  remainingEl.textContent = remaining;
}

function renderRepoPrsTableBatch(append = false) {
  const tbody = document.getElementById("repoPrsTableBody");
  const container = document.getElementById("seeMoreRepoPrsContainer");
  const remainingEl = document.getElementById("repoPrsRemainingCount");
  if (!append) tbody.innerHTML = "";

  if (rawStore.repoPrs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400">No pull requests found.</td></tr>`;
    container.classList.add("hidden");
    return;
  }

  const nextBatch = rawStore.repoPrs.slice(rawStore.repoPrsIndex, rawStore.repoPrsIndex + PAGE_SIZE);
  rawStore.repoPrsIndex += nextBatch.length;

  const html = nextBatch.map((pr) => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-semibold text-slate-900">${pr.repo}</td>
      <td class="p-4 font-medium text-slate-800 max-w-xs truncate">${pr.title}</td>
      <td class="p-4 font-mono text-xs text-slate-500">${pr.source} &rarr; ${pr.target}</td>
      <td class="p-4 text-xs font-medium text-slate-700">${pr.creator}</td>
      <td class="p-4"><span class="px-2 py-0.5 rounded-full text-xs font-semibold ${
        pr.status === "completed" ? "bg-emerald-100 text-emerald-700" :
        pr.status === "active" ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-600"
      }">${pr.status}</span></td>
      <td class="p-4 text-xs text-slate-500">${pr.createdDate}</td>
    </tr>
  `).join("");

  tbody.insertAdjacentHTML("beforeend", html);
  const remaining = rawStore.repoPrs.length - rawStore.repoPrsIndex;
  container.classList.toggle("hidden", remaining <= 0);
  remainingEl.textContent = remaining;
}

// ==========================================
// MODULE 2: USER ACCESS & TEAMS
// (Uses CoreRestClient teams + members. Project-level Security Groups,
//  e.g. Contributors/Readers/Admins, require the Graph API and are not
//  included here — see README "Known Gaps".)
// ==========================================
async function fetchUserAccessData() {
  const userQuery = document.getElementById("targetAccessUserQuery").value.trim().toLowerCase();

  showSection("access");
  setStatus(userQuery ? `Scanning teams for "${userQuery}"...` : "Fetching all project teams and members...", "info");

  let accessRows = [];
  let teamMemberCounts = {};

  try {
    const teams = await coreClient.getTeams(project.id, true, 500);

    await Promise.all(teams.map(async (t) => {
      try {
        const members = await coreClient.getTeamMembersWithExtendedProperties(project.id, t.id, 500);
        members.forEach((m) => {
          const name = m.identity?.displayName || "Unknown";
          const email = m.identity?.uniqueName || "N/A";
          if (!userQuery || name.toLowerCase().includes(userQuery) || email.toLowerCase().includes(userQuery)) {
            accessRows.push({ team: t.name, name, email });
            teamMemberCounts[t.name] = (teamMemberCounts[t.name] || 0) + 1;
          }
        });
      } catch (e) {
        console.warn(`Could not fetch members for team ${t.name}:`, e);
      }
    }));

    rawStore.access = accessRows;
    rawStore.accessIndex = 0;

    document.getElementById("kpi-1-val").textContent = userQuery || project.name;
    document.getElementById("kpi-2-label").textContent = "Teams";
    document.getElementById("kpi-2-val").textContent = Object.keys(teamMemberCounts).length;
    document.getElementById("kpi-3-label").textContent = "Total Memberships";
    document.getElementById("kpi-3-val").textContent = accessRows.length;
    document.getElementById("kpi-4-label").textContent = "Mode";
    document.getElementById("kpi-4-val").textContent = "Team Access";

    renderAccessTableBatch(false);
    renderChart(Object.keys(teamMemberCounts), Object.values(teamMemberCounts), "Members per Team");
    setStatus(`Loaded ${accessRows.length} member assignments across ${Object.keys(teamMemberCounts).length} teams.`, "success");
  } catch (err) {
    setStatus(`Error querying team access: ${err.message}`, "error");
  }
}

function renderAccessTableBatch(append = false) {
  const tbody = document.getElementById("accessTableBody");
  const container = document.getElementById("seeMoreAccessContainer");
  const remainingEl = document.getElementById("accessRemainingCount");
  if (!append) tbody.innerHTML = "";

  if (rawStore.access.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3" class="p-4 text-center text-slate-400">No team memberships found.</td></tr>`;
    container.classList.add("hidden");
    return;
  }

  const nextBatch = rawStore.access.slice(rawStore.accessIndex, rawStore.accessIndex + PAGE_SIZE);
  rawStore.accessIndex += nextBatch.length;

  const html = nextBatch.map((a) => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-semibold text-slate-900">${a.team}</td>
      <td class="p-4 font-medium">${a.name}</td>
      <td class="p-4 text-xs font-mono text-slate-600">${a.email}</td>
    </tr>
  `).join("");

  tbody.insertAdjacentHTML("beforeend", html);
  const remaining = rawStore.access.length - rawStore.accessIndex;
  container.classList.toggle("hidden", remaining <= 0);
  remainingEl.textContent = remaining;
}

// ==========================================
// MODULE 3: USER ACTIVITY & COMMITS
// ==========================================
async function fetchUserActivityData() {
  const userQuery = document.getElementById("targetUserQuery").value.trim();
  const timeframeDays = parseInt(document.getElementById("userTimeframeDays").value, 10);
  if (!userQuery) return showModal("Please enter a User Email or Name to search.", "targetUserQuery");

  showSection("activity");
  setStatus(`Scanning commits and PRs across repos for "${userQuery}"...`, "info");

  const queryLower = userQuery.toLowerCase();
  let userCommits = [];
  let userPRs = [];
  let reposTouched = new Set();

  let fromDate;
  if (timeframeDays > 0) {
    const d = new Date();
    d.setDate(d.getDate() - timeframeDays);
    fromDate = d.toISOString();
  }

  try {
    await Promise.all(cachedRepos.map(async (r) => {
      try {
        const commits = await gitClient.getCommits(r.id, {
          fromDate,
          $top: 500
        }, project.id, 0, 500);
        (commits || []).forEach((c) => {
          const email = (c.author?.email || "").toLowerCase();
          const name = (c.author?.name || "").toLowerCase();
          if (email.includes(queryLower) || name.includes(queryLower)) {
            reposTouched.add(r.name);
            userCommits.push({
              repo: r.name,
              commitId: (c.commitId || "").substring(0, 8),
              date: c.author?.date ? new Date(c.author.date).toLocaleString() : "N/A",
              comment: c.comment || ""
            });
          }
        });
      } catch (e) { console.warn(`Commit scan failed for ${r.name}:`, e); }

      try {
        const prs = await gitClient.getPullRequests(r.id, { status: 4 }, project.id, 0, 50);
        (prs || []).forEach((pr) => {
          const creatorEmail = (pr.createdBy?.uniqueName || "").toLowerCase();
          const creatorName = (pr.createdBy?.displayName || "").toLowerCase();
          if (creatorEmail.includes(queryLower) || creatorName.includes(queryLower)) {
            userPRs.push({
              repo: r.name,
              title: pr.title,
              source: (pr.sourceRefName || "").replace("refs/heads/", ""),
              target: (pr.targetRefName || "").replace("refs/heads/", ""),
              status: pr.status,
              createdDate: pr.creationDate ? new Date(pr.creationDate).toLocaleDateString() : "N/A"
            });
          }
        });
      } catch (e) { console.warn(`PR scan failed for ${r.name}:`, e); }
    }));

    rawStore.commits = userCommits;
    rawStore.commitsIndex = 0;

    document.getElementById("kpi-1-val").textContent = userQuery;
    document.getElementById("kpi-2-label").textContent = "Active Repos";
    document.getElementById("kpi-2-val").textContent = reposTouched.size;
    document.getElementById("kpi-3-label").textContent = "Pull Requests";
    document.getElementById("kpi-3-val").textContent = userPRs.length;
    document.getElementById("kpi-4-label").textContent = "Commits Made";
    document.getElementById("kpi-4-val").textContent = userCommits.length;

    renderCommitsTableBatch(false);

    document.getElementById("userPrTableBody").innerHTML = userPRs.length === 0
      ? `<tr><td colspan="5" class="p-4 text-center text-slate-400">No pull requests found.</td></tr>`
      : userPRs.map((pr) => `
          <tr class="hover:bg-slate-50 transition">
            <td class="p-4 font-semibold text-slate-900">${pr.repo}</td>
            <td class="p-4 font-medium text-slate-800">${pr.title}</td>
            <td class="p-4 font-mono text-xs text-slate-500">${pr.source} &rarr; ${pr.target}</td>
            <td class="p-4"><span class="px-2 py-0.5 rounded-full text-xs font-semibold ${pr.status === "completed" ? "bg-green-100 text-green-700" : "bg-blue-100 text-blue-700"}">${pr.status}</span></td>
            <td class="p-4 text-xs text-slate-500">${pr.createdDate}</td>
          </tr>
        `).join("");

    const repoCommitMap = {};
    userCommits.forEach((c) => (repoCommitMap[c.repo] = (repoCommitMap[c.repo] || 0) + 1));
    renderChart(Object.keys(repoCommitMap), Object.values(repoCommitMap), `Commits by ${userQuery}`);
    setStatus(`Found ${userCommits.length} commits and ${userPRs.length} PRs.`, "success");
  } catch (err) {
    setStatus(`Error fetching user activity: ${err.message}`, "error");
  }
}

function renderCommitsTableBatch(append = false) {
  const tbody = document.getElementById("userCommitsTableBody");
  const container = document.getElementById("seeMoreCommitsContainer");
  const remainingEl = document.getElementById("commitsRemainingCount");
  if (!append) tbody.innerHTML = "";

  if (rawStore.commits.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-400">No commits found.</td></tr>`;
    container.classList.add("hidden");
    return;
  }

  const nextBatch = rawStore.commits.slice(rawStore.commitsIndex, rawStore.commitsIndex + PAGE_SIZE);
  rawStore.commitsIndex += nextBatch.length;

  const html = nextBatch.map((c) => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-semibold text-slate-900">${c.repo}</td>
      <td class="p-4 font-mono text-xs text-blue-600 bg-blue-50 px-2 py-0.5 rounded">${c.commitId}</td>
      <td class="p-4 text-xs text-slate-500">${c.date}</td>
      <td class="p-4 text-xs text-slate-700">${c.comment}</td>
    </tr>
  `).join("");

  tbody.insertAdjacentHTML("beforeend", html);
  const remaining = rawStore.commits.length - rawStore.commitsIndex;
  container.classList.toggle("hidden", remaining <= 0);
  remainingEl.textContent = remaining;
}

// ==========================================
// MODULE 4: PIPELINES & BUILDS
// ==========================================
async function fetchPipelineData() {
  const perPipelineRuns = parseInt(document.getElementById("pipelineRunsTop").value, 10) || 20;

  showSection("pipelines");
  setStatus(`Scanning up to ${perPipelineRuns} runs per pipeline...`, "info");

  try {
    const definitions = await buildClient.getDefinitions(project.id);

    function parseTriggerType(reasonStr) {
      const r = (reasonStr || "").toLowerCase();
      if (r.includes("batchedci") || r.includes("individualci") || r === "ci") return "Auto (CI)";
      if (r.includes("pullrequest") || r.includes("validatepr")) return "Auto (PR)";
      if (r.includes("schedule")) return "Auto (Scheduled)";
      if (r.includes("buildcompletion") || r.includes("triggered")) return "Auto (Triggered)";
      return "Manual";
    }

    function parseBranch(refStr) {
      if (!refStr) return "main";
      return refStr
        .replace(/^refs\/heads\//, "")
        .replace(/^refs\/pull\/\d+\/merge/, "PR Merge")
        .replace(/^refs\/tags\//, "Tag: ");
    }

    let summaryMap = {};
    definitions.forEach((d) => {
      summaryMap[d.name] = { name: d.name, total: 0, succeeded: 0, failed: 0, autoTriggers: 0, manualTriggers: 0 };
    });

    let allRuns = [];
    const BATCH_SIZE = 10;

    for (let i = 0; i < definitions.length; i += BATCH_SIZE) {
      const batch = definitions.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (def) => {
        try {
          const builds = await buildClient.getBuilds(
            project.id,
            [def.id],
            undefined, undefined, undefined, undefined, undefined, undefined,
            undefined, undefined, undefined, undefined,
            perPipelineRuns
          );

          (builds || []).forEach((b) => {
            const result = (b.result || "unknown").toString().toLowerCase();
            const isSuccess = result === "succeeded";
            const trigger = parseTriggerType(b.reason);
            const isAuto = trigger.startsWith("Auto");
            const author = b.requestedFor?.displayName || b.requestedBy?.displayName || "Automated System";
            const branch = parseBranch(b.sourceBranch);

            summaryMap[def.name].total++;
            if (isSuccess) summaryMap[def.name].succeeded++;
            else summaryMap[def.name].failed++;
            if (isAuto) summaryMap[def.name].autoTriggers++;
            else summaryMap[def.name].manualTriggers++;

            allRuns.push({
              name: def.name,
              buildNumber: b.buildNumber || b.id,
              branch,
              reason: trigger,
              author,
              result: b.result || b.status || "unknown",
              finishTime: b.finishTime ? new Date(b.finishTime).toLocaleString() : (b.startTime ? "In Progress" : "Queued")
            });
          });
        } catch (err) {
          console.warn(`Build fetch failed for ${def.name}:`, err);
        }
      }));
    }

    pipelineSummaries = Object.values(summaryMap);
    rawStore.pipelines = allRuns;
    rawStore.pipelineIndex = 0;

    const totalSuccessful = pipelineSummaries.reduce((acc, p) => acc + p.succeeded, 0);
    const totalAuto = pipelineSummaries.reduce((acc, p) => acc + p.autoTriggers, 0);

    document.getElementById("kpi-1-val").textContent = `${project.name} (${definitions.length} Pipelines)`;
    document.getElementById("kpi-2-label").textContent = "Total Pipelines";
    document.getElementById("kpi-2-val").textContent = definitions.length;
    document.getElementById("kpi-3-label").textContent = "Successful Builds";
    document.getElementById("kpi-3-val").textContent = totalSuccessful;
    document.getElementById("kpi-4-label").textContent = "Auto / CI Triggers";
    document.getElementById("kpi-4-val").textContent = totalAuto;

    renderPipelineSummaryTable();
    renderPipelineTableBatch(false);

    const activeSummaries = pipelineSummaries.filter((p) => p.total > 0).slice(0, 20);
    const chartSource = activeSummaries.length > 0 ? activeSummaries : pipelineSummaries.slice(0, 15);
    renderChart(chartSource.map((p) => p.name), chartSource.map((p) => p.succeeded), "Successful Builds (Top Pipelines)");

    setStatus(`Loaded ${definitions.length} pipelines with ${allRuns.length} total runs.`, "success");
  } catch (err) {
    setStatus(`Error fetching pipelines: ${err.message}`, "error");
  }
}

function renderPipelineSummaryTable() {
  const tbody = document.getElementById("pipelineSummaryTableBody");
  if (pipelineSummaries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400">No pipelines found.</td></tr>`;
    return;
  }
  tbody.innerHTML = pipelineSummaries.map((p) => {
    const rate = p.total > 0 ? Math.round((p.succeeded / p.total) * 100) : 0;
    return `
      <tr class="hover:bg-slate-50 transition">
        <td class="p-4 font-semibold text-slate-900">${p.name}</td>
        <td class="p-4 font-mono font-medium">${p.total}</td>
        <td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-700">${p.succeeded}</span></td>
        <td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold bg-red-50 text-red-600">${p.failed}</span></td>
        <td class="p-4 font-mono text-xs text-blue-700">${p.autoTriggers}</td>
        <td class="p-4 font-mono text-xs text-slate-700">${p.manualTriggers}</td>
        <td class="p-4"><span class="px-2 py-0.5 rounded-full text-xs font-semibold ${rate >= 80 ? "bg-emerald-100 text-emerald-700" : rate >= 50 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700"}">${rate}%</span></td>
      </tr>`;
  }).join("");
}

function renderPipelineTableBatch(append = false) {
  const tbody = document.getElementById("pipelineTableBody");
  const container = document.getElementById("seeMorePipelinesContainer");
  const remainingEl = document.getElementById("pipelinesRemainingCount");
  if (!append) tbody.innerHTML = "";

  if (rawStore.pipelines.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400">No recent build runs found.</td></tr>`;
    container.classList.add("hidden");
    return;
  }

  const nextBatch = rawStore.pipelines.slice(rawStore.pipelineIndex, rawStore.pipelineIndex + PAGE_SIZE);
  rawStore.pipelineIndex += nextBatch.length;

  const html = nextBatch.map((r) => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-semibold text-slate-900">${r.name}</td>
      <td class="p-4 font-mono text-xs text-blue-600">#${r.buildNumber}</td>
      <td class="p-4 text-xs font-mono text-slate-700 font-semibold">${r.branch}</td>
      <td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold ${r.reason.includes("Auto") ? "bg-indigo-50 text-indigo-700 border border-indigo-200" : "bg-slate-100 text-slate-700"}">${r.reason}</span></td>
      <td class="p-4 text-xs font-medium text-slate-800">${r.author}</td>
      <td class="p-4"><span class="px-2 py-0.5 rounded-full text-xs font-semibold ${
        r.result === "succeeded" ? "bg-emerald-100 text-emerald-700" :
        r.result === "failed" ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
      }">${r.result}</span></td>
      <td class="p-4 text-xs text-slate-500">${r.finishTime}</td>
    </tr>
  `).join("");

  tbody.insertAdjacentHTML("beforeend", html);
  const remaining = rawStore.pipelines.length - rawStore.pipelineIndex;
  container.classList.toggle("hidden", remaining <= 0);
  remainingEl.textContent = remaining;
}

// ==========================================
// MODULE 5: WORK ITEMS & BACKLOG
// ==========================================
async function fetchWorkItemsData() {
  const targetUser = document.getElementById("targetWorkItemUser").value.trim();

  showSection("workitems");
  setStatus(targetUser ? `Querying work items assigned to "${targetUser}"...` : "Querying all active work items...", "info");

  try {
    let wiql = `SELECT [System.Id] FROM workitems WHERE [System.TeamProject] = @project`;
    if (targetUser) {
      wiql += ` AND [System.AssignedTo] CONTAINS '${targetUser.replace(/'/g, "''")}'`;
    }
    wiql += ` ORDER BY [System.ChangedDate] DESC`;

    const queryRes = await witClient.queryByWiql({ query: wiql }, project.id);
    const wiList = queryRes.workItems || [];
    const wiIds = wiList.slice(0, 200).map((w) => w.id);

    if (wiIds.length === 0) {
      document.getElementById("workItemsTableBody").innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400">No work items found in "${project.name}".</td></tr>`;
      document.getElementById("seeMoreWorkItemsContainer").classList.add("hidden");
      renderChart([], [], "Work Item States");
      setStatus("No work items found matching criteria.", "info");
      return;
    }

    const fields = ["System.Id", "System.Title", "System.WorkItemType", "System.State", "System.AssignedTo", "System.IterationPath", "System.CreatedDate"];
    const workItems = await witClient.getWorkItems(wiIds, project.id, undefined, undefined, undefined, fields);

    let stateCounts = {};
    let activeInProgressCount = 0, resolvedCount = 0, closedCount = 0;

    rawStore.workitems = (workItems || []).map((w) => {
      const f = w.fields || {};
      const type = f["System.WorkItemType"] || "Work Item";
      const state = f["System.State"] || "New";

      let assignedName = "Unassigned";
      if (f["System.AssignedTo"]) {
        assignedName = f["System.AssignedTo"].displayName || f["System.AssignedTo"].uniqueName || String(f["System.AssignedTo"]);
      }

      stateCounts[state] = (stateCounts[state] || 0) + 1;
      const sLower = state.toLowerCase();
      if (sLower === "resolved") resolvedCount++;
      else if (["closed", "done", "completed"].includes(sLower)) closedCount++;
      else if (["active", "in progress", "doing", "new", "to do"].includes(sLower)) activeInProgressCount++;

      return {
        id: w.id,
        type,
        title: f["System.Title"] || "Untitled",
        assignedTo: assignedName,
        state,
        createdDate: f["System.CreatedDate"] ? new Date(f["System.CreatedDate"]).toLocaleDateString() : "N/A"
      };
    });

    rawStore.workitemsIndex = 0;

    document.getElementById("kpi-1-val").textContent = targetUser || `${project.name} (All Backlog)`;
    document.getElementById("kpi-2-label").textContent = "Total Work Items";
    document.getElementById("kpi-2-val").textContent = rawStore.workitems.length;
    document.getElementById("kpi-3-label").textContent = "Active / In Progress";
    document.getElementById("kpi-3-val").textContent = activeInProgressCount;
    document.getElementById("kpi-4-label").textContent = "Resolved";
    document.getElementById("kpi-4-val").textContent = resolvedCount;
    document.getElementById("kpi-5-label").textContent = "Closed / Done";
    document.getElementById("kpi-5-val").textContent = closedCount;

    renderWorkItemsTableBatch(false);
    renderChart(Object.keys(stateCounts), Object.values(stateCounts), "Work Items by State");
    setStatus(`Loaded ${rawStore.workitems.length} work items successfully.`, "success");
  } catch (err) {
    setStatus(`Error fetching work items: ${err.message}`, "error");
  }
}

function renderWorkItemsTableBatch(append = false) {
  const tbody = document.getElementById("workItemsTableBody");
  const container = document.getElementById("seeMoreWorkItemsContainer");
  const remainingEl = document.getElementById("workItemsRemainingCount");
  if (!append) tbody.innerHTML = "";

  if (rawStore.workitems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-slate-400">No work items found.</td></tr>`;
    container.classList.add("hidden");
    return;
  }

  const nextBatch = rawStore.workitems.slice(rawStore.workitemsIndex, rawStore.workitemsIndex + PAGE_SIZE);
  rawStore.workitemsIndex += nextBatch.length;

  const html = nextBatch.map((r) => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-mono text-xs font-bold text-blue-600">#${r.id}</td>
      <td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-700">${r.type}</span></td>
      <td class="p-4 font-medium text-slate-900 max-w-sm truncate" title="${r.title}">${r.title}</td>
      <td class="p-4 text-xs font-semibold ${r.assignedTo === "Unassigned" ? "text-slate-400 italic" : "text-slate-800"}">${r.assignedTo}</td>
      <td class="p-4 text-xs"><span class="px-2 py-0.5 rounded-full font-semibold ${
        ["closed", "done", "resolved", "completed"].includes(r.state.toLowerCase()) ? "bg-emerald-100 text-emerald-700" :
        ["active", "in progress", "doing"].includes(r.state.toLowerCase()) ? "bg-blue-100 text-blue-700" : "bg-slate-100 text-slate-700"
      }">${r.state}</span></td>
      <td class="p-4 text-xs text-slate-500">${r.createdDate}</td>
    </tr>
  `).join("");

  tbody.insertAdjacentHTML("beforeend", html);
  const remaining = rawStore.workitems.length - rawStore.workitemsIndex;
  container.classList.toggle("hidden", remaining <= 0);
  remainingEl.textContent = remaining;
}

// ==========================================
// FILTER & EXCEL EXPORT
// ==========================================
function filterActiveTable() {
  const query = document.getElementById("tableFilterInput").value.toLowerCase();
  const activeSection = document.getElementById(activeViewSection);
  if (!activeSection) return;
  activeSection.querySelectorAll("tbody tr").forEach((r) => {
    r.style.display = r.textContent.toLowerCase().includes(query) ? "" : "none";
  });
}

function exportToExcelFile(sheetsData, baseFileName) {
  if (typeof XLSX === "undefined") {
    alert("Excel library is still loading, please try again in a moment.");
    return;
  }
  const wb = XLSX.utils.book_new();
  let hasData = false;
  for (const [sheetName, data] of Object.entries(sheetsData)) {
    if (data && data.length > 0) {
      const ws = XLSX.utils.json_to_sheet(data);
      XLSX.utils.book_append_sheet(wb, ws, sheetName.substring(0, 31));
      hasData = true;
    }
  }
  if (!hasData) return;
  XLSX.writeFile(wb, `${baseFileName}_${Date.now()}.xlsx`);
}

function exportBranchesToXLSX() {
  if (!rawStore.repos.length) return;
  const data = rawStore.repos.map((b) => ({
    Repository: b.repo, "Branch Name": b.branch, "Status / Health": b.isStale ? "Stale" : "Active",
    "Last Author": b.author, "Last Commit Date": b.date, "Commit Message": b.msg
  }));
  exportToExcelFile({ Branches: data }, "AzureDevOps_Branches");
}

function exportRepoPrsToXLSX() {
  if (!rawStore.repoPrs.length) return;
  const data = rawStore.repoPrs.map((p) => ({
    Repository: p.repo, "PR Title": p.title, "Source Branch": p.source, "Target Branch": p.target,
    Creator: p.creator, Status: p.status, "Created Date": p.createdDate
  }));
  exportToExcelFile({ "Pull Requests": data }, "AzureDevOps_PullRequests");
}

function exportAccessToXLSX() {
  if (!rawStore.access.length) return;
  const data = rawStore.access.map((a) => ({ Team: a.team, "User Display Name": a.name, "User Principal / Email": a.email }));
  exportToExcelFile({ "Team Access": data }, "AzureDevOps_Access");
}

function exportPipelinesToXLSX() {
  if (!pipelineSummaries.length) return;
  const summaryData = pipelineSummaries.map((p) => ({
    "Pipeline Name": p.name, "Total Runs": p.total, "Successful Builds": p.succeeded, "Failed / Other": p.failed,
    "Auto CI Triggers": p.autoTriggers, "Manual Triggers": p.manualTriggers,
    "Success Rate": `${p.total > 0 ? Math.round((p.succeeded / p.total) * 100) : 0}%`
  }));
  const runsData = (rawStore.pipelines || []).map((r) => ({
    "Pipeline Name": r.name, "Build Number": r.buildNumber, Branch: r.branch, "Trigger Type": r.reason,
    "Triggered By": r.author, Result: r.result, "Finish Time": r.finishTime
  }));
  exportToExcelFile({ "Pipelines Inventory": summaryData, "Build Runs History": runsData }, "AzureDevOps_Pipelines_Analytics");
}

function exportCurrentTableToXLSX() {
  if (activeViewSection === "view-repositories") {
    exportBranchesToXLSX();
    exportRepoPrsToXLSX();
  } else if (activeViewSection === "view-access") {
    exportAccessToXLSX();
  } else if (activeViewSection === "view-activity") {
    const data = (rawStore.commits || []).map((c) => ({ Repository: c.repo, "Commit ID": c.commitId, "Commit Date": c.date, Message: c.comment }));
    exportToExcelFile({ "User Commits": data }, "AzureDevOps_User_Activity");
  } else if (activeViewSection === "view-pipelines") {
    exportPipelinesToXLSX();
  } else if (activeViewSection === "view-workitems") {
    const data = (rawStore.workitems || []).map((w) => ({
      ID: w.id, "Work Item Type": w.type, Title: w.title, "Assigned To": w.assignedTo, State: w.state, "Created Date": w.createdDate
    }));
    exportToExcelFile({ "Work Items": data }, "AzureDevOps_WorkItems");
  }
}

// ==========================================
// CHART RENDERING
// ==========================================
function changeChartType(type) {
  currentChartType = type.toLowerCase() === "pie" ? "pie" : type;
  renderChart(currentChartData.labels, currentChartData.values, currentChartData.label);
}

function renderChart(labels, data, datasetLabel) {
  currentChartData = { labels, values: data, label: datasetLabel };
  const ctx = document.getElementById("analyticsChart").getContext("2d");
  if (chartInstance) chartInstance.destroy();

  const palette = ["#3b82f6", "#10b981", "#6366f1", "#f59e0b", "#ec4899", "#8b5cf6", "#06b6d4", "#84cc16", "#f43f5e", "#a855f7"];
  const isPie = currentChartType === "pie" || currentChartType === "doughnut";
  const isLine = currentChartType === "line";

  if (typeof ChartDataLabels !== "undefined") {
    Chart.register(ChartDataLabels);
  }

  chartInstance = new Chart(ctx, {
    type: currentChartType,
    data: {
      labels: labels.length ? labels : ["No Data"],
      datasets: [{
        label: datasetLabel,
        data: data.length ? data : [0],
        backgroundColor: isPie ? palette : "#3b82f6",
        borderColor: isLine ? "#2563eb" : undefined,
        pointBackgroundColor: isLine ? "#2563eb" : undefined,
        pointRadius: isLine ? 5 : undefined,
        fill: isLine ? false : undefined,
        borderRadius: currentChartType === "bar" ? 6 : 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: isPie ? 10 : 25, bottom: 10 } },
      plugins: {
        legend: { display: isPie, position: "right" },
        datalabels: {
          display: true,
          color: isPie ? "#ffffff" : "#1e293b",
          font: { weight: "bold", size: 11 },
          anchor: isPie ? "center" : "end",
          align: isPie ? "center" : "top",
          offset: isPie ? 0 : 2,
          formatter: (value) => (value > 0 ? value : (isPie ? "" : "0"))
        }
      },
      scales: isPie ? {} : {
        y: { beginAtZero: true, grid: { color: "#f1f5f9" }, ticks: { precision: 0 } },
        x: { grid: { display: false }, ticks: { autoSkip: false, maxRotation: 45, minRotation: 20 } }
      }
    }
  });
}
