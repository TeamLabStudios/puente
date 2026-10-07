#!/bin/bash
# Compila Puente para Android sin Gradle: aapt2 + javac + dx + apksigner (paquetes de Ubuntu).
# Uso: PUENTE_KEYSTORE_PASS=… ./build.sh 0.2.0 2
set -e
cd "$(dirname "$0")"
SDK=/usr/lib/android-sdk; BT=$SDK/build-tools/debian; JAR=$SDK/platforms/android-23/android.jar
KS=${PUENTE_KEYSTORE:?falta PUENTE_KEYSTORE (ruta del almacén de firma)}; KP=${PUENTE_KEYSTORE_PASS:?falta PUENTE_KEYSTORE_PASS}
VER=${1:-0.3.0}; CODE=${2:-3}
# sin pruebas en verde no hay APK (PUENTE_SIN_PRUEBAS=1 solo para compilar a mano mientras se trabaja)
if [ -z "${PUENTE_SIN_PRUEBAS:-}" ]; then test/run.sh; fi
rm -rf build/apk && mkdir -p build/apk/flat build/apk/gen/com/teamlabstudios/puente build/apk/classes build/apk/dex
cat > build/apk/gen/com/teamlabstudios/puente/BuildConfig.java <<J
package com.teamlabstudios.puente;
public final class BuildConfig { public static final String VERSION = "$VER"; }
J
aapt2 compile --dir res -o build/apk/flat/res.zip
aapt2 link -I "$JAR" --manifest AndroidManifest.xml -A assets -o build/apk/app.unsigned.apk --java build/apk/gen --min-sdk-version 26 --target-sdk-version 33 --version-name "$VER" --version-code "$CODE" --replace-version build/apk/flat/res.zip
javac -nowarn -source 8 -target 8 -encoding UTF-8 -bootclasspath "$JAR" -classpath "$JAR" -d build/apk/classes $(find src build/apk/gen -name '*.java') 2>&1 | grep -v -E "JAVA_TOOL|bootstrap class path|^Note:|^warning|obsolete|suppress" || true
test -f build/apk/classes/com/teamlabstudios/puente/MainActivity.class
java -jar $BT/lib/dx.jar --dex --min-sdk-version=26 --output=build/apk/dex/classes.dex build/apk/classes 2>&1 | grep -v JAVA_TOOL || true
cp build/apk/app.unsigned.apk build/apk/app.apk
(cd build/apk/dex && zip -q ../app.apk classes.dex)
zipalign -f -p 4 build/apk/app.apk build/apk/app.aligned.apk
apksigner sign --ks "$KS" --ks-pass "pass:$KP" --out build/apk/puente.apk build/apk/app.aligned.apk 2>&1 | grep -v JAVA_TOOL || true
apksigner verify --print-certs build/apk/puente.apk 2>&1 | grep -v JAVA_TOOL | head -2
mkdir -p dist && cp build/apk/puente.apk "dist/Puente-$VER.apk"
ls -la "dist/Puente-$VER.apk"
