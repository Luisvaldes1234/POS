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
index.html              Shell del POS (markup + estilos)
login.html              Acceso (Supabase Auth)
js/pos.js               Toda la lógica del POS
js/shared/dialogs.js    Modales de confirmación (tmvDialog)
js/shared/errors.js     Presentación de errores (tmvShowError)
js/sentry-init.js       Stub de telemetría (sin envío por defecto)
manifest.webmanifest    PWA manifest
sw.js                   Service worker (cache shell + offline)
icon.svg                Ícono de la app
```

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
# abrir http://localhost:8080/login.html
```

> Nota: el scanner de código de barras y el cajón monedero (Web Serial)
> requieren contexto seguro (HTTPS o localhost) y navegador compatible
> (Chrome/Edge desktop para Web Serial).
