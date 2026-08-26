async function fetchPipelineData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim() || sessionStorage.getItem('azdo_pat') || '';
  const top = Number(document.getElementById('pipelineRunsTop').value || 20);
  if (!org || !project) return showModal('Select an organization and project first.', 'projectSelect');
  if (!pat) return showModal('Enter a PAT before loading pipeline data.', 'targetPat');

  showSection('pipelines');
  setStatus(`Loading pipeline definitions and the latest ${top} run(s) per pipeline...`, 'info');
  const authHeader = buildAuthHeader(pat);

  try {
    const definitionsUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/pipelines?api-version=7.1-preview.1&$top=500`;
    const definitions = (await fetchAzDo(definitionsUrl, authHeader)).value || [];
    const runs = [];
    const summaries = [];

    await Promise.all(definitions.map(async pipeline => {
      const buildsUrl = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/build/builds?definitions=${encodeURIComponent(pipeline.id)}&$top=${top}&queryOrder=finishTimeDescending&api-version=${API_VERSION}`;
      try {
        const data = await fetchAzDo(buildsUrl, authHeader);
        const builds = data.value || [];
        let successful = 0, ci = 0, manual = 0;
        builds.forEach(build => {
          if (String(build.result || '').toLowerCase() === 'succeeded') successful++;
          const reason = String(build.reason || '').toLowerCase();
          if (reason.includes('individualci') || reason.includes('batchedci') || reason.includes('schedule')) ci++; else manual++;
          runs.push({
            pipeline: pipeline.name,
            buildNumber: build.buildNumber || build.id,
            branch: build.sourceBranch ? String(build.sourceBranch).replace('refs/heads/', '') : 'N/A',
            trigger: build.reason || 'Unknown',
            triggeredBy: normalizeDisplayName(build.requestedFor),
            result: build.result || build.status || 'Unknown',
            finishTime: build.finishTime ? new Date(build.finishTime).toLocaleString() : 'Running'
          });
        });
        const total = builds.length;
        summaries.push({ pipeline: pipeline.name, total, successful, failed: total - successful, ci, manual, rate: total ? ((successful / total) * 100).toFixed(1) : '0.0' });
      } catch (_) {
        summaries.push({ pipeline: pipeline.name, total: 0, successful: 0, failed: 0, ci: 0, manual: 0, rate: '0.0' });
      }
    }));

    rawStore.pipelines = runs.sort((a,b) => new Date(b.finishTime) - new Date(a.finishTime));
    rawStore.pipelineIndex = 0;
    rawStore.pipelineSummary = summaries.sort((a,b) => b.total - a.total);

    const totalRuns = summaries.reduce((sum, item) => sum + item.total, 0);
    const successfulRuns = summaries.reduce((sum, item) => sum + item.successful, 0);
    const failedRuns = summaries.reduce((sum, item) => sum + item.failed, 0);
    const successRate = totalRuns ? ((successfulRuns / totalRuns) * 100).toFixed(1) : '0.0';
    setKpis(project, [
      { label: 'Pipelines', value: definitions.length },
      { label: 'Successful runs', value: successfulRuns },
      { label: 'Failed / other', value: failedRuns },
      { label: 'Success rate %', value: successRate }
    ]);
    renderPipelineSummary();
    renderPipelineTableBatch(false);
    renderChart(['Succeeded', 'Failed / other'], [successfulRuns, failedRuns], 'Pipeline run results');
    setStatus(`Scanned ${definitions.length.toLocaleString()} pipeline(s) and ${totalRuns.toLocaleString()} run(s). Overall success rate: ${successRate}%.`, 'success');
  } catch (err) {
    setStatus(`Pipeline analytics failed: ${err.message}`, 'error');
  }
}

function renderPipelineSummary() {
  const tbody = document.getElementById('pipelineSummaryTableBody');
  tbody.innerHTML = rawStore.pipelineSummary.length ? rawStore.pipelineSummary.map(item => `
    <tr><td><strong class="text-slate-900">${escapeHtml(item.pipeline)}</strong></td><td>${formatNumber(item.total)}</td><td>${formatNumber(item.successful)}</td><td>${formatNumber(item.failed)}</td><td>${formatNumber(item.ci)}</td><td>${formatNumber(item.manual)}</td><td><span class="status-pill ${Number(item.rate) >= 90 ? 'success' : Number(item.rate) >= 70 ? 'warning' : 'error'}">${escapeHtml(item.rate)}%</span></td></tr>`).join('') : '<tr><td colspan="7" class="empty-row">No pipeline run data found.</td></tr>';
}

function renderPipelineTableBatch(append = false) {
  const tbody = document.getElementById('pipelineTableBody');
  const container = document.getElementById('seeMorePipelinesContainer');
  const remaining = document.getElementById('pipelinesRemainingCount');
  if (!append) tbody.innerHTML = '';
  if (!rawStore.pipelines.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No build runs found.</td></tr>';
    container.classList.add('hidden');
    return;
  }
  const batch = rawStore.pipelines.slice(rawStore.pipelineIndex, rawStore.pipelineIndex + PAGE_SIZE);
  rawStore.pipelineIndex += batch.length;
  tbody.insertAdjacentHTML('beforeend', batch.map(run => `
    <tr><td><strong class="text-slate-900">${escapeHtml(run.pipeline)}</strong></td><td class="font-mono text-[10px]">${escapeHtml(run.buildNumber)}</td><td>${escapeHtml(run.branch)}</td><td><span class="status-pill neutral">${escapeHtml(run.trigger)}</span></td><td>${escapeHtml(run.triggeredBy)}</td><td><span class="status-pill ${statusClass(run.result)}">${escapeHtml(run.result)}</span></td><td>${escapeHtml(run.finishTime)}</td></tr>`).join(''));
  const count = rawStore.pipelines.length - rawStore.pipelineIndex;
  remaining.textContent = count.toLocaleString();
  container.classList.toggle('hidden', count <= 0);
}

function exportPipelinesToXLSX() {
  exportToExcelFile({
    'Pipeline Summary': rawStore.pipelineSummary.map(item => ({ Pipeline: item.pipeline, Scanned: item.total, Successful: item.successful, 'Failed / Other': item.failed, 'CI / Auto': item.ci, Manual: item.manual, 'Success Rate': `${item.rate}%` })),
    'Build Runs': rawStore.pipelines.map(run => ({ Pipeline: run.pipeline, 'Build #': run.buildNumber, Branch: run.branch, Trigger: run.trigger, 'Triggered By': run.triggeredBy, Result: run.result, 'Finish Time': run.finishTime }))
  }, 'AzureDevOps_Pipelines');
}
