// ═══════════════════════════════════════════════════════════════════
// Clientes y programa de lealtad del POS Mostrador.
//
// Se carga después de js/pos.js y usa sus globales (sb, orgId, cart,
// productos, clienteSel, fmtARS, toast, _esc, _ccModal…).
//
// Lealtad: cada `pesos_por_punto` de compra suma 1 punto. Los puntos se
// canjean por recompensas que configura el admin (descuento en $, en % o un
// producto gratis). La lógica que mueve puntos vive en RPCs de Supabase
// (sql/2026-10-05_pos_lealtad.sql); acá solo la UI.
// ═══════════════════════════════════════════════════════════════════

let _lealtadCfg = null;          // config de la org (null = sin cargar)
let _lealtadCfgTs = 0;
let _lealtadMiembro = null;      // { cliente_id, puntos } del cliente en venta
let _lealtadCanje = null;        // { clienteId, rec } canje pendiente en el carrito

const LEALTAD_TIPOS = { monto: '$ de descuento', pct: '% de descuento', producto: 'Producto gratis' };

async function cargarLealtadConfig(force) {
  if (!force && _lealtadCfg && Date.now() - _lealtadCfgTs < 60_000) return _lealtadCfg;
  const { data, error } = await sb.from('pos_lealtad_config')
    .select('activo, pesos_por_punto, puntos_bienvenida, recompensas')
    .eq('organization_id', orgId).maybeSingle();
  if (error) { console.warn('lealtad config:', error.message); return _lealtadCfg || { activo: false, recompensas: [] }; }
  _lealtadCfg = data || { activo: false, pesos_por_punto: 1000, puntos_bienvenida: 0, recompensas: [] };
  _lealtadCfg.recompensas = Array.isArray(_lealtadCfg.recompensas) ? _lealtadCfg.recompensas : [];
  _lealtadCfgTs = Date.now();
  return _lealtadCfg;
}

function _lealtadRecompensasActivas() {
  return (_lealtadCfg?.recompensas || []).filter(r => r.activo !== false && Number(r.puntos) >= 0);
}

function _lealtadRecLabel(r) {
  if (r.tipo === 'monto') return fmtARS(r.valor) + ' de descuento';
  if (r.tipo === 'pct') return Number(r.valor) + '% de descuento';
  if (r.tipo === 'producto') {
    const p = productos.find(x => x.id === r.producto_id);
    return (p ? p.nombre : 'Producto') + ' gratis';
  }
  return '';
}

// ── Descuento del canje pendiente (lo usa _calcDescuento de pos.js) ──
function _lealtadDescuento(total) {
  if (!_lealtadCanje || !clienteSel?.id || _lealtadCanje.clienteId !== clienteSel.id) return 0;
  const r = _lealtadCanje.rec;
  if (r.tipo === 'monto') return Math.max(0, Number(r.valor) || 0);
  if (r.tipo === 'pct') return Math.max(0, total * (Number(r.valor) || 0) / 100);
  if (r.tipo === 'producto') {
    const it = cart.get(r.producto_id);
    return it ? Number(it.precio) || 0 : 0;   // 1 unidad gratis
  }
  return 0;
}

function _lealtadLimpiarCanje() {
  if (!_lealtadCanje) return;
  _lealtadCanje = null;
  _lealtadPintarBox();
}

// ── Bloque de puntos en la venta (debajo del cliente) ──
async function _lealtadRefrescarCliente() {
  const box = document.getElementById('pos-lealtad');
  if (!box) return;
  if (!clienteSel?.id) { _lealtadMiembro = null; _lealtadCanje = null; box.style.display = 'none'; box.innerHTML = ''; return; }
  if (_lealtadCanje && _lealtadCanje.clienteId !== clienteSel.id) _lealtadCanje = null;
  const cliId = clienteSel.id;
  await cargarLealtadConfig();
  if (!_lealtadCfg?.activo) { box.style.display = 'none'; return; }
  const { data } = await sb.from('pos_lealtad_miembros')
    .select('cliente_id, puntos').eq('organization_id', orgId).eq('cliente_id', cliId).maybeSingle();
  if (!clienteSel || clienteSel.id !== cliId) return;
  _lealtadMiembro = data || null;
  _lealtadPintarBox();
}

function _lealtadPintarBox() {
  const box = document.getElementById('pos-lealtad');
  if (!box) return;
  if (!clienteSel?.id || !_lealtadCfg?.activo) { box.style.display = 'none'; return; }
  box.style.display = '';
  if (!_lealtadMiembro) {
    box.innerHTML =
      '<button type="button" id="lea-sumar" class="lea-box lea-cta">⭐ Sumar a ' + _esc(clienteSel.nombre) + ' al programa de puntos</button>';
    box.querySelector('#lea-sumar').addEventListener('click', async () => {
      const r = await _lealtadRegistrar({ clienteId: clienteSel.id });
      if (r) _lealtadRefrescarCliente();
    });
    return;
  }
  const pts = Number(_lealtadMiembro.puntos) || 0;
  const recs = _lealtadRecompensasActivas();
  const alcanzables = recs.filter(r => pts >= Number(r.puntos));
  const proxima = recs.filter(r => pts < Number(r.puntos)).sort((a, b) => a.puntos - b.puntos)[0];
  const canje = _lealtadCanje && _lealtadCanje.clienteId === clienteSel.id ? _lealtadCanje.rec : null;
  box.innerHTML =
    '<div class="lea-box">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
        '<div><b>⭐ ' + pts + ' punto' + (pts === 1 ? '' : 's') + '</b>' +
        '<div style="font-size:11px;color:var(--muted)">' +
          (canje ? 'Canje aplicado en esta venta'
            : alcanzables.length ? alcanzables.length + ' recompensa' + (alcanzables.length > 1 ? 's' : '') + ' disponible' + (alcanzables.length > 1 ? 's' : '')
            : proxima ? 'Le faltan ' + (proxima.puntos - pts) + ' para "' + _esc(proxima.nombre) + '"'
            : 'Suma ' + 1 + ' punto cada ' + fmtARS(_lealtadCfg.pesos_por_punto)) +
        '</div></div>' +
        (canje ? '' : (alcanzables.length ? '<button type="button" id="lea-canjear" class="cc-btn cc-btn-pri" style="padding:6px 10px;font-size:12px">Canjear</button>' : '')) +
      '</div>' +
      (canje
        ? '<div class="lea-chip"><span>🎁 ' + _esc(canje.nombre) + ' · ' + _esc(_lealtadRecLabel(canje)) + ' (−' + canje.puntos + ' pts)</span>' +
          '<button type="button" id="lea-quitar" title="Quitar canje">×</button></div>'
        : '') +
    '</div>';
  box.querySelector('#lea-canjear')?.addEventListener('click', _lealtadElegirCanje);
  box.querySelector('#lea-quitar')?.addEventListener('click', () => { _lealtadCanje = null; renderCart(); _lealtadPintarBox(); });
}

function _lealtadElegirCanje() {
  const pts = Number(_lealtadMiembro?.puntos) || 0;
  const recs = _lealtadRecompensasActivas();
  const ov = _ccModal(
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
      '<h3 style="margin:0;font-size:18px">Canjear puntos</h3>' +
      '<button type="button" data-x style="background:none;border:0;font-size:22px;cursor:pointer;color:#64748b">×</button></div>' +
    '<div style="font-size:14px;color:var(--muted);margin-bottom:14px">' + _esc(clienteSel.nombre) + ' tiene <b>' + pts + ' puntos</b>. El canje se descuenta al cobrar.</div>' +
    recs.map((r, i) => {
      const ok = pts >= Number(r.puntos);
      return '<button type="button" data-i="' + i + '"' + (ok ? '' : ' disabled') + ' class="lea-rec' + (ok ? '' : ' off') + '">' +
        '<span><b>' + _esc(r.nombre) + '</b><span style="display:block;font-size:12px;color:var(--muted)">' + _esc(_lealtadRecLabel(r)) + '</span></span>' +
        '<span style="font-weight:700;white-space:nowrap">' + r.puntos + ' pts</span></button>';
    }).join(''));
  const cerrar = () => ov.remove();
  ov.querySelector('[data-x]').addEventListener('click', cerrar);
  ov.addEventListener('mousedown', e => { if (e.target === ov) cerrar(); });
  ov.querySelectorAll('[data-i]').forEach(b => b.addEventListener('click', () => {
    const r = recs[Number(b.dataset.i)];
    if (r.tipo === 'producto') {
      const p = productos.find(x => x.id === r.producto_id);
      if (!p) { toast('El producto de esta recompensa ya no está en el catálogo', 'err'); return; }
      if (!cart.has(p.id)) agregarAlCarrito(p);
    }
    _lealtadCanje = { clienteId: clienteSel.id, rec: r };
    cerrar();
    renderCart();
    _lealtadPintarBox();
    toast('🎁 Canje aplicado: ' + r.nombre, 'ok');
  }));
}

// Después de una venta confirmada: canjea (si había) y suma los puntos.
async function _lealtadPostVenta(clienteId, data, totalCobrado) {
  const canje = _lealtadCanje && _lealtadCanje.clienteId === clienteId ? _lealtadCanje.rec : null;
  _lealtadCanje = null;
  if (!clienteId || data?.offline || !_lealtadCfg?.activo) return;
  const pedidoId = data?.pedido_id || null;
  try {
    if (canje) {
      const { error } = await sb.rpc('pos_lealtad_canjear', {
        p_organization_id: orgId, p_cliente_id: clienteId, p_recompensa_id: String(canje.id), p_pedido_id: pedidoId,
      });
      if (error) toast('No se pudo descontar el canje de puntos: ' + error.message, 'err');
    }
    const { data: r, error } = await sb.rpc('pos_lealtad_sumar', {
      p_organization_id: orgId, p_cliente_id: clienteId, p_monto: Math.max(0, Number(totalCobrado) || 0), p_pedido_id: pedidoId,
    });
    if (error) { console.warn('lealtad sumar:', error.message); return; }
    if (r?.puntos_ganados > 0) toast('⭐ +' + r.puntos_ganados + ' puntos · ahora tiene ' + r.puntos, 'ok');
  } catch (e) { console.warn('lealtad post-venta:', e); }
}

// Registrar en el programa: por cliente existente o por teléfono + nombre.
async function _lealtadRegistrar({ clienteId, telefono, nombre }) {
  const { data, error } = await sb.rpc('pos_lealtad_registrar', {
    p_organization_id: orgId, p_telefono: telefono || null, p_nombre: nombre || null, p_cliente_id: clienteId || null,
  });
  if (error) { tmvShowError(error, { title: 'No se pudo registrar' }); return null; }
  if (data?.ya_era_miembro) toast('Ya estaba en el programa · ' + data.puntos + ' puntos', 'info');
  else toast('⭐ Registrado en el programa' + (data?.bienvenida > 0 ? ' · +' + data.bienvenida + ' puntos de bienvenida' : ''), 'ok');
  return data;
}

// ═══════════════════════════════════════════════════════════════════
// Pestaña CLIENTES
// ═══════════════════════════════════════════════════════════════════
let _cliVista = 'lista';
let _cliBusca = '';
let _cliPagina = 0;
const CLI_POR_PAGINA = 50;
let _cliWired = false;

async function renderClientes() {
  const subnav = document.getElementById('cli-subnav');
  if (subnav && !_cliWired) {
    _cliWired = true;
    subnav.querySelectorAll('[data-cli]').forEach(b => b.addEventListener('click', () => {
      _cliVista = b.dataset.cli;
      subnav.querySelectorAll('[data-cli]').forEach(x => x.classList.toggle('active', x === b));
      renderClientes();
    }));
  }
  await cargarLealtadConfig();
  if (_cliVista === 'lealtad') return _renderLealtadMiembros();
  return _renderListaClientes();
}

async function _renderListaClientes() {
  const wrap = document.getElementById('clientes-wrap');
  if (!wrap) return;
  if (!wrap.querySelector('#cli-q')) {
    wrap.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px">' +
        '<div><h2 style="font-size:22px;font-weight:700;letter-spacing:-.02em;margin:0">Clientes</h2>' +
        '<div style="font-size:13px;color:var(--muted);margin-top:4px">Tu cartera de clientes, con su saldo y sus puntos.</div></div>' +
        '<button type="button" id="cli-nuevo" class="cc-btn cc-btn-pri">+ Nuevo cliente</button>' +
      '</div>' +
      '<input id="cli-q" type="search" placeholder="Buscar por nombre, teléfono o email" autocomplete="off" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:10px;font-size:14px;font-family:inherit;outline:none;margin-bottom:12px">' +
      '<div id="cli-lista"></div>';
    const q = wrap.querySelector('#cli-q');
    let t = null;
    q.value = _cliBusca;
    q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { _cliBusca = q.value; _cliPagina = 0; _cargarListaClientes(); }, 250); });
    wrap.querySelector('#cli-nuevo').addEventListener('click', () => _cliEditar(null));
  }
  _cargarListaClientes();
}

async function _cargarListaClientes() {
  const box = document.getElementById('cli-lista');
  if (!box) return;
  box.innerHTML = '<div style="text-align:center;padding:24px;color:var(--muted)">Cargando…</div>';
  let qb = sb.from('clientes')
    .select('id, nombre, telefono, whatsapp, email, notas, cuenta_corriente_habilitada, limite_cc', { count: 'exact' })
    .eq('organization_id', orgId).eq('activo', true).neq('nombre', 'Mostrador')
    .order('nombre')
    .range(_cliPagina * CLI_POR_PAGINA, _cliPagina * CLI_POR_PAGINA + CLI_POR_PAGINA - 1);
  const v = _cliBusca.trim().replace(/[%,()]/g, ' ');
  if (v) qb = qb.or('nombre.ilike.%' + v + '%,telefono.ilike.%' + v + '%,whatsapp.ilike.%' + v + '%,email.ilike.%' + v + '%');
  const { data, error, count } = await qb;
  if (error) { box.innerHTML = '<div style="color:#B42318;padding:14px">Error: ' + _esc(error.message) + '</div>'; return; }
  const filas = data || [];
  const ids = filas.map(c => c.id);
  const [ccR, leR] = ids.length ? await Promise.all([
    sb.from('cuenta_corriente').select('cliente_id, saldo').eq('organization_id', orgId).in('cliente_id', ids),
    sb.from('pos_lealtad_miembros').select('cliente_id, puntos').eq('organization_id', orgId).in('cliente_id', ids),
  ]) : [{ data: [] }, { data: [] }];
  const saldo = new Map((ccR.data || []).map(r => [r.cliente_id, Number(r.saldo) || 0]));
  const puntos = new Map((leR.data || []).map(r => [r.cliente_id, Number(r.puntos) || 0]));
  const leaOn = !!_lealtadCfg?.activo;
  const total = count || 0;
  const pags = Math.max(1, Math.ceil(total / CLI_POR_PAGINA));

  box.innerHTML =
    '<div class="env-section" style="padding:0;overflow:hidden">' +
    (filas.length ? filas.map(c => {
      const s = saldo.get(c.id) || 0;
      const pts = puntos.has(c.id) ? puntos.get(c.id) : null;
      return '<div class="cc-row" data-id="' + c.id + '">' +
        '<div class="cc-cli"><div class="cc-nm">' + _esc(c.nombre) + '</div>' +
        '<div class="cc-sub">' + _esc([c.telefono || c.whatsapp, c.email].filter(Boolean).join(' · ') || 'Sin datos de contacto') + '</div></div>' +
        '<div class="cc-saldo" style="font-size:13px">' +
          (s > 0.009 ? '<div style="color:#B42318;font-weight:700">debe ' + fmtARS(s) + '</div>' : s < -0.009 ? '<div style="color:#047857;font-weight:700">' + fmtARS(-s) + ' a favor</div>' : '') +
          (pts != null ? '<div class="cc-sub">⭐ ' + pts + ' pts</div>' : '') +
        '</div>' +
        '<div class="cc-acts">' +
          '<button type="button" class="cc-btn cc-btn-pri" data-act="vender">Vender</button>' +
          '<button type="button" class="cc-btn" data-act="editar">Editar</button>' +
          '<button type="button" class="cc-btn" data-act="compras">Compras</button>' +
          (leaOn && pts == null ? '<button type="button" class="cc-btn" data-act="lealtad">⭐ Sumar</button>' : '') +
        '</div></div>';
    }).join('') : '<div class="env-empty">' + (v ? 'Sin resultados para "' + _esc(v) + '"' : 'Todavía no cargaste clientes.') + '</div>') +
    '</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;font-size:13px;color:var(--muted)">' +
      '<span>' + total + ' cliente' + (total === 1 ? '' : 's') + '</span>' +
      (pags > 1 ? '<span style="display:flex;gap:8px;align-items:center">' +
        '<button type="button" class="cc-btn" data-pag="-1"' + (_cliPagina === 0 ? ' disabled' : '') + '>← Anterior</button>' +
        (_cliPagina + 1) + ' / ' + pags +
        '<button type="button" class="cc-btn" data-pag="1"' + (_cliPagina >= pags - 1 ? ' disabled' : '') + '>Siguiente →</button></span>' : '') +
    '</div>';

  box.querySelectorAll('[data-pag]').forEach(b => b.addEventListener('click', () => { _cliPagina += Number(b.dataset.pag); _cargarListaClientes(); }));
  box.querySelectorAll('.cc-row').forEach(row => {
    const c = filas.find(x => x.id === row.dataset.id);
    row.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
      const act = b.dataset.act;
      if (act === 'vender') { seleccionarCliente(c); goTab('pos'); toast('Vendiendo a ' + c.nombre, 'ok'); }
      if (act === 'editar') _cliEditar(c);
      if (act === 'compras') _cliCompras(c);
      if (act === 'lealtad') { const r = await _lealtadRegistrar({ clienteId: c.id }); if (r) _cargarListaClientes(); }
    }));
  });
}

// Alta / edición de cliente (datos básicos).
function _cliEditar(c) {
  const nuevo = !c;
  c = c || {};
  const leaOn = !!_lealtadCfg?.activo;
  const campo = (id, label, val, type, ph) =>
    '<label style="display:block;font-size:13px;font-weight:600;margin:12px 0 6px">' + label + '</label>' +
    '<input id="' + id + '" type="' + (type || 'text') + '" value="' + _esc(val || '') + '" placeholder="' + _esc(ph || '') + '" autocomplete="off" style="width:100%;padding:10px 12px;border:1.5px solid var(--border);border-radius:10px;font-size:15px;font-family:inherit;outline:none">';
  const ov = _ccModal(
    '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<h3 style="margin:0;font-size:18px">' + (nuevo ? 'Nuevo cliente' : 'Editar cliente') + '</h3>' +
      '<button type="button" data-x style="background:none;border:0;font-size:22px;cursor:pointer;color:#64748b">×</button></div>' +
    campo('ce-nombre', 'Nombre *', c.nombre, 'text', 'Ej: María González') +
    campo('ce-tel', 'Teléfono / WhatsApp', c.telefono || c.whatsapp, 'tel', '11 5555-1234') +
    campo('ce-email', 'Email', c.email, 'email', 'opcional') +
    campo('ce-notas', 'Notas', c.notas, 'text', 'opcional') +
    (nuevo && leaOn ? '<label style="display:flex;align-items:center;gap:8px;font-size:14px;margin-top:14px;cursor:pointer"><input type="checkbox" id="ce-lea" checked> Sumar al programa de puntos</label>' : '') +
    '<button type="button" id="ce-ok" style="margin-top:18px;width:100%;padding:13px;border:0;border-radius:10px;background:var(--primary);color:#fff;font-size:15px;font-weight:700;cursor:pointer">' + (nuevo ? 'Crear cliente' : 'Guardar') + '</button>');
  const cerrar = () => ov.remove();
  ov.querySelector('[data-x]').addEventListener('click', cerrar);
  ov.addEventListener('mousedown', e => { if (e.target === ov) cerrar(); });
  setTimeout(() => ov.querySelector('#ce-nombre').focus(), 30);
  ov.querySelector('#ce-ok').addEventListener('click', async () => {
    const val = id => ov.querySelector('#' + id).value.trim();
    const nombre = val('ce-nombre');
    if (!nombre) { toast('Falta el nombre', 'err'); return; }
    const tel = val('ce-tel');
    const payload = { nombre, telefono: tel || null, whatsapp: tel || null, email: val('ce-email') || null, notas: val('ce-notas') || null };
    const btn = ov.querySelector('#ce-ok');
    btn.disabled = true;
    let res;
    if (nuevo) res = await sb.from('clientes').insert({ ...payload, organization_id: orgId, activo: true }).select('id').single();
    else res = await sb.from('clientes').update(payload).eq('id', c.id).eq('organization_id', orgId).select('id').single();
    if (res.error) { btn.disabled = false; tmvShowError(res.error, { title: 'No se pudo guardar el cliente' }); return; }
    if (nuevo && ov.querySelector('#ce-lea')?.checked) await _lealtadRegistrar({ clienteId: res.data.id });
    else toast(nuevo ? 'Cliente creado ✓' : 'Cliente actualizado ✓', 'ok');
    if (typeof _resumenCliCache !== 'undefined') _resumenCliCache.delete(res.data.id);
    cerrar();
    _cargarListaClientes();
  });
}

async function _cliCompras(c) {
  const ov = _ccModal('<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>', 480);
  const box = ov.firstElementChild;
  ov.addEventListener('mousedown', e => { if (e.target === ov) ov.remove(); });
  const { data: d, error } = await sb.rpc('pos_cliente_resumen', { p_cliente_id: c.id });
  if (!document.body.contains(ov)) return;
  const ult = d?.ultimas_entregas || [];
  box.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
      '<h3 style="margin:0;font-size:18px">' + _esc(c.nombre) + '</h3>' +
      '<button type="button" data-x style="background:none;border:0;font-size:22px;cursor:pointer;color:#64748b">×</button></div>' +
    (error ? '<div style="color:#B42318">Error: ' + _esc(error.message) + '</div>' :
      '<div class="env-kpis" style="grid-template-columns:1fr 1fr;margin-bottom:12px">' +
        '<div class="env-kpi"><div class="env-kpi-l">Compras 30 días</div><div class="env-kpi-v" style="font-size:22px">' + (d?.compras_30d || 0) + '</div></div>' +
        '<div class="env-kpi"><div class="env-kpi-l">Gastó 30 días</div><div class="env-kpi-v" style="font-size:22px">' + fmtARS(d?.monto_30d || 0) + '</div></div>' +
      '</div>' +
      (ult.length ? ult.map(e =>
        '<div style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--border);font-size:13px">' +
          '<div><div style="font-weight:600">' + new Date(e.fecha).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' }) + '</div>' +
          '<div style="font-size:12px;color:var(--muted)">' + _esc(e.items || '—') + '</div></div>' +
          '<div style="font-weight:700;white-space:nowrap">' + fmtARS(e.total) + '</div></div>').join('')
        : '<div class="env-empty">Sin compras registradas.</div>'));
  box.querySelector('[data-x]').addEventListener('click', () => ov.remove());
}

// ── Vista Lealtad: miembros + registro rápido por teléfono ──
async function _renderLealtadMiembros() {
  const wrap = document.getElementById('clientes-wrap');
  if (!wrap) return;
  const cfg = _lealtadCfg || {};
  const esAdmin = _isAdmin();
  if (!cfg.activo) {
    wrap.innerHTML =
      '<div class="env-section" style="text-align:center;padding:32px 20px">' +
        '<div style="font-size:36px">⭐</div>' +
        '<h3 style="font-size:18px;font-weight:700;color:var(--ink);text-transform:none;letter-spacing:0;margin:8px 0 6px">Programa de lealtad apagado</h3>' +
        '<p style="color:var(--muted);font-size:14px;max-width:420px;margin:0 auto 16px">Tus clientes suman puntos con cada compra y los canjean por descuentos o productos que vos elegís.</p>' +
        (esAdmin ? '<button type="button" class="cc-btn cc-btn-pri" id="lea-ir-cfg">Configurar programa</button>'
                 : '<div style="font-size:13px;color:var(--muted)">Pedile a un administrador que lo active en Configuración → Lealtad.</div>') +
      '</div>';
    wrap.querySelector('#lea-ir-cfg')?.addEventListener('click', () => { goTab('config'); _cfgShow('lealtad'); });
    return;
  }
  wrap.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';
  const { data: miembros, error } = await sb.from('pos_lealtad_miembros')
    .select('cliente_id, puntos, puntos_acumulados, created_at')
    .eq('organization_id', orgId).order('puntos', { ascending: false }).limit(500);
  if (error) { wrap.innerHTML = '<div style="color:#B42318;padding:14px">Error: ' + _esc(error.message) + '</div>'; return; }
  const ids = (miembros || []).map(m => m.cliente_id);
  const nombres = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await sb.from('clientes').select('id, nombre, telefono, whatsapp').in('id', ids.slice(i, i + 200));
    (data || []).forEach(c => nombres.set(c.id, c));
  }
  const filas = (miembros || []).map(m => ({ ...m, cli: nombres.get(m.cliente_id) || { nombre: '—' } }));
  const enCirc = filas.reduce((s, m) => s + (m.puntos || 0), 0);
  const recs = (cfg.recompensas || []).filter(r => r.activo !== false);

  wrap.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:14px">' +
      '<div><h2 style="font-size:22px;font-weight:700;letter-spacing:-.02em;margin:0">Programa de lealtad</h2>' +
      '<div style="font-size:13px;color:var(--muted);margin-top:4px">1 punto cada ' + fmtARS(cfg.pesos_por_punto) + ' de compra' +
        (cfg.puntos_bienvenida > 0 ? ' · ' + cfg.puntos_bienvenida + ' de bienvenida' : '') + '</div></div>' +
      (esAdmin ? '<button type="button" class="cc-btn" id="lea-cfg">Configurar</button>' : '') +
    '</div>' +
    '<div class="env-section">' +
      '<h3>Registrar cliente</h3>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px" class="lea-reg">' +
        '<input id="lea-tel" type="tel" placeholder="Teléfono" autocomplete="off" class="lea-in">' +
        '<input id="lea-nom" type="text" placeholder="Nombre" autocomplete="off" class="lea-in">' +
        '<button type="button" id="lea-reg" class="cc-btn cc-btn-pri">Registrar</button>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--muted);margin-top:8px">Si el teléfono ya es de un cliente, se usa ese; si no, se crea el cliente.</div>' +
    '</div>' +
    '<div class="env-kpis">' +
      '<div class="env-kpi"><div class="env-kpi-l">Miembros</div><div class="env-kpi-v">' + filas.length + '</div></div>' +
      '<div class="env-kpi"><div class="env-kpi-l">Puntos sin canjear</div><div class="env-kpi-v">' + enCirc.toLocaleString('es-AR') + '</div></div>' +
      '<div class="env-kpi"><div class="env-kpi-l">Recompensas activas</div><div class="env-kpi-v">' + recs.length + '</div></div>' +
    '</div>' +
    (recs.length ? '<div class="env-section"><h3>Recompensas</h3>' + recs.sort((a, b) => a.puntos - b.puntos).map(r =>
      '<div class="env-row"><span><b>' + _esc(r.nombre) + '</b> <span style="color:var(--muted)">· ' + _esc(_lealtadRecLabel(r)) + '</span></span><span class="env-row-cant">' + r.puntos + ' pts</span></div>').join('') + '</div>' : '') +
    '<input id="lea-q" type="search" placeholder="Buscar miembro" autocomplete="off" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:10px;font-size:14px;font-family:inherit;outline:none;margin-bottom:12px">' +
    '<div class="env-section" style="padding:0;overflow:hidden" id="lea-lista"></div>';

  const pintarLista = () => {
    const q = (wrap.querySelector('#lea-q').value || '').trim().toLowerCase();
    const lista = q ? filas.filter(m => (m.cli.nombre || '').toLowerCase().includes(q) || (m.cli.telefono || m.cli.whatsapp || '').includes(q)) : filas;
    const box = wrap.querySelector('#lea-lista');
    box.innerHTML = lista.length ? lista.map(m =>
      '<div class="cc-row" data-id="' + m.cliente_id + '">' +
        '<div class="cc-cli"><div class="cc-nm">' + _esc(m.cli.nombre) + '</div><div class="cc-sub">' + _esc(m.cli.telefono || m.cli.whatsapp || 'Sin teléfono') + ' · desde ' + new Date(m.created_at).toLocaleDateString('es-AR') + '</div></div>' +
        '<div class="cc-saldo"><b>⭐ ' + m.puntos + '</b><div class="cc-sub">' + m.puntos_acumulados + ' acumulados</div></div>' +
        '<div class="cc-acts"><button type="button" class="cc-btn" data-act="movs">Movimientos</button>' +
        (esAdmin ? '<button type="button" class="cc-btn" data-act="ajustar">Ajustar</button>' : '') + '</div></div>').join('')
      : '<div class="env-empty">' + (q ? 'Sin resultados' : 'Todavía no hay clientes en el programa. Registrá el primero arriba.') + '</div>';
    box.querySelectorAll('.cc-row').forEach(row => {
      const m = filas.find(x => x.cliente_id === row.dataset.id);
      row.querySelector('[data-act="movs"]').addEventListener('click', () => _lealtadMovimientos(m));
      row.querySelector('[data-act="ajustar"]')?.addEventListener('click', () => _lealtadAjustar(m));
    });
  };
  pintarLista();
  wrap.querySelector('#lea-q').addEventListener('input', pintarLista);
  wrap.querySelector('#lea-cfg')?.addEventListener('click', () => { goTab('config'); _cfgShow('lealtad'); });
  const reg = async () => {
    const tel = wrap.querySelector('#lea-tel').value.trim();
    const nom = wrap.querySelector('#lea-nom').value.trim();
    if (tel.replace(/\D/g, '').length < 6) { toast('Ingresá un teléfono válido', 'warn'); return; }
    const r = await _lealtadRegistrar({ telefono: tel, nombre: nom });
    if (r) _renderLealtadMiembros();
  };
  wrap.querySelector('#lea-reg').addEventListener('click', reg);
  wrap.querySelector('#lea-nom').addEventListener('keydown', e => { if (e.key === 'Enter') reg(); });
}

async function _lealtadMovimientos(m) {
  const ov = _ccModal('<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>', 480);
  const box = ov.firstElementChild;
  ov.addEventListener('mousedown', e => { if (e.target === ov) ov.remove(); });
  const { data, error } = await sb.from('pos_lealtad_movimientos')
    .select('puntos, tipo, detalle, monto, created_at, created_by_nombre')
    .eq('organization_id', orgId).eq('cliente_id', m.cliente_id)
    .order('created_at', { ascending: false }).limit(100);
  if (!document.body.contains(ov)) return;
  const tipoLbl = { bienvenida: 'Bienvenida', compra: 'Compra', canje: 'Canje', ajuste: 'Ajuste' };
  box.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
      '<h3 style="margin:0;font-size:18px">' + _esc(m.cli.nombre) + '</h3>' +
      '<button type="button" data-x style="background:none;border:0;font-size:22px;cursor:pointer;color:#64748b">×</button></div>' +
    '<div style="font-size:14px;color:var(--muted);margin-bottom:12px">Tiene <b>⭐ ' + m.puntos + ' puntos</b></div>' +
    (error ? '<div style="color:#B42318">Error: ' + _esc(error.message) + '</div>' :
      (data || []).map(r =>
        '<div style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--border);font-size:13px">' +
          '<div><div style="font-weight:600">' + (tipoLbl[r.tipo] || r.tipo) + (r.tipo === 'compra' && r.monto ? ' · ' + fmtARS(r.monto) : '') + '</div>' +
          '<div style="font-size:12px;color:var(--muted)">' + new Date(r.created_at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) +
            (r.tipo === 'canje' || r.tipo === 'ajuste' ? ' · ' + _esc(r.detalle || '') : '') + (r.created_by_nombre ? ' · ' + _esc(r.created_by_nombre) : '') + '</div></div>' +
          '<div style="font-weight:700;white-space:nowrap;color:' + (r.puntos >= 0 ? '#047857' : '#B42318') + '">' + (r.puntos >= 0 ? '+' : '') + r.puntos + '</div></div>').join('')
      || '<div class="env-empty">Sin movimientos.</div>');
  box.querySelector('[data-x]').addEventListener('click', () => ov.remove());
}

function _lealtadAjustar(m) {
  const ov = _ccModal(
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
      '<h3 style="margin:0;font-size:18px">Ajustar puntos · ' + _esc(m.cli.nombre) + '</h3>' +
      '<button type="button" data-x style="background:none;border:0;font-size:22px;cursor:pointer;color:#64748b">×</button></div>' +
    '<div style="font-size:14px;color:var(--muted);margin-bottom:10px">Tiene ' + m.puntos + ' puntos. Usá un número negativo para restar.</div>' +
    '<input id="aj-p" type="text" inputmode="numeric" placeholder="Ej: 50 o -20" class="lea-in" style="width:100%;font-size:18px">' +
    '<input id="aj-d" type="text" placeholder="Motivo (opcional)" class="lea-in" style="width:100%;margin-top:8px">' +
    '<button type="button" id="aj-ok" style="margin-top:14px;width:100%;padding:13px;border:0;border-radius:10px;background:var(--primary);color:#fff;font-size:15px;font-weight:700;cursor:pointer">Guardar ajuste</button>');
  const cerrar = () => ov.remove();
  ov.querySelector('[data-x]').addEventListener('click', cerrar);
  ov.addEventListener('mousedown', e => { if (e.target === ov) cerrar(); });
  setTimeout(() => ov.querySelector('#aj-p').focus(), 30);
  ov.querySelector('#aj-ok').addEventListener('click', async () => {
    const n = parseInt(ov.querySelector('#aj-p').value.replace(/[^\d-]/g, ''), 10);
    if (!Number.isFinite(n) || n === 0) { toast('Ingresá una cantidad de puntos', 'warn'); return; }
    const { error } = await sb.rpc('pos_lealtad_ajustar', {
      p_organization_id: orgId, p_cliente_id: m.cliente_id, p_puntos: n, p_detalle: ov.querySelector('#aj-d').value.trim() || null,
    });
    if (error) { tmvShowError(error); return; }
    toast('Puntos ajustados ✓', 'ok');
    cerrar();
    _renderLealtadMiembros();
  });
}

// ═══════════════════════════════════════════════════════════════════
// Configuración → Lealtad (solo admins)
// ═══════════════════════════════════════════════════════════════════
async function renderLealtadConfig() {
  const wrap = document.getElementById('lealtad-cfg-wrap');
  if (!wrap) return;
  if (!_isAdmin()) { wrap.innerHTML = '<div class="env-empty">Solo administradores.</div>'; return; }
  wrap.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Cargando…</div>';
  const cfg = await cargarLealtadConfig(true);
  let recs = (cfg.recompensas || []).map(r => ({ ...r }));
  if (!recs.length) recs = [{ id: _lealtadId(), nombre: 'Descuento de $1.000', puntos: 100, tipo: 'monto', valor: 1000, activo: true }];
  const prodOpts = (sel) => '<option value="">— Elegí un producto —</option>' +
    productos.filter(p => !p.es_combo).map(p => '<option value="' + p.id + '"' + (p.id === sel ? ' selected' : '') + '>' + _esc(p.nombre) + '</option>').join('');

  const filaRec = (r, i) =>
    '<div class="lea-rec-cfg" data-i="' + i + '">' +
      '<input class="lea-in" data-f="nombre" placeholder="Nombre (ej: Café gratis)" value="' + _esc(r.nombre || '') + '">' +
      '<input class="lea-in" data-f="puntos" type="text" inputmode="numeric" placeholder="Puntos" value="' + (r.puntos ?? '') + '">' +
      '<select class="lea-in" data-f="tipo">' + Object.entries(LEALTAD_TIPOS).map(([k, l]) => '<option value="' + k + '"' + (r.tipo === k ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
      (r.tipo === 'producto'
        ? '<select class="lea-in" data-f="producto_id">' + prodOpts(r.producto_id) + '</select>'
        : '<input class="lea-in" data-f="valor" type="text" inputmode="decimal" placeholder="' + (r.tipo === 'pct' ? '%' : '$') + '" value="' + (r.valor ?? '') + '">') +
      '<label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--muted)"><input type="checkbox" data-f="activo"' + (r.activo !== false ? ' checked' : '') + '>Activa</label>' +
      '<button type="button" class="cc-btn" data-del title="Quitar" style="color:#B42318">×</button>' +
    '</div>';

  const pintar = () => {
    wrap.innerHTML =
      '<div class="env-section">' +
        '<label style="display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600;cursor:pointer"><input type="checkbox" id="lc-on"' + (cfg.activo ? ' checked' : '') + ' style="width:18px;height:18px"> Programa de lealtad activo</label>' +
        '<div style="font-size:13px;color:var(--muted);margin-top:6px">Los clientes registrados suman puntos con cada compra y los canjean en la caja.</div>' +
      '</div>' +
      '<div class="env-section">' +
        '<h3>Cómo se ganan puntos</h3>' +
        '<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:end">' +
          '<label style="font-size:13px;font-weight:600">1 punto cada<br><span style="display:flex;align-items:center;gap:6px;margin-top:6px">$ <input id="lc-ppp" class="lea-in" type="text" inputmode="numeric" value="' + Math.round(cfg.pesos_por_punto || 1000) + '" style="width:120px"></span></label>' +
          '<label style="font-size:13px;font-weight:600">Puntos de bienvenida<br><input id="lc-bien" class="lea-in" type="text" inputmode="numeric" value="' + (cfg.puntos_bienvenida || 0) + '" style="width:120px;margin-top:6px"></label>' +
        '</div>' +
        '<div id="lc-ej" style="font-size:13px;color:var(--muted);margin-top:10px"></div>' +
      '</div>' +
      '<div class="env-section">' +
        '<h3>Recompensas (promos para canjear)</h3>' +
        '<div style="font-size:13px;color:var(--muted);margin-bottom:10px">Armá las promos que quieras: un descuento fijo, un porcentaje o un producto gratis, y cuántos puntos cuestan.</div>' +
        '<div id="lc-recs">' + recs.map(filaRec).join('') + '</div>' +
        '<button type="button" id="lc-add" class="cc-btn" style="margin-top:6px">+ Agregar recompensa</button>' +
      '</div>' +
      '<button type="button" id="lc-save" style="width:100%;padding:14px;border:0;border-radius:10px;background:var(--primary);color:#fff;font-size:15px;font-weight:700;cursor:pointer">Guardar programa</button>';
    const ej = () => {
      const ppp = Number(wrap.querySelector('#lc-ppp').value.replace(/\D/g, '')) || 0;
      wrap.querySelector('#lc-ej').textContent = ppp > 0 ? 'Ejemplo: una compra de ' + fmtARS(ppp * 15) + ' suma 15 puntos.' : '';
    };
    wrap.querySelector('#lc-ppp').addEventListener('input', ej); ej();
    const leer = () => {
      wrap.querySelectorAll('.lea-rec-cfg').forEach(row => {
        const r = recs[Number(row.dataset.i)];
        row.querySelectorAll('[data-f]').forEach(el => {
          const f = el.dataset.f;
          r[f] = el.type === 'checkbox' ? el.checked : el.value;
        });
      });
    };
    wrap.querySelectorAll('.lea-rec-cfg').forEach(row => {
      row.querySelector('[data-f="tipo"]').addEventListener('change', () => { leer(); pintar(); });
      row.querySelector('[data-del]').addEventListener('click', () => { leer(); recs.splice(Number(row.dataset.i), 1); pintar(); });
    });
    wrap.querySelector('#lc-add').addEventListener('click', () => { leer(); recs.push({ id: _lealtadId(), nombre: '', puntos: '', tipo: 'monto', valor: '', activo: true }); pintar(); });
    wrap.querySelector('#lc-save').addEventListener('click', async () => {
      leer();
      const limpias = [];
      for (const r of recs) {
        const nombre = String(r.nombre || '').trim();
        const puntos = parseInt(String(r.puntos).replace(/\D/g, ''), 10);
        if (!nombre && !r.puntos) continue;
        if (!nombre || !Number.isFinite(puntos) || puntos <= 0) { toast('Cada recompensa necesita nombre y puntos', 'warn'); return; }
        const out = { id: r.id || _lealtadId(), nombre, puntos, tipo: r.tipo, activo: r.activo !== false };
        if (r.tipo === 'producto') {
          if (!r.producto_id) { toast('Elegí el producto de "' + nombre + '"', 'warn'); return; }
          out.producto_id = r.producto_id;
        } else {
          const v = parseFloat(String(r.valor).replace(',', '.'));
          if (!Number.isFinite(v) || v <= 0 || (r.tipo === 'pct' && v > 100)) { toast('Valor inválido en "' + nombre + '"', 'warn'); return; }
          out.valor = v;
        }
        limpias.push(out);
      }
      const ppp = Number(wrap.querySelector('#lc-ppp').value.replace(/\D/g, ''));
      if (!ppp) { toast('Indicá cada cuántos pesos se suma 1 punto', 'warn'); return; }
      const { error } = await sb.rpc('pos_lealtad_config_set', {
        p_organization_id: orgId,
        p_activo: wrap.querySelector('#lc-on').checked,
        p_pesos_por_punto: ppp,
        p_puntos_bienvenida: parseInt(wrap.querySelector('#lc-bien').value.replace(/\D/g, ''), 10) || 0,
        p_recompensas: limpias,
      });
      if (error) { tmvShowError(error, { title: 'No se pudo guardar' }); return; }
      toast('Programa de lealtad guardado ✓', 'ok');
      await cargarLealtadConfig(true);
      if (clienteSel?.id) _lealtadRefrescarCliente();
      renderLealtadConfig();
    });
  };
  pintar();
}

function _lealtadId() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
