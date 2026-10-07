# Cambios

## 0.3.0
- Android: «Después de enviar» → Conservar / Preguntar / Borrar (solo tras verificar SHA-256; nunca en privado).
- Envíos de miles de archivos (la lista va en trozos).
- Frontera ventana → motor por fichas e ids; ajustes con lista blanca; CSP estricta.
- Android: almacén de claves sin texto plano, puente JS validado, enlace QR que no empareja solo.
- Quitar un aparato corta sus conexiones al instante; relé con límites.
- Fuzzing y pruebas con tiempo límite; nada se construye si una prueba falla.

## 0.2.0
- App de Android con el mismo protocolo; QR para emparejar el móvil; arreglo de pérdida de datos en el relé.

## 0.1.0
- Primera versión: Noise XX + AES-256-GCM, emparejar con código + 6 cifras, casa / directo / relé, sesión privada, pánico, Nubo.
