/* popup.js — 控制开关状态，存入 chrome.storage.local */
const toggle     = document.getElementById('toggle');
const titleCheck = document.getElementById('translate-title');

chrome.storage.local.get({ enabled: true, translateTitle: true }, (r) => {
  toggle.checked = r.enabled;
  titleCheck.checked = r.translateTitle;
});

toggle.addEventListener('change', () => {
  chrome.storage.local.set({ enabled: toggle.checked });
});
titleCheck.addEventListener('change', () => {
  chrome.storage.local.set({ translateTitle: titleCheck.checked });
});
