// ═══════════════════════════════════════════════════════════════════
// Plan y suscripción del POS (Configuración → Mi plan).
//
// Muestra en qué plan está la organización (prueba, plan pago, vencido) y
// los planes disponibles (tabla pos_planes). El cobro con Stripe pasa por las
// edge functions pos-billing-checkout / pos-billing-portal: mientras los
// planes no tengan stripe_price_id, se muestran sin botón de pago.
// ═══════════════════════════════════════════════════════════════════

let _planInfo = null;

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
  _planPintarChip();
  return data;
}

// Aviso en la barra superior cuando quedan pocos días de prueba o hay un problema de pago.
function _planPintarChip() {
  const p = _planInfo;
  document.getElementById('plan-chip')?.remove();
  if (!p || !p.puede_gestionar) return;
  let txt = null, alerta = false;
  if (p.estado === 'trial' && p.dias_restantes != null && p.dias_restantes <= 7) txt = 'Prueba: ' + p.dias_restantes + ' día' + (p.dias_restantes === 1 ? '' : 's');
  else if (p.estado === 'pago_pendiente') { txt = 'Pago pendiente'; alerta = true; }
  else if (p.estado === 'vencida' || p.estado === 'cancelada') { txt = 'Plan vencido'; alerta = true; }
  if (!txt) return;
  const chip = document.createElement('button');
  chip.id = 'plan-chip';
  chip.type = 'button';
  chip.className = 'plan-chip' + (alerta ? ' alerta' : '');
  chip.textContent = txt;
  chip.title = 'Ver mi plan';
  chip.addEventListener('click', () => { goTab('config'); _cfgShow('plan'); });
  const ref = document.getElementById('dash-mini') || document.querySelector('.topbar-logout');
  ref?.parentNode?.insertBefore(chip, ref);
}

async function renderPlanConfig() {
  const wrap = document.getElementById('plan-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';
  const [p, planesR] = await Promise.all([
    cargarPlanActual(),
    sb.from('pos_planes').select('id, nombre, descripcion, precio_mensual, precio_primer_mes, features, stripe_price_id, tiendas_incluidas, precio_tienda_extra').eq('activo', true).order('orden'),
  ]);
  if (!p) { wrap.innerHTML = '<div class="env-empty">No se pudo cargar tu plan.</div>'; return; }
  const planes = planesR.data || [];
  const est = PLAN_ESTADOS[p.estado] || PLAN_ESTADOS.activa;
  const fecha = (s) => s ? new Date(s).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

  let detalle = '';
  if (p.estado === 'trial') {
    detalle = p.dias_restantes != null
      ? 'Te quedan <b>' + p.dias_restantes + ' día' + (p.dias_restantes === 1 ? '' : 's') + '</b> de prueba con todas las funciones (vence el ' + fecha(p.trial_ends_at) + ').'
      : 'Estás usando la prueba gratis con todas las funciones.';
  } else if (p.estado === 'activa') {
    detalle = p.current_period_end
      ? (p.cancel_at_period_end ? 'Se cancela el ' : 'Próximo cobro: ') + '<b>' + fecha(p.current_period_end) + '</b>.'
      : 'Tu cuenta está activa.';
  } else if (p.estado === 'pago_pendiente') {
    detalle = 'No pudimos cobrar el último pago. Actualizá tu medio de pago para no perder el acceso.';
  } else {
    detalle = 'Tu plan venció. Elegí un plan para seguir usando el POS.';
  }

  const puede = p.puede_gestionar;
  const actualId = p.plan_id;
  const tarjeta = (pl) => {
    const esActual = pl.id === actualId && p.estado === 'activa';
    const pagable = p.stripe_habilitado && !!pl.stripe_price_id;
    let boton;
    if (esActual) boton = '<button type="button" class="cc-btn" disabled style="width:100%">Tu plan actual</button>';
    else if (!puede) boton = '';
    else if (pagable && p.tiene_cliente_stripe && ['activa', 'pago_pendiente'].includes(p.estado))
      boton = '<button type="button" class="cc-btn" data-portal style="width:100%">Cambiar a este plan</button>';
    else if (pagable) boton = '<button type="button" class="cc-btn cc-btn-pri" data-plan="' + pl.id + '" style="width:100%">Elegir ' + _esc(pl.nombre) + '</button>';
    else boton = '<button type="button" class="cc-btn" disabled style="width:100%" title="El pago online todavía no está habilitado">Pago online próximamente</button>';
    return '<div class="plan-card' + (esActual ? ' actual' : '') + '">' +
      '<div style="font-size:16px;font-weight:700">' + _esc(pl.nombre) + '</div>' +
      '<div style="font-size:12px;color:var(--muted);min-height:32px">' + _esc(pl.descripcion || '') + '</div>' +
      '<div style="font-size:26px;font-weight:800;letter-spacing:-.02em;margin-top:6px;font-variant-numeric:tabular-nums">' + fmtARS(pl.precio_mensual) + ' <span style="font-size:13px;font-weight:500;color:var(--muted)">/ mes</span></div>' +
      (pl.precio_primer_mes ? '<div style="font-size:12px;color:var(--muted)">Primer mes ' + fmtARS(pl.precio_primer_mes) + '</div>' : '') +
      '<ul>' + (Array.isArray(pl.features) ? pl.features : []).map(f => '<li>' + _esc(f) + '</li>').join('') + '</ul>' +
      boton + '</div>';
  };

  wrap.innerHTML =
    '<div class="env-section">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">' +
        '<div><div style="font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em">Tu plan</div>' +
          '<div style="font-size:24px;font-weight:700;letter-spacing:-.02em;margin-top:2px">' + _esc(p.plan_nombre || '—') + '</div></div>' +
        '<span style="background:' + est.bg + ';color:' + est.fg + ';font-size:12px;font-weight:700;padding:5px 12px;border-radius:999px">' + est.txt + '</span>' +
      '</div>' +
      '<div style="font-size:14px;color:var(--ink);margin-top:10px;line-height:1.5">' + detalle + '</div>' +
      (p.precio_mensual ? '<div style="font-size:13px;color:var(--muted);margin-top:4px">' + fmtARS(p.precio_mensual) + ' por mes</div>' : '') +
      (puede && p.tiene_cliente_stripe ? '<button type="button" class="cc-btn" data-portal style="margin-top:12px">Administrar suscripción y medio de pago</button>' : '') +
    '</div>' +
    '<h3 style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin:18px 0 10px">Planes</h3>' +
    '<div class="plan-grid">' + planes.map(tarjeta).join('') + '</div>' +
    (!p.stripe_habilitado ? '<div style="font-size:13px;color:var(--muted);margin-top:12px;line-height:1.5">El pago con tarjeta desde acá llega muy pronto. Mientras tanto, escribinos para activar o cambiar tu plan.</div>' : '') +
    (!puede ? '<div style="font-size:13px;color:var(--muted);margin-top:12px">Solo un administrador puede cambiar el plan.</div>' : '');

  wrap.querySelectorAll('[data-plan]').forEach(b => b.addEventListener('click', () => _planCheckout(b.dataset.plan, b)));
  wrap.querySelectorAll('[data-portal]').forEach(b => b.addEventListener('click', () => _planPortal(b)));
}

async function _planCheckout(planId, btn) {
  btn.disabled = true; const txt = btn.textContent; btn.textContent = 'Abriendo pago…';
  const { data, error } = await sb.functions.invoke('pos-billing-checkout', { body: { organization_id: orgId, plan_id: planId } });
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

// Vuelta desde Stripe (?billing=ok|cancel|portal) y carga inicial del plan.
(function _planInit() {
  const params = new URLSearchParams(location.search);
  const vuelta = params.get('billing');
  if (vuelta) { params.delete('billing'); history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash); }
  let intentos = 0;
  const esperar = setInterval(() => {
    if (++intentos > 60) { clearInterval(esperar); return; }
    if (!orgId) return;
    clearInterval(esperar);
    cargarPlanActual();
    if (vuelta === 'ok') toast('¡Gracias! Tu suscripción se está activando. Puede tardar unos segundos.', 'ok');
    if (vuelta === 'cancel') toast('El pago se canceló. Podés elegir un plan cuando quieras.', 'info');
    if (vuelta && _isAdmin()) { goTab('config'); _cfgShow('plan'); }
  }, 500);
})();
