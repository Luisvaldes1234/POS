// ════════════════════════════════════════════════════════════════════
//  POS Mostrador — lógica principal (módulo retail independiente).
//  Punto de venta para tiendas de abarrotes, ferreterías y kioscos.
//  Reusa el backend Supabase compartido (mismas RPC del POS de Reparto).
// ════════════════════════════════════════════════════════════════════

// ── Supabase ─────────────────────────────────────────
const SB_URL = 'https://zgdrvptneiwlxlaywfur.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpnZHJ2cHRuZWl3bHhsYXl3ZnVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NDU4NDgsImV4cCI6MjA5MDUyMTg0OH0.r1BR_OruT95Ks_xdkvlnuSqT8Lm-Vh6usJhgdLcV_Ig';
const sb = supabase.createClient(SB_URL, SB_KEY);

// ── Estado ───────────────────────────────────────────
let orgId       = null;
let orgName     = null;
let orgPais     = null;   // 'AR' / 'MX' / etc — para sugerir prefijo telefónico
let userRole    = null;

const PHONE_PREFIX = {
  AR:'+54',ARGENTINA:'+54',MX:'+52',MEXICO:'+52','MÉXICO':'+52',
  CL:'+56',CHILE:'+56',UY:'+598',URUGUAY:'+598',PY:'+595',PARAGUAY:'+595',
  BO:'+591',BOLIVIA:'+591',PE:'+51',PERU:'+51','PERÚ':'+51',
  CO:'+57',COLOMBIA:'+57',EC:'+593',ECUADOR:'+593',VE:'+58',VENEZUELA:'+58',
  BR:'+55',BRASIL:'+55',BRAZIL:'+55',US:'+1',USA:'+1',EEUU:'+1','ESTADOS UNIDOS':'+1',
  ES:'+34','ESPAÑA':'+34',SPAIN:'+34',
};
function posPhonePrefix() {
  if (!orgPais) return '+54';
  return PHONE_PREFIX[String(orgPais).toUpperCase()] || '+54';
}
let productos   = [];
let stockMap    = new Map();
let cart        = new Map();
let clienteSel  = null;
let clienteMostradorId = null;
let _searchProd = '';
let _prodView = (() => { try { return localStorage.getItem('pos_prod_view') || 'grid'; } catch (_) { return 'grid'; } })();
let _searchCli  = '';
let _suggestTimer = null;
let _stockStrict = true;
// Permisos de stock del usuario actual (los admins tienen ambos). Para cajeros
// los define el administrador desde Configuración → Usuarios.
let _permRecibir = false;   // puede reponer / cargar mercadería (sumar stock)
let _permAjustar = false;   // puede descontar/ajustar y editar/dar de baja productos
async function _cargarPermisos(){
  if (_isAdmin()) { _permRecibir = true; _permAjustar = true; return; }
  try {
    const { data } = await sb.rpc('pos_permisos_mis', { p_organization_id: orgId });
    _permRecibir = !!data?.recibir_stock;
    _permAjustar = !!data?.ajustar_stock;
  } catch (_) { _permRecibir = false; _permAjustar = false; }
}
function _canRecibirStock(){ return _isAdmin() || _permRecibir || _permAjustar; }
function _canAjustarStock(){ return _isAdmin() || _permAjustar; }
function _calcDescuento(total) {
  const inp = document.getElementById('pos-descuento');
  const tipo = document.getElementById('pos-descuento-tipo')?.value || 'ars';
  if (!inp) return 0;
  const raw = parseFloat(String(inp.value).replace(',', '.')) || 0;
  if (raw <= 0) return 0;
  if (tipo === 'pct') return Math.min(total, total * raw / 100);
  return Math.min(total, raw);
}
function _calcPromoOff() {
  let off = 0;
  cart.forEach((it, prodId) => {
    const p = productos.find(x => x.id === prodId);
    if (!p) return;
    const qty = Number(p.descuento_volumen_qty || 0);
    const pct = Number(p.descuento_volumen_pct || 0);
    if (qty > 0 && pct > 0 && it.cantidad >= qty) {
      off += (it.cantidad * it.precio) * pct / 100;
    }
  });
  return off;
}
function _resetDescuento() {
  const inp = document.getElementById('pos-descuento');
  if (inp) inp.value = '';
}
let tiendas = [];
let tiendaId = null;
// Nombre de tienda elegido en el registro (queda en el metadata del usuario);
// se usa al crear la primera tienda de una organización nueva.
let _provisionTiendaNombre = null;

// ¿El usuario actual es administrador? (puede gestionar stock, productos,
// usuarios, ver costos/márgenes y finanzas). Los cajeros (client_pos) no.
function _isAdmin() {
  return ['client_admin','account_manager','super_admin'].includes(userRole);
}

// Recalcula el costo de un producto al recibir una entrega cuyo costo unitario
// puede diferir del anterior. Modos:
//   'promedio'  → costo promedio ponderado: mezcla el stock que ya había (a su
//                 costo anterior) con la entrega nueva (a su costo nuevo).
//   'reemplazar'→ toma el costo de esta entrega como costo actual.
//   'no'        → no cambia el costo.
// Devuelve el nuevo costo (redondeado a 2 decimales) o null si no hay cambio.
function _costoNuevoPonderado(mode, qActual, costoActual, qNueva, costoNuevo) {
  costoNuevo = Number(costoNuevo) || 0;
  if (mode === 'no' || costoNuevo <= 0) return null;
  if (mode === 'reemplazar') return Math.round(costoNuevo * 100) / 100;
  // promedio ponderado
  const qa = Math.max(0, Number(qActual) || 0);
  const ca = Number(costoActual) || 0;
  const qn = Math.max(0, Number(qNueva) || 0);
  if (qa <= 0 || ca <= 0) return Math.round(costoNuevo * 100) / 100; // sin base previa
  if (qn <= 0) return null;
  const avg = (qa * ca + qn * costoNuevo) / (qa + qn);
  return Math.round(avg * 100) / 100;
}

// ── Helpers UI ───────────────────────────────────────
function fmtARS(n){ return '$' + Number(n||0).toLocaleString('es-AR', {maximumFractionDigits:0}); }
function fmtTime(ts){
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('es-AR', {hour:'2-digit', minute:'2-digit'});
}
// ── Info tooltips (ⓘ) ────────────────────────────────
// Devuelve un iconito "i" que, al pasar el cursor (o tocar en móvil), muestra un
// tooltip propio explicando qué es y cómo se calcula la métrica.
function iHelp(text){
  if (!text) return '';
  const t = String(text).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return '<span class="info-i" tabindex="0" role="button" aria-label="' + t + '" data-tip="' + t + '">i</span>';
}

// Tooltip propio para los iconos ⓘ: aparece al instante y se posiciona con
// position:fixed, así nunca se recorta dentro de paneles que scrollean (el
// title nativo del navegador era lento y a veces no aparecía).
(function initInfoTips(){
  let tip = null;
  const ensure = () => { if (!tip) { tip = document.createElement('div'); tip.id = 'pos-tip'; document.body.appendChild(tip); } return tip; };
  const iconOf = (e) => (e.target && e.target.closest) ? e.target.closest('.info-i') : null;
  function show(el){
    const txt = el.getAttribute('data-tip'); if (!txt) return;
    const t = ensure(); t.textContent = txt; t.classList.add('show');
    const r = el.getBoundingClientRect();
    const tw = t.offsetWidth, th = t.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
    let top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8;   // si no entra arriba, va abajo
    t.style.left = left + 'px'; t.style.top = top + 'px';
  }
  const hide = () => { if (tip) tip.classList.remove('show'); };
  document.addEventListener('pointerover', (e) => { const el = iconOf(e); if (el) show(el); });
  document.addEventListener('pointerout',  (e) => { const el = iconOf(e); if (el) hide(); });
  document.addEventListener('focusin',     (e) => { const el = iconOf(e); if (el) show(el); });
  document.addEventListener('focusout', hide);
  document.addEventListener('click', (e) => {   // móvil: tocar para ver/ocultar
    const el = iconOf(e);
    if (el) { (tip && tip.classList.contains('show')) ? hide() : show(el); }
    else hide();
  });
  window.addEventListener('scroll', hide, true);
})();
// Explicaciones reutilizables (qué es y cómo se calcula cada métrica).
const INFO = {
  total_cobrado:  'Suma de TODO lo efectivamente cobrado en el período, sumando todas las formas de pago. No incluye ventas anuladas.',
  ventas_count:   'Cantidad de ventas registradas en el período (sin contar las anuladas).',
  efectivo:       'Total cobrado en efectivo.',
  mercadopago:    'Total cobrado con MercadoPago (QR o link de pago).',
  transferencia:  'Total cobrado por transferencia bancaria.',
  debito:         'Total cobrado con tarjeta de débito.',
  credito:        'Total cobrado con tarjeta de crédito (incluye el recargo por cuotas si se aplicó).',
  cuenta_corriente:'Ventas fiadas: se anotan en la cuenta del cliente para cobrarse después. Todavía NO es dinero recibido; no suma al total cobrado.',
  egresos:        'Dinero que salió de la caja (retiros, pagos, gastos cargados en la caja) en el período.',
  ingresos_extra: 'Dinero que entró a la caja por fuera de las ventas (ej. aporte de cambio, cobros varios).',
  anuladas:       'Ventas que se anularon/cancelaron. No suman al total cobrado.',
  operaciones:    'Cantidad de cobros realizados en este turno de caja.',
  // Finanzas
  fin_ventas:     'Ventas efectivamente cobradas en el período (mismo criterio que Total cobrado).',
  fin_costo:      'Costo de la mercadería vendida (CMV): unidades vendidas × costo de compra cargado en cada producto. Es estimado; si un producto no tiene costo cargado, no se computa.',
  fin_margen:     'Margen bruto = Ventas − Costo de mercadería. El porcentaje es sobre las ventas.',
  fin_gastos:     'Suma de los gastos del período (sueldos, alquiler, servicios, etc.) cargados en Finanzas.',
  fin_otros_ing:  'Otros ingresos del período que no son ventas (ej. reintegros, ingresos varios).',
  fin_resultado:  'Resultado neto estimado = Margen bruto − Gastos + Otros ingresos. Es una estimación de gestión, no reemplaza la contabilidad formal.',
  fin_comisiones: 'Incentivo de cada cajero calculado sobre lo que vendió en el período: ventas × % de comisión + bono fijo. El % y el bono se guardan para la próxima vez. Podés registrarlas como gasto (categoría Comisiones) para que impacten en el resultado.',
  // Envases
  env_hoy:        'Envases retornables movidos hoy (entregados/devueltos) en esta tienda.',
  env_periodo:    'Envases retornables movidos en el período seleccionado.',
  env_clientes:   'Cantidad de clientes distintos con movimientos de envases en el período.',
  // Reportes históricos — secciones
  rep_por_cajero: 'Desglose de ventas y cobros por cada cajero en el período. "Total" es lo cobrado por ese cajero; "Egresos" son retiros/gastos de caja que registró.',
  rep_productos:  'Unidades vendidas y su importe (cantidad × precio, neto de devoluciones) por producto en el período. La barra compara el volumen entre productos. No descuenta promos ni descuentos generales.',
  rep_por_dia:    'Cantidad de ventas y monto cobrado en cada día del rango. La barra compara el monto entre días.',
  rep_ventas:     'Detalle de cada venta del período: fecha, cliente, cajero, forma de pago y total. Las que aparecen tachadas son ventas anuladas.',
  rep_cortes:     'Cierres de caja (Z) del período: apertura, lo declarado al cerrar, lo calculado por el sistema y la diferencia entre ambos.',
  rep_global:     'Resumen consolidado del período sumando todas las cajas: cajas cerradas, ventas, efectivo declarado, diferencia, ingresos/egresos y facturas.',
  cg_cortes:      'Cajas cerradas / total de cajas abiertas ese día.',
  cg_ventas:      'Total vendido en el POS ese día, sumando todas las cajas de la tienda.',
  cg_efectivo:    'Efectivo declarado (contado físicamente) al cerrar las cajas del día.',
  cg_diferencia:  'Diferencia entre el efectivo declarado y el que calculó el sistema. Negativo = faltante; positivo = sobrante.',
  cg_ing_egr:     'Ingresos y egresos de caja del día (aportes de cambio, retiros, pagos/gastos), fuera de las ventas.',
  cg_facturas:    'Cantidad de facturas emitidas ese día y su importe total.',
  cg_metodos:     'Total vendido ese día abierto por forma de pago.',
  cg_cortes_incl: 'Detalle de cada caja cerrada incluida en el corte: apertura, declarado, calculado por el sistema y diferencia.',
};

let _toastT;
function toast(msg, type=''){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(_toastT);
  _toastT = setTimeout(() => el.classList.remove('show'), 3000);
}

// ══════════════════ MODO OFFLINE ══════════════════════
// Permite seguir vendiendo sin internet (efectivo, transferencia, débito,
// crédito y cuenta corriente): las ventas se guardan localmente y se
// sincronizan solas al volver la conexión. MercadoPago (QR) y la facturación
// requieren conexión. El catálogo/stock se cachea para poder abrir offline.
let _offSyncing = false;

function _uuid(){
  try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (_) {}
  return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.floor(Math.random() * 16); return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}
function _isNetErr(e){
  if (!e) return false;
  const m = ((e.message || e.msg || e.error_description || '') + '').toLowerCase();
  return e.name === 'TypeError' || /failed to fetch|networkerror|load failed|fetch|network|offline|err_internet|timeout/.test(m);
}

// ── Cola de ventas offline ──
function _offQueueKey(){ return 'pos_offq_' + (orgId || 'x'); }
function _offLoadQueue(){ try { return JSON.parse(localStorage.getItem(_offQueueKey()) || '[]'); } catch (_) { return []; } }
function _offSaveQueue(q){ try { localStorage.setItem(_offQueueKey(), JSON.stringify(q)); } catch (_) {} }
function _offPending(){ return _offLoadQueue().length; }

// Wrapper del alta de venta: online intenta la RPC real; si no hay red, encola.
async function _ventaRPC(params){
  if (navigator.onLine){
    try {
      const res = await sb.rpc('pos_registrar_venta', params);
      if (res.error && _isNetErr(res.error)) throw res.error;
      return res;                     // incluye respuestas lógicas (stock_insuficiente, etc.)
    } catch (e){
      if (!_isNetErr(e)) throw e;      // error real (no de red): propagar
      // se cortó la red justo al cobrar → encolamos
    }
  }
  return _offEnqueueVenta(params);
}

function _offEnqueueVenta(params){
  const q = _offLoadQueue();
  const localId = 'local-' + _uuid();
  q.push({ id: localId, params, ts: Date.now() });
  _offSaveQueue(q);
  // Descuento optimista de stock local, para que la UI y el modo estricto sigan
  // reflejando lo vendido mientras estamos sin conexión.
  try {
    (params.p_items || []).forEach(it => {
      const pid = it.producto_id; if (!pid) return;
      const qty = Number(it.cantidad) || 0;
      if (stockMap.has(pid)) stockMap.set(pid, (stockMap.get(pid) || 0) - qty);
    });
  } catch (_) {}
  _offUpdateUI();
  return { data: { ok: true, pedido_id: localId, offline: true, vales_creados: 0 }, error: null };
}

// ── Bloqueo por stock del lado del cliente ──
// El servidor bloquea solo si el producto tiene fila de stock; y offline no hay
// servidor. Este chequeo garantiza el bloqueo en ambos casos usando el stock
// que ve el cajero (stockMap). Solo actúa con el modo estricto activado.
function _stockFaltante(items){
  if (!_stockStrict) return [];
  const probs = [];
  (items || []).forEach(it => {
    const p = productos.find(x => x.id === it.producto_id);
    if (!p || p.es_combo) return;   // los combos descuentan por sus componentes
    const req = Number(it.cantidad_entregada != null ? it.cantidad_entregada : it.cantidad) || 0;
    if (req <= 0) return;
    const disp = stockMap.has(it.producto_id) ? Number(stockMap.get(it.producto_id)) || 0 : 0;
    if (disp < req) probs.push({ nombre: p.nombre, disp, req });
  });
  return probs;
}
async function _bloqueoStock(items){
  const probs = _stockFaltante(items);
  if (!probs.length) return false;
  await tmvDialog.detail({
    title: 'No alcanza el stock del mostrador',
    body: 'Estos productos no tienen cantidad suficiente para esta venta:',
    items: probs.map(p => p.nombre + ' — tenés ' + p.disp + ', necesitás ' + p.req),
    severity: 'warning', okLabel: 'Entendido', cancelLabel: '',
  });
  return true;
}

// Reintenta registrar en el servidor todas las ventas encoladas, en orden.
async function _offSync(manual){
  if (_offSyncing) return;
  let q = _offLoadQueue();
  if (!q.length){ if (manual) toast('No hay ventas pendientes de sincronizar', 'info'); return; }
  if (!navigator.onLine){ if (manual) toast('Todavía sin conexión', 'warn'); return; }
  _offSyncing = true; _offUpdateUI();
  let ok = 0, fail = 0, netCut = false;
  for (const sale of [...q]){
    try {
      // La venta ya ocurrió físicamente: registrar aunque el stock quede en
      // negativo (no bloquear por stock estricto al sincronizar).
      const p = Object.assign({}, sale.params, { p_stock_strict: false });
      const { data, error } = await sb.rpc('pos_registrar_venta', p);
      if (error){ if (_isNetErr(error)){ netCut = true; break; } fail++; }
      else if (data && (data.ok || data.pedido_id)){ ok++; }
      else { fail++; }
    } catch (e){
      if (_isNetErr(e)){ netCut = true; break; }
      fail++;                          // error no-red: descartar para no loopear
    }
    q = _offLoadQueue().filter(s => s.id !== sale.id);
    _offSaveQueue(q);
  }
  _offSyncing = false;
  const pend = _offPending();
  if (ok){ try { await cargarStock(); renderStock(); renderProductGrid(); } catch (_) {} }
  _offUpdateUI();
  if (ok)   toast('✓ ' + ok + ' venta(s) sincronizada(s)' + (pend ? ' · ' + pend + ' pendiente(s)' : ''), 'ok');
  else if (fail) toast('⚠ ' + fail + ' venta(s) no se pudieron sincronizar', 'err');
  else if (manual && pend && !netCut) toast(pend + ' pendiente(s)', 'warn');
}

// ── Indicador en la barra superior (offline / pendientes) ──
function _offInitUI(){
  const bar = document.querySelector('.topbar');
  if (bar && !document.getElementById('off-pill')){
    const pill = document.createElement('button');
    pill.id = 'off-pill';
    pill.type = 'button';
    pill.style.cssText = 'display:none;flex:0 0 auto;border:none;border-radius:50px;padding:5px 12px;font-family:inherit;font-size:12px;font-weight:800;color:#fff;cursor:pointer;white-space:nowrap';
    pill.title = 'Estado de conexión / ventas pendientes';
    pill.addEventListener('click', () => _offSync(true));
    const logout = bar.querySelector('.topbar-logout');
    bar.insertBefore(pill, logout || null);
  }
  window.addEventListener('online',  () => { _offUpdateUI(); _offSync(false); });
  window.addEventListener('offline', () => { _offUpdateUI(); });
  _offUpdateUI();
  if (navigator.onLine) _offSync(false);
}

function _offUpdateUI(){
  const pill = document.getElementById('off-pill');
  const online = navigator.onLine;
  const pend = _offPending();
  // Aviso arriba de la grilla de venta cuando estamos offline.
  const scr = document.getElementById('screen-vender') || document.querySelector('.pos-products');
  if (pill){
    if (!online){
      pill.style.display = ''; pill.style.background = '#b45309';
      pill.textContent = '📴 Offline' + (pend ? ' · ' + pend : '');
    } else if (_offSyncing){
      pill.style.display = ''; pill.style.background = '#1d4ed8';
      pill.textContent = '⏳ Sincronizando…';
    } else if (pend){
      pill.style.display = ''; pill.style.background = '#1d4ed8';
      pill.textContent = '↑ ' + pend + ' sincronizar';
    } else {
      pill.style.display = 'none';
    }
  }
  // Bloquear MercadoPago cuando no hay conexión (necesita el servidor).
  document.querySelectorAll('[data-metodo="mercadopago"], #btn-mp').forEach(b => {
    if (!online){ b.setAttribute('disabled', 'disabled'); b.title = 'MercadoPago necesita conexión a internet'; }
    else { b.removeAttribute('disabled'); b.title = ''; }
  });
}

// ── Snapshot del catálogo para arrancar offline ──
function _offSnapKey(uid){ return 'pos_snap_' + uid; }
function _offSaveSnapshot(uid){
  try {
    if (!orgId || !Array.isArray(productos) || !productos.length) return;   // no pisar con datos vacíos
    localStorage.setItem(_offSnapKey(uid), JSON.stringify({
      ts: Date.now(), userRole, orgId, orgName, orgPais,
      tiendas, tiendaId, tiendaLocked,
      productos, stock: Array.from(stockMap.entries()),
      clienteMostradorId,
      permRecibir: _permRecibir, permAjustar: _permAjustar,
    }));
  } catch (_) {}
}
function _offHydrate(uid){
  let s; try { s = JSON.parse(localStorage.getItem(_offSnapKey(uid)) || 'null'); } catch (_) { s = null; }
  if (!s || !s.orgId || !Array.isArray(s.productos) || !s.productos.length) return false;
  userRole = s.userRole; orgId = s.orgId; orgName = s.orgName; orgPais = s.orgPais;
  tiendas = s.tiendas || []; tiendaId = s.tiendaId; tiendaLocked = !!s.tiendaLocked;
  productos = s.productos || [];
  stockMap = new Map(s.stock || []);
  clienteMostradorId = s.clienteMostradorId || null;
  _permRecibir = !!s.permRecibir; _permAjustar = !!s.permAjustar;
  return true;
}

// ── Bootstrap ────────────────────────────────────────
async function init(){
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { window.location.replace('login.html'); return; }
  _lockUserEmail = session.user?.email || null;
  // Nombre de tienda elegido en el registro (para la primera tienda).
  _provisionTiendaNombre = (session.user?.user_metadata?.tienda_name || '').trim() || null;
  _resetLockTimer();
  const _uid = session.user.id;
  let _offlineMode = false;

  try {
  if (!navigator.onLine) throw { message: 'offline' };

  const { data: sysRole } = await sb.from('system_roles')
    .select('role').eq('user_id', session.user.id).maybeSingle();

  if (sysRole?.role === 'super_admin') {
    userRole = 'super_admin';
    let impOrgId = null;
    try { impOrgId = localStorage.getItem('tmv_impersonate_org') || null; } catch (_) {}
    let orgRow = null;
    if (impOrgId) {
      const { data } = await sb.from('organizations')
        .select('id, name, pais').eq('id', impOrgId).eq('activo', true).maybeSingle();
      orgRow = data || null;
    }
    if (!orgRow) {
      const { data: orgs } = await sb.from('organizations')
        .select('id, name, pais').eq('activo', true).order('name').limit(1);
      orgRow = orgs?.[0] || null;
    }
    if (!orgRow) { toast('Sin organizaciones disponibles', 'err'); return; }
    orgId = orgRow.id; orgName = orgRow.name; orgPais = orgRow.pais || null;
  } else {
    const _fetchRole = () => sb.from('user_roles')
      .select('role, organization_id, organizations(name, pais)')
      .eq('user_id', session.user.id)
      .eq('activo', true)
      .maybeSingle();

    let { data: ur } = await _fetchRole();

    // Self-service: si el usuario autenticado todavía no tiene organización
    // (recién se registró o acaba de confirmar su email), provisionamos su
    // org de prueba (trial 14 días, rol client_admin) y reintentamos. La RPC
    // es idempotente: si ya estaba provisionada, devuelve la existente.
    if (!ur) {
      toast('Preparando tu cuenta…', 'info');
      try {
        const { data: prov, error: provErr } = await sb.rpc('provision_trial_org_for_user', {
          p_business_name: null, p_owner_name: null, p_phone: null, p_country: null,
          p_product: 'pos',
        });
        if (provErr) throw provErr;
        if (prov?.ok) ({ data: ur } = await _fetchRole());
      } catch (e) {
        console.warn('provision_trial_org_for_user:', e);
      }
    }

    if (!ur) {
      toast('Tu usuario no tiene rol asignado', 'err');
      setTimeout(() => sb.auth.signOut().then(() => window.location.replace('login.html')), 2000);
      return;
    }
    userRole = ur.role;
    orgId    = ur.organization_id;
    orgName  = ur.organizations?.name || '';
    orgPais  = ur.organizations?.pais || null;

    if (!['client_pos','client_admin','account_manager'].includes(userRole)) {
      toast('No tenés permisos para usar el POS', 'err');
      setTimeout(() => window.location.replace('login.html'), 2000);
      return;
    }
  }

  document.getElementById('t-org').textContent = orgName || '';
  if (userRole === 'super_admin') {
    try {
      const { data: allOrgs } = await sb.from('organizations')
        .select('id, name').eq('activo', true).order('name');
      if (allOrgs?.length) {
        const esc = (s) => String(s || '').replace(/[<>&"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
        const el = document.getElementById('t-org');
        el.innerHTML = '<select id="t-org-sel" title="Cambiar de organización" '
          + 'style="background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);color:#fff;border-radius:8px;padding:4px 8px;font-size:13px;font-weight:600;max-width:220px;cursor:pointer;font-family:inherit">'
          + allOrgs.map(o => '<option value="' + o.id + '"' + (o.id === orgId ? ' selected' : '') + '>' + esc(o.name) + '</option>').join('')
          + '</select>';
        document.getElementById('t-org-sel').addEventListener('change', (e) => {
          const v = e.target.value;
          if (!v || v === orgId) return;
          try { localStorage.setItem('tmv_impersonate_org', v); } catch (_) {}
          location.reload();
        });
      }
    } catch (_) {}
  }

  await cargarTiendas();
  await _cargarPermisos();
  if (_isAdmin()) {
    // Todo lo de gestión (usuarios, tiendas, ticket, promos, cuotas y
    // MercadoPago) vive ahora dentro de la pestaña Configuración.
    document.getElementById('tab-finanzas-btn').style.display = '';
    document.getElementById('tab-config-btn').style.display = '';
    const addBtn = document.getElementById('btn-add-prod-toolbar');
    if (addBtn) addBtn.style.display = '';
  }

  await Promise.all([
    cargarProductos(),
    cargarStock(),
    cargarOrgFiscal(),
    cargarReciboConfig().catch(()=>{}),
  ]);
  _offSaveSnapshot(_uid);
  } catch (_e) {
    // Falló el arranque online (sin conexión). Intentamos abrir con el snapshot.
    if (_offHydrate(_uid)) {
      _offlineMode = true;
      document.getElementById('t-org').textContent = orgName || '';
      if (_isAdmin()) {
        const _fb = document.getElementById('tab-finanzas-btn'); if (_fb) _fb.style.display = '';
        const _cb = document.getElementById('tab-config-btn');   if (_cb) _cb.style.display = '';
        const _ab = document.getElementById('btn-add-prod-toolbar'); if (_ab) _ab.style.display = '';
      }
    } else {
      toast('Sin conexión y sin datos guardados todavía. Entrá una vez con internet para poder usar el POS sin conexión.', 'err');
      return;
    }
  }

  renderProductGrid();
  renderCart();
  renderStock();
  if (!_offlineMode) startDashMini();

  document.getElementById('prod-q').addEventListener('input', (e) => {
    _searchProd = e.target.value.toLowerCase();
    renderProductGrid();
  });
  document.getElementById('cli-q').addEventListener('input', onClienteInput);
  document.getElementById('cart-handle')?.addEventListener('click', () => {
    document.getElementById('pos-cart').classList.toggle('open');
  });
  if (!_offlineMode) await _loadTiposEnvase();
  _wireEnvasesUI();
  const strictCb = document.getElementById('stock-strict-toggle');
  if (strictCb) strictCb.addEventListener('change', () => { _stockStrict = strictCb.checked; });

  const factCb     = document.getElementById('fact-toggle');
  const factTipo   = document.getElementById('fact-tipo');
  if (factCb && factTipo) {
    factCb.addEventListener('change', () => {
      factTipo.style.display = factCb.checked ? '' : 'none';
    });
  }

  const descInp  = document.getElementById('pos-descuento');
  const descTipo = document.getElementById('pos-descuento-tipo');
  if (descInp)  descInp.addEventListener('input', renderCart);
  if (descTipo) descTipo.addEventListener('change', renderCart);

  if (!_offlineMode) {
    sb.rpc('pos_get_or_create_cliente_mostrador', { p_org_id: orgId })
      .then(({ data }) => { clienteMostradorId = data; })
      .catch(() => {/* no crítico */});
  }

  _offInitUI();
}

async function cargarProductos(){
  const { data, error } = await sb.from('productos')
    .select('id, nombre, precio, precio_pos, costo, unidad, litros, tiene_envase, tipo_envase_id, codigo_barra, es_combo, peso_variable, fecha_vencimiento, descuento_volumen_qty, descuento_volumen_pct')
    .eq('organization_id', orgId)
    .eq('activo', true)
    .order('es_combo', { ascending: false })
    .order('litros', { ascending: false, nullsFirst: false })
    .order('nombre');
  if (error) { console.error(error); toast('Error productos: '+error.message, 'err'); return; }
  productos = (data || []).map(p => ({
    ...p,
    precio: (p.precio_pos != null && p.precio_pos !== '') ? parseFloat(p.precio_pos) : p.precio,
    precio_reparto: p.precio,
    precio_pos_falta: (p.precio_pos == null || p.precio_pos === ''),
  }));
  await _aplicarRankingProductos();
}

async function _aplicarRankingProductos() {
  try {
    const { data, error } = await sb.rpc('pos_productos_ranking', {
      p_organization_id: orgId,
      p_tienda_id:       tiendaId || null,
      p_dias:            90,
    });
    if (error) { console.warn('ranking productos:', error.message); return; }
    const rank = new Map((data || []).map(r => [r.producto_id, Number(r.ventas) || 0]));
    productos.forEach(p => { p._ventas = rank.get(p.id) || 0; });
    productos.sort((a, b) => (b._ventas || 0) - (a._ventas || 0));
  } catch (e) { console.warn('ranking productos:', e); }
}

let orgFiscal = { cuit: null, direccion: null, telefono: null };
async function cargarOrgFiscal() {
  const [orgRes, cfgRes] = await Promise.allSettled([
    sb.from('organizations')
      .select('email, telefono')
      .eq('id', orgId)
      .maybeSingle(),
    sb.from('org_config')
      .select('direccion, telefono, factura_cuit, factura_logo_url')
      .eq('organization_id', orgId)
      .maybeSingle(),
  ]);
  const org = orgRes.status === 'fulfilled' ? (orgRes.value?.data || null) : null;
  const cfg = cfgRes.status === 'fulfilled' ? (cfgRes.value?.data || null) : null;
  orgFiscal = {
    cuit:      cfg?.factura_cuit || null,
    direccion: cfg?.direccion    || null,
    telefono:  cfg?.telefono     || org?.telefono || null,
    email:     org?.email        || null,
    logo_url:  cfg?.factura_logo_url || null,
  };
}

async function cargarStock(){
  if (!tiendaId) { stockMap = new Map(); return; }
  const { data, error } = await sb.from('stock_mostrador')
    .select('producto_id, cantidad')
    .eq('organization_id', orgId)
    .eq('tienda_id', tiendaId);
  if (error) { console.warn('stock_mostrador:', error.message); return; }
  stockMap = new Map((data || []).map(r => [r.producto_id, r.cantidad]));
  await cargarEnvasesTienda();
}

async function cargarEnvasesTienda() {
  const card = document.getElementById('stock-envases-card');
  if (!card) return;
  if (!tiendaId) { card.innerHTML = ''; return; }
  card.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:14px;text-align:center">Cargando envases…</div>';
  const { data, error } = await sb.rpc('stock_mostrador_resumen_por_tipo', {
    p_org: orgId, p_tienda: tiendaId,
  });
  if (error) { console.warn('envases tienda:', error); card.innerHTML = ''; return; }
  const filas = data || [];
  if (filas.length === 0) {
    card.innerHTML = `
      <div style="background:rgba(102,126,234,.04);border:1px dashed var(--border);border-radius:12px;padding:14px;text-align:center;font-size:12px;color:var(--muted)">
        🫙 Sin envases retornables todavía en esta tienda.
      </div>`;
    return;
  }
  const totL = filas.reduce((s, r) => s + (r.llenos || 0), 0);
  const totV = filas.reduce((s, r) => s + (r.vacios || 0), 0);
  card.innerHTML = `
    <div style="background:#fff;border:1px solid var(--border);border-radius:12px;padding:12px 14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">🫙 Envases en esta tienda</div>
        <div style="font-size:12px;color:var(--muted)"><b style="color:var(--primary)">${totL}</b> llenos · <b style="color:#b45309">${totV}</b> vacíos</div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 70px 70px;gap:8px;font-size:10px;color:var(--muted);font-weight:700;text-transform:uppercase;padding:0 8px 6px">
        <div>Tipo</div>
        <div style="text-align:center">💧 Llenos</div>
        <div style="text-align:center">↩️ Vacíos</div>
      </div>
      ${filas.map(r => `
        <div style="display:grid;grid-template-columns:1fr 70px 70px;gap:8px;align-items:center;padding:8px;background:rgba(102,126,234,.04);border-radius:8px;margin-bottom:4px;font-size:13px">
          <div style="font-weight:600">${r.tipo_nombre}${r.capacidad_litros ? ' · ' + r.capacidad_litros + 'L' : ''}</div>
          <div style="text-align:center;color:var(--primary);font-weight:700">${r.llenos}</div>
          <div style="text-align:center;color:#b45309;font-weight:700">${r.vacios}</div>
        </div>
      `).join('')}
      <div style="font-size:10px;color:var(--muted);padding:6px 8px 0;line-height:1.4">
        ℹ️ Vacíos van a la tienda al recibirlos (no al depósito central). Para transferirlos al depósito, hacelo desde el módulo Envases del dashboard.
      </div>
    </div>`;
}

// ── MULTI-TIENDA ─────────────────────────────────────
let tiendaLocked = false;
async function cargarTiendas() {
  const { data, error } = await sb.rpc('pos_listar_tiendas', { p_organization_id: orgId });
  if (error) { console.warn('cargarTiendas:', error); tiendas = []; }
  else tiendas = (data || []).filter(t => t.activo);

  // Onboarding: una organización nueva no tiene tiendas. Si es admin, creamos
  // una tienda principal por defecto para que el POS quede operativo desde el
  // primer ingreso (sin esto el selector queda en "Cargando tiendas…").
  if (!tiendas.length && _isAdmin()) {
    try {
      const { error: cErr } = await sb.rpc('pos_crear_tienda', {
        p_organization_id: orgId, p_nombre: (_provisionTiendaNombre || 'Casa central'), p_direccion: null, p_telefono: null,
      });
      if (!cErr) {
        const { data: d2 } = await sb.rpc('pos_listar_tiendas', { p_organization_id: orgId });
        tiendas = (d2 || []).filter(t => t.activo);
      }
    } catch (_) {}
  }

  if (!tiendas.length) {
    tiendaId = null;
    const sel = document.getElementById('t-tienda');
    if (sel) sel.innerHTML = '<option value="">— Sin tiendas —</option>';
    return;
  }
  tiendaLocked = !!(tiendas[0]?.lock);

  if (tiendaLocked) {
    tiendaId = tiendas[0].id;
    localStorage.setItem('pos_tienda_' + orgId, tiendaId);
  } else {
    const stored = localStorage.getItem('pos_tienda_' + orgId);
    if (stored && tiendas.find(t => t.id === stored)) {
      tiendaId = stored;
    } else {
      const principal = tiendas.find(t => t.es_principal);
      tiendaId = principal?.id || tiendas[0].id;
    }
  }

  const sel = document.getElementById('t-tienda');
  if (sel) {
    sel.innerHTML = '';
    tiendas.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = (t.es_principal ? '★ ' : '') + t.nombre;
      if (t.id === tiendaId) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.disabled = tiendaLocked;
    sel.title = tiendaLocked
      ? 'Tu usuario está asignado a esta tienda'
      : 'Cambiar de tienda';
    sel.style.opacity = tiendaLocked ? '0.7' : '1';
    sel.style.cursor = tiendaLocked ? 'not-allowed' : 'pointer';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('t-tienda')?.addEventListener('change', async (e) => {
    const newId = e.target.value;
    if (!newId || newId === tiendaId) return;
    if (cart.size > 0) {
      const itemsLista = Array.from(cart.values()).map(it => `${it.cantidad}× ${it.nombre}`);
      const ok = await tmvDialog.confirm(
        'Si cambiás de tienda, los productos del carrito se van a borrar.',
        { title: 'Vaciar carrito al cambiar de tienda', severity: 'warning',
          items: itemsLista, okLabel: 'Cambiar y vaciar', cancelLabel: 'No cambiar' }
      );
      if (!ok) {
        e.target.value = tiendaId;
        return;
      }
      cart.clear();
      renderCart();
    }
    tiendaId = newId;
    localStorage.setItem('pos_tienda_' + orgId, tiendaId);
    await cargarStock();
    renderProductGrid();
    renderStock();
    const activeTab = document.querySelector('.topbar-tab.active')?.dataset?.tab;
    if (activeTab === 'caja')   renderCaja();
    if (activeTab === 'recibo') renderReciboConfig();
    if (activeTab === 'envases') renderEnvases();
    toast('Cambiaste a ' + (tiendas.find(t => t.id === tiendaId)?.nombre || 'otra tienda'), 'ok');
  });
});

// ── TAB TIENDAS — CRUD ───────────────────────────────
async function renderTiendas() {
  const wrap = document.getElementById('tiendas-wrap');
  if (!wrap) return;
  const isAdmin = ['client_admin','account_manager','super_admin'].includes(userRole);
  if (!isAdmin) {
    wrap.innerHTML = '<div class="env-empty" style="background:#fff;border:1px solid var(--border);border-radius:14px">Solo administradores pueden gestionar tiendas.</div>';
    return;
  }
  await cargarTiendas();

  let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">' +
    '<h3 style="font-size:14px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:0">Tiendas / Puntos de venta</h3>' +
    '<button id="tienda-add" type="button" style="padding:8px 16px;border-radius:50px;border:1.5px solid var(--primary);background:rgba(124,58,237,.06);color:var(--primary);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">+ Nueva tienda</button>' +
    '</div>';

  if (!tiendas.length) {
    html += '<div class="env-empty" style="background:#fff;border:1px solid var(--border);border-radius:14px">Sin tiendas aún.</div>';
  } else {
    tiendas.forEach((t, i) => {
      html += '<div class="tienda-card' + (t.es_principal ? ' principal' : '') + (t.activo ? '' : ' inactiva') + '">' +
        '<div class="tienda-card-info">' +
        '  <div class="tienda-card-nm">' +
        '    <span class="nm"></span>' +
        (t.es_principal ? '<span class="pp">Principal</span>' : '') +
        (t.activo ? '' : '<span style="font-size:10px;color:var(--muted)">inactiva</span>') +
        '  </div>' +
        '  <div class="tienda-card-meta dir"></div>' +
        '</div>' +
        '<div class="tienda-card-actions">' +
        '  <button type="button" data-edit="' + t.id + '">Editar</button>' +
        (t.es_principal ? '' : '  <button type="button" data-toggle="' + t.id + '">' + (t.activo ? 'Desactivar' : 'Activar') + '</button>') +
        '</div>' +
        '</div>';
    });
  }
  wrap.innerHTML = html;

  tiendas.forEach((t, i) => {
    const card = wrap.querySelectorAll('.tienda-card')[i];
    if (!card) return;
    card.querySelector('.nm').textContent = t.nombre;
    const dirEls = [];
    if (t.direccion) dirEls.push(t.direccion);
    if (t.telefono) dirEls.push('Tel: ' + t.telefono);
    card.querySelector('.dir').textContent = dirEls.join(' · ') || '—';
  });

  document.getElementById('tienda-add').addEventListener('click', () => abrirModalTienda(null));
  wrap.querySelectorAll('button[data-edit]').forEach(b => {
    b.addEventListener('click', () => {
      const t = tiendas.find(x => x.id === b.dataset.edit);
      if (t) abrirModalTienda(t);
    });
  });
  wrap.querySelectorAll('button[data-toggle]').forEach(b => {
    b.addEventListener('click', async () => {
      const t = tiendas.find(x => x.id === b.dataset.toggle);
      if (!t) return;
      const { error } = await sb.rpc('pos_actualizar_tienda', {
        p_tienda_id: t.id, p_nombre: t.nombre, p_direccion: t.direccion,
        p_telefono: t.telefono, p_activo: !t.activo,
      });
      if (error) { tmvShowError(error); return; }
      toast(t.activo ? 'Desactivada' : 'Activada', 'ok');
      renderTiendas();
    });
  });
}

function abrirModalTienda(t) {
  const isEdit = !!t;
  const nombre = prompt(isEdit ? 'Nombre de la tienda:' : 'Nombre de la nueva tienda:', t?.nombre || '');
  if (nombre == null || !nombre.trim()) return;
  const direccion = prompt('Dirección (opcional):', t?.direccion || '') || null;
  const telefono = prompt('Teléfono (opcional):', t?.telefono || '') || null;

  (async () => {
    if (isEdit) {
      const { error } = await sb.rpc('pos_actualizar_tienda', {
        p_tienda_id: t.id, p_nombre: nombre.trim(),
        p_direccion: direccion, p_telefono: telefono, p_activo: t.activo,
      });
      if (error) { tmvShowError(error); return; }
      toast('Tienda actualizada ✓', 'ok');
    } else {
      const { error } = await sb.rpc('pos_crear_tienda', {
        p_organization_id: orgId,
        p_nombre: nombre.trim(),
        p_direccion: direccion, p_telefono: telefono,
      });
      if (error) { tmvShowError(error); return; }
      toast('Tienda creada ✓', 'ok');
    }
    await cargarTiendas();
    renderTiendas();
  })();
}

window.hacerLogout = async () => {
  await sb.auth.signOut();
  window.location.replace('login.html');
};

// ── LOCK POR INACTIVIDAD ─────────────────────────────
const LOCK_AFTER_MS = 5 * 60 * 1000;
let _lockTimer = null;
let _lockUserEmail = null;

function _resetLockTimer() {
  if (_lockTimer) clearTimeout(_lockTimer);
  _lockTimer = setTimeout(_lockNow, LOCK_AFTER_MS);
}
function _lockNow() {
  if (document.getElementById('qr-overlay')?.classList.contains('show')) {
    _resetLockTimer();
    return;
  }
  const ov = document.getElementById('lock-overlay');
  if (ov && !ov.classList.contains('show')) {
    document.getElementById('lock-pass').value = '';
    const sub = document.getElementById('lock-sub');
    if (sub && _lockUserEmail) sub.textContent = 'Sesión de ' + _lockUserEmail + ' · ingresá la contraseña';
    ov.classList.add('show');
    setTimeout(() => document.getElementById('lock-pass')?.focus(), 50);
  }
}
async function _intentarUnlock() {
  const pass = document.getElementById('lock-pass').value;
  if (!pass) { toast('Ingresá la contraseña', 'warn'); return; }
  if (!_lockUserEmail) { toast('Sesión expirada', 'err'); window.location.replace('login.html'); return; }
  const { error } = await sb.auth.signInWithPassword({ email: _lockUserEmail, password: pass });
  if (error) { toast('Contraseña incorrecta', 'err'); return; }
  document.getElementById('lock-overlay').classList.remove('show');
  document.getElementById('lock-pass').value = '';
  _resetLockTimer();
}

document.addEventListener('DOMContentLoaded', () => {
  ['click','keydown','touchstart','mousemove'].forEach(ev =>
    document.addEventListener(ev, () => {
      if (!document.getElementById('lock-overlay')?.classList.contains('show')) _resetLockTimer();
    }, { passive: true }));
  document.getElementById('lock-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    _intentarUnlock();
  });
  document.getElementById('lock-logout')?.addEventListener('click', () => hacerLogout());
});

// ── ATAJOS DE TECLADO ────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (document.getElementById('lock-overlay')?.classList.contains('show')) return;

  const tag = (e.target?.tagName || '').toLowerCase();
  const enInput = tag === 'input' || tag === 'textarea';

  if (e.key === 'Escape') {
    ['qr-overlay', 'mix-overlay', 'receipt-overlay'].forEach(id => {
      const ov = document.getElementById(id);
      if (ov?.classList?.contains('show')) {
        if (id === 'qr-overlay') _detenerQrPolling();
        ov.classList.remove('show');
      }
    });
    return;
  }

  if (e.key === 'Backspace' && (e.ctrlKey || e.metaKey) && !enInput) {
    e.preventDefault();
    if (cart.size && confirm('¿Vaciar el carrito?')) vaciarCarrito();
    return;
  }

  if (e.key === 'F1') { e.preventDefault(); cobrar('efectivo'); return; }
  if (e.key === 'F2') { e.preventDefault(); cobrar('transferencia'); return; }
  if (e.key === 'F3') { e.preventDefault(); cobrar('mercadopago'); return; }
  if (e.key === 'F4') { e.preventDefault(); abrirCobroMixto(); return; }
  if (e.key === 'F5') { e.preventDefault(); document.getElementById('prod-q')?.focus(); return; }
  if (e.key === 'F6') { e.preventDefault(); document.getElementById('cli-q')?.focus(); return; }
  if (/^F([7-9]|1[0-2])$/.test(e.key)) {
    e.preventDefault();
    const slot = parseInt(e.key.slice(1), 10) - 6;
    if (e.shiftKey) {
      _configurarFavorito(slot);
    } else {
      _agregarFavorito(slot);
    }
    return;
  }

  if (e.key === 'Enter' && e.target?.id === 'cli-q') {
    const first = document.querySelector('#cli-suggest .pos-cliente-suggest-item');
    if (first) first.click();
  }
});

window.goTab = (tab) => {
  document.querySelectorAll('.topbar-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + tab).classList.add('active');
  if (tab === 'ventas')   cargarVentasHoy();
  if (tab === 'reservas') cargarReservas();
  if (tab === 'reportes') initReportesUI();
  if (tab === 'stock')    renderStock();
  if (tab === 'caja')     renderCaja();
  if (tab === 'envases')  renderEnvases();
  if (tab === 'finanzas') renderFinanzas();
  if (tab === 'config')   renderConfig();
};

// ── PROMOS (configuración) ───────────────────────────
let _promoEdit = null;
window._promosCache = [];
function _promoResumen(pr) {
  if (pr.tipo === 'nxm')         return 'Llevás ' + pr.llevas + ' · Pagás ' + pr.paga;
  if (pr.tipo === 'precio_fijo') return pr.cantidad + ' u. por ' + fmtARS(pr.precio_total);
  if (pr.tipo === 'pct')         return pr.pct + '% off' + (pr.min_cantidad > 1 ? ' (desde ' + pr.min_cantidad + ')' : '');
  return '';
}
async function renderPromosConfig() {
  const wrap = document.getElementById('promos-wrap');
  if (!wrap) return;
  const isAdmin = ['client_admin','account_manager','super_admin'].includes(userRole);
  if (!isAdmin) { wrap.innerHTML = '<div style="padding:30px;text-align:center;color:var(--muted)">Solo administradores.</div>'; return; }
  wrap.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';
  const { data, error } = await sb.rpc('promos_pos_list', { p_organization_id: orgId, p_solo_vigentes: false });
  if (error) { wrap.innerHTML = '<div style="color:var(--danger);padding:20px">Error: ' + error.message + '</div>'; return; }
  const promos = data?.promos || [];
  window._promosCache = promos;
  const prods = (productos || []).filter(p => p.activo !== false);
  const e = _promoEdit || {};
  const esc = s => (s == null ? '' : String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])));
  const opt = (v, t, sel) => '<option value="' + v + '"' + (sel ? ' selected' : '') + '>' + esc(t) + '</option>';
  const prodOpts = prods.map(p => opt(p.id, p.nombre, e.producto_id === p.id)).join('');
  const tipo = e.tipo || 'nxm';

  let html = '<div class="recibo-card">' +
    '<div style="font-size:18px;font-weight:800;margin-bottom:14px">🎁 Promos</div>' +
    '<div class="recibo-section">' +
      '<div class="recibo-section-h">' + (_promoEdit ? 'Editar promo' : 'Nueva promo') + '</div>' +
      '<input id="pm-nombre" class="prod-form-i" style="width:100%;margin-bottom:8px" placeholder="Nombre (ej: 2x1 Gaseosa 600ml)" maxlength="60" value="' + esc(e.nombre) + '">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">' +
        '<select id="pm-tipo" class="prod-form-i" onchange="window._promoTipoChange()">' +
          opt('nxm','NxM (2x1, 3x2)', tipo==='nxm') + opt('precio_fijo','Precio fijo por cantidad', tipo==='precio_fijo') + opt('pct','% off por cantidad', tipo==='pct') +
        '</select>' +
        '<select id="pm-prod" class="prod-form-i">' + prodOpts + '</select>' +
      '</div>' +
      '<div id="pm-nxm" style="display:' + (tipo==='nxm'?'grid':'none') + ';grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">' +
        '<label style="font-size:11px;color:var(--muted)">Llevás<input id="pm-llevas" type="number" min="1" class="prod-form-i" style="width:100%" value="' + (e.llevas || 2) + '"></label>' +
        '<label style="font-size:11px;color:var(--muted)">Pagás<input id="pm-paga" type="number" min="0" class="prod-form-i" style="width:100%" value="' + (e.paga != null ? e.paga : 1) + '"></label>' +
      '</div>' +
      '<div id="pm-pf" style="display:' + (tipo==='precio_fijo'?'grid':'none') + ';grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">' +
        '<label style="font-size:11px;color:var(--muted)">Cantidad<input id="pm-cantidad" type="number" min="1" class="prod-form-i" style="width:100%" value="' + (e.cantidad || 3) + '"></label>' +
        '<label style="font-size:11px;color:var(--muted)">Precio total<input id="pm-precio-total" type="number" min="0" step="0.01" class="prod-form-i" style="width:100%" value="' + (e.precio_total != null ? e.precio_total : '') + '"></label>' +
      '</div>' +
      '<div id="pm-pct" style="display:' + (tipo==='pct'?'grid':'none') + ';grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">' +
        '<label style="font-size:11px;color:var(--muted)">% descuento<input id="pm-pct-val" type="number" min="1" max="100" step="0.01" class="prod-form-i" style="width:100%" value="' + (e.pct != null ? e.pct : '') + '"></label>' +
        '<label style="font-size:11px;color:var(--muted)">Desde (cant.)<input id="pm-min" type="number" min="1" class="prod-form-i" style="width:100%" value="' + (e.min_cantidad || 1) + '"></label>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px">' +
        '<label style="font-size:11px;color:var(--muted)">Vigente desde<input id="pm-desde" type="date" class="prod-form-i" style="width:100%" value="' + (e.vigente_desde || '') + '"></label>' +
        '<label style="font-size:11px;color:var(--muted)">Vigente hasta<input id="pm-hasta" type="date" class="prod-form-i" style="width:100%" value="' + (e.vigente_hasta || '') + '"></label>' +
      '</div>' +
      '<label class="recibo-toggle" style="margin-bottom:10px"><span>Activa</span><input id="pm-activo" type="checkbox"' + (e.activo === false ? '' : ' checked') + '></label>' +
      '<div style="display:flex;gap:8px">' +
        '<button onclick="window._promoGuardar()" style="flex:1;padding:12px;border-radius:10px;border:none;background:var(--primary);color:#fff;font-weight:700;cursor:pointer">' + (_promoEdit ? 'Guardar cambios' : 'Crear promo') + '</button>' +
        (_promoEdit ? '<button onclick="window._promoCancelarEdit()" style="padding:12px 16px;border-radius:10px;border:1px solid var(--border);background:#fff;font-weight:600;cursor:pointer">Cancelar</button>' : '') +
      '</div>' +
    '</div>';

  html += '<div class="recibo-section"><div class="recibo-section-h">Promos cargadas (' + promos.length + ')</div>';
  if (!promos.length) html += '<div style="color:var(--muted);font-size:13px;padding:8px 0">Todavía no cargaste promos.</div>';
  else html += promos.map(pr =>
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--border)">' +
      '<div style="min-width:0"><div style="font-weight:700;font-size:13px">' + (pr.activo ? '' : '🚫 ') + esc(pr.nombre) + '</div>' +
      '<div style="font-size:11px;color:var(--muted)">' + _promoResumen(pr) + (pr.producto_nombre ? ' · ' + esc(pr.producto_nombre) : '') + '</div></div>' +
      '<div style="display:flex;gap:6px;flex-shrink:0">' +
        '<button onclick="window._promoEditar(\'' + pr.id + '\')" style="padding:5px 10px;border:1px solid var(--border);background:#fff;border-radius:7px;font-size:12px;cursor:pointer">✏️</button>' +
        '<button onclick="window._promoBorrar(\'' + pr.id + '\')" style="padding:5px 10px;border:1px solid rgba(239,68,68,.4);background:#fff;color:#dc2626;border-radius:7px;font-size:12px;cursor:pointer">🗑</button>' +
      '</div></div>'
  ).join('');
  html += '</div></div>';
  wrap.innerHTML = html;
}
window._promoTipoChange = () => {
  const t = document.getElementById('pm-tipo').value;
  document.getElementById('pm-nxm').style.display = t==='nxm' ? 'grid' : 'none';
  document.getElementById('pm-pf').style.display  = t==='precio_fijo' ? 'grid' : 'none';
  document.getElementById('pm-pct').style.display = t==='pct' ? 'grid' : 'none';
};
window._promoEditar = (id) => { _promoEdit = (window._promosCache || []).find(p => p.id === id) || null; renderPromosConfig(); };
window._promoCancelarEdit = () => { _promoEdit = null; renderPromosConfig(); };
window._promoBorrar = async (id) => {
  if (!confirm('¿Borrar esta promo?')) return;
  const { data, error } = await sb.rpc('promos_pos_delete', { p_id: id });
  if (error || !data?.ok) { toast('Error: ' + (error?.message || 'no se pudo'), 'err'); return; }
  toast('Promo borrada', 'ok');
  if (_promoEdit?.id === id) _promoEdit = null;
  renderPromosConfig();
};
window._promoGuardar = async () => {
  const tipo = document.getElementById('pm-tipo').value;
  const params = {
    p_organization_id: orgId,
    p_id: _promoEdit?.id || null,
    p_nombre: document.getElementById('pm-nombre').value.trim(),
    p_tipo: tipo,
    p_producto_id: document.getElementById('pm-prod').value || null,
    p_llevas: null, p_paga: null, p_cantidad: null, p_precio_total: null, p_pct: null,
    p_min_cantidad: 1,
    p_vigente_desde: document.getElementById('pm-desde').value || null,
    p_vigente_hasta: document.getElementById('pm-hasta').value || null,
    p_activo: document.getElementById('pm-activo').checked,
  };
  if (!params.p_nombre) { toast('Poné un nombre', 'warn'); return; }
  if (tipo === 'nxm') { params.p_llevas = parseInt(document.getElementById('pm-llevas').value) || 0; params.p_paga = parseInt(document.getElementById('pm-paga').value); }
  if (tipo === 'precio_fijo') { params.p_cantidad = parseInt(document.getElementById('pm-cantidad').value) || 0; params.p_precio_total = parseFloat(document.getElementById('pm-precio-total').value); }
  if (tipo === 'pct') { params.p_pct = parseFloat(document.getElementById('pm-pct-val').value); params.p_min_cantidad = parseInt(document.getElementById('pm-min').value) || 1; }
  const { data, error } = await sb.rpc('promos_pos_upsert', params);
  if (error || !data?.ok) { toast('Error: ' + (error?.message || 'no se pudo guardar'), 'err'); return; }
  toast(_promoEdit ? 'Promo actualizada' : 'Promo creada', 'ok');
  _promoEdit = null;
  renderPromosConfig();
};

// ── PROMOS (aplicar en el POS) ───────────────────────
window.aplicarPromoPOS = async () => {
  const { data, error } = await sb.rpc('promos_pos_list', { p_organization_id: orgId, p_solo_vigentes: true });
  if (error) { toast('Error: ' + error.message, 'err'); return; }
  const promos = (data?.promos || []).filter(p => p.producto_id);
  if (!promos.length) { toast('No hay promos vigentes', 'info'); return; }
  let ov = document.getElementById('promo-pick-ov');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'promo-pick-ov';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px';
  const esc = s => (s == null ? '' : String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])));
  ov.innerHTML = '<div style="background:#fff;border-radius:16px;padding:20px;max-width:440px;width:100%;max-height:85vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">' +
    '<div style="font-size:16px;font-weight:800;margin-bottom:12px">🎁 Elegí una promo</div>' +
    promos.map((p, i) =>
      '<button class="promo-pick" data-i="' + i + '" style="display:block;width:100%;text-align:left;padding:12px;margin-bottom:8px;border:1px solid var(--border);border-radius:10px;background:#fff;cursor:pointer">' +
        '<div style="font-weight:700;font-size:14px">' + esc(p.nombre) + '</div>' +
        '<div style="font-size:12px;color:#64748b">' + _promoResumen(p) + (p.producto_nombre ? ' · ' + esc(p.producto_nombre) : '') + '</div>' +
      '</button>'
    ).join('') +
    '<button id="promo-pick-cancel" style="width:100%;padding:10px;border:1px solid var(--border);background:#fff;border-radius:10px;font-weight:600;cursor:pointer;margin-top:4px">Cancelar</button>' +
    '</div>';
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  ov.querySelector('#promo-pick-cancel').addEventListener('click', () => ov.remove());
  ov.querySelectorAll('.promo-pick').forEach(btn => btn.addEventListener('click', () => {
    _aplicarPromoAlCarrito(promos[parseInt(btn.dataset.i)]);
    ov.remove();
  }));
};
function _aplicarPromoAlCarrito(pr) {
  const prod = (productos || []).find(p => p.id === pr.producto_id);
  if (!prod) { toast('El producto de la promo no está disponible', 'warn'); return; }
  const base = parseFloat(prod.precio) || 0;
  let N, unit;
  if (pr.tipo === 'nxm')              { N = pr.llevas;       unit = N > 0 ? (pr.paga * base) / N : base; }
  else if (pr.tipo === 'precio_fijo') { N = pr.cantidad;     unit = N > 0 ? pr.precio_total / N : 0; }
  else                                { N = pr.min_cantidad || 1; unit = base * (1 - (pr.pct || 0) / 100); }
  unit = Math.round(unit * 100) / 100;
  cart.set(prod.id, {
    cantidad: N,
    precio: unit,
    nombre: prod.nombre,
    tiene_envase: !!prod.tiene_envase,
    envase_modo: prod.tiene_envase ? 'comodato' : 'no_aplica',
    promo: { nombre: pr.nombre },
  });
  renderCart();
  renderProductGrid();
  toast('🎁 Promo aplicada: ' + pr.nombre, 'ok');
  if (window.innerWidth <= 760) document.getElementById('pos-cart')?.classList.add('open');
}

// ── CAJA DIARIA ──────────────────────────────────────
let _cajaActual = null;
async function renderCaja() {
  const wrap = document.getElementById('caja-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';

  const { data, error } = await sb.rpc('pos_caja_actual', { p_organization_id: orgId, p_tienda_id: tiendaId });
  if (error) {
    wrap.innerHTML = '<div style="background:rgba(239,68,68,.08);border:1.5px solid rgba(239,68,68,.3);border-radius:14px;padding:16px;color:var(--danger)">Error: ' + error.message + '</div>';
    return;
  }
  _cajaActual = data?.caja || null;
  if (!_cajaActual) {
    _renderAbrirCaja(wrap);
  } else {
    _renderCajaAbierta(wrap, _cajaActual);
  }
}

async function _renderAbrirCaja(wrap) {
  wrap.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'caja-card';
  card.innerHTML =
    '<div class="caja-h"><div class="caja-title">Abrir caja general</div><span class="caja-badge cerrada">Sin caja</span></div>' +
    '<div class="caja-meta">Es una <b>caja única para toda la tienda</b>: la abrís una vez y la usan todos los cajeros del día. Declará el efectivo con el que arranca. Al cerrar, el sistema muestra cuánto debería haber y la diferencia con lo contado físicamente.</div>' +
    '<div class="caja-form">' +
    '  <label for="caja-apertura">Monto inicial en caja (efectivo)</label>' +
    '  <input id="caja-apertura" type="number" min="0" step="1" placeholder="0">' +
    '  <div id="caja-arrastre-hint" class="caja-meta" style="margin-top:-6px"></div>' +
    '  <label for="caja-notas">Notas (opcional)</label>' +
    '  <textarea id="caja-notas" rows="2" placeholder="Observaciones del turno…"></textarea>' +
    '  <button id="caja-btn-abrir">Abrir caja</button>' +
    '</div>';
  wrap.appendChild(card);

  try {
    const { data: arr } = await sb.rpc('pos_caja_arrastre_sugerido', { p_organization_id: orgId, p_tienda_id: tiendaId });
    const sug = Number(arr?.sugerido || 0);
    if (sug > 0) {
      card.querySelector('#caja-apertura').value = sug;
      const quien  = arr?.cerrada_por ? (' por ' + arr.cerrada_por) : '';
      const cuando = arr?.cerrada_at  ? (' · ' + new Date(arr.cerrada_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })) : '';
      const hint = card.querySelector('#caja-arrastre-hint');
      if (hint) hint.innerHTML = '↩ Arrastrado del cierre anterior' + quien + cuando + ': <b>' + fmtARS(sug) + '</b>. Editá si contás algo distinto.';
    }
  } catch (_) {}

  card.querySelector('#caja-btn-abrir').addEventListener('click', async (e) => {
    const monto = parseFloat(document.getElementById('caja-apertura').value) || 0;
    const notas = document.getElementById('caja-notas').value || null;
    e.target.disabled = true;
    const { data, error } = await sb.rpc('pos_abrir_caja', {
      p_organization_id: orgId,
      p_monto_apertura: monto,
      p_notas: notas,
      p_tienda_id: tiendaId,
    });
    if (error) { tmvShowError(error); e.target.disabled = false; return; }
    if (!data?.ok) { alert('No se pudo abrir caja'); e.target.disabled = false; return; }
    toast('Caja abierta ✓', 'ok');
    renderCaja();
  });
}

function _renderCajaAbierta(wrap, caja) {
  wrap.innerHTML = '';
  const abiertaStr = new Date(caja.abierta_at).toLocaleString('es-AR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
  const ingresos = Number(caja.ingresos || 0);
  const egresos  = Number(caja.egresos  || 0);
  const cobradoCC = Number(caja.cobrado_cc || 0);
  const pc = caja.por_cajero || [];
  const porCajeroHtml = pc.length ? (
    '<div style="margin-bottom:14px"><div style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">🧑‍💼 Ventas por cajero</div>' +
    '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
    '<thead><tr style="color:var(--muted);text-align:right"><th style="text-align:left;padding:3px 6px">Cajero</th><th style="padding:3px 6px">Vtas</th><th style="padding:3px 6px">Efvo</th><th style="padding:3px 6px">Transf</th><th style="padding:3px 6px">Total</th></tr></thead><tbody>' +
    pc.map(c => '<tr style="text-align:right;border-top:1px solid var(--border)"><td style="text-align:left;padding:3px 6px">' + (c.cajero_nombre || '—') + '</td><td style="padding:3px 6px">' + (c.ventas || 0) + '</td><td style="padding:3px 6px">' + fmtARS(c.efectivo) + '</td><td style="padding:3px 6px">' + fmtARS(c.transf) + '</td><td style="padding:3px 6px;font-weight:700">' + fmtARS(c.total) + '</td></tr>').join('') +
    '</tbody></table></div></div>'
  ) : '';
  const card = document.createElement('div');
  card.className = 'caja-card';
  card.innerHTML =
    '<div class="caja-h"><div class="caja-title">Caja general</div><span class="caja-badge abierta">Abierta</span></div>' +
    '<div class="caja-meta">Abierta por <b>' + (caja.abierta_por_nombre || '—') + '</b> · <b>' + abiertaStr + '</b><br>Apertura: <b>' + fmtARS(caja.monto_apertura) + '</b> · <span style="color:var(--primary)">Caja única compartida por toda la tienda</span></div>' +
    '<div class="caja-stats">' +
    '  <div class="caja-stat"><div class="caja-stat-l">💵 Efectivo cobrado' + iHelp(INFO.efectivo) + '</div><div class="caja-stat-v">' + fmtARS(caja.cobrado_efectivo) + '</div></div>' +
    '  <div class="caja-stat"><div class="caja-stat-l">📱 MercadoPago' + iHelp(INFO.mercadopago) + '</div><div class="caja-stat-v">' + fmtARS(caja.cobrado_mp) + '</div></div>' +
    '  <div class="caja-stat"><div class="caja-stat-l">🏦 Transferencia' + iHelp(INFO.transferencia) + '</div><div class="caja-stat-v">' + fmtARS(caja.cobrado_transferencia) + '</div></div>' +
    '  <div class="caja-stat"><div class="caja-stat-l">💳 Débito' + iHelp(INFO.debito) + '</div><div class="caja-stat-v">' + fmtARS(caja.cobrado_debito || 0) + '</div></div>' +
    '  <div class="caja-stat"><div class="caja-stat-l">💳 Crédito' + iHelp(INFO.credito) + '</div><div class="caja-stat-v">' + fmtARS(caja.cobrado_credito || 0) + '</div></div>' +
    '  <div class="caja-stat"><div class="caja-stat-l">💳 Cuenta corriente' + iHelp(INFO.cuenta_corriente) + '</div><div class="caja-stat-v">' + fmtARS(cobradoCC) + '</div></div>' +
    (ingresos > 0 ? '  <div class="caja-stat"><div class="caja-stat-l">↑ Ingresos extra' + iHelp(INFO.ingresos_extra) + '</div><div class="caja-stat-v">' + fmtARS(ingresos) + '</div></div>' : '') +
    (egresos  > 0 ? '  <div class="caja-stat"><div class="caja-stat-l">↓ Egresos / gastos' + iHelp(INFO.egresos) + '</div><div class="caja-stat-v">' + fmtARS(egresos) + '</div></div>' : '') +
    '  <div class="caja-stat"><div class="caja-stat-l">Operaciones' + iHelp(INFO.operaciones) + '</div><div class="caja-stat-v">' + caja.cobros_count + '</div></div>' +
    '</div>' +
    porCajeroHtml +
    '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px">' +
    '  <button class="btn-mov" data-tipo="ingreso" style="padding:10px;border:1px solid rgba(16,185,129,.3);background:rgba(16,185,129,.08);border-radius:8px;color:#059669;font-weight:600;cursor:pointer;font-size:12px">↑ Ingreso</button>' +
    '  <button class="btn-mov" data-tipo="egreso"  style="padding:10px;border:1px solid rgba(239,68,68,.3);background:rgba(239,68,68,.08);border-radius:8px;color:#dc2626;font-weight:600;cursor:pointer;font-size:12px">↓ Egreso</button>' +
    '  <button onclick="abrirCajonMonedero()" title="Configurá la primera vez (Web Serial). Después se abre solo al cobrar efectivo." style="padding:10px;border:1px solid var(--border);background:white;border-radius:8px;font-weight:600;cursor:pointer;font-size:12px">💰 Cajón</button>' +
    '  <button class="btn-rep" data-tipo="X"       title="Lectura parcial del turno en curso. No cierra la caja, podés sacarla las veces que quieras." style="padding:10px;border:1px solid var(--border);background:white;border-radius:8px;font-weight:600;cursor:pointer;font-size:12px">📋 Reporte X</button>' +
    '  <button class="btn-rep" data-tipo="Z"       title="Cierre del turno actual: ventas desde la última apertura de caja." style="padding:10px;border:1px solid rgba(124,58,237,.3);background:rgba(124,58,237,.08);color:#7c3aed;font-weight:600;cursor:pointer;font-size:12px">📊 Reporte Z</button>' +
    '  <button class="btn-rep" data-tipo="DIA"     title="Suma todos los turnos de la tienda en el día, incluso ventas hechas con la caja cerrada." style="padding:10px;border:1px solid rgba(37,99,235,.3);background:rgba(37,99,235,.08);color:#2563eb;font-weight:600;cursor:pointer;font-size:12px">🗓️ Cierre del día</button>' +
    '</div>' +
    '<div class="caja-form">' +
    '  <label for="caja-cierre">Efectivo contado al cierre <span style="color:var(--muted);font-weight:500">(esperado: ' + fmtARS(caja.esperado_caja) + ')</span></label>' +
    '  <input id="caja-cierre" type="number" min="0" step="1" placeholder="0" value="' + caja.esperado_caja + '">' +
    '  <div id="caja-diff" class="caja-diff zero">Diferencia: ' + fmtARS(0) + '</div>' +
    '  <label for="caja-dejar">¿Cuánto dejás en caja para el próximo turno?</label>' +
    '  <input id="caja-dejar" type="number" min="0" step="1" placeholder="0">' +
    '  <div style="display:flex;gap:8px;margin:6px 0 2px">' +
    '    <button type="button" id="caja-dejar-todo" style="flex:1;padding:8px;border:1px solid var(--border);background:white;color:var(--ink);border-radius:8px;font-weight:600;cursor:pointer;font-size:12px">Dejar todo</button>' +
    '    <button type="button" id="caja-entregue-todo" style="flex:1;padding:8px;border:1px solid rgba(239,68,68,.3);background:rgba(239,68,68,.08);color:#dc2626;border-radius:8px;font-weight:600;cursor:pointer;font-size:12px">Entregué todo</button>' +
    '  </div>' +
    '  <div id="caja-entregado-hint" class="caja-meta" style="margin-bottom:6px"></div>' +
    '  <label for="caja-notas-cierre">Notas de cierre (opcional)</label>' +
    '  <textarea id="caja-notas-cierre" rows="2" placeholder="Diferencia justificada por…"></textarea>' +
    '  <button id="caja-btn-cerrar" class="danger">Cerrar caja</button>' +
    '</div>';
  wrap.appendChild(card);
  card.querySelectorAll('.btn-mov').forEach(b => {
    b.addEventListener('click', () => abrirMovimientoCaja(caja.id, b.dataset.tipo));
  });
  card.querySelectorAll('.btn-rep').forEach(b => {
    b.addEventListener('click', () => abrirReporteCaja(caja.id, b.dataset.tipo));
  });

  const inp = card.querySelector('#caja-cierre');
  const diffEl = card.querySelector('#caja-diff');
  const recalcDiff = () => {
    const v = parseFloat(inp.value) || 0;
    const d = v - caja.esperado_caja;
    diffEl.className = 'caja-diff ' + (d === 0 ? 'zero' : d < 0 ? 'neg' : 'pos');
    diffEl.textContent = 'Diferencia: ' + (d > 0 ? '+' : '') + fmtARS(d) +
      (d === 0 ? ' · OK' : d < 0 ? ' · Falta efectivo' : ' · Sobra efectivo');
  };
  inp.addEventListener('input', recalcDiff);
  recalcDiff();

  const dejarInp = card.querySelector('#caja-dejar');
  const entregadoHint = card.querySelector('#caja-entregado-hint');
  dejarInp.value = caja.esperado_caja;
  const recalcEntregado = () => {
    const declarado = parseFloat(inp.value) || 0;
    let dejar = parseFloat(dejarInp.value);
    if (!Number.isFinite(dejar)) dejar = 0;
    const entregado = Math.max(0, declarado - dejar);
    if (dejar > declarado) {
      entregadoHint.innerHTML = '<span style="color:var(--danger)">No podés dejar más de lo contado (' + fmtARS(declarado) + ').</span>';
    } else if (entregado > 0) {
      entregadoHint.innerHTML = 'Se retira / entrega: <b>' + fmtARS(entregado) + '</b> · queda en caja: <b>' + fmtARS(dejar) + '</b>';
    } else {
      entregadoHint.innerHTML = 'Queda todo en caja para el próximo turno: <b>' + fmtARS(dejar) + '</b>';
    }
  };
  dejarInp.addEventListener('input', recalcEntregado);
  inp.addEventListener('input', recalcEntregado);
  card.querySelector('#caja-dejar-todo').addEventListener('click', () => { dejarInp.value = parseFloat(inp.value) || 0; recalcEntregado(); });
  card.querySelector('#caja-entregue-todo').addEventListener('click', () => { dejarInp.value = 0; recalcEntregado(); });
  recalcEntregado();

  card.querySelector('#caja-btn-cerrar').addEventListener('click', async (e) => {
    const declarado = parseFloat(inp.value);
    if (!Number.isFinite(declarado) || declarado < 0) { toast('Ingresá un monto válido', 'warn'); return; }
    const d = declarado - caja.esperado_caja;
    const notas = card.querySelector('#caja-notas-cierre').value || null;
    if (Math.abs(d) > 1) {
      const detalle =
        'Sistema esperaba: ' + fmtARS(caja.esperado_caja) + '\n' +
        'Vos declaraste:   ' + fmtARS(declarado) + '\n' +
        'Diferencia:       ' + fmtARS(d) + ' ' + (d > 0 ? '(sobra)' : '(falta)') + '\n\n' +
        (d > 0
          ? '⚠ Hay más plata en caja de lo registrado. Puede ser una venta sin facturar o un error de cobro.'
          : '⚠ Falta plata en caja vs lo registrado. Revisá si hay vueltos mal entregados o algún cobro no rendido.') +
        '\n\n¿Confirmar el cierre con esta diferencia?';
      if (!confirm(detalle)) return;
    }
    const dejarRaw = parseFloat(dejarInp.value);
    const efectivoDejado = Number.isFinite(dejarRaw) ? dejarRaw : declarado;
    if (efectivoDejado < 0 || efectivoDejado > declarado + 0.01) {
      toast('El efectivo a dejar no puede superar lo contado', 'warn'); return;
    }
    e.target.disabled = true;
    const { data, error } = await sb.rpc('pos_cerrar_caja', {
      p_caja_id: caja.id,
      p_monto_declarado: declarado,
      p_notas: notas,
      p_efectivo_dejado: efectivoDejado,
    });
    if (error) { tmvShowError(error); e.target.disabled = false; return; }
    if (!data?.ok) { alert('No se pudo cerrar'); e.target.disabled = false; return; }
    const msgEntregado = (Number(data.efectivo_entregado) > 0) ? (' · entregado ' + fmtARS(data.efectivo_entregado)) : '';
    toast('Caja cerrada · diferencia ' + fmtARS(data.diferencia) + msgEntregado, data.diferencia === 0 ? 'ok' : 'warn');
    _cajaActual = null;
    renderCaja();
  });
}

// ── REPORTES HISTÓRICOS ────────────────────────────────
let _reportesInited = false;
async function initReportesUI() {
  const desde = document.getElementById('rep-desde');
  const hasta = document.getElementById('rep-hasta');
  if (desde && !desde.value) {
    const d = new Date(); d.setDate(d.getDate() - 7);
    desde.value = d.toISOString().slice(0, 10);
  }
  if (hasta && !hasta.value) {
    hasta.value = new Date().toISOString().slice(0, 10);
  }
  if (!_reportesInited) {
    try {
      const { data } = await sb.rpc('pos_listar_cajeros', { p_organization_id: orgId });
      const cajeros = data || [];
      const sel = document.getElementById('rep-cajero');
      if (sel && cajeros.length) {
        cajeros.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.user_id;
          opt.textContent = c.nombre || c.email;
          sel.appendChild(opt);
        });
      }
    } catch (_) {}
    _reportesInited = true;
  }
  if (!document.getElementById('rep-content').innerHTML.trim()) cargarReportes();
  cargarCortesCaja();
  cargarCorteGlobal();
}

window.cargarReportes = async () => {
  const desde = document.getElementById('rep-desde').value;
  const hasta = document.getElementById('rep-hasta').value;
  const cajeroId = document.getElementById('rep-cajero').value || null;
  const cont = document.getElementById('rep-content');
  if (!desde || !hasta) { toast('Elegí rango de fechas', 'warn'); return; }
  cont.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';
  const { data, error } = await sb.rpc('pos_get_ventas_rango', {
    p_organization_id: orgId,
    p_fecha_desde:     desde,
    p_fecha_hasta:     hasta,
    p_cajero_id:       cajeroId,
  });
  if (error) { cont.innerHTML = '<div style="color:var(--danger);padding:20px">Error: ' + error.message + '</div>'; return; }

  const t = data.totales || {};
  const porDia = data.por_dia || [];
  const porCajero = data.por_cajero || [];
  const porProducto = data.por_producto || [];
  const ventas = data.ventas || [];

  let html = '<div class="kpi-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:14px">' +
    kpiCard('Total cobrado', fmtARS(t.total || 0), (t.count || 0) + ' ventas', '#10b981', INFO.total_cobrado) +
    kpiCard('Efectivo',      fmtARS(t.efectivo || 0), '', '#374151', INFO.efectivo) +
    kpiCard('MercadoPago',   fmtARS(t.mp || 0), '', '#009ee3', INFO.mercadopago) +
    kpiCard('Transferencia', fmtARS(t.transf || 0), '', '#7C3AED', INFO.transferencia) +
    kpiCard('Débito',        fmtARS(t.debito || 0), '', '#0ea5e9', INFO.debito) +
    kpiCard('Crédito',       fmtARS(t.credito || 0), '', '#0284c7', INFO.credito) +
    kpiCard('Cuenta corriente', fmtARS(t.cc || 0), '', '#f59e0b', INFO.cuenta_corriente) +
    kpiCard('Egresos',       '-' + fmtARS(t.egresos || 0), '', '#dc2626', INFO.egresos) +
    '</div>';

  if (!cajeroId && porCajero.length) {
    const metodos = [['efectivo','Efectivo'],['debito','Débito'],['credito','Crédito'],['transf','Transf'],['mp','MP'],['cc','Cta cte']];
    const visibles = metodos.filter(([k]) => (Number(t[k])||0) > 0 || porCajero.some(c => (Number(c[k])||0) > 0));
    const hayEgr = (Number(t.egresos)||0) > 0 || porCajero.some(c => (Number(c.egresos)||0) > 0);
    const cell = v => (Number(v)||0) === 0 ? '<span style="color:#cbd5e1">—</span>' : fmtARS(v);
    const egrCell = v => (Number(v)||0) === 0 ? '<span style="color:#cbd5e1">—</span>' : '-' + fmtARS(v);
    html += '<div style="background:white;border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px">' +
      '<div style="font-weight:700;margin-bottom:8px;display:flex;align-items:center">🧑‍💼 Por cajero' + iHelp(INFO.rep_por_cajero) + '</div>' +
      '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px;white-space:nowrap">' +
      '<thead><tr style="border-bottom:1px solid var(--border);color:var(--muted);text-align:right">' +
      '<th style="text-align:left;padding:4px 6px">Cajero</th><th style="padding:4px 6px">Ventas</th>' +
      visibles.map(([,lbl]) => '<th style="padding:4px 6px">' + lbl + '</th>').join('') +
      (hayEgr ? '<th style="padding:4px 6px;color:#dc2626">Egresos</th>' : '') +
      '<th style="padding:4px 6px">Total</th></tr></thead><tbody>' +
      porCajero.map(c =>
        '<tr style="border-bottom:1px solid #f1f5f9;text-align:right">' +
        '<td style="text-align:left;padding:4px 6px;font-weight:600;white-space:normal">' + (c.cajero_nombre || '—') + '</td>' +
        '<td style="padding:4px 6px">' + (c.ventas || 0) + '</td>' +
        visibles.map(([k]) => '<td style="padding:4px 6px">' + cell(c[k]) + '</td>').join('') +
        (hayEgr ? '<td style="padding:4px 6px;color:#dc2626">' + egrCell(c.egresos) + '</td>' : '') +
        '<td style="padding:4px 6px;font-weight:700">' + fmtARS(c.monto) + '</td>' +
        '</tr>'
      ).join('') +
      '<tr style="border-top:2px solid var(--border);text-align:right;font-weight:700">' +
      '<td style="text-align:left;padding:6px">Total</td><td style="padding:6px">' + (t.count || 0) + '</td>' +
      visibles.map(([k]) => '<td style="padding:6px">' + cell(t[k]) + '</td>').join('') +
      (hayEgr ? '<td style="padding:6px;color:#dc2626">' + egrCell(t.egresos) + '</td>' : '') +
      '<td style="padding:6px">' + fmtARS(t.total) + '</td></tr>' +
      '</tbody></table></div></div>';
  }

  if (porProducto.length) {
    const totQty = porProducto.reduce((a, p) => a + (Number(p.cantidad) || 0), 0);
    const totMonto = porProducto.reduce((a, p) => a + (Number(p.monto) || 0), 0);
    const maxQ = Math.max(...porProducto.map(p => Number(p.cantidad) || 0)) || 1;
    html += '<div style="background:white;border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px">' +
      '<div style="font-weight:700;margin-bottom:8px;display:flex;align-items:center">📦 Productos vendidos' + iHelp(INFO.rep_productos) + '</div>' +
      '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">' +
      '<thead><tr style="border-bottom:1px solid var(--border);color:var(--muted)">' +
      '<th style="text-align:left;padding:4px 6px">Producto</th>' +
      '<th style="text-align:right;padding:4px 6px">Unidades</th>' +
      '<th style="padding:4px 6px"></th>' +
      '<th style="text-align:right;padding:4px 6px">Importe</th></tr></thead><tbody>' +
      porProducto.map(p => {
        const q = Number(p.cantidad) || 0;
        const w = Math.max(2, (q / maxQ) * 100);
        return '<tr style="border-bottom:1px solid #f1f5f9">' +
          '<td style="padding:4px 6px;font-weight:600">' + (p.producto || '—') + '</td>' +
          '<td style="text-align:right;padding:4px 6px;font-weight:700">' + q + '</td>' +
          '<td style="padding:4px 6px;min-width:80px"><div style="background:#f1f5f9;height:8px;border-radius:4px;overflow:hidden"><div style="width:' + w + '%;height:100%;background:var(--primary)"></div></div></td>' +
          '<td style="text-align:right;padding:4px 6px">' + fmtARS(p.monto) + '</td>' +
        '</tr>';
      }).join('') +
      '<tr style="border-top:2px solid var(--border);font-weight:700">' +
      '<td style="padding:6px">Total</td><td style="text-align:right;padding:6px">' + totQty + '</td><td></td>' +
      '<td style="text-align:right;padding:6px">' + fmtARS(totMonto) + '</td></tr>' +
      '</tbody></table></div>' +
      '<div style="font-size:11px;color:var(--muted);margin-top:6px">Importe de línea (cantidad × precio), neto de devoluciones. No descuenta promos ni descuentos generales de la venta.</div>' +
      '</div>';
  }

  if (porDia.length) {
    const max = Math.max(...porDia.map(d => Number(d.monto) || 0)) || 1;
    html += '<div style="background:white;border:1px solid var(--border);border-radius:10px;padding:14px;margin-bottom:14px">' +
      '<div style="font-weight:700;margin-bottom:8px;display:flex;align-items:center">📈 Por día' + iHelp(INFO.rep_por_dia) + '</div>' +
      porDia.map(d => {
        const w = Math.max(2, (Number(d.monto) / max) * 100);
        return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;font-size:12px">' +
          '<div style="width:80px">' + d.dia + '</div>' +
          '<div style="flex:1;background:#f1f5f9;height:18px;border-radius:4px;overflow:hidden"><div style="width:' + w + '%;height:100%;background:var(--primary)"></div></div>' +
          '<div style="width:120px;text-align:right;font-weight:600">' + d.ventas + ' · ' + fmtARS(d.monto) + '</div>' +
          '</div>';
      }).join('') +
      '</div>';
  }

  if (ventas.length) {
    html += '<div style="background:white;border:1px solid var(--border);border-radius:10px;padding:14px">' +
      '<div style="font-weight:700;margin-bottom:8px;display:flex;align-items:center">🧾 Ventas (' + ventas.length + ')' + iHelp(INFO.rep_ventas) + '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
      '<thead><tr style="border-bottom:1px solid var(--border);color:var(--muted)">' +
      '<th style="text-align:left;padding:4px">Fecha</th><th style="text-align:left">Cliente</th><th style="text-align:left">Cajero</th><th style="text-align:left">Método</th><th style="text-align:right">Total</th>' +
      '</tr></thead><tbody>' +
      ventas.slice(0, 100).map(v => {
        const dt = new Date(v.fecha).toLocaleString('es-AR', {day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
        const cancelada = v.estado === 'cancelado';
        return '<tr style="border-bottom:1px solid #f1f5f9' + (cancelada ? ';opacity:.5;text-decoration:line-through' : '') + '">' +
          '<td style="padding:4px">' + dt + '</td>' +
          '<td>' + (v.cliente || '—') + '</td>' +
          '<td>' + (v.cajero_nombre || '—') + '</td>' +
          '<td>' + (v.metodo || '—') + '</td>' +
          '<td style="text-align:right;font-weight:600">' + fmtARS(v.total) + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>' +
      (ventas.length > 100 ? '<div style="font-size:11px;color:var(--muted);text-align:center;padding:6px">+ ' + (ventas.length - 100) + ' más (limita a 100)</div>' : '') +
      '</div>';
  } else {
    html += '<div style="background:white;border:1px dashed var(--border);border-radius:10px;padding:30px;text-align:center;color:var(--muted)">Sin ventas en este rango.</div>';
  }

  cont.innerHTML = html;
};

window.cargarCortesCaja = async () => {
  const cont = document.getElementById('cortes-content');
  if (!cont) return;
  cont.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted)">Cargando…</div>';
  const cajeroId = document.getElementById('rep-cajero')?.value || null;
  let q = sb.from('cajas_pos')
    .select('id, fecha, abierta_at, cerrada_at, abierta_por_nombre, cerrada_por_nombre, monto_apertura, monto_cierre_declarado, diferencia')
    .eq('organization_id', orgId)
    .eq('estado', 'cerrada')
    .order('cerrada_at', { ascending: false })
    .limit(60);
  if (cajeroId) q = q.eq('abierta_por', cajeroId);
  const { data, error } = await q;
  if (error) { cont.innerHTML = '<div style="color:var(--danger);padding:16px">Error: ' + error.message + '</div>'; return; }
  const cajas = data || [];
  if (!cajas.length) {
    cont.innerHTML = '<div style="background:white;border:1px dashed var(--border);border-radius:10px;padding:26px;text-align:center;color:var(--muted)">Todavía no hay cajas cerradas para mostrar.</div>';
    return;
  }
  const fmtDT = s => s ? new Date(s).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—';
  const fmtT  = s => s ? new Date(s).toLocaleTimeString('es-AR', { hour:'2-digit', minute:'2-digit' }) : '—';
  let html = '<div style="background:white;border:1px solid var(--border);border-radius:10px;padding:14px;overflow-x:auto">' +
    '<table style="width:100%;border-collapse:collapse;font-size:12px">' +
    '<thead><tr style="border-bottom:1px solid var(--border);color:var(--muted);text-align:left">' +
    '<th style="padding:6px 4px">Cierre</th><th>Cajero</th><th>Turno</th>' +
    '<th style="text-align:right">Declarado</th><th style="text-align:right">Diferencia</th><th></th>' +
    '</tr></thead><tbody>';
  cajas.forEach(c => {
    const dif = Number(c.diferencia || 0);
    const difColor = dif === 0 ? 'var(--muted)' : dif < 0 ? '#dc2626' : '#059669';
    const difTxt = (dif > 0 ? '+' : '') + fmtARS(dif);
    html += '<tr style="border-bottom:1px solid #f1f5f9">' +
      '<td style="padding:6px 4px;white-space:nowrap">' + fmtDT(c.cerrada_at) + '</td>' +
      '<td>' + (c.cerrada_por_nombre || c.abierta_por_nombre || '—') + '</td>' +
      '<td style="white-space:nowrap">' + fmtT(c.abierta_at) + ' → ' + fmtT(c.cerrada_at) + '</td>' +
      '<td style="text-align:right;white-space:nowrap">' + fmtARS(c.monto_cierre_declarado || 0) + '</td>' +
      '<td style="text-align:right;white-space:nowrap;color:' + difColor + ';font-weight:600">' + difTxt + '</td>' +
      '<td style="text-align:right;white-space:nowrap"><button class="corte-ver" data-id="' + c.id + '" style="padding:6px 12px;border:1px solid rgba(124,58,237,.3);background:rgba(124,58,237,.08);color:#7c3aed;border-radius:8px;cursor:pointer;font-weight:600;font-size:12px">📊 Ver Z</button></td>' +
      '</tr>';
  });
  html += '</tbody></table>' +
    (cajas.length >= 60 ? '<div style="font-size:11px;color:var(--muted);text-align:center;padding:6px">Mostrando las últimas 60 cajas cerradas. Usá el filtro de cajero para acotar.</div>' : '') +
    '</div>';
  cont.innerHTML = html;
  cont.querySelectorAll('.corte-ver').forEach(b => {
    b.addEventListener('click', () => abrirReporteCaja(b.dataset.id, 'Z'));
  });
};

window._corteGlobalData = null;
window.cargarCorteGlobal = async () => {
  const cont = document.getElementById('corte-global-content');
  const inp  = document.getElementById('corte-global-fecha');
  if (!cont) return;
  if (inp && !inp.value) inp.value = new Date().toISOString().slice(0, 10);
  const fecha = (inp && inp.value) ? inp.value : new Date().toISOString().slice(0, 10);
  cont.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted)">Cargando…</div>';
  const { data, error } = await sb.rpc('pos_corte_global_dia', { p_organization_id: orgId, p_fecha: fecha });
  if (error) { cont.innerHTML = '<div style="color:var(--danger);padding:16px">Error: ' + error.message + '</div>'; return; }
  window._corteGlobalData = data;
  cont.innerHTML = renderCorteGlobal(data);
};

function renderCorteGlobal(d) {
  if (!d || !d.ok) return '<div style="padding:16px;color:var(--muted)">Sin datos</div>';
  const t = d.totales || {}, v = d.ventas || {}, m = d.movimientos || {}, f = d.facturas || {};
  if ((t.total || 0) === 0 && (v.count || 0) === 0)
    return '<div style="background:white;border:1px dashed var(--border);border-radius:10px;padding:26px;text-align:center;color:var(--muted)">No hubo movimientos de caja ese día.</div>';
  const dif = Number(t.diferencia || 0);
  const difColor = dif === 0 ? 'var(--muted)' : dif < 0 ? '#dc2626' : '#059669';
  const kpi = (lbl, val, color, info) => '<div style="background:white;border:1px solid var(--border);border-radius:10px;padding:12px 14px;min-width:130px;flex:1"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;display:flex;align-items:center">' + lbl + iHelp(info) + '</div><div style="font-size:20px;font-weight:800;color:' + (color || 'var(--ink)') + '">' + val + '</div></div>';
  const metodos = (v.metodos || []).map(x => '<tr><td style="padding:4px 6px">' + x.metodo + '</td><td style="text-align:right">' + x.count + '</td><td style="text-align:right">' + fmtARS(x.monto) + '</td></tr>').join('') || '<tr><td colspan="3" style="color:var(--muted);padding:6px">Sin ventas</td></tr>';
  const cajeros = (d.por_cajero || []).map(c => '<tr><td style="padding:4px 6px">' + c.cajero_nombre + '</td><td style="text-align:right">' + c.ventas + '</td><td style="text-align:right">' + fmtARS(c.efectivo) + '</td><td style="text-align:right">' + fmtARS(c.mercadopago) + '</td><td style="text-align:right">' + fmtARS(c.transferencia) + '</td><td style="text-align:right;font-weight:600">' + fmtARS(c.monto_total) + '</td></tr>').join('') || '<tr><td colspan="6" style="color:var(--muted);padding:6px">—</td></tr>';
  const cajas = (d.cajas || []).map(c => {
    const cd = Number(c.diferencia || 0);
    const cc = cd === 0 ? 'var(--muted)' : cd < 0 ? '#dc2626' : '#059669';
    return '<tr><td style="padding:4px 6px">' + (c.cajero || '—') + '</td><td>' + (c.estado || '') + '</td><td style="text-align:right">' + fmtARS(c.monto_apertura) + '</td><td style="text-align:right">' + fmtARS(c.declarado) + '</td><td style="text-align:right">' + fmtARS(c.calculado) + '</td><td style="text-align:right;color:' + cc + ';font-weight:600">' + (cd > 0 ? '+' : '') + fmtARS(cd) + '</td></tr>';
  }).join('') || '<tr><td colspan="6" style="color:var(--muted);padding:6px">Sin cortes ese día</td></tr>';
  return '' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">' +
      kpi('Cortes (cajas)', (t.cerradas || 0) + '/' + (t.total || 0), '', INFO.cg_cortes) +
      kpi('Ventas POS', fmtARS(v.total || 0), '', INFO.cg_ventas) +
      kpi('Efectivo declarado', fmtARS(t.declarado || 0), '', INFO.cg_efectivo) +
      kpi('Diferencia', (dif > 0 ? '+' : '') + fmtARS(dif), difColor, INFO.cg_diferencia) +
      kpi('Ingresos / Egresos', fmtARS(m.ingresos || 0) + ' / ' + fmtARS(m.egresos || 0), '', INFO.cg_ing_egr) +
      kpi('Facturas', (f.count || 0) + ' · ' + fmtARS(f.total || 0), '', INFO.cg_facturas) +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px">' +
      '<div style="background:white;border:1px solid var(--border);border-radius:10px;padding:12px"><div style="font-weight:700;margin-bottom:6px;display:flex;align-items:center">Ventas por método' + iHelp(INFO.cg_metodos) + '</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px"><tbody>' + metodos + '</tbody></table></div>' +
      '<div style="background:white;border:1px solid var(--border);border-radius:10px;padding:12px;overflow-x:auto"><div style="font-weight:700;margin-bottom:6px;display:flex;align-items:center">Por cajero' + iHelp(INFO.rep_por_cajero) + '</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="color:var(--muted)"><th style="text-align:left">Cajero</th><th style="text-align:right">Vtas</th><th style="text-align:right">Efvo</th><th style="text-align:right">MP</th><th style="text-align:right">Transf</th><th style="text-align:right">Total</th></tr></thead><tbody>' + cajeros + '</tbody></table></div>' +
    '</div>' +
    '<div style="background:white;border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:14px;overflow-x:auto"><div style="font-weight:700;margin-bottom:6px;display:flex;align-items:center">Cortes incluidos (' + (d.cajas || []).length + ')' + iHelp(INFO.cg_cortes_incl) + '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="color:var(--muted)"><th style="text-align:left">Cajero</th><th style="text-align:left">Estado</th><th style="text-align:right">Apertura</th><th style="text-align:right">Declarado</th><th style="text-align:right">Calculado</th><th style="text-align:right">Dif</th></tr></thead><tbody>' + cajas + '</tbody></table></div>';
}

window.imprimirCorteGlobal = () => {
  const d = window._corteGlobalData;
  if (!d) { cargarCorteGlobal(); return; }
  const fecha = document.getElementById('corte-global-fecha')?.value || '';
  imprimirEnIframe('Corte global ' + fecha, '<h2>Corte global del día ' + fecha + '</h2>' + renderCorteGlobal(d));
};

function imprimirEnIframe(titulo, bodyHTML, css = '') {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(iframe);

  const doc = iframe.contentWindow.document;
  doc.open();
  doc.write(
    '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>' + titulo + '</title><style>' +
    '*{box-sizing:border-box}' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#111827;margin:18px;font-size:13px}' +
    'table{width:100%;border-collapse:collapse}h3{margin:0 0 8px;font-size:18px}' +
    css +
    '@media print{@page{margin:12mm}body{margin:0}' +
    '*{overflow:visible!important;max-height:none!important}' +
    'table{page-break-inside:auto}tr{page-break-inside:avoid}}' +
    '</style></head><body>' + bodyHTML + '</body></html>'
  );
  doc.close();

  const win = iframe.contentWindow;
  const lanzar = () => {
    try { win.focus(); win.print(); }
    catch (e) { toast('No se pudo abrir la impresión', 'err'); }
    setTimeout(() => iframe.remove(), 1500);
  };
  if (doc.readyState === 'complete') setTimeout(lanzar, 200);
  else win.addEventListener('load', () => setTimeout(lanzar, 200));
}

window.imprimirReportes = () => {
  const cont = document.getElementById('rep-content');
  const cuerpo = cont ? cont.innerHTML.trim() : '';
  if (!cuerpo || cuerpo.includes('Cargando…')) { toast('Generá el reporte antes de imprimir', 'warn'); return; }

  const desde = document.getElementById('rep-desde').value;
  const hasta = document.getElementById('rep-hasta').value;
  const cajeroSel = document.getElementById('rep-cajero');
  const cajeroTxt = cajeroSel && cajeroSel.value ? cajeroSel.options[cajeroSel.selectedIndex].text : 'Todos los cajeros';
  const fmtFecha = (f) => f ? new Date(f + 'T00:00:00').toLocaleDateString('es-AR', {day:'2-digit',month:'2-digit',year:'numeric'}) : '—';
  const generado = new Date().toLocaleString('es-AR', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});

  const css =
    ':root{--border:#e5e7eb;--primary:#2563eb;--muted:#6b7280;--text:#111827}' +
    'body{margin:24px}' +
    '.rep-head{border-bottom:2px solid var(--primary);padding-bottom:12px;margin-bottom:18px}' +
    '.rep-head h1{margin:0 0 4px;font-size:22px}' +
    '.rep-head .meta{color:var(--muted);font-size:12px;line-height:1.6}' +
    '.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:14px}' +
    '.ventas-kpi{border:1px solid var(--border);border-left:4px solid var(--ka,var(--primary));border-radius:8px;padding:10px}' +
    '.ventas-kpi-l{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}' +
    '.ventas-kpi-v{font-size:18px;font-weight:700;margin-top:2px}' +
    '@media print{@page{margin:14mm}}';

  const body =
    '<div class="rep-head"><h1>📊 ' + (orgName || 'Reporte de ventas') + '</h1>' +
    '<div class="meta">Período: <b>' + fmtFecha(desde) + '</b> → <b>' + fmtFecha(hasta) + '</b>' +
    ' · Cajero: <b>' + cajeroTxt + '</b><br>Generado: ' + generado + '</div></div>' +
    cuerpo;

  imprimirEnIframe('Reporte ' + (orgName || ''), body, css);
};

// ── ATAJOS DE PRODUCTOS FAVORITOS (F7-F12) ─────────────
function _favKey() { return 'pos_favoritos_' + (orgId || 'na'); }
function _getFavoritos() {
  try { return JSON.parse(localStorage.getItem(_favKey()) || '{}'); }
  catch { return {}; }
}
function _saveFavoritos(map) {
  try { localStorage.setItem(_favKey(), JSON.stringify(map)); } catch {}
}
function _configurarFavorito(slot) {
  const favs = _getFavoritos();
  if (favs[slot]) {
    if (confirm('Slot F' + (slot + 6) + ' ya tiene "' + favs[slot].nombre + '". ¿Quitar?')) {
      delete favs[slot];
      _saveFavoritos(favs);
      toast('Atajo F' + (slot + 6) + ' liberado', 'ok');
      renderProductGrid();
    }
    return;
  }
  const grid = document.getElementById('prod-grid');
  const firstId = grid?.querySelector('.prod-card')?.dataset?.prodId;
  const p = productos.find(x => x.id === firstId);
  if (!p) {
    toast('Buscá el producto primero (F5) y después Shift+F' + (slot + 6), 'warn');
    return;
  }
  favs[slot] = { id: p.id, nombre: p.nombre };
  _saveFavoritos(favs);
  toast('F' + (slot + 6) + ' → ' + p.nombre + ' ✓', 'ok');
  renderProductGrid();
}
function _agregarFavorito(slot) {
  const favs = _getFavoritos();
  const fav = favs[slot];
  if (!fav) {
    toast('F' + (slot + 6) + ' sin asignar. Buscá un producto y Shift+F' + (slot + 6) + ' para asignarlo.', 'warn');
    return;
  }
  const p = productos.find(x => x.id === fav.id);
  if (!p) { toast('Favorito eliminado del catálogo', 'err'); return; }
  agregarAlCarrito(p);
  toast('+ ' + p.nombre + ' (F' + (slot + 6) + ')', 'ok');
}

// ── DASHBOARD MINI DEL CAJERO ──────────────────────────
let _dashTimer = null;
async function actualizarDashMini() {
  if (!orgId) return;
  const wrap = document.getElementById('dash-mini');
  if (!wrap) return;
  const { data } = await sb.rpc('pos_caja_actual', { p_organization_id: orgId, p_tienda_id: tiendaId });
  const caja = data?.caja || null;
  if (!caja) { wrap.style.display = 'none'; return; }
  const { data: r } = await sb.rpc('pos_resumen_cajero_turno', { p_caja_id: caja.id });
  if (!r?.ok) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  document.getElementById('dash-ventas').textContent = r.ventas || 0;
  document.getElementById('dash-monto').textContent = fmtARS(r.total || 0);
  if (r.top_producto?.nombre) {
    wrap.title = 'Tu turno: ' + r.ventas + ' ventas · ' + fmtARS(r.total) +
                 ' · top: ' + r.top_producto.nombre + ' (' + r.top_producto.cantidad + ')';
  }
}
function startDashMini() {
  if (_dashTimer) clearInterval(_dashTimer);
  actualizarDashMini();
  _dashTimer = setInterval(actualizarDashMini, 30_000);
}

// ── CAJÓN MONEDERO (Web Serial API) ──────────────────────
let _serialPort = null;
async function _abrirSerialPort() {
  if (!('serial' in navigator)) {
    toast('Web Serial no disponible (usá Chrome/Edge desktop)', 'err');
    return null;
  }
  if (_serialPort && _serialPort.readable) return _serialPort;
  try {
    const granted = await navigator.serial.getPorts();
    _serialPort = granted[0] || await navigator.serial.requestPort();
    if (!_serialPort.readable) {
      await _serialPort.open({ baudRate: 9600 });
    }
    return _serialPort;
  } catch (e) {
    console.warn('serial port:', e);
    return null;
  }
}
window.abrirCajonMonedero = async () => {
  const port = await _abrirSerialPort();
  if (!port) {
    toast('No hay impresora conectada', 'warn');
    return;
  }
  try {
    const writer = port.writable.getWriter();
    await writer.write(new Uint8Array([0x1B, 0x70, 0x00, 0x19, 0xFA]));
    writer.releaseLock();
    toast('💰 Cajón abierto', 'ok');
  } catch (e) {
    console.warn('kick error:', e);
    toast('Error abriendo cajón: ' + e.message, 'err');
  }
};

// ── RESERVAS ────────────────────────────────────────────
window.crearReserva = async () => {
  if (cart.size === 0) { toast('Cargá productos antes de reservar', 'warn'); return; }
  if (!clienteSel?.id) {
    toast('Para reservar elegí un cliente real (no Mostrador)', 'warn');
    return;
  }
  const items = [];
  cart.forEach((it, prodId) => {
    items.push({ producto_id: prodId, cantidad: it.cantidad, precio: it.precio });
  });
  _abrirReservaModal(items);
};

function _abrirReservaModal(items) {
  const hoy = new Date().toISOString().slice(0, 10);
  const html = `
    <div id="pos-rv-overlay" style="position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:14px"
      onmousedown="this.dataset.dwn=(event.target===this?&quot;1&quot;:&quot;&quot;)" onclick="if(event.target===this&&this.dataset.dwn===&quot;1&quot;)this.remove();this.dataset.dwn=&quot;&quot;">
      <div style="background:#fff;border-radius:14px;max-width:440px;width:100%;padding:20px;box-shadow:0 14px 40px rgba(0,0,0,.18)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <div style="font-weight:700;font-size:16px">📌 Reservar pedido</div>
          <button type="button" onclick="document.getElementById('pos-rv-overlay').remove()"
            style="background:none;border:0;font-size:22px;cursor:pointer;color:#64748b">×</button>
        </div>
        <div style="margin-bottom:14px">
          <label style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Fecha estimada de retiro</label>
          <input id="pos-rv-fecha" type="date" value="${hoy}" min="${hoy}"
            style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;font-weight:600;margin-top:5px;font-family:inherit">
          <div style="font-size:11px;color:var(--muted);margin-top:6px">Default: hoy. Tocá para abrir el calendario.</div>
        </div>
        <div style="margin-bottom:8px">
          <label style="font-size:11px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.04em">Notas (opcional)</label>
          <textarea id="pos-rv-notas" rows="3" placeholder="Ej: avisar antes de pasar, dejar en portería…"
            style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:5px;font-family:inherit;resize:vertical"></textarea>
        </div>
        <div style="background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:9px;padding:10px 12px;font-size:12px;color:#92400e;margin:14px 0">
          ℹ️ La reserva no descuenta stock. Cuando el cliente venga a retirar, abrís la pestaña <b>Reservas</b> y confirmás con método de pago.
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button type="button" onclick="document.getElementById('pos-rv-overlay').remove()"
            style="padding:10px 16px;border:1.5px solid var(--border);background:#fff;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer">Cancelar</button>
          <button type="button" id="pos-rv-save" onclick="window._posConfirmarReserva()"
            style="padding:10px 18px;border:0;background:#f59e0b;color:#fff;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer">Crear reserva</button>
        </div>
      </div>
    </div>`;
  const div = document.createElement('div'); div.innerHTML = html;
  document.body.appendChild(div.firstElementChild);
  window._posRvItems = items;
}

window._posConfirmarReserva = async function() {
  const fecha = document.getElementById('pos-rv-fecha').value || null;
  const notas = document.getElementById('pos-rv-notas').value.trim() || null;
  const items = window._posRvItems || [];
  if (items.length === 0) { toast('Sin items', 'err'); return; }

  const btn = document.getElementById('pos-rv-save');
  btn.disabled = true; btn.textContent = 'Guardando…';

  const { data, error } = await sb.rpc('pos_crear_reserva', {
    p_organization_id: orgId,
    p_items:           items,
    p_cliente_id:      clienteSel.id,
    p_notas:           notas,
    p_fecha_estimada:  fecha,
    p_tienda_id:       tiendaId || null,
  });
  if (error) {
    btn.disabled = false; btn.textContent = 'Crear reserva';
    tmvShowError(error); return;
  }
  if (!data?.ok) {
    btn.disabled = false; btn.textContent = 'Crear reserva';
    alert('No se pudo crear la reserva'); return;
  }

  toast('📌 Reserva creada · ' + fmtARS(data.total), 'ok');
  document.getElementById('pos-rv-overlay').remove();
  cart.clear();
  _resumenCliCache.delete(clienteSel.id);
  clienteSel = null;
  _searchCli = '';
  _resetEnvasesUI();
  _resetDescuento();
  renderCart();
  renderClienteUI();
  renderProductGrid();
  if (document.getElementById('screen-reservas')?.classList.contains('active')) cargarReservas();
};

async function cargarReservas() {
  const cont = document.getElementById('reservas-list');
  if (!cont) return;
  cont.innerHTML = '<div style="text-align:center;padding:20px;color:var(--muted)">Cargando…</div>';
  const { data, error } = await sb.rpc('pos_listar_reservas', { p_organization_id: orgId });
  if (error) {
    cont.innerHTML = '<div style="color:var(--danger);padding:20px">Error: ' + error.message + '</div>';
    return;
  }
  const reservas = data || [];
  const badge = document.getElementById('reservas-badge');
  if (badge) {
    badge.style.display = reservas.length > 0 ? '' : 'none';
    badge.textContent = reservas.length;
  }
  if (!reservas.length) {
    cont.innerHTML = '<div style="background:#fff;border:1px dashed var(--border);border-radius:12px;padding:30px;text-align:center;color:var(--muted)">Sin reservas pendientes.</div>';
    return;
  }
  cont.innerHTML = '';
  const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  reservas.forEach(r => {
    const fechaTxt = r.fecha_estimada
      ? new Date(r.fecha_estimada + 'T00:00:00').toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit' })
      : 'sin fecha';
    const itemsTxt = (r.items || []).map(i => i.cantidad + '× ' + i.producto).join(', ');
    const card = document.createElement('div');
    card.style.cssText = 'background:white;border:1px solid var(--border);border-radius:10px;padding:14px;display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center';
    card.innerHTML = `
      <div>
        <div style="font-weight:700;font-size:14px">👤 ${escHtml(r.cliente || 'Mostrador')}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">📅 ${escHtml(fechaTxt)} · ${escHtml(r.cajero || 'cajero')}${r.tienda_nombre ? ' · 🏪 ' + escHtml(r.tienda_nombre) : ''}</div>
        <div style="font-size:12px;color:var(--ink);margin-top:6px;line-height:1.4">${escHtml(itemsTxt)}</div>
        ${r.notas ? `<div style="font-size:11px;color:var(--muted);margin-top:4px;font-style:italic">📝 ${escHtml(r.notas)}</div>` : ''}
      </div>
      <div style="text-align:right">
        <div style="font-weight:800;font-size:18px;margin-bottom:6px">${fmtARS(r.total)}</div>
        <button class="btn-liberar" style="padding:8px 14px;border:none;background:var(--primary);color:white;border-radius:6px;cursor:pointer;font-weight:600;font-size:12px;margin-right:4px">💵 Cobrar</button>
        <button class="btn-cancelar" style="padding:8px 10px;border:1px solid var(--border);background:white;border-radius:6px;cursor:pointer;font-size:12px">✕</button>
      </div>`;
    card.querySelector('.btn-liberar').addEventListener('click', () => liberarReserva(r));
    card.querySelector('.btn-cancelar').addEventListener('click', () => cancelarReserva(r));
    cont.appendChild(card);
  });
}

async function liberarReserva(r) {
  const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const html = `
    <div id="pos-rl-overlay" style="position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:14px"
      onmousedown="this.dataset.dwn=(event.target===this?&quot;1&quot;:&quot;&quot;)" onclick="if(event.target===this&&this.dataset.dwn===&quot;1&quot;)this.remove();this.dataset.dwn=&quot;&quot;">
      <div style="background:#fff;border-radius:14px;max-width:420px;width:100%;padding:20px;box-shadow:0 14px 40px rgba(0,0,0,.18)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="font-weight:700;font-size:16px">💵 Cobrar reserva</div>
          <button type="button" onclick="document.getElementById('pos-rl-overlay').remove()"
            style="background:none;border:0;font-size:22px;cursor:pointer;color:#64748b">×</button>
        </div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:14px">${escHtml(r.cliente)} · <b style="color:var(--ink)">${fmtARS(r.total)}</b></div>
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px">Método de cobro</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px" id="pos-rl-metodos">
          <button class="rl-met" data-m="efectivo" style="padding:14px 10px;border:1.5px solid var(--border);background:#fff;border-radius:10px;cursor:pointer;font-weight:600;font-size:13px">💵 Efectivo</button>
          <button class="rl-met" data-m="transferencia" style="padding:14px 10px;border:1.5px solid var(--border);background:#fff;border-radius:10px;cursor:pointer;font-weight:600;font-size:13px">🏦 Transferencia</button>
          <button class="rl-met" data-m="mercadopago" style="padding:14px 10px;border:1.5px solid var(--border);background:#fff;border-radius:10px;cursor:pointer;font-weight:600;font-size:13px">📱 Mercado Pago</button>
          <button class="rl-met" data-m="cuenta_corriente" style="padding:14px 10px;border:1.5px solid var(--border);background:#fff;border-radius:10px;cursor:pointer;font-weight:600;font-size:13px">📒 Cuenta corriente</button>
        </div>
        <div style="font-size:11px;color:var(--muted);text-align:center">Tocá un método para confirmar el cobro y liberar la reserva.</div>
      </div>
    </div>`;
  const div = document.createElement('div'); div.innerHTML = html;
  document.body.appendChild(div.firstElementChild);
  document.querySelectorAll('#pos-rl-metodos .rl-met').forEach(btn => {
    btn.addEventListener('click', async () => {
      const metodo = btn.dataset.m;
      btn.disabled = true; btn.textContent = '…';
      const { data, error } = await sb.rpc('pos_liberar_reserva', {
        p_pedido_id:         r.pedido_id,
        p_cobro_metodo:      metodo,
        p_pagos:             null,
        p_bidones_retirados: 0,
        p_descuento_monto:   0,
        p_cobro_referencia:  null,
      });
      if (error) { tmvShowError(error); btn.disabled = false; btn.textContent = btn.dataset.m; return; }
      if (!data?.ok) { alert('No se pudo liberar'); btn.disabled = false; return; }
      document.getElementById('pos-rl-overlay').remove();
      toast('✓ Reserva liberada → venta confirmada', 'ok');
      await cargarReservas();
      await cargarStock();
    });
  });
}

async function cancelarReserva(r) {
  if (!confirm('¿Cancelar reserva de ' + r.cliente + '? Esto la elimina sin generar venta.')) return;
  const { data, error } = await sb.rpc('pos_cancelar_reserva', {
    p_pedido_id: r.pedido_id, p_motivo: null,
  });
  if (error) { tmvShowError(error); return; }
  if (!data?.ok) { alert('No se pudo cancelar'); return; }
  toast('Reserva cancelada', 'warn');
  cargarReservas();
}

// ── Movimientos de caja (ingreso / egreso de efectivo) ─────
async function abrirMovimientoCaja(cajaId, tipo) {
  const titulo = tipo === 'ingreso' ? '↑ Ingreso de efectivo' : '↓ Egreso / gasto';
  const ejemplo = tipo === 'ingreso'
    ? 'Aporte de socio, devolución de proveedor, etc.'
    : 'Pago a proveedor, retiro a banco, vuelto inicial repuesto, etc.';
  const ov = document.createElement('div');
  ov.className = 'qr-overlay show';
  ov.style.cssText = 'background:rgba(0,0,0,.5);z-index:200';
  ov.innerHTML =
    '<div style="background:white;border-radius:14px;width:min(420px,90vw);padding:20px">' +
    '<h3 style="margin:0 0 12px;font-size:18px">' + titulo + '</h3>' +
    '<label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px">Monto (ARS)</label>' +
    '<input id="mov-monto" type="number" min="0" step="1" placeholder="0" autofocus style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;font-size:18px;margin-bottom:10px">' +
    '<label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px">Motivo</label>' +
    '<input id="mov-motivo" placeholder="' + ejemplo + '" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:14px">' +
    '<div style="display:flex;gap:8px;justify-content:flex-end">' +
    '  <button id="mov-cancel" style="padding:10px 16px;border:1px solid var(--border);border-radius:8px;background:white;cursor:pointer">Cancelar</button>' +
    '  <button id="mov-ok" style="padding:10px 16px;border:none;border-radius:8px;background:var(--primary);color:white;font-weight:700;cursor:pointer">Registrar</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(ov);
  ov.querySelector('#mov-cancel').addEventListener('click', () => ov.remove());
  ov.querySelector('#mov-ok').addEventListener('click', async (e) => {
    const monto  = parseFloat(ov.querySelector('#mov-monto').value) || 0;
    const motivo = ov.querySelector('#mov-motivo').value.trim() || null;
    if (monto <= 0) { toast('Monto debe ser mayor a 0', 'warn'); return; }
    e.target.disabled = true;
    const { data, error } = await sb.rpc('pos_caja_movimiento', {
      p_caja_id: cajaId, p_tipo: tipo, p_monto: monto, p_motivo: motivo,
    });
    if (error) { tmvShowError(error); e.target.disabled = false; return; }
    if (!data?.ok) { alert('No se pudo registrar el movimiento'); e.target.disabled = false; return; }
    toast(titulo + ' registrado ✓', 'ok');
    ov.remove();
    renderCaja();
  });
  setTimeout(() => ov.querySelector('#mov-monto')?.focus(), 50);
}

// ── Reporte X / Z / DIA ──
async function abrirReporteCaja(cajaId, tipo) {
  const { data, error } = tipo === 'DIA'
    ? await sb.rpc('pos_caja_reporte_dia', { p_caja_id: cajaId })
    : await sb.rpc('pos_caja_reporte',     { p_caja_id: cajaId, p_tipo: tipo });
  if (error) { tmvShowError(error); return; }
  if (!data?.ok) { alert('No se pudo generar el reporte'); return; }

  const metodos = data.metodos || [];
  const tops    = data.top_productos || [];
  const movs    = data.movimientos || [];
  const porCaj  = data.por_cajero || [];
  const ops     = data.operaciones || [];
  const facts   = data.facturas || { count: 0, total: 0, por_tipo: [] };
  const ingresos = Number(data.ingresos || 0);
  const egresos  = Number(data.egresos  || 0);
  const escR = s => (s == null ? '' : String(s).replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])));

  const ov = document.createElement('div');
  ov.className = 'qr-overlay show';
  ov.style.cssText = 'background:rgba(0,0,0,.5);z-index:200';

  const metodoIcon = m => ({ efectivo:'💵', mercadopago:'📱', transferencia:'🏦', cuenta_corriente:'💳', debito:'💳', credito:'💳', otro:'🪙' }[m] || '·');
  const tituloRep = tipo === 'X' ? '📋 Reporte X (parcial)'
                  : tipo === 'Z' ? '📊 Reporte Z (cierre)'
                  : '🗓️ Cierre del día';
  const scopeRep  = tipo === 'X' ? 'Lectura parcial de la caja en curso (toda la tienda) — no cierra la caja.'
                  : tipo === 'Z' ? 'Cierre de la caja actual: ventas de toda la tienda desde la apertura.'
                  : 'Toda la jornada: suma de todos los turnos de la tienda en el día.';

  let html = '<div style="background:white;border-radius:14px;width:min(640px,92vw);max-height:88vh;overflow:auto;padding:24px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
    '<h3 style="margin:0;font-size:20px">' + tituloRep + '</h3>' +
    '<button id="rep-print" style="padding:6px 12px;border:1px solid var(--border);background:white;border-radius:6px;cursor:pointer;font-size:12px">🖨 Imprimir</button>' +
    '</div>' +
    '<div style="font-size:12px;color:var(--ink);background:rgba(102,126,234,.06);border-radius:8px;padding:8px 10px;margin-bottom:12px">ℹ️ ' + scopeRep + '</div>' +
    '<div style="font-size:12px;color:var(--muted);margin-bottom:16px">' +
    (tipo === 'DIA'
      ? 'Día: <b>' + new Date(data.dia + 'T00:00:00').toLocaleDateString('es-AR') + '</b> · ' + (data.turnos || 0) + ' turno' + ((data.turnos||0) === 1 ? '' : 's') + '<br>'
      : '') +
    'Apertura: ' + new Date(data.abierta_at).toLocaleString('es-AR') +
    (data.cerrada_at ? ' · Cierre: ' + new Date(data.cerrada_at).toLocaleString('es-AR') : ' · En curso') +
    '<br>Apertura caja: ' + fmtARS(data.monto_apertura) +
    '</div>';

  html += '<div style="font-weight:700;margin-bottom:6px;display:flex;align-items:center">Por método de pago' + iHelp('Total cobrado en este reporte, abierto por cada forma de pago (efectivo, MercadoPago, transferencia, débito, crédito, cuenta corriente). La cuenta corriente es lo fiado, todavía no cobrado.') + '</div>';
  if (metodos.length) {
    html += '<table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:13px">';
    let totalGral = 0;
    metodos.forEach(m => {
      totalGral += Number(m.monto || 0);
      html += '<tr><td style="padding:4px 0">' + metodoIcon(m.metodo) + ' ' + m.metodo + '</td>' +
              '<td style="text-align:right">' + m.count + ' op</td>' +
              '<td style="text-align:right;font-weight:600">' + fmtARS(m.monto) + '</td></tr>';
    });
    html += '<tr style="border-top:1px solid var(--border)"><td colspan="2" style="padding-top:6px;font-weight:700">Total cobrado</td>' +
            '<td style="text-align:right;font-weight:800">' + fmtARS(totalGral) + '</td></tr></table>';
  } else {
    html += '<div style="color:var(--muted);margin-bottom:14px">Sin cobros en el turno</div>';
  }

  if (ingresos > 0 || egresos > 0) {
    html += '<div style="display:flex;gap:10px;margin-bottom:14px;font-size:13px">' +
      '<div style="flex:1;background:rgba(16,185,129,.08);border-radius:8px;padding:8px 10px">↑ Ingresos: <b style="color:#059669">' + fmtARS(ingresos) + '</b></div>' +
      '<div style="flex:1;background:rgba(239,68,68,.08);border-radius:8px;padding:8px 10px">↓ Egresos: <b style="color:#dc2626">' + fmtARS(egresos) + '</b></div>' +
      '</div>';
  }

  if (porCaj.length) {
    html += '<div style="font-weight:700;margin-bottom:6px">Por cajero</div>' +
      '<table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:13px">' +
      '<thead><tr style="color:var(--muted);text-align:right"><th style="text-align:left">Cajero</th><th>Vtas</th><th>Efvo</th><th>Transf</th><th>Otros</th><th>Total</th></tr></thead><tbody>';
    porCaj.forEach(c => {
      const otros = Number(c.mp||0) + Number(c.debito||0) + Number(c.credito||0) + Number(c.cc||0);
      html += '<tr style="text-align:right"><td style="text-align:left;padding:3px 0">' + escR(c.cajero_nombre) + '</td>' +
        '<td>' + (c.ventas || 0) + '</td><td>' + fmtARS(c.efectivo) + '</td><td>' + fmtARS(c.transf) + '</td>' +
        '<td>' + fmtARS(otros) + '</td><td style="font-weight:700">' + fmtARS(c.total) + '</td></tr>';
    });
    html += '</tbody></table>';
  }

  if (tops.length) {
    const totU = tops.reduce((a, p) => a + (Number(p.cantidad) || 0), 0);
    html += '<div style="font-weight:700;margin-bottom:6px">Resumen por artículo</div>' +
            '<table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:13px">';
    tops.forEach(p => {
      html += '<tr><td style="padding:3px 0">' + escR(p.producto) + '</td>' +
              '<td style="text-align:right;font-weight:700">' + p.cantidad + ' u</td>' +
              '<td style="text-align:right">' + fmtARS(p.monto) + '</td></tr>';
    });
    html += '<tr style="border-top:1px solid var(--border)"><td style="padding-top:6px;font-weight:700">Total unidades</td>' +
            '<td style="text-align:right;font-weight:800">' + totU + ' u</td><td></td></tr></table>';
  }

  if (facts.count > 0) {
    html += '<div style="font-weight:700;margin-bottom:6px">Facturas emitidas</div>' +
            '<div style="font-size:13px;margin-bottom:14px">' + facts.count + ' facturas · ' + fmtARS(facts.total) + '</div>';
  }

  if (movs.length) {
    html += '<div style="font-weight:700;margin-bottom:6px">Movimientos de caja</div>' +
            '<table style="width:100%;border-collapse:collapse;margin-bottom:14px;font-size:13px">';
    movs.forEach(m => {
      const sign = m.tipo === 'ingreso' ? '+' : '−';
      const color = m.tipo === 'ingreso' ? '#059669' : '#dc2626';
      html += '<tr><td style="padding:3px 0">' + new Date(m.at).toLocaleTimeString('es-AR', {hour:'2-digit',minute:'2-digit'}) + '</td>' +
              '<td style="font-size:11px;color:var(--muted)">' + (m.motivo || '—') + '</td>' +
              '<td style="text-align:right;color:' + color + ';font-weight:600">' + sign + fmtARS(m.monto) + '</td></tr>';
    });
    html += '</table>';
  }

  if (ops.length) {
    html += '<div style="font-weight:700;margin-bottom:6px">Detalle de operaciones (' + ops.length + ')</div>' +
            '<div style="font-size:12px;margin-bottom:14px">';
    ops.forEach(o => {
      const hora = new Date(o.fecha).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
      const items = (o.items || []).map(it => escR(it.producto) + ' ×' + it.cantidad).join(', ');
      html += '<div style="border-top:1px solid #f1f5f9;padding:6px 0;display:flex;justify-content:space-between;gap:10px">' +
        '<div style="min-width:0"><div style="font-weight:600">' + hora + ' · ' + escR(o.cliente || 'Mostrador') + '</div>' +
        '<div style="color:var(--muted)">' + (items || '—') + '</div></div>' +
        '<div style="text-align:right;white-space:nowrap"><div style="font-weight:700">' + fmtARS(o.total) + '</div>' +
        '<div style="color:var(--muted);font-size:11px">' + escR(o.metodo || '') + '</div></div>' +
        '</div>';
    });
    html += '</div>';
  }

  html += '<div style="display:flex;justify-content:flex-end;margin-top:14px">' +
          '<button id="rep-close" style="padding:10px 20px;border:none;background:var(--primary);color:white;border-radius:8px;font-weight:700;cursor:pointer">Cerrar</button>' +
          '</div></div>';

  ov.innerHTML = html;
  document.body.appendChild(ov);
  ov.querySelector('#rep-close').addEventListener('click', () => ov.remove());
  ov.querySelector('#rep-print').addEventListener('click', () => {
    const clone = ov.firstElementChild.cloneNode(true);
    clone.querySelectorAll('#rep-print, #rep-close').forEach(el => el.remove());
    const titulo = (tipo === 'X' ? 'Reporte X (parcial)' : tipo === 'Z' ? 'Reporte Z (cierre)' : 'Cierre del día') + ' — ' + (orgName || '');
    imprimirEnIframe(titulo, clone.innerHTML,
      ':root{--border:#e5e7eb;--muted:#6b7280;--primary:#2563eb;--ink:#111827}' +
      '@media print{@page{margin:10mm}}');
  });
}

// ── VISTA CATÁLOGO ───────────────────────────────────
window.posToggleVista = () => {
  _prodView = _prodView === 'list' ? 'grid' : 'list';
  try { localStorage.setItem('pos_prod_view', _prodView); } catch (_) {}
  _updateVistaBtn();
  renderProductGrid();
};
function _updateVistaBtn() {
  const b = document.getElementById('prod-view-toggle');
  if (b) b.textContent = _prodView === 'list' ? '▦ Grilla' : '≣ Lista';
}

function renderProductGrid(){
  const grid = document.getElementById('prod-grid');
  if (!grid) return;
  grid.className = 'prod-grid' + (_prodView === 'list' ? ' as-list' : '');
  _updateVistaBtn();
  const q = _searchProd;
  const norm = s => (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '');
  const tokens = q ? norm(q).split(/\s+/).filter(Boolean) : [];
  const list = productos.filter(p => {
    if (!tokens.length) return true;
    const hay = norm(p.nombre);
    return tokens.every(t => hay.includes(t));
  });

  if (!list.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted)">' +
      (q ? 'Sin productos para "' + q + '"' : 'Sin productos cargados en el catálogo') + '</div>';
    return;
  }

  grid.innerHTML = '';
  list.forEach(p => {
    const enCart = cart.get(p.id);
    const stock  = stockMap.has(p.id) ? stockMap.get(p.id) : null;
    const stockClass = stock == null ? '' : stock < 0 ? 'negativo' : stock <= 5 ? 'bajo' : '';
    const stockTxt = stock == null
      ? 'sin tracking'
      : stock < 0 ? 'Stock ' + stock
      : 'Stock ' + stock;

    const card = document.createElement('div');
    card.className = (_prodView === 'list' ? 'prod-row' : 'prod-card') + (enCart ? ' in-cart' : '');
    card.dataset.prodId = p.id;
    const sinTipo = p.tiene_envase && !p.tipo_envase_id;
    const _favs = _getFavoritos();
    const favSlot = Object.entries(_favs).find(([, v]) => v.id === p.id)?.[0];
    const favKey = favSlot ? 'F' + (parseInt(favSlot, 10) + 6) : null;
    const hoy = new Date().toISOString().slice(0, 10);
    const vencido = p.fecha_vencimiento && p.fecha_vencimiento <= hoy;
    const porVencer = !vencido && p.fecha_vencimiento &&
      ((new Date(p.fecha_vencimiento) - new Date(hoy)) / 86400000) <= 7;
    const tienePromo = p.descuento_volumen_qty > 0 && p.descuento_volumen_pct > 0;

    // Editar producto: solo administradores (los cajeros no modifican catálogo).
    const editBtnHtml = _isAdmin() ? '<button class="prod-card-edit" type="button" title="Editar producto">✏️</button>' : '';
    if (_prodView === 'list') {
      const tags =
        (sinTipo ? '<span class="prod-row-tag" style="background:rgba(245,158,11,.12);color:#b45309" title="Sin tipo de envase">⚠</span>' : '') +
        (p.es_combo ? '<span class="prod-row-tag" style="background:rgba(124,58,237,.12);color:#7c3aed">🎁</span>' : '') +
        (vencido ? '<span class="prod-row-tag" style="background:rgba(239,68,68,.12);color:#dc2626">⏰ VENC</span>' : '') +
        (porVencer ? '<span class="prod-row-tag" style="background:rgba(245,158,11,.12);color:#b45309">⏰ ' + p.fecha_vencimiento.slice(5) + '</span>' : '') +
        (p.peso_variable ? '<span class="prod-row-tag" style="background:rgba(59,130,246,.12);color:#2563eb" title="Peso variable">⚖</span>' : '') +
        (tienePromo ? '<span class="prod-row-tag" style="background:rgba(124,58,237,.12);color:#7c3aed">🎟 ' + p.descuento_volumen_pct + '%</span>' : '') +
        (favKey ? '<span class="prod-row-tag" style="background:rgba(245,158,11,.18);color:#b45309" title="Atajo ' + favKey + '">' + favKey + '</span>' : '');
      card.innerHTML =
        '<span class="prod-card-name"></span>' +
        (tags ? '<span class="prod-row-tags">' + tags + '</span>' : '') +
        '<span class="prod-row-stock ' + stockClass + '">' + (p.es_combo ? 'comp.' : stockTxt) + (p.unidad ? ' · ' + p.unidad.toUpperCase() : '') + '</span>' +
        '<span class="prod-row-precio">' + fmtARS(p.precio) + (p.precio_pos_falta ? ' <span title="Sin precio POS propio" style="font-size:10px;color:#f59e0b">⚠</span>' : '') + '</span>' +
        (enCart ? '<span class="prod-row-qty">' + enCart.cantidad + '</span>' : '') +
        editBtnHtml;
    } else {
    card.innerHTML =
      (enCart ? '<div class="prod-card-qty">' + (p.peso_variable ? enCart.cantidad : enCart.cantidad) + '</div>' : '') +
      editBtnHtml +
      (sinTipo ? '<div class="prod-card-warn" title="Producto retornable sin tipo de envase. Editá para asignar.">⚠ sin tipo</div>' : '') +
      (p.es_combo ? '<div class="prod-card-combo" title="Combo: descuenta stock de los componentes al vender">🎁 COMBO</div>' : '') +
      (vencido ? '<div class="prod-card-warn" style="background:rgba(239,68,68,.12);border-color:rgba(239,68,68,.4);color:#dc2626">⏰ VENCIDO</div>' : '') +
      (porVencer ? '<div class="prod-card-warn" title="Vence pronto">⏰ ' + p.fecha_vencimiento.slice(5) + '</div>' : '') +
      (p.peso_variable ? '<div class="prod-card-peso" title="Peso variable: pide cantidad al sumar">⚖</div>' : '') +
      (favKey ? '<div class="prod-card-fav" title="Atajo: presioná ' + favKey + '">' + favKey + '</div>' : '') +
      '<div class="prod-card-name"></div>' +
      '<div class="prod-card-precio">' + fmtARS(p.precio) + '</div>' +
      (tienePromo ? '<div style="font-size:10px;color:#7c3aed;font-weight:700">🎟 ' + p.descuento_volumen_qty + '+ → ' + p.descuento_volumen_pct + '% off</div>' : '') +
      '<div class="prod-card-stock ' + stockClass + '">' +
        '<span>' + (p.es_combo ? 'Stock por componentes' : stockTxt) + '</span>' +
        (p.unidad ? '<span style="text-transform:uppercase;font-size:10px;letter-spacing:.04em">' + p.unidad + '</span>' : '') +
      '</div>';
    }
    card.querySelector('.prod-card-name').textContent = p.nombre;
    card.addEventListener('click', () => agregarAlCarrito(p));
    const _editBtn = card.querySelector('.prod-card-edit');
    if (_editBtn) _editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      abrirAltaProducto({
        _editId: p.id,
        nombre: p.nombre,
        precio: p.precio,
        costo: p.costo,
        unidad: p.unidad,
        codigo_barra: p.codigo_barra,
        tiene_envase: p.tiene_envase,
        tipo_envase_id: p.tipo_envase_id,
        es_combo: p.es_combo,
        peso_variable: p.peso_variable,
        fecha_vencimiento: p.fecha_vencimiento,
        descuento_volumen_qty: p.descuento_volumen_qty,
        descuento_volumen_pct: p.descuento_volumen_pct,
      });
    });
    grid.appendChild(card);
  });
}

function agregarAlCarrito(p){
  if (p.fecha_vencimiento) {
    const hoy = new Date().toISOString().slice(0, 10);
    if (p.fecha_vencimiento <= hoy) {
      if (!confirm('⚠ ' + p.nombre + ' está vencido (vto ' + p.fecha_vencimiento + '). ¿Vender igual?')) return;
    } else {
      const dias = Math.floor((new Date(p.fecha_vencimiento) - new Date(hoy)) / 86400000);
      if (dias <= 7) {
        toast('⚠ ' + p.nombre + ' vence en ' + dias + ' días', 'warn');
      }
    }
  }
  if (p.peso_variable && !cart.get(p.id)) {
    const raw = prompt('Peso/cantidad de ' + p.nombre + ' (' + (p.unidad || 'kg') + '):', '1');
    if (raw === null) return;
    const valor = parseFloat(String(raw).replace(',', '.'));
    if (!Number.isFinite(valor) || valor <= 0) { toast('Cantidad inválida', 'warn'); return; }
    cart.set(p.id, {
      cantidad: valor,
      precio: parseFloat(p.precio) || 0,
      nombre: p.nombre,
      tiene_envase: !!p.tiene_envase,
      envase_modo: p.tiene_envase ? 'comodato' : 'no_aplica',
    });
    renderCart();
    renderProductGrid();
    return;
  }
  const cur = cart.get(p.id);
  if (cur) cur.cantidad += 1;
  else {
    cart.set(p.id, {
      cantidad: 1,
      precio: parseFloat(p.precio) || 0,
      nombre: p.nombre,
      tiene_envase: !!p.tiene_envase,
      envase_modo: p.tiene_envase ? 'comodato' : 'no_aplica',
    });
    if (clienteSel?.id) {
      const k = _precioCacheKey(clienteSel.id, p.id);
      if (_precioCache.has(k)) {
        const it = cart.get(p.id);
        if (it) it.precio = _precioCache.get(k);
      } else {
        resolverPrecioCliente(clienteSel.id, p.id).then(r => {
          if (r == null) return;
          const it = cart.get(p.id);
          if (it) {
            it.precio = r;
            renderCart();
          }
        });
      }
    }
  }
  renderCart();
  renderProductGrid();
  if (window.innerWidth <= 760 && cart.size === 1) {
    document.getElementById('pos-cart').classList.add('open');
  }
}

let _precioCache = new Map();
function _precioCacheKey(cliId, prodId){ return cliId + '|' + prodId; }

async function resolverPrecioCliente(cliId, prodId){
  const k = _precioCacheKey(cliId, prodId);
  if (_precioCache.has(k)) return _precioCache.get(k);
  const { data, error } = await sb.rpc('resolver_precio', {
    p_cliente_id:  cliId,
    p_producto_id: prodId,
    p_contexto:    'pos',
  });
  if (error) { console.warn('resolver_precio:', error); return null; }
  const v = parseFloat(data);
  _precioCache.set(k, v);
  return v;
}

async function recalcularPreciosCart(){
  if (cart.size === 0) return;
  if (!clienteSel?.id) {
    cart.forEach((it, prodId) => {
      const p = productos.find(x => x.id === prodId);
      if (p) it.precio = parseFloat(p.precio) || 0;
    });
    renderCart();
    return;
  }
  const ids = Array.from(cart.keys());
  const { data, error } = await sb.rpc('resolver_precios_bulk', {
    p_cliente_id:   clienteSel.id,
    p_producto_ids: ids,
    p_contexto:     'pos',
  });
  if (error) { console.warn('resolver_precios_bulk:', error); return; }
  (data || []).forEach(r => {
    const it = cart.get(r.producto_id);
    if (it && !it.promo) {
      it.precio = parseFloat(r.precio) || it.precio;
      _precioCache.set(_precioCacheKey(clienteSel.id, r.producto_id), it.precio);
    }
  });
  renderCart();
}

function renderCart(){
  const list = document.getElementById('cart-list');
  const totalEl = document.getElementById('pos-total');
  const handleCount = document.getElementById('cart-handle-count');
  const handleTotal = document.getElementById('cart-handle-total');
  const btnEfe = document.getElementById('btn-efe');
  const btnTrs = document.getElementById('btn-trs');
  const btnMp  = document.getElementById('btn-mp');
  if (!list) return;

  let total = 0, count = 0;
  list.innerHTML = '';

  if (cart.size === 0) {
    list.innerHTML =
      '<div class="pos-cart-empty">' +
      '<div class="pos-cart-empty-icon">🛒</div>' +
      '<div>Carrito vacío</div>' +
      '<div style="font-size:11px;margin-top:4px">Tocá un producto para empezar</div>' +
      '</div>';
  } else {
    cart.forEach((it, prodId) => {
      const sub = it.cantidad * it.precio;
      total += sub; count += it.cantidad;
      const row = document.createElement('div');
      row.className = 'cart-item';
      const toggleHtml = it.tiene_envase
        ? '<div class="cart-item-envase ' + (it.envase_modo === 'venta' ? 'venta' : 'comodato') + '" data-prod="' + prodId + '">' +
            (it.envase_modo === 'venta' ? '💰 Compra envase' : '📦 Comodato') +
          '</div>'
        : '';
      const llevaHint = (it.entregar != null && it.entregar < it.cantidad)
        ? '<div style="font-size:10px;font-weight:700;color:#047857;margin-top:3px">📦 lleva ' + it.entregar + ' · prepaga ' + (it.cantidad - it.entregar) + '</div>'
        : '';
      const promoTag = it.promo
        ? '<div style="display:inline-block;margin-top:3px;font-size:10px;font-weight:700;color:#b45309;background:rgba(245,158,11,.12);border-radius:6px;padding:1px 6px">🎁 ' + String(it.promo.nombre || 'promo').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c])) + '</div>'
        : '';
      row.innerHTML =
        '<div class="cart-item-info">' +
        '  <div class="cart-item-name"></div>' +
        '  <div class="cart-item-precio">' + fmtARS(it.precio) + ' c/u</div>' +
        '  ' + toggleHtml + promoTag + llevaHint +
        '</div>' +
        '<div class="cart-stepper">' +
        '  <button class="dec" title="−">−</button>' +
        '  <span class="cart-stepper-val">' + it.cantidad + '</span>' +
        '  <button class="inc" title="+">+</button>' +
        '</div>' +
        '<div class="cart-item-sub">' + fmtARS(sub) + '</div>' +
        '<button class="cart-item-rm" title="Quitar">×</button>';
      row.querySelector('.cart-item-name').textContent = it.nombre;
      row.querySelector('.dec').addEventListener('click', () => stepCart(prodId, -1));
      row.querySelector('.inc').addEventListener('click', () => stepCart(prodId, +1));
      row.querySelector('.cart-item-rm').addEventListener('click', () => {
        cart.delete(prodId); renderCart(); renderProductGrid();
      });
      const tog = row.querySelector('.cart-item-envase');
      if (tog) {
        tog.addEventListener('click', () => {
          const itemNow = cart.get(prodId);
          if (!itemNow) return;
          itemNow.envase_modo = itemNow.envase_modo === 'venta' ? 'comodato' : 'venta';
          renderCart();
        });
      }
      list.appendChild(row);
    });
  }

  let promoOff = 0;
  cart.forEach((it, prodId) => {
    const p = productos.find(x => x.id === prodId);
    if (!p) return;
    const qty = Number(p.descuento_volumen_qty || 0);
    const pct = Number(p.descuento_volumen_pct || 0);
    if (qty > 0 && pct > 0 && it.cantidad >= qty) {
      promoOff += (it.cantidad * it.precio) * pct / 100;
    }
  });
  let prepagoOff = 0;
  cart.forEach(it => {
    if (it.entregar != null && it.entregar < it.cantidad && it.precioPrepago != null && it.precioPrepago < it.precio) {
      prepagoOff += (it.cantidad - it.entregar) * (it.precio - it.precioPrepago);
    }
  });
  const descuento = _calcDescuento(total) + promoOff + prepagoOff;
  const totalFinal = Math.max(0, total - descuento);
  const promoTxt = (promoOff > 0 ? ' · promo –' + fmtARS(promoOff) : '') + (prepagoOff > 0 ? ' · prepago –' + fmtARS(prepagoOff) : '');
  const totalStr = descuento > 0
    ? fmtARS(totalFinal) + ' (–' + fmtARS(descuento) + promoTxt + ')'
    : fmtARS(totalFinal);
  if (totalEl)     totalEl.textContent = totalStr;
  if (handleCount) handleCount.textContent = count;
  if (handleTotal) handleTotal.textContent = totalStr;

  const disabled = total <= 0;
  if (btnEfe) btnEfe.disabled = disabled;
  if (btnTrs) btnTrs.disabled = disabled;
  if (btnMp)  btnMp.disabled  = disabled;

  const btnPre = document.getElementById('btn-prepago');
  if (btnPre) btnPre.style.display = (clienteSel?.id && cart.size > 0) ? '' : 'none';

  if (typeof _refrescarEnvasesSaldo === 'function') _refrescarEnvasesSaldo();
}

function stepCart(prodId, delta){
  const it = cart.get(prodId);
  if (!it) return;
  it.cantidad += delta;
  if (it.cantidad <= 0) { cart.delete(prodId); renderCart(); renderProductGrid(); return; }
  if (it.entregar != null && it.entregar > it.cantidad) it.entregar = it.cantidad;
  renderCart();
  renderProductGrid();
}

let _prepagoDescuento = { valor: 0, tipo: 'pct' };
let _prepagosPendientesTotal = 0;
let _prepagoToastedCli = null;

window.abrirEntregaParcial = () => {
  if (!clienteSel?.id) { toast('El prepago requiere un cliente real (no Mostrador)', 'warn'); return; }
  if (cart.size === 0) { toast('Cargá productos primero', 'warn'); return; }
  let ov = document.getElementById('prepago-ov');
  if (ov) ov.remove();
  ov = document.createElement('div');
  ov.id = 'prepago-ov';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:2000;display:flex;align-items:center;justify-content:center;padding:20px';
  const rows = Array.from(cart.entries()).map(([prodId, it]) => {
    const lleva = (it.entregar != null ? it.entregar : it.cantidad);
    return '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid #f1f5f9">' +
      '<div style="flex:1;min-width:0"><div style="font-weight:600;font-size:13px">' + (it.nombre || '') + '</div>' +
      '<div style="font-size:11px;color:#64748b">compra ' + it.cantidad + ' · ' + fmtARS(it.precio) + ' c/u</div></div>' +
      '<div style="display:flex;align-items:center;gap:6px">' +
        '<span style="font-size:11px;color:#64748b">se lleva</span>' +
        '<input type="number" class="pp-lleva" data-prod="' + prodId + '" min="0" max="' + it.cantidad + '" step="1" value="' + lleva + '" style="width:64px;padding:7px 8px;border:1px solid var(--border);border-radius:8px;text-align:center;font-weight:700">' +
        '<span style="font-size:11px;color:#64748b">de ' + it.cantidad + '</span>' +
      '</div></div>';
  }).join('');
  ov.innerHTML =
    '<div style="background:#fff;border-radius:16px;padding:20px;max-width:460px;width:100%;max-height:85vh;overflow:auto;box-shadow:0 20px 60px rgba(0,0,0,.3)">' +
      '<div style="font-size:16px;font-weight:800;margin-bottom:2px">📦 Entrega parcial / prepago</div>' +
      '<div style="font-size:12px;color:#64748b;margin-bottom:14px">El cliente paga todo. Lo que no se lleva queda como prepago (precio congelado) para entregar después.</div>' +
      rows +
      '<div style="margin-top:14px;border-top:1px solid #f1f5f9;padding-top:12px">' +
        '<div style="font-size:12px;font-weight:700;color:#047857;margin-bottom:6px">💸 Descuento por pago adelantado <span style="font-weight:500;color:#64748b">(solo sobre lo prepagado)</span></div>' +
        '<div style="display:flex;gap:6px;align-items:center">' +
          '<input type="number" id="pp-desc" min="0" step="0.01" value="' + (_prepagoDescuento.valor || '') + '" placeholder="0" style="flex:1;padding:8px;border:1px solid var(--border);border-radius:8px">' +
          '<select id="pp-desc-tipo" style="padding:8px;border:1px solid var(--border);border-radius:8px">' +
            '<option value="pct"' + (_prepagoDescuento.tipo === 'pct' ? ' selected' : '') + '>%</option>' +
            '<option value="ars"' + (_prepagoDescuento.tipo === 'ars' ? ' selected' : '') + '>$</option>' +
          '</select>' +
        '</div>' +
        '<div id="pp-desc-info" style="font-size:11px;color:#64748b;margin-top:6px"></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">' +
        '<button id="pp-cancel" style="padding:9px 16px;border:1px solid var(--border);background:#fff;border-radius:10px;font-weight:600;cursor:pointer">Cancelar</button>' +
        '<button id="pp-ok" style="padding:9px 16px;border:none;background:#047857;color:#fff;border-radius:10px;font-weight:700;cursor:pointer">Aplicar</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(ov);

  const _prepaidSub = () => {
    let s = 0;
    ov.querySelectorAll('.pp-lleva').forEach(inp => {
      const it = cart.get(inp.dataset.prod);
      if (!it) return;
      let lleva = parseInt(inp.value); if (isNaN(lleva) || lleva < 0) lleva = 0; if (lleva > it.cantidad) lleva = it.cantidad;
      s += (it.cantidad - lleva) * it.precio;
    });
    return s;
  };
  const recalcInfo = () => {
    const sub = _prepaidSub();
    const valor = parseFloat(ov.querySelector('#pp-desc').value) || 0;
    const tipo = ov.querySelector('#pp-desc-tipo').value;
    let ahorro = 0;
    if (sub > 0 && valor > 0) ahorro = tipo === 'pct' ? sub * Math.min(valor, 100) / 100 : Math.min(valor, sub);
    const info = ov.querySelector('#pp-desc-info');
    info.textContent = sub <= 0
      ? 'No hay unidades prepagadas (todo se entrega ahora).'
      : 'Prepago: ' + fmtARS(sub) + (ahorro > 0 ? ' · Ahorro: ' + fmtARS(ahorro) + ' → ' + fmtARS(sub - ahorro) : '');
  };
  ov.querySelectorAll('.pp-lleva').forEach(inp => inp.addEventListener('input', recalcInfo));
  ov.querySelector('#pp-desc').addEventListener('input', recalcInfo);
  ov.querySelector('#pp-desc-tipo').addEventListener('change', recalcInfo);
  recalcInfo();

  ov.querySelector('#pp-cancel').addEventListener('click', () => ov.remove());
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove(); });
  ov.querySelector('#pp-ok').addEventListener('click', () => {
    ov.querySelectorAll('.pp-lleva').forEach(inp => {
      const it = cart.get(inp.dataset.prod);
      if (!it) return;
      let lleva = parseInt(inp.value);
      if (isNaN(lleva) || lleva < 0) lleva = 0;
      if (lleva > it.cantidad) lleva = it.cantidad;
      it.entregar = (lleva >= it.cantidad) ? null : lleva;
    });
    const valor = parseFloat(ov.querySelector('#pp-desc').value) || 0;
    const tipo = ov.querySelector('#pp-desc-tipo').value;
    _prepagoDescuento = { valor, tipo };
    let sub = 0;
    cart.forEach(it => { if (it.entregar != null && it.entregar < it.cantidad) sub += (it.cantidad - it.entregar) * it.precio; });
    let factor = 1;
    if (sub > 0 && valor > 0) {
      factor = tipo === 'pct'
        ? Math.max(0, 1 - Math.min(valor, 100) / 100)
        : Math.max(0, (sub - Math.min(valor, sub)) / sub);
    }
    cart.forEach(it => {
      it.precioPrepago = (it.entregar != null && it.entregar < it.cantidad && factor < 1)
        ? Math.round(it.precio * factor * 100) / 100
        : null;
    });
    ov.remove();
    renderCart();
    const prepagados = Array.from(cart.values()).reduce((s, it) =>
      s + ((it.entregar != null && it.entregar < it.cantidad) ? (it.cantidad - it.entregar) : 0), 0);
    if (prepagados > 0) toast('📦 ' + prepagados + ' u. en prepago' + (factor < 1 ? ' con descuento' : '') + ' al cobrar', 'ok');
  });
};

// ── Stock predictivo: avisa qué reponer según el ritmo de venta ──
let _stockSug = [];
async function _stockPrediccionCard(){
  _stockSug = [];
  const UMBRAL = 7, COBERTURA = 14, DIAS = 30;
  try {
    const { data } = await sb.rpc('pos_stock_velocidad', { p_organization_id: orgId, p_tienda_id: tiendaId || null, p_dias: DIAS });
    const arr = data || [];
    const dias = arr[0]?.dias || DIAS;
    const vel = new Map(arr.map(v => [v.producto_id, Number(v.unidades) || 0]));
    productos.forEach(p => {
      if (p.es_combo) return;
      const vendidos = vel.get(p.id) || 0;
      if (vendidos <= 0) return;
      const ritmo = vendidos / dias;                        // u/día
      const stock = stockMap.has(p.id) ? Number(stockMap.get(p.id)) : 0;
      const diasRest = ritmo > 0 ? stock / ritmo : Infinity;
      if (diasRest <= UMBRAL) {
        const sugerido = Math.max(1, Math.ceil(ritmo * COBERTURA - stock));
        _stockSug.push({ id: p.id, nombre: p.nombre, ritmo, stock, diasRest, sugerido });
      }
    });
    _stockSug.sort((a, b) => a.diasRest - b.diasRest);
  } catch (_) { return ''; }
  if (!_stockSug.length) return '';
  const esc = s => String(s ?? '').replace(/[<>&]/g, '');
  const puedeRep = _canRecibirStock();
  return '<div style="background:rgba(245,158,11,.07);border:1.5px solid rgba(245,158,11,.4);border-radius:12px;padding:12px 14px;margin-bottom:14px">' +
    '<div style="font-weight:700;margin-bottom:8px;display:flex;align-items:center">🔮 Reponé pronto' +
      iHelp('Predicción según tu ritmo de venta de los últimos ' + DIAS + ' días: estimamos cuántos días de stock te quedan. Se listan los que se agotarían en ' + UMBRAL + ' días o menos, con una cantidad sugerida para cubrir ~' + COBERTURA + ' días.') + '</div>' +
    '<div style="display:flex;flex-direction:column;gap:6px">' +
    _stockSug.map((s, i) => {
      const d = s.diasRest;
      const dTxt = d <= 0 ? 'sin stock' : (d < 1 ? 'menos de 1 día' : ('~' + Math.round(d) + ' día' + (Math.round(d) === 1 ? '' : 's')));
      const col = d <= 1 ? '#dc2626' : '#b45309';
      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:13px;background:#fff;border:1px solid var(--border);border-radius:8px;padding:8px 10px">' +
        '<div style="min-width:0"><b>' + esc(s.nombre) + '</b>' +
        '<div style="font-size:11px;color:var(--muted)">stock ' + s.stock + ' · vendés ~' + (Math.round(s.ritmo * 10) / 10) + '/día · <b style="color:' + col + '">te queda ' + dTxt + '</b></div></div>' +
        (puedeRep ? '<button class="sug-rep" data-i="' + i + '" style="padding:6px 12px;border:1.5px solid var(--primary);background:rgba(124,58,237,.06);color:var(--primary);border-radius:50px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap;flex:0 0 auto">+ Reponer ' + s.sugerido + '</button>' : '') +
      '</div>';
    }).join('') +
    '</div></div>';
}

let _stockShowInactive = false;
async function renderStock(){
  const list = document.getElementById('stock-list');
  if (!list) return;
  const admin = _isAdmin();
  // Permisos de stock: los admins tienen todo; a los cajeros el admin les puede
  // habilitar "recibir" (reponer/cargar, sumar) y/o "ajustar" (descontar y
  // editar/dar de baja productos) desde Configuración → Usuarios.
  const canRecibir = _canRecibirStock();
  const canAjustar = _canAjustarStock();
  const canAny = canRecibir || canAjustar;

  // El toggle de "bloquear venta por stock" es una config de operación: admin.
  const strictCb = document.getElementById('stock-strict-toggle');
  if (strictCb && strictCb.closest('label')) {
    strictCb.closest('label').style.display = admin ? '' : 'none';
  }

  if (!productos.length && !_stockShowInactive) {
    list.innerHTML = (canAny ? _stockAdminToolbar(canRecibir, canAjustar) : '') +
      '<div style="padding:30px;text-align:center;color:var(--muted)">Sin productos en el catálogo' +
      (canAjustar ? '. Tocá "➕ Producto" para crear el primero.' : '.') + '</div>';
    if (canAny) _wireStockToolbar();
    return;
  }

  const negativos = productos.filter(p => stockMap.has(p.id) && stockMap.get(p.id) < 0);
  let html = canAny ? _stockAdminToolbar(canRecibir, canAjustar) : '';
  if (negativos.length) {
    const items = negativos.map(p =>
      '<li><b>' + p.nombre.replace(/</g,'&lt;') + '</b>: ' + stockMap.get(p.id) + '</li>'
    ).join('');
    html += '<div style="background:rgba(239,68,68,.08);border:1.5px solid rgba(239,68,68,.35);'
      + 'border-radius:12px;padding:12px 14px;margin-bottom:14px;color:#991b1b;font-size:13px">'
      + '<div style="font-weight:700;margin-bottom:6px">⚠ ' + negativos.length
      + ' producto' + (negativos.length>1?'s':'') + ' con stock negativo</div>'
      + '<ul style="margin:0;padding-left:18px;line-height:1.5">' + items + '</ul>'
      + '</div>';
  }
  if (_canRecibirStock()) html += await _stockPrediccionCard();
  list.innerHTML = html;
  if (canAny) _wireStockToolbar();
  list.querySelectorAll('.sug-rep').forEach(b => b.addEventListener('click', () => {
    const s = _stockSug[+b.dataset.i]; if (!s) return;
    const p = productos.find(x => x.id === s.id); if (p) reponer(p, s.sugerido);
  }));

  productos.forEach(p => {
    const cant = stockMap.has(p.id) ? stockMap.get(p.id) : 0;
    const cls  = cant < 0 ? 'negativo' : cant <= 5 ? 'bajo' : '';
    // Línea secundaria: precio siempre; costo y margen solo para admin.
    let sub = fmtARS(p.precio) + (p.unidad ? ' · ' + p.unidad : '');
    if (admin && p.costo != null && p.costo !== '' && Number(p.costo) > 0) {
      const costo = Number(p.costo);
      const gan = p.precio - costo;
      const mg = p.precio > 0 ? (gan / p.precio) * 100 : 0;
      const col = gan < 0 ? '#dc2626' : '#059669';
      sub += ' · costo ' + fmtARS(costo) +
        ' · <b style="color:' + col + '">margen ' + mg.toFixed(0) + '% (' + (gan>=0?'+':'') + fmtARS(gan) + ')</b>';
    } else if (admin) {
      sub += ' · <span style="color:#f59e0b">sin costo</span>';
    }
    const row = document.createElement('div');
    row.className = 'stock-row';
    row.innerHTML =
      '<div>' +
        '<div class="stock-row-name"></div>' +
        '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + sub + '</div>' +
      '</div>' +
      '<div class="stock-row-cant ' + cls + '">' + cant + '</div>' +
      (canAny
        ? '<div style="display:flex;gap:6px">' +
            (canRecibir ? '<button class="rep-btn" style="padding:6px 12px;border:1.5px solid var(--primary);background:rgba(124,58,237,.06);color:var(--primary);border-radius:50px;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">' + (canAjustar ? '+ Reponer' : '+ Recibir') + '</button>' : '') +
            (canAjustar ? '<button class="edit-btn" title="Editar producto" style="padding:6px 10px;border:1.5px solid var(--border);background:#fff;border-radius:50px;font-size:12px;cursor:pointer">✏️</button>' : '') +
            (canAjustar ? '<button class="baja-btn" title="Dar de baja" style="padding:6px 10px;border:1.5px solid rgba(239,68,68,.35);background:rgba(239,68,68,.06);color:#dc2626;border-radius:50px;font-size:12px;cursor:pointer">🗑</button>' : '') +
          '</div>'
        : '<div style="font-size:11px;color:var(--muted)">solo lectura</div>');
    row.querySelector('.stock-row-name').textContent = p.nombre;
    if (canAny) {
      row.querySelector('.rep-btn')?.addEventListener('click', () => reponer(p));
      row.querySelector('.edit-btn')?.addEventListener('click', () => abrirAltaProducto({
        _editId: p.id, nombre: p.nombre, precio: p.precio, costo: p.costo, unidad: p.unidad,
        codigo_barra: p.codigo_barra, tiene_envase: p.tiene_envase, tipo_envase_id: p.tipo_envase_id,
        es_combo: p.es_combo, peso_variable: p.peso_variable, fecha_vencimiento: p.fecha_vencimiento,
        descuento_volumen_qty: p.descuento_volumen_qty, descuento_volumen_pct: p.descuento_volumen_pct,
      }));
      row.querySelector('.baja-btn')?.addEventListener('click', () => darDeBajaProducto(p));
    }
    list.appendChild(row);
  });

  // Sección de productos dados de baja (inactivos) — requiere permiso de ajuste.
  if (canAjustar && _stockShowInactive) {
    const { data: inact } = await sb.from('productos')
      .select('id, nombre, precio, precio_pos, unidad, codigo_barra')
      .eq('organization_id', orgId).eq('activo', false).order('nombre');
    const cont = document.createElement('div');
    cont.style.cssText = 'margin-top:18px';
    cont.innerHTML = '<h3 style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:0 0 8px">Dados de baja (' + (inact?.length || 0) + ')</h3>';
    if (!inact || !inact.length) {
      cont.innerHTML += '<div style="font-size:12px;color:var(--muted);padding:8px">No hay productos dados de baja.</div>';
    } else {
      inact.forEach(p => {
        const r = document.createElement('div');
        r.className = 'stock-row';
        r.style.opacity = '.7';
        r.innerHTML = '<div><div class="ia-nm" style="font-weight:600;font-size:13px"></div>' +
          '<div style="font-size:11px;color:var(--muted)">' + fmtARS(p.precio_pos != null ? p.precio_pos : p.precio) + (p.unidad ? ' · ' + p.unidad : '') + '</div></div>' +
          '<div></div>' +
          '<button class="react-btn" style="padding:6px 12px;border:1.5px solid #059669;background:rgba(16,185,129,.08);color:#059669;border-radius:50px;font-size:12px;font-weight:700;cursor:pointer">Reactivar</button>';
        r.querySelector('.ia-nm').textContent = p.nombre;
        r.querySelector('.react-btn').addEventListener('click', () => reactivarProducto(p));
        cont.appendChild(r);
      });
    }
    list.appendChild(cont);
  }
}

function _stockAdminToolbar(canRecibir, canAjustar) {
  if (canRecibir === undefined) { canRecibir = true; canAjustar = true; }  // compat
  return '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' +
    (canAjustar ? '<button id="stk-add" type="button" style="padding:9px 16px;border-radius:50px;border:1.5px solid var(--primary);background:rgba(124,58,237,.06);color:var(--primary);font-family:inherit;font-size:13px;font-weight:700;cursor:pointer">➕ Producto</button>' : '') +
    (canRecibir ? '<button id="stk-carga" type="button" style="padding:9px 16px;border-radius:50px;border:1.5px solid var(--border);background:#fff;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer">📦 Cargar mercadería</button>' : '') +
    (canAjustar ? '<button id="stk-inact" type="button" style="padding:9px 16px;border-radius:50px;border:1.5px solid var(--border);background:#fff;font-family:inherit;font-size:13px;font-weight:600;cursor:pointer">' + (_stockShowInactive ? '✓ Ocultar dados de baja' : '👁 Ver dados de baja') + '</button>' : '') +
    '</div>';
}
function _wireStockToolbar() {
  document.getElementById('stk-add')?.addEventListener('click', () => abrirAltaProducto());
  document.getElementById('stk-carga')?.addEventListener('click', () => abrirCargaStock());
  document.getElementById('stk-inact')?.addEventListener('click', () => { _stockShowInactive = !_stockShowInactive; renderStock(); });
}

async function darDeBajaProducto(p) {
  const ok = await tmvDialog.confirm(
    'Se quita "' + p.nombre + '" del catálogo (no se borra el histórico de ventas). Podés reactivarlo después desde "Ver dados de baja".',
    { title: 'Dar de baja producto', severity: 'warning', okLabel: 'Dar de baja', cancelLabel: 'Cancelar' }
  );
  if (!ok) return;
  const { error } = await sb.from('productos').update({ activo: false }).eq('id', p.id);
  if (error) { tmvShowError(error, { title: 'No se pudo dar de baja' }); return; }
  toast('Producto dado de baja', 'ok');
  await cargarProductos();
  renderProductGrid();
  renderStock();
}

async function reactivarProducto(p) {
  const { error } = await sb.from('productos').update({ activo: true }).eq('id', p.id);
  if (error) { tmvShowError(error, { title: 'No se pudo reactivar' }); return; }
  toast('Producto reactivado ✓', 'ok');
  await cargarProductos();
  renderProductGrid();
  renderStock();
}

async function reponer(p, sugerido){
  // Quien solo tiene permiso de "recibir" puede sumar pero NO descontar.
  const _soloRecibir = !_canAjustarStock();
  const _valorIni = (sugerido && sugerido > 0) ? sugerido : 10;
  const cur = stockMap.has(p.id) ? stockMap.get(p.id) : 0;
  const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
  const html = `
    <div id="pos-rep-overlay" style="position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:14px"
      onmousedown="this.dataset.dwn=(event.target===this?&quot;1&quot;:&quot;&quot;)" onclick="if(event.target===this&&this.dataset.dwn===&quot;1&quot;)this.remove();this.dataset.dwn=&quot;&quot;">
      <div style="background:#fff;border-radius:14px;max-width:440px;width:100%;padding:20px;box-shadow:0 14px 40px rgba(0,0,0,.18)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <div style="font-weight:700;font-size:16px">📦 ${_soloRecibir ? 'Recibir stock' : 'Ajustar stock'}</div>
          <button type="button" onclick="document.getElementById('pos-rep-overlay').remove()"
            style="background:none;border:0;font-size:22px;cursor:pointer;color:#64748b">×</button>
        </div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:14px">${escHtml(p.nombre)} · stock actual: <b style="color:var(--ink)">${cur}</b></div>
        <div id="pos-rep-origen-wrap">
          <label style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.04em">Origen del stock</label>
          <select id="pos-rep-origen" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:5px;margin-bottom:12px">
            <option value="compra">🛒 Compra a proveedor (no descuenta)</option>
            <option value="deposito">🏪 Sale del depósito central</option>
            <option value="tienda">🏬 Sale de otra tienda</option>
            <option value="vehiculo">🚚 Sale del vehículo</option>
          </select>
        </div>
        <div id="pos-rep-tienda-wrap" style="display:none;margin-bottom:12px">
          <label style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.04em">Tienda origen</label>
          <select id="pos-rep-tienda" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:5px"></select>
        </div>
        <div id="pos-rep-vehiculo-wrap" style="display:none;margin-bottom:12px">
          <label style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.04em">Vehículo origen</label>
          <select id="pos-rep-vehiculo" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:5px"></select>
        </div>
        <label style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.04em">Cantidad</label>
        <input id="pos-rep-cant" type="number" inputmode="numeric" placeholder="${_soloRecibir ? '10' : '+10 ó -3'}" value="${_valorIni}" step="1" ${_soloRecibir ? 'min="1"' : ''}
          style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:5px;margin-bottom:6px">
        <div style="font-size:10px;color:var(--muted);margin-bottom:14px">${_soloRecibir ? 'Ingresá cuánto recibís (solo suma).' : '+ suma · − resta (merma, corrección, rotura)'}</div>
        <div id="pos-rep-costo-wrap" style="display:none;background:rgba(16,185,129,.05);border:1px solid rgba(16,185,129,.2);border-radius:9px;padding:10px;margin-bottom:14px">
          <label style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.04em">💲 Costo unitario de esta entrega</label>
          <input id="pos-rep-costo" type="number" min="0" step="0.01" placeholder="0" autocomplete="off"
            style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:5px;margin-bottom:8px">
          <label style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.04em">Cómo actualizar el costo del producto</label>
          <select id="pos-rep-costo-modo" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:5px">
            <option value="promedio" selected>Promedio ponderado (recomendado)</option>
            <option value="reemplazar">Reemplazar por este costo</option>
            <option value="no">No cambiar el costo</option>
          </select>
          <div id="pos-rep-costo-hint" style="font-size:11px;color:var(--muted);margin-top:6px"></div>
        </div>
        <div id="pos-rep-motivo-wrap" style="display:none;margin-bottom:14px">
          <label style="font-size:11px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.04em">Motivo *</label>
          <input id="pos-rep-motivo" type="text" placeholder="Ej: rotura, faltante en inventario, corrección"
            style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:5px">
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button type="button" onclick="document.getElementById('pos-rep-overlay').remove()"
            style="padding:10px 16px;border:1.5px solid var(--border);background:#fff;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer">Cancelar</button>
          <button type="button" id="pos-rep-save"
            style="padding:10px 18px;border:0;background:var(--primary);color:#fff;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer">Aplicar</button>
        </div>
      </div>
    </div>`;
  const div = document.createElement('div'); div.innerHTML = html;
  document.body.appendChild(div.firstElementChild);

  const { data: tiendasLista } = await sb.rpc('pos_listar_tiendas', { p_organization_id: orgId });
  const tSel = document.getElementById('pos-rep-tienda');
  if (tSel) tSel.innerHTML = (tiendasLista || [])
    .filter(t => t.id !== tiendaId)
    .map(t => `<option value="${t.id}">${(t.es_principal ? '★ ' : '') + t.nombre}</option>`).join('');
  const { data: stocks } = await sb.from('stock_repartidor')
    .select('id, vehiculo_id, vehiculos(patente, marca, modelo)')
    .eq('organization_id', orgId)
    .eq('fecha', new Date().toISOString().slice(0,10))
    .eq('estado', 'abierto');
  const vSel = document.getElementById('pos-rep-vehiculo');
  if (vSel) vSel.innerHTML = (stocks || []).map(s =>
    `<option value="${s.id}">${s.vehiculos?.patente || '—'} · ${s.vehiculos?.marca || ''} ${s.vehiculos?.modelo || ''}</option>`
  ).join('') || '<option value="">— sin jornadas activas —</option>';

  const origenSel = document.getElementById('pos-rep-origen');
  origenSel.addEventListener('change', e => {
    const v = e.target.value;
    document.getElementById('pos-rep-tienda-wrap').style.display = v === 'tienda' ? '' : 'none';
    document.getElementById('pos-rep-vehiculo-wrap').style.display = v === 'vehiculo' ? '' : 'none';
  });

  const cantInp = document.getElementById('pos-rep-cant');
  const btnSave = document.getElementById('pos-rep-save');

  // Costo de la entrega (solo admin; visible al sumar stock).
  const costoInp  = document.getElementById('pos-rep-costo');
  const costoModo = document.getElementById('pos-rep-costo-modo');
  const costoHint = document.getElementById('pos-rep-costo-hint');
  if (costoInp) costoInp.value = (p.costo != null && p.costo !== '') ? p.costo : '';
  const recalcCosto = () => {
    if (!costoHint) return;
    const cant = parseInt(cantInp.value, 10) || 0;
    const cn = parseFloat(costoInp.value) || 0;
    const modo = costoModo.value;
    if (cant <= 0) { costoHint.textContent = ''; return; }
    const nuevo = _costoNuevoPonderado(modo, cur, p.costo, cant, cn);
    if (nuevo == null) {
      costoHint.textContent = modo === 'no'
        ? 'El costo del producto no se modifica.'
        : 'Ingresá el costo de esta entrega para actualizar el costo del producto.';
      return;
    }
    const precio = Number(p.precio) || 0;
    const mg = precio > 0 ? ((precio - nuevo) / precio * 100) : 0;
    costoHint.innerHTML = 'Costo anterior: <b>' + fmtARS(p.costo || 0) + '</b> → nuevo costo: ' +
      '<b style="color:#059669">' + fmtARS(nuevo) + '</b>' +
      (precio > 0 ? ' · margen <b>' + mg.toFixed(0) + '%</b>' : '') +
      (modo === 'promedio' ? ' <span style="color:var(--muted)">(promedio sobre ' + cur + ' + ' + cant + ' u.)</span>' : '');
  };
  if (costoInp)  costoInp.addEventListener('input', recalcCosto);
  if (costoModo) costoModo.addEventListener('change', recalcCosto);

  const updateMode = () => {
    const v = parseInt(cantInp.value, 10) || 0;
    const esResta = v < 0;
    document.getElementById('pos-rep-origen-wrap').style.display = esResta ? 'none' : '';
    document.getElementById('pos-rep-motivo-wrap').style.display = esResta ? '' : 'none';
    // El costo solo aplica al SUMAR stock (recibir mercadería), no al restar.
    document.getElementById('pos-rep-costo-wrap').style.display = esResta ? 'none' : '';
    if (esResta) {
      document.getElementById('pos-rep-tienda-wrap').style.display = 'none';
      document.getElementById('pos-rep-vehiculo-wrap').style.display = 'none';
    } else {
      origenSel.dispatchEvent(new Event('change'));
    }
    btnSave.textContent = esResta ? 'Descontar' : 'Reponer';
    btnSave.style.background = esResta ? '#dc2626' : 'var(--primary)';
    recalcCosto();
  };
  cantInp.addEventListener('input', updateMode);
  updateMode();

  btnSave.addEventListener('click', async () => {
    const cant = parseInt(cantInp.value, 10) || 0;
    if (cant === 0) { toast('Cantidad inválida', 'err'); return; }
    if (_soloRecibir && cant < 0) {
      toast('No tenés permiso para descontar stock. Pedíselo al administrador.', 'err'); return;
    }
    if (cant < 0 && (-cant) > cur) {
      toast(`No podés descontar más que el stock actual (${cur})`, 'err'); return;
    }
    const esResta = cant < 0;
    const motivo = (document.getElementById('pos-rep-motivo')?.value || '').trim();
    if (esResta && !motivo) {
      toast('Ingresá un motivo para el descuento', 'err'); return;
    }
    const origen = esResta ? 'compra' : origenSel.value;
    const origenTienda    = origen === 'tienda'   ? document.getElementById('pos-rep-tienda').value : null;
    const origenVehiculo  = origen === 'vehiculo' ? document.getElementById('pos-rep-vehiculo').value : null;
    if (!esResta && origen === 'tienda' && !origenTienda) { toast('Elegí la tienda origen', 'err'); return; }
    if (!esResta && origen === 'vehiculo' && !origenVehiculo) { toast('Elegí el vehículo origen', 'err'); return; }

    btnSave.disabled = true; btnSave.textContent = 'Guardando…';
    const { data, error } = await sb.rpc('pos_cargar_stock_bulk', {
      p_organization_id:       orgId,
      p_items:                 [{ producto_id: p.id, delta: cant, notas: esResta ? motivo : null }],
      p_motivo:                esResta ? 'ajuste' : 'carga',
      p_tienda_id:             tiendaId,
      p_origen:                origen,
      p_origen_tienda_id:      origenTienda,
      p_origen_repartidor_id:  origenVehiculo,
    });
    if (error) { toast(error.message, 'err'); btnSave.disabled = false; updateMode(); return; }

    // Actualizar el costo del producto con el costo de esta entrega (al sumar).
    let costoMsg = '';
    if (!esResta) {
      const cn = parseFloat(costoInp?.value) || 0;
      const modo = costoModo?.value || 'no';
      const nuevoCosto = _costoNuevoPonderado(modo, cur, p.costo, cant, cn);
      if (nuevoCosto != null) {
        const { error: cErr } = await sb.from('productos').update({ costo: nuevoCosto }).eq('id', p.id);
        if (cErr) { console.warn('update costo:', cErr); }
        else {
          p.costo = nuevoCosto;
          const idx = productos.findIndex(x => x.id === p.id);
          if (idx >= 0) productos[idx].costo = nuevoCosto;
          costoMsg = ' · costo ' + fmtARS(nuevoCosto);
        }
      }
    }

    document.getElementById('pos-rep-overlay').remove();
    const post = data?.detalle?.[0]?.cantidad_post ?? (cur + cant);
    stockMap.set(p.id, post);
    renderStock();
    renderProductGrid();
    toast('✓ Stock actualizado: ' + p.nombre + ' = ' + post + costoMsg, 'ok');
  });
}

window.reponerTodos = () => { if (!productos.length) return; abrirCargaStock(); };

function onClienteInput(e){
  const q = (e.target.value || '').trim();
  _searchCli = q;
  if (clienteSel) {
    clienteSel = null;
    renderClienteUI();
  }
  clearTimeout(_suggestTimer);
  if (q.length < 2) {
    document.getElementById('cli-suggest').classList.remove('show');
    return;
  }
  _suggestTimer = setTimeout(() => buscarClientes(q), 220);
}

async function buscarClientes(q){
  const box = document.getElementById('cli-suggest');
  if (!box) return;
  const { data, error } = await sb.from('clientes')
    .select('id, nombre, telefono, whatsapp, email')
    .eq('organization_id', orgId)
    .eq('activo', true)
    .neq('nombre', 'Mostrador')
    .or('nombre.ilike.%' + q + '%,telefono.ilike.%' + q + '%,whatsapp.ilike.%' + q + '%')
    .limit(8);
  if (error) { console.warn(error); return; }
  if (!data || !data.length) {
    box.innerHTML = '<div class="pos-cliente-suggest-item" style="color:var(--muted);cursor:default">Sin resultados</div>';
    box.classList.add('show');
    return;
  }
  box.innerHTML = '';
  data.forEach(c => {
    const item = document.createElement('div');
    item.className = 'pos-cliente-suggest-item';
    item.innerHTML = '<div class="nm"></div><div class="tel">' + (c.telefono || c.whatsapp || '—') + '</div>';
    item.querySelector('.nm').textContent = c.nombre;
    item.addEventListener('click', () => seleccionarCliente(c));
    box.appendChild(item);
  });
  box.classList.add('show');
}

function seleccionarCliente(c){
  clienteSel = {
    id: c.id, nombre: c.nombre,
    telefono: c.telefono || c.whatsapp || null,
    email:    c.email || null,
  };
  document.getElementById('cli-suggest').classList.remove('show');
  renderClienteUI();
  recalcularPreciosCart();
}

// ── NUEVO CLIENTE INLINE (POS) ───────────────────────────────
window._posAbrirNuevoCliente = async function() {
  let listas = [];
  try {
    const { data } = await sb.from('listas_precios')
      .select('id, nombre').eq('organization_id', orgId).eq('activo', true).order('nombre');
    listas = data || [];
  } catch (_) {}

  const html = `
    <div id="pos-nc-overlay" style="position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.55);display:flex;align-items:flex-start;justify-content:center;padding:14px;overflow-y:auto"
      onmousedown="this.dataset.dwn=(event.target===this?&quot;1&quot;:&quot;&quot;)" onclick="if(event.target===this&&this.dataset.dwn===&quot;1&quot;)this.remove();this.dataset.dwn=&quot;&quot;">
      <div style="background:#fff;border-radius:14px;max-width:680px;width:100%;padding:20px;box-shadow:0 14px 40px rgba(0,0,0,.18);margin:14px 0">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <div style="font-weight:700;font-size:16px">+ Nuevo cliente</div>
          <button type="button" onclick="document.getElementById('pos-nc-overlay').remove()"
            style="background:none;border:0;font-size:22px;cursor:pointer;color:#64748b">×</button>
        </div>
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Identidad</div>
        <div style="display:grid;grid-template-columns:1fr 160px;gap:10px;margin-bottom:8px">
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">Nombre / Razón social *</label>
            <input id="pos-nc-nombre" type="text" autofocus
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">Tipo</label>
            <select id="pos-nc-tipo"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
              <option value="residencial">Residencial</option>
              <option value="comercio">Comercio</option>
              <option value="oficina">Oficina</option>
              <option value="otro">Otro</option>
            </select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px">
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">Teléfono *</label>
            <input id="pos-nc-tel" type="tel" inputmode="tel"
              value="${posPhonePrefix()} "
              placeholder="${posPhonePrefix()} 264 762 1505"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">WhatsApp</label>
            <input id="pos-nc-wa" type="tel" inputmode="tel"
              placeholder="vacío = mismo que tel (${posPhonePrefix()} ...)"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">Email</label>
            <input id="pos-nc-email" type="email"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
          </div>
        </div>
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Dirección</div>
        <div style="position:relative;margin-bottom:10px">
          <label style="font-size:11px;color:#64748b;font-weight:600">🔍 Buscar dirección</label>
          <div style="display:flex;gap:6px;margin-top:3px">
            <input id="geo-search" type="text" autocomplete="off"
              placeholder="Ej: San Martín 1234, San Juan…"
              oninput="window.geoSuggest(this.value)"
              style="flex:1;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;outline:none">
            <button type="button" onclick="window.geoMiUbicacion()" title="Usar mi GPS"
              style="padding:9px 14px;border-radius:9px;border:1.5px solid var(--border);background:#fff;cursor:pointer;font-size:16px">📍</button>
          </div>
          <div id="geo-sugerencias" style="display:none;position:absolute;top:100%;left:0;right:0;background:#fff;border:1.5px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:99999;max-height:220px;overflow-y:auto;margin-top:4px"></div>
        </div>
        <div style="margin-bottom:10px">
          <label style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:#64748b;font-weight:600">
            <span>📍 Ubicación · arrastrá el pin o tocá el mapa</span>
            <span id="geo-coords-label" style="font-size:10px;color:var(--primary);font-family:monospace"></span>
          </label>
          <div id="geo-map" style="height:240px;border-radius:10px;overflow:hidden;border:1.5px solid var(--border);margin-top:3px"></div>
        </div>
        <input id="cli-lat" type="hidden">
        <input id="cli-lng" type="hidden">
        <div style="display:grid;grid-template-columns:2fr 1fr;gap:10px;margin-bottom:8px">
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">Calle</label>
            <input id="cli-calle" type="text"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">Número</label>
            <input id="cli-numero" type="text"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:8px">
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">Barrio</label>
            <input id="cli-barrio" type="text"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">Ciudad</label>
            <input id="cli-ciudad" type="text"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">Provincia</label>
            <input id="cli-prov" type="text"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
          </div>
        </div>
        <div style="margin-bottom:14px">
          <label style="font-size:11px;color:#64748b;font-weight:600">Referencia (esquina, portón, etc.)</label>
          <input id="pos-nc-ref" type="text"
            style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
        </div>
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Visitas y precios</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px">
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">Frecuencia (días)</label>
            <input id="pos-nc-freq" type="number" inputmode="numeric" value="7" min="1"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">Prioridad</label>
            <select id="pos-nc-prio"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
              <option value="1" selected>Normal</option>
              <option value="2">Alta</option>
              <option value="0">Baja</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">Lista de precios</label>
            <select id="pos-nc-lista"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
              <option value="">— Default —</option>
              ${listas.map(l => `<option value="${l.id}">${l.nombre}</option>`).join('')}
            </select>
          </div>
        </div>
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Facturación (opcional)</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px">
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">CUIT/DNI</label>
            <input id="pos-nc-cuit" type="text"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">Condición IVA</label>
            <select id="pos-nc-iva"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
              <option value=""></option>
              <option value="responsable_inscripto">Responsable Inscripto</option>
              <option value="monotributo">Monotributo</option>
              <option value="exento">Exento</option>
              <option value="consumidor_final">Consumidor Final</option>
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#64748b;font-weight:600">Razón social</label>
            <input id="pos-nc-rsocial" type="text"
              style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px">
          </div>
        </div>
        <div style="display:flex;gap:18px;margin-bottom:14px;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#64748b;cursor:pointer">
            <input type="checkbox" id="pos-nc-remito"> Acepta remito (cierra entrega sin cobro)
          </label>
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;color:#64748b;cursor:pointer">
            <input type="checkbox" id="pos-nc-cc"> Cuenta corriente habilitada
          </label>
        </div>
        <div style="font-size:11px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">
          Envases que trae (relevo inicial · opcional)
        </div>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">
          Si el cliente trae envases vacíos al darse de alta, registralos acá. Se contarán como "en su poder" para que la primera venta pueda recibirlos.
        </div>
        <div id="nc-env-rows" style="display:flex;flex-direction:column;gap:6px;margin-bottom:8px"></div>
        <button type="button" id="nc-env-add"
          style="background:none;border:1.5px dashed var(--border);color:var(--primary);padding:7px 12px;border-radius:9px;font-size:12px;font-weight:600;cursor:pointer;margin-bottom:14px">
          + Agregar tipo
        </button>
        <div style="margin-bottom:14px">
          <label style="font-size:11px;color:#64748b;font-weight:600">Notas internas</label>
          <textarea id="pos-nc-notas" rows="2"
            style="width:100%;padding:9px 11px;border:1.5px solid var(--border);border-radius:9px;font-size:14px;margin-top:3px;resize:vertical"></textarea>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button type="button" onclick="document.getElementById('pos-nc-overlay').remove()"
            style="padding:9px 16px;border:1.5px solid var(--border);background:#fff;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer">Cancelar</button>
          <button type="button" id="pos-nc-save" onclick="window._posGuardarNuevoCliente()"
            style="padding:9px 18px;border:0;background:var(--primary);color:#fff;border-radius:9px;font-size:13px;font-weight:700;cursor:pointer">Guardar y seleccionar</button>
        </div>
      </div>
    </div>`;
  const div = document.createElement('div'); div.innerHTML = html;
  document.body.appendChild(div.firstElementChild);
  setTimeout(() => document.getElementById('pos-nc-nombre')?.focus(), 100);
  setTimeout(() => _posInitGeoMap(), 150);
  setTimeout(() => _posInitNcEnvases(), 150);
};

// ── ENVASES INICIALES (relevo al alta) ──────────────────────
let _ncEnvIniciales = [];
async function _posInitNcEnvases() {
  if (!_tiposEnvase.length) await _loadTiposEnvase();
  _ncEnvIniciales = [];
  _renderNcEnvases();
  const wrap = document.getElementById('nc-env-rows');
  const add  = document.getElementById('nc-env-add');
  if (!wrap || !add) return;
  add.addEventListener('click', () => {
    const defTipo = _tiposEnvase[0]?.id || '';
    _ncEnvIniciales.push({ tipo_envase_id: defTipo, cantidad: 1 });
    _renderNcEnvases();
  });
  wrap.addEventListener('click', (e) => {
    const row = e.target.closest('.nc-env-row'); if (!row) return;
    const idx = +row.dataset.idx; const fld = e.target.dataset.fld;
    if (fld === 'rm')  { _ncEnvIniciales.splice(idx, 1); _renderNcEnvases(); }
    if (fld === 'dec') { _ncEnvIniciales[idx].cantidad = Math.max(1, (_ncEnvIniciales[idx].cantidad || 1) - 1); _renderNcEnvases(); }
    if (fld === 'inc') { _ncEnvIniciales[idx].cantidad = (_ncEnvIniciales[idx].cantidad || 1) + 1; _renderNcEnvases(); }
  });
  wrap.addEventListener('change', (e) => {
    const row = e.target.closest('.nc-env-row'); if (!row) return;
    const idx = +row.dataset.idx; const fld = e.target.dataset.fld;
    if (fld === 'tipo') _ncEnvIniciales[idx].tipo_envase_id = e.target.value;
  });
  wrap.addEventListener('input', (e) => {
    if (e.target.dataset.fld !== 'cant') return;
    const row = e.target.closest('.nc-env-row'); if (!row) return;
    const idx = +row.dataset.idx;
    _ncEnvIniciales[idx].cantidad = Math.max(1, parseInt(e.target.value, 10) || 1);
  });
}
function _renderNcEnvases() {
  const wrap = document.getElementById('nc-env-rows');
  if (!wrap) return;
  if (!_ncEnvIniciales.length) { wrap.innerHTML = ''; return; }
  const tipos = _tiposEnvase.filter(t => t.es_retornable !== false);
  wrap.innerHTML = _ncEnvIniciales.map((r, i) => {
    const opts = tipos.map(t => `<option value="${t.id}" ${t.id===r.tipo_envase_id?'selected':''}>${
      t.capacidad_litros ? t.capacidad_litros + 'L · ' : ''}${t.nombre}</option>`).join('');
    return `<div class="nc-env-row" data-idx="${i}"
      style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:9px">
      <select data-fld="tipo" style="flex:1;min-width:0;padding:6px 8px;border:1px solid var(--border);border-radius:8px;font-size:12px;font-weight:600">
        <option value="">— tipo —</option>${opts}
      </select>
      <div style="display:flex;align-items:center;gap:2px">
        <button type="button" data-fld="dec" style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:#fff;font-size:14px;font-weight:700;cursor:pointer">−</button>
        <input type="number" data-fld="cant" min="1" step="1" value="${r.cantidad || 1}" inputmode="numeric"
          style="width:42px;padding:4px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-weight:700;text-align:center">
        <button type="button" data-fld="inc" style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:#fff;font-size:14px;font-weight:700;cursor:pointer">+</button>
      </div>
      <button type="button" data-fld="rm" title="Eliminar"
        style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:#fff;color:var(--danger);font-size:13px;cursor:pointer">✕</button>
    </div>`;
  }).join('');
}

// ── GEOCODER (Mapbox + Nominatim) ──────────
// El token de Mapbox NO se versiona (push protection). Se configura en runtime
// vía window.POS_MAPBOX_TOKEN (ej. en js/config.js, no commiteado) o
// localStorage 'pos_mapbox_token'. Si no hay token, el mapa interactivo se
// omite y el alta de cliente sigue funcionando con los campos de dirección
// manuales + la búsqueda por Nominatim (que no requiere token).
function _posMapboxToken() {
  try {
    return (typeof window !== 'undefined' && window.POS_MAPBOX_TOKEN)
      || localStorage.getItem('pos_mapbox_token')
      || '';
  } catch (_) { return (typeof window !== 'undefined' && window.POS_MAPBOX_TOKEN) || ''; }
}
let _posMbMap = null, _posMbMarker = null, _posMbLoaded = false;
let _posGeoTimer = null, _posGeoResults = [], _posReverseTimer = null;

function _posApplyAddress(addr) {
  if (!addr) return;
  const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
  set('cli-calle',  addr.road || addr.pedestrian || addr.footway || '');
  set('cli-numero', addr.house_number || '');
  set('cli-barrio', addr.neighbourhood || addr.suburb || addr.quarter || addr.residential || '');
  set('cli-ciudad', addr.city || addr.town || addr.village || addr.municipality || '');
  set('cli-prov',   addr.state || addr.province || '');
}
async function _posReverseGeo(lng, lat) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&addressdetails=1&accept-language=es`,
      { headers: { 'Accept-Language':'es', 'User-Agent':'POS-Mostrador/1.0' } });
    return (await res.json()).address || null;
  } catch { return null; }
}
function _posReverseAndFill(lng, lat) {
  clearTimeout(_posReverseTimer);
  _posReverseTimer = setTimeout(async () => {
    const addr = await _posReverseGeo(lng, lat);
    if (addr) {
      _posApplyAddress(addr);
      const lbl = document.getElementById('geo-search');
      if (lbl && !lbl.value) {
        lbl.value = [addr.road, addr.house_number].filter(Boolean).join(' ');
      }
    }
  }, 600);
}
function _posLoadMapbox(cb) {
  const token = _posMapboxToken();
  if (!token) {
    // Sin token: mostramos un placeholder en el contenedor del mapa y seguimos
    // con los campos manuales + búsqueda Nominatim (no requiere Mapbox).
    const mapEl = document.getElementById('geo-map');
    if (mapEl && !mapEl.dataset.noMap) {
      mapEl.dataset.noMap = '1';
      mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;padding:12px;text-align:center;font-size:12px;color:var(--muted);background:#f8f9ff">🗺️ Mapa deshabilitado (sin token de Mapbox). Usá la búsqueda de dirección o cargá los campos manualmente.</div>';
    }
    return;
  }
  if (_posMbLoaded && window.mapboxgl) { cb(); return; }
  if (window.mapboxgl) { mapboxgl.accessToken = token; _posMbLoaded = true; cb(); return; }
  if (!document.querySelector('link[href*="mapbox-gl"]')) {
    const link = document.createElement('link');
    link.rel='stylesheet'; link.href='https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.css';
    document.head.appendChild(link);
  }
  const s = document.createElement('script');
  s.src = 'https://api.mapbox.com/mapbox-gl-js/v3.3.0/mapbox-gl.js';
  s.onload = () => { mapboxgl.accessToken = token; _posMbLoaded = true; cb(); };
  document.head.appendChild(s);
}
function _posInitGeoMap(latI, lngI) {
  _posLoadMapbox(() => {
    const mapEl = document.getElementById('geo-map');
    if (!mapEl) return;
    if (_posMbMap) { try { _posMbMap.remove(); } catch {} _posMbMap = null; _posMbMarker = null; }
    mapEl.innerHTML = '';
    const lat = latI || -31.5375;
    const lng = lngI || -68.5364;
    const zoom = (latI && lngI) ? 16 : 13;
    try {
      _posMbMap = new mapboxgl.Map({
        container: mapEl, style: 'mapbox://styles/mapbox/streets-v12',
        center: [lng, lat], zoom,
      });
    } catch (e) { console.error('[pos] mapbox init', e); return; }
    _posMbMap.addControl(new mapboxgl.NavigationControl({ showCompass:false }), 'top-right');
    const pinEl = document.createElement('div');
    pinEl.style.cssText = 'width:24px;height:24px;background:var(--primary);border-radius:50%;border:3px solid white;box-shadow:0 2px 12px rgba(102,126,234,.6);cursor:grab';
    _posMbMarker = new mapboxgl.Marker({ element: pinEl, draggable: true }).setLngLat([lng, lat]).addTo(_posMbMap);
    const updateCoords = (lng, lat) => {
      const latR = parseFloat(lat.toFixed(6));
      const lngR = parseFloat(lng.toFixed(6));
      const latEl = document.getElementById('cli-lat');
      const lngEl = document.getElementById('cli-lng');
      if (latEl) latEl.value = latR;
      if (lngEl) lngEl.value = lngR;
      const lbl = document.getElementById('geo-coords-label');
      if (lbl) lbl.textContent = latR + ', ' + lngR;
    };
    _posMbMarker.on('dragend', () => {
      const p = _posMbMarker.getLngLat();
      updateCoords(p.lng, p.lat); _posReverseAndFill(p.lng, p.lat);
    });
    _posMbMap.on('click', e => {
      _posMbMarker.setLngLat(e.lngLat);
      updateCoords(e.lngLat.lng, e.lngLat.lat); _posReverseAndFill(e.lngLat.lng, e.lngLat.lat);
    });
    if (latI && lngI) updateCoords(lng, lat);
    _posMbMap.once('load', () => _posMbMap.resize());
    [50, 200, 500].forEach(t => setTimeout(() => { if (_posMbMap) _posMbMap.resize(); }, t));
    window._posMbActualizar = updateCoords;
  });
}
window.geoSuggest = function(q) {
  const box = document.getElementById('geo-sugerencias');
  if (!q || q.length < 3) { if (box) box.style.display = 'none'; return; }
  clearTimeout(_posGeoTimer);
  _posGeoTimer = setTimeout(async () => {
    try {
      const center = _posMbMap ? _posMbMap.getCenter() : { lng:-68.5364, lat:-31.5375 };
      const params = new URLSearchParams({
        format:'json', addressdetails:'1', limit:'7', 'accept-language':'es', q,
        viewbox: [center.lng-3, center.lat+3, center.lng+3, center.lat-3].join(','),
        bounded: '0',
      });
      const res = await fetch('https://nominatim.openstreetmap.org/search?' + params,
        { headers: { 'Accept-Language':'es', 'User-Agent':'POS-Mostrador/1.0' } });
      const data = await res.json();
      if (!box) return;
      if (!data.length) {
        box.innerHTML = '<div style="padding:12px 14px;font-size:12px;color:#94a3b8">Sin resultados</div>';
        box.style.display = ''; return;
      }
      _posGeoResults = data;
      box.innerHTML = data.map((r, idx) => {
        const a = r.address || {};
        const l1 = [a.road, a.house_number].filter(Boolean).join(' ') || a.neighbourhood || a.suburb || r.display_name.split(',')[0];
        const l2 = [a.neighbourhood||a.suburb, a.city||a.town||a.village, a.country].filter(Boolean).slice(0,3).join(', ');
        return `<div onclick="window.geoSeleccionar(${idx})"
          style="padding:10px 14px;cursor:pointer;border-bottom:1px solid rgba(0,0,0,.05)"
          onmouseover="this.style.background='rgba(102,126,234,.05)'"
          onmouseout="this.style.background=''">
          <div style="font-weight:600;font-size:13px">${l1}</div>
          ${l2 ? `<div style="font-size:11px;color:#94a3b8;margin-top:2px">${l2}</div>` : ''}
        </div>`;
      }).join('');
      box.style.display = '';
    } catch (e) { console.warn('[pos] geoSuggest', e); }
  }, 400);
};
window.geoSeleccionar = function(idx) {
  const r = _posGeoResults[idx]; if (!r) return;
  const lng = parseFloat(r.lon), lat = parseFloat(r.lat);
  const box = document.getElementById('geo-sugerencias');
  const inp = document.getElementById('geo-search');
  if (box) box.style.display = 'none';
  const a = r.address || {};
  if (inp) inp.value = [a.road, a.house_number].filter(Boolean).join(' ') || r.display_name.split(',')[0];
  _posApplyAddress(a);
  if (_posMbMap && _posMbMarker) {
    _posMbMap.resize();
    _posMbMap.flyTo({ center:[lng,lat], zoom:17, duration:600 });
    _posMbMarker.setLngLat([lng, lat]);
    window._posMbActualizar?.(lng, lat);
  } else {
    document.getElementById('cli-lat').value = lat;
    document.getElementById('cli-lng').value = lng;
    _posInitGeoMap(lat, lng);
  }
  toast('Dirección detectada ✓', 'ok');
};
window.geoMiUbicacion = function() {
  if (!navigator.geolocation) { toast('GPS no disponible', 'err'); return; }
  navigator.geolocation.getCurrentPosition(async pos => {
    const lng = pos.coords.longitude, lat = pos.coords.latitude;
    if (_posMbMap && _posMbMarker) {
      _posMbMap.flyTo({ center:[lng,lat], zoom:18, duration:800 });
      _posMbMarker.setLngLat([lng, lat]);
      window._posMbActualizar?.(lng, lat);
    } else {
      _posInitGeoMap(lat, lng);
    }
    const addr = await _posReverseGeo(lng, lat);
    if (addr) {
      _posApplyAddress(addr);
      const inp = document.getElementById('geo-search');
      if (inp) inp.value = [addr.road, addr.house_number].filter(Boolean).join(' ');
    }
    toast('GPS capturado ✓', 'ok');
  }, () => toast('No se pudo obtener GPS', 'err'), { enableHighAccuracy:true, timeout:8000 });
};

window._posGuardarNuevoCliente = async function() {
  const v = (id) => document.getElementById(id).value.trim();
  const nombre = v('pos-nc-nombre');
  if (!nombre) { toast('Falta el nombre', 'err'); return; }
  const tel    = v('pos-nc-tel');
  const wa     = v('pos-nc-wa') || tel;
  const calle  = v('cli-calle');
  const numero = v('cli-numero');
  const barrio = v('cli-barrio');
  const ciudad = v('cli-ciudad');
  const prov   = v('cli-prov');
  const ref    = v('pos-nc-ref');
  const lat    = parseFloat(document.getElementById('cli-lat').value) || null;
  const lng    = parseFloat(document.getElementById('cli-lng').value) || null;

  const payload = {
    organization_id: orgId,
    nombre,
    tipo:               document.getElementById('pos-nc-tipo').value || 'residencial',
    telefono:           tel || null,
    whatsapp:           wa || null,
    email:              v('pos-nc-email') || null,
    referencia:         ref || null,
    frecuencia_dias:    parseInt(v('pos-nc-freq'), 10) || 7,
    prioridad:          parseInt(document.getElementById('pos-nc-prio').value, 10) || 1,
    lista_precio_id:    document.getElementById('pos-nc-lista').value || null,
    cuit:               v('pos-nc-cuit') || null,
    condicion_iva:      document.getElementById('pos-nc-iva').value || null,
    razon_social:       v('pos-nc-rsocial') || null,
    acepta_remito:      document.getElementById('pos-nc-remito').checked,
    cuenta_corriente_habilitada: document.getElementById('pos-nc-cc').checked,
    notas:              v('pos-nc-notas') || null,
    activo: true,
  };

  const btn = document.getElementById('pos-nc-save');
  btn.disabled = true; btn.textContent = 'Guardando…';
  try {
    if (lat != null) payload.lat = lat;
    if (lng != null) payload.lng = lng;

    const { data: cli, error } = await sb.from('clientes').insert(payload)
      .select('id, nombre, telefono, whatsapp, email').single();
    if (error) throw error;

    if (calle || ciudad || lat != null) {
      const dirPayload = {
        organization_id: orgId,
        cliente_id: cli.id,
        calle: calle || null, numero: numero || null,
        barrio: barrio || null, ciudad: ciudad || null, provincia: prov || null,
        referencia: ref || null,
        lat: lat, lng: lng,
        principal: true, activo: true,
      };
      const { error: dirErr } = await sb.from('direcciones').insert(dirPayload);
      if (dirErr) console.warn('[pos] dirección no se pudo crear:', dirErr);
    }

    const envIni = (_ncEnvIniciales || [])
      .filter(r => r.tipo_envase_id && (parseInt(r.cantidad, 10) || 0) > 0)
      .map(r => ({ tipo_envase_id: r.tipo_envase_id, cantidad: parseInt(r.cantidad, 10) }));
    if (envIni.length) {
      const { error: envErr } = await sb.rpc('pos_setear_envases_iniciales', {
        p_cliente_id: cli.id,
        p_items:      envIni,
      });
      if (envErr) {
        console.warn('[pos] relevo inicial falló:', envErr);
        toast('Cliente creado, pero el relevo no se pudo guardar: ' + envErr.message, 'warn');
      }
    }

    toast('Cliente creado ✓', 'ok');
    document.getElementById('pos-nc-overlay').remove();
    _ncEnvIniciales = [];
    seleccionarCliente(cli);
  } catch (e) {
    btn.disabled = false; btn.textContent = 'Guardar y seleccionar';
    toast(e.message || 'Error al crear cliente', 'err');
  }
};

// ── ENVASES RETORNADOS ────────────────────────────────
let _envasesDevueltos = [];
let _envasesSaldoActual = 0;
let _envasesSaldoClientId = null;
let _tiposEnvase     = [];
function _envasesRetornadosSum() {
  return _envasesDevueltos.reduce((s, r) => s + (parseInt(r.cantidad, 10) || 0), 0);
}
function _cartHasRetornable() {
  for (const it of cart.values()) if (it.tiene_envase) return true;
  return false;
}
async function _loadTiposEnvase() {
  if (!orgId) return;
  const { data, error } = await sb.rpc('tipos_envase_activos', { p_org: orgId });
  if (error) { console.warn('[envases] no pude cargar tipos:', error.message); return; }
  _tiposEnvase = data || [];
}
function _tiposEnvaseRetornables() {
  return _tiposEnvase.filter(t => t.es_retornable !== false);
}
function _envaseRowHtml(idx, row) {
  const opts = _tiposEnvaseRetornables().map(t =>
    `<option value="${t.id}"${t.id === row.tipo_envase_id ? ' selected' : ''}>${t.nombre}${t.capacidad_litros ? ' · '+t.capacidad_litros+'L' : ''}</option>`
  ).join('');
  return `
    <div class="env-row" data-idx="${idx}" style="display:flex;gap:6px;align-items:center;background:#fff;border:1px solid var(--border);border-radius:10px;padding:6px 8px">
      <select data-fld="tipo" style="flex:1;min-width:0;padding:6px 8px;border:1px solid var(--border);border-radius:8px;font-size:12px;font-weight:600">
        <option value="">— tipo —</option>${opts}
      </select>
      <div style="display:flex;align-items:center;gap:2px">
        <button type="button" data-fld="dec" style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:#fff;font-size:14px;font-weight:700;cursor:pointer">−</button>
        <input type="number" data-fld="cant" min="1" step="1" value="${row.cantidad || 1}" inputmode="numeric"
          style="width:42px;padding:4px;border:1px solid var(--border);border-radius:6px;font-size:13px;font-weight:700;text-align:center">
        <button type="button" data-fld="inc" style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:#fff;font-size:14px;font-weight:700;cursor:pointer">+</button>
      </div>
      <button type="button" data-fld="rm" title="Eliminar" style="width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:#fff;color:var(--danger);font-size:13px;cursor:pointer">✕</button>
    </div>`;
}
function _renderEnvasesDevueltos() {
  const wrap = document.getElementById('env-rows');
  if (!wrap) return;
  wrap.innerHTML = _envasesDevueltos.map((r, i) => _envaseRowHtml(i, r)).join('') ||
    '<div style="font-size:11px;color:var(--muted);padding:8px;text-align:center">Sin envases recibidos. Tocá "+ Agregar tipo".</div>';
}
function _wireEnvasesUI() {
  const wrap = document.getElementById('env-rows');
  const add  = document.getElementById('env-add');
  if (!wrap || !add) return;
  add.addEventListener('click', () => {
    const defTipo = _tiposEnvase[0]?.id || '';
    _envasesDevueltos.push({ tipo_envase_id: defTipo, cantidad: 1, condicion: 'vacio' });
    _renderEnvasesDevueltos();
  });
  wrap.addEventListener('click', (e) => {
    const row = e.target.closest('.env-row'); if (!row) return;
    const idx = +row.dataset.idx; const fld = e.target.dataset.fld;
    if (fld === 'rm')  { _envasesDevueltos.splice(idx, 1); _renderEnvasesDevueltos(); }
    if (fld === 'dec') { _envasesDevueltos[idx].cantidad = Math.max(1, (_envasesDevueltos[idx].cantidad || 1) - 1); _renderEnvasesDevueltos(); }
    if (fld === 'inc') { _envasesDevueltos[idx].cantidad = (_envasesDevueltos[idx].cantidad || 1) + 1; _renderEnvasesDevueltos(); }
  });
  wrap.addEventListener('change', (e) => {
    const row = e.target.closest('.env-row'); if (!row) return;
    const idx = +row.dataset.idx; const fld = e.target.dataset.fld;
    if (fld === 'tipo') _envasesDevueltos[idx].tipo_envase_id = e.target.value;
  });
  wrap.addEventListener('input', (e) => {
    if (e.target.dataset.fld !== 'cant') return;
    const row = e.target.closest('.env-row'); if (!row) return;
    const idx = +row.dataset.idx;
    _envasesDevueltos[idx].cantidad = Math.max(1, parseInt(e.target.value, 10) || 1);
  });
  _renderEnvasesDevueltos();
}
function _resetEnvasesUI() {
  _envasesDevueltos = [];
  _envasesSaldoClientId = null;
  _renderEnvasesDevueltos();
}
function _envasesDevueltosPayload() {
  return _envasesDevueltos
    .filter(r => r.tipo_envase_id && (parseInt(r.cantidad, 10) || 0) > 0)
    .map(r => ({
      tipo_envase_id: r.tipo_envase_id,
      cantidad: parseInt(r.cantidad, 10) || 0,
      condicion: r.condicion || 'vacio',
    }));
}
async function _refrescarEnvasesSaldo() {
  const wrap = document.getElementById('pos-envases');
  const tag = document.getElementById('env-saldo');
  const btnSolo = document.getElementById('btn-solo-devolver');
  if (!wrap) return;
  if (!clienteSel?.id) {
    wrap.style.display = 'none';
    _resetEnvasesUI();
    if (btnSolo) btnSolo.style.display = 'none';
    return;
  }
  if (tag) tag.textContent = '…';
  const { data: porTipo, error } = await sb.rpc('get_envases_en_cliente_por_tipo', {
    p_cliente_id: clienteSel.id,
  });
  const totalEnPoder = !error ? (porTipo || []).reduce((s, t) => s + (t.cantidad || 0), 0) : 0;
  _envasesSaldoActual = totalEnPoder;
  _envasesSaldoClientId = clienteSel.id;

  if (!_cartHasRetornable() && totalEnPoder === 0) {
    wrap.style.display = 'none';
    _resetEnvasesUI();
    if (btnSolo) btnSolo.style.display = 'none';
    return;
  }
  wrap.style.display = '';

  if (totalEnPoder === 0) {
    if (tag) tag.textContent = 'Sin envases en su poder';
  } else {
    const partes = (porTipo || []).map(t =>
      `${t.cantidad}× ${t.capacidad_litros ? t.capacidad_litros + 'L' : t.tipo_nombre}`
    ).join(' · ');
    if (tag) tag.textContent = `Tiene ${totalEnPoder} (${partes})`;
  }

  if (btnSolo) {
    btnSolo.style.display = (cart.size === 0 && totalEnPoder > 0) ? '' : 'none';
  }
}

window._posSoloDevolver = async () => {
  const payload = _envasesDevueltosPayload();
  if (payload.length === 0) {
    toast('Agregá al menos un envase a devolver', 'warn'); return;
  }
  if (!clienteSel?.id) { toast('Sin cliente', 'err'); return; }

  const totalDev = payload.reduce((s, r) => s + r.cantidad, 0);
  const lineas = payload.map(r => {
    const tipo = _tiposEnvase.find(t => t.id === r.tipo_envase_id);
    const nm = tipo ? ((tipo.capacidad_litros ? tipo.capacidad_litros + 'L ' : '') + (tipo.nombre || '')).trim() : 'envase';
    return { label: nm + (r.condicion === 'roto' ? ' (roto)' : ''), value: '×' + r.cantidad };
  });
  lineas.push({ label: '<strong>Total</strong>', value: '<strong>' + totalDev + ' envase' + (totalDev>1?'s':'') + '</strong>' });
  const ok = await confirmarOperacionPOS({
    titulo: '↩️ Devolución sin venta',
    subtitulo: `<strong>${clienteSel.nombre}</strong> está devolviendo envases. No se está cobrando ni vendiendo nada.`,
    lineas,
    btnOkLabel: 'Confirmar devolución',
    btnOkColor: '#059669',
  });
  if (!ok) return;

  const cliSnap = { id: clienteSel.id, nombre: clienteSel.nombre, telefono: clienteSel.telefono, email: clienteSel.email };
  if (_envasesSaldoClientId !== clienteSel.id) {
    const { data: pT } = await sb.rpc('get_envases_en_cliente_por_tipo', { p_cliente_id: clienteSel.id });
    _envasesSaldoActual = (pT || []).reduce((s, t) => s + (t.cantidad || 0), 0);
    _envasesSaldoClientId = clienteSel.id;
  }
  const tenia = Math.max(0, _envasesSaldoActual || 0);
  const ahora = Math.max(0, tenia - totalDev);
  const envasesMov = { tenia, devolvio: totalDev, prestado: 0, ahora };

  const btn = document.getElementById('btn-solo-devolver');
  if (btn) { btn.disabled = true; btn.textContent = 'Procesando…'; }
  const { data, error } = await sb.rpc('pos_devolver_envases_sin_venta', {
    p_organization_id: orgId,
    p_cliente_id:      clienteSel.id,
    p_envases_devueltos: payload,
    p_tienda_id:       tiendaId || null,
  });
  if (btn) { btn.disabled = false; btn.textContent = '↩️ Solo registrar devolución (sin venta)'; }
  if (error) { toast('Error: ' + error.message, 'err'); return; }
  toast(`✓ Devueltos ${data?.devueltos || 0} envases`, 'ok');
  _resumenCliCache.delete(clienteSel.id);
  _resetEnvasesUI();
  await _refrescarEnvasesSaldo();

  abrirRecibo({
    pedidoId:      data?.devolucion_id || crypto.randomUUID(),
    total:         0,
    metodo:        'devolucion',
    clienteId:     cliSnap.id,
    clienteNombre: cliSnap.nombre,
    telefono:      cliSnap.telefono,
    email:         cliSnap.email,
    facturaPdfUrl: null,
    facturaNumero: null,
    envasesMov,
    items:         [],
    fecha:         new Date(),
    tipoOperacion: 'devolucion',
  });
};

function renderClienteUI(){
  const wrap = document.getElementById('cli-wrap');
  if (!wrap) return;
  _refrescarEnvasesSaldo();
  _refrescarPrepagos();
  const ccBtn = document.getElementById('btn-cc');
  if (ccBtn) {
    ccBtn.disabled = !clienteSel?.id;
    ccBtn.style.opacity = clienteSel?.id ? '1' : '.45';
    ccBtn.title = clienteSel?.id
      ? 'Cargar a la cuenta del cliente (suma deuda)'
      : 'Seleccioná un cliente real para fiar';
  }
  const btnNuevoHTML = `<button type="button" id="btn-nuevo-cliente-pos" title="Nuevo cliente"
    onclick="window._posAbrirNuevoCliente()"
    style="padding:0 12px;border:1.5px solid var(--border);background:#fff;border-radius:10px;font-size:18px;font-weight:700;cursor:pointer;color:var(--primary)">+</button>`;

  if (clienteSel) {
    wrap.innerHTML =
      '<div style="flex:1">' +
      '<div class="pos-cliente-tag">' +
      '<span>👤 <span class="cli-nm"></span></span>' +
      '<button title="Quitar y vender a Mostrador">×</button>' +
      '</div>' +
      '<div id="cli-historial" class="pos-cli-historial">' +
      '<div style="padding:4px;color:var(--muted);font-size:11px">Cargando historial…</div>' +
      '</div>' +
      '</div>' + btnNuevoHTML;
    wrap.querySelector('.cli-nm').textContent = clienteSel.nombre;
    wrap.querySelector('.pos-cliente-tag button').addEventListener('click', () => {
      clienteSel = null;
      _searchCli = '';
      _precioCache.clear();
      renderClienteUI();
      recalcularPreciosCart();
    });
    _renderHistorialCliente(clienteSel.id);
  } else {
    wrap.innerHTML =
      '<div style="flex:1;position:relative">' +
      '<input id="cli-q" type="text" placeholder="🔍 Buscar cliente — vacío = Mostrador" autocomplete="off" value="' +
      _searchCli.replace(/"/g, '&quot;') + '" style="width:100%">' +
      '<div class="pos-cliente-suggest" id="cli-suggest"></div>' +
      '</div>' + btnNuevoHTML;
    document.getElementById('cli-q').addEventListener('input', onClienteInput);
  }
}

const _resumenCliCache = new Map();
async function _renderHistorialCliente(cliId) {
  const cached = _resumenCliCache.get(cliId);
  if (cached && Date.now() - cached.t < 60_000) {
    _renderHistorialUI(cached.data);
    return;
  }
  const { data, error } = await sb.rpc('pos_cliente_resumen', { p_cliente_id: cliId });
  if (error) {
    console.warn('cliente_resumen', error);
    const h = document.getElementById('cli-historial');
    if (h) h.innerHTML = '<div style="padding:4px;color:var(--danger);font-size:11px">Error: ' + error.message + '</div>';
    return;
  }
  _resumenCliCache.set(cliId, { t: Date.now(), data });
  _renderHistorialUI(data);
}

function _renderHistorialUI(d) {
  const h = document.getElementById('cli-historial');
  if (!h) return;
  const saldo = Number(d.saldo || 0);
  const envases = Number(d.envases_en_cliente || 0);
  const compras = Number(d.compras_30d || 0);
  const monto30 = Number(d.monto_30d || 0);
  const credito = saldo < 0 ? Math.abs(saldo) : 0;
  const ccOk    = !!d.cuenta_corriente_habilitada;
  const limit   = d.limite_cc != null ? Number(d.limite_cc) : null;

  let saldoTxt;
  if (saldo > 0) {
    saldoTxt = '<span style="color:#dc2626">debe ' + fmtARS(saldo) + '</span>';
  } else if (credito > 0) {
    saldoTxt = '<span style="color:#059669">saldo a favor ' + fmtARS(credito) +
      '</span> <button id="btn-usar-credito" style="margin-left:6px;padding:2px 8px;border:1px solid #059669;background:rgba(5,150,105,.08);color:#059669;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer">Usar</button>';
  } else {
    saldoTxt = '<span style="color:var(--muted)">sin deuda</span>';
  }

  const ccBadge = ccOk
    ? '<span class="pos-cli-pill" style="background:rgba(5,150,105,.08);border-color:rgba(5,150,105,.3);color:#059669">💳 CC' +
      (limit != null ? ' · ' + fmtARS(limit) : '') + '</span>'
    : '<span class="pos-cli-pill" style="background:rgba(148,163,184,.08);color:#64748b" title="Cliente no habilitado para fiar">💳 sin CC</span>';

  const ult = (d.ultimas_entregas || []).slice(0, 3);
  let ultHtml = '<div style="font-size:11px;color:var(--muted);margin-top:4px">Sin compras previas</div>';
  if (ult.length) {
    ultHtml = '<div style="margin-top:6px;font-size:11px;line-height:1.45">' +
      ult.map(e => {
        const dt = new Date(e.fecha).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit' });
        const itemsTxt = (e.items || '—');
        const itemsCorto = itemsTxt.length > 36 ? itemsTxt.slice(0, 36) + '…' : itemsTxt;
        return '<div style="display:flex;justify-content:space-between;gap:8px;padding:1px 0;color:var(--muted)">' +
               '<span>' + dt + ' · ' + itemsCorto + '</span>' +
               '<span style="font-weight:600;color:var(--ink);white-space:nowrap">' + fmtARS(e.total) + '</span></div>';
      }).join('') + '</div>';
  }

  const accionesCC = (saldo > 0 || ccOk)
    ? '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' +
      (saldo > 0 ? '<button id="btn-abonar-cc" style="padding:4px 10px;border:1px solid #059669;background:white;color:#059669;border-radius:6px;font-size:11px;font-weight:700;cursor:pointer">💵 Abonar a cuenta</button>' : '') +
      '</div>'
    : '';

  h.innerHTML =
    '<div style="display:flex;gap:6px;flex-wrap:wrap;font-size:12px;align-items:center">' +
    '<span class="pos-cli-pill">💰 ' + saldoTxt + '</span>' +
    (envases > 0 ? '<span class="pos-cli-pill">🫙 ' + envases + ' envase' + (envases > 1 ? 's' : '') + '</span>' : '') +
    (compras > 0 ? '<span class="pos-cli-pill">📅 ' + compras + ' / 30d · ' + fmtARS(monto30) + '</span>' : '') +
    ccBadge +
    '</div>' + ultHtml + accionesCC;

  const btnUsar = h.querySelector('#btn-usar-credito');
  if (btnUsar && credito > 0) {
    btnUsar.addEventListener('click', () => {
      const inp = document.getElementById('pos-descuento');
      const tipo = document.getElementById('pos-descuento-tipo');
      if (inp && tipo) {
        tipo.value = 'ars';
        inp.value = String(credito);
        renderCart();
        toast('Saldo a favor aplicado como descuento ' + fmtARS(credito), 'ok');
      }
    });
  }
  const btnAbonar = h.querySelector('#btn-abonar-cc');
  if (btnAbonar && saldo > 0) {
    btnAbonar.addEventListener('click', () => abrirAbonoCuenta(d.cliente_id, saldo));
  }

  const ccBtn = document.getElementById('btn-cc');
  if (ccBtn) {
    if (!ccOk) {
      ccBtn.disabled = true;
      ccBtn.style.opacity = '.45';
      ccBtn.title = 'Cliente sin cuenta corriente habilitada (editar en Clientes)';
    }
  }
}

async function _refrescarPrepagos(){
  const box = document.getElementById('pos-prepagos');
  if (!box) return;
  if (!clienteSel?.id) { box.style.display = 'none'; box.innerHTML = ''; _prepagosPendientesTotal = 0; _prepagoToastedCli = null; return; }
  const cliId = clienteSel.id;
  const { data, error } = await sb.rpc('get_vales_cliente', { p_cliente_id: cliId });
  if (error) { box.style.display = 'none'; return; }
  if (!clienteSel || clienteSel.id !== cliId) return;
  const vales = data?.vales || [];
  if (!vales.length) { box.style.display = 'none'; box.innerHTML = ''; _prepagosPendientesTotal = 0; return; }
  const total = vales.reduce((s, v) => s + (v.cantidad_pendiente || 0), 0);
  _prepagosPendientesTotal = total;
  if (_prepagoToastedCli !== cliId) {
    _prepagoToastedCli = cliId;
    toast('📦 Cliente con ' + total + ' producto' + (total !== 1 ? 's' : '') + ' prepagado(s) para retirar sin cargo', 'ok');
  }
  box.style.display = '';
  box.innerHTML =
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
      '<span style="font-size:20px">📦</span>' +
      '<div><div style="font-size:13px;font-weight:800;color:#047857">' + total + ' producto' + (total !== 1 ? 's' : '') + ' prepagado' + (total !== 1 ? 's' : '') + ' — retiro sin cargo</div>' +
      '<div style="font-size:11px;color:#047857;opacity:.85">Ya pagados. Tocá “Entregar” cuando el cliente los retire.</div></div>' +
    '</div>' +
    vales.map(v =>
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid rgba(5,150,105,.2)">' +
        '<div style="min-width:0"><div style="font-size:12px;font-weight:600" class="pp-nm"></div>' +
        '<div style="font-size:11px;color:#64748b">' + v.cantidad_pendiente + ' pend. · ' + fmtARS(v.precio_unitario) + ' c/u (pagado)</div></div>' +
        '<button class="pp-ent" data-id="' + v.id + '" data-pend="' + v.cantidad_pendiente + '" style="padding:6px 12px;border:none;background:#047857;color:#fff;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap">📦 Entregar</button>' +
      '</div>'
    ).join('');
  box.querySelectorAll('.pp-nm').forEach((el, i) => { el.textContent = vales[i].producto_nombre || '—'; });
  box.querySelectorAll('.pp-ent').forEach((btn, i) => {
    btn.addEventListener('click', () => posEntregarPrepago(
      btn.dataset.id, parseInt(btn.dataset.pend),
      vales[i].producto_nombre || '', vales[i].producto_id, vales[i].precio_unitario
    ));
  });
}

window.posEntregarPrepago = async (valeId, pendiente, nombre, prodId, precio) => {
  let cant = pendiente;
  if (pendiente > 1) {
    const r = prompt('¿Cuántas unidades de "' + nombre + '" entregás ahora? (pendientes: ' + pendiente + ')', String(pendiente));
    if (r == null) return;
    cant = parseInt(r);
    if (isNaN(cant) || cant <= 0 || cant > pendiente) { toast('Cantidad inválida', 'warn'); return; }
  } else if (!confirm('¿Entregar 1 unidad de "' + nombre + '"? Ya estaba pagada (no se cobra de nuevo).')) {
    return;
  }

  let tenia = 0;
  if (clienteSel?.id) {
    try {
      const { data: env } = await sb.rpc('get_envases_en_cliente_por_tipo', { p_cliente_id: clienteSel.id });
      tenia = (env || []).reduce((s, t) => s + (t.cantidad || 0), 0);
    } catch (_) {}
  }
  const prod = productos.find(p => p.id === prodId);
  const esRetornable = !!(prod && prod.tiene_envase);

  const { data, error } = await sb.rpc('vale_entregar', { p_vale_id: valeId, p_cantidad: cant, p_notas: null });
  if (error) { toast('Error: ' + error.message, 'err'); return; }
  if (!data?.ok) { toast('No se pudo entregar el prepago', 'err'); return; }
  toast('📦 ' + cant + ' u. entregada' + (cant !== 1 ? 's' : '') + ' (prepago)', 'ok');

  const cli = clienteSel;
  abrirRecibo({
    pedidoId:      data.pedido_id,
    total: 0, bruto: 0, descuento: 0, recargo: 0, cuotas: null,
    metodo:        'prepago',
    tipoOperacion: 'prepago_entrega',
    clienteId:     cli?.id || null,
    clienteNombre: cli?.nombre || '—',
    telefono:      cli?.telefono || null,
    email:         cli?.email || null,
    envasesMov:    esRetornable ? { tenia, devolvio: 0, prestado: cant, ahora: tenia + cant } : null,
    items: [{ nombre, cantidad: cant, precio: Number(precio) || 0, entregado: cant, prepagado: 0 }],
    fecha: new Date(),
  });

  if (cli?.id) _resumenCliCache.delete(cli.id);
  _refrescarPrepagos();
  _refrescarEnvasesSaldo();
  if (cli?.id) _renderHistorialCliente(cli.id);
  cargarStock().then(() => renderProductGrid());
};

async function abrirAbonoCuenta(clienteId, saldoActual) {
  const monto = prompt('Abono a cuenta de ' + (clienteSel?.nombre || 'cliente') +
    '\nDeuda actual: ' + fmtARS(saldoActual) + '\n\nMonto a recibir:', String(saldoActual));
  if (monto === null) return;
  const m = parseFloat(String(monto).replace(',', '.'));
  if (!Number.isFinite(m) || m <= 0) { toast('Monto inválido', 'warn'); return; }
  const metodo = prompt('Método (efectivo / transferencia / mercadopago / otro):', 'efectivo');
  if (!metodo) return;
  if (!['efectivo','transferencia','mercadopago','otro'].includes(metodo.trim())) {
    toast('Método inválido', 'err'); return;
  }
  const { data, error } = await sb.rpc('pos_abonar_cuenta', {
    p_organization_id: orgId,
    p_cliente_id:      clienteId,
    p_monto:           m,
    p_metodo:          metodo.trim(),
    p_referencia:      null,
    p_notas:           null,
  });
  if (error) { tmvShowError(error); return; }
  if (!data?.ok) { alert('No se pudo registrar el abono'); return; }
  toast('Abono ' + fmtARS(m) + ' ✓', 'ok');
  _resumenCliCache.delete(clienteId);
  _renderHistorialCliente(clienteId);
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#cli-wrap')) {
    document.getElementById('cli-suggest')?.classList.remove('show');
  }
});

// ── CONFIRMACIÓN GENÉRICA ────────────
function confirmarOperacionPOS({titulo, subtitulo, lineas, btnOkLabel, btnOkColor}) {
  return new Promise((resolve) => {
    const ov = document.createElement('div');
    ov.className = 'receipt-overlay show';
    ov.style.zIndex = '210';
    const okCol = btnOkColor || 'var(--primary)';
    ov.innerHTML = `
      <div class="receipt" style="max-width:380px;padding:0">
        <div style="padding:22px 22px 12px">
          <div style="font-size:16px;font-weight:800;color:#0f172a">${titulo}</div>
          ${subtitulo ? `<div style="font-size:13px;color:#64748b;margin-top:6px;line-height:1.4">${subtitulo}</div>` : ''}
        </div>
        ${lineas?.length ? `
          <div style="padding:0 22px 14px">
            <div style="background:rgba(102,126,234,.06);border-radius:10px;padding:12px 14px;font-size:13px;color:#0f172a">
              ${lineas.map(l => `<div style="display:flex;justify-content:space-between;padding:3px 0">
                <span>${l.label}</span><strong>${l.value}</strong>
              </div>`).join('')}
            </div>
          </div>
        ` : ''}
        <div class="receipt-actions no-print" style="padding:0 22px 22px;display:flex;gap:8px;justify-content:flex-end">
          <button id="conf-cancel" style="padding:10px 16px;border:1.5px solid var(--border);background:#fff;border-radius:8px;font-weight:600;cursor:pointer">Cancelar</button>
          <button id="conf-ok" class="btn-primary" style="background:${okCol};color:#fff;padding:10px 16px;border:none;border-radius:8px;font-weight:700;cursor:pointer">${btnOkLabel || 'Confirmar'}</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    const cleanup = (val) => { ov.remove(); resolve(val); };
    ov.querySelector('#conf-ok').onclick = () => cleanup(true);
    ov.querySelector('#conf-cancel').onclick = () => cleanup(false);
    ov.addEventListener('click', (e) => { if (e.target === ov) cleanup(false); });
  });
}

// ── RECIBO ───────────────────────────────────────────
function abrirRecibo(v){
  const ov = document.getElementById('receipt-overlay');
  const r  = document.getElementById('receipt');
  if (!ov || !r) return;

  const fechaStr = v.fecha.toLocaleString('es-AR', {
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit'
  });
  const refCorta = (v.pedidoId || '').slice(0, 8).toUpperCase();
  const metodoLabel = {
    efectivo:      '💵 Efectivo',
    transferencia: '🏦 Transferencia',
    mercadopago:   '📱 MercadoPago',
    debito:        '💳 Débito',
    credito:       '💳 Crédito',
    cuenta_corriente: '💳 Cuenta corriente',
    prepago:       '📦 Prepago (ya abonado)',
    otro:          '🪙 Otro',
  }[v.metodo] || v.metodo;
  const esPrepagoEntrega = v.tipoOperacion === 'prepago_entrega';
  const logoUrl = orgFiscal.logo_url || reciboCfg.logo_url || null;

  let itemsHtml = '';
  v.items.forEach(it => {
    const sub = it.cantidad * it.precio;
    const prepagado = Number(it.prepagado || 0);
    const prepagoLine = esPrepagoEntrega
      ? '<div style="font-size:11px;color:#047857;font-weight:700;margin-top:2px">📦 Entrega de prepago · ya abonado</div>'
      : (prepagado > 0
        ? '<div style="font-size:11px;color:#047857;font-weight:700;margin-top:2px">📦 Lleva ' +
            Number(it.entregado != null ? it.entregado : it.cantidad) +
            ' · prepaga ' + prepagado + ' (entrega diferida)</div>'
        : '');
    const rightVal = esPrepagoEntrega
      ? '<div style="font-weight:700;color:#047857;font-size:12px">✓ abonado</div>'
      : '<div style="font-weight:700">' + fmtARS(sub) + '</div>';
    itemsHtml +=
      '<div class="receipt-item">' +
      '<div><div class="rcp-nm"></div><div class="receipt-item-q">' +
        it.cantidad + ' × ' + fmtARS(it.precio) +
      '</div>' + prepagoLine + '</div>' +
      rightVal +
      '</div>';
  });

  const esDev = v.tipoOperacion === 'devolucion';
  const waLines = [
    (esDev ? '↩️ *Constancia de devolución*'
           : (esPrepagoEntrega ? '📦 *Entrega de prepago*' : '🧾 *' + (orgName || 'Comprobante') + '*')),
    'Cliente: ' + v.clienteNombre,
    'Ref: ' + refCorta,
    'Fecha: ' + fechaStr,
  ];
  if (!esDev && v.items?.length) {
    if (esPrepagoEntrega) {
      waLines.push('', ...v.items.map(it => '• ' + it.cantidad + '× ' + it.nombre + ' (prepago entregado)'), '');
      waLines.push('Ya abonado anteriormente ✓', 'A cobrar ahora: ' + fmtARS(0));
    } else {
      const descWA = Number(v.descuento || 0);
      const brutoWA = Number(v.bruto || v.total || 0);
      waLines.push('', ...v.items.map(it => {
        const base = '• ' + it.cantidad + '× ' + it.nombre + ' — ' + fmtARS(it.cantidad * it.precio);
        return Number(it.prepagado || 0) > 0
          ? base + ' (lleva ' + Number(it.entregado != null ? it.entregado : it.cantidad) + ', prepaga ' + it.prepagado + ')'
          : base;
      }), '');
      const recWA = Number(v.recargo || 0);
      if (descWA > 0 || recWA > 0) waLines.push('Subtotal: ' + fmtARS(brutoWA));
      if (descWA > 0) waLines.push('Descuento: −' + fmtARS(descWA));
      if (recWA > 0)  waLines.push('Recargo' + (Number(v.cuotas) > 1 ? ' (' + v.cuotas + ' cuotas)' : '') + ': +' + fmtARS(recWA));
      waLines.push('Total: ' + fmtARS(v.total), 'Pago: ' + metodoLabel);
    }
  }
  if (v.envasesMov && ((v.envasesMov.devolvio || 0) > 0 || (v.envasesMov.prestado || 0) > 0)) {
    const m = v.envasesMov;
    waLines.push('', 'Envases:', '  Tenía: ' + (m.tenia || 0));
    if (m.devolvio > 0) waLines.push('  Devolvió: ' + m.devolvio);
    if (m.prestado > 0) waLines.push('  Se llevó: ' + m.prestado);
    waLines.push('  Ahora tiene: ' + (m.ahora || 0));
  }
  if (v.facturaPdfUrl)  waLines.push('', 'Factura: ' + v.facturaPdfUrl);
  if (v.facturaNumero)  waLines.push('Comprobante: ' + v.facturaNumero);
  const waText = waLines.join('\n');
  const telDigits = (v.telefono || '').replace(/[^\d]/g, '');
  const waHref = telDigits
    ? 'https://wa.me/' + telDigits + '?text=' + encodeURIComponent(waText)
    : 'https://wa.me/?text=' + encodeURIComponent(waText);

  const mailHref = v.email
    ? 'mailto:' + encodeURIComponent(v.email) +
      '?subject=' + encodeURIComponent('Comprobante ' + (orgName || '') + ' · Ref ' + refCorta) +
      '&body=' + encodeURIComponent(waText)
    : null;

  const fiscalLines = [];
  if (reciboCfg.header_extra)                  fiscalLines.push(reciboCfg.header_extra);
  if (reciboCfg.mostrar_cuit && orgFiscal.cuit)           fiscalLines.push('CUIT: ' + orgFiscal.cuit);
  if (reciboCfg.mostrar_direccion && orgFiscal.direccion) fiscalLines.push(orgFiscal.direccion);
  if (reciboCfg.mostrar_telefono && orgFiscal.telefono)   fiscalLines.push('Tel: ' + orgFiscal.telefono);
  const fiscalHtml = fiscalLines.length
    ? '<div class="receipt-fiscal">' + fiscalLines.map(l => '<div></div>').join('') + '</div>'
    : '';

  const footerLines = [];
  if (reciboCfg.footer_mensaje) footerLines.push(reciboCfg.footer_mensaje);
  if (reciboCfg.footer_extra)   footerLines.push(reciboCfg.footer_extra);
  const footerHtml = footerLines.length
    ? '<div class="receipt-footer">' + footerLines.map(l => '<div></div>').join('') + '</div>'
    : '';

  r.className = 'receipt papel-' + (reciboCfg.tamano_papel || '80mm');

  let envasesMovHtml = '';
  if (v.envasesMov && v.clienteId) {
    const m = v.envasesMov;
    const hubo = (m.devolvio || 0) > 0 || (m.prestado || 0) > 0;
    if (hubo) {
      envasesMovHtml =
        '<div style="margin-top:10px;border-top:1px dashed #cbd5e1;padding-top:8px">' +
          '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px">Movimiento de envases 🫙</div>' +
          '<div class="receipt-pago"><span>Tenía</span><span>' + (m.tenia || 0) + '</span></div>' +
          (m.devolvio > 0
            ? '<div class="receipt-pago" style="color:#059669"><span>Devolvió</span><span>− ' + m.devolvio + '</span></div>'
            : '') +
          (m.prestado > 0
            ? '<div class="receipt-pago" style="color:#7c3aed"><span>Se llevó (prestado)</span><span>+ ' + m.prestado + '</span></div>'
            : '') +
          '<div class="receipt-pago" style="font-weight:800;color:#0f172a;border-top:1px solid #e2e8f0;padding-top:4px;margin-top:4px"><span>Ahora tiene</span><span>' + (m.ahora || 0) + ' 🫙</span></div>' +
        '</div>';
    }
  }

  const esDevolucionSola = v.tipoOperacion === 'devolucion';
  const headerStyle = (esDevolucionSola || esPrepagoEntrega) ? ' style="background:#d1fae5;color:#065f46"' : '';
  const headerIcon  = esDevolucionSola ? '↩' : (esPrepagoEntrega ? '📦' : '✓');
  const headerTitle = esDevolucionSola ? 'Devolución registrada' : (esPrepagoEntrega ? 'Entrega de prepago' : 'Venta confirmada');

  const descuentoRecibo = Number(v.descuento || 0);
  const recargoRecibo   = Number(v.recargo || 0);
  const cuotasRecibo    = Number(v.cuotas || 0);
  const brutoRecibo     = Number(v.bruto || v.total || 0);
  const mostrarSubtot   = descuentoRecibo > 0 || recargoRecibo > 0;
  const totalLineHtml = esDevolucionSola
    ? ''
    : esPrepagoEntrega
    ? '  <div class="receipt-tot" style="color:#047857"><span>Ya abonado anteriormente</span><span>✓</span></div>' +
      '  <div class="receipt-tot"><span>A cobrar ahora</span><span>' + fmtARS(0) + '</span></div>' +
      '  <div class="receipt-pago"><span>Comprobante</span><span>Entrega de prepago</span></div>'
    : (mostrarSubtot
        ? '  <div class="receipt-tot" style="font-size:13px;color:var(--muted)"><span>Subtotal</span><span>' + fmtARS(brutoRecibo) + '</span></div>'
        : '') +
      (descuentoRecibo > 0
        ? '  <div class="receipt-tot" style="font-size:13px;color:#b45309"><span>Descuento</span><span>−' + fmtARS(descuentoRecibo) + '</span></div>'
        : '') +
      (recargoRecibo > 0
        ? '  <div class="receipt-tot" style="font-size:13px;color:#7c3aed"><span>Recargo' + (cuotasRecibo > 1 ? ' (' + cuotasRecibo + ' cuotas)' : '') + '</span><span>+' + fmtARS(recargoRecibo) + '</span></div>'
        : '') +
      '  <div class="receipt-tot"><span>Total</span><span>' + fmtARS(v.total) + '</span></div>' +
      (recargoRecibo > 0 && cuotasRecibo > 1
        ? '  <div class="receipt-pago"><span>Cuotas</span><span>' + cuotasRecibo + ' × ' + fmtARS(v.total / cuotasRecibo) + '</span></div>'
        : '') +
      '  <div class="receipt-pago"><span>Método</span><span>' + metodoLabel + '</span></div>';

  const itemsBlockHtml = esDevolucionSola
    ? '<div style="font-size:12px;color:var(--muted);font-style:italic;padding:8px 0">Operación sin venta · sin cobro</div>'
    : '<div class="receipt-items">' + itemsHtml + '</div>';

  r.innerHTML =
    (logoUrl ? '<div style="text-align:center;padding:12px 10px 0"><img id="rcp-logo" alt="" crossorigin="anonymous" style="max-height:60px;max-width:75%;object-fit:contain"></div>' : '') +
    '<div class="receipt-h"' + headerStyle + '>' +
    '  <div class="receipt-h-icon">' + headerIcon + '</div>' +
    '  <div class="receipt-h-title">' + headerTitle + '</div>' +
    '  <div class="receipt-h-sub" id="rcp-org"></div>' +
    '  ' + fiscalHtml +
    '</div>' +
    '<div class="receipt-body">' +
    '  <div class="receipt-meta">Ref ' + refCorta + ' · ' + fechaStr + '</div>' +
    '  <div style="font-size:13px;font-weight:700;margin-bottom:8px">Cliente: <span id="rcp-cli"></span></div>' +
    '  ' + itemsBlockHtml +
    totalLineHtml +
    envasesMovHtml +
    '  <div id="rcp-envases-dom"></div>' +
    '  ' + footerHtml +
    '</div>' +
    '<div class="receipt-actions no-print">' +
    '  <button id="rcp-print">🖨 Imprimir</button>' +
    '  <a href="' + waHref + '" target="_blank" rel="noopener">📱 WhatsApp' + (telDigits ? '' : ' (elegir)') + '</a>' +
    (mailHref ? '  <a href="' + mailHref + '">📧 Email</a>' : '') +
    (v.facturaPdfUrl ? '  <a href="' + v.facturaPdfUrl + '" target="_blank" rel="noopener">📄 Ver PDF</a>' : '') +
    '  <button class="btn-primary" id="rcp-close">Cerrar</button>' +
    '</div>';
  if (logoUrl) { const lg = r.querySelector('#rcp-logo'); if (lg) lg.src = logoUrl; }
  r.querySelector('#rcp-org').textContent = orgName || '';
  if (fiscalLines.length) {
    const fiscalDivs = r.querySelectorAll('.receipt-fiscal > div');
    fiscalLines.forEach((line, i) => { if (fiscalDivs[i]) fiscalDivs[i].textContent = line; });
  }
  if (footerLines.length) {
    const footerDivs = r.querySelectorAll('.receipt-footer > div');
    footerLines.forEach((line, i) => { if (footerDivs[i]) footerDivs[i].textContent = line; });
  }
  r.querySelector('#rcp-cli').textContent = v.clienteNombre;
  r.querySelectorAll('.rcp-nm').forEach((el, i) => { el.textContent = v.items[i].nombre; });
  r.querySelector('#rcp-print').addEventListener('click', () => {
    document.body.classList.remove('print-58mm','print-80mm','print-a4');
    document.body.classList.add('print-' + (reciboCfg.tamano_papel || '80mm'));
    window.print();
  });
  r.querySelector('#rcp-close').addEventListener('click', () => ov.classList.remove('show'));
  pintarEnvasesDomicilio(v.clienteId);
  ov.classList.add('show');
}

async function pintarEnvasesDomicilio(clienteId) {
  const anchor = document.getElementById('rcp-envases-dom');
  if (!anchor || !clienteId) return;
  try {
    const { data: envases, error } = await sb.rpc('get_envases_en_cliente_por_tipo', { p_cliente_id: clienteId });
    if (error || !envases?.length) return;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-top:10px;border-top:1px dashed #cbd5e1;padding-top:8px';
    const h = document.createElement('div');
    h.style.cssText = 'font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px';
    h.textContent = 'Envases en domicilio 🫙';
    wrap.appendChild(h);
    envases.forEach((e) => {
      const row = document.createElement('div');
      row.className = 'receipt-pago';
      const nm = document.createElement('span'); nm.textContent = e.tipo_nombre;
      const qt = document.createElement('span'); qt.textContent = e.cantidad;
      row.appendChild(nm); row.appendChild(qt);
      wrap.appendChild(row);
    });
    anchor.replaceChildren(wrap);
  } catch (_) {}
}

// ── VENTAS DEL DÍA ───────────────────────────────────
async function cargarVentasHoy(){
  const list = document.getElementById('ventas-list');
  const kpis = document.getElementById('ventas-kpis');
  if (!list || !kpis) return;
  list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--muted)">Cargando…</div>';

  const { data, error } = await sb.rpc('pos_get_ventas_dia', {
    p_organization_id: orgId,
    p_fecha:           new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }),
  });
  if (error) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--danger)">Error: ' + error.message + '</div>';
    return;
  }

  const ventas  = data?.ventas  || [];
  const totales = data?.totales || {};

  kpis.innerHTML =
    kpiCard('Total cobrado', fmtARS(totales.total || 0), totales.count + ' ventas', '#10b981', INFO.total_cobrado) +
    kpiCard('Efectivo',      fmtARS(totales.efectivo || 0), '', '#374151', INFO.efectivo) +
    kpiCard('MercadoPago',   fmtARS(totales.mp || 0),       '', '#009ee3', INFO.mercadopago) +
    kpiCard('Transferencia', fmtARS(totales.transf || 0),   '', '#7C3AED', INFO.transferencia) +
    kpiCard('Débito',        fmtARS(totales.debito || 0),   '', '#0ea5e9', INFO.debito) +
    kpiCard('Crédito',       fmtARS(totales.credito || 0),  '', '#0284c7', INFO.credito) +
    kpiCard('Cuenta corriente', fmtARS(totales.cc || 0),    '', '#f59e0b', INFO.cuenta_corriente) +
    (totales.anuladas ? kpiCard('Anuladas', totales.anuladas, '', '#ef4444', INFO.anuladas) : '');

  if (!ventas.length) {
    list.innerHTML = '<div style="background:#fff;border:1px dashed var(--border);border-radius:12px;padding:30px;text-align:center;color:var(--muted)">Sin ventas hoy todavía.</div>';
    return;
  }

  list.innerHTML = '';
  ventas.forEach(v => {
    const cancelada = v.estado === 'cancelado';
    const itemsTxt  = (v.items || []).map(i => i.cantidad + '× ' + i.producto).join(', ') || '—';
    const metodoLabel = {
      efectivo: '💵', transferencia: '🏦', mercadopago: '📱',
      debito: '💳', credito: '💳', cuenta_corriente: '💳', otro: '🪙'
    }[v.metodo] || '·';

    const row = document.createElement('div');
    row.className = 'venta-row' + (cancelada ? ' cancelada' : '');
    row.innerHTML =
      '<div class="venta-row-time">' + fmtTime(v.created_at) + '</div>' +
      '<div>' +
        '<div class="venta-row-cli"></div>' +
        '<div class="venta-row-items"></div>' +
      '</div>' +
      '<div style="text-align:right">' +
        '<div class="venta-row-total">' + fmtARS(v.total) + '</div>' +
        '<div class="venta-row-meta">' + metodoLabel + (cancelada ? ' · ANULADA' : '') + '</div>' +
      '</div>' +
      '<div class="venta-row-actions">' +
        (cancelada
          ? ''
          : '<button class="btn-ver">Recibo</button><button class="btn-devolver">Devolver</button><button class="btn-anular">Anular</button>'
        ) +
      '</div>';
    row.querySelector('.venta-row-cli').textContent   = v.cliente_nombre || 'Mostrador';
    row.querySelector('.venta-row-items').textContent = itemsTxt;
    if (!cancelada) {
      row.querySelector('.btn-ver').addEventListener('click', () => verReciboHist(v));
      row.querySelector('.btn-devolver').addEventListener('click', () => abrirDevolucion(v));
      row.querySelector('.btn-anular').addEventListener('click', () => anularVenta(v));
    }
    list.appendChild(row);
  });
}

function kpiCard(label, value, detail, color, info){
  return '<div class="ventas-kpi" style="--ka:' + color + '">' +
    '<div class="ventas-kpi-l" style="display:flex;align-items:center">' + label + iHelp(info) + '</div>' +
    '<div class="ventas-kpi-v">' + value + '</div>' +
    (detail ? '<div style="font-size:10px;color:var(--muted);margin-top:2px">' + detail + '</div>' : '') +
    '</div>';
}

async function verReciboHist(v){
  let envasesCliente = null;
  if (v.cliente_id) {
    const { data: porTipo } = await sb.rpc('get_envases_en_cliente_por_tipo', {
      p_cliente_id: v.cliente_id,
    });
    if (Array.isArray(porTipo) && porTipo.length) {
      envasesCliente = porTipo.map(t =>
        t.cantidad + '× ' + (t.capacidad_litros
          ? t.capacidad_litros + 'L'
          : (t.tipo_nombre || 'Envase'))).join(' · ');
    }
  }
  abrirRecibo({
    pedidoId: v.pedido_id,
    total:    parseFloat(v.total) || 0,
    bruto:    parseFloat(v.bruto) || parseFloat(v.total) || 0,
    descuento: parseFloat(v.descuento) || 0,
    metodo:   v.metodo,
    clienteId: v.cliente_id || null,
    clienteNombre: v.cliente_nombre || 'Mostrador',
    envasesCliente,
    items:    (v.items || []).map(i => ({
      nombre: i.producto, cantidad: i.cantidad, precio: i.precio
    })),
    fecha:    new Date(v.created_at),
  });
}

async function anularVenta(v){
  if (!confirm('¿Anular esta venta de ' + fmtARS(v.total) + '?\n\nSe restaurará el stock y la entrega quedará marcada como rechazada.')) return;
  const { data, error } = await sb.rpc('pos_anular_venta', { p_pedido_id: v.pedido_id });
  if (error) { tmvShowError(error, { title: 'No se pudo anular la venta' }); return; }
  if (!data?.ok) { alert('No se pudo anular'); return; }
  toast('Venta anulada ✓', 'ok');
  await Promise.all([cargarStock(), cargarVentasHoy()]);
  renderProductGrid();
  renderStock();
}

// ── DEVOLUCIONES ──────────────────────────────
async function abrirDevolucion(v) {
  const { data: items, error } = await sb.from('pedido_items')
    .select('id, producto_id, cantidad, cantidad_devuelta, precio')
    .eq('pedido_id', v.pedido_id);
  if (error) { tmvShowError(error, { title: 'No se pudieron cargar los items' }); return; }

  const disponibles = (items || []).map(it => {
    const prod = productos.find(p => p.id === it.producto_id);
    return {
      producto_id: it.producto_id,
      nombre:      prod?.nombre || it.producto_id.slice(0,8),
      precio:      Number(it.precio || 0),
      cantidad:    Number(it.cantidad || 0),
      devuelta:    Number(it.cantidad_devuelta || 0),
      a_devolver:  0,
    };
  }).filter(i => i.cantidad - i.devuelta > 0);

  if (!disponibles.length) {
    alert('No quedan items para devolver (todo fue devuelto previamente).');
    return;
  }

  const ov = document.createElement('div');
  ov.className = 'qr-overlay show';
  ov.style.cssText = 'background:rgba(0,0,0,.5);z-index:200';
  ov.innerHTML =
    '<div style="background:white;border-radius:14px;width:min(560px,90vw);max-height:85vh;overflow:auto;padding:20px">' +
    '<h3 style="margin:0 0 12px;font-size:18px;color:var(--ink)">↩ Devolución</h3>' +
    '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">Tildá los items y ajustá la cantidad. El reembolso se registra como cobro negativo.</div>' +
    '<div id="devo-items" style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px"></div>' +
    '<label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px">Método de reembolso</label>' +
    '<select id="devo-metodo" style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:10px">' +
    '  <option value="efectivo">💵 Efectivo</option>' +
    '  <option value="transferencia">🏦 Transferencia</option>' +
    '  <option value="mercadopago">📱 MercadoPago (manual)</option>' +
    '  <option value="cuenta_corriente">💳 Crédito en cuenta</option>' +
    '</select>' +
    '<label style="font-size:12px;font-weight:600;color:var(--muted);display:block;margin-bottom:4px">Motivo (opcional)</label>' +
    '<input id="devo-motivo" placeholder="Producto en mal estado, error de cantidad, etc." style="width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:14px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:rgba(102,126,234,.06);border-radius:10px;margin-bottom:14px">' +
    '  <span style="font-weight:600">Total a reembolsar</span>' +
    '  <span id="devo-total" style="font-weight:800;font-size:20px">$0</span>' +
    '</div>' +
    '<div style="display:flex;gap:8px;justify-content:flex-end">' +
    '  <button id="devo-cancel" style="padding:10px 16px;border:1px solid var(--border);border-radius:8px;background:white;cursor:pointer">Cancelar</button>' +
    '  <button id="devo-ok" style="padding:10px 16px;border:none;border-radius:8px;background:var(--danger);color:white;font-weight:700;cursor:pointer">Confirmar devolución</button>' +
    '</div>' +
    '</div>';
  document.body.appendChild(ov);

  const itemsWrap = ov.querySelector('#devo-items');
  const totalEl   = ov.querySelector('#devo-total');
  const recalc = () => {
    let t = 0;
    disponibles.forEach(d => { t += d.a_devolver * d.precio; });
    totalEl.textContent = fmtARS(t);
  };

  disponibles.forEach((d, idx) => {
    const max = d.cantidad - d.devuelta;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--border);border-radius:8px';
    row.innerHTML =
      '<input type="checkbox" id="devo-cb-' + idx + '" style="width:18px;height:18px">' +
      '<div style="flex:1;font-size:13px"><b>' + d.nombre + '</b><br>' +
      '<span style="color:var(--muted);font-size:11px">$' + d.precio + ' · disponible: ' + max + (d.devuelta > 0 ? ' (ya devueltos: ' + d.devuelta + ')' : '') + '</span></div>' +
      '<input type="number" id="devo-q-' + idx + '" min="0" max="' + max + '" value="0" style="width:64px;padding:6px;border:1px solid var(--border);border-radius:6px;text-align:center" disabled>';
    const cb = row.querySelector('#devo-cb-' + idx);
    const q  = row.querySelector('#devo-q-' + idx);
    cb.addEventListener('change', () => {
      q.disabled = !cb.checked;
      if (cb.checked && Number(q.value) === 0) { q.value = max; }
      if (!cb.checked) q.value = 0;
      d.a_devolver = Number(q.value) || 0;
      recalc();
    });
    q.addEventListener('input', () => {
      let val = Math.max(0, Math.min(max, Math.floor(Number(q.value) || 0)));
      q.value = val;
      d.a_devolver = val;
      recalc();
    });
    itemsWrap.appendChild(row);
  });

  ov.querySelector('#devo-cancel').addEventListener('click', () => ov.remove());
  ov.querySelector('#devo-ok').addEventListener('click', async (e) => {
    const itemsToReturn = disponibles
      .filter(d => d.a_devolver > 0)
      .map(d => ({ producto_id: d.producto_id, cantidad: d.a_devolver }));
    if (!itemsToReturn.length) { toast('Marcá al menos un item con cantidad > 0', 'warn'); return; }
    const metodo = ov.querySelector('#devo-metodo').value;
    const motivo = ov.querySelector('#devo-motivo').value.trim() || null;
    e.target.disabled = true;
    e.target.textContent = 'Procesando…';
    const { data, error } = await sb.rpc('pos_devolver_venta', {
      p_pedido_id:        v.pedido_id,
      p_items:            itemsToReturn,
      p_motivo:           motivo,
      p_metodo_reembolso: metodo,
    });
    if (error) { tmvShowError(error); e.target.disabled = false; e.target.textContent = 'Confirmar devolución'; return; }
    if (!data?.ok) { alert('No se pudo procesar la devolución'); e.target.disabled = false; return; }
    toast('Devolución ' + fmtARS(data.monto_reembolsado) + ' ✓', 'ok');
    ov.remove();
    await Promise.all([cargarStock(), cargarVentasHoy()]);
    renderProductGrid();
    renderStock();
  });
}

async function _capturarMovEnvases(items) {
  if (!clienteSel?.id) return null;
  let prestado = 0;
  (items || []).forEach(it => {
    if (it.envase_modo !== 'comodato') return;
    const prod = productos.find(p => p.id === it.producto_id);
    if (!prod?.tiene_envase) return;
    const llevados = (it.cantidad_entregada != null ? it.cantidad_entregada : it.cantidad);
    prestado += parseInt(llevados, 10) || 0;
  });
  const devolvio = _envasesDevueltosPayload().reduce((s, r) => s + r.cantidad, 0);
  if (prestado === 0 && devolvio === 0) return null;

  if (_envasesSaldoClientId !== clienteSel.id) {
    const { data } = await sb.rpc('get_envases_en_cliente_por_tipo', { p_cliente_id: clienteSel.id });
    const total = (data || []).reduce((s, t) => s + (t.cantidad || 0), 0);
    _envasesSaldoActual = total;
    _envasesSaldoClientId = clienteSel.id;
  }

  const tenia = Math.max(0, _envasesSaldoActual || 0);
  const ahora = Math.max(0, tenia - devolvio + prestado);
  return { tenia, devolvio, prestado, ahora };
}

async function _confirmarVentaEnvases(items, totalBruto) {
  // Sin cliente (venta a Mostrador) no hay comodato ni devolución que confirmar:
  // el retornable se vende como un producto más.
  if (!clienteSel?.id) return true;
  const prestados = [];
  let totalPrestados = 0;
  items.forEach(it => {
    if (it.envase_modo !== 'comodato') return;
    const prod = productos.find(p => p.id === it.producto_id);
    if (!prod?.tiene_envase) return;
    const llevados = (it.cantidad_entregada != null ? it.cantidad_entregada : it.cantidad);
    if (llevados <= 0) return;
    const cap = prod.capacidad_litros ? prod.capacidad_litros + 'L' : (prod.nombre || 'envase');
    prestados.push({ label: 'Envase ' + cap, value: '×' + llevados });
    totalPrestados += llevados;
  });

  const devueltos = clienteSel?.id ? _envasesDevueltosPayload() : [];
  const totalDevueltos = devueltos.reduce((s, r) => s + r.cantidad, 0);

  if (totalPrestados === 0 && totalDevueltos === 0) return true;

  const lineas = [];
  if (prestados.length) {
    lineas.push({ label: '<span style="color:#7c3aed;font-weight:700">Vas a prestar</span>', value: totalPrestados + ' envase' + (totalPrestados>1?'s':'') });
    prestados.forEach(p => lineas.push({ label: '&nbsp;&nbsp;· ' + p.label, value: p.value }));
  }
  if (devueltos.length) {
    lineas.push({ label: '<span style="color:#059669;font-weight:700">Cliente devuelve</span>', value: totalDevueltos + ' envase' + (totalDevueltos>1?'s':'') });
    devueltos.forEach(r => {
      const tipo = _tiposEnvase.find(t => t.id === r.tipo_envase_id);
      const nm = tipo ? ((tipo.capacidad_litros ? tipo.capacidad_litros + 'L' : '') + ' ' + (tipo.nombre || '')).trim() : 'envase';
      lineas.push({ label: '&nbsp;&nbsp;· ' + nm + (r.condicion === 'roto' ? ' (roto)' : ''), value: '×' + r.cantidad });
    });
  }
  lineas.push({ label: 'Total venta', value: fmtARS(totalBruto) });

  const avisoComodato = (_prepagosPendientesTotal > 0 && totalPrestados > 0);
  if (avisoComodato) {
    lineas.unshift({
      label: '<span style="color:#b45309;font-weight:800">⚠ Tiene ' + _prepagosPendientesTotal + ' prepagado(s) pendiente(s)</span>',
      value: '<span style="color:#b45309;font-weight:700">no prestar comodato</span>',
    });
  }

  let sub = totalPrestados > 0
    ? 'Si querés <strong>vender</strong> el envase (no prestarlo), tildá la opción "Venta" en cada producto retornable antes de cobrar.'
    : 'Verificá que los tipos y cantidades sean correctos.';
  if (avisoComodato) {
    sub = '⚠ <strong>Seguridad:</strong> este cliente tiene <strong>' + _prepagosPendientesTotal +
      ' producto(s) prepagado(s) pendiente(s)</strong>. Por política no se presta envase en comodato hasta que los consuma — entregá del prepago o vendé el envase.<br>' + sub;
  }

  return await confirmarOperacionPOS({
    titulo: avisoComodato ? '⚠ Comodato con prepagos pendientes' : (totalPrestados > 0 ? '🫙 Operación con envases' : '↩️ Devolución de envases'),
    subtitulo: sub,
    lineas,
    btnOkLabel: 'Confirmar y cobrar',
  });
}

// ── Recargo por cuotas (tarjeta de crédito) ────────────────
let _cuotasConfig = null;
async function cargarCuotasConfig() {
  try {
    const { data, error } = await sb.rpc('pos_cuotas_config_get', { p_organization_id: orgId });
    if (error) { _cuotasConfig = []; return; }
    _cuotasConfig = (Array.isArray(data) ? data : [])
      .map(p => ({ cuotas: Number(p.cuotas), recargo_pct: Number(p.recargo_pct) }))
      .filter(p => p.cuotas >= 1 && p.recargo_pct >= 0)
      .sort((a, b) => a.cuotas - b.cuotas);
  } catch (_) { _cuotasConfig = []; }
}

function _pedirCuotasCredito(totalBase) {
  return new Promise(resolve => {
    const planes = _cuotasConfig || [];
    const opciones = [{ cuotas: 1, recargo_pct: 0 }, ...planes];
    const ov = document.createElement('div');
    ov.className = 'qr-overlay show';
    ov.style.cssText = 'background:rgba(0,0,0,.5);z-index:240';
    const filas = opciones.map((o, i) => {
      const recargo = Math.round(totalBase * o.recargo_pct) / 100;
      const tot = totalBase + recargo;
      const porCuota = o.cuotas > 0 ? tot / o.cuotas : tot;
      const etiqueta = o.cuotas === 1 ? 'Contado (1 pago)' : (o.cuotas + ' cuotas');
      const detalle = o.recargo_pct > 0
        ? ('+' + o.recargo_pct + '% · ' + o.cuotas + ' × ' + fmtARS(porCuota))
        : 'sin recargo';
      return '<button class="cuota-op" data-i="' + i + '" style="display:flex;justify-content:space-between;align-items:center;gap:10px;width:100%;padding:12px 14px;border:1.5px solid var(--border);background:#fff;border-radius:10px;cursor:pointer;text-align:left;font-size:14px">' +
        '<span><b>' + etiqueta + '</b><div style="font-size:11px;color:var(--muted);font-weight:500">' + detalle + '</div></span>' +
        '<span style="font-weight:800;white-space:nowrap">' + fmtARS(tot) + '</span>' +
        '</button>';
    }).join('');
    ov.innerHTML =
      '<div style="background:#fff;border-radius:14px;width:min(420px,92vw);max-height:88vh;overflow:auto;padding:20px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
      '<h3 style="margin:0;font-size:18px">💳 Pago con crédito</h3>' +
      '<button id="cuota-x" style="background:none;border:0;font-size:22px;cursor:pointer;color:#64748b">×</button>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--muted);margin-bottom:14px">Elegí en cuántas cuotas. El recargo se suma al total cobrado.</div>' +
      '<div style="display:flex;flex-direction:column;gap:8px">' + filas + '</div>' +
      '</div>';
    document.body.appendChild(ov);
    const cerrar = (val) => { ov.remove(); resolve(val); };
    ov.querySelector('#cuota-x').addEventListener('click', () => cerrar(null));
    ov.addEventListener('mousedown', e => { if (e.target === ov) cerrar(null); });
    ov.querySelectorAll('.cuota-op').forEach(b => {
      b.addEventListener('click', () => {
        const o = opciones[Number(b.dataset.i)];
        const recargo = Math.round(totalBase * o.recargo_pct) / 100;
        cerrar({ cuotas: o.cuotas, pct: o.recargo_pct, recargo });
      });
    });
  });
}

async function renderCuotasConfig() {
  const wrap = document.getElementById('cuotas-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';
  await cargarCuotasConfig();
  const isAdmin = ['client_admin','account_manager','super_admin'].includes(userRole);
  const planes = _cuotasConfig || [];

  const rowHtml = (c, pct) =>
    '<div class="cuota-row" style="display:flex;gap:8px;align-items:center;margin-bottom:8px">' +
    '  <input type="number" min="1" max="60" step="1" class="cuota-n prod-form-i" style="width:90px" placeholder="cuotas" value="' + (c ?? '') + '"' + (isAdmin ? '' : ' disabled') + '>' +
    '  <span style="color:var(--muted);font-size:13px">cuotas →</span>' +
    '  <input type="number" min="0" max="500" step="0.1" class="cuota-pct prod-form-i" style="width:100px" placeholder="% recargo" value="' + (pct ?? '') + '"' + (isAdmin ? '' : ' disabled') + '>' +
    '  <span style="color:var(--muted);font-size:13px">%</span>' +
    (isAdmin ? '  <button type="button" class="cuota-del" title="Quitar" style="margin-left:auto;border:1px solid var(--border);background:#fff;border-radius:8px;width:32px;height:32px;cursor:pointer;color:#dc2626">×</button>' : '') +
    '</div>';

  wrap.innerHTML =
    '<div class="recibo-card">' +
    '  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
    '    <div style="font-size:18px;font-weight:800">💳 Recargo por cuotas</div>' +
    '    <span style="font-size:11px;color:var(--muted)">' + (isAdmin ? '' : 'Solo lectura') + '</span>' +
    '  </div>' +
    '  <div style="font-size:12px;color:var(--muted);margin-bottom:16px">Cuánto se incrementa el total al cobrar con <b>tarjeta de crédito</b> según la cantidad de cuotas. El cajero elige las cuotas al cobrar y el sistema aplica el recargo automáticamente.</div>' +
    '  <div id="cuotas-rows">' +
    (planes.length ? planes.map(p => rowHtml(p.cuotas, p.recargo_pct)).join('') : rowHtml('', '')) +
    '  </div>' +
    (isAdmin ? '  <button type="button" id="cuota-add" style="margin-bottom:16px;padding:8px 14px;border:1px dashed var(--border);background:#fff;border-radius:8px;cursor:pointer;font-weight:600;font-size:13px">+ Agregar plan</button>' : '') +
    (isAdmin ? '  <button id="cuotas-save" type="button" style="width:100%;padding:14px;border-radius:50px;border:none;background:var(--primary);color:#fff;font-weight:700;font-size:14px;cursor:pointer">Guardar configuración</button>' : '') +
    '</div>';

  if (!isAdmin) return;

  const rows = wrap.querySelector('#cuotas-rows');
  const bindDel = () => wrap.querySelectorAll('.cuota-del').forEach(b => {
    b.onclick = () => { b.closest('.cuota-row').remove(); };
  });
  bindDel();
  wrap.querySelector('#cuota-add').addEventListener('click', () => {
    const div = document.createElement('div');
    div.innerHTML = rowHtml('', '');
    rows.appendChild(div.firstElementChild);
    bindDel();
  });

  wrap.querySelector('#cuotas-save').addEventListener('click', async (e) => {
    const arr = [];
    let err = null;
    const seen = new Set();
    wrap.querySelectorAll('.cuota-row').forEach(r => {
      const c = parseInt(r.querySelector('.cuota-n').value, 10);
      const pct = parseFloat(r.querySelector('.cuota-pct').value);
      if (!Number.isFinite(c) && !Number.isFinite(pct)) return;
      if (!Number.isInteger(c) || c < 1 || c > 60) { err = 'Cantidad de cuotas inválida'; return; }
      if (!Number.isFinite(pct) || pct < 0 || pct > 500) { err = 'Porcentaje inválido en ' + c + ' cuotas'; return; }
      if (seen.has(c)) { err = 'Hay cuotas repetidas (' + c + ')'; return; }
      seen.add(c);
      arr.push({ cuotas: c, recargo_pct: pct });
    });
    if (err) { toast(err, 'warn'); return; }
    arr.sort((a, b) => a.cuotas - b.cuotas);
    e.target.disabled = true;
    try {
      const { data, error } = await sb.rpc('pos_cuotas_config_set', { p_organization_id: orgId, p_planes: arr });
      if (error) throw error;
      if (!data?.ok) throw new Error('No se guardó');
      _cuotasConfig = arr;
      toast('Configuración guardada ✓', 'ok');
      renderCuotasConfig();
    } catch (err2) {
      tmvShowError(err2, { title: 'No se pudo guardar' });
    } finally {
      e.target.disabled = false;
    }
  });
}

// ── COBRAR ───────────────────────────────────────────
window.cobrar = async (metodo) => {
  if (cart.size === 0) {
    const payload = _envasesDevueltosPayload();
    if (payload.length > 0 && clienteSel?.id) {
      return window._posSoloDevolver();
    }
    toast('Cargá productos antes de cobrar', 'warn');
    return;
  }

  if (metodo === 'cuenta_corriente' && !clienteSel?.id) {
    toast('Para cuenta corriente seleccioná un cliente real (no Mostrador)', 'warn');
    return;
  }

  // En este POS de mostrador se puede vender un producto retornable a Mostrador
  // (sin cliente): se vende como un producto normal, sin seguimiento de envase
  // en comodato (eso requiere un cliente real para poder recuperarlo después).

  let hayPrepago = false;
  cart.forEach(it => { if (it.entregar != null && it.entregar < it.cantidad) hayPrepago = true; });
  if (hayPrepago && !clienteSel?.id) {
    toast('El prepago (entrega parcial) requiere un cliente real, no Mostrador', 'warn');
    return;
  }

  const items = [];
  let totalBruto = 0;
  let totalConPrepago = 0;
  cart.forEach((it, prodId) => {
    const item = { producto_id: prodId, cantidad: it.cantidad, precio: it.precio, envase_modo: it.envase_modo || 'comodato' };
    const lleva = (it.entregar != null && it.entregar < it.cantidad) ? it.entregar : it.cantidad;
    const resto = it.cantidad - lleva;
    let precioResto = it.precio;
    if (resto > 0) {
      item.cantidad_entregada = lleva;
      if (it.precioPrepago != null && it.precioPrepago < it.precio) {
        item.precio_prepago = it.precioPrepago;
        precioResto = it.precioPrepago;
      }
    }
    items.push(item);
    totalBruto      += it.cantidad * it.precio;
    totalConPrepago += lleva * it.precio + resto * precioResto;
  });

  const descuento = _calcDescuento(totalConPrepago) + _calcPromoOff();
  const total = Math.max(0, totalConPrepago - descuento);

  if (await _bloqueoStock(items)) return;

  const _envasesMovSnap = await _capturarMovEnvases(items);

  if (!await _confirmarVentaEnvases(items, totalBruto)) return;

  if (metodo === 'mercadopago') {
    if (!navigator.onLine) { toast('MercadoPago necesita conexión. Cobrá en efectivo/tarjeta o esperá a tener internet.', 'warn'); return; }
    return cobrarConQR(items, total, descuento, _envasesMovSnap);
  }

  let recargoMonto = 0, cuotasSel = null;
  if (metodo === 'credito') {
    if (_cuotasConfig === null) await cargarCuotasConfig();
    if (_cuotasConfig.length) {
      const elec = await _pedirCuotasCredito(total);
      if (!elec) return;
      recargoMonto = elec.recargo;
      cuotasSel    = elec.cuotas;
    }
  }
  const totalFinal = total + recargoMonto;

  const btnIds = ['btn-efe', 'btn-trs', 'btn-mp', 'btn-cc', 'btn-deb', 'btn-cre'];
  btnIds.forEach(id => { const b = document.getElementById(id); if (b) b.disabled = true; });

  try {
    const { data, error } = await _ventaRPC({
      p_organization_id:    orgId,
      p_items:              items,
      p_cobro_monto:        totalFinal,
      p_cobro_metodo:       metodo,
      p_cliente_id:         clienteSel?.id || null,
      p_cobro_referencia:   null,
      p_notas:              null,
      p_bidones_retirados:  clienteSel?.id ? _envasesRetornadosSum() : 0,
      p_envases_devueltos: clienteSel?.id ? _envasesDevueltosPayload() : null,
      p_stock_strict:       _stockStrict,
      p_tienda_id:          tiendaId || null,
      p_descuento_monto:    descuento,
      p_recargo_monto:      recargoMonto,
      p_cuotas:             cuotasSel,
    });
    if (error) throw error;
    if (!data?.ok) {
      if (data?.error === 'stock_insuficiente') {
        const detalles = (data.stock_errors || []).slice(0, 8).map(e => {
          const p = productos.find(x => x.id === e.producto_id);
          const nm = p ? p.nombre : (e.producto_id || '').slice(0, 8);
          const falta = Math.max(0, (e.requerido || 0) - (e.stock_actual || 0));
          return `${nm} — tenés ${e.stock_actual}, falta ${falta}`;
        });
        await tmvDialog.detail({
          title: 'No alcanza el stock del mostrador',
          body: 'Estos productos no tienen cantidad suficiente para esta venta:',
          items: detalles,
          severity: 'warning',
          okLabel: 'Entendido',
          cancelLabel: '',
        });
        return;
      }
      throw new Error('La RPC no confirmó la venta');
    }

    const factInfo = await _maybeEmitirFactura(data, total);
    _postVentaOk(data, metodo, total, factInfo, _envasesMovSnap, { monto: recargoMonto, cuotas: cuotasSel }, totalBruto);
  } catch (e) {
    console.error(e);
    tmvShowError(e, { title: 'No se pudo registrar la venta' });
  } finally {
    btnIds.forEach(id => { const b = document.getElementById(id); if (b) b.disabled = false; });
    renderCart();
  }
};

function _postVentaOk(data, metodo, totalEstimado, factInfo, envasesMov, recargoInfo, brutoOverride) {
  if (data?.vales_creados > 0) {
    toast('📦 ' + data.vales_creados + ' prepago(s) registrado(s) — pendiente de entrega', 'ok');
  }
  if (metodo === 'efectivo' && 'serial' in navigator) {
    navigator.serial.getPorts().then(ports => {
      if (ports.length > 0) window.abrirCajonMonedero();
    }).catch(() => {});
  }
  const cliIdParaSaldo = clienteSel?.id || null;
  const _recargo = Number(recargoInfo?.monto || 0);
  const _cuotas  = recargoInfo?.cuotas || null;
  const _bruto   = (brutoOverride != null ? brutoOverride : (parseFloat(data.total) || totalEstimado));
  abrirRecibo({
    pedidoId:  data.pedido_id,
    total:     totalEstimado + _recargo,
    bruto:     _bruto,
    descuento: Math.max(0, _bruto - totalEstimado),
    recargo:   _recargo,
    cuotas:    _cuotas,
    metodo:    metodo,
    clienteId: cliIdParaSaldo,
    clienteNombre: clienteSel?.nombre || 'Mostrador',
    telefono:  clienteSel?.telefono || null,
    email:     clienteSel?.email || null,
    facturaPdfUrl: factInfo?.pdf_url || null,
    facturaNumero: factInfo?.numero || null,
    envasesMov: envasesMov || null,
    items:     Array.from(cart.values()).map(i => ({
      nombre: i.nombre, cantidad: i.cantidad, precio: i.precio,
      entregado: (i.entregar != null && i.entregar < i.cantidad) ? i.entregar : i.cantidad,
      prepagado: (i.entregar != null && i.entregar < i.cantidad) ? (i.cantidad - i.entregar) : 0,
    })),
    fecha:     new Date(),
  });

  if (clienteSel?.id) _resumenCliCache.delete(clienteSel.id);
  cart.clear();
  _prepagoDescuento = { valor: 0, tipo: 'pct' };
  clienteSel = null;
  _searchCli = '';
  _resetEnvasesUI();
  _resetDescuento();
  const factCb = document.getElementById('fact-toggle');
  if (factCb) { factCb.checked = false; const ft = document.getElementById('fact-tipo'); if (ft) ft.style.display = 'none'; }
  renderCart();
  renderProductGrid();
  renderClienteUI();
  cargarStock().then(() => renderProductGrid());

  if (data.stock_warns && data.stock_warns.length) {
    const warnsTxt = data.stock_warns.slice(0, 3).map(w => {
      const p = productos.find(x => x.id === w.producto_id);
      const nm = p ? p.nombre : (w.producto_id || '').slice(0, 8);
      return nm + ' (' + w.stock_actual + ')';
    }).join(', ');
    const restantes = data.stock_warns.length - 3;
    const sufijo = restantes > 0 ? ' y ' + restantes + ' más' : '';
    toast('⚠ Stock negativo: ' + warnsTxt + sufijo + ' — andá a Stock para reponer', 'warn');
  } else {
    toast('Venta registrada ✓', 'ok');
  }
  actualizarDashMini().catch(() => {});
}

async function _maybeEmitirFactura(ventaData, total) {
  // Offline: la venta se registra igual, pero la factura se emite después
  // (la emisión necesita conexión con el servidor de facturación).
  if (ventaData?.offline || !navigator.onLine) return;
  const toggle = document.getElementById('fact-toggle');
  if (!toggle?.checked) return;

  let tipo = document.getElementById('fact-tipo')?.value || 'auto';
  let cliFiscal = null;
  if (clienteSel?.id) {
    const { data } = await sb.from('clientes')
      .select('cuit, condicion_iva, tipo_factura')
      .eq('id', clienteSel.id).maybeSingle();
    cliFiscal = data;
  }
  if (tipo === 'auto') {
    if (cliFiscal?.tipo_factura) tipo = cliFiscal.tipo_factura;
    else if (cliFiscal?.cuit && ['responsable_inscripto','monotributo'].includes(cliFiscal?.condicion_iva)) tipo = 'A';
    else tipo = 'B';
  }

  const items = [];
  cart.forEach((it) => {
    items.push({
      descripcion: it.nombre,
      cantidad:    it.cantidad,
      precio_unit: it.precio,
      cobro_id:    ventaData.cobro_id || null,
      entrega_id:  ventaData.entrega_id || null,
    });
  });
  if (!items.length) return;

  const targetClienteId = clienteSel?.id || ventaData.cliente_id || clienteMostradorId;
  if (!targetClienteId) {
    toast('Factura no emitida: sin cliente válido', 'warn');
    return;
  }

  toast('🧾 Emitiendo factura…', 'info');
  try {
    const { data: bData, error: bErr } = await sb.rpc('crear_factura_borrador', {
      p_org_id:     orgId,
      p_cliente_id: targetClienteId,
      p_tipo:       tipo,
      p_iva_pct:    21,
      p_items:      items,
      p_tienda_id:  tiendaId || null,
    });
    if (bErr) throw bErr;
    const facturaId = bData?.factura_id;
    if (!facturaId) throw new Error('crear_factura_borrador no devolvió factura_id');

    const token = await _freshAccessToken();
    const res = await fetch(SB_URL + '/functions/v1/emitir-factura', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + token,
        'apikey':        SB_KEY,
      },
      body: JSON.stringify({ factura_id: facturaId }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) {
      console.warn('[emitir-factura]', out);
      toast('⚠ Factura no emitida: ' + (out.error || 'error desconocido'), 'warn');
      return null;
    }
    toast(`Factura ${out.numero} ${out.simulado ? '(simulada) ' : ''}emitida ✓`, 'ok');
    if (out.pdf_url) {
      try { window.open(out.pdf_url, '_blank', 'noopener'); } catch (_) {}
    }
    return { numero: out.numero, pdf_url: out.pdf_url, simulado: !!out.simulado };
  } catch (e) {
    console.error('emitir-factura:', e);
    toast('⚠ Error emitiendo factura: ' + e.message, 'warn');
    return null;
  }
}

// ── COBRO CON QR DE MERCADOPAGO ──────────────────────
let _qrPolling = null;
let _qrAbortCtrl = null;
let _qrCerrandose = false;
let _qrBackup = null;

async function _freshAccessToken() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return null;
    const expSec = session.expires_at || 0;
    const nowSec = Math.floor(Date.now() / 1000);
    if (expSec - nowSec < 60) {
      const { data: refreshed } = await sb.auth.refreshSession();
      return refreshed?.session?.access_token || null;
    }
    return session.access_token;
  } catch (e) {
    console.warn('_freshAccessToken:', e);
    return null;
  }
}

async function cobrarConQR(items, total, descuento, envasesMov) {
  descuento = descuento || 0;
  const ov = document.getElementById('qr-overlay');
  const imgEl = document.getElementById('qr-img');
  const statusEl = document.getElementById('qr-status');
  const montoEl = document.getElementById('qr-monto');
  const linkEl = document.getElementById('qr-link');
  if (!ov) return;

  if (imgEl) imgEl.innerHTML = '<div class="spinner-lg"></div>';
  if (statusEl) { statusEl.className = 'qr-status wait'; statusEl.textContent = '⏳ Generando QR…'; }
  if (montoEl) montoEl.textContent = fmtARS(total);
  if (linkEl) linkEl.innerHTML = '';
  ov.classList.add('show');

  _qrBackup = { items, total };
  _qrCerrandose = false;

  if (!clienteSel?.id && !clienteMostradorId) {
    try {
      const { data } = await sb.rpc('pos_get_or_create_cliente_mostrador', { p_org_id: orgId });
      if (data) clienteMostradorId = data;
    } catch (e) { console.warn('Mostrador inline:', e); }
  }

  try {
    const token = await _freshAccessToken();
    if (!token) {
      if (statusEl) { statusEl.className = 'qr-status err'; statusEl.textContent = '❌ Sesión expirada — recargá la página'; }
      return;
    }
    const res = await fetch(SB_URL + '/functions/v1/mp-crear-cobro', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'apikey': SB_KEY,
      },
      body: JSON.stringify({
        cliente_id:      clienteSel?.id || clienteMostradorId || null,
        repartidor_id:   null,
        monto:           total,
        descripcion:     'POS · ' + (clienteSel?.nombre || 'Mostrador'),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      if (statusEl) { statusEl.className = 'qr-status err'; statusEl.textContent = '❌ Sesión expirada — recargá la página'; }
      return;
    }
    if (!res.ok || !data?.ok) {
      if (statusEl) { statusEl.className = 'qr-status err'; statusEl.textContent = '❌ ' + (data?.error || 'Error generando QR'); }
      return;
    }

    const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=400x400&margin=10&data=' + encodeURIComponent(data.qr_data);
    if (imgEl) {
      const img = document.createElement('img');
      img.src = qrUrl;
      img.alt = 'QR MercadoPago';
      imgEl.innerHTML = '';
      imgEl.appendChild(img);
    }
    if (linkEl && data.init_point) {
      const a = document.createElement('a');
      a.href = data.init_point;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = '🔗 O enviá el link al cliente';
      linkEl.appendChild(a);
    }
    if (statusEl) { statusEl.className = 'qr-status wait'; statusEl.textContent = '⏳ Esperando pago…'; }

    _qrAbortCtrl = new AbortController();
    let errores = 0;

    if (_qrPolling) clearInterval(_qrPolling);
    _qrPolling = setInterval(async () => {
      if (_qrCerrandose) return;
      try {
        const tk = await _freshAccessToken();
        if (!tk) { errores++; return; }
        const checkRes = await fetch(SB_URL + '/functions/v1/mp-check-cobro', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + tk,
            'apikey': SB_KEY,
          },
          body: JSON.stringify({ cobro_id: data.cobro_id }),
          signal: _qrAbortCtrl.signal,
        });
        const estado = await checkRes.json();
        if (_qrCerrandose) return;
        errores = 0;

        if (estado.paid) {
          _qrCerrandose = true;
          _detenerQrPolling();
          if (statusEl) { statusEl.className = 'qr-status ok'; statusEl.textContent = '✅ Pago confirmado, registrando venta…'; }

          try {
            const { data: vData, error: vErr } = await sb.rpc('pos_registrar_venta', {
              p_organization_id:    orgId,
              p_items:              items,
              p_cobro_monto:        total,
              p_cobro_metodo:       'mercadopago',
              p_cliente_id:         clienteSel?.id || null,
              p_cobro_referencia:   estado.mp_payment_id || data.cobro_id || null,
              p_notas:              null,
              p_existing_cobro_id:  data.cobro_id,
              p_bidones_retirados:  clienteSel?.id ? _envasesRetornadosSum() : 0,
              p_envases_devueltos:  clienteSel?.id ? _envasesDevueltosPayload() : null,
              p_stock_strict:       _stockStrict,
              p_tienda_id:          tiendaId || null,
              p_descuento_monto:    descuento,
            });
            if (vErr) throw vErr;
            if (!vData?.ok) throw new Error('La RPC no confirmó la venta');
            ov.classList.remove('show');
            const factInfo2 = await _maybeEmitirFactura(vData, total);
            _postVentaOk(vData, 'mercadopago', total, factInfo2, envasesMov);
          } catch (e) {
            if (statusEl) { statusEl.className = 'qr-status err'; statusEl.textContent = '❌ ' + (e.message || 'Error al cerrar venta'); }
            tmvShowError(e, { title: 'No se pudo cerrar la venta' });
          }
        } else if (estado.status === 'rejected') {
          _detenerQrPolling();
          if (statusEl) { statusEl.className = 'qr-status err'; statusEl.textContent = '❌ Pago rechazado'; }
        }
      } catch (e) {
        if (e?.name === 'AbortError') return;
        errores++;
        if (errores >= 10) {
          _detenerQrPolling();
          if (statusEl) { statusEl.className = 'qr-status err'; statusEl.textContent = '⚠ Sin red — cancelá y generá un QR nuevo cuando vuelva'; }
        }
      }
    }, 3000);

    setTimeout(() => {
      if (_qrPolling) {
        _detenerQrPolling();
        if (statusEl) { statusEl.className = 'qr-status err'; statusEl.textContent = '⏱ QR expirado — generá uno nuevo'; }
      }
    }, 10 * 60 * 1000);

  } catch (e) {
    console.error('cobrarConQR:', e);
    if (statusEl) { statusEl.className = 'qr-status err'; statusEl.textContent = '❌ ' + (e.message || 'Error de red'); }
  }
}

function _detenerQrPolling() {
  if (_qrPolling) { clearInterval(_qrPolling); _qrPolling = null; }
  try { _qrAbortCtrl?.abort(); } catch (_) {}
  _qrAbortCtrl = null;
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('qr-close');
  if (btn) {
    btn.addEventListener('click', () => {
      _detenerQrPolling();
      _qrCerrandose = true;
      document.getElementById('qr-overlay')?.classList.remove('show');
    });
  }
});

// ── COBRO MIXTO ─────────────────────
window.abrirCobroMixto = () => {
  if (cart.size === 0) { toast('Cargá productos antes de cobrar', 'warn'); return; }
  let hayPrepago = false;
  cart.forEach(it => { if (it.entregar != null && it.entregar < it.cantidad) hayPrepago = true; });
  if (hayPrepago && !clienteSel?.id) {
    toast('El prepago (entrega parcial) requiere un cliente real, no Mostrador', 'warn');
    return;
  }
  let totalBruto = 0, totalConPrepago = 0;
  cart.forEach(it => {
    const lleva = (it.entregar != null && it.entregar < it.cantidad) ? it.entregar : it.cantidad;
    const resto = it.cantidad - lleva;
    const precioResto = (resto > 0 && it.precioPrepago != null && it.precioPrepago < it.precio) ? it.precioPrepago : it.precio;
    totalBruto      += it.cantidad * it.precio;
    totalConPrepago += lleva * it.precio + resto * precioResto;
  });
  const descuentoMix = _calcDescuento(totalConPrepago) + _calcPromoOff();
  const total = Math.max(0, totalConPrepago - descuentoMix);

  const ov = document.getElementById('mix-overlay');
  const totalEl = document.getElementById('mix-total');
  const efe = document.getElementById('mix-efe');
  const trs = document.getElementById('mix-trs');
  const mp  = document.getElementById('mix-mp');
  const deb = document.getElementById('mix-deb');
  const cre = document.getElementById('mix-cre');
  const bal = document.getElementById('mix-balance');
  if (totalEl) totalEl.textContent = fmtARS(total);
  efe.value = '0'; trs.value = '0'; mp.value = '0'; deb.value = '0'; cre.value = '0';

  const confirmBtn0 = document.getElementById('mix-confirm');
  const recalcBal = () => {
    const ve = parseFloat(efe.value) || 0;
    const vt = parseFloat(trs.value) || 0;
    const vm = parseFloat(mp.value)  || 0;
    const vd = parseFloat(deb.value) || 0;
    const vc = parseFloat(cre.value) || 0;
    const sum = ve + vt + vm + vd + vc;
    const diff = total - sum;
    const canConfirm = Math.abs(diff) < 0.01 && sum > 0;
    if (Math.abs(diff) < 0.01) {
      bal.className = 'caja-diff zero';
      bal.textContent = '✓ Total cubierto: ' + fmtARS(sum);
    } else if (diff > 0) {
      bal.className = 'caja-diff neg';
      bal.textContent = '⚠ Falta: ' + fmtARS(diff);
    } else {
      bal.className = 'caja-diff pos';
      bal.textContent = '⚠ Sobra: ' + fmtARS(-diff);
    }
    if (confirmBtn0) {
      confirmBtn0.disabled = !canConfirm;
      confirmBtn0.style.opacity  = canConfirm ? '1' : '.45';
      confirmBtn0.style.cursor   = canConfirm ? 'pointer' : 'not-allowed';
      confirmBtn0.textContent    = canConfirm
        ? 'Confirmar venta · ' + fmtARS(total)
        : (sum === 0 ? 'Cargá los pagos' : 'La suma debe coincidir con el total');
    }
  };
  efe.addEventListener('input', recalcBal);
  trs.addEventListener('input', recalcBal);
  mp.addEventListener('input', recalcBal);
  deb.addEventListener('input', recalcBal);
  cre.addEventListener('input', recalcBal);
  recalcBal();
  ov.classList.add('show');

  const confirmBtn = document.getElementById('mix-confirm');
  confirmBtn.onclick = async () => {
    const ve = parseFloat(efe.value) || 0;
    const vt = parseFloat(trs.value) || 0;
    const vm = parseFloat(mp.value)  || 0;
    const vd = parseFloat(deb.value) || 0;
    const vc = parseFloat(cre.value) || 0;
    const sum = ve + vt + vm + vd + vc;
    if (Math.abs(sum - total) > 0.01) {
      toast('La suma no cubre el total', 'warn'); return;
    }
    const pagos = [];
    if (ve > 0) pagos.push({ metodo: 'efectivo', monto: ve });
    if (vt > 0) pagos.push({ metodo: 'transferencia', monto: vt });
    if (vm > 0) pagos.push({ metodo: 'mercadopago', monto: vm });
    if (vd > 0) pagos.push({ metodo: 'debito', monto: vd });
    if (vc > 0) pagos.push({ metodo: 'credito', monto: vc });
    if (!pagos.length) { toast('Cargá al menos un método', 'warn'); return; }

    const items = [];
    let totalBrutoCart = 0;
    cart.forEach((it, prodId) => {
      const item = { producto_id: prodId, cantidad: it.cantidad, precio: it.precio, envase_modo: it.envase_modo || 'comodato' };
      const lleva = (it.entregar != null && it.entregar < it.cantidad) ? it.entregar : it.cantidad;
      const resto = it.cantidad - lleva;
      if (resto > 0) {
        item.cantidad_entregada = lleva;
        if (it.precioPrepago != null && it.precioPrepago < it.precio) item.precio_prepago = it.precioPrepago;
      }
      items.push(item);
      totalBrutoCart += it.cantidad * it.precio;
    });

    if (await _bloqueoStock(items)) return;

    if (!await _confirmarVentaEnvases(items, totalBrutoCart)) return;

    const envasesMovMix = await _capturarMovEnvases(items);

    confirmBtn.disabled = true;
    try {
      const { data, error } = await _ventaRPC({
        p_organization_id:    orgId,
        p_items:              items,
        p_cobro_monto:        total,
        p_cobro_metodo:       null,
        p_cliente_id:         clienteSel?.id || null,
        p_cobro_referencia:   null,
        p_notas:              null,
        p_bidones_retirados:  clienteSel?.id ? _envasesRetornadosSum() : 0,
        p_envases_devueltos:  clienteSel?.id ? _envasesDevueltosPayload() : null,
        p_stock_strict:       _stockStrict,
        p_pagos:              pagos,
        p_tienda_id:          tiendaId || null,
        p_descuento_monto:    descuentoMix,
      });
      if (error) throw error;
      if (!data?.ok) {
        if (data?.error === 'stock_insuficiente') {
          alert('No alcanza el stock — destildá "Stock estricto" o reponé.');
          return;
        }
        throw new Error('La RPC no confirmó la venta');
      }
      ov.classList.remove('show');
      const factInfo3 = await _maybeEmitirFactura(data, total);
      _postVentaOk(data, 'mixto', total, factInfo3, envasesMovMix, null, totalBrutoCart);
    } catch (e) {
      console.error(e);
      tmvShowError(e, { title: 'No se pudo registrar la venta' });
    } finally {
      confirmBtn.disabled = false;
    }
  };
};

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('mix-close')?.addEventListener('click', () => {
    document.getElementById('mix-overlay')?.classList.remove('show');
  });
});

window.vaciarCarrito = () => { cart.clear(); _prepagoDescuento = { valor: 0, tipo: 'pct' }; renderCart(); renderProductGrid(); };

// ── ALTA DE PRODUCTO ─────────────────────────────────
let _prodEditId = null;
window.abrirAltaProducto = (preset) => {
  preset = preset || {};
  _prodEditId = preset._editId || null;
  const ov = document.getElementById('prod-overlay');
  const titleEl = ov.querySelector('.qr-modal-title');
  if (titleEl) titleEl.textContent = _prodEditId ? '✏️ Editar producto' : '+ Nuevo producto';
  const btnEl = document.getElementById('prod-confirm');
  if (btnEl) btnEl.textContent = _prodEditId ? 'Guardar cambios' : 'Crear producto';

  document.getElementById('prod-nombre').value  = preset.nombre  || '';
  document.getElementById('prod-precio').value  = preset.precio  || '';
  document.getElementById('prod-unidad').value  = preset.unidad  || 'u.';
  document.getElementById('prod-barcode').value = preset.codigo_barra || '';
  document.getElementById('prod-tiene-envase').checked = !!preset.tiene_envase;
  document.getElementById('prod-peso-variable').checked = !!preset.peso_variable;
  document.getElementById('prod-vencimiento').value = preset.fecha_vencimiento || '';
  document.getElementById('prod-promo-qty').value = preset.descuento_volumen_qty || '';
  document.getElementById('prod-promo-pct').value = preset.descuento_volumen_pct || '';
  document.getElementById('prod-es-combo').checked = !!preset.es_combo;
  // Costo + margen: solo administradores. Precargamos y mostramos la fila.
  const costoRow = document.getElementById('prod-costo-row');
  const costoInp = document.getElementById('prod-costo');
  if (costoRow) costoRow.style.display = _isAdmin() ? '' : 'none';
  if (costoInp) costoInp.value = (preset.costo != null && preset.costo !== '') ? preset.costo : '';
  _recalcMargenProd();
  _llenarSelectTipoEnvase(preset.tipo_envase_id || null);
  _toggleTipoEnvaseVisibility();
  _toggleComboVisibility();
  if (_prodEditId && preset.es_combo) {
    _cargarComponentesEnEditor(_prodEditId);
  } else {
    _comboItems = [];
    _renderComboList();
  }
  ov.classList.add('show');
  // Autocompletar desde el catálogo compartido al tipear/escanear un código.
  const _bcEl = document.getElementById('prod-barcode');
  if (_bcEl) _bcEl.onchange = () => _catalogoAutofill(_bcEl.value);
  if (preset.codigo_barra && !_prodEditId) _catalogoAutofill(preset.codigo_barra);
  setTimeout(() => document.getElementById('prod-nombre').focus(), 50);
};

// Autocompleta nombre/unidad desde el catálogo compartido (si la org comparte).
async function _catalogoAutofill(codigo){
  const cb = (codigo || '').trim();
  if (cb.length < 6) return;
  if (productos.some(p => (p.codigo_barra || '') === cb)) return;   // ya lo tenés
  try {
    const { data } = await sb.rpc('pos_catalogo_buscar', { p_organization_id: orgId, p_codigo: cb });
    if (!data?.encontrado) return;
    const nom = document.getElementById('prod-nombre');
    const uni = document.getElementById('prod-unidad');
    if (nom && !nom.value.trim()) nom.value = data.nombre || '';
    if (uni && (!uni.value.trim() || uni.value.trim() === 'u.') && data.unidad) uni.value = data.unidad;
    toast('✓ "' + (data.nombre || '') + '" del catálogo compartido — cargá costo y precio', 'ok');
  } catch (_) {}
}

// Calcula y muestra el margen (precio venta vs costo) en el modal de producto.
function _recalcMargenProd() {
  const el = document.getElementById('prod-margen');
  if (!el) return;
  const precio = parseFloat(document.getElementById('prod-precio')?.value) || 0;
  const costo  = parseFloat(document.getElementById('prod-costo')?.value) || 0;
  if (costo <= 0 || precio <= 0) { el.textContent = '—'; el.style.color = 'var(--muted)'; return; }
  const ganancia = precio - costo;
  const margenPct = precio > 0 ? (ganancia / precio) * 100 : 0;
  const markupPct = costo > 0 ? (ganancia / costo) * 100 : 0;
  el.textContent = margenPct.toFixed(0) + '% · +' + fmtARS(ganancia);
  el.style.color = ganancia < 0 ? 'var(--danger)' : '#059669';
  el.title = 'Margen ' + margenPct.toFixed(1) + '% · Markup ' + markupPct.toFixed(0) + '% · Ganancia ' + fmtARS(ganancia) + ' por unidad';
}

async function _llenarSelectTipoEnvase(seleccionar) {
  const sel = document.getElementById('prod-tipo-envase');
  if (!sel) return;
  let tipos = _envTiposCache;
  if (!tipos.length) {
    const { data } = await sb.rpc('get_envases_consolidado', { p_organization_id: orgId });
    tipos = data?.tipos || [];
    _envTiposCache = tipos;
  }
  const opts = tipos.filter(t => t.es_retornable);
  sel.innerHTML = '<option value="">— Sin asignar (usa fallback) —</option>' +
    opts.map(t => '<option value="' + t.tipo_envase_id + '"' +
      (seleccionar && seleccionar === t.tipo_envase_id ? ' selected' : '') +
      '></option>').join('');
  const optEls = sel.querySelectorAll('option');
  opts.forEach((t, i) => {
    if (optEls[i + 1]) optEls[i + 1].textContent =
      t.tipo_nombre + (t.capacidad_litros ? ' (' + t.capacidad_litros + 'L)' : '');
  });
}

function _toggleTipoEnvaseVisibility() {
  const wrap = document.getElementById('prod-tipo-envase-wrap');
  const cb   = document.getElementById('prod-tiene-envase');
  if (wrap && cb) wrap.style.display = cb.checked ? '' : 'none';
}
function _toggleComboVisibility() {
  const wrap = document.getElementById('prod-combo-wrap');
  const cb   = document.getElementById('prod-es-combo');
  if (wrap && cb) wrap.style.display = cb.checked ? '' : 'none';
}

let _comboItems = [];
function _renderComboList() {
  const cont = document.getElementById('prod-combo-list');
  if (!cont) return;
  if (!_comboItems.length) {
    cont.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:6px 0">Sin componentes. Agregá al menos uno.</div>';
    return;
  }
  cont.innerHTML = '';
  _comboItems.forEach((c, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;align-items:center';
    const opts = productos
      .filter(p => !p.es_combo)
      .map(p => '<option value="' + p.id + '"' + (p.id === c.producto_id ? ' selected' : '') + '>' + p.nombre + '</option>')
      .join('');
    row.innerHTML =
      '<select class="prod-form-i" style="flex:1;font-size:12px;padding:6px 8px"><option value="">— elegir producto —</option>' + opts + '</select>' +
      '<input type="number" min="1" step="1" value="' + (c.cantidad || 1) + '" style="width:60px;padding:6px;border:1px solid var(--border);border-radius:6px;text-align:center;font-size:12px">' +
      '<button type="button" style="padding:6px 8px;border:1px solid rgba(239,68,68,.3);background:rgba(239,68,68,.06);color:#dc2626;border-radius:6px;cursor:pointer">×</button>';
    const sel = row.querySelector('select');
    const qty = row.querySelector('input');
    const del = row.querySelector('button');
    sel.addEventListener('change', () => { _comboItems[idx].producto_id = sel.value; });
    qty.addEventListener('input', () => { _comboItems[idx].cantidad = Math.max(1, Math.floor(Number(qty.value) || 1)); });
    del.addEventListener('click', () => { _comboItems.splice(idx, 1); _renderComboList(); });
    cont.appendChild(row);
  });
}

async function _cargarComponentesEnEditor(productoId) {
  _comboItems = [];
  if (!productoId) { _renderComboList(); return; }
  const { data, error } = await sb.from('combo_componentes')
    .select('componente_id, cantidad')
    .eq('combo_id', productoId);
  if (error) { console.warn('combo_componentes', error); _renderComboList(); return; }
  _comboItems = (data || []).map(c => ({ producto_id: c.componente_id, cantidad: c.cantidad }));
  _renderComboList();
}

async function _persistirCombo(comboId) {
  await sb.from('combo_componentes').delete().eq('combo_id', comboId);
  const items = _comboItems.filter(c => c.producto_id && c.cantidad > 0);
  if (!items.length) return;
  const rows = items.map(c => ({
    combo_id: comboId,
    componente_id: c.producto_id,
    cantidad: c.cantidad,
  }));
  const { error } = await sb.from('combo_componentes').insert(rows);
  if (error) throw new Error('combo_componentes: ' + error.message);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('prod-close')?.addEventListener('click', () => {
    document.getElementById('prod-overlay')?.classList.remove('show');
  });
  document.getElementById('prod-tiene-envase')?.addEventListener('change', _toggleTipoEnvaseVisibility);
  document.getElementById('prod-es-combo')?.addEventListener('change', _toggleComboVisibility);
  document.getElementById('prod-precio')?.addEventListener('input', _recalcMargenProd);
  document.getElementById('prod-costo')?.addEventListener('input', _recalcMargenProd);
  document.getElementById('prod-combo-add')?.addEventListener('click', () => {
    _comboItems.push({ producto_id: null, cantidad: 1 });
    _renderComboList();
  });
  document.getElementById('prod-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('prod-confirm');
    btn.disabled = true;
    try {
      const tieneEnvase = document.getElementById('prod-tiene-envase').checked;
      const tipoEnvId = tieneEnvase
        ? (document.getElementById('prod-tipo-envase')?.value || null)
        : null;
      let data, error;
      if (_prodEditId) {
        ({ data, error } = await sb.rpc('pos_actualizar_producto', {
          p_producto_id:       _prodEditId,
          p_nombre:            document.getElementById('prod-nombre').value.trim(),
          p_precio:            parseFloat(document.getElementById('prod-precio').value) || 0,
          p_unidad:            document.getElementById('prod-unidad').value.trim() || 'u.',
          p_tiene_envase:      tieneEnvase,
          p_codigo_barra:      document.getElementById('prod-barcode').value.trim() || null,
          p_tipo_envase_id:    tipoEnvId,
          p_unset_tipo_envase: !tieneEnvase,
        }));
      } else {
        ({ data, error } = await sb.rpc('pos_crear_producto', {
          p_organization_id: orgId,
          p_nombre:          document.getElementById('prod-nombre').value.trim(),
          p_precio:          parseFloat(document.getElementById('prod-precio').value) || 0,
          p_unidad:          document.getElementById('prod-unidad').value.trim() || 'u.',
          p_tiene_envase:    tieneEnvase,
          p_codigo_barra:    document.getElementById('prod-barcode').value.trim() || null,
          p_tipo_envase_id:  tipoEnvId,
        }));
      }
      if (error) throw error;
      if (!data?.ok) throw new Error('La RPC no confirmó la operación');

      const esCombo = document.getElementById('prod-es-combo').checked;
      const pesoVar = document.getElementById('prod-peso-variable').checked;
      const venc    = document.getElementById('prod-vencimiento').value || null;
      const promoQ  = parseInt(document.getElementById('prod-promo-qty').value) || null;
      const promoP  = parseFloat(document.getElementById('prod-promo-pct').value) || null;
      const productoId = _prodEditId || data.producto_id || data.id;
      if (productoId) {
        const extra = {
          es_combo:               esCombo,
          peso_variable:          pesoVar,
          fecha_vencimiento:      venc,
          descuento_volumen_qty:  promoQ,
          descuento_volumen_pct:  promoP,
        };
        // El costo solo lo escriben administradores (campo oculto para cajeros).
        if (_isAdmin()) {
          const costoRaw = document.getElementById('prod-costo')?.value;
          extra.costo = (costoRaw != null && costoRaw !== '') ? (parseFloat(costoRaw) || 0) : null;
        }
        const { error: cErr } = await sb.from('productos')
          .update(extra)
          .eq('id', productoId);
        if (cErr) console.warn('update extra fields:', cErr);
        if (esCombo) {
          try { await _persistirCombo(productoId); }
          catch (ce) { toast('Producto guardado pero combo: ' + ce.message, 'warn'); }
        } else {
          await sb.from('combo_componentes').delete().eq('combo_id', productoId);
        }
      }

      // Si la org comparte su catálogo, publicar este producto al pool
      // (self-gated: no hace nada si no comparte o no tiene código de barras).
      if (productoId) {
        sb.rpc('pos_catalogo_publicar_uno', { p_organization_id: orgId, p_producto_id: productoId }).catch(() => {});
      }

      document.getElementById('prod-overlay').classList.remove('show');
      const wasEdit = !!_prodEditId;
      _prodEditId = null;
      _comboItems = [];
      await cargarProductos();
      renderProductGrid();
      renderStock();
      toast(wasEdit ? 'Producto actualizado ✓' : 'Producto creado ✓', 'ok');
    } catch (e) {
      tmvShowError(e, { title: 'No se pudo guardar el producto' });
    } finally {
      btn.disabled = false;
    }
  });
});

// ── BARCODE SCANNER ──────────────────────────────────
let _barcodeBuf = '';
let _barcodeTimer = null;
const BARCODE_GAP_MS = 60;

async function _resolverBarcode(codigo) {
  if (!codigo || !orgId) return;
  const local = productos.find(p => p.codigo_barra === codigo);
  if (local) { agregarAlCarrito(local); toast('+ ' + local.nombre, 'ok'); return; }
  try {
    const { data, error } = await sb.rpc('pos_buscar_producto_por_barcode', {
      p_organization_id: orgId,
      p_codigo_barra:    codigo,
    });
    if (error) throw error;
    if (data?.ok && data.producto) {
      agregarAlCarrito(data.producto);
      toast('+ ' + data.producto.nombre, 'ok');
      cargarProductos().catch(()=>{});
      return;
    }
  } catch (e) { console.warn('barcode lookup:', e); }
  if (confirm('Código "' + codigo + '" no está en el catálogo.\n\n¿Crear un producto nuevo con ese código?')) {
    abrirAltaProducto({ codigo_barra: codigo });
  }
}

// Captura global del scanner. Funciona haya o no foco en la barra de
// búsqueda: el scanner USB "tipea" los dígitos muy rápido (ráfaga) y termina
// con Enter. Detectamos la ráfaga por el tiempo entre teclas (BARCODE_GAP_MS)
// y, al recibir Enter con un buffer suficientemente largo, lo resolvemos como
// código de barras y lo agregamos al carrito al instante — limpiando la barra
// de búsqueda si el foco estaba ahí. Un humano tipeando es más lento, así que
// el buffer se resetea y no interfiere con la búsqueda normal.
document.addEventListener('keydown', (e) => {
  const tag = (e.target?.tagName || '').toLowerCase();
  const enInput = tag === 'input' || tag === 'textarea';
  // Permitimos la captura solo cuando no hay foco en un input, o cuando el
  // foco está en la barra de búsqueda (prod-q). En otros inputs (formularios,
  // cantidades, etc.) no interferimos.
  if (enInput && e.target?.id !== 'prod-q') return;
  const blockingModals = ['lock-overlay','prod-overlay','mix-overlay','carga-overlay'];
  for (const id of blockingModals) {
    if (document.getElementById(id)?.classList?.contains('show')) return;
  }
  if (_barcodeTimer) clearTimeout(_barcodeTimer);
  _barcodeTimer = setTimeout(() => { _barcodeBuf = ''; }, BARCODE_GAP_MS * 4);

  if (e.key === 'Enter') {
    // Umbral 6: los códigos EAN/UPC tienen 8–13 dígitos, evita falsos
    // positivos con búsquedas cortas tipeadas a mano.
    if (_barcodeBuf.length >= 6) {
      const code = _barcodeBuf;
      _barcodeBuf = '';
      e.preventDefault();
      // Si el foco estaba en la búsqueda, limpiamos lo que el scanner dejó.
      const q = document.getElementById('prod-q');
      if (q && e.target === q) { q.value = ''; _searchProd = ''; renderProductGrid(); }
      _resolverBarcode(code);
    } else {
      _barcodeBuf = '';
    }
    return;
  }
  if (e.key.length === 1) _barcodeBuf += e.key;
}, true);

// ── CARGA DE STOCK EN BULK ───────────────────────────
window.abrirCargaStock = () => {
  const ov = document.getElementById('carga-overlay');
  const list = document.getElementById('carga-list');
  if (!list) return;
  list.innerHTML = '';
  productos.forEach(p => {
    const cur = stockMap.has(p.id) ? stockMap.get(p.id) : 0;
    const row = document.createElement('div');
    row.className = 'carga-row';
    row.style.gridTemplateColumns = '1fr 58px 60px 84px';
    const costoActual = (p.costo != null && p.costo !== '') ? Number(p.costo) : null;
    row.innerHTML =
      '<div><div class="carga-row-name"></div>' +
        '<div style="font-size:10px;color:var(--muted)">' + (costoActual ? 'costo ' + fmtARS(costoActual) : 'sin costo') + '</div></div>' +
      '<div class="carga-row-cur">x<b>' + cur + '</b></div>' +
      '<input class="carga-row-input" type="number" step="1" placeholder="0" data-prod="' + p.id + '" title="Cantidad a sumar (o negativo para restar)">' +
      '<input class="carga-row-costo" type="number" min="0" step="0.01" placeholder="costo" data-prod="' + p.id + '" data-cur="' + cur + '" title="Costo unitario de esta entrega (opcional)" style="padding:8px 8px;border:1.5px solid var(--border);border-radius:8px;font-size:13px;text-align:right;width:100%">';
    row.querySelector('.carga-row-name').textContent = p.nombre;
    list.appendChild(row);
  });
  document.getElementById('carga-motivo').value = 'carga';
  document.getElementById('carga-origen').value = 'compra';
  const cm = document.getElementById('carga-costo-modo'); if (cm) cm.value = 'promedio';
  document.getElementById('carga-origen-tienda-wrap').style.display = 'none';
  document.getElementById('carga-origen-vehiculo-wrap').style.display = 'none';
  ov.classList.add('show');
  _posPopularOrigenes();
};

async function _posPopularOrigenes() {
  const { data: tiendasLista } = await sb.rpc('pos_listar_tiendas', { p_organization_id: orgId });
  const tSel = document.getElementById('carga-origen-tienda');
  if (tSel) {
    tSel.innerHTML = (tiendasLista || [])
      .filter(t => t.id !== tiendaId)
      .map(t => `<option value="${t.id}">${(t.es_principal ? '★ ' : '') + t.nombre}</option>`).join('');
  }
  const { data: stocks } = await sb.from('stock_repartidor')
    .select('id, vehiculo_id, repartidor_id, vehiculos(patente, marca, modelo)')
    .eq('organization_id', orgId)
    .eq('fecha', new Date().toISOString().slice(0,10))
    .eq('estado', 'abierto');
  const vSel = document.getElementById('carga-origen-vehiculo');
  if (vSel) {
    vSel.innerHTML = (stocks || []).map(s =>
      `<option value="${s.id}">${s.vehiculos?.patente || '—'} · ${s.vehiculos?.marca || ''} ${s.vehiculos?.modelo || ''}</option>`
    ).join('') || '<option value="">— sin jornadas activas —</option>';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const origenSel = document.getElementById('carga-origen');
  if (origenSel) {
    origenSel.addEventListener('change', e => {
      const v = e.target.value;
      const tw = document.getElementById('carga-origen-tienda-wrap');
      const vw = document.getElementById('carga-origen-vehiculo-wrap');
      if (tw) tw.style.display = v === 'tienda'   ? '' : 'none';
      if (vw) vw.style.display = v === 'vehiculo' ? '' : 'none';
    });
  }
});

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('carga-close')?.addEventListener('click', () => {
    document.getElementById('carga-overlay')?.classList.remove('show');
  });
  document.getElementById('carga-confirm')?.addEventListener('click', async (e) => {
    const inputs = document.querySelectorAll('#carga-list .carga-row-input');
    const items = [];
    inputs.forEach(inp => {
      const v = parseInt(inp.value, 10);
      if (!Number.isFinite(v) || v === 0) return;
      items.push({ producto_id: inp.dataset.prod, delta: v });
    });
    if (!items.length) { toast('No cargaste cantidades', 'warn'); return; }
    e.target.disabled = true;
    try {
      const motivo = document.getElementById('carga-motivo').value;
      const origen = document.getElementById('carga-origen').value;
      const origenTienda    = origen === 'tienda'   ? document.getElementById('carga-origen-tienda').value : null;
      const origenVehiculo  = origen === 'vehiculo' ? document.getElementById('carga-origen-vehiculo').value : null;
      if (origen === 'tienda' && !origenTienda) { toast('Elegí la tienda origen', 'err'); e.target.disabled = false; return; }
      if (origen === 'vehiculo' && !origenVehiculo) { toast('Elegí el vehículo origen', 'err'); e.target.disabled = false; return; }
      const { data, error } = await sb.rpc('pos_cargar_stock_bulk', {
        p_organization_id:       orgId,
        p_items:                 items,
        p_motivo:                motivo,
        p_tienda_id:             tiendaId,
        p_origen:                origen,
        p_origen_tienda_id:      origenTienda,
        p_origen_repartidor_id:  origenVehiculo,
      });
      if (error) throw error;
      if (!data?.ok) throw new Error('No se aplicó la carga');

      // Actualizar el costo de los productos cuya entrega trajo un costo nuevo.
      // Usamos el stock previo (data-cur) para el promedio ponderado.
      const modoCosto = document.getElementById('carga-costo-modo')?.value || 'no';
      let costosActualizados = 0;
      if (modoCosto !== 'no') {
        const costoInputs = document.querySelectorAll('#carga-list .carga-row-costo');
        for (const ci of costoInputs) {
          const cn = parseFloat(ci.value) || 0;
          if (cn <= 0) continue;
          const prodId = ci.dataset.prod;
          const it = items.find(x => x.producto_id === prodId);
          if (!it || it.delta <= 0) continue;  // el costo solo aplica al sumar
          const curStock = parseInt(ci.dataset.cur, 10) || 0;
          const prod = productos.find(x => x.id === prodId);
          const nuevo = _costoNuevoPonderado(modoCosto, curStock, prod?.costo, it.delta, cn);
          if (nuevo == null) continue;
          const { error: cErr } = await sb.from('productos').update({ costo: nuevo }).eq('id', prodId);
          if (!cErr) { if (prod) prod.costo = nuevo; costosActualizados++; }
        }
      }

      document.getElementById('carga-overlay').classList.remove('show');
      await cargarStock();
      renderStock();
      renderProductGrid();
      toast('✓ ' + data.aplicados + ' producto' + (data.aplicados>1?'s':'') + ' actualizado' + (data.aplicados>1?'s':'') +
            (costosActualizados > 0 ? ' · ' + costosActualizados + ' costo' + (costosActualizados>1?'s':'') + ' actualizado' + (costosActualizados>1?'s':'') : ''), 'ok');
    } catch (err) {
      tmvShowError(err, { title: 'No se pudo cargar el stock' });
    } finally {
      e.target.disabled = false;
    }
  });
});

// ── ENVASES (visibilidad y transferencias) ─────────────────
let _envPeriodo = 30;
let _envTiposCache = [];
async function renderEnvases() {
  const wrap = document.getElementById('envases-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';

  const [consResp, resumenResp] = await Promise.all([
    sb.rpc('get_envases_consolidado', { p_organization_id: orgId }),
    sb.rpc('pos_envases_retornados_resumen', { p_organization_id: orgId, p_dias: _envPeriodo }),
  ]);

  if (consResp.error) {
    wrap.innerHTML = '<div style="background:rgba(239,68,68,.08);border:1.5px solid rgba(239,68,68,.3);border-radius:14px;padding:14px;color:var(--danger)">Error: ' + consResp.error.message + '</div>';
    return;
  }
  const tipos = (consResp.data?.tipos) || [];
  _envTiposCache = tipos;
  const isAdmin = ['client_admin','account_manager','super_admin'].includes(userRole);

  let html = '';
  html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:14px;flex-wrap:wrap">';
  html += '<h3 style="font-size:14px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:0">Stock por tipo de envase</h3>';
  if (isAdmin) {
    html += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
    html += '<button id="env-transferir" type="button" style="padding:8px 16px;border-radius:50px;border:1.5px solid var(--primary);background:rgba(124,58,237,.06);color:var(--primary);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">↔ Transferir</button>';
    html += '<button id="env-vacios-deposito" type="button" style="padding:8px 16px;border-radius:50px;border:1.5px solid #059669;background:rgba(16,185,129,.08);color:#059669;font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">📦 Vacíos → depósito</button>';
    html += '</div>';
  }
  html += '</div>';

  if (tipos.length === 0) {
    html += '<div class="env-empty" style="background:#fff;border:1px solid var(--border);border-radius:14px">Sin tipos de envase configurados. Configurá primero los tipos desde el dashboard de admin.</div>';
  } else {
    tipos.forEach(t => {
      const total = t.total_circulante;
      const valor = (t.valor_unitario || 0) * total;
      html += '<div class="env-tipo-card">' +
        '<div class="env-tipo-h">' +
        '  <div class="env-tipo-name"></div>' +
        '  <div class="env-tipo-cap">' + (t.capacidad_litros ? t.capacidad_litros + 'L' : '') +
            (t.es_retornable ? ' · 🔁 retornable' : ' · descartable') + '</div>' +
        '</div>' +
        '<div class="env-tipo-grid">' +
        _envCol('Depósito',     t.en_deposito,  '🏭') +
        _envCol('Mostrador',    t.en_mostrador, '🛒') +
        _envCol('Repartidores', t.en_ruta,      '🚚') +
        _envCol('En clientes',  t.en_clientes,  '🏠', 'comodato') +
        '</div>' +
        '<div class="env-tipo-total">' +
        '  <span>Total circulante</span>' +
        '  <span class="env-tipo-total-v">' + total + (valor > 0 ? ' · ' + fmtARS(valor) : '') + '</span>' +
        '</div>' +
        (t.vendidos > 0 || t.rotos > 0 || t.perdidos > 0
          ? '<div class="env-tipo-extras">' +
            (t.vendidos > 0 ? '<span class="env-extra venta">💰 Vendidos: <b>' + t.vendidos + '</b></span>' : '') +
            (t.rotos > 0    ? '<span class="env-extra roto">⚠ Rotos: <b>' + t.rotos + '</b></span>' : '') +
            (t.perdidos > 0 ? '<span class="env-extra perdido">❓ Perdidos: <b>' + t.perdidos + '</b></span>' : '') +
            '</div>'
          : '') +
        '</div>';
    });
  }

  if (!resumenResp.error && resumenResp.data) {
    const data = resumenResp.data;
    html += '<h3 style="font-size:14px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:24px 0 10px">Retornos en mostrador</h3>';
    html += '<div class="env-period">';
    [[7,'7 días'],[30,'30 días'],[90,'90 días']].forEach(([d, lbl]) => {
      html += '<button data-d="' + d + '"' + (d === _envPeriodo ? ' class="active"' : '') + '>' + lbl + '</button>';
    });
    html += '</div>';
    html += '<div class="env-kpis">' +
      '<div class="env-kpi hl"><div class="env-kpi-l">Hoy' + iHelp(INFO.env_hoy) + '</div><div class="env-kpi-v">' + (data.total_hoy || 0) + '</div></div>' +
      '<div class="env-kpi"><div class="env-kpi-l">' + _envPeriodo + ' días' + iHelp(INFO.env_periodo) + '</div><div class="env-kpi-v">' + (data.total_periodo || 0) + '</div></div>' +
      '<div class="env-kpi"><div class="env-kpi-l">Clientes' + iHelp(INFO.env_clientes) + '</div><div class="env-kpi-v">' + (data.clientes_unicos || 0) + '</div></div>' +
      '</div>';

    const top = data.top_clientes || [];
    const ult = data.ultimos || [];

    html += '<div class="env-section"><h3>Top clientes que retornan</h3>';
    if (top.length === 0) html += '<div class="env-empty">Aún sin retornos en este período</div>';
    else top.forEach(t => {
      html += '<div class="env-row"><span class="env-row-name"></span><span class="env-row-cant">' + t.envases_retornados + '</span></div>';
    });
    html += '</div>';

    html += '<div class="env-section"><h3>Últimas operaciones</h3>';
    if (ult.length === 0) html += '<div class="env-empty">Sin operaciones registradas todavía</div>';
    else ult.forEach(u => {
      const fecha = new Date(u.entregado_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      html += '<div class="env-row">' +
        '<div><div class="env-row-name"></div><div style="font-size:11px;color:var(--muted)">' + fecha + '</div></div>' +
        '<span class="env-row-cant">+' + u.envases_retornados + '</span>' +
        '</div>';
    });
    html += '</div>';
  }

  wrap.innerHTML = html;

  tipos.forEach((t, i) => {
    const card = wrap.querySelectorAll('.env-tipo-card')[i];
    if (card) card.querySelector('.env-tipo-name').textContent = t.tipo_nombre;
  });
  if (!resumenResp.error && resumenResp.data) {
    const top = resumenResp.data.top_clientes || [];
    const ult = resumenResp.data.ultimos || [];
    const sects = wrap.querySelectorAll('.env-section');
    if (sects[0]) {
      const rows = sects[0].querySelectorAll('.env-row .env-row-name');
      top.forEach((t, i) => { if (rows[i]) rows[i].textContent = t.cliente_nombre; });
    }
    if (sects[1]) {
      const rows = sects[1].querySelectorAll('.env-row .env-row-name');
      ult.forEach((u, i) => { if (rows[i]) rows[i].textContent = u.cliente_nombre; });
    }
  }

  wrap.querySelectorAll('.env-period button').forEach(b => {
    b.addEventListener('click', () => {
      _envPeriodo = parseInt(b.dataset.d, 10);
      renderEnvases();
    });
  });
  document.getElementById('env-transferir')?.addEventListener('click', abrirTransferenciaEnvases);
  document.getElementById('env-vacios-deposito')?.addEventListener('click', async () => {
    if (!confirm('¿Mover los vacíos del mostrador de esta tienda al depósito?')) return;
    const { data, error } = await sb.rpc('transferir_vacios_tienda_a_deposito', { p_organization_id: orgId, p_tienda_id: tiendaId });
    if (error) { tmvShowError(error); return; }
    toast('Vacíos al depósito: ' + (data?.total_vacios || 0), 'ok');
    renderEnvases();
  });
}

function _envCol(label, valor, icon, hint) {
  return '<div class="env-col' + (hint ? ' ' + hint : '') + '">' +
    '<div class="env-col-icon">' + icon + '</div>' +
    '<div class="env-col-l">' + label + '</div>' +
    '<div class="env-col-v">' + (valor || 0) + '</div>' +
    '</div>';
}

// ── TRANSFERIR ENVASES ───────────────────────────────
let _transfClienteSel = null;
let _transfRepartidores = [];
async function abrirTransferenciaEnvases() {
  const ov = document.getElementById('transf-overlay');
  const tipoSel = document.getElementById('transf-tipo');
  if (!_envTiposCache.length) {
    toast('No hay tipos de envase configurados', 'warn');
    return;
  }
  tipoSel.innerHTML = _envTiposCache.map(t =>
    '<option value="' + t.tipo_envase_id + '">' + t.tipo_nombre + (t.capacidad_litros ? ' (' + t.capacidad_litros + 'L)' : '') + '</option>'
  ).join('');
  if (!_transfRepartidores.length) {
    const { data } = await sb.from('repartidores')
      .select('id, nombre')
      .eq('organization_id', orgId)
      .eq('activo', true)
      .order('nombre');
    _transfRepartidores = data || [];
    document.getElementById('transf-rep').innerHTML =
      '<option value="">— Elegí un repartidor —</option>' +
      _transfRepartidores.map(r => '<option value="' + r.id + '"></option>').join('');
    const opts = document.getElementById('transf-rep').querySelectorAll('option');
    _transfRepartidores.forEach((r, i) => { if (opts[i+1]) opts[i+1].textContent = r.nombre; });
  }
  _transfClienteSel = null;
  document.getElementById('transf-cli-q').value = '';
  document.getElementById('transf-cli-sel').textContent = '';
  document.getElementById('transf-cant').value = '';
  document.getElementById('transf-notas').value = '';
  _toggleTransfFields();
  ov.classList.add('show');
  setTimeout(() => document.getElementById('transf-cant').focus(), 50);
}

function _toggleTransfFields() {
  const o = document.getElementById('transf-origen').value;
  const d = document.getElementById('transf-destino').value;
  const repNeeded = o === 'repartidor' || d === 'repartidor';
  const cliNeeded = o === 'cliente' || d === 'cliente';
  document.getElementById('transf-rep-wrap').style.display = repNeeded ? '' : 'none';
  document.getElementById('transf-cli-wrap').style.display = cliNeeded ? '' : 'none';
}

async function _transfBuscarClientes(q) {
  const box = document.getElementById('transf-cli-suggest');
  if (!box) return;
  if (q.length < 2) { box.classList.remove('show'); return; }
  const { data } = await sb.from('clientes')
    .select('id, nombre, telefono')
    .eq('organization_id', orgId)
    .eq('activo', true)
    .or('nombre.ilike.%' + q + '%,telefono.ilike.%' + q + '%')
    .limit(8);
  if (!data || !data.length) {
    box.innerHTML = '<div class="pos-cliente-suggest-item" style="color:var(--muted);cursor:default">Sin resultados</div>';
    box.classList.add('show');
    return;
  }
  box.innerHTML = '';
  data.forEach(c => {
    const item = document.createElement('div');
    item.className = 'pos-cliente-suggest-item';
    item.innerHTML = '<div class="nm"></div><div class="tel">' + (c.telefono || '—') + '</div>';
    item.querySelector('.nm').textContent = c.nombre;
    item.addEventListener('click', () => {
      _transfClienteSel = { id: c.id, nombre: c.nombre };
      document.getElementById('transf-cli-q').value = c.nombre;
      document.getElementById('transf-cli-sel').textContent = '✓ ' + c.nombre;
      box.classList.remove('show');
    });
    box.appendChild(item);
  });
  box.classList.add('show');
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('transf-close')?.addEventListener('click', () => {
    document.getElementById('transf-overlay')?.classList.remove('show');
  });
  document.getElementById('transf-origen')?.addEventListener('change', _toggleTransfFields);
  document.getElementById('transf-destino')?.addEventListener('change', _toggleTransfFields);
  let _tcTimer = null;
  document.getElementById('transf-cli-q')?.addEventListener('input', (e) => {
    clearTimeout(_tcTimer);
    _tcTimer = setTimeout(() => _transfBuscarClientes(e.target.value.trim()), 220);
  });
  document.getElementById('transf-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tipoId  = document.getElementById('transf-tipo').value;
    const origen  = document.getElementById('transf-origen').value;
    const destino = document.getElementById('transf-destino').value;
    const cant    = parseInt(document.getElementById('transf-cant').value, 10);
    const notas   = document.getElementById('transf-notas').value.trim() || null;
    const repId   = (origen === 'repartidor' || destino === 'repartidor')
      ? (document.getElementById('transf-rep').value || null) : null;
    const cliId   = (origen === 'cliente' || destino === 'cliente')
      ? (_transfClienteSel?.id || null) : null;

    if (!tipoId)            { toast('Falta tipo de envase', 'warn'); return; }
    if (origen === destino) { toast('Origen y destino no pueden ser iguales', 'warn'); return; }
    if (!Number.isFinite(cant) || cant <= 0) { toast('Cantidad inválida', 'warn'); return; }
    if ((origen === 'repartidor' || destino === 'repartidor') && !repId) {
      toast('Elegí el repartidor', 'warn'); return;
    }
    if ((origen === 'cliente' || destino === 'cliente') && !cliId) {
      toast('Elegí el cliente', 'warn'); return;
    }

    const btn = document.getElementById('transf-confirm');
    btn.disabled = true;
    try {
      const { data, error } = await sb.rpc('pos_transferir_envases', {
        p_organization_id: orgId,
        p_tipo_envase_id:  tipoId,
        p_origen:          origen,
        p_destino:         destino,
        p_cantidad:        cant,
        p_repartidor_id:   repId,
        p_cliente_id:      cliId,
        p_notas:           notas,
      });
      if (error) throw error;
      if (!data?.ok) throw new Error('No se aplicó la transferencia');
      document.getElementById('transf-overlay').classList.remove('show');
      toast('Transferencia aplicada ✓', 'ok');
      renderEnvases();
    } catch (err) {
      tmvShowError(err, { title: 'No se pudo transferir' });
    } finally {
      btn.disabled = false;
    }
  });
});

// ── RECIBO CONFIG ────────────────────────────────────
let reciboCfg = {
  tamano_papel: '80mm',
  mostrar_cuit: true, mostrar_direccion: true, mostrar_telefono: true,
  header_extra: null, footer_mensaje: '¡Gracias por su compra!',
  footer_extra: null, logo_url: null,
};

async function cargarReciboConfig() {
  const { data, error } = await sb.rpc('pos_recibo_config_get', { p_organization_id: orgId, p_tienda_id: tiendaId });
  if (error) { console.warn('recibo config:', error); return; }
  if (data) reciboCfg = { ...reciboCfg, ...data };
}

// Reduce una imagen a un data URL chico (para guardar el logo del ticket sin
// usar Storage). Mantiene proporción, ancho máx ~360px.
function _fileToLogoDataURL(file, maxW = 360) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) { reject(new Error('El archivo no es una imagen')); return; }
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('No se pudo leer el archivo'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Imagen inválida'));
      img.onload = () => {
        const scale = Math.min(1, maxW / (img.width || maxW));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/png'));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

// HTML de un ticket de muestra para la vista previa, según la config actual.
function _reciboPreviewHTML(cfg) {
  const esc = s => String(s ?? '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  const fiscal = [];
  if (cfg.header_extra) fiscal.push(cfg.header_extra);
  if (cfg.mostrar_cuit && orgFiscal.cuit)           fiscal.push('CUIT: ' + orgFiscal.cuit);
  if (cfg.mostrar_direccion && orgFiscal.direccion) fiscal.push(orgFiscal.direccion);
  if (cfg.mostrar_telefono && orgFiscal.telefono)   fiscal.push('Tel: ' + orgFiscal.telefono);
  const foot = [];
  if (cfg.footer_mensaje) foot.push(cfg.footer_mensaje);
  if (cfg.footer_extra)   foot.push(cfg.footer_extra);
  const width = cfg.tamano_papel === '58mm' ? 210 : cfg.tamano_papel === 'a4' ? 360 : 280;
  return '<div style="background:#fff;color:#000;width:' + width + 'px;max-width:100%;margin:0 auto;padding:14px 16px;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.14);font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;line-height:1.5">' +
    (cfg.logo_url ? '<div style="text-align:center;margin-bottom:8px"><img src="' + cfg.logo_url + '" alt="logo" style="max-height:56px;max-width:75%;object-fit:contain"></div>' : '') +
    '<div style="text-align:center;font-weight:800;font-size:14px">' + esc(orgName || 'Tu negocio') + '</div>' +
    (fiscal.length ? '<div style="text-align:center;color:#555;font-size:10px;margin-top:2px">' + fiscal.map(esc).join('<br>') + '</div>' : '') +
    '<div style="text-align:center;color:#777;font-size:10px;margin:8px 0">Ref A1B2C3D4 · ' + new Date().toLocaleDateString('es-AR') + '</div>' +
    '<div style="font-size:12px;font-weight:700;margin-bottom:6px">Cliente: Mostrador</div>' +
    '<div style="border-top:1px dashed #999;border-bottom:1px dashed #999;padding:8px 0;margin-bottom:8px">' +
      '<div style="display:flex;justify-content:space-between"><span>2 × Gaseosa 600ml</span><span>$2.000</span></div>' +
      '<div style="display:flex;justify-content:space-between"><span>1 × Alfajor</span><span>$1.500</span></div>' +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;font-weight:800;font-size:15px"><span>Total</span><span>$3.500</span></div>' +
    '<div style="display:flex;justify-content:space-between;color:#555;font-size:11px;margin-top:2px"><span>Método</span><span>💵 Efectivo</span></div>' +
    (foot.length ? '<div style="text-align:center;color:#555;font-size:10px;border-top:1px dashed #999;margin-top:8px;padding-top:6px">' + foot.map(esc).join('<br>') + '</div>' : '') +
    '</div>';
}

async function renderReciboConfig() {
  const wrap = document.getElementById('recibo-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';
  await cargarReciboConfig();
  const c = reciboCfg;
  const isAdmin = ['client_admin','account_manager','super_admin'].includes(userRole);
  let logoActual = c.logo_url || null;   // se actualiza al subir/quitar logo

  wrap.innerHTML =
    '<div style="display:grid;grid-template-columns:1fr;gap:16px">' +
    '<div class="recibo-card">' +
    '  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">' +
    '    <div style="font-size:18px;font-weight:800">Recibo / Ticket</div>' +
    '    <span style="font-size:11px;color:var(--muted)">' + (isAdmin ? '' : 'Solo lectura') + '</span>' +
    '  </div>' +
    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">Logo del negocio</div>' +
    '    <div style="display:flex;gap:12px;align-items:center">' +
    '      <div id="rc-logo-prev" style="width:64px;height:64px;border:1.5px dashed var(--border);border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#fff;flex-shrink:0;font-size:24px">🏪</div>' +
    '      <div style="flex:1;min-width:0">' +
    '        <input id="rc-logo-file" type="file" accept="image/png,image/jpeg,image/webp" style="font-size:12px;max-width:100%"' + (isAdmin ? '' : ' disabled') + '>' +
    '        <div style="font-size:11px;color:var(--muted);margin-top:4px">PNG/JPG. Se reduce solo para el ticket. Mejor con fondo transparente.</div>' +
    '        <button id="rc-logo-clear" type="button" style="margin-top:6px;padding:5px 10px;border:1px solid var(--border);background:#fff;border-radius:8px;font-size:12px;cursor:pointer;display:none">Quitar logo</button>' +
    '      </div>' +
    '    </div>' +
    '  </div>' +
    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">Tamaño del papel</div>' +
    '    <div class="recibo-papel-grid">' +
    ['58mm','80mm','a4'].map(t => '<label><input type="radio" name="papel" value="' + t + '"' + (c.tamano_papel === t ? ' checked' : '') + '><span>' + t.toUpperCase() + '</span></label>').join('') +
    '    </div>' +
    '  </div>' +
    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">Datos fiscales en el header</div>' +
    '    <label class="recibo-toggle"><span>CUIT</span><input id="rc-cuit" type="checkbox"' + (c.mostrar_cuit ? ' checked' : '') + '></label>' +
    '    <label class="recibo-toggle"><span>Dirección</span><input id="rc-dir" type="checkbox"' + (c.mostrar_direccion ? ' checked' : '') + '></label>' +
    '    <label class="recibo-toggle"><span>Teléfono</span><input id="rc-tel" type="checkbox"' + (c.mostrar_telefono ? ' checked' : '') + '></label>' +
    '  </div>' +
    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">Texto extra del header (opcional)</div>' +
    '    <input id="rc-header" class="prod-form-i" style="width:100%" placeholder="Ej: Sucursal Centro" maxlength="80">' +
    '  </div>' +
    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">Mensaje al pie</div>' +
    '    <input id="rc-footer-msg" class="prod-form-i" style="width:100%" placeholder="¡Gracias por su compra!" maxlength="120">' +
    '    <div style="height:8px"></div>' +
    '    <input id="rc-footer-extra" class="prod-form-i" style="width:100%" placeholder="Ej: WhatsApp 11-1234-5678 · Instagram @almacen" maxlength="120">' +
    '  </div>' +
    '  <button id="rc-save" type="button" style="width:100%;padding:14px;border-radius:50px;border:none;background:var(--primary);color:#fff;font-weight:700;font-size:14px;cursor:pointer"' + (isAdmin ? '' : ' disabled') + '>Guardar configuración</button>' +
    '</div>' +
    '<div class="recibo-card">' +
    '  <div style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px">Vista previa del ticket</div>' +
    '  <div id="rc-preview" style="background:#f1f5f9;border-radius:12px;padding:20px;overflow:auto"></div>' +
    '</div>' +
    '</div>';

  document.getElementById('rc-header').value      = c.header_extra || '';
  document.getElementById('rc-footer-msg').value  = c.footer_mensaje || '';
  document.getElementById('rc-footer-extra').value = c.footer_extra || '';

  // Estado del thumbnail del logo + botón de quitar.
  const logoPrev  = document.getElementById('rc-logo-prev');
  const logoClear = document.getElementById('rc-logo-clear');
  const pintarLogoThumb = () => {
    if (logoActual) {
      logoPrev.innerHTML = '<img src="' + logoActual + '" alt="logo" style="max-width:100%;max-height:100%;object-fit:contain">';
      logoClear.style.display = isAdmin ? '' : 'none';
    } else {
      logoPrev.innerHTML = '🏪';
      logoClear.style.display = 'none';
    }
  };
  pintarLogoThumb();

  // Vista previa en vivo: lee los inputs actuales + el logo en memoria.
  const refreshPreview = () => {
    const cfg = {
      logo_url:         logoActual,
      tamano_papel:     wrap.querySelector('input[name="papel"]:checked')?.value || '80mm',
      mostrar_cuit:     document.getElementById('rc-cuit').checked,
      mostrar_direccion:document.getElementById('rc-dir').checked,
      mostrar_telefono: document.getElementById('rc-tel').checked,
      header_extra:     document.getElementById('rc-header').value.trim() || null,
      footer_mensaje:   document.getElementById('rc-footer-msg').value.trim() || null,
      footer_extra:     document.getElementById('rc-footer-extra').value.trim() || null,
    };
    document.getElementById('rc-preview').innerHTML = _reciboPreviewHTML(cfg);
  };
  refreshPreview();
  // Re-render del preview ante cualquier cambio.
  wrap.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('input', refreshPreview);
    el.addEventListener('change', refreshPreview);
  });

  // Carga de logo.
  document.getElementById('rc-logo-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      logoActual = await _fileToLogoDataURL(file, 360);
      pintarLogoThumb();
      refreshPreview();
      toast('Logo cargado · acordate de Guardar', 'ok');
    } catch (err) {
      toast('No se pudo procesar la imagen: ' + err.message, 'err');
    }
  });
  logoClear.addEventListener('click', () => {
    logoActual = null;
    document.getElementById('rc-logo-file').value = '';
    pintarLogoThumb();
    refreshPreview();
  });

  document.getElementById('rc-save').addEventListener('click', async (e) => {
    if (!isAdmin) { toast('Sin permisos', 'err'); return; }
    e.target.disabled = true;
    const tamano = wrap.querySelector('input[name="papel"]:checked')?.value || '80mm';
    try {
      const { data, error } = await sb.rpc('pos_recibo_config_set', {
        p_organization_id:   orgId,
        p_tamano_papel:      tamano,
        p_mostrar_cuit:      document.getElementById('rc-cuit').checked,
        p_mostrar_direccion: document.getElementById('rc-dir').checked,
        p_mostrar_telefono:  document.getElementById('rc-tel').checked,
        p_header_extra:      document.getElementById('rc-header').value.trim() || null,
        p_footer_mensaje:    document.getElementById('rc-footer-msg').value.trim() || null,
        p_footer_extra:      document.getElementById('rc-footer-extra').value.trim() || null,
        p_logo_url:          logoActual || null,
        p_tienda_id:         tiendaId,
      });
      if (error) throw error;
      if (!data?.ok) throw new Error('No se guardó');
      reciboCfg = {
        ...reciboCfg,
        tamano_papel: tamano,
        mostrar_cuit: document.getElementById('rc-cuit').checked,
        mostrar_direccion: document.getElementById('rc-dir').checked,
        mostrar_telefono: document.getElementById('rc-tel').checked,
        header_extra: document.getElementById('rc-header').value.trim() || null,
        footer_mensaje: document.getElementById('rc-footer-msg').value.trim() || null,
        footer_extra: document.getElementById('rc-footer-extra').value.trim() || null,
        logo_url: logoActual || null,
      };
      toast('Configuración guardada ✓', 'ok');
    } catch (err) {
      tmvShowError(err, { title: 'No se pudo guardar' });
    } finally {
      e.target.disabled = false;
    }
  });
}

// ── ARRANQUE ─────────────────────────────────────────
init();

// ── PWA: registrar service worker ─────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { scope: './' })
      .then(reg => {
        reg.addEventListener('updatefound', () => {
          const w = reg.installing;
          if (!w) return;
          w.addEventListener('statechange', () => {
            if (w.state === 'installed' && navigator.serviceWorker.controller) {
              w.postMessage('skip-waiting');
            }
          });
        });
      })
      .catch(err => console.warn('[sw-pos] register fallo:', err));

    let _swReloaded = false;
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'sw-updated' && !_swReloaded) {
        _swReloaded = true;
        console.log('[sw-pos] versión nueva activa, recargando…', e.data.version);
        location.reload();
      }
    });
  });
}

// ════════════════════════════════════════════════════════════════════
//  USUARIOS (gestión por el admin) — crear y dar de alta/baja
// ════════════════════════════════════════════════════════════════════
const _ROLE_LABEL = {
  client_admin: 'Administrador', account_manager: 'Gerente',
  client_pos: 'Cajero', client_user: 'Usuario', super_admin: 'Super admin',
};
async function renderUsuarios() {
  const wrap = document.getElementById('usuarios-wrap');
  if (!wrap) return;
  if (!_isAdmin()) { wrap.innerHTML = '<div class="env-empty" style="background:#fff;border:1px solid var(--border);border-radius:14px">Solo administradores.</div>'; return; }
  wrap.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';
  const { data, error } = await sb.rpc('pos_listar_usuarios', { p_organization_id: orgId });
  if (error) { wrap.innerHTML = '<div style="color:var(--danger);padding:20px">Error: ' + error.message + '</div>'; return; }
  const usuarios = data?.usuarios || [];
  const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  // Permisos de stock por cajero (para los toggles).
  let permMap = {};
  try {
    const { data: permData } = await sb.rpc('pos_permisos_listar', { p_organization_id: orgId });
    (permData || []).forEach(p => { permMap[p.user_id] = p; });
  } catch (_) {}

  let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;gap:10px;flex-wrap:wrap">' +
    '<h3 style="font-size:14px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:0">Usuarios del negocio</h3>' +
    '<button id="usr-add" type="button" style="padding:9px 16px;border-radius:50px;border:1.5px solid var(--primary);background:rgba(124,58,237,.06);color:var(--primary);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">+ Nuevo usuario</button>' +
    '</div>' +
    '<div style="font-size:12px;color:var(--ink);background:rgba(124,58,237,.06);border-radius:8px;padding:8px 10px;margin-bottom:12px">ℹ️ Creá cajeros (solo venta) o administradores (acceso total). A cada cajero podés habilitarle <b>📦 Recibir stock</b> (reponer/cargar mercadería) y/o <b>✏️ Ajustar / descontar</b> (restar stock y editar productos). Sin permisos, el cajero ve el stock en modo lectura.</div>';

  if (!usuarios.length) {
    html += '<div class="env-empty" style="background:#fff;border:1px solid var(--border);border-radius:14px">Todavía no hay usuarios.</div>';
  } else {
    usuarios.forEach(u => {
      const rol = _ROLE_LABEL[u.role] || u.role;
      const inactivo = !u.activo;
      html += '<div class="tienda-card' + (inactivo ? ' inactiva' : '') + '">' +
        '<div class="tienda-card-info">' +
        '  <div class="tienda-card-nm"><span class="nm"></span>' +
        '    <span class="pp" style="background:' + (u.role==='client_pos' ? '#0ea5e9' : 'var(--primary)') + '">' + esc(rol) + '</span>' +
        (u.es_actual ? '<span style="font-size:10px;color:var(--muted)">vos</span>' : '') +
        (inactivo ? '<span style="font-size:10px;color:var(--danger)">dado de baja</span>' : '') +
        '  </div>' +
        '  <div class="tienda-card-meta email"></div>' +
        ((u.role === 'client_pos' && u.activo) ? (function(){
          const pm = permMap[u.user_id] || {};
          const rec = !!pm.recibir_stock, aj = !!pm.ajustar_stock;
          return '<div class="usr-perms" data-uid="' + u.user_id + '" style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:var(--ink)">' +
            '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" class="perm-rec" ' + (rec?'checked':'') + '> 📦 Recibir stock</label>' +
            '<label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" class="perm-aj" ' + (aj?'checked':'') + '> ✏️ Ajustar / descontar</label>' +
          '</div>';
        })() : '') +
        '</div>' +
        '<div class="tienda-card-actions">' +
        (u.es_actual ? '<span style="font-size:11px;color:var(--muted)">—</span>'
                     : '<button type="button" data-toggle="' + u.user_id + '" data-activo="' + (u.activo?'1':'0') + '">' + (u.activo ? 'Dar de baja' : 'Reactivar') + '</button>') +
        '</div>' +
        '</div>';
    });
  }
  wrap.innerHTML = html;
  usuarios.forEach((u, i) => {
    const card = wrap.querySelectorAll('.tienda-card')[i];
    if (!card) return;
    card.querySelector('.nm').textContent = u.nombre || '—';
    card.querySelector('.email').textContent = u.email + (u.tienda_nombre ? ' · 🏪 ' + u.tienda_nombre : '');
  });

  document.getElementById('usr-add')?.addEventListener('click', abrirNuevoUsuario);
  wrap.querySelectorAll('.usr-perms').forEach(box => {
    const uid = box.dataset.uid;
    const rec = box.querySelector('.perm-rec');
    const aj  = box.querySelector('.perm-aj');
    const save = async () => {
      const { data, error } = await sb.rpc('pos_permisos_set', {
        p_organization_id: orgId, p_user_id: uid,
        p_recibir_stock: rec.checked, p_ajustar_stock: aj.checked,
      });
      if (error || !data?.ok) { toast('No se pudo guardar el permiso', 'err'); return; }
      toast('Permisos actualizados ✓', 'ok');
    };
    rec.addEventListener('change', save);
    aj.addEventListener('change', () => { if (aj.checked) rec.checked = true; save(); });
  });
  wrap.querySelectorAll('button[data-toggle]').forEach(b => {
    b.addEventListener('click', async () => {
      const activar = b.dataset.activo !== '1';
      if (!activar && !confirm('¿Dar de baja a este usuario? No podrá ingresar hasta que lo reactives.')) return;
      const { data, error } = await sb.rpc('pos_set_usuario_activo', {
        p_organization_id: orgId, p_user_id: b.dataset.toggle, p_activo: activar,
      });
      if (error) { tmvShowError(error); return; }
      if (!data?.ok) { toast('No se pudo actualizar', 'err'); return; }
      toast(activar ? 'Usuario reactivado ✓' : 'Usuario dado de baja', 'ok');
      renderUsuarios();
    });
  });
}

function abrirNuevoUsuario() {
  const tiendasOpts = (tiendas || []).map(t => '<option value="' + t.id + '">' + (t.es_principal ? '★ ' : '') + t.nombre.replace(/[<>&"]/g, '') + '</option>').join('');
  const ov = document.createElement('div');
  ov.className = 'qr-overlay show';
  ov.style.cssText = 'background:rgba(0,0,0,.5);z-index:240';
  ov.innerHTML =
    '<div style="background:#fff;border-radius:14px;width:min(440px,92vw);max-height:90vh;overflow:auto;padding:22px">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
    '<h3 style="margin:0;font-size:18px">+ Nuevo usuario</h3>' +
    '<button id="usr-x" style="background:none;border:0;font-size:22px;cursor:pointer;color:#64748b">×</button></div>' +
    '<label class="prod-form-l">Nombre *</label>' +
    '<input id="usr-nombre" class="prod-form-i" style="width:100%;margin-bottom:10px" placeholder="Nombre del cajero/admin">' +
    '<label class="prod-form-l">Email *</label>' +
    '<input id="usr-email" type="email" class="prod-form-i" style="width:100%;margin-bottom:10px" placeholder="usuario@negocio.com" autocomplete="off">' +
    '<label class="prod-form-l">Contraseña *</label>' +
    '<input id="usr-pass" type="text" class="prod-form-i" style="width:100%;margin-bottom:10px" placeholder="mínimo 6 caracteres" autocomplete="off">' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">' +
    '<div><label class="prod-form-l">Rol</label>' +
    '<select id="usr-role" class="prod-form-i" style="width:100%">' +
    '<option value="client_pos" selected>Cajero (solo venta)</option>' +
    '<option value="client_admin">Administrador (acceso total)</option>' +
    '</select></div>' +
    '<div><label class="prod-form-l">Tienda (opcional)</label>' +
    '<select id="usr-tienda" class="prod-form-i" style="width:100%"><option value="">Todas</option>' + tiendasOpts + '</select></div>' +
    '</div>' +
    '<div style="font-size:11px;color:var(--muted);margin-bottom:14px">El cajero solo verá la pantalla de venta, ventas del día y caja. El administrador ve todo (stock, costos, finanzas, usuarios).</div>' +
    '<button id="usr-save" style="width:100%;padding:13px;border-radius:50px;border:none;background:var(--primary);color:#fff;font-weight:700;font-size:14px;cursor:pointer">Crear usuario</button>' +
    '</div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#usr-x').addEventListener('click', close);
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  setTimeout(() => ov.querySelector('#usr-nombre')?.focus(), 50);

  ov.querySelector('#usr-save').addEventListener('click', async (e) => {
    const nombre = ov.querySelector('#usr-nombre').value.trim();
    const email  = ov.querySelector('#usr-email').value.trim();
    const pass   = ov.querySelector('#usr-pass').value;
    const role   = ov.querySelector('#usr-role').value;
    const tienda = ov.querySelector('#usr-tienda').value || null;
    if (!nombre || !email || pass.length < 6) { toast('Completá nombre, email y contraseña (6+)', 'warn'); return; }
    e.target.disabled = true; e.target.textContent = 'Creando…';
    try {
      const token = await _freshAccessToken();
      if (!token) { toast('Sesión expirada, recargá la página', 'err'); e.target.disabled = false; return; }
      const res = await fetch(SB_URL + '/functions/v1/crear-usuario', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'apikey': SB_KEY },
        body: JSON.stringify({ email, password: pass, nombre, role, organization_id: orgId }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok || out.error) { toast('Error: ' + (out.error || ('status ' + res.status)), 'err'); e.target.disabled = false; e.target.textContent = 'Crear usuario'; return; }
      // Asignación de tienda (best-effort): la edge function no la setea.
      if (tienda && out.user_id) {
        try { await sb.from('user_roles').update({ tienda_id: tienda }).eq('user_id', out.user_id).eq('organization_id', orgId); }
        catch (_) {}
      }
      toast('Usuario creado ✓', 'ok');
      close();
      renderUsuarios();
    } catch (err) {
      toast('Error: ' + err.message, 'err');
      e.target.disabled = false; e.target.textContent = 'Crear usuario';
    }
  });
}

// ════════════════════════════════════════════════════════════════════
//  FINANZAS — resumen de lo que pasó (ventas, costo, margen, gastos…)
// ════════════════════════════════════════════════════════════════════
function _finRango(preset) {
  const hoy = new Date();
  const fmt = d => d.toISOString().slice(0, 10);
  if (preset === 'hoy')  return [fmt(hoy), fmt(hoy)];
  if (preset === 'mes')  return [fmt(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), fmt(hoy)];
  if (preset === '7')    { const d = new Date(hoy); d.setDate(d.getDate()-6); return [fmt(d), fmt(hoy)]; }
  if (preset === '30')   { const d = new Date(hoy); d.setDate(d.getDate()-29); return [fmt(d), fmt(hoy)]; }
  return [fmt(new Date(hoy.getFullYear(), hoy.getMonth(), 1)), fmt(hoy)];
}

async function renderFinanzas() {
  const wrap = document.getElementById('finanzas-wrap');
  if (!wrap) return;
  if (!_isAdmin()) { wrap.innerHTML = '<div class="env-empty" style="background:#fff;border:1px solid var(--border);border-radius:14px">Solo administradores.</div>'; return; }
  // Estructura base con selector de período (solo la primera vez)
  if (!document.getElementById('fin-desde')) {
    const [d0, d1] = _finRango('mes');
    const escT = s => String(s ?? '').replace(/[<>&"]/g, '');
    // Selector de tienda: solo si hay más de una (para no confundir en tiendas únicas).
    const tiendaSelHtml = (tiendas.length > 1)
      ? '<select id="fin-tienda" class="prod-form-i" style="padding:6px 10px">' +
          '<option value="">🏪 Todas las tiendas</option>' +
          tiendas.map(t => '<option value="' + t.id + '">🏪 ' + escT(t.nombre || 'Tienda') + '</option>').join('') +
        '</select>'
      : '';
    wrap.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px">' +
        '<h2 style="margin:0;font-size:20px">📈 Finanzas</h2>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
          tiendaSelHtml +
          '<input type="date" id="fin-desde" class="prod-form-i" style="padding:6px 10px" value="' + d0 + '">' +
          '<span style="color:var(--muted)">→</span>' +
          '<input type="date" id="fin-hasta" class="prod-form-i" style="padding:6px 10px" value="' + d1 + '">' +
          '<button id="fin-go" style="padding:8px 14px;border:none;background:var(--primary);color:#fff;border-radius:8px;cursor:pointer;font-weight:600;font-size:12px">Ver</button>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;align-items:center" id="fin-presets">' +
        '<button data-p="hoy" style="padding:6px 14px;border-radius:50px;border:1px solid var(--border);background:#fff;cursor:pointer;font-size:12px;font-weight:600">Hoy</button>' +
        '<button data-p="7" style="padding:6px 14px;border-radius:50px;border:1px solid var(--border);background:#fff;cursor:pointer;font-size:12px;font-weight:600">7 días</button>' +
        '<button data-p="mes" style="padding:6px 14px;border-radius:50px;border:1px solid var(--border);background:#fff;cursor:pointer;font-size:12px;font-weight:600">Este mes</button>' +
        '<button data-p="30" style="padding:6px 14px;border-radius:50px;border:1px solid var(--border);background:#fff;cursor:pointer;font-size:12px;font-weight:600">30 días</button>' +
        '<button id="fin-add-gasto" style="margin-left:auto;padding:6px 14px;border-radius:50px;border:1px solid rgba(220,38,38,.3);background:rgba(220,38,38,.05);color:#dc2626;cursor:pointer;font-size:12px;font-weight:700">＋ Registrar gasto</button>' +
      '</div>' +
      '<div id="fin-gasto-form" style="display:none;background:#fff;border:1px solid var(--border);border-radius:12px;padding:14px;margin-bottom:14px">' +
        '<div style="font-weight:700;margin-bottom:10px">Registrar gasto</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px">' +
          '<div><label class="prod-form-l">Fecha</label><input type="date" id="fg-fecha" class="prod-form-i" value="' + d1 + '"></div>' +
          '<div><label class="prod-form-l">Tipo de costo</label><select id="fg-tipo" class="prod-form-i"><option value="fijo">Fijo (mensual)</option><option value="variable" selected>Variable</option></select></div>' +
          '<div><label class="prod-form-l">Categoría</label><input type="text" id="fg-cat" class="prod-form-i" list="fg-cats" placeholder="Ej: Alquiler" autocomplete="off">' +
            '<datalist id="fg-cats"><option>Alquiler</option><option>Servicios (luz/agua/gas)</option><option>Internet / Teléfono</option><option>Nómina / Sueldos</option><option>Cargas sociales</option><option>Impuestos y tasas</option><option>Mercadería / Insumos</option><option>Fletes / Envíos</option><option>Mantenimiento</option><option>Comisiones</option><option>Marketing / Publicidad</option><option>Otros</option></datalist></div>' +
          '<div><label class="prod-form-l">Monto</label><input type="number" min="0" step="0.01" id="fg-monto" class="prod-form-i" placeholder="0"></div>' +
          '<div><label class="prod-form-l">Detalle (opcional)</label><input type="text" id="fg-desc" class="prod-form-i" placeholder="Ej: Sueldo de Juan"></div>' +
        '</div>' +
        '<div style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.5">💡 <b>Fijo</b>: se repite todos los meses (alquiler, sueldos/nómina, servicios). <b>Variable</b>: cambia o es puntual (mercadería, fletes, arreglos).</div>' +
        '<div style="display:flex;gap:8px;margin-top:12px">' +
          '<button id="fg-save" style="padding:10px 16px;border:none;background:var(--primary);color:#fff;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px">Guardar gasto</button>' +
          '<button id="fg-cancel" style="padding:10px 16px;border:1px solid var(--border);background:#fff;border-radius:8px;cursor:pointer;font-size:13px">Cancelar</button>' +
        '</div>' +
        '<div id="fg-msg" style="font-size:12px;margin-top:8px"></div>' +
      '</div>' +
      '<div id="fin-content"></div>';
    document.getElementById('fin-go').addEventListener('click', _cargarFinanzas);
    document.getElementById('fin-tienda')?.addEventListener('change', _cargarFinanzas);
    document.getElementById('fin-add-gasto').addEventListener('click', () => {
      const f = document.getElementById('fin-gasto-form');
      f.style.display = f.style.display === 'none' ? '' : 'none';
      if (f.style.display === '') document.getElementById('fg-monto').focus();
    });
    document.getElementById('fg-cancel').addEventListener('click', () => {
      document.getElementById('fin-gasto-form').style.display = 'none';
    });
    document.getElementById('fg-save').addEventListener('click', _guardarGasto);
    wrap.querySelectorAll('#fin-presets button[data-p]').forEach(b => b.addEventListener('click', () => {
      const [a, c] = _finRango(b.dataset.p);
      document.getElementById('fin-desde').value = a;
      document.getElementById('fin-hasta').value = c;
      _cargarFinanzas();
    }));
  }
  _cargarFinanzas();
}

async function _cargarFinanzas() {
  const cont = document.getElementById('fin-content');
  if (!cont) return;
  const desde = document.getElementById('fin-desde').value;
  const hasta = document.getElementById('fin-hasta').value;
  if (!desde || !hasta) { toast('Elegí el rango', 'warn'); return; }
  cont.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';

  // 1) Ventas del rango, opcionalmente filtradas por tienda (#8).
  const tiendaSel = document.getElementById('fin-tienda')?.value || null;
  const { data: vr, error: vErr } = await sb.rpc('pos_get_ventas_rango', {
    p_organization_id: orgId, p_fecha_desde: desde, p_fecha_hasta: hasta,
    p_cajero_id: null, p_tienda_id: tiendaSel,
  });
  if (vErr) { cont.innerHTML = '<div style="color:var(--danger);padding:20px">Error: ' + vErr.message + '</div>'; return; }
  const t = vr.totales || {};
  const porProd = vr.por_producto || [];
  // Ventas por cajero (para el cálculo de comisiones/incentivos).
  const porCajeroFin = (vr.por_cajero || []).filter(c => c.cajero_id && (Number(c.monto) || 0) > 0);

  // 2) COGS (costo de mercadería vendida) estimado con el costo del catálogo
  const costoMap = new Map(productos.map(p => [p.id, Number(p.costo) || 0]));
  let cogs = 0, sinCosto = 0, gananciaProd = [];
  porProd.forEach(p => {
    const c = costoMap.get(p.producto_id) || 0;
    const qty = Number(p.cantidad) || 0;
    const monto = Number(p.monto) || 0;
    if (c <= 0) sinCosto += qty;
    cogs += qty * c;
    gananciaProd.push({ nombre: p.producto, qty, monto, costoTotal: qty * c, ganancia: monto - qty * c, tieneCosto: c > 0 });
  });
  const ventas = Number(t.total) || 0;
  const margenBruto = ventas - cogs;

  // 3) Gastos e ingresos extra del rango (lectura directa; degrada si falla)
  let gastos = [], ingresos = [];
  try {
    const { data } = await sb.from('gastos')
      .select('id, monto, fecha, descripcion, proveedor, metodo_pago, es_recurrente, categorias_gasto(nombre)')
      .eq('organization_id', orgId).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
    gastos = data || [];
  } catch (_) {}
  try {
    const { data } = await sb.from('ingresos')
      .select('monto, fecha, descripcion, origen, metodo_pago, categorias_ingreso(nombre)')
      .eq('organization_id', orgId).gte('fecha', desde).lte('fecha', hasta).order('fecha', { ascending: false });
    ingresos = data || [];
  } catch (_) {}
  const totGastos = gastos.reduce((s, g) => s + (Number(g.monto) || 0), 0);
  const totIngresos = ingresos.reduce((s, g) => s + (Number(g.monto) || 0), 0);
  // Clasificación fijos vs variables + desglose por categoría.
  const totFijos = gastos.filter(g => g.es_recurrente).reduce((s, g) => s + (Number(g.monto) || 0), 0);
  const totVariables = totGastos - totFijos;
  const _catMap = new Map();
  gastos.forEach(g => {
    const nombre = g.categorias_gasto?.nombre || 'Sin categoría';
    const cur = _catMap.get(nombre) || { nombre, total: 0, fijo: false };
    cur.total += (Number(g.monto) || 0);
    if (g.es_recurrente) cur.fijo = true;
    _catMap.set(nombre, cur);
  });
  const gastosPorCat = [..._catMap.values()].sort((a, b) => b.total - a.total);
  const cajaIng = Number(t.ingresos) || 0;
  const cajaEgr = Number(t.egresos) || 0;
  const resultado = margenBruto - totGastos + totIngresos;

  const kpi = (lbl, val, color, sub, info) => '<div style="background:white;border:1px solid var(--border);border-radius:12px;padding:14px 16px;flex:1;min-width:150px"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;display:flex;align-items:center">' + lbl + iHelp(info) + '</div><div style="font-size:22px;font-weight:800;margin-top:3px;color:' + (color||'var(--ink)') + '">' + val + '</div>' + (sub ? '<div style="font-size:11px;color:var(--muted);margin-top:2px">' + sub + '</div>' : '') + '</div>';

  let html = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px">' +
    kpi('Ventas (cobrado)', fmtARS(ventas), '#059669', (t.count||0) + ' ventas', INFO.fin_ventas) +
    kpi('Costo mercadería', fmtARS(cogs), '#dc2626', 'estimado', INFO.fin_costo) +
    kpi('Margen bruto', fmtARS(margenBruto), margenBruto<0?'#dc2626':'#059669', ventas>0 ? (margenBruto/ventas*100).toFixed(0) + '% s/ventas' : '', INFO.fin_margen) +
    kpi('Gastos', fmtARS(totGastos), '#dc2626', (totGastos > 0 ? fmtARS(totFijos) + ' fijos · ' + fmtARS(totVariables) + ' var.' : gastos.length + ' registros'), INFO.fin_gastos) +
    kpi('Otros ingresos', fmtARS(totIngresos), '#059669', ingresos.length + ' registros', INFO.fin_otros_ing) +
    kpi('Resultado neto', fmtARS(resultado), resultado<0?'#dc2626':'#059669', 'margen − gastos + ingresos', INFO.fin_resultado) +
  '</div>';

  if (sinCosto > 0) {
    html += '<div style="font-size:12px;color:#b45309;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.25);border-radius:8px;padding:8px 10px;margin-bottom:14px">⚠ ' + sinCosto + ' unidad(es) vendida(s) sin costo cargado: el costo y el margen son parciales. Cargá el costo de esos productos en Stock para un cálculo exacto.</div>';
  }

  // Ventas por método
  const metodos = [['efectivo','💵 Efectivo'],['transf','🏦 Transferencia'],['mp','📱 MercadoPago'],['debito','💳 Débito'],['credito','💳 Crédito'],['cc','📒 Cuenta corriente']];
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px">';
  html += '<div style="background:white;border:1px solid var(--border);border-radius:12px;padding:14px"><div style="font-weight:700;margin-bottom:8px">Ventas por método de pago</div><table style="width:100%;border-collapse:collapse;font-size:13px"><tbody>' +
    metodos.filter(([k]) => (Number(t[k])||0) > 0).map(([k, lbl]) => '<tr><td style="padding:4px 0">' + lbl + '</td><td style="text-align:right;font-weight:600">' + fmtARS(t[k]) + '</td></tr>').join('') +
    '<tr style="border-top:1px solid var(--border)"><td style="padding-top:6px;font-weight:700">Total</td><td style="text-align:right;font-weight:800;padding-top:6px">' + fmtARS(ventas) + '</td></tr>' +
    (cajaIng > 0 || cajaEgr > 0 ? '<tr><td colspan="2" style="padding-top:8px;font-size:11px;color:var(--muted)">Caja: +' + fmtARS(cajaIng) + ' ingresos · −' + fmtARS(cajaEgr) + ' egresos</td></tr>' : '') +
    '</tbody></table></div>';

  // Productos más rentables (con costo)
  const conGanancia = gananciaProd.filter(g => g.tieneCosto).sort((a,b) => b.ganancia - a.ganancia).slice(0, 8);
  html += '<div style="background:white;border:1px solid var(--border);border-radius:12px;padding:14px"><div style="font-weight:700;margin-bottom:8px">Productos por ganancia</div>';
  if (!conGanancia.length) html += '<div style="font-size:12px;color:var(--muted)">Cargá costos a tus productos para ver la ganancia por artículo.</div>';
  else html += '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="color:var(--muted);text-align:right"><th style="text-align:left">Producto</th><th>Vts</th><th>Ganancia</th></tr></thead><tbody>' +
    conGanancia.map(g => '<tr><td style="text-align:left;padding:3px 0">' + String(g.nombre||'').replace(/[<>&]/g,'') + '</td><td style="text-align:right">' + g.qty + '</td><td style="text-align:right;font-weight:600;color:' + (g.ganancia<0?'#dc2626':'#059669') + '">' + fmtARS(g.ganancia) + '</td></tr>').join('') +
    '</tbody></table>';
  html += '</div>';
  html += '</div>';

  // Desglose de gastos por categoría (con clasificación fijo/variable).
  if (gastos.length) {
    html += '<div style="background:white;border:1px solid var(--border);border-radius:12px;padding:14px;margin-top:14px">' +
      '<div style="font-weight:700;margin-bottom:8px;display:flex;align-items:center">Gastos por categoría' + iHelp('Gastos del período agrupados por categoría. La etiqueta indica si es un costo FIJO (se repite cada mes: alquiler, sueldos, servicios) o VARIABLE (puntual: mercadería, fletes, arreglos).') + '</div>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px"><tbody>' +
      gastosPorCat.map(c => '<tr style="border-top:1px solid #f1f5f9"><td style="padding:5px 0">' + String(c.nombre).replace(/[<>&]/g,'') +
        (c.fijo
          ? ' <span style="font-size:9px;font-weight:800;background:rgba(124,58,237,.1);color:#7c3aed;padding:1px 6px;border-radius:50px">FIJO</span>'
          : ' <span style="font-size:9px;font-weight:800;background:rgba(2,132,199,.1);color:#0284c7;padding:1px 6px;border-radius:50px">VARIABLE</span>') +
        '</td><td style="text-align:right;font-weight:700;color:#dc2626">' + fmtARS(c.total) + '</td></tr>').join('') +
      '<tr style="border-top:2px solid var(--border)"><td style="padding:6px 0;font-weight:700">🔒 Costos fijos</td><td style="text-align:right;font-weight:800">' + fmtARS(totFijos) + '</td></tr>' +
      '<tr><td style="padding:2px 0;font-weight:700">📊 Costos variables</td><td style="text-align:right;font-weight:800">' + fmtARS(totVariables) + '</td></tr>' +
      '<tr style="border-top:1px solid var(--border)"><td style="padding:6px 0;font-weight:800">Total gastos</td><td style="text-align:right;font-weight:900;color:#dc2626">' + fmtARS(totGastos) + '</td></tr>' +
      '</tbody></table></div>';
  }

  // Detalle de gastos
  const notaTienda = tiendaSel ? ' <span style="font-weight:400;color:var(--muted)">· los gastos son generales (no se dividen por tienda)</span>' : '';
  html += '<div style="background:white;border:1px solid var(--border);border-radius:12px;padding:14px;margin-top:14px"><div style="font-weight:700;margin-bottom:8px">Gastos del período (' + gastos.length + ')' + notaTienda + '</div>';
  if (!gastos.length) html += '<div style="font-size:12px;color:var(--muted)">Sin gastos registrados en este rango. Usá el botón “＋ Registrar gasto” de arriba para cargar sueldos, alquiler y otros gastos.</div>';
  else html += '<table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr style="color:var(--muted)"><th style="text-align:left;padding:4px">Fecha</th><th style="text-align:left">Categoría</th><th style="text-align:left">Detalle</th><th style="text-align:right">Monto</th><th></th></tr></thead><tbody>' +
    gastos.slice(0, 50).map(g => '<tr style="border-top:1px solid #f1f5f9"><td style="padding:4px">' + (g.fecha||'') + '</td><td>' + String(g.categorias_gasto?.nombre||'—').replace(/[<>&]/g,'') + (g.es_recurrente ? ' <span style="font-size:9px;font-weight:800;background:rgba(124,58,237,.1);color:#7c3aed;padding:1px 6px;border-radius:50px">FIJO</span>' : '') + '</td><td>' + String(g.descripcion||g.proveedor||'').replace(/[<>&]/g,'') + '</td><td style="text-align:right;font-weight:600;color:#dc2626">' + fmtARS(g.monto) + '</td><td style="text-align:right"><button class="fin-del-gasto" data-id="' + g.id + '" title="Eliminar gasto" style="background:none;border:none;color:#cbd5e1;font-size:15px;cursor:pointer;padding:0 4px">🗑</button></td></tr>').join('') +
    '<tr style="border-top:2px solid var(--border)"><td colspan="3" style="padding:6px;font-weight:700">Total gastos</td><td style="text-align:right;font-weight:800;padding:6px">' + fmtARS(totGastos) + '</td><td></td></tr>' +
    '</tbody></table>';
  html += '</div>';

  // Comisiones / incentivos de cajeros (sobre lo vendido en el período).
  if (porCajeroFin.length) {
    const escN = s => String(s ?? '—').replace(/[<>&"]/g, '');
    const getCfg = cid => { try { return JSON.parse(localStorage.getItem('pos_com_' + orgId + '_' + cid) || '{}'); } catch (_) { return {}; } };
    html += '<div id="fin-comisiones" style="background:white;border:1px solid var(--border);border-radius:12px;padding:14px;margin-top:14px">' +
      '<div style="font-weight:700;margin-bottom:4px;display:flex;align-items:center">🧑‍💼 Comisiones / incentivos de cajeros' + iHelp(INFO.fin_comisiones) + '</div>' +
      '<div style="font-size:11px;color:var(--muted);margin-bottom:10px">Comisión = ventas del cajero × % + bono fijo. Ajustá el % y el bono (se guardan para la próxima). Con “Registrar” se cargan como gasto del período (categoría Comisiones).</div>' +
      '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">' +
      '<thead><tr style="color:var(--muted);text-align:right"><th style="text-align:left;padding:4px">Cajero</th><th style="padding:4px">Ventas</th><th style="padding:4px">% comisión</th><th style="padding:4px">Bono fijo</th><th style="padding:4px">A pagar</th></tr></thead><tbody>' +
      porCajeroFin.map(c => {
        const cfg = getCfg(c.cajero_id);
        const pct = (cfg.pct != null) ? cfg.pct : '';
        const bono = (cfg.bono != null) ? cfg.bono : '';
        const monto = Number(c.monto) || 0;
        const tot = monto * (Number(pct) || 0) / 100 + (Number(bono) || 0);
        return '<tr data-cid="' + c.cajero_id + '" data-monto="' + monto + '" data-nombre="' + escN(c.cajero_nombre) + '" style="border-top:1px solid #f1f5f9;text-align:right">' +
          '<td style="text-align:left;padding:5px 4px;font-weight:600">' + escN(c.cajero_nombre) + '</td>' +
          '<td style="padding:5px 4px">' + fmtARS(monto) + '</td>' +
          '<td style="padding:5px 4px"><input type="number" min="0" step="0.1" class="com-pct" value="' + pct + '" placeholder="0" style="width:68px;text-align:right;padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:13px"></td>' +
          '<td style="padding:5px 4px"><input type="number" min="0" step="0.01" class="com-bono" value="' + bono + '" placeholder="0" style="width:92px;text-align:right;padding:4px 6px;border:1px solid var(--border);border-radius:6px;font-size:13px"></td>' +
          '<td class="com-tot" style="padding:5px 4px;font-weight:700;color:#dc2626">' + fmtARS(tot) + '</td>' +
        '</tr>';
      }).join('') +
      '<tr style="border-top:2px solid var(--border);text-align:right;font-weight:800"><td style="text-align:left;padding:6px 4px">Total comisiones</td><td></td><td></td><td></td><td id="com-grand" style="padding:6px 4px;color:#dc2626">' + fmtARS(0) + '</td></tr>' +
      '</tbody></table></div>' +
      '<button id="com-registrar" style="margin-top:12px;padding:9px 16px;border:none;background:var(--primary);color:#fff;border-radius:8px;cursor:pointer;font-weight:700;font-size:13px">Registrar comisiones como gasto</button>' +
    '</div>';
  }

  html += '<div style="font-size:11px;color:var(--muted);margin-top:12px;line-height:1.5">El costo de mercadería y el margen se calculan con el costo actual cargado en cada producto. El resultado neto es una estimación de gestión (no reemplaza la contabilidad formal).</div>';

  cont.innerHTML = html;

  _wireComisiones(desde, hasta);

  cont.querySelectorAll('.fin-del-gasto').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      if (!id) return;
      const ok = await tmvDialog.confirm('¿Eliminar este gasto del registro?', { title: 'Eliminar gasto', severity: 'danger', okLabel: 'Eliminar' });
      if (!ok) return;
      const { data, error } = await sb.rpc('pos_eliminar_gasto', { p_gasto_id: id });
      if (error || !data?.ok) { toast('No se pudo eliminar', 'err'); return; }
      toast('Gasto eliminado', 'ok');
      _cargarFinanzas();
    });
  });
}

// Registra un gasto (incluye gastos fijos como sueldos o alquiler) — #7.
async function _guardarGasto() {
  const monto = parseFloat(document.getElementById('fg-monto').value) || 0;
  const cat   = document.getElementById('fg-cat').value.trim();
  const desc  = document.getElementById('fg-desc').value.trim();
  const fecha = document.getElementById('fg-fecha').value || null;
  const fijo  = document.getElementById('fg-tipo').value === 'fijo';
  const msg   = document.getElementById('fg-msg');
  if (monto <= 0) { msg.style.color = 'var(--danger)'; msg.textContent = 'Ingresá un monto válido.'; return; }
  const btn = document.getElementById('fg-save');
  btn.disabled = true; btn.textContent = 'Guardando…';
  const { data, error } = await sb.rpc('pos_registrar_gasto', {
    p_organization_id: orgId, p_monto: monto,
    p_descripcion: desc || null, p_categoria_nombre: cat || null,
    p_fecha: fecha, p_es_recurrente: fijo, p_recurrencia: fijo ? 'mensual' : null,
  });
  btn.disabled = false; btn.textContent = 'Guardar gasto';
  if (error || !data?.ok) { msg.style.color = 'var(--danger)'; msg.textContent = 'Error: ' + (error?.message || 'no se pudo registrar'); return; }
  toast('✓ Gasto registrado', 'ok');
  document.getElementById('fg-monto').value = '';
  document.getElementById('fg-desc').value = '';
  document.getElementById('fg-cat').value = '';
  document.getElementById('fg-tipo').value = 'variable';
  document.getElementById('fin-gasto-form').style.display = 'none';
  _cargarFinanzas();
}

// Comisiones/incentivos de cajeros: recálculo en vivo + guardado del % y bono.
function _wireComisiones(desde, hasta){
  const box = document.getElementById('fin-comisiones');
  if (!box) return;
  const recalc = () => {
    let grand = 0;
    box.querySelectorAll('tr[data-cid]').forEach(tr => {
      const monto = Number(tr.dataset.monto) || 0;
      const pct  = Number(tr.querySelector('.com-pct').value) || 0;
      const bono = Number(tr.querySelector('.com-bono').value) || 0;
      const tot = monto * pct / 100 + bono;
      tr.querySelector('.com-tot').textContent = fmtARS(tot);
      grand += tot;
    });
    const g = document.getElementById('com-grand'); if (g) g.textContent = fmtARS(grand);
  };
  box.querySelectorAll('.com-pct, .com-bono').forEach(inp => {
    inp.addEventListener('input', () => {
      const tr = inp.closest('tr[data-cid]');
      const pct = tr.querySelector('.com-pct').value;
      const bono = tr.querySelector('.com-bono').value;
      try {
        localStorage.setItem('pos_com_' + orgId + '_' + tr.dataset.cid,
          JSON.stringify({ pct: pct === '' ? null : Number(pct), bono: bono === '' ? null : Number(bono) }));
      } catch (_) {}
      recalc();
    });
  });
  recalc();
  document.getElementById('com-registrar')?.addEventListener('click', () => _registrarComisiones(desde, hasta));
}

async function _registrarComisiones(desde, hasta){
  const box = document.getElementById('fin-comisiones');
  if (!box) return;
  const items = [];
  box.querySelectorAll('tr[data-cid]').forEach(tr => {
    const monto = Number(tr.dataset.monto) || 0;
    const pct  = Number(tr.querySelector('.com-pct').value) || 0;
    const bono = Number(tr.querySelector('.com-bono').value) || 0;
    const tot = monto * pct / 100 + bono;
    if (tot > 0) items.push({ nombre: tr.dataset.nombre || 'Cajero', tot, pct, bono });
  });
  if (!items.length) { toast('Cargá un % o un bono para registrar comisiones', 'warn'); return; }
  const total = items.reduce((s, i) => s + i.tot, 0);
  const ok = await tmvDialog.confirm(
    'Se registrarán ' + items.length + ' comisión(es) por un total de ' + fmtARS(total) +
    ' como gasto (categoría Comisiones), con fecha ' + hasta + '. ¿Confirmás?',
    { title: 'Registrar comisiones', severity: 'question', okLabel: 'Registrar' });
  if (!ok) return;
  let okc = 0;
  for (const it of items) {
    const { data, error } = await sb.rpc('pos_registrar_gasto', {
      p_organization_id: orgId, p_monto: Math.round(it.tot * 100) / 100,
      p_descripcion: 'Comisión ' + it.nombre + ' (' + desde + ' a ' + hasta + ' · ' + it.pct + '%' + (it.bono ? ' + bono ' + fmtARS(it.bono) : '') + ')',
      p_categoria_nombre: 'Comisiones', p_fecha: hasta, p_es_recurrente: false, p_recurrencia: null,
    });
    if (!error && data?.ok) okc++;
  }
  toast('✓ ' + okc + ' comisión(es) registrada(s) como gasto', 'ok');
  _cargarFinanzas();
}

// ════════════════════════════════════════════════════════════════════
//  CONFIGURACIÓN — hub de admin: Usuarios, Tiendas, Ticket, Promos,
//  Cuotas y MercadoPago, todo en un solo apartado con sub-navegación.
// ════════════════════════════════════════════════════════════════════
let _cfgWired = false;
function renderConfig() {
  if (!_isAdmin()) return;
  const subnav = document.getElementById('cfg-subnav');
  if (subnav && !_cfgWired) {
    _cfgWired = true;
    subnav.querySelectorAll('button[data-cfg]').forEach(b => {
      b.addEventListener('click', () => _cfgShow(b.dataset.cfg));
    });
  }
  // Mostrar el panel activo actual (Negocio por defecto la primera vez).
  const activo = subnav?.querySelector('button.active')?.dataset.cfg || 'negocio';
  _cfgShow(activo);
}

// Muestra un panel de configuración y dispara su render correspondiente.
function _cfgShow(key) {
  document.querySelectorAll('#cfg-subnav button[data-cfg]').forEach(b => {
    b.classList.toggle('active', b.dataset.cfg === key);
  });
  document.querySelectorAll('#screen-config .cfg-panel').forEach(p => {
    p.style.display = p.dataset.panel === key ? '' : 'none';
  });
  if (key === 'negocio')  renderNegocio();
  else if (key === 'usuarios') renderUsuarios();
  else if (key === 'tiendas') renderTiendas();
  else if (key === 'ticket')  renderReciboConfig();
  else if (key === 'promos')  renderPromosConfig();
  else if (key === 'cuotas')  renderCuotasConfig();
  else if (key === 'pagos')   renderConfigMP();
  else if (key === 'recibidas') renderFacturasRecibidas();
  else if (key === 'catalogo') renderCatalogoCompartido();
}

// Catálogo compartido: opt-in público entre quienes comparten (aportás → accedés).
async function renderCatalogoCompartido(){
  const wrap = document.getElementById('catalogo-wrap');
  if (!wrap) return;
  if (!_isAdmin()) { wrap.innerHTML = '<div class="env-empty" style="background:#fff;border:1px solid var(--border);border-radius:14px">Solo administradores.</div>'; return; }
  wrap.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';
  let cfg = {};
  try {
    const { data, error } = await sb.rpc('pos_catalogo_config_get', { p_organization_id: orgId });
    if (error) throw error;
    cfg = data || {};
  } catch (e) { wrap.innerHTML = '<div style="color:var(--danger);padding:20px">Error: ' + (e.message || e) + '</div>'; return; }

  wrap.innerHTML =
    '<div class="recibo-card">' +
    '  <div style="font-size:18px;font-weight:800;margin-bottom:6px">🗂 Catálogo compartido</div>' +
    '  <div style="font-size:12.5px;color:var(--muted);margin-bottom:14px;line-height:1.55">Es un catálogo <b>público entre los negocios que optan por compartir</b>: si activás esto, tus productos (nombre, categoría y unidad, por su <b>código de barras</b>) se suman al pool y, a cambio, cuando cargás un producto podés autocompletar los datos de cualquier código que ya esté en el pool — vos solo ponés tu costo y tu precio. <b>Nunca se comparten costos ni precios.</b></div>' +
    '  <label class="recibo-toggle" style="margin-bottom:12px"><span>Compartir mi catálogo (aportar y acceder)</span><input id="cat-share" type="checkbox"' + (cfg.compartir ? ' checked' : '') + '></label>' +
    '  <div style="display:flex;gap:10px;flex-wrap:wrap">' +
    '    <div style="flex:1;min-width:140px;background:#f8f9ff;border:1px solid var(--border);border-radius:10px;padding:12px 14px"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Aportados por vos</div><div style="font-size:22px;font-weight:800">' + (cfg.aportados || 0) + '</div></div>' +
    '    <div style="flex:1;min-width:140px;background:#f8f9ff;border:1px solid var(--border);border-radius:10px;padding:12px 14px"><div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em">Total en el pool</div><div style="font-size:22px;font-weight:800">' + (cfg.pool_total || 0) + '</div></div>' +
    '  </div>' +
    '  <div id="cat-msg" style="font-size:12.5px;margin-top:12px;line-height:1.5"></div>' +
    '</div>';

  document.getElementById('cat-share').addEventListener('change', async (e) => {
    const msg = document.getElementById('cat-msg');
    const on = e.target.checked;
    e.target.disabled = true;
    const { data, error } = await sb.rpc('pos_catalogo_config_set', { p_organization_id: orgId, p_compartir: on });
    e.target.disabled = false;
    if (error || !data?.ok) { msg.style.color = 'var(--danger)'; msg.textContent = 'No se pudo guardar.'; e.target.checked = !on; return; }
    if (on) { toast('Catálogo compartido activado ✓', 'ok'); msg.style.color = '#059669'; msg.textContent = '✓ Compartiendo. Se publicaron ' + (data.publicados || 0) + ' productos con código de barras.'; }
    else { toast('Dejaste de compartir', 'ok'); msg.style.color = 'var(--muted)'; msg.textContent = 'Ya no compartís tu catálogo (y no podés autocompletar del pool).'; }
    renderCatalogoCompartido();
  });
}

// Archivo de facturas/remitos recibidos (compras). Foto o PDF + datos.
// Convierte imágenes a JPEG comprimido (data URL) para no usar Storage; los PDF
// se guardan tal cual con tope de tamaño.
function _fileToArchivoDataURL(file){
  return new Promise((resolve, reject) => {
    const esImg = file.type.startsWith('image/');
    const esPdf = file.type === 'application/pdf';
    if (!esImg && !esPdf) { reject(new Error('Subí una imagen (foto) o un PDF')); return; }
    if (esPdf && file.size > 4 * 1024 * 1024) { reject(new Error('El PDF es muy grande (máx 4 MB). Sacá una foto en su lugar.')); return; }
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('No se pudo leer el archivo'));
    fr.onload = () => {
      if (esPdf) { resolve({ url: fr.result, tipo: 'pdf' }); return; }
      const img = new Image();
      img.onerror = () => reject(new Error('Imagen inválida'));
      img.onload = () => {
        const maxW = 1400;
        const scale = Math.min(1, maxW / (img.width || maxW));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve({ url: cv.toDataURL('image/jpeg', 0.72), tipo: 'image' });
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

let _frecArchivo = null;   // {url, tipo, nombre} pendiente de guardar
async function renderFacturasRecibidas(){
  const wrap = document.getElementById('recibidas-wrap');
  if (!wrap) return;
  if (!_isAdmin()) { wrap.innerHTML = '<div class="env-empty" style="background:#fff;border:1px solid var(--border);border-radius:14px">Solo administradores.</div>'; return; }
  wrap.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';
  let lista = [];
  try {
    const { data, error } = await sb.rpc('pos_frec_listar', { p_organization_id: orgId, p_desde: null, p_hasta: null });
    if (error) throw error;
    lista = data || [];
  } catch (e) { wrap.innerHTML = '<div style="color:var(--danger);padding:20px">Error: ' + (e.message || e) + '</div>'; return; }
  const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

  let html = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:10px;flex-wrap:wrap">' +
    '<h3 style="font-size:14px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:0">📥 Facturas / remitos recibidos</h3>' +
    '<button id="frec-add" type="button" style="padding:9px 16px;border-radius:50px;border:1.5px solid var(--primary);background:rgba(124,58,237,.06);color:var(--primary);font-family:inherit;font-size:12px;font-weight:700;cursor:pointer">＋ Cargar factura/remito</button>' +
    '</div>' +
    '<div style="font-size:12px;color:var(--ink);background:rgba(124,58,237,.06);border-radius:8px;padding:8px 10px;margin-bottom:12px">ℹ️ Guardá acá las facturas y remitos de tus <b>compras</b> (foto o PDF), con proveedor, número, fecha y monto. Quedan archivados para consulta. (Próximamente: leer la foto y autocargar el stock.)</div>';

  if (!lista.length) {
    html += '<div class="env-empty" style="background:#fff;border:1px solid var(--border);border-radius:14px">Todavía no cargaste facturas recibidas.</div>';
  } else {
    html += '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:13px">' +
      '<thead><tr style="color:var(--muted);text-align:left;border-bottom:1px solid var(--border)">' +
      '<th style="padding:6px 8px">Fecha</th><th>Tipo</th><th>Proveedor</th><th>Número</th>' +
      '<th style="text-align:right">Monto</th><th></th></tr></thead><tbody>' +
      lista.map(f => '<tr style="border-bottom:1px solid #f1f5f9">' +
        '<td style="padding:6px 8px;white-space:nowrap">' + (f.fecha || '—') + '</td>' +
        '<td>' + (f.tipo_doc === 'remito' ? '📦 Remito' : '🧾 Factura') + '</td>' +
        '<td>' + esc(f.proveedor || '—') + '</td>' +
        '<td>' + esc(f.numero || '—') + '</td>' +
        '<td style="text-align:right;font-weight:600">' + (f.monto != null ? fmtARS(f.monto) : '—') + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
          (f.tiene_archivo ? '<button class="frec-ver" data-id="' + f.id + '" title="Ver archivo" style="background:none;border:1px solid var(--border);border-radius:6px;padding:3px 8px;cursor:pointer;font-size:12px">👁</button> ' : '') +
          '<button class="frec-del" data-id="' + f.id + '" title="Eliminar" style="background:none;border:none;color:#cbd5e1;font-size:15px;cursor:pointer">🗑</button>' +
        '</td></tr>').join('') +
      '</tbody></table></div>';
  }
  wrap.innerHTML = html;

  document.getElementById('frec-add')?.addEventListener('click', _abrirCargaFacturaRecibida);
  wrap.querySelectorAll('.frec-ver').forEach(b => b.addEventListener('click', () => _verFacturaRecibida(b.dataset.id)));
  wrap.querySelectorAll('.frec-del').forEach(b => b.addEventListener('click', async () => {
    const ok = await tmvDialog.confirm('¿Eliminar esta factura recibida del archivo?', { title: 'Eliminar', severity: 'danger', okLabel: 'Eliminar' });
    if (!ok) return;
    const { data, error } = await sb.rpc('pos_frec_borrar', { p_id: b.dataset.id });
    if (error || !data?.ok) { toast('No se pudo eliminar', 'err'); return; }
    toast('Eliminada', 'ok'); renderFacturasRecibidas();
  }));
}

async function _verFacturaRecibida(id){
  toast('Abriendo…', 'info');
  const { data, error } = await sb.rpc('pos_frec_get', { p_id: id });
  if (error || !data?.archivo) { toast('No se pudo abrir el archivo', 'err'); return; }
  const ov = document.createElement('div');
  ov.className = 'qr-overlay show';
  ov.style.cssText = 'background:rgba(0,0,0,.75);z-index:260';
  const body = data.archivo_tipo === 'pdf'
    ? '<iframe src="' + data.archivo + '" style="width:min(900px,94vw);height:82vh;border:0;border-radius:10px;background:#fff"></iframe>'
    : '<img src="' + data.archivo + '" style="max-width:94vw;max-height:82vh;border-radius:10px;background:#fff">';
  ov.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;gap:10px">' + body +
    '<div style="display:flex;gap:8px"><a href="' + data.archivo + '" download="' + (data.archivo_nombre || ('factura.' + (data.archivo_tipo === 'pdf' ? 'pdf' : 'jpg'))) + '" style="padding:8px 16px;background:#fff;border-radius:8px;color:#111;font-weight:700;font-size:13px;text-decoration:none">⬇ Descargar</a>' +
    '<button id="frec-close" style="padding:8px 16px;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer">Cerrar</button></div></div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#frec-close').addEventListener('click', close);
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
}

function _abrirCargaFacturaRecibida(){
  _frecArchivo = null;
  const hoy = new Date().toISOString().slice(0, 10);
  const tiendasOpts = (tiendas || []).map(t => '<option value="' + t.id + '">' + (t.es_principal ? '★ ' : '') + t.nombre.replace(/[<>&"]/g, '') + '</option>').join('');
  const ov = document.createElement('div');
  ov.className = 'qr-overlay show';
  ov.style.cssText = 'background:rgba(0,0,0,.5);z-index:250';
  ov.innerHTML =
    '<div class="qr-modal" style="max-width:480px">' +
    '<div class="qr-modal-h"><div class="qr-modal-title">＋ Cargar factura / remito</div><button class="qr-modal-close" id="frx-x" type="button">×</button></div>' +
    '<div class="qr-modal-body" style="align-items:stretch;text-align:left">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
        '<div><label class="prod-form-l">Tipo</label><select id="frx-tipo" class="prod-form-i"><option value="factura">🧾 Factura</option><option value="remito">📦 Remito</option></select></div>' +
        '<div><label class="prod-form-l">Fecha</label><input type="date" id="frx-fecha" class="prod-form-i" value="' + hoy + '"></div>' +
      '</div>' +
      '<label class="prod-form-l" style="margin-top:8px">Proveedor</label><input id="frx-prov" class="prod-form-i" placeholder="Ej: Distribuidora XX">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:8px">' +
        '<div><label class="prod-form-l">Número</label><input id="frx-num" class="prod-form-i" placeholder="0001-00001234"></div>' +
        '<div><label class="prod-form-l">Monto</label><input id="frx-monto" type="number" min="0" step="0.01" class="prod-form-i" placeholder="0"></div>' +
      '</div>' +
      (tiendasOpts ? '<label class="prod-form-l" style="margin-top:8px">Tienda (opcional)</label><select id="frx-tienda" class="prod-form-i"><option value="">—</option>' + tiendasOpts + '</select>' : '') +
      '<label class="prod-form-l" style="margin-top:8px">Notas (opcional)</label><input id="frx-notas" class="prod-form-i" placeholder="Ej: pagada en efectivo">' +
      '<label class="prod-form-l" style="margin-top:10px">Foto o PDF de la factura/remito</label>' +
      '<input id="frx-file" type="file" accept="image/*,application/pdf" capture="environment" class="prod-form-i" style="padding:8px">' +
      '<div id="frx-file-info" style="font-size:12px;color:var(--muted);margin-top:4px"></div>' +
      '<div id="frx-msg" style="font-size:12px;margin-top:8px"></div>' +
    '</div>' +
    '<div class="qr-modal-foot"><button id="frx-save" class="qr-foot-btn">Guardar</button></div>' +
    '</div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#frx-x').addEventListener('click', close);
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });

  const info = ov.querySelector('#frx-file-info');
  ov.querySelector('#frx-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    _frecArchivo = null;
    if (!file) { info.textContent = ''; return; }
    info.textContent = 'Procesando…';
    try {
      const r = await _fileToArchivoDataURL(file);
      _frecArchivo = { url: r.url, tipo: r.tipo, nombre: file.name };
      const kb = Math.round((r.url.length * 0.75) / 1024);
      info.innerHTML = '✓ ' + (r.tipo === 'pdf' ? 'PDF' : 'Imagen') + ' lista (' + kb + ' KB)';
      info.style.color = '#059669';
    } catch (err) { info.textContent = err.message; info.style.color = 'var(--danger)'; }
  });

  ov.querySelector('#frx-save').addEventListener('click', async () => {
    const msg = ov.querySelector('#frx-msg');
    const monto = parseFloat(ov.querySelector('#frx-monto').value);
    const btn = ov.querySelector('#frx-save');
    btn.disabled = true; btn.textContent = 'Guardando…';
    const { data, error } = await sb.rpc('pos_frec_crear', {
      p_organization_id: orgId,
      p_proveedor: ov.querySelector('#frx-prov').value.trim() || null,
      p_numero: ov.querySelector('#frx-num').value.trim() || null,
      p_fecha: ov.querySelector('#frx-fecha').value || null,
      p_monto: isNaN(monto) ? null : monto,
      p_tipo_doc: ov.querySelector('#frx-tipo').value,
      p_notas: ov.querySelector('#frx-notas').value.trim() || null,
      p_archivo: _frecArchivo?.url || null,
      p_archivo_tipo: _frecArchivo?.tipo || null,
      p_archivo_nombre: _frecArchivo?.nombre || null,
      p_tienda_id: ov.querySelector('#frx-tienda')?.value || null,
    });
    btn.disabled = false; btn.textContent = 'Guardar';
    if (error || !data?.ok) { msg.style.color = 'var(--danger)'; msg.textContent = 'Error: ' + (error?.message || 'no se pudo guardar'); return; }
    toast('✓ Factura recibida guardada', 'ok');
    close();
    renderFacturasRecibidas();
  });
}

// ── Datos del negocio (nombre de la org + datos fiscales del ticket) ──
async function renderNegocio() {
  const wrap = document.getElementById('negocio-wrap');
  if (!wrap) return;
  if (!_isAdmin()) { wrap.innerHTML = '<div class="env-empty" style="background:#fff;border:1px solid var(--border);border-radius:14px">Solo administradores.</div>'; return; }
  // Refrescar datos fiscales por si cambiaron en otra pantalla.
  await cargarOrgFiscal().catch(() => {});
  const esc = s => String(s ?? '').replace(/"/g, '&quot;');

  wrap.innerHTML =
    '<div class="recibo-card">' +
    '  <div style="font-size:18px;font-weight:800;margin-bottom:6px">🏷 Datos del negocio</div>' +
    '  <div style="font-size:12.5px;color:var(--muted);margin-bottom:16px">El nombre es el que se ve arriba en el POS y en el encabezado del ticket. Los datos fiscales aparecen en el ticket según lo que actives en la sección Ticket.</div>' +
    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">Nombre del negocio *</div>' +
    '    <input id="ng-nombre" class="prod-form-i" style="width:100%" maxlength="80" placeholder="Ej: Almacén Don José" value="' + esc(orgName || '') + '">' +
    '  </div>' +
    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">CUIT / identificación fiscal (opcional)</div>' +
    '    <input id="ng-cuit" class="prod-form-i" style="width:100%" maxlength="40" placeholder="Ej: 20-12345678-9" value="' + esc(orgFiscal.cuit || '') + '">' +
    '  </div>' +
    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">Dirección (opcional)</div>' +
    '    <input id="ng-dir" class="prod-form-i" style="width:100%" maxlength="120" placeholder="Ej: San Martín 1234, San Juan" value="' + esc(orgFiscal.direccion || '') + '">' +
    '  </div>' +
    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">Teléfono (opcional)</div>' +
    '    <input id="ng-tel" class="prod-form-i" style="width:100%" maxlength="40" placeholder="Ej: 264 762 1505" value="' + esc(orgFiscal.telefono || '') + '">' +
    '  </div>' +
    '  <button id="ng-save" type="button" style="width:100%;padding:14px;border-radius:50px;border:none;background:var(--primary);color:#fff;font-weight:700;font-size:14px;cursor:pointer">Guardar</button>' +
    '</div>';

  document.getElementById('ng-save').addEventListener('click', async (e) => {
    const nombre = document.getElementById('ng-nombre').value.trim();
    if (!nombre) { toast('El nombre no puede quedar vacío', 'warn'); return; }
    e.target.disabled = true; e.target.textContent = 'Guardando…';
    try {
      const { data, error } = await sb.rpc('pos_negocio_set', {
        p_organization_id: orgId,
        p_nombre:    nombre,
        p_cuit:      document.getElementById('ng-cuit').value.trim() || null,
        p_direccion: document.getElementById('ng-dir').value.trim() || null,
        p_telefono:  document.getElementById('ng-tel').value.trim() || null,
      });
      if (error) throw error;
      if (!data?.ok) throw new Error('No se guardó');
      // Reflejar en memoria + UI al instante.
      orgName = nombre;
      const el = document.getElementById('t-org');
      if (el) { if (el.querySelector('select')) {/* super admin selector: no tocar */} else el.textContent = nombre; }
      orgFiscal.cuit      = document.getElementById('ng-cuit').value.trim() || null;
      orgFiscal.direccion = document.getElementById('ng-dir').value.trim() || null;
      orgFiscal.telefono  = document.getElementById('ng-tel').value.trim() || null;
      toast('Datos del negocio guardados ✓', 'ok');
    } catch (err) {
      tmvShowError(err, { title: 'No se pudo guardar' });
    } finally {
      e.target.disabled = false; e.target.textContent = 'Guardar';
    }
  });
}

// ── MercadoPago (sub-sección de Configuración) ──
async function renderConfigMP() {
  const wrap = document.getElementById('mp-config-wrap');
  if (!wrap) return;
  if (!_isAdmin()) { wrap.innerHTML = '<div class="env-empty" style="background:#fff;border:1px solid var(--border);border-radius:14px">Solo administradores.</div>'; return; }
  wrap.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';

  let cfg = {};
  try {
    const { data, error } = await sb.rpc('pos_mp_credentials_get', { p_organization_id: orgId });
    if (error) throw error;
    cfg = data || {};
  } catch (e) { wrap.innerHTML = '<div style="color:var(--danger);padding:20px">Error: ' + e.message + '</div>'; return; }

  const esc = s => String(s ?? '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const estado = cfg.configurado
    ? (cfg.verificado
        ? '<span style="color:#059669;font-weight:700">✓ Verificado</span>' + (cfg.nombre_cuenta ? ' · ' + esc(cfg.nombre_cuenta) : '')
        : '<span style="color:#b45309;font-weight:700">⚠ Configurado, sin verificar</span>')
    : '<span style="color:var(--danger);font-weight:700">Sin configurar</span>';

  wrap.innerHTML =
    '<div class="recibo-card">' +
    '  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
    '    <div style="font-size:18px;font-weight:800">💳 Cobros con MercadoPago</div>' +
    '    <span style="font-size:12px">' + estado + '</span>' +
    '  </div>' +
    '  <div style="font-size:12.5px;color:var(--muted);margin-bottom:16px;line-height:1.5">Ingresá las credenciales de tu cuenta de MercadoPago para generar los <b>QR de cobro</b> en el POS. Conseguilas en <b>mercadopago → Tu negocio → Configuración → Gestión y administración → Credenciales de producción</b>.</div>' +

    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">Access Token (producción)</div>' +
    '    <input id="mp-token" type="password" class="prod-form-i" style="width:100%;font-family:monospace" autocomplete="off" placeholder="' + (cfg.token_preview ? esc(cfg.token_preview) + ' (dejá vacío para mantener)' : 'APP_USR-...') + '">' +
    '    <div style="font-size:11px;color:var(--muted);margin-top:6px">Empieza con <code>APP_USR-</code>. No lo compartas: se guarda cifrado en el servidor y nunca se muestra de nuevo.</div>' +
    '  </div>' +

    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">Public Key (opcional)</div>' +
    '    <input id="mp-pubkey" type="text" class="prod-form-i" style="width:100%;font-family:monospace" autocomplete="off" placeholder="APP_USR-... (opcional)" value="' + esc(cfg.public_key || '') + '">' +
    '  </div>' +

    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">Client ID (App ID)</div>' +
    '    <input id="mp-appid" type="text" class="prod-form-i" style="width:100%;font-family:monospace" autocomplete="off" placeholder="Ej: 1234567890123456" value="' + esc(cfg.app_id || '') + '">' +
    '    <div style="font-size:11px;color:var(--muted);margin-top:6px">Número de tu aplicación de MercadoPago (Tus integraciones → tu app → Credenciales).</div>' +
    '  </div>' +

    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">Client Secret</div>' +
    '    <input id="mp-secret" type="password" class="prod-form-i" style="width:100%;font-family:monospace" autocomplete="off" placeholder="' + (cfg.tiene_client_secret ? '•••• (dejá vacío para mantener)' : 'Client Secret de tu app') + '">' +
    '    <div style="font-size:11px;color:var(--muted);margin-top:6px">Se guarda cifrado en el servidor y no se muestra de nuevo. Va junto con el Client ID.</div>' +
    '  </div>' +

    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">User ID (número de tu cuenta MP)</div>' +
    '    <input id="mp-userid" type="number" inputmode="numeric" class="prod-form-i" style="width:100%;font-family:monospace" autocomplete="off" placeholder="Ej: 123456789" value="' + esc(cfg.user_id_mp != null ? cfg.user_id_mp : '') + '">' +
    '    <div style="font-size:11px;color:var(--muted);margin-top:6px">Es el ID de usuario (collector) de tu cuenta de MercadoPago. Necesario para el QR fijo en caja.</div>' +
    '  </div>' +

    '  <div class="recibo-section">' +
    '    <div class="recibo-section-h">Nombre del POS (caja) para el QR</div>' +
    '    <input id="mp-posname" type="text" class="prod-form-i" style="width:100%" autocomplete="off" placeholder="POS01" value="' + esc(cfg.pos_name || 'POS01') + '">' +
    '    <div style="font-size:11px;color:var(--muted);margin-top:6px">Para el QR fijo "en caja" creá un punto de venta <b>Dinámico</b> en MP (Tu negocio → Puntos de venta) con este mismo nombre. Si no, el sistema genera igual un link/QR de pago automáticamente.</div>' +
    '  </div>' +

    '  <div class="recibo-section">' +
    '    <label class="recibo-toggle"><span>Modo prueba (sandbox)</span><input id="mp-sandbox" type="checkbox"' + (cfg.sandbox_mode ? ' checked' : '') + '></label>' +
    '    <div id="mp-sandbox-wrap" style="display:' + (cfg.sandbox_mode ? '' : 'none') + '">' +
    '      <div style="font-size:11px;color:var(--muted);margin:4px 0 6px">Access Token de prueba (TEST-...). Solo para testear sin cobrar de verdad.</div>' +
    '      <input id="mp-sandbox-token" type="password" class="prod-form-i" style="width:100%;font-family:monospace" autocomplete="off" placeholder="' + (cfg.tiene_sandbox_token ? '•••• (dejá vacío para mantener)' : 'TEST-...') + '">' +
    '    </div>' +
    '  </div>' +

    '  <div class="recibo-section">' +
    '    <label class="recibo-toggle"><span>Cobros con MP habilitados</span><input id="mp-activo" type="checkbox"' + (cfg.activo !== false ? ' checked' : '') + '></label>' +
    '  </div>' +

    '  <div style="display:flex;gap:8px;flex-wrap:wrap">' +
    '    <button id="mp-save" type="button" style="flex:1;min-width:160px;padding:14px;border-radius:50px;border:none;background:var(--primary);color:#fff;font-weight:700;font-size:14px;cursor:pointer">Guardar</button>' +
    '    <button id="mp-verify" type="button" style="flex:1;min-width:160px;padding:14px;border-radius:50px;border:1.5px solid #009ee3;background:rgba(0,158,227,.08);color:#009ee3;font-weight:700;font-size:14px;cursor:pointer">Verificar conexión</button>' +
    '  </div>' +
    '  <div id="mp-result" style="font-size:12.5px;margin-top:12px;line-height:1.5"></div>' +
    '</div>';

  document.getElementById('mp-sandbox').addEventListener('change', (e) => {
    document.getElementById('mp-sandbox-wrap').style.display = e.target.checked ? '' : 'none';
  });

  document.getElementById('mp-save').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Guardando…';
    const res = document.getElementById('mp-result');
    try {
      const { data, error } = await sb.rpc('pos_mp_credentials_set', {
        p_organization_id:      orgId,
        p_access_token:         document.getElementById('mp-token').value.trim() || null,
        p_public_key:           document.getElementById('mp-pubkey').value.trim(),
        p_pos_name:             document.getElementById('mp-posname').value.trim() || null,
        p_sandbox_mode:         document.getElementById('mp-sandbox').checked,
        p_sandbox_access_token: document.getElementById('mp-sandbox-token').value.trim() || null,
        p_activo:               document.getElementById('mp-activo').checked,
        p_app_id:               document.getElementById('mp-appid').value.trim() || null,
        p_client_secret:        document.getElementById('mp-secret').value.trim() || null,
        p_user_id_mp:           (document.getElementById('mp-userid').value.trim() ? Number(document.getElementById('mp-userid').value.trim()) : null),
      });
      if (error) throw error;
      if (!data?.ok) throw new Error('No se guardó');
      toast('Configuración guardada ✓', 'ok');
      res.innerHTML = '<span style="color:#059669">✓ Guardado. Tocá "Verificar conexión" para confirmar que el token es válido.</span>';
      renderConfigMP();
    } catch (err) {
      tmvShowError(err, { title: 'No se pudo guardar' });
    } finally {
      e.target.disabled = false; e.target.textContent = 'Guardar';
    }
  });

  document.getElementById('mp-verify').addEventListener('click', async (e) => {
    e.target.disabled = true; e.target.textContent = 'Verificando…';
    const res = document.getElementById('mp-result');
    res.innerHTML = '<span style="color:var(--muted)">Consultando MercadoPago…</span>';
    try {
      const token = await _freshAccessToken();
      if (!token) { res.innerHTML = '<span style="color:var(--danger)">Sesión expirada, recargá la página.</span>'; return; }
      const r = await fetch(SB_URL + '/functions/v1/mp-verificar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'apikey': SB_KEY },
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || !out.ok) {
        res.innerHTML = '<span style="color:var(--danger)">❌ ' + (out.error || ('Error ' + r.status)) + '</span>';
        return;
      }
      const posLine = out.pos_ok
        ? '<div style="color:#059669">✓ ' + (out.pos_msg || 'POS configurado') + '</div>'
        : '<div style="color:#b45309">⚠ ' + (out.pos_msg || 'POS no encontrado (el QR igual funciona vía link de pago)') + '</div>';
      res.innerHTML = '<div style="color:#059669;font-weight:700">✓ Conexión OK · ' + (out.nombre || '') + (out.email ? ' (' + out.email + ')' : '') + '</div>' + posLine;
      toast('MercadoPago verificado ✓', 'ok');
      // Refrescar para mostrar el estado "verificado"
      setTimeout(renderConfigMP, 1200);
    } catch (err) {
      res.innerHTML = '<span style="color:var(--danger)">❌ ' + err.message + '</span>';
    } finally {
      e.target.disabled = false; e.target.textContent = 'Verificar conexión';
    }
  });
}
