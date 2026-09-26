/* popup.js — 控制开关状态，存入 chrome.storage.local */
const toggle     = document.getElementById('toggle');
const titleCheck = document.getElementById('translate-title');
const mtToggle   = document.getElementById('mt-toggle');

chrome.storage.local.get({ enabled: true, translateTitle: true, mtEnabled: true }, (r) => {
  toggle.checked = r.enabled;
  titleCheck.checked = r.translateTitle;
  mtToggle.checked = r.mtEnabled;
});

toggle.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: toggle.checked });
});
titleCheck.addEventListener('change', () => {
  chrome.storage.local.set({ translateTitle: titleCheck.checked });
});
mtToggle.addEventListener('change', () => {
  chrome.storage.local.set({ mtEnabled: mtToggle.checked });
});
