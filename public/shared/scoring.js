/*
 * Puntaje oficial de bowling para N frames (pleno, semi-pleno y tiros extra en el último).
 * Funciona en el navegador (window.BowlingScoring) y en Node (require).
 *
 * La tarjeta es JSON plano, se puede mandar por Socket.io tal cual:
 *   { frames: 3, rolls: [[10], [7, 3], [10, 10, 10]] }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BowlingScoring = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PINS = 10;

  function createCard(frames) {
    const n = frames === undefined ? 3 : frames;
    if (!Number.isInteger(n) || n < 1) throw new Error('Cantidad de frames inválida');
    return { frames: n, rolls: [] };
  }

  function isLast(card, i) { return i === card.frames - 1; }

  /** ¿El frame i ya no admite más tiros? */
  function frameDone(card, i) {
    const r = card.rolls[i] || [];
    if (!isLast(card, i)) return r[0] === PINS || r.length === 2;
    if (r.length < 2) return false;
    if (r.length === 3) return true;
    return r[0] + r[1] < PINS; // sin pleno ni semi-pleno no hay 3.er tiro
  }

  function isComplete(card) {
    return card.rolls.length === card.frames && frameDone(card, card.frames - 1);
  }

  /** Índice (desde 0) del frame que se está jugando; -1 si la tarjeta terminó */
  function currentFrame(card) {
    if (isComplete(card)) return -1;
    const i = card.rolls.length - 1;
    return i >= 0 && !frameDone(card, i) ? i : card.rolls.length;
  }

  /** Número de tiro dentro del frame actual (1, 2 o 3); 0 si la tarjeta terminó */
  function throwInFrame(card) {
    const i = currentFrame(card);
    if (i < 0) return 0;
    return (card.rolls[i] || []).length + 1;
  }

  /** Pinos en pie para el próximo tiro */
  function pinsLeft(card) {
    const i = currentFrame(card);
    if (i < 0) return 0;
    const r = card.rolls[i] || [];
    if (r.length === 0) return PINS;
    if (!isLast(card, i)) return PINS - r[0];
    if (r.length === 1) return r[0] === PINS ? PINS : PINS - r[0];
    // 3.er tiro del último frame
    if (r[0] === PINS) return r[1] === PINS ? PINS : PINS - r[1];
    return PINS; // después de un semi-pleno
  }

  /** Registra un tiro. Devuelve la misma tarjeta. */
  function addRoll(card, pins) {
    if (isComplete(card)) throw new Error('La tarjeta ya está completa');
    const left = pinsLeft(card);
    if (!Number.isInteger(pins) || pins < 0 || pins > left) {
      throw new Error('Tiro inválido: ' + pins + ' (quedan ' + left + ')');
    }
    const i = currentFrame(card);
    if (!card.rolls[i]) card.rolls[i] = [];
    card.rolls[i].push(pins);
    return card;
  }

  /** Puntaje acumulado por frame; null donde todavía falta el bonus o el frame */
  function frameScores(card) {
    const flat = [];
    const starts = [];
    card.rolls.forEach((r) => { starts.push(flat.length); flat.push(...r); });
    const out = [];
    let acc = 0;
    for (let i = 0; i < card.frames; i++) {
      const r = card.rolls[i];
      if (!r || !frameDone(card, i)) { out.push(null); acc = NaN; continue; }
      let value;
      if (isLast(card, i)) {
        value = r.reduce((a, b) => a + b, 0);
      } else {
        const s = starts[i];
        const strike = r[0] === PINS;
        const spare = !strike && r[0] + r[1] === PINS;
        const need = strike ? 2 : spare ? 1 : 0;
        const firstBonus = s + r.length;
        if (flat.length < firstBonus + need) { out.push(null); acc = NaN; continue; }
        value = r[0] + (r[1] || 0);
        for (let k = 0; k < need; k++) value += flat[firstBonus + k];
      }
      acc += value;
      out.push(Number.isNaN(acc) ? null : acc);
    }
    return out;
  }

  /** Total con los tiros que ya se pueden contar (los bonus pendientes aún no suman) */
  function total(card) {
    const flat = [];
    card.rolls.forEach((r) => flat.push(...r));
    let sum = 0;
    let pos = 0;
    for (let i = 0; i < card.rolls.length; i++) {
      const r = card.rolls[i];
      sum += r.reduce((a, b) => a + b, 0);
      pos += r.length;
      if (isLast(card, i)) continue;
      const strike = r[0] === PINS;
      const spare = !strike && r.length === 2 && r[0] + r[1] === PINS;
      const need = strike ? 2 : spare ? 1 : 0;
      for (let k = 0; k < need && pos + k < flat.length; k++) sum += flat[pos + k];
    }
    return sum;
  }

  function mark(pins, prev, canSpare) {
    if (canSpare && prev !== null && prev + pins === PINS) return '/';
    if (pins === PINS) return 'X';
    if (pins === 0) return '-';
    return String(pins);
  }

  /** Detalle para mostrar: [{ marks: ['X'], cumulative: 30 }, ...] */
  function display(card) {
    const scores = frameScores(card);
    const out = [];
    for (let i = 0; i < card.frames; i++) {
      const r = card.rolls[i] || [];
      const marks = [];
      let prev = null; // tiro anterior que dejó pinos en pie (para el "/")
      r.forEach((p) => {
        const m = mark(p, prev, prev !== null);
        marks.push(m);
        prev = m === 'X' || m === '/' ? null : p;
      });
      out.push({ marks, cumulative: scores[i] });
    }
    return out;
  }

  return { PINS, createCard, addRoll, frameDone, isComplete, currentFrame, throwInFrame, pinsLeft, frameScores, total, display };
});
