Object.assign(messages["zh-CN"], {
  queryHome:"查询", queryRun:"执行查询", queryLocal:"本地演示", queryStatus:"状态", queryAmount:"金额大于",
  queryAll:"全部", queryReset:"重置条件", queryDirty:"条件已修改，结果来自上次执行",
  queryDone:"查询完成", queryEmpty:"没有匹配的演示文档", queryScope:"orders-* · 6 条本地样本",
  queryTitle:"订单查询", queryWhere:"筛选条件", queryHint:"仅筛选内置样本，不连接 Elasticsearch",
  queryResults:"条结果", queryTime:"固定样本时间范围", queryInvalid:"金额必须是有效数字"
});
Object.assign(messages["en-US"], {
  queryHome:"Query", queryRun:"Run query", queryLocal:"Local demo", queryStatus:"Status", queryAmount:"Amount greater than",
  queryAll:"All", queryReset:"Reset filters", queryDirty:"Filters changed; results are from the previous run",
  queryDone:"Query completed", queryEmpty:"No matching demo documents", queryScope:"orders-* · 6 local samples",
  queryTitle:"Order search", queryWhere:"Filters", queryHint:"Filters built-in samples only; no Elasticsearch connection",
  queryResults:"results", queryTime:"Fixed sample time range", queryInvalid:"Enter a valid amount"
});
const queryStyle=document.createElement("style");
queryStyle.textContent=`
  .workspace { min-height:calc(100vh - 73px); }
  .query-context { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:16px; margin-bottom:24px; }
  .query-context h1 { font-size:1.3rem; font-weight:600; }
  .query-filter-grid { display:flex; flex-wrap:wrap; align-items:end; gap:16px; padding:16px 0; }
  .query-filter-grid label { display:grid; gap:8px; font-size:.85rem; color:var(--muted); min-width:160px; }
  .query-filter-grid input { width:180px; color:var(--text); }
  .query-run { display:inline-flex; align-items:center; justify-content:center; gap:8px; border-radius:6px; background:var(--accent); color:var(--on-accent); padding:9px 16px; min-height:38px; }
  .query-actions { display:flex; align-items:center; flex-wrap:wrap; gap:12px; margin-top:12px; }
  .query-state { font-size:.8rem; color:var(--muted); }
  .query-actions .icon-button { border:1px solid var(--border); }
  .query-mode-note { font-size:.8rem; color:var(--muted); }
  .workspace main { display:flex; flex-direction:column; }
  .workspace main > section:last-child { flex:1; }
  .table-wrap { min-height:360px; }
  .resource { gap:2px; }
`;
document.head.append(queryStyle);
const queryMain=document.querySelector("#workspace main");
const querySection=queryMain.querySelector("section");
querySection.querySelector("h1").dataset.i18n="queryTitle";
querySection.querySelector("h1").closest("div.mb-5").className="query-context";
querySection.querySelector('[data-i18n="time"]').dataset.i18n="queryTime";
querySection.querySelector('[data-i18n="demo"]').dataset.i18n="queryLocal";
const visual=document.getElementById("visual-query");
visual.className="query-filter-grid";
visual.innerHTML=`
  <label for="query-status"><span data-i18n="queryStatus"></span><select id="query-status"><option value="failed">failed</option><option value="" data-i18n="queryAll"></option></select></label>
  <label for="query-amount"><span data-i18n="queryAmount"></span><input id="query-amount" type="number" step="any" value="500"></label>
`;
const actionsBar=document.createElement("div");
actionsBar.className="query-actions";
actionsBar.innerHTML=`<button id="query-run" class="query-run"><i data-lucide="play" class="icon" aria-hidden="true"></i><span data-i18n="queryRun"></span></button>
  <button id="query-reset" class="icon-button" data-label="queryReset"><i data-lucide="rotate-ccw" class="icon" aria-hidden="true"></i></button>
  <span id="query-state" class="query-state" role="status"></span>`;
querySection.append(actionsBar);
const scope=document.createElement("p");
scope.className="query-mode-note mt-4";
scope.dataset.i18n="queryHint";
querySection.append(scope);
document.getElementById("workspace").classList.toggle("ai-hidden",!generalPreferences.startAI);
document.getElementById("toggle-ai").setAttribute("aria-pressed",String(generalPreferences.startAI));
document.querySelector(`[data-view="${generalPreferences.resultView}"]`).click();
const originalRender=render;
let queryRows=sample.slice();
let queryStateKey="queryScope";
let appliedStatus="failed";
let appliedAmount=500;
function updateQueryView() {
  const body=document.getElementById("rows");
  const numbers=new Intl.NumberFormat(state.locale,{minimumFractionDigits:2,maximumFractionDigits:2,useGrouping:generalPreferences.groupNumbers});
  const timeZone=generalPreferences.timeZone==="system"?Intl.DateTimeFormat().resolvedOptions().timeZone:generalPreferences.timeZone;
  const dates=new Intl.DateTimeFormat(state.locale,{timeZone,hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23",
    ...(generalPreferences.dateFormat==="datetime"?{year:"numeric",month:"2-digit",day:"2-digit"}:{})});
  body.replaceChildren();
  queryRows.forEach(record=>{
    const row=document.createElement("tr");
    [record.order_id,record.status,numbers.format(record.amount),record.payment.error,dates.format(new Date(record.created_at))].forEach((value,index)=>{
      const cell=document.createElement("td");cell.textContent=value;
      if(index===2)cell.className="text-right tabular-nums";
      row.append(cell);
    });
    body.append(row);
  });
  if(!queryRows.length) {
    const row=document.createElement("tr"),cell=document.createElement("td");
    cell.colSpan=5;cell.textContent=messages[state.locale].queryEmpty;cell.className="text-center text-muted";
    row.append(cell);body.append(row);
  }
  document.getElementById("json-view").textContent=JSON.stringify(queryRows,null,2);
  document.getElementById("query-state").textContent=messages[state.locale][queryStateKey];
  const resultSection=queryMain.querySelector("section:last-child");
  resultSection.querySelector(".rounded.bg-subtle").textContent=String(queryRows.length);
  resultSection.querySelector('[data-i18n="shown"]').textContent=`${queryRows.length} ${messages[state.locale].queryResults} · ${messages[state.locale].queryLocal}`;
  resultSection.querySelector('[data-i18n="timezone"]').textContent=timeZone;
  querySection.querySelector('[data-i18n="queryTime"]').nextElementSibling.textContent=timeZone;
  document.getElementById("dsl-query").textContent=JSON.stringify({query:{bool:{filter:[
    ...(appliedStatus?[{term:{status:appliedStatus}}]:[]),{range:{amount:{gt:appliedAmount}}}
  ]}}},null,2);
}
render=function(){originalRender();updateQueryView();};
window.addEventListener("escope:general",updateQueryView);
function executeLocalQuery() {
  if(window.escopeConnection && !window.escopeConnection.isDemo)return;
  const input=document.getElementById("query-amount");
  if(input.value.trim()==="" || !input.checkValidity() || !Number.isFinite(Number(input.value))) {
    queryStateKey="queryInvalid";updateQueryView();input.focus();return;
  }
  appliedStatus=document.getElementById("query-status").value;
  appliedAmount=Number(input.value);
  queryRows=sample.filter(record=>(!appliedStatus||record.status===appliedStatus)&&record.amount>appliedAmount);
  queryStateKey="queryDone";updateQueryView();
}
document.getElementById("query-run").addEventListener("click",executeLocalQuery);
document.getElementById("query-reset").addEventListener("click",()=>{
  document.getElementById("query-status").value="failed";
  document.getElementById("query-amount").value="500";
  executeLocalQuery();
});
visual.addEventListener("input",()=>{queryStateKey="queryDirty";updateQueryView();});
document.addEventListener("keydown",event=>{
  if(event.key==="Enter" && (isMac?event.metaKey:event.ctrlKey) && !event.isComposing &&
    !document.getElementById("workspace").hidden && !document.querySelector("dialog[open]")) {
    event.preventDefault();executeLocalQuery();
  }
});
render();
if(window.lucide)lucide.createIcons();
