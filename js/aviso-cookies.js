// Aviso de cookies de las páginas públicas. Solo informa: el sitio usa
// únicamente almacenamiento necesario (ver cookies.html), así que no hay nada
// que aceptar o rechazar. Si algún día se agregan cookies de medición o
// publicidad, esto tiene que pasar a pedir consentimiento antes de cargarlas.
(function () {
  try { if (localStorage.getItem('pos_cookies_ok')) return; } catch (_) { return; }
  const base = new URL('../', document.currentScript.src);
  const caja = document.createElement('div');
  caja.setAttribute('role', 'region');
  caja.setAttribute('aria-label', 'Aviso de cookies');
  caja.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;max-width:560px;margin:0 auto;' +
    'background:#fff;border:1px solid #E2E8F0;border-radius:12px;box-shadow:0 12px 32px -8px rgba(16,24,40,.25);' +
    'padding:14px 16px;display:flex;gap:12px;align-items:center;font:14px/1.45 Inter,system-ui,sans-serif;color:#334155';
  const txt = document.createElement('div');
  txt.style.flex = '1';
  txt.innerHTML = 'Usamos solo cookies necesarias para que el sitio funcione, sin publicidad. ' +
    '<a href="' + new URL('cookies.html', base) + '" style="color:#0F766E;font-weight:600">Más información</a>';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Entendido';
  btn.style.cssText = 'font:600 14px Inter,system-ui,sans-serif;background:#0F766E;color:#fff;border:0;border-radius:8px;padding:9px 16px;cursor:pointer;white-space:nowrap;width:auto;flex:none;margin:0';
  btn.onclick = () => { try { localStorage.setItem('pos_cookies_ok', '1'); } catch (_) {} caja.remove(); };
  caja.append(txt, btn);
  (document.body ? Promise.resolve() : new Promise(r => addEventListener('DOMContentLoaded', r)))
    .then(() => document.body.appendChild(caja));
})();
