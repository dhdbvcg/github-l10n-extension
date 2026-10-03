/* background.js — MV3 Service Worker：人机翻译中继
 *
 * 支持两���本地翻译服务（弹窗可切换，协议自动探测后记住）：
 *
 *  1) zh_translator（默认，本机 zh_translator 服务）
 *     健康：GET  {base}/health          → {"ok":true,"loaded":true}
 *     翻译：POST {base}/translate  {"text":"..."}  → {"translation":"..."}
 *     说明：CPU 推理较慢，单片不宜过长；不支持数组批量入参。
 *
 *  2) OpenNMT-py（onmt_server）
 *     健康：GET  {base}/translator/health → {"status":"ok"}
 *     翻译：POST {base}/translator/translate
 *           请求 [{"id": <model_id>, "src": "文本"}]
 *           响应 [[{"src":..., "tgt":"译文", "pred_score":...}]]
 *     词级模型按空格分词，长文本需分片。
 *
 * 其他能力：
 *   - 协议自动探测：首次翻译时试探 /health 与 /translator/health，记住结果
 *   - 服务不可达时快速失败（冷却 30s），不再白等超时
 *   - 分片翻译：CPU 推理慢，故并发 1，避免互相抢资源导致整体超时
 *   - 同文本并发去重（inflight）
 *   - 译文缓存（mt.js 侧，本机 chrome.storage）
 */
'use strict';

const PROBE_TIMEOUT = 4000;
const FETCH_TIMEOUT = 45000;   // 本地 CPU 推理可能较慢
const COOLDOWN_MS = 30000;
const PARALLEL = 1;            // CPU 推理串行更稳，避免相互拖慢
const CHUNK_MAX = 300;         // 单片上限（CPU 推理，保守取值）
const MAX_CHUNKS = 40;         // 单次任务最多分多少片，防超大文本拖垮服务

const DEFAULT_BASE = 'http://127.0.0.1:8848';
const DEFAULT_MODEL_ID = 0;

/* 服务配置（弹窗写入 storage，SW 启动时读取） */
let CFG = {
  base: DEFAULT_BASE,
  modelId: DEFAULT_MODEL_ID,
  proto: 'auto',     // 'auto' | 'zhtr' | 'onnmt'
};

function loadCfg() {
  try {
    chrome.storage.local.get({ onmtBase: null, onmtModelId: null, onmtProto: null }, (r) => {
      if (r.onmtBase) CFG.base = String(r.onmtBase).replace(/\/+$/, '');
      if (r.onmtModelId != null && !isNaN(Number(r.onmtModelId))) CFG.modelId = Number(r.onmtModelId);
      if (r.onmtProto) CFG.proto = r.onmtProto;
    });
  } catch (e) { /* noop */ }
}
loadCfg();

/* =========================== 服务状态 =========================== */
const state = {
  proto: null,      // 已探测出的协议：'zhtr' | 'onnmt'
  ready: null,      // null 未探测
  lastError: '',
  coolUntil: 0,
};

function describe(e) {
  const msg = String((e && e.message) || e);
  if (/abort|timeout/i.test(msg)) return '翻译超时（服务推理过慢，可减少单次文本量）';
  if (/Failed to fetch|NetworkError|ERR_CONNECTION/i.test(msg)) return '无法连接（服务未启动或地址不对）';
  if (/ERR_CORS/i.test(msg)) return '被 CORS 拦截（需按 README 配置跨域）';
  if (/429/.test(msg)) return '服务繁忙（限流），稍后重试';
  return msg.slice(0, 120);
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

/** 探测协议与可用性：先试 zh_translator 的 /health，再试 OpenNMT 的 /translator/health */
async function probe() {
  const order = CFG.proto === 'onnmt' ? ['onnmt', 'zhtr']
    : CFG.proto === 'zhtr' ? ['zhtr', 'onnmt']
      : ['zhtr', 'onnmt'];
  let lastErr = '';
  for (const p of order) {
    try {
      const path = p === 'zhtr' ? '/health' : '/translator/health';
      const res = await fetchWithTimeout(CFG.base + path, undefined, PROBE_TIMEOUT);
      if (res.ok) {
        state.proto = p;
        state.ready = true;
        state.lastError = '';
        return { ok: true, proto: p };
      }
      lastErr = p + ' HTTP ' + res.status;
    } catch (e) {
      lastErr = describe(e);
    }
  }
  state.ready = false;
  state.lastError = '服务未响应（' + lastErr + '）';
  return { ok: false, error: state.lastError };
}

function coolDown(err) {
  state.ready = false;
  state.lastError = describe(err);
  state.coolUntil = Date.now() + COOLDOWN_MS;
}

/* =========================== 切块 =========================== */
function splitChunks(text, max) {
  const src = String(text || '');
  if (src.length <= max) return [src];
  const out = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur); cur = ''; };
  // 优先在句子边界切
  const sentences = src.match(/[^.!?。！？\n]+[.!?。！？]*\n?/g) || [src];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > max) {
      // 超长句：按空格组词，不切断单词
      const words = s.split(/\s+/);
      let piece = '';
      for (const w of words) {
        if ((piece ? piece + ' ' + w : w).length > max) {
          if (piece) { out.push(piece); piece = ''; }
          if (w.length > max) { for (let i = 0; i < w.length; i += max) out.push(w.slice(i, i + max)); continue; }
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

/** 单片翻译：按协议分派 */
async function trChunk(chunk) {
  if (state.proto === 'onnmt') {
    const res = await fetchWithTimeout(CFG.base + '/translator/translate', {
      method: 'POST',
      body: JSON.stringify([{ id: CFG.modelId, src: chunk }]),
    });
    if (!res.ok) { const e = new Error('OpenNMT HTTP ' + res.status); e.hard = true; throw e; }
    const data = await res.json();
    const first = Array.isArray(data) ? data[0] : null;
    const item = Array.isArray(first) ? first[0] : (first || null);
    if (item && item.status === 'error') throw new Error(item.error || 'OpenNMT 返回 error');
    const tgt = item && typeof item.tgt === 'string' ? item.tgt : '';
    if (!tgt) { const e = new Error('OpenNMT 返回空结果'); e.hard = true; throw e; }
    return { text: tgt, unchanged: tgt === chunk };
  }

  // zh_translator：POST /translate {"text": "..."}
  const res = await fetchWithTimeout(CFG.base + '/translate', {
    method: 'POST',
    body: JSON.stringify({ text: chunk }),
  });
  if (!res.ok) { const e = new Error('HTTP ' + res.status); e.hard = true; throw e; }
  let data;
  try {
    data = await res.json();
  } catch (err) {
    const e = new Error('响应不是合法 JSON'); e.hard = true; throw e;
  }
  if (data && data.skipped) return { unchanged: true, text: chunk };
  const tgt = String((data && data.translation) || '');
  if (!tgt) { const e = new Error('返回空译文（服务可能未加载模型）'); e.hard = true; throw e; }
  return { text: tgt, unchanged: tgt === chunk };
}

/** 串行翻译所有分片（CPU 推理，串行更稳） */
async function trAllChunks(chunks) {
  const results = [];
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

async function translateOnce(text) {
  if (isMostlyChinese(text)) return { ok: false, error: '原文已是中文' };

  if (state.ready === false && state.coolUntil > Date.now()) {
    return { ok: false, error: state.lastError + '（30 秒后重试）' };
  }
  if (state.ready !== true || !state.proto) {
    const p = await probe();
    if (!p.ok) return { ok: false, error: state.lastError };
  }

  const chunks = splitChunks(text, CHUNK_MAX).slice(0, MAX_CHUNKS);
  try {
    const { text: out, unchanged } = await trAllChunks(chunks);
    const trimmed = String(out || '').trim();
    if (!trimmed) return { ok: false, error: '返回空结果' };
    state.ready = true;
    state.lastError = '';
    return {
      ok: true,
      text: trimmed,
      engine: (state.proto === 'onnmt' ? 'OpenNMT' : '本机翻译服务') + ' @ ' + CFG.base,
      chunks: chunks.length,
      unchangedAll: unchanged === chunks.length,
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/Failed to fetch|NetworkError|aborted|timeout|CORS/i.test(msg)) coolDown(e);
    else state.lastError = msg.slice(0, 120);
    return { ok: false, error: msg };
  }
}

/* 并发去重 */
const inflight = new Map();
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

  if (msg.type === 'ghl10n-mt-config') {
    sendResponse({ ok: true, base: CFG.base, modelId: CFG.modelId, proto: CFG.proto, ready: state.ready, lastError: state.lastError });
    return;
  }

  if (msg.type === 'ghl10n-mt-health') {
    sendResponse({
      ok: true, base: CFG.base, modelId: CFG.modelId,
      proto: state.proto, protoPref: CFG.proto,
      reachable: state.ready, cooling: state.coolUntil > Date.now(),
      lastError: state.lastError, inflight: inflight.size,
    });
    return;
  }

  if (msg.type === 'ghl10n-mt-reprobe') {
    state.ready = null;
    state.coolUntil = 0;
    probe().then(() => {
      sendResponse({ ok: true, reachable: state.ready, proto: state.proto, lastError: state.lastError, base: CFG.base });
    });
    return true;
  }

  if (msg.type === 'ghl10n-mt-set-config') {
    const set = {};
    if (msg.base) set.onmtBase = String(msg.base).replace(/\/+$/, '');
    if (msg.modelId != null && !isNaN(Number(msg.modelId))) set.onmtModelId = Number(msg.modelId);
    if (msg.proto) set.onmtProto = msg.proto;
    if (Object.keys(set).length) {
      try { chrome.storage.local.set(set); } catch (e) { /* noop */ }
      if (set.onmtBase) CFG.base = set.onmtBase;
      if (set.onmtModelId != null) CFG.modelId = set.onmtModelId;
      if (set.onmtProto) CFG.proto = set.onmtProto;
      state.ready = null;
      state.proto = null;
      state.coolUntil = 0;
    }
    sendResponse({ ok: true, base: CFG.base, modelId: CFG.modelId, proto: CFG.proto });
    return;
  }

  if (msg.type !== 'ghl10n-mt') return;
  translate(String(msg.text || '')).then(sendResponse);
  return true;
});
