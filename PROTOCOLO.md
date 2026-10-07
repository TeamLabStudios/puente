# Protocolo de Puente (v1)

Puente pasa archivos entre PC propios, en casa o fuera, **cifrados de punta a punta**. Nadie que no sea uno de los dos PC
puede leer, cambiar o reordenar lo que viaja. Esto incluye el router, el proveedor de internet y el relé.

## 1. Amenazas que cubre

| Quién | Qué podría intentar | Cómo se para |
|---|---|---|
| Alguien en tu WiFi | Leer o cambiar lo que pasa | Noise XX + AES-256-GCM, con claves nuevas en cada conexión |
| Alguien en medio al emparejar | Hacerse pasar por el otro PC | Código de un solo uso (3 min, 5 intentos) + **6 cifras** que tienen que coincidir en las dos pantallas |
| Un aparato desconocido | Mandarte archivos o ver quién eres | Solo se aceptan claves de confianza; en la red de casa no anuncias tu nombre, solo una marca que cambia cada 5 min |
| El relé (o quien lo controle) | Leer, cambiar, saber quién eres | Solo ve bytes cifrados y una «sala» aleatoria (HMAC del secreto compartido) |
| Archivos con nombres trucados | Escribir fuera de la carpeta (`..\..\Windows`) | Las rutas se limpian (sin `..`, unidades, `\\servidor`, nombres reservados) y se comprueba que quedan dentro |
| Un archivo dañado o cortado | Que se guarde mal | Huella SHA-256 de cada archivo y se reanuda donde se cortó |
| Robo del PC | Usar tus claves | La clave fija se guarda protegida con DPAPI (solo tu usuario de Windows); botón del pánico; quitar aparatos |

**Fuera de alcance (por ahora):** un PC ya infectado por malware, y el análisis del tráfico (cuándo y cuánto se envía).

## 2. Identidad

- Cada PC crea una clave **X25519** fija la primera vez, guardada con `safeStorage` (DPAPI).
- En Android, la clave fija, los aparatos de confianza y los ajustes se guardan cifrados con una clave AES-256-GCM del **almacén de claves de Android** (no sale del móvil; sin copia de seguridad de la app).
- La **huella** que se enseña es `SHA-256("puente-id" ‖ clave pública)`, en base 31 sin letras confusas, por ejemplo `RNUR-JPAY-XGWX`.

## 3. Conexión segura: `Noise_XX_25519_AESGCM_SHA256`

- Prólogo `Puente/1`. Patrón XX: `→ e` · `← e, ee, s, es` · `→ s, se`.
- Cada mensaje lleva delante su longitud (2 bytes, máximo 65 535).
- En el saludo cifrado solo viaja `{v, name, mode}`.
- Después, cada mensaje va con AES-256-GCM y un nonce = contador: un bit cambiado, un mensaje repetido o uno reordenado corta la conexión.
- Al terminar se borran de la memoria las claves de sesión y las efímeras.
- La implementación se comprueba **byte a byte con los vectores oficiales** (`tests/vectors`, de cacophony).

## 4. Emparejar

1. El PC B pulsa «Mostrar código»: 8 caracteres (≈ 39 bits), caduca en 3 minutos y se anula tras 5 fallos.
2. A se conecta a B con `mode: "pair"` y, ya dentro del canal cifrado, manda `HMAC(código, h ‖ "I")`, donde h es la huella del saludo.
3. B lo comprueba (en tiempo constante) y contesta `HMAC(código, h ‖ "R")`: los dos demuestran que conocen el código **ligado a esta conexión**.
4. Los dos enseñan **6 cifras** = `HMAC(h, "puente-sas") mod 10⁶`. Si hubiera alguien en medio, saldrían distintas.
5. Solo cuando **los dos** pulsan «Coinciden» se guarda el otro aparato: su clave pública, su nombre y el secreto de sala `HKDF(h)`.

## 5. Encontrarse

| Dónde | Cómo |
|---|---|
| **En casa** | Aviso UDP cada 3 s al puerto 47831. Con el modo emparejar activo lleva `{name, fp, port}`; si no, solo `tag = SHA-256("puente-marca" ‖ clave ‖ ventana de 5 min)[0..8]`, que solo tus aparatos reconocen. |
| **Directo** | Una dirección `host:puerto`, si el otro PC tiene el puerto abierto. |
| **Relé** | Cada PC espera en la sala `HMAC(secreto, "sala:" + su huella)`; el que envía marca la sala del otro. El relé exige su propia clave y limita las conexiones por IP. |

Se prueban en este orden: casa → directo → relé. En los tres, el contenido es el mismo canal Noise.

## 6. Transferencia (dentro del canal)

```
→ offer  {id, files:[{fid, rel, size, key}…], count, total, private, more}
→ offer+ {files:[…], more}      (la lista va en trozos de ≤48 KB: cada mensaje cifrado cabe en 64 KB)
← accept {start:{fid: bytes ya recibidos}}  |  reject
→ file {fid, from}  · trozos de datos [1][fid][≤65 514 B] ·  end {fid, sha256}
→ done
← received {n}  |  error {reason}
```

- El receptor escribe en `.puente/<key>.part`. Si se corta, el siguiente `offer` del mismo archivo sigue desde ese byte, y la huella del archivo completo se vuelve a comprobar al final.
- Nunca se pisa nada: si ya existe, se guarda como «nombre (2).ext».
- Si el disco va lento, se frena la conexión, así la memoria no crece.
- Límites que comprueba el receptor: como mucho **10.000 archivos** por envío, rutas de ≤1.024 caracteres y 32 niveles, `fid` enteros sin repetir, tamaños enteros ≥ 0, y nunca más bytes de los anunciados. El id de la transferencia lo pone el receptor (el del otro no se usa para nada del disco).
- Solo cuenta como recibido cuando **todos** los archivos han pasado tamaño + SHA-256; hasta entonces son `.part` y luego se mueven a su sitio.

## 6b. Fronteras de confianza

- **Ventana → motor** (PC y móvil): la ventana pide acciones, el motor decide recursos. Nada de rutas desde la ventana: lo elegido en el diálogo va por una ficha, lo soltado lo traduce el preload desde objetos `File` reales, y lo recibido se abre por id de transferencia. Los ajustes pasan por una lista blanca con tipos y rangos (claves desconocidas → error).
- **CSP estricta** en las dos pantallas: `script-src 'self'`, sin estilos en línea, `connect-src 'none'`, `object-src 'none'`, `base-uri 'none'`.
- **Enlace del QR** (`puente://emparejar`): formato exacto o se ignora; solo rellena el formulario. Emparejar exige tocar «Emparejar» y comparar las 6 cifras.
- **Guardado en Android**: si el almacén de claves falla, no se guarda nada (nunca en claro); Puente avisa y sigue solo en memoria.
- **Quitar un aparato** corta en el acto sus conexiones abiertas. El **pánico** corta todo, cancela el emparejado, borra lo privado y deja tus aparatos de confianza.
- **Relé**: límite total de conexiones, por IP y de conexiones nuevas por minuto; espera máxima sin pareja (30 min) y cierre tras 10 min sin tráfico; la primera línea ≤512 B y 10 s para mandarla. No guarda nada ni ve nombres, archivos o claves.

## 7. Sesión privada

- Lo recibido va a una carpeta de Puente (no a Descargas).
- No deja historial.
- Se borra a los N minutos y al cerrar Puente.
- Con «Guardar» se saca antes de que se borre.
- **Pánico:** corta todo, anula el emparejado en curso y borra lo privado.

## 8. Móvil (Android)

- Mismo protocolo, byte a byte, en Java puro (`android/src/.../core`): X25519 adaptado de TweetNaCl, Noise XX con `javax.crypto` (AES-GCM, HMAC-SHA256). Comprobado con los vectores del RFC 7748 y de Noise, y contra el motor del PC de verdad (emparejar en los dos sentidos, enviar y recibir, red de casa, relé, sesión privada, reanudar, intrusos).
- La pantalla es una página local dentro de la app (sin red: CSP `connect-src 'none'`, navegación bloqueada); solo habla con el motor por un puente JS.
- Lo privado se queda en la zona interna de la app; para verlo se presta con un permiso puntual de solo lectura (sin exportar el proveedor).
- Emparejar por QR: `puente://emparejar?h=<direcciones>&p=<puerto>&c=<código>&n=<nombre>`. El QR solo lleva el código de un solo uso (3 min, 5 intentos): la seguridad sigue siendo la de las 6 cifras.

## 9. Pendiente (siguientes versiones)

- Android con Gradle y targetSdk actual (tipo de servicio en primer plano «dataSync»): aquí no hay acceso a los repositorios de Google; se compila con aapt2/javac/dx contra la API 23 (minSdk 26, targetSdk 33).
- Firma de código de Windows (Authenticode) y builds reproducibles.
- Límite de ancho de banda en el relé.

- Bóveda cifrada para lo recibido.
- «Ver una vez».
- Contraseña extra (Argon2id).
- Abrir puerto solo con UPnP.
- Conexión directa a través de internet sin relé.
- Auditoría externa.
