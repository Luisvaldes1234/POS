/* ──────────────────────────────────────────────────────────────────────
   dialogs.js — Modales de confirmación / detalle reutilizables.

   Reimplementación independiente del helper compartido `tmvDialog` que
   usa el POS. Provee:

     tmvDialog.confirm(mensaje, opts)  → Promise<boolean>
     tmvDialog.detail(opts)            → Promise<boolean>
     tmvDialog.alert(mensaje, opts)    → Promise<void>

   opts soporta: { title, severity:'info'|'warning'|'danger'|'success',
                   items:[], okLabel, cancelLabel, body }

   No depende de ningún framework. Inyecta su propio CSS una sola vez.
   ────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.tmvDialog) return;

  const CSS = `
  .tmvdlg-ov{position:fixed;inset:0;background:rgba(10,10,20,.62);z-index:9000;display:flex;align-items:center;justify-content:center;padding:18px;opacity:0;transition:opacity .15s}
  .tmvdlg-ov.show{opacity:1}
  .tmvdlg{background:#fff;border-radius:16px;max-width:420px;width:100%;max-height:88vh;overflow:auto;box-shadow:0 24px 60px rgba(0,0,0,.32);transform:translateY(8px);transition:transform .15s}
  .tmvdlg-ov.show .tmvdlg{transform:translateY(0)}
  .tmvdlg-h{padding:20px 22px 8px;display:flex;gap:12px;align-items:flex-start}
  .tmvdlg-ico{font-size:26px;line-height:1;flex-shrink:0}
  .tmvdlg-titles{flex:1;min-width:0}
  .tmvdlg-title{font-size:16px;font-weight:800;color:#0f172a;line-height:1.3}
  .tmvdlg-body{font-size:13.5px;color:#475569;line-height:1.5;margin-top:6px}
  .tmvdlg-items{margin:10px 22px 0;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px 14px;font-size:13px;color:#0f172a}
  .tmvdlg-items ul{margin:0;padding-left:18px;line-height:1.6}
  .tmvdlg-acts{display:flex;gap:8px;justify-content:flex-end;padding:18px 22px 20px}
  .tmvdlg-btn{padding:10px 18px;border-radius:10px;border:1.5px solid #e2e8f0;background:#fff;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;color:#0f172a}
  .tmvdlg-btn:hover{background:#f8fafc}
  .tmvdlg-btn.primary{border:none;color:#fff;background:#7C3AED}
  .tmvdlg-btn.primary.warning{background:#f59e0b}
  .tmvdlg-btn.primary.danger{background:#ef4444}
  .tmvdlg-btn.primary.success{background:#10b981}
  `;
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const ICONS = { info: 'ℹ️', warning: '⚠️', danger: '⛔', success: '✅', question: '❓' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  }

  // Construye y muestra un modal. `withCancel` controla si hay botón
  // "Cancelar". Devuelve Promise<boolean> (true = OK, false = cancelar).
  function build(opts, withCancel) {
    opts = opts || {};
    const sev = opts.severity || 'info';
    return new Promise((resolve) => {
      const ov = document.createElement('div');
      ov.className = 'tmvdlg-ov';

      const itemsHtml = (opts.items && opts.items.length)
        ? '<div class="tmvdlg-items"><ul>' +
            opts.items.map(it => '<li>' + esc(it) + '</li>').join('') +
          '</ul></div>'
        : '';

      const cancelLabel = opts.cancelLabel != null ? opts.cancelLabel : 'Cancelar';
      const okLabel = opts.okLabel || 'Aceptar';
      const cancelBtn = (withCancel && cancelLabel)
        ? '<button class="tmvdlg-btn" data-act="cancel">' + esc(cancelLabel) + '</button>'
        : '';

      ov.innerHTML =
        '<div class="tmvdlg" role="dialog" aria-modal="true">' +
          '<div class="tmvdlg-h">' +
            '<div class="tmvdlg-ico">' + (ICONS[sev] || ICONS.info) + '</div>' +
            '<div class="tmvdlg-titles">' +
              (opts.title ? '<div class="tmvdlg-title">' + esc(opts.title) + '</div>' : '') +
              (opts.body || opts.message ? '<div class="tmvdlg-body">' + esc(opts.body || opts.message) + '</div>' : '') +
            '</div>' +
          '</div>' +
          itemsHtml +
          '<div class="tmvdlg-acts">' +
            cancelBtn +
            '<button class="tmvdlg-btn primary ' + sev + '" data-act="ok">' + esc(okLabel) + '</button>' +
          '</div>' +
        '</div>';

      document.body.appendChild(ov);
      requestAnimationFrame(() => ov.classList.add('show'));

      const done = (val) => {
        ov.classList.remove('show');
        setTimeout(() => ov.remove(), 160);
        resolve(val);
      };
      ov.addEventListener('click', (e) => {
        const act = e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'ok') done(true);
        else if (act === 'cancel') done(false);
        else if (e.target === ov && withCancel) done(false);
      });
      document.addEventListener('keydown', function onKey(e) {
        if (!document.body.contains(ov)) { document.removeEventListener('keydown', onKey); return; }
        if (e.key === 'Escape' && withCancel) { done(false); document.removeEventListener('keydown', onKey); }
        if (e.key === 'Enter') { done(true); document.removeEventListener('keydown', onKey); }
      });
    });
  }

  window.tmvDialog = {
    // confirm(mensaje, opts) — mensaje puede ir como primer arg (compat)
    confirm(message, opts) {
      opts = opts || {};
      if (typeof message === 'string') opts = Object.assign({ body: message }, opts);
      else opts = message || {};
      if (opts.severity == null) opts.severity = 'question';
      return build(opts, true);
    },
    // detail(opts) — modal informativo con lista de items
    detail(opts) {
      return build(opts || {}, !!(opts && opts.cancelLabel));
    },
    // alert(mensaje, opts)
    alert(message, opts) {
      opts = opts || {};
      if (typeof message === 'string') opts = Object.assign({ body: message }, opts);
      else opts = message || {};
      return build(opts, false);
    },
  };
})();
