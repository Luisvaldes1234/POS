# POS Mostrador

Punto de venta (POS) en mostrador, **especializado para tiendas de abarrotes,
ferreterías, kioscos** y comercios de venta directa. Recrea, en su propio
apartado e independiente, todas las funciones del POS de mostrador del sistema
de Reparto, reutilizando el mismo backend de Supabase.

Es una **PWA en JavaScript vanilla** (sin framework ni build step): se sirve
como archivos estáticos y se conecta directo a Supabase desde el navegador.

## Funciones

- **Venta rápida**: catálogo en grilla o lista, búsqueda fuzzy multi-palabra,
  **scanner de código de barras** (USB o captura global de teclado), atajos de
  teclado (F1–F12), productos favoritos.
- **Carrito y cobro**: efectivo, transferencia, MercadoPago (QR escaneable con
  polling), débito, crédito (con recargo por cuotas configurable), cuenta
  corriente y **cobro mixto** (combinar métodos).
- **Clientes**: venta a "Mostrador" por defecto o a cliente real con historial,
  saldo de cuenta corriente, alta de cliente inline con geocoder (Mapbox +
  Nominatim) y tarifas/listas de precios.
- **Promos**: NxM (2x1, 3x2), precio fijo por cantidad, % off por volumen.
- **Reservas / prepagos**: tomar pedido sin cobrar; entregas parciales con vale
  de precio congelado.
- **Caja diaria**: apertura/cierre con arrastre, ingresos/egresos, cajón
  monedero (Web Serial), reportes X / Z / cierre del día, corte global y
  reportes históricos por cajero/producto/día.
- **Stock**: stock por tienda, carga en bulk, reposición/ajuste con origen
  (compra, depósito, otra tienda, vehículo), bloqueo por stock insuficiente.
- **Devoluciones y anulaciones** parciales o totales con reembolso.
- **Facturación** (borrador + emisión vía edge function), combos, productos de
  peso variable, vencimientos.
- **Envases retornables / comodato**: soporte completo heredado del sistema de
  Reparto. En comercios sin envases retornables, el módulo se auto-oculta.
- **Multi-tienda**, configuración de recibo (58/80mm/A4, datos fiscales,
  footer), impresión por iframe (compatible con iOS/PWA), bloqueo por
  inactividad y soporte offline básico vía service worker.

## Estructura

```
index.html              Landing pública (presenta las funciones)
signup.html             Registro / alta de cuenta (Supabase Auth + trial)
login.html              Acceso (Supabase Auth)
app.html                Shell del POS (markup + estilos)
js/pos.js               Toda la lógica del POS
js/config.js            Config de runtime (token de Mapbox opcional)
js/shared/dialogs.js    Modales de confirmación (tmvDialog)
js/shared/errors.js     Presentación de errores (tmvShowError)
js/sentry-init.js       Stub de telemetría (sin envío por defecto)
manifest.webmanifest    PWA manifest (start_url = app.html)
sw.js                   Service worker (cache shell + offline)
icon.svg                Ícono de la app
```

## Roles, permisos y administración

- **Cajero** (`client_pos`): solo vende. Ve la pantalla de venta, ventas del
  día, caja y reservas. El stock lo ve en **modo lectura** (las ventas igual lo
  descuentan). No ve costos, márgenes ni finanzas.
- **Administrador** (`client_admin`): acceso total. La gestión vive en la
  pestaña **⚙️ Configuración** (solo admins), con sub-secciones: **Usuarios,
  Tiendas, Ticket, Promos, Cuotas y MercadoPago**. Además gestiona:
  - **Usuarios**: crear cajeros/administradores y darlos de alta/baja
    (Configuración → Usuarios → RPC `pos_listar_usuarios` /
    `pos_set_usuario_activo` + edge function `crear-usuario`).
  - **Stock**: reponer, cargar mercadería, ajustar, **agregar y dar de baja
    productos** (reversible) — todo desde la pestaña *Stock*.
  - **Costo y margen**: al alta/edición de producto se carga el **costo**
    (columna `productos.costo`, aditiva) y se calcula margen/ganancia. Solo
    visible para administradores.
  - **Finanzas** (pestaña *Finanzas*): ventas por método, costo de mercadería
    vendida, margen bruto, gastos, otros ingresos, movimientos de caja y
    resultado neto del período. Lectura compuesta sobre `pos_get_ventas_rango`,
    `gastos` e `ingresos` (no modifica funciones existentes).

El **scanner de código de barras** funciona con una sola barra: al escanear se
agrega el producto al carrito al instante, sin necesidad de enfocar ningún
campo.

## Registro (sign up) y provisión de cuenta

`signup.html` crea el usuario con **Supabase Auth** (`signUp`) guardando el
nombre del negocio, dueño, teléfono y país en el metadata. La organización se
crea con la RPC **`provision_trial_org_for_user`** (trial de 14 días, rol
`client_admin`), que también dispara el email de bienvenida vía la edge
function `notify-signup`.

- Si el proyecto auto-confirma el email, se provisiona y entra directo al POS.
- Si requiere confirmación, se provisiona en el primer ingreso: `app.html`
  detecta al usuario autenticado sin organización y llama a la RPC
  automáticamente (es idempotente).

## Backend

Se conecta al proyecto Supabase **Reparto** (`zgdrvptneiwlxlaywfur`) usando la
clave pública anónima embebida en `js/pos.js` y `login.html`. El modelo es
multi-tenant por organización: el rol del usuario (`user_roles` /
`system_roles`) determina la organización, las tiendas visibles y los permisos.
Toda la lógica de negocio (ventas, caja, stock, envases, facturación) vive en
RPCs de Postgres (`pos_registrar_venta`, `pos_abrir_caja`, etc.) y edge
functions (`mp-crear-cobro`, `emitir-factura`, …) ya existentes.

Roles aceptados para usar el POS: `client_pos`, `client_admin`,
`account_manager` y `super_admin`. Las pestañas de administración (Tiendas,
Cuotas, Promos) solo se muestran a administradores.

## Despliegue

Subir los archivos a cualquier hosting estático (o servir el directorio). Al
ser una PWA se puede "Instalar" desde el navegador en tablets de mostrador.
Para correr local:

```bash
python3 -m http.server 8080
# abrir http://localhost:8080/         (landing)
#        http://localhost:8080/signup.html  (crear cuenta)
#        http://localhost:8080/app.html     (POS, requiere sesión)
```

> Nota: el scanner de código de barras y el cajón monedero (Web Serial)
> requieren contexto seguro (HTTPS o localhost) y navegador compatible
> (Chrome/Edge desktop para Web Serial).
