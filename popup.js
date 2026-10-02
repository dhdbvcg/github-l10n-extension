/* popup.js — 控制开关、引擎优先级与缓存管理，存入 chrome.storage.local */

/* =========================== 基础开关 =========================== */
const toggle     = document.getElementById('toggle');
const titleCheck = document.getElementById('translate-title');
const mtToggle   = document.getElementById('mt-toggle');
const clearBtn   = document.getElementById('mt-clear');
const tip        = document.getElementById('mt-clear-tip');

chrome.storage.local.get({ enabled: true, translateTitle: true, mtEnabled: true }, (r) => {
  toggle.checked = r.enabled;
  titleCheck.checked = r.translateTitle;
  mtToggle.checked = r.mtEnabled;
});

toggle.addEventListener('change', () => chrome.storage.local.set({ enabled: toggle.checked }));
titleCheck.addEventListener('change', () => chrome.storage.local.set({ translateTitle: titleCheck.checked }));
mtToggle.addEventListener('change', () => chrome.storage.local.set({ mtEnabled: mtToggle.checked }));

clearBtn.addEventListener('click', () => {
  chrome.storage.local.remove('mtCache', () => {
    tip.textContent = '已清除，刷新 GitHub 页面后重新翻译';
    setTimeout(() => { tip.textContent = ''; }, 2500);
  });
});

/* =========================== 引擎优先级 =========================== */
const DEFAULT_ORDER = ['gtx', 'gtx2', 'bing', 'youdao', 'mymemory'];
const engList = document.getElementById('eng-list');
let engines = [];      // [{name,label}]
let order = [];        // 引擎名数组
let health = {};       // { name: {cooling, lastError} }

function sendMessage(msg) {
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

function renderEngines() {
  engList.innerHTML = '';
  order.forEach((name, idx) => {
    const meta = engines.find((e) => e.name === name) || { name, label: name };
    const h = health[name] || {};
    const row = document.createElement('div');
    row.className = 'engine-item';

    const i = document.createElement('span');
    i.className = 'idx';
    i.textContent = String(idx + 1);

    const n = document.createElement('span');
    n.className = 'name';
    n.textContent = meta.label;
    if (h.lastError) n.title = '最近错误：' + h.lastError;

    const st = document.createElement('span');
    st.className = 'state ' + (h.dead ? 'state-dead' : h.cooling ? 'state-cool' : 'state-ok');
    st.textContent = h.dead ? '不可达' : h.cooling ? '冷却' : '就绪';
    st.title = h.lastError ? '最近错误：' + h.lastError : (h.reachable === false ? '网络不可达' : '可用');

    const moves = document.createElement('span');
    moves.className = 'moves';
    const up = document.createElement('button');
    up.textContent = '▲';
    up.title = '上移（更优先）';
    up.disabled = idx === 0;
    up.addEventListener('click', () => moveEngine(idx, -1));
    const down = document.createElement('button');
    down.textContent = '▼';
    down.title = '下移（更靠后）';
    down.disabled = idx === order.length - 1;
    down.addEventListener('click', () => moveEngine(idx, 1));
    moves.appendChild(up);
    moves.appendChild(down);

    row.appendChild(i);
    row.appendChild(n);
    row.appendChild(st);
    row.appendChild(moves);
    engList.appendChild(row);
  });
}

function moveEngine(idx, delta) {
  const next = idx + delta;
  if (next < 0 || next >= order.length) return;
  const tmp = order[idx];
  order[idx] = order[next];
  order[next] = tmp;
  renderEngines();
  saveOrder();
}

let saveTimer = null;
function saveOrder() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    sendMessage({ type: 'ghl10n-mt-set-order', order });
    tip.textContent = '已保存引擎优先级';
    setTimeout(() => { tip.textContent = ''; }, 1800);
  }, 250);
}

document.getElementById('eng-reset').addEventListener('click', () => {
  order = DEFAULT_ORDER.slice();
  renderEngines();
  sendMessage({ type: 'ghl10n-mt-set-order', order: null });
  tip.textContent = '已恢复默认优先级';
  setTimeout(() => { tip.textContent = ''; }, 1800);
});

/* 重新探测各引擎可达性 */
document.getElementById('eng-probe').addEventListener('click', async (ev) => {
  const btn = ev.currentTarget;
  btn.disabled = true;
  btn.textContent = '检测中…';
  const res = await sendMessage({ type: 'ghl10n-mt-reprobe' });
  if (res && res.ok) {
    health = res.engines || {};
    renderEngines();
    const okList = Object.values(health).filter((e) => e.reachable).map((e) => e.label);
    tip.textContent = okList.length ? '可用：' + okList.join('、') : '未检测到可用引擎';
  } else {
    tip.textContent = '检测失败';
  }
  setTimeout(() => { tip.textContent = ''; }, 2600);
  btn.disabled = false;
  btn.textContent = '重测';
});

/* 初始化引擎列表 + 健康度 */
(async function initEngines() {
  const res = await sendMessage({ type: 'ghl10n-mt-engines' });
  if (res && res.ok) {
    engines = res.engines || [];
    const known = new Set(engines.map((e) => e.name));
    order = (res.order || DEFAULT_ORDER).filter((n) => known.has(n));
    for (const n of DEFAULT_ORDER) if (known.has(n) && !order.includes(n)) order.push(n);
  } else {
    // 后台未就绪时用内置清单兜底
    engines = DEFAULT_ORDER.map((n) => ({ name: n, label: n }));
    order = DEFAULT_ORDER.slice();
    chrome.storage.local.get({ engineOrder: null }, (r) => {
      if (Array.isArray(r.engineOrder) && r.engineOrder.length) {
        const known = new Set(engines.map((e) => e.name));
        order = r.engineOrder.filter((n) => known.has(n));
        for (const n of DEFAULT_ORDER) if (known.has(n) && !order.includes(n)) order.push(n);
        renderEngines();
      }
    });
  }

  const hres = await sendMessage({ type: 'ghl10n-mt-health' });
  if (hres && hres.ok) health = hres.engines || {};
  renderEngines();
})();
