const preferenceDefaults = { uiSize:14, codeSize:13, tableSize:13, font:"system", codeFont:"system", density:"comfortable" };
const generalDefaults={timeZone:"Asia/Shanghai",dateFormat:"time",groupNumbers:true,startAI:false,resultView:"table",wrapJSON:false};
let generalPreferences={...generalDefaults};
try {
  const stored=JSON.parse(localStorage.getItem("escope-general")||"{}");
  if(stored && typeof stored==="object") {
    for(const key of ["groupNumbers","startAI","wrapJSON"]) if(typeof stored[key]==="boolean") generalPreferences[key]=stored[key];
    for(const [key,allowed] of Object.entries({timeZone:["system","Asia/Shanghai","UTC"],dateFormat:["time","datetime"],resultView:["table","json"]})) {
      if(allowed.includes(stored[key]))generalPreferences[key]=stored[key];
    }
  }
} catch {}
let preferences = { ...preferenceDefaults };
try {
  const stored = JSON.parse(localStorage.getItem("escope-type") || "{}");
  for (const key of ["uiSize", "codeSize", "tableSize"]) {
    if (Number.isInteger(stored[key]) && stored[key] >= 12 && stored[key] <= 20) preferences[key] = stored[key];
  }
  if (["system","sans","serif"].includes(stored.font)) preferences.font = stored.font;
  if (["system","consolas","menlo"].includes(stored.codeFont)) preferences.codeFont = stored.codeFont;
  if (["comfortable","compact"].includes(stored.density)) preferences.density = stored.density;
} catch {}

Object.assign(messages["zh-CN"], {
  settings:"设置", back:"返回工作台", general:"常规", typography:"字体与密度", keyboard:"键盘快捷键",
  searchSettings:"搜索设置", quickOpen:"快速跳转", commands:"命令面板", searchCommands:"搜索命令或页面",
  uiSize:"界面字号", codeSize:"代码字号", tableSize:"表格字号", font:"界面字体", codeFont:"代码字体",
  density:"显示密度", comfortable:"舒适", compact:"紧凑", reset:"恢复排版默认值",
  noMatches:"没有匹配结果", fontSystem:"系统默认", sans:"无衬线", serif:"衬线",
  generalTitle:"常规", keyboardTitle:"键盘快捷键", openAppearance:"打开外观设置", openGeneral:"打开常规设置",
  openTypography:"打开字体设置", openKeyboard:"打开快捷键设置", showTable:"切换到表格", showJSON:"切换到 JSON",
  showDSL:"切换到 DSL", showVisual:"切换到可视化", changeTheme:"切换日间 / 夜间", close:"关闭",
  visualStyle:"视觉风格", typePreview:"预览", shortcutsNote:"macOS 使用 ⌘；Windows / Linux 使用 Ctrl。"
});
Object.assign(messages["en-US"], {
  settings:"Settings", back:"Back to workspace", general:"General", typography:"Typography & density", keyboard:"Keyboard shortcuts",
  searchSettings:"Search settings", quickOpen:"Quick open", commands:"Command palette", searchCommands:"Search commands or pages",
  uiSize:"Interface font size", codeSize:"Code font size", tableSize:"Table font size", font:"Interface font", codeFont:"Code font",
  density:"Display density", comfortable:"Comfortable", compact:"Compact", reset:"Reset typography",
  noMatches:"No matching results", fontSystem:"System default", sans:"Sans serif", serif:"Serif",
  generalTitle:"General", keyboardTitle:"Keyboard shortcuts", openAppearance:"Open appearance settings", openGeneral:"Open general settings",
  openTypography:"Open typography settings", openKeyboard:"Open keyboard shortcuts", showTable:"Switch to table", showJSON:"Switch to JSON",
  showDSL:"Switch to DSL", showVisual:"Switch to visual", changeTheme:"Toggle light / dark", close:"Close",
  visualStyle:"Visual style", typePreview:"Preview", shortcutsNote:"Use ⌘ on macOS; Ctrl on Windows / Linux."
});
Object.assign(messages["zh-CN"],{
  regional:"语言与格式",startupQuery:"启动与查询",displayTimeZone:"显示时区",dateFormat:"日期格式",
  timeOnly:"仅时间",dateAndTime:"日期与时间",groupNumbers:"数字千分位",startAI:"启动时展开 AI 面板",
  resultView:"启动时结果视图",wrapJSON:"JSON 自动换行",resetGeneral:"恢复常规默认值",
  generalSaveFailed:"无法保存设置，本次会话仍然有效",generalSaved:"已保存",shanghai:"北京时间"
});
Object.assign(messages["en-US"],{
  regional:"Language & formatting",startupQuery:"Startup & query",displayTimeZone:"Display timezone",dateFormat:"Date format",
  timeOnly:"Time only",dateAndTime:"Date and time",groupNumbers:"Number grouping",startAI:"Open AI panel on startup",
  resultView:"Result view on startup",wrapJSON:"Wrap JSON lines",resetGeneral:"Reset general settings",
  generalSaveFailed:"Settings could not be saved; active for this session",generalSaved:"Saved",shanghai:"Beijing time"
});
const style = document.createElement("style");
style.textContent = `
html { font-size:var(--ui-size,14px); }
body { font-size:var(--ui-size,14px); font-family:var(--ui-font); }
.text-xs,.nav-row,.field,.segment button { font-size:.9rem; }
.text-sm { font-size:1rem; }
.text-base { font-size:1.08rem; }
.text-lg { font-size:1.3rem; }
pre,code { font-family:var(--code-font); font-size:var(--code-size,13px); }
table { font-size:var(--table-size,13px); }
th,td { padding:var(--cell-padding,13px) 16px; }
.settings-page { display:grid; grid-template-columns:240px minmax(0,1fr); min-height:calc(100vh - 73px); }
.settings-nav { background:var(--sidebar); border-right:1px solid var(--border); padding:24px 16px; }
.settings-nav button { display:flex; align-items:center; gap:10px; width:100%; padding:10px 12px; text-align:left; border-radius:6px; margin:4px 0; }
.settings-nav button[aria-current="page"] { background:var(--subtle); color:var(--accent); }
.settings-content { width:100%; max-width:850px; padding:32px 48px; margin:0 auto; align-self:start; }
.setting-row input[type="checkbox"] { appearance:auto; width:18px; height:18px; accent-color:var(--accent); cursor:pointer; }
.setting-row select { max-width:55%; }
:root[data-wrap-json="true"] pre { white-space:pre-wrap; overflow-wrap:anywhere; }
.settings-content h1 { font-size:1.65rem; font-weight:600; margin:0 0 36px; }
.settings-content h2 { color:var(--muted); font-size:.9rem; margin:28px 0 12px; }
.setting-row { display:flex; justify-content:space-between; align-items:center; gap:24px; padding:18px 0; border-bottom:1px solid var(--border); min-height:68px; }
.setting-row label { flex:1; }
.setting-row input[type="number"] { width:76px; }
input { font:inherit; color:var(--text); background:var(--app); border:1px solid var(--border); padding:8px 10px; border-radius:6px; max-width:100%; }
input:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.setting-search { width:100%; margin:20px 0; }
.mode-control { display:flex; flex-wrap:wrap; gap:8px; }
.mode-control button { display:flex; flex-direction:column; align-items:center; gap:8px; padding:8px; border:1px solid var(--border); border-radius:6px; min-width:82px; font-size:.85rem; }
.mode-control button[aria-pressed="true"] { outline:2px solid var(--accent); outline-offset:2px; }
.mode-thumb { width:64px; height:40px; border:1px solid #777; border-radius:4px; background:linear-gradient(90deg,#eee 25%,#fff 25%); position:relative; }
.mode-thumb:after { content:""; position:absolute; top:10px; left:23px; width:30px; height:2px; background:#999; box-shadow:0 7px #999,0 14px #999; }
[data-choose-mode="dark"] .mode-thumb { background:linear-gradient(90deg,#151618 25%,#282a2e 25%); }
[data-choose-mode="system"] .mode-thumb { background:linear-gradient(90deg,#fff 50%,#222 50%); }
.settings-reset { margin-top:28px; padding:8px 12px; border:1px solid var(--border); border-radius:6px; }
.palette { width:min(620px,calc(100vw - 32px)); max-height:75vh; padding:0; background:var(--app); color:var(--text); border:1px solid var(--border); border-radius:8px; margin:12vh auto auto; box-shadow:0 20px 80px #0003; }
.palette::backdrop { background:#0005; }
.palette-head { display:flex; align-items:center; padding:12px 16px; gap:12px; border-bottom:1px solid var(--border); }
.palette-head input { flex:1; min-width:0; border:0; }
.palette-results { padding:8px; max-height:50vh; overflow:auto; }
.palette-item { width:100%; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px; border-radius:5px; text-align:left; }
.palette-item[aria-selected="true"] { background:var(--subtle); color:var(--accent); }
kbd { font:12px/1.5 monospace; background:var(--subtle); border:1px solid var(--border); border-radius:4px; padding:3px 6px; white-space:nowrap; }
@media(max-width:760px) { .settings-page { grid-template-columns:1fr; } .settings-nav { border-right:0; border-bottom:1px solid var(--border); } .settings-content { padding:28px 20px; } .setting-row { flex-wrap:wrap; gap:12px; } }
`;
document.head.append(style);

const controls = document.querySelector("header .settings");
const modeSelect = document.getElementById("appearance");
const languageControl = document.getElementById("locale").closest("label");
const swatches = controls.querySelector('[role="group"]');
const page = document.createElement("section");
page.className = "settings-page";
page.hidden = true;
page.innerHTML = `
  <nav class="settings-nav" aria-label="Settings">
    <button id="settings-back"><i data-lucide="arrow-left" class="icon"></i><span data-i18n="back"></span></button>
    <input id="settings-search" class="setting-search" type="search" data-label="searchSettings">
    <div id="settings-nav-items"></div>
  </nav>
  <main class="settings-content">
    <h1 id="settings-heading" tabindex="-1"></h1>
    <section data-section="general"><h2 data-i18n="regional"></h2><div id="language-row" class="setting-row"><span data-i18n="language"></span></div></section>
    <section data-section="appearance">
      <h2 data-i18n="visualStyle"></h2>
      <div class="setting-row"><span data-i18n="appearance"></span><div id="mode-control" class="mode-control"></div></div>
      <div id="accent-row" class="setting-row"><span data-i18n="accent"></span></div>
    </section>
    <section data-section="typography" id="type-settings"></section>
    <section data-section="keyboard" id="keyboard-settings"></section>
  </main>`;
document.body.insertBefore(page, document.body.lastElementChild);
document.getElementById("language-row").append(languageControl);
const generalSection=page.querySelector('[data-section="general"]');
const generalFields=[
  ["timeZone","displayTimeZone",[["system","system"],["Asia/Shanghai","shanghai"],["UTC","UTC"]]],
  ["dateFormat","dateFormat",[["time","timeOnly"],["datetime","dateAndTime"]]],
  ["groupNumbers","groupNumbers",null],
  ["startAI","startAI",null],
  ["resultView","resultView",[["table","table"],["json","JSON"]]],
  ["wrapJSON","wrapJSON",null]
];
generalFields.forEach(([key,label,choices])=>{
  if(key==="startAI") {
    const heading=document.createElement("h2");heading.dataset.i18n="startupQuery";generalSection.append(heading);
  }
  const row=document.createElement("div");row.className="setting-row";
  row.innerHTML=`<label for="general-${key}" data-i18n="${label}"></label>`+
    (choices?`<select id="general-${key}">${choices.map(([value,name])=>`<option value="${value}" ${messages["en-US"][name]?`data-i18n="${name}"`:""}>${name}</option>`).join("")}</select>`:
      `<input type="checkbox" id="general-${key}" role="switch">`);
  const control=row.querySelector("input,select");
  if(choices)control.value=generalPreferences[key];else control.checked=generalPreferences[key];
  control.addEventListener("change",()=>{
    generalPreferences[key]=choices?control.value:control.checked;
    applyGeneralPreferences(true);
  });
  generalSection.append(row);
});
const generalReset=document.createElement("button");
generalReset.className="settings-reset";generalReset.dataset.i18n="resetGeneral";
generalReset.addEventListener("click",()=>{
  generalPreferences={...generalDefaults};
  generalFields.forEach(([key,,choices])=>{
    const control=document.getElementById(`general-${key}`);
    if(choices)control.value=generalPreferences[key];else control.checked=generalPreferences[key];
  });
  applyGeneralPreferences(true);
});
generalSection.append(generalReset);
const generalFeedback=document.createElement("p");
generalFeedback.className="mt-3 text-xs text-muted";generalFeedback.setAttribute("role","status");
generalSection.append(generalFeedback);
function applyGeneralPreferences(save=false) {
  document.documentElement.dataset.wrapJson=String(generalPreferences.wrapJSON);
  if(save) {
    try {localStorage.setItem("escope-general",JSON.stringify(generalPreferences));generalFeedback.textContent=messages[state.locale].generalSaved;}
    catch {generalFeedback.textContent=messages[state.locale].generalSaveFailed;}
  }
  window.dispatchEvent(new Event("escope:general"));
}
applyGeneralPreferences();
document.getElementById("accent-row").append(swatches);
modeSelect.hidden = true;
document.getElementById("mode-control").append(modeSelect);
controls.replaceChildren();
for (const [id,icon,label] of [["open-quick","search","quickOpen"],["open-commands","command","commands"],["open-settings","settings","settings"]]) {
  const button = document.createElement("button");
  button.id = id;
  button.className = "icon-button";
  button.dataset.label = label;
  button.innerHTML = `<i data-lucide="${icon}" class="icon"></i>`;
  controls.append(button);
}
const sections = ["general","appearance","typography","keyboard"];
const sectionIcons = ["sliders-horizontal","sun","type","keyboard"];
sections.forEach((section,index) => {
  const button = document.createElement("button");
  button.dataset.sectionLink = section;
  button.innerHTML = `<i data-lucide="${sectionIcons[index]}" class="icon"></i><span data-i18n="${section}"></span>`;
  button.addEventListener("click",() => openSettings(section));
  document.getElementById("settings-nav-items").append(button);
});
["system","light","dark"].forEach(mode => {
  const button = document.createElement("button");
  button.dataset.chooseMode = mode;
  button.innerHTML = `<span class="mode-thumb" aria-hidden="true"></span><span data-i18n="${mode}"></span>`;
  button.addEventListener("click",() => { state.mode = mode; render(); refreshSettings(); });
  document.getElementById("mode-control").append(button);
});
const typeSettings = document.getElementById("type-settings");
for (const key of ["font","codeFont","uiSize","codeSize","tableSize","density"]) {
  const row = document.createElement("div");
  row.className = "setting-row";
  const choices = key === "font" ? [["system","fontSystem"],["sans","sans"],["serif","serif"]] :
    key === "codeFont" ? [["system","fontSystem"],["consolas","Consolas"],["menlo","Menlo"]] :
    key === "density" ? [["comfortable","comfortable"],["compact","compact"]] : null;
  row.innerHTML = `<label for="pref-${key}" data-i18n="${key}"></label>` +
    (choices ? `<select id="pref-${key}">${choices.map(([value,label])=>`<option value="${value}" ${messages["en-US"][label] ? `data-i18n="${label}"` : ""}>${label}</option>`).join("")}</select>` :
      `<div><input id="pref-${key}" type="number" min="12" max="20" step="1"> <span class="text-muted">px</span></div>`);
  const input = row.querySelector("input,select");
  input.value = preferences[key];
  input.addEventListener("change",() => {
    if (choices) preferences[key] = input.value;
    else if (input.checkValidity() && input.value !== "") preferences[key] = Number(input.value);
    input.value = preferences[key];
    applyTypography();
  });
  typeSettings.append(row);
}
const reset = document.createElement("button");
reset.className = "settings-reset";
reset.dataset.i18n = "reset";
reset.addEventListener("click",() => {
  preferences = { ...preferenceDefaults };
  Object.keys(preferences).forEach(key => { document.getElementById(`pref-${key}`).value = preferences[key]; });
  applyTypography();
});
typeSettings.append(reset);
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const modifier = isMac ? "⌘" : "Ctrl";
document.getElementById("keyboard-settings").innerHTML =
  `<p class="text-muted" data-i18n="shortcutsNote"></p>` +
  [["quickOpen",`${modifier}+P`],["commands",`${modifier}+Shift+P`],["settings",`${modifier}+,`],["close","Esc"]]
    .map(([label,shortcut])=>`<div class="setting-row"><span data-i18n="${label}"></span><kbd>${shortcut}</kbd></div>`).join("");

let currentSection = "appearance";
function applyTypography() {
  const root = document.documentElement.style;
  root.setProperty("--ui-size",`${preferences.uiSize}px`);
  root.setProperty("--code-size",`${preferences.codeSize}px`);
  root.setProperty("--table-size",`${preferences.tableSize}px`);
  root.setProperty("--ui-font", {system:'"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',sans:'Arial,"Microsoft YaHei",sans-serif',serif:'Georgia,"Songti SC",serif'}[preferences.font]);
  root.setProperty("--code-font", {system:'"Cascadia Code","SFMono-Regular",Consolas,monospace',consolas:'Consolas,monospace',menlo:'Menlo,monospace'}[preferences.codeFont]);
  root.setProperty("--cell-padding",preferences.density === "compact" ? "8px" : "13px");
  try { localStorage.setItem("escope-type",JSON.stringify(preferences)); } catch {}
}
function refreshSettings() {
  document.getElementById("settings-heading").textContent = messages[state.locale][currentSection];
  document.querySelectorAll("[data-choose-mode]").forEach(button => button.setAttribute("aria-pressed",String(button.dataset.chooseMode === state.mode)));
  document.getElementById("settings-search").placeholder = messages[state.locale].searchSettings;
  page.querySelector("nav").setAttribute("aria-label",messages[state.locale].settings);
  filterSettings();
}
function openSettings(section = "appearance") {
  window.dispatchEvent(new Event("escope:settings"));
  currentSection = section;
  page.hidden = false;
  document.getElementById("workspace").hidden = true;
  page.querySelectorAll("[data-section]").forEach(element => { element.hidden = element.dataset.section !== section; });
  page.querySelectorAll("[data-section-link]").forEach(button => {
    if(button.dataset.sectionLink === section) button.setAttribute("aria-current","page");
    else button.removeAttribute("aria-current");
  });
  refreshSettings();
  document.getElementById("settings-heading").focus();
}
function closeSettings() {
  page.hidden = true;
  document.getElementById("workspace").hidden = false;
  document.getElementById("open-settings").focus();
  window.dispatchEvent(new Event("escope:workspace"));
}
function filterSettings() {
  const query = document.getElementById("settings-search").value.toLowerCase().trim();
  const searchTerms = {general:["general","language","displayTimeZone","dateFormat","groupNumbers","startAI","resultView","wrapJSON"],appearance:["appearance","accent","system","light","dark"],typography:["typography","font","codeFont","uiSize","codeSize","tableSize","density"],keyboard:["keyboard","quickOpen","commands"]};
  page.querySelectorAll("[data-section-link]").forEach(button => {
    button.hidden = !searchTerms[button.dataset.sectionLink].some(key => Object.values(messages).some(locale => (locale[key] || "").toLowerCase().includes(query)));
  });
  page.querySelectorAll("[data-settings-key]").forEach(button => {
    button.hidden = !Object.values(messages).some(locale => (locale[button.dataset.settingsKey] || "").toLowerCase().includes(query));
  });
}
document.getElementById("settings-search").addEventListener("input",filterSettings);
document.getElementById("settings-back").addEventListener("click",closeSettings);
document.getElementById("open-settings").addEventListener("click",() => openSettings());
document.getElementById("locale").addEventListener("change",refreshSettings);

const palette = document.createElement("dialog");
palette.className = "palette";
palette.innerHTML = `<div class="palette-head"><i data-lucide="search" class="icon"></i><input id="palette-search" role="combobox" aria-autocomplete="list" aria-controls="palette-results" aria-expanded="true" autocomplete="off"><button id="palette-close" class="icon-button" data-label="close"><i data-lucide="x" class="icon"></i></button></div><div id="palette-results" class="palette-results" role="listbox"></div>`;
document.body.append(palette);
let paletteMode = "quickOpen";
let activeOption = 0;
let matches = [];
let previousFocus = null;
let restorePaletteFocus = true;
function actions() {
  const targets = [
    {label:"queryName",run:closeSettings},
    ...sections.map(section => ({label:section,run:()=>openSettings(section)}))
  ];
  if(window.platformActions) targets.push(...window.platformActions());
  if(paletteMode === "quickOpen") return targets;
  return [
    ...targets,
    {label:"changeTheme",run:()=>{state.mode = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; render(); refreshSettings();}},
    {label:"toggleAI",run:()=>{closeSettings(); document.getElementById("toggle-ai").click();}},
    ...[["showTable","view","table"],["showJSON","view","json"],["showDSL","mode","dsl"],["showVisual","mode","visual"]].map(([label,type,value]) => ({label,run:()=>{closeSettings(); document.querySelector(`[data-${type}="${value}"]`).click();}}))
  ];
}
function renderPalette() {
  const query = document.getElementById("palette-search").value.trim().toLowerCase().replace(/^>\s*/,"");
  matches = actions().filter(action => Object.values(messages).some(locale => locale[action.label].toLowerCase().includes(query)));
  activeOption = Math.min(activeOption,Math.max(0,matches.length-1));
  const results = document.getElementById("palette-results");
  results.replaceChildren();
  matches.forEach((action,index) => {
    const item = document.createElement("button");
    item.className = "palette-item";
    item.id = `palette-option-${index}`;
    item.setAttribute("role","option");
    item.setAttribute("aria-selected",String(index === activeOption));
    item.tabIndex = -1;
    item.textContent = messages[state.locale][action.label];
    item.addEventListener("click",() => executeAction(action));
    results.append(item);
  });
  const input = document.getElementById("palette-search");
  if(matches.length) input.setAttribute("aria-activedescendant",`palette-option-${activeOption}`);
  else {
    input.removeAttribute("aria-activedescendant");
    const empty = document.createElement("p");
    empty.className = "p-4 text-muted";
    empty.setAttribute("role","status");
    empty.textContent = messages[state.locale].noMatches;
    results.append(empty);
  }
}
function openPalette(mode) {
  paletteMode = mode;
  if(!palette.open) previousFocus = document.activeElement;
  restorePaletteFocus = true;
  const input = document.getElementById("palette-search");
  input.value = "";
  input.placeholder = messages[state.locale][mode];
  input.setAttribute("aria-label",messages[state.locale][mode]);
  palette.setAttribute("aria-label",messages[state.locale][mode]);
  activeOption = 0;
  renderPalette();
  if(!palette.open) palette.showModal();
  input.focus();
}
function executeAction(action) {
  restorePaletteFocus = false;
  palette.close();
  action.run();
  if(palette.contains(document.activeElement) || document.activeElement === document.body) {
    document.getElementById("open-commands").focus();
  }
}
palette.addEventListener("close",() => { if(restorePaletteFocus && previousFocus?.isConnected) previousFocus.focus(); });
document.getElementById("palette-close").addEventListener("click",() => palette.close());
document.getElementById("palette-search").addEventListener("input",() => {activeOption = 0; renderPalette();});
palette.addEventListener("keydown",event => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if(matches.length) activeOption = (activeOption + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length;
    renderPalette();
    document.getElementById(`palette-option-${activeOption}`)?.scrollIntoView({block:"nearest"});
  } else if(event.key === "Enter" && event.target.id === "palette-search") {
    event.preventDefault();
    if(matches[activeOption]) executeAction(matches[activeOption]);
  }
});
document.getElementById("open-quick").addEventListener("click",() => openPalette("quickOpen"));
document.getElementById("open-commands").addEventListener("click",() => openPalette("commands"));
document.addEventListener("keydown",event => {
  if(event.isComposing || event.repeat) return;
  if(document.querySelector("dialog[open]:not(.palette)")) return;
  const primary = isMac ? event.metaKey : event.ctrlKey;
  if(primary && !event.altKey && event.key.toLowerCase() === "p") {
    event.preventDefault();
    openPalette(event.shiftKey ? "commands" : "quickOpen");
  } else if(primary && !event.shiftKey && !event.altKey && event.key === ",") {
    event.preventDefault();
    if(palette.open) { restorePaletteFocus = false; palette.close(); }
    openSettings();
  } else if(event.key === "Escape" && !palette.open && !page.hidden) closeSettings();
},true);
applyTypography();
render();
refreshSettings();
if(window.lucide) lucide.createIcons();
