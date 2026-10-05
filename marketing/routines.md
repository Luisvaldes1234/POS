# Routines de contenido de POS Mostrador

Las routines de Claude leen este archivo y siguen la sección que les toca. Para cambiar cómo trabajan, se edita este archivo en la rama `marketing-contenido`; no hace falta tocar la routine.

## Antes de empezar (todas las routines)

1. Trabajar en el repositorio `Luisvaldes1234/POS`, rama **`marketing-contenido`** (nunca `main`). Si el repositorio no está en el directorio de trabajo, clonarlo; si la rama no existe, crearla desde `main` y subirla.
2. Leer `marketing/publicaciones.json`, `marketing/canva.json`, `marketing/grupos.json` y este archivo.
3. Leer la guía de marca: el README del brand kit de POS Mostrador (https://claude.ai/artifact/K6Vxbv4rLww1TUyxedRipJ, archivo `project/README.md`). Si no se puede leer, usar las reglas de `publicaciones.json`.
4. Zona horaria de referencia: America/Argentina/Buenos_Aires.

Reglas que no se rompen:
- No inventar testimonios, clientes, cifras de uso ni reseñas. Las publicaciones de historias necesitan un caso real: si no hay, se reemplazan por un tip.
- No mencionar facturación electrónica ni "emitir factura".
- Voseo en Argentina y Uruguay; tú en el resto. Palabra local del rubro (ver `reglas.rubros`).
- Precios solo los de `reglas.precios`.
- No publicar nada por tu cuenta en Facebook ni en grupos: preparar el material y avisar.

## Routine diaria: "POS · Post del día" (lunes a viernes)

1. Tomar de `publicaciones.json` las publicaciones con `fecha` = hoy y `estado` = `pendiente`. Si no hay, terminar sin avisar.
2. Para cada una, armar la pieza en Canva siguiendo `canva.json`:
   - `copy-design` de `plantillas.post_4x5.design_id`.
   - `read-design` con `open_transaction` en la copia.
   - `edit-design`: `replace_text` en titular, bajada y etiqueta con `pieza.titular`, `pieza.bajada`, `pieza.etiqueta`; `update_fill` de la captura con el asset de `pieza.captura` (ver `assets`), o la variante sin captura si `pieza.captura` es null; `update_title` con `<id> · <titulo>`.
   - Aplicar `reglas_de_armado` (tamaño del titular, posición de la bajada) y revisar la miniatura. Corregir hasta que no haya nada encimado ni cortado.
   - `commit`, `move-item-to-folder` a `carpeta.id`, `export-design` en PNG.
   - Carrusel: una copia por lámina, según `reglas_de_armado`.
3. Si el pilar se puede llevar a grupos (`grupos.permitido`), escribir una versión distinta del texto para cada grupo de ese país en `grupos.json`, sin link y adaptada al grupo.
4. Guardar en la publicación `canva.design_id`, `canva.edit_url` y `canva.png_url`, y pasar `estado` a `borrador_listo`. Commit en `marketing-contenido` con el mensaje `Contenido: <id>` y push.
5. Terminar con un resumen corto para el aviso: título, texto listo para pegar, link de Canva, PNG, link con UTM y, si hay, los textos para grupos.

## Routine semanal: "POS · Calendario de la semana" (domingos)

1. Ver qué publicaciones quedan para los próximos 7 días. Si ya hay 5 de lunes a viernes, terminar.
2. Escribir las que falten para la semana siguiente, una por día hábil, siguiendo la cadencia (lunes tip, martes comunidad, miércoles producto, jueves historia, viernes humor u oferta) y la mezcla de `reglas.mezcla`. No repetir temas de las últimas 4 semanas.
3. Cada publicación nueva con todos los campos del formato: `id` (`sN-dia`), `fecha`, `semana`, `dia`, `hora_local`, `pais`, `canal`, `pilar`, `formato`, `titulo`, `texto`, `visual`, `imagen`, `cta_url` con `utm_campaign` = id, `grupos`, `pieza` (titular de hasta 50 caracteres, bajada, etiqueta, captura), `canva` vacío y `estado` = `pendiente`.
4. Historias: solo si en `marketing/casos.json` hay un caso real con permiso; si no, un tip.
5. Si un país distinto de Argentina tiene `activo: true` en `reglas.paises_activos`, agregar también su semana, en su voz y con sus precios.
6. Commit en `marketing-contenido` con `Calendario: semana N` y push. Resumen corto con los títulos de la semana.

## Revisión de resultados (manual, por ahora)

Los lunes, revisar en analytics las visitas y cuentas con `utm_source=facebook`, `instagram` o `grupo`, y anotar en `marketing/resultados.json` qué publicaciones trajeron cuentas. La routine semanal repite los formatos que mejor funcionaron.
