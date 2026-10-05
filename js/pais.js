// ═══════════════════════════════════════════════════════════════════
// País del visitante en las páginas públicas (landing, registro, login).
//
// - detectarPais(): ?pais=XX → elección guardada → idioma del navegador →
//   zona horaria → 'AR'.
// - Precios por país: se leen de pos_planes_precios (Supabase, lectura
//   pública); si no hay conexión se usa la copia de PRECIOS_RESPALDO.
// - Tuteo: fuera de Argentina y Uruguay los textos con voseo ("cobrá",
//   "tenés") pasan a "tú" ("cobra", "tienes").
// ═══════════════════════════════════════════════════════════════════
(function () {
  const SB_URL = 'https://zgdrvptneiwlxlaywfur.supabase.co';
  const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpnZHJ2cHRuZWl3bHhsYXl3ZnVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ5NDU4NDgsImV4cCI6MjA5MDUyMTg0OH0.r1BR_OruT95Ks_xdkvlnuSqT8Lm-Vh6usJhgdLcV_Ig';

  const PAISES = {
    AR: { nombre: 'Argentina', moneda: 'ARS', monedaNombre: 'pesos argentinos', voseo: true,  tel: '+54 9 11 1234 5678' },
    MX: { nombre: 'México',    moneda: 'MXN', monedaNombre: 'pesos mexicanos',  voseo: false, tel: '+52 55 1234 5678' },
    CL: { nombre: 'Chile',     moneda: 'CLP', monedaNombre: 'pesos chilenos',   voseo: false, tel: '+56 9 1234 5678' },
    CO: { nombre: 'Colombia',  moneda: 'COP', monedaNombre: 'pesos colombianos',voseo: false, tel: '+57 300 123 4567' },
    PE: { nombre: 'Perú',      moneda: 'PEN', monedaNombre: 'soles',            voseo: false, tel: '+51 912 345 678' },
    UY: { nombre: 'Uruguay',   moneda: 'UYU', monedaNombre: 'pesos uruguayos',  voseo: true,  tel: '+598 94 123 456' },
    OT: { nombre: 'Otro país', moneda: 'USD', monedaNombre: 'dólares estadounidenses', voseo: false, tel: '+1 555 123 4567' },
  };

  const MONEDAS = {
    ARS: { sim: '$',   loc: 'es-AR', dec: 0 }, MXN: { sim: '$',   loc: 'es-MX', dec: 2 },
    CLP: { sim: '$',   loc: 'es-CL', dec: 0 }, COP: { sim: '$',   loc: 'es-CO', dec: 0 },
    PEN: { sim: 'S/ ', loc: 'es-PE', dec: 2 }, UYU: { sim: '$',   loc: 'es-UY', dec: 0 },
    USD: { sim: 'US$', loc: 'en-US', dec: 2 },
  };

  // Copia de pos_planes_precios (sql/2026-10-05_pos_precios_pais.sql) por si
  // la consulta falla. La fuente de verdad es la tabla.
  // [mensual, primer_mes, promo, meses_promo, anual, tienda_extra]
  const PRECIOS_RESPALDO = {
    AR: { mostrador: [40000, null, 20000, 3, 240000, null], negocio: [60000, 30000], cadena: [90000, 45000, null, null, null, 24900] },
    MX: { mostrador: [499, null, 249, 3, 2988, null],       negocio: [799, 399],     cadena: [1199, 599, null, null, null, 349] },
    CL: { mostrador: [26990, null, 13490, 3, 161880, null], negocio: [39990, 19990], cadena: [59990, 29990, null, null, null, 16990] },
    CO: { mostrador: [119900, null, 59900, 3, 718800, null],negocio: [179900, 89900],cadena: [259900, 129900, null, null, null, 69900] },
    PE: { mostrador: [109, null, 55, 3, 660, null],         negocio: [159, 79],      cadena: [239, 119, null, null, null, 69] },
    UY: { mostrador: [1190, null, 590, 3, 7080, null],      negocio: [1790, 890],    cadena: [2590, 1290, null, null, null, 690] },
    OT: { mostrador: [29, null, 15, 3, 180, null],          negocio: [45, 22],       cadena: [65, 32, null, null, null, 18] },
  };

  const TZ_PAIS = [
    [/^America\/Argentina\//, 'AR'], [/^America\/(Mexico_City|Cancun|Merida|Monterrey|Chihuahua|Hermosillo|Mazatlan|Tijuana|Matamoros|Ojinaga|Bahia_Banderas)$/, 'MX'],
    [/^(America\/Santiago|America\/Punta_Arenas|Pacific\/Easter)$/, 'CL'], [/^America\/Bogota$/, 'CO'],
    [/^America\/Lima$/, 'PE'], [/^America\/Montevideo$/, 'UY'],
  ];

  function detectarPais() {
    const url = (new URLSearchParams(location.search).get('pais') || '').toUpperCase();
    if (PAISES[url]) { guardar(url); return url; }
    try { const g = localStorage.getItem('pos_pais'); if (PAISES[g]) return g; } catch (_) {}
    for (const l of (navigator.languages || [navigator.language || ''])) {
      const m = String(l).match(/^es-([A-Z]{2})$/i);
      if (m && PAISES[m[1].toUpperCase()]) return m[1].toUpperCase();
    }
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      for (const [re, p] of TZ_PAIS) if (re.test(tz)) return p;
      if (tz && !/^America\//.test(tz)) return 'OT';
    } catch (_) {}
    return 'AR';
  }
  function guardar(p) { try { localStorage.setItem('pos_pais', p); } catch (_) {} }

  function fmt(n, moneda) {
    const m = MONEDAS[moneda] || MONEDAS.ARS;
    const v = Number(n || 0);
    const dec = m.dec && Math.round(v * 100) % 100 !== 0 ? m.dec : 0;
    return m.sim + v.toLocaleString(m.loc, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  }

  function respaldo(pais) {
    const r = PRECIOS_RESPALDO[pais] || PRECIOS_RESPALDO.AR;
    const out = {};
    for (const [plan, a] of Object.entries(r)) {
      out[plan] = { moneda: PAISES[pais].moneda, precio_mensual: a[0], precio_primer_mes: a[1] ?? null,
        precio_promo: a[2] ?? null, meses_promo: a[3] ?? null, precio_anual: a[4] ?? null, precio_tienda_extra: a[5] ?? null };
    }
    return out;
  }

  const _cache = {};
  async function precios(pais) {
    if (_cache[pais]) return _cache[pais];
    try {
      const r = await fetch(SB_URL + '/rest/v1/pos_planes_precios?select=plan_id,moneda,precio_mensual,precio_primer_mes,precio_promo,meses_promo,precio_anual,precio_tienda_extra&pais=eq.' + pais,
        { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } });
      if (!r.ok) throw new Error(r.status);
      const filas = await r.json();
      if (!filas.length) throw new Error('vacío');
      const out = {};
      filas.forEach(f => { out[f.plan_id] = f; });
      return (_cache[pais] = out);
    } catch (_) {
      return (_cache[pais] = respaldo(pais));
    }
  }

  // Voseo → tuteo (palabras completas, respetando mayúscula inicial).
  const TUTEO = {
    'abrí': 'abre', 'agregá': 'agrega', 'cargá': 'carga', 'cobrá': 'cobra', 'creá': 'crea', 'escaneá': 'escanea',
    'generá': 'genera', 'generalo': 'genéralo', 'ingresás': 'ingresas', 'mirá': 'mira', 'pagás': 'pagas',
    'podés': 'puedes', 'probalo': 'pruébalo', 'probá': 'prueba', 'registrás': 'registras', 'vendé': 'vende',
    'armás': 'armas', 'cargás': 'cargas', 'cerrá': 'cierra', 'controlá': 'controla', 'elegís': 'eliges',
    'entendé': 'entiende', 'entregá': 'entrega', 'envialo': 'envíalo', 'escaneás': 'escaneas', 'generás': 'generas',
    'imprimí': 'imprime', 'imprimís': 'imprimes', 'sabé': 'sabe', 'tenés': 'tienes', 'vos': 'tú', 'elegí': 'elige',
    'iniciá': 'inicia', 'aceptás': 'aceptas', 'empezá': 'empieza', 'registrate': 'regístrate', 'creálos': 'créalos',
    'querés': 'quieres', 'necesitás': 'necesitas', 'sabés': 'sabes', 'usás': 'usas', 'escribinos': 'escríbenos',
    'seguís': 'sigues', 'pasate': 'pásate', 'elegí': 'elige',
  };
  const RE_TUTEO = new RegExp('(^|[^\\p{L}])(' + Object.keys(TUTEO).join('|') + ')(?=$|[^\\p{L}])', 'giu');
  function tutear(txt) {
    return txt.replace(RE_TUTEO, (m, pre, w) => {
      const t = TUTEO[w.toLowerCase()];
      return pre + (w[0] === w[0].toUpperCase() ? t[0].toUpperCase() + t.slice(1) : t);
    });
  }
  function aplicarTuteo(root) {
    const walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: n => (n.parentElement && /^(SCRIPT|STYLE)$/.test(n.parentElement.tagName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const nodos = [];
    while (walker.nextNode()) nodos.push(walker.currentNode);
    nodos.forEach(n => { const t = tutear(n.nodeValue); if (t !== n.nodeValue) n.nodeValue = t; });
    (root || document).querySelectorAll('[placeholder]').forEach(el => {
      el.placeholder = tutear(el.placeholder.replace(/^vos@/, 'tu@'));
    });
    document.title = tutear(document.title);
  }

  window.PosPais = { PAISES, detectarPais, guardar, fmt, precios, aplicarTuteo, tutear };
})();
