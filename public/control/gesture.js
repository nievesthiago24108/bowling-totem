/*
 * Convierte el deslizamiento del dedo en un tiro { power, aim, spin }.
 * Funciona en el navegador (window.BowlingGesture) y en Node (require) para los tests.
 *
 * points: [{ x, y, t }] en píxeles de pantalla y milisegundos, en el orden del trazo.
 * screenH: alto de la pantalla, para que la fuerza no dependa del tamaño del celular.
 *
 *   fuerza    = velocidad del trazo (alturas de pantalla por segundo)
 *   dirección = ángulo de la recta inicio → fin
 *   efecto    = cuánto se aparta el trazo de esa recta (en el medio), con signo:
 *               si la panza queda a la izquierda, la bola engancha a la derecha (efecto +)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BowlingGesture = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const G = {
    minDistance: 0.08,   // trazo mínimo hacia arriba (fracción del alto de pantalla)
    speedSlow: 0.6,      // alturas/s que dan power 0
    speedFast: 3.2,      // alturas/s que dan power 1
    speedWindowMs: 160,  // la velocidad se mide en el último tramo del trazo
    maxAngleDeg: 22,     // ángulo del trazo que da aim ±1
    fullSpinRatio: 0.12, // desvío del medio / largo del trazo que da efecto ±1
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /** Velocidad del último tramo del trazo, en px/ms */
  function endSpeed(points) {
    const last = points[points.length - 1];
    let i = points.length - 1;
    while (i > 0 && last.t - points[i - 1].t <= G.speedWindowMs) i--;
    if (i === points.length - 1) i = Math.max(0, i - 1);
    const a = points[i];
    const dt = Math.max(1, last.t - a.t);
    return Math.hypot(last.x - a.x, last.y - a.y) / dt;
  }

  /** Desvío con signo del trazo respecto de la recta inicio-fin (el punto más alejado) */
  function deviation(points) {
    const s = points[0], e = points[points.length - 1];
    const cx = e.x - s.x, cy = e.y - s.y;
    const len = Math.hypot(cx, cy) || 1;
    let best = 0;
    for (let i = 1; i < points.length - 1; i++) {
      // producto cruz / largo = distancia con signo a la recta
      const d = (cx * (points[i].y - s.y) - cy * (points[i].x - s.x)) / len;
      if (Math.abs(d) > Math.abs(best)) best = d;
    }
    return { dev: best, len };
  }

  /** Devuelve { power, aim, spin } o null si el trazo no sirve como tiro */
  function analyze(points, screenH) {
    if (!Array.isArray(points) || points.length < 2 || !(screenH > 0)) return null;
    const s = points[0], e = points[points.length - 1];
    const up = s.y - e.y;
    if (up < G.minDistance * screenH) return null;      // muy corto o hacia abajo
    if (Math.abs(e.x - s.x) > up * 1.2) return null;    // demasiado de costado

    const speed = endSpeed(points) / screenH * 1000;   // alturas de pantalla por segundo
    const power = clamp((speed - G.speedSlow) / (G.speedFast - G.speedSlow), 0, 1);
    const angle = Math.atan2(e.x - s.x, up) * 180 / Math.PI;
    const aim = clamp(angle / G.maxAngleDeg, -1, 1);
    const { dev, len } = deviation(points);
    // trazo hacia arriba: desvío negativo = panza a la izquierda → engancha a la derecha
    const spin = clamp(-dev / (G.fullSpinRatio * len), -1, 1);
    const r = (v) => Math.round(v * 1000) / 1000 + 0; // + 0 evita el -0
    return { power: r(power), aim: r(aim), spin: r(spin) };
  }

  return { analyze, G };
});
