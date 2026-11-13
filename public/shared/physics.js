/*
 * Física del bowling (vista desde arriba) con Matter.js.
 * Funciona en el navegador (window.BowlingPhysics) y en Node (require) para pruebas.
 *
 * Unidades: píxeles del lienzo lógico de 1080 x 1920. Velocidades en px por paso (≈16,7 ms).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BowlingPhysics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Geometría de la pista dentro del lienzo de 1080 x 1920
  const LANE = {
    left: 270,          // borde izquierdo de la pista (madera)
    right: 810,         // borde derecho
    gutter: 46,         // ancho de cada canaleta
    top: 220,           // fin de la pista (después está el foso)
    foul: 1470,         // línea de foul
    ballStartY: 1410,   // donde arranca la bola
    pinRadius: 21,
    ballRadius: 36,
    pinSpacing: 110,    // distancia entre pinos vecinos
    headPinY: 640,      // posición del pino 1
  };
  LANE.width = LANE.right - LANE.left;
  LANE.centerX = (LANE.left + LANE.right) / 2;

  // Números ajustables de la física (calibrados con test/sim.js)
  const TUNING = {
    pinDensity: 0.0012,
    pinFrictionAir: 0.035,
    pinRestitution: 0.65,
    pinHitRadius: 26.5,  // radio de choque del pino: al caer, un pino real barre más que su base dibujada (21)
    knockDistance: 15,   // un pino que se movió más que esto cuenta como caído
    ballDensity: 0.004,
    ballFrictionAir: 0.0035,
    speedMin: 9.5,       // px por paso con power 0
    speedRange: 8.5,     // se suma con power 1
    maxAngle: 0.085,     // radianes con aim ±1 (±4,9°)
    spinForce: 0.0000105,
    spinStartY: 1250,    // el efecto actúa desde acá hasta el pino 1
    carrySpeed: 4,       // en 2D los pinos no saltan: tras el choque la bola sigue al foso a esta velocidad mínima
    pitFrictionAir: 0.08, // el colchón del foso frena la bola
  };

  // Posiciones de los 10 pinos (1 adelante, 7-10 atrás)
  function pinLayout() {
    const s = LANE.pinSpacing;
    const dy = s * 0.866;
    const cx = LANE.centerX;
    const rows = [[1], [2, 3], [4, 5, 6], [7, 8, 9, 10]];
    const out = [];
    rows.forEach((row, r) => {
      row.forEach((num, i) => {
        const x = cx + (i - (row.length - 1) / 2) * s;
        const y = LANE.headPinY - r * dy;
        out.push({ num, x, y });
      });
    });
    return out;
  }

  /**
   * Crea un mundo nuevo. `standing` es la lista de números de pino que siguen en pie
   * (por defecto los 10). `prevPins` permite conservar la posición donde quedaron.
   */
  function createLane(Matter, opts) {
    opts = opts || {};
    const { Engine, Bodies, Composite, Events } = Matter;
    const engine = Engine.create({ gravity: { x: 0, y: 0 } });
    engine.positionIterations = 10;
    engine.velocityIterations = 8;

    const wallOpts = { isStatic: true, restitution: 0.4, friction: 0, label: 'wall' };
    const outerL = LANE.left - LANE.gutter;
    const outerR = LANE.right + LANE.gutter;
    const walls = [
      // paredes exteriores de las canaletas
      Bodies.rectangle(outerL - 20, 900, 40, 2200, wallOpts),
      Bodies.rectangle(outerR + 20, 900, 40, 2200, wallOpts),
      // fondo del foso
      Bodies.rectangle(LANE.centerX, LANE.top - 170, 1000, 40, { ...wallOpts, restitution: 0.1 }),
    ];
    Composite.add(engine.world, walls);

    const layout = pinLayout();
    const standing = opts.standing || layout.map((p) => p.num);
    const prev = opts.prevPins || {};
    const pins = [];
    layout.forEach((p) => {
      if (!standing.includes(p.num)) return;
      const pos = prev[p.num] || { x: p.x, y: p.y };
      const body = Bodies.circle(pos.x, pos.y, TUNING.pinHitRadius, {
        label: 'pin',
        density: TUNING.pinDensity,
        frictionAir: TUNING.pinFrictionAir,
        restitution: TUNING.pinRestitution,
        friction: 0.05,
        collisionFilter: { category: 0x0002, mask: 0xffffffff, group: 0 },
      });
      body.pinNum = p.num;
      body.home = { x: pos.x, y: pos.y };
      body.down = false;
      body.inGutter = false;
      pins.push(body);
    });
    Composite.add(engine.world, pins);

    const state = {
      Matter,
      engine,
      pins,
      ball: null,
      spin: 0,
      released: false,
      inGutter: false,
      hitPin: false, // la bola ya tocó algún pino
      steps: 0,
      stepsSinceRelease: 0,
      hits: [], // eventos de choques para sonido/partículas
    };

    Events.on(engine, 'collisionStart', (ev) => {
      ev.pairs.forEach((pair) => {
        const a = pair.bodyA, b = pair.bodyB;
        const labels = [a.label, b.label].sort().join('-');
        if (labels === 'ball-pin') state.hitPin = true;
        if (labels === 'ball-pin' || labels === 'pin-pin') {
          const rel = Math.hypot(a.velocity.x - b.velocity.x, a.velocity.y - b.velocity.y);
          if (rel > 0.8) {
            state.hits.push({
              x: (a.position.x + b.position.x) / 2,
              y: (a.position.y + b.position.y) / 2,
              strength: Math.min(1, rel / 12),
              kind: labels,
            });
          }
        }
      });
    });

    return state;
  }

  /**
   * Convierte el gesto del celular en un tiro.
   * power: 0..1  · aim: -1..1 (dirección) · spin: -1..1 (efecto) · position: -1..1 (posición de salida)
   */
  function throwBall(state, params) {
    const { Bodies, Body, Composite } = state.Matter;
    const power = clamp(num(params.power, 0.6), 0, 1);
    const aim = clamp(num(params.aim, 0), -1, 1);
    const spin = clamp(num(params.spin, 0), -1, 1);
    const position = clamp(num(params.position, 0), -1, 1);

    const startX = LANE.centerX + position * (LANE.width / 2 - LANE.ballRadius - 6);
    const ball = Bodies.circle(startX, LANE.ballStartY, LANE.ballRadius, {
      label: 'ball',
      density: TUNING.ballDensity,
      frictionAir: TUNING.ballFrictionAir,
      restitution: 0.2,
      friction: 0.02,
    });
    const speed = TUNING.speedMin + power * TUNING.speedRange;
    const angle = aim * TUNING.maxAngle;
    Body.setVelocity(ball, { x: Math.sin(angle) * speed, y: -Math.cos(angle) * speed });
    Composite.add(state.engine.world, ball);
    state.ball = ball;
    state.spin = spin;
    // la curva no depende de la velocidad: una bola lenta pasa más tiempo bajo el efecto,
    // así que se compensa con (velocidad / velocidad máxima)²
    state.spinScale = Math.pow(speed / (TUNING.speedMin + TUNING.speedRange), 2);
    state.released = true;
    state.stepsSinceRelease = 0;
    state.params = { power, aim, spin, position };
    return ball;
  }

  function step(state, dtMs) {
    const { Body, Engine } = state.Matter;
    const ball = state.ball;
    if (ball) {
      const onLane = ball.position.y > LANE.top && ball.position.y < LANE.foul + 60;
      // Canaleta: si el centro de la bola pasa el borde antes de llegar a los pinos,
      // cae y deja de tocarlos. Después del choque, la bola puede rebotar a los costados.
      if (!state.inGutter && !state.hitPin && onLane &&
          (ball.position.x < LANE.left - 4 || ball.position.x > LANE.right + 4)) {
        state.inGutter = true;
        ball.collisionFilter.mask = 0x0001; // solo paredes: deja de chocar con pinos (0x0002)
        ball.collisionFilter.category = 0x0004;
        state.hits.push({ x: ball.position.x, y: ball.position.y, strength: 0.4, kind: 'gutter' });
      }
      if (state.inGutter && onLane) {
        // la canaleta guía la bola derecho
        const gx = ball.position.x < LANE.centerX
          ? LANE.left - LANE.gutter / 2 : LANE.right + LANE.gutter / 2;
        Body.setPosition(ball, { x: ball.position.x + (gx - ball.position.x) * 0.25, y: ball.position.y });
        Body.setVelocity(ball, { x: 0, y: Math.min(ball.velocity.y, -6) });
      } else if (!state.hitPin && ball.position.y < TUNING.spinStartY && ball.position.y > LANE.headPinY - 40) {
        // efecto (curva) en el último tramo, como en la realidad
        Body.applyForce(ball, ball.position, { x: state.spin * state.spinScale * TUNING.spinForce * ball.mass * 60, y: 0 });
      }
      if (ball.position.y < LANE.top) ball.frictionAir = TUNING.pitFrictionAir;
      else if (state.hitPin && ball.position.y > LANE.top - 40 && ball.velocity.y > -TUNING.carrySpeed) {
        Body.setVelocity(ball, { x: ball.velocity.x, y: -TUNING.carrySpeed });
      }
    }
    // pinos que caen a la canaleta: quedan guiados y no vuelven a la pista
    state.pins.forEach((p) => {
      if (!p.inGutter && (p.position.x < LANE.left - 2 || p.position.x > LANE.right + 2) &&
          p.position.y > LANE.top) {
        p.inGutter = true;
      }
    });
    Engine.update(state.engine, dtMs || 1000 / 60);
    state.steps++;
    if (state.released) state.stepsSinceRelease++;
  }

  /** Pinos que se consideran caídos en este momento */
  function knockedPins(state) {
    return state.pins.filter((p) => {
      const d = Math.hypot(p.position.x - p.home.x, p.position.y - p.home.y);
      return d > TUNING.knockDistance || p.inGutter || p.position.y < LANE.top - 10;
    });
  }

  /** ¿Terminó la jugada? (bola en el foso o quieta, y pinos quietos) */
  function isSettled(state) {
    const ball = state.ball;
    if (!ball) return false;
    const ballDone = ball.position.y < LANE.top - 40 || ball.speed < 0.25;
    // los pinos que ya cayeron al foso no cuentan
    const pinsQuiet = state.pins.every((p) => p.speed < 0.08 || p.position.y < LANE.top - 10);
    if (ballDone && pinsQuiet && state.stepsSinceRelease > 120) return true; // mínimo 2 s
    return state.stepsSinceRelease > 60 * 9; // corte de seguridad: 9 s
  }

  /** Posiciones actuales de los pinos que siguen en pie (para el segundo tiro) */
  function standingAfter(state) {
    const down = new Set(knockedPins(state).map((p) => p.pinNum));
    const standing = [];
    const prevPins = {};
    state.pins.forEach((p) => {
      if (down.has(p.pinNum)) return;
      standing.push(p.pinNum);
      prevPins[p.pinNum] = { x: p.position.x, y: p.position.y };
    });
    return { standing, prevPins, knocked: down.size };
  }

  function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  return { LANE, TUNING, pinLayout, createLane, throwBall, step, knockedPins, isSettled, standingAfter };
});
