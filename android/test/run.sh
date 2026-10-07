#!/bin/bash
# Pruebas del núcleo del móvil en la JVM: vectores de cifrado y contra el Puente de PC real (Node).
set -eo pipefail
cd "$(dirname "$0")/.."
rm -rf build/jvm && mkdir -p build/jvm
javac -nowarn -encoding UTF-8 -d build/jvm $(find src/com/teamlabstudios/puente/core -name '*.java') test/*.java 2>&1 | grep -v -E "JAVA_TOOL|^Note" || true
timeout 60 java -Dstdout.encoding=UTF-8 -cp build/jvm CryptoTest ../tests/vectors/noise_xx_25519_aesgcm_sha256.json 2>&1 | grep -v JAVA_TOOL
timeout 200 java -Dstdout.encoding=UTF-8 -cp build/jvm FuzzTest 2>&1 | grep -v JAVA_TOOL
timeout 300 java -Dstdout.encoding=UTF-8 -cp build/jvm InteropTest 2>&1 | grep -v JAVA_TOOL
