/* background.js — MV3 Service Worker：人机翻译中继
 * 内容脚本受 CORS 限制无法直接调用翻译接口，由后台统一转发。
 * 引擎：Google 翻译公开端点（主）→ MyMemory（备）。免费无需密钥。
 *
 * v1.1.3 优化：
 *  1. 分片并行翻译（限流 3），长文本等待时间约降为 1/3；结果按原顺序拼接
 *  2. 引擎健康度记忆：连续失败/硬错误（4xx/5xx/超时）后冷却 60s，避免每段都撞已挂的引擎
 *  3. 请求去重：同一文本并发请求合并为一次（多按钮/多段命中同一句时常见）
 *  4. 错误信息聚合：返回可读的引擎失败摘要，便于前端展示与排查
 */
'use strict';

const FETCH_TIMEOUT = 15000;
const PARALLEL = 3;          // 单引擎内并行分片数
const COOLDOWN_MS = 60000;   // 引擎失败冷却时长
const HARD_FAILS = 3;        // 连续软失败达到该次数进入冷却

const ENGINES = [
  {
    name: 'gtx',
    max: 1200,
    url: (q) => 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=zh-CN&q=' + encodeURIComponent(q),
    parse: (data) => {
      const srcLang = String((data && data[2]) || '').toLowerCase();
      const txt = ((data && data[0]) || []).map((seg) => (seg && seg[0]) || '').join('');
      return { text: txt, srcLang };
    },
    retries: 1,
  },
  {
    name: 'mymemory',
    max: 450,
    url: (q) => 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=en|zh-CN',
    parse: (data) => {
      const status = data && data.responseStatus;
      const text = String((data && data.responseData && data.responseData.translatedText) || '');
      // MyMemory 出错时常返回 HTTP 200 + 错误文案，必须识别为失败
      if (status != null && Number(status) !== 200) {
        throw new Error('mymemory status ' + status);
      }
      if (/QUERY LENGTH LIMIT|MYMEMORY WARNING|INVALID (SOURCE|TARGET|LANGUAGE)|PLEASE (SELECT|USE) TWO DISTINCT/i.test(text)) {
        throw new Error('mymemory rejected: ' + text.slice(0, 60));
      }
      return { text, srcLang: '' };
    },
    retries: 0,
  },
];

/* =========================== 引擎健康度 =========================== */
const engineHealth = new Map(); // name -> { fails, until, lastError }

function isCooling(engine) {
  const h = engineHealth.get(engine.name);
  return !!(h && h.until && h.until > Date.now());
}

function markFail(engine, err, hard) {
  const h = engineHealth.get(engine.name) || { fails: 0, until: 0, lastError: '' };
  h.fails += 1;
  h.lastError = String((err && err.message) || err).slice(0, 120);
  if (hard || h.fails >= HARD_FAILS) {
    h.until = Date.now() + COOLDOWN_MS;
    h.fails = 0;
  }
  engineHealth.set(engine.name, h);
}

function markOk(engine) {
  engineHealth.set(engine.name, { fails: 0, until: 0, lastError: '' });
}

/* 冷却中的引擎排在最后；全冷却时仍按原顺序尝试（不放弃） */
function orderedEngines() {
  return ENGINES.slice().sort((a, b) => Number(isCooling(a)) - Number(isCooling(b)));
}

/* =========================== 请求去重 =========================== */
const inflight = new Map(); // text -> Promise<result>

/* =========================== 工具 =========================== */
function isMostlyChinese(t) {
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const body = t.replace(/\s/g, '');
  return cjk >= 4 && cjk > body.length * 0.5;
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { credentials: 'omit', signal: ctrl.signal });
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

/* 单个分片：带重试，返回 { unchanged, text } 或抛错 */
async function trChunk(engine, chunk) {
  let lastErr = null;
  for (let attempt = 0; attempt <= (engine.retries || 0); attempt++) {
    try {
      const res = await fetchWithTimeout(engine.url(chunk), FETCH_TIMEOUT);
      if (!res.ok) {
        const e = new Error(engine.name + ' HTTP ' + res.status);
        e.hard = res.status >= 400 && res.status < 500 || res.status >= 500;
        throw e;
      }
      const data = await res.json();
      const { text, srcLang } = engine.parse(data);
      if (!text) throw new Error(engine.name + ' 空结果');
      if (srcLang.startsWith('zh')) return { unchanged: true, text: chunk };
      return { unchanged: false, text };
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      if (/abort|timeout/i.test(msg)) { lastErr.hard = true; break; } // 超时不重试，直接换引擎
      if (attempt < (engine.retries || 0)) await sleep(900);
    }
  }
  throw lastErr || new Error(engine.name + ' failed');
}

/* 并行翻译全部分片：顺序由索引保证，任一失败则整体抛出（交由上层换引擎） */
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
  const engines = orderedEngines();

  for (const engine of engines) {
    let chunks;
    try {
      chunks = splitChunks(text, engine.max);
    } catch (e) {
      errors.push(engine.name + ': 切块失败');
      continue;
    }
    try {
      const { text: out, unchanged } = await trAllChunks(engine, chunks);
      const trimmed = String(out || '').trim();
      if (!trimmed || unchanged === chunks.length) return { ok: false, error: '原文无需翻译' };
      markOk(engine);
      return { ok: true, text: trimmed, engine: engine.name, chunks: chunks.length };
    } catch (e) {
      markFail(engine, e, !!(e && e.hard));
      errors.push(engine.name + ': ' + String((e && e.message) || e));
    }
  }

  return { ok: false, error: errors.join(' | ') || '全部引擎失败' };
}

/* 并发去重：相同文本的并发请求只真正翻译一次 */
function translate(text) {
  const src = String(text || '');
  if (inflight.has(src)) return inflight.get(src);
  const p = translateOnce(src).finally(() => { inflight.delete(src); });
  inflight.set(src, p);
  return p;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;
  // 诊断用：查询引擎健康度（不入业务路径）
  if (msg.type === 'ghl10n-mt-health') {
    const out = {};
    for (const e of ENGINES) {
      const h = engineHealth.get(e.name);
      out[e.name] = h
        ? { cooling: isCooling(e), fails: h.fails, lastError: h.lastError }
        : { cooling: false, fails: 0, lastError: '' };
    }
    sendResponse({ ok: true, engines: out, inflight: inflight.size });
    return;
  }
  if (msg.type !== 'ghl10n-mt') return;
  translate(String(msg.text || '')).then(sendResponse);
  return true; // 异步 sendResponse
});
