#!/usr/bin/env python3
"""Genera la landing de cada país a partir de index.html (la de Argentina).

    python3 scripts/generar_landings.py

Escribe mx/, cl/, co/, pe/, uy/ e intl/ (index.html en cada carpeta) con:
precios y moneda del país (leídos de pos_planes_precios; si no hay conexión,
usa PRECIOS_RESPALDO), plan Gratis visible, textos con "tú" donde no se usa
el voseo, idioma y canonical del país, y rutas relativas corregidas.

Volver a correrlo cada vez que se edite index.html o cambien los precios.
"""
import json
import os
import re
import ssl
import urllib.request

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DOMINIO = 'https://pos.trackmyvend.com'
SB_URL = 'https://zgdrvptneiwlxlaywfur.supabase.co'

PAISES = {
    'MX': dict(dir='mx',   lang='es-MX', nombre='México',   moneda='MXN', moneda_nombre='pesos mexicanos',          voseo=False),
    'CL': dict(dir='cl',   lang='es-CL', nombre='Chile',    moneda='CLP', moneda_nombre='pesos chilenos',           voseo=False),
    'CO': dict(dir='co',   lang='es-CO', nombre='Colombia', moneda='COP', moneda_nombre='pesos colombianos',        voseo=False),
    'PE': dict(dir='pe',   lang='es-PE', nombre='Perú',     moneda='PEN', moneda_nombre='soles',                    voseo=False),
    'UY': dict(dir='uy',   lang='es-UY', nombre='Uruguay',  moneda='UYU', moneda_nombre='pesos uruguayos',          voseo=True),
    'OT': dict(dir='intl', lang='es',    nombre='Otros países', moneda='USD', moneda_nombre='dólares estadounidenses', voseo=False),
}

# símbolo, separador de miles, separador decimal, decimales si hay centavos
MONEDAS = {
    'MXN': ('$', ',', '.', 2), 'CLP': ('$', '.', ',', 0), 'COP': ('$', '.', ',', 0),
    'PEN': ('S/ ', ',', '.', 2), 'UYU': ('$', '.', ',', 0), 'USD': ('US$', ',', '.', 2),
}

# Copia de pos_planes_precios por si la consulta falla.
PRECIOS_RESPALDO = {
    'MX': {'mostrador': (499, None, 249, 2988, None), 'negocio': (799, 399, None, None, None), 'cadena': (1199, 599, None, None, 349)},
    'CL': {'mostrador': (26990, None, 13490, 161880, None), 'negocio': (39990, 19990, None, None, None), 'cadena': (59990, 29990, None, None, 16990)},
    'CO': {'mostrador': (119900, None, 59900, 718800, None), 'negocio': (179900, 89900, None, None, None), 'cadena': (259900, 129900, None, None, 69900)},
    'PE': {'mostrador': (109, None, 55, 660, None), 'negocio': (159, 79, None, None, None), 'cadena': (239, 119, None, None, 69)},
    'UY': {'mostrador': (1190, None, 590, 7080, None), 'negocio': (1790, 890, None, None, None), 'cadena': (2590, 1290, None, None, 690)},
    'OT': {'mostrador': (29, None, 15, 180, None), 'negocio': (45, 22, None, None, None), 'cadena': (65, 32, None, None, 18)},
}
CAMPOS = ('precio_mensual', 'precio_primer_mes', 'precio_promo', 'precio_anual', 'precio_tienda_extra')


def leer_precios():
    js = open(os.path.join(RAIZ, 'js', 'pais.js'), encoding='utf-8').read()
    key = re.search(r"SB_KEY = '([^']+)'", js).group(1)
    url = SB_URL + '/rest/v1/pos_planes_precios?select=plan_id,pais,' + ','.join(CAMPOS)
    try:
        ctx = ssl.create_default_context(cafile=os.environ.get('SSL_CERT_FILE') or None)
        req = urllib.request.Request(url, headers={'apikey': key, 'Authorization': 'Bearer ' + key})
        filas = json.load(urllib.request.urlopen(req, timeout=15, context=ctx))
        out = {}
        for f in filas:
            out.setdefault(f['pais'], {})[f['plan_id']] = {k: (float(f[k]) if f[k] is not None else None) for k in CAMPOS}
        print('Precios leídos de pos_planes_precios')
        return out
    except Exception as e:  # sin conexión: copia local
        print('No se pudo leer la base (%s): uso PRECIOS_RESPALDO' % e)
        return {p: {plan: dict(zip(CAMPOS, v)) for plan, v in planes.items()} for p, planes in PRECIOS_RESPALDO.items()}


def fmt(n, moneda):
    if n is None:
        return ''
    sim, miles, dec, ndec = MONEDAS[moneda]
    n = float(n)
    d = ndec if ndec and round(n * 100) % 100 else 0
    entero, _, frac = ('%.*f' % (d, n)).partition('.')
    entero = '{:,}'.format(int(entero)).replace(',', miles)
    return sim + entero + (dec + frac if frac else '')


def leer_tuteo():
    js = open(os.path.join(RAIZ, 'js', 'pais.js'), encoding='utf-8').read()
    bloque = js[js.index('const TUTEO = {'):js.index('};', js.index('const TUTEO = {'))]
    return dict(re.findall(r"'([^']+)':\s*'([^']+)'", bloque))


LETRA = 'A-Za-zÁÉÍÓÚÜÑáéíóúüñ'


def tutear_texto(txt, tuteo, patron):
    def r(m):
        w = m.group(0)
        t = tuteo[w.lower()]
        return t[0].upper() + t[1:] if w[0].isupper() else t
    return patron.sub(r, txt)


def tutear_html(html, tuteo):
    patron = re.compile(r'(?<![%s])(%s)(?![%s])' % (LETRA, '|'.join(sorted(map(re.escape, tuteo), key=len, reverse=True)), LETRA), re.I)
    partes = re.split(r'(<script\b.*?</script>|<style\b.*?</style>|<[^>]+>)', html, flags=re.S)
    out = []
    for p in partes:
        if p.startswith('<'):
            # textos visibles en atributos: content, alt, title, aria-label, placeholder
            p = re.sub(r'\b(content|alt|title|aria-label|placeholder)="([^"]*)"',
                       lambda m: '%s="%s"' % (m.group(1), tutear_texto(m.group(2), tuteo, patron)), p) \
                if not p.startswith(('<script', '<style')) else p
            out.append(p)
        else:
            out.append(tutear_texto(p, tuteo, patron))
    return ''.join(out)


def poner(html, clave, valor):
    """Reemplaza el contenido de los elementos con data-pp="clave"."""
    return re.sub(r'(data-pp="%s"[^>]*>)[^<]*(<)' % re.escape(clave), lambda m: m.group(1) + valor + m.group(2), html)


def rutas_relativas(html):
    def r(m):
        attr, val = m.group(1), m.group(2)
        if re.match(r'^(https?:|//|#|/|mailto:|tel:|data:|\.\./)', val):
            return m.group(0)
        if val.startswith('./'):
            val = val[2:]
        return '%s="../%s"' % (attr, val)
    return re.sub(r'\b(href|src)="([^"]*)"', r, html)


def generar(base, pais, cfg, precios, tuteo):
    h = base
    pr = precios.get(pais, {})
    m, n, c = pr.get('mostrador', {}), pr.get('negocio', {}), pr.get('cadena', {})
    f = lambda v: fmt(v, cfg['moneda'])

    h = h.replace('<html lang="es-AR" data-pais="AR">', '<html lang="%s" data-pais="%s">' % (cfg['lang'], pais))
    h = h.replace('<link rel="canonical" href="%s/">' % DOMINIO, '<link rel="canonical" href="%s/%s/">' % (DOMINIO, cfg['dir']))
    # Plan Gratis visible y grilla de 4 columnas
    h = h.replace('<div class="price" id="price-gratis" hidden>', '<div class="price" id="price-gratis">')
    h = h.replace('<div class="price-grid">', '<div class="price-grid con-gratis">')
    h = h.replace('<span id="eyebrow-txt">14 días de prueba · sin tarjeta</span>', '<span id="eyebrow-txt">Plan gratis para siempre · sin tarjeta</span>')
    h = re.sub(r'<p data-pp-texto>.*?</p>',
               '<p data-pp-texto>Plan Gratis para siempre, o 14 días de prueba de los planes pagos. Todo sin tarjeta. '
               'En Mostrador, promo: <span data-pp="intro">%s</span> por mes los primeros 3 meses.</p>' % f(m.get('precio_promo')), h, flags=re.S)
    h = h.replace('14 días de prueba sin tarjeta.">', 'Plan gratis para siempre, sin tarjeta.">', 1)
    h = h.replace('<p>No. Al registrarte elegís el plan, pero no te pedimos tarjeta: tenés 14 días de prueba completa gratis. Recién al terminar la prueba cargás el medio de pago.</p>',
                  '<p>No. El plan Gratis es para siempre y sin tarjeta. Los planes pagos tienen 14 días de prueba completa: si al terminar no pagás, seguís en Gratis.</p>')
    # Precios
    for clave, valor in {
        'moneda': 'Precios en %s (%s), por mes.' % (cfg['moneda_nombre'], cfg['moneda']),
        'mostrador-promo': f(m.get('precio_promo')), 'mostrador-promo2': f(m.get('precio_promo')),
        'mostrador-mensual': f(m.get('precio_mensual')), 'mostrador-anual': f(m.get('precio_anual')),
        'negocio-mensual': f(n.get('precio_mensual')), 'negocio-primer': f(n.get('precio_primer_mes')),
        'cadena-mensual': f(c.get('precio_mensual')), 'cadena-extra': f(c.get('precio_tienda_extra')),
    }.items():
        h = poner(h, clave, valor)
    # Registro con el país de la página
    h = h.replace('signup.html?pais=AR"', 'signup.html?pais=%s"' % pais).replace('&amp;pais=AR"', '&amp;pais=%s"' % pais)
    h = h.replace('<a href="./?pais=AR" data-pais-link="AR" aria-current="page">', '<a href="./?pais=AR" data-pais-link="AR">')
    h = h.replace('data-pais-link="%s">' % pais, 'data-pais-link="%s" aria-current="page">' % pais)
    if not cfg['voseo']:
        h = tutear_html(h, tuteo)
    h = rutas_relativas(h)
    h = h.replace('<!-- hreflang:inicio -->', '<!-- Generado por scripts/generar_landings.py desde index.html: no editar a mano. -->\n<!-- hreflang:inicio -->', 1)
    destino = os.path.join(RAIZ, cfg['dir'])
    os.makedirs(destino, exist_ok=True)
    open(os.path.join(destino, 'index.html'), 'w', encoding='utf-8').write(h)
    print('  %s/index.html (%s, %s)' % (cfg['dir'], cfg['nombre'], cfg['moneda']))


def main():
    base = open(os.path.join(RAIZ, 'index.html'), encoding='utf-8').read()
    precios = leer_precios()
    tuteo = leer_tuteo()
    for pais, cfg in PAISES.items():
        generar(base, pais, cfg, precios, tuteo)


if __name__ == '__main__':
    main()
