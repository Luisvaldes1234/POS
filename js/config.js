/* ──────────────────────────────────────────────────────────────────────
   config.js — Configuración de runtime del POS.

   NO incluir secretos sensibles acá si el repo es público. El token de
   Mapbox es público (pk....) y solo habilita el mapa interactivo del alta
   de cliente; si se deja vacío, el alta sigue funcionando con la búsqueda
   de dirección (Nominatim) y los campos manuales.

   Para habilitar el mapa, pegá tu token público de Mapbox abajo, o seteá
   localStorage 'pos_mapbox_token' en el navegador del mostrador.
   ────────────────────────────────────────────────────────────────────── */
window.POS_MAPBOX_TOKEN = '';
