#!/bin/bash
# Todo lo que tiene que pasar antes de construir un instalador o un APK. Si algo falla (o se cuelga), no se construye nada.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "== 1/5 Motor del PC, protocolo, fuzzing (Node) =="
timeout 600 npm test
echo "== 2/5 Ventana del PC =="
npx vite build >/dev/null
echo "== 3/5 Móvil: cifrado, fuzzing y contra el PC real (JVM) =="
timeout 900 android/test/run.sh
echo "== 4/5 Pantalla del móvil =="
timeout 400 node android/test/ui.e2e.cjs "${TMPDIR:-/tmp}"
echo "== 5/5 Dos Puente de verdad (Electron) =="
timeout 400 xvfb-run -a node tests/e2e/dos-pc.e2e.cjs
echo "TODO VERIFICADO"
