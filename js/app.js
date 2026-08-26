let chartInstance = null;
let currentFocusTarget = null;
let cachedRepos = [];
let currentChartData = { labels: [], values: [], label: 'Overview' };
let currentChartType = 'bar';
let activeViewSection = 'view-repositories';
const PAGE_SIZE = 10;

let rawStore = {
  repos: [], repoIndex: 0,
  repoPrs: [], repoPrsIndex: 0,
  access: [], accessIndex: 0,
  commits: [], commitsIndex: 0,
  pipelines: [], pipelineIndex: 0,
  workitems: [], workitemsIndex: 0
};

function showModal(message, targetFocusId) {
  currentFocusTarget = targetFocusId;
  document.getElementById('modalMessage').textContent = message;
  document.getElementById('validationModal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('validationModal').classList.add('hidden');
  if (currentFocusTarget) {
    const target = document.getElementById(currentFocusTarget);
    if (target) {
      target.focus();
      target.classList.add('ring-2', 'ring-red-400');
      setTimeout(() => target.classList.remove('ring-2', 'ring-red-400'), 1500);
    }
  }
}

function setStatus(msg, type = 'info') {
  const el = document.getElementById('statusBar');
  el.classList.remove('hidden', 'bg-red-50', 'text-red-700', 'bg-green-50', 'text-green-700', 'bg-blue-50', 'text-blue-700');
  if (type === 'error') el.classList.add('bg-red-50', 'text-red-700');
  else if (type === 'success') el.classList.add('bg-green-50', 'text-green-700');
  else el.classList.add('bg-blue-50', 'text-blue-700');
  el.textContent = msg;
}

function updatePathPreview(org = '', project = '') {
  const linkEl = document.getElementById('generatedUrlLink');
  let url = 'https://dev.azure.com/';
  if (org) url += org;
  if (org && project) url += `/${project}`;

  linkEl.textContent = url;
  linkEl.href = url;
  if (org) {
    linkEl.className = 'text-blue-600 font-mono underline hover:text-blue-800 cursor-pointer';
    linkEl.target = '_blank';
  } else {
    linkEl.className = 'text-slate-400 font-mono underline cursor-default';
    linkEl.removeAttribute('target');
  }
}

function initCredentials() {
  const savedOrg = localStorage.getItem('azdo_org');
  const savedPat = localStorage.getItem('azdo_pat');
  if (savedOrg) document.getElementById('targetOrg').value = savedOrg;
  if (savedPat) {
    document.getElementById('targetPat').value = savedPat;
    document.getElementById('chkRememberCreds').checked = true;
  }
  handleOrgChange();
}

function toggleRememberCreds() {
  const isChecked = document.getElementById('chkRememberCreds').checked;
  if (isChecked) {
    localStorage.setItem('azdo_org', document.getElementById('targetOrg').value.trim());
    localStorage.setItem('azdo_pat', document.getElementById('targetPat').value.trim());
  } else {
    localStorage.removeItem('azdo_org');
    localStorage.removeItem('azdo_pat');
  }
}

function handleOrgChange() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  updatePathPreview(org);
  resetDropdown('projectSelect', '-- Load PAT first --');
  resetDropdown('categorySelect', '-- Select Project first --');
  document.getElementById('step5Container').classList.add('hidden');
  if (document.getElementById('chkRememberCreds').checked) {
    localStorage.setItem('azdo_org', document.getElementById('targetOrg').value.trim());
  }
}

function resetDropdown(id, placeholder) {
  const el = document.getElementById(id);
  el.innerHTML = `<option value="">${placeholder}</option>`;
  el.disabled = true;
  el.classList.add('bg-slate-100', 'cursor-not-allowed');
  el.classList.remove('bg-white');
}

function enableDropdown(id) {
  const el = document.getElementById(id);
  el.disabled = false;
  el.classList.remove('bg-slate-100', 'cursor-not-allowed');
  el.classList.add('bg-white');
}

async function loadProjectsList() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const pat = document.getElementById('targetPat').value.trim();

  if (!org) return showModal('Please enter the Organization Name or URL first.', 'targetOrg');
  if (!pat) return showModal('Please enter your Personal Access Token (PAT).', 'targetPat');

  if (document.getElementById('chkRememberCreds').checked) {
    localStorage.setItem('azdo_org', org);
    localStorage.setItem('azdo_pat', pat);
  }

  const authHeader = 'Basic ' + btoa(':' + pat);
  setStatus(`Loading projects from https://dev.azure.com/${org}...`, 'info');

  try {
    const url = `https://dev.azure.com/${org}/_apis/projects?api-version=${API_VERSION}&$top=500`;
    const data = await fetchAzDo(url, authHeader);
    const projects = data.value || [];

    const projDropdown = document.getElementById('projectSelect');
    projDropdown.innerHTML = '<option value="">-- Select a Project --</option>';

    projects.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name;
      projDropdown.appendChild(opt);
    });

    enableDropdown('projectSelect');
    resetDropdown('categorySelect', '-- Select Project first --');
    document.getElementById('step5Container').classList.add('hidden');
    setStatus(`Loaded ${projects.length} projects successfully! Please choose a project.`, 'success');
  } catch (err) {
    setStatus(`Error loading projects: ${err.message}`, 'error');
  }
}

async function handleProjectSelection() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim();

  if (!project) {
    resetDropdown('categorySelect', '-- Select Project first --');
    document.getElementById('step5Container').classList.add('hidden');
    updatePathPreview(org);
    return;
  }

  updatePathPreview(org, project);

  const catSelect = document.getElementById('categorySelect');
  catSelect.innerHTML = `
    <option value="">-- Choose Category --</option>
    <option value="repositories">Repositories & Branches</option>
    <option value="user_access">User Access & Teams</option>
    <option value="user_activity">User Activity & Commits</option>
    <option value="pipelines">Pipelines & Builds</option>
    <option value="work_items">Work Items & Backlog</option>
  `;
  enableDropdown('categorySelect');
  document.getElementById('step5Container').classList.add('hidden');

  const authHeader = 'Basic ' + btoa(':' + pat);
  try {
    const url = `https://dev.azure.com/${org}/${project}/_apis/git/repositories?api-version=${API_VERSION}`;
    const data = await fetchAzDo(url, authHeader);
    cachedRepos = data.value || [];
  } catch (e) {
    console.warn('Could not prefetch repos:', e);
  }
}

function handleCategorySelection() {
  const cat = document.getElementById('categorySelect').value;
  const step5 = document.getElementById('step5Container');
  const subRepo = document.getElementById('substepRepo');
  const subAccess = document.getElementById('substepAccess');
  const subActivity = document.getElementById('substepActivity');
  const subPipelines = document.getElementById('substepPipelines');
  const subWorkItems = document.getElementById('substepWorkItems');

  if (!cat) {
    step5.classList.add('hidden');
    return;
  }

  step5.classList.remove('hidden');
  [subRepo, subAccess, subActivity, subPipelines, subWorkItems].forEach(el => el.classList.add('hidden'));

  if (cat === 'repositories') {
    subRepo.classList.remove('hidden');
    populateRepoDropdown();
  } else if (cat === 'user_access') {
    subAccess.classList.remove('hidden');
  } else if (cat === 'user_activity') {
    subActivity.classList.remove('hidden');
  } else if (cat === 'pipelines') {
    subPipelines.classList.remove('hidden');
  } else if (cat === 'work_items') {
    subWorkItems.classList.remove('hidden');
  }
}

function showSection(viewId) {
  activeViewSection = `view-${viewId}`;
  ['repositories', 'access', 'activity', 'pipelines', 'workitems'].forEach(v => {
    document.getElementById(`view-${v}`).classList.toggle('hidden', v !== viewId);
  });
}

function filterActiveTable() {
  const query = document.getElementById('tableFilterInput').value.toLowerCase();
  const activeSection = document.getElementById(activeViewSection);
  if (!activeSection) return;

  const rows = activeSection.querySelectorAll('tbody tr');
  rows.forEach(r => {
    const text = r.textContent.toLowerCase();
    r.style.display = text.includes(query) ? '' : 'none';
  });
}

function exportToExcelFile(sheetsData, baseFileName) {
  if (typeof XLSX === 'undefined') {
    alert('Excel library is still loading, please try again in a moment.');
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

function exportCurrentTableToXLSX() {
  if (activeViewSection === 'view-repositories') {
    const branchData = (rawStore.repos || []).map(b => ({
      "Repository": b.repo,
      "Branch Name": b.branch,
      "Status / Health": b.isStale ? "Stale" : "Active",
      "Last Author": b.author,
      "Last Commit Date": b.date,
      "Commit Message": b.msg
    }));

    const prData = (rawStore.repoPrs || []).map(p => ({
      "Repository": p.repo,
      "PR Title": p.title,
      "Source Branch": p.source,
      "Target Branch": p.target,
      "Creator": p.creator,
      "Status": p.status,
      "Created Date": p.createdDate
    }));

    exportToExcelFile({ "Branches": branchData, "Pull Requests": prData }, "AzureDevOps_Repositories_Telemetry");
  } 
  else if (activeViewSection === 'view-access') {
    exportAccessToXLSX();
  } 
  else if (activeViewSection === 'view-activity') {
    const commitData = (rawStore.commits || []).map(c => ({
      "Repository": c.repo,
      "Commit ID": c.commitId,
      "Commit Date": c.date,
      "Message": c.comment
    }));
    exportToExcelFile({ "User Commits": commitData }, "AzureDevOps_User_Activity");
  } 
  else if (activeViewSection === 'view-pipelines') {
    exportPipelinesToXLSX();
  } 
  else if (activeViewSection === 'view-workitems') {
    const wiData = (rawStore.workitems || []).map(w => ({
      "ID": w.id,
      "Work Item Type": w.type,
      "Title": w.title,
      "Assigned To": w.assignedTo,
      "State": w.state,
      "Created Date": w.createdDate
    }));
    exportToExcelFile({ "Work Items": wiData }, "AzureDevOps_WorkItems");
  }
}

function changeChartType(type) {
  currentChartType = type.toLowerCase() === 'pie' ? 'pie' : type;
  renderChart(currentChartData.labels, currentChartData.values, currentChartData.label);
}

function renderChart(labels, data, datasetLabel) {
  currentChartData = { labels, values: data, label: datasetLabel };
  const ctx = document.getElementById('analyticsChart').getContext('2d');
  if (chartInstance) chartInstance.destroy();

  const palette = ['#3b82f6', '#10b981', '#6366f1', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4', '#84cc16', '#f43f5e', '#a855f7'];
  const isPie = currentChartType === 'pie' || currentChartType === 'doughnut';
  const isLine = currentChartType === 'line';

  if (typeof ChartDataLabels !== 'undefined') {
    Chart.register(ChartDataLabels);
  }

  chartInstance = new Chart(ctx, {
    type: currentChartType,
    data: {
      labels: labels.length ? labels : ['No Data'],
      datasets: [{
        label: datasetLabel,
        data: data.length ? data : [0],
        backgroundColor: isPie ? palette : '#3b82f6',
        borderColor: isLine ? '#2563eb' : undefined,
        pointBackgroundColor: isLine ? '#2563eb' : undefined,
        pointRadius: isLine ? 5 : undefined,
        fill: isLine ? false : undefined,
        borderRadius: currentChartType === 'bar' ? 6 : 0
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: {
          top: isPie ? 10 : 25,
          bottom: 10
        }
      },
      plugins: {
        legend: { 
          display: isPie,
          position: 'right'
        },
        datalabels: {
          display: true,
          color: isPie ? '#ffffff' : '#1e293b',
          font: {
            weight: 'bold',
            size: 11
          },
          anchor: isPie ? 'center' : 'end',
          align: isPie ? 'center' : 'top',
          offset: isPie ? 0 : 2,
          formatter: function(value) {
            return value > 0 ? value : (isPie ? '' : '0');
          }
        }
      },
      scales: isPie ? {} : {
        y: { 
          beginAtZero: true, 
          grid: { color: '#f1f5f9' },
          ticks: { precision: 0 }
        },
        x: { 
          grid: { display: false },
          ticks: {
            autoSkip: false,
            maxRotation: 45,
            minRotation: 20
          }
        }
      }
    }
  });
}

document.addEventListener('DOMContentLoaded', initCredentials);