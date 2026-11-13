# Bowling Tótem — Plan de la app

Juego de bowling 2D (vista desde arriba) para un tótem vertical de **1080 x 1920**. Los jugadores usan **su celular como control**: escanean un QR, ponen su nombre y lanzan la bola deslizando el dedo. Todo funciona en **red local**, sin internet.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Gráficos | 2D, vista desde arriba, dibujado a mano en `<canvas>` (sin Matter.Render) |
| Física | Matter.js 0.20, gravedad 0 |
| Comunicación | Node.js + Express 5 + Socket.io 4 en la red local |
| Pinos | Clásicos (blancos con franja roja), logo de la escuela en la pista |
| Control | Deslizar el dedo (funciona en HTTP, sin permisos). El acelerómetro queda para una etapa posterior porque en iPhone requiere HTTPS |
| Jugadores | 1 a 6 por partida, pocos usuarios simultáneos |
| Partida | 3 frames (configurable), puntaje oficial con pleno y semi-pleno |
| Internet | No hace falta: todo se sirve desde `node_modules` y el QR se genera en el servidor |
| Leaderboard | Se guardan **todos** los puntajes con nombre, fecha y hora en un archivo que no se borra. Se ven tablas de hoy, de la semana y de siempre |

## Estructura del proyecto

```
bowling-totem/
├── package.json            ✅ hecho (express, socket.io, qrcode, matter-js; dev: socket.io-client, playwright)
├── config.json             ✅ nombre de la escuela, frames, puerto, máx. jugadores
├── server.js               ✅ servidor, lobby, reenvío de mensajes, QR, rutas del ranking y del admin
├── leaderboard.js          ✅ guardar y consultar puntajes, filtro de nombres, copias y CSV
├── data/                   (se crea sola; las pruebas usan una carpeta temporal)
│   ├── puntajes.jsonl      un renglón por cada puntaje, nunca se reescribe
│   ├── backups/            copia diaria del archivo de puntajes
│   ├── archivo/            leaderboards reiniciados desde /admin
│   └── palabras-prohibidas.txt  filtro de nombres (editable, se aplica al instante)
├── README.md               ✅ instalación, uso, admin, problemas de red
├── iniciar.sh / .bat       ✅ arrancan el servidor y abren el kiosco con doble clic
├── PLAN.md                 ✅ este documento
├── PROMPTS.md              ✅ prompts para continuar en Claude Code
├── test/
│   ├── scoring.test.js     ✅ tests del puntaje (`npm test`)
│   ├── server.test.js      ✅ tests del servidor con clientes socket.io-client
│   ├── game.test.js        ✅ tests de la lógica del tótem (turnos, tiro automático, desconectados)
│   ├── sim.js              ✅ simulación para ajustar la física (`npm run sim -- --n 500 --seed 1`)
│   ├── gesture.test.js     ✅ tests del gesto del celular (fuerza, dirección, efecto)
│   ├── leaderboard.test.js ✅ tests del leaderboard (orden, desempate, tildes, borrar, cambio de día, filtro)
│   ├── capturas.js         ✅ prueba de punta a punta con Playwright (`npm run capturas` → `capturas/`)
│   ├── celular.js          ✅ prueba del celular emulado contra el tótem (`npm run capturas:celu`)
│   ├── ranking.js          ✅ 3 partidas, /ranking y /admin (`npm run capturas:ranking`)
│   ├── presentacion.js     ✅ demo, choque, pleno, podio y FPS (`npm run capturas:presentacion`)
│   ├── final.js            ✅ tótem + 3 celus + espectador + desconexión + reinicio (`npm run prueba:final`)
│   └── rendimiento.js      ✅ FPS con CPU 3 veces más lenta y sin placa de video (`npm run prueba:rendimiento`)
└── public/
    ├── logo.png            (lo pone la escuela; si no está, se escribe el nombre)
    ├── shared/
    │   ├── physics.js      ✅ hecho: pista, pinos, tiro, canaleta, efecto, conteo
    │   └── scoring.js      ✅ puntaje de bowling (sirve en navegador y en Node)
    ├── totem/
    │   ├── index.html      ✅ pantalla del tótem (ruta `/`)
    │   ├── game.js         ✅ lógica del juego: fases, turnos, tiros y puntaje (sin DOM, se testea en Node)
    │   ├── totem.js        ✅ dibujo en canvas, socket y teclado
    │   └── sound.js        ✅ sonidos sintetizados con WebAudio (tecla M = silencio)
    ├── control/
    │   ├── index.html      ✅ página del celular (ruta `/j`, la del QR)
    │   ├── gesture.js      ✅ convierte el deslizamiento en { power, aim, spin } (se testea en Node)
    │   └── control.js      ✅ unirse, apuntar, deslizar, reacciones, reconexión
    ├── ranking/
    │   └── index.html      ✅ leaderboard completo (ruta `/ranking`), para celu o compu
    └── admin/
        └── index.html      ✅ panel con PIN para borrar puntajes, exportar y reiniciar (ruta `/admin`)
```

## Arquitectura

- **El tótem es la autoridad del juego**: corre la física, los turnos y el puntaje.
- **El servidor** maneja quién está conectado, reenvía mensajes y guarda el ranking. No simula nada.
- **Los celulares** solo mandan gestos y reciben "es tu turno", su puntaje y el estado de la partida.

### Mensajes de Socket.io

| Mensaje | De → a | Contenido |
|---|---|---|
| `totem:hello` | tótem → servidor | se registra como pantalla |
| `player:join` | celu → servidor | `{ name, token }` (el token queda en localStorage para reconectar) |
| `lobby:update` | servidor → todos | `{ phase, totemConnected, maxJugadores, players: [{ id, name, color, host, connected, spectator }] }` (nunca los tokens) |
| `game:start` | celu anfitrión → servidor → tótem `{ by }` (o tecla Enter en el tótem) | arranca la cuenta regresiva; el celu recibe respuesta `{ ok, error }` |
| `game:state` | tótem → servidor → celus | `{ phase, currentPlayerId, frame, throw, scores }` |
| `player:aim` | celu → tótem | `{ position }`; el tótem recibe `{ playerId, position }` (solo del jugador de turno, máx. ~25 por segundo) |
| `player:throw` | celu → tótem | `{ power, aim, spin, position }` (todos entre -1 y 1, power entre 0 y 1); el servidor acota los valores, agrega `playerId` y acepta solo al jugador de turno, máx. 1 por segundo |
| `player:react` | celu → tótem | `{ emoji }` de la lista 👏 🔥 😂 😱 🎳, máx. 1 cada 2 s; el tótem recibe `{ playerId, name, color, emoji }` |
| `game:over` | tótem → servidor | resultados `{ jugadores: [{ id, name, score, plenos, semiplenos }], frames }`; el servidor guarda solo los jugadores que conoce (no los de prueba), con el nombre que validó él y los números acotados al máximo posible |
| `leaderboard:update` | servidor → tótem y celus | `{ frames, hoy, semana, siempre }` (top 10) y, después de una partida, `ultimaPartida: [{ id, puestoHoy, puestoSiempre, esRecordPersonal, esRecordHistorico }]` |
| `leaderboard:position` | servidor → cada celu | `{ id, puntaje, puestoHoy, puestoSiempre, esRecordPersonal, esRecordHistorico }` |

### Servidor (`server.js`)

- Rutas: `/` tótem, `/j` control del celular, `/ranking`, `/admin`, `/shared/*`, `/qr.png`, `/logo.png`, `/api/config` (config sin el PIN, más `urlJuego` y `logo`), `/vendor/matter.min.js` y `/socket.io/socket.io.js` (lo sirve Socket.io). Todo sin internet.
- Ranking: `GET /api/leaderboard` (las 3 tablas) o `?tabla=hoy|semana|siempre|jugadores&n=10`, `GET /api/jugador/:nombre` (historial).
- Admin (header `x-pin` con el PIN; 5 errores seguidos bloquean esa IP 1 minuto): `GET /api/admin/puntajes`, `DELETE /api/admin/puntajes/:id`, `GET /api/admin/export.csv` (";" y BOM), `POST /api/admin/reiniciar` con `{ "confirmar": "REINICIAR" }`.
- Al unirse, el nombre pasa por el filtro de `data/palabras-prohibidas.txt` (sin tildes, con reemplazos 4→a, 3→e, 0→o, 1→i… y letras repetidas).
- IP del QR: la IPv4 de la red local, sin contar interfaces virtuales (Docker, VPN, VirtualBox). Se puede forzar con `IP_TOTEM=192.168.0.5 npm start`. El puerto se puede cambiar con `PORT`.
- `player:join` responde `{ ok, id, token, color, spectator, host }` o `{ ok: false, error }`. El token lo guarda el celu en localStorage; con el mismo token recupera su lugar y su color (si tenía otra pestaña abierta, esa se desconecta).
- Si hay partida en curso o el lobby está lleno, quien entra queda como espectador; al volver al lobby pasa a jugar si hay lugar.
- En el lobby, un jugador desconectado se borra a los 20 s. Si se va el anfitrión, pasa al siguiente conectado.
- El tótem es uno solo: si se conecta otro, reemplaza al anterior. Al conectarse recibe `lobby:update`.

### Tótem (`public/totem/`)

- `game.js` maneja las fases `lobby → countdown (3 s) → playing → results (15 s) → lobby`. El tiempo avanza solo con `update(ms)`, así los tests lo adelantan a mano; la física corre a paso fijo de 1/60 s.
- Cada turno pasa por `aiming` (bola quieta, se mueve con `player:aim`) → `rolling` (física) → `result` (cartel de 1,4 s: ¡PLENO!, ¡SEMI-PLENO!, CANALETA, N pinos).
- Después del 1.er tiro se arma una pista nueva solo con los pinos en pie, donde quedaron. En el último frame, después de un pleno o semi-pleno vuelven los 10.
- Tiro automático suave si no tira en `segundosPorTurno` (sale desde donde estaba apuntando). Un jugador desconectado por más de 5 s pierde el frame (se completa con 0); si vuelve, juega el siguiente. Si se desconectan todos, la partida se abandona sin `game:over`.
- `game:state` lleva además `frames`, `turnState` (`aiming`/`rolling`/`result`), `pinsLeft`, `pins` (los pinos de la pista actual: `[{ n, x, y }]` en separaciones entre pinos, x desde el centro e y hacia atrás desde el pino 1; el celu los dibuja en su mini pista, así en el segundo tiro ve solo los que quedaron), `turnMsLeft`/`startsInMs`/`lobbyInMs` (milisegundos que faltan; no se manda la hora porque el reloj del celu puede no coincidir con el del tótem), `lastThrow` y, en resultados, `results`. Al conectarse, el tótem manda `totem:hello` y su estado (si se recargó, el servidor vuelve al lobby).

## Geometría (lienzo de 1080 x 1920)

- Pista de madera: x 270 → 810 (540 px de ancho), canaletas de 46 px a cada lado.
- Fin de la pista (foso): y = 220. Línea de foul: y = 1470. La bola sale en y = 1410.
- Pino 1 en y = 640, separación entre pinos 110 px, radio del pino 21, radio de la bola 36.
- Franja superior (0–200): nombre del jugador de turno, frame y tiro.
- Franja inferior (≈1520–1920): tabla de puntajes de todos los jugadores.

## Física (`public/shared/physics.js`, calibrada con `test/sim.js`)

Todos los números ajustables están en el objeto `TUNING` (exportado, así `sim.js` puede probar variantes).

- Gravedad 0. Pinos con `frictionAir` 0,035 y restitución 0,65; bola más pesada (densidad 0,004 contra 0,0012).
- **Radio de choque del pino 26,5** (se dibuja con 21). En 2D un pino no puede caerse y barrer a sus vecinos como en la realidad; agrandar su radio de choque lo compensa. Fue la perilla decisiva: con 21 casi no había plenos.
- Velocidad de la bola: 9,5 a 18 px por paso según la fuerza del deslizamiento. Ángulo máximo ±4,9°.
- **Efecto (curva)**: fuerza lateral solo en el último tramo (y entre 1250 y el pino 1) y solo hasta que la bola toca un pino. Se compensa con (velocidad / velocidad máxima)², así la curva es igual con un tiro lento o rápido (efecto 1 ≈ 120–130 px de desvío).
- **Canaleta**: si el centro de la bola pasa el borde *antes de tocar los pinos*, deja de chocar con ellos y sigue derecho. Si sale al costado después del choque, no cuenta como canaleta.
- **Después del choque** la bola sigue hacia el foso a 4 px por paso como mínimo (en 2D los pinos no saltan y la frenarían como un bloque) y el colchón del foso la frena.
- **Pino caído**: se movió más de 15 px de su lugar, cayó a la canaleta o pasó al foso.
- **Fin de la jugada**: bola en el foso o quieta y pinos quietos (los del foso no cuentan), con un mínimo de 2 s; corte de seguridad a los 9 s.
- Para el segundo tiro se retiran los pinos caídos y los que quedan conservan su posición (`standingAfter`).

### Resultado de la simulación (500 tiros por grupo, semillas 1 y 2)

| Grupo | Plenos | Pinos prom. | Canaletas | Duración |
|---|---|---|---|---|
| Al bolsillo (entre pino 1 y 3, con efecto) | 37–43 % | 8,8–8,9 | 0 % | 2,6–3,7 s |
| Al medio (pino 1 de frente) | 10–11 % | 7,9 | 0 % | 2,6–3,7 s |
| Al azar | 2–4 % | 3,6–3,9 | 25–28 % | 2,0–4,5 s |
| Torcidos (borde + ángulo hacia afuera) | 0 % | 0 | 94–95 % | 2,0–3,3 s |

Tiros con aim, efecto y posición menores a 0,5: 0 % de canaletas. Antes del ajuste: 0 % de plenos al bolsillo, 29 % de canaletas falsas y hasta 48 % de jugadas cortadas a los 9 s.

## Flujo del juego

1. **Lobby / espera**: QR grande, nombre de la escuela, lista de jugadores que se suman y el leaderboard rotando entre "Hoy", "Semana" y "Siempre". Si no hay nadie, una demo juega sola de fondo.
2. El primer jugador que entra es el **anfitrión** y tiene el botón "¡Empezar!" (también sirve la tecla Enter en el tótem). Con 1 solo jugador también se puede.
3. **Cuenta regresiva** 3, 2, 1.
4. **Turnos**: cada jugador juega su frame completo (1 o 2 tiros, hasta 3 en el último) y pasa al siguiente.
   - Su celu vibra y muestra "¡Tu turno!".
   - Si no tira en 25 segundos, se lanza un tiro automático suave para no trabar la partida.
   - Si se desconectó, se saltea su turno; si vuelve con el mismo token, recupera su lugar.
5. **Resultados**: podio durante 15 segundos, se guardan los puntajes en el leaderboard y se muestra el puesto de cada jugador ("¡Entraste al top 10 de hoy en el puesto 3!"). Si alguien bate el récord histórico, aparece un festejo especial. Después se vuelve al lobby.
6. Quien entra con una partida en curso queda como **espectador** para la siguiente y puede mandar reacciones.

## Control en el celular

- Pantalla simple con una mini pista y la bola abajo.
- **Arrastrar la bola a los costados** elige la posición de salida (se ve en vivo en el tótem).
- **Deslizar hacia arriba** lanza:
  - fuerza = velocidad del deslizamiento,
  - dirección = ángulo del trazo,
  - efecto = cuánto se curva el trazo (desvío del punto medio respecto de la línea recta).
- Cuando no es su turno: puntaje propio, quién está jugando y botones de reacciones (👏 🔥 😂 😱 🎳).
- Cálculo del gesto (`gesture.js`, números en `G`): la fuerza sale de la velocidad del último tramo (160 ms) medida en alturas de pantalla por segundo (0,6 → fuerza 0, 3,2 → fuerza 1); la dirección, del ángulo inicio-fin (±22° = aim ±1); el efecto, del desvío máximo respecto de esa recta (12 % del largo = efecto ±1; panza a la izquierda → engancha a la derecha). Un trazo de menos del 8 % de la pantalla o muy de costado no cuenta como tiro.
- El nombre y el token quedan en localStorage: si recarga la página dentro de las 3 h vuelve a entrar solo y recupera su lugar. Si se pierde la conexión aparece un aviso y reconecta solo; si el mismo jugador se abre en otra pestaña, la vieja muestra «Volver a conectar».
- Se evita el scroll, el zoom y el «tirar para recargar» (Chrome Android y Safari iPhone). Con la pantalla de turno usa Pointer Events, así también funciona con mouse.
- En el tótem las reacciones flotan con el nombre de quien las mandó. Para ver los emojis, la compu del tótem necesita una fuente de emojis (en Linux, Noto Color Emoji).

## Leaderboard

### Qué se guarda
Cada jugador de cada partida terminada genera un renglón en `data/puntajes.jsonl`:

```json
{"id":"a1b2c3","nombre":"Lucía","nombreClave":"lucia","puntaje":87,"frames":3,"plenos":2,"semiplenos":1,"fecha":"2026-11-01T14:32:10-03:00","partidaId":"p-0042","jugadores":3}
```

- Se guardan **todos** los puntajes, no solo los mejores, así queda el historial completo.
- Formato JSONL (un JSON por renglón): agregar es solo sumar una línea al final, sin reescribir el archivo, así no se pierde nada si se corta la luz.
- Copia de seguridad automática por día en `data/backups/`.
- Las partidas abandonadas (todos se desconectaron) no se guardan.
- `nombreClave` es el nombre en minúsculas y sin tildes, para agrupar "Lucía", "lucia" y "LUCIA" como la misma persona.

### Nombres de usuario
- El nombre se elige al entrar desde el celular (2 a 14 caracteres, letras, números y espacios).
- Filtro de malas palabras con una lista editable (`data/palabras-prohibidas.txt`), porque el leaderboard queda a la vista de todos en la escuela.
- El celular recuerda el nombre para la próxima vez, así cada persona juega siempre con el mismo.
- No hay contraseñas: dos personas pueden usar el mismo nombre. El leaderboard las agrupa como una sola. Si hace falta más adelante, se puede sumar el curso (ej. "Lucía - 5°I").

### Tablas que se muestran
| Tabla | Qué muestra |
|---|---|
| **Hoy** | top 10 de puntajes del día |
| **Semana** | top 10 de los últimos 7 días |
| **Siempre** | top 10 histórico |
| **Mejores jugadores** | el mejor puntaje de cada persona (sin repetir nombres), con cantidad de partidas jugadas y promedio |

- En las tablas de "Hoy", "Semana" y "Siempre" una misma persona puede aparecer varias veces. En "Mejores jugadores", una sola vez.
- Solo se comparan puntajes con la misma cantidad de frames. Si se cambia `frames` en la configuración, el leaderboard muestra los puntajes de esa cantidad.
- Empates: gana quien tiene más plenos y, si siguen empatados, quien lo logró antes.

### Dónde se ve
- **Tótem, en el lobby**: las tablas van rotando cada 8 segundos con una animación.
- **Tótem, en resultados**: el puesto de cada jugador y si es récord personal o histórico.
- **Celular, al terminar**: "Hiciste 87 puntos · Puesto 3 de hoy · Puesto 12 de siempre · ¡Récord personal!".
- **Página `/ranking`**: el leaderboard completo con pestañas, buscador por nombre y el historial de partidas de cada persona. Se puede abrir desde el celu (botón "Ver ranking" en el control) o desde cualquier compu de la red.

### Administración (`/admin`, protegido con PIN de `config.json`)
- Ver todos los puntajes, buscar y borrar uno (por ejemplo, un nombre ofensivo que pasó el filtro). Al borrar, el puntaje se marca como borrado en el archivo, no se elimina el renglón.
- Exportar todo a CSV para abrir en Excel o Google Sheets.
- Reiniciar el leaderboard: se archiva el archivo actual con la fecha y se empieza de cero (útil para un torneo o un evento nuevo).

## Presentación en el tótem

- Estética “Institucional Nº4” (rediseño del 2026-11-12, pedido porque la versión neón “parecía hecha por IA”): azul noche liso, azul `#6272B4` y celeste `#7AB6E6` del logo de la escuela, naranja `#F2A33A` solo para lo destacado; formas planas con esquinas chicas, sin brillos (`shadowBlur`), sin degradados violetas, sin emojis decorativos y con pocos “¡!”. Tipografías Barlow / Barlow Condensed empaquetadas (`@fontsource`, servidas en `/fonts`). Paleta en `public/shared/tema.css` y en `PAL` de `totem.js`. Pista de madera con tablas y flechas guía.
- Logo: `public/shared/emblema.svg`, el logo de la Escuela Industrial Nº4 “José Menéndez” redibujado en vector calcando el del sitio oficial de la escuela; `public/logo.png`, si existe, lo reemplaza. Crédito “Hecho por 5ºI Informática” en `config.json` → `creditos` (pie del lobby, celular, ranking y admin).
- Sombras, bola con brillo que gira, partículas al chocar.
- **Cámara lenta** cuando la bola llega a los pinos (opción `slowMotion` de `game.js`, la activa el tótem; baja a 0,35 desde 170 px antes del pino 1 hasta 0,7 s después del primer choque; la física da exactamente lo mismo), **sacudida de pantalla** (solo la pista) y carteles en banda horizontal con rebote: "PLENO" (naranja), "SEMIPLENO" (azul), "CANALETA", "9 PINOS".
- Chispas y astillas en cada choque (salen de `lane.hits`), confeti en plenos y semi-plenos, podio que entra fila por fila con el puntaje contando.
- El logo va como marca de agua tenue en la pista, grande en el lobby y chico en el encabezado (`/api/config` avisa si existe `public/logo.png`, así no se pide un archivo que no está y no hay 404 en la consola).
- Sonidos sintetizados en `sound.js` (rodar según velocidad, choque según fuerza, festejo, cuenta regresiva), sin archivos de audio. Tecla M = silencio (se recuerda).
- Demo en el lobby: si no hay jugadores, se tiran bolas solas de fondo (sin sonido).
- **Rendimiento** (la causa del lag era redibujar en cada cuadro cosas que casi no cambian, carísimo en compus sin aceleración por placa de video):
  - Dos lienzos apilados en `index.html`: `#fondo` (la pista; en el lobby además velo, título y QR; en la cuenta regresiva, el velo) se redibuja solo al cambiar de pantalla, y `#pantalla` se borra y redibuja en cada cuadro con lo que se mueve.
  - Encabezado y tablero de puntajes en capas en caché (`cachedLayer`), que se regeneran solo cuando cambia su contenido (un tiro, el reloj, el turno, la conexión).
  - Sin `shadowBlur` en ninguna parte (con el rediseño se sacaron todos los brillos; antes los textos con brillo se guardaban como imágenes).
  - La sacudida mueve `#escena` con CSS (no redibuja). El anillo del pleno y la fila ganadora imitan el halo con trazos en vez de `shadowBlur`. La cuenta regresiva no escala el número (cae y se desvanece).
  - `npm run prueba:rendimiento`: CPU 3 veces más lenta y sin placa de video. Antes: lobby 33 FPS y jugando 28 (con choques, 24). Después: lobby ≈59 y jugando ≈59, con menos del 2 % de cuadros de más de 25 ms.
- El lienzo de 1080 x 1920 se escala para entrar en cualquier pantalla (sirve para probar en una compu común).
- Atajos de teclado en el tótem: Enter = empezar, R = reiniciar (en el lobby borra los jugadores de prueba), F = pantalla completa, D = modo depuración, M = sonido, Espacio = tiro de prueba para el jugador de turno, P = agregar jugador de prueba (o abrir `/?prueba=3`). Los jugadores de prueba existen solo en el tótem.

## Configuración (`config.json`)

```json
{
  "nombreEscuela": "Industrial Nº4 José Menéndez",
  "frames": 3,
  "maxJugadores": 6,
  "puerto": 3000,
  "segundosPorTurno": 25,
  "pinAdmin": "1234",
  "segundosRotacionRanking": 8
}
```

## Instalación en el tótem

1. Instalar Node.js 20 o superior en la compu del tótem.
2. `npm install` y luego `npm start`. La consola muestra la IP local y la dirección del QR.
3. Abrir Chrome o Chromium en modo kiosco:
   `chromium --kiosk --autoplay-policy=no-user-gesture-required http://localhost:3000`
4. Los celulares tienen que estar en la **misma red wifi** que el tótem.
5. Si la red tiene "aislamiento de clientes" (pasa en wifi de escuelas), los celulares no ven al tótem: usar un router propio o un punto de acceso.

## Etapas

1. ✅ Proyecto creado, dependencias instaladas, física base escrita.
2. ✅ Puntaje + simulación en Node para ajustar la física.
3. ✅ Servidor con lobby, QR y reenvío de mensajes.
4. ✅ Pantalla del tótem jugable (pista, pinos, turnos, tabla).
5. ✅ Control del celular con deslizamiento.
6. ✅ Leaderboard: guardado de puntajes, tablas, página `/ranking` y panel `/admin`.
7. ✅ Presentación: partículas, sacudida, cámara lenta, textos animados, sonidos, logo, demo en el lobby y podio.
8. ✅ Prueba completa con 3 celulares + espectador, README de instalación e `iniciar.sh` / `iniciar.bat`.
   Pendiente fuera de la compu de desarrollo: probar con celulares reales en el tótem (calibrar la fuerza del deslizamiento en `G` de `gesture.js`) y probar `iniciar.bat` en Windows.
9. (Futuro) Lanzar con el acelerómetro usando HTTPS con certificado propio, temas alternativos, modo equipos.

## Auditoría y depuración (2026-11-12)

Revisión completa del código (servidor, tótem, celular, ranking y admin) buscando lo que puede romper el juego. Lo arreglado, cada cosa con su prueba:

- **Crítico:** un mensaje malformado desde cualquier celu tiraba abajo el servidor (`cleanName`/`clampNum` sin control de tipo y handlers de Socket.io sin try/catch) → validación de tipos y envoltorio `on()` que atrapa errores. Un error de disco al guardar (disco lleno, sin permiso) también lo tiraba → try/catch, y la copia diaria fallida ya no impide guardar. Un solo error en un cuadro congelaba el tótem para siempre (el bucle pedía el próximo cuadro al final) → se pide primero y el cuadro va en try/catch. `config.json` con tipos inválidos rompía el tótem → `loadConfig` valida tipos y rangos. El celu del anfitrión quedaba trabado en la pantalla de la partida anterior si se reconectaba con el tótem ya en el lobby → `lobby:update` limpia el estado viejo.
- **Alto:** el temporizador de 20 s del lobby borraba jugadores en plena partida → solo borra en el lobby, y al borrar promueve espectadores. Quien empezaba desconectado no tenía los 5 s de gracia → `goneSince: g.clock`. Un tiro perdido dejaba al jugador en «Lanzaste» → `player:throw` con confirmación y reintento. Sin localStorage cada reconexión creaba un jugador nuevo → token también en memoria. La pantalla del celu se apagaba sola → Wake Lock. `game:over` se perdía si el socket estaba caído → queda pendiente y se reenvía; el servidor guarda cada `partidaId` una sola vez (lo busca en `puntajes.jsonl`, así vale aunque se reinicie) y, si no conoce un id, acepta el nombre pasándolo por el filtro. Dos pestañas de tótem → la vieja recibe `totem:replaced` y se apaga. Servidor reiniciado en medio de una partida → el tótem la cancela con aviso.
- **Medio y bajo:** filtro de nombres sin falsos positivos ("Vergara") y con plurales, diminutivos y aumentativos ("Forros", "Boludazo"); lista de palabras en caché por fecha; tope de 30 espectadores; el tótem no puede unirse como jugador; nombres en NFC; vencimiento de los PIN errados (15 min) y errores de red visibles en el admin; carreras en el historial y "Cargando…" al cambiar de pestaña en el ranking; contraste WCAG AA (gris `#90A7BC`, rojo de texto `#F46C70`, botones `#5868AA` / `#C93A3F`); tablero legible con 5–6 jugadores; resultados sin saltos (lugar de la cinta reservado); aviso de salteado limpio en resultados; cartel "SIN CONEXIÓN" visible en resultados; logo con respaldo; configuración que se vuelve a pedir al reconectar; la demo del lobby ya no traba (sin `aimTowards`); sonido: M funciona con el audio suspendido y `roll` no programa eventos en cada cuadro; celu: turnos limpios entre partidas, bola al centro en cada turno, resultados con scroll, pantalla de entrada usable en celus chicos, vuelve solo si arranca la partida mientras cambia el nombre, mini pista que solo se anima en su pantalla; `iniciar.sh`/`iniciar.bat` reinician el servidor si se cae.
- **Pruebas:** 79 tests (`npm test`); `prueba:final` suma un error forzado en un cuadro del tótem y un celu que pierde la conexión en los resultados y vuelve con el tótem en el lobby.
- **Se dejó así (documentado en el README):** el tótem se acepta desde cualquier IP (decisión del usuario); el navegador pausa el juego si la ventana del tótem queda tapada (desactivar protector de pantalla); partidas solo con tiros automáticos se guardan; empates en la misma partida se ordenan por orden de juego; con el celu horizontal el deslizamiento da más fuerza.
