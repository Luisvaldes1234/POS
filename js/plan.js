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
  _planPintarBanda();
  return data;
}

async function _cargarPlanes() {
  if (_planesCache) return _planesCache;
  const { data } = await sb.from('pos_planes')
    .select('id, nombre, descripcion, precio_mensual, precio_primer_mes, precio_promo, meses_promo, precio_anual, promo_texto, features, stripe_price_id, stripe_price_id_anual')
    .eq('activo', true).order('orden');
  _planesCache = data || [];
  return _planesCache;
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
  const [p, planes] = await Promise.all([cargarPlanActual(), _cargarPlanes()]);
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
    if (!puede) botones = '';
    else if (subPaga) botones = esActual ? '<button type="button" class="cc-btn" disabled>Tu plan actual</button>' : '<button type="button" class="cc-btn" data-portal>Cambiar a este plan</button>';
    else if (pagMensual || pagAnual) {
      botones =
        (pagMensual ? '<button type="button" class="cc-btn cc-btn-pri" data-pagar="' + pl.id + '" data-periodo="mensual">Pagar mensual</button>' : '') +
        (pagAnual ? '<button type="button" class="cc-btn" data-pagar="' + pl.id + '" data-periodo="anual">Pagar el año (' + fmtARS(pl.precio_anual) + ')</button>' : '');
    } else if (enPrueba || p.estado === 'vencida') {
      botones = esActual ? '<button type="button" class="cc-btn" disabled>Plan elegido ✓</button>'
                         : '<button type="button" class="cc-btn" data-elegir="' + pl.id + '">Elegir este plan</button>';
    }
    return '<div class="plan-card' + (esActual ? ' actual' : '') + '">' +
      (pl.promo_texto ? '<div class="plan-promo">Promo</div>' : '') +
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
    await cargarPlanActual();
    if (vuelta === 'ok') toast('¡Gracias! Tu suscripción se está activando. Puede tardar unos segundos.', 'ok');
    if (vuelta === 'cancel') toast('El pago se canceló. Podés elegir cómo pagar cuando quieras.', 'info');
    if (vuelta && _isAdmin()) { goTab('config'); _cfgShow('plan'); }
  }, 500);
})();
