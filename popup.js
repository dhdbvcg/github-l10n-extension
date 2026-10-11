/* popup.js — 开关 + 翻译来源配置 + 缓存管理 */

const toggle     = document.getElementById('toggle');
const titleCheck = document.getElementById('translate-title');
const mtToggle   = document.getElementById('mt-toggle');
const mtAuto     = document.getElementById('mt-auto');
const clearBtn   = document.getElementById('mt-clear');
const clearTip   = document.getElementById('mt-clear-tip');

chrome.storage.local.get({ enabled: true, translateTitle: true, mtEnabled: true, mtAutoButton: true }, (r) => {
  toggle.checked = r.enabled;
  titleCheck.checked = r.translateTitle;
  mtToggle.checked = r.mtEnabled;
  mtAuto.checked = r.mtAutoButton;
});

toggle.addEventListener('change', () => chrome.storage.local.set({ enabled: toggle.checked }));
titleCheck.addEventListener('change', () => chrome.storage.local.set({ translateTitle: titleCheck.checked }));
mtToggle.addEventListener('change', () => chrome.storage.local.set({ mtEnabled: mtToggle.checked }));
mtAuto.addEventListener('change', () => chrome.storage.local.set({ mtAutoButton: mtAuto.checked }));

clearBtn.addEventListener('click', () => {
  chrome.storage.local.remove('mtCache', () => {
    clearTip.textContent = '已清除，刷新 GitHub 页面后重新翻译';
    setTimeout(() => { clearTip.textContent = ''; }, 2500);
  });
});

/* 打开独立设置页 */
document.getElementById('open-options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

/* =========================== 翻译来源配置 =========================== */
const providerSel = document.getElementById('mt-provider');
const keyInput    = document.getElementById('ms-key');
const regionInput = document.getElementById('ms-region');
const baseInput   = document.getElementById('onnmt-base');
const modelInput  = document.getElementById('onnmt-model');
const badge       = document.getElementById('onnmt-badge');
const msgEl       = document.getElementById('onnmt-msg');
const testBtn     = document.getElementById('onnmt-test');
const saveBtn     = document.getElementById('onnmt-save');

function send(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (r) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(r);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

function setBadge(cls, text, title) {
  badge.className = 'badge ' + cls;
  badge.textContent = text;
  if (title) badge.title = title;
}

/* 读取当前配置（优先 background 运行时值，回退 storage） */
(async function initCfg() {
  const cfg = await send({ type: 'ghl10n-mt-config' });
  chrome.storage.local.get(
    { mtProvider: 'auto', msKey: '', msRegion: '', onmtBase: 'http://127.0.0.1:8848', onmtModelId: 0 },
    (r) => {
      providerSel.value = (cfg && cfg.provider) || r.mtProvider || 'auto';
      keyInput.value    = r.msKey || '';
      regionInput.value = r.msRegion || '';
      baseInput.value   = (cfg && cfg.base) || r.onmtBase || 'http://127.0.0.1:8848';
      modelInput.value  = (cfg && cfg.modelId != null) ? cfg.modelId : (r.onmtModelId || 0);
    }
  );

  if (cfg && cfg.hasKey) setBadge('s-ok', '已配置', '已填微软 API 密钥，将优先使用官方 API');
  else if (cfg && cfg.hasToken) setBadge('s-ok', '令牌已捕获', '微软网页翻译令牌有效（约 30 分钟）');
  else setBadge('s-wait', '待测试', '默认使用 MyMemory（免密钥），点「测试」验证');
})();

function collect() {
  return {
    provider: providerSel.value,
    msKey: keyInput.value.trim(),
    msRegion: regionInput.value.trim(),
    base: baseInput.value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8848',
    modelId: Number(modelInput.value || 0),
  };
}

/* 申请自定义地址的跨域权限（仅当地址不是本机时才申请） */
async function ensureHostPermission(url) {
  try {
    const u = new URL(url);
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u.origin)) return true;
    const origin = u.origin + '/*';
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch (e) {
    return false;
  }
}

saveBtn.addEventListener('click', async () => {
  const cfg = collect();
  saveBtn.disabled = true;
  const ok = await ensureHostPermission(cfg.base);
  if (!ok) {
    msgEl.textContent = '未获得该地址的访问权限，跨域请求会被浏览器拦截（配置已保存）。';
  }
  const r = await send({ type: 'ghl10n-mt-set-config', ...cfg });
  saveBtn.disabled = false;
  if (r && r.ok) {
    setBadge('s-wait', '已保存', '');
    msgEl.textContent = ok ? '已保存，点「测试」验证' : '已保存配置（权限未授予）';
  } else {
    msgEl.textContent = '保存失败：扩展后台未响应';
  }
});

/* 测试：真实翻译一句 */
testBtn.addEventListener('click', async () => {
  testBtn.disabled = true;
  testBtn.textContent = '测试中…';
  setBadge('s-wait', '测试中', '');

  const cfg = collect();
  const saved = await send({ type: 'ghl10n-mt-set-config', ...cfg });
  if (!saved || !saved.ok) {
    setBadge('s-bad', '后台无响应', '');
    msgEl.textContent = '扩展后台未响应，尝试刷新扩展';
    testBtn.disabled = false;
    testBtn.textContent = '测试';
    return;
  }

  msgEl.textContent = '正在试译…';
  const t = await send({ type: 'ghl10n-mt', text: 'Hello world' });
  if (t && t.ok) {
    setBadge('s-ok', '可用', t.engine || '');
    msgEl.textContent = '译文：' + String(t.text).slice(0, 40) + '　（来源：' + (t.engine || '') + '）';
  } else {
    const err = (t && t.error) || '未知原因';
    if (/额度|配额/.test(err)) {
      setBadge('s-cool', '额度用尽', err);
      msgEl.textContent = err + '：MyMemory 匿名额度约 5000 字符/天，次日恢复；或改用「微软官方 API」填入密钥。';
    } else if (/令牌/.test(err)) {
      setBadge('s-wait', '缺令牌', err);
      msgEl.textContent = err + '：微软网页翻译需在设置页完成授权，或改用「微软官方 API」并填入密钥。';
    } else if (/本机服务|本地服务|无法连接/.test(err)) {
      setBadge('s-bad', '本机服务未启动', err);
      msgEl.textContent = err;
    } else {
      setBadge('s-cool', '翻译失败', err);
      msgEl.textContent = '翻译失败：' + err;
    }
  }
  testBtn.disabled = false;
  testBtn.textContent = '测试';
});
