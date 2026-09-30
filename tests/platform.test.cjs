const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

function setup(initial = {}, options = {}) {
  const html = fs.readFileSync(path.join(__dirname,"../docs/theme-preview.html"),"utf8");
  const dom = new JSDOM(html,{url:"https://prototype.test/",runScripts:"outside-only",pretendToBeVisual:true});
  const {window}=dom;
  const mediaListeners=[];
  const media={matches:false,addEventListener(type,listener){mediaListeners.push(listener);}};
  window.matchMedia=()=>media;
  if(options.mac) Object.defineProperty(window.navigator,"platform",{value:"MacIntel"});
  window.HTMLElement.prototype.scrollIntoView=function(){};
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;this.dispatchEvent(new window.Event("close"));};
  for(const [key,value] of Object.entries(initial)) window.localStorage.setItem(key,value);
  const context=dom.getInternalVMContext();
  for(const script of window.document.querySelectorAll("script")) {
    const source=script.getAttribute("src");
    if(source?.includes("assets/"))continue;
    const code=source ? fs.readFileSync(path.join(__dirname,"../docs",source),"utf8") : script.textContent;
    vm.runInContext(code,context,{filename:source||"inline.js"});
  }
  const document=window.document;
  const click=selector=>{
    const element=document.querySelector(selector);
    assert.ok(element,`Missing ${selector}`);
    element.click();
    return element;
  };
  const change=(selector,value,event="change")=>{
    const element=document.querySelector(selector);
    assert.ok(element,`Missing ${selector}`);
    element.value=value;element.dispatchEvent(new window.Event(event,{bubbles:true}));
  };
  return {dom,window,document,click,change,setSystemDark(value){
    media.matches=value;mediaListeners.forEach(listener=>listener({matches:value}));
  }};
}

test("overview, node details, allocation explanation and resource filters",()=>{
  const app=setup();
  try {
    assert.equal(app.document.getElementById("workspace").hidden,false);
    app.click("#open-settings");
    app.click('[data-settings-key="platform_overview"]');
    assert.equal(app.document.getElementById("workspace").hidden,true);
    assert.match(app.document.getElementById("platform-heading").textContent,/集群概览/);
    app.click('[data-action="diagnose"]');
    assert.match(app.document.querySelector(".platform-dialog pre").textContent,/disk_threshold/);
    app.click("[data-close]");
    app.click('[data-route="nodes"]');
    app.change("#resource-filter","data-02","input");
    assert.equal(app.document.querySelectorAll("#resource-results tbody tr").length,1);
    app.click('#resource-results [data-node="data-02"]');
    assert.match(app.document.querySelector(".platform-dialog").textContent,/930/);
    app.click("[data-close]");
    app.click('[data-route="indices"]');
    app.change("#resource-status","yellow");
    assert.equal(app.document.querySelectorAll("#resource-results tbody tr").length,1);
    app.click('[data-index="orders-2026.09"]');
    app.click('[data-index-tab="mappings"]');
    assert.match(app.document.querySelector(".platform-dialog pre").textContent,/"keyword"/);
    app.click("[data-close]");
    app.click('[data-route="shards"]');
    app.click('[data-shard-view="list"]');
    assert.equal(app.document.querySelectorAll("#resource-results tbody tr").length,8);
  } finally {app.dom.window.close();}
});

test("models are explicit metadata; selection persists and unsafe endpoints are rejected",()=>{
  const app=setup();
  try {
    app.click('[data-route="models"]');
    app.click('[data-action="add-model"]');
    app.change('[name="name"]',"<img src=x onerror=alert(1)>");
    app.change('[name="model"]',"my-private-model");
    app.change('[name="endpoint"]',"https://user:secret@example.com");
    app.document.querySelector(".platform-form").dispatchEvent(new app.window.Event("submit",{cancelable:true}));
    assert.equal(app.document.getElementById("profile-error").hidden,false);
    app.change('[name="endpoint"]',"http://localhost:11434");
    app.document.querySelector(".platform-form").dispatchEvent(new app.window.Event("submit",{cancelable:true}));
    const models=JSON.parse(app.window.localStorage.getItem("escope-models"));
    assert.equal(models.length,1);
    assert.equal(models[0].model,"my-private-model");
    assert.equal(app.document.querySelectorAll("#platform img").length,0);
    assert.equal(app.document.getElementById("session-model").value,models[0].id);
    app.click("[data-remove-model]");
    app.click("#confirm-remove");
    assert.equal(app.document.getElementById("session-model").value,"");
  } finally {app.dom.window.close();}
});

test("settings hide platform; typography, language and shortcuts remain functional",()=>{
  const app=setup();
  try {
    app.click("#open-settings");
    assert.equal(app.document.getElementById("platform").hidden,true);
    assert.ok(app.document.getElementById("appearance").closest(".settings-page"));
    app.click('[data-section-link="typography"]');
    app.change("#pref-uiSize","18");
    assert.equal(app.document.documentElement.style.getPropertyValue("--ui-size"),"18px");
    app.change("#pref-uiSize","99");
    assert.equal(app.document.getElementById("pref-uiSize").value,"18");
    app.click('[data-section-link="general"]');
    app.change("#locale","en-US");
    assert.equal(app.document.documentElement.lang,"en-US");
    app.window.document.dispatchEvent(new app.window.KeyboardEvent("keydown",{key:"p",ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
    assert.equal(app.document.querySelector(".palette").open,true);
    app.change("#palette-search","Nodes","input");
    app.click(".palette-item");
    assert.equal(app.document.getElementById("platform-heading").textContent,"Nodes");
    assert.equal(app.document.querySelector(".settings-page").hidden,false);
    assert.equal(app.document.getElementById("platform").hidden,false);
    assert.equal(app.document.querySelector(".configuration-window").hidden,false);
  } finally {app.dom.window.close();}
});

test("connection drafts never replace demo data or save credentials",()=>{
  const app=setup({"escope-models":"not json"});
  try {
    app.click('[data-route="connections"]');
    app.click('[data-action="add-connection"]');
    app.change('[name="name"]',"Production");
    app.change('[name="environment"]',"production");
    app.change('[name="auth"]',"basic");
    app.change('[name="endpoint"]',"https://es.example.com:9200");
    app.document.querySelector("form").dispatchEvent(new app.window.Event("submit",{cancelable:true}));
    const profiles=JSON.parse(app.window.localStorage.getItem("escope-connections"));
    assert.equal(profiles[0].environment,"production");
    assert.equal(Object.hasOwn(profiles[0],"password"),false);
    assert.match(app.document.querySelector("#platform main").textContent,/配置草稿/);
    app.click('[data-route="overview"]');
    assert.match(app.document.querySelector("#platform main").textContent,/Production.*未连接/);
  } finally {app.dom.window.close();}
});

test("workspace connection restores selection, renames by ID and falls back after removal",()=>{
  const profiles=[
    {id:"es-a",name:"Development",endpoint:"https://dev.example.com",environment:"development",auth:"basic"},
    {id:"es-b",name:"Production",endpoint:"https://prod.example.com",environment:"production",auth:"API Key"}
  ];
  const app=setup({"escope-connections":JSON.stringify(profiles),"escope-active-connection":"es-b"});
  try {
    assert.equal(app.document.getElementById("workspace-connection").value,"es-b");
    assert.equal(app.document.querySelector("#workspace main > section").hidden,true);
    app.change("#workspace-connection","es-a");
    assert.equal(app.window.localStorage.getItem("escope-active-connection"),"es-a");
    app.click("#open-settings");
    app.click('[data-settings-key="platform_connections"]');
    app.click('[data-rename-profile="es-a"]');
    app.change('[name="name"]',"Renamed development");
    app.document.querySelector(".platform-form").dispatchEvent(new app.window.Event("submit",{cancelable:true}));
    assert.equal(app.document.getElementById("workspace-connection").value,"es-a");
    assert.match(app.document.getElementById("workspace-connection").textContent,/Renamed development/);
    app.click('[data-select-connection="es-b"]');
    assert.equal(app.window.localStorage.getItem("escope-active-connection"),"es-b");
    app.click('[data-remove-profile="es-b"]');
    app.click("#confirm-remove");
    assert.equal(app.document.getElementById("workspace-connection"),null);
    assert.equal(app.window.localStorage.getItem("escope-active-connection"),"es-a");
  } finally {app.dom.window.close();}
  const fallback=setup({"escope-connections":JSON.stringify(profiles),"escope-active-connection":"deleted"});
  try {assert.equal(fallback.document.getElementById("workspace-connection").value,"es-a");}
  finally {fallback.dom.window.close();}
});

test("general preferences format results without rerunning and restore startup options",()=>{
  const app=setup();
  try {
    app.change("#query-amount","2000","input");app.click("#query-run");
    const raw=app.document.getElementById("json-view").textContent;
    app.click("#open-settings");app.click('[data-section-link="general"]');
    app.change("#general-timeZone","UTC");
    app.change("#general-dateFormat","datetime");
    const grouping=app.document.getElementById("general-groupNumbers");
    grouping.checked=false;grouping.dispatchEvent(new app.window.Event("change"));
    assert.equal(app.document.getElementById("json-view").textContent,raw);
    assert.equal(app.document.querySelectorAll("#rows tr").length,2);
    assert.equal(app.document.querySelector("#rows td:nth-child(3)").textContent,"2450.00");
    assert.match(app.document.querySelector("#rows td:nth-child(5)").textContent,/2026/);
    assert.equal(app.document.querySelector('[data-i18n="timezone"]').textContent,"UTC");
    app.change("#general-resultView","json");
    const ai=app.document.getElementById("general-startAI");
    ai.checked=true;ai.dispatchEvent(new app.window.Event("change"));
    assert.equal(app.document.getElementById("toggle-ai").getAttribute("aria-pressed"),"false");
    const next=setup({"escope-general":app.window.localStorage.getItem("escope-general")});
    try {
      assert.equal(next.document.getElementById("json-view").hidden,false);
      assert.equal(next.document.getElementById("toggle-ai").getAttribute("aria-pressed"),"true");
    } finally {next.dom.window.close();}
    app.click('[data-i18n="resetGeneral"]');
    assert.equal(app.document.getElementById("general-timeZone").value,"Asia/Shanghai");
    assert.equal(app.document.querySelectorAll("#rows tr").length,2);
    assert.equal(app.window.getComputedStyle(app.document.querySelector(".settings-content")).marginTop,"0px");
  } finally {app.dom.window.close();}
});

test("settings visual groups preserve controls and do not nest groups",()=>{
  const app=setup();
  try {
    app.click("#open-settings");
    assert.equal(app.document.querySelectorAll(".settings-nav-group").length,3);
    assert.ok(app.document.querySelector(".settings-search-shell #settings-search"));
    assert.equal(app.document.querySelectorAll(".settings-row-group .settings-row-group").length,0);
    assert.equal(app.document.querySelectorAll('[data-section="general"] .settings-row-group').length,2);
    for(const id of ["locale","general-timeZone","general-startAI","pref-uiSize","pref-font"]) {
      assert.ok(app.document.getElementById(id).closest(".settings-row-group"),id);
    }
    assert.ok(app.document.querySelector('link[href="./settings-design.css"]'));
    app.change("#locale","en-US");
    assert.equal(app.document.querySelector(".settings-nav-title").textContent,"Settings");
    assert.equal(app.document.querySelector(".settings-nav-group").textContent,"Personal");
  } finally {app.dom.window.close();}
});

test("settings search has a single compact surface without inherited input padding",()=>{
  const app=setup();
  try {
    const css=app.document.createElement("style");
    css.textContent=fs.readFileSync(path.join(__dirname,"../docs/settings-design.css"),"utf8");
    app.document.head.append(css);
    const input=app.window.getComputedStyle(app.document.getElementById("settings-search"));
    const shell=app.window.getComputedStyle(app.document.querySelector(".settings-search-shell"));
    assert.equal(input.marginTop,"0px");
    assert.equal(input.marginBottom,"0px");
    assert.equal(input.paddingTop,"0px");
    assert.equal(input.paddingLeft,"0px");
    assert.equal(input.backgroundColor,"rgba(0, 0, 0, 0)");
    assert.equal(shell.height,"34px");
    app.click("#open-settings");
    app.change("#settings-search","font","input");
    assert.equal(app.document.querySelector('[data-section-link="typography"]').hidden,false);
  } finally {app.dom.window.close();}
});

test("corrupt preferences recover and theme follows system only when selected",()=>{
  const app=setup({"escope-appearance":"null","escope-type":"null","escope-models":"{}"});
  try {
    assert.ok(app.document.getElementById("query-run"));
    app.setSystemDark(true);
    assert.equal(app.document.documentElement.dataset.theme,"dark");
    app.click("#open-settings");
    app.click('[data-choose-mode="light"]');
    app.setSystemDark(false);app.setSystemDark(true);
    assert.equal(app.document.documentElement.dataset.theme,"light");
  } finally {app.dom.window.close();}
});

test("all appearance and locale combinations preserve query content and persist",()=>{
  const app=setup();
  try {
    app.click('[data-mode="dsl"]');app.click('[data-view="json"]');
    const query=app.document.getElementById("dsl-query").textContent;
    const result=app.document.getElementById("json-view").textContent;
    app.click("#open-settings");
    for(const locale of ["zh-CN","en-US"]) for(const mode of ["light","dark"]) for(const accent of ["graphite","jade","blue","violet"]) {
      app.change("#locale",locale);
      app.click(`[data-choose-mode="${mode}"]`);
      app.click(`button[data-accent="${accent}"]`);
      assert.equal(app.document.documentElement.dataset.theme,mode);
      assert.equal(app.document.documentElement.dataset.accent,accent);
      assert.equal(app.document.getElementById("dsl-query").textContent,query);
      assert.equal(app.document.getElementById("json-view").textContent,result);
      assert.equal(JSON.parse(app.window.localStorage.getItem("escope-appearance")).locale,locale);
    }
    app.click("#settings-back");
    assert.equal(app.document.getElementById("dsl-query").hidden,false);
    assert.equal(app.document.getElementById("json-view").hidden,false);
  } finally {app.dom.window.close();}
});

test("modal shortcuts do not navigate away and details restore focus",()=>{
  const app=setup();
  try {
    app.click('[data-route="indices"]');
    const opener=app.document.querySelector('[data-index="orders-2026.09"]');
    opener.focus();opener.click();
    app.click('[data-index-tab="settingsTab"]');
    app.document.dispatchEvent(new app.window.KeyboardEvent("keydown",{key:",",ctrlKey:true,bubbles:true,cancelable:true}));
    assert.equal(app.document.querySelector(".settings-page").hidden,false);
    app.document.dispatchEvent(new app.window.KeyboardEvent("keydown",{key:"p",ctrlKey:true,bubbles:true,cancelable:true}));
    assert.equal(app.document.querySelector(".palette").open,false);
    app.click("[data-close]");
    assert.equal(app.document.activeElement,opener);
  } finally {app.dom.window.close();}
});

test("management renders inside settings right pane and preserves query results",()=>{
  const app=setup();
  try {
    app.change("#query-amount","2000","input");
    app.click("#query-run");
    app.click("#open-settings");
    const opener=app.document.querySelector('[data-settings-key="platform_connections"]');
    opener.focus();opener.click();
    assert.equal(app.document.querySelector(".settings-page").hidden,false);
    assert.equal(app.document.querySelector(".configuration-window").hidden,false);
    assert.ok(app.document.querySelector(".settings-content .configuration-window"));
    assert.equal(app.document.querySelector("dialog.configuration-window"),null);
    app.click('[data-route="nodes"]');
    assert.equal(app.document.querySelector(".settings-page").hidden,false);
    assert.equal(app.document.querySelector('.configuration-window [data-route="query"]'),null);
    app.click('[data-section-link="appearance"]');
    assert.equal(app.document.querySelector(".configuration-window").hidden,true);
    assert.equal(app.document.getElementById("settings-heading").hidden,false);
    assert.equal(app.document.querySelector(".settings-page").hidden,false);
    app.click("#settings-back");
    assert.equal(app.document.getElementById("workspace").hidden,false);
    assert.equal(app.document.querySelectorAll("#rows tr").length,2);
    app.click("#open-quick");
    app.change("#palette-search","nodes","input");
    app.click(".palette-item");
    assert.equal(app.document.getElementById("workspace").hidden,true);
    app.click("#settings-back");
    assert.equal(app.document.querySelectorAll("#rows tr").length,2);
  } finally {app.dom.window.close();}
});

test("palette handles no matches, keyboard selection, IME and macOS modifiers",()=>{
  const app=setup({}, {mac:true});
  try {
    app.document.dispatchEvent(new app.window.KeyboardEvent("keydown",{key:"p",metaKey:true,isComposing:true,bubbles:true}));
    assert.equal(app.document.querySelector(".palette").open,false);
    app.document.dispatchEvent(new app.window.KeyboardEvent("keydown",{key:"p",metaKey:true,bubbles:true,cancelable:true}));
    assert.equal(app.document.querySelector(".palette").open,true);
    app.change("#palette-search","no-such-resource","input");
    assert.equal(app.document.querySelectorAll(".palette-item").length,0);
    assert.equal(app.document.getElementById("palette-search").hasAttribute("aria-activedescendant"),false);
    app.change("#palette-search","nodes","input");
    app.document.getElementById("palette-search").dispatchEvent(new app.window.KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
    assert.match(app.document.getElementById("platform-heading").textContent,/节点/);
  } finally {app.dom.window.close();}
});

test("settings search includes models and typography reset is scoped",()=>{
  const app=setup();
  try {
    app.click("#open-settings");
    app.change("#settings-search","font","input");
    assert.equal(app.document.querySelector('[data-settings-key="platform_models"]').hidden,true);
    app.change("#settings-search","模型","input");
    assert.equal(app.document.querySelector('[data-settings-key="platform_models"]').hidden,false);
    app.change("#settings-search","","input");
    app.click('[data-choose-mode="dark"]');
    app.click('[data-section-link="typography"]');
    app.change("#pref-codeSize","20");
    app.change("#pref-density","compact");
    app.click("#type-settings .settings-reset");
    assert.equal(app.document.documentElement.style.getPropertyValue("--code-size"),"13px");
    assert.equal(app.document.documentElement.dataset.theme,"dark");
  } finally {app.dom.window.close();}
});

test("query is home; local filters execute, survive settings, and handle empty results",()=>{
  const app=setup();
  try {
    assert.equal(app.document.getElementById("workspace").hidden,false);
    assert.equal(app.document.getElementById("platform").hidden,true);
    assert.equal(app.document.getElementById("toggle-ai").getAttribute("aria-pressed"),"false");
    app.change("#query-amount","2000","input");
    assert.equal(app.document.querySelectorAll("#rows tr").length,6);
    app.click("#query-run");
    assert.equal(app.document.querySelectorAll("#rows tr").length,2);
    app.click("#open-settings");
    app.change("#locale","en-US");
    app.click("#settings-back");
    assert.equal(app.document.querySelectorAll("#rows tr").length,2);
    assert.equal(app.document.getElementById("query-amount").value,"2000");
    app.change("#query-amount","99999","input");
    app.click("#query-run");
    assert.match(app.document.getElementById("rows").textContent,/No matching/);
    app.click("#query-reset");
    assert.equal(app.document.querySelectorAll("#rows tr").length,6);
  } finally {app.dom.window.close();}
});

test("saved model selection is restored and removal cancellation preserves data",()=>{
  const profile={id:"local-1",name:"Local",model:"my-model",protocol:"Ollama",endpoint:"http://localhost:11434"};
  const app=setup({"escope-models":JSON.stringify([profile]),"escope-model-choice":"local-1"});
  try {
    assert.equal(app.document.getElementById("session-model").value,"local-1");
    app.click('[data-route="models"]');
    app.click("[data-remove-model]");
    app.click("[data-cancel-remove]");
    assert.equal(JSON.parse(app.window.localStorage.getItem("escope-models")).length,1);
  } finally {app.dom.window.close();}
});
