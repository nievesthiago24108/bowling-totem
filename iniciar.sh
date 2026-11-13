#!/usr/bin/env bash
# Bowling Tótem: arranca el servidor y abre el tótem en pantalla completa (modo kiosco).
# Uso: doble clic (si el explorador de archivos lo permite) o ./iniciar.sh en una terminal.
# Para salir del kiosco: Alt+F4. Al cerrar el navegador también se apaga el servidor.
set -u
cd "$(dirname "$0")"

pausa() { [ -t 0 ] && read -r -p "Tocá Enter para cerrar…" _; }

if ! command -v node >/dev/null 2>&1; then
  echo "Falta Node.js 20 o superior. Instalalo desde https://nodejs.org o con el gestor de paquetes."
  pausa; exit 1
fi
if [ ! -d node_modules ]; then
  echo "Instalando dependencias (solo la primera vez)…"
  npm install --omit=dev || { echo "No se pudo instalar. ¿Hay internet?"; pausa; exit 1; }
fi

PUERTO=$(node -p "require('./server.js').loadConfig().puerto")
URL="http://localhost:${PUERTO}"

# el servidor se vuelve a levantar solo si se cae (así el tótem no queda muerto)
( while true; do
    node server.js
    echo "El servidor se detuvo; se reinicia en 2 segundos…"
    sleep 2
  done ) &
SERVIDOR=$!
trap 'trap - EXIT; kill 0 2>/dev/null; exit 0' EXIT INT TERM

# esperar a que el servidor responda (máx. 20 s)
listo=0
for _ in $(seq 1 40); do
  if node -e "require('http').get('${URL}/api/config',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"; then
    listo=1; break
  fi
  sleep 0.5
done
[ "$listo" = 1 ] || { echo "El servidor no respondió en ${URL} (mirá los mensajes de arriba)."; pausa; exit 1; }

NAVEGADOR=""
for b in chromium chromium-browser google-chrome google-chrome-stable brave brave-browser microsoft-edge; do
  if command -v "$b" >/dev/null 2>&1; then NAVEGADOR="$b"; break; fi
done

if [ -z "$NAVEGADOR" ]; then
  echo "No encontré Chromium ni Chrome. Abrí ${URL} a mano y tocá F para pantalla completa."
  wait "$SERVIDOR"
  exit 0
fi

# Perfil propio: así el kiosco funciona aunque el navegador ya esté abierto, y se puede
# reproducir sonido sin tocar la pantalla.
"$NAVEGADOR" --kiosk --autoplay-policy=no-user-gesture-required \
  --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble \
  --disable-features=Translate --password-store=basic \
  --user-data-dir="${HOME}/.config/bowling-totem-kiosco" "$URL"
