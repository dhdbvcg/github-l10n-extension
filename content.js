/* content.js — GitHub 中文化内容脚本
 * 算法移植自「GitHub 中文化插件」(maboloshi/github-chinese, GPL-3.0)，
 * 适配 Chrome 扩展：词库 = locals.js(I18N) + extras.js(补充) + dictionary.js(补充)，
 * 设置读取改用 chrome.storage，去除 GM API 与远程机器翻译。
 */
(function (window, document, undefined) {
  'use strict';
  if (window.__GH_L10N_ACTIVE__) return;
  window.__GH_L10N_ACTIVE__ = true;

  /* =========================== 全局配置常量 =========================== */
  const CONFIG = {
    LANG: 'zh-CN',
    DEV: false,
    PAGE_MAP: {
      'gist.github.com': 'gist',
      'www.githubstatus.com': 'status',
      'skills.github.com': 'skills',
      'education.github.com': 'education'
    },
    SPECIAL_SITES: ['gist', 'status', 'skills', 'education'],
    OBSERVER_CONFIG: {
      childList: true,
      subtree: true,
      characterData: true,
      attributeFilter: ['value', 'placeholder', 'aria-label', 'data-confirm']
    }
  };

  const EXTRAS = window.__GH_EXTRAS__ || {};
  const RELATIVE_TIME_PATTERNS = EXTRAS.relativeTimePatterns || [];

  /* =========================== 日志工具 =========================== */
  const LOG_PREFIX = '[GitHub 中文化插件]';
  const log = (...args) => { if (CONFIG.DEV) console.log(LOG_PREFIX, ...args); };
  const warn = (...args) => { console.warn(LOG_PREFIX, ...args); };
  const error = (...args) => { console.error(LOG_PREFIX, ...args); };

  function safe(fn, label) {
    return function (...args) {
      try {
        return fn.apply(this, args);
      } catch (e) {
        error(`${label} 出错:`, e);
      }
    };
  }

  /* =========================== 状态管理器 =========================== */
  const State = {
    featureSet: {
      enable_RegExp: true,
    },
    settings: { enabled: true, translateTitle: true },
    pageConfig: null,
    currentURL: window.location.href,
    mutationObserver: null,
    initDone: false,
  };

  /* =========================== 词库合并 =========================== */
  function mergeExtraTranslations() {
    const locale = I18N[CONFIG.LANG];
    if (!locale || typeof locale !== 'object') return;

    if (!locale.public) locale.public = {};
    if (!locale.public.static || typeof locale.public.static !== 'object') {
      locale.public.static = {};
    }
    const publicStatic = locale.public.static;

    // 顺序：locals.js 优先，其次 extras.js 参考词条，最后 dictionary.js 本插件补充
    const dicts = [EXTRAS.static || {}, window.__GH_L10N_DICT__ || {}];
    for (const dict of dicts) {
      for (const [source, target] of Object.entries(dict)) {
        if (!(source in publicStatic)) publicStatic[source] = target;
      }
    }

    if (!Array.isArray(locale.public.regexp)) locale.public.regexp = [];
    const existingPatterns = new Set(
      locale.public.regexp.map(rule => rule[0] && rule[0].toString())
    );
    for (const rule of (EXTRAS.regexp || [])) {
      const key = rule[0] && rule[0].toString();
      if (key && !existingPatterns.has(key)) {
        locale.public.regexp.push(rule);
        existingPatterns.add(key);
      }
    }
  }

  /* =========================== 安全检查 =========================== */
  function checkI18NLoaded() {
    if (typeof I18N === 'undefined') {
      error('词库文件 locals.js 未加载，插件无法运行！');
      throw new Error('[GitHub 中文化插件] 词库文件 locals.js 未加载');
    }
  }

  /* =========================== 初始化入口 =========================== */
  function init() {
    try {
      checkI18NLoaded();
      mergeExtraTranslations();
      setupReactGlobalNavTranslation();
      initLangEnv();
      setupInitTrans();
      setupTurboEvents();
      State.initDone = true;
      log('初始化完成');
    } catch (e) {
      error('初始化失败:', e);
    }
  }

  function initLangEnv() {
    document.documentElement.lang = CONFIG.LANG;
    const langObserver = new MutationObserver(() => {
      if (document.documentElement.lang === 'en') {
        document.documentElement.lang = CONFIG.LANG;
      }
    });
    langObserver.observe(document.documentElement, { attributeFilter: ['lang'] });
  }

  function setupInitTrans() {
    function doInitTrans() {
      updatePageConfig('首次载入');
      if (State.pageConfig) safe(traverseNode, '首次遍历')(document.body);
      setupMutationObserver();
    }

    const scheduleDirectPatches = () => {
      safe(applyDirectTextPatches, '直接文本补丁-立即')();
      [0, 300, 800, 1500].forEach(delay => {
        window.setTimeout(() => safe(applyDirectTextPatches, '直接文本补丁-延迟')(), delay);
      });
    };

    const ready = () => {
      doInitTrans();
      applyDirectPlaceholderPatches();
      scheduleDirectPatches();
      // 兜底：定期翻译输入框占位符（弹层/面板晚渲染场景）+ 聚焦时立即翻译
      window.setInterval(() => safe(applyDirectPlaceholderPatches, '占位符定时')(), 1500);
      document.addEventListener('focusin', (e) => {
        const el = e.target;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          safe(applyDirectPlaceholderPatches, '占位符聚焦')();
        }
      }, true);
    };

    if (document.readyState === 'interactive' || document.readyState === 'complete') {
      ready();
    } else {
      window.addEventListener('DOMContentLoaded', ready, { once: true });
    }
  }

  /* =========================== Turbo 事件 =========================== */
  function setupTurboEvents() {
    document.addEventListener('turbo:load', handleTurboLoad);
    document.addEventListener('turbo:frame-render', () => {
      safe(applyDirectTextPatches, 'turbo-frame-render 直接文本补丁')();
      safe(applyDirectPlaceholderPatches, 'turbo-frame-render 占位符补丁')();
    });
  }

  function handleTurboLoad() {
    if (!State.pageConfig) return;
    transTitle();
    transBySelector();
    applyDirectPlaceholderPatches();
    safe(applyDirectTextPatches, 'turbo-load 直接文本补丁')();
  }

  function applyDirectPlaceholderPatches() {
    if (!document.body) return;
    const nodes = document.querySelectorAll('input, textarea');
    nodes.forEach(node => {
      // 1) 专用补丁优先
      const text = node.placeholder;
      if (text) {
        let patched = false;
        for (const { pattern, replacement } of (EXTRAS.placeholderPatches || [])) {
          if (pattern.test(text)) {
            node.placeholder = replacement;
            patched = true;
            break;
          }
        }
        // 2) 词典/正则通用翻译（input/textarea 被全局忽略规则排除在遍历之外，这里兜底）
        if (!patched) {
          const result = transText(text);
          if (result) node.placeholder = result;
        }
      }
      // 3) 按钮型 value 与确认文案
      if (node.tagName === 'INPUT') {
        if (['button', 'submit', 'reset'].includes(node.type) && node.value) {
          const result = transText(node.value);
          if (result) node.value = result;
        }
        if (node.dataset && node.dataset.confirm) {
          const result = transText(node.dataset.confirm);
          if (result) node.dataset.confirm = result;
        }
      }
    });
  }

  function xpathStringLiteral(s) {
    if (!s.includes("'")) return `"${s}"`;
    const parts = s.split("'");
    return `concat('${parts.join("', \"'\", '")}')`;
  }

  function applyDirectTextPatches() {
    if (!document.body) return;

    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH', 'CODE', 'PRE', 'KBD', 'SAMP']);
    const SKIP_CLOSEST = 'script, style, noscript, svg, code, pre, kbd, samp';

    for (const { text, replacement } of (EXTRAS.directTextPatches || [])) {
      const literal = xpathStringLiteral(text);

      try {
        const textSnapshot = document.evaluate(
          `//text()[normalize-space(.)=${literal}]`,
          document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
        );
        for (let i = 0; i < textSnapshot.snapshotLength; i++) {
          const node = textSnapshot.snapshotItem(i);
          if (!node || node.nodeType !== Node.TEXT_NODE) continue;
          const parent = node.parentElement;
          if (parent && (SKIP_TAGS.has(parent.tagName) || parent.closest?.(SKIP_CLOSEST))) continue;
          if (node.data.trim() === text || node.data.replace(/\xa0|[\s]+/g, ' ').trim() === text) {
            const m = node.data.match(/^(\s*)([\s\S]*?)(\s*)$/);
            node.data = m ? (m[1] + replacement + m[3]) : replacement;
          }
        }
      } catch (e) {
        log('[直接文本补丁] 文本节点替换失败:', text, e);
      }

      try {
        const elemSnapshot = document.evaluate(
          `//*[not(self::script or self::style or self::noscript or self::svg or self::path or self::code or self::pre or self::kbd or self::samp)]` +
          `[normalize-space(.)=${literal} and not(*)]`,
          document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
        );
        for (let i = 0; i < elemSnapshot.snapshotLength; i++) {
          const el = elemSnapshot.snapshotItem(i);
          if (!el) continue;
          if (el.textContent.replace(/\xa0|[\s]+/g, ' ').trim() === text) {
            el.textContent = replacement;
          }
        }
      } catch (e) {
        log('[直接文本补丁] 叶子元素替换失败:', text, e);
      }
    }
  }

  /* =========================== 页面配置管理 =========================== */
  function updatePageConfig(trigger) {
    const newType = detectPageType();
    if (!newType) {
      if (State.pageConfig?.currentPageType !== '__fallback__') {
        State.pageConfig = buildFallbackPageConfig();
      }
    } else if (newType !== State.pageConfig?.currentPageType) {
      State.pageConfig = buildPageConfig(newType);
    }
    log(`${trigger}触发, 页面类型为 ${State.pageConfig?.currentPageType}`);
  }

  function buildPageConfig(pageType) {
    const locale = I18N[CONFIG.LANG];
    return {
      currentPageType: pageType,
      currentPath: window.location.pathname,
      titleStaticDict: locale[pageType]?.title?.static || {},
      titleRegexpRules: locale[pageType]?.title?.regexp || [],
      staticDict: {
        ...locale.public.static,
        ...(locale[pageType]?.static || {})
      },
      regexpRules: [
        ...(locale[pageType]?.regexp || []),
        ...(locale.public.regexp || [])
      ],
      ignoreMutationSelectors: [
        ...(I18N.conf.ignoreMutationSelectorPage['*'] || []),
        ...(I18N.conf.ignoreMutationSelectorPage[pageType] || [])
      ].join(', '),
      ignoreSelectors: [
        ...(I18N.conf.ignoreSelectorPage['*'] || []),
        ...(I18N.conf.ignoreSelectorPage[pageType] || [])
      ].join(', '),
      characterData: (I18N.conf.characterDataPage || []).includes(pageType),
      transSelectors: [
        ...(locale.public.selector || []),
        ...(locale[pageType]?.selector || [])
      ],
    };
  }

  function buildFallbackPageConfig() {
    const locale = I18N[CONFIG.LANG];
    return {
      currentPageType: '__fallback__',
      currentPath: window.location.pathname,
      titleStaticDict: {},
      titleRegexpRules: [],
      staticDict: { ...locale.public.static },
      regexpRules: [...(locale.public.regexp || [])],
      ignoreMutationSelectors: [
        ...(I18N.conf.ignoreMutationSelectorPage['*'] || [])
      ].join(', '),
      ignoreSelectors: [
        ...(I18N.conf.ignoreSelectorPage['*'] || [])
      ].join(', '),
      characterData: false,
      transSelectors: [...(locale.public.selector || [])],
    };
  }

  /* =========================== 页面类型检测 =========================== */
  function detectPageType() {
    const url = new URL(window.location.href);
    const { PAGE_MAP, SPECIAL_SITES } = CONFIG;
    const { hostname, pathname } = url;

    const site = PAGE_MAP[hostname] || 'github';
    const isLogin = document.body.classList.contains('logged-in');
    const metaLocation = document.head.querySelector('meta[name="analytics-location"]')?.content || '';

    const isSession = document.body.classList.contains('session-authentication');
    const isHomepage = pathname === '/' && site === 'github';
    const isProfile = document.body.classList.contains('page-profile') || metaLocation === '/<user-name>';
    const isRepository = /\/<user-name>\/<repo-name>/.test(metaLocation);
    const isOrganization = /\/<org-login>/.test(metaLocation) || /^\/(?:orgs|organizations)/.test(pathname);

    let pageType;
    switch (true) {
      case isSession:
        pageType = 'session-authentication';
        break;
      case SPECIAL_SITES.includes(site):
        pageType = site;
        break;
      case isProfile: {
        const tabParam = new URLSearchParams(url.search).get('tab');
        pageType = pathname.includes('/stars') ? 'page-profile/stars'
          : tabParam ? `page-profile/${tabParam}`
            : 'page-profile';
        break;
      }
      case isHomepage:
        pageType = isLogin ? 'dashboard' : 'homepage';
        break;
      case isRepository: {
        const repoMatch = pathname.match(I18N.conf.rePagePathRepo);
        pageType = repoMatch ? `repository/${repoMatch[1]}` : 'repository';
        break;
      }
      case isOrganization: {
        const orgMatch = pathname.match(I18N.conf.rePagePathOrg);
        pageType = orgMatch ? `orgs/${orgMatch[1] || orgMatch.slice(-1)[0]}` : 'orgs';
        break;
      }
      default: {
        const pathMatch = pathname.match(I18N.conf.rePagePath);
        pageType = pathMatch ? (pathMatch[1] || pathMatch.slice(-1)[0]) : false;
      }
    }

    if (pageType === false || !I18N[CONFIG.LANG]?.[pageType]) {
      if (CONFIG.DEV) {
        const reason = pageType === false
          ? '路径未匹配任何页面规则'
          : `词库中缺少 "${pageType}" 的翻译`;
        warn('[i18n]', reason, { url: window.location.href, hostname, pathname, site, pageType, isLogin, metaLocation });
      }
      return false;
    }

    return pageType;
  }

  /* =========================== React 头部翻译补丁 =========================== */
  function isReactGlobalNavPortalNode(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    const portalRoot = element?.closest?.('#__primerPortalRoot__');
    if (!portalRoot) return false;

    const portal = element.closest?.('[data-component="Portal"]')
      || element.querySelector?.('[data-component="Portal"]')
      || portalRoot;
    if (portal.matches?.('#search-suggestions-dialog')
      || portal.querySelector?.('#search-suggestions-dialog')) return true;

    const referenceAttributes = ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns'];
    const referenceElements = [
      portal,
      ...portal.querySelectorAll?.(
        referenceAttributes.map(attribute => `[${attribute}]`).join(', ')
      ) || [],
    ];

    for (const referenceElement of referenceElements) {
      for (const attribute of referenceAttributes) {
        const ids = referenceElement.getAttribute?.(attribute)?.split(/\s+/) || [];
        if (ids.some(id => document.getElementById(id)?.closest?.('header.GlobalNav'))) {
          return true;
        }
      }
    }

    const portalIds = new Set([
      portal.id,
      ...Array.from(portal.querySelectorAll?.('[id]') || [], item => item.id),
    ].filter(Boolean));
    if (portalIds.size) {
      const headerReferences = document.querySelectorAll(
        'header.GlobalNav [aria-describedby], header.GlobalNav [aria-controls], header.GlobalNav [aria-owns]'
      );
      for (const headerReference of headerReferences) {
        for (const attribute of ['aria-describedby', 'aria-controls', 'aria-owns']) {
          const ids = headerReference.getAttribute(attribute)?.split(/\s+/) || [];
          if (ids.some(id => portalIds.has(id))) return true;
        }
      }
    }

    const hasControlledSurface = portal.matches?.('[role="menu"], [role="dialog"], [role="tooltip"]')
      || portal.querySelector?.('[role="menu"], [role="dialog"], [role="tooltip"]');
    return !!hasControlledSurface
      && !!document.activeElement?.closest?.('header.GlobalNav, qbsearch-input');
  }

  function setupReactGlobalNavTranslation() {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    const labels = I18N.conf.reactGlobalNavLabels || {};

    const reactGlobalNavLookup = (function buildGlobalNavLookup() {
      const locale = I18N[CONFIG.LANG] || I18N.zh || I18N['zh-CN'];
      const staticMap = new Map();
      const regexpRules = [];
      if (locale) {
        for (const section of Object.values(locale)) {
          if (section && typeof section.static === 'object') {
            for (const [k, v] of Object.entries(section.static)) {
              if (typeof v === 'string' && v && v !== k && !staticMap.has(k)) {
                staticMap.set(k, v);
              }
            }
          }
          if (section && Array.isArray(section.regexp)) {
            regexpRules.push(...section.regexp);
          }
        }
      }
      return { staticMap, regexpRules };
    })();

    const dataContentLabelSelector = 'header.GlobalNav [data-component="text"][data-content]';
    const portalSurfaceSelector = '#__primerPortalRoot__ [role="menu"], #__primerPortalRoot__ [role="dialog"], #__primerPortalRoot__ [role="tooltip"]';
    const searchSurfaceSelector = 'qbsearch-input';
    const searchModuleSelector = 'header.GlobalNav [class*="Search-module__"]';
    const unsafeTextSelector = [
      'textarea',
      '[contenteditable="true"]',
      'code',
      'pre',
      'kbd',
      'svg',
      'img',
      'canvas',
      'video',
    ].join(', ');
    const searchSelector = `${searchModuleSelector}, ${searchSurfaceSelector}, #__primerPortalRoot__ [role="dialog"]`;
    const translatableAttributeNames = ['title', 'aria-label', 'data-visible-text', 'placeholder'];

    const reactGlobalNavIdleMs = 700;
    const reactGlobalNavRetryMs = 400;

    let timer = null;
    let headerObserver = null;
    let lastReactGlobalNavMutationAt = Date.now();
    let lastReactGlobalNavPortalMutationAt = Date.now();
    const observedSurfaces = new WeakSet();

    function isReactGlobalNavSearchActive() {
      const active = document.activeElement;
      return !!active?.closest?.(searchSelector)
        || !!document.querySelector('#__primerPortalRoot__ [role="dialog"]');
    }

    function isReactGlobalNavSurfaceIdle(surfaceType = 'header') {
      const lastMutationAt = surfaceType === 'portal'
        ? lastReactGlobalNavPortalMutationAt
        : lastReactGlobalNavMutationAt;
      return Date.now() - lastMutationAt >= reactGlobalNavIdleMs;
    }

    function canTranslateReactGlobalNavHeader() {
      return document.readyState === 'complete'
        && isReactGlobalNavSurfaceIdle('header')
        && !isReactGlobalNavSearchActive();
    }

    function findStaticGlobalNavLabel(source) {
      return reactGlobalNavLookup.staticMap.get(source) || null;
    }

    function findRegexpGlobalNavLabel(source) {
      for (const [pattern, replacement] of reactGlobalNavLookup.regexpRules) {
        const match = source.match(pattern);
        if (!match || match.index !== 0 || match[0] !== source) continue;
        const label = source.replace(pattern, replacement);
        if (label !== source) return label;
      }
      return null;
    }

    function resolveReactGlobalNavLabel(source) {
      return labels[source] || findStaticGlobalNavLabel(source) || findRegexpGlobalNavLabel(source);
    }

    function normalizeReactGlobalNavText(text) {
      return text?.replace(/\s+/g, ' ').trim();
    }

    function translateReactGlobalNavText(text) {
      const source = normalizeReactGlobalNavText(text);
      return source ? resolveReactGlobalNavLabel(source) : null;
    }

    function translateReactGlobalNavElement(element, source) {
      const label = translateReactGlobalNavText(source ?? element.textContent);
      if (label && element.textContent !== label) {
        element.textContent = label;
      }
    }

    function shouldSkipReactGlobalNavNode(node) {
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!element) return true;
      if (element.closest?.(unsafeTextSelector)) return true;
      if (element.closest?.(searchSurfaceSelector)) return true;
      return false;
    }

    function translateReactGlobalNavAttributes(element) {
      translatableAttributeNames.forEach(attributeName => {
        const value = element.getAttribute?.(attributeName);
        const label = translateReactGlobalNavText(value);
        if (label && value !== label) {
          element.setAttribute(attributeName, label);
        }
      });
    }

    function translateReactGlobalNavTextNode(node) {
      const original = node.data;
      const m = original.match(/^(\s*)([\s\S]*?)(\s*)$/);
      const inner = m ? m[2] : original;
      const label = translateReactGlobalNavText(inner);
      if (label) {
        node.data = (m ? m[1] : '') + label + (m ? m[3] : '');
      }
    }

    function translateReactGlobalNavSurface(surface) {
      if (!surface || shouldSkipReactGlobalNavNode(surface)) return;

      if (surface.nodeType === Node.ELEMENT_NODE) {
        translateReactGlobalNavAttributes(surface);
      }

      const walker = document.createTreeWalker(
        surface,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            return shouldSkipReactGlobalNavNode(node)
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          translateReactGlobalNavAttributes(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          translateReactGlobalNavTextNode(node);
        }
      }
    }

    function translateReactGlobalNavHeader() {
      const header = document.querySelector('header.GlobalNav');
      if (!header) return true;
      if (!canTranslateReactGlobalNavHeader()) return false;

      document.querySelectorAll(dataContentLabelSelector).forEach(element => {
        if (!shouldSkipReactGlobalNavNode(element)) {
          translateReactGlobalNavElement(element, element.getAttribute('data-content'));
        }
      });
      translateReactGlobalNavSearchButton();
      translateReactGlobalNavSurface(header);
      return true;
    }

    function isReactGlobalNavSearchPortal(surface) {
      return surface.matches?.('[role="dialog"]')
        || !!surface.querySelector?.('#search-suggestions-dialog, qbsearch-input, [role="dialog"]');
    }

    function translateReactGlobalNavPortals() {
      const surfaces = Array.from(document.querySelectorAll(portalSurfaceSelector))
        .filter(isReactGlobalNavPortalNode);
      if (!surfaces.length) return true;

      let searchPortalPending = false;
      surfaces.forEach(surface => {
        if (isReactGlobalNavSearchPortal(surface) && !isReactGlobalNavSurfaceIdle('portal')) {
          searchPortalPending = true;
          return;
        }
        translateReactGlobalNavSurface(surface);
      });
      return !searchPortalPending;
    }

    function translateReactGlobalNavSearchButton() {
      const placeholder = document.querySelector('header.GlobalNav [class*="Search-module__placeholder__"]');
      if (!placeholder) return;
      const label = translateReactGlobalNavText(placeholder.textContent);
      if (!label || normalizeReactGlobalNavText(placeholder.textContent) === label) return;

      const textNodeGroups = [[]];
      const protectedTexts = [];
      function collectSearchPlaceholderNodes(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          textNodeGroups[textNodeGroups.length - 1].push(node);
          return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.matches?.(unsafeTextSelector)) {
          const protectedText = normalizeReactGlobalNavText(node.textContent);
          if (protectedText) {
            protectedTexts.push(protectedText);
            textNodeGroups.push([]);
          }
          return;
        }
        node.childNodes.forEach(collectSearchPlaceholderNodes);
      }
      placeholder.childNodes.forEach(collectSearchPlaceholderNodes);

      const segments = [];
      let remainingLabel = label;
      for (const protectedText of protectedTexts) {
        const protectedIndex = remainingLabel.indexOf(protectedText);
        if (protectedIndex === -1) return;
        segments.push(remainingLabel.slice(0, protectedIndex));
        remainingLabel = remainingLabel.slice(protectedIndex + protectedText.length);
      }
      segments.push(remainingLabel);

      if (segments.some((segment, index) =>
        normalizeReactGlobalNavText(segment) && !textNodeGroups[index].length
      )) return;

      textNodeGroups.forEach((nodes, segmentIndex) => {
        nodes.forEach((node, nodeIndex) => {
          node.data = nodeIndex === 0 ? segments[segmentIndex] : '';
        });
      });
    }

    function translateReactGlobalNavSearchDialog() {
      const dialog = document.querySelector('#search-suggestions-dialog');
      if (!dialog) return;

      const header = document.getElementById('search-suggestions-dialog-header');
      if (header) {
        const label = translateReactGlobalNavText(header.textContent);
        if (label) header.textContent = label;
      }
      dialog.querySelectorAll('.ActionList-sectionDivider-title').forEach(el => {
        const label = translateReactGlobalNavText(el.textContent);
        if (label) el.textContent = label;
      });
      dialog.querySelectorAll('.search-feedback-prompt a, .search-feedback-prompt button').forEach(el => {
        const label = translateReactGlobalNavText(el.textContent);
        if (label) el.textContent = label;
      });
    }

    function translateReactGlobalNavLabels(options = { requireSettledHeader: true }) {
      observeReactGlobalNav();
      translateReactGlobalNavSearchDialog();

      const headerTranslated = translateReactGlobalNavHeader();
      const portalsTranslated = translateReactGlobalNavPortals();

      if ((options.requireSettledHeader && !headerTranslated) || !portalsTranslated) {
        scheduleReactGlobalNavTranslation(reactGlobalNavRetryMs, options);
      }
    }

    function scheduleReactGlobalNavTranslation(delay = 800, options = {}) {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => translateReactGlobalNavLabels(options), delay);
    }

    function scheduleReactGlobalNavSeries() {
      [800, 1600, 3000].forEach(delay => {
        window.setTimeout(() => translateReactGlobalNavLabels(), delay);
      });
    }

    function recordReactGlobalNavMutation(surface) {
      if (surface?.id === '__primerPortalRoot__' || surface?.closest?.('#__primerPortalRoot__')) {
        lastReactGlobalNavPortalMutationAt = Date.now();
        return;
      }
      lastReactGlobalNavMutationAt = Date.now();
    }

    function observeReactGlobalNav() {
      if (!headerObserver) {
        headerObserver = new MutationObserver(mutations => {
          mutations.forEach(mutation => recordReactGlobalNavMutation(mutation.target));
          translateReactGlobalNavPortals();
          scheduleReactGlobalNavTranslation(reactGlobalNavRetryMs, { requireSettledHeader: true });
        });
      }

      [
        document.querySelector('header.GlobalNav'),
        document.querySelector('#__primerPortalRoot__'),
      ].forEach(surface => {
        if (!surface || observedSurfaces.has(surface)) return;
        observedSurfaces.add(surface);
        recordReactGlobalNavMutation(surface);
        headerObserver.observe(surface, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      });
    }

    function startReactGlobalNavTranslation() {
      observeReactGlobalNav();
      scheduleReactGlobalNavSeries();
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startReactGlobalNavTranslation, { once: true });
    } else {
      startReactGlobalNavTranslation();
    }

    window.addEventListener('turbo:load', scheduleReactGlobalNavSeries);

    ['click', 'focusin', 'focusout', 'pointerover'].forEach(evt => {
      document.addEventListener(evt, () => {
        scheduleReactGlobalNavTranslation(reactGlobalNavRetryMs, { requireSettledHeader: true });
      }, true);
    });
  }

  /* =========================== MutationObserver =========================== */
  function setupMutationObserver() {
    let previousURL = window.location.href;

    if (State.mutationObserver) State.mutationObserver.disconnect();

    State.mutationObserver = new MutationObserver(
      safe((mutations) => {
        const currentURL = window.location.href;
        if (currentURL !== previousURL) {
          previousURL = currentURL;
          State.currentURL = currentURL;
          updatePageConfig('URL变化 (MutationObserver)');
        }
        if (State.pageConfig) processMutations(mutations);
      }, 'MutationObserver')
    );

    State.mutationObserver.observe(document.body, CONFIG.OBSERVER_CONFIG);
  }

  function shouldIgnoreMutationNode(node) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    if (!element) return true;

    const ignoredSelectors = State.pageConfig?.ignoreMutationSelectors;
    if (ignoredSelectors && element.closest?.(ignoredSelectors)) return true;

    return isReactGlobalNavPortalNode(element);
  }

  /* =========================== 遍历合并调度 =========================== */
  let pendingTranslateRoots = null;
  let flushScheduled = false;

  function scheduleTraversalFlush() {
    if (flushScheduled) return;
    flushScheduled = true;

    let flushed = false;
    const flush = () => {
      if (flushed) return;
      flushed = true;
      flushScheduled = false;

      const roots = pendingTranslateRoots;
      pendingTranslateRoots = null;
      safe(applyDirectPlaceholderPatches, '占位符随批')();
      if (!roots || roots.size === 0) return;
      roots.forEach(node => safe(traverseNode, '合并遍历')(node));
    };

    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(flush);
    }
    window.setTimeout(flush, 100);
  }

  function processMutations(mutations) {
    const nodesToProcess = new Set();

    mutations.forEach(({ target, addedNodes, type }) => {
      if (type === 'childList' && addedNodes.length > 0) {
        addedNodes.forEach(node => {
          if (!shouldIgnoreMutationNode(node)) nodesToProcess.add(node);
        });
      } else if (type === 'attributes') {
        if (!shouldIgnoreMutationNode(target)) nodesToProcess.add(target);
      } else if (type === 'characterData' && State.pageConfig.characterData) {
        if (!shouldIgnoreMutationNode(target)) nodesToProcess.add(target);
      }
    });

    const topNodes = new Set();
    nodesToProcess.forEach(node => {
      let ancestor = node.parentElement;
      while (ancestor) {
        if (nodesToProcess.has(ancestor)) return;
        ancestor = ancestor.parentElement;
      }
      topNodes.add(node);
    });

    log('DOM变化(已过滤)', topNodes);

    if (!pendingTranslateRoots) pendingTranslateRoots = new Set();
    topNodes.forEach(node => pendingTranslateRoots.add(node));
    scheduleTraversalFlush();
  }

  /* =========================== DOM 遍历与节点处理 =========================== */
  function traverseNode(rootNode) {
    const measure = CONFIG.DEV;
    const start = measure ? performance.now() : 0;

    if (rootNode.nodeType === Node.TEXT_NODE) {
      handleTextNode(rootNode);
      return;
    }

    const ignoreSelectors = State.pageConfig?.ignoreSelectors;
    const treeWalker = document.createTreeWalker(
      rootNode,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      node => {
        if (node.nodeType === Node.ELEMENT_NODE
          && ignoreSelectors
          && node.matches(ignoreSelectors)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    );

    let currentNode;
    while ((currentNode = treeWalker.nextNode())) {
      if (currentNode.nodeType === Node.ELEMENT_NODE) {
        handleElementNode(currentNode);
      } else if (currentNode.nodeType === Node.TEXT_NODE) {
        handleTextNode(currentNode);
      }
    }

    if (measure) {
      const duration = performance.now() - start;
      if (duration > 10) console.log(`节点遍历耗时: ${duration.toFixed(2)}ms`);
    }
  }

  function tryPatchParentText(node) {
    const parent = node.parentElement;
    if (!parent) return;

    const text = parent.textContent;
    if (!text || text.length > 200) return;
    if (/^(INPUT|TEXTAREA|SELECT|CODE|PRE|KBD|SAMP|SCRIPT|STYLE)$/i.test(parent.tagName)) return;
    if (parent.closest?.('input, textarea, select, code, pre, kbd, samp, script, style')) return;

    for (const { pattern, replacement } of (EXTRAS.textPatches || [])) {
      if (pattern.test(text)) {
        parent.textContent = replacement;
        return;
      }
    }
  }

  function tryPatchInputPlaceholder(node) {
    if (!node.placeholder) return;
    const text = node.placeholder;
    for (const { pattern, replacement } of (EXTRAS.placeholderPatches || [])) {
      if (pattern.test(text)) {
        node.placeholder = replacement;
        return;
      }
    }
  }

  function handleTextNode(node) {
    if (node.length > 500) return;
    transElementAttrs(node, 'data');
    tryPatchParentText(node);
  }

  function handleElementNode(node) {
    const tag = node.tagName;

    if (tag === 'RELATIVE-TIME') {
      if (node.shadowRoot) transTimeElement(node.shadowRoot);
      return;
    }

    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (['button', 'submit', 'reset'].includes(node.type)) {
        transElementAttrs(node.dataset, 'confirm');
        transElementAttrs(node, 'value');
      } else {
        transElementAttrs(node, 'placeholder');
        tryPatchInputPlaceholder(node);
      }
      return;
    }

    if (tag === 'OPTGROUP') {
      transElementAttrs(node, 'label');
      return;
    }

    if (tag === 'BUTTON') {
      transElementAttrs(node, 'title');
      transElementAttrs(node.dataset, [
        'confirm',
        'confirmText',
        'confirmCancelText',
        'disableWith',
        'visibleText'
      ]);
    }

    if (tag === 'A' || tag === 'SPAN') {
      transElementAttrs(node, 'title');
      transElementAttrs(node.dataset, 'visibleText');
    }

    if (node.classList?.contains('tooltipped')) {
      transElementAttrs(node, 'ariaLabel');
    }
  }

  /* =========================== 翻译功能 =========================== */
  function transTitle() {
    if (!State.settings.translateTitle) return;
    const text = document.title;
    let result = State.pageConfig.titleStaticDict[text] || '';

    if (!result) {
      for (const [pattern, replacement] of State.pageConfig.titleRegexpRules) {
        result = text.replace(pattern, replacement);
        if (result !== text) break;
      }
    }

    // extras 补充标题规则（如 /copilot 页 "New conversation · ..."）
    if (!result && Array.isArray(EXTRAS.titleRegexp)) {
      for (const [pattern, replacement] of EXTRAS.titleRegexp) {
        result = text.replace(pattern, replacement);
        if (result !== text) break;
      }
    }

    if (result) document.title = result;
  }

  function transTimeElement(element) {
    const text = element.textContent;
    if (!text) return;

    let result = text.replace(/^on/, '');

    for (const [pattern, replacement] of RELATIVE_TIME_PATTERNS) {
      const next = result.replace(pattern, replacement);
      if (next !== result) {
        result = next;
        break;
      }
    }

    if (result !== text) element.textContent = result;
  }

  function transElementAttr(target, attrName) {
    const text = target[attrName];
    if (!text) return;
    const result = transText(text);
    if (result) target[attrName] = result;
  }

  function transElementAttrs(target, attrs) {
    if (!target) return;
    const attrList = Array.isArray(attrs) ? attrs : [attrs];
    attrList.forEach(attrName => transElementAttr(target, attrName));
  }

  function transBySelector() {
    State.pageConfig.transSelectors?.forEach(([selector, result]) => {
      const element = document.querySelector(selector);
      if (element) element.textContent = result;
    });
  }

  /* =========================== 翻译文本 =========================== */
  const transTextCache = new Map();
  const TRANS_TEXT_CACHE_MAX = 3000;

  function transText(text) {
    if (!text) return false;
    if (/^[\s0-9]*$/.test(text) ||
      /^[一-龥]+$/.test(text) ||
      !/[a-zA-Z,.]/.test(text)) {
      return false;
    }

    const trimmedText = text.trim();
    const cleanedText = trimmedText.replace(/\xa0|[\s]+/g, ' ');

    const cached = transTextCache.get(cleanedText);
    if (cached !== undefined) {
      return cached === null ? false : text.replace(trimmedText, () => cached);
    }

    const result = fetchTransResult(cleanedText);
    const finalResult = (result && result !== cleanedText) ? result : false;

    transTextCache.set(cleanedText, finalResult === false ? null : finalResult);
    if (transTextCache.size > TRANS_TEXT_CACHE_MAX) {
      let drop = Math.floor(TRANS_TEXT_CACHE_MAX / 2);
      for (const key of transTextCache.keys()) {
        transTextCache.delete(key);
        if (--drop <= 0) break;
      }
    }

    return finalResult === false ? false : text.replace(trimmedText, () => finalResult);
  }

  function fetchTransResult(text) {
    if (!State.pageConfig) return false;

    const staticResult = State.pageConfig.staticDict[text];
    if (typeof staticResult === 'string') {
      return staticResult;
    }

    if (State.featureSet.enable_RegExp) {
      for (const [pattern, replacement] of State.pageConfig.regexpRules) {
        const result = text.replace(pattern, replacement);
        if (result !== text) {
          return result;
        }
      }
    }

    return false;
  }

  /* =========================== 设置接入（chrome.storage） =========================== */
  function start() {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      chrome.storage.local.get({ enabled: true, translateTitle: true }, (items) => {
        State.settings = items || { enabled: true, translateTitle: true };
        if (State.settings.enabled) init();

        if (chrome.storage.onChanged) {
          chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local') return;
            let flipped = false;
            for (const [key, { newValue }] of Object.entries(changes)) {
              if (State.settings[key] !== newValue) flipped = true;
              State.settings[key] = newValue;
            }
            // 开关变化需要整页重新翻译/还原
            if (flipped) window.location.reload();
          });
        }
      });
    } else {
      // 测试/降级环境：无扩展 API 时直接启用
      init();
    }
  }

  start();
})(window, document);
