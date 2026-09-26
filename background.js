/* background.js — MV3 Service Worker：人机翻译中继
 * 内容脚本受 CORS 限制无法直接调用翻译接口，由后台统一转发。
 * 引擎：Google 翻译公开端点（主）→ MyMemory（备）。免费无需密钥。
 * v1.1.1：切块算法保证任何分片都不超引擎上限；识别引擎错误文本（不当作译文）；
 *         请求超时 + gtx 429/5xx 重试。
 */
'use strict';

const FETCH_TIMEOUT = 15000;

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

function isMostlyChinese(t) {
  const cjk = (t.match(/[一-鿿]/g) || []).length;
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

/* 切块：保证输出的每个分片长度都 ≤ max（先按段落聚合，超长段落按句子，再按硬上限切） */
function splitChunks(text, max) {
  const src = String(text || '');
  if (src.length <= max) return [src];
  const out = [];
  let cur = '';
  const pushCur = () => { if (cur.trim()) out.push(cur); cur = ''; };

  const addPiece = (piece) => {
    if (!piece) return;
    if (piece.length > max) {
      // 单段超限：按句子边界切
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

async function trChunk(engine, chunk) {
  let lastErr = null;
  for (let attempt = 0; attempt <= (engine.retries || 0); attempt++) {
    try {
      const res = await fetchWithTimeout(engine.url(chunk), FETCH_TIMEOUT);
      if (!res.ok) throw new Error(engine.name + ' HTTP ' + res.status);
      const data = await res.json();
      const { text, srcLang } = engine.parse(data);
      if (!text) throw new Error(engine.name + ' 空结果');
      if (srcLang.startsWith('zh')) return { unchanged: true, text: chunk };
      return { unchanged: false, text };
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || e);
      // 429/5xx 等临时错误：等待后重试一次
      if (attempt < (engine.retries || 0)) await sleep(900);
      if (/abort|timeout/i.test(msg)) break; // 超时不重试，直接换引擎
    }
  }
  throw lastErr || new Error(engine.name + ' failed');
}

async function translate(text) {
  if (isMostlyChinese(text)) return { ok: false, error: '原文无需翻译' };
  const errors = [];
  for (const engine of ENGINES) {
    try {
      const chunks = splitChunks(text, engine.max);
      let out = '';
      let unchanged = 0;
      for (const chunk of chunks) {
        const r = await trChunk(engine, chunk);
        if (r.unchanged) unchanged++;
        out += r.text;
      }
      const trimmed = out.trim();
      if (!trimmed || unchanged === chunks.length) return { ok: false, error: '原文无需翻译' };
      return { ok: true, text: trimmed, engine: engine.name };
    } catch (e) {
      errors.push(String((e && e.message) || e));
    }
  }
  return { ok: false, error: errors.join(' / ') };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'ghl10n-mt') return;
  translate(String(msg.text || '')).then(sendResponse);
  return true; // 异步 sendResponse
});
