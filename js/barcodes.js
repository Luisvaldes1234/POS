// ═══════════════════════════════════════════════════════════════════
// Generador de códigos de barras + impresión de etiquetas.
//
// Para productos que no traen código: se genera un EAN-13 interno con
// prefijo 20 (rango reservado para uso dentro del comercio, no choca con
// códigos de fábrica). Se guarda en productos.codigo_barra, así el scanner
// lo encuentra como cualquier otro. Las etiquetas se dibujan con JsBarcode
// (EAN-13 si el código lo es, Code 128 para cualquier otro).
// ═══════════════════════════════════════════════════════════════════

const JSBARCODE_URL = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';
let _jsBarcodeP = null;
function _cargarJsBarcode() {
  if (window.JsBarcode) return Promise.resolve();
  if (_jsBarcodeP) return _jsBarcodeP;
  _jsBarcodeP = new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = JSBARCODE_URL;
    s.onload = () => ok();
    s.onerror = () => { _jsBarcodeP = null; ko(new Error('No se pudo cargar el generador de códigos (¿sin conexión?)')); };
    document.head.appendChild(s);
  });
  return _jsBarcodeP;
}

function _ean13CheckDigit(d12) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(d12[i]) * (i % 2 ? 3 : 1);
  return String((10 - (s % 10)) % 10);
}
function _esEan13(code) {
  return /^\d{13}$/.test(code || '') && _ean13CheckDigit(code.slice(0, 12)) === code[12];
}

// Genera un EAN-13 interno (20 + 10 dígitos + verificador) que no esté en uso.
async function _bcGenerarUnico(usados) {
  usados = usados || new Set(productos.map(p => p.codigo_barra).filter(Boolean));
  for (let intento = 0; intento < 20; intento++) {
    const base = '20' + String(Date.now() % 1e6).padStart(6, '0') + String(Math.floor(Math.random() * 1e4)).padStart(4, '0');
    const code = base + _ean13CheckDigit(base);
    if (usados.has(code)) continue;
    // También contra productos inactivos (que no están cargados en memoria).
    const { data } = await sb.from('productos').select('id').eq('organization_id', orgId).eq('codigo_barra', code).limit(1);
    if (data && data.length) continue;
    usados.add(code);
    return code;
  }
  throw new Error('No se pudo generar un código único, probá de nuevo');
}

// Botón "Generar" del formulario de producto.
window._bcGenerarEnForm = async () => {
  const inp = document.getElementById('prod-barcode');
  if (!inp) return;
  if (inp.value.trim() && !confirm('Este producto ya tiene código. ¿Reemplazarlo por uno nuevo?')) return;
  try {
    inp.value = await _bcGenerarUnico();
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    toast('Código generado: ' + inp.value + ' — guardá el producto para que quede', 'ok');
  } catch (e) { toast(e.message, 'err'); }
};

function _bcSvg(code, opts) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const formato = _esEan13(code) ? 'EAN13' : 'CODE128';
  window.JsBarcode(svg, code, Object.assign({
    format: formato, width: 2, height: 50, fontSize: 14, margin: 0, displayValue: true,
    font: 'monospace', textMargin: 2, flat: formato === 'EAN13' ? false : true,
  }, opts || {}));
  return svg;
}

// ── Modal "Códigos de barras" (desde Stock) ──
window.abrirCodigosBarras = async () => {
  try { await _cargarJsBarcode(); } catch (e) { toast(e.message, 'err'); return; }
  const puedeEditar = _canAjustarStock();
  let filtro = 'sin';         // 'sin' | 'todos'
  let busca = '';
  const sel = new Map();      // producto_id → copias
  let tam = 'chica';
  let conPrecio = true;

  const ov = _ccModal('', 720);
  const box = ov.firstElementChild;
  const cerrar = () => ov.remove();
  ov.addEventListener('mousedown', e => { if (e.target === ov) cerrar(); });

  const pintar = () => {
    const base = productos.filter(p => !p.es_combo);
    const sinCod = base.filter(p => !p.codigo_barra);
    const q = busca.trim().toLowerCase();
    let lista = filtro === 'sin' ? sinCod : base;
    if (q) lista = lista.filter(p => (p.nombre || '').toLowerCase().includes(q) || (p.codigo_barra || '').includes(q));
    lista = lista.slice(0, 300);
    const selSinCod = [...sel.keys()].filter(id => !productos.find(p => p.id === id)?.codigo_barra);
    box.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">' +
        '<h3 style="margin:0;font-size:18px">🏷 Códigos de barras y etiquetas</h3>' +
        '<button type="button" data-x style="background:none;border:0;font-size:22px;cursor:pointer;color:#64748b">×</button></div>' +
      '<div style="font-size:13px;color:var(--muted);margin-bottom:12px">Generá un código para lo que no trae y imprimí etiquetas para pegar. ' +
        sinCod.length + ' producto' + (sinCod.length === 1 ? '' : 's') + ' sin código.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">' +
        '<input id="bc-q" type="search" placeholder="Buscar producto" value="' + _esc(busca) + '" autocomplete="off" class="lea-in" style="flex:1;min-width:180px">' +
        '<div class="env-period" style="margin:0">' +
          '<button type="button" data-f="sin" class="' + (filtro === 'sin' ? 'active' : '') + '">Sin código</button>' +
          '<button type="button" data-f="todos" class="' + (filtro === 'todos' ? 'active' : '') + '">Todos</button>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);padding:0 4px 6px">' +
        '<label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="bc-all"> Seleccionar todos (' + lista.length + ')</label><span>Copias</span></div>' +
      '<div style="max-height:44vh;overflow:auto;border:1px solid var(--border);border-radius:10px">' +
        (lista.length ? lista.map(p =>
          '<div class="bc-row">' +
            '<label style="display:flex;gap:10px;align-items:center;min-width:0;flex:1;cursor:pointer"><input type="checkbox" data-sel="' + p.id + '"' + (sel.has(p.id) ? ' checked' : '') + '>' +
            '<span style="min-width:0"><span style="display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + _esc(p.nombre) + '</span>' +
            '<span style="font-size:12px;color:' + (p.codigo_barra ? 'var(--muted)' : '#B45309') + ';font-family:monospace">' + (p.codigo_barra ? _esc(p.codigo_barra) : 'sin código') + '</span></span></label>' +
            '<input type="number" min="1" max="200" data-cop="' + p.id + '" value="' + (sel.get(p.id) || 1) + '" class="lea-in" style="width:70px;text-align:center">' +
          '</div>').join('')
          : '<div class="env-empty">' + (filtro === 'sin' && !q ? '¡Todos tus productos tienen código! 🎉' : 'Sin resultados') + '</div>') +
      '</div>' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin:12px 0;font-size:13px">' +
        '<label>Tamaño <select id="bc-tam" class="lea-in" style="padding:6px 8px">' +
          '<option value="chica"' + (tam === 'chica' ? ' selected' : '') + '>Chica (40×25 mm)</option>' +
          '<option value="grande"' + (tam === 'grande' ? ' selected' : '') + '>Grande (60×35 mm)</option></select></label>' +
        '<label style="display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="bc-precio"' + (conPrecio ? ' checked' : '') + '> Mostrar precio</label>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        (puedeEditar ? '<button type="button" id="bc-gen" class="cc-btn"' + (selSinCod.length ? '' : ' disabled') + ' style="flex:1">Generar código a ' + selSinCod.length + ' sin código</button>' : '') +
        '<button type="button" id="bc-print" class="cc-btn cc-btn-pri" style="flex:1"' + (sel.size ? '' : ' disabled') + '>Imprimir etiquetas (' + [...sel.values()].reduce((a, b) => a + b, 0) + ')</button>' +
      '</div>' +
      (puedeEditar ? '' : '<div style="font-size:12px;color:var(--muted);margin-top:8px">Para generar códigos necesitás permiso para editar productos.</div>');

    box.querySelector('[data-x]').addEventListener('click', cerrar);
    const q2 = box.querySelector('#bc-q');
    q2.addEventListener('input', () => { busca = q2.value; const pos = q2.selectionStart; pintar(); const n = box.querySelector('#bc-q'); n.focus(); try { n.setSelectionRange(pos, pos); } catch (_) {} });
    box.querySelectorAll('[data-f]').forEach(b => b.addEventListener('click', () => { filtro = b.dataset.f; pintar(); }));
    box.querySelectorAll('[data-sel]').forEach(cb => cb.addEventListener('change', () => {
      const id = cb.dataset.sel;
      if (cb.checked) sel.set(id, Number(box.querySelector('[data-cop="' + id + '"]').value) || 1); else sel.delete(id);
      pintar();
    }));
    box.querySelectorAll('[data-cop]').forEach(inp => inp.addEventListener('change', () => {
      const id = inp.dataset.cop;
      const n = Math.max(1, Math.min(200, parseInt(inp.value, 10) || 1));
      sel.set(id, n);
      pintar();
    }));
    box.querySelector('#bc-all')?.addEventListener('change', e => {
      lista.forEach(p => { if (e.target.checked) sel.set(p.id, sel.get(p.id) || 1); else sel.delete(p.id); });
      pintar();
    });
    box.querySelector('#bc-tam').addEventListener('change', e => { tam = e.target.value; });
    box.querySelector('#bc-precio').addEventListener('change', e => { conPrecio = e.target.checked; });

    box.querySelector('#bc-gen')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = 'Generando…';
      const usados = new Set(productos.map(p => p.codigo_barra).filter(Boolean));
      let ok = 0, fail = 0;
      for (const id of selSinCod) {
        try {
          const code = await _bcGenerarUnico(usados);
          const { error } = await sb.from('productos').update({ codigo_barra: code }).eq('id', id).eq('organization_id', orgId);
          if (error) throw error;
          const p = productos.find(x => x.id === id);
          if (p) p.codigo_barra = code;
          ok++;
        } catch (err) { console.warn('generar código:', err); fail++; }
      }
      toast(ok ? '✓ ' + ok + ' código' + (ok > 1 ? 's' : '') + ' generado' + (ok > 1 ? 's' : '') + (fail ? ' · ' + fail + ' con error' : '') : 'No se pudieron generar los códigos', ok ? 'ok' : 'err');
      if (typeof renderProductGrid === 'function') renderProductGrid();
      if (typeof renderStock === 'function') renderStock();
      filtro = 'todos';
      pintar();
    });

    box.querySelector('#bc-print')?.addEventListener('click', () => {
      const faltan = [...sel.keys()].filter(id => !productos.find(p => p.id === id)?.codigo_barra);
      if (faltan.length) { toast(faltan.length + ' producto(s) seleccionados no tienen código: generalo primero', 'warn'); return; }
      _bcImprimir([...sel.entries()].map(([id, copias]) => ({ p: productos.find(x => x.id === id), copias })), tam, conPrecio);
    });
  };
  pintar();
};

function _bcImprimir(items, tam, conPrecio) {
  const dims = tam === 'grande' ? { w: 60, h: 35, bh: 48, fs: 11 } : { w: 40, h: 25, bh: 32, fs: 9 };
  let html = '<div class="sheet">';
  items.forEach(({ p, copias }) => {
    if (!p) return;
    let svg;
    try { svg = _bcSvg(p.codigo_barra, { height: dims.bh, fontSize: dims.fs + 2, width: tam === 'grande' ? 2 : 1.4 }); }
    catch (e) { toast('Código inválido en ' + p.nombre + ': ' + p.codigo_barra, 'err'); return; }
    const svgStr = svg.outerHTML;
    const lbl =
      '<div class="lbl">' +
        '<div class="nm">' + _esc(p.nombre) + '</div>' +
        '<div class="bc">' + svgStr + '</div>' +
        (conPrecio ? '<div class="pr">' + fmtARS(p.precio) + '</div>' : '') +
      '</div>';
    for (let i = 0; i < copias; i++) html += lbl;
  });
  html += '</div>';
  const css =
    'body{margin:0}' +
    '.sheet{display:flex;flex-wrap:wrap;gap:2mm}' +
    '.lbl{width:' + dims.w + 'mm;height:' + dims.h + 'mm;border:0.2mm dashed #cbd5e1;padding:1.5mm;display:flex;flex-direction:column;align-items:center;justify-content:space-between;overflow:hidden;page-break-inside:avoid;break-inside:avoid}' +
    '.nm{font-size:' + dims.fs + 'px;font-weight:700;text-align:center;line-height:1.1;max-height:2.3em;overflow:hidden;width:100%}' +
    '.bc{flex:1;display:flex;align-items:center;justify-content:center;width:100%;min-height:0}' +
    '.bc svg{max-width:100%;max-height:100%;height:auto}' +
    '.pr{font-size:' + (dims.fs + 3) + 'px;font-weight:800}' +
    '@media print{.lbl{border-color:transparent}@page{margin:5mm}}';
  imprimirEnIframe('Etiquetas', html, css);
}
