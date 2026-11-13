# Prompts para continuar en Claude Code

Cómo usarlos:
1. Descomprimí `bowling-totem.zip`, abrí una terminal en la carpeta y corré `npm install`.
2. Abrí Claude Code en esa carpeta (`claude`).
3. Pegá los prompts (0 al 7) **de a uno, en orden**. Esperá a que termine cada uno y probá antes de pasar al siguiente.
4. Si algo no anda, contale qué pasó (qué ves en pantalla o el error de la consola) antes de seguir.

---

## Prompt 0 — Contexto (pegalo siempre primero en una sesión nueva)

```
Leé PLAN.md completo y revisá public/shared/physics.js. Es un juego de bowling 2D para un
tótem vertical de 1080x1920 donde los celulares son el control, todo en red local.
Respetá las decisiones, la estructura de carpetas, los nombres de mensajes de Socket.io y la
geometría que figuran en PLAN.md. Todos los textos de la interfaz van en español rioplatense.
No uses recursos de internet (CDN, Google Fonts): todo tiene que funcionar sin conexión.
Antes de escribir código, resumime en 5 líneas qué entendiste. No hagas nada más todavía.
```

## Prompt 1 — Puntaje y ajuste de la física

```
Etapa 2 de PLAN.md.
1) Creá public/shared/scoring.js con el mismo formato UMD que physics.js (sirve en navegador
   y en Node). Tiene que calcular el puntaje oficial de bowling para N frames configurables:
   pleno (strike) y semi-pleno (spare) con sus bonus, y el último frame con tiros extra.
   Funciones: crear la tarjeta, registrar un tiro, saber si el frame del jugador terminó,
   cuántos pinos quedan, el total y el detalle por frame para mostrar (X, /, -).
2) Escribí tests con node:test para scoring.js (juego perfecto = 30 por frame, todos 9-0,
   todos semi-plenos, canaletas, último frame) y corrélos.
3) Creá test/sim.js que use physics.js en Node para simular unos 500 tiros con parámetros
   al azar y otros "buenos" (al bolsillo entre pino 1 y 3 con algo de efecto). Mostrá: % de
   plenos, promedio de pinos, % de canaletas y cuánto dura cada jugada.
4) Ajustá los números de physics.js para que: un tiro bueno haga pleno entre 30% y 50% de
   las veces, un tiro al medio derecho sea menos efectivo que uno al bolsillo, las canaletas
   solo pasen con tiros muy torcidos y cada jugada dure entre 2 y 5 segundos. Mostrame la
   tabla antes y después.
```

## Prompt 2 — Servidor

```
Etapa 3 de PLAN.md. Creá config.json y server.js:
- Express 5 + Socket.io. Ruta "/" sirve public/totem/, ruta "/j" sirve public/control/,
  /shared sirve public/shared, y servir matter-js desde node_modules.
- Detectar la IP local (IPv4 de la red, ignorando interfaces virtuales y de Docker) y
  generar el QR con la librería qrcode apuntando a http://IP:PUERTO/j. Exponerlo en /qr.png.
  Mostrar la IP y la dirección en la consola al arrancar.
- Lobby: jugadores con nombre (máx. 14 caracteres, sin HTML), color asignado de una paleta
  de 6, anfitrión = el primero. Reconexión con token guardado en localStorage del celular.
  Si hay partida en curso, quien entra queda como espectador.
- Implementá los mensajes de la tabla de PLAN.md reenviando entre tótem y celulares, salvo
  los de leaderboard (game:over solo dejalo registrado en la consola por ahora; el
  leaderboard se hace en el Prompt 5).
- Si el tótem se reconecta, mandarle el estado del lobby.
Probalo arrancando el servidor y conectando dos clientes de prueba con socket.io-client
(como dependencia de desarrollo) en un script de test.
```

## Prompt 3 — Pantalla del tótem jugable

```
Etapa 4 de PLAN.md. Creá public/totem/index.html y totem.js:
- Un canvas lógico de 1080x1920 escalado para entrar en la ventana (con bordes si hace falta).
- Dibujá a mano la pista: madera con tablas, flechas guía, línea de foul, canaletas, foso,
  pinos vistos desde arriba (círculo blanco con franja roja) y bola con brillo.
- Usá physics.js y scoring.js. Fases: lobby, cuenta regresiva, juego, resultados.
- Lobby: QR grande (/qr.png), nombre de la escuela y jugadores que se suman. Dejá un espacio
  reservado para el leaderboard, que se agrega en el Prompt 5.
- Turnos según PLAN.md: frame completo por jugador, tiro automático si no tira en el tiempo de
  config.json, saltear desconectados. Después del primer tiro, sacar los pinos caídos.
- Franja superior con jugador de turno, frame y tiro. Tabla inferior con todos los jugadores.
- Mandar game:state después de cada cambio y game:over al terminar.
- Atajos: Enter empezar, R reiniciar, F pantalla completa, D depuración, y la tecla
  Espacio lanza un tiro de prueba al azar para el jugador de turno (para probar sin celular).
Probalo con Playwright: abrí el tótem a 1080x1920, agregá jugadores de prueba, tirá con
Espacio varias veces y sacame capturas del lobby, de un tiro en curso y de la tabla.
```

## Prompt 4 — Control del celular

```
Etapa 5 de PLAN.md. Creá public/control/index.html y control.js, pensado para celular
vertical (botones grandes, sin zoom, sin scroll, funciona en Chrome Android y Safari iPhone):
- Pantalla para unirse: nombre y botón "Entrar". Recordar nombre y token en localStorage.
- Esperando: lista de jugadores, y si soy anfitrión el botón "¡Empezar!".
- Mi turno: vibrar si se puede, mini pista con la bola abajo. Arrastrar la bola a los
  costados cambia la posición (manda player:aim limitado a 20 por segundo). Deslizar hacia
  arriba lanza: fuerza por velocidad del trazo, dirección por el ángulo, efecto por la curva
  del trazo (desvío del punto medio respecto de la recta inicio-fin). Mostrar una flecha
  mientras desliza. Evitar que el navegador haga scroll o "pull to refresh".
- No es mi turno: mi puntaje, quién está jugando y botones de reacciones 👏 🔥 😂 😱 🎳
  (máx. una cada 2 segundos).
- Mensaje claro si se pierde la conexión, y reconexión automática.
En el tótem: mostrar en vivo la posición de la bola mientras el jugador apunta y hacer
flotar los emojis de reacción.
Probalo con Playwright emulando un celular (390x844, táctil) contra el tótem abierto en otra
página: unirse, empezar, deslizar y confirmar que la bola sale en el tótem. Pasame capturas.
```

## Prompt 5 — Leaderboard

```
Etapa 6 de PLAN.md. Implementá el leaderboard tal como está en la sección "Leaderboard" de
PLAN.md:
1) leaderboard.js (módulo de Node, sin dependencias nuevas):
   - Guardar cada puntaje como un renglón en data/puntajes.jsonl, agregando al final del
     archivo (appendFile). Crear la carpeta data/ si no existe.
   - Al arrancar, leer el archivo a memoria e ignorar renglones dañados sin romper nada.
   - nombreClave: minúsculas, sin tildes y sin espacios repetidos.
   - Consultas: top de hoy, de la semana y de siempre; mejores jugadores (mejor puntaje por
     nombreClave, partidas jugadas y promedio); historial de un nombre; puesto de un puntaje.
     Filtrar siempre por la cantidad de frames actual. Desempate: más plenos, luego el más
     antiguo. "Hoy" según la hora de Argentina.
   - Borrar = agregar un renglón {"borrar": id}, nunca reescribir el archivo.
   - Copia de seguridad diaria en data/backups/ y función para archivar y empezar de cero.
   - Filtro de nombres con data/palabras-prohibidas.txt (crealo con una lista básica en
     español, comparando sin tildes y detectando reemplazos como 4→a, 3→e, 0→o, 1→i).
2) Escribí tests con node:test para leaderboard.js (guardar, ordenar, desempate, agrupar
   nombres con y sin tildes, borrar, renglón dañado, cambio de día) y corrélos.
3) En server.js: al recibir game:over guardar los puntajes (no guardar partidas sin tiros
   ni abandonadas), mandar leaderboard:update a todos y leaderboard:position a cada celu.
   Validar el nombre al unirse con el filtro y avisarle al celu si fue rechazado.
   Rutas: GET /api/leaderboard?tabla=hoy|semana|siempre|jugadores, GET /api/jugador/:nombre,
   y las de admin protegidas con el PIN de config.json (listar, borrar, exportar CSV con
   separador ";" y BOM para que Excel muestre bien las tildes, reiniciar).
4) Tótem: en el lobby mostrar el leaderboard rotando entre Hoy, Semana y Siempre cada
   segundosRotacionRanking, con medallas para los 3 primeros. En resultados, mostrar el
   puesto de cada jugador y un festejo especial si hay récord histórico.
5) Celular: al terminar, mostrar puntaje, puesto de hoy, puesto de siempre y si es récord
   personal. Agregar un botón "Ver ranking" que abra /ranking.
6) public/ranking/index.html: pestañas Hoy, Semana, Siempre y Mejores jugadores, buscador
   por nombre y, al tocar un nombre, su historial de partidas. Que se vea bien en celu y
   en compu, y que se actualice solo cada 15 segundos.
7) public/admin/index.html: pedir el PIN, listar y buscar puntajes, borrar con
   confirmación, exportar CSV y reiniciar con doble confirmación.
Probalo jugando 3 partidas de prueba con la tecla Espacio y sacame capturas del lobby con
el leaderboard, de /ranking en tamaño celular y de /admin.
```

## Prompt 6 — Presentación

```
Etapa 7 de PLAN.md. Mejorá la presentación del tótem sin tocar la lógica:
- Estética de bowling nocturno con acentos de neón, consistente en todo el juego.
- Sombras de pinos y bola, rotación visible de la bola, partículas al chocar.
- Cámara lenta cuando la bola llega a los pinos, sacudida de pantalla en los plenos.
- Textos animados grandes: "¡PLENO!", "¡SEMI-PLENO!", "CANALETA", "¡9 PINOS!".
- Logo: si existe public/logo.png, dibujarlo semitransparente en la pista y chico en el
  encabezado; si no, escribir el nombre de la escuela de config.json.
- public/totem/sound.js con sonidos sintetizados en WebAudio: rodar (según velocidad),
  choque de pinos (según fuerza), festejo de pleno y conteo. Sin archivos de audio.
- Demo en el lobby: si no hay jugadores, que se tiren bolas solas de fondo detrás del QR.
- Podio animado en resultados.
Mantené 60 cuadros por segundo en una compu modesta. Sacame capturas para revisar.
```

## Prompt 7 — Prueba final y README

```
Etapa 8 de PLAN.md.
1) Hacé una prueba completa con Playwright: tótem + 3 celulares emulados, partida entera
   hasta resultados, uno se desconecta y vuelve a mitad de partida, y un espectador manda
   reacciones. Confirmá que los 3 puntajes quedaron en data/puntajes.jsonl y aparecen en
   /ranking, y que después de reiniciar el servidor siguen estando. Revisá la consola de
   todas las páginas y arreglá cualquier error.
2) Escribí README.md en español: requisitos, instalación, cómo arrancar, cómo abrir el
   tótem en modo kiosco (Windows y Linux), cómo cambiar el logo y la configuración,
   cómo ver el ranking, usar el panel de admin (y cambiar el PIN), dónde están guardados
   los puntajes y cómo hacer una copia de seguridad,
   qué hacer si los celulares no se conectan (misma red, aislamiento de clientes, firewall
   de Windows, puerto), y atajos de teclado.
3) Agregá un script para arrancar con doble clic (iniciar.bat para Windows e iniciar.sh para
   Linux) que levante el servidor y abra el navegador en modo kiosco.
```

## Prompt 8 (opcional, más adelante) — Lanzar moviendo el celular

```
Agregá la opción de lanzar haciendo el movimiento real con el celular usando DeviceMotion,
manteniendo el deslizamiento como alternativa. Para iPhone hace falta HTTPS: generá un
certificado propio con la librería selfsigned, levantá el servidor también en HTTPS en otro
puerto y pedí el permiso con un botón "Activar movimiento". Explicá en el README cómo
aceptar el certificado en el celular.
```

---

## Consejos para trabajar con Claude Code

- Si la sesión se alarga mucho, abrí una nueva y pegá de nuevo el **Prompt 0**.
- Pedile que actualice PLAN.md marcando con ✅ cada etapa que termine.
- Usá git: `git init` al empezar y pedile "hacé un commit" al final de cada etapa, así podés volver atrás.
- Si un cambio no te gusta, decile exactamente qué ves ("los pinos se mueven solos", "la bola va muy rápido") en vez de "no anda".
