/* ──────────────────────────────────────────────────────────────────────
   errors.js — `tmvShowError`: presenta errores (de Supabase u otros) en
   un modal legible, traduciendo los códigos/mensajes más comunes a algo
   entendible por el cajero.

   Uso:
     tmvShowError(error)
     tmvShowError(error, { title: 'No se pudo registrar la venta' })

   Depende de tmvDialog (dialogs.js) para el render. Si no está cargado,
   cae a un alert() nativo.
   ────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.tmvShowError) return;

  // Traduce mensajes de Postgres/Supabase frecuentes a copy de mostrador.
  function humanizar(err) {
    const raw = (err && (err.message || err.error_description || err.error || err.details)) || String(err || 'Error desconocido');
    const msg = String(raw);
    const m = msg.toLowerCase();

    if (m.includes('jwt') || m.includes('not authorized') || m.includes('no autorizado') || m.includes('401')) {
      return 'Tu sesión expiró. Recargá la página e iniciá sesión de nuevo.';
    }
    if (m.includes('failed to fetch') || m.includes('networkerror') || m.includes('network request failed')) {
      return 'Sin conexión. Revisá el WiFi del mostrador y reintentá.';
    }
    if (m.includes('duplicate key') || m.includes('23505')) {
      return 'Ese registro ya existe (dato duplicado).';
    }
    if (m.includes('foreign key') || m.includes('23503')) {
      return 'Falta un dato relacionado o está en uso por otra operación.';
    }
    if (m.includes('22p02') || m.includes('invalid input syntax')) {
      return 'Hay un dato con formato inválido. Revisá los campos e intentá de nuevo.';
    }
    if (m.includes('permission denied') || m.includes('row-level security') || m.includes('rls')) {
      return 'No tenés permisos para esta operación.';
    }
    if (m.includes('stock')) {
      return msg; // los errores de stock ya vienen en español del backend
    }
    return msg;
  }

  window.tmvShowError = function tmvShowError(err, opts) {
    opts = opts || {};
    const body = humanizar(err);
    // Loguear el error crudo para diagnóstico.
    try { console.error('[tmvShowError]', err); } catch (_) {}

    if (window.tmvDialog && typeof window.tmvDialog.alert === 'function') {
      const detalle = (err && (err.code || err.hint)) ? String(err.code || err.hint) : null;
      return window.tmvDialog.alert({
        title: opts.title || 'Ocurrió un error',
        body,
        severity: 'danger',
        items: detalle ? ['Detalle técnico: ' + detalle] : null,
        okLabel: 'Entendido',
      });
    }
    // Fallback sin tmvDialog
    alert((opts.title ? opts.title + '\n\n' : '') + body);
    return Promise.resolve();
  };
})();
