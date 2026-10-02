/* background.js — MV3 Service Worker：人机翻译中继
 * 内容脚本受 CORS 限制无法直接调用翻译接口，由后台统一转发。
 *
 * 引擎池（均无需密钥，失败自动回退）：
 *   1. gtx       Google 翻译 translate.googleapis.com（质量最好，需网络可达/代理）
 *   2. gtx2      Google 备用入口 clients5.google.com（主入口不通时）
 *   3. bing      必应网页翻译（token 惰性获取，国内可直连）
 *   4. youdao    有道翻译 translate_o（国内可直连）
 *   5. mymemory  MyMemory 公共 API（保底，最稳定但质量一般）
 *
 * 关键能力：
 *   - 启动连通性探测：懒探测各引擎可达性，不可达的直接降权，
 *     避免"每次翻译都要白等 N 个引擎超时"（实测未探测时回退链耗时 47s）
 *   - 引擎健康度记忆：硬错误/连续失败后冷却 60s，冷却引擎沉到队尾
 *   - 分片并行翻译（限流 3），按索引拼接保证顺序
 *   - 同文本并发去重（inflight）
 *   - 引擎优先级可由用户在弹窗调整（storage: engineOrder）
 *   - ghl10n-mt-health 诊断：查看各引擎可达性、冷却状态与最近错误
 */
'use strict';

const FETCH_TIMEOUT = 15000;
const PROBE_TIMEOUT = 4000;   // 连通性探测超时（短）
const PARALLEL = 3;          // 单引擎内并行分片数
const COOLDOWN_MS = 60000;   // 引擎失败冷却时长
const HARD_FAILS = 3;        // 连续软失败达到该次数进入冷却
const DEAD_MS = 30 * 60000;  // 探测不可达后的跳过时长
const DEFAULT_ORDER = ['gtx', 'gtx2', 'bing', 'youdao', 'mymemory'];

/* =========================== 引擎定义 =========================== */
const ENGINES = {
  gtx: {
    name: 'gtx',
    label: 'Google 翻译',
    max: 1200,
    probe: () => 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=en&tl=zh-CN&q=hi',
    url: (q) => 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=zh-CN&q=' + encodeURIComponent(q),
    parse: (data) => {
      const srcLang = String((data && data[2]) || '').toLowerCase();
      const txt = ((data && data[0]) || []).map((seg) => (seg && seg[0]) || '').join('');
      return { text: txt, srcLang };
    },
    retries: 1,
  },
  gtx2: {
    name: 'gtx2',
    label: 'Google 备用',
    max: 1000,
    probe: () => 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=zh-CN&q=hi',
    url: (q) => 'https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=en&tl=zh-CN&q=' + encodeURIComponent(q),
    parse: (data) => {
      // 返回形态不固定：字符串 / 扁平交替数组 / 嵌套数组 / 更深层嵌套
      // 策略：递归收集所有叶子串，含 CJK 的作为译文；
      //      全无 CJK 时退化为取每对首项，避免把英文原文拼进译文
      if (typeof data === 'string') return { text: data, srcLang: '' };
      if (!Array.isArray(data)) return { text: '', srcLang: '' };

      const leaves = [];
      (function walk(node) {
        if (typeof node === 'string') { leaves.push(node); return; }
        if (Array.isArray(node)) { node.forEach(walk); return; }
      })(data);

      if (!leaves.length) return { text: '', srcLang: '' };
      const cjk = leaves.filter((s) => /[\u4e00-\u9fff]/.test(s));
      if (cjk.length) return { text: cjk.join(''), srcLang: '' };
      const out = [];
      for (let i = 0; i < leaves.length; i += 2) out.push(leaves[i]);
      return { text: out.join(''), srcLang: '' };
    },
    retries: 1,
  },
  bing: {
    name: 'bing',
    label: '必应翻译',
    max: 900,
    probe: () => 'https://www.bing.com/translator',
    build: (q) => ({
      url: 'https://www.bing.com/ttranslatev3?isVertical=1&IG=' + BING_IG + '&IID=translator.5028.1',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          fromLang: 'en', text: q,
          to: 'zh-Hans', token: BING_TOKEN, key: BING_KEY,
        }).toString(),
      },
    }),
    parse: (data) => {
      const txt = ((data && data[0] && data[0].translations) || [])
        .map((t) => (t && t.text) || '').join('');
      return { text: txt, srcLang: '' };
    },
    retries: 0,
  },
  youdao: {
    name: 'youdao',
    label: '有道翻译',
    max: 450,
    probe: () => 'https://fanyi.youdao.com/translate_o?i=hi&type=EN2ZH_CN&doctype=json',
    build: (q) => ({
      url: 'https://fanyi.youdao.com/translate_o',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ i: q, type: 'EN2ZH_CN', doctype: 'json', version: '2.1' }).toString(),
      },
    }),
    parse: (data) => {
      // errorCode 非 0 时说明被风控/需校验，不能当译文
      if (data && data.errorCode) throw new Error('youdao errorCode ' + data.errorCode);
      const groups = (data && data.translateResult) || [];
      const txt = groups.map((g) => (Array.isArray(g) ? (g[0] && g[0].tgt) || '' : '')).join('\n');
      return { text: txt, srcLang: '' };
    },
    retries: 0,
  },
  mymemory: {
    name: 'mymemory',
    label: 'MyMemory',
    max: 450,
    probe: () => 'https://api.mymemory.translated.net/get?q=hi&langpair=en|zh-CN',
    url: (q) => 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=en|zh-CN',
    parse: (data) => {
      const status = data && data.responseStatus;
      const text = String((data && data.responseData && data.responseData.translatedText) || '');
      // MyMemory 出错时常返回 HTTP 200 + 错误文案，必须识别为失败
      if (status != null && Number(status) !== 200) throw new Error('mymemory status ' + status);
      if (/QUERY LENGTH LIMIT|MYMEMORY WARNING|INVALID (SOURCE|TARGET|LANGUAGE)|PLEASE (SELECT|USE) TWO DISTINCT/i.test(text)) {
        throw new Error('mymemory rejected');
      }
      return { text, srcLang: '' };
    },
    retries: 0,
  },
};

/* =========================== 必应令牌（惰性获取） =========================== */
let BING_IG = '';
let BING_TOKEN = '';
let BING_KEY = '';
let bingTokenPromise = null;

async function ensureBingToken() {
  if (BING_TOKEN && BING_KEY) return true;
  if (bingTokenPromise) return bingTokenPromise;
  bingTokenPromise = (async () => {
    try {
      const res = await fetchWithTimeout('https://www.bing.com/translator', undefined, PROBE_TIMEOUT);
      if (!res.ok) return false;
      const html = await res.text();
      const ig = html.match(/IG:"([^"]+)"/);
      const tk = html.match(/params_AbusePreventionHelper\s*=\s*\[?\s*\d+\s*,\s*"([^"]+)"\s*,\s*"(\d+)"/);
      if (ig) BING_IG = ig[1];
      if (tk) { BING_TOKEN = tk[1]; BING_KEY = tk[2]; }
      return !!(BING_TOKEN && BING_KEY);
    } catch (e) {
      return false;
    } finally {
      bingTokenPromise = null;
    }
  })();
  return bingTokenPromise;
}

/* =========================== 引擎可达性 + 健康度 =========================== */
const engineState = new Map(); // name -> { fails, until, lastError, deadUntil, reachable }

function getState(name) {
  let s = engineState.get(name);
  if (!s) {
    s = { fails: 0, until: 0, lastError: '', deadUntil: 0, reachable: null };
    engineState.set(name, s);
  }
  return s;
}

function isCooling(name) {
  const s = engineState.get(name);
  return !!(s && s.until && s.until > Date.now());
}

function isDead(name) {
  const s = engineState.get(name);
  return !!(s && s.deadUntil && s.deadUntil > Date.now());
}

/* 探测结果缓存：同一引擎在 DEAD_MS 内不重复探测 */
const probed = new Map(); // name -> boolean

async function probeEngine(engine) {
  if (!engine.probe) return true;
  if (probed.has(engine.name)) return probed.get(engine.name);
  try {
    const res = await fetchWithTimeout(engine.probe(), undefined, PROBE_TIMEOUT);
    const reachable = res.ok;
    probed.set(engine.name, reachable);
    const s = getState(engine.name);
    s.reachable = reachable;
    if (!reachable) {
      s.deadUntil = Date.now() + DEAD_MS;
      s.lastError = '不可达（网络或被墙）';
    }
    return reachable;
  } catch (e) {
    probed.set(engine.name, false);
    const s = getState(engine.name);
    s.reachable = false;
    s.deadUntil = Date.now() + DEAD_MS;
    s.lastError = '不可达：' + String((e && e.message) || e).slice(0, 60);
    return false;
  }
}

function markFail(name, err, hard) {
  const s = getState(name);
  s.fails += 1;
  s.lastError = String((err && err.message) || err).slice(0, 120);
  if (hard || s.fails >= HARD_FAILS) {
    s.until = Date.now() + COOLDOWN_MS;
    s.fails = 0;
  }
  // 连续硬失败 ≥ 3 次视为不可达，跳过更久
  if (hard) {
    s.hardFails = (s.hardFails || 0) + 1;
    if (s.hardFails >= 3) { s.deadUntil = Date.now() + DEAD_MS; s.hardFails = 0; }
  } else {
    s.hardFails = 0;
  }
}

function markOk(name) {
  const s = getState(name);
  s.fails = 0;
  s.until = 0;
  s.lastError = '';
  s.reachable = true;
  s.hardFails = 0;
  probed.set(name, true);
}

/* 引擎列表：用户偏好顺序 → 不可达/冷却沉底 */
let engineOrderPref = null;

function engineList() {
  const ordered = engineOrderPref && engineOrderPref.length
    ? engineOrderPref.filter((n) => ENGINES[n])
    : DEFAULT_ORDER.slice();
  for (const n of DEFAULT_ORDER) {
    if (!ordered.includes(n)) ordered.push(n);
  }
  // 排序权重：可用(0) < 冷却(1) < 不可达(2)
  return ordered.map((n) => ENGINES[n]).sort((a, b) => {
    const rank = (e) => (isDead(e.name) ? 2 : isCooling(e.name) ? 1 : 0);
    return rank(a) - rank(b);
  });
}

function loadEngineOrder() {
  try {
    chrome.storage.local.get({ engineOrder: null }, (r) => {
      if (Array.isArray(r.engineOrder) && r.engineOrder.length) engineOrderPref = r.engineOrder;
    });
  } catch (e) { /* noop */ }
}
loadEngineOrder();

/* =========================== 请求去重 =========================== */
const inflight = new Map(); // text -> Promise<result>

/* =========================== 工具 =========================== */
function isMostlyChinese(t) {
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const body = t.replace(/\s/g, '');
  return cjk >= 4 && cjk > body.length * 0.5;
}

async function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || FETCH_TIMEOUT);
  try {
    return await fetch(url, Object.assign({ credentials: 'omit', signal: ctrl.signal }, init || {}));
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 切块：保证每个分片长度 ≤ max（按段落聚合 → 超长段落按句子 → 硬上限切） */
function splitChunks(text, max) {
  const src = String(text || '');
  if (src.length <= max) return [src];
  const out = [];
  let cur = '';
  const pushCur = () => { if (cur.trim()) out.push(cur); cur = ''; };

  const addPiece = (piece) => {
    if (!piece) return;
    if (piece.length > max) {
      const sentences = piece.match(/[^.!?。！？]+[.!?。！？]+["')\]]*\s*|[^.!?。！？]+$/g) || [piece];
      for (const s of sentences) {
        const sent = s.trim();
        if (!sent) continue;
        if (sent.length > max) {
          pushCur();
          for (let i = 0; i < sent.length; i += max) out.push(sent.slice(i, i + max));
        } else if ((cur ? cur + ' ' + sent : sent).length > max) {
          pushCur();
          cur = sent;
        } else {
          cur = cur ? cur + ' ' + sent : sent;
        }
      }
      return;
    }
    if ((cur ? cur + '\n' + piece : piece).length > max) {
      pushCur();
      cur = piece;
    } else {
      cur = cur ? cur + '\n' + piece : piece;
    }
  };

  for (const p of src.split(/\n{2,}/)) addPiece(p.trim());
  pushCur();
  return out.length ? out : [src];
}

/* 单引擎单分片：GET（url）或 POST（build），带重试 */
async function trChunk(engine, chunk) {
  if (engine.name === 'bing') {
    const ok = await ensureBingToken();
    if (!ok) {
      const e = new Error('bing token 获取失败');
      e.hard = true;
      throw e;
    }
  }
  let lastErr = null;
  for (let attempt = 0; attempt <= (engine.retries || 0); attempt++) {
    try {
      const spec = engine.build ? engine.build(chunk) : { url: engine.url(chunk), init: undefined };
      const res = await fetchWithTimeout(spec.url, spec.init);
      if (!res.ok) {
        const e = new Error(engine.name + ' HTTP ' + res.status);
        e.hard = true;
        throw e;
      }
      const data = await res.json();
      const { text, srcLang } = engine.parse(data);
      if (!text) {
        const e = new Error(engine.name + ' 空结果');
        e.hard = true;
        throw e;
      }
      if (srcLang.startsWith('zh')) return { unchanged: true, text: chunk };
      return { unchanged: false, text };
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      if (/abort|timeout|空结果|token|errorCode/i.test(msg)) { lastErr.hard = true; break; }
      if (attempt < (engine.retries || 0)) await sleep(900);
    }
  }
  throw lastErr || new Error(engine.name + ' failed');
}

/* 并行翻译全部分片：按索引保证拼接顺序，任一失败整体抛出（交由上层换引擎） */
async function trAllChunks(engine, chunks) {
  const results = new Array(chunks.length);
  let unchanged = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(PARALLEL, chunks.length) }, async () => {
    while (cursor < chunks.length) {
      const idx = cursor++;
      const r = await trChunk(engine, chunks[idx]);
      results[idx] = r.text;
      if (r.unchanged) unchanged += 1;
    }
  });
  await Promise.all(workers);
  return { text: results.join(''), unchanged };
}

/* =========================== 主流程 =========================== */
async function translateOnce(text) {
  if (isMostlyChinese(text)) return { ok: false, error: '原文已是中文' };

  const errors = [];
  const list = engineList();

  // 先并行探测一遍：不可达的引擎直接跳过，不浪费翻译时间
  await Promise.all(list.map((e) => probeEngine(e)));

  for (const engine of engineList()) {
    if (isDead(engine.name)) {
      errors.push(engine.label + ': 不可达');
      continue;
    }
    if (isCooling(engine.name)) {
      errors.push(engine.label + ': 冷却中');
      continue;
    }
    let chunks;
    try {
      chunks = splitChunks(text, engine.max);
    } catch (e) {
      errors.push(engine.label + ': 切块失败');
      continue;
    }
    try {
      const { text: out, unchanged } = await trAllChunks(engine, chunks);
      const trimmed = String(out || '').trim();
      if (!trimmed || unchanged === chunks.length) return { ok: false, error: '原文无需翻译' };
      markOk(engine.name);
      return { ok: true, text: trimmed, engine: engine.label, chunks: chunks.length };
    } catch (e) {
      markFail(engine.name, e, !!(e && e.hard));
      errors.push(engine.label + ': ' + String((e && e.message) || e));
    }
  }
  return { ok: false, error: errors.join(' | ') || '全部引擎失败' };
}

function translate(text) {
  const src = String(text || '');
  if (inflight.has(src)) return inflight.get(src);
  const p = translateOnce(src).finally(() => { inflight.delete(src); });
  inflight.set(src, p);
  return p;
}

/* =========================== 消息接口 =========================== */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  // 引擎清单（供弹窗渲染优先级列表）
  if (msg.type === 'ghl10n-mt-engines') {
    const list = DEFAULT_ORDER.filter((n) => ENGINES[n])
      .map((n) => ({ name: n, label: ENGINES[n].label, max: ENGINES[n].max }));
    sendResponse({ ok: true, engines: list, order: engineOrderPref || DEFAULT_ORDER });
    return;
  }

  // 引擎健康度 / 可达性诊断
  if (msg.type === 'ghl10n-mt-health') {
    const out = {};
    for (const name of DEFAULT_ORDER) {
      if (!ENGINES[name]) continue;
      const s = engineState.get(name);
      out[name] = {
        label: ENGINES[name].label,
        reachable: s ? s.reachable : null,
        dead: isDead(name),
        cooling: isCooling(name),
        fails: s ? s.fails : 0,
        lastError: s ? s.lastError : '',
      };
    }
    sendResponse({ ok: true, engines: out, inflight: inflight.size });
    return;
  }

  // 主动重新探测全部引擎（弹窗"重测可达性"）
  if (msg.type === 'ghl10n-mt-reprobe') {
    probed.clear();
    engineState.clear();
    Promise.all(DEFAULT_ORDER.map((n) => probeEngine(ENGINES[n]))).then(() => {
      const out = {};
      for (const name of DEFAULT_ORDER) {
        const s = engineState.get(name);
        out[name] = { label: ENGINES[name].label, reachable: s ? s.reachable : null, dead: isDead(name), cooling: isCooling(name), fails: 0, lastError: s ? s.lastError : '' };
      }
      sendResponse({ ok: true, engines: out });
    });
    return true;
  }

  // 设置引擎优先级
  if (msg.type === 'ghl10n-mt-set-order') {
    const order = Array.isArray(msg.order) ? msg.order.filter((n) => ENGINES[n]) : null;
    engineOrderPref = order && order.length ? order : null;
    try { chrome.storage.local.set({ engineOrder: engineOrderPref }); } catch (e) { /* noop */ }
    sendResponse({ ok: true, order: engineOrderPref || DEFAULT_ORDER });
    return;
  }

  if (msg.type !== 'ghl10n-mt') return;
  translate(String(msg.text || '')).then(sendResponse);
  return true; // 异步 sendResponse
});
