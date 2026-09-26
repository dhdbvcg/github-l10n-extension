/* mt.js — 人机翻译（点击「译」按钮，机翻参考插入原文旁，保留原文对照）
 * 覆盖：关于简介 / 自述文件 / 发行版简介 / 文件列表提交信息（悬浮按钮）/
 *       文件内容（许可证、贡献指南、安全政策等 blob 页）。
 * 翻译请求经 background.js 中继；结果按文本哈希缓存到 chrome.storage。
 */
'use strict';
(function () {
  if (window.__GH_L10N_MT__) return;
  window.__GH_L10N_MT__ = true;

  let enabled = true;
  const cache = new Map(); // hash -> 译文（'' 表示失败/无需翻译）
  let persistTimer = null;

  /* =========================== 工具 =========================== */
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36) + '_' + s.length.toString(36);
  }

  function loadCache() {
    if (!(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)) return;
    chrome.storage.local.get({ mtCache: {} }, (r) => {
      let dirty = false;
      for (const [k, v] of Object.entries(r.mtCache || {})) {
        // 清洗 v1.1.0 时代被持久化的引擎报错"译文"
        if (v && MT_ERROR_RE.test(v)) { dirty = true; continue; }
        cache.set(k, v);
      }
      if (dirty) {
        try { chrome.storage.local.set({ mtCache: Object.fromEntries(cache) }); } catch (e) { /* noop */ }
      }
    });
  }

  function persistCache() {
    if (!(typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local)) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      const obj = {};
      let n = 0;
      for (const [k, v] of cache) {
        if (!v || MT_ERROR_RE.test(v)) continue; // 不持久化空值/报错文案
        obj[k] = v;
        if (++n >= 800) break;
      }
      chrome.storage.local.set({ mtCache: obj });
    }, 800);
  }

  function send(msg) {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        try {
          chrome.runtime.sendMessage(msg, (r) => {
            const err = chrome.runtime.lastError;
            // Service Worker 休眠后首次唤醒可能失败：短延迟重试一次
            if (err && n < 1) { setTimeout(() => attempt(n + 1), 300); return; }
            if (err) reject(new Error(err.message));
            else resolve(r);
          });
        } catch (e) {
          if (n < 1) { setTimeout(() => attempt(n + 1), 300); return; }
          reject(e);
        }
      };
      attempt(0);
    });
  }

  const MT_ERROR_RE = /QUERY LENGTH LIMIT|MYMEMORY WARNING|INVALID (SOURCE|TARGET|LANGUAGE)|PLEASE (SELECT|USE) TWO DISTINCT|QUOTA|^HTTP \d+$|FAILED TO FETCH/i;

  /* 离线词典兜底：locals/extras/dictionary 的合并静态表（短标题优先走这里） */
  let offlineDict = null;
  function getOfflineDict() {
    if (offlineDict) return offlineDict;
    const merged = {};
    try {
      if (window.__GH_L10N_DICT__) Object.assign(merged, window.__GH_L10N_DICT__);
      if (window.__GH_EXTRAS__ && window.__GH_EXTRAS__.static) Object.assign(merged, window.__GH_EXTRAS__.static);
      const i18n = window.I18N;
      if (i18n && i18n['zh-CN'] && i18n['zh-CN'].public && i18n['zh-CN'].public.static) {
        // locals 优先级最高，放最后覆盖
        Object.assign(merged, i18n['zh-CN'].public.static);
      }
    } catch (e) { /* noop */ }
    offlineDict = merged;
    return merged;
  }

  async function mt(text) {
    const key = hash(text);
    if (cache.has(key)) {
      const v = cache.get(key);
      // 缓存命中也要过滤：报错文案绝不能当译文（修复 v1.1.0 污染缓存）
      if (v && !MT_ERROR_RE.test(v)) return v;
      if (v) { cache.delete(key); } // 命中污染条目：清除后走重新翻译
      else throw new Error('cached-fail');
    }
    const res = await send({ type: 'ghl10n-mt', text });
    if (res && res.ok && res.text) {
      // 双保险：引擎错误文案绝不作为译文展示
      if (MT_ERROR_RE.test(res.text)) {
        throw new Error('engine-error');
      }
      cache.set(key, res.text);
      persistCache();
      return res.text;
    }
    // 失败不写负缓存：下次点击可重试（v1.1.1 之前失败被永久记住导致一直无译文）
    throw new Error((res && res.error) || '翻译失败');
  }

  /* =========================== 样式 =========================== */
  const CSS = `
    .gh-l10n-mt-btn{font-size:12px;line-height:16px;padding:2px 12px;border:1px solid var(--ghl10n-border,#d0d7de);
      border-radius:20px;background:var(--ghl10n-bg,#f6f8fa);color:var(--ghl10n-fg,#57606a);cursor:pointer;flex-shrink:0}
    .gh-l10n-mt-btn:hover{background:var(--ghl10n-bg-hover,#eaeef2);color:var(--ghl10n-fg-strong,#24292f)}
    .gh-l10n-mt-btn:disabled{opacity:.5;cursor:progress}
    .gh-l10n-mt-float{position:fixed;right:20px;bottom:24px;z-index:999;padding:6px 16px;font-size:13px;
      box-shadow:0 4px 12px rgba(140,149,159,.25)}
    .gh-l10n-mt-out{margin:4px 0 8px;padding:4px 10px;border-left:3px solid var(--ghl10n-border,#d0d7de);
      color:var(--ghl10n-fg,#57606a);font-size:.92em;background:var(--ghl10n-bg,#f6f8fa);border-radius:0 6px 6px 0}
    .gh-l10n-mt-out.gh-l10n-mt-inline{display:inline-block;margin:0 0 0 8px;padding:0 8px;border:none;
      font-size:.85em;background:var(--ghl10n-bg,#f6f8fa);border-radius:6px}
    .gh-l10n-mt-tag{opacity:.6;margin-right:6px;font-size:.85em}
    .gh-l10n-mt-panel{border:1px solid var(--ghl10n-border,#d0d7de);border-radius:6px;margin:8px 0;overflow:hidden}
    .gh-l10n-mt-panel-head{padding:6px 10px;font-size:12px;color:var(--ghl10n-fg,#57606a);
      background:var(--ghl10n-bg,#f6f8fa);border-bottom:1px solid var(--ghl10n-border,#d0d7de)}
    .gh-l10n-mt-pair{padding:8px 12px;border-bottom:1px solid var(--ghl10n-border,#d0d7de)}
    .gh-l10n-mt-pair:last-child{border-bottom:none}
    .gh-l10n-mt-src{white-space:pre-wrap;word-break:break-word;max-height:9em;overflow:auto;
      color:var(--ghl10n-fg,#57606a);font-size:.85em;opacity:.75}
    .gh-l10n-mt-dst{margin-top:4px;white-space:pre-wrap;word-break:break-word}
    .gh-l10n-mt-retry{border-color:var(--ghl10n-warn,#bf8700);color:var(--ghl10n-warn,#bf8700)}
    .gh-l10n-mt-float + .gh-l10n-mt-retry{position:fixed;right:20px;bottom:72px;z-index:999}
    .gh-l10n-mt-fail{opacity:.7;font-style:italic}
    .gh-l10n-mt-hide{display:none!important}
    @media (prefers-color-scheme: dark){
      :root{--ghl10n-border:#30363d;--ghl10n-bg:#161b22;--ghl10n-bg-hover:#21262d;
        --ghl10n-fg:#8b949e;--ghl10n-fg-strong:#e6edf3}
    }`;
  function injectCss() {
    if (document.getElementById('gh-l10n-mt-style')) return;
    const st = document.createElement('style');
    st.id = 'gh-l10n-mt-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /* =========================== 目标区域 =========================== */
  const ABOUT_SEL = 'p.f4.my-3, [itemprop="about"]';
  const README_SEL = '#readme article.markdown-body, #readme .markdown-body';
  const FILELIST_SEL = '[class*="react-directory-commit-message"]';
  const BLOB_SEL = '.react-code-lines, table.highlight, .blob-wrapper';

  const AREA_TITLE = {
    about: '人机翻译：关于简介',
    readme: '人机翻译：自述文件',
    release: '人机翻译：发行版说明',
    filelist: '人机翻译：文件列表的提交信息',
    blob: '人机翻译：文件内容（许可证 / 贡献指南等）',
  };

  function isReleasesPage() { return /\/releases(\/|$)/.test(location.pathname); }
  function isBlobPage() { return /\/blob\//.test(location.pathname); }
  function isTreePage() { return /^\/[^/]+\/[^/]+(\/tree\/.*)?$/.test(location.pathname); }

  function makeBtn(area) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gh-l10n-mt-btn';
    b.dataset.area = area;
    b.textContent = '译';
    b.title = AREA_TITLE[area] || '人机翻译（机器翻译，仅供参考）';
    return b;
  }

  function makeBar(area) {
    const bar = document.createElement('div');
    bar.className = 'gh-l10n-mt-bar';
    bar.style.display = 'flex';
    bar.style.alignItems = 'center';
    bar.style.gap = '8px';
    bar.style.margin = '6px 0';
    bar.appendChild(makeBtn(area));
    return bar;
  }

  /* =========================== 注入按钮 =========================== */
  function injectButtons() {
    if (!enabled) return;

    // 关于简介（仓库侧栏）
    const about = document.querySelector(ABOUT_SEL);
    if (about && !about.parentElement.querySelector(':scope > .gh-l10n-mt-btn')) {
      about.insertAdjacentElement('afterend', makeBtn('about'));
    }

    // 自述文件（仓库首页 README）
    const readme = document.querySelector(README_SEL);
    if (readme && !readme.parentElement.querySelector(':scope > .gh-l10n-mt-bar')) {
      readme.parentElement.insertBefore(makeBar('readme'), readme);
    }

    // 发行版简介（/releases 页）
    if (isReleasesPage()) {
      document.querySelectorAll('.markdown-body').forEach((body) => {
        if (body.closest('#readme')) return;
        const prev = body.previousElementSibling;
        if (prev && prev.classList.contains('gh-l10n-mt-bar')) return;
        body.parentElement.insertBefore(makeBar('release'), body);
      });
    }

    // 文件内容（blob 页：许可证 / 贡献指南 / 安全政策等）
    if (isBlobPage()) {
      const blob = document.querySelector(BLOB_SEL);
      if (blob && blob.parentElement && !blob.parentElement.querySelector(':scope > .gh-l10n-mt-bar')) {
        blob.parentElement.insertBefore(makeBar('blob'), blob);
      }
    }

    // 文件列表提交信息（悬浮按钮）
    if (isTreePage() && document.querySelector(FILELIST_SEL) && !document.querySelector('.gh-l10n-mt-float')) {
      const float = makeBtn('filelist');
      float.classList.add('gh-l10n-mt-float');
      float.textContent = '译 提交信息';
      document.body.appendChild(float);
    }
  }

  /* =========================== 收集待翻译块 =========================== */
  const BLOCK_SEL = 'p,li,h1,h2,h3,h4,h5,h6,td,th,caption,figcaption,dt,dd,summary';

  function leafBlocks(root) {
    return [...root.querySelectorAll(BLOCK_SEL)].filter((el) =>
      !el.querySelector(BLOCK_SEL) &&
      el.textContent.trim().length > 1 &&
      !el.closest('pre, code')
    );
  }

  function makeOut(mode) {
    const d = document.createElement(mode === 'inline' ? 'span' : 'div');
    d.className = 'gh-l10n-mt-out' + (mode === 'inline' ? ' gh-l10n-mt-inline' : '');
    const tag = document.createElement('span');
    tag.className = 'gh-l10n-mt-tag';
    tag.textContent = '机翻';
    d.appendChild(tag);
    const t = document.createElement(mode === 'inline' ? 'span' : 'div');
    t.className = 'gh-l10n-mt-txt';
    d.appendChild(t);
    return d;
  }

  function makePanel() {
    const panel = document.createElement('div');
    panel.className = 'gh-l10n-mt-panel';
    const head = document.createElement('div');
    head.className = 'gh-l10n-mt-panel-head';
    head.textContent = '人机翻译（机器翻译，仅供参考）';
    panel.appendChild(head);
    return panel;
  }

  function blobText() {
    const ta = document.querySelector('#read-only-cursor-text-area');
    if (ta && ta.value) return ta.value;
    const lines = document.querySelectorAll('.react-code-lines .react-file-line, table.highlight td.blob-code');
    return [...lines].map((l) => (l.innerText || '').replace(/\n$/, '')).join('\n');
  }

  function collectJobs(area) {
    const jobs = [];
    // 无拉丁字母的段落（纯中文/纯符号/纯数字）不送翻译，避免白占并发
    const needMT = (t) => !!t && /[a-zA-Z]/.test(t);

    if (area === 'about') {
      const about = document.querySelector(ABOUT_SEL);
      if (about && !about.dataset.ghl10nDone) {
        const out = makeOut('block');
        about.insertAdjacentElement('afterend', out);
        about.dataset.ghl10nDone = '1';
        jobs.push({ el: about, out, text: about.textContent.trim() });
      }
    } else if (area === 'readme' || area === 'release') {
      const roots = area === 'readme'
        ? [...document.querySelectorAll(README_SEL)]
        : [...document.querySelectorAll('.markdown-body')].filter((r) => !r.closest('#readme'));
      for (const root of roots) {
        // 短标题（≤3 词）优先走离线词典：即使机翻引擎全挂也能出"新增/修复"
        const headings = [...root.querySelectorAll('h1,h2,h3,h4')];
        for (const h of headings) {
          if (h.dataset.ghl10nDone) continue;
          const text = h.textContent.trim();
          if (text && text.split(/\s+/).length <= 3) {
            const out = makeOut('block');
            h.insertAdjacentElement('afterend', out);
            h.dataset.ghl10nDone = '1';
            jobs.push({ el: h, out, text, dictFirst: true });
          }
        }
        for (const el of leafBlocks(root)) {
          if (el.dataset.ghl10nDone) continue;
          const text = el.textContent.trim();
          if (!needMT(text)) { el.dataset.ghl10nDone = '1'; continue; }
          const out = makeOut('block');
          el.insertAdjacentElement('afterend', out);
          el.dataset.ghl10nDone = '1';
          jobs.push({ el, out, text });
        }
      }
    } else if (area === 'filelist') {
      for (const el of document.querySelectorAll(FILELIST_SEL)) {
        if (jobs.length >= 40) break;
        if (el.dataset.ghl10nDone) continue;
        const text = el.textContent.trim();
        if (!needMT(text) || text === '…' || text === '...') continue;
        const out = makeOut('inline');
        el.insertAdjacentElement('afterend', out);
        el.dataset.ghl10nDone = '1';
        jobs.push({ el, out, text });
      }
    } else if (area === 'blob') {
      const text = blobText().trim();
      if (!text) return jobs;
      const blob = document.querySelector(BLOB_SEL);
      const host = blob && blob.parentElement ? blob.parentElement : document.body;
      // 重复点击/重试时先清掉旧面板，避免多份对照面板叠加
      [...host.children].forEach((c) => { if (c.classList && c.classList.contains('gh-l10n-mt-panel')) c.remove(); });
      const panel = makePanel();
      host.appendChild(panel);
      const chunks = text.split(/\n{2,}/).map((c) => c.trim()).filter(needMT).slice(0, 60);
      for (const chunk of chunks) {
        const pair = document.createElement('div');
        pair.className = 'gh-l10n-mt-pair';
        const src = document.createElement('div');
        src.className = 'gh-l10n-mt-src';
        src.textContent = chunk;
        const dst = document.createElement('div');
        dst.className = 'gh-l10n-mt-dst gh-l10n-mt-txt';
        dst.textContent = '…';
        pair.appendChild(src);
        pair.appendChild(dst);
        panel.appendChild(pair);
        jobs.push({ out: pair, text: chunk });
      }
    }
    return jobs;
  }

  /* =========================== 执行翻译 =========================== */
  async function pool(items, limit, fn) {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) || 1 }, async () => {
      while (i < items.length) {
        const item = items[i++];
        await fn(item);
      }
    });
    await Promise.all(workers);
  }

  async function runJobs(btn, jobs) {
    const total = jobs.length;
    let done = 0;
    let failed = 0;
    let lastError = '';
    // 累积已有译文（重试失败段时不清空先前成功的部分）
    const outs = Array.isArray(btn._outs) ? btn._outs.slice() : [];
    const dict = getOfflineDict();
    // 同一批里内容完全相同的段落共享一次翻译请求（发行版说明常见重复句式）
    const shared = new Map();
    const translateShared = (text) => {
      if (!shared.has(text)) shared.set(text, mt(text));
      return shared.get(text);
    };
    btn.textContent = '译 0/' + total;
    await pool(jobs, 2, async (job) => {
      try {
        // 短标题等 dictFirst 任务：离线词典能翻就直接用，不请求引擎
        const dictHit = job.dictFirst && dict[job.text];
        const t = typeof dictHit === 'string' && dictHit ? dictHit : await translateShared(job.text);
        job.out.querySelector('.gh-l10n-mt-txt').textContent = t;
        outs.push(job.out);
      } catch (e) {
        failed++;
        lastError = String((e && e.message) || e);
        // blob 对照面板：保留原文，只把译文位置标记失败（整对删掉会让原文一起消失）
        const srcEl = job.out.querySelector && job.out.querySelector('.gh-l10n-mt-src');
        const dstEl = job.out.querySelector && job.out.querySelector('.gh-l10n-mt-txt');
        if (srcEl && dstEl) {
          dstEl.textContent = '（翻译失败）';
          dstEl.classList.add('gh-l10n-mt-fail');
        } else {
          job.out.remove();
        }
        // 失败不锁死：清掉完成标记，下次点击可重试该段
        if (job.el) delete job.el.dataset.ghl10nDone;
      } finally {
        done++;
        btn.textContent = '译 ' + done + '/' + total;
      }
    });
    btn._outs = outs;

    if (outs.length) {
      btn.textContent = '收起翻译';
      btn.dataset.state = 'done';
      btn.dataset.collapsed = '0';
      if (failed) {
        btn.title = '有 ' + failed + ' 段失败：' + lastError;
        showRetry(btn, failed);
      } else {
        btn.title = AREA_TITLE[btn.dataset.area] || '人机翻译（机器翻译，仅供参考）';
        hideRetry(btn);
      }
    } else {
      // 全部失败：按钮回到可重试状态，并把原因挂到 title 上
      btn.textContent = btn.classList.contains('gh-l10n-mt-float') ? '译 提交信息' : '译';
      btn.title = '翻译失败：' + (lastError || '未知原因') + '（可再次点击重试）';
    }
  }

  /* 失败提示：在被点按钮后挂一个「重试失败」小按钮，只补翻未完成段落 */
  function showRetry(btn, failed) {
    let retry = btn.nextElementSibling;
    if (!retry || !retry.classList || !retry.classList.contains('gh-l10n-mt-retry')) {
      retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'gh-l10n-mt-btn gh-l10n-mt-retry';
      retry.title = '只重新翻译失败的段落';
      btn.insertAdjacentElement('afterend', retry);
    }
    retry.textContent = '重试失败 (' + failed + ')';
    retry._owner = btn;
  }

  function hideRetry(btn) {
    const n = btn.nextElementSibling;
    if (n && n.classList && n.classList.contains('gh-l10n-mt-retry')) n.remove();
  }

  async function handle(btn) {
    const area = btn.dataset.area;
    if (btn.dataset.state === 'done') {
      // 用状态位判断，而不是按钮文案（文案会随失败计数变化）
      const hiding = btn.dataset.collapsed !== '1';
      (btn._outs || []).forEach((o) => o.classList.toggle('gh-l10n-mt-hide', hiding));
      const retry = btn.nextElementSibling;
      if (retry && retry.classList && retry.classList.contains('gh-l10n-mt-retry')) {
        retry.classList.toggle('gh-l10n-mt-hide', hiding);
      }
      btn.dataset.collapsed = hiding ? '1' : '0';
      btn.textContent = hiding ? '显示翻译' : '收起翻译';
      return;
    }
    btn.disabled = true;
    try {
      const jobs = collectJobs(area);
      if (!jobs.length) {
        btn.textContent = '无内容';
        setTimeout(() => { btn.textContent = btn.classList.contains('gh-l10n-mt-float') ? '译 提交信息' : '译'; }, 1500);
        return;
      }
      await runJobs(btn, jobs);
    } finally {
      btn.disabled = false;
    }
  }

  /* =========================== 事件与调度 =========================== */
  document.addEventListener('click', (ev) => {
    const retry = ev.target.closest('.gh-l10n-mt-retry');
    if (retry && retry._owner) {
      ev.preventDefault();
      ev.stopPropagation();
      // 只补翻失败段落：成功段已带 ghl10nDone 标记，collectJobs 会自动跳过
      retry._owner.dataset.state = '';
      retry.remove();
      handle(retry._owner);
      return;
    }
    const btn = ev.target.closest('.gh-l10n-mt-btn');
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation();
    handle(btn);
  }, true);

  let scanPending = false;
  function scanAll() {
    if (!enabled || scanPending) return;
    scanPending = true;
    requestAnimationFrame(() => {
      scanPending = false;
      try { injectButtons(); } catch (e) { /* noop */ }
    });
  }

  function removeAll() {
    document.querySelectorAll('.gh-l10n-mt-btn, .gh-l10n-mt-out, .gh-l10n-mt-panel, .gh-l10n-mt-bar, .gh-l10n-mt-retry')
      .forEach((e) => e.remove());
    document.querySelectorAll('[data-ghl10n-done]').forEach((e) => { delete e.dataset.ghl10nDone; });
  }

  const OUR_CLASS = /gh-l10n-mt-(btn|out|panel)/;
  const mo = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && !OUR_CLASS.test(n.className || '')) {
          scanAll();
          return;
        }
      }
    }
  });

  function start() {
    injectCss();
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ mtEnabled: true }, (r) => {
        enabled = r.mtEnabled !== false;
        if (enabled) scanAll();
      });
      if (chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local' || !changes.mtEnabled) return;
          enabled = changes.mtEnabled.newValue !== false;
          if (enabled) scanAll();
          else removeAll();
        });
      }
    }
    loadCache();
    if (document.body) {
      mo.observe(document.body, { childList: true, subtree: true });
      scanAll();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        mo.observe(document.body, { childList: true, subtree: true });
        scanAll();
      }, { once: true });
    }
    document.addEventListener('turbo:load', scanAll);
    document.addEventListener('turbo:frame-render', scanAll);
    window.addEventListener('popstate', scanAll);
  }

  start();
})();
