/* ================================================================
   Tab Out — Dashboard App

   This file is the brain of the dashboard. It:
   1. Talks to the Chrome extension (to read/close actual browser tabs)
   2. Groups open tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus)
   ================================================================ */

'use strict';

/* ================================================================
   TIMER THAT RESPECTS TAB VISIBILITY — polls only while tab is visible.
   When user switches away, intervals pause (no CPU/network burn).
   When they switch back, tick fires immediately so data refreshes.
   ================================================================ */
const _scheduledTicks = [];
let _visibilityBound = false;

function setVisibleInterval(fn, intervalMs, { runOnVisible = true } = {}) {
  let timer = null;
  const tick = () => {
    if (document.visibilityState === 'visible') {
      try { fn(); } catch (e) { console.warn('[tick]', e); }
    }
  };
  const start = () => {
    stop();
    timer = setInterval(tick, intervalMs);
  };
  const stop = () => { if (timer) { clearInterval(timer); timer = null; } };

  _scheduledTicks.push({ fn, start, stop, intervalMs, runOnVisible });
  if (document.visibilityState === 'visible') start();

  if (!_visibilityBound) {
    _visibilityBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        for (const t of _scheduledTicks) {
          t.start();
          if (t.runOnVisible) { try { t.fn(); } catch {} }
        }
      } else {
        for (const t of _scheduledTicks) t.stop();
      }
    });
  }
  return { start, stop };
}

/* ================================================================
   STORAGE + SETTINGS (chrome.storage.local-backed)
   ================================================================ */

const Storage = {
  async get(key, defaultValue = null) {
    if (!chrome?.storage?.local) return defaultValue;
    const r = await chrome.storage.local.get(key);
    return r[key] ?? defaultValue;
  },
  async set(key, value) {
    if (!chrome?.storage?.local) return;
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    if (!chrome?.storage?.local) return;
    await chrome.storage.local.remove(key);
  },
  async getAll() {
    if (!chrome?.storage?.local) return {};
    return await chrome.storage.local.get(null);
  },
};

/* ================================================================
   In-memory mirror of frequently-read storage keys.
   Loaded once at bootstrap (loadAllStorage()) then synchronous code
   reads from `mem` and writes both to `mem` and chrome.storage.local.
   ================================================================ */
const mem = {
  shortcuts: null,     // array of Quick Access entries
  pinned: null,        // array of { url, title, favicon }
  themeMode: 'light',  // 'light' | 'dark' | 'auto'
  pingHosts: null,
};

async function loadAllStorage() {
  // Migrate old localStorage keys into chrome.storage (one-time)
  try {
    const oldShortcuts = localStorage.getItem('tabout-shortcuts');
    const oldPinned = localStorage.getItem('tabout-pinned');
    const oldTheme = localStorage.getItem('tabout-theme-mode');
    const oldSettings = localStorage.getItem('tabout-settings');
    if (oldShortcuts && !(await Storage.get('tabout-shortcuts'))) {
      await Storage.set('tabout-shortcuts', JSON.parse(oldShortcuts));
    }
    if (oldPinned && !(await Storage.get('tabout-pinned'))) {
      await Storage.set('tabout-pinned', JSON.parse(oldPinned));
    }
    if (oldTheme && !(await Storage.get('tabout-theme-mode'))) {
      await Storage.set('tabout-theme-mode', oldTheme);
    }
    if (oldSettings && !(await Storage.get('tabout-settings'))) {
      await Storage.set('tabout-settings', JSON.parse(oldSettings));
    }
  } catch {}

  // Parallel load — single chrome.storage.get call with multiple keys is fastest.
  const all = await chrome.storage.local.get([
    'tabout-shortcuts', 'tabout-pinned', 'tabout-theme-mode',
    'tabout-ping-hosts', 'tabout-deferred',
  ]);
  mem.shortcuts = all['tabout-shortcuts'] ?? null;
  mem.pinned    = all['tabout-pinned'] ?? [];
  mem.themeMode = all['tabout-theme-mode'] ?? 'light';
  mem.pingHosts = all['tabout-ping-hosts'] ?? null;
  DeferredStore._data = all['tabout-deferred'] ?? { active: [], archived: [] };
  DeferredStore._ageOut();
}

/* ================================================================
   DeferredStore — replaces the old SQLite + REST API for "Saved for Later"
   ================================================================ */
const DeferredStore = {
  _data: { active: [], archived: [] },

  async load() {
    this._data = await Storage.get('tabout-deferred', { active: [], archived: [] });
    this._ageOut();
  },

  _save() { Storage.set('tabout-deferred', this._data).catch(() => {}); },

  getAll() { return this._data; },

  add(tab) {
    const entry = {
      id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
      url: tab.url,
      title: tab.title,
      favicon_url: tab.favicon_url || null,
      source_mission: tab.source_mission || null,
      deferred_at: new Date().toISOString(),
      checked: 0,
      checked_at: null,
      dismissed: 0,
      archived: 0,
      archived_at: null,
    };
    this._data.active.unshift(entry);
    this._save();
    return entry;
  },

  check(id) {
    const idx = this._data.active.findIndex(i => i.id == id);
    if (idx < 0) return;
    const item = this._data.active.splice(idx, 1)[0];
    item.checked = 1;
    item.checked_at = new Date().toISOString();
    item.archived = 1;
    item.archived_at = new Date().toISOString();
    this._data.archived.unshift(item);
    this._save();
  },

  dismiss(id) {
    const idx = this._data.active.findIndex(i => i.id == id);
    if (idx < 0) return;
    const item = this._data.active.splice(idx, 1)[0];
    item.dismissed = 1;
    item.archived = 1;
    item.archived_at = new Date().toISOString();
    this._data.archived.unshift(item);
    this._save();
  },

  _ageOut() {
    const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
    const stillActive = [];
    for (const item of this._data.active) {
      if (new Date(item.deferred_at).getTime() < thirtyDaysAgo) {
        item.archived = 1;
        item.archived_at = new Date().toISOString();
        this._data.archived.unshift(item);
      } else {
        stillActive.push(item);
      }
    }
    this._data.active = stillActive;
    this._save();
  },

  search(q) {
    const lower = (q || '').toLowerCase();
    if (!lower) return [];
    return this._data.archived.filter(i =>
      (i.title || '').toLowerCase().includes(lower) ||
      (i.url || '').toLowerCase().includes(lower)
    ).slice(0, 50);
  },
};

// Default settings (overwritten by Storage.get('tabout-settings'))
const DEFAULT_SETTINGS = {
  tabTitle: 'Tab Out',
  weatherCity: {
    name: 'Moscow',
    lat: 55.7558,
    lon: 37.6173,
  },
  currencies: ['USD', 'EUR', 'BTC'],
  tileScale: 1.0,
  metrics: {
    cpu: true,       // CPU load %
    ram: true,       // RAM used/total
    disk: true,      // Disk free
    cpuTemp: true,   // CPU temp (LHM)
    gpuTemp: true,   // GPU temp (LHM)
    gpuLoad: false,  // GPU load (LHM)
    vram: false,     // VRAM used/total (LHM)
    fan: false,      // max fan RPM (LHM)
    uptime: true,    // browser uptime (sec)
  },
};

const METRICS_LIST = [
  { key: 'cpu',     label: 'CPU load' },
  { key: 'ram',     label: 'RAM' },
  { key: 'disk',    label: 'Disk' },
  { key: 'cpuTemp', label: 'CPU temp' },
  { key: 'gpuTemp', label: 'GPU temp' },
  { key: 'gpuLoad', label: 'GPU load' },
  { key: 'vram',    label: 'VRAM' },
  { key: 'fan',     label: 'Fan RPM' },
  { key: 'uptime',  label: 'Uptime' },
];

function applyTileScale(scale) {
  document.documentElement.style.setProperty('--qa-scale', scale);
  const display = document.getElementById('sizeDisplay');
  if (display) display.textContent = Math.round(scale * 100) + '%';
}

let settings = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  const saved = await Storage.get('tabout-settings', {});
  settings = { ...DEFAULT_SETTINGS, ...saved };
  if (saved?.weatherCity) settings.weatherCity = { ...DEFAULT_SETTINGS.weatherCity, ...saved.weatherCity };
  return settings;
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await Storage.set('tabout-settings', settings);
}

/**
 * cachedFetch(url, ttlMs) — fetches JSON with TTL-based cache in chrome.storage.local.
 * Returns parsed JSON or null on failure. Falls back to stale cache if fresh fetch fails.
 */
async function cachedFetch(url, ttlMs = 30 * 60 * 1000) {
  const key = 'cache:' + url;
  const cached = await Storage.get(key);
  if (cached && Date.now() - cached.ts < ttlMs) return cached.data;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error('http ' + resp.status);
    const data = await resp.json();
    await Storage.set(key, { data, ts: Date.now() });
    return data;
  } catch {
    return cached ? cached.data : null;
  }
}



/* ----------------------------------------------------------------
   QUICK ACCESS SHORTCUTS

   Array of bookmarks shown at the top of the dashboard.
   Each entry: { label, url, group }
   Groups are separated by visual spacing (no headers).
   ---------------------------------------------------------------- */
// Local Simple Icons SVG — in dashboard/icons/
const LI = (name) => `/icons/${name}.svg`;
// Google Favicons fallback for sites not in Simple Icons (bypasses CORS issues)
const FAV = (domain) => `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;

const QUICK_ACCESS = [
  // Search & Info
  { label: 'Google',     url: 'https://google.com',           group: 'search', icon: LI('google'),      color: '#4285F4' },
  { label: 'Yandex',     url: 'https://ya.ru',                group: 'search', icon: LI('yandex'),      color: '#FFCC00' },
  { label: 'DDG',        url: 'https://duckduckgo.com',       group: 'search', icon: LI('duckduckgo'),  color: '#DE5833' },
  { label: '\u041a\u0430\u0440\u0442\u0438\u043d\u043a\u0438', url: 'https://yandex.ru/images', group: 'search', icon: LI('yandex-images'), color: '#FFCC00' },
  { label: 'YouTube',    url: 'https://youtube.com',          group: 'search', icon: LI('youtube'),     color: '#FF0000' },
  { label: 'Pinterest',  url: 'https://pinterest.com',        group: 'search', icon: LI('pinterest'),   color: '#BD081C' },
  // Cloud & Files
  { label: 'Drive',      url: 'https://drive.google.com',     group: 'cloud',  icon: LI('googledrive'), color: '#1967D2' },
  { label: '\u042f.\u0414\u0438\u0441\u043a', url: 'https://disk.yandex.ru', group: 'cloud', icon: LI('yandex-disk'), color: '#FFCC00' },
  { label: 'Photos',     url: 'https://photos.google.com',    group: 'cloud',  icon: LI('googlephotos'), color: '#4285F4' },
  { label: 'Envato',     url: 'https://elements.envato.com',  group: 'cloud',  icon: LI('envato'),      color: '#82B541' },
  // Communication & Work
  { label: 'Gmail',      url: 'https://mail.google.com',      group: 'comms',  icon: LI('gmail'),       color: '#EA4335' },
  { label: 'VK',         url: 'https://vk.com',               group: 'comms',  icon: LI('vk'),          color: '#0077FF' },
  { label: 'Kaiten',     url: 'https://kaiten.io',            group: 'comms',  icon: LI('kaiten'),      color: '#FF6B35' },
  // Google Docs
  { label: 'Docs',       url: 'https://docs.google.com',      group: 'docs',   icon: LI('googledocs'),  color: '#1A73E8' },
  { label: 'Sheets',     url: 'https://docs.google.com/spreadsheets', group: 'docs', icon: LI('googlesheets'), color: '#0F9D58' },
  { label: 'Slides',     url: 'https://docs.google.com/presentation', group: 'docs', icon: LI('googleslides'), color: '#F4B400' },
  { label: 'Keep',       url: 'https://keep.google.com',      group: 'docs',   icon: LI('googlekeep'),  color: '#FBBC04' },
  // AI — text & chat
  { label: 'ChatGPT',    url: 'https://chatgpt.com',          group: 'ai', icon: LI('chatgpt'),        color: '#10A37F' },
  { label: 'Claude',     url: 'https://claude.ai',            group: 'ai', icon: LI('anthropic'),      color: '#D97757' },
  { label: 'Gemini',     url: 'https://gemini.google.com',    group: 'ai', icon: LI('googlegemini'),   color: '#8E75B2' },
  { label: 'Grok',       url: 'https://grok.com',             group: 'ai', icon: LI('grok'),           color: '#000000' },
  { label: 'AI Studio',  url: 'https://aistudio.google.com',  group: 'ai', icon: LI('google-ai-studio'), color: '#4285F4' },
  { label: 'OpenRouter', url: 'https://openrouter.ai',        group: 'ai', icon: LI('openrouter'),     color: '#6466F1' },
  // Custom groups (work / wave / veta) are user-added in real deployments —
  // the defaults ship with only generic brand shortcuts. Users can add
  // their own via the ⚙ → "+ Add shortcut" button.
  // Creative — image/video generation & design
  { label: 'Krea',       url: 'https://krea.ai',              group: 'creative', icon: LI('krea'),       color: '#FFD300' },
  { label: 'Higgsfield', url: 'https://higgsfield.ai',        group: 'creative', icon: LI('higgsfield'), color: '#1A1A1A' },
  { label: 'SVG Artist', url: 'https://svgartista.net/',       group: 'creative', icon: LI('svgartista'), color: '#5A7A62' },
  { label: 'Dreamina',   url: 'https://dreamina.capcut.com/ai-tool/generate', group: 'creative',
    icon: LI('dreamina'), color: '#7F6FF1' },
  { label: 'Flow',       url: 'https://labs.google/fx/tools/flow/', group: 'creative', icon: LI('google-flow'), color: '#4285F4' },
  { label: 'Variant',    url: 'https://variant.com/authentication?next=%2Fcommunity', group: 'creative',
    icon: LI('variant'), color: '#2F2F2F' },
  // Dev & Design tools
  { label: 'GitHub',     url: 'https://github.com',           group: 'dev', icon: LI('github'),     color: '#181717' },
  { label: 'Icones',     url: 'https://icones.js.org',        group: 'dev', icon: LI('icones'),     color: '#5A6B7A' },
  { label: 'Tavily',     url: 'https://app.tavily.com/home',  group: 'dev', icon: LI('tavily'),     color: '#1F6FEB' },
  { label: 'Reg.ru',     url: 'https://www.reg.ru/', group: 'dev',
    icon: LI('regru'), color: '#EC1C24' },
  { label: 'Habr',       url: 'https://habr.com',             group: 'dev', icon: LI('habr'),       color: '#5EB2D6' },
];

/**
 * getShortcuts()
 * Returns the current shortcuts array — from localStorage if customized, else defaults.
 */
function getShortcuts() {
  try {
    const parsed = mem.shortcuts;
    if (true) {
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Merge from defaults — fill in MISSING fields only, preserving user's customizations.
        const defaultsByUrl = new Map(QUICK_ACCESS.map(s => [s.url, s]));
        return parsed.map(s => {
          const d = defaultsByUrl.get(s.url);
          if (!d) return s;
          // User's values win; defaults fill gaps
          return {
            label: s.label ?? d.label,
            url: s.url,
            group: s.group,
            icon: s.icon !== undefined ? s.icon : d.icon,
            color: s.color !== undefined ? s.color : d.color,
            iconColor: s.iconColor !== undefined ? s.iconColor : d.iconColor,
            letter: s.letter !== undefined ? s.letter : d.letter,
          };
        });
      }
    }
  } catch {}
  return QUICK_ACCESS;
}

let _saveShortcutsTimer = null;
function saveShortcuts(shortcuts) {
  mem.shortcuts = shortcuts;
  // Debounced async write to reduce disk writes during rapid drag-drop / edit batches.
  clearTimeout(_saveShortcutsTimer);
  _saveShortcutsTimer = setTimeout(() => {
    Storage.set('tabout-shortcuts', shortcuts).catch(() => {});
  }, 200);
}

// Track edit mode state
let qaEditMode = false;

// Cache for fetched SVG icons (recolored). Key: url|color
const coloredSvgCache = new Map();

/**
 * loadColoredSvg(url, color) — fetches SVG from URL, recolors it to given color,
 * and caches the result. Returns innerHTML string for <svg>.
 */
async function loadColoredSvg(url /* color arg unused — we use currentColor for live theming */) {
  if (coloredSvgCache.has(url)) return coloredSvgCache.get(url);
  try {
    let svg;
    if (url.startsWith('data:image/svg+xml')) {
      if (url.includes(';base64,')) {
        const b64 = url.split(';base64,')[1];
        svg = atob(b64);
      } else {
        svg = decodeURIComponent(url.split(',').slice(1).join(','));
      }
    } else {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('fetch failed');
      svg = await resp.text();
    }
    // Use currentColor so CSS color property controls the fill — enables hover effects
    svg = svg.replace(/fill="(?!none)[^"]*"/gi, `fill="currentColor"`);
    svg = svg.replace(/stroke="(?!none)[^"]*"/gi, `stroke="currentColor"`);
    svg = svg.replace(/fill\s*:\s*(?!none)[^;"']+/gi, `fill:currentColor`);
    svg = svg.replace(/stroke\s*:\s*(?!none)[^;"']+/gi, `stroke:currentColor`);
    if (!/<svg[^>]*fill=/i.test(svg)) {
      svg = svg.replace(/<svg/i, `<svg fill="currentColor"`);
    }
    coloredSvgCache.set(url, svg);
    return svg;
  } catch {
    coloredSvgCache.set(url, null);
    return null;
  }
}

// Backwards-compat alias
const loadWhiteSvg = (url) => loadColoredSvg(url, '#fff');

/**
 * isRecolorableSvg(url) — returns true if the icon URL points to an SVG we can recolor to white.
 * Covers local /icons/*.svg files and inline SVG data URIs (including uploaded user SVGs).
 */
function isRecolorableSvg(url) {
  if (typeof url !== 'string') return false;
  if (url.startsWith('/icons/') && url.endsWith('.svg')) return true;
  if (url.startsWith('data:image/svg+xml')) return true;
  return false;
}

// Keep old alias for backwards compatibility in render code
const isLocalSvg = isRecolorableSvg;

/**
 * renderQuickAccess()
 * Renders shortcut icons grouped into card blocks with drag-and-drop support.
 */
function renderQuickAccess() {
  const container = document.getElementById('quickAccess');
  if (!container) return;

  const shortcuts = getShortcuts();

  // Build groups preserving order of first appearance
  const groupOrder = [];
  const groups = {};
  for (const item of shortcuts) {
    if (!groups[item.group]) {
      groups[item.group] = [];
      groupOrder.push(item.group);
    }
    groups[item.group].push(item);
  }

  let html = '';
  const svgLoadTasks = []; // deferred SVG loads for local icons

  for (const groupKey of groupOrder) {
    const items = groups[groupKey];
    if (!items || items.length === 0) continue;

    let itemsHtml = '';
    for (const item of items) {
      const idx = shortcuts.indexOf(item);
      const safeUrl = item.url.replace(/"/g, '&quot;');
      // Adapt dark brand colors (e.g. GitHub #181717) for dark theme visibility
      const color = adaptColorToTheme(item.color || '#5a6b7a');
      const iconColor = item.iconColor || '#fff';

      // Build inner content: letter, local SVG (recolored), or favicon img
      let innerHtml = '';
      if (item.letter) {
        innerHtml = `<span class="qa-tile-letter">${item.letter}</span>`;
      } else if (isLocalSvg(item.icon)) {
        const svgId = `qa-svg-${idx}`;
        innerHtml = `<span class="qa-tile-icon" id="${svgId}"></span>`;
        svgLoadTasks.push({ id: svgId, url: item.icon, color: iconColor });
      } else if (item.icon) {
        innerHtml = `<img class="qa-tile-img" src="${item.icon}" alt="" onerror="this.style.opacity='0.3'" draggable="false">`;
      } else {
        const firstChar = (item.label || '?').charAt(0).toUpperCase();
        innerHtml = `<span class="qa-tile-letter">${firstChar}</span>`;
      }

      // Ghost mode: dim tile bg to ~15% alpha, icon/text in brand color.
      // Use CSS var so :hover can swap to solid fill.
      itemsHtml += `<a class="quick-access-item" href="${item.url}" target="_top" title="${item.label}"
        style="--qa-brand:${color};--qa-icon-hover:${iconColor}"
        draggable="false" data-qa-url="${safeUrl}" data-qa-group="${item.group}" data-qa-index="${idx}">
        <button class="qa-edit-btn" data-qa-index="${idx}" title="\u0420\u0435\u0434\u0430\u043a\u0442\u0438\u0440\u043e\u0432\u0430\u0442\u044c">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.863 4.487z"/></svg>
        </button>
        <button class="qa-delete-btn" data-qa-index="${idx}" title="\u0423\u0434\u0430\u043b\u0438\u0442\u044c">\u00d7</button>
        <div class="qa-tile-content">${innerHtml}</div>
        <span class="qa-tile-label">${item.label}</span>
      </a>`;
    }

    html += `<div class="quick-access-group" data-qa-group="${groupKey}">
      <div class="quick-access-group-items">${itemsHtml}</div>
    </div>`;
  }

  // Action buttons (edit + add), stacked vertically on the right
  html += `<div class="quick-access-actions">
    <button class="quick-access-edit-btn${qaEditMode ? ' active' : ''}" id="qaEditToggle" title="${qaEditMode ? '\u0413\u043e\u0442\u043e\u0432\u043e' : '\u0420\u0435\u0434\u0430\u043a\u0442\u0438\u0440\u043e\u0432\u0430\u0442\u044c'}">
      ${qaEditMode ? '\u2713' : '\u270e'}
    </button>
    <button class="quick-access-edit-btn" id="qaAddBtn" title="\u0414\u043e\u0431\u0430\u0432\u0438\u0442\u044c \u044f\u0440\u043b\u044b\u043a">+</button>
  </div>`;

  container.className = 'quick-access' + (qaEditMode ? ' edit-mode' : '');
  container.innerHTML = html;

  // Edit toggle handler
  document.getElementById('qaEditToggle').addEventListener('click', () => {
    qaEditMode = !qaEditMode;
    renderQuickAccess();
  });

  document.getElementById('qaAddBtn').addEventListener('click', openAddShortcutsForm);

  // Async: load local SVGs, recolor to target color, inject
  for (const task of svgLoadTasks) {
    loadColoredSvg(task.url, task.color).then(svg => {
      const el = document.getElementById(task.id);
      if (el && svg) el.innerHTML = svg;
    });
  }

  // In edit mode: enable dragging, delete buttons, block link navigation
  if (qaEditMode) {
    container.querySelectorAll('.quick-access-item').forEach(el => {
      el.setAttribute('draggable', 'true');
      el.addEventListener('click', (e) => e.preventDefault());
    });

    // Delete button handler — removes by index (so duplicates with same URL stay intact)
    container.querySelectorAll('.qa-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = Number(btn.dataset.qaIndex);
        const shortcuts = getShortcuts();
        if (idx >= 0 && idx < shortcuts.length) {
          shortcuts.splice(idx, 1);
          saveShortcuts(shortcuts);
          renderQuickAccess();
        }
      });
    });

    // Edit (settings) button handler
    container.querySelectorAll('.qa-edit-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const idx = Number(btn.dataset.qaIndex);
        openEditShortcutForm(idx);
      });
    });

    initQuickAccessDragDrop(container);
  }
}

/**
 * initQuickAccessDragDrop(container)
 * Sets up drag-and-drop for moving shortcut icons between and within groups.
 */
function initQuickAccessDragDrop(container) {
  let draggedUrl = null;
  let draggedEl = null;

  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.quick-access-item');
    if (!item) return;
    draggedUrl = item.dataset.qaUrl;
    draggedEl = item;
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedUrl);
    // Prevent the link from navigating during drag
    setTimeout(() => { if (draggedEl) draggedEl.style.pointerEvents = 'none'; }, 0);
  });

  container.addEventListener('dragend', (e) => {
    if (draggedEl) {
      draggedEl.classList.remove('dragging');
      draggedEl.style.pointerEvents = '';
    }
    // Clear all highlights
    container.querySelectorAll('.drag-over, .drag-target-left, .drag-target-right').forEach(el => {
      el.classList.remove('drag-over', 'drag-target-left', 'drag-target-right');
    });
    draggedUrl = null;
    draggedEl = null;
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    // Clear previous highlights
    container.querySelectorAll('.drag-target-left, .drag-target-right').forEach(el => {
      el.classList.remove('drag-target-left', 'drag-target-right');
    });
    container.querySelectorAll('.drag-over').forEach(el => {
      el.classList.remove('drag-over');
    });

    // Highlight the target item or group
    const targetItem = e.target.closest('.quick-access-item');
    const targetGroup = e.target.closest('.quick-access-group');

    if (targetItem && targetItem !== draggedEl) {
      // Show insertion indicator (left or right side of the target)
      const rect = targetItem.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if (e.clientX < midX) {
        targetItem.classList.add('drag-target-left');
      } else {
        targetItem.classList.add('drag-target-right');
      }
    } else if (targetGroup) {
      targetGroup.classList.add('drag-over');
    }
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!draggedUrl) return;

    const targetItem = e.target.closest('.quick-access-item');
    const targetGroup = e.target.closest('.quick-access-group');
    if (!targetGroup) return;

    const shortcuts = getShortcuts();
    const dragIdx = shortcuts.findIndex(s => s.url === draggedUrl);
    if (dragIdx === -1) return;

    // Remove dragged item from its current position
    const [dragged] = shortcuts.splice(dragIdx, 1);

    if (targetItem && targetItem !== draggedEl) {
      // Insert before or after the target item
      const targetUrl = targetItem.dataset.qaUrl;
      const targetIdx = shortcuts.findIndex(s => s.url === targetUrl);
      if (targetIdx === -1) return;

      const rect = targetItem.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const insertIdx = e.clientX < midX ? targetIdx : targetIdx + 1;

      // Update group to match target
      dragged.group = targetItem.dataset.qaGroup;
      shortcuts.splice(insertIdx, 0, dragged);
    } else {
      // Dropped on empty area of group — append to that group
      const targetGroupKey = targetGroup.dataset.qaGroup;
      dragged.group = targetGroupKey;
      // Find last item of this group and insert after it
      let lastIdx = -1;
      for (let i = 0; i < shortcuts.length; i++) {
        if (shortcuts[i].group === targetGroupKey) lastIdx = i;
      }
      shortcuts.splice(lastIdx + 1, 0, dragged);
    }

    saveShortcuts(shortcuts);
    renderQuickAccess();
  });

}


/**
 * luminance(hex) — perceived brightness 0 (black) → 1 (white).
 * Used to auto-lighten dark brand colors in dark theme.
 */
function luminance(hex) {
  if (!hex || !hex.startsWith('#') || hex.length < 7) return 0.5;
  const r = parseInt(hex.slice(1,3), 16) / 255;
  const g = parseInt(hex.slice(3,5), 16) / 255;
  const b = parseInt(hex.slice(5,7), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * lightenHex(hex, amount) — mixes hex with white by `amount` (0..1).
 * lightenHex('#181717', 0.6) → mostly white with a hint of the original tone.
 */
function lightenHex(hex, amount = 0.6) {
  if (!hex || !hex.startsWith('#') || hex.length < 7) return hex;
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  const mix = (c) => Math.round(c + (255 - c) * amount);
  return '#' + [mix(r), mix(g), mix(b)]
    .map(n => n.toString(16).padStart(2, '0')).join('');
}

/**
 * adaptColorToTheme(hex) — if in dark theme and color is too dark, lighten it.
 */
function adaptColorToTheme(hex) {
  const isDark = document.documentElement.dataset.theme === 'dark';
  if (!isDark) return hex;
  if (luminance(hex) < 0.22) {
    return lightenHex(hex, 0.7);
  }
  return hex;
}

/**
 * syncColorHex(colorInput, hexInput) — two-way sync between <input type="color">
 * and a text hex input. Hex input accepts values with or without leading #.
 */
function syncColorHex(colorInput, hexInput) {
  colorInput.addEventListener('input', () => { hexInput.value = colorInput.value.slice(1); });
  hexInput.addEventListener('input', () => {
    let v = hexInput.value.trim();
    if (!v.startsWith('#')) v = '#' + v;
    if (/^#[0-9a-fA-F]{6}$/.test(v) || /^#[0-9a-fA-F]{3}$/.test(v)) {
      colorInput.value = v;
    }
  });
}

/**
 * readHexOrColor(colorInput, hexInput) — returns the current color value,
 * preferring hex input if it's a valid hex string.
 */
function readHexOrColor(colorInput, hexInput) {
  const hexVal = hexInput.value.trim();
  const hexNorm = hexVal.startsWith('#') ? hexVal : '#' + hexVal;
  if (/^#[0-9a-fA-F]{6}$/.test(hexNorm) || /^#[0-9a-fA-F]{3}$/.test(hexNorm)) {
    return hexNorm;
  }
  return colorInput.value;
}

/**
 * Generate a unique group key for a new shortcut (e.g. "custom-1")
 */
function generateUniqueGroup(shortcuts) {
  let n = 1;
  const existing = new Set(shortcuts.map(s => s.group));
  while (existing.has('custom-' + n)) n++;
  return 'custom-' + n;
}

/**
 * openEditShortcutForm(idx)
 * Opens an inline edit form for the shortcut at the given index.
 * Allows changing URL, label, color, and icon.
 */
function openEditShortcutForm(idx) {
  const shortcuts = getShortcuts();
  const item = shortcuts[idx];
  if (!item) return;

  // Remove any existing form
  document.querySelectorAll('.qa-add-form').forEach(el => el.remove());

  const form = document.createElement('div');
  form.className = 'qa-add-form';
  form.innerHTML = `
    <div class="qa-add-title">\u0420\u0435\u0434\u0430\u043a\u0442\u0438\u0440\u043e\u0432\u0430\u043d\u0438\u0435 \u044f\u0440\u043b\u044b\u043a\u0430</div>
    <div class="qa-add-rows">
      <div class="qa-add-row">
        <input type="text" class="qa-edit-url" placeholder="https://example.com" value="${(item.url||'').replace(/"/g,'&quot;')}" autocomplete="off">
        <input type="text" class="qa-edit-label" placeholder="\u041d\u0430\u0437\u0432\u0430\u043d\u0438\u0435" value="${(item.label||'').replace(/"/g,'&quot;')}" autocomplete="off" maxlength="12">
      </div>
      <div class="qa-add-row qa-colors-row">
        <span class="qa-color-label">\u041f\u043b\u0438\u0442\u043a\u0430:</span>
        <span class="qa-color-pair">
          <input type="color" class="qa-edit-color" value="${item.color || '#5a6b7a'}">
          <input type="text" class="qa-edit-hex" placeholder="EA195D" value="${(item.color || '#5a6b7a').slice(1)}" maxlength="7">
        </span>
        <span class="qa-color-label">\u0418\u043a\u043e\u043d\u043a\u0430:</span>
        <span class="qa-color-pair">
          <input type="color" class="qa-edit-icon-color" value="${item.iconColor || '#ffffff'}">
          <input type="text" class="qa-edit-icon-hex" placeholder="ffffff" value="${(item.iconColor || '#ffffff').slice(1)}" maxlength="7">
          <button type="button" class="qa-color-quick" data-target="icon" data-color="#ffffff" title="\u0411\u0435\u043b\u044b\u0439">\u25cb</button>
          <button type="button" class="qa-color-quick" data-target="icon" data-color="#000000" title="\u0427\u0451\u0440\u043d\u044b\u0439">\u25cf</button>
        </span>
      </div>
      <div class="qa-add-row qa-icon-row">
        <label class="qa-icon-label">\u0418\u043a\u043e\u043d\u043a\u0430:</label>
        <div class="qa-icon-types">
          <button type="button" class="qa-icon-type-btn active" data-type="keep">\u0422\u0435\u043a\u0443\u0449\u0430\u044f</button>
          <button type="button" class="qa-icon-type-btn" data-type="favicon">Favicon</button>
          <button type="button" class="qa-icon-type-btn" data-type="letter">\u0411\u0443\u043a\u0432\u0430</button>
          <button type="button" class="qa-icon-type-btn" data-type="svg">SVG URL</button>
          <button type="button" class="qa-icon-type-btn" data-type="upload">\u0424\u0430\u0439\u043b</button>
        </div>
        <input type="hidden" class="qa-edit-icon-type" value="keep">
        <input type="file" class="qa-edit-icon-file" accept=".svg,image/svg+xml" style="display:none">
      </div>
      <div class="qa-add-row qa-icon-value-row" style="display:none">
        <input type="text" class="qa-edit-icon-value" placeholder="\u0411\u0443\u043a\u0432\u0430 \u0438\u043b\u0438 URL" autocomplete="off">
      </div>
    </div>
    <div class="qa-add-actions">
      <div class="qa-add-spacer"></div>
      <button class="qa-add-cancel" type="button">\u041e\u0442\u043c\u0435\u043d\u0430</button>
      <button class="qa-edit-save" type="button">\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c</button>
    </div>`;

  const container = document.getElementById('quickAccess');
  container.parentNode.insertBefore(form, container.nextSibling);

  const typeHidden = form.querySelector('.qa-edit-icon-type');
  const valueRow = form.querySelector('.qa-icon-value-row');
  const valueInp = form.querySelector('.qa-edit-icon-value');
  const fileInp = form.querySelector('.qa-edit-icon-file');
  const typeBtns = form.querySelectorAll('.qa-icon-type-btn');

  // Sync tile color picker <-> hex input
  const editColor = form.querySelector('.qa-edit-color');
  const editHex = form.querySelector('.qa-edit-hex');
  syncColorHex(editColor, editHex);

  // Sync icon color picker <-> hex + quick buttons
  const editIconColor = form.querySelector('.qa-edit-icon-color');
  const editIconHex = form.querySelector('.qa-edit-icon-hex');
  syncColorHex(editIconColor, editIconHex);

  form.querySelectorAll('.qa-color-quick[data-target="icon"]').forEach(btn => {
    btn.addEventListener('click', () => {
      editIconColor.value = btn.dataset.color;
      editIconHex.value = btn.dataset.color.slice(1);
    });
  });

  let uploadedSvgDataUri = null;

  function setIconType(type) {
    typeHidden.value = type;
    typeBtns.forEach(b => b.classList.toggle('active', b.dataset.type === type));
    valueInp.removeAttribute('readonly');

    if (type === 'keep' || type === 'favicon') {
      valueRow.style.display = 'none';
      valueInp.value = '';
    } else if (type === 'upload') {
      valueRow.style.display = 'none';
      valueInp.value = '';
      uploadedSvgDataUri = null;
      fileInp.value = '';
      fileInp.click();
    } else {
      // letter or svg URL
      valueRow.style.display = '';
      valueInp.placeholder = type === 'letter' ? '\u0411\u0443\u043a\u0432\u0430' : 'https://.../icon.svg';
      valueInp.value = '';
      setTimeout(() => valueInp.focus(), 0);
    }
  }

  typeBtns.forEach(btn => {
    btn.addEventListener('click', () => setIconType(btn.dataset.type));
  });

  fileInp.addEventListener('change', () => {
    const file = fileInp.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const svgText = e.target.result;
      uploadedSvgDataUri = 'data:image/svg+xml;utf8,' + encodeURIComponent(svgText);
      valueRow.style.display = '';
      valueInp.value = file.name + '  \u2713';
      valueInp.setAttribute('readonly', 'readonly');
    };
    reader.onerror = () => {
      valueRow.style.display = '';
      valueInp.value = '\u274c \u041e\u0448\u0438\u0431\u043a\u0430 \u0447\u0442\u0435\u043d\u0438\u044f';
    };
    reader.readAsText(file);
  });

  form.querySelector('.qa-add-cancel').addEventListener('click', () => form.remove());

  form.querySelector('.qa-edit-save').addEventListener('click', () => {
    let url = form.querySelector('.qa-edit-url').value.trim();
    const label = form.querySelector('.qa-edit-label').value.trim();
    const color = readHexOrColor(editColor, editHex);
    const iconColor = readHexOrColor(editIconColor, editIconHex);
    const iconType = typeHidden.value;
    const iconValue = valueInp.value.trim();

    if (!url || !label) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    // Build updated entry
    const updated = { ...item, url, label, color, iconColor };

    // Use explicit null (not delete) so migration knows user cleared the field
    if (iconType === 'favicon') {
      let domain = '';
      try { domain = new URL(url).hostname; } catch {}
      updated.icon = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
      updated.letter = null;
    } else if (iconType === 'letter' && iconValue) {
      updated.letter = iconValue.charAt(0).toUpperCase();
      updated.icon = null;
    } else if (iconType === 'svg' && iconValue) {
      updated.icon = iconValue;
      updated.letter = null;
    } else if (iconType === 'upload' && uploadedSvgDataUri) {
      updated.icon = uploadedSvgDataUri;
      updated.letter = null;
    }
    // else 'keep' — icon/letter stays as is

    shortcuts[idx] = updated;
    saveShortcuts(shortcuts);
    renderQuickAccess();
    form.remove();
  });
}

/**
 * Open inline "Add Shortcuts" form — allows adding multiple at once.
 */
function openAddShortcutsForm() {
  document.querySelectorAll('.qa-add-form').forEach(el => el.remove());

  const form = document.createElement('div');
  form.className = 'qa-add-form';
  form.innerHTML = `
    <div class="qa-add-title">\u041d\u043e\u0432\u044b\u0435 \u044f\u0440\u043b\u044b\u043a\u0438</div>
    <div class="qa-add-rows" id="qaAddRows"></div>
    <div class="qa-add-actions">
      <button class="qa-add-more" type="button">+ \u0435\u0449\u0451 \u043e\u0434\u0438\u043d</button>
      <div class="qa-add-spacer"></div>
      <button class="qa-add-cancel" type="button">\u041e\u0442\u043c\u0435\u043d\u0430</button>
      <button class="qa-add-save" type="button">\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c</button>
    </div>`;

  const container = document.getElementById('quickAccess');
  container.parentNode.insertBefore(form, container.nextSibling);

  const rowsEl = form.querySelector('#qaAddRows');

  function addRow(focus = true) {
    const row = document.createElement('div');
    row.className = 'qa-add-row';
    // Random default color from a pleasant palette
    const palette = ['#5a7a62', '#5a6b7a', '#c8713a', '#b8892e', '#b35a5a', '#6466F1', '#8E75B2'];
    const defaultColor = palette[Math.floor(Math.random() * palette.length)];
    row.innerHTML = `
      <input type="text" class="qa-add-url" placeholder="https://example.com" autocomplete="off">
      <input type="text" class="qa-add-label" placeholder="\u041d\u0430\u0437\u0432\u0430\u043d\u0438\u0435" autocomplete="off" maxlength="12">
      <span class="qa-color-pair" title="\u0426\u0432\u0435\u0442 \u043f\u043b\u0438\u0442\u043a\u0438">
        <input type="color" class="qa-add-color" value="${defaultColor}">
        <input type="text" class="qa-add-hex" placeholder="EA195D" value="${defaultColor.slice(1)}" maxlength="7">
      </span>
      <span class="qa-color-pair qa-icon-color-pair" title="\u0426\u0432\u0435\u0442 \u0438\u043a\u043e\u043d\u043a\u0438">
        <input type="color" class="qa-add-icon-color" value="#ffffff">
        <input type="text" class="qa-add-icon-hex" placeholder="ffffff" value="ffffff" maxlength="7">
        <button type="button" class="qa-color-quick" data-color="#ffffff" title="\u0411\u0435\u043b\u044b\u0439">\u25cb</button>
        <button type="button" class="qa-color-quick" data-color="#000000" title="\u0427\u0451\u0440\u043d\u044b\u0439">\u25cf</button>
      </span>
      <button class="qa-add-remove" type="button" title="\u0423\u0434\u0430\u043b\u0438\u0442\u044c">\u00d7</button>`;
    rowsEl.appendChild(row);
    if (focus) row.querySelector('.qa-add-url').focus();

    row.querySelector('.qa-add-remove').addEventListener('click', () => {
      if (rowsEl.children.length > 1) row.remove();
    });

    // Sync color picker <-> hex input (tile color)
    const colorInp = row.querySelector('.qa-add-color');
    const hexInp = row.querySelector('.qa-add-hex');
    syncColorHex(colorInp, hexInp);

    // Sync icon color picker <-> hex + quick buttons
    const iconColorInp = row.querySelector('.qa-add-icon-color');
    const iconHexInp = row.querySelector('.qa-add-icon-hex');
    syncColorHex(iconColorInp, iconHexInp);

    row.querySelectorAll('.qa-color-quick').forEach(btn => {
      btn.addEventListener('click', () => {
        iconColorInp.value = btn.dataset.color;
        iconHexInp.value = btn.dataset.color.slice(1);
      });
    });
  }

  addRow();

  form.querySelector('.qa-add-more').addEventListener('click', () => addRow(true));
  form.querySelector('.qa-add-cancel').addEventListener('click', () => form.remove());

  form.querySelector('.qa-add-save').addEventListener('click', () => {
    const shortcuts = getShortcuts();
    const rows = rowsEl.querySelectorAll('.qa-add-row');
    let added = 0;

    for (const row of rows) {
      let url = row.querySelector('.qa-add-url').value.trim();
      const label = row.querySelector('.qa-add-label').value.trim();
      const color = readHexOrColor(row.querySelector('.qa-add-color'), row.querySelector('.qa-add-hex'));
      const iconColor = readHexOrColor(row.querySelector('.qa-add-icon-color'), row.querySelector('.qa-add-icon-hex'));
      if (!url || !label) continue;
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

      // Build entry — auto-use favicon for the domain
      let domain = '';
      try { domain = new URL(url).hostname; } catch {}
      const entry = {
        label: label,
        url: url,
        group: generateUniqueGroup(shortcuts),
        color: color,
        iconColor: iconColor,
      };
      if (domain) {
        entry.icon = `https://www.google.com/s2/favicons?domain=${domain}&sz=64`;
      } else {
        entry.letter = label.charAt(0).toUpperCase();
      }

      shortcuts.push(entry);
      added++;
    }

    if (added > 0) {
      saveShortcuts(shortcuts);
      renderQuickAccess();
    }
    form.remove();
  });
}


/* ----------------------------------------------------------------
   THEME TOGGLE (light / dark / auto)
   ---------------------------------------------------------------- */
const THEME_ICON_SUN = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32l1.41-1.41"/></svg>`;
const THEME_ICON_MOON = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path d="M21.752 15.002A9.718 9.718 0 0 1 18 15.75 9.75 9.75 0 0 1 8.25 6c0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25 9.75 9.75 0 0 0 12.75 21a9.753 9.753 0 0 0 8.002-5.998z"/></svg>`;
// Auto: half sun / half moon (circle split)
const THEME_ICON_AUTO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></svg>`;

// Parse "05:50 AM" / "08:06 PM" → minutes from midnight
function parseTimeToMinutes(s) {
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const period = (m[3] || '').toUpperCase();
  if (period === 'PM' && h < 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

// Decide light/dark based on cached sunrise/sunset from /api/weather
let astroSunrise = null; // minutes from midnight
let astroSunset = null;

async function fetchAstro() {
  try {
    const w = await fetchWeather();
    if (!w) return;
    astroSunrise = parseTimeToMinutes(w.sunrise);
    astroSunset  = parseTimeToMinutes(w.sunset);
  } catch {}
}

function isDaylightNow() {
  if (astroSunrise === null || astroSunset === null) {
    // Fallback: 6:00-20:00 is "day"
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes();
    return m >= 360 && m < 1200;
  }
  const now = new Date();
  const m = now.getHours() * 60 + now.getMinutes();
  return m >= astroSunrise && m < astroSunset;
}

function applyThemeMode(mode) {
  let resolved; // actual theme to apply: 'light' or 'dark'
  if (mode === 'auto') {
    resolved = isDaylightNow() ? 'light' : 'dark';
  } else {
    resolved = mode;
  }
  if (resolved === 'dark') {
    document.documentElement.dataset.theme = 'dark';
  } else {
    delete document.documentElement.dataset.theme;
  }
}

function getThemeMode() {
  const m = mem.themeMode;
  return (m === 'light' || m === 'dark' || m === 'auto') ? m : 'light';
}

function setThemeMode(mode) {
  mem.themeMode = mode;
  Storage.set('tabout-theme-mode', mode).catch(() => {});
  applyThemeMode(mode);
  updateThemeIcon();
  if (typeof renderQuickAccess === 'function') renderQuickAccess();
}

function updateThemeIcon() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const mode = getThemeMode();
  const icon = mode === 'auto' ? THEME_ICON_AUTO
              : mode === 'dark' ? THEME_ICON_SUN
              : THEME_ICON_MOON;
  btn.innerHTML = icon;
  const titles = { light: '\u0421\u0432\u0435\u0442\u043b\u0430\u044f', dark: '\u0422\u0451\u043c\u043d\u0430\u044f', auto: '\u0410\u0432\u0442\u043e (\u043f\u043e \u0441\u043e\u043b\u043d\u0446\u0443)' };
  btn.title = '\u0422\u0435\u043c\u0430: ' + titles[mode];
}

function initThemeToggle() {
  applyThemeMode(getThemeMode());
  updateThemeIcon();

  const btn = document.getElementById('themeToggle');
  if (btn) {
    btn.addEventListener('click', () => {
      // Cycle: light → dark → auto → light
      const order = ['light', 'dark', 'auto'];
      const cur = getThemeMode();
      const next = order[(order.indexOf(cur) + 1) % order.length];
      setThemeMode(next);
    });
  }

  // Load astronomy and re-apply if in auto mode
  fetchAstro().then(() => {
    if (getThemeMode() === 'auto') setThemeMode('auto');
  });

  // Re-evaluate auto theme every minute (day/night transitions)
  // Paused when tab is not visible.
  setVisibleInterval(() => {
    if (getThemeMode() === 'auto') {
      const wasDark = document.documentElement.dataset.theme === 'dark';
      applyThemeMode('auto');
      const isDark = document.documentElement.dataset.theme === 'dark';
      if (wasDark !== isDark && typeof renderQuickAccess === 'function') {
        renderQuickAccess();
      }
    }
  }, 60_000, { runOnVisible: false });
}

// Init theme immediately (before render) to avoid flash
initThemeToggle();


/* ================================================================
   SETTINGS MODAL — city picker, currencies, export/import
   ================================================================ */

const AVAILABLE_CURRENCIES = [
  { code: 'USD',  label: 'USD — US Dollar',     type: 'fiat' },
  { code: 'EUR',  label: 'EUR — Euro',           type: 'fiat' },
  { code: 'GBP',  label: 'GBP — British Pound',  type: 'fiat' },
  { code: 'CNY',  label: 'CNY — Chinese Yuan',   type: 'fiat' },
  { code: 'JPY',  label: 'JPY — Japanese Yen',   type: 'fiat' },
  { code: 'CHF',  label: 'CHF — Swiss Franc',    type: 'fiat' },
  { code: 'TRY',  label: 'TRY — Turkish Lira',   type: 'fiat' },
  { code: 'AED',  label: 'AED — UAE Dirham',     type: 'fiat' },
  { code: 'BTC',  label: 'BTC — Bitcoin',        type: 'crypto' },
  { code: 'ETH',  label: 'ETH — Ethereum',       type: 'crypto' },
  { code: 'SOL',  label: 'SOL — Solana',         type: 'crypto' },
  { code: 'TON',  label: 'TON — Toncoin',        type: 'crypto' },
];

function openSettings() {
  const modal = document.getElementById('settingsModal');
  if (!modal) return;
  modal.style.display = 'flex';
  renderSettingsContents();
}

function closeSettings() {
  const modal = document.getElementById('settingsModal');
  if (modal) modal.style.display = 'none';
}

function renderSettingsContents() {
  // Tab title
  const titleInput = document.getElementById('tabTitleInput');
  if (titleInput) titleInput.value = settings.tabTitle ?? 'Tab Out';

  // Tile size display
  const sizeDisplay = document.getElementById('sizeDisplay');
  if (sizeDisplay) sizeDisplay.textContent = Math.round((settings.tileScale ?? 1) * 100) + '%';

  // Metrics checkboxes
  const metricsEl = document.getElementById('settingsMetrics');
  if (metricsEl) {
    const m = { ...DEFAULT_SETTINGS.metrics, ...(settings.metrics || {}) };
    metricsEl.innerHTML = METRICS_LIST.map(({ key, label }) => {
      const checked = m[key] ? 'checked' : '';
      return `<label class="settings-currency-item">
        <input type="checkbox" data-metric="${key}" ${checked}> ${label}
      </label>`;
    }).join('');
    metricsEl.querySelectorAll('input[data-metric]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const key = cb.dataset.metric;
        const cur = { ...DEFAULT_SETTINGS.metrics, ...(settings.metrics || {}) };
        cur[key] = cb.checked;
        await saveSettings({ metrics: cur });
        renderSystemStats();
      });
    });
  }

  // Ping hosts editor
  renderSettingsPings();

  // Current city
  const curEl = document.getElementById('settingsCurrentCity');
  if (curEl) {
    curEl.innerHTML = settings.weatherCity
      ? `<span>\u2713 ${settings.weatherCity.name} <small>(${settings.weatherCity.lat.toFixed(2)}, ${settings.weatherCity.lon.toFixed(2)})</small></span>`
      : '';
  }

  // Currencies checkboxes
  const curListEl = document.getElementById('settingsCurrencies');
  if (curListEl) {
    curListEl.innerHTML = AVAILABLE_CURRENCIES.map(c => {
      const checked = settings.currencies.includes(c.code) ? 'checked' : '';
      return `<label class="settings-currency-item">
        <input type="checkbox" value="${c.code}" ${checked}> ${c.label}
      </label>`;
    }).join('');

    curListEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const code = cb.value;
        let list = [...settings.currencies];
        if (cb.checked && !list.includes(code)) list.push(code);
        if (!cb.checked) list = list.filter(c => c !== code);
        await saveSettings({ currencies: list });
        renderRates();
      });
    });
  }
}

function renderSettingsPings() {
  const el = document.getElementById('settingsPings');
  if (!el) return;
  const list = mem.pingHosts && mem.pingHosts.length ? mem.pingHosts : PING_HOSTS;
  el.innerHTML = list.map((h, idx) => `
    <div class="ping-row" data-idx="${idx}">
      <input type="text" class="ping-name" value="${(h.name||'').replace(/"/g,'&quot;')}" placeholder="Label">
      <input type="text" class="ping-host" value="${(h.host||'').replace(/"/g,'&quot;')}" placeholder="example.com">
      <button class="ping-remove" title="Remove">\u00d7</button>
    </div>
  `).join('');

  function saveFromUI() {
    const rows = el.querySelectorAll('.ping-row');
    const newList = [];
    rows.forEach(row => {
      const name = row.querySelector('.ping-name').value.trim();
      const host = row.querySelector('.ping-host').value.trim()
        .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (name && host) newList.push({ name, host });
    });
    mem.pingHosts = newList;
    Storage.set('tabout-ping-hosts', newList).catch(() => {});
    pingCache = { data: null, ts: 0 }; // invalidate cache so new hosts ping immediately
    renderPingStats();
  }

  el.querySelectorAll('.ping-name, .ping-host').forEach(inp => {
    inp.addEventListener('change', saveFromUI);
    inp.addEventListener('blur', saveFromUI);
  });
  el.querySelectorAll('.ping-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.closest('.ping-row').remove();
      saveFromUI();
      renderSettingsPings();
    });
  });
}

// City autocomplete (Open-Meteo Geocoding API — supports RU/EN)
async function searchCities(query) {
  if (!query || query.length < 2) return [];
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=ru`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.results || [];
  } catch { return []; }
}

function initSettingsUI() {
  const btn = document.getElementById('settingsToggle');
  const modal = document.getElementById('settingsModal');
  if (!btn || !modal) return;

  btn.addEventListener('click', openSettings);

  // Close on backdrop / X
  modal.addEventListener('click', (e) => {
    if (e.target.dataset?.close === '1') closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display !== 'none') closeSettings();
  });

  // City autocomplete
  const input = document.getElementById('citySearch');
  const dropdown = document.getElementById('cityDropdown');
  let debounceTimer = null;

  input?.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(debounceTimer);
    if (!q || q.length < 2) { dropdown.style.display = 'none'; return; }

    // Show loading state immediately so user gets feedback
    dropdown.innerHTML = '<div class="city-option" style="opacity:0.5;cursor:default">Searching...</div>';
    dropdown.style.display = 'block';

    debounceTimer = setTimeout(async () => {
      const results = await searchCities(q);
      if (!results || !results.length) {
        dropdown.innerHTML = '<div class="city-option" style="opacity:0.5;cursor:default">No cities found</div>';
        return;
      }
      dropdown.innerHTML = results.map(r => {
        const label = r.name + (r.admin1 ? `, ${r.admin1}` : '') + (r.country ? `, ${r.country}` : '');
        return `<div class="city-option" data-name="${r.name.replace(/"/g,'&quot;')}" data-lat="${r.latitude}" data-lon="${r.longitude}">${label}</div>`;
      }).join('');

      dropdown.querySelectorAll('.city-option[data-name]').forEach(el => {
        el.addEventListener('click', async () => {
          const city = {
            name: el.dataset.name,
            lat: parseFloat(el.dataset.lat),
            lon: parseFloat(el.dataset.lon),
          };
          await saveSettings({ weatherCity: city });
          // Clear old weather/aqi caches so new city's data loads
          const all = await Storage.getAll();
          for (const k of Object.keys(all)) {
            if (k.startsWith('cache:https://wttr.in/') || k.startsWith('cache:https://air-quality-api.open-meteo.com/')) {
              await Storage.remove(k);
            }
          }
          renderSettingsContents();
          dropdown.style.display = 'none';
          input.value = '';
          renderWeather();
          renderAqi();
        });
      });
    }, 300);
  });

  // Close dropdown on outside click
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.settings-city-input-wrap')) {
      if (dropdown) dropdown.style.display = 'none';
    }
  });

  // Tab title — live update document.title
  const titleInput = document.getElementById('tabTitleInput');
  if (titleInput) {
    let saveTimer = null;
    titleInput.addEventListener('input', () => {
      const v = titleInput.value.trim() || 'Tab Out';
      document.title = v;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => saveSettings({ tabTitle: v }), 300);
    });
  }

  // Add ping host
  document.getElementById('addPingBtn')?.addEventListener('click', () => {
    const cur = mem.pingHosts && mem.pingHosts.length ? [...mem.pingHosts] : [...PING_HOSTS];
    cur.push({ name: 'New', host: 'example.com' });
    mem.pingHosts = cur;
    Storage.set('tabout-ping-hosts', cur).catch(() => {});
    renderSettingsPings();
  });

  // Tile size buttons
  document.querySelectorAll('.size-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const delta = parseInt(btn.dataset.delta, 10);
      const current = settings.tileScale ?? 1.0;
      const next = Math.max(0.5, Math.min(2.5, Math.round((current + delta / 100) * 100) / 100));
      await saveSettings({ tileScale: next });
      applyTileScale(next);
    });
  });
  document.getElementById('sizeReset')?.addEventListener('click', async () => {
    await saveSettings({ tileScale: 1.0 });
    applyTileScale(1.0);
  });

  // Export
  document.getElementById('exportBtn')?.addEventListener('click', async () => {
    const all = await Storage.getAll();
    const userData = Object.fromEntries(
      Object.entries(all).filter(([k]) => !k.startsWith('cache:'))
    );
    const json = JSON.stringify({
      version: 2,
      exported: new Date().toISOString(),
      data: userData,
    }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tabout-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast('Exported');
  });

  // Import
  document.getElementById('importBtn')?.addEventListener('click', () => {
    document.getElementById('importFile')?.click();
  });
  document.getElementById('importFile')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);

      // Accept three formats:
      //   1. Full backup: { version, data: { 'tabout-shortcuts': [...], ... } }
      //   2. Plain shortcuts array: [{ label, url, color, icon, ... }, ...]
      //   3. Recovery dump: { 'tabout-shortcuts': [...], 'tabout-pinned': [...], ... }
      let dataToImport;
      if (Array.isArray(parsed)) {
        // Format 2: just shortcuts
        if (!confirm('Это похоже на массив ярлыков. Заменить текущие Quick Access?')) { e.target.value = ''; return; }
        dataToImport = { 'tabout-shortcuts': parsed };
      } else if (parsed.data && typeof parsed.data === 'object') {
        // Format 1: full backup
        dataToImport = parsed.data;
      } else if (parsed['tabout-shortcuts'] || parsed['tabout-pinned'] || parsed['tabout-settings']) {
        // Format 3: raw storage dump
        dataToImport = parsed;
      } else {
        throw new Error('Unrecognized file format');
      }

      // Wipe non-cache keys first (only for keys we're about to overwrite), then restore
      const toWriteKeys = Object.keys(dataToImport);
      for (const k of toWriteKeys) {
        await Storage.remove(k);
      }
      await chrome.storage.local.set(dataToImport);
      showToast('Imported — reloading...');
      setTimeout(() => location.reload(), 800);
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
    e.target.value = '';
  });
}

initSettingsUI();


/* ----------------------------------------------------------------
   WEATHER ICONS — wttr.in codes mapped to weather-icons font classes
   https://github.com/erikflowers/weather-icons
   ---------------------------------------------------------------- */

// Map wttr.in moon_phase string to a Weather Icons class
function moonPhaseToClass(phase) {
  if (!phase) return null;
  const map = {
    'New Moon':         'wi-moon-new',
    'Waxing Crescent':  'wi-moon-waxing-crescent-3',
    'First Quarter':    'wi-moon-first-quarter',
    'Waxing Gibbous':   'wi-moon-waxing-gibbous-3',
    'Full Moon':        'wi-moon-full',
    'Waning Gibbous':   'wi-moon-waning-gibbous-3',
    'Last Quarter':     'wi-moon-third-quarter',
    'Waning Crescent':  'wi-moon-waning-crescent-3',
  };
  return map[phase] || 'wi-moon-full';
}

function weatherCodeToClass(code, isNight) {
  const c = Number(code);
  if (c === 113) return isNight ? 'wi-night-clear' : 'wi-day-sunny';
  if (c === 116) return isNight ? 'wi-night-alt-cloudy' : 'wi-day-cloudy';
  if (c === 119) return 'wi-cloudy';
  if (c === 122) return 'wi-cloud';
  if ([143, 248, 260].includes(c)) return isNight ? 'wi-night-fog' : 'wi-day-fog';
  if ([176, 263, 266, 293, 296].includes(c)) return isNight ? 'wi-night-alt-sprinkle' : 'wi-day-sprinkle';
  if ([299, 302, 353, 356].includes(c)) return isNight ? 'wi-night-alt-showers' : 'wi-day-showers';
  if ([305, 308, 311, 314, 359].includes(c)) return isNight ? 'wi-night-alt-rain' : 'wi-day-rain';
  if ([179, 182, 185, 323, 326].includes(c)) return isNight ? 'wi-night-alt-snow' : 'wi-day-snow';
  if ([227, 230, 329, 332, 335, 338].includes(c)) return 'wi-snow-wind';
  if ([317, 320, 362, 365, 368, 371, 374, 377].includes(c)) return 'wi-sleet';
  if ([200, 386, 389, 392, 395].includes(c)) return isNight ? 'wi-night-alt-thunderstorm' : 'wi-day-thunderstorm';
  return 'wi-cloudy';
}

/**
 * fetchWeather() — wttr.in direct, returns same shape as old /api/weather.
 * Uses settings.weatherCity for the location.
 */
async function fetchWeather() {
  const city = settings.weatherCity?.name || 'Verkhnyaya Pyshma';
  const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
  const raw = await cachedFetch(url, 30 * 60 * 1000);
  if (!raw) return null;
  const current = raw.current_condition?.[0] || {};
  const today = raw.weather?.[0] || {};
  const hourly = today.hourly || [];
  const dayEntry = hourly.find(h => h.time === '1200') || hourly[4] || {};
  const nightEntry = hourly.find(h => h.time === '0') || hourly[0] || {};
  const tomorrow = raw.weather?.[1] || {};
  const tmHourly = tomorrow.hourly || [];
  const tmDayEntry = tmHourly.find(h => h.time === '1200') || tmHourly[4] || {};
  const tmNightEntry = tmHourly.find(h => h.time === '0') || tmHourly[0] || {};
  const astro = today.astronomy?.[0] || {};
  return {
    temp: current.temp_C,
    feelsLike: current.FeelsLikeC,
    description: current.weatherDesc?.[0]?.value || '',
    weatherCode: current.weatherCode,
    dayHigh: today.maxtempC,
    dayLow: today.mintempC,
    dayCode: dayEntry.weatherCode || current.weatherCode,
    nightCode: nightEntry.weatherCode || current.weatherCode,
    tomorrowHigh: tomorrow.maxtempC || null,
    tomorrowLow: tomorrow.mintempC || null,
    tomorrowDayCode: tmDayEntry.weatherCode || '119',
    tomorrowNightCode: tmNightEntry.weatherCode || '113',
    sunrise: astro.sunrise || null,
    sunset: astro.sunset || null,
    moonPhase: astro.moon_phase || null,
    moonIllumination: astro.moon_illumination || null,
  };
}

/**
 * renderWeather() — direct fetch from wttr.in, no server needed.
 */
async function renderWeather() {
  const el = document.getElementById('headerWeather');
  if (!el) return;
  try {
    const w = await fetchWeather();
    if (!w) return;
    // (keep original rendering logic below — emulate old { ok, json() } response shape)
    { const res = { ok: true, json: async () => w };

    // Determine if it's currently night (between 21:00 and 6:00)
    const hour = new Date().getHours();
    const isNight = hour >= 21 || hour < 6;

    const mainClass = weatherCodeToClass(w.weatherCode, isNight);
    const dayClass = weatherCodeToClass(w.dayCode, false);
    const nightClass = weatherCodeToClass(w.nightCode, true);

    // Tomorrow forecast
    let tomorrowHtml = '';
    if (w.tomorrowHigh !== null) {
      const tmDayClass = weatherCodeToClass(w.tomorrowDayCode, false);
      const tmNightClass = weatherCodeToClass(w.tomorrowNightCode, true);
      tomorrowHtml = `<div class="weather-forecast weather-tomorrow">
        <span class="weather-label">\u0437\u0430\u0432\u0442\u0440\u0430</span>
        <span class="weather-day"><i class="wi ${tmDayClass}"></i> ${w.tomorrowHigh}\u00b0</span>
        <span class="weather-night"><i class="wi ${tmNightClass}"></i> ${w.tomorrowLow}\u00b0</span>
      </div>`;
    }

    // Fetch AQI (air quality) separately — it's for the same location
    let aqiHtml = '<div class="weather-aqi" id="weatherAqi"></div>';

    el.innerHTML = `
      <i class="wi ${mainClass} weather-icon"></i>
      <div class="weather-info">
        <div class="weather-current">${w.temp}\u00b0 <small>/ ${w.feelsLike}\u00b0</small></div>
        <div class="weather-forecast">
          <span class="weather-day"><i class="wi ${dayClass}"></i> ${w.dayHigh}\u00b0</span>
          <span class="weather-night"><i class="wi ${nightClass}"></i> ${w.dayLow}\u00b0</span>
        </div>
        ${tomorrowHtml}
        ${aqiHtml}
      </div>`;
    // Load AQI into its placeholder
    renderAqi();

    // Render astronomy inline after the date
    const astroEl = document.getElementById('astroLine');
    if (astroEl && w.sunrise && w.sunset) {
      const to24h = (t) => {
        const [time, period] = t.split(' ');
        let [h, m] = time.split(':').map(Number);
        if (period === 'PM' && h < 12) h += 12;
        if (period === 'AM' && h === 12) h = 0;
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      };
      const moonIconClass = moonPhaseToClass(w.moonPhase);
      astroEl.innerHTML = `
        <span class="astro-sep">\u2022</span>
        <span><i class="wi wi-sunrise"></i> ${to24h(w.sunrise)}</span>
        <span><i class="wi wi-sunset"></i> ${to24h(w.sunset)}</span>
        ${moonIconClass ? `<span><i class="wi ${moonIconClass}"></i></span>` : ''}
      `;
    }
    } // end of wrapper block opened above
  } catch { /* fail silently */ }
}

/**
 * formatUptime(seconds) — returns human-readable uptime ("3d 4h", "6h 22m")
 */
function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}\u0434 ${h}\u0447`;
  if (h > 0) return `${h}\u0447 ${m}\u043c`;
  return `${m}\u043c`;
}

/**
 * fetchSystemInfo() — collects live system metrics from:
 *  - chrome.system.memory      → RAM
 *  - chrome.system.storage     → C: drive size/free
 *  - Libre Hardware Monitor (http://localhost:8085/data.json) → CPU/GPU temps + CPU load
 *
 * Uptime is the extension/browser uptime (there's no OS uptime in extension context).
 */
async function fetchSystemInfo() {
  const result = {
    cpu: null,         // % CPU load (from LHM)
    gpuLoad: null,     // % GPU load (from LHM)
    ramUsed: null, ramTotal: null,
    diskFree: null, diskTotal: null,
    cpuTemp: null,     // °C
    gpuTemp: null,     // °C
    vramUsed: null, vramTotal: null, // GB VRAM
    fanRpm: null,      // max fan RPM
    uptime: Math.round((Date.now() - (performance.timeOrigin || Date.now())) / 1000),
  };

  // RAM via chrome.system.memory
  if (chrome?.system?.memory) {
    try {
      const mem = await new Promise(res => chrome.system.memory.getInfo(res));
      if (mem) {
        result.ramTotal = Math.round(mem.capacity / 1e9);
        result.ramUsed = Math.round((mem.capacity - mem.availableCapacity) / 1e9 * 10) / 10;
      }
    } catch {}
  }

  // Disk via chrome.system.storage (take the largest fixed drive — usually C:)
  if (chrome?.system?.storage) {
    try {
      const storages = await new Promise(res => chrome.system.storage.getInfo(res));
      // Find C: — usually first "fixed" type, or largest capacity
      let main = null;
      for (const s of storages || []) {
        if (s.type === 'fixed' && (!main || s.capacity > main.capacity)) main = s;
      }
      // chrome.system.storage doesn't give free space — fallback: try LHM or leave null
      if (main) {
        result.diskTotal = Math.round(main.capacity / 1e9);
      }
    } catch {}
  }

  // LHM data: CPU load, temps, AND disk free (LHM sees nvme/hdd)
  try {
    const resp = await fetch('http://localhost:8085/data.json',
      { signal: AbortSignal.timeout(1500) });
    if (resp.ok) {
      const data = await resp.json();
      parseLhmData(data, result);
    }
  } catch {}

  return result;
}

function parseLhmData(tree, result) {
  const cpuTemps = [];
  const gpuTemps = [];
  let cpuLoad = null;
  let gpuLoad = null;
  let gpuMemUsed = null, gpuMemTotal = null;
  let fanRpms = [];
  let diskFreeGB = null, diskTotalGB = null, diskUsedPct = null;

  function walk(n) {
    if (!n) return;
    const text = n.Text || '';
    const val  = parseFloat(String(n.Value || '').replace(',', '.'));
    const type = n.Type || '';
    const sensorId = n.SensorId || '';

    // CPU temps
    if (type === 'Temperature' && /CPU (Package|Total|Core)/i.test(text) && !isNaN(val)) {
      if (/CPU Package|Core Average|Core Max/i.test(text)) cpuTemps.push(val);
    }
    // GPU temps
    if (type === 'Temperature' && /GPU (Core|Hot Spot)/i.test(text) && !isNaN(val) && /Core/i.test(text)) {
      gpuTemps.push(val);
    }
    // CPU load
    if (type === 'Load' && /CPU Total/i.test(text) && !isNaN(val)) {
      cpuLoad = val;
    }
    // GPU load
    if (type === 'Load' && /GPU Core/i.test(text) && !isNaN(val)) {
      gpuLoad = val;
    }
    // GPU memory
    if (type === 'SmallData' && /GPU Memory Used/i.test(text) && !isNaN(val)) gpuMemUsed = val;
    if (type === 'SmallData' && /GPU Memory Total/i.test(text) && !isNaN(val)) gpuMemTotal = val;
    // Fan RPM
    if (type === 'Fan' && !isNaN(val) && val > 0) fanRpms.push(val);
    // Disk free / total / used% — prefer the first nvme/0 or hdd/0 (system drive)
    if (type === 'Data' && /^\/nvme\/0\/|^\/hdd\/0\//.test(sensorId)) {
      if (/Free Space/i.test(text) && !isNaN(val))  diskFreeGB  = val;
      if (/Total Space/i.test(text) && !isNaN(val)) diskTotalGB = val;
    }
    if (type === 'Load' && /^\/nvme\/0\/|^\/hdd\/0\//.test(sensorId) && /Used Space/i.test(text) && !isNaN(val)) {
      diskUsedPct = val;
    }

    (n.Children || []).forEach(walk);
  }
  walk(tree);

  if (cpuTemps.length) result.cpuTemp = Math.round(cpuTemps[0]);
  if (gpuTemps.length) result.gpuTemp = Math.round(gpuTemps[0]);
  if (cpuLoad !== null) result.cpu = Math.round(cpuLoad);
  if (gpuLoad !== null) result.gpuLoad = Math.round(gpuLoad);
  if (gpuMemUsed !== null && gpuMemTotal !== null) {
    result.vramUsed = Math.round(gpuMemUsed / 1024 * 10) / 10; // MB → GB
    result.vramTotal = Math.round(gpuMemTotal / 1024);
  }
  if (fanRpms.length) result.fanRpm = Math.round(Math.max(...fanRpms));
  if (diskFreeGB !== null)  result.diskFree  = Math.round(diskFreeGB);
  if (diskTotalGB !== null) result.diskTotal = Math.round(diskTotalGB);
  if (diskUsedPct !== null) result.diskUsedPct = Math.round(diskUsedPct);
}

/**
 * renderSystemStats() — gathers fresh metrics and renders the row.
 */
async function renderSystemStats() {
  const el = document.getElementById('systemStats');
  if (!el) return;
  try {
    const s = await fetchSystemInfo();
    if (!s) return;

    const m = settings.metrics || DEFAULT_SETTINGS.metrics;
    const parts = [];
    if (m.cpu     && s.cpu !== null)       parts.push(`<span class="sys-metric"><b>CPU</b> ${s.cpu}%</span>`);
    if (m.gpuLoad && s.gpuLoad !== null)   parts.push(`<span class="sys-metric"><b>GPU</b> ${s.gpuLoad}%</span>`);
    if (m.ram     && s.ramTotal !== null)  parts.push(`<span class="sys-metric"><b>RAM</b> ${s.ramUsed}/${s.ramTotal}\u202f\u0413\u0411</span>`);
    if (m.disk && s.diskFree !== null && s.diskTotal !== null) {
      const used = Math.max(0, s.diskTotal - s.diskFree);
      parts.push(`<span class="sys-metric"><b>C:</b> ${used}/${s.diskTotal}\u202f\u0413\u0411</span>`);
    } else if (m.disk && s.diskTotal !== null) {
      // LHM not running — show just total capacity with (total) marker
      parts.push(`<span class="sys-metric" title="Total capacity (install LHM for used/free)"><b>C:</b> ${s.diskTotal}\u202f\u0413\u0411</span>`);
    }
    if (m.cpuTemp && s.cpuTemp !== null)   parts.push(`<span class="sys-metric"><b>CPU</b> ${s.cpuTemp}\u00b0</span>`);
    if (m.gpuTemp && s.gpuTemp !== null)   parts.push(`<span class="sys-metric"><b>GPU</b> ${s.gpuTemp}\u00b0</span>`);
    if (m.vram    && s.vramTotal !== null) parts.push(`<span class="sys-metric"><b>VRAM</b> ${s.vramUsed}/${s.vramTotal}\u202f\u0413\u0411</span>`);
    if (m.fan     && s.fanRpm !== null)    parts.push(`<span class="sys-metric"><b>Fan</b> ${s.fanRpm}\u202frpm</span>`);
    if (m.uptime)                          parts.push(`<span class="sys-metric"><b>up</b> ${formatUptime(s.uptime)}</span>`);

    el.innerHTML = parts.join('<span class="sys-sep">\u00b7</span>');
  } catch { /* silent */ }
}

// Refresh system stats every 5 seconds — paused when tab not visible.
setVisibleInterval(renderSystemStats, 5000, { runOnVisible: true });

/**
 * PING_HOSTS — domains we ping from the new tab.
 * Override via chrome.storage 'tabout-ping-hosts' if user wants a custom list.
 */
const PING_HOSTS = [
  { name: 'Google', host: 'google.com' },
  { name: 'GitHub', host: 'github.com' },
  { name: 'CF',     host: 'cloudflare.com' },
];

/**
 * pingHost(host) — times a no-cors HEAD-like fetch of /favicon.ico.
 * Returns { ok: boolean, ms: number | null }.
 * Uses `no-cors` so CORS failures don't throw.
 */
async function pingHost(host) {
  const url = `https://${host}/favicon.ico?_=${Date.now()}`;
  const start = performance.now();
  try {
    await fetch(url, {
      mode: 'no-cors',
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    return { ok: true, ms: Math.round(performance.now() - start) };
  } catch {
    return { ok: false, ms: null };
  }
}

let pingCache = { data: null, ts: 0 };
const PING_TTL = 30_000;

async function fetchPings() {
  if (pingCache.data && Date.now() - pingCache.ts < PING_TTL) return pingCache.data;
  const hosts = (mem.pingHosts && mem.pingHosts.length) ? mem.pingHosts : PING_HOSTS;
  const list = await Promise.all(hosts.map(async h => ({
    ...h,
    ...(await pingHost(h.host)),
  })));
  pingCache = { data: list, ts: Date.now() };
  return list;
}

/**
 * renderPingStats() — HTTP ping via direct fetch.
 */
async function renderPingStats() {
  const el = document.getElementById('pingStats');
  if (!el) return;
  try {
    const list = await fetchPings();
    if (!list) return;
    el.innerHTML = list.map(p => {
      const dot = p.ok ? '\u25cf' : '\u25cb';
      const dotCls = p.ok
        ? (p.ms < 100 ? 'ping-ok' : p.ms < 300 ? 'ping-slow' : 'ping-bad')
        : 'ping-dead';
      const txt = p.ok ? `${p.ms}\u202fms` : 'down';
      return `<span class="ping-item"><span class="ping-dot ${dotCls}">${dot}</span>${p.name} ${txt}</span>`;
    }).join('<span class="sys-sep">\u00b7</span>');
  } catch {}
}

// Refresh pings every 60 seconds — paused when tab not visible.
setVisibleInterval(renderPingStats, 60_000, { runOnVisible: true });

/**
 * renderTopNews() — no-op (removed from UI).
 */
async function renderTopNews() {}

/**
 * renderHoliday() — today's public holiday (RU) via nager.at, direct fetch.
 */
async function renderHoliday() {
  const el = document.getElementById('holidayLine');
  if (!el) return;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const year = new Date().getFullYear();
    const list = await cachedFetch(`https://date.nager.at/api/v3/PublicHolidays/${year}/RU`, 24 * 60 * 60 * 1000);
    if (!list) { el.innerHTML = ''; return; }
    const match = list.find(h => h.date === today);
    if (match) {
      const name = match.localName || match.name;
      el.innerHTML = `<span class="holiday-icon">\u{1f389}</span> \u0421\u0435\u0433\u043e\u0434\u043d\u044f: <b>${name}</b>`;
    } else {
      el.innerHTML = '';
    }
  } catch { if (el) el.innerHTML = ''; }
}

/**
 * runSpeedtest() — measures down/up/ping through Cloudflare directly.
 * Saves result into chrome.storage.local under 'speedtest-result'.
 */
async function runSpeedtest() {
  // Ping
  const pingStart = Date.now();
  try {
    const r = await fetch('https://speed.cloudflare.com/__down?bytes=1000', {
      signal: AbortSignal.timeout(5000), cache: 'no-store',
    });
    await r.arrayBuffer();
  } catch { throw new Error('ping failed'); }
  const ping = Date.now() - pingStart;

  // Download 25 MB
  const dlBytes = 25_000_000;
  const dlStart = Date.now();
  const dlResp = await fetch(`https://speed.cloudflare.com/__down?bytes=${dlBytes}`, {
    signal: AbortSignal.timeout(60_000), cache: 'no-store',
  });
  const dlBuf = await dlResp.arrayBuffer();
  const dlMs = Date.now() - dlStart;
  const downMbps = ((dlBuf.byteLength * 8) / (dlMs / 1000)) / 1_000_000;

  // Upload 5 MB
  const upSize = 5_000_000;
  const upBody = new Uint8Array(upSize);
  const upStart = Date.now();
  await fetch('https://speed.cloudflare.com/__up', {
    method: 'POST', body: upBody,
    signal: AbortSignal.timeout(60_000),
  });
  const upMs = Date.now() - upStart;
  const upMbps = ((upSize * 8) / (upMs / 1000)) / 1_000_000;

  const result = {
    down: Math.round(downMbps * 10) / 10,
    up: Math.round(upMbps * 10) / 10,
    ping: ping,
    ts: new Date().toISOString(),
  };
  await Storage.set('speedtest-result', result);
  return result;
}

/**
 * renderSpeedtest() — show last saved speedtest result + run button
 */
async function renderSpeedtest() {
  const el = document.getElementById('speedtestLine');
  if (!el) return;
  try {
    const s = await Storage.get('speedtest-result', { down: null, up: null, ping: null, ts: null });
    const hasData = s && s.down !== null;
    const when = s?.ts ? timeAgo(s.ts) : '\u043d\u0435 \u0437\u0430\u043f\u0443\u0441\u043a\u0430\u043b\u0441\u044f';
    const display = hasData
      ? `<span class="st-metric"><b>\u2193</b> ${s.down}\u202fMbps</span>
         <span class="st-metric"><b>\u2191</b> ${s.up}\u202fMbps</span>
         <span class="st-metric"><b>ping</b> ${s.ping}\u202fms</span>
         <span class="st-when">${when}</span>`
      : `<span class="st-when">\u0421\u043a\u043e\u0440\u043e\u0441\u0442\u044c \u0438\u043d\u0442\u0435\u0440\u043d\u0435\u0442\u0430 \u043d\u0435 \u0437\u0430\u043c\u0435\u0440\u044f\u043b\u0430\u0441\u044c</span>`;
    el.innerHTML = `${display}
      <button class="st-run" id="speedtestRun" title="\u0417\u0430\u043f\u0443\u0441\u0442\u0438\u0442\u044c \u0437\u0430\u043c\u0435\u0440">\u21bb</button>`;

    document.getElementById('speedtestRun').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.classList.add('spinning');
      try {
        await runSpeedtest();
      } catch {}
      await renderSpeedtest();
    });
  } catch {}
}

/**
 * fetchAqi() — air quality index via Open-Meteo, returns { aqi, delta, pm25 }.
 */
async function fetchAqi() {
  const lat = settings.weatherCity?.lat ?? 56.97;
  const lon = settings.weatherCity?.lon ?? 60.57;
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=us_aqi,pm2_5&past_days=1&forecast_days=1`;
  const raw = await cachedFetch(url, 60 * 60 * 1000);
  if (!raw) return null;
  const hourly = raw.hourly?.us_aqi || [];
  const times = raw.hourly?.time || [];
  const now = Date.now();
  let nowIdx = times.findIndex(t => new Date(t + 'Z').getTime() >= now);
  if (nowIdx < 0) nowIdx = hourly.length - 1;
  const current = hourly[nowIdx];
  const yesterday = hourly[Math.max(0, nowIdx - 24)];
  const delta = (current !== undefined && yesterday !== undefined)
    ? current - yesterday : null;
  return {
    aqi: current,
    delta,
    pm25: raw.hourly?.pm2_5?.[nowIdx] ?? null,
  };
}

/**
 * renderAqi() — air quality index inside the weather widget
 */
async function renderAqi() {
  const el = document.getElementById('weatherAqi');
  if (!el) return;
  try {
    const a = await fetchAqi();
    if (!a || a.aqi === null || a.aqi === undefined) return;

    // Color by US AQI scale
    let cls;
    if (a.aqi <= 50) cls = 'aqi-good';
    else if (a.aqi <= 100) cls = 'aqi-moderate';
    else if (a.aqi <= 150) cls = 'aqi-sensitive';
    else if (a.aqi <= 200) cls = 'aqi-unhealthy';
    else cls = 'aqi-severe';

    // Delta arrow (higher AQI = worse, lower = better) — neutral color
    let deltaHtml = '';
    if (a.delta !== null && a.delta !== 0) {
      const arrow = a.delta > 0 ? '\u2191' : '\u2193';
      deltaHtml = ` <span class="aqi-delta">${arrow}${Math.abs(a.delta)}</span>`;
    }

    el.innerHTML = `<span class="aqi-dot ${cls}">\u25cf</span> AQI ${a.aqi}${deltaHtml}`;
  } catch {}
}

// Map of fiat CBR codes + crypto CoinGecko ids
const CURRENCY_META = {
  USD: { kind: 'fiat', cbr: 'USD', symbol: '$' },
  EUR: { kind: 'fiat', cbr: 'EUR', symbol: '\u20ac' },
  GBP: { kind: 'fiat', cbr: 'GBP', symbol: '\u00a3' },
  CNY: { kind: 'fiat', cbr: 'CNY', symbol: '\u00a5' },
  JPY: { kind: 'fiat', cbr: 'JPY', symbol: '\u00a5' },
  CHF: { kind: 'fiat', cbr: 'CHF', symbol: 'F' },
  TRY: { kind: 'fiat', cbr: 'TRY', symbol: '\u20ba' },
  AED: { kind: 'fiat', cbr: 'AED', symbol: 'AED' },
  BTC: { kind: 'crypto', geckoId: 'bitcoin',           symbol: '\u20bf' },
  ETH: { kind: 'crypto', geckoId: 'ethereum',          symbol: '\u039e' },
  SOL: { kind: 'crypto', geckoId: 'solana',            symbol: 'S' },
  TON: { kind: 'crypto', geckoId: 'the-open-network',  symbol: 'T' },
};

/**
 * fetchRates() — returns array of { code, symbol, value, delta, label }.
 * Uses settings.currencies to decide what to fetch.
 */
async function fetchRates() {
  const codes = settings.currencies && settings.currencies.length
    ? settings.currencies
    : ['USD', 'EUR', 'BTC'];

  const fiatCodes   = codes.filter(c => CURRENCY_META[c]?.kind === 'fiat');
  const cryptoCodes = codes.filter(c => CURRENCY_META[c]?.kind === 'crypto');

  const out = [];

  // Fiat rates from CBR (single call, all currencies)
  if (fiatCodes.length) {
    const cbr = await cachedFetch('https://www.cbr-xml-daily.ru/daily_json.js', 15 * 60 * 1000);
    if (cbr?.Valute) {
      for (const code of fiatCodes) {
        const v = cbr.Valute[CURRENCY_META[code].cbr];
        if (!v) continue;
        // CBR sometimes quotes per 10/100 units (JPY, etc.) — normalize to per-1
        const nominal = v.Nominal || 1;
        const value = Math.round((v.Value / nominal) * 100) / 100;
        const prev  = Math.round((v.Previous / nominal) * 100) / 100;
        out.push({
          code,
          symbol: CURRENCY_META[code].symbol,
          value,
          delta: Math.round((value - prev) * 100) / 100,
          unit: 'rub',
        });
      }
    }
  }

  // Crypto rates from CoinGecko (batch single call)
  if (cryptoCodes.length) {
    const ids = cryptoCodes.map(c => CURRENCY_META[c].geckoId).join(',');
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
    const data = await cachedFetch(url, 15 * 60 * 1000);
    if (data) {
      for (const code of cryptoCodes) {
        const id = CURRENCY_META[code].geckoId;
        const entry = data[id];
        if (!entry?.usd) continue;
        const value = entry.usd;
        const pct = entry.usd_24h_change;
        const delta = pct ? Math.round(value * pct / (100 + pct)) : null;
        out.push({
          code,
          symbol: CURRENCY_META[code].symbol,
          value,
          delta,
          unit: 'usd',
        });
      }
    }
  }

  return out;
}

/**
 * renderRates() — direct fetch from CBR + CoinGecko.
 */
async function renderRates() {
  const el = document.getElementById('headerRates');
  if (!el) return;
  try {
    const rates = await fetchRates();
    if (!rates || !rates.length) { el.innerHTML = ''; return; }

    function deltaHtml(delta) {
      if (delta === null || delta === undefined || delta === 0) return '';
      const arrow = delta > 0 ? '\u2191' : '\u2193';
      const abs = Math.abs(delta);
      // If delta is whole number (crypto), no decimals; else 2 decimals
      const fmt = Math.abs(delta) >= 10 ? Math.round(abs).toLocaleString('en-US') : abs;
      return ` <span class="rate-delta">${arrow}${fmt}</span>`;
    }

    function fmtValue(v) {
      // Large values (BTC $70k+) — no decimals, grouped with comma
      if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
      // Small-ish (SOL $85, EUR 89.14) — 2 decimals
      return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    el.innerHTML = rates.map(r => {
      const isCrypto = r.unit === 'usd';
      const label = isCrypto ? '$' : '\u20bd';
      return `<div class="rate-row">
        <span class="rate-symbol">${r.symbol}</span>
        <span class="rate-value">${fmtValue(r.value)}</span>
        <span class="rate-label">${label}${deltaHtml(r.delta)}</span>
      </div>`;
    }).join('');
  } catch { /* fail silently */ }
}


/* ----------------------------------------------------------------
   EXTENSION BRIDGE

   The dashboard runs in an iframe inside the Chrome extension's
   new-tab page. To communicate with the extension's background
   script, we use window.postMessage — the extension's content
   script listens and relays messages.

   When running in a regular browser tab (dev mode), we gracefully
   fall back without crashing.
   ---------------------------------------------------------------- */

// Extension is always "available" in this version (we ARE the extension now)
let extensionAvailable = typeof chrome !== 'undefined' && !!chrome.tabs;

// Track all open tabs fetched from chrome.tabs API (array of tab objects)
let openTabs = [];

/**
 * sendToExtension(action, data)
 *
 * Wrapper around the old postMessage API — now calls chrome.tabs directly.
 * Kept with the same shape so existing call-sites don't need to change.
 * Returns { success, ...payload } like the old API.
 */
async function sendToExtension(action, data = {}) {
  if (!extensionAvailable) return { success: false, reason: 'not-extension' };
  try {
    switch (action) {
      case 'getTabs':           return await handleGetTabs();
      case 'closeTabs':         return await handleCloseTabs(data);
      case 'focusTabs':         return await handleFocusTabs(data);
      case 'focusTab':          return await handleFocusSingleTab(data.url);
      case 'closeDuplicates':   return await handleCloseDuplicates(data.urls, data.keepOne);
      case 'closeTabOutDupes':  return await handleCloseTabOutDupes();
      default: return { success: false, error: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/* ── chrome.tabs handlers (inlined from extension/newtab.js of the old version) ── */

async function handleGetTabs() {
  const tabs = await chrome.tabs.query({});
  const extId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extId}/index.html`;
  const simpleTabs = tabs.map(tab => ({
    id:       tab.id,
    url:      tab.url,
    title:    tab.title,
    windowId: tab.windowId,
    active:   tab.active,
    isTabOut: tab.url === newtabUrl || tab.url === 'chrome://newtab/',
  }));
  return { success: true, tabs: simpleTabs };
}

async function handleCloseTabs({ urls = [], exact = false } = {}) {
  if (exact) return await handleCloseTabsExact(urls);

  // Match by hostname (default for most actions)
  const targetHostnames = [];
  const targetExactUrls = new Set();
  for (const u of urls) {
    if (u.startsWith('file://')) {
      targetExactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); } catch {}
    }
  }
  const allTabs = await chrome.tabs.query({});
  const ids = allTabs.filter(tab => {
    const tabUrl = tab.url || '';
    if (tabUrl.startsWith('file://') && targetExactUrls.has(tabUrl)) return true;
    try {
      const h = new URL(tabUrl).hostname;
      return h && targetHostnames.includes(h);
    } catch { return false; }
  }).map(t => t.id);
  if (ids.length) await chrome.tabs.remove(ids);
  return { success: true, closedCount: ids.length };
}

async function handleCloseTabsExact(urls = []) {
  const set = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const ids = allTabs.filter(t => set.has(t.url)).map(t => t.id);
  if (ids.length) await chrome.tabs.remove(ids);
  return { success: true, closedCount: ids.length };
}

async function handleFocusTabs({ urls = [] } = {}) {
  const targets = urls.map(u => { try { return new URL(u).hostname; } catch { return null; } }).filter(Boolean);
  if (!targets.length) return { success: false, error: 'No valid URLs' };
  const allTabs = await chrome.tabs.query({});
  const match = allTabs.find(t => { try { return targets.includes(new URL(t.url).hostname); } catch { return false; } });
  if (!match) return { success: false, error: 'No matching tab' };
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
  return { success: true, focusedTabId: match.id };
}

async function handleFocusSingleTab(url) {
  if (!url) return { success: false, error: 'No URL' };
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  let matches = allTabs.filter(t => t.url === url);
  if (!matches.length) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => { try { return new URL(t.url).hostname === targetHost; } catch { return false; } });
    } catch {}
  }
  if (!matches.length) return { success: false, error: 'Tab not found' };
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
  return { success: true, focusedTabId: match.id };
}

async function handleCloseDuplicates(urls = [], keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const ids = [];
  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) if (tab.id !== keep.id) ids.push(tab.id);
    } else {
      for (const tab of matching) ids.push(tab.id);
    }
  }
  if (ids.length) await chrome.tabs.remove(ids);
  return { success: true, closedCount: ids.length };
}

async function handleCloseTabOutDupes() {
  const allTabs = await chrome.tabs.query({});
  const extId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extId}/index.html`;
  const tabOutTabs = allTabs.filter(t => t.url === newtabUrl || t.url === 'chrome://newtab/');
  if (tabOutTabs.length <= 1) return { success: true, closedCount: 0 };

  const currentWindow = await chrome.windows.getCurrent();
  // Keep the active tab in the focused window — that's the one user is looking at
  const keep = tabOutTabs.find(t => t.active && t.windowId === currentWindow.id)
             || tabOutTabs.find(t => t.active)
             || tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length) await chrome.tabs.remove(toClose);
  return { success: true, closedCount: toClose.length };
}

/**
 * fetchOpenTabs()
 *
 * Reads the list of open tabs via chrome.tabs API (no server, no iframe).
 */
async function fetchOpenTabs() {
  if (!extensionAvailable) { openTabs = []; return; }
  try {
    const tabs = await chrome.tabs.query({});
    const extId = chrome.runtime.id;
    const newtabUrl = `chrome-extension://${extId}/index.html`;
    openTabs = tabs.map(tab => ({
      id: tab.id, url: tab.url, title: tab.title,
      windowId: tab.windowId, active: tab.active,
      isTabOut: tab.url === newtabUrl || tab.url === 'chrome://newtab/',
    }));
  } catch { openTabs = []; }
}

async function closeTabsByUrls(urls) {
  if (!extensionAvailable || !urls || urls.length === 0) return;
  await handleCloseTabs({ urls });
  await fetchOpenTabs();
}

async function focusTabsByUrls(urls) {
  if (!extensionAvailable || !urls || urls.length === 0) return;
  await handleFocusTabs({ urls });
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * showToast(message)
 *
 * Shows a brief pop-up notification at the bottom of the screen.
 * Like the little notification that pops up when you send a message.
 */
/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — this creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 *
 * Each particle:
 * - Is either a circle or a square (randomly chosen)
 * - Uses the dashboard's color palette: amber, sage, slate, with some light variants
 * - Flies outward in a random direction with a gravity arc
 * - Fades out over ~800ms, then is removed from the DOM
 *
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  // Color palette drawn from the dashboard's CSS variables
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    // Randomly decide: circle or square
    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px

    // Pick a random color from the palette
    const color = colors[Math.floor(Math.random() * colors.length)];

    // Style the particle
    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle  = Math.random() * Math.PI * 2;           // random direction (radians)
    const speed  = 60 + Math.random() * 120;              // px/second
    const vx     = Math.cos(angle) * speed;               // horizontal velocity
    const vy     = Math.sin(angle) * speed - 80;          // vertical: bias upward a bit
    const gravity = 200;                                   // downward pull (px/s²)

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200;          // 700–900ms

    // Animate with requestAnimationFrame for buttery-smooth motion
    function frame(now) {
      const elapsed = (now - startTime) / 1000; // seconds
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) {
        el.remove();
        return;
      }

      // Position: initial velocity + gravity arc
      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;

      // Fade out during the second half of the animation
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;

      // Slight rotation for realism
      const rotate = elapsed * 200 * (isCircle ? 0 : 1); // squares spin, circles don't

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card in two phases:
 * 1. Fade out + scale down (GPU-accelerated, smooth)
 * 2. After fade completes, remove from DOM
 *
 * Also fires confetti from the card's center for a satisfying "done!" moment.
 */
function animateCardOut(card) {
  if (!card) return;

  // Get the card's center position on screen for the confetti origin
  const rect = card.getBoundingClientRect();
  const cx = rect.left + rect.width  / 2;
  const cy = rect.top  + rect.height / 2;

  // Shoot confetti from the card's center
  shootConfetti(cx, cy);

  // Phase 1: fade + scale down
  card.classList.add('closing');
  // Phase 2: remove from DOM after animation
  setTimeout(() => {
    card.remove();
    // After card is gone, check if the missions grid is now empty
    // and show the empty state if so
    checkAndShowEmptyState();
  }, 300);
}

function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Called after each card is removed from the DOM. If all mission cards
 * are gone (the grid is empty), we swap in a fun empty state instead of
 * showing a blank, lifeless grid.
 *
 */
function checkAndShowEmptyState() {

  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  // Count remaining mission cards (excludes anything already animating out)
  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  // All missions are gone — show the empty state
  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">Inbox zero, but for tabs.</div>
      <div class="empty-subtitle">You're free.</div>
    </div>
  `;

  // Update the section count to reflect the clear state
  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 missions';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * e.g. "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';

  const then = new Date(dateStr);
  const now = new Date();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting()
 *
 * Returns an appropriate greeting based on the current hour.
 * Morning = before noon, Afternoon = noon–5pm, Evening = after 5pm.
 * No name — Tab Out is for everyone now.
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay()
 *
 * Returns a formatted date string like "Friday, April 4, 2026".
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

/**
 * countOpenTabsForMission(missionUrls)
 *
 * Counts how many of the user's currently open browser tabs
 * match any of the URLs associated with a mission.
 *
 * We match by domain (hostname) rather than exact URL, because
 * the exact URL often changes (e.g. page IDs, session tokens).
 */
function countOpenTabsForMission(missionUrls) {
  return getOpenTabsForMission(missionUrls).length;
}

/**
 * getOpenTabsForMission(missionUrls)
 *
 * Returns the actual tab objects from openTabs that match
 * any URL in the mission's URL list (matched by domain).
 */
function getOpenTabsForMission(missionUrls) {
  if (!missionUrls || missionUrls.length === 0 || openTabs.length === 0) return [];

  // Extract the domains from the mission's saved URLs
  // missionUrls can be either URL strings or objects with a .url property
  const missionDomains = missionUrls.map(item => {
    const urlStr = (typeof item === 'string') ? item : (item.url || '');
    try {
      return new URL(urlStr.startsWith('http') ? urlStr : 'https://' + urlStr).hostname;
    } catch {
      return urlStr;
    }
  });

  // Find open tabs whose hostname matches any mission domain
  return openTabs.filter(tab => {
    try {
      const tabDomain = new URL(tab.url).hostname;
      return missionDomains.some(d => tabDomain.includes(d) || d.includes(tabDomain));
    } catch {
      return false;
    }
  });
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS

   We store these as a constant so we can reuse them in buttons
   without writing raw SVG every time. Each value is an HTML string
   ready to be injected with innerHTML.
   ---------------------------------------------------------------- */
/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS

   Make domain names and tab titles more readable.
   - friendlyDomain() turns "github.com" into "GitHub"
   - cleanTitle() strips redundant site names from the end of titles
   ---------------------------------------------------------------- */

// Map of known domains → friendly display names.
// Covers the most common sites; everything else gets a smart fallback.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

/**
 * friendlyDomain(hostname)
 *
 * Turns a raw hostname into a human-readable name.
 * 1. Check the lookup map for known domains
 * 2. For subdomains of known domains, check if the parent matches
 *    (e.g. "docs.github.com" → "GitHub Docs")
 * 3. Fallback: strip "www.", strip TLD, capitalize
 *    (e.g. "minttr.com" → "Minttr", "blog.example.co.uk" → "Blog Example")
 */
function friendlyDomain(hostname) {
  if (!hostname) return '';

  // Direct lookup
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  // Check for *.substack.com pattern (e.g. "lenny.substack.com" → "Lenny's Substack")
  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    const sub = hostname.replace('.substack.com', '');
    return capitalize(sub) + "'s Substack";
  }

  // Check for *.github.io pattern
  if (hostname.endsWith('.github.io')) {
    const sub = hostname.replace('.github.io', '');
    return capitalize(sub) + ' (GitHub Pages)';
  }

  // Fallback: strip www, strip common TLDs, capitalize each word
  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  // If it's a subdomain like "blog.example", keep it readable
  return clean
    .split('.')
    .map(part => capitalize(part))
    .join(' ');
}

/**
 * capitalize(str)
 * "github" → "GitHub" (okay, just "Github" — but close enough for fallback)
 */
function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * stripTitleNoise(title)
 *
 * Removes common noise from browser tab titles:
 * - Leading notification counts: "(2) Vibe coding ideas" → "Vibe coding ideas"
 * - Trailing email addresses: "Subject - user@gmail.com" → "Subject"
 * - X/Twitter cruft: "Name on X: \"quote\" / X" → "Name: \"quote\""
 * - Trailing "/ X" or "| LinkedIn" etc (handled by cleanTitle, but the
 *   "on X:" pattern needs special handling here)
 */
function stripTitleNoise(title) {
  if (!title) return '';

  // 1. Strip leading notification count: "(2) Title" or "(99+) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');

  // 1b. Strip inline counts like "Inbox (16,359)" or "Messages (42)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');

  // 2. Strip email addresses anywhere in the title (privacy + cleaner display)
  //    Catches patterns like "Subject - user@example.com - Gmail"
  //    First remove "- email@domain.com" segments (with separator)
  title = title.replace(/\s*[\-\u2010\u2011\u2012\u2013\u2014\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  //    Then catch any remaining bare email addresses
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');

  // 3. Clean up X/Twitter title format: "Name on X: \"quote text\"" → "Name: \"quote text\""
  title = title.replace(/\s+on X:\s*/, ': ');

  // 4. Strip trailing "/ X" (X/Twitter appends this)
  title = title.replace(/\s*\/\s*X\s*$/, '');

  return title.trim();
}

/**
 * cleanTitle(title, hostname)
 *
 * Strips redundant site name suffixes from tab titles.
 * Many sites append their name: "Article Title - Medium" or "Post | Reddit"
 * If the suffix matches the domain, we remove it for a cleaner look.
 */
function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain = hostname.replace(/^www\./, '');

  // Common separator patterns at the end of titles
  // "Article Title - Site Name", "Article Title | Site Name", "Article Title — Site Name"
  const separators = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of separators) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;

    const suffix = title.slice(idx + sep.length).trim();
    const suffixLower = suffix.toLowerCase();

    // Check if the suffix matches the domain name, friendly name, or common variations
    if (
      suffixLower === domain.toLowerCase() ||
      suffixLower === friendly.toLowerCase() ||
      suffixLower === domain.replace(/\.\w+$/, '').toLowerCase() || // "github" from "github.com"
      domain.toLowerCase().includes(suffixLower) ||
      friendly.toLowerCase().includes(suffixLower)
    ) {
      const cleaned = title.slice(0, idx).trim();
      // Only strip if we're left with something meaningful (at least 5 chars)
      if (cleaned.length >= 5) return cleaned;
    }
  }

  return title;
}

/**
 * smartTitle(title, url)
 *
 * When the tab title is useless (just the URL, or a generic site name),
 * try to extract something meaningful from the URL itself.
 * Works for X/Twitter posts, GitHub repos, YouTube videos, Reddit threads, etc.
 */
function smartTitle(title, url) {
  if (!url) return title || '';

  let pathname = '';
  let hostname = '';
  try {
    const u = new URL(url);
    pathname = u.pathname;
    hostname = u.hostname;
  } catch {
    return title || '';
  }

  // Check if the title is basically just the URL (useless)
  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  // X / Twitter — extract @username from /username/status/123456 URLs
  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) {
      // If the title has actual content (not just URL), clean it and keep it
      if (!titleIsUrl) return title;
      return `Post by @${username}`;
    }
  }

  // GitHub — extract owner/repo or owner/repo/path context
  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const owner = parts[0];
      const repo = parts[1];
      if (parts[2] === 'issues' && parts[3]) return `${owner}/${repo} Issue #${parts[3]}`;
      if (parts[2] === 'pull' && parts[3]) return `${owner}/${repo} PR #${parts[3]}`;
      if (parts[2] === 'blob' || parts[2] === 'tree') return `${owner}/${repo} — ${parts.slice(4).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  // YouTube — if title is just a URL, at least say "YouTube Video"
  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  // Reddit — extract subreddit and post hint from URL
  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      const sub = parts[subIdx + 1];
      if (titleIsUrl) return `r/${sub} post`;
    }
  }

  return title || url;
}


const ICONS = {
  // Tab/browser icon — used in the "N tabs open" badge
  tabs: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,

  // X / close icon — used in "Close N tabs" button
  close: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,

  // Archive / trash icon — used in "Close & archive" button
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,

  // Arrow up-right — used in "Focus on this" button
  focus: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`
};


/* ----------------------------------------------------------------
   ---------------------------------------------------------------- */

/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS

   domainGroups is populated by renderStaticDashboard().
   ---------------------------------------------------------------- */
let domainGroups    = [];
let duplicateTabs   = [];

/* ----------------------------------------------------------------
   PINNED TABS — stored as array of { url, title, favicon } in localStorage.
   Pinned tabs are filtered out of Open Tabs and shown in their own section.
   ---------------------------------------------------------------- */

function getPinned() {
  const list = mem.pinned;
  return Array.isArray(list) ? list : [];
}

function savePinned(list) {
  mem.pinned = list;
  Storage.set('tabout-pinned', list).catch(() => {});
}

function isPinned(url) {
  return getPinned().some(p => p.url === url);
}

function addPinned(entry) {
  const list = getPinned();
  if (!list.find(p => p.url === entry.url)) {
    list.push(entry);
    savePinned(list);
  }
}

function removePinned(url) {
  savePinned(getPinned().filter(p => p.url !== url));
}


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   We call this in multiple places, so it lives in one spot.
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns all open tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc. We only want to show and manage actual websites.
 */
function getRealTabs() {
  const pinnedSet = new Set(getPinned().map(p => p.url));
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !pinnedSet.has(url) &&
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out new-tab pages are open (they show up as
 * chrome-extension://XXXXX/newtab.html in the tab list). If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  // Each tab has an isTabOut flag set by the extension's handleGetTabs()
  const tabOutTabs = openTabs.filter(t => t.isTabOut);

  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER (for static default view)

   Groups open tabs by domain (e.g. all github.com tabs together)
   and renders a card per domain.
   ---------------------------------------------------------------- */

/**
 * buildOverflowChips(hiddenTabs, urlCounts)
 *
 * Builds the expandable "+N more" section for tab lists that exceed 8 items.
 * Returns HTML string with hidden chips and a clickable expand button.
 * Used by domain cards when there are more than 8 tabs.
 */
function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label   = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count   = urlCounts[tab.url] || 1;
    const dupeTag = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-pin" data-action="pin-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="\u0417\u0430\u043a\u0440\u0435\u043f\u0438\u0442\u044c">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
        </button>
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card in the static view.
 * "group" is: { domain, tabs: [{ url, title, tabId }] }
 *
 * Visually similar to renderOpenTabsMissionCard() but with a neutral
 * gray status bar (amber if duplicates exist).
 */
function renderDomainCard(group, groupIndex) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Detect duplicates within this domain group (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) {
    urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  }
  const dupeUrls = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  // Tab count badge
  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  // Duplicate warning badge
  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color: var(--accent-amber); background: rgba(200, 113, 58, 0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once with (Nx) badge if duplicated
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) {
      seen.add(tab.url);
      uniqueTabs.push(tab);
    }
  }
  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;
  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend the port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) {
        label = `${parsed.port} ${label}`;
      }
    } catch {}
    const count   = urlCounts[tab.url];
    const dupeTag = count > 1
      ? ` <span class="chip-dupe-badge">(${count}x)</span>`
      : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const faviconUrl = domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16` : '';
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ''}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-pin" data-action="pin-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="\u0417\u0430\u043a\u0440\u0435\u043f\u0438\u0442\u044c">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>
        </button>
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  // Use amber status bar if there are duplicates
  const statusBarClass = hasDupes ? 'active' : 'neutral';
  const statusBarStyle = hasDupes ? ' style="background: var(--accent-amber);"' : '';

  // Actions: always show save all + close all, add "Close duplicates" if dupes exist
  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"${statusBarStyle}></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : friendlyDomain(group.domain)}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   DEFERRED TABS — "Saved for Later" checklist column

   Fetches deferred tabs from the server and renders:
   1. Active items as a checklist (checkbox + title + dismiss)
   2. Archived items in a collapsible section with search
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Fetches all deferred tabs (active + archived) from the API and
 * renders them into the right-side column. Called on every dashboard
 * load.
 */
async function renderDeferredColumn() {
  const column    = document.getElementById('deferredColumn');
  const list      = document.getElementById('deferredList');
  const empty     = document.getElementById('deferredEmpty');
  const countEl   = document.getElementById('deferredCount');
  const archiveEl = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const data = DeferredStore.getAll();
    const active   = data.active || [];
    const archived = data.archived || [];

    // Show or hide the entire column based on whether there's anything to show
    const hasPinned = getPinned().length > 0;
    if (active.length === 0 && archived.length === 0 && !hasPinned) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Find "Saved for later" header (first section-header in this column)
    // and hide the whole Saved for later block if empty while pinned exists
    const savedHeader = column.querySelector('.section-header:not(.pinned-header)');
    const hasSavedContent = active.length > 0 || archived.length > 0;
    if (savedHeader) savedHeader.style.display = hasSavedContent ? '' : 'none';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      // Only show "Nothing saved" when no pinned either (to avoid confusing empty message)
      empty.style.display = (hasSavedContent || hasPinned) ? 'none' : 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load deferred tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds the HTML for a single checklist item in the Saved for Later column.
 * Each item has: checkbox, title (clickable link), domain, time ago, dismiss X.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.deferred_at);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds the HTML for a single item in the collapsed archive list.
 * Simpler than active items — just title link + date.
 */
function renderArchiveItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const ago = item.archived_at ? timeAgo(item.archived_at) : '';

  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER

   renderStaticDashboard() — groups open tabs by domain.
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main view. Loads instantly:
 * 1. Paint greeting + date
 * 2. Fetch open tabs from the extension
 * 3. Group tabs by domain (with landing pages pulled out)
 * 4. Render domain cards
 * 5. Update footer stats
 */
async function renderStaticDashboard() {
  // --- Quick Access shortcuts ---
  renderQuickAccess();

  // --- Weather + Rates (non-blocking) ---
  renderWeather();
  renderRates();

  // --- Header: compact date + live system stats ---
  const dateEl = document.getElementById('dateDisplay');
  if (dateEl) dateEl.textContent = getDateDisplay();

  renderSystemStats();
  renderPingStats();
  renderHoliday();
  renderSpeedtest();

  // ── Fetch tabs + render open tabs section ───────────────────────────────
  await fetchOpenTabs();
  renderOpenTabsSection();

  // ── Footer stats ──────────────────────────────────────────────────────────
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // ── Check for duplicate Tab Out tabs ────────────────────────────────────
  checkTabOutDupes();

  // ── Render the "Saved for Later" checklist column ──────────────────────
  await renderDeferredColumn();

  // ── Render the "Pinned" section (below Saved for Later) ────────────────
  renderPinnedSection();
}

/**
 * renderOpenTabsSection()
 * Groups open tabs by domain and renders the Open Tabs cards.
 * Does NOT fetch tabs — call fetchOpenTabs() first if you need fresh data.
 * Standalone so it can be called without touching Quick Access, header, etc.
 */
function renderOpenTabsSection() {
  const realTabs = getRealTabs();

  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com',  test: (p, h) => {
      return !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/');
    }},
    { hostname: 'x.com',                       pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',            pathExact: ['/'] },
    { hostname: 'github.com',                  pathExact: ['/'] },
    { hostname: 'www.youtube.com',             pathExact: ['/'] },
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        if (parsed.hostname !== p.hostname) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap = {};
  const landingTabs = [];

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }
      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;
      if (!groupMap[hostname]) {
        groupMap[hostname] = { domain: hostname, tabs: [] };
      }
      groupMap[hostname].tabs.push(tab);
    } catch {}
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname));
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;
    const aIsPriority = landingHostnames.has(a.domain);
    const bIsPriority = landingHostnames.has(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;
    return b.tabs.length - a.tabs.length;
  });

  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = 'Open tabs';
    openTabsSectionCount.innerHTML = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} Close all ${realTabs.length} tabs</button>`;
    openTabsMissionsEl.innerHTML = domainGroups
      .map((g, idx) => renderDomainCard(g, idx))
      .join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }
}

/**
 * renderPinnedSection()
 * Renders the Pinned tabs list below the Saved for Later column.
 * Each pinned entry can be unpinned or closed (which closes the real browser tab).
 */
function renderPinnedSection() {
  const section = document.getElementById('pinnedSection');
  const listEl = document.getElementById('pinnedList');
  const countEl = document.getElementById('pinnedCount');
  const column = document.getElementById('deferredColumn');
  if (!section || !listEl) return;

  const pinned = getPinned();
  if (pinned.length === 0) {
    section.style.display = 'none';
    // If deferred column is also empty it will be hidden by its own render
    return;
  }

  section.style.display = 'block';
  // Ensure the right column is visible (shared with deferred)
  if (column) column.style.display = 'block';

  countEl.textContent = `${pinned.length} item${pinned.length !== 1 ? 's' : ''}`;

  listEl.innerHTML = pinned.map(p => {
    // Try to match a currently-open tab for live title/favicon
    const liveTab = openTabs.find(t => t.url === p.url);
    const title = liveTab?.title || p.title || p.url;
    const favicon = p.favicon || (() => {
      try { return `https://www.google.com/s2/favicons?domain=${new URL(p.url).hostname}&sz=16`; }
      catch { return ''; }
    })();
    const isOpen = !!liveTab;
    const safeUrl = p.url.replace(/"/g, '&quot;');
    const safeTitle = String(title).replace(/"/g, '&quot;');

    return `<div class="pinned-item${isOpen ? '' : ' pinned-offline'}" data-pinned-url="${safeUrl}">
      ${favicon ? `<img class="pinned-favicon" src="${favicon}" alt="" onerror="this.style.display='none'">` : ''}
      <a class="pinned-title" href="#" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">${title}</a>
      <button class="chip-action pinned-unpin" data-action="unpin-tab" data-tab-url="${safeUrl}" title="\u041e\u0442\u043a\u0440\u0435\u043f\u0438\u0442\u044c">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M15 9.34V6h1a2 2 0 0 0 0-4H7.89"/><path d="m2 2 20 20"/><path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/></svg>
      </button>
      <button class="chip-action pinned-close" data-action="close-pinned" data-tab-url="${safeUrl}" title="\u0417\u0430\u043a\u0440\u044b\u0442\u044c">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
      </button>
    </div>`;
  }).join('');
}


/**
 * renderDashboard()
 *
 * Entry point — just calls renderStaticDashboard().
 */
async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS (using event delegation)

   Instead of attaching a listener to every button, we attach ONE
   listener to the whole document and check what was clicked.
   This is more efficient and works even after we re-render cards.

   Think of it like one security guard watching the whole building
   instead of one guard per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM from the clicked element to find the nearest
  // element with a data-action attribute
  const actionEl = e.target.closest('[data-action]');

  if (!actionEl) return; // click wasn't on an action button

  const action    = actionEl.dataset.action;
  const missionId = actionEl.dataset.missionId;

  // --- Close duplicate Tab Out tabs ---
  if (action === 'close-tabout-dupes') {
    await sendToExtension('closeTabOutDupes');
    await fetchOpenTabs();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Tab Out tabs');
    return;
  }

  // Find the card element so we can animate it
  const card = actionEl.closest('.mission-card');

  // ---- expand-chips: show the hidden tabs in a card ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- focus-tab: switch to a specific open tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) {
      await sendToExtension('focusTab', { url: tabUrl });
    }
    return;
  }

  // ---- close-single-tab: close one specific tab by URL ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger the parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    await sendToExtension('closeTabs', { urls: [tabUrl] });
    playCloseSound();
    await fetchOpenTabs();

    // Remove the chip from the DOM with confetti
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity = '0';
      chip.style.transform = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If this was the last tab in the card, remove the whole card
        const card = document.querySelector(`.mission-card:has(.mission-pages:empty)`);
        if (card) {
          animateCardOut(card);
        }
        // Also check for cards where only overflow/non-tab chips remain
        document.querySelectorAll('.mission-card').forEach(c => {
          const remainingTabs = c.querySelectorAll('.page-chip[data-action="focus-tab"]');
          if (remainingTabs.length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    showToast('Tab closed');
    return;
  }

  // ---- pin-tab: move tab to Pinned section (tab stays open in browser) ----
  if (action === 'pin-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    let favicon = '';
    try {
      const d = new URL(tabUrl).hostname;
      favicon = `https://www.google.com/s2/favicons?domain=${d}&sz=16`;
    } catch {}

    addPinned({ url: tabUrl, title: tabTitle, favicon });

    // Animate chip out smoothly + update only affected sections
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity = '0';
      chip.style.transform = 'translateX(20px)';
      setTimeout(() => {
        chip.remove();
        // If card became empty, animate it out (same as close-single-tab)
        document.querySelectorAll('.mission-card').forEach(c => {
          const remaining = c.querySelectorAll('.page-chip[data-action="focus-tab"]');
          if (remaining.length === 0) animateCardOut(c);
        });
        // Update pinned section + deferred column (in case it needs to show now)
        renderPinnedSection();
        renderDeferredColumn();
      }, 200);
    } else {
      renderPinnedSection();
      renderDeferredColumn();
    }
    showToast('Pinned');
    return;
  }

  // ---- unpin-tab: remove from Pinned, tab reappears in Open tabs ----
  if (action === 'unpin-tab') {
    e.stopPropagation();
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    removePinned(tabUrl);

    // Animate pinned item out
    const item = actionEl.closest('.pinned-item');
    if (item) {
      item.style.transition = 'opacity 0.2s, transform 0.2s';
      item.style.opacity = '0';
      item.style.transform = 'translateX(20px)';
      setTimeout(async () => {
        renderPinnedSection();
        renderDeferredColumn();
        // Re-render open tabs so unpinned tab reappears in its domain card.
        // Use partial render of just that section — not full dashboard.
        await renderOpenTabsSection();
      }, 200);
    } else {
      renderPinnedSection();
      renderDeferredColumn();
      await renderOpenTabsSection();
    }
    showToast('Unpinned');
    return;
  }

  // ---- close-pinned: close the actual browser tab + unpin ----
  if (action === 'close-pinned') {
    e.stopPropagation();
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    await sendToExtension('closeTabs', { urls: [tabUrl] });
    await fetchOpenTabs();
    removePinned(tabUrl);
    playCloseSound();

    const item = actionEl.closest('.pinned-item');
    if (item) {
      const rect = item.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      item.style.transition = 'opacity 0.25s, transform 0.25s';
      item.style.opacity = '0';
      item.style.transform = 'scale(0.9)';
      setTimeout(() => {
        renderPinnedSection();
        renderDeferredColumn();
      }, 250);
    } else {
      renderPinnedSection();
      renderDeferredColumn();
    }
    showToast('Tab closed');
    return;
  }

  // ---- defer-single-tab: save one tab for later, then close it ----
  if (action === 'defer-single-tab') {
    e.stopPropagation(); // don't trigger the parent chip's focus-tab
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to the deferred list (local storage)
    try {
      DeferredStore.add({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to defer tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in the browser
    await sendToExtension('closeTabs', { urls: [tabUrl] });
    await fetchOpenTabs();

    // Animate the chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity = '0';
      chip.style.transform = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    // Refresh the deferred column to show the new item
    await renderDeferredColumn();
    return;
  }

  // ---- check-deferred: check off a deferred tab (mark as read) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    try {
      DeferredStore.check(id);
    } catch (err) {
      console.error('[tab-out] Failed to check deferred tab:', err);
      return;
    }

    // Animate the item: add strikethrough, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh to update counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- dismiss-deferred: dismiss a deferred tab without reading ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    try {
      DeferredStore.dismiss(id);
    } catch (err) {
      console.error('[tab-out] Failed to dismiss deferred tab:', err);
      return;
    }

    // Animate the item out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn(); // refresh counts and archive
      }, 300);
    }
    return;
  }

  // ---- close-domain-tabs: close all tabs in a static domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    // Find the group by its stable ID
    const group = domainGroups.find(g => {
      const id = 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-');
      return id === domainId;
    });
    if (!group) return;

    const urls = group.tabs.map(t => t.url);
    // Use exact URL matching for landing pages (share domains with content tabs)
    const useExact = group.domain === '__landing-pages__';
    await sendToExtension('closeTabs', { urls, exact: useExact });
    await fetchOpenTabs();

    // Animate the card out
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory domain groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : friendlyDomain(group.domain);
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    // Update footer tab count
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- close-all-dupes: close every duplicate tab ----

  // ---- dedup-keep-one: close extras but keep one copy of each ----
  if (action === 'dedup-keep-one') {
    // URLs come from the button's data attribute (per-mission duplicates)
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await sendToExtension('closeDuplicates', { urls, keepOne: true });
    playCloseSound();
    await fetchOpenTabs();

    // Remove the dupe button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove all (2x) badges and the "N duplicates" header badge from this card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity = '0';
        setTimeout(() => b.remove(), 200);
      });
      // Remove the amber "N duplicates" badge from the card header
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      // Remove amber highlight from the card border
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
      const statusBar = card.querySelector('.status-bar');
      if (statusBar) statusBar.style.background = '';
    }

    showToast(`Closed duplicates, kept one copy each`);
    return;
  }

  // ---- close-all-open-tabs: close every open tab ----
  if (action === 'close-all-open-tabs') {
    // Use the actual openTabs list from the extension — works regardless of
    // close all domain-grouped tabs
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    // Animate all cards out
    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }

  // ---- archive: close tabs + mark mission as archived, then remove card ----
  else if (action === 'archive') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    const urls = (mission.urls || []).map(u => u.url);
    await closeTabsByUrls(urls);

    // Missions are legacy — no-op archive
    try {
      void missionId;
    } catch (err) {
      console.warn('[tab-out] Could not archive mission:', err);
    }

    // Animate the card out
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    showToast(`Archived "${mission.name}"`);

  }

  // ---- dismiss: close tabs (if any), mark as dismissed, remove card ----
  else if (action === 'dismiss') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    // If tabs are open, close them first
    const tabCount = card
      ? (card.querySelector('.open-tabs-badge')?.textContent.match(/\d+/)?.[0] || 0)
      : 0;

    if (parseInt(tabCount) > 0) {
      const urls = (mission.urls || []).map(u => u.url);
      await closeTabsByUrls(urls);
    }

    // Missions are legacy — no-op dismiss
    try {
      void missionId;
    } catch (err) {
      console.warn('[tab-out] Could not dismiss mission:', err);
    }

    // Animate the card out
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    showToast(`Let go of "${mission.name}"`);

  }

  // ---- focus: bring the mission's tabs to the front ----
  else if (action === 'focus') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    const urls = (mission.urls || []).map(u => u.url);
    await focusTabsByUrls(urls);
    showToast(`Focused on "${mission.name}"`);
  }

  // ---- close-uncat: close uncategorized tabs by domain ----
  else if (action === 'close-uncat') {
    const domain = actionEl.dataset.domain;
    if (!domain) return;

    // Find all open tabs matching this domain and close them
    const tabsToClose = openTabs.filter(t => {
      try { return new URL(t.url).hostname === domain; }
      catch { return false; }
    });
    const urls = tabsToClose.map(t => t.url);
    await closeTabsByUrls(urls);

    // Animate card removal
    if (card) {
      playCloseSound();
      animateCardOut(card);
    }
    showToast(`Closed ${tabsToClose.length} tab${tabsToClose.length !== 1 ? 's' : ''} from ${domain}`);

  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  if (q.length < 2) {
    // Reset archive list to show all archived items
    const data = DeferredStore.getAll();
    archiveList.innerHTML = (data.archived || []).map(item => renderArchiveItem(item)).join('');
    return;
  }

  const results = DeferredStore.search(q);
  archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
    || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
});


/* ----------------------------------------------------------------
   ACTION HELPERS
   ---------------------------------------------------------------- */

// Missions were a legacy concept from the server version — no longer used.
async function fetchMissionById() { return null; }

/* ----------------------------------------------------------------
   INITIALIZE — bootstrap from chrome.storage before first render
   ---------------------------------------------------------------- */
(async function bootstrap() {
  await loadAllStorage();
  await loadSettings();
  // Re-apply theme now that mem.themeMode is populated (initThemeToggle ran before storage loaded)
  applyThemeMode(getThemeMode());
  updateThemeIcon();
  // Apply persisted tile scale
  applyTileScale(settings.tileScale ?? 1.0);
  // Apply custom tab title
  if (settings.tabTitle) document.title = settings.tabTitle;
  renderDashboard();
})();
