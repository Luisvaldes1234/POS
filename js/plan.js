// ═══════════════════════════════════════════════════════════════════
// Plan y suscripción del POS (Configuración → Mi plan + banda superior).
//
// - Banda fija debajo de la barra superior mientras dura la prueba gratis
//   ("Te quedan X días gratis"), o si hay un problema de pago / plan vencido.
// - Mi plan: plan elegido / actual, estado, planes con su promo y el botón de
//   pago (mensual o anual) que abre Stripe Checkout vía pos-billing-checkout.
//   Mientras los planes no tengan stripe_price_id se muestran sin pago online
//   y durante la prueba se puede cambiar el plan elegido.
// - Al entrar, aplica los datos del registro (dirección y plan elegido) con
//   pos_registro_completar.
// ═══════════════════════════════════════════════════════════════════

let _planInfo = null;
let _planesCache = null;
let _planLimites = null;   // límites del plan Gratis (null = sin límites)

// ── Límites del plan (solo el plan Gratis tiene) ──
function planPermite(f) { return !_planLimites || _planLimites[f] !== false; }
function planLimite(k) { return _planLimites && _planLimites[k] != null ? _planLimites[k] : null; }
function planHistorialDesde() {
  const d = planLimite('historial_dias');
  return d ? _fechaNegocio(-(d - 1)) : null;
}
// true (y muestra el aviso) si ya se llegó al tope de `clave`.
function planBloquea(clave, actual) {
  const lim = planLimite(clave);
  if (lim == null || actual < lim) return false;
  const txt = { usuarios: 'El plan Gratis incluye ' + lim + ' usuarios.', tiendas: 'El plan Gratis incluye ' + lim + ' tienda.' }[clave] || 'Llegaste al límite del plan Gratis.';
  mostrarMejorarPlan(txt);
  return true;
}
const FUNCIONES_PAGAS = {
  promos:   'Las promos automáticas (2x1, NxM, % por volumen) están en los planes pagos.',
  reservas: 'Las reservas, prepagos y entregas parciales están en los planes pagos.',
  finanzas: 'El módulo de Finanzas (costos, márgenes y ganancia) está en los planes pagos.',
};
function mostrarMejorarPlan(texto) {
  const admin = typeof _isAdmin === 'function' && _isAdmin();
  const ov = _ccModal(
    '<div style="text-align:center;padding:6px 4px">' +
      '<div style="font-size:34px">🚀</div>' +
      '<h3 style="margin:8px 0 6px;font-size:18px">Pasate a un plan pago</h3>' +
      '<p style="color:var(--muted);font-size:14px;line-height:1.5;margin:0 0 16px">' + _esc(texto) + '</p>' +
      (admin ? '<button type="button" data-ver class="cc-btn cc-btn-pri" style="width:100%;padding:12px">Ver planes</button>'
             : '<div style="font-size:13px;color:var(--muted)">Pedile a un administrador que cambie el plan.</div>') +
      '<button type="button" data-x class="cc-btn" style="width:100%;margin-top:8px">Ahora no</button>' +
    '</div>', 360);
  ov.querySelector('[data-x]').addEventListener('click', () => ov.remove());
  ov.addEventListener('mousedown', e => { if (e.target === ov) ov.remove(); });
  ov.querySelector('[data-ver]')?.addEventListener('click', () => { ov.remove(); goTab('config'); _cfgShow('plan'); });
}
// Bloquea las funciones pagas en el plan Gratis (quedan visibles con 🔒).
function _envolverGratis(nombre, f) {
  const orig = window[nombre];
  if (typeof orig !== 'function' || orig.__gratis) return;
  const w = function (...a) { if (!planPermite(f)) { mostrarMejorarPlan(FUNCIONES_PAGAS[f]); return; } return orig.apply(this, a); };
  w.__gratis = true;
  window[nombre] = w;
}
function _aplicarLimitesPlan() {
  document.body.classList.toggle('plan-gratis', !!_planLimites);
  if (!_planLimites) return;
  _envolverGratis('aplicarPromoPOS', 'promos');
  _envolverGratis('crearReserva', 'reservas');
  _envolverGratis('abrirEntregaParcial', 'reservas');
  const goTabOrig = window.goTab;
  if (!goTabOrig.__gratis) {
    const w = (tab) => {
      const f = { reservas: 'reservas', finanzas: 'finanzas' }[tab];
      if (f && !planPermite(f)) { mostrarMejorarPlan(FUNCIONES_PAGAS[f]); return; }
      return goTabOrig(tab);
    };
    w.__gratis = true;
    window.goTab = w;
  }
  const cfgOrig = window._cfgShow;
  if (!cfgOrig.__gratis) {
    const w = (key) => {
      if (key === 'promos' && !planPermite('promos')) { mostrarMejorarPlan(FUNCIONES_PAGAS.promos); return; }
      return cfgOrig(key);
    };
    w.__gratis = true;
    window._cfgShow = w;
  }
  ['btn-reservar', 'btn-promo'].forEach(id => document.getElementById(id)?.classList.add('bloq-gratis'));
  document.querySelector('.topbar-tab[data-tab="reservas"]')?.classList.add('bloq-gratis');
  document.querySelector('.topbar-tab[data-tab="finanzas"]')?.classList.add('bloq-gratis');
  document.querySelector('#cfg-subnav [data-cfg="promos"]')?.classList.add('bloq-gratis');
  const btnPre = document.getElementById('btn-prepago');
  if (btnPre) btnPre.style.display = 'none';
}

const PLAN_ESTADOS = {
  trial:          { txt: 'Prueba gratis',   bg: '#E6F2F1', fg: '#0D5C56' },
  activa:         { txt: 'Activo',          bg: '#ECFDF3', fg: '#047857' },
  pago_pendiente: { txt: 'Pago pendiente',  bg: '#FFFAEB', fg: '#B45309' },
  cancelada:      { txt: 'Cancelado',       bg: '#FEF3F2', fg: '#B42318' },
  vencida:        { txt: 'Vencido',         bg: '#FEF3F2', fg: '#B42318' },
};

async function cargarPlanActual() {
  const { data, error } = await sb.rpc('pos_plan_actual', { p_organization_id: orgId });
  if (error) { console.warn('pos_plan_actual:', error.message); return null; }
  _planInfo = data;
  _planLimites = data?.limites || null;
  _aplicarLimitesPlan();
  _planPintarBanda();
  return data;
}

// Planes con los precios del país del negocio (pos_planes_precios).
async function _cargarPlanes(pais) {
  if (_planesCache && _planesCache.pais === pais) return _planesCache.lista;
  const [planesR, preciosR] = await Promise.all([
    sb.from('pos_planes').select('id, nombre, descripcion, promo_texto, features, orden').eq('activo', true).order('orden'),
    sb.from('pos_planes_precios')
      .select('plan_id, moneda, precio_mensual, precio_primer_mes, precio_promo, meses_promo, precio_anual, stripe_price_id, stripe_price_id_anual')
      .eq('pais', pais || 'AR'),
  ]);
  const precios = new Map((preciosR.data || []).map(r => [r.plan_id, r]));
  const lista = (planesR.data || []).filter(pl => precios.has(pl.id)).map(pl => ({ ...pl, ...precios.get(pl.id) }));
  _planesCache = { pais, lista };
  return lista;
}

// ── Banda superior ──
function _planPintarBanda() {
  const p = _planInfo;
  document.getElementById('plan-banda')?.remove();
  document.documentElement.style.setProperty('--banda', '0px');
  if (!p) return;
  let html = null, alerta = false;
  const elegido = p.plan_id ? ' · Plan elegido: <b>' + _esc(p.plan_nombre) + '</b>' : '';
  if (p.estado === 'trial' && p.dias_restantes != null) {
    const d = p.dias_restantes;
    html = '<span class="pb-txt">⏳ ' + (d === 0 ? '<b>Tu prueba gratis termina hoy</b>' : 'Te quedan <b>' + d + ' día' + (d === 1 ? '' : 's') + ' gratis</b>') +
      '<span class="pb-extra">' + elegido + '</span></span>';
  } else if (p.estado === 'pago_pendiente') {
    html = '<span class="pb-txt">⚠ No pudimos cobrar tu plan. Actualizá el medio de pago para no perder el acceso.</span>'; alerta = true;
  } else if (p.estado === 'vencida' || p.estado === 'cancelada') {
    html = '<span class="pb-txt">⚠ Tu plan venció. Elegí cómo pagar para seguir usando el POS.</span>'; alerta = true;
  }
  if (!html) return;
  const banda = document.createElement('div');
  banda.id = 'plan-banda';
  banda.className = 'plan-banda' + (alerta ? ' alerta' : '');
  banda.setAttribute('role', 'status');
  banda.innerHTML = html + (p.puede_gestionar ? '<button type="button">' + (p.estado === 'trial' ? 'Ver planes' : 'Resolver') + '</button>' : '');
  banda.querySelector('button')?.addEventListener('click', () => { goTab('config'); _cfgShow('plan'); });
  document.body.appendChild(banda);
  document.documentElement.style.setProperty('--banda', '36px');
}

// ── Configuración → Mi plan ──
async function renderPlanConfig() {
  const wrap = document.getElementById('plan-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';
  const p = await cargarPlanActual();
  const planes = p ? await _cargarPlanes(p.pais_precios) : [];
  if (!p) { wrap.innerHTML = '<div class="env-empty">No se pudo cargar tu plan.</div>'; return; }
  const est = PLAN_ESTADOS[p.estado] || PLAN_ESTADOS.activa;
  const fecha = (s) => s ? new Date(s).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const enPrueba = p.estado === 'trial';
  const titulo = enPrueba ? (p.plan_id ? p.plan_nombre : 'Prueba gratis') : (p.plan_nombre || '—');

  let detalle = '';
  if (enPrueba) {
    detalle = p.dias_restantes != null
      ? 'Te quedan <b>' + p.dias_restantes + ' día' + (p.dias_restantes === 1 ? '' : 's') + ' gratis</b> con todas las funciones (hasta el ' + fecha(p.trial_ends_at) + '). No te cobramos nada hasta que elijas cómo pagar.'
      : 'Estás usando la prueba gratis con todas las funciones.';
  } else if (p.es_gratis) {
    const l = p.limites || {};
    detalle = 'Estás en el plan <b>Gratis</b>, sin vencimiento. Incluye ' + (l.usuarios || 2) + ' usuarios, ' + (l.tiendas || 1) + ' tienda y ' + (l.historial_dias || 90) + ' días de historial. Cuando quieras más, pasate a un plan pago.';
  } else if (p.estado === 'activa') {
    detalle = (p.periodo === 'anual' ? 'Pago anual. ' : p.periodo === 'mensual' ? 'Pago mensual. ' : '') +
      (p.current_period_end ? (p.cancel_at_period_end ? 'Se cancela el ' : 'Próximo cobro: ') + '<b>' + fecha(p.current_period_end) + '</b>.' : 'Tu cuenta está activa.');
  } else if (p.estado === 'pago_pendiente') {
    detalle = 'No pudimos cobrar el último pago. Actualizá tu medio de pago para no perder el acceso.';
  } else {
    detalle = 'Tu plan venció. Elegí un plan para seguir usando el POS.';
  }

  const puede = p.puede_gestionar;
  const subPaga = p.tiene_cliente_stripe && ['activa', 'pago_pendiente'].includes(p.estado) && p.plan_legacy !== 'trial';

  const precioHtml = (pl) => {
    if (Number(pl.precio_mensual) === 0) {
      return '<div class="plan-precio">Gratis</div><div class="plan-sub">Para siempre, sin tarjeta</div>';
    }
    if (pl.precio_promo && pl.meses_promo) {
      return '<div class="plan-precio">' + fmtARS(pl.precio_promo) + ' <span>/ mes</span></div>' +
        '<div class="plan-sub">Los primeros ' + pl.meses_promo + ' meses, después ' + fmtARS(pl.precio_mensual) + '</div>' +
        (pl.precio_anual ? '<div class="plan-sub">o <b>' + fmtARS(pl.precio_anual) + ' el año</b> (' + fmtARS(pl.precio_anual / 12) + '/mes)</div>' : '');
    }
    return '<div class="plan-precio">' + fmtARS(pl.precio_mensual) + ' <span>/ mes</span></div>' +
      (pl.precio_primer_mes ? '<div class="plan-sub">Primer mes ' + fmtARS(pl.precio_primer_mes) + '</div>' : '') +
      (pl.precio_anual ? '<div class="plan-sub">o ' + fmtARS(pl.precio_anual) + ' el año</div>' : '');
  };

  const tarjeta = (pl) => {
    const esActual = pl.id === p.plan_id;
    const pagMensual = p.stripe_habilitado && !!pl.stripe_price_id;
    const pagAnual = p.stripe_habilitado && !!pl.stripe_price_id_anual;
    let botones = '';
    const esGratisPl = Number(pl.precio_mensual) === 0;
    if (!puede) botones = '';
    else if (esActual && !enPrueba) botones = '<button type="button" class="cc-btn" disabled>Tu plan actual</button>';
    else if (esGratisPl) botones = (enPrueba || p.estado === 'vencida') ? '<button type="button" class="cc-btn" data-elegir="gratis">Quedarme con Gratis</button>' : '';
    else if (subPaga) botones = esActual ? '<button type="button" class="cc-btn" disabled>Tu plan actual</button>' : '<button type="button" class="cc-btn" data-portal>Cambiar a este plan</button>';
    else if (pagMensual || pagAnual) {
      botones =
        (pagMensual ? '<button type="button" class="cc-btn cc-btn-pri" data-pagar="' + pl.id + '" data-periodo="mensual">Pagar mensual</button>' : '') +
        (pagAnual ? '<button type="button" class="cc-btn" data-pagar="' + pl.id + '" data-periodo="anual">Pagar el año (' + fmtARS(pl.precio_anual) + ')</button>' : '');
    } else if (enPrueba || p.estado === 'vencida') {
      botones = esActual ? '<button type="button" class="cc-btn" disabled>Plan elegido ✓</button>'
                         : '<button type="button" class="cc-btn" data-elegir="' + pl.id + '">Elegir este plan</button>';
    } else if (p.es_gratis) {
      botones = '<button type="button" class="cc-btn" disabled title="El pago online todavía no está habilitado">Pago online próximamente</button>';
    }
    return '<div class="plan-card' + (esActual ? ' actual' : '') + '">' +
      (pl.precio_promo ? '<div class="plan-promo">Promo</div>' : '') +
      '<div style="font-size:16px;font-weight:700">' + _esc(pl.nombre) + (esActual ? ' <span style="font-size:11px;font-weight:600;color:var(--primary)">· ' + (enPrueba ? 'elegido' : 'actual') + '</span>' : '') + '</div>' +
      '<div style="font-size:12px;color:var(--muted);min-height:32px">' + _esc(pl.descripcion || '') + '</div>' +
      precioHtml(pl) +
      '<ul>' + (Array.isArray(pl.features) ? pl.features : []).map(f => '<li>' + _esc(f) + '</li>').join('') + '</ul>' +
      (botones ? '<div class="plan-btns">' + botones + '</div>' : '') + '</div>';
  };

  wrap.innerHTML =
    '<div class="env-section">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">' +
        '<div><div style="font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em">' + (enPrueba && p.plan_id ? 'Plan elegido' : 'Tu plan') + '</div>' +
          '<div style="font-size:24px;font-weight:700;letter-spacing:-.02em;margin-top:2px">' + _esc(titulo) + '</div></div>' +
        '<span style="background:' + est.bg + ';color:' + est.fg + ';font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px">' + est.txt + '</span>' +
      '</div>' +
      '<div style="font-size:14px;color:var(--ink);margin-top:10px;line-height:1.5">' + detalle + '</div>' +
      (puede && p.tiene_cliente_stripe ? '<button type="button" class="cc-btn" data-portal style="margin-top:12px">Administrar suscripción y medio de pago</button>' : '') +
    '</div>' +
    '<h3 style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:18px 0 10px">Planes</h3>' +
    '<div class="plan-grid">' + planes.map(tarjeta).join('') + '</div>' +
    (!p.stripe_habilitado ? '<div style="font-size:13px;color:var(--muted);margin-top:12px;line-height:1.5">El pago con tarjeta desde acá llega muy pronto. Mientras tanto, escribinos para activar tu plan.</div>' : '') +
    (!puede ? '<div style="font-size:13px;color:var(--muted);margin-top:12px">Solo un administrador puede cambiar el plan.</div>' : '');

  wrap.querySelectorAll('[data-pagar]').forEach(b => b.addEventListener('click', () => _planCheckout(b.dataset.pagar, b.dataset.periodo, b)));
  wrap.querySelectorAll('[data-portal]').forEach(b => b.addEventListener('click', () => _planPortal(b)));
  wrap.querySelectorAll('[data-elegir]').forEach(b => b.addEventListener('click', async () => {
    if (b.dataset.elegir === 'gratis' && enPrueba && !confirm('Vas a pasar al plan Gratis y termina tu prueba de los planes pagos. ¿Seguro?')) return;
    b.disabled = true;
    const { error } = await sb.rpc('pos_plan_elegir', { p_organization_id: orgId, p_plan_id: b.dataset.elegir });
    if (error) { b.disabled = false; tmvShowError(error); return; }
    toast('Plan elegido ✓', 'ok');
    renderPlanConfig();
  }));
}

async function _planCheckout(planId, periodo, btn) {
  btn.disabled = true; const txt = btn.textContent; btn.textContent = 'Abriendo pago…';
  const { data, error } = await sb.functions.invoke('pos-billing-checkout', { body: { organization_id: orgId, plan_id: planId, periodo } });
  if (error || !data?.url) {
    btn.disabled = false; btn.textContent = txt;
    toast(data?.error || (error && (await _planErrorMsg(error))) || 'No se pudo iniciar el pago', 'err');
    return;
  }
  window.location.href = data.url;
}

async function _planPortal(btn) {
  btn.disabled = true; const txt = btn.textContent; btn.textContent = 'Abriendo…';
  const { data, error } = await sb.functions.invoke('pos-billing-portal', { body: { organization_id: orgId } });
  if (error || !data?.url) {
    btn.disabled = false; btn.textContent = txt;
    toast(data?.error || (error && (await _planErrorMsg(error))) || 'No se pudo abrir el portal de pagos', 'err');
    return;
  }
  window.location.href = data.url;
}

async function _planErrorMsg(error) {
  try { const b = await error.context?.json?.(); if (b?.error) return b.error; } catch (_) {}
  return error.message;
}

// Datos del registro + carga del plan al entrar, y vuelta desde Stripe.
(function _planInit() {
  const params = new URLSearchParams(location.search);
  const vuelta = params.get('billing');
  if (vuelta) { params.delete('billing'); history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash); }
  let intentos = 0;
  const esperar = setInterval(async () => {
    if (++intentos > 60) { clearInterval(esperar); return; }
    if (!orgId) return;
    clearInterval(esperar);
    if (_isAdmin()) {
      const k = 'pos_reg_ok_' + orgId;
      let hecho = false;
      try { hecho = localStorage.getItem(k) === '1'; } catch (_) {}
      if (!hecho) {
        const { data } = await sb.rpc('pos_registro_completar', { p_organization_id: orgId });
        if (data?.ok) { try { localStorage.setItem(k, '1'); } catch (_) {} }
      }
    }
    // Fuera de Argentina, si la prueba venció pasa al plan Gratis.
    const { data: venc } = await sb.rpc('pos_plan_vencido_a_gratis', { p_organization_id: orgId });
    await cargarPlanActual();
    if (venc?.cambio) toast('Terminó tu prueba: seguís usando el POS con el plan Gratis.', 'info');
    if (vuelta === 'ok') toast('¡Gracias! Tu suscripción se está activando. Puede tardar unos segundos.', 'ok');
    if (vuelta === 'cancel') toast('El pago se canceló. Podés elegir cómo pagar cuando quieras.', 'info');
    if (vuelta && _isAdmin()) { goTab('config'); _cfgShow('plan'); }
  }, 500);
})();

// ── Términos, Aviso de privacidad y uso de datos para mejora / IA ──
// TERMINOS_VERSION = fecha de terminos.html / privacidad.html. Al cambiar los
// documentos, subirla (y la de signup.html): a los administradores que
// aceptaron una versión anterior les aparece el aviso para aceptar la nueva.
const TERMINOS_VERSION = '2026-10-05';
let _consent = null;

async function _cargarConsentimiento() {
  const { data, error } = await sb.rpc('pos_consentimiento_estado', { p_organization_id: orgId });
  if (error) { console.warn('pos_consentimiento_estado', error); return null; }
  return (_consent = data);
}

function _avisoTerminos() {
  document.getElementById('aviso-terminos')?.remove();
  if (!_consent || !_consent.es_admin || _consent.terminos_version === TERMINOS_VERSION) return;
  const nuevo = !_consent.terminos_version;
  const caja = document.createElement('div');
  caja.id = 'aviso-terminos';
  caja.setAttribute('role', 'dialog');
  caja.setAttribute('aria-label', 'Términos y Aviso de privacidad');
  caja.style.cssText = 'position:fixed;left:16px;right:16px;bottom:calc(16px + env(safe-area-inset-bottom));z-index:250;max-width:560px;margin:0 auto;' +
    'background:#fff;border:1px solid var(--border,#E2E8F0);border-radius:12px;box-shadow:0 12px 32px -8px rgba(16,24,40,.25);padding:16px;font-size:14px;line-height:1.5;color:#334155';
  caja.innerHTML =
    '<div style="font-weight:700;color:#1A1A1A;margin-bottom:4px">' + (nuevo ? 'Términos y Aviso de privacidad' : 'Actualizamos los Términos y el Aviso de privacidad') + '</div>' +
    '<div>Explican cómo funciona el servicio y cómo cuidamos tus datos. Entre otras cosas, usamos datos desidentificados (sin nombres ni teléfonos) para mejorar el POS y sus funciones de inteligencia artificial; podés desactivarlo cuando quieras en Configuración → Privacidad.</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center">' +
      '<button type="button" data-ok style="font-weight:600;background:var(--primary,#0F766E);color:#fff;border:0;border-radius:8px;padding:9px 16px;cursor:pointer">Aceptar</button>' +
      '<button type="button" data-cfg style="font-weight:600;background:#fff;color:#1A1A1A;border:1px solid #CBD5E1;border-radius:8px;padding:8px 14px;cursor:pointer">Ver opciones</button>' +
      '<a href="terminos.html" target="_blank" style="color:var(--primary,#0F766E);font-weight:600">Términos</a>' +
      '<a href="privacidad.html" target="_blank" style="color:var(--primary,#0F766E);font-weight:600">Privacidad</a>' +
    '</div>';
  caja.querySelector('[data-ok]').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const { data, error } = await sb.rpc('pos_consentimiento_guardar', { p_organization_id: orgId, p_terminos_version: TERMINOS_VERSION });
    if (error) { e.target.disabled = false; toast('No se pudo guardar. Probá de nuevo.', 'err'); return; }
    _consent = data;
    caja.remove();
  });
  caja.querySelector('[data-cfg]').addEventListener('click', () => { goTab('config'); _cfgShow('privacidad'); });
  document.body.appendChild(caja);
}

async function renderPrivacidadConfig() {
  const wrap = document.getElementById('privacidad-wrap');
  if (!wrap) return;
  if (!_isAdmin()) { wrap.innerHTML = '<div class="env-empty">Solo administradores.</div>'; return; }
  wrap.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';
  const c = await _cargarConsentimiento();
  if (!c) { wrap.innerHTML = '<div class="env-empty">No se pudo cargar.</div>'; return; }
  const fecha = (s) => s ? new Date(s).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const vigente = c.terminos_version === TERMINOS_VERSION;
  wrap.innerHTML =
    '<div class="env-section">' +
      '<h3>Uso de datos para mejorar el servicio</h3>' +
      '<label style="display:flex;align-items:flex-start;gap:10px;font-size:15px;font-weight:600;cursor:pointer"><input type="checkbox" id="pv-ia"' + (c.mejora_ia ? ' checked' : '') + ' style="width:18px;height:18px;margin-top:2px;flex-shrink:0"> Usar datos desidentificados para mejorar el Servicio y sus funciones de IA</label>' +
      '<div style="font-size:13px;color:var(--muted);margin-top:8px;line-height:1.5">Antes de usarlos les quitamos nombres, teléfonos, correos, direcciones y datos fiscales, y los combinamos con los de otros negocios. Sirven para mejorar el POS y desarrollar funciones como sugerencias de precios y compras. Si lo desactivás, el POS funciona igual. <a href="privacidad.html#mejora" target="_blank" style="color:var(--primary);font-weight:600">Más información</a></div>' +
      '<div id="pv-msg" style="font-size:13px;margin-top:8px;min-height:18px"></div>' +
    '</div>' +
    '<div class="env-section">' +
      '<h3>Documentos</h3>' +
      '<div style="font-size:14px;line-height:1.7">' +
        '<a href="terminos.html" target="_blank" style="color:var(--primary);font-weight:600">Términos y condiciones</a> · ' +
        '<a href="privacidad.html" target="_blank" style="color:var(--primary);font-weight:600">Aviso de privacidad</a> · ' +
        '<a href="cookies.html" target="_blank" style="color:var(--primary);font-weight:600">Política de cookies</a></div>' +
      '<div style="font-size:13px;color:var(--muted);margin-top:6px">' +
        (vigente ? 'Aceptados el ' + fecha(c.terminos_aceptados_at) + ' (versión ' + _esc(c.terminos_version) + ').'
                 : 'Hay una versión nueva (' + TERMINOS_VERSION + ') sin aceptar. <button type="button" id="pv-acepto" class="cc-btn" style="margin-left:6px">Aceptar</button>') +
      '</div>' +
      '<div style="font-size:13px;color:var(--muted);margin-top:10px">Para pedir una copia de tus datos, corregirlos o borrarlos, escribí a <a href="mailto:contacto@trackmyvend.com" style="color:var(--primary)">contacto@trackmyvend.com</a>.</div>' +
    '</div>';
  const msg = wrap.querySelector('#pv-msg');
  wrap.querySelector('#pv-ia').addEventListener('change', async (e) => {
    const valor = e.target.checked;
    e.target.disabled = true;
    const { data, error } = await sb.rpc('pos_consentimiento_guardar', { p_organization_id: orgId, p_mejora_ia: valor });
    e.target.disabled = false;
    if (error) { e.target.checked = !valor; msg.style.color = '#B42318'; msg.textContent = 'No se pudo guardar. Probá de nuevo.'; return; }
    _consent = data;
    msg.style.color = 'var(--muted)';
    msg.textContent = valor ? 'Activado.' : 'Desactivado: dejamos de usar los datos de tu negocio para estos fines.';
  });
  wrap.querySelector('#pv-acepto')?.addEventListener('click', async () => {
    const { data, error } = await sb.rpc('pos_consentimiento_guardar', { p_organization_id: orgId, p_terminos_version: TERMINOS_VERSION });
    if (error) { toast('No se pudo guardar. Probá de nuevo.', 'err'); return; }
    _consent = data;
    document.getElementById('aviso-terminos')?.remove();
    renderPrivacidadConfig();
  });
}

// Al entrar: registra lo aceptado en el registro y, si falta aceptar la
// versión vigente, muestra el aviso (solo administradores).
(function _consentInit() {
  let intentos = 0;
  const esperar = setInterval(async () => {
    if (++intentos > 60) { clearInterval(esperar); return; }
    if (!orgId) return;
    clearInterval(esperar);
    if (!_isAdmin()) return;
    if (await _cargarConsentimiento()) _avisoTerminos();
  }, 700);
})();
