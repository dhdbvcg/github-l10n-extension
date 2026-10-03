/* popup.js — 开关 + OpenNMT 服务配置 + 缓存管理 */

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

/* =========================== OpenNMT 服务 =========================== */
const baseInput  = document.getElementById('onnmt-base');
const protoSelect= document.getElementById('onnmt-proto');
const modelInput = document.getElementById('onnmt-model');
const badge      = document.getElementById('onnmt-badge');
const msgEl      = document.getElementById('onnmt-msg');
const testBtn    = document.getElementById('onnmt-test');
const saveBtn    = document.getElementById('onnmt-save');

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

/* 读取当前配置（优先从 background 拿运行时值，回退到 storage） */
(async function initCfg() {
  const cfg = await send({ type: 'ghl10n-mt-config' });
  chrome.storage.local.get(
    { onmtBase: 'http://127.0.0.1:8848', onmtModelId: 0, onmtProto: 'auto' },
    (r) => {
      baseInput.value  = (cfg && cfg.base) || r.onmtBase || 'http://127.0.0.1:8848';
      modelInput.value = (cfg && cfg.modelId != null) ? cfg.modelId : (r.onmtModelId || 0);
      protoSelect.value = (cfg && cfg.protoPref) || r.onmtProto || 'auto';
    }
  );

  if (cfg && cfg.reachable === true) {
    setBadge('s-ok', '已连接', (cfg.proto === 'onnmt' ? 'OpenNMT-py' : '本机翻译服务'));
  } else if (cfg && cfg.reachable === false) {
    setBadge('s-bad', '未连接', cfg.lastError || '');
  } else {
    setBadge('s-wait', '未检测', '点「测试连接」检测服务');
  }
  if (cfg && cfg.lastError) msgEl.textContent = cfg.lastError;
})();

function collect() {
  return {
    base: baseInput.value.trim().replace(/\/+$/, '') || 'http://127.0.0.1:8848',
    modelId: Number(modelInput.value || 0),
    proto: protoSelect.value,
  };
}

/* 申请自定义地址的跨域权限（仅当地址不是默认本机时才申请） */
async function ensureHostPermission(url) {
  try {
    const u = new URL(url);
    const origin = u.origin + '/*';
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(u.origin)) return true;
    const granted = await chrome.permissions.contains({ origins: [origin] });
    if (granted) return true;
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
    msgEl.textContent = '未获得该地址的访问权限，跨域请求会被浏览器拦截。已保存配置，但仍需授权。';
  }

  const r = await send({ type: 'ghl10n-mt-set-config', ...cfg });
  saveBtn.disabled = false;
  if (r && r.ok) {
    setBadge('s-wait', '未检测', '');
    msgEl.textContent = ok
      ? '已保存，点「测试连接」验证服务'
      : '已保存配置（权限未授予）';
  } else {
    msgEl.textContent = '保存失败：扩展后台未响应';
  }
});

/* 测试连接：先健康检查，再发一条真实短句 */
testBtn.addEventListener('click', async () => {
  testBtn.disabled = true;
  testBtn.textContent = '检测中…';
  setBadge('s-wait', '检测中', '');

  const cfg = collect();
  // 检测时用输入框里的值（可能尚未保存）
  const saved = await send({ type: 'ghl10n-mt-set-config', ...cfg });
  if (!saved || !saved.ok) {
    setBadge('s-bad', '后台无响应', '');
    msgEl.textContent = '扩展后台未响应，尝试刷新扩展';
    testBtn.disabled = false;
    testBtn.textContent = '测试连接';
    return;
  }

  const health = await send({ type: 'ghl10n-mt-reprobe' });
  if (!health || !health.ok || !health.reachable) {
    setBadge('s-bad', '未连接', '');
    msgEl.textContent = (health && health.lastError) || '无法连接 OpenNMT 服务。请确认已启动 onmt_server 且地址正确。';
    testBtn.disabled = false;
    testBtn.textContent = '测试连接';
    return;
  }

  // 健康检查通过 → 实际翻译一句，验证模型可用
  msgEl.textContent = '服务在线，正在试译…';
  const t = await send({ type: 'ghl10n-mt', text: 'Hello world' });
  if (t && t.ok) {
    setBadge('s-ok', '已连接', (t.engine || '').indexOf('OpenNMT') === 0 ? 'OpenNMT-py' : '本机翻译服务');
    msgEl.textContent = '译文：' + String(t.text).slice(0, 40);
  } else {
    setBadge('s-cool', '服务在但翻译失败', '');
    msgEl.textContent = '健康检查通过，但翻译失败：' + ((t && t.error) || '未知原因')
      + '（CPU 推理可能较慢，稍后重试或调小单次文本量）';
  }
  testBtn.disabled = false;
  testBtn.textContent = '测试连接';
});
