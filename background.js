/* background.js — MV3 Service Worker：人机翻译中继
 * 内容脚本受 CORS 限制无法直接调用翻译接口，由后台统一转发。
 * 引擎：Google 翻译公开端点（主）→ MyMemory（备）。免费无需密钥。
 */
'use strict';

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
  },
  {
    name: 'mymemory',
    max: 450,
    url: (q) => 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(q) + '&langpair=en|zh-CN',
    parse: (data) => ({
      text: String((data && data.responseData && data.responseData.translatedText) || ''),
      srcLang: '',
    }),
  },
];

function isMostlyChinese(t) {
  const cjk = (t.match(/[一-鿿]/g) || []).length;
  const body = t.replace(/\s/g, '');
  return cjk >= 4 && cjk > body.length * 0.5;
}

/* 长文本切块：按行聚合，超长单行按句子/空格硬切 */
function splitChunks(text, max) {
  const src = String(text || '');
  if (src.length <= max) return [src];
  const out = [];
  let cur = '';
  for (const line of src.split('\n')) {
    if (cur && (cur + line + '\n').length > max) {
      out.push(cur);
      cur = '';
    }
    cur += line + '\n';
    while (cur.length > max * 2) {
      let cut = cur.lastIndexOf('. ', max);
      if (cut < max * 0.5) cut = cur.indexOf(' ', max);
      if (cut < 0) cut = max;
      out.push(cur.slice(0, cut + 1));
      cur = cur.slice(cut + 1);
    }
  }
  if (cur.trim()) out.push(cur);
  return out.length ? out : [src];
}

async function trVia(engine, chunk) {
  const res = await fetch(engine.url(chunk), { credentials: 'omit' });
  if (!res.ok) throw new Error(engine.name + ' HTTP ' + res.status);
  const data = await res.json();
  const { text, srcLang } = engine.parse(data);
  if (!text) throw new Error(engine.name + ' 空结果');
  if (srcLang.startsWith('zh')) return { unchanged: true, text: chunk };
  return { unchanged: false, text };
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
        const r = await trVia(engine, chunk);
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
