
/* Phase 5 — Advanced Analytics
 * Derived from the telemetry already loaded by the existing workspaces.
 * Scores are explicitly heuristic indicators, not Azure DevOps security/compliance certifications.
 */
let advancedChartInstances = [];
let advancedReviewLatencyCache = new Map();
const ADVANCED_DEFAULT_DAYS = 90;
const ADVANCED_REVIEW_PR_LIMIT = 50;
const ADVANCED_UNUSED_SERVICE_DAYS = 90;

function advNum(v, fallback=0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function advDate(v) { if (v instanceof Date) return v; const d = new Date(v); return Number.isFinite(d.getTime()) ? d : null; }
function advDaysBetween(a,b=new Date()) { const da=advDate(a), db=advDate(b); return da ? Math.max(0,(db-da)/86400000) : null; }
function advFormatHours(h) { if (!Number.isFinite(h)) return 'N/A'; if (h < 24) return `${h.toFixed(1)}h`; const d=h/24; return d < 30 ? `${d.toFixed(1)}d` : `${(d/30).toFixed(1)}mo`; }
function advFormatPct(v) { return Number.isFinite(v) ? `${Math.round(v)}%` : 'N/A'; }
function advScoreClass(score) { return score >= 80 ? 'good' : score >= 60 ? 'warn' : 'bad'; }
function advStatusBadge(label, cls='neutral') { return `<span class="advanced-badge ${cls}">${escapeHtml(label)}</span>`; }
function advScoreBadge(score) { const n=advNum(score); return advStatusBadge(`${Math.round(n)}/100`, advScoreClass(n)); }
function advClearCharts() { advancedChartInstances.forEach(c=>{ try{c.destroy();}catch(e){} }); advancedChartInstances=[]; }
function advChart(id,type,labels,datasets,options={}) {
  const canvas=document.getElementById(id); if(!canvas || typeof Chart==='undefined') return;
  const chart=new Chart(canvas.getContext('2d'), { type, data:{labels,datasets}, options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:datasets.length>1}},scales:type==='doughnut'?{}:{y:{beginAtZero:true,ticks:{precision:0}},x:{grid:{display:false}}},...options} });
  advancedChartInstances.push(chart);
}
function advancedGetDays() { return parseInt(document.getElementById('advancedAnalyticsDays')?.value,10) || ADVANCED_DEFAULT_DAYS; }
function advancedCutoff(days=advancedGetDays()) { const d=new Date(); d.setDate(d.getDate()-days); return d; }
function advancedLoadedNotice() {
  const parts=[];
  if (rawStore.repos?.length) parts.push(`${rawStore.repos.length} branches`);
  if (rawStore.repoPrs?.length) parts.push(`${rawStore.repoPrs.length} PRs`);
  if (rawStore.pipelines?.length) parts.push(`${rawStore.pipelines.length} runs`);
  if (rawStore.commits?.length) parts.push(`${rawStore.commits.length} commits`);
  if (rawStore.workitems?.length) parts.push(`${rawStore.workitems.length} work items`);
  if (rawStore.agents?.length) parts.push(`${rawStore.agents.length} agents`);
  if (rawStore.userEntitlements?.length) parts.push(`${rawStore.userEntitlements.length} users`);
  if (rawStore.serviceConnections?.length) parts.push(`${rawStore.serviceConnections.length} service connections`);
  return parts.length ? `Using loaded telemetry: ${parts.join(' · ')}` : 'Load one or more workspaces first, then build Advanced Analytics.';
}
function advancedRepoHealth() {
  const branches=Array.isArray(rawStore.repos)?rawStore.repos:[]; const prs=Array.isArray(rawStore.repoPrs)?rawStore.repoPrs:[];
  const map=new Map();
  branches.forEach(b=>{ const k=b.repo||'Unknown'; if(!map.has(k)) map.set(k,{repo:k,branches:0,stale:0,protected:0,reviewProtected:0}); const x=map.get(k); x.branches++; if(b.isStale)x.stale++; if(b.hasPolicy)x.protected++; if(advNum(b.minReviewers)>0)x.reviewProtected++; });
  prs.forEach(p=>{const x=map.get(p.repo||'Unknown'); if(x){x.prs=(x.prs||0)+1; if(String(p.status).toLowerCase()==='active')x.activePrs=(x.activePrs||0)+1;}});
  return [...map.values()].map(x=>{const freshness=x.branches?100*(1-x.stale/x.branches):0; const protection=x.branches?100*x.protected/x.branches:0; const review=x.protected?100*x.reviewProtected/x.protected:0; const prHealth=x.prs?100*(1-(x.activePrs||0)/x.prs):100; const score=.5*freshness+.3*protection+.1*review+.1*prHealth; return {...x,freshness,protection,review,prHealth,score};}).sort((a,b)=>b.score-a.score);
}
function advancedPipelineHealth() {
  const runs=Array.isArray(rawStore.pipelines)?rawStore.pipelines:[]; const map=new Map();
  runs.forEach(r=>{const k=r.pipelineIdentityKey||`${r.pipelineType||'unknown'}:${r.pipelineId||r.name}`; if(!map.has(k))map.set(k,{key:k,name:r.name||'Unknown',pipelineType:r.pipelineType||'unknown',pipelineId:r.pipelineId,total:0,success:0,failed:0,runs:[]}); const x=map.get(k); x.total++; const res=String(r.result||'').toLowerCase(); if(res==='succeeded')x.success++; else if(['failed','canceled','partiallysucceeded'].includes(res))x.failed++; x.runs.push(r);});
  return [...map.values()].map(x=>{x.runs.sort((a,b)=>advNum(b.rawTimestamp)-advNum(a.rawTimestamp)); const successRate=x.total?100*x.success/x.total:0; const recent=x.runs.slice(0,10); const recentRate=recent.length?100*recent.filter(r=>String(r.result||'').toLowerCase()==='succeeded').length/recent.length:successRate; x.score=.7*successRate+.3*recentRate; x.successRate=successRate; x.recentRate=recentRate; return x;}).sort((a,b)=>b.score-a.score);
}
function advancedBranchProtection() {
  const rows=Array.isArray(rawStore.repos)?rawStore.repos:[]; if(!rows.length)return {score:null,protected:0,total:0,reviewProtected:0}; const protectedRows=rows.filter(r=>r.hasPolicy); const reviewRows=rows.filter(r=>advNum(r.minReviewers)>0); return {score:100*(.65*protectedRows.length/rows.length+.35*reviewRows.length/rows.length),protected:protectedRows.length,total:rows.length,reviewProtected:reviewRows.length};
}
function advancedDeveloperTrend(days) {
  const cutoff=advancedCutoff(days); const map=new Map(); const add=(date,key)=>{const d=advDate(date); if(!d||d<cutoff)return; const day=d.toISOString().slice(0,10); if(!map.has(day))map.set(day,{commits:0,prs:0}); map.get(day)[key]++;};
  (rawStore.commits||[]).forEach(c=>add(c.rawDate||c.date,'commits')); (rawStore.repoPrs||[]).forEach(p=>add(p.rawCreatedTimestamp||p.rawDate||p.createdDate,'prs'));
  const out=[]; for(let d=new Date(cutoff);d<=new Date();d.setDate(d.getDate()+1)){const k=d.toISOString().slice(0,10);out.push({date:k,...(map.get(k)||{commits:0,prs:0})});} return out;
}
function advancedPRMetrics() {
  const prs=(rawStore.repoPrs||[]); const completed=prs.filter(p=>['completed','merged'].includes(String(p.status||'').toLowerCase()) && advDate(p.rawCreatedTimestamp) && advDate(p.rawClosedTimestamp));
  const cycle=completed.map(p=>(p.rawClosedTimestamp-p.rawCreatedTimestamp)/3600000).filter(Number.isFinite).filter(v=>v>=0); const active=prs.filter(p=>String(p.status||'').toLowerCase()==='active');
  const reviewable=prs.filter(p=>p.reviewersCount!==undefined); const reviewed=reviewable.filter(p=>advNum(p.reviewersCount)>0);
  return {completedCount:completed.length,avgCycle:cycle.length?cycle.reduce((a,b)=>a+b,0)/cycle.length:null,medianCycle:cycle.length?cycle.slice().sort((a,b)=>a-b)[Math.floor(cycle.length/2)]:null,active:active.length,reviewCoverage:reviewable.length?100*reviewed.length/reviewable.length:null,prs};
}
async function advancedFetchFirstReviewLatency(prs) {
  const candidates=(prs||[]).filter(p=>p.repoId&&p.id).slice().sort((a,b)=>advNum(b.rawCreatedTimestamp)-advNum(a.rawCreatedTimestamp)).slice(0,ADVANCED_REVIEW_PR_LIMIT);
  let values=[];
  for(const p of candidates){ const key=`${p.repoId}:${p.id}`; if(advancedReviewLatencyCache.has(key)){const v=advancedReviewLatencyCache.get(key); if(Number.isFinite(v))values.push(v); continue;} try{ const org=extractOrgName(document.getElementById('targetOrg')?.value||''); const project=document.getElementById('projectSelect')?.value||''; const url=`https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(p.repoId)}/pullRequests/${encodeURIComponent(p.id)}/threads?api-version=${API_VERSION}`; const data=await fetchAzDoPaged(url,createBasicAuthHeader(document.getElementById('targetPat')?.value||''),{pageSize:200}); const creator=normalizeIdentityText(p.creator||''); const dates=[]; (data?.value||[]).forEach(t=>{(t.comments||[]).forEach(c=>{if(c.isDeleted)return; const author=normalizeIdentityText(c.author?.displayName||c.author?.uniqueName||''); if(author && author!==creator && !/system|build service|microsoft.visualstudio.services/i.test(author)){const d=advDate(c.publishedDate||t.publishedDate); if(d)dates.push(d);}});}); const created=advDate(p.rawCreatedTimestamp); const first=dates.sort((a,b)=>a-b)[0]; const hours=created&&first?(first-created)/3600000:null; advancedReviewLatencyCache.set(key,Number.isFinite(hours)&&hours>=0?hours:null); if(Number.isFinite(hours)&&hours>=0)values.push(hours);}catch(e){advancedReviewLatencyCache.set(key,null);} }
  return values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
}
function advancedWorkItemAging() {
  const now=new Date(); const open=(rawStore.workitems||[]).filter(w=>!['Completed','Removed','Resolved'].includes(String(w.stateCategory||''))); const buckets=[['0–7 days',0],['8–30 days',0],['31–60 days',0],['61–90 days',0],['90+ days',0]]; let ages=[]; open.forEach(w=>{const d=advDate(w.rawCreatedTimestamp||w.createdDate); const age=d?Math.floor((now-d)/86400000):null; if(age===null)return; ages.push(age); if(age<=7)buckets[0][1]++; else if(age<=30)buckets[1][1]++; else if(age<=60)buckets[2][1]++; else if(age<=90)buckets[3][1]++; else buckets[4][1]++;}); return {openCount:open.length,avgAge:ages.length?ages.reduce((a,b)=>a+b,0)/ages.length:null,buckets};
}
function advancedAgentUtilization() {
  const agents=(rawStore.agents||[]).filter(a=>a.isHosted==='No' && a.name && a.name!=='Unable to read agents'); const enabled=agents.filter(a=>String(a.enabled).toLowerCase()==='yes'); const assigned=enabled.filter(a=>a.assignedRequest); return {enabled:enabled.length,assigned:assigned.length,utilization:enabled.length?100*assigned.length/enabled.length:null,online:enabled.filter(a=>/online|idle/i.test(String(a.status))).length};
}
function advancedUserRisk() {
  const users=(rawStore.userEntitlements||[]); const access=(rawStore.access||[]); const counts=new Map(); access.forEach(a=>{const k=normalizeIdentityText(a.email||a.name||''); if(k)counts.set(k,(counts.get(k)||0)+1);}); const cutoff=advancedCutoff(ADVANCED_UNUSED_SERVICE_DAYS); const rows=users.map(u=>{const key=normalizeIdentityText(u.email||u.name||''); const memberships=counts.get(key)||0; const last=advDate(u.lastAccessedDate); const inactive=String(u.status||'').toLowerCase()!=='active'; const stale=last?last<cutoff:false; let score=0; if(inactive)score+=50; if(stale)score+=30; if(memberships>=5)score+=20; else if(memberships>=3)score+=10; return {...u,memberships,indicatorScore:Math.min(100,score),inactive,inactive90:stale};}).sort((a,b)=>b.indicatorScore-a.indicatorScore); return {rows,inactive:rows.filter(r=>r.inactive).length,inactive90:rows.filter(r=>r.inactive90).length,high:rows.filter(r=>r.indicatorScore>=60).length};
}
function advancedServiceUsage() {
  const cutoff=advancedCutoff(ADVANCED_UNUSED_SERVICE_DAYS); const rows=(rawStore.serviceConnections||[]).map(s=>{const d=advDate(s.rawLastUsedTimestamp||s.lastUsedDate); const unused=!!d&&d<cutoff; return {...s,usageKnown:!!d,unused};}); return {rows,unused:rows.filter(r=>r.unused).length,unknown:rows.filter(r=>!r.usageKnown).length};
}
function advancedSetCard(id,value,sub='') { const el=document.getElementById(id); if(el)el.textContent=value; const se=document.getElementById(`${id}-sub`); if(se)se.textContent=sub; }
function advancedTable(id,html){const el=document.getElementById(id); if(el)setSafeInnerHTML(el,html);}
function advancedRenderRepoTable(rows){ advancedTable('advancedRepoHealthBody',rows.length?rows.slice(0,20).map(r=>`<tr><td>${escapeHtml(r.repo)}</td><td>${r.branches}</td><td>${r.stale}</td><td>${r.protected}</td><td>${advScoreBadge(r.score)}</td></tr>`).join(''):`<tr><td colspan="5" class="advanced-empty">No repository branch telemetry loaded.</td></tr>`); }
function advancedRenderPipelineTable(rows){ advancedTable('advancedPipelineHealthBody',rows.length?rows.slice(0,20).map(r=>`<tr><td>${escapeHtml(r.name)}<small>${escapeHtml(String(r.pipelineType).toUpperCase())} · ID ${escapeHtml(r.pipelineId)}</small></td><td>${r.total}</td><td>${advFormatPct(r.successRate)}</td><td>${advFormatPct(r.recentRate)}</td><td>${advScoreBadge(r.score)}</td></tr>`).join(''):`<tr><td colspan="5" class="advanced-empty">No pipeline run telemetry loaded.</td></tr>`); }
function advancedRenderRiskTable(risk){ advancedTable('advancedRiskBody',risk.rows.length?risk.rows.slice(0,20).map(r=>`<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.email)}</td><td>${r.memberships}</td><td>${r.inactive90?'&gt;90d':'—'}</td><td>${advScoreBadge(r.indicatorScore)}</td></tr>`).join(''):`<tr><td colspan="5" class="advanced-empty">Load Organization & Project Users to calculate access indicators.</td></tr>`); }
function advancedRenderServiceTable(svc){ advancedTable('advancedServiceBody',svc.rows.length?svc.rows.slice(0,20).map(r=>`<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.type)}</td><td>${r.usageKnown?(r.unused?advStatusBadge('Unused > 90d','bad'):advStatusBadge('Used < 90d','good')):advStatusBadge('Usage unknown','neutral')}</td><td>${escapeHtml(r.lastUsedDate||'Not exposed by API')}</td></tr>`).join(''):`<tr><td colspan="4" class="advanced-empty">Load Service Connections to evaluate usage telemetry.</td></tr>`); }
async function renderAdvancedAnalytics(){
  const days=advancedGetDays(); const notice=document.getElementById('advancedAnalyticsNotice'); if(notice)notice.textContent=advancedLoadedNotice(); advClearCharts();
  const repos=advancedRepoHealth(), pipes=advancedPipelineHealth(), protection=advancedBranchProtection(), dev=advancedDeveloperTrend(days), pr=advancedPRMetrics(), wi=advancedWorkItemAging(), agents=advancedAgentUtilization(), risk=advancedUserRisk(), svc=advancedServiceUsage();
  const avgRepo=repos.length?repos.reduce((a,b)=>a+b.score,0)/repos.length:null, avgPipe=pipes.length?pipes.reduce((a,b)=>a+b.score,0)/pipes.length:null;
  advancedSetCard('advancedRepoScore',avgRepo===null?'N/A':Math.round(avgRepo)); advancedSetCard('advancedPipelineScore',avgPipe===null?'N/A':Math.round(avgPipe)); advancedSetCard('advancedProtectionScore',protection.score===null?'N/A':Math.round(protection.score)); advancedSetCard('advancedPRCycle',advFormatHours(pr.avgCycle)); advancedSetCard('advancedPRReview','Loading…'); advancedSetCard('advancedWorkAging',advFormatHours(wi.avgAge*24)); advancedSetCard('advancedAgentUtil',advFormatPct(agents.utilization)); advancedSetCard('advancedAccessRisk',risk.high); advancedSetCard('advancedInactiveUsers',risk.inactive); advancedSetCard('advancedUnusedServices',svc.unused); advancedSetCard('advancedCommits',dev.reduce((a,b)=>a+b.commits,0)); advancedSetCard('advancedBuildFailures',pipes.reduce((a,b)=>a+b.failed,0));
  advancedRenderRepoTable(repos); advancedRenderPipelineTable(pipes); advancedRenderRiskTable(risk); advancedRenderServiceTable(svc);
  advChart('advancedHealthChart','bar',repos.slice(0,12).map(r=>r.repo),[{label:'Repository Health',data:repos.slice(0,12).map(r=>Math.round(r.score))}]);
  advChart('advancedDeveloperChart','line',dev.map(x=>x.date.slice(5)),[{label:'Commits',data:dev.map(x=>x.commits),tension:.25},{label:'PRs',data:dev.map(x=>x.prs),tension:.25}]);
  const failureTrend=[]; const failMap=new Map(); pipes.forEach(p=>p.runs.forEach(r=>{const d=advDate(r.rawTimestamp); if(!d)return; const k=d.toISOString().slice(0,10); if(!failMap.has(k))failMap.set(k,0); if(['failed','canceled','partiallysucceeded'].includes(String(r.result||'').toLowerCase()))failMap.set(k,failMap.get(k)+1);})); for(let d=new Date(advancedCutoff(days));d<=new Date();d.setDate(d.getDate()+1)){const k=d.toISOString().slice(0,10);failureTrend.push([k,failMap.get(k)||0]);} advChart('advancedFailureChart','line',failureTrend.map(x=>x[0].slice(5)),[{label:'Failed / Other Builds',data:failureTrend.map(x=>x[1]),tension:.2}]);
  advChart('advancedAgingChart','doughnut',wi.buckets.map(x=>x[0]),[{label:'Open Work Item Age',data:wi.buckets.map(x=>x[1])}]);
  const reviewAvg=await advancedFetchFirstReviewLatency(pr.prs); advancedSetCard('advancedPRReview',advFormatHours(reviewAvg));
  const sub=document.getElementById('advancedAnalyticsMeta'); if(sub)sub.textContent=`Scores are derived from loaded telemetry. Time window: ${days} days. Service connection “unused” requires explicit last-used telemetry; otherwise it is reported as unknown.`;
}
function configureAdvancedAnalytics(active){ const grid=document.querySelector('.kpi-grid'),chart=document.getElementById('chartSection'),controls=document.getElementById('tableControls'); if(grid)grid.classList.toggle('hidden',active); if(chart)chart.classList.toggle('hidden',active); if(controls)controls.classList.toggle('hidden',active); const v=document.getElementById('view-advanced'); if(v)v.classList.toggle('hidden',!active); if(active){ renderAdvancedAnalytics(); } else { advClearCharts(); } }
window.renderAdvancedAnalytics=renderAdvancedAnalytics; window.configureAdvancedAnalytics=configureAdvancedAnalytics;
