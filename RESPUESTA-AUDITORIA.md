# Respuesta a la auditoría de Puente 0.2.0 → Puente 0.3.0

Cada punto se comprobó contra el código antes de tocarlo. Además salieron **tres fallos reales que la auditoría no mencionaba** (arriba del todo).

## Fallos encontrados al revisar (arreglados, con prueba)

| Fallo | Qué pasaba | Arreglo |
|---|---|---|
| Envíos grandes fallaban | Con ~500 archivos o más, la lista no cabía en un mensaje de 64 KB y el envío daba error | La lista va en trozos (`offer` + `offer+`); probado con 3.000 archivos PC↔PC y 2.500 móvil↔PC |
| Id de transferencia trucado | Un aparato **ya emparejado** podía mandar `id: "../../x"` en sesión privada y dejar archivos fuera de la carpeta privada (PC y móvil) | El receptor pone su propio id; prueba con el ataque |
| «Coinciden» muy rápido | Si el otro confirmaba en el mismo instante, el aviso se perdía y no se emparejaba | El canal queda en pausa hasta escuchar |
| `setPeer` devolvía el secreto de sala a la ventana (PC) | — | Devuelve solo los datos públicos |
| JSON muy anidado (móvil) | Podía desbordar la pila del lector | Máximo 64 niveles |

## P0

| Punto | Estado |
|---|---|
| Keystore sin texto plano | ✅ Si falla, no se guarda nada y se avisa; lo que 0.2.0 dejara en claro se vuelve a guardar cifrado. Prueba incluida |
| Rutas canónicas en Android | ✅ Todas las comprobaciones de carpeta usan `getCanonicalPath` |
| WebView sin rutas: IDs | ✅ `listPrivate(id)`, `openPrivate(id, n)`, `openReceived(id, n)`, `keep(id)`; ya no existe `open(path)` |
| Puente JS mínimo y validado | ✅ Cada método comprueba tipo, largo y rango; ajustes por lista blanca; devuelve `{error}` |
| Deep links | ✅ Formato exacto (direcciones, puerto, código, nombre) o se ignora; **ya no empareja solo**: rellena y hay que tocar y comparar las 6 cifras |
| IPC genérico en Electron | ✅ Fuera `open`/`show`/`pathOf`. Enviar va por ficha del diálogo o por archivos soltados (el preload saca la ruta de objetos `File` reales); abrir por id |
| Ajustes con esquema (PC y móvil) | ✅ Claves desconocidas y tipos/rangos malos → error; la carpeta de recibidos solo cambia con su diálogo |
| CSP estricta | ✅ PC y móvil: sin estilos en línea, `connect-src 'none'`, `object-src 'none'`, `base-uri 'none'`. Las pruebas fallan si hay una violación |
| Límites contra abuso | ✅ 10.000 archivos por envío, rutas ≤1.024, 32 niveles, `fid` sin repetir, nunca más bytes de los anunciados |
| Límites del relé | ✅ Total, por IP, nuevas por minuto, espera máxima sin pareja, cierre sin tráfico (`--max-conns`, `--por-ip`) |
| Pruebas con tiempo límite | ✅ Node `--test-timeout`, vigilantes en las pruebas Java, `timeout` en todos los pasos |
| CI que bloquea | ✅ `scripts/verificar.sh` (5 bloques); `npm run dist` y `android/build.sh` no construyen si falla; `.github/workflows/verificar.yml` listo |

## P1 / P2

| Punto | Estado |
|---|---|
| WakeLock | ✅ 2 minutos que se renuevan solo mientras pasan datos; se suelta al terminar, cancelar, cortarse o fallar |
| Revocación inmediata | ✅ Quitar un aparato corta sus conexiones abiertas en el acto |
| Notificación de progreso con «Cancelar» | ✅ |
| Ocultar lo técnico | ✅ (parcial) Huella fuera de las tarjetas de enviar; la dirección a mano solo si no aparece tu PC en la lista |
| Fuzzing | ✅ Nombres/rutas (20.000 casos), JSON roto y anidado, mensajes trucados de un aparato emparejado, basura cifrada, ajustes raros |
| Ya estaban | Share Sheet, QR, aceptar/rechazar desde notificación, MediaStore con `IS_PENDING`, `.part` + SHA-256 antes de dar por recibido, PrivateProvider no exportado y de solo lectura |
| **Gradle / targetSdk actual / tipo de servicio** | ⏳ Este entorno no llega a los repositorios de Google ni de Gradle. Sigue con aapt2/javac/dx contra la API 23 (minSdk 26, targetSdk 33, que no exige tipo de servicio) |
| Firma Authenticode, builds reproducibles, límite de ancho de banda del relé, auditoría externa | ⏳ Para siguientes versiones |
