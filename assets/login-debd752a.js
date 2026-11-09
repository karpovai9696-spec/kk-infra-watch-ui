(function () {
  var API_BASE = 'https://a.mdlp.gk-kd.ru:24112';
  var form = document.getElementById('form');
  var msg = document.getElementById('msg');
  var btn = document.getElementById('submit');
  var loginEl = document.getElementById('login');
  var passEl = document.getElementById('password');

  // Адреса API: сначала внешний (через корпоративный VPS), при недоступности —
  // прямой офисный. В офисе DNS отдаёт внутренний адрес домена, поэтому
  // внешний порт недоступен, а снаружи наоборот.
  // Адрес API выбираем по протоколу страницы: с HTTPS-страницы нельзя
  // ходить на HTTP (mixed content), а в офисе DNS отдаёт внутренний адрес
  // домена, поэтому внешний порт оттуда недоступен.
  var API_CANDIDATES = (location.protocol === 'https:')
    ? ['https://a.mdlp.gk-kd.ru:24112']
    : ['http://a.mdlp.gk-kd.ru:7100', 'http://192.168.1.227:7100'];

  var apiIndex = 0;

  function api(path) {
    return API_CANDIDATES[apiIndex] + path;
  }

  // Перебор адресов: если текущий не отвечает, пробуем следующий.
  function apiTry(path, options) {
    function attempt(i) {
      if (i >= API_CANDIDATES.length) return Promise.reject(new Error('API недоступен'));
      apiIndex = i;
      var opts = options || {};
      opts.credentials = 'include';
      opts.cache = 'no-store';
      return fetch(api(path), opts)
        .then(function (res) {
          // 5xx — адрес не по той причине пробуем следующий; 4xx — ответ сервера,
          // показываем пользователю.
          if (res.status >= 500) throw new Error('HTTP ' + res.status);
          return res;
        })
        .catch(function (e) {
          if (e && e.status && e.status >= 400) throw e;
          return attempt(i + 1);
        });
    }
    return attempt(0);
  }

  // Токен храним, чтобы не вводить его каждый раз.
  try {
    var saved = localStorage.getItem('kk_api_token');
    if (saved) { loginEl.value = saved; passEl.value = 'token'; }
  } catch (e) { /* нет localStorage */ }

  // Пояснение, если API недоступен: из офисной сети браузер блокирует
  // запросы с публичной страницы (GitHub Pages) к внутреннему адресу.
  if (location.search.indexOf('err=network') >= 0) {
    msg.textContent = 'Сервер недоступен с этой страницы. Из офисной сети откройте '
      + 'http://192.168.1.227:7100/ (прямой адрес) или http://a.mdlp.gk-kd.ru:7100/. '
      + 'Снаружи (интернет или корпоративный VPN) всё работает.';
    msg.style.color = '#e8a33d';
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    msg.textContent = '';
    btn.disabled = true;
    var login = loginEl.value.trim();
    var pass = passEl.value;
    var isToken = pass === 'token' || pass === '';

    function store(token) {
      try { localStorage.setItem('kk_api_token', token); } catch (e) { /* ignore */ }
      window.location.replace('./');
    }

    if (isToken) {
      // Вход по API-токену: проверяем его запросом к /api/auth/me.
      apiTry('/api/auth/me', { headers: { Accept: 'application/json', Authorization: 'Bearer ' + login } }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }).then(function () {
        store(login);
      }).catch(function () {
        msg.textContent = 'Токен не принят. Проверьте срок действия (72 часа).';
        btn.disabled = false;
      });
      return;
    }

    apiTry('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ login: login, password: pass }) }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (d) {
          throw new Error(d.error || ('HTTP ' + res.status));
        });
      }
      return res.json();
    }).then(function (data) {
      // Сессия лежит в cookie SameSite=Strict — из внешнего домена она не
      // долетит, поэтому сохраняем токен в localStorage как запасной путь.
      store('');
      window.location.replace('./');
    }).catch(function (e) {
      msg.textContent = e && e.message ? e.message : 'Не удалось войти';
      btn.disabled = false;
    });
  });
})();
