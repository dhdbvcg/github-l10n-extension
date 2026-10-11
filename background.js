/* background.js — MV3 Service Worker：人机翻译中继
 *
 * 三种翻译来源（弹窗可选择，默认 auto 自动探测）：
 *
 *  1) 微软网页翻译（默认，免密钥）
 *     令牌由 bing.com/translator 页面 JS 运行时生成（Date.now() 计算 key），
 *     静态抓取拿不到，故提供两种取得方式：
 *       a) 官方公开令牌端点（Microsoft Translator 网页版共用凭据，无需密钥）
 *       b) 用户在弹窗点「授权网页翻译」，扩展打开 bing.com/translator 并
 *          通过 declarativeNetRequest 捕获请求中的 token/key 存入本地
 *     翻译：POST https://www.bing.com/ttranslatev3
 *
 *  2) 微软官方 API（用户在弹窗填密钥）
 *     翻译：POST https://api.cognitive.microsofttranslator.com/translate?api-version=3.0
 *     鉴权：Ocp-Apim-Subscription-Key 或 Authorization: Bearer
 *     区域：eastasia / westus 等
 *
 *  3) 本地服务（保底）
 *     zh_translator: POST {base}/translate  {"text":...} → {"translation":...}
 *     OpenNMT-py  : POST {base}/translator/translate [{"id":..,"src":..}]
 *
 * 其他能力：自动探测协议、不可达快速失败、分片串行、同文本并发去重。
 */
'use strict';

const PROBE_TIMEOUT = 5000;
const FETCH_TIMEOUT = 30000;
const COOLDOWN_MS = 30000;
const PARALLEL = 2;
const CHUNK_MAX = 900;          // 网络翻译无 CPU 瓶颈，可放宽
const MAX_CHUNKS = 40;

const DEFAULT_BASE = 'http://127.0.0.1:8848';
const MS_AUTH_URL = 'https://edge.microsoft.com/translate/auth';
const BING_TRANS_URL = 'https://www.bing.com/ttranslatev3';
const MS_API_URL = 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* 配置 */
let CFG = {
  provider: 'auto',   // 'auto' | 'bing' | 'msapi' | 'local'
  base: DEFAULT_BASE,
  modelId: 0,
  msKey: '',          // 微软官方 API 订阅密钥
  msRegion: '',       // 区域（eastasia 等），留空用全局端点
};
let bingToken = { token: '', key: '', ig: '', at: 0 };   // 网页版令牌缓存
const TOKEN_TTL = 25 * 60 * 1000;   // 令牌约半小时过期

function loadCfg() {
  try {
    chrome.storage.local.get({
      mtProvider: null, onmtBase: null, onmtModelId: null,
      msKey: null, msRegion: null, bingToken: null,
    }, (r) => {
      if (r.mtProvider) CFG.provider = r.mtProvider;
      if (r.onmtBase) CFG.base = String(r.onmtBase).replace(/\/+$/, '');
      if (r.onmtModelId != null && !isNaN(Number(r.onmtModelId))) CFG.modelId = Number(r.onmtModelId);
      if (r.msKey) CFG.msKey = r.msKey;
      if (r.msRegion) CFG.msRegion = r.msRegion;
      if (r.bingToken && r.bingToken.token) {
        bingToken = { ig: '', at: 0, ...r.bingToken };
      }
    });
  } catch (e) { /* noop */ }
}
loadCfg();

/* =========================== 工具 =========================== */
const state = { provider: null, ready: null, lastError: '', coolUntil: 0 };

function describe(e) {
  const m = String((e && e.message) || e);
  if (/abort|timeout/i.test(m)) return '翻译超时（服务响应过慢）';
  if (/Failed to fetch|NetworkError|ERR_CONNECTION/i.test(m)) return '无法连接（服务未启动或地址不对）';
  if (/ERR_CORS/i.test(m)) return '被 CORS 拦截';
  if (/401|Unauthorized|Subscription/i.test(m)) return '微软 API 密钥无效或未填写';
  return m.slice(0, 140);
}

async function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms || FETCH_TIMEOUT);
  try {
    return await fetch(url, Object.assign({ credentials: 'omit' }, init || {}, { signal: ctrl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

function coolDown(err) {
  state.ready = false;
  state.lastError = describe(err);
  state.coolUntil = Date.now() + COOLDOWN_MS;
}

function isMostlyChinese(t) {
  const cjk = (t.match(/[一-鿿]/g) || []).length;
  const body = t.replace(/\s/g, '');
  return cjk >= 4 && cjk > body.length * 0.5;
}

/* =========================== 切块 =========================== */
function splitChunks(text, max) {
  const src = String(text || '');
  if (src.length <= max) return [src];
  const out = [];
  let cur = '';
  const push = () => { if (cur.trim()) out.push(cur); cur = ''; };
  const sentences = src.match(/[^.!?。！？\n]+[.!?。！？]*\n?/g) || [src];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s) continue;
    if (s.length > max) {
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

/* =========================== 引擎 1：微软官方 API =========================== */
async function trMsApi(chunk) {
  const url = CFG.msRegion
    ? `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=zh-Hans&region=${encodeURIComponent(CFG.msRegion)}`
    : MS_API_URL;
  const headers = { 'Content-Type': 'application/json' };
  if (CFG.msKey) headers['Ocp-Apim-Subscription-Key'] = CFG.msKey;
  const res = await fetchWithTimeout(url, {
    method: 'POST', headers,
    body: JSON.stringify([{ Text: chunk }]),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('MS API HTTP ' + res.status + ' ' + t.slice(0, 100));
  }
  const data = await res.json();
  const tgt = String((data[0] && data[0].translations && data[0].translations[0] && data[0].translations[0].text) || '');
  if (!tgt) throw new Error('MS API 返回空结果');
  return { text: tgt, unchanged: tgt === chunk };
}

/* =========================== 引擎 2：必应网页翻译 =========================== */
/** 取 IG 与令牌：优先已捕获的；否则尝试公开 auth 端点 */
async function ensureBingToken() {
  if (bingToken.token && Date.now() - bingToken.at < TOKEN_TTL) return true;

  // (a) 公开 auth 端点
  try {
    const res = await fetchWithTimeout(MS_AUTH_URL, { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const jwt = (await res.text()).trim();
      if (jwt && jwt.length > 40 && jwt.split('.').length === 3) {
        bingToken = { token: jwt, key: String(Date.now()), ig: bingToken.ig || '', at: Date.now() };
        try { chrome.storage.local.set({ bingToken }); } catch (e) { /* noop */ }
        return true;
      }
    }
  } catch (e) { /* 继续尝试其它方式 */ }

  // (b) 从 bing.com/translator 页面取 IG（配合已捕获的 token 使用）
  try {
    const res = await fetchWithTimeout('https://www.bing.com/translator', { headers: { 'User-Agent': UA } });
    if (res.ok) {
      const html = await res.text();
      const ig = (html.match(/IG:"([^"]+)"/) || [])[1] || '';
      if (ig) bingToken.ig = ig;
    }
  } catch (e) { /* noop */ }

  return !!(bingToken.token && bingToken.ig);
}

async function trBing(chunk) {
  const ok = await ensureBingToken();
  if (!ok) throw new Error('缺少必应翻译令牌，请在弹窗点「授权网页翻译」');

  const url = BING_TRANS_URL + '?isVertical=1&IG=' + (bingToken.ig || 'A1B2C3D4E5F6G7H8') + '&IID=translator.5028.1';
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      'Referer': 'https://www.bing.com/translator',
      'Origin': 'https://www.bing.com',
    },
    body: new URLSearchParams({
      fromLang: 'en', text: chunk, to: 'zh-Hans',
      token: bingToken.token, key: bingToken.key,
    }).toString(),
  });
  if (!res.ok) {
    bingToken.at = 0;   // 令牌可能已失效
    throw new Error('必应翻译 HTTP ' + res.status);
  }
  const text = await res.text();
  let tgt = '';
  try {
    const data = JSON.parse(text);
    tgt = String((data[0] && data[0].translations && data[0].translations[0] && data[0].translations[0].text) || '');
  } catch (e) {
    throw new Error('必应返回空或非 JSON（令牌可能已失效，请重新授权）');
  }
  if (!tgt) throw new Error('必应返回空译文（令牌可能已失效，请重新授权）');
  return { text: tgt, unchanged: tgt === chunk };
}

/* =========================== 引擎 3：本地服务 =========================== */
async function trLocal(chunk) {
  // 先试 zh_translator 的 /translate，再试 OpenNMT 的 /translator/translate
  try {
    const res = await fetchWithTimeout(CFG.base + '/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: chunk }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.skipped) return { unchanged: true, text: chunk };
      const tgt = String((data && data.translation) || '');
      if (tgt) return { text: tgt, unchanged: tgt === chunk };
    }
  } catch (e) { /* 试 OpenNMT */ }

  const res = await fetchWithTimeout(CFG.base + '/translator/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ id: CFG.modelId, src: chunk }]),
  });
  if (!res.ok) throw new Error('本地服务 HTTP ' + res.status);
  const data = await res.json();
  const first = Array.isArray(data) ? data[0] : null;
  const item = Array.isArray(first) ? first[0] : (first || null);
  const tgt = item && typeof item.tgt === 'string' ? item.tgt : '';
  if (!tgt) throw new Error('本地服务返回空结果');
  return { text: tgt, unchanged: tgt === chunk };
}

const ENGINES = { msapi: trMsApi, bing: trBing, local: trLocal };

/** 按配置顺序尝试可用引擎 */
function engineOrder() {
  if (CFG.provider === 'bing') return ['bing', 'local'];
  if (CFG.provider === 'msapi') return ['msapi', 'local'];
  if (CFG.provider === 'local') return ['local'];
  // auto：官方 API（有密钥）→ 网页版 → 本地
  const order = [];
  if (CFG.msKey) order.push('msapi');
  order.push('bing', 'local');
  return order;
}

function engineLabel(name) {
  return name === 'msapi' ? '微软官方 API' : name === 'bing' ? '必应网页翻译' : '本地服务';
}

/* =========================== 翻译主流程 =========================== */
async function trAllChunks(name, chunks) {
  const results = [];
  let unchanged = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(PARALLEL, chunks.length) }, async () => {
    while (cursor < chunks.length) {
      const idx = cursor++;
      const r = await ENGINES[name](chunks[idx]);
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

  const chunks = splitChunks(text, CHUNK_MAX).slice(0, MAX_CHUNKS);
  const errors = [];

  for (const name of engineOrder()) {
    try {
      const { text: out, unchanged } = await trAllChunks(name, chunks);
      const trimmed = String(out || '').trim();
      if (!trimmed) throw new Error('返回空结果');
      state.provider = name;
      state.ready = true;
      state.lastError = '';
      return {
        ok: true, text: trimmed,
        engine: engineLabel(name), provider: name,
        chunks: chunks.length, unchangedAll: unchanged === chunks.length,
      };
    } catch (e) {
      errors.push(engineLabel(name) + ': ' + String((e && e.message) || e));
      if (name === 'bing' && /令牌/.test(String((e && e.message) || e))) {
        // 令牌缺失是配置问题，不该冷却整个服务
        state.lastError = String((e && e.message) || e);
        state.ready = true;
        return { ok: false, error: state.lastError };
      }
    }
  }
  coolDown(new Error(errors.join(' | ')));
  return { ok: false, error: errors.join(' | ') };
}

const inflight = new Map();
function translate(text) {
  const src = String(text || '');
  if (inflight.has(src)) return inflight.get(src);
  const p = translateOnce(src).finally(() => { inflight.delete(src); });
  inflight.set(src, p);
  return p;
}

/* =========================== 令牌捕获 =========================== */
/**
 * 通过 declarativeNetRequest 捕获必应翻译请求中的 token/key。
 * 需要 "declarativeNetRequestWithHostAccess" 权限与规则。
 */
async function setupTokenCapture() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ['ms1'],
      addRules: [{
        id: 'ms1',
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [
          // 不做任何修改，仅用于观察；捕获在 webRequest.onBeforeRequestListen 中完成
        ] },
        condition: { urlFilter: '*bing.com/ttranslatev3*', resourceTypes: ['xmlhttprequest'] },
      }],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: describe(e) };
  }
}

if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (!details.url.includes('/ttranslatev3')) return;
      try {
        const raw = details.requestBody && details.requestBody.raw;
        if (!raw) return;
        const text = new TextDecoder().decode(raw);
        const p = new URLSearchParams(text);
        const token = p.get('token');
        const key = p.get('key');
        if (token) {
          bingToken = { token, key: key || String(Date.now()), ig: bingToken.ig || '', at: Date.now() };
          try { chrome.storage.local.set({ bingToken }); } catch (e) { /* noop */ }
          state.lastError = '';
          state.ready = true;
        }
      } catch (e) { /* noop */ }
    },
    { urls: ['*://*.bing.com/ttranslatev3*'] },
    ['requestBody']
  );
}

/* =========================== 消息接口 =========================== */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === 'ghl10n-mt-config') {
    sendResponse({
      ok: true, base: CFG.base, modelId: CFG.modelId, provider: CFG.provider,
      hasKey: !!CFG.msKey, msRegion: CFG.msRegion,
      hasToken: !!(bingToken.token && Date.now() - bingToken.at < TOKEN_TTL),
    });
    return;
  }

  if (msg.type === 'ghl10n-mt-health') {
    sendResponse({
      ok: true, base: CFG.base, provider: state.provider, pref: CFG.provider,
      reachable: state.ready, cooling: state.coolUntil > Date.now(),
      lastError: state.lastError, inflight: inflight.size,
      hasToken: !!(bingToken.token && Date.now() - bingToken.at < TOKEN_TTL),
    });
    return;
  }

  if (msg.type === 'ghl10n-mt-set-config') {
    const set = {};
    if (msg.provider) set.mtProvider = msg.provider;
    if (msg.base) set.onmtBase = String(msg.base).replace(/\/+$/, '');
    if (msg.modelId != null && !isNaN(Number(msg.modelId))) set.onmtModelId = Number(msg.modelId);
    if (msg.msKey !== undefined) set.msKey = String(msg.msKey || '');
    if (msg.msRegion !== undefined) set.msRegion = String(msg.msRegion || '');
    if (Object.keys(set).length) {
      try { chrome.storage.local.set(set); } catch (e) { /* noop */ }
      if (msg.provider) CFG.provider = msg.provider;
      if (msg.base) CFG.base = String(msg.base).replace(/\/+$/, '');
      if (msg.modelId != null) CFG.modelId = Number(msg.modelId);
      if (msg.msKey !== undefined) CFG.msKey = String(msg.msKey || '');
      if (msg.msRegion !== undefined) CFG.msRegion = String(msg.msRegion || '');
      state.ready = null;
      state.coolUntil = 0;
    }
    sendResponse({ ok: true, provider: CFG.provider, base: CFG.base, hasKey: !!CFG.msKey });
    return;
  }

  // 打开必应翻译页，让用户手动翻译一次以捕获令牌
  if (msg.type === 'ghl10n-mt-capture') {
    setupTokenCapture().then(() => {
      chrome.tabs.create({ url: 'https://www.bing.com/translator', active: true });
      sendResponse({ ok: true, opened: true });
    });
    return;
  }

  if (msg.type === 'ghl10n-mt-reprobe') {
    state.ready = null;
    state.coolUntil = 0;
    ensureBingToken().then(() => {
      sendResponse({ ok: true, reachable: state.ready, provider: state.provider, lastError: state.lastError, hasToken: !!(bingToken.token && Date.now() - bingToken.at < TOKEN_TTL) });
    });
    return true;
  }

  if (msg.type !== 'ghl10n-mt') return;
  translate(String(msg.text || '')).then(sendResponse);
  return true;
});
