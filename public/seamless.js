/* =========================================================================
   WhaleChat seamless — open access, uninterrupted sessions, always-on sync
   * every device that opens the link (browser, installed PWA, mobile shell)
     connects to the shared server automatically; no per-device setup
   * background refreshes never wipe what the user is typing, their focus,
     caret or scroll position
   * drafts survive real page reloads (passwords/PINs are never stored)
   * updates install silently when the user is idle — no countdown, no prompt
   * local changes always reach the server before remote data replaces them
   * heartbeat keeps the live connection and the server warm
   ========================================================================= */
'use strict';
(function () {
  if (typeof window === 'undefined' || window.__wcSeamless) return;
  window.__wcSeamless = true;

  const DRAFT_KEY = 'wc.drafts.v1';
  const SCROLL_KEY = 'wc.scroll.v1';
  const UPDATED_KEY = 'wc.updatedTo';
  const OFFLINE_USERS_KEY = 'wc.offlineUsers.v1';
  const ACTION_WINDOW = 1500;
  const TYPING_IDLE = 1300;
  const SENSITIVE = /pass|pwd|pin|otp|cvv|cvc|card|secret|seed|mnemonic|private|2fa|token/i;

  const S = {
    dirty: new Map(),
    lastInput: 0,
    lastAction: 0,
    composing: false,
    route: location.hash,
    draftApplied: new Set(),
    deferTimer: null,
    draftTimer: null,
    scrollRestore: null,
    userDisconnected: false
  };

  const R = typeof Remote !== 'undefined' ? Remote : null;
  const appEl = () => document.getElementById('app');

  /* ---------------------------- field helpers ---------------------------- */
  const SKIP_TYPES = { file: 1, hidden: 1, submit: 1, button: 1, reset: 1, image: 1 };
  function isField(el) {
    if (!el || !el.tagName) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return tag === 'INPUT' && !SKIP_TYPES[(el.type || 'text').toLowerCase()];
  }
  function isTextField(el) {
    if (!isField(el) || el.tagName === 'SELECT') return false;
    const t = (el.type || 'text').toLowerCase();
    return el.tagName === 'TEXTAREA' || !(t === 'checkbox' || t === 'radio' || t === 'range' || t === 'color');
  }
  function isSensitive(el) {
    const t = (el.type || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (t === 'password' || /cc-|one-time-code|password/.test(ac)) return true;
    return SENSITIVE.test(el.id || '') || SENSITIVE.test(el.name || '');
  }
  function collect(root) {
    const map = new Map();
    if (!root) return map;
    const seen = Object.create(null);
    root.querySelectorAll('input, textarea, select').forEach((el) => {
      if (!isField(el)) return;
      let key;
      const t = (el.type || '').toLowerCase();
      if (el.id) key = '#' + el.id;
      else if (el.name && t === 'radio') key = 'n:' + el.name + ':' + el.value;
      else if (el.name) { const b = 'n:' + el.name; seen[b] = (seen[b] || 0) + 1; key = b + ':' + seen[b]; }
      else { const b = 'u:' + el.tagName + ':' + t; seen[b] = (seen[b] || 0) + 1; key = b + ':' + seen[b]; }
      if (!map.has(key)) map.set(key, el);
    });
    return map;
  }
  function keyOf(el, root) {
    for (const [k, v] of collect(root)) if (v === el) return k;
    return null;
  }
  function readVal(el) {
    const t = (el.type || '').toLowerCase();
    if (t === 'checkbox' || t === 'radio') return el.checked ? '1' : '0';
    return el.value;
  }
  function writeVal(el, v) {
    const t = (el.type || '').toLowerCase();
    if (t === 'checkbox' || t === 'radio') el.checked = v === '1';
    else el.value = v;
  }

  /* ------------------------------- drafts -------------------------------- */
  function readDrafts() {
    try { return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeDrafts(d) {
    try { sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch (e) {}
  }
  function saveDraftNow() {
    clearTimeout(S.draftTimer); S.draftTimer = null;
    const root = appEl();
    const drafts = readDrafts();
    const fields = collect(root);
    const out = {};
    for (const [k, v] of S.dirty) {
      const el = fields.get(k);
      if (el && !isSensitive(el)) out[k] = v;
    }
    const route = location.hash;
    if (Object.keys(out).length) drafts[route] = { f: out, at: Date.now() };
    else delete drafts[route];
    for (const r of Object.keys(drafts)) if (Date.now() - (drafts[r].at || 0) > 6 * 3600 * 1000) delete drafts[r];
    writeDrafts(drafts);
  }
  function scheduleDraftSave() {
    clearTimeout(S.draftTimer);
    S.draftTimer = setTimeout(saveDraftNow, 250);
  }
  function dropDraft(route) {
    const d = readDrafts();
    if (d[route]) { delete d[route]; writeDrafts(d); }
  }
  function applyDraft(route) {
    if (S.draftApplied.has(route)) return;
    const root = appEl();
    const fields = collect(root);
    if (!fields.size) return;
    S.draftApplied.add(route);
    const d = readDrafts()[route];
    if (!d || !d.f) return;
    for (const k of Object.keys(d.f)) {
      const el = fields.get(k);
      if (!el || isSensitive(el)) continue;
      if (readVal(el) !== d.f[k]) writeVal(el, d.f[k]);
      S.dirty.set(k, d.f[k]);
    }
  }

  /* ---------------------------- input tracking ---------------------------- */
  document.addEventListener('input', (e) => {
    const el = e.target; const root = appEl();
    if (!root || !isField(el) || !root.contains(el)) return;
    const k = keyOf(el, root);
    if (!k) return;
    S.dirty.set(k, readVal(el));
    S.lastInput = Date.now();
    scheduleDraftSave();
  }, true);
  document.addEventListener('change', (e) => {
    const el = e.target; const root = appEl();
    if (!root || !isField(el) || !root.contains(el)) return;
    const k = keyOf(el, root);
    if (k) { S.dirty.set(k, readVal(el)); scheduleDraftSave(); }
  }, true);
  document.addEventListener('compositionstart', () => { S.composing = true; }, true);
  document.addEventListener('compositionend', () => { S.composing = false; S.lastInput = Date.now(); }, true);
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('button, [data-act], [data-nav], a[href], .link, [role="button"]') : null;
    if (t) S.lastAction = Date.now();
  }, true);
  document.addEventListener('submit', () => { S.lastAction = Date.now(); }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !(e.isComposing || e.keyCode === 229)) S.lastAction = Date.now();
  }, true);

  function isTyping() {
    const a = document.activeElement; const root = appEl();
    if (!a || !root || !root.contains(a) || !isTextField(a)) return false;
    return S.composing || Date.now() - S.lastInput < TYPING_IDLE;
  }

  /* -------------------------- render protection -------------------------- */
  function capture(root) {
    const snap = { focusKey: null, selStart: null, selEnd: null, winY: window.scrollY, scrolls: [] };
    const a = document.activeElement;
    if (a && root.contains(a) && isField(a)) {
      snap.focusKey = keyOf(a, root);
      try { snap.selStart = a.selectionStart; snap.selEnd = a.selectionEnd; } catch (e) {}
    }
    root.querySelectorAll('.content, [id]').forEach((el) => {
      if (el.scrollTop > 0 && el.scrollHeight > el.clientHeight) {
        snap.scrolls.push({ sel: el.id ? '#' + CSS.escape(el.id) : '.content', top: el.scrollTop });
      }
    });
    return snap;
  }
  function restore(root, snap) {
    const fields = collect(root);
    for (const [k, v] of S.dirty) {
      const el = fields.get(k);
      if (el && readVal(el) !== v) writeVal(el, v);
    }
    if (!snap) return;
    if (snap.focusKey) {
      const el = fields.get(snap.focusKey);
      if (el && document.activeElement !== el) {
        try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
        if (snap.selStart != null) { try { el.setSelectionRange(snap.selStart, snap.selEnd); } catch (e) {} }
      }
    }
    for (const s of snap.scrolls) {
      const el = root.querySelector(s.sel);
      if (el && s.sel !== '#chatBody') el.scrollTop = s.top;
    }
    if (Math.abs(window.scrollY - snap.winY) > 2) window.scrollTo(0, snap.winY);
  }
  function restoreScrollAfterReload(root) {
    if (!S.scrollRestore) {
      try { S.scrollRestore = JSON.parse(sessionStorage.getItem(SCROLL_KEY) || 'null') || false; } catch (e) { S.scrollRestore = false; }
      try { sessionStorage.removeItem(SCROLL_KEY); } catch (e) {}
    }
    const s = S.scrollRestore;
    if (!s || s.route !== location.hash || Date.now() - s.at > 60000) return;
    S.scrollRestore = false;
    requestAnimationFrame(() => {
      const c = root.querySelector('.content');
      if (c && s.content) c.scrollTop = s.content;
      if (s.win) window.scrollTo(0, s.win);
    });
  }

  function scheduleDeferredRender() {
    if (S.deferTimer) return;
    const tick = () => {
      if (isTyping()) { S.deferTimer = setTimeout(tick, 400); return; }
      S.deferTimer = null;
      try { window.render(); } catch (e) {}
    };
    S.deferTimer = setTimeout(tick, 400);
  }

  function wrapRender() {
    const base = window.render;
    if (typeof base !== 'function' || base.__wcSeamless) return;
    const wrapped = function () {
      const root = appEl();
      const now = Date.now();
      const before = S.route;
      const sameRoute = before === location.hash;
      const interactive = now - S.lastAction < ACTION_WINDOW;

      if (!interactive && sameRoute && isTyping()) { scheduleDeferredRender(); return; }
      if (S.deferTimer) { clearTimeout(S.deferTimer); S.deferTimer = null; }

      const snap = (sameRoute && !interactive && root) ? capture(root) : null;
      const out = base.apply(this, arguments);
      const after = location.hash;
      const r = appEl();

      try {
        if (before !== after) {
          if (interactive) dropDraft(before);
          S.dirty.clear();
          S.draftApplied.delete(after);
        } else if (interactive) {
          if (S.dirty.size) { S.dirty.clear(); dropDraft(after); }
        } else if (r) {
          restore(r, snap);
        }
        S.route = after;
        if (r) { applyDraft(after); restoreScrollAfterReload(r); }
      } catch (e) {}
      return out;
    };
    wrapped.__wcSeamless = true;
    window.render = wrapped;
  }
  wrapRender();
  window.addEventListener('hashchange', () => { if (!window.render || !window.render.__wcSeamless) wrapRender(); });

  function rememberPage() {
    saveDraftNow();
    try {
      const c = document.querySelector('#app .content');
      sessionStorage.setItem(SCROLL_KEY, JSON.stringify({ route: location.hash, win: window.scrollY, content: c ? c.scrollTop : 0, at: Date.now() }));
    } catch (e) {}
  }
  window.addEventListener('pagehide', rememberPage);
  window.addEventListener('beforeunload', rememberPage);
  document.addEventListener('visibilitychange', () => { if (document.hidden) rememberPage(); });

  /* --------------------------- silent updates ---------------------------- */
  let updateWait = null;
  function silentUpdate(v, opts) {
    const build = (v && v.build) || '';
    const current = typeof APP_BUILD !== 'undefined' ? APP_BUILD : '';
    let tried = '';
    try { tried = sessionStorage.getItem(UPDATED_KEY) || ''; } catch (e) {}
    const forced = !!(opts && opts.auto);
    if (!forced && build && tried === build && current < build) return;
    if (updateWait) return;
    const started = Date.now();
    const go = () => {
      updateWait = null;
      rememberPage();
      try { if (build) sessionStorage.setItem(UPDATED_KEY, build); } catch (e) {}
      try { applyUpdate(); } catch (e) { try { location.reload(); } catch (e2) {} }
    };
    const check = () => {
      const idle = !isTyping() && Date.now() - S.lastInput > 5000 && Date.now() - S.lastAction > 3000;
      const busy = document.querySelector('.spinner') || (typeof Remote !== 'undefined' && Remote.flushing);
      if (document.hidden || (idle && !S.dirty.size && !busy) || (Date.now() - started > 120000 && !isTyping() && !busy)) return go();
      updateWait = setTimeout(check, 2000);
    };
    updateWait = setTimeout(check, forced ? 400 : 1500);
  }
  if (typeof window.showUpdatePrompt === 'function') {
    window.showUpdatePrompt = function (v, opts) { silentUpdate(v, opts); };
  }

  /* --------------------------- shared server sync ------------------------- */
  if (!R) return;

  function syncParam() {
    try { return new URLSearchParams(location.search).get('server'); } catch (e) { return null; }
  }
  if (syncParam() === 'off') S.userDisconnected = true;

  function candidates() {
    const list = [];
    const add = (u) => { if (u == null) return; u = String(u).replace(/\/+$/, ''); if (!list.includes(u)) list.push(u); };
    if (window.__WC_SERVER__) add('');
    try { add(R.storedBase() || null); } catch (e) {}
    if (typeof DEFAULT_SYNC_SERVER !== 'undefined' && DEFAULT_SYNC_SERVER) add(DEFAULT_SYNC_SERVER);
    if (window.__WC_PUBLIC_URL__) add(window.__WC_PUBLIC_URL__);
    return list;
  }

  function offlineIds() {
    try { return JSON.parse(localStorage.getItem(OFFLINE_USERS_KEY) || '[]') || []; } catch (e) { return []; }
  }
  function setOfflineIds(ids) {
    try { ids.length ? localStorage.setItem(OFFLINE_USERS_KEY, JSON.stringify(ids)) : localStorage.removeItem(OFFLINE_USERS_KEY); } catch (e) {}
  }
  function snapshotLocal() {
    const ids = offlineIds();
    const users = (DB && Array.isArray(DB.users)) ? DB.users.filter((u) => u && ids.includes(u.id)) : [];
    return { users: cloneDB(users), session: SESSION ? Object.assign({}, SESSION) : null };
  }
  function mergeLocal(snap) {
    if (!snap || !DB || !Array.isArray(DB.users)) return false;
    const lower = (s) => String(s || '').toLowerCase();
    const ids = new Set(DB.users.map((u) => u && u.id));
    const names = new Set(DB.users.map((u) => lower(u && u.username)));
    const mails = new Set(DB.users.map((u) => lower(u && u.email)));
    let added = 0;
    for (const u of snap.users) {
      if (!u || ids.has(u.id) || names.has(lower(u.username)) || mails.has(lower(u.email))) continue;
      DB.users.push(u); added++;
    }
    setOfflineIds([]);
    if (snap.session && !SESSION && DB.users.some((u) => u.id === snap.session.userId)) {
      SESSION = snap.session;
      try { localStorage.setItem(LS_SESSION, JSON.stringify(SESSION)); } catch (e) {}
    }
    if (added) { try { persist(true); } catch (e) {} try { R.flush(); } catch (e) {} }
    return added > 0;
  }

  async function tryConnect(list) {
    const snap = snapshotLocal();
    for (const base of list) {
      let ok = false;
      try { ok = await R.connect(base, { silent: true, initFromLocal: true }); } catch (e) { ok = false; }
      if (ok) { mergeLocal(snap); return true; }
    }
    return false;
  }

  let reconnectTimer = null;
  let reconnectDelay = 3000;
  function scheduleReconnect(soon) {
    if (R.enabled || S.userDisconnected) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(async () => {
      if (R.enabled || S.userDisconnected) return;
      if (navigator.onLine === false) { scheduleReconnect(); return; }
      const hadSession = !!SESSION;
      const ok = await tryConnect(candidates());
      if (ok) {
        reconnectDelay = 3000;
        if (hadSession && !SESSION) { try { go('login'); } catch (e) {} }
        try { window.render(); } catch (e) {}
      } else {
        reconnectDelay = Math.min(reconnectDelay * 2, 30000);
        scheduleReconnect();
      }
    }, soon ? 300 : reconnectDelay);
  }

  const origInit = R.init.bind(R);
  R.init = async function () {
    const param = syncParam();
    if (param === 'off') return origInit();
    const snap = snapshotLocal();
    let ok = false;
    if (!param && window.__WC_SERVER__) {
      try { ok = await R.connect('', { silent: true, initFromLocal: true }); } catch (e) { ok = false; }
    }
    if (!ok) { try { ok = await origInit(); } catch (e) { ok = false; } }
    if (!ok && !param) {
      const tried = window.__WC_SERVER__ ? [''] : [];
      try { const sb = R.storedBase(); if (sb) tried.push(sb); } catch (e) {}
      const next = candidates().find((c) => !tried.includes(c));
      if (next != null) { try { ok = await R.connect(next, { silent: true, initFromLocal: true }); } catch (e) { ok = false; } }
    }
    if (ok) mergeLocal(snap); else scheduleReconnect();
    return ok;
  };

  const origDisconnect = R.disconnect.bind(R);
  R.disconnect = function () { S.userDisconnected = true; clearTimeout(reconnectTimer); return origDisconnect(); };
  const origConnect = R.connect.bind(R);
  R.connect = async function (base, opts) {
    const ok = await origConnect(base, opts);
    if (ok) { S.userDisconnected = false; clearTimeout(reconnectTimer); }
    return ok;
  };

  function waitFor(cond, ms) {
    return new Promise((resolve) => {
      const end = Date.now() + ms;
      const step = () => { if (cond() || Date.now() > end) return resolve(); setTimeout(step, 60); };
      step();
    });
  }

  /* local edits must reach the server before remote state replaces them —
     otherwise a fresh signup could vanish when another user's change lands */
  const origRefresh = R.refresh.bind(R);
  R.refresh = async function (force) {
    if (!R.enabled) return;
    try { if (typeof SAVE_TIMER !== 'undefined' && SAVE_TIMER) persist(true); } catch (e) {}
    if (R.dirty || R.flushing) {
      await waitFor(() => !R.flushing, 6000);
      if (R.dirty) { try { await R.flush(); } catch (e) {} }
      if (R.dirty) { R.pendingRemote = true; return; }
      R.pendingRemote = false;
      return origRefresh(true);
    }
    R.pendingRemote = false;
    return origRefresh(force);
  };

  async function quietSync(timeout) {
    if (!R.enabled) {
      if (S.userDisconnected) return;
      await tryConnect(candidates().slice(0, 2));
      return;
    }
    try { if (typeof SAVE_TIMER !== 'undefined' && SAVE_TIMER) persist(true); } catch (e) {}
    if (R.dirty) { try { await R.flush(); } catch (e) {} }
    if (R.dirty) return;
    try {
      const r = await R.fetchJSON('/api/state', {}, timeout);
      if (!r.res.ok || !r.data || !r.data.db || r.data.rev === R.rev || R.dirty) return;
      DB = migrateDB(r.data.db);
      R.rev = r.data.rev;
      R.last = cloneDB(DB);
      saveLocalNow();
    } catch (e) {}
  }

  function withFreshData(name, btnId) {
    const orig = App[name];
    if (typeof orig !== 'function' || orig.__wcSeamless) return;
    const fn = async function () {
      const btn = document.getElementById(btnId);
      const label = btn ? btn.innerHTML : null;
      if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> ' + (name === 'login' ? 'Signing in…' : 'Creating account…'); }
      try { await quietSync(4000); } catch (e) {}
      if (btn) { btn.disabled = false; btn.innerHTML = label; }
      const result = await orig.apply(this, arguments);
      if (name === 'signup' && !R.enabled && SESSION) {
        const ids = offlineIds();
        if (!ids.includes(SESSION.userId)) { ids.push(SESSION.userId); setOfflineIds(ids); }
        scheduleReconnect(true);
      }
      if (R.enabled) { try { persist(true); R.flush(); } catch (e) {} }
      return result;
    };
    fn.__wcSeamless = true;
    App[name] = fn;
  }
  if (typeof App !== 'undefined') { withFreshData('login', 'loginBtn'); withFreshData('signup', 'suBtn'); }

  /* ------------------------------ heartbeat ------------------------------ */
  let pingPath = '/api/ping';
  async function heartbeat() {
    if (!R.enabled) { scheduleReconnect(); return; }
    if (document.hidden) return;
    try {
      let r = await R.fetchJSON(pingPath, {}, 6000);
      if (r.res.status === 404 && pingPath !== '/api/health') { pingPath = '/api/health'; r = await R.fetchJSON(pingPath, {}, 6000); }
      if (!r.res.ok || !r.data) throw new Error('ping ' + r.res.status);
      if (R.status === 'offline' || R.status === 'error') R.status = 'online';
      if (!R.es || R.es.readyState === 2) { try { startEventStream(); } catch (e) {} }
      if ((typeof r.data.rev === 'number' && r.data.rev > R.rev) || R.pendingRemote) R.refresh();
      else if (R.dirty && !R.flushing) R.flush();
    } catch (e) {
      R.status = 'offline';
    }
  }
  setInterval(heartbeat, 20000);
  window.addEventListener('online', () => {
    if (R.enabled) { try { startEventStream(); } catch (e) {} heartbeat(); }
    else scheduleReconnect(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (R.enabled) { if (!R.es || R.es.readyState === 2) { try { startEventStream(); } catch (e) {} } }
    else scheduleReconnect(true);
  });
})();
