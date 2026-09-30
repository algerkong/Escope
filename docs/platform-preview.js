(() => {
  const copy = {
    overview:["集群概览","Overview"], nodes:["节点","Nodes"], shards:["分片","Shards"], indices:["索引","Indices"],
    query:["查询工作台","Query workspace"], models:["AI 模型","AI models"], connections:["连接中心","Connections"],
    demo:["演示环境 · 不连接外部服务","Demo environment · No external services"],
    subtitle:["Commerce / 开发环境","Commerce / Development"],
    health:["分配健康","Allocation health"], yellow:["副本未分配","Unassigned replica"],
    healthy:["正常","Healthy"], unavailable:["未分配","Unassigned"], warning:["需要关注","Needs attention"],
    dataNodes:["数据节点","Data nodes"], documents:["文档","Documents"], storage:["总存储","Total storage"],
    primary:["主分片","Primary"], replica:["副本","Replica"], node:["节点","Node"], index:["索引","Index"],
    role:["角色","Role"], heap:["JVM 堆","JVM heap"], disk:["磁盘使用率","Disk usage"], cpu:["CPU","CPU"],
    name:["名称","Name"], status:["状态","Status"], size:["大小","Size"], actions:["操作","Actions"],
    details:["查看详情","View details"], refresh:["重置演示数据","Reset demo data"],
    diagnostics:["健康检查","Health checks"], trends:["资源使用","Resource usage"],
    explanation:["分配解释","Allocation explanation"], inspect:["检查","Inspect"],
    diskIssue:["data-02 磁盘空间不足，副本分配被阻止","data-02 disk pressure prevents replica allocation"],
    healthNote:["主分片均已分配；1 个副本未分配。","All primary shards are assigned; one replica is unassigned."],
    sampled:["固定演示快照 · 2026-09-30 10:00 UTC+08:00","Fixed demo snapshot · Sep 30, 2026 10:00 UTC+08:00"],
    filter:["按名称筛选","Filter by name"], all:["全部","All"], empty:["没有匹配的记录","No matching records"],
    matrix:["矩阵","Matrix"], list:["列表","List"], source:["证据","Evidence"], recommendation:["建议","Recommendation"],
    diskAdvice:["先释放磁盘空间或扩容，再检查分配规则。不要直接强制分配或移除保护设置。","Free disk space or add capacity, then inspect allocation rules. Do not force allocation or remove safeguards."],
    mockExplain:["以下为固定演示响应，不是集群实时诊断。","This is a fixed demo response, not a live diagnosis."],
    mappings:["字段结构","Mapping"], settingsTab:["设置","Settings"], summary:["概览","Summary"],
    readOnlyOps:["只读原型，未开放索引写入","Read-only prototype; index mutations are unavailable"],
    close:["关闭","Close"], healthDetails:["健康诊断详情","Health diagnostic details"],
    registry:["提供方与模型","Providers & models"], addModel:["添加模型","Add model"], provider:["提供方","Provider"],
    protocol:["协议","Protocol"], endpoint:["服务地址","Endpoint"], modelId:["模型 ID / 部署名","Model ID / deployment"],
    modelName:["显示名称","Display name"], select:["选择","Select"], selected:["已选择","Selected"],
    configure:["管理模型","Manage models"], none:["未配置模型","No model configured"],
    modelHint:["只保存模型目录；本原型不保存密钥，也不发送模型请求。","Only model metadata is saved. This prototype stores no secrets and sends no model requests."],
    modelSelected:["下一次使用","Selected for next request"], remove:["移除","Remove"], save:["保存","Save"],
    modelRequired:["请填写名称、模型 ID 和有效的 HTTP(S) 地址。","Enter a name, model ID and valid HTTP(S) endpoint."],
    unsafeURL:["地址不能包含用户名、密码、查询参数或片段。","Endpoint must not contain credentials, query parameters or fragments."],
    modelNote:["更换提供方不会发送历史记录。当前回答仍为静态示例。","Switching providers does not send history. The current response remains a static example."],
    addConnection:["添加连接配置","Add connection profile"], connectionName:["连接名称","Connection name"],
    environment:["环境","Environment"], development:["开发","Development"], production:["生产","Production"], staging:["测试","Staging"],
    auth:["认证方式","Authentication"], noAuth:["无认证","None"], basic:["用户名 / 密码","Username / password"],
    connectionHint:["配置草稿仅保存在本机，不会测试连接或读取集群。认证信息在正式桌面版中进入系统密钥库。","Draft profiles stay on this device. No connection tests or cluster reads. The desktop release will use the OS credential store."],
    draft:["未测试 · 配置草稿","Untested · Draft profile"], newProfile:["新连接","New connection"],
    network:["网络与 TLS","Network & TLS"], tls:["校验证书","Verify certificate"], enabled:["开启","Enabled"],
    advanced:["正式版计划：自定义 CA、mTLS、代理与 SSH 隧道。","Planned for the desktop release: custom CA, mTLS, proxy and SSH tunnel."],
    noModels:["还没有模型配置","No models configured yet"], addFirst:["添加模型后即可手动选择；实际调用尚未接入。","Add a model to select it manually. Actual model calls are not connected yet."],
    registryOnly:["已配置 · 未验证","Configured · Unverified"], session:["会话配置","Session configuration"],
    deleteModel:["移除这个模型配置？不会删除服务端模型。","Remove this local model profile? The server model is not deleted."],
    deleteConnection:["移除这个连接草稿？不会修改集群。","Remove this connection draft? The cluster will not be changed."],
    cancel:["取消","Cancel"], resetFilters:["清除筛选","Clear filters"],
    main:["当前主节点","Current master"], data:["数据","Data"], coordinator:["协调 / Master","Coordinator / Master"],
    allocated:["已分配","Assigned"], restored:["演示筛选已重置","Demo filters reset"],
    searchIndex:["查看查询工作台","Open query workspace"], saved:["已保存在本机","Saved locally"],
    storageFailure:["本地保存不可用；仅本次会话有效。","Local storage unavailable; changes last for this session only."],
    resource:["资源","Resources"], connectionGroup:["工作区","Workspace"], tools:["工具","Tools"],
    workspaceConnection:["工作区连接","Workspace connection"], rename:["重命名","Rename"],
    disconnected:["未连接：原型尚未接入此 Elasticsearch 服务。","Not connected: this prototype does not access this Elasticsearch service."],
    demoConnection:["Commerce · 演示连接","Commerce · Demo connection"]
  };
  const text = key => copy[key]?.[state.locale === "en-US" ? 1 : 0] || key;
  for (const [key,value] of Object.entries(copy)) {
    messages["zh-CN"][`platform_${key}`] = value[0];
    messages["en-US"][`platform_${key}`] = value[1];
  }
  const escape = value => String(value).replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[character]));
  const icon = name => `<i data-lucide="${name}" class="icon" aria-hidden="true"></i>`;
  const nodes = [
    {name:"master-01",role:"coordinator",cpu:8,heap:31,disk:24,storage:"48 / 200 GB",version:"8.15.1"},
    {name:"data-01",role:"data",cpu:24,heap:52,disk:61,storage:"610 / 1,000 GB",version:"8.15.1"},
    {name:"data-02",role:"data",cpu:37,heap:68,disk:93,storage:"930 / 1,000 GB",version:"8.15.1"}
  ];
  const indices = [
    {name:"orders-2026.09",health:"yellow",docs:128640,bytes:"4.8 GB",primary:2,replica:1,fields:{order_id:"keyword",status:"keyword",amount:"double",created_at:"date",payment:"object"}},
    {name:"payments-2026.09",health:"healthy",docs:92410,bytes:"2.1 GB",primary:1,replica:1,fields:{payment_id:"keyword",order_id:"keyword",status:"keyword",created_at:"date"}},
    {name:"events-2026.09",health:"healthy",docs:841920,bytes:"8.4 GB",primary:1,replica:1,fields:{event_id:"keyword",message:"text","@timestamp":"date"}}
  ];
  const shards = [
    {index:indices[0].name,node:"data-01",id:0,type:"primary",status:"allocated",size:"1.6 GB"},
    {index:indices[0].name,node:"data-02",id:0,type:"replica",status:"allocated",size:"1.6 GB"},
    {index:indices[0].name,node:"data-01",id:1,type:"primary",status:"allocated",size:"1.6 GB"},
    {index:indices[0].name,node:"unassigned",id:1,type:"replica",status:"unavailable",size:"—"},
    {index:indices[1].name,node:"data-01",id:0,type:"primary",status:"allocated",size:"1.05 GB"},
    {index:indices[1].name,node:"data-02",id:0,type:"replica",status:"allocated",size:"1.05 GB"},
    {index:indices[2].name,node:"data-01",id:0,type:"primary",status:"allocated",size:"4.2 GB"},
    {index:indices[2].name,node:"data-02",id:0,type:"replica",status:"allocated",size:"4.2 GB"}
  ];
  const protocols = ["OpenAI-compatible","OpenAI Responses","Anthropic","Google Gemini","Azure OpenAI","Ollama","AWS Bedrock"];
  function readProfiles(key) {
    try {
      const data = JSON.parse(localStorage.getItem(key) || "[]");
      return Array.isArray(data) ? data.filter(profile => profile && typeof profile.id === "string" &&
        typeof profile.name === "string" && typeof profile.endpoint === "string" &&
        (key.endsWith("models") ? typeof profile.model === "string" && protocols.includes(profile.protocol) :
          ["development","staging","production"].includes(profile.environment) && ["noAuth","basic","API Key","Bearer"].includes(profile.auth))) : [];
    } catch { return []; }
  }
  let models = readProfiles("escope-models");
  let profiles = readProfiles("escope-connections");
  const demoProfile={id:"demo-commerce",name:"Commerce",endpoint:"localhost:9200",environment:"development",auth:"noAuth"};
  const availableConnections=()=>profiles.length?profiles:[demoProfile];
  let selectedConnection="";
  try { selectedConnection=localStorage.getItem("escope-active-connection")||""; } catch {}
  function activeConnection() {
    const list=availableConnections();
    if(!list.some(profile=>profile.id===selectedConnection)) selectedConnection=list[0].id;
    return list.find(profile=>profile.id===selectedConnection);
  }
  activeConnection();
  const connectionControl=document.createElement("div");
  connectionControl.className="flex items-center gap-2";
  document.querySelector("header .settings").prepend(connectionControl);
  const connectionNotice=document.createElement("div");
  connectionNotice.className="p-6 text-muted";
  connectionNotice.setAttribute("role","status");
  document.querySelector("#workspace main").prepend(connectionNotice);
  function syncConnection() {
    const active=activeConnection();
    window.escopeConnection={...active,isDemo:active.id===demoProfile.id};
    const list=availableConnections();
    connectionControl.replaceChildren();
    if(list.length>1) {
      const select=document.createElement("select");
      select.id="workspace-connection";
      select.setAttribute("aria-label",text("workspaceConnection"));
      select.style.maxWidth="240px";
      list.forEach(profile=>{
        const option=document.createElement("option");option.value=profile.id;option.textContent=profile.name;
        select.append(option);
      });
      select.value=active.id;
      select.addEventListener("change",()=>selectConnection(select.value));
      connectionControl.append(select);
    } else {
      const name=document.createElement("span");name.className="text-sm";name.textContent=active.id===demoProfile.id?text("demoConnection"):active.name;
      connectionControl.append(name);
    }
    const resource=document.querySelector("#workspace .resource");
    resource.querySelector(".nav-row .font-medium").textContent=active.name;
    resource.querySelector(".nav-row .text-muted").textContent=active.environment.toUpperCase();
    resource.querySelector(".mb-5.mt-1").textContent=active.endpoint;
    resource.querySelectorAll(".nav-row").forEach((row,index)=>{if(index>0)row.hidden=active.id!==demoProfile.id;});
    const queryMain=document.querySelector("#workspace main");
    queryMain.querySelectorAll(":scope > section").forEach(section=>{section.hidden=active.id!==demoProfile.id;});
    connectionNotice.hidden=active.id===demoProfile.id;
    connectionNotice.textContent=`${active.name} · ${text("disconnected")}`;
    document.querySelector(".assistant").hidden=active.id!==demoProfile.id;
    try {localStorage.setItem("escope-active-connection",active.id);} catch {}
    window.dispatchEvent(new Event("escope:connection"));
  }
  function selectConnection(id) {
    if(!availableConnections().some(profile=>profile.id===id))return;
    selectedConnection=id;syncConnection();renderPlatform();
  }
  let chosenModel = "";
  try { chosenModel = localStorage.getItem("escope-model-choice") || ""; } catch {}
  if (!models.some(model => model.id === chosenModel)) chosenModel = "";
  let current = "query";
  let filter = "";
  let statusFilter = "all";
  let shardView = "matrix";
  const pageTitles = {overview:"activity",nodes:"server",shards:"grid-2x2",indices:"layers",query:"search",connections:"plug",models:"sparkles"};
  const style = document.createElement("style");
  style.textContent = `
    .platform { display:grid; grid-template-columns:216px minmax(0,1fr); min-height:calc(100vh - 73px); }
    .platform-nav { padding:24px 12px; background:var(--sidebar); border-right:1px solid var(--border); }
    .platform-nav button { width:100%; border:0; background:none; display:flex; align-items:center; gap:10px; padding:10px 12px; margin:3px 0; border-radius:6px; text-align:left; font-size:.95rem; }
    .platform-nav button[aria-current="page"] { color:var(--accent); background:color-mix(in srgb,var(--accent) 9%,transparent); }
    .platform-nav .nav-caption { padding:18px 12px 6px; font-size:.8rem; color:var(--muted); }
    .platform-content { min-width:0; padding:30px 32px; }
    .platform-head { display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:16px; margin-bottom:28px; }
    .platform-head h1 { font-size:1.5rem; font-weight:600; }
    .platform-subtitle { font-size:.85rem; color:var(--muted); margin-top:6px; }
    .metric-band { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); border-top:1px solid var(--border); border-bottom:1px solid var(--border); margin-bottom:32px; }
    .metric { padding:22px 18px; border-right:1px solid var(--border); }
    .metric:first-child { padding-left:0; } .metric:last-child { border:0; }
    .metric-label { font-size:.85rem; color:var(--muted); }
    .metric-value { font-size:1.8rem; margin-top:8px; font-weight:550; font-variant-numeric:tabular-nums; }
    .metric-note { font-size:.8rem; color:var(--muted); margin-top:5px; }
    .platform h2 { font-size:1.05rem; font-weight:600; margin-bottom:16px; }
    .overview-grid { display:grid; grid-template-columns:minmax(0,1.2fr) minmax(0,1fr); gap:40px; }
    .health-row { display:flex; align-items:flex-start; gap:12px; padding:18px 0; border-bottom:1px solid var(--border); }
    .health-row p { font-size:.9rem; margin-top:5px; color:var(--muted); line-height:1.8; }
    .status-badge { display:inline-flex; align-items:center; gap:6px; font-size:.8rem; white-space:nowrap; }
    .status-badge:before { content:""; width:6px; height:6px; border-radius:50%; background:currentColor; }
    .status-healthy { color:#16836c; } .status-yellow,.status-unavailable { color:#946000; }
    :root[data-theme="dark"] .status-healthy { color:#70d4b8; } :root[data-theme="dark"] .status-yellow,:root[data-theme="dark"] .status-unavailable { color:#f0c16c; }
    .meter { display:flex; gap:10px; align-items:center; min-width:110px; }
    .meter-track { height:5px; flex:1; background:var(--border); border-radius:3px; overflow:hidden; }
    .meter-track span { display:block; height:100%; background:var(--accent); }
    .meter.danger .meter-track span { background:var(--error); } .meter em { font-style:normal; min-width:36px; text-align:right; }
    .node-meter { padding:14px 0; border-bottom:1px solid var(--border); }
    .node-meter .meter { margin-top:10px; }
    .platform-toolbar { display:flex; flex-wrap:wrap; align-items:center; gap:12px; margin:20px 0; }
    .platform-toolbar input { width:min(300px,100%); }
    .platform-table { overflow:auto; border-top:1px solid var(--border); border-bottom:1px solid var(--border); }
    .platform-table table { min-width:620px; }
    .platform button.command,.platform-dialog button.command { display:inline-flex; align-items:center; gap:8px; padding:8px 12px; border:1px solid var(--border); border-radius:6px; font-size:.9rem; }
    .platform button.primary,.platform-dialog button.primary { background:var(--accent); color:var(--on-accent); border-color:transparent; }
    .platform-link { text-align:left; color:var(--accent); text-decoration:underline; text-underline-offset:3px; }
    .shard-chip { display:inline-flex; margin:3px; padding:4px 8px; border:1px solid var(--border); border-radius:4px; font:12px monospace; }
    .shard-chip.replica { border-style:dashed; } .shard-chip.unavailable { color:var(--error); border-color:var(--error); }
    .platform-empty { padding:48px 20px; text-align:center; color:var(--muted); }
    .platform-dialog { width:min(720px,calc(100vw - 32px)); max-height:85vh; margin:auto; padding:0; background:var(--app); color:var(--text); border:1px solid var(--border); border-radius:8px; box-shadow:0 20px 80px #0003; }
    .platform-dialog::backdrop { background:#0005; }
    .platform-dialog-head { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:20px 24px; border-bottom:1px solid var(--border); }
    .platform-dialog-head h2 { font-size:1.15rem; font-weight:600; }
    .platform-dialog-content { padding:24px; overflow:auto; }
    .platform-dialog pre { padding:16px; background:var(--subtle); border-radius:6px; max-height:380px; margin-top:16px; }
    .platform-form { display:grid; gap:18px; } .platform-form label { display:grid; gap:6px; font-size:.9rem; }
    .platform-form footer { display:flex; justify-content:flex-end; gap:10px; border-top:1px solid var(--border); padding-top:18px; }
    .platform-form .two-col { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
    .inline-error { color:var(--error); font-size:.9rem; }
    .detail-pairs { display:grid; grid-template-columns:1fr 1fr; gap:0 24px; }
    .detail-pairs div { padding:12px 0; border-bottom:1px solid var(--border); overflow-wrap:anywhere; }
    .detail-pairs dt { color:var(--muted); font-size:.8rem; margin-bottom:4px; }
    .model-session { padding:14px 20px; border-bottom:1px solid var(--border); font-size:12px; }
    .model-session select { width:100%; margin:8px 0; } .model-session p { font-size:11px; color:var(--muted); }
    .platform-toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%); padding:12px 20px; border:1px solid var(--border); border-radius:6px; background:var(--app); color:var(--text); z-index:100; box-shadow:0 4px 24px #0002; max-width:calc(100vw - 32px); }
    @media(max-width:1000px) { .overview-grid { grid-template-columns:1fr; } .platform-content { padding:24px; } }
    @media(max-width:760px) { .platform { grid-template-columns:1fr; } .platform-nav { display:flex; overflow:auto; border-right:0; border-bottom:1px solid var(--border); padding:8px; } .platform-nav button { width:auto; white-space:nowrap; } .nav-caption,.platform-nav .cluster-label { display:none; } .metric-band { grid-template-columns:repeat(2,minmax(0,1fr)); } .metric { padding:16px !important; } .platform-content { padding:20px 16px; } .platform-form .two-col,.detail-pairs { grid-template-columns:1fr; } }
  `;
  document.head.append(style);
  const root = document.createElement("div");
  root.id = "platform";
  root.className = "platform";
  root.innerHTML = `<nav class="platform-nav"></nav><main class="platform-content"></main>`;
  document.querySelector("header").after(root);
  const configurationWindow=document.createElement("section");
  configurationWindow.className="configuration-window";
  configurationWindow.hidden=true;
  configurationWindow.innerHTML=`<div class="configuration-titlebar"><strong id="configuration-title"></strong><button class="icon-button" id="configuration-close">${icon("x")}</button></div>`;
  configurationWindow.setAttribute("aria-labelledby","configuration-title");
  configurationWindow.append(root);
  page.querySelector(".settings-content").append(configurationWindow);
  const windowStyle=document.createElement("style");
  windowStyle.textContent=`
    .configuration-window { width:100%; min-width:0; }
    .configuration-titlebar,.configuration-window .platform-nav { display:none; }
    .configuration-window .platform { display:block; min-height:0; }
    .configuration-window .platform-content { padding:0; min-width:0; }
    .settings-content:has(.configuration-window:not([hidden])) { max-width:1280px; margin:0 auto; }
    .settings-nav button[data-settings-key][aria-current="page"] { background:var(--subtle); color:var(--accent); }
  `;
  document.head.append(windowStyle);
  const dialog = document.createElement("dialog");
  dialog.className = "platform-dialog";
  document.body.append(dialog);
  const toast = document.createElement("div");
  toast.className = "platform-toast";
  toast.hidden = true;
  toast.setAttribute("role","status");
  document.body.append(toast);
  let toastTimer;
  function notify(key) {
    toast.textContent = text(key); toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(()=>{toast.hidden = true;},3500);
  }
  function persist() {
    try {
      localStorage.setItem("escope-models",JSON.stringify(models));
      localStorage.setItem("escope-connections",JSON.stringify(profiles));
      localStorage.setItem("escope-model-choice",chosenModel);
      return true;
    } catch { notify("storageFailure"); return false; }
  }
  const badge = status => `<span class="status-badge status-${status}">${text(status)}</span>`;
  const meter = (value,danger = false) => `<div class="meter ${danger ? "danger":""}"><div class="meter-track"><span style="width:${value}%"></span></div><em>${value}%</em></div>`;
  function table(headers,rows) {
    return `<div class="platform-table"><table><thead><tr>${headers.map(header=>`<th>${text(header)}</th>`).join("")}</tr></thead><tbody>${rows.length ? rows.join("") : `<tr><td colspan="${headers.length}"><div class="platform-empty">${text("empty")}</div></td></tr>`}</tbody></table></div>`;
  }
  function title(action = "") {
    const active=activeConnection();
    return `<div class="platform-head"><div><h1 tabindex="-1" id="platform-heading">${text(current)}</h1><p class="platform-subtitle">${escape(active.name)} / ${text(active.environment)}</p></div>${action}</div>`;
  }
  function toolbar(hasStatus = false) {
    return `<div class="platform-toolbar"><input id="resource-filter" type="search" value="${escape(filter)}" placeholder="${text("filter")}" aria-label="${text("filter")}">${hasStatus ? `<select id="resource-status" aria-label="${text("status")}">${["all","healthy","yellow"].map(value=>`<option value="${value}" ${statusFilter===value?"selected":""}>${text(value)}</option>`).join("")}</select>`:""}<button class="icon-button" data-action="clear" aria-label="${text("resetFilters")}" title="${text("resetFilters")}">${icon("filter-x")}</button></div>`;
  }
  function overview() {
    return title(`<span class="status-badge status-yellow">${text("demo")}</span>`) +
      `<div class="metric-band">${[
        [text("health"),"Yellow",`4 ${text("primary")} · 3 ${text("replica")}`],
        [text("nodes"),"3",`2 ${text("data")} · 1 master`],
        [text("documents"),new Intl.NumberFormat(state.locale).format(1062970),`3 ${text("indices")}`],
        [text("storage"),"15.3 GB",`8.45 GB ${text("primary")}`]
      ].map(([label,value,note])=>`<div class="metric"><div class="metric-label">${label}</div><div class="metric-value">${value}</div><div class="metric-note">${note}</div></div>`).join("")}</div>
      <div class="overview-grid"><section><h2>${text("diagnostics")}</h2>
        <div class="health-row">${icon("triangle-alert")}<div class="flex-1"><strong>${text("yellow")}</strong><p>${text("healthNote")}</p></div><button class="icon-button" data-action="diagnose" aria-label="${text("inspect")}">${icon("arrow-up-right")}</button></div>
        <div class="health-row">${icon("hard-drive")}<div><strong>data-02 · 93%</strong><p>${text("diskIssue")}</p></div></div>
        <div class="health-row">${icon("shield-check")}<div><strong>${text("primary")} · 4 / 4</strong><p>${text("readOnlyOps")}</p></div></div>
      </section><section><h2>${text("disk")}</h2>${nodes.map(node=>`<div class="node-meter"><div class="flex justify-between"><button class="platform-link" data-node="${node.name}">${node.name}</button><span class="text-muted text-xs">${node.storage}</span></div>${meter(node.disk,node.disk>90)}</div>`).join("")}</section></div>
      <p class="platform-subtitle mt-8">${text("sampled")}</p>`;
  }
  function nodePage() {
    return title() + toolbar() + `<div id="resource-results">${nodeTable()}</div>`;
  }
  function nodeTable() {
    return table(["name","role","cpu","heap","disk","actions"],nodes.filter(node=>node.name.includes(filter.toLowerCase())).map(node=>
      `<tr><td><button class="platform-link" data-node="${node.name}">${node.name}</button></td><td>${text(node.role)}</td><td>${meter(node.cpu)}</td><td>${meter(node.heap)}</td><td>${meter(node.disk,node.disk>90)}</td><td><button class="icon-button" data-node="${node.name}" aria-label="${text("details")} ${node.name}">${icon("arrow-up-right")}</button></td></tr>`));
  }
  function indexTable() {
    return table(["name","health","documents","storage","primary","replica","actions"],indices.filter(index=>index.name.includes(filter.toLowerCase()) && (statusFilter==="all" || index.health===statusFilter)).map(index=>
      `<tr><td><button class="platform-link" data-index="${index.name}">${index.name}</button></td><td>${badge(index.health)}</td><td>${new Intl.NumberFormat(state.locale).format(index.docs)}</td><td>${index.bytes}</td><td>${index.primary}</td><td>${index.replica}</td><td><button class="icon-button" data-index="${index.name}" aria-label="${text("details")} ${index.name}">${icon("arrow-up-right")}</button></td></tr>`));
  }
  function shardTable() {
    const visible = shards.filter(shard=>`${shard.index} ${shard.node}`.includes(filter.toLowerCase()));
    if(shardView==="list") return table(["index","node","primary","status","size"],visible.map(shard=>`<tr><td>${shard.index}</td><td>${shard.node==="unassigned"?text("unavailable"):shard.node}</td><td><button class="platform-link" data-shard="${shards.indexOf(shard)}">${shard.type==="primary"?"P":"R"}${shard.id}</button></td><td>${badge(shard.status==="allocated"?"healthy":"unavailable")}</td><td>${shard.size}</td></tr>`));
    const visibleIndices = indices.filter(index=>visible.some(shard=>shard.index===index.name));
    if(!visibleIndices.length) return `<div class="platform-empty">${text("empty")}</div>`;
    return table(["node",...visibleIndices.map(index=>index.name)],["unassigned","data-01","data-02"].map(node=>`<tr><td>${node==="unassigned"?text("unavailable"):node}</td>${visibleIndices.map(index=>`<td>${visible.filter(shard=>shard.node===node&&shard.index===index.name).map(shard=>`<button class="shard-chip ${shard.type} ${shard.status}" data-shard="${shards.indexOf(shard)}" title="${text(shard.type)} ${shard.id} · ${text(shard.status)}">${shard.type==="primary"?"P":"R"}${shard.id}</button>`).join("") || "—"}</td>`).join("")}</tr>`));
  }
  function modelsPage() {
    return title(`<button class="command primary" data-action="add-model">${icon("plus")}${text("addModel")}</button>`) +
      `<p class="text-muted mb-6">${text("modelHint")}</p>` +
      (!models.length ? `<div class="platform-empty"><h2>${text("noModels")}</h2><p>${text("addFirst")}</p></div>` :
        table(["name","protocol","modelId","status","actions"],models.map(model=>`<tr><td>${escape(model.name)}<div class="text-muted text-xs">${escape(model.endpoint)}</div></td><td>${escape(model.protocol)}</td><td><code>${escape(model.model)}</code></td><td>${text("registryOnly")}</td><td><div class="flex gap-2"><button class="command ${chosenModel===model.id?"primary":""}" data-select-model="${escape(model.id)}">${text(chosenModel===model.id?"selected":"select")}</button><button class="icon-button" data-remove-model="${escape(model.id)}" aria-label="${text("remove")} ${escape(model.name)}">${icon("trash-2")}</button></div></td></tr>`))) +
      `<p class="platform-subtitle mt-6">${text("modelNote")}</p>`;
  }
  function connectionsPage() {
    return title(`<button class="command primary" data-action="add-connection">${icon("plus")}${text("addConnection")}</button>`) +
      `<p class="text-muted mb-6">${text("connectionHint")}</p>` +
      table(["connectionName","endpoint","environment","status","actions"],[
        ...availableConnections().map(profile=>`<tr><td>${escape(profile.name)}</td><td>${escape(profile.endpoint)}</td><td>${text(profile.environment)}</td><td>${text(profile.id===demoProfile.id?"demo":"draft")}</td><td><div class="flex gap-2"><button class="command" data-select-connection="${escape(profile.id)}">${text(selectedConnection===profile.id?"selected":"select")}</button>${profile.id===demoProfile.id?"":`<button class="icon-button" data-rename-profile="${escape(profile.id)}" aria-label="${text("rename")} ${escape(profile.name)}">${icon("pencil")}</button><button class="icon-button" data-remove-profile="${escape(profile.id)}" aria-label="${text("remove")} ${escape(profile.name)}">${icon("trash-2")}</button>`}</div></td></tr>`)
      ]);
  }
  function renderPlatform(focus = false) {
    syncConnection();
    root.querySelector("nav").setAttribute("aria-label",text("resource"));
    root.querySelector("nav").innerHTML = `<div class="cluster-label px-3 pb-4"><div class="font-semibold">Commerce <span class="text-xs text-muted">DEV</span></div><div class="text-xs text-muted mt-1">${text("demo")}</div></div>` +
      [["tools",["connections","models"]],["resource",["overview","nodes","shards","indices"]]].map(([group,items])=>`<div class="nav-caption">${text(group)}</div>${items.map(item=>`<button data-route="${item}" ${current===item?'aria-current="page"':""}>${icon(pageTitles[item])}${text(item)}</button>`).join("")}`).join("");
    document.getElementById("configuration-title").textContent=text(current);
    document.getElementById("configuration-close").setAttribute("aria-label",text("close"));
    const content = root.querySelector("main");
    if(current==="overview") content.innerHTML = overview();
    if(current==="nodes") content.innerHTML = nodePage();
    if(current==="indices") content.innerHTML = title()+toolbar(true)+`<div id="resource-results">${indexTable()}</div><p class="platform-subtitle mt-5">${text("readOnlyOps")}</p>`;
    if(current==="shards") content.innerHTML = title(`<div class="segment">${["matrix","list"].map(view=>`<button data-shard-view="${view}" aria-pressed="${shardView===view}">${text(view)}</button>`).join("")}</div>`)+toolbar()+`<div id="resource-results">${shardTable()}</div>`;
    if(current==="models") content.innerHTML = modelsPage();
    if(current==="connections") content.innerHTML = connectionsPage();
    if(activeConnection().id!==demoProfile.id && ["overview","nodes","shards","indices"].includes(current)) {
      content.innerHTML=title()+`<div class="platform-empty">${text("disconnected")}</div>`;
    }
    const input = document.getElementById("resource-filter");
    input?.addEventListener("input",event=>{filter=event.target.value; updateResources();});
    document.getElementById("resource-status")?.addEventListener("change",event=>{statusFilter=event.target.value;updateResources();});
    if(window.lucide) lucide.createIcons();
    if(focus) document.getElementById("platform-heading")?.focus();
    renderModelSelector();
  }
  function updateResources() {
    const results = document.getElementById("resource-results");
    if(results) results.innerHTML = current==="nodes"?nodeTable():current==="indices"?indexTable():shardTable();
    if(window.lucide) lucide.createIcons();
  }
  function navigate(route) {
    current = route; filter="";statusFilter="all";
    if(route==="query") {
      configurationWindow.hidden=true;
      root.hidden=true;
      return;
    }
    openSettings("appearance");
    page.querySelectorAll("[data-section]").forEach(section=>{section.hidden=true;});
    document.getElementById("settings-heading").hidden=true;
    page.querySelectorAll("[aria-current]").forEach(element=>element.removeAttribute("aria-current"));
    page.querySelector(`[data-settings-key="platform_${route}"]`)?.setAttribute("aria-current","page");
    configurationWindow.hidden=false;
    root.hidden=false;
    renderPlatform(true);
  }
  let returnFocus;
  function showDialog(heading,body) {
    if(!dialog.open) returnFocus=document.activeElement;
    dialog.innerHTML=`<div class="platform-dialog-head"><h2 id="detail-heading">${escape(heading)}</h2><button class="icon-button" data-close aria-label="${text("close")}">${icon("x")}</button></div><div class="platform-dialog-content">${body}</div>`;
    dialog.setAttribute("aria-labelledby","detail-heading");
    dialog.querySelector("[data-close]").addEventListener("click",()=>dialog.close());
    if(!dialog.open) dialog.showModal();
    if(window.lucide) lucide.createIcons();
  }
  dialog.addEventListener("close",()=>{
    if(returnFocus?.isConnected) returnFocus.focus();
    else document.getElementById("platform-heading")?.focus();
  });
  function diagnose() {
    showDialog(text("healthDetails"),`<p>${text("mockExplain")}</p><h3 class="mt-6 font-semibold">${text("source")}</h3><pre>${escape(JSON.stringify({index:"orders-2026.09",shard:1,primary:false,current_state:"unassigned",can_allocate:"no",node_decisions:[{node_name:"data-01",decider:"same_shard",decision:"NO"},{node_name:"data-02",decider:"disk_threshold",decision:"NO",disk_used_percent:93}]},null,2))}</pre><h3 class="mt-6 font-semibold">${text("recommendation")}</h3><p class="mt-2 text-muted leading-7">${text("diskAdvice")}</p>`);
  }
  function showNode(name) {
    const node=nodes.find(item=>item.name===name);
    showDialog(node.name,`<dl class="detail-pairs">${[["role",text(node.role)],["cpu",node.cpu+"%"],["heap",node.heap+"%"],["disk",node.storage],["Elasticsearch",node.version],["status",text(node.disk>90?"warning":"healthy")]].map(([key,value])=>`<div><dt>${text(key)}</dt><dd>${value}</dd></div>`).join("")}</dl><p class="platform-subtitle mt-6">${text("sampled")}</p>${node.disk>90?`<button class="command mt-4" data-action="diagnose">${icon("stethoscope")}${text("explanation")}</button>`:""}`);
  }
  function showIndex(name,tab="summary") {
    const index=indices.find(item=>item.name===name);
    const content=tab==="summary"?`<dl class="detail-pairs">${[["health",text(index.health)],["documents",index.docs],["storage",index.bytes],["primary",index.primary],["replica",index.replica]].map(([key,value])=>`<div><dt>${text(key)}</dt><dd>${value}</dd></div>`).join("")}</dl>`:
      `<pre>${escape(JSON.stringify(tab==="mappings"?{properties:Object.fromEntries(Object.entries(index.fields).map(([field,type])=>[field,{type}]))}:{index:{number_of_shards:index.primary,number_of_replicas:index.replica}},null,2))}</pre>`;
    showDialog(name,`<div class="segment">${["summary","mappings","settingsTab"].map(item=>`<button data-index-tab="${item}" data-index-name="${name}" aria-pressed="${tab===item}">${text(item)}</button>`).join("")}</div>${content}<p class="platform-subtitle mt-6">${text("readOnlyOps")}</p>`);
  }
  function validEndpoint(value) {
    try {const url=new URL(value);return ["http:","https:"].includes(url.protocol)&&url.hostname&&!url.username&&!url.password&&!url.search&&!url.hash;} catch{return false;}
  }
  function addProfile(kind) {
    const isModel=kind==="model";
    showDialog(text(isModel?"addModel":"addConnection"),`<form class="platform-form">
      <p class="text-muted text-sm">${text(isModel?"modelHint":"connectionHint")}</p>
      <label>${text(isModel?"modelName":"connectionName")}<input name="name" required maxlength="100" autocomplete="off"></label>
      ${isModel?`<div class="two-col"><label>${text("protocol")}<select name="protocol">${protocols.map(protocol=>`<option>${protocol}</option>`).join("")}</select></label><label>${text("modelId")}<input name="model" required maxlength="200" autocomplete="off"></label></div>`:
        `<div class="two-col"><label>${text("environment")}<select name="environment">${["development","staging","production"].map(environment=>`<option value="${environment}">${text(environment)}</option>`).join("")}</select></label><label>${text("auth")}<select name="auth">${["noAuth","basic","API Key","Bearer"].map(auth=>`<option value="${auth}">${text(auth)}</option>`).join("")}</select></label></div>`}
      <label>${text("endpoint")}<input name="endpoint" type="url" required placeholder="${isModel?"http://localhost:11434":"https://es.example.com:9200"}" autocomplete="off"></label>
      <p class="text-xs text-muted">${text("unsafeURL")}</p>
      ${isModel?"":`<p class="text-xs text-muted">${text("advanced")}</p>`}
      <p id="profile-error" class="inline-error" role="alert" hidden></p>
      <footer><button type="button" class="command" data-close-form>${text("cancel")}</button><button type="submit" class="command primary">${text("save")}</button></footer>
    </form>`);
    const form=dialog.querySelector("form");
    form.querySelector("[data-close-form]").addEventListener("click",()=>dialog.close());
    form.addEventListener("submit",event=>{
      event.preventDefault();
      const data=Object.fromEntries(new FormData(form));
      for(const key of Object.keys(data)) data[key]=data[key].trim();
      if(!data.name || (isModel&&!data.model) || !validEndpoint(data.endpoint)) {
        const error=form.querySelector("#profile-error");error.textContent=text("modelRequired")+" "+text("unsafeURL");error.hidden=false;return;
      }
      data.id=crypto.randomUUID();
      if(isModel) {models.push(data);if(!chosenModel)chosenModel=data.id;}
      else profiles.push(data);
      const saved=persist();
      dialog.close();renderPlatform();
      if(saved)notify("saved");
    });
    form.querySelector("input").focus();
  }
  function confirmRemoval(kind,id) {
    showDialog(text("remove"),`<p>${text(kind==="model"?"deleteModel":"deleteConnection")}</p><div class="flex justify-end gap-3 mt-6"><button class="command" data-cancel-remove>${text("cancel")}</button><button class="command" id="confirm-remove">${text("remove")}</button></div>`);
    dialog.querySelector("[data-cancel-remove]").addEventListener("click",()=>dialog.close());
    dialog.querySelector("#confirm-remove").addEventListener("click",()=>{
      if(kind==="model") {models=models.filter(model=>model.id!==id);if(chosenModel===id)chosenModel="";}
      else profiles=profiles.filter(profile=>profile.id!==id);
      persist();dialog.close();renderPlatform();
    });
  }
  function renameProfile(id) {
    const profile=profiles.find(item=>item.id===id);
    if(!profile)return;
    showDialog(text("rename"),`<form class="platform-form"><label>${text("connectionName")}<input name="name" required maxlength="100" value="${escape(profile.name)}"></label><footer><button type="submit" class="command primary">${text("save")}</button></footer></form>`);
    const form=dialog.querySelector("form");
    form.addEventListener("submit",event=>{
      event.preventDefault();
      const input=form.querySelector("input");
      const name=input.value.trim();
      if(!name){input.setCustomValidity(text("connectionName"));input.reportValidity();return;}
      profile.name=name;persist();dialog.close();renderPlatform();
    });
    form.querySelector("input").addEventListener("input",event=>event.target.setCustomValidity(""));
  }
  const selector=document.createElement("div");
  selector.className="model-session";
  document.querySelector(".assistant").children[0].after(selector);
  function renderModelSelector() {
    selector.innerHTML=`<label for="session-model">${text("modelSelected")}</label><select id="session-model"><option value="">${text("none")}</option>${models.map(model=>`<option value="${escape(model.id)}" ${chosenModel===model.id?"selected":""}>${escape(model.protocol+" / "+model.name)}</option>`).join("")}</select><div class="flex justify-between"><button class="platform-link" data-action="models">${text("configure")}</button><span class="text-muted">${text("registryOnly")}</span></div><p class="mt-2">${text("modelNote")}</p>`;
    selector.querySelector("select").addEventListener("change",event=>{chosenModel=event.target.value;persist();});
  }
  function handleClick(event) {
    const target=event.target.closest("button");
    if(!target)return;
    if(target.dataset.route)navigate(target.dataset.route);
    if(target.dataset.node)showNode(target.dataset.node);
    if(target.dataset.index)showIndex(target.dataset.index);
    if(target.dataset.indexTab)showIndex(target.dataset.indexName,target.dataset.indexTab);
    if(target.dataset.shard!==undefined) {
      const shard=shards[Number(target.dataset.shard)];
      if(shard.status==="unavailable")diagnose();
      else showDialog(`${shard.index} · ${shard.type==="primary"?"P":"R"}${shard.id}`,`<pre>${escape(JSON.stringify(shard,null,2))}</pre><p class="platform-subtitle mt-6">${text("sampled")}</p>`);
    }
    if(target.dataset.shardView){shardView=target.dataset.shardView;renderPlatform();}
    if(target.dataset.selectModel){chosenModel=target.dataset.selectModel;persist();renderPlatform();}
    if(target.dataset.removeModel)confirmRemoval("model",target.dataset.removeModel);
    if(target.dataset.removeProfile)confirmRemoval("connection",target.dataset.removeProfile);
    if(target.dataset.renameProfile)renameProfile(target.dataset.renameProfile);
    if(target.dataset.selectConnection)selectConnection(target.dataset.selectConnection);
    const action=target.dataset.action;
    if(action==="diagnose")diagnose();
    if(action==="add-model")addProfile("model");
    if(action==="add-connection")addProfile("connection");
    if(action==="clear"){filter="";statusFilter="all";renderPlatform();document.getElementById("resource-filter")?.focus();}
    if(action==="models" || action==="overview")navigate(action);
  }
  root.addEventListener("click",handleClick);
  dialog.addEventListener("click",handleClick);
  selector.addEventListener("click",handleClick);
  window.addEventListener("escope:settings",()=>{
    configurationWindow.hidden=true;root.hidden=true;
    document.getElementById("settings-heading").hidden=false;
    page.querySelectorAll("[data-settings-key]").forEach(element=>element.removeAttribute("aria-current"));
  });
  window.addEventListener("escope:workspace",()=>{navigate("query");});
  document.getElementById("locale").addEventListener("change",()=>{renderPlatform();});
  window.platformActions=()=>Object.keys(pageTitles).filter(route=>route!=="query").map(route=>({label:`platform_${route}`,run:()=>navigate(route)}));
  for(const route of ["connections","models","overview","nodes","shards","indices"]) {
    const entry=document.createElement("button");
    entry.dataset.settingsKey=`platform_${route}`;
    entry.innerHTML=`${icon(pageTitles[route])}<span data-i18n="platform_${route}"></span>`;
    entry.addEventListener("click",()=>navigate(route));
    document.getElementById("settings-nav-items").append(entry);
  }
  render();
  renderPlatform();
  navigate("query");
})();
