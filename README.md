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
- Combos, productos de peso variable, vencimientos. (La emisión de factura
  desde la venta está apagada: `FACTURACION_ON = false` en `js/pos.js`.)
- **Cuenta corriente**: pestaña con lo que deben los clientes (fiado), saldos a
  favor, registrar pagos, movimientos, límite de deuda y recordatorio por
  WhatsApp. Reemplaza al módulo de envases retornables, que queda apagado
  (`ENVASES_ON = false` en `js/pos.js`).
- **Clientes**: pestaña con la lista de clientes (búsqueda, saldo, puntos,
  vender, editar, compras) y alta de clientes.
- **Programa de lealtad**: registro por teléfono + nombre, 1 punto cada $X de
  compra, puntos de bienvenida y recompensas configurables (descuento en $, en %
  o producto gratis) que se canjean en la caja. Configuración → Lealtad. SQL en
  `sql/2026-10-05_pos_lealtad.sql`.
- **Códigos de barras**: botón "Generar" en el alta de producto y herramienta
  en Stock para generar EAN-13 internos (prefijo 20) a los productos sin código
  e imprimir etiquetas con nombre y precio.
- **Stock nunca negativo**: si se vende sin stock, queda en 0 (trigger en
  `stock_mostrador`, ver `sql/`).
- **Vuelto en efectivo**: al cobrar en efectivo se pregunta con cuánto paga y se
  muestra el vuelto (también en el recibo).
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
nombre de la **organización** (`business_name`) y de la **tienda**
(`tienda_name`), dueño, teléfono, país y `product: 'pos'` en el metadata.

La organización se crea con trial de 14 días y al usuario se le asigna
**siempre** el rol `client_admin` (administrador). El nombre de la org es
exactamente el que indicó el cliente en el signup. La provisión ocurre por
**tres vías redundantes e idempotentes** (la primera que corra gana; las demás
detectan que ya existe y no hacen nada):

1. **Trigger server-side** `trg_pos_auto_provision` sobre `auth.users`: al
   crearse una cuenta con `product='pos'` se provisiona la org + rol admin
   automáticamente, **sin depender del JavaScript del navegador** (evita que un
   front cacheado deje usuarios sin rol). No afecta a los cajeros creados por un
   admin (la edge `crear-usuario` no manda `product`) ni a Reparto/callibri.
2. **RPC en el signup**: `signup.html` llama `provision_trial_org_for_user`
   (con `p_product:'pos'`) si el proyecto auto-confirma el email.
3. **Fallback en el primer login**: `app.html`/`pos.js` detecta al usuario
   autenticado sin organización y llama la misma RPC.

El email de bienvenida se dispara una sola vez vía la edge function
`notify-signup` desde la vía que efectivamente crea la org.

## Países

El POS funciona para Argentina, México, Chile, Colombia, Perú, Uruguay y
"Otro país" (USD):

- **Registro:** el país se preselecciona (enlace de la landing, idioma o zona
  horaria del navegador). "Otro país" crea la organización con `pais = 'OT'`,
  moneda USD y la zona horaria del navegador del dueño.
- **Precios:** `pos_planes_precios` tiene los montos por país y moneda
  (`sql/2026-10-05_pos_precios_pais.sql`). La landing, el registro y Mi plan los
  leen de ahí. Los montos fuera de Argentina son equivalentes aproximados:
  revisarlos en esa tabla.
- **App:** los montos se muestran en la moneda del negocio
  (`organizations.moneda`) y los ingresos de dinero respetan su separador
  decimal; "hoy" se calcula con la zona horaria del negocio
  (`organizations.timezone`); la identificación fiscal se llama CUIT, RFC,
  RUT, NIT o RUC según el país y "Condición IVA" solo aparece en Argentina.
- **Textos:** landing, registro y login usan "tú" fuera de Argentina y Uruguay
  (`js/pais.js`). La app sigue en español rioplatense.

## Plan y cobro de la suscripción (Stripe)

Configuración → **💳 Mi plan** muestra el plan de la organización (prueba con
días restantes, plan pago, pago pendiente o vencido) y los planes de
`pos_planes`. Los administradores ven además un aviso en la barra superior
cuando quedan 7 días o menos de prueba o hay un problema de pago.

Base ya creada en Supabase (`sql/2026-10-05_pos_billing.sql`): `pos_planes`
(Mostrador / Negocio / Cadena con los precios de la landing), `pos_suscripciones`,
`pos_billing_eventos` y la RPC `pos_plan_actual`.

**Registro:** el alta pide la dirección del local y el plan (Mostrador /
Negocio / Cadena), sin tarjeta. Se guardan en el metadata del usuario y la app
los aplica al entrar (`pos_registro_completar`: dirección en `org_config` y en
la tienda, plan elegido en `pos_suscripciones` con estado `trial`). Durante la
prueba hay una banda fija "Te quedan X días gratis" y el plan elegido se puede
cambiar en Mi plan. SQL en `sql/2026-10-05_pos_promo_registro.sql`.

**Promo Mostrador:** $20.000/mes los primeros 3 meses y después $40.000, o
$240.000 pagando el año por adelantado (`precio_promo`, `meses_promo`,
`precio_anual` en `pos_planes`).

Para activar el pago con tarjeta:

1. En Stripe, crear un producto por plan con su precio mensual recurrente en
   cada moneda y cargar los ids en `pos_planes_precios` (por país:
   `stripe_price_id`, `stripe_price_id_anual`, `stripe_coupon_promo`). Para Mostrador:
   precio mensual (ej. $40.000 ARS), un cupón `amount_off` por la diferencia
   con la promo con duración "repeating" de 3 meses y un precio anual. Opcional: el
   cupón general del 50% del primer mes para los otros planes. Si la
   organización todavía está en la prueba, el primer cobro se hace al terminar
   la prueba.
2. Cargar los secrets y desplegar las edge functions de `supabase/functions/`:
   ```sh
   supabase secrets set STRIPE_SECRET_KEY=sk_... STRIPE_WEBHOOK_SECRET=whsec_... \
     APP_URL=https://pos.trackmyvend.com STRIPE_COUPON_PRIMER_MES=<cupón opcional>
   supabase functions deploy pos-billing-checkout
   supabase functions deploy pos-billing-portal
   supabase functions deploy pos-billing-webhook --no-verify-jwt
   ```
3. En Stripe → Webhooks, apuntar a `…/functions/v1/pos-billing-webhook` con los
   eventos `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.paid` e `invoice.payment_failed`.
4. Activar el portal de clientes de Stripe (Settings → Billing → Customer portal).

Apenas un plan tiene `stripe_price_id`, el botón "Elegir plan" abre Stripe
Checkout. El webhook mantiene `pos_suscripciones` y marca la organización como
paga (`organizations.plan = 'pro'`); si la suscripción se cancela o vence, la
organización vuelve a `trial` con vencimiento al fin del período pagado, y el
bloqueo existente por prueba vencida corta el acceso.

## Backend

Se conecta al proyecto Supabase **Reparto** (`zgdrvptneiwlxlaywfur`) usando la
clave pública anónima embebida en `js/pos.js` y `login.html`. El modelo es
multi-tenant por organización: el rol del usuario (`user_roles` /
`system_roles`) determina la organización, las tiendas visibles y los permisos.
Toda la lógica de negocio (ventas, caja, stock, cuenta corriente, lealtad) vive en
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
