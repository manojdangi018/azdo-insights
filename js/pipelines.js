async function fetchPipelineData() {
  const org = extractOrgName(document.getElementById('targetOrg').value);
  const project = document.getElementById('projectSelect').value;
  const pat = document.getElementById('targetPat').value.trim();
  const perPipelineRuns = parseInt(document.getElementById('pipelineRunsTop').value, 10) || 20;

  const authHeader = 'Basic ' + btoa(':' + pat);
  showSection('pipelines');
  startFetching(`Scanning pipeline definitions and recent runs in descending order...`);

  try {
    const modernUrl = `https://dev.azure.com/${org}/${project}/_apis/pipelines?api-version=${API_VERSION}`;
    const classicUrl = `https://dev.azure.com/${org}/${project}/_apis/build/definitions?api-version=${API_VERSION}`;

    const [modernRes, classicRes] = await Promise.allSettled([
      fetchAzDo(modernUrl, authHeader),
      fetchAzDo(classicUrl, authHeader)
    ]);

    const pipelineMap = new Map();

    if (modernRes.status === 'fulfilled' && modernRes.value?.value) {
      modernRes.value.value.forEach(p => {
        pipelineMap.set(p.name, {
          id: p.id,
          name: p.name,
          type: 'yaml'
        });
      });
    }

    if (classicRes.status === 'fulfilled' && classicRes.value?.value) {
      classicRes.value.value.forEach(d => {
        if (!pipelineMap.has(d.name)) {
          pipelineMap.set(d.name, {
            id: d.id,
            name: d.name,
            type: 'classic'
          });
        }
      });
    }

    function parseTriggerType(reasonStr) {
      const r = (reasonStr || '').toLowerCase();

      if (r.includes('batchedci') || r.includes('individualci') || r === 'ci') {
        return 'Auto (CI)';
      }

      if (r.includes('pullrequest') || r.includes('validatepr')) {
        return 'Auto (PR)';
      }

      if (r.includes('schedule')) {
        return 'Auto (Scheduled)';
      }

      if (r.includes('buildcompletion') || r.includes('triggered')) {
        return 'Auto (Triggered)';
      }

      if (r.includes('manual') || r.includes('usercreated') || r.includes('none')) {
        return 'Manual';
      }

      return 'Manual';
    }

    // Azure DevOps Build objects expose the actual source branch in sourceBranch.
    // YAML Pipeline Run objects expose it under resources.repositories.<repo>.refName.
    function parseBranch(bObj) {
      const directBranch =
        bObj?.sourceBranch ||
        bObj?.resources?.repositories?.self?.refName ||
        bObj?.resources?.repositories?.self?.version ||
        bObj?.triggerInfo?.['pr.sourceBranch'] ||
        bObj?.triggerInfo?.['ci.sourceBranch'] ||
        bObj?.parameters?.['system.pullRequest.sourceBranch'] ||
        bObj?.variables?.['Build.SourceBranch']?.value ||
        bObj?.variables?.['Build.SourceBranchName']?.value;

      if (!directBranch) {
        return 'Unknown Branch';
      }

      return String(directBranch)
        .replace(/^refs\/heads\//i, '')
        .replace(/^refs\/pull\/(\d+)\/merge$/i, 'PR Merge #$1')
        .replace(/^refs\/tags\//i, 'Tag: ');
    }

    function cleanIdentity(value) {
      if (!value) return '';

      const text = String(value).trim();
      if (!text) return '';

      const lower = text.toLowerCase();

      const blocked = [
        'microsoft.visualstudio.services',
        'build service',
        'project collection build service',
        'project collection service accounts',
        'automated system',
        'azure devops'
      ];

      if (blocked.some(x => lower.includes(x))) {
        return '';
      }

      return text;
    }

    // For a manual build, requestedFor is the identity on whose behalf
    // the build was queued. requestedBy is the identity that queued it.
    // For CI/PR builds Azure DevOps may legitimately return a service identity.
    function parseAuthor(bObj, pipeName, triggerType) {
      const requestedFor = cleanIdentity(
        bObj?.requestedFor?.displayName ||
        bObj?.requestedFor?.uniqueName ||
        bObj?.requestedFor?.mailAddress
      );

      const requestedBy = cleanIdentity(
        bObj?.requestedBy?.displayName ||
        bObj?.requestedBy?.uniqueName ||
        bObj?.requestedBy?.mailAddress
      );

      const candidates = [
        requestedFor,
        requestedBy,
        cleanIdentity(bObj?.createdBy?.displayName),
        cleanIdentity(bObj?.createdBy?.uniqueName),
        cleanIdentity(bObj?.triggerInfo?.['pr.sender.name']),
        cleanIdentity(bObj?.triggerInfo?.['ci.actor.name']),
        cleanIdentity(bObj?.triggerInfo?.['pr.sender.email']),
        cleanIdentity(bObj?.triggerInfo?.['ci.actor.email']),
        cleanIdentity(bObj?.lastChangedBy?.displayName),
        cleanIdentity(bObj?.lastChangedBy?.uniqueName),
        cleanIdentity(bObj?.variables?.['Build.RequestedFor']?.value),
        cleanIdentity(bObj?.variables?.['Build.RequestedForEmail']?.value),
        cleanIdentity(bObj?.variables?.['Build.QueuedBy']?.value),
        cleanIdentity(bObj?.variables?.['Build.QueuedByEmail']?.value)
      ];

      for (const candidate of candidates) {
        if (
          candidate &&
          candidate.toLowerCase() !== (pipeName || '').toLowerCase()
        ) {
          return candidate;
        }
      }

      if (triggerType === 'Auto (Scheduled)') return 'Scheduled Timer';
      if (triggerType === 'Auto (CI)') return 'CI Automation';
      if (triggerType === 'Auto (PR)') return 'PR Automation';
      if (triggerType === 'Auto (Triggered)') return 'Pipeline Automation';

      return 'Automated System';
    }

    // Get the authoritative Build object. The Build API documents
    // sourceBranch, requestedBy and requestedFor on the Build response.
    // This is intentionally called for every returned build because the
    // list response in some Azure DevOps configurations does not contain
    // all identity/repository fields needed by the UI.
    async function getBuildDetails(buildId) {
      if (!buildId) return null;
    
      const url =
        `https://dev.azure.com/${org}/${project}` +
        `/_apis/build/builds/${encodeURIComponent(buildId)}` +
        `?api-version=7.1`;
    
      try {
    
        const result = await fetchAzDo(
          url,
          authHeader
        );
    
        console.log("========================================");
        console.log("AZURE DEVOPS BUILD DETAIL");
        console.log("Build ID:", buildId);
        console.log("Full Response:", result);
        console.log("sourceBranch:", result?.sourceBranch);
        console.log("requestedBy:", result?.requestedBy);
        console.log("requestedFor:", result?.requestedFor);
        console.log("repository:", result?.repository);
        console.log("reason:", result?.reason);
        console.log("========================================");
    
        return result;
    
      } catch (err) {
    
        console.error(
          `[Azure DevOps Pipeline] Unable to get build details for ${buildId}:`,
          err
        );
    
        return null;
    
      }
    }

    // Get the individual YAML Pipeline Run. The Run API provides repository
    // refName even when the list response is incomplete.
    async function getPipelineRunDetails(pipelineId, runId) {
      if (!pipelineId || !runId) return null;

      const url =
        `https://dev.azure.com/${org}/${project}` +
        `/_apis/pipelines/${encodeURIComponent(pipelineId)}/runs/${encodeURIComponent(runId)}` +
        `?api-version=7.1`;

      try {
        return await fetchAzDo(url, authHeader);
      } catch (err) {
        console.warn(
          `[Azure DevOps Pipeline] Unable to get pipeline run details for ${pipelineId}/${runId}:`,
          err
        );
        return null;
      }
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

    let allRuns = [];
    const pipeList = Array.from(pipelineMap.values());
    const BATCH_SIZE = 8;

    for (let i = 0; i < pipeList.length; i += BATCH_SIZE) {
      const batch = pipeList.slice(i, i + BATCH_SIZE);

      await Promise.all(batch.map(async (pipe) => {
        try {
          let runsObtained = [];

          const bUrl =
            `https://dev.azure.com/${org}/${project}/_apis/build/builds` +
            `?definitions=${encodeURIComponent(pipe.id)}` +
            `&$top=${perPipelineRuns}` +
            `&queryOrder=queueTimeDescending` +
            `&api-version=7.1`;

          const bData = await fetchAzDo(bUrl, authHeader);
          runsObtained = bData?.value || [];

          // Build list is the preferred source because it contains
          // sourceBranch, requestedBy and requestedFor.
          if (runsObtained.length > 0) {
            const detailedRuns = await Promise.all(
              runsObtained.map(async (build) => {
                const detail = await getBuildDetails(build.id);

                if (!detail) {
                  return build;
                }

                return {
                  ...build,
                  ...detail,
                  sourceBranch: detail.sourceBranch || build.sourceBranch,
                  requestedBy: detail.requestedBy || build.requestedBy,
                  requestedFor: detail.requestedFor || build.requestedFor,
                  triggerInfo: detail.triggerInfo || build.triggerInfo,
                  repository: detail.repository || build.repository,
                  variables: detail.variables || build.variables,
                  reason: detail.reason || build.reason,
                  result: detail.result || build.result,
                  status: detail.status || build.status,
                  finishTime: detail.finishTime || build.finishTime,
                  startTime: detail.startTime || build.startTime,
                  queueTime: detail.queueTime || build.queueTime,
                  createdDate: detail.queueTime || build.createdDate
                };
              })
            );

            runsObtained = detailedRuns;
          }

          // Fallback for pipeline definitions where the Build list does not
          // return runs. The Pipeline Runs API exposes repository refName.
          if (runsObtained.length === 0) {
            const rUrl =
              `https://dev.azure.com/${org}/${project}` +
              `/_apis/pipelines/${encodeURIComponent(pipe.id)}/runs` +
              `?$top=${perPipelineRuns}` +
              `&api-version=7.1`;

            const rData = await fetchAzDo(rUrl, authHeader);
            const rawYamlRuns = (rData?.value || []).slice(0, perPipelineRuns);

            runsObtained = await Promise.all(
              rawYamlRuns.map(async (yr) => {
                const detail = await getPipelineRunDetails(pipe.id, yr.id);
                const run = detail || yr;

                const selfRepo =
                  run?.resources?.repositories?.self ||
                  Object.values(run?.resources?.repositories || {})[0] ||
                  null;

                return {
                  id: run.id,
                  buildNumber: run.name || `#${run.id}`,
                  sourceBranch:
                    selfRepo?.refName ||
                    selfRepo?.version ||
                    run.variables?.['Build.SourceBranch']?.value ||
                    run.variables?.['Build.SourceBranchName']?.value,
                  reason:
                    run.variables?.['Build.Reason']?.value ||
                    run.reason ||
                    'manual',
                  createdBy: run.createdBy,
                  requestedFor: run.requestedFor,
                  requestedBy: run.requestedBy,
                  triggerInfo: run.triggerInfo,
                  variables: run.variables,
                  result: run.result || run.state || 'unknown',
                  finishTime: run.finishedDate || run.createdDate,
                  startTime: run.startedDate,
                  queueTime: run.createdDate
                };
              })
            );
          }

          // Process each normalized run.
          runsObtained.forEach(b => {
            const result = (b.result || b.status || 'unknown').toLowerCase();
            const isSuccess = result === 'succeeded';
            const trigger = parseTriggerType(b.reason);
            const isAuto = trigger.startsWith('Auto');
            const author = parseAuthor(b, pipe.name, trigger);
            const branch = parseBranch(b);

            summaryMap[pipe.name].total++;

            if (isSuccess) {
              summaryMap[pipe.name].succeeded++;
            } else {
              summaryMap[pipe.name].failed++;
            }

            if (isAuto) {
              summaryMap[pipe.name].autoTriggers++;
            } else {
              summaryMap[pipe.name].manualTriggers++;
            }

            const rawTime =
              b.finishTime ||
              b.startTime ||
              b.queueTime ||
              b.createdDate;

            const parsedDate = rawTime
              ? new Date(rawTime)
              : new Date(0);

            allRuns.push({
              name: pipe.name,
              buildNumber: b.buildNumber || b.id,
              branch: branch,
              reason: trigger,
              author: author,
              result: b.result || b.status || 'unknown',
              rawTimestamp: parsedDate.getTime(),
              finishTime: rawTime
                ? parsedDate.toLocaleString()
                : (b.startTime ? 'In Progress' : 'Queued')
            });
          });
        } catch (err) {
          console.warn(
            `[Azure DevOps Pipeline] Error processing pipeline ${pipe.name}:`,
            err
          );
        }
      }));
    }

    allRuns.sort((a, b) => b.rawTimestamp - a.rawTimestamp);

    rawStore.pipelineSummaries = Object.values(summaryMap);
    rawStore.pipelineSummariesIndex = 0;
    rawStore.pipelines = allRuns;
    rawStore.pipelineIndex = 0;

    const totalSuccessful = rawStore.pipelineSummaries.reduce(
      (acc, p) => acc + p.succeeded,
      0
    );

    const totalAuto = rawStore.pipelineSummaries.reduce(
      (acc, p) => acc + p.autoTriggers,
      0
    );

    document.getElementById('kpi-1-label').textContent = 'Active Scope';
    document.getElementById('kpi-1-val').textContent = `${project} (${pipelineMap.size} Pipelines)`;
    document.getElementById('kpi-1-val').className = 'text-2xl font-extrabold text-slate-800 mt-1 truncate';
    document.getElementById('kpi-2-label').textContent = 'Total Pipelines';
    document.getElementById('kpi-2-val').textContent = pipelineMap.size;
    document.getElementById('kpi-3-label').textContent = 'Successful Builds';
    document.getElementById('kpi-3-val').textContent = totalSuccessful;
    document.getElementById('kpi-4-label').textContent = 'Auto / CI Triggers';
    document.getElementById('kpi-4-val').textContent = totalAuto;
    document.getElementById('kpi-5-label').textContent = 'Scanned Runs';
    document.getElementById('kpi-5-val').textContent = allRuns.length;

    renderPipelineSummaryTableBatch(false);
    renderPipelineTableBatch(false);

    const activeSummaries = rawStore.pipelineSummaries
      .filter(p => p.total > 0)
      .slice(0, 20);

    const chartLabels = activeSummaries.length > 0
      ? activeSummaries.map(p => p.name)
      : rawStore.pipelineSummaries.slice(0, 15).map(p => p.name);

    const chartData = activeSummaries.length > 0
      ? activeSummaries.map(p => p.succeeded)
      : rawStore.pipelineSummaries.slice(0, 15).map(p => p.succeeded);

    renderChart(
      chartLabels,
      chartData,
      'Successful Builds (Top Pipelines)'
    );

    stopFetching();



    setStatus(


      `Loaded ${pipelineMap.size} pipelines with ${allRuns.length} total runs sorted by newest first.`,


      'success'


    );


    } catch (err) {


      stopFetching();
    setStatus(
      `Error fetching pipelines: ${err.message}`,
      'error'
    );
  }
}

function renderPipelineSummaryTableBatch(append = false) {
  const tbody = document.getElementById('pipelineSummaryTableBody');
  const container = document.getElementById('seeMorePipelineSummaryContainer');
  const remainingEl = document.getElementById('pipelineSummaryRemainingCount');
  if (!tbody) return;

  if (!append) tbody.innerHTML = '';

  if (rawStore.pipelineSummaries.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400">No pipelines found.</td></tr>`;
    container.classList.add('hidden');
    return;
  }

  const nextBatch = rawStore.pipelineSummaries.slice(rawStore.pipelineSummariesIndex, rawStore.pipelineSummariesIndex + PIPELINE_PAGE_SIZE);
  rawStore.pipelineSummariesIndex += nextBatch.length;

  const html = nextBatch.map(p => {
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

  tbody.insertAdjacentHTML('beforeend', html);

  const remaining = rawStore.pipelineSummaries.length - rawStore.pipelineSummariesIndex;
  if (remaining > 0) {
    container.classList.remove('hidden');
    remainingEl.textContent = remaining;
  } else {
    container.classList.add('hidden');
  }
}

function renderPipelineTableBatch(append = false) {
  const tbody = document.getElementById('pipelineTableBody');
  const container = document.getElementById('seeMorePipelinesContainer');
  const remainingEl = document.getElementById('pipelinesRemainingCount');

  if (!append) tbody.innerHTML = '';

  if (rawStore.pipelines.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400">No recent build runs found for scanned pipelines.</td></tr>`;
    container.classList.add('hidden');
    return;
  }

  const nextBatch = rawStore.pipelines.slice(rawStore.pipelineIndex, rawStore.pipelineIndex + PAGE_SIZE);
  rawStore.pipelineIndex += nextBatch.length;

  const html = nextBatch.map(r => `
    <tr class="hover:bg-slate-50 transition">
      <td class="p-4 font-semibold text-slate-900">${r.name}</td>
      <td class="p-4 font-mono text-xs text-blue-600 font-bold">#${r.buildNumber}</td>
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
  if (!rawStore.pipelineSummaries || rawStore.pipelineSummaries.length === 0) return;
  const summaryData = rawStore.pipelineSummaries.map(p => ({
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
