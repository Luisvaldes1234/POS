/* ──────────────────────────────────────────────────────────────────────
   sentry-init.js — stub de inicialización de monitoreo de errores.

   La app de Reparto carga Sentry acá. En este módulo POS independiente
   no enviamos telemetría a ningún servicio externo por defecto: dejamos
   solo un logger liviano de errores no capturados en la consola para
   facilitar el diagnóstico en mostrador.

   Para conectar Sentry (u otro), reemplazá el cuerpo de initSentry() con
   la inicialización real de su SDK.
   ────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  function initSentry() {
    // No-op por defecto. Punto de extensión para telemetría real.
  }
  // Captura básica de errores globales (solo consola).
  window.addEventListener('error', (e) => {
    try { console.error('[unhandled error]', e.message, e.filename + ':' + e.lineno); } catch (_) {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    try { console.error('[unhandled promise rejection]', e.reason); } catch (_) {}
  });
  initSentry();
})();
