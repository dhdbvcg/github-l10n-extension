/* options.js — 独立设置页逻辑 */

const $ = (id) => document.getElementById(id);

const fEnabled = $('enabled');
const fTitle   = $('translateTitle');
const fMt      = $('mtEnabled');
const fAuto    = $('mtAutoTranslate');
const fAutoBtn = $('mtAutoButton');
const fClear   = $('mtClear');
const fProv    = $('provider');
const fKey     = $('msKey');
const fRegion  = $('msRegion');
const fBase    = $('base');
const fModel   = $('modelId');
const btnSave  = $('save');
const btnTest  = $('test');
const badge    = $('badge');
const msg      = $('msg');

function send(m) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(m, (r) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(r);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function say(text, cls) {
  msg.textContent = text || '';
  msg.className = 'msg' + (cls ? ' ' + cls : '');
}

function setBadge(cls, text, title) {
  badge.className = 'badge ' + cls;
  badge.textContent = text;
  if (title) badge.title = title;
}

/* 读取并回填 */
(async function load() {
  const cfg = await send({ type: 'ghl10n-mt-config' });
  chrome.storage.local.get({
    enabled: true, translateTitle: true, mtEnabled: true,
    mtAutoTranslate: false, mtAutoButton: true,
    msKey: '', msRegion: '', onmtBase: 'http://127.0.0.1:8848', onmtModelId: 0,
  }, (r) => {
    fEnabled.checked = r.enabled;
    fTitle.checked = r.translateTitle;
    fMt.checked = r.mtEnabled;
    fAuto.checked = r.mtAutoTranslate;
    fAutoBtn.checked = r.mtAutoButton;
    fProv.value = (cfg && cfg.provider) || r.mtProvider || 'auto';
    fKey.value = r.msKey || '';
    fRegion.value = r.msRegion || '';
    fBase.value = (cfg && cfg.base) || r.onmtBase || 'http://127.0.0.1:8848';
    fModel.value = (cfg && cfg.modelId != null) ? cfg.modelId : (r.onmtModelId || 0);
  });

  if (cfg && cfg.hasToken) setBadge('b-ok', '令牌已捕获', '微软网页翻译令牌有效（约 30 分钟）');
  else if (cfg && cfg.hasKey) setBadge('b-wait', '已填密钥', '点「测试翻译」验证');
  else setBadge('b-wait', '待授权', '用微软网页翻译需先点「授权网页翻译」');
})();

/* 开关即时保存 */
[['enabled', fEnabled], ['translateTitle', fTitle], ['mtEnabled', fMt],
 ['mtAutoTranslate', fAuto], ['mtAutoButton', fAutoBtn]].forEach(([key, el]) => {
  el.addEventListener('change', () => {
    const o = { [key]: el.checked };
    chrome.storage.local.set(o, () => say('已保存（刷新 GitHub 页面后生效）', 'saved'));
  });
});

fClear.addEventListener('click', () => {
  chrome.storage.local.remove('mtCache', () => say('译文缓存已清除，刷新 GitHub 页面后重新翻译', 'saved'));
});

btnSave.addEventListener('click', async () => {
  btnSave.disabled = true;
  say('保存中…');
  const cfg = {
    provider: fProv.value,
    msKey: fKey.value.trim(),
    msRegion: fRegion.value.trim(),
    base: fBase.value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8848',
    modelId: Number(fModel.value || 0),
  };
  // 非本机地址需申请权限
  try {
    const u = new URL(cfg.base);
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u.origin)) {
      const origin = u.origin + '/*';
      if (!(await chrome.permissions.contains({ origins: [origin] }))) {
        await chrome.permissions.request({ origins: [origin] });
      }
    }
  } catch (e) { /* 地址无效时交由后台报错 */ }

  const r = await send({ type: 'ghl10n-mt-set-config', ...cfg });
  btnSave.disabled = false;
  say(r && r.ok ? '设置已保存，刷新 GitHub 页面后生效' : '保存失败：扩展后台未响应', r && r.ok ? 'saved' : '');
});

/* 测试翻译 */
btnTest.addEventListener('click', async () => {
  btnTest.disabled = true;
  btnTest.textContent = '测试中…';
  setBadge('b-wait', '测试中', '');
  say('正在试译…');
  const t = await send({ type: 'ghl10n-mt', text: 'Hello world' });
  btnTest.disabled = false;
  btnTest.textContent = '测试翻译';
  if (t && t.ok) {
    setBadge('b-ok', '可用', t.engine || '');
    say('译文：' + String(t.text).slice(0, 40) + '　（来源：' + (t.engine || '') + '）', 'saved');
  } else {
    const err = (t && t.error) || '未知原因';
    if (/额度|配额/.test(err)) {
      setBadge('b-cool', '额度用尽', err);
      say(err + '：MyMemory 匿名额度约 5000 字符/天，次日恢复；或改用「微软官方 API」填入密钥。');
    } else if (/本机服务|本地服务|无法连接/.test(err)) {
      setBadge('b-bad', '本机服务未启动', err);
      say(err);
    } else {
      setBadge('b-bad', '翻译失败', err);
      say('翻译失败：' + err);
    }
  }
});
