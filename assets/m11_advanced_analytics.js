/* Phase 5 — Advanced Analytics (mature presentation + safer metric handling)
 * Derived from telemetry already loaded by the existing workspaces.
 * All scores are application indicators, not Azure DevOps certifications.
 */
let advancedChartInstances = [];
let advancedReviewLatencyCache = new Map();
const ADVANCED_DEFAULT_DAYS = 90;
const ADVANCED_REVIEW_PR_LIMIT = 50;
const ADVANCED_UNUSED_SERVICE_DAYS = 90;

function advNum(v, fallback=0) { const n=Number(v); return Number.isFinite(n) ? n : fallback; }
function advTime(v) {
  if (v instanceof Date) return v.getTime();
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (/^\d+$/.test(String(v).trim())) { const n=Number(v); return n < 1e12 ? n * 1000 : n; }
  return NaN;
}
function advDate(v) {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v : null;
  const numeric=advTime(v);
  if (Number.isFinite(numeric)) { const d=new Date(numeric); return Number.isFinite(d.getTime()) ? d : null; }
  const s=String(v||'').trim(); if (!s) return null;
  // Azure DevOps UI data is sometimes represented as DD/MM/YYYY or DD-MM-YYYY.
  let m=s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM))?)?$/i);
  if (m) {
    let hh=Number(m[4]||0), mm=Number(m[5]||0), ss=Number(m[6]||0);
    if (m[7]) { const ap=m[7].toUpperCase(); if (ap==='PM' && hh<12) hh+=12; if (ap==='AM' && hh===12) hh=0; }
    const d=new Date(Number(m[3]),Number(m[2])-1,Number(m[1]),hh,mm,ss); return Number.isFinite(d.getTime()) ? d : null;
  }
  const d=new Date(s); return Number.isFinite(d.getTime()) ? d : null;
}
function advDaysBetween(a,b=new Date()) { const da=advDate(a), db=advDate(b); return da&&db ? Math.max(0,(db-da)/86400000) : null; }
function advFormatHours(h) { if (!Number.isFinite(h)) return 'N/A'; if (h < 24) return `${h.toFixed(1)}h`; const d=h/24; return d < 30 ? `${d.toFixed(1)}d` : `${(d/30).toFixed(1)}mo`; }
function advFormatPct(v) { return Number.isFinite(v) ? `${Math.round(v)}%` : 'N/A'; }
function advScoreClass(score) { if (!Number.isFinite(score)) return 'neutral'; return score >= 80 ? 'good' : score >= 60 ? 'warn' : 'bad'; }
function advStatusBadge(label, cls='neutral') { return `<span class="advanced-badge ${cls}">${escapeHtml(label)}</span>`; }
function advScoreBadge(score) { const n=Number(score); return Number.isFinite(n) ? advStatusBadge(`${Math.round(n)}/100`, advScoreClass(n)) : advStatusBadge('N/A','neutral'); }
function advClearCharts() { advancedChartInstances.forEach(c=>{ try{c.destroy();}catch(e){} }); advancedChartInstances=[]; }
function advChart(id,type,labels,datasets,options={}) {
  const canvas=document.getElementById(id); if(!canvas || typeof Chart==='undefined') return;
  const chart=new Chart(canvas.getContext('2d'), { type, data:{labels,datasets}, options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:datasets.length>1}},scales:type==='doughnut'?{}:{y:{beginAtZero:true,ticks:{precision:0}},x:{grid:{display:false}}},...options} });
  advancedChartInstances.push(chart);
}
function advancedGetDays() { return parseInt(document.getElementById('advancedAnalyticsDays')?.value,10) || ADVANCED_DEFAULT_DAYS; }
function advancedCutoff(days=advancedGetDays()) { const d=new Date(); d.setDate(d.getDate()-days); return d; }
function advLocalKey(date) { const d=advDate(date); if(!d) return null; const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,'0'), day=String(d.getDate()).padStart(2,'0'); return `${y}-${m}-${day}`; }
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
  const branches=Array.isArray(rawStore.repos)?rawStore.repos:[];
  const map=new Map();
  branches.forEach(b=>{
    const k=b.repo||'Unknown'; if(!map.has(k)) map.set(k,{repo:k,branches:0,stale:0,protected:0,reviewProtected:0});
    const x=map.get(k); x.branches++; if(b.isStale)x.stale++; if(b.hasPolicy)x.protected++; if(advNum(b.minReviewers)>0)x.reviewProtected++;
  });
  return [...map.values()].map(x=>{
    const freshness=x.branches?100*(1-x.stale/x.branches):null;
    const protection=x.branches?100*x.protected/x.branches:null;
    const review=x.branches?100*x.reviewProtected/x.branches:null;
    // Health is intentionally limited to observable repository controls: freshness + policy coverage + reviewer coverage.
    const score=freshness===null?null:(.5*freshness+.35*(protection??0)+.15*(review??0));
    return {...x,freshness,protection,review,score};
  }).sort((a,b)=>(b.score??-1)-(a.score??-1));
}
function advancedPipelineHealth() {
  const runs=Array.isArray(rawStore.pipelines)?rawStore.pipelines:[]; const map=new Map();
  runs.forEach(r=>{
    const k=r.pipelineIdentityKey||`${r.pipelineType||'unknown'}:${r.pipelineId||r.name}`;
    if(!map.has(k))map.set(k,{key:k,name:r.name||'Unknown',pipelineType:r.pipelineType||'unknown',pipelineId:r.pipelineId,total:0,success:0,failed:0,runs:[]});
    const x=map.get(k); x.total++; const res=String(r.result||'').toLowerCase(); if(res==='succeeded')x.success++; else if(['failed','canceled','partiallysucceeded'].includes(res))x.failed++; x.runs.push(r);
  });
  return [...map.values()].map(x=>{
    x.runs.sort((a,b)=>(advTime(b.rawTimestamp)||0)-(advTime(a.rawTimestamp)||0));
    const successRate=x.total?100*x.success/x.total:null; const recent=x.runs.slice(0,10);
    const recentRate=recent.length?100*recent.filter(r=>String(r.result||'').toLowerCase()==='succeeded').length/recent.length:successRate;
    x.score=successRate===null?null:.7*successRate+.3*(recentRate??successRate); x.successRate=successRate; x.recentRate=recentRate;
    return x;
  }).sort((a,b)=>(b.score??-1)-(a.score??-1));
}
function advancedBranchProtection() {
  const rows=Array.isArray(rawStore.repos)?rawStore.repos:[]; if(!rows.length)return {score:null,protected:0,total:0,reviewProtected:0};
  const protectedRows=rows.filter(r=>r.hasPolicy); const reviewRows=rows.filter(r=>advNum(r.minReviewers)>0);
  return {score:100*(.65*protectedRows.length/rows.length+.35*reviewRows.length/rows.length),protected:protectedRows.length,total:rows.length,reviewProtected:reviewRows.length};
}
function advancedDeveloperTrend(days) {
  const cutoff=advancedCutoff(days), now=new Date(), map=new Map();
  const add=(date,key)=>{const d=advDate(date); if(!d||d<cutoff||d>now)return; const day=advLocalKey(d); if(!map.has(day))map.set(day,{commits:0,prs:0}); map.get(day)[key]++;};
  (rawStore.commits||[]).forEach(c=>add(c.rawDate||c.date,'commits')); (rawStore.repoPrs||[]).forEach(p=>add(p.rawCreatedTimestamp||p.rawDate||p.createdDate,'prs'));
  const out=[]; for(let d=new Date(cutoff);d<=now;d.setDate(d.getDate()+1)){const k=advLocalKey(d);out.push({date:k,...(map.get(k)||{commits:0,prs:0})});} return out;
}
function advancedPRMetrics() {
  const prs=(rawStore.repoPrs||[]);
  const completed=prs.filter(p=>['completed','merged'].includes(String(p.status||'').toLowerCase()) && advDate(p.rawCreatedTimestamp) && advDate(p.rawClosedTimestamp));
  const cycle=completed.map(p=>(advTime(p.rawClosedTimestamp)-advTime(p.rawCreatedTimestamp))/3600000).filter(Number.isFinite).filter(v=>v>=0);
  const active=prs.filter(p=>String(p.status||'').toLowerCase()==='active');
  const reviewable=prs.filter(p=>p.reviewersCount!==undefined); const reviewed=reviewable.filter(p=>advNum(p.reviewersCount)>0);
  return {completedCount:completed.length,avgCycle:cycle.length?cycle.reduce((a,b)=>a+b,0)/cycle.length:null,medianCycle:cycle.length?cycle.slice().sort((a,b)=>a-b)[Math.floor(cycle.length/2)]:null,active:active.length,reviewCoverage:reviewable.length?100*reviewed.length/reviewable.length:null,prs};
}
async function advancedFetchFirstReviewLatency(prs) {
  const candidates=(prs||[]).filter(p=>p.repoId&&p.id).slice().sort((a,b)=>(advTime(b.rawCreatedTimestamp)||0)-(advTime(a.rawCreatedTimestamp)||0)).slice(0,ADVANCED_REVIEW_PR_LIMIT); let values=[];
  for(const p of candidates){
    const key=`${p.repoId}:${p.id}`;
    if(advancedReviewLatencyCache.has(key)){const v=advancedReviewLatencyCache.get(key); if(Number.isFinite(v))values.push(v); continue;}
    try{
      const org=extractOrgName(document.getElementById('targetOrg')?.value||''); const project=document.getElementById('projectSelect')?.value||'';
      const url=`https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(p.repoId)}/pullRequests/${encodeURIComponent(p.id)}/threads?api-version=${API_VERSION}`;
      const data=await fetchAzDoPaged(url,createBasicAuthHeader(document.getElementById('targetPat')?.value||''),{pageSize:200});
      const creator=normalizeIdentityText(p.creator||''); const dates=[];
      (data?.value||[]).forEach(t=>(t.comments||[]).forEach(c=>{
        if(c.isDeleted)return; const author=normalizeIdentityText(c.author?.displayName||c.author?.uniqueName||'');
        if(author && author!==creator && !/system|build service|microsoft.visualstudio.services/i.test(author)){const d=advDate(c.publishedDate||t.publishedDate); if(d)dates.push(d);}
      }));
      const created=advDate(p.rawCreatedTimestamp), first=dates.sort((a,b)=>a-b)[0], hours=created&&first?(first-created)/3600000:null;
      advancedReviewLatencyCache.set(key,Number.isFinite(hours)&&hours>=0?hours:null); if(Number.isFinite(hours)&&hours>=0)values.push(hours);
    }catch(e){ advancedReviewLatencyCache.set(key,null); }
  }
  return values.length?values.reduce((a,b)=>a+b,0)/values.length:null;
}
function advancedWorkItemAging() {
  const now=new Date();
  const open=(rawStore.workitems||[]).filter(w=>!['completed','removed','resolved'].includes(String(w.stateCategory||'').toLowerCase()));
  const buckets=[['0–7 days',0],['8–30 days',0],['31–60 days',0],['61–90 days',0],['90+ days',0]]; let ages=[];
  open.forEach(w=>{const d=advDate(w.rawCreatedTimestamp||w.createdDate); const age=d?Math.floor((now-d)/86400000):null; if(age===null||age<0)return; ages.push(age); if(age<=7)buckets[0][1]++; else if(age<=30)buckets[1][1]++; else if(age<=60)buckets[2][1]++; else if(age<=90)buckets[3][1]++; else buckets[4][1]++;});
  return {openCount:open.length,avgAge:ages.length?ages.reduce((a,b)=>a+b,0)/ages.length:null,oldestAge:ages.length?Math.max(...ages):null,buckets};
}
function advancedAgentUtilization() {
  const agents=(rawStore.agents||[]).filter(a=>a.isHosted==='No' && a.name && a.name!=='Unable to read agents'); const enabled=agents.filter(a=>String(a.enabled).toLowerCase()==='yes'); const assigned=enabled.filter(a=>a.assignedRequest); return {enabled:enabled.length,assigned:assigned.length,utilization:enabled.length?100*assigned.length/enabled.length:null,online:enabled.filter(a=>/online|idle/i.test(String(a.status))).length};
}
function advancedUserRisk() {
  const users=(rawStore.userEntitlements||[]), access=(rawStore.access||[]); const counts=new Map();
  access.forEach(a=>{const k=normalizeIdentityText(a.email||a.name||''); if(k)counts.set(k,(counts.get(k)||0)+1);});
  const cutoff=advancedCutoff(ADVANCED_UNUSED_SERVICE_DAYS);
  const rows=users.map(u=>{
    const key=normalizeIdentityText(u.email||u.name||''), memberships=counts.get(key)||0, last=advDate(u.lastAccessedDate);
    const inactive=String(u.status||'').toLowerCase()!=='active', stale=!!last&&last<cutoff; let score=0, reasons=[];
    if(inactive){score+=50; reasons.push('Directory status is not Active');}
    if(stale){score+=30; reasons.push('No access for >90 days');}
    if(memberships>=5){score+=20; reasons.push(`${memberships} access memberships`);} else if(memberships>=3){score+=10; reasons.push(`${memberships} access memberships`);}
    return {...u,memberships,indicatorScore:Math.min(100,score),inactive,inactive90:stale,reasons};
  }).sort((a,b)=>b.indicatorScore-a.indicatorScore);
  return {rows,inactive:rows.filter(r=>r.inactive).length,inactive90:rows.filter(r=>r.inactive90).length,high:rows.filter(r=>r.indicatorScore>=60).length};
}
function advancedServiceUsage() {
  const cutoff=advancedCutoff(ADVANCED_UNUSED_SERVICE_DAYS); const rows=(rawStore.serviceConnections||[]).map(s=>{const d=advDate(s.rawLastUsedTimestamp||s.lastUsedDate); const unused=!!d&&d<cutoff; return {...s,usageKnown:!!d,unused};}); return {rows,unused:rows.filter(r=>r.unused).length,unknown:rows.filter(r=>!r.usageKnown).length};
}
function advancedSetCard(id,value,sub='') { const el=document.getElementById(id); if(el)el.textContent=value; const se=document.getElementById(`${id}-sub`); if(se)se.textContent=sub; }
function advancedSetStatus(id,status){const card=document.querySelector(`[data-advanced-card="${id}"]`); if(card)card.classList.remove('status-good','status-warn','status-bad','status-neutral'),card.classList.add(`status-${status}`);}
function advancedTable(id,html){const el=document.getElementById(id); if(el)setSafeInnerHTML(el,html);}
function advancedRenderRepoTable(rows){
  advancedTable('advancedRepoHealthBody',rows.length?rows.slice(0,20).map(r=>`<tr><td>${escapeHtml(r.repo)}</td><td>${r.branches}</td><td>${r.stale} (${advFormatPct(r.branches?r.stale/r.branches*100:null)})</td><td>${r.protected} (${advFormatPct(r.branches?r.protected/r.branches*100:null)})</td><td>${advFormatPct(r.freshness)}</td><td>${advFormatPct(r.protection)}</td><td>${advScoreBadge(r.score)}</td></tr>`).join(''):`<tr><td colspan="7" class="advanced-empty">Load Repositories & Branches to calculate repository health.</td></tr>`);
}
function advancedRenderPipelineTable(rows){
  advancedTable('advancedPipelineHealthBody',rows.length?rows.slice(0,20).map(r=>`<tr><td>${escapeHtml(r.name)}<small>${escapeHtml(String(r.pipelineType).toUpperCase())} · ID ${escapeHtml(r.pipelineId)}</small></td><td>${r.total}</td><td>${advFormatPct(r.successRate)}</td><td>${advFormatPct(r.recentRate)}</td><td>${r.failed}</td><td>${advScoreBadge(r.score)}</td></tr>`).join(''):`<tr><td colspan="6" class="advanced-empty">Load Pipelines & Builds to calculate pipeline reliability.</td></tr>`);
}
function advancedRenderRiskTable(risk){
  advancedTable('advancedRiskBody',risk.rows.length?risk.rows.slice(0,20).map(r=>`<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.email)}</td><td>${r.memberships}</td><td>${r.lastAccessedDate?escapeHtml(String(r.lastAccessedDate)):'—'}</td><td>${escapeHtml(r.reasons.length?r.reasons.join(' · '):'No strong indicator')}</td><td>${advScoreBadge(r.indicatorScore)}</td></tr>`).join(''):`<tr><td colspan="6" class="advanced-empty">Load Organization & Project Users to calculate access review indicators.</td></tr>`);
}
function advancedRenderServiceTable(svc){ advancedTable('advancedServiceBody',svc.rows.length?svc.rows.slice(0,20).map(r=>`<tr><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.type)}</td><td>${r.usageKnown?(r.unused?advStatusBadge('Review: unused > 90d','bad'):advStatusBadge('Used < 90d','good')):advStatusBadge('Usage unknown','neutral')}</td><td>${escapeHtml(r.lastUsedDate||'Not exposed by API')}</td></tr>`).join(''):`<tr><td colspan="4" class="advanced-empty">Load Service Connections to evaluate usage telemetry.</td></tr>`); }
function advancedRenderAttention({repos,pipes,protection,pr,wi,agents,risk,svc,dev}){
  const items=[];
  if(repos.length){const r=repos[0]; const stalePct=r.branches?r.stale/r.branches*100:0; const avg=repos.reduce((a,b)=>a+(b.score??0),0)/repos.length; const worst=repos.slice().sort((a,b)=>(a.score??101)-(b.score??101))[0]; if(stalePct>=30)items.push({cls:'bad',title:`${Math.round(stalePct)}% of ${r.repo} branches are stale`,text:`Repository health is ${Math.round(avg)}/100 on average. Review ${worst.repo} first if its score is lowest.`}); else items.push({cls:'good',title:'Branch freshness looks healthy',text:`The repository inventory has less than 30% stale branches in the leading repository.`});}
  if(pipes.length){const failures=pipes.reduce((a,b)=>a+b.failed,0), avg=pipes.reduce((a,b)=>a+(b.score??0),0)/pipes.length; items.push({cls:avg<70?'bad':avg<85?'warn':'good',title:`Pipeline reliability: ${Math.round(avg)}/100`,text:`${failures} failed/canceled/partial runs were found in the loaded run history.`});}
  if(protection.total)items.push({cls:protection.score<70?'warn':'good',title:`Branch protection coverage: ${Math.round(protection.score)}/100`,text:`${protection.protected} of ${protection.total} branches have policies and ${protection.reviewProtected} require reviewers.`});
  if(pr.completedCount===0)items.push({cls:'neutral',title:'PR cycle time is not available',text:'No completed PRs with both creation and completion timestamps are loaded. Load User Activity or Repository PR telemetry with completed PRs.'}); else items.push({cls:pr.avgCycle>72?'warn':'good',title:`Average PR cycle: ${advFormatHours(pr.avgCycle)}`,text:`Based on ${pr.completedCount} completed PRs with usable timestamps.`});
  if(wi.openCount)items.push({cls:wi.oldestAge>90?'warn':'good',title:`${wi.openCount} open work items`,text:`Average age is ${advFormatHours((wi.avgAge??0)*24)}; oldest loaded item is ${wi.oldestAge ?? 0} days.`});
  if(agents.enabled)items.push({cls:(agents.utilization??0)>85?'warn':'good',title:`Self-hosted agent utilization: ${advFormatPct(agents.utilization)}`,text:`${agents.assigned} of ${agents.enabled} enabled self-hosted agents are currently assigned.`});
  if(risk.high)items.push({cls:'warn',title:`${risk.high} users need access review`,text:'These are heuristic indicators based on directory status, last access and membership count. Investigate before removing access.'});
  if(svc.unknown)items.push({cls:'neutral',title:`${svc.unknown} service connections have unknown usage`,text:'Azure DevOps did not expose last-used telemetry, so they are not counted as unused.'});
  if(dev.some(x=>x.commits||x.prs))items.push({cls:'good',title:`Developer activity is available`,text:`${dev.reduce((a,b)=>a+b.commits,0)} commits and ${dev.reduce((a,b)=>a+b.prs,0)} PRs fall inside the selected time window.`});
  const el=document.getElementById('advancedAttentionList'); if(!el)return; const shown=items.slice(0,8); setSafeInnerHTML(el,shown.length?shown.map(i=>`<div class="advanced-attention-item ${i.cls}"><strong>${escapeHtml(i.title)}</strong><span>${escapeHtml(i.text)}</span></div>`).join(''):`<div class="advanced-attention-item neutral"><strong>Not enough telemetry</strong><span>Load the relevant workspaces and refresh this dashboard.</span></div>`);
}
async function renderAdvancedAnalytics(){
  const days=advancedGetDays(), notice=document.getElementById('advancedAnalyticsNotice'); if(notice)notice.textContent=advancedLoadedNotice(); advClearCharts();
  const repos=advancedRepoHealth(), pipes=advancedPipelineHealth(), protection=advancedBranchProtection(), dev=advancedDeveloperTrend(days), pr=advancedPRMetrics(), wi=advancedWorkItemAging(), agents=advancedAgentUtilization(), risk=advancedUserRisk(), svc=advancedServiceUsage();
  const avgRepo=repos.length?repos.reduce((a,b)=>a+(b.score??0),0)/repos.length:null, avgPipe=pipes.length?pipes.reduce((a,b)=>a+(b.score??0),0)/pipes.length:null;
  advancedSetCard('advancedRepoScore',avgRepo===null?'N/A':Math.round(avgRepo),'Overall freshness + protection'); advancedSetCard('advancedPipelineScore',avgPipe===null?'N/A':Math.round(avgPipe),'Build success indicator'); advancedSetCard('advancedProtectionScore',protection.score===null?'N/A':Math.round(protection.score),'Policy + reviewer coverage'); advancedSetCard('advancedPRCycle',advFormatHours(pr.avgCycle),'Completed PRs'); advancedSetCard('advancedPRReview','Loading…','First human response'); advancedSetCard('advancedWorkAging',wi.avgAge===null?'N/A':advFormatHours(wi.avgAge*24),'Open items'); advancedSetCard('advancedAgentUtil',advFormatPct(agents.utilization),'Current assignments'); advancedSetCard('advancedAccessRisk',risk.high,'High review indicators'); advancedSetCard('advancedInactiveUsers',risk.inactive,'Directory status'); advancedSetCard('advancedUnusedServices',svc.unused,`Verified > ${ADVANCED_UNUSED_SERVICE_DAYS}d`); advancedSetCard('advancedCommits',dev.reduce((a,b)=>a+b.commits,0),`${days}-day window`); advancedSetCard('advancedBuildFailures',pipes.reduce((a,b)=>a+b.failed,0),'Failed / canceled / partial');
  advancedSetStatus('repo',avgRepo===null?'neutral':advScoreClass(avgRepo)); advancedSetStatus('pipeline',avgPipe===null?'neutral':advScoreClass(avgPipe)); advancedSetStatus('protection',protection.score===null?'neutral':advScoreClass(protection.score)); advancedSetStatus('cycle',pr.avgCycle===null?'neutral':pr.avgCycle<=48?'good':pr.avgCycle<=72?'warn':'bad'); advancedSetStatus('review','neutral'); advancedSetStatus('aging',wi.avgAge===null?'neutral':wi.avgAge<=30?'good':wi.avgAge<=60?'warn':'bad'); advancedSetStatus('agents',agents.utilization===null?'neutral':agents.utilization<=80?'good':'warn'); advancedSetStatus('risk',risk.high?'warn':'good'); advancedSetStatus('inactive',risk.inactive?'warn':'good'); advancedSetStatus('unused',svc.unknown?'neutral':svc.unused?'warn':'good'); advancedSetStatus('commits',dev.some(x=>x.commits)?'good':'neutral'); advancedSetStatus('failures',pipes.length?(pipes.reduce((a,b)=>a+b.failed,0)>0?'warn':'good'):'neutral');
  advancedRenderRepoTable(repos); advancedRenderPipelineTable(pipes); advancedRenderRiskTable(risk); advancedRenderServiceTable(svc); advancedRenderAttention({repos,pipes,protection,pr,wi,agents,risk,svc,dev});
  const healthSummary=document.getElementById('advancedHealthSummary'); if(healthSummary)healthSummary.textContent=repos.length?`Average ${Math.round(avgRepo)} / 100. Score combines branch freshness (50%), policy coverage (35%) and reviewer coverage (15%).`:'Load Repositories & Branches to populate this chart.';
  const agingSummary=document.getElementById('advancedAgingSummary'); if(agingSummary)agingSummary.textContent=wi.openCount?`${wi.openCount} open items · average age ${wi.avgAge===null?'N/A':Math.round(wi.avgAge)+' days'} · oldest ${wi.oldestAge??'N/A'} days.`:'No open work-item telemetry is currently loaded.';
  advChart('advancedHealthChart','bar',repos.slice(0,12).map(r=>r.repo),[{label:'Health score (0–100)',data:repos.slice(0,12).map(r=>Math.round(r.score??0))}],{scales:{y:{beginAtZero:true,max:100,ticks:{precision:0}},x:{grid:{display:false}}}});
  advChart('advancedDeveloperChart','line',dev.map(x=>x.date.slice(5)),[{label:'Commits',data:dev.map(x=>x.commits),tension:.25},{label:'PRs',data:dev.map(x=>x.prs),tension:.25}]);
  const failureTrend=[]; const failMap=new Map(); pipes.forEach(p=>p.runs.forEach(r=>{const d=advDate(r.rawTimestamp); if(!d)return; const k=advLocalKey(d); if(!failMap.has(k))failMap.set(k,0); if(['failed','canceled','partiallysucceeded'].includes(String(r.result||'').toLowerCase()))failMap.set(k,failMap.get(k)+1);}));
  const cutoff=advancedCutoff(days), now=new Date(); for(let d=new Date(cutoff);d<=now;d.setDate(d.getDate()+1)){const k=advLocalKey(d);failureTrend.push([k,failMap.get(k)||0]);}
  advChart('advancedFailureChart','line',failureTrend.map(x=>x[0].slice(5)),[{label:'Runs without success',data:failureTrend.map(x=>x[1]),tension:.2}]);
  advChart('advancedAgingChart','doughnut',wi.buckets.map(x=>x[0]),[{label:'Open work items',data:wi.buckets.map(x=>x[1])}]);
  const reviewAvg=await advancedFetchFirstReviewLatency(pr.prs); advancedSetCard('advancedPRReview',advFormatHours(reviewAvg),'First human response'); advancedSetStatus('review',reviewAvg===null?'neutral':reviewAvg<=24?'good':reviewAvg<=48?'warn':'bad');
  const sub=document.getElementById('advancedAnalyticsMeta'); if(sub)sub.textContent=`Management view for ${days} days. Scores are calculated indicators from loaded telemetry; N/A means reliable source data is not available. Service connection “unused” is counted only when last-used telemetry is exposed by Azure DevOps.`;
}
function configureAdvancedAnalytics(active){ const grid=document.querySelector('.kpi-grid'),chart=document.getElementById('chartSection'),controls=document.getElementById('tableControls'); if(grid)grid.classList.toggle('hidden',active); if(chart)chart.classList.toggle('hidden',active); if(controls)controls.classList.toggle('hidden',active); const v=document.getElementById('view-advanced'); if(v)v.classList.toggle('hidden',!active); if(active){ renderAdvancedAnalytics(); } else { advClearCharts(); } }
window.renderAdvancedAnalytics=renderAdvancedAnalytics; window.configureAdvancedAnalytics=configureAdvancedAnalytics;
