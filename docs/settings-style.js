Object.assign(messages["zh-CN"], {
  settingsPersonal:"个人",settingsIntegration:"集成",settingsResources:"集群资源",
  settingsTypeGroup:"字体与排版",settingsKeyboardGroup:"应用快捷键",settingsStyleGroup:"主题与强调色"
});
Object.assign(messages["en-US"], {
  settingsPersonal:"Personal",settingsIntegration:"Integrations",settingsResources:"Cluster resources",
  settingsTypeGroup:"Fonts & typography",settingsKeyboardGroup:"Application shortcuts",settingsStyleGroup:"Theme & accent"
});
const settingsStyleLink=document.createElement("link");
settingsStyleLink.rel="stylesheet";
settingsStyleLink.href="./settings-design.css";
document.head.append(settingsStyleLink);

const settingsNavigation=document.querySelector(".settings-nav");
const settingsNavTitle=document.createElement("h2");
settingsNavTitle.className="settings-nav-title";
settingsNavTitle.dataset.i18n="settings";
settingsNavigation.prepend(settingsNavTitle);

const searchInput=document.getElementById("settings-search");
const searchShell=document.createElement("div");
searchShell.className="settings-search-shell";
searchShell.innerHTML='<i data-lucide="search" class="icon" aria-hidden="true"></i>';
searchInput.before(searchShell);
searchShell.append(searchInput);

const navigationList=document.getElementById("settings-nav-items");
[
  ["settingsPersonal","[data-section-link='general']"],
  ["settingsIntegration","[data-settings-key='platform_connections']"],
  ["settingsResources","[data-settings-key='platform_overview']"]
].forEach(([key,selector])=>{
  const caption=document.createElement("div");
  caption.className="settings-nav-group";
  caption.dataset.i18n=key;
  navigationList.querySelector(selector)?.before(caption);
});

function groupSettingRows(section) {
  let group=null;
  [...section.children].forEach(child=>{
    if(child.classList.contains("setting-row")) {
      if(!group) {
        group=document.createElement("div");
        group.className="settings-row-group";
        child.before(group);
      }
      group.append(child);
    } else group=null;
  });
}
page.querySelectorAll("[data-section]").forEach(groupSettingRows);
const typeHeading=document.createElement("h2");
typeHeading.dataset.i18n="settingsTypeGroup";
document.getElementById("type-settings").prepend(typeHeading);
const keyboardHeading=document.createElement("h2");
keyboardHeading.dataset.i18n="settingsKeyboardGroup";
document.getElementById("keyboard-settings").querySelector(".settings-row-group").before(keyboardHeading);
page.querySelector('[data-section="appearance"] h2').dataset.i18n="settingsStyleGroup";

const settingsOpenOriginal=openSettings;
openSettings=function(section="appearance") {
  settingsOpenOriginal(section);
  page.querySelector(".settings-content").scrollTop=0;
  page.scrollTop=0;
};
render();
refreshSettings();
if(window.lucide)lucide.createIcons();
