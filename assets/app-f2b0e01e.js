/* KK Infra Watch — v3. Рендер без фреймворка: сборка Vue-исходников нет,
   поэтому фронтенд написан на plain JS поверх тех же API (/api/status,
   /api/fleet, /api/fleet/registry, /api/fleet/pcs/*). Палитра и типографика —
   как в v1 (см. palette.css). Все данные из API вставляются через textContent
   (нет innerHTML с данными), поэтому имена сотрудников из внешнего JSON не
   могут дать XSS.

   Структура экрана:
     шапка   — логотип, сводка (в норме / внимание / недоступно), часы, тема,
               анимации, профиль пользователя (роли, переключение компании);
     разделы — Обзор · Парк ПК · Склад · Задачи · Отчёты;
     Обзор   — быстрые ответы, плитки по компаниям, топ проблем, инфраструктура;
     Парк ПК — дерево компания → филиал → машина, фильтры, карточка с панелями;
     Отчёты  — таблица по парку, печать и выгрузка CSV;
     Склад и Задачи — заглушки (API v3 ещё не выложен). */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  // Ссылка из данных API попадает в DOM только как http(s) — иначе это может
  // быть javascript: из внешнего JSON.
  const safeUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u.trim());

  const SECTIONS = ['overview', 'fleet', 'warehouse', 'tasks', 'reports'];

  const state = {
    status: null,
    fleet: null,
    registry: null,   // GET /api/fleet/registry — полные записи карточек + orgs
    registryMissing: false, // эндпоинта реестра на сервере нет
    section: 'overview', // overview | fleet | warehouse | tasks | reports
    query: '',
    company: 'all',
    branch: 'all',
    statusFilter: 'all', // all | ok | degraded | down | pending
    issuesOnly: false,
    theme: 'ink',
    anim: true,
    collapsed: new Set(), // свёрнутые группы дерева парка
    opened: new Set(),     // раскрытые карточки ПК (панели «Железо» и т. п.)
    focusPc: null,        // карточка, к которой прыгнули из «Топ проблем»
    user: null,           // профиль (заглушка, пока нет /api/auth/me)
    companies: null,      // /api/companies (заглушка, пока нет эндпоинта)
  };

  const REFRESH_MS = 60000;

  // Кэш анализа по id машины: ответы GET /api/fleet/pcs/:id/analysis не
  // запрашиваются заново при каждом рендере. После мутации или чата запись
  // инвалидируется, чтобы балл пересчитался на свежих данных.
  const analysisCache = new Map();
  const analysisInflight = new Map();
  const ANALYSIS_TTL_MS = 5 * 60 * 1000;

  // Профиль-заглушка: серверный API пользователей и компаний ещё не выложен.
  const USER_STUB = {
    name: 'Михаил Карпов',
    login: 'm.karpov',
    role: 'владелец · owner',
  };

  // Подпись текущего состояния: если данные не изменились, DOM не
  // перестраиваем — перерисовка даже с теми же данными вызывала скачок
  // раскладки (CLS до 0,78 на мобильном).
  function stateSignature() {
    const s = state.status;
    const f = state.fleet;
    if (!s) return 'empty';
    const src = (s.sources || []).map((x) =>
      x.id + ':' + x.status + ':' + (x.detail || '').length + ':' + (x.metrics || []).length).join('|');
    const pcs = ((f && f.pcs) || []).map((p) =>
      p.id + ':' + p.status + ':' + (p.detail || '').length + ':' + (p.metrics || []).length + ':' + (p.issues || []).length).join('|');
    // generatedAt НЕ входит: он меняется каждый опрос, и перерисовка
    // ради него сдвигала всю страницу (CLS 0,78).
    return src + '#' + pcs;
  }

  // Снимок, встроенный сервером в index.html: первый кадр уже полный,
  // поэтому нет «прыжка» страницы, когда приходят данные по сети.
  function readBoot() {
    const node = document.getElementById('boot');
    if (!node) return null;
    try { return JSON.parse(node.textContent || 'null'); } catch (e) { return null; }
  }

  // ---------- сеть ----------
  // Фронт может быть опубликован на GitHub Pages, тогда API живёт на другом
  // домене: адрес берём из window.KK_API_BASE (или <meta name="kk-api-base">),
  // а доступ — по API-токену (Authorization: Bearer), который хранится в
  // localStorage. Cookie с чужого домена не долетит, токен — долетит.
  const API_BASE = (function () {
    const meta = document.querySelector('meta[name="kk-api-base"]');
    const base = (window.KK_API_BASE || (meta && meta.content) || '').trim();
    return base.replace(/\/+$/, '');
  })();
  const API_TOKEN_KEY = 'kk_api_token';

  function apiToken() {
    try { return localStorage.getItem(API_TOKEN_KEY) || ''; } catch (e) { return ''; }
  }

  function setApiToken(token) {
    try {
      if (token) localStorage.setItem(API_TOKEN_KEY, token);
      else localStorage.removeItem(API_TOKEN_KEY);
    } catch (e) { /* приватный режим */ }
  }

  // Адреса API: сначала внешний (через корпоративный VPS), при недоступности —
  // прямой офисный. В офисе DNS отдаёт внутренний адрес домена (split-horizon
  // в coredns), поэтому внешний порт оттуда недоступен, а снаружи наоборот.
  // Адрес API выбираем по протоколу страницы: с HTTPS-страницы нельзя ходить
  // на HTTP (mixed content), а в офисе DNS отдаёт внутренний адрес домена —
  // внешний порт оттуда недоступен.
  const API_CANDIDATES = (location.protocol === 'https:')
    ? ['https://a.mdlp.gk-kd.ru:24112']
    : ['http://a.mdlp.gk-kd.ru:7100', 'http://192.168.1.227:7100'];
  let apiIndex = 0;

  function apiUrl(path) {
    if (!API_CANDIDATES.length) return path;
    const base = API_CANDIDATES[apiIndex] || '';
    if (!base) return path;
    return base + (path.startsWith('/') ? path : '/' + path);
  }

  function authHeaders(extra) {
    const headers = extra || {};
    const token = apiToken();
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  // Один запрос с перебором адресов: при сетевой ошибке или 5xx пробуем
  // следующий адрес (внешний → внутренний).
  async function apiFetch(path, opts) {
    const options = Object.assign({ cache: 'no-store' }, opts || {});
    options.credentials = API_BASE ? 'include' : 'same-origin';
    options.headers = authHeaders(Object.assign({ Accept: 'application/json' }, options.headers || {}));
    let lastErr = null;
    for (let i = 0; i < API_CANDIDATES.length; i++) {
      apiIndex = i;
      try {
        const res = await fetch(apiUrl(path), options);
        if (res.status >= 500) { lastErr = new Error('HTTP ' + res.status); continue; }
        return res;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Сеть недоступна');
  }

  async function getJson(url) {
    let res;
    try {
      res = await apiFetch(url);
    } catch (e) {
      // Сеть недоступна: из офисной сети браузер блокирует обращения с
      // публичной страницы (GitHub Pages) к приватному адресу сервера.
      // Показываем страницу входа с пояснением, а не бесконечную «загрузку».
      if (!location.pathname.endsWith('/login.html')) {
        location.replace('./login.html?err=network');
      }
      throw e;
    }
    if (!res.ok) {
      if (res.status === 401 && !location.pathname.endsWith('/login.html')) {
        location.replace('./login.html');
        return {};
      }
      throw new Error('HTTP ' + res.status);
    }
    return res.json();
  }

  // Запрос с телом (POST/PUT/DELETE) и разбор тела ошибки: сервер отдаёт
  // {"error": "текст"} — показываем его пользователю как есть.
  // timeoutMs — страховка от «зависшего» запроса: кнопка не должна
  // блокироваться навсегда, если сервер не отвечает.
  async function apiSend(method, url, body, timeoutMs) {
    const opts = {
      method,
      cache: 'no-store',
      credentials: API_BASE ? 'include' : 'same-origin',
      headers: authHeaders({ Accept: 'application/json' }),
    };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const limit = timeoutMs || 30000;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    if (ctrl) opts.signal = ctrl.signal;
    const timer = setTimeout(() => { if (ctrl) ctrl.abort(); }, limit);
    let res;
    try {
      res = await apiFetch(url, opts);
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') {
        const err = new Error('Сервер не ответил вовремя (' + Math.round(limit / 1000) + ' с)');
        err.timeout = true;
        throw err;
      }
      const err = new Error('Сеть недоступна: ' + (e && e.message ? e.message : 'запрос не прошёл'));
      err.net = true;
      throw err;
    }
    clearTimeout(timer);
    let data = null;
    const raw = await res.text();
    if (raw) {
      try { data = JSON.parse(raw); } catch (e) { data = null; }
    }
    if (!res.ok) {
      // 401 — нет действующей сессии или токена: на внешнем домене показываем
      // страницу входа (она же просит API-токен на 72 часа).
      if (res.status === 401 && !location.pathname.endsWith('/login.html')) {
        location.replace('./login.html');
        return {};
      }
      const err = new Error((data && data.error) || httpMessage(res.status));
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  function httpMessage(status) {
    if (status === 404) return 'Сервер не знает этот запрос (404)';
    if (status === 401 || status === 403) return 'Нет прав на операцию (' + status + ')';
    if (status === 409) return 'Конфликт данных (409)';
    if (status >= 500) return 'Ошибка сервера (' + status + ')';
    return 'Ошибка запроса (' + status + ')';
  }

  async function loadAll(manual) {
    const btn = $('#refresh');
    if (btn) btn.dataset.busy = '1';
    try {
      const [status, fleet] = await Promise.all([
        getJson('api/status'),
        getJson('api/fleet').catch(() => null),
      ]);
      state.status = status;
      state.fleet = fleet;
      render();
      if (manual) toast('Обновлено');
      prefetchAnalyses();
    } catch (e) {
      renderError(String(e.message || e));
    } finally {
      if (btn) btn.dataset.busy = '0';
    }
  }

  // ---------- отрисовка ----------
  let lastSignature = null;

  function render(force) {
    if (!state.status) return;
    const sig = stateSignature();
    // Первый рендер — всегда; дальше только при изменении данных.
    // Перерисовка даже с теми же данными вызывала скачок раскладки
    // (CLS до 0,78 на мобильном).
    if (!force && sig === lastSignature) return;
    lastSignature = sig;
    renderChrome();
    renderSection();
  }

  // Шапка, сводка и навигация: перерисовываются и при смене данных, и при
  // смене фильтров (счётчики в сводке зависят от раздела).
  function renderChrome() {
    renderHeader();
    renderSummary();
    renderNav();
    showSection();
  }

  function showSection() {
    for (const id of SECTIONS) {
      const node = $('#sec-' + id);
      if (node) node.hidden = id !== state.section;
    }
    for (const id of SECTIONS) {
      const btn = $('#nav-' + id);
      if (!btn) continue;
      if (id === state.section) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    }
  }

  function renderSection() {
    switch (state.section) {
      case 'fleet': renderFleet(); break;
      case 'warehouse': renderWarehouse(); break;
      case 'tasks': renderTasks(); break;
      case 'reports': renderReports(); break;
      default: renderOverview(); break;
    }
  }

  function renderHeader() {
    const s = state.status.sources || [];
    const bad = s.filter((x) => x.status === 'down').length;
    const warn = s.filter((x) => x.status === 'degraded').length;
    const pulse = $('#pulse');
    pulse.dataset.state = bad ? 'danger' : (warn ? 'warn' : 'ok');
    const label = bad
      ? `${bad} ${plural(bad, 'источник недоступен', 'источника недоступно', 'источников недоступно')}`
      : (warn ? `${warn} с предупреждениями` : 'все системы в норме');
    $('#state').textContent = label;

    const d = new Date();
    $('#clock-time').textContent = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    $('#clock-date').textContent = d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
    $('#updated').textContent = `обновлено ${state.status.generatedAt || '—'}`;
    const f = state.status.fleet;
    if (f && f.generatedAt) {
      const age = Math.max(0, Math.round((Date.now() - Date.parse(f.generatedAt)) / 60000));
      $('#fleet-updated').textContent = f.stale
        ? `данные парка устарели (${age} мин)`
        : `снимок парка: ${new Date(f.generatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
    }
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  // ---------- сводка в шапке ----------
  // Считаем всё, что мониторится: источники инфраструктуры + машины парка.
  // Чип — это быстрый фильтр: клик оставляет в парке только машины со
  // статусом «внимание» / «недоступно».
  function renderSummary() {
    const box = $('#summary');
    box.textContent = '';
    const infra = (state.status.sources || []).filter((x) => x.group !== 'Парк ПК');
    const all = infra.concat(fleetPcs().map((p) => ({ status: p.status })));
    const counts = { ok: 0, degraded: 0, down: 0, pending: 0 };
    for (const x of all) {
      const key = x.status === 'pending' ? 'pending' : (counts[x.status] !== undefined ? x.status : 'down');
      if (counts[key] !== undefined) counts[key]++;
    }
    const tones = [['ok', 'в норме'], ['degraded', 'внимание'], ['down', 'недоступно']];
    for (const [tone, label] of tones) {
      const chip = el('button', 'sumchip');
      chip.type = 'button';
      chip.dataset.tone = tone;
      chip.appendChild(el('span', 'sumchip__n', counts[tone]));
      chip.appendChild(el('span', 'sumchip__t', label));
      chip.setAttribute('aria-pressed', String(state.statusFilter === tone));
      chip.title = `Показать в парке только «${label}»`;
      chip.addEventListener('click', () => {
        state.statusFilter = state.statusFilter === tone ? 'all' : tone;
        state.issuesOnly = false;
        go('fleet');
      });
      box.appendChild(chip);
    }
    const pending = counts.pending;
    if (pending) {
      const note = el('span', 'sumbar__note', `${pending} ${plural(pending, 'машина ждёт', 'машины ждут', 'машин ждут')} настройки`);
      box.appendChild(note);
    }
  }

  function renderNav() {
    const count = $('#nav-fleet-count');
    if (count) {
      const total = fleetPcs().length;
      const bad = fleetPcs().filter((p) => p.status === 'down' || p.status === 'degraded').length;
      count.textContent = total ? `${total}${bad ? ' · ' + bad + '!' : ''}` : '—';
      count.title = bad ? `${bad} машин с проблемами` : 'машин в парке';
    }
  }

  // ---------- обзор ----------
  function renderOverview() {
    renderQuick();
    renderTiles();
    renderProblems();
    renderInfra();
  }

  // «Быстрый ответ» — четыре вопроса, ради которых админ открывает дашборд.
  function renderQuick() {
    const box = $('#ov-quick');
    if (!box) return;
    box.textContent = '';
    const items = [
      {
        t: 'Что упало',
        d: 'Источники и машины со статусом «недоступно»',
        fn: () => { state.statusFilter = 'down'; state.issuesOnly = false; go('fleet'); },
      },
      {
        t: 'Где сотрудник не может работать',
        d: 'Машины, которых нет в сети',
        fn: () => { state.statusFilter = 'down'; state.issuesOnly = false; go('fleet'); },
      },
      {
        t: 'Что чинить или заменять',
        d: 'Машины с проблемами ИБ и просроченными обновлениями',
        fn: () => { state.statusFilter = 'all'; state.issuesOnly = true; go('fleet'); },
      },
      {
        t: 'Кого позвать на ПК',
        d: 'Парк по компаниям и филиалам',
        fn: () => { resetFilters(); go('fleet'); },
      },
    ];
    for (const it of items) {
      const b = el('button', 'quicktile');
      b.type = 'button';
      b.appendChild(el('span', 'quicktile__t', it.t));
      b.appendChild(el('span', 'quicktile__d', it.d));
      b.addEventListener('click', it.fn);
      box.appendChild(b);
    }
  }

  // Плитки по компаниям: сколько машин, средний КПД, сколько проблем.
  function renderTiles() {
    const box = $('#ov-tiles');
    if (!box) return;
    box.textContent = '';
    const stats = companyStats();
    if (!stats.length) {
      box.appendChild(el('div', 'empty', 'Данные парка недоступны: сборщик на .207 не отвечает'));
      return;
    }
    for (const st of stats) {
      const tile = el('button', 'ovtile');
      tile.type = 'button';
      tile.title = 'Открыть парк: ' + st.name;
      const head = el('div', 'ovtile__head');
      head.appendChild(el('span', 'ovtile__name', st.short));
      head.appendChild(el('span', 'ovtile__full', st.name));
      tile.appendChild(head);

      const nums = el('div', 'ovtile__nums');
      nums.appendChild(tileNum(st.total, 'машин'));
      nums.appendChild(tileNum(st.avg === null ? '—' : st.avg, 'ср. КПД'));
      nums.appendChild(tileNum(st.problems, 'проблем'));
      tile.appendChild(nums);

      if (st.problems || !st.online) {
        const note = el('div', 'ovtile__note');
        note.textContent = (!st.online ? st.offline + ' не в сети' : '') + (st.problems ? ' · ' + st.problems + ' с проблемами' : '');
        tile.appendChild(note);
      }

      tile.addEventListener('click', () => {
        state.company = st.id;
        state.branch = 'all';
        resetFilters(false);
        go('fleet');
      });
      box.appendChild(tile);
    }
  }

  function tileNum(value, key) {
    const n = el('div', 'ovtile__num');
    n.appendChild(el('span', 'ovtile__v', value));
    n.appendChild(el('span', 'ovtile__k', key));
    return n;
  }

  function companyStats() {
    const map = new Map();
    for (const c of companyList()) map.set(c.id, { id: c.id, total: 0, online: 0, offline: 0, problems: 0, scores: [] });
    for (const pc of fleetPcs()) {
      const id = pc.companyId || pc.org;
      if (!map.has(id)) map.set(id, { id, total: 0, online: 0, offline: 0, problems: 0, scores: [] });
      const st = map.get(id);
      st.total++;
      if (pc.online) st.online++; else st.offline++;
      if (pc.issues && pc.issues.length) st.problems++;
      const a = analysisCache.get(pc.id);
      if (a && a.ok && a.data && typeof a.data.score === 'number') st.scores.push(a.data.score);
    }
    return [...map.values()].map((st) => {
      const meta = companyMeta(st.id);
      st.name = meta.name;
      st.short = meta.short;
      st.avg = st.scores.length
        ? Math.round(st.scores.reduce((a, b) => a + b, 0) / st.scores.length)
        : null;
      return st;
    });
  }

  // Топ проблем по парку: одинаковые проблемы с разных машин — одна строка
  // со счётчиком «N машин», без дублей.
  function renderProblems() {
    const box = $('#ov-issues');
    const note = $('#ov-issues-note');
    if (!box) return;
    box.textContent = '';
    const problems = topProblems(8);
    if (note) note.textContent = problems.length ? 'одинаковые проблемы собраны вместе' : '';
    if (!problems.length) {
      box.appendChild(el('div', 'empty', 'Проблем не найдено: парк в норме'));
      return;
    }
    for (const p of problems) {
      const row = el('div', 'probrow');
      row.appendChild(el('span', 'probrow__text', p.text));
      const n = el('span', 'probrow__n', p.count + ' ' + plural(p.count, 'машина', 'машины', 'машин'));
      row.appendChild(n);
      const btn = el('button', 'ghostbtn', 'открыть');
      btn.type = 'button';
      btn.title = 'Перейти к карточке: ' + (pcName(p.pcs[0]) || '');
      btn.addEventListener('click', () => jumpToPc(p.pcs[0]));
      row.appendChild(btn);
      box.appendChild(row);
    }
  }

  function topProblems(limit) {
    const map = new Map();
    for (const pc of fleetPcs()) {
      for (const raw of pc.issues || []) {
        const key = normalizeIssue(raw);
        if (!key) continue;
        if (!map.has(key)) map.set(key, { text: String(raw), count: 0, pcs: [] });
        const item = map.get(key);
        item.count++;
        item.pcs.push(pc.id);
        if (String(raw).length < item.text.length) item.text = String(raw);
      }
    }
    const list = [...map.values()];
    list.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, 'ru'));
    return limit ? list.slice(0, limit) : list;
  }

  // Ключ проблемы без чисел: «обновления Windows не ставились 87 дн.» и
  // «...12 дн.» — это одна и та же проблема на разных машинах.
  function normalizeIssue(text) {
    return String(text).toLowerCase().replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim();
  }

  // ---------- инфраструктура ----------
  function renderInfra() {
    const board = $('#board');
    if (!board) return;
    board.textContent = '';
    const q = state.query.trim().toLowerCase();
    const sources = (state.status.sources || []).filter((x) => {
      if (x.group === 'Парк ПК') return false;
      if (!q) return true;
      return (x.name + ' ' + x.detail + ' ' + (x.group || '')).toLowerCase().includes(q);
    });

    if (!sources.length) {
      board.appendChild(el('div', 'empty', 'Ничего не найдено'));
      return;
    }

    const groups = new Map();
    sources.forEach((x) => {
      const g = x.group || 'Прочее';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(x);
    });

    let idx = 0;
    for (const [name, list] of groups) {
      const group = el('div', 'group');
      group.appendChild(el('div', 'group__head', name));
      const head = el('div', 'board__head');
      head.appendChild(el('span', null, '№'));
      head.appendChild(el('span', null, 'источник'));
      head.appendChild(el('span', null, 'метрики'));
      head.appendChild(el('span', null, 'отклик'));
      group.appendChild(head);
      for (const s of list) group.appendChild(sourceCard(s, ++idx));
      board.appendChild(group);
    }
  }

  function sourceCard(s, idx) {
    const card = el('div', 'card');
    card.dataset.status = s.status || 'down';
    card.appendChild(el('div', 'card__idx', String(idx).padStart(2, '0')));

    const main = el('div', 'card__main');
    const name = el('div', 'card__name');
    name.appendChild(el('span', null, s.name));
    const badge = el('span', 'badge', statusText(s.status));
    badge.dataset.status = s.status || 'down';
    name.appendChild(badge);
    if (s.location) name.appendChild(el('span', 'card__loc', s.location));
    main.appendChild(name);
    main.appendChild(el('div', 'card__detail', s.detail || ''));
    card.appendChild(main);

    const side = el('div', 'card__side');
    const metrics = el('div', 'card__metrics');
    for (const m of s.metrics || []) {
      const metric = el('div', 'metric');
      metric.appendChild(el('span', 'metric__k', m.label));
      metric.appendChild(el('span', 'metric__value', m.value));
      if (typeof m.pct === 'number') {
        const bar = el('div', 'metric__bar');
        const fill = el('i');
        fill.style.width = Math.max(0, Math.min(100, m.pct)) + '%';
        bar.appendChild(fill);
        metric.appendChild(bar);
      }
      metrics.appendChild(metric);
    }
    side.appendChild(metrics);
    if (Array.isArray(s.history) && s.history.length > 1) side.appendChild(spark(s.history));
    card.appendChild(side);

    card.appendChild(el('div', 'card__latency', s.latencyMs != null ? `${s.latencyMs} мс` : '—'));
    return card;
  }

  function statusText(status) {
    if (status === 'ok') return 'работает';
    if (status === 'degraded') return 'деградация';
    if (status === 'down') return 'НЕДОСТУПЕН';
    if (status === 'pending') return 'ожидает настройки';
    return 'нет данных';
  }

  function spark(history) {
    const wrap = el('div', 'spark-wrap');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('viewBox', '0 0 120 26');
    svg.setAttribute('preserveAspectRatio', 'none');
    const pts = history.map((p) => p[1]).filter((v) => typeof v === 'number');
    if (pts.length > 1) {
      const max = Math.max(100, ...pts);
      const d = pts.map((v, i) => {
        const x = (i / (pts.length - 1)) * 118 + 1;
        const y = 24 - (v / max) * 22;
        return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'spark__line');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    wrap.appendChild(svg);
    return wrap;
  }

  // ---------- парк ПК ----------
  function fleetPcs() {
    return (state.fleet && state.fleet.pcs) || [];
  }

  function orgOf(id) {
    const orgs = (state.fleet && state.fleet.orgs) || {};
    return orgs[id] || {};
  }

  // Компании: сначала /api/companies (там есть филиалы), иначе — орг-карта
  // из /api/fleet.
  function companyMeta(id) {
    const list = (state.companies && state.companies.companies) || [];
    const found = list.find((c) => c && c.id === id);
    if (found) {
      return {
        id: found.id,
        name: found.name || found.short || found.id,
        short: found.short || found.name || found.id,
        branches: (found.branches || []).map((b) => ({ id: b.id, name: b.name || b.id, city: b.city || '' })),
      };
    }
    const o = orgOf(id);
    return { id, name: o.name || id, short: o.short || o.name || id, branches: [] };
  }

  function companyList() {
    const list = (state.companies && state.companies.companies) || [];
    if (list.length) return list.map((c) => companyMeta(c.id));
    return Object.keys((state.fleet && state.fleet.orgs) || {}).map((id) => companyMeta(id));
  }

  function orgShort(id) {
    return companyMeta(id).short;
  }

  // Филиал машины: поле branchId из API → название → подразделение из
  // реестра → «Без филиала».
  function branchOf(pc) {
    if (pc.branchId) {
      for (const c of companyList()) {
        const b = c.branches.find((x) => x.id === pc.branchId);
        if (b) return b.name;
      }
      return String(pc.branchId);
    }
    if (pc.branchName) return String(pc.branchName);
    if (pc.branch && typeof pc.branch === 'object' && pc.branch.name) return String(pc.branch.name);
    if (typeof pc.branch === 'string' && pc.branch) return pc.branch;
    if (pc.unit) return String(pc.unit);
    return 'Без филиала';
  }

  function pcName(id) {
    const pc = fleetPcs().find((p) => p.id === id);
    return pc ? (pc.person || pc.hostname || pc.ip) : '';
  }

  // Компания машины: companyId из API, иначе старая метка org.
  function pcCompany(pc) {
    return pc.companyId || pc.org || '';
  }

  function filteredPcs() {
    const q = state.query.trim().toLowerCase();
    return fleetPcs().filter((pc) => {
      if (state.company !== 'all' && pcCompany(pc) !== state.company) return false;
      if (state.branch !== 'all' && branchOf(pc) !== state.branch) return false;
      if (state.statusFilter !== 'all' && (pc.status || 'down') !== state.statusFilter) return false;
      if (state.issuesOnly && !(pc.issues && pc.issues.length)) return false;
      if (!q) return true;
      return [pc.person, pc.role, pc.hostname, pc.ip, pc.orgName, pc.unit, pc.detail]
        .filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }

  function renderFleet() {
    const box = $('#park');
    if (!box) return;
    box.textContent = '';
    renderOrgChips();
    renderBranchFilter();

    if (!state.fleet) {
      box.appendChild(el('div', 'empty', 'Данные парка недоступны: сборщик на .207 не отвечает'));
      return;
    }
    const pcs = filteredPcs();
    const all = fleetPcs();
    if (!all.length) {
      box.appendChild(el('div', 'empty', 'В реестре пока нет ни одной машины'));
      return;
    }
    if (!pcs.length) {
      box.appendChild(el('div', 'empty', 'Машин по фильтру не найдено'));
      const btn = el('button', 'ghostbtn', 'сбросить фильтры');
      btn.type = 'button';
      btn.addEventListener('click', () => { resetFilters(); renderSection(); });
      const wrap = el('div', 'empty__act');
      wrap.appendChild(btn);
      box.appendChild(wrap);
      return;
    }

    // Дерево: компания → филиал → машина.
    const byOrg = new Map();
    for (const pc of pcs) {
      const orgId = pcCompany(pc);
      if (!byOrg.has(orgId)) byOrg.set(orgId, new Map());
      const branches = byOrg.get(orgId);
      const b = branchOf(pc);
      if (!branches.has(b)) branches.set(b, []);
      branches.get(b).push(pc);
    }
    const orgIds = [...byOrg.keys()].sort((a, b) => companyRank(a) - companyRank(b));
    for (const orgId of orgIds) {
      const branches = byOrg.get(orgId);
      const orgPcs = [];
      for (const list of branches.values()) orgPcs.push(...list);
      const key = 'org:' + orgId;
      const group = el('section', 'fgroup');
      group.dataset.org = orgId;
      group.appendChild(fgroupHead(key, orgShort(orgId), orgName(orgId), orgPcs, true));
      if (!state.collapsed.has(key)) {
        const body = el('div', 'fgroup__body');
        const branchIds = [...branches.keys()].sort((a, b) => a.localeCompare(b, 'ru'));
        for (const branchId of branchIds) {
          const list = branches.get(branchId);
          const bkey = 'branch:' + orgId + '/' + branchId;
          const sub = el('div', 'fgroup fgroup--sub');
          sub.dataset.branch = branchId;
          sub.appendChild(fgroupHead(bkey, branchId, branchId, list, false));
          if (!state.collapsed.has(bkey)) {
            const grid = el('div', 'park');
            for (const pc of list) grid.appendChild(pcCard(pc));
            sub.appendChild(grid);
          }
          body.appendChild(sub);
        }
        group.appendChild(body);
      }
      box.appendChild(group);
    }
  }

  function orgName(id) {
    return companyMeta(id).name;
  }

  // Порядок компаний — как в /api/companies (КК, Диамедика, Диалам+),
  // а не по алфавиту: так парк читается в привычном порядке.
  function companyRank(id) {
    const i = companyList().findIndex((c) => c.id === id);
    return i === -1 ? 999 : i;
  }

  // Заголовок группы: название, счётчики (машины / проблемы / ср. КПД) и
  // свёртка. Кнопка — единственный интерактивный элемент.
  function fgroupHead(key, title, subtitle, pcs, isOrg) {
    const head = el('button', 'fgroup__head');
    head.type = 'button';
    head.setAttribute('aria-expanded', String(!state.collapsed.has(key)));
    const arrow = el('span', 'fgroup__arrow', state.collapsed.has(key) ? '▸' : '▾');
    head.appendChild(arrow);
    head.appendChild(el('span', 'fgroup__title', title));
    if (subtitle && subtitle !== title) head.appendChild(el('span', 'fgroup__sub', subtitle));

    const problems = pcs.filter((p) => p.issues && p.issues.length).length;
    const offline = pcs.filter((p) => !p.online).length;
    const scores = pcs.map((p) => {
      const a = analysisCache.get(p.id);
      return a && a.ok && a.data && typeof a.data.score === 'number' ? a.data.score : null;
    }).filter((v) => v !== null);
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

    const meta = el('span', 'fgroup__meta');
    meta.appendChild(el('span', null, pcs.length + ' ' + plural(pcs.length, 'машина', 'машины', 'машин')));
    if (problems) meta.appendChild(el('span', 'fgroup__bad', problems + ' ' + plural(problems, 'проблема', 'проблемы', 'проблем')));
    if (offline) meta.appendChild(el('span', 'fgroup__bad', offline + ' не в сети'));
    meta.appendChild(el('span', null, 'КПД ' + (avg === null ? '—' : avg)));
    head.appendChild(meta);

    head.addEventListener('click', () => {
      if (state.collapsed.has(key)) state.collapsed.delete(key);
      else state.collapsed.add(key);
      renderSection();
    });
    if (!isOrg) head.classList.add('fgroup__head--sub');
    return head;
  }

  function renderOrgChips() {
    const box = $('#orgs');
    if (!box) return;
    box.textContent = '';
    const pcs = fleetPcs();
    const mk = (id, label, count) => {
      const b = el('button', null, count != null ? `${label} · ${count}` : label);
      b.type = 'button';
      b.setAttribute('aria-pressed', String((state.company || 'all') === id));
      b.addEventListener('click', () => {
        state.company = id;
        state.branch = 'all';
        renderSection();
        renderChrome();
      });
      return b;
    };
    box.appendChild(mk('all', 'все', pcs.length));
    for (const c of companyList()) {
      const n = pcs.filter((p) => (p.companyId || p.org) === c.id).length;
      box.appendChild(mk(c.id, c.short, n));
    }
  }

  // Филиалы для фильтра: из /api/companies по выбранной компании + те, что
  // реально встречаются в парке (на случай старой версии сервера).
  function branchList() {
    const set = new Set();
    if (state.company !== 'all') {
      for (const b of companyMeta(state.company).branches) set.add(b.name);
    } else {
      for (const c of companyList()) for (const b of c.branches) set.add(b.name);
    }
    for (const pc of fleetPcs()) {
      if (state.company !== 'all' && pc.org !== state.company) continue;
      set.add(branchOf(pc));
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
  }

  function renderBranchFilter() {
    const sel = $('#filter-branch');
    if (!sel) return;
    const branches = branchList();
    const cur = state.branch;
    sel.textContent = '';
    const all = el('option', null, 'все');
    all.value = 'all';
    sel.appendChild(all);
    for (const b of branches) {
      const o = el('option', null, b);
      o.value = b;
      sel.appendChild(o);
    }
    sel.value = branches.indexOf(cur) === -1 ? 'all' : cur;
    if (sel.value !== cur) state.branch = 'all';
  }

  function resetFilters(withCompany) {
    state.query = '';
    state.statusFilter = 'all';
    state.issuesOnly = false;
    state.branch = 'all';
    if (withCompany !== false) state.company = 'all';
    const search = $('#search');
    if (search) search.value = '';
    const status = $('#filter-status');
    if (status) status.value = 'all';
    const issues = $('#filter-issues');
    if (issues) issues.setAttribute('aria-pressed', 'false');
    const chips = $$('#orgs button');
    if (chips[0]) chips[0].setAttribute('aria-pressed', 'true');
  }

  // ---------- карточка ПК ----------
  // Ленивая подгрузка КПД для карточек парка: без неё карточка показывает
  // «—» и не видит рекомендации со ссылками на магазины. Запросы идут
  // пачками по мере появления карточек (IntersectionObserver), а не все
  // разом — иначе 18 запросов к серверу за один кадр.
  function observeAnalysis(card, pc) {
    if (analysisCache.has(pc.id)) return;
    if (typeof IntersectionObserver !== 'function') {
      requestAnalysis(pc.id).then(() => refreshCardAnalysis(card, pc));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        io.unobserve(e.target);
        requestAnalysis(pc.id).then(() => refreshCardAnalysis(card, pc));
      }
    }, { rootMargin: '200px' });
    io.observe(card);
  }

  // Перерисовка карточки после загрузки анализа: балл, рекомендации,
  // ссылки на магазины и предупреждение о материнской плате.
  function refreshCardAnalysis(card, pc) {
    const entry = analysisCache.get(pc.id);
    if (!entry || !entry.ok || !entry.data) return;
    const chip = card.querySelector('.pccard__score');
    if (chip) {
      const fresh = scoreChip(pc);
      chip.replaceWith(fresh);
    }
    const host = card.querySelector('.pccard__recs');
    if (!host) return;
    host.textContent = '';
    const recs = (entry.data.recommendations || []).slice(0, 3);
    for (const r of recs) {
      const li = el('li');
      li.appendChild(el('span', null, String((r && r.action) || '')));
      if (r && r.gain !== undefined && r.gain !== null) {
        li.appendChild(el('span', 'pccard__gain', ' +' + r.gain));
      }
      const links = recLinks(r);
      if (links.length) {
        const boxLinks = el('span', 'pccard__links');
        for (const l of links) {
          const a2 = el('a', 'pccard__link', l.label);
          a2.href = l.url;
          a2.target = '_blank';
          a2.rel = 'noopener noreferrer';
          boxLinks.appendChild(a2);
        }
        li.appendChild(boxLinks);
      }
      if (r && r.warning) {
        li.appendChild(el('span', 'pccard__warn', String(r.warning)));
      }
      host.appendChild(li);
    }
  }
  function pcCard(pc) {
    const card = el('div', 'pccard');
    card.dataset.status = pc.status || 'down';
    card.dataset.pc = pc.id;
    card.id = 'pc-' + pc.id;
    if (state.focusPc === pc.id) card.classList.add('pccard--flash');

    const head = el('div', 'pccard__head');
    const who = el('div', 'pccard__who');
    who.appendChild(el('div', 'pccard__person', pc.person || pc.hostname || pc.ip));
    who.appendChild(el('div', 'pccard__role', pc.role || ''));
    const tags = el('div', 'pccard__tags');
    tags.appendChild(el('span', 'pccard__org', orgShort(pc.org)));
    const branch = branchOf(pc);
    if (branch && branch !== 'Без филиала') tags.appendChild(el('span', 'pccard__org', branch));
    if (pc.pending) tags.appendChild(el('span', 'pccard__org', 'ожидает настройки'));
    who.appendChild(tags);
    who.appendChild(el('div', 'pccard__host', `${pc.hostname || '—'} · ${pc.ip || '—'}`));
    head.appendChild(who);

    const right = el('div', 'pccard__headside');
    const badge = el('span', 'badge', pcStatusText(pc));
    badge.dataset.status = pc.status || 'down';
    right.appendChild(badge);
    const score = scoreChip(pc);
    right.appendChild(score);
    head.appendChild(right);
    card.appendChild(head);

    if (pc.detail) card.appendChild(el('div', 'pccard__detail', pc.detail));

    if (pc.issues && pc.issues.length) {
      const ul = el('ul', 'pccard__issues');
      for (const issue of pc.issues) ul.appendChild(el('li', null, issue));
      card.appendChild(ul);
    }

    const metrics = el('div', 'pccard__metrics');
    for (const m of pc.metrics || []) {
      const metric = el('div', 'metric');
      metric.appendChild(el('span', 'metric__k', m.label));
      metric.appendChild(el('span', 'metric__value', m.value));
      if (typeof m.pct === 'number') {
        const bar = el('div', 'metric__bar');
        const fill = el('i');
        fill.style.width = Math.max(0, Math.min(100, m.pct)) + '%';
        bar.appendChild(fill);
        metric.appendChild(bar);
      }
      metrics.appendChild(metric);
    }
    if (metrics.childNodes.length) card.appendChild(metrics);

    // Панели с подробностями — по кнопке: карточек много, а детали нужны
    // только когда разбираешь конкретную машину.
    const panelsId = 'panels-' + pc.id;
    const toggle = el('button', 'ghostbtn pccard__more', state.opened.has(pc.id) ? 'свернуть' : 'подробнее');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(state.opened.has(pc.id)));
    toggle.setAttribute('aria-controls', panelsId);
    const panels = el('div', 'pccard__panels');
    panels.id = panelsId;
    if (state.opened.has(pc.id)) {
      panels.appendChild(whatPanel(pc));
      panels.appendChild(hwPanel(pc));
      panels.appendChild(secPanel(pc));
      panels.appendChild(cryptoPanel(pc));
    } else {
      panels.hidden = true;
    }
    toggle.addEventListener('click', () => {
      if (state.opened.has(pc.id)) state.opened.delete(pc.id);
      else state.opened.add(pc.id);
      renderSection();
    });

    const acts = el('div', 'pccard__acts');
    const links = pc.links || {};
    acts.appendChild(linkBtn('Терминал', links.terminal, 'Подключиться к терминалу через MeshCentral'));
    acts.appendChild(linkBtn('Экран', links.desktop, 'Показать экран ПК'));
    acts.appendChild(linkBtn('Файлы', links.files, 'Открыть файлы ПК'));
    if (links.ssh) {
      const b = el('button', 'ghostbtn', 'SSH');
      b.type = 'button';
      b.title = links.ssh;
      b.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(links.ssh);
          toast('Команда скопирована');
        } catch (e) {
          toast(links.ssh);
        }
      });
      acts.appendChild(b);
    }
    acts.appendChild(actBtn('Задача', 'Запустить задачу на машине (диагностика, чистка, перезагрузка)', () => { openTask(pc.id); }));
    acts.appendChild(actBtn('Правка', 'Изменить карточку ПК', () => { openEditor(pc.id); }));
    acts.appendChild(actBtn('Чат', 'Чат по машине: изменить конфигурацию', () => { openChat(pc.id); }));
    // Удаление - прямо в карточке: разобрали машину, карточку убираем.
    acts.appendChild(actBtn('Удалить', 'Удалить карточку из парка (машину разобрали или списали)', () => {
      if (!window.confirm('Удалить карточку «' + (pc.person || pc.hostname || pc.ip) + '» из парка? Действие необратимо.')) return;
      deletePcFromCard(pc);
    }));
    // Разбор ПК: комплектующие уходят на склад, карточка удаляется.
    acts.appendChild(actBtn('Разобрать', 'Разобрать ПК: детали на склад, карточка из парка', () => {
      if (!window.confirm('Разобрать «' + (pc.person || pc.hostname || pc.ip) + '»? Комплектующие уйдут на склад, карточка исчезнет из парка.')) return;
      stripPcToWarehouse(pc);
    }));
    acts.appendChild(toggle);
    // Блок рекомендаций: наполняется после загрузки анализа (см.
    // observeAnalysis). Ссылки на магазины и предупреждение о замене
    // материнской платы приходят с сервера.
    const recsBox = el('div', 'pccard__recbox');
    const recsUl = el('ul', 'pccard__recs');
    recsBox.appendChild(recsUl);
    card.appendChild(recsBox);
    observeAnalysis(card, pc);
    card.appendChild(acts);
    card.appendChild(panels);
    return card;
  }

  function pcStatusText(pc) {
    if (pc.status === 'pending') return 'ожидает настройки';
    if (!pc.online) return 'не в сети';
    if (pc.issues && pc.issues.length) return 'внимание';
    return 'на связи';
  }

  // Компактный балл КПД в шапке карточки.
  function scoreChip(pc) {
    const chip = el('div', 'pccard__score');
    const entry = analysisCache.get(pc.id);
    if (!entry || !entry.ok || !entry.data || typeof entry.data.score !== 'number') {
      chip.appendChild(el('span', 'pccard__scorenum', '—'));
      chip.appendChild(el('span', 'pccard__scorelabel', 'КПД'));
      chip.title = 'КПД считается…';
      return chip;
    }
    const score = Math.round(entry.data.score);
    chip.appendChild(el('span', 'pccard__scorenum', score));
    chip.appendChild(el('span', 'pccard__scorelabel', 'КПД'));
    chip.title = entry.data.grade || '';
    chip.dataset.tone = score >= 80 ? 'ok' : (score >= 50 ? 'warn' : 'bad');
    return chip;
  }

  function actBtn(label, title, onClick) {
    const b = el('button', 'ghostbtn', label);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', onClick);
    return b;
  }

  function linkBtn(label, href, title) {
    if (!href) {
      const b = el('button', 'ghostbtn', label);
      b.type = 'button';
      b.setAttribute('aria-disabled', 'true');
      b.title = 'Узел не найден в MeshCentral';
      return b;
    }
    const a = el('a', 'ghostbtn', label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = title;
    return a;
  }

  function renderError(message) {
    const box = $('#board');
    if (!box) return;
    box.textContent = '';
    box.appendChild(el('div', 'empty', `Не удалось получить данные: ${message}`));
  }

  // ---------- панели карточки ПК ----------
  function panelShell(title) {
    const p = el('div', 'pcpanel');
    p.appendChild(el('div', 'pcpanel__title', title));
    return p;
  }

  function panelRow(box, key, value, tone) {
    const row = el('div', 'pcpanel__row');
    row.appendChild(el('span', 'pcpanel__k', key));
    const v = el('span', 'pcpanel__v', value === undefined || value === null || value === '' ? 'н/д' : String(value));
    if (tone) v.dataset.tone = tone;
    row.appendChild(v);
    box.appendChild(row);
  }

  // Панель «Что с машиной»: балл, вердикт, разбор по узлам и рекомендации
  // (ссылки на магазины подставляет сервер).
  function whatPanel(pc) {
    const box = panelShell('Что с машиной');
    const entry = analysisCache.get(pc.id);
    if (!entry || !entry.ok || !entry.data) {
      box.appendChild(el('div', 'pcedit-kpd__none', 'КПД: нет данных (анализ недоступен)'));
      return box;
    }
    const a = entry.data;
    const score = Number(a.score);
    const hasScore = Number.isFinite(score);
    const head = el('div', 'pcedit-kpd__head');
    head.appendChild(el('span', 'pcedit-kpd__label', 'КПД'));
    head.appendChild(el('span', 'pcedit-kpd__score', hasScore ? String(Math.round(score)) : '—'));
    box.appendChild(head);
    const bar = el('div', 'pcedit-kpd__bar');
    const fill = el('i');
    fill.style.width = (hasScore ? Math.max(0, Math.min(100, score)) : 0) + '%';
    bar.appendChild(fill);
    box.appendChild(bar);
    if (a.grade) box.appendChild(el('div', 'pcedit-kpd__grade', String(a.grade)));

    if (Array.isArray(a.parts) && a.parts.length) {
      const parts = el('ul', 'pccard__parts');
      for (const p of a.parts) {
        const li = el('li');
        li.dataset.ok = p.ok ? '1' : '0';
        li.appendChild(el('span', 'pccard__partk', String(p.label || p.key || '')));
        li.appendChild(el('span', 'pccard__partv', String(p.have || 'н/д')));
        if (p.need) li.appendChild(el('span', 'pccard__partneed', 'нужно: ' + String(p.need)));
        parts.appendChild(li);
      }
      box.appendChild(parts);
    }

    const recs = (a.recommendations) || [];
    if (recs.length) {
      const list = el('ul', 'pcedit-kpd__recs pccard__recs');
      for (const r of recs.slice(0, 5)) {
        const li = el('li');
        li.appendChild(el('span', null, String((r && r.action) || '')));
        if (r && r.gain !== undefined && r.gain !== null) {
          li.appendChild(el('span', 'pcedit-kpd__gain', ` +${r.gain} балл.`));
        }
        const links = recLinks(r);
        if (links.length) {
          const boxLinks = el('span', 'pccard__links');
          for (const l of links) {
            const a2 = el('a', 'pccard__link', l.label);
            a2.href = l.url;
            a2.target = '_blank';
            a2.rel = 'noopener noreferrer';
            boxLinks.appendChild(a2);
          }
          li.appendChild(boxLinks);
        }
        // Предупреждение о несовместимости с материнской платой.
        if (r && r.warning) {
          li.appendChild(el('span', 'pccard__warn', String(r.warning)));
        }
        list.appendChild(li);
      }
      box.appendChild(list);
    }
    return box;
  }

  // Ссылки на магазины приходят с сервера (в рекомендациях). Без сервера
  // показывать нечего — пустую ссылку не рисуем.
  function recLinks(r) {
    const out = [];
    if (r && Array.isArray(r.links)) {
      for (const l of r.links) {
        const url = typeof l === 'string' ? l : (l && l.url);
        const label = (l && l.label) || 'купить';
        if (safeUrl(url)) out.push({ label: String(label), url: url.trim() });
      }
    }
    if (r && safeUrl(r.url)) out.push({ label: String(r.shopLabel || 'магазин'), url: r.url.trim() });
    return out;
  }

  // Панель «Железо»: состав машины. Данные — из реестра (/api/fleet/registry),
  // а если реестра на сервере нет — из разбора КПД сервера.
  function hwPanel(pc) {
    const box = panelShell('Железо');
    const hw = hwFor(pc);
    const parts = analysisParts(pc);
    const part = (key) => (parts.find((p) => p.key === key) || {});

    if (hw && hw.cpu) {
      const cpu = hw.cpu;
      panelRow(box, 'CPU', [cpu.model, cpu.cores ? cpu.cores + ' ядра' : '', cpu.threads ? cpu.threads + ' потока' : '', cpu.year ? cpu.year + ' г.' : ''].filter(Boolean).join(' · '));
    } else {
      panelRow(box, 'CPU', part('cpu').have);
    }
    // Материнская плата: модель, сокет и чипсет — по ним подбирается CPU и
    // память, поэтому сокет и тип DDR показываем отдельными строками.
    const board = hw && hw.board && typeof hw.board === 'object' ? hw.board : null;
    if (board) {
      panelRow(box, 'Материнская плата', [board.vendor, board.model].filter(Boolean).join(' '));
    } else {
      panelRow(box, 'Материнская плата', (hw && hw.boardModel) || '');
    }
    panelRow(box, 'Сокет', (board && board.socket) || (hw && hw.socket) || '');
    if (hw && hw.ram) {
      const ram = hw.ram;
      const slots = ram.slots !== undefined && ram.slots !== null
        ? (ram.usedSlots !== undefined && ram.usedSlots !== null ? ram.usedSlots + '/' + ram.slots + ' слотов' : ram.slots + ' слотов')
        : '';
      panelRow(box, 'ОЗУ', [ram.totalGb !== undefined && ram.totalGb !== null ? ram.totalGb + ' ГБ' : '', ram.type || '', slots].filter(Boolean).join(' · ') || part('ram').have);
    } else {
      panelRow(box, 'ОЗУ', part('ram').have);
    }
    if (hw && hw.disk) {
      const d = hw.disk;
      // Если накопителей несколько — показываем состав: системный SSD и
      // диск для данных часто разные, и износ у них тоже разный.
      if (Array.isArray(hw.disks) && hw.disks.length > 1) {
        const parts = hw.disks.map((x) => [x.media ? String(x.media).toUpperCase() : '', x.sizeGb ? x.sizeGb + ' ГБ' : ''].filter(Boolean).join(' ')).filter(Boolean);
        panelRow(box, 'Накопители', parts.join(' + '));
      }
      panelRow(box, 'Накопитель', [d.type ? String(d.type).toUpperCase() : '', d.sizeGb !== undefined && d.sizeGb !== null ? d.sizeGb + ' ГБ' : '', d.freeGb !== undefined && d.freeGb !== null ? 'свободно ' + d.freeGb + ' ГБ' : ''].filter(Boolean).join(' · ') || part('disk').have);
    } else {
      panelRow(box, 'Накопитель', part('disk').have);
    }
    // Ресурс накопителя: износ в процентах, часы работы, температура.
    // SSD с износом >80% пора менять, пока он не ушёл в read-only.
    const dh = hw && hw.diskHealth;
    if (dh) {
      const wear = dh.wearPct !== undefined && dh.wearPct !== null ? Number(dh.wearPct) : null;
      const bits = [];
      if (wear !== null) bits.push('износ ' + wear + '%');
      if (dh.hours !== undefined && dh.hours !== null) bits.push(dh.hours + ' ч');
      if (dh.temperatureC !== undefined && dh.temperatureC !== null) bits.push(dh.temperatureC + ' °C');
      if (dh.status) bits.push(dh.status);
      if (bits.length) panelRow(box, 'Ресурс диска', bits.join(' · '));
    }
    // Блок питания: модель/мощность из SMBIOS (часто пусто), ресурс — оценка
    // по часам работы и возрасту машины: у БП нет своей телеметрии износа.
    const psu = hw && hw.psu;
    if (psu && (psu.model || psu.maxW || psu.wearPct !== null && psu.wearPct !== undefined)) {
      const bits = [];
      if (psu.model) bits.push(psu.model);
      if (psu.maxW) bits.push(psu.maxW + ' Вт');
      if (psu.ageYears !== null && psu.ageYears !== undefined) bits.push(psu.ageYears + ' г.');
      if (psu.wearPct !== null && psu.wearPct !== undefined) bits.push('ресурс ~' + psu.wearPct + '%');
      panelRow(box, 'Блок питания', bits.join(' · '));
    }
    if (hw && hw.gpu) {
      panelRow(box, 'Видео', [hw.gpu.model || '', hw.gpu.vramGb ? hw.gpu.vramGb + ' ГБ VRAM' : ''].filter(Boolean).join(' · ') || part('gpu').have);
    } else {
      panelRow(box, 'Видео', part('gpu').have);
    }
    panelRow(box, 'Мониторы', monitorText(hw));
    if (hw && hw.os) {
      panelRow(box, 'ОС', [hw.os.name || '', hw.os.build || ''].filter(Boolean).join(' · ') || part('os').have);
    } else {
      panelRow(box, 'ОС', part('os').have);
    }
    if (hw && Array.isArray(hw.notes) && hw.notes.length) {
      for (const n of hw.notes) {
        if (n) box.appendChild(el('div', 'pcpanel__note', '— ' + String(n)));
      }
    }
    return box;
  }

  function monitorText(hw) {
    if (!hw) return '';
    const list = hw.monitors || hw.MONITORS;
    if (Array.isArray(list) && list.length) {
      return list.map((m) => (m && (m.model || m.vendor)) ? String(m.model || m.vendor) : '').filter(Boolean).join(', ');
    }
    return '';
  }

  // Панель «Безопасность»: антивирус, файрвол, обновления, драйверы.
  function secPanel(pc) {
    const box = panelShell('Безопасность');
    const av = (pc.avOn || []).filter(Boolean);
    panelRow(box, 'Антивирус', av.length ? av.join(' + ') : (pc.online ? 'нет данных' : 'машина не в сети'));
    const fwIssue = (pc.issues || []).find((i) => /фаервол/i.test(i));
    panelRow(box, 'Файрвол', fwIssue ? 'выключен' : (pc.online ? 'включён' : ''), fwIssue ? 'bad' : null);
    const upd = metricValue(pc, 'Обновления');
    panelRow(box, 'Обновления', upd);
    const drv = metricValue(pc, 'Драйверы');
    panelRow(box, 'Драйверы', drv);
    const issues = pc.issues || [];
    panelRow(box, 'Проблемы', issues.length ? issues.length + ' ' + plural(issues.length, 'запись', 'записи', 'записей') : 'нет', issues.length ? 'warn' : null);
    if (issues.length) {
      const ul = el('ul', 'pcpanel__list');
      for (const i of issues) ul.appendChild(el('li', null, i));
      box.appendChild(ul);
    }
    return box;
  }

  function metricValue(pc, label) {
    const m = (pc.metrics || []).find((x) => x && x.label === label);
    return m ? m.value : '';
  }

  // Панель «ЭЦП / КриптоПро». Данных пока нет: расширенный сборщик (BOARD_MODEL,
  // CRYPTO_PRO, CERTIFICATES) ещё не отдаёт их на сервер.
  function cryptoPanel(pc) {
    const box = panelShell('ЭЦП / КриптоПро');
    const hw = hwFor(pc);
    const crypto = (hw && (hw.cryptoPro || hw.CRYPTO_PRO)) || null;
    panelRow(box, 'Версия', crypto && crypto.version);
    panelRow(box, 'Лицензия', crypto && (crypto.licenseUntil
      ? crypto.license + ' до ' + crypto.licenseUntil
      : crypto.license));
    const certs = (hw && (hw.certificates || hw.CERTIFICATES)) || null;
    panelRow(box, 'Ближайший сертификат', certs && certs.notAfter ? certs.notAfter : certs);
    box.appendChild(el('div', 'pcpanel__note', 'Данные по ЭЦП придут с расширенным сборщиком аудита'));
    return box;
  }

  // Железо карточки: /api/fleet уже отдаёт hw (плата, диск, БП), реестр —
  // запасной источник, если карточка пришла без профиля.
  function hwFor(pc) {
    if (pc && pc.hw && typeof pc.hw === 'object') return pc.hw;
    const reg = state.registry && (state.registry.pcs || []).find((p) => p.id === pc.id);
    return (reg && reg.hw) || null;
  }

  function analysisParts(pc) {
    const entry = analysisCache.get(pc.id);
    if (!entry || !entry.ok || !entry.data || !Array.isArray(entry.data.parts)) return [];
    return entry.data.parts;
  }

  // ---------- блок КПД (общий для карточки и окон) ----------
  function fillKpd(box, entry, limit) {
    box.textContent = '';
    if (!entry || !entry.ok || !entry.data) {
      box.appendChild(el('div', 'pcedit-kpd__none', 'КПД: нет данных'));
      return;
    }
    fillKpdContent(box, entry.data, limit);
  }

  function fillKpdContent(box, a, limit) {
    const score = Number(a && a.score);
    const hasScore = Number.isFinite(score);
    const head = el('div', 'pcedit-kpd__head');
    head.appendChild(el('span', 'pcedit-kpd__label', 'КПД'));
    head.appendChild(el('span', 'pcedit-kpd__score', hasScore ? String(Math.round(score)) : '—'));
    box.appendChild(head);
    const bar = el('div', 'pcedit-kpd__bar');
    const fill = el('i');
    fill.style.width = (hasScore ? Math.max(0, Math.min(100, score)) : 0) + '%';
    bar.appendChild(fill);
    box.appendChild(bar);
    if (a && a.grade) box.appendChild(el('div', 'pcedit-kpd__grade', String(a.grade)));
    const recs = (a && a.recommendations) || [];
    if (recs.length) {
      const ul = el('ul', 'pcedit-kpd__recs');
      let n = 0;
      for (const r of recs) {
        if (limit && n >= limit) break;
        n++;
        const li = el('li', null, String((r && r.action) || ''));
        // Ссылки на магазины (Ситилинк / DNS) — приходят с сервера.
        const links = recLinks(r);
        if (links.length) {
          const boxLinks = el('span', 'pccard__links');
          for (const l of links) {
            const a2 = el('a', 'pccard__link', l.label);
            a2.href = l.url;
            a2.target = '_blank';
            a2.rel = 'noopener noreferrer';
            boxLinks.appendChild(a2);
          }
          li.appendChild(boxLinks);
        }
        if (r && r.warning) {
          li.appendChild(el('span', 'pccard__warn', String(r.warning)));
        }
        if (r && r.gain !== undefined && r.gain !== null) {
          li.appendChild(el('span', 'pcedit-kpd__gain', ` +${r.gain} балл.`));
        }
        ul.appendChild(li);
      }
      box.appendChild(ul);
      if (limit && recs.length > limit) {
        box.appendChild(el('div', 'pcedit-kpd__more', `ещё ${recs.length - limit} рекомендаций — в окне правки`));
      }
    }
  }

  // ---------- чат по машине ----------
  const HW_LABELS = {
    'hw.cpu.model': 'CPU', 'hw.cpu.cores': 'Ядра CPU', 'hw.cpu.threads': 'Потоки CPU', 'hw.cpu.year': 'Год CPU',
    'hw.ram.totalGb': 'ОЗУ', 'hw.ram.slots': 'Слоты ОЗУ', 'hw.ram.usedSlots': 'Занято слотов', 'hw.ram.type': 'Тип ОЗУ',
    'hw.disk.type': 'Тип диска', 'hw.disk.sizeGb': 'Объём диска', 'hw.disk.freeGb': 'Свободно на диске',
    'hw.gpu.model': 'Видео', 'hw.gpu.vramGb': 'Видеопамять',
    'hw.os.name': 'ОС', 'hw.os.build': 'Сборка ОС',
  };
  const HW_UNITS = {
    'hw.cpu.cores': ' яд.', 'hw.cpu.threads': ' пот.', 'hw.cpu.year': ' г.',
    'hw.ram.totalGb': ' ГБ', 'hw.ram.slots': ' слотов', 'hw.ram.usedSlots': ' слотов',
    'hw.disk.sizeGb': ' ГБ', 'hw.disk.freeGb': ' ГБ', 'hw.gpu.vramGb': ' ГБ',
  };

  // Текущая конфигурация машины — компактными строками.
  function renderHwLines(hw, box) {
    box.textContent = '';
    if (!hw || typeof hw !== 'object') {
      box.appendChild(el('div', 'pcchat__cfgrow pcchat__cfgrow--muted', 'Конфигурация неизвестна'));
      return;
    }
    const rows = [];
    const cpu = hw.cpu || {};
    if (cpu.model || cpu.cores) {
      rows.push(['CPU', [cpu.model, cpu.cores ? cpu.cores + ' ядра' : '', cpu.year ? cpu.year + ' г.' : ''].filter(Boolean).join(' · ')]);
    }
    const ram = hw.ram || {};
    if (ram.totalGb !== undefined || ram.type) {
      const slots = ram.slots !== undefined
        ? (ram.usedSlots !== undefined ? ram.usedSlots + '/' + ram.slots + ' слотов' : ram.slots + ' слотов')
        : '';
      rows.push(['ОЗУ', [ram.totalGb !== undefined ? ram.totalGb + ' ГБ' : '', ram.type || '', slots].filter(Boolean).join(' · ')]);
    }
    const disk = hw.disk || {};
    if (disk.type || disk.sizeGb !== undefined) {
      rows.push(['Диск', [disk.type ? String(disk.type).toUpperCase() : '',
        disk.sizeGb !== undefined ? disk.sizeGb + ' ГБ' : '',
        disk.freeGb !== undefined ? 'свободно ' + disk.freeGb + ' ГБ' : ''].filter(Boolean).join(' · ')]);
    }
    const gpu = hw.gpu || {};
    if (gpu.model || gpu.vramGb !== undefined) {
      rows.push(['Видео', [gpu.model || '', gpu.vramGb ? gpu.vramGb + ' ГБ VRAM' : ''].filter(Boolean).join(' · ')]);
    }
    const os = hw.os || {};
    if (os.name || os.build) rows.push(['ОС', [os.name || '', os.build || ''].filter(Boolean).join(' · ')]);
    if (!rows.length) {
      box.appendChild(el('div', 'pcchat__cfgrow pcchat__cfgrow--muted', 'Данных о железе нет'));
    }
    for (const [k, v] of rows) {
      const row = el('div', 'pcchat__cfgrow');
      row.appendChild(el('span', 'pcchat__cfgkey', k));
      row.appendChild(el('span', 'pcchat__cfgval', v));
      box.appendChild(row);
    }
    if (Array.isArray(hw.notes)) {
      for (const n of hw.notes) {
        if (n) box.appendChild(el('div', 'pcchat__cfgnote', '— ' + String(n)));
      }
    }
  }

  // Список применённых изменений: «ОЗУ: 8 → 16 ГБ».
  function changesBlock(changes) {
    const box = el('div', 'pcchat__changes');
    box.appendChild(el('div', 'pcchat__changes__title', 'Применённые изменения'));
    for (const c of changes) {
      const path = String((c && c.path) || '');
      const label = HW_LABELS[path] || path || 'параметр';
      const unit = HW_UNITS[path] || '';
      const from = c && c.from !== undefined && c.from !== null ? String(c.from) : '—';
      const to = c && c.to !== undefined && c.to !== null ? String(c.to) : '—';
      const row = el('div', 'pcchat__change');
      row.appendChild(el('span', 'pcchat__change__label', label));
      row.appendChild(el('span', 'pcchat__change__val', from + ' → ' + to + unit));
      box.appendChild(row);
    }
    return box;
  }

  function scrollLog(log) {
    log.scrollTop = log.scrollHeight;
  }

  function openChat(pcId) {
    const rec = pcRecord(pcId);
    const title = 'Чат по машине · ' + (rec.person || rec.hostname || pcId);

    const body = el('div', 'pcchat');

    const cfg = el('div', 'pcchat__cfg');
    body.appendChild(cfg);
    renderHwLines(rec.hw, cfg);

    const kpd = el('div', 'pcedit-kpd');
    body.appendChild(kpd);
    const cached = analysisCache.get(pcId);
    if (cached) fillKpd(kpd, cached);
    else {
      kpd.appendChild(el('div', 'pcedit-kpd__none', 'КПД: считаю…'));
      requestAnalysis(pcId).then((entry) => {
        if (kpd.isConnected) fillKpd(kpd, entry);
      });
    }

    const log = el('div', 'pcchat__log');
    body.appendChild(log);
    log.appendChild(el('div', 'pcchat__hint',
      'Напишите, что изменилось на машине (например: «добавил слот ОЗУ, теперь 16 ГБ») — ассистент обновит конфигурацию и пересчитает КПД.'));

    const form = el('form', 'pcchat__form');
    const input = el('textarea', 'pcchat__input');
    input.rows = 2;
    input.placeholder = 'Сообщение ассистенту…';
    input.setAttribute('aria-label', 'Сообщение ассистенту');
    const send = el('button', 'ghostbtn pcedit-btn--primary', 'Отправить');
    send.type = 'submit';
    form.appendChild(input);
    form.appendChild(send);
    body.appendChild(form);

    form.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    const foot = modal.show({ title, body, focus: input });
    const closeBtn = el('button', 'ghostbtn', 'Закрыть');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => { modal.close(); });
    foot.appendChild(closeBtn);

    async function sendMessage() {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      send.disabled = true;
      send.dataset.busy = '1';
      log.appendChild(el('div', 'pcchat__msg pcchat__msg--user', text));
      const busy = el('div', 'pcchat__msg pcchat__msg--busy', 'Ассистент думает…');
      log.appendChild(busy);
      scrollLog(log);
      try {
        const data = await apiSend('POST', 'api/fleet/pcs/' + encodeURIComponent(pcId) + '/chat', { message: text });
        busy.remove();
        const reply = data && data.reply ? String(data.reply) : '';
        const changes = data && Array.isArray(data.changes) ? data.changes : [];
        if (reply) log.appendChild(el('div', 'pcchat__msg pcchat__msg--bot', reply));
        if (changes.length) log.appendChild(changesBlock(changes));
        if (!reply && !changes.length) {
          log.appendChild(el('div', 'pcchat__msg pcchat__msg--bot',
            'Сервер принял сообщение, но не вернул ни ответа, ни изменений.'));
        }
        if (data && data.hw) renderHwLines(data.hw, cfg);
        if (data && data.analysis) {
          analysisCache.set(pcId, { ok: true, data: data.analysis, at: Date.now() });
          fillKpd(kpd, analysisCache.get(pcId));
          refreshCardKpd(pcId);
          renderSection();
        }
      } catch (e) {
        busy.remove();
        log.appendChild(el('div', 'pcchat__msg pcchat__msg--err',
          'Сообщение не отправлено: ' + (e && e.message ? e.message : String(e))));
      } finally {
        send.disabled = false;
        send.dataset.busy = '0';
        scrollLog(log);
      }
    }
  }

  // ---------- реестр парка (редактор карточек) ----------
  // Полный реестр: GET /api/fleet/registry → { orgs, pcs }. Нужен редактору
  // (список организаций, полные записи с hw/notes). Если эндпоинт недоступен,
  // работаем на данных /api/fleet (там тоже есть orgs).
  async function loadRegistry(force) {
    if (state.registry && !force) return state.registry;
    // Если эндпоинта реестра на сервере нет, не долбим его на каждое открытие
    // окна правки: организации берём из /api/fleet.
    if (state.registryMissing && !force) return null;
    try {
      const data = await apiSend('GET', 'api/fleet/registry');
      if (data && Array.isArray(data.pcs)) {
        state.registry = data;
        state.registryMissing = false;
      } else {
        state.registryMissing = true;
      }
    } catch (e) {
      state.registryMissing = true;
    }
    return state.registry;
  }

  // Полная запись машины: реестр (если есть) поверх данных списка парка.
  function pcRecord(id) {
    const reg = state.registry && (state.registry.pcs || []).find((p) => p.id === id);
    const fl = state.fleet && (state.fleet.pcs || []).find((p) => p.id === id);
    return Object.assign({}, fl || {}, reg || {});
  }

  function orgOptions() {
    const src = (state.registry && state.registry.orgs) || (state.fleet && state.fleet.orgs) || {};
    return Object.keys(src).map((id) => ({
      id,
      label: (src[id] && (src[id].short || src[id].name)) || id,
    }));
  }

  // ---------- КПД: балл, вердикт, рекомендации ----------
  function requestAnalysis(id, force) {
    const hit = analysisCache.get(id);
    if (hit && !force && hit.at && Date.now() - hit.at < ANALYSIS_TTL_MS) {
      return Promise.resolve(hit);
    }
    const inflight = analysisInflight.get(id);
    if (inflight) return inflight;
    const p = apiSend('GET', 'api/fleet/pcs/' + encodeURIComponent(id) + '/analysis')
      .then((data) => {
        const ok = !!(data && (data.score !== undefined || Array.isArray(data.parts)));
        const entry = { ok, data: ok ? data : null, at: Date.now() };
        analysisCache.set(id, entry);
        return entry;
      })
      .catch(() => {
        const entry = { ok: false, data: null, at: Date.now() };
        analysisCache.set(id, entry);
        return entry;
      })
      .then((entry) => {
        analysisInflight.delete(id);
        return entry;
      });
    analysisInflight.set(id, p);
    return p;
  }

  // Фоновый пересчёт баллов для всех машин парка: нужны для плиток обзора
  // и отчёта. Запросы идут пачками по 4, чтобы не забить сервер.
  async function prefetchAnalyses() {
    const ids = fleetPcs().map((p) => p.id);
    if (!ids.length) return;
    const queue = ids.filter((id) => {
      const hit = analysisCache.get(id);
      return !(hit && hit.at && Date.now() - hit.at < ANALYSIS_TTL_MS);
    });
    if (!queue.length) return;
    const workers = [];
    for (let i = 0; i < 4; i++) {
      workers.push((async () => {
        while (queue.length) {
          const id = queue.shift();
          await requestAnalysis(id, true);
        }
      })());
    }
    await Promise.all(workers);
    if (state.status) {
      renderChrome();
      renderSection();
    }
  }

  // Обновить блок КПД на карточке после чата (оценка могла измениться).
  function refreshCardKpd(id) {
    const entry = analysisCache.get(id);
    if (!entry) return;
    const boxes = document.querySelectorAll('.pcedit-kpd--compact');
    for (const b of boxes) {
      if (b.dataset.pc === id) fillKpd(b, entry, 3);
    }
  }

  // ---------- модальное окно ----------
  // Одно окно на всё: правка карточки, чат, задачи. Esc закрывает, Tab не
  // выпускает фокус наружу, фокус возвращается на кнопку-инициатор.
  const modal = (() => {
    let root = null, box = null, titleEl = null, bodyEl = null, footEl = null, errEl = null;
    let opened = false, lastFocus = null;

    function ensure() {
      if (root) return;
      root = el('div', 'pcedit-modal');
      root.hidden = true;
      const back = el('div', 'pcedit-modal__back');
      back.addEventListener('click', () => close());
      box = el('div', 'pcedit-modal__box');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');
      box.setAttribute('aria-labelledby', 'pcedit-modal-title');
      box.tabIndex = -1;
      const head = el('div', 'pcedit-modal__head');
      titleEl = el('h2', 'pcedit-modal__title');
      titleEl.id = 'pcedit-modal-title';
      const closeBtn = el('button', 'pcedit-modal__close', '×');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', 'Закрыть окно');
      closeBtn.addEventListener('click', () => close());
      head.appendChild(titleEl);
      head.appendChild(closeBtn);
      bodyEl = el('div', 'pcedit-modal__body');
      errEl = el('div', 'pcedit-modal__err');
      errEl.hidden = true;
      errEl.setAttribute('role', 'alert');
      footEl = el('div', 'pcedit-modal__foot');
      box.appendChild(head);
      box.appendChild(bodyEl);
      box.appendChild(errEl);
      box.appendChild(footEl);
      root.appendChild(back);
      root.appendChild(box);
      document.body.appendChild(root);
      document.addEventListener('keydown', onKey, true);
    }

    function focusables() {
      const sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
      return Array.from(box.querySelectorAll(sel)).filter((n) => n.getClientRects().length > 0);
    }

    function onKey(e) {
      if (!opened) return;
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !box.contains(active)) { e.preventDefault(); last.focus(); }
      } else if (active === last || !box.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    }

    function show(opts) {
      ensure();
      lastFocus = document.activeElement;
      titleEl.textContent = opts.title || '';
      bodyEl.textContent = '';
      footEl.textContent = '';
      setError('');
      opened = true;
      root.hidden = false;
      root.dataset.open = '1';
      document.body.classList.add('modal-open');
      if (opts.body) bodyEl.appendChild(opts.body);
      const target = (opts.focus && bodyEl.contains(opts.focus) ? opts.focus : null)
        || bodyEl.querySelector('input:not([disabled]), select:not([disabled]), textarea:not([disabled])')
        || focusables()[0];
      if (target) target.focus();
      else box.focus();
      return footEl;
    }

    function setError(text) {
      if (!errEl) return;
      errEl.textContent = text || '';
      errEl.hidden = !text;
    }

    function close() {
      if (!root || !opened) return;
      opened = false;
      root.hidden = true;
      root.dataset.open = '0';
      document.body.classList.remove('modal-open');
      bodyEl.textContent = '';
      footEl.textContent = '';
      setError('');
      if (lastFocus && document.contains(lastFocus)) {
        try { lastFocus.focus(); } catch (e) { /* элемент исчез */ }
      }
      lastFocus = null;
    }

    return {
      show,
      close,
      error: setError,
      isOpen: () => opened,
    };
  })();

  // ---------- правка карточки ПК ----------
  function editorFields(rec) {
    const orgs = orgOptions();
    // Компания машины: companyId (новое поле). org — старый идентификатор
    // организации, оставшийся в части карточек. companyId приоритетнее:
    // иначе правка «организации» меняла одно поле, а группировка парка шла
    // по другому — и машина оставалась в прежней компании.
    const orgValue = rec.companyId || rec.org || (orgs.length ? orgs[0].id : '');
    if (orgValue && !orgs.some((o) => o.id === orgValue)) orgs.push({ id: orgValue, label: orgValue });
    const kinds = [
      { id: 'pc', label: 'ПК' },
      { id: 'laptop', label: 'Ноутбук' },
      { id: 'server', label: 'Сервер' },
    ];
    const kindValue = rec.kind || 'pc';
    if (!kinds.some((k) => k.id === kindValue)) kinds.push({ id: kindValue, label: kindValue });
    // Филиал: список по выбранной компании.
    const company = companyMeta(orgValue);
    const branchOptions = (company.branches || []).map((b) => ({ id: b.id, label: b.name || b.id }));
    const branchValue = rec.branchId || '';
    if (branchValue && !branchOptions.some((b) => b.id === branchValue)) {
      branchOptions.push({ id: branchValue, label: branchValue });
    }
    return [
      { key: 'person', label: 'ФИО', required: true, value: rec.person || '' },
      { key: 'role', label: 'Должность', value: rec.role || '' },
      { key: 'unit', label: 'Подразделение', value: rec.unit || '' },
      { key: 'companyId', label: 'Компания', options: orgs, value: orgValue },
      { key: 'branchId', label: 'Филиал', options: branchOptions, value: branchValue },
      { key: 'hostname', label: 'Имя хоста', value: rec.hostname || '' },
      { key: 'ip', label: 'IP-адрес', value: rec.ip || '' },
      { key: 'kind', label: 'Тип', options: kinds, value: kindValue },
    ];
  }

  async function openEditor(pcId) {
    await loadRegistry(false);
    const creating = !pcId;
    const rec = pcId ? pcRecord(pcId) : {};
    const title = creating
      ? 'Новый ПК'
      : ('Правка карточки · ' + (rec.person || rec.hostname || pcId));

    const body = el('div');
    const form = el('div', 'pcedit-form');
    const inputs = {};
    for (const f of editorFields(rec)) {
      const wrap = el('label', 'pcedit-field');
      wrap.appendChild(el('span', 'pcedit-field__label', f.label + (f.required ? ' *' : '')));
      let input;
      if (f.options) {
        input = el('select', 'pcedit-field__input');
        for (const opt of f.options) {
          const o = el('option', null, opt.label);
          o.value = opt.id;
          input.appendChild(o);
        }
      } else {
        input = el('input', 'pcedit-field__input');
        input.type = 'text';
        input.autocomplete = 'off';
      }
      input.name = f.key;
      input.value = f.value == null ? '' : String(f.value);
      inputs[f.key] = input;
      wrap.appendChild(input);
      form.appendChild(wrap);
    }
    body.appendChild(form);

    // КПД по редактируемой машине: тот же блок, что на карточке.
    if (!creating) {
      const kpd = el('div', 'pcedit-kpd pcedit-kpd--modal');
      body.appendChild(kpd);
      const cached = analysisCache.get(pcId);
      if (cached) fillKpd(kpd, cached);
      else {
        kpd.appendChild(el('div', 'pcedit-kpd__none', 'КПД: считаю…'));
        requestAnalysis(pcId).then((entry) => {
          if (kpd.isConnected) fillKpd(kpd, entry);
        });
      }
    }

    const foot = modal.show({ title, body, focus: inputs.person });

    if (!creating) {
      const del = el('button', 'ghostbtn pcedit-btn--danger', 'Удалить');
      del.type = 'button';
      foot.appendChild(del);
      del.addEventListener('click', () => { deletePc(pcId, rec, del); });
    }
    const cancel = el('button', 'ghostbtn', 'Отмена');
    cancel.type = 'button';
    foot.appendChild(cancel);
    cancel.addEventListener('click', () => { modal.close(); });
    const save = el('button', 'ghostbtn pcedit-btn--primary', creating ? 'Создать' : 'Сохранить');
    save.type = 'button';
    foot.appendChild(save);
    save.addEventListener('click', () => { savePc(pcId, inputs, save, creating); });
  }

  async function savePc(pcId, inputs, btn, creating) {
    const payload = {
      person: inputs.person.value.trim(),
      role: inputs.role.value.trim(),
      unit: inputs.unit.value.trim(),
      // Компания и филиал — по companyId/branchId (группировка парка и
      // область видимости админов считают именно их).
      companyId: inputs.companyId.value,
      branchId: inputs.branchId.value,
      hostname: inputs.hostname.value.trim(),
      ip: inputs.ip.value.trim(),
      kind: inputs.kind.value,
    };
    if (!payload.person) {
      modal.error('Укажите ФИО — без него карточку не создать.');
      inputs.person.focus();
      return;
    }
    btn.disabled = true;
    btn.dataset.busy = '1';
    try {
      if (creating) {
        const created = await apiSend('POST', 'api/fleet/pcs', payload);
        if (created && created.id) analysisCache.delete(created.id);
        modal.close();
        toast('Карточка создана');
      } else {
        await apiSend('PUT', 'api/fleet/pcs/' + encodeURIComponent(pcId), payload);
        analysisCache.delete(pcId);
        modal.close();
        toast('Карточка сохранена');
      }
      await afterMutation();
    } catch (e) {
      modal.error(e && e.message ? e.message : String(e));
      btn.disabled = false;
      btn.dataset.busy = '0';
    }
  }

  // Удаление из карточки: та же операция, без модалки редактора.
  async function deletePcFromCard(pc) {
    try {
      await apiSend('DELETE', 'api/fleet/pcs/' + encodeURIComponent(pc.id));
      analysisCache.delete(pc.id);
      toast('Карточка удалена: ' + (pc.person || pc.hostname || pc.ip));
      await afterMutation();
    } catch (e) {
      toast('Не удалось удалить: ' + (e && e.message ? e.message : String(e)));
    }
  }

  // Разбор ПК: сервер переносит комплектующие на склад и убирает карточку.
  async function stripPcToWarehouse(pc) {
    try {
      const r = await apiSend('POST', 'api/fleet/pcs/' + encodeURIComponent(pc.id) + '/strip');
      const n = r && Array.isArray(r.moved) ? r.moved.length : 0;
      analysisCache.delete(pc.id);
      toast('Разобрано: ' + n + ' поз. на складе' + (r && r.deleted ? ', карточка удалена' : ''));
      await afterMutation();
      if (typeof reloadParts === 'function') await reloadParts();
    } catch (e) {
      toast('Не удалось разобрать: ' + (e && e.message ? e.message : String(e)));
    }
  }

  async function deletePc(pcId, rec, btn) {
    const name = rec.person || rec.hostname || pcId;
    if (!window.confirm('Удалить карточку «' + name + '»? Действие необратимо.')) return;
    btn.disabled = true;
    btn.dataset.busy = '1';
    try {
      await apiSend('DELETE', 'api/fleet/pcs/' + encodeURIComponent(pcId));
      analysisCache.delete(pcId);
      modal.close();
      toast('Карточка удалена');
      await afterMutation();
    } catch (e) {
      modal.error(e && e.message ? e.message : String(e));
      btn.disabled = false;
      btn.dataset.busy = '0';
    }
  }

  // После мутации: обновляем данные с сервера и перерисовываем текущий раздел.
  // Страницу не перезагружаем.
  async function afterMutation() {
    await Promise.all([loadAll(false), loadRegistry(true)]);
    renderSection();
  }

  // ---------- задачи по машине ----------
  // Эндпоинт POST /api/pcs/:id/actions появится вместе с API v3. Пока его
  // нет — показываем список действий и честно говорим, что сервер их ещё
  // не выполняет.
  const TASK_TYPES = [
    { id: 'diagnostics', title: 'Диагностика', desc: 'Собрать отчёт о состоянии: диск, память, события, драйверы' },
    { id: 'disk_cleanup', title: 'Очистка диска', desc: 'Почистить временные файлы и кэш, вернуть свободное место' },
    { id: 'update_drivers', title: 'Обновить драйверы', desc: 'Установить доступные драйверы из Windows Update' },
    { id: 'install_software', title: 'Установить программу', desc: 'Установка из подготовленного локального каталога' },
    { id: 'reboot', title: 'Перезагрузка', desc: 'Требует подтверждения и прав администратора компании' },
  ];

  function openTask(pcId) {
    const rec = pcRecord(pcId);
    const body = el('div', 'tasklist');
    const note = el('p', 'tasklist__note',
      'Задачи выполняет агент на машине. Серверный эндпоинт /api/pcs/:id/actions ещё не выложен — запуск станет доступен после выкладки API v3.');
    body.appendChild(note);
    for (const t of TASK_TYPES) {
      const row = el('div', 'taskrow');
      const txt = el('div', 'taskrow__txt');
      txt.appendChild(el('div', 'taskrow__t', t.title));
      txt.appendChild(el('div', 'taskrow__d', t.desc));
      row.appendChild(txt);
      const btn = el('button', 'ghostbtn', 'запустить');
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.dataset.busy = '1';
        try {
          const res = await apiSend('POST', 'api/pcs/' + encodeURIComponent(pcId) + '/actions', { type: t.id, args: {} });
          modal.error('');
          toast('Задача поставлена в очередь: ' + (res.jobId || t.id));
        } catch (e) {
          const msg = e && e.message ? e.message : String(e);
          modal.error('Задача не запущена: ' + msg);
        } finally {
          btn.disabled = false;
          btn.dataset.busy = '0';
        }
      });
      row.appendChild(btn);
      body.appendChild(row);
    }
    const foot = modal.show({
      title: 'Задачи по машине · ' + (rec.person || rec.hostname || pcId),
      body,
    });
    const closeBtn = el('button', 'ghostbtn', 'Закрыть');
    closeBtn.type = 'button';
    closeBtn.addEventListener('click', () => { modal.close(); });
    foot.appendChild(closeBtn);
  }

  // ---------- склад и задачи: заглушки разделов ----------
  const PART_TYPES = {
    ram: 'ОЗУ', ssd: 'SSD', hdd: 'HDD', cpu: 'CPU', board: 'Материнская плата',
    gpu: 'Видеокарта', psu: 'БП', monitor: 'Монитор', case: 'Корпус', other: 'Прочее',
  };

  let partsData = null;   // null — ещё не запрашивали; {items: []} — пусто
  let partsFailed = false;

  async function loadParts() {
    if (partsData || partsFailed) return;
    try {
      const data = await apiSend('GET', 'api/parts');
      partsData = { items: Array.isArray(data.items) ? data.items : [] };
    } catch (e) {
      partsFailed = true;
      const note = $('#wh-note');
      if (note) note.textContent = 'Складской API (GET /api/parts) недоступен на сервере — раздел заработает после выкладки API v3.';
    }
    renderWarehouse();
  }

  function renderWarehouse() {
    const box = $('#wh-list');
    if (!box) return;
    box.textContent = '';
    const note = $('#wh-note');
    const badge = $('#nav-warehouse .navitem__soon');

    if (partsData) {
    if (badge) badge.textContent = partsData.items.length ? 'β' : 'пусто';

    // Панель действий: добавить позицию склада.
    const whTools = el('div', 'section__tools');
    const whAdd = el('button', 'ghostbtn pcedit-btn--primary', '+ Добавить позицию');
    whAdd.type = 'button';
    whAdd.addEventListener('click', () => openPartEditor(null));
    whTools.appendChild(whAdd);
    box.appendChild(whTools);
      if (!partsData.items.length) {
        box.appendChild(el('div', 'empty', 'Склад пуст: ни одной позиции не заведено'));
        if (note) note.textContent = 'Складской API отвечает (GET /api/parts), но данных пока нет. Позиции заводит владелец: тип, производитель, модель, количество.';
        return;
      }
      const table = el('table', 'reptable');
      const thead = el('thead');
      const htr = el('tr');
      for (const c of ['Тип', 'Производитель', 'Модель', 'Характеристики', 'Кол-во', '']) {
        const th = el('th', null, c);
        th.scope = 'col';
        htr.appendChild(th);
      }
      thead.appendChild(htr);
      table.appendChild(thead);
      const tbody = el('tbody');
      for (const it of partsData.items) {
        const tr = el('tr');
        const spec = it.spec && typeof it.spec === 'object'
          ? Object.entries(it.spec).map(([k, v]) => k + ': ' + v).join(', ')
          : '';
        for (const v of [PART_TYPES[it.type] || it.type || '', it.vendor || '', it.model || '', spec, String(it.qty === undefined ? '—' : it.qty)]) {
          tr.appendChild(el('td', null, v));
        }

            // Действия по позиции склада.

            const whTda = el('td', 'wh-actions');

            const whEdit = el('button', 'ghostbtn', 'Изменить');

            whEdit.type = 'button';

            whEdit.addEventListener('click', () => openPartEditor(it));

            const whTake = el('button', 'ghostbtn', 'На ПК');

            whTake.type = 'button';

            whTake.disabled = !(Number(it.qty) > 0);

            whTake.title = whTake.disabled ? 'На складе нет свободных единиц' : 'Списать на компьютер';

            whTake.addEventListener('click', () => takePartToPc(it));

            const whDel = el('button', 'ghostbtn pcedit-btn--danger', 'Удалить');

            whDel.type = 'button';

            whDel.addEventListener('click', () => deletePart(it));

            whTda.appendChild(whEdit);

            whTda.appendChild(whTake);

            whTda.appendChild(whDel);

            tbody.appendChild(tr);
            tr.appendChild(whTda);
      }
      table.appendChild(tbody);
      const wrap = el('div', 'tablewrap');
      wrap.appendChild(table);
      box.appendChild(wrap);
      if (note) note.textContent = 'Данные складского API. Списание на машину и возврат на склад появятся вместе с действиями по ПК.';
      return;
    }

    if (badge) badge.textContent = 'скоро';
    const rows = [
      ['ОЗУ (планки DDR4)', 'остаток комплектующих под замену'],
      ['SSD / HDD', 'свободные накопители и «в работе»'],
      ['Мониторы и периферия', 'под замену списанным'],
      ['Видеокарты, БП, корпуса', 'редкие позиции под заказ'],
    ];
    for (const [t, d] of rows) {
      const row = el('div', 'whrow');
      row.appendChild(el('div', 'whrow__t', t));
      row.appendChild(el('div', 'whrow__d', d));
      row.appendChild(el('span', 'whrow__v', '—'));
      box.appendChild(row);
    }
    if (note && !note.textContent) {
      note.textContent = 'Раздел ждёт выкладки складского API: GET /api/parts, POST /api/parts/:id/take.';
    }
  }

  // ---------- склад: редактор позиции ----------
  function parseSpec(text) {
    const out = {};
    for (const chunk of String(text || '').split(',')) {
      const i = chunk.indexOf('=');
      if (i < 0) continue;
      const k = chunk.slice(0, i).trim();
      const v = chunk.slice(i + 1).trim();
      if (!k) continue;
      const num = Number(v);
      out[k] = (v !== '' && String(num) === v) ? num : v;
    }
    return out;
  }

  function specToText(spec) {
    if (!spec || typeof spec !== 'object') return '';
    return Object.entries(spec).map(([k, v]) => k + '=' + v).join(', ');
  }

  function openPartEditor(item) {
    const creating = !item;
    const body = el('div', 'pcedit-form');
    const inputs = {};

    const addField = (label, key, value, type) => {
      const wrap = el('label', 'pcedit-field');
      wrap.appendChild(el('span', 'pcedit-field__label', label));
      let input;
      if (type === 'select') {
        input = el('select', 'pcedit-field__input');
        for (const [id, name] of Object.entries(PART_TYPES)) {
          const o = el('option', null, name);
          o.value = id;
          input.appendChild(o);
        }
      } else {
        input = el('input', 'pcedit-field__input');
        input.type = type || 'text';
        input.value = value === undefined || value === null ? '' : String(value);
      }
      input.name = key;
      inputs[key] = input;
      wrap.appendChild(input);
      body.appendChild(wrap);
    };

    addField('Тип', 'type', (item && item.type) || 'ram', 'select');
    addField('Производитель', 'vendor', item && item.vendor);
    addField('Модель', 'model', item && item.model);
    addField('Характеристики (ключ=значение через запятую)', 'spec', specToText(item && item.spec));
    addField('Количество', 'qty', item && item.qty !== undefined ? item.qty : 1, 'number');
    addField('Заметки', 'notes', item && item.notes);

    const foot = modal.show({ title: creating ? 'Новая позиция склада' : 'Позиция склада', body, focus: inputs.model });
    const cancel = el('button', 'ghostbtn', 'Отмена');
    cancel.type = 'button';
    cancel.addEventListener('click', () => modal.close());
    foot.appendChild(cancel);
    const save = el('button', 'ghostbtn pcedit-btn--primary', creating ? 'Добавить' : 'Сохранить');
    save.type = 'button';
    foot.appendChild(save);

    save.addEventListener('click', async () => {
      const payload = {
        type: inputs.type.value,
        vendor: inputs.vendor.value.trim(),
        model: inputs.model.value.trim(),
        spec: parseSpec(inputs.spec.value),
        qty: Number(inputs.qty.value) || 0,
        notes: inputs.notes.value.trim(),
      };
      if (!payload.model) { modal.error('Укажите модель.'); inputs.model.focus(); return; }
      save.disabled = true;
      try {
        if (creating) await apiSend('POST', 'api/parts', payload);
        else await apiSend('PUT', 'api/parts/' + encodeURIComponent(item.id), payload);
        modal.close();
        toast(creating ? 'Позиция добавлена' : 'Позиция сохранена');
        await reloadParts();
      } catch (e) {
        modal.error(e && e.message ? e.message : String(e));
        save.disabled = false;
      }
    });
  }

  async function deletePart(item) {
    const name = [item.vendor, item.model].filter(Boolean).join(' ') || item.id;
    if (!window.confirm('Удалить позицию «' + name + '» со склада?')) return;
    try {
      await apiSend('DELETE', 'api/parts/' + encodeURIComponent(item.id));
      toast('Позиция удалена');
      await reloadParts();
    } catch (e) {
      toast(e && e.message ? e.message : String(e));
    }
  }

  async function takePartToPc(item) {
    const pcs = (state.fleet && state.fleet.pcs) || [];
    if (!pcs.length) { toast('Парк не загружен — обновите страницу'); return; }
    const body = el('div', 'pcedit-form');
    const wrapPc = el('label', 'pcedit-field');
    wrapPc.appendChild(el('span', 'pcedit-field__label', 'Компьютер'));
    const sel = el('select', 'pcedit-field__input');
    for (const pc of pcs) {
      const o = el('option', null, (pc.person || pc.hostname || pc.ip) + ' (' + (pc.ip || '—') + ')');
      o.value = pc.id;
      sel.appendChild(o);
    }
    wrapPc.appendChild(sel);
    body.appendChild(wrapPc);
    const wrapQty = el('label', 'pcedit-field');
    wrapQty.appendChild(el('span', 'pcedit-field__label', 'Количество (на складе: ' + item.qty + ')'));
    const qty = el('input', 'pcedit-field__input');
    qty.type = 'number';
    qty.min = '1';
    qty.max = String(item.qty);
    qty.value = '1';
    wrapQty.appendChild(qty);
    body.appendChild(wrapQty);

    const foot = modal.show({ title: 'Списать на компьютер', body, focus: sel });
    const cancel = el('button', 'ghostbtn', 'Отмена');
    cancel.type = 'button';
    cancel.addEventListener('click', () => modal.close());
    foot.appendChild(cancel);
    const ok = el('button', 'ghostbtn pcedit-btn--primary', 'Списать');
    ok.type = 'button';
    foot.appendChild(ok);
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      try {
        await apiSend('POST', 'api/parts/' + encodeURIComponent(item.id) + '/take', {
          pcId: sel.value,
          qty: Number(qty.value) || 1,
        });
        modal.close();
        toast('Списано на компьютер');
        await reloadParts();
      } catch (e) {
        modal.error(e && e.message ? e.message : String(e));
        ok.disabled = false;
      }
    });
  }

  async function reloadParts() {
    partsData = null;
    partsFailed = false;
    await loadParts();
    renderWarehouse();
  }

  function renderTasks() {
    const box = $('#task-list');
    if (!box) return;
    box.textContent = '';
    const rows = [
      ['disk_cleanup', 'чистка диска и кэша'],
      ['diagnostics', 'диагностика: диск, память, события'],
      ['install_software', 'установка программы'],
      ['update_drivers', 'обновление драйверов'],
      ['reboot', 'перезагрузка (с подтверждением)'],
    ];
    for (const [t, d] of rows) {
      const row = el('div', 'whrow');
      row.appendChild(el('div', 'whrow__t', t));
      row.appendChild(el('div', 'whrow__d', d));
      row.appendChild(el('span', 'whrow__v', '—'));
      box.appendChild(row);
    }
    const note = $('#task-note');
    if (note && !note.textContent) {
      note.textContent = 'Раздел ждёт выкладки API задач: POST /api/pcs/:id/actions, GET /api/jobs/:jobId.';
    }
  }

  // Проверка готовности эндпоинта: честно показываем, что сервер ещё не
  // умеет, вместо пустого экрана.
  async function probeEndpoint(path, noteId) {
    const note = $(noteId);
    if (!note) return;
    note.textContent = 'Проверяю ' + path + '…';
    try {
      const res = await apiFetch(path);
      if (res.status === 404) {
        note.textContent = path + ' — эндпоинта ещё нет на сервере (404). Раздел заработает после выкладки API v3.';
      } else if (!res.ok) {
        note.textContent = path + ' — сервер ответил ' + res.status + '.';
      } else {
        note.textContent = path + ' — эндпоинт отвечает. Данные появятся здесь после выкладки API v3.';
      }
    } catch (e) {
      note.textContent = path + ' — сервер недоступен (' + (e && e.message ? e.message : String(e)) + ').';
    }
  }

  // ---------- отчёты ----------
  function reportRows() {
    const pcs = fleetPcs().filter((pc) => state.company === 'all' || pcCompany(pc) === state.company);
    return pcs.slice().sort((a, b) => {
      const d = companyRank(pcCompany(a)) - companyRank(pcCompany(b));
      if (d) return d;
      const db = branchOf(a).localeCompare(branchOf(b), 'ru');
      if (db) return db;
      return String(a.person || a.hostname || '').localeCompare(String(b.person || b.hostname || ''), 'ru');
    });
  }

  function reportCellData(pc) {
    const hw = hwFor(pc);
    const parts = analysisParts(pc);
    const part = (key) => (parts.find((p) => p.key === key) || {});
    const entry = analysisCache.get(pc.id);
    const score = entry && entry.ok && entry.data && typeof entry.data.score === 'number'
      ? Math.round(entry.data.score) : null;
    const recs = entry && entry.ok && entry.data && Array.isArray(entry.data.recommendations)
      ? entry.data.recommendations.slice(0, 2).map((r) => String((r && r.action) || '')).filter(Boolean).join('; ')
      : '';
    const cpu = hw && hw.cpu
      ? [hw.cpu.model, hw.cpu.cores ? hw.cpu.cores + ' ядра' : ''].filter(Boolean).join(', ')
      : String(part('cpu').have || '');
    const ram = hw && hw.ram
      ? [hw.ram.totalGb !== undefined && hw.ram.totalGb !== null ? hw.ram.totalGb + ' ГБ' : '',
        hw.ram.slots ? hw.ram.usedSlots + '/' + hw.ram.slots + ' слотов' : ''].filter(Boolean).join(', ')
      : String(part('ram').have || '');
    const disk = hw && hw.disk
      ? [hw.disk.type ? String(hw.disk.type).toUpperCase() : '', hw.disk.sizeGb ? hw.disk.sizeGb + ' ГБ' : ''].filter(Boolean).join(', ')
      : String(part('disk').have || '');
    const os = hw && hw.os
      ? [hw.os.name || '', hw.os.build || ''].filter(Boolean).join(' ')
      : String(part('os').have || '');
    return {
      score,
      cpu,
      ram,
      disk,
      os,
      free: metricValue(pc, 'Диск C:'),
      upd: metricValue(pc, 'Обновления'),
      drv: metricValue(pc, 'Драйверы'),
      ib: (pc.issues || []).join('; '),
      recs,
    };
  }

  function renderReports() {
    const rows = reportRows();
    const sum = $('#report-summary');
    if (sum) {
      sum.textContent = '';
      const scores = rows.map((pc) => reportCellData(pc).score).filter((v) => v !== null);
      const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
      const problems = rows.filter((pc) => pc.issues && pc.issues.length).length;
      const offline = rows.filter((pc) => !pc.online).length;
      sum.appendChild(tileNum(rows.length, 'машин в отчёте'));
      sum.appendChild(tileNum(avg === null ? '—' : avg, 'средний КПД'));
      sum.appendChild(tileNum(problems, 'с проблемами'));
      sum.appendChild(tileNum(offline, 'не в сети'));
    }

    const table = $('#report-table');
    if (!table) return;
    table.textContent = '';
    const cols = ['Сотрудник', 'Должность', 'Филиал', 'Хост / IP', 'Статус', 'ОС', 'CPU', 'ОЗУ', 'Диск', 'Свободно', 'Обновления', 'Драйверы', 'ИБ', 'КПД', 'Рекомендации'];
    const thead = el('thead');
    const htr = el('tr');
    for (const c of cols) {
      const th = el('th', null, c);
      th.scope = 'col';
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = el('tbody');
    let lastOrg = null;
    for (const pc of rows) {
      const d = reportCellData(pc);
      const tr = el('tr');
      tr.dataset.pc = pc.id;
      const orgId = pcCompany(pc);
      if (orgId !== lastOrg) {
        lastOrg = orgId;
        const head = el('tr', 'reptable__org');
        const th = el('th', null, orgName(orgId));
        th.colSpan = cols.length;
        th.scope = 'colgroup';
        head.appendChild(th);
        tbody.appendChild(head);
      }
      const cells = [
        pc.person || pc.hostname || pc.ip,
        pc.role || '',
        branchOf(pc),
        (pc.hostname || '') + (pc.ip ? ' · ' + pc.ip : ''),
        pcStatusText(pc),
        d.os,
        d.cpu,
        d.ram,
        d.disk,
        d.free,
        d.upd,
        d.drv,
        d.ib,
        d.score === null ? '—' : String(d.score),
        d.recs,
      ];
      cells.forEach((value, i) => {
        const td = el('td', null, value);
        if (i === 0) td.classList.add('reptable__name');
        if (i === 13) td.classList.add('reptable__kpd');
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const date = $('#report-date');
    if (date) {
      date.textContent = 'ИТ-парк КК · ' + new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
        + ' · машин: ' + rows.length;
    }
  }

  // CSV для Excel: разделитель «;», BOM — чтобы кириллица не ломалась.
  function csvEscape(v) {
    const s = String(v === undefined || v === null ? '' : v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function exportCsv() {
    const rows = reportRows();
    const cols = ['Компания', 'Филиал', 'Сотрудник', 'Должность', 'Хост', 'IP', 'Статус', 'ОС', 'CPU', 'ОЗУ', 'Диск', 'Свободно', 'Обновления', 'Драйверы', 'Проблемы ИБ', 'КПД', 'Рекомендации'];
    const lines = [cols.map(csvEscape).join(';')];
    for (const pc of rows) {
      const d = reportCellData(pc);
      lines.push([
        orgName(pcCompany(pc)), branchOf(pc), pc.person || '', pc.role || '',
        pc.hostname || '', pc.ip || '', pcStatusText(pc), d.os, d.cpu, d.ram, d.disk,
        d.free, d.upd, d.drv, d.ib, d.score === null ? '' : d.score, d.recs,
      ].map(csvEscape).join(';'));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = 'it-park-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('CSV выгружен: ' + rows.length + ' строк');
  }

  // ---------- профиль пользователя ----------
  function renderProfile() {
    const user = state.user || USER_STUB;
    const name = $('#profile-name');
    const role = $('#profile-role');
    const ava = $('#profile-ava');
    const login = $('#profile-login');
    if (name) name.textContent = user.name || 'Пользователь';
    if (role) role.textContent = user.role || 'роль не назначена';
    if (ava) {
      const parts = String(user.name || '?').trim().split(/\s+/);
      ava.textContent = ((parts[0] || '')[0] || '' + ((parts[1] || '')[0] || '')).toUpperCase().slice(0, 2) || '?';
    }
    if (login) login.textContent = user.login || '—';

    const comp = $('#profile-company');
    if (comp) {
      comp.textContent = '';
      const all = el('option', null, 'Все компании');
      all.value = 'all';
      comp.appendChild(all);
      for (const c of companyList()) {
        const o = el('option', null, c.short);
        o.value = c.id;
        comp.appendChild(o);
      }
      comp.value = state.company;
    }
    const br = $('#profile-branch');
    if (br) {
      br.textContent = '';
      const all = el('option', null, 'Все филиалы');
      all.value = 'all';
      br.appendChild(all);
      const names = new Set();
      if (state.company === 'all') {
        for (const c of companyList()) for (const b of c.branches) names.add(b.name);
      } else {
        for (const b of companyMeta(state.company).branches) names.add(b.name);
      }
      for (const b of branchList()) names.add(b);
      for (const name of [...names].sort((a, b) => a.localeCompare(b, 'ru'))) {
        const o = el('option', null, name);
        o.value = name;
        br.appendChild(o);
      }
      br.value = state.branch;
    }
  }

  function initProfile() {
    const btn = $('#profile-btn');
    const menu = $('#profile-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) {
        renderProfile();
        loadIdentity();
      }
    });
    document.addEventListener('click', (e) => {
      if (menu.hidden) return;
      if (menu.contains(e.target) || e.target === btn) return;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('keydown', (e) => {
      if (menu.hidden) return;
      if (e.key === 'Escape') {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        btn.focus();
      }
    });
    const comp = $('#profile-company');
    if (comp) {
      comp.addEventListener('change', () => {
        state.company = comp.value;
        state.branch = 'all';
        renderChrome();
        renderSection();
      });
    }
    const br = $('#profile-branch');
    if (br) {
      br.addEventListener('change', () => {
        state.branch = br.value;
        renderChrome();
        renderSection();
      });
    }
  }

  // Профиль и компании: /api/auth/me и /api/companies. Если эндпоинта ещё
  // нет (старая версия сервера) — остаёмся на заглушке.
  let identityTried = false;
  async function loadIdentity() {
    if (identityTried) return;
    identityTried = true;
    try {
      const data = await apiSend('GET', 'api/auth/me');
      if (data && data.user) state.user = data.user;
    } catch (e) { /* заглушка */ }
    try {
      const data = await apiSend('GET', 'api/companies');
      if (data && Array.isArray(data.companies)) state.companies = data;
    } catch (e) { /* заглушка */ }
    renderProfile();
    if (state.status) {
      renderChrome();
      renderSection();
    }
  }

  // ---------- переходы ----------
  function go(section) {
    state.section = section;
    showSection();
    renderChrome();
    renderSection();
    if (section === 'warehouse') loadParts();
    window.scrollTo(0, 0);
  }

  // Переход к карточке машины из «Топ проблем»: открываем парк, раскрываем
  // нужную группу и подсвечиваем карточку.
  function jumpToPc(pcId) {
    if (!pcId) return;
    state.section = 'fleet';
    state.company = 'all';
    state.branch = 'all';
    state.statusFilter = 'all';
    state.issuesOnly = false;
    state.query = '';
    const search = $('#search');
    if (search) search.value = '';
    const pc = fleetPcs().find((p) => p.id === pcId);
    if (pc) {
      state.collapsed.delete('org:' + pcCompany(pc));
      state.collapsed.delete('branch:' + pcCompany(pc) + '/' + branchOf(pc));
    }
    state.focusPc = pcId;
    showSection();
    renderChrome();
    renderSection();
    const node = document.getElementById('pc-' + pcId);
    if (node) {
      node.scrollIntoView({ block: 'center' });
      setTimeout(() => { state.focusPc = null; }, 4000);
    }
  }

  // ---------- вспомогательное ----------
  let toastTimer = null;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.dataset.show = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.dataset.show = '0'; }, 2200);
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
    document.body.classList.toggle('no-anim', !state.anim);
    $('#theme').setAttribute('aria-pressed', String(state.theme === 'ink'));
    $('#theme').textContent = state.theme === 'ink' ? 'чернила' : 'бумага';
    $('#anim').setAttribute('aria-pressed', String(!state.anim));
    $('#anim').textContent = state.anim ? 'анимация: вкл' : 'анимация: выкл';
  }

  function bind() {
    $('#refresh').addEventListener('click', () => loadAll(true));
    $('#theme').addEventListener('click', () => {
      state.theme = state.theme === 'ink' ? 'light' : 'ink';
      applyTheme();
    });
    $('#anim').addEventListener('click', () => {
      state.anim = !state.anim;
      applyTheme();
    });
    for (const id of SECTIONS) {
      const btn = $('#nav-' + id);
      if (btn) btn.addEventListener('click', () => go(id));
    }
    $('#search').addEventListener('input', (e) => {
      state.query = e.target.value;
      // render() пропускает перерисовку, когда данные не изменились (защита
      // от скачка раскладки), а поиск меняет только фильтр. Поэтому разделы
      // перерисовываем напрямую.
      if (!state.status) return;
      if (state.section === 'fleet') renderFleet();
      else if (state.section === 'overview') renderInfra();
    });
    const statusSel = $('#filter-status');
    if (statusSel) {
      statusSel.addEventListener('change', () => {
        state.statusFilter = statusSel.value;
        renderFleet();
        renderChrome();
      });
    }
    const branchSel = $('#filter-branch');
    if (branchSel) {
      branchSel.addEventListener('change', () => {
        state.branch = branchSel.value;
        renderFleet();
      });
    }
    const issuesBtn = $('#filter-issues');
    if (issuesBtn) {
      issuesBtn.addEventListener('click', () => {
        state.issuesOnly = !state.issuesOnly;
        issuesBtn.setAttribute('aria-pressed', String(state.issuesOnly));
        renderFleet();
      });
    }
    const resetBtn = $('#filter-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        resetFilters();
        renderFleet();
        renderChrome();
      });
    }
    const addBtn = $('#pc-add');
    if (addBtn) addBtn.addEventListener('click', () => { openEditor(null); });
    const printBtn = $('#report-print');
    if (printBtn) printBtn.addEventListener('click', () => { window.print(); });
    const csvBtn = $('#report-csv');
    if (csvBtn) csvBtn.addEventListener('click', () => exportCsv());
    const whProbe = $('#wh-probe');
    if (whProbe) whProbe.addEventListener('click', () => {
      partsData = null;
      partsFailed = false;
      loadParts();
    });
    const taskProbe = $('#task-probe');
    if (taskProbe) taskProbe.addEventListener('click', () => probeEndpoint('api/jobs', '#task-note'));

    document.addEventListener('keydown', (e) => {
      // В открытом модальном окне клавиши-шортказы не работают: Esc и Tab
      // обрабатывает само окно, а «r» не должен обновлять страницу поверх формы.
      if (modal.isOpen()) return;
      const tag = document.activeElement ? document.activeElement.tagName : '';
      if (e.key === '/' && document.activeElement !== $('#search')) {
        e.preventDefault();
        $('#search').focus();
      }
      if (e.key === 'r' && !e.ctrlKey && !e.metaKey && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        loadAll(true);
      }
    });
  }

  applyTheme();
  bind();
  initProfile();
  renderProfile();
  const boot = readBoot();
  if (boot && boot.status) {
    state.status = boot.status;
    state.fleet = boot.fleet || null;
    render(true);
  }
  loadAll(false);
  loadIdentity();
  setInterval(() => loadAll(false), REFRESH_MS);
  setInterval(() => {
    const d = new Date();
    const t = $('#clock-time');
    if (t) t.textContent = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }, 30000);
})();
