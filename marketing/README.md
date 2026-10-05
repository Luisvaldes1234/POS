# Marketing orgánico

Datos que leen las routines de contenido:

- `publicaciones.json`: reglas (voz por país, rubros, precios, lo prohibido, mezcla de pilares) y el calendario de publicaciones. Cada día se toman las de `fecha` = hoy y `estado` = `pendiente`; al preparar el borrador pasan a `borrador_listo` y, ya publicadas, a `publicado`.
- `grupos.json`: grupos de Facebook y gremios por país. `verificado: false` = dato sacado de búsquedas, falta confirmarlo en Facebook.

- `canva.json`: plantilla de Canva, assets y reglas de armado de las piezas.
- `routines.md`: instrucciones que siguen las routines (rama `marketing-contenido`).
- `casos.json`: casos reales de clientes con permiso para publicar.

Los grupos se publican a mano (Facebook no permite publicar en grupos por API). La marca (colores, tipografía, logo, voz) está en el brand kit de POS Mostrador.
