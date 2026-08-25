let pipelineSummaries = [];

async function fetchPipelineData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim();
  const perPipelineRuns = parseInt(document.getElementById('pipelineRunsTop').value, 10) || 20;

  const authHeader = 'Basic ' + btoa(':' + pat);
  showSection('pipelines');
  setStatus(`Scanning all pipelines and up to ${perPipelineRuns} runs per pipeline...`, 'info');

  try {
    const modernUrl = `https://dev.azure.com/${org}/${project}/_apis/pipelines?api-version=${API_VERSION}`;
    const classicUrl = `https://dev.azure.com/${org}/${project}/_apis/build/definitions?api-version=${API_VERSION}`;

    const [modernRes, classicRes] = await Promise.allSettled([
      fetchAzDo(modernUrl, authHeader),
      fetchAzDo(classicUrl, authHeader)
    ]);

    const pipelineMap = new Map();

    if (modernRes.status === 'fulfilled' && modernRes.value?.value) {
      modernRes.value.value.forEach(p => pipelineMap.set(p.name, { id: p.id, name: p.name }));
    }

    if (classicRes.status === 'fulfilled' && classicRes.value?.value) {
      classicRes.value.value.forEach(d => {
        if (!pipelineMap.has(d.name)) {
          pipelineMap.set(d.name, { id: d.id, name: d.name });
        }
      });
    }

    function parseTriggerType(reasonStr) {
      const r = (reasonStr || '').toLowerCase();
      if (r.includes('individualci') || r.includes('batchedci') || r === 'ci') return 'Auto (CI)';
      if (r.includes('pullrequest') || r.includes('validatepr')) return 'Auto (PR)';
      if (r.includes('schedule')) return 'Auto (Scheduled)';
      if (r.includes('buildcompletion') || r.includes('triggered')) return 'Auto (Triggered)';
      if (r.includes('manual') || r.includes('usercreated') || r.includes('none')) return 'Manual';
      return 'Manual';
    }

    function parseBranch(refStr, buildObj) {
      let branch = refStr || buildObj?.sourceBranch || '';
      if (!branch && buildObj?.triggerInfo?.['pr.sourceBranch']) {
        branch = buildObj.triggerInfo['pr.sourceBranch'];
      }
      if (!branch) return 'main';
      return branch
        .replace(/^refs\/heads\//, '')
        .replace(/^refs\/pull\/\d+\/merge/, 'PR Merge')
        .replace(/^refs\/tags\//, 'Tag: ');
    }

    function parseAuthor(buildObj, triggerType) {
      const requestedUser = buildObj.requestedBy?.displayName || 
                            buildObj.requestedFor?.displayName || 
                            buildObj.lastChangedBy?.displayName;

      if (triggerType === 'Manual') {
        return requestedUser || 'Manual User';
      }
      if (triggerType === 'Auto (PR)') {
        return buildObj.triggerInfo?.['pr.sender.name'] || requestedUser || 'PR Author';
      }
      if (triggerType === 'Auto (Scheduled)') {
        return 'Scheduled Timer';
      }
      return requestedUser || 'Automated System';
    }

    let summaryMap = {};
    pipelineMap.forEach((pipe, name) => {
      summaryMap[name] = {
        name: name,
        total: 0,
        succeeded: 0,
        failed: 0,
        autoTriggers: 0,
        manualTriggers: 0
      };
    });

    let allBuilds = [];
    let contToken = null;
    let batchCount = 0;

    do {
      let bUrl = `https://dev.azure.com/${org}/${project}/_apis/build/builds?$top=1000&queryOrder=queueTimeDescending&api-version=${API_VERSION}`;
      if (contToken) {
        bUrl += `&continuationToken=${encodeURIComponent(contToken)}`;
      }

      const bData = await fetchAzDo(bUrl, authHeader);
      const list = bData?.value || [];
      allBuilds.push(...list);
      contToken = bData?.continuationToken;
      batchCount++;
    } while (contToken && batchCount < 5);

    let perPipelineCounters = {};
    let filteredRuns = [];

    allBuilds.forEach(b => {
      const pName = b.definition?.name || 'Unnamed Pipeline';

      if (!summaryMap[pName]) {
        summaryMap[pName] = { name: pName, total: 0, succeeded: 0, failed: 0, autoTriggers: 0, manualTriggers: 0 };
        if (!pipelineMap.has(pName)) {
          pipelineMap.set(pName, { id: b.definition?.id, name: pName });
        }
      }

      if (!perPipelineCounters[pName]) {
        perPipelineCounters[pName] = 0;
      }

      if (perPipelineCounters[pName] >= perPipelineRuns) {
        return;
      }
      perPipelineCounters[pName]++;

      const result = (b.result || b.status || 'unknown').toLowerCase();
      const isSuccess = result === 'succeeded';
      const trigger = parseTriggerType(b.reason);
      const isAuto = trigger.startsWith('Auto');
      const author = parseAuthor(b, trigger);
      const branch = parseBranch(b.sourceBranch, b);

      summaryMap[pName].total++;
      if (isSuccess) summaryMap[pName].succeeded++;
      else summaryMap[pName].failed++;

      if (isAuto) summaryMap[pName].autoTriggers++;
      else summaryMap[pName].manualTriggers++;

      filteredRuns.push({
        name: pName,
        buildNumber: b.buildNumber || `#${b.id}`,
        branch: branch,
        reason: trigger,
        author: author,
        result: b.result || b.status || 'unknown',
        finishTime: b.finishTime ? new Date(b.finishTime).toLocaleString() : (b.startTime ? 'In Progress' : 'Queued')
      });
    });

    const emptyPipelines = Array.from(pipelineMap.values()).filter(p => !summaryMap[p.name] || summaryMap[p.name].total === 0).slice(0, 15);
    if (emptyPipelines.length > 0) {
      await Promise.all(emptyPipelines.map(async (pipe) => {
        try {
          const rUrl = `https://dev.azure.com/${org}/${project}/_apis/pipelines/${pipe.id}/runs?$top=${perPipelineRuns}&api-version=${API_VERSION}`;
          const rData = await fetchAzDo(rUrl, authHeader);
          const runs = rData?.value || [];

          runs.forEach(r => {
            const isSuccess = (r.result || '').toLowerCase() === 'succeeded';
            const branchName = parseBranch(r.resources?.repositories?.self?.refName || r.resources?.repositories?.self?.version);
            const trigger = parseTriggerType(r.variables?.['Build.Reason']?.value);
            const author = r.variables?.['Build.RequestedFor']?.value || 'Automated System';

            summaryMap[pipe.name].total++;
            if (isSuccess) summaryMap[pipe.name].succeeded++;
            else summaryMap[pipe.name].failed++;

            if (trigger.startsWith('Auto')) summaryMap[pipe.name].autoTriggers++;
            else summaryMap[pipe.name].manualTriggers++;

            filteredRuns.push({
              name: pipe.name,
              buildNumber: r.name || `#${r.id}`,
              branch: branchName,
              reason: trigger,
              author: author,
              result: r.result || r.state || 'unknown',
              finishTime: r.finishedDate ? new Date(r.finishedDate).toLocaleString() : 'Running...'
            });
          });
        } catch (e) {}
      }));
    }

    pipelineSummaries = Object.values(summaryMap);
    rawStore.pipelines = filteredRuns;
    rawStore.pipelineIndex = 0;

    const totalSuccessful = pipelineSummaries.reduce((acc, p) => acc + p.succeeded, 0);
    const totalAuto = pipelineSummaries.reduce((acc, p) => acc + p.autoTriggers, 0);

    document.getElementById('kpi-1-val').textContent = `${project} (${pipelineMap.size} Pipelines)`;
    document.getElementById('kpi-2-label').textContent = 'Total Pipelines';
    document.getElementById('kpi-2-val').textContent = pipelineMap.size;
    document.getElementById('kpi-3-label').textContent = 'Successful Builds';
    document.getElementById('kpi-3-val').textContent = totalSuccessful;
    document.getElementById('kpi-4-label').textContent = 'Auto / CI Triggers';
    document.getElementById('kpi-4-val').textContent = totalAuto;
    document.getElementById('kpi-5-label').textContent = 'Total Runs Loaded';
    document.getElementById('kpi-5-val').textContent = filteredRuns.length;

    renderPipelineSummaryTable();
    renderPipelineTableBatch(false);

    const activeSummaries = pipelineSummaries.filter(p => p.total > 0).slice(0, 20);
    const chartLabels = activeSummaries.length > 0 ? activeSummaries.map(p => p.name) : pipelineSummaries.slice(0, 15).map(p => p.name);
    const chartData = activeSummaries.length > 0 ? activeSummaries.map(p => p.succeeded) : pipelineSummaries.slice(0, 15).map(p => p.succeeded);
    renderChart(chartLabels, chartData, 'Successful Builds (Top Pipelines)');

    setStatus(`Loaded ${pipelineMap.size} pipelines with ${filteredRuns.length} total runs.`, 'success');
  } catch (err) {
    setStatus(`Error fetching pipelines: ${err.message}`, 'error');
  }
}

function renderPipelineSummaryTable() {
  const tbody = document.getElementById('pipelineSummaryTableBody');
  if (!tbody) return;

  if (pipelineSummaries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400">No pipelines found.</td></tr>`;
    return;
  }

  tbody.innerHTML = pipelineSummaries.map(p => {
    const rate = p.total > 0 ? Math.round((p.succeeded / p.total) * 100) : 0;
    return `
      <tr class="hover:bg-slate-50 transition">
        <td class="p-4 font-semibold text-slate-900">${p.name}</td>
        <td class="p-4 font-mono font-medium">${p.total}</td>
        <td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold bg-emerald-100 text-emerald-700">${p.succeeded}</span></td>
        <td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold bg-red-50 text-red-600">${p.failed}</span></td>
        <td class="p-4 font-mono text-xs text-blue-700">${p.autoTriggers}</td>
        <td class="p-4 font-mono text-xs text-slate-700">${p.manualTriggers}</td>
        <td class="p-4">
          <span class="px-2 py-0.5 rounded-full text-xs font-semibold ${rate >= 80 ? 'bg-emerald-100 text-emerald-700' : rate >= 50 ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'}">${rate}%</span>
        </td>
      </tr>
    `;
  }).join('');
}

function renderPipelineTableBatch(append = false) {
  const tbody = document.getElementById('pipelineTableBody');
  const container = document.getElementById('seeMorePipelinesContainer');
  const remainingEl = document.getElementById('pipelinesRemainingCount');

  if (!append) tbody.innerHTML = '';

  if (rawStore.pipelines.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400">No recent build runs found.</td></tr>`;
    container.classList.add('hidden');
    return;
  }

  const nextBatch = rawStore.pipelines.slice(rawStore.pipelineIndex, rawStore.pipelineIndex + PAGE_SIZE);
  rawStore.pipelineIndex += nextBatch.length;

  const html = nextBatch.map(r => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-semibold text-slate-900">${r.name}</td>
      <td class="p-4 font-mono text-xs text-blue-600">${r.buildNumber}</td>
      <td class="p-4 text-xs font-mono text-slate-700 font-semibold">${r.branch}</td>
      <td class="p-4"><span class="px-2 py-0.5 rounded text-xs font-semibold ${r.reason.includes('Auto') ? 'bg-indigo-50 text-indigo-700 border border-indigo-200' : 'bg-slate-100 text-slate-700'}">${r.reason}</span></td>
      <td class="p-4 text-xs font-medium text-slate-800">${r.author}</td>
      <td class="p-4">
        <span class="px-2 py-0.5 rounded-full text-xs font-semibold ${
          r.result === 'succeeded' ? 'bg-emerald-100 text-emerald-700' :
          r.result === 'failed' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
        }">${r.result}</span>
      </td>
      <td class="p-4 text-xs text-slate-500">${r.finishTime}</td>
    </tr>
  `).join('');

  tbody.insertAdjacentHTML('beforeend', html);

  const remaining = rawStore.pipelines.length - rawStore.pipelineIndex;
  if (remaining > 0) {
    container.classList.remove('hidden');
    remainingEl.textContent = remaining;
  } else {
    container.classList.add('hidden');
  }
}

function exportPipelinesToXLSX() {
  if (!pipelineSummaries || pipelineSummaries.length === 0) return;
  const summaryData = pipelineSummaries.map(p => ({
    "Pipeline Name": p.name,
    "Total Runs": p.total,
    "Successful Builds": p.succeeded,
    "Failed / Other": p.failed,
    "Auto CI Triggers": p.autoTriggers,
    "Manual Triggers": p.manualTriggers,
    "Success Rate": `${p.total > 0 ? Math.round((p.succeeded / p.total) * 100) : 0}%`
  }));

  const runsData = (rawStore.pipelines || []).map(r => ({
    "Pipeline Name": r.name,
    "Build Number": r.buildNumber,
    "Branch": r.branch,
    "Trigger Type": r.reason,
    "Triggered By": r.author,
    "Result": r.result,
    "Finish Time": r.finishTime
  }));

  exportToExcelFile({ "Pipelines Inventory": summaryData, "Build Runs History": runsData }, "AzureDevOps_Pipelines_Analytics");
}