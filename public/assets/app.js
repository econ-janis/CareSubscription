// Helpers compartidos de Inicio, Clientes PMC e Impacto Care: tema, sesión
// (Janis ID), encabezado con navegación y llamadas a la API.
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const NAV = [
    { href: '/', label: 'Inicio' },
    { href: '/suscripciones', label: 'Suscripciones' },
    { href: '/clientes-pmc', label: 'Clientes PMC' },
    { href: '/impacto', label: 'Impacto Care' },
  ];

  function goToLogin() {
    location.replace(`/login?returnTo=${encodeURIComponent(location.pathname + location.search + location.hash)}`);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      body: options.body ? JSON.stringify(options.body) : undefined,
      credentials: 'same-origin',
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) goToLogin();
    if (!response.ok) {
      const error = new Error(payload.error || `Error ${response.status}`);
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  // Tema claro/oscuro (misma preferencia que Suscripciones). onChange: para redibujar gráficos.
  const themeListeners = [];
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const logo = $('brandLogo');
    if (logo) logo.src = theme === 'dark' ? '/brand/iso-white.svg' : '/brand/iso-color.svg';
    const toggle = $('themeToggle');
    if (toggle) toggle.textContent = theme === 'dark' ? '☀️' : '🌙';
    themeListeners.forEach((fn) => fn(theme));
  }

  function renderHeader(user) {
    const header = document.createElement('header');
    header.className = 'top';
    header.innerHTML = `
      <a class="brand" href="/"><img id="brandLogo" src="/brand/iso-color.svg" alt="Janis">CareSubscription</a>
      <nav>${NAV.map((n) => `<a href="${n.href}"${location.pathname === n.href ? ' aria-current="page"' : ''}>${esc(n.label)}</a>`).join('')}</nav>
      <span class="user" title="${esc(user.email)}">${esc(user.name && user.name !== user.email ? `${user.name} · ${user.email}` : user.email)}</span>
      <button class="icon-btn" id="themeToggle" title="Cambiar tema" aria-label="Cambiar tema">🌙</button>
      <a class="btn" href="/logout">Cerrar sesión</a>`;
    document.body.prepend(header);
    let theme = 'light';
    try { theme = localStorage.getItem('janis-theme') || 'light'; } catch { /* sin storage */ }
    applyTheme(theme);
    $('themeToggle').onclick = () => {
      theme = theme === 'dark' ? 'light' : 'dark';
      applyTheme(theme);
      try { localStorage.setItem('janis-theme', theme); } catch { /* sin storage */ }
    };
  }

  // Verifica la sesión y arma el encabezado. Devuelve el usuario (o redirige al login).
  async function initPage() {
    let theme = 'light';
    try { theme = localStorage.getItem('janis-theme') || 'light'; } catch { /* sin storage */ }
    document.documentElement.dataset.theme = theme;
    const auth = await api('/api/auth');
    if (!auth.user) {
      goToLogin();
      return new Promise(() => {});
    }
    renderHeader(auth.user);
    return auth;
  }

  function showMsg(target, kind, text) {
    const el = typeof target === 'string' ? $(target) : target;
    el.innerHTML = `<div class="msg ${kind}">${esc(text)}</div>`;
  }

  async function busy(button, fn) {
    button.disabled = true;
    try { return await fn(); } finally { button.disabled = false; }
  }

  window.CS = { $, esc, api, initPage, showMsg, busy, onTheme: (fn) => themeListeners.push(fn) };
})();
