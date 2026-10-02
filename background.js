/* background.js — MV3 Service Worker：人机翻译中继（OpenNMT-py）
 *
 * 唯一引擎：OpenNMT-py REST Server（自建，需自行部署）
 *   部署：pip install OpenNMT-py && onmt_server -m conf.json
 *   接口：POST {base}/translator/translate
 *          请求 [{"id": <model_id>, "src": "文本"}]
 *          响应 [[{"src":..., "tgt":"译文", "pred_score":...}]]
 *   健康：GET  {base}/translator/health → {"status":"ok"}
 *
 * 服务地址可在弹窗中修改（storage: onmtBase），默认本机 5000 端口。
 * 词级模型按空格分词，故长文本需分片；分片可并行，结果按索引拼接。
 *
 * 其他能力：
 *   - 连通性探测：服务不可达时快速失败并提示，不再白等引擎超时
 *   - 分片并行翻译（限流 3）
 *   - 同文本并发去重（inflight）
 *   - 译文缓存（mt.js 侧，本机 chrome.storage）
 */
'use strict';

const FETCH_TIMEOUT = 20000;  // 本地服务推理可能较慢
const PROBE_TIMEOUT = 3000;
const PARALLEL = 3;           // 分片并行数
const COOLDOWN_MS = 30000;    // 服务不可用后的冷却
const DEAD_MS = 60 * 1000;    // 明确连不上后的跳过时长

const DEFAULT_BASE = 'http://127.0.0.1:5000';
const DEFAULT_MODEL_ID = 0;
const DEFAULT_URL_ROOT = '/translator';
/* 词级模型按空格分词，单片不宜过长；留足余量避免句法碎片 */
const CHUNK_MAX = 400;

/* 服务配置（由弹窗写入 storage，SW 启动时读取） */
let CFG = {
  base: DEFAULT_BASE,
  modelId: DEFAULT_MODEL_ID,
  urlRoot: DEFAULT_URL_ROOT,
  batch: false,   // 一次请求发多句（服务端支持时更快）
};

function loadCfg() {
  try {
    chrome.storage.local.get({ onmtBase: null, onmtModelId: null, onmtUrlRoot: null }, (r) => {
      if (r.onmtBase) CFG.base = String(r.onmtBase).replace(/\/+$/, '');
      if (r.onmtModelId != null && !isNaN(Number(r.onmtModelId))) CFG.modelId = Number(r.onmtModelId);
      if (r.onmtUrlRoot) CFG.urlRoot = String(r.onmtUrlRoot);
    });
  } catch (e) { /* noop */ }
}
loadCfg();

/* =========================== 服务状态 =========================== */
const state = {
  reachable: null,   // null=未探测 true/false=已探测
  lastError: '',
  coolUntil: 0,
  models: null,     // /models 缓存
};

function url(pathname) {
  return CFG.base + CFG.urlRoot.replace(/\/+$/, '') + pathname;
}

async function fetchWithTimeout(target, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || FETCH_TIMEOUT);
  try {
    return await fetch(target, Object.assign({
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
    }, init || {}, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

async function probe() {
  try {
    const res = await fetchWithTimeout(url('/health'), undefined, PROBE_TIMEOUT);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json().catch(() => ({}));
    state.reachable = true;
    state.lastError = '';
    return { ok: true, data };
  } catch (e) {
    state.reachable = false;
    state.lastError = describe(e);
    return { ok: false, error: state.lastError };
  }
}

/* 把 fetch 异常翻译成人话 */
function describe(e) {
  const msg = String((e && e.message) || e);
  if (/abort|timeout/i.test(msg)) return '连接超时（服务未启动或推理过慢）';
  if (/Failed to fetch|NetworkError|ERR_CONNECTION/i.test(msg)) return '无法连接（服务未启动或地址不对）';
  if (/ERR_CORS/i.test(msg)) return '被 CORS 拦截（需按 README 配置跨域）';
  return msg.slice(0, 100);
}

/* 拉取模型列表（用于弹窗展示与校验 model_id） */
async function fetchModels() {
  try {
    const res = await fetchWithTimeout(url('/models'), undefined, PROBE_TIMEOUT);
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    state.models = await res.json();
    return { ok: true, models: state.models };
  } catch (e) {
    return { ok: false, error: describe(e) };
  }
}

/* =========================== 切块 =========================== */
function splitChunks(text, max) {
  const src = String(text || '');
  if (src.length <= max) return [src];
  const out = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur); cur = ''; };
  // 优先在句子边界切（词级模型对完整句子翻译质量更好）
  const sentences = src.match(/[^.!?。！？\n]+[.!?。！？]*\n?/g) || [src];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > max) {
      // 超长句：按空格分词组块，尽量不切断单词
      const words = s.split(/\s+/);
      let piece = '';
      for (const w of words) {
        if ((piece ? piece + ' ' + w : w).length > max) {
          if (piece) { out.push(piece); piece = ''; }
          if (w.length > max) {
            // 极端长词（URL 等）：硬切
            for (let i = 0; i < w.length; i += max) out.push(w.slice(i, i + max));
            continue;
          }
        }
        piece = piece ? piece + ' ' + w : w;
      }
      if (piece) out.push(piece);
      continue;
    }
    if ((cur ? cur + ' ' + s : s).length > max) { push(); cur = s; }
    else cur = cur ? cur + ' ' + s : s;
  }
  push();
  return out.length ? out : [src];
}

/* =========================== 翻译核心 =========================== */
function isMostlyChinese(t) {
  const cjk = (t.match(/[一-鿿]/g) || []).length;
  const body = t.replace(/\s/g, '');
  return cjk >= 4 && cjk > body.length * 0.5;
}

/* 单片翻译：POST /translate，请求体 [{id, src}]，取 [0][0].tgt */
async function trChunk(chunk) {
  const payload = JSON.stringify([{ id: CFG.modelId, src: chunk }]);
  const res = await fetchWithTimeout(url('/translate'), {
    method: 'POST',
    body: payload,
  });
  if (!res.ok) {
    const e = new Error('HTTP ' + res.status);
    e.hard = true;
    throw e;
  }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    const e = new Error('响应不是合法 JSON（可能返回了 HTML 错误页）');
    e.hard = true;
    throw e;
  }
  // 契约：[[{ src, tgt, n_best, pred_score }]]
  const first = Array.isArray(data) ? data[0] : null;
  const item = Array.isArray(first) ? first[0] : (first || null);
  if (item && item.status === 'error') throw new Error(item.error || '服务端返回 error');
  const tgt = item && typeof item.tgt === 'string' ? item.tgt : '';
  if (!tgt) {
    const e = new Error('空结果（检查模型 id 与 src_lang 是否匹配）');
    e.hard = true;
    throw e;
  }
  return { text: tgt, unchanged: tgt === chunk };
}

/* 多片并行：按索引拼接，保证顺序 */
async function trAllChunks(chunks) {
  const results = new Array(chunks.length);
  let unchanged = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(PARALLEL, chunks.length) }, async () => {
    while (cursor < chunks.length) {
      const idx = cursor++;
      const r = await trChunk(chunks[idx]);
      results[idx] = r.text;
      if (r.unchanged) unchanged += 1;
    }
  });
  await Promise.all(workers);
  return { text: results.join(''), unchanged };
}

function coolDown(err) {
  state.reachable = false;
  state.lastError = describe(err);
  state.coolUntil = Date.now() + COOLDOWN_MS;
}

async function translateOnce(text) {
  if (isMostlyChinese(text)) return { ok: false, error: '原文已是中文' };

  // 冷却中且未到期：直接失败，不浪费一次探测
  if (state.reachable === false && state.coolUntil > Date.now()) {
    return { ok: false, error: state.lastError + '（30 秒后重试）' };
  }

  // 首次或冷却到期：先探测
  if (state.reachable !== true) {
    const p = await probe();
    if (!p.ok) {
      coolDown(new Error(state.lastError));
      return { ok: false, error: state.lastError };
    }
  }

  const chunks = splitChunks(text, CHUNK_MAX);
  try {
    const { text: out, unchanged } = await trAllChunks(chunks);
    const trimmed = String(out || '').trim();
    if (!trimmed) return { ok: false, error: 'OpenNMT 返回空结果' };
    state.reachable = true;
    state.lastError = '';
    return {
      ok: true,
      text: trimmed,
      engine: 'OpenNMT (' + CFG.base + ')',
      chunks: chunks.length,
      unchangedAll: unchanged === chunks.length,
    };
  } catch (e) {
    // 连不上（网络层）走冷却；服务端报错只标记本次失败，下次仍可试
    const msg = String((e && e.message) || e);
    if (/Failed to fetch|NetworkError|aborted|timeout|CORS/i.test(msg)) coolDown(e);
    else state.lastError = msg.slice(0, 100);
    return { ok: false, error: msg };
  }
}

/* 并发去重 */
const inflight = new Map();
function translate(text) {
  const src = String(text || '');
  if (inflight.has(src)) return inflight.get(src);
  const p = translateOnce(src).finally(() => inflight.delete(src));
  inflight.set(src, p);
  return p;
}

/* =========================== 消息接口 =========================== */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'ghl10n-mt-config') {
    sendResponse({
      ok: true,
      base: CFG.base,
      modelId: CFG.modelId,
      urlRoot: CFG.urlRoot,
      reachable: state.reachable,
      lastError: state.lastError,
    });
    return;
  }

  if (msg.type === 'ghl10n-mt-health') {
    sendResponse({
      ok: true,
      base: CFG.base,
      modelId: CFG.modelId,
      urlRoot: CFG.urlRoot,
      reachable: state.reachable,
      cooling: state.coolUntil > Date.now(),
      lastError: state.lastError,
      inflight: inflight.size,
    });
    return;
  }

  if (msg.type === 'ghl10n-mt-models') {
    probe().then(async (p) => {
      if (!p.ok) { sendResponse({ ok: false, error: state.lastError }); return; }
      const m = await fetchModels();
      sendResponse(m.ok ? { ok: true, models: m.models } : { ok: false, error: m.error });
    });
    return true;
  }

  if (msg.type === 'ghl10n-mt-set-config') {
    const set = {};
    if (msg.base) set.onmtBase = String(msg.base).replace(/\/+$/, '');
    if (msg.modelId != null && !isNaN(Number(msg.modelId))) set.onmtModelId = Number(msg.modelId);
    if (msg.urlRoot) set.onmtUrlRoot = String(msg.urlRoot);
    if (Object.keys(set).length) {
      try { chrome.storage.local.set(set); } catch (e) { /* noop */ }
      if (set.onmtBase) CFG.base = set.onmtBase;
      if (set.onmtModelId != null) CFG.modelId = set.onmtModelId;
      if (set.onmtUrlRoot) CFG.urlRoot = set.onmtUrlRoot;
      state.reachable = null; // 配置变了，重新探测
      state.coolUntil = 0;
    }
    sendResponse({ ok: true, base: CFG.base, modelId: CFG.modelId, urlRoot: CFG.urlRoot });
    return;
  }

  if (msg.type === 'ghl10n-mt-reprobe') {
    state.reachable = null;
    state.coolUntil = 0;
    probe().then(() => {
      sendResponse({ ok: true, reachable: state.reachable, lastError: state.lastError, base: CFG.base });
    });
    return true;
  }

  if (msg.type !== 'ghl10n-mt') return;
  translate(String(msg.text || '')).then(sendResponse);
  return true;
});
