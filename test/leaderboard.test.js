const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLeaderboard, nombreClave, fechaLocal } = require('../leaderboard.js');

const HORA = 60 * 60 * 1000;
// 2026-11-10 12:00 en Argentina (15:00 UTC)
const MEDIODIA = Date.parse('2026-11-10T12:00:00-03:00');

const carpetas = [];
test.after(() => carpetas.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function nuevo(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bowling-lb-'));
  carpetas.push(dir);
  const reloj = { t: MEDIODIA };
  const lb = createLeaderboard(Object.assign({ dir, frames: 3, now: () => reloj.t }, opts));
  return { dir, reloj, lb };
}

const j = (nombre, puntaje, plenos = 0, semiplenos = 0) => ({ nombre, puntaje, plenos, semiplenos });

test('nombreClave: minúsculas, sin tildes y sin espacios repetidos', () => {
  assert.equal(nombreClave('  LUCÍA   Pérez '), 'lucia perez');
  assert.equal(nombreClave('Lucía'), nombreClave('lucia'));
  assert.equal(nombreClave('Muñoz'), 'munoz');
});

test('fechaLocal usa la hora de Argentina con su desfase', () => {
  assert.equal(fechaLocal(Date.parse('2026-11-01T17:32:10Z')), '2026-11-01T14:32:10-03:00');
  assert.equal(fechaLocal(Date.parse('2026-11-02T02:00:00Z')), '2026-11-01T23:00:00-03:00');
});

test('guarda un renglón por jugador y lo vuelve a leer al arrancar', () => {
  const { dir, lb } = nuevo();
  const res = lb.guardarPartida([j('Lucía', 87, 2, 1), j('Tomás', 40)]);
  assert.equal(res.length, 2);
  const lineas = fs.readFileSync(path.join(dir, 'puntajes.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lineas.length, 2);
  const r = JSON.parse(lineas[0]);
  assert.equal(r.nombre, 'Lucía');
  assert.equal(r.nombreClave, 'lucia');
  assert.equal(r.puntaje, 87);
  assert.equal(r.frames, 3);
  assert.equal(r.jugadores, 2);
  assert.equal(r.fecha, '2026-11-10T12:00:00-03:00');
  assert.equal(r.partidaId, JSON.parse(lineas[1]).partidaId);

  const otra = createLeaderboard({ dir, frames: 3, now: () => MEDIODIA });
  assert.deepEqual(otra.top('siempre').map((x) => x.nombre), ['Lucía', 'Tomás']);
});

test('los valores se acotan al máximo posible', () => {
  const { lb } = nuevo();
  const [r] = lb.guardarPartida([{ nombre: 'Trampa', puntaje: 9999, plenos: 50, semiplenos: -3 }]);
  assert.equal(r.registro.puntaje, 90);
  assert.equal(r.registro.plenos, 5);
  assert.equal(r.registro.semiplenos, 0);
});

test('orden: puntaje, después más plenos y después el más antiguo', () => {
  const { lb, reloj } = nuevo();
  lb.guardarPartida([j('Primero', 50, 1)]);
  reloj.t += HORA;
  lb.guardarPartida([j('Segundo', 50, 1)]);
  reloj.t += HORA;
  lb.guardarPartida([j('ConPlenos', 50, 3), j('Alto', 70)]);
  assert.deepEqual(lb.top('siempre').map((x) => x.nombre), ['Alto', 'ConPlenos', 'Primero', 'Segundo']);
  assert.deepEqual(lb.top('siempre').map((x) => x.puesto), [1, 2, 3, 4]);
});

test('mejores jugadores agrupa nombres con y sin tildes', () => {
  const { lb, reloj } = nuevo();
  lb.guardarPartida([j('Lucía', 60), j('Tomás', 30)]);
  reloj.t += HORA;
  lb.guardarPartida([j('lucia', 80)]);
  reloj.t += HORA;
  lb.guardarPartida([j('LUCIA', 40)]);
  const tabla = lb.jugadores();
  assert.equal(tabla.length, 2);
  assert.equal(tabla[0].nombre, 'lucia');
  assert.equal(tabla[0].puntaje, 80);
  assert.equal(tabla[0].partidas, 3);
  assert.equal(tabla[0].promedio, 60);
  assert.equal(tabla[1].nombre, 'Tomás');
  // en "siempre" la misma persona puede repetirse
  assert.equal(lb.top('siempre').filter((x) => nombreClave(x.nombre) === 'lucia').length, 3);

  const h = lb.historial('LUCÍA');
  assert.equal(h.partidas, 3);
  assert.equal(h.mejor, 80);
  assert.deepEqual(h.lista.map((x) => x.puntaje), [40, 80, 60]); // el más nuevo primero
  assert.equal(lb.historial('nadie'), null);
});

test('hoy, semana y siempre según la fecha de Argentina', () => {
  const { lb, reloj } = nuevo();
  reloj.t = MEDIODIA - 10 * 24 * HORA;
  lb.guardarPartida([j('Viejo', 90)]);
  reloj.t = MEDIODIA - 3 * 24 * HORA;
  lb.guardarPartida([j('Semana', 80)]);
  // 23:30 del día anterior en Argentina (02:30 UTC del día 10): no es "hoy"
  reloj.t = Date.parse('2026-11-09T23:30:00-03:00');
  lb.guardarPartida([j('Anoche', 70)]);
  reloj.t = Date.parse('2026-11-10T00:10:00-03:00');
  lb.guardarPartida([j('Temprano', 20)]);
  reloj.t = MEDIODIA;
  assert.deepEqual(lb.top('hoy').map((x) => x.nombre), ['Temprano']);
  assert.deepEqual(lb.top('semana').map((x) => x.nombre), ['Semana', 'Anoche', 'Temprano']);
  assert.deepEqual(lb.top('siempre').map((x) => x.nombre), ['Viejo', 'Semana', 'Anoche', 'Temprano']);
  // cambio de día: a la noche siguiente "Temprano" deja de ser de hoy
  reloj.t = Date.parse('2026-11-11T00:01:00-03:00');
  assert.deepEqual(lb.top('hoy'), []);
});

test('solo se comparan puntajes con la misma cantidad de frames', () => {
  const { dir, lb } = nuevo();
  lb.guardarPartida([j('Tres', 50)]);
  const cinco = createLeaderboard({ dir, frames: 5, now: () => MEDIODIA });
  assert.deepEqual(cinco.top('siempre'), []);
  cinco.guardarPartida([j('Cinco', 100)]);
  assert.deepEqual(cinco.top('siempre').map((x) => x.nombre), ['Cinco']);
  assert.equal(cinco.listar().length, 2); // el admin ve todos
});

test('puesto, récord personal y récord histórico', () => {
  const { lb, reloj } = nuevo();
  const [primera] = lb.guardarPartida([j('Ana', 50)]);
  assert.equal(primera.puestoHoy, 1);
  assert.equal(primera.esRecordPersonal, false); // primera partida: no hay récord que batir
  assert.equal(primera.esRecordHistorico, true);

  reloj.t += HORA;
  const [a, b] = lb.guardarPartida([j('Ana', 70), j('Beto', 60)]);
  assert.equal(a.esRecordPersonal, true);
  assert.equal(a.esRecordHistorico, true);
  assert.equal(b.esRecordHistorico, false); // superó el récord anterior, pero Ana hizo más en la misma partida
  assert.equal(b.puestoSiempre, 2);

  reloj.t += HORA;
  const [c] = lb.guardarPartida([j('ana', 55)]);
  assert.equal(c.esRecordPersonal, false);
  assert.equal(c.puestoSiempre, 3);
  assert.equal(c.puestoHoy, 3);

  reloj.t += HORA;
  const [cero] = lb.guardarPartida([j('Ceros', 0)]);
  assert.equal(cero.esRecordHistorico, false);
});

test('borrar agrega un renglón y no reescribe el archivo', () => {
  const { dir, lb } = nuevo();
  const [r] = lb.guardarPartida([j('Ofensivo', 99), j('Bien', 10)]);
  const antes = fs.readFileSync(path.join(dir, 'puntajes.jsonl'), 'utf8');
  assert.equal(lb.borrar(r.registro.id), true);
  assert.equal(lb.borrar(r.registro.id), false);
  assert.equal(lb.borrar('no-existe'), false);
  const despues = fs.readFileSync(path.join(dir, 'puntajes.jsonl'), 'utf8');
  assert.ok(despues.startsWith(antes));
  assert.deepEqual(JSON.parse(despues.trim().split('\n').pop()).borrar, r.registro.id);
  assert.deepEqual(lb.top('siempre').map((x) => x.nombre), ['Bien']);
  const otra = createLeaderboard({ dir, frames: 3, now: () => MEDIODIA });
  assert.deepEqual(otra.top('siempre').map((x) => x.nombre), ['Bien']);
});

test('renglones dañados se ignoran y lo nuevo empieza en un renglón aparte', () => {
  const { dir, lb } = nuevo();
  lb.guardarPartida([j('Bien', 30)]);
  const archivo = path.join(dir, 'puntajes.jsonl');
  fs.appendFileSync(archivo, 'esto no es json\n{"id":"x","nombre":"SinPuntaje"}\n{"id":"cortado","nombre":"Cor');
  const otra = createLeaderboard({ dir, frames: 3, now: () => MEDIODIA });
  assert.deepEqual(otra.top('siempre').map((x) => x.nombre), ['Bien']);
  otra.guardarPartida([j('Despues', 40)]);
  const tercera = createLeaderboard({ dir, frames: 3, now: () => MEDIODIA });
  assert.deepEqual(tercera.top('siempre').map((x) => x.nombre), ['Despues', 'Bien']);
});

test('copia diaria y reinicio archivando el archivo', () => {
  const { dir, lb, reloj } = nuevo();
  lb.guardarPartida([j('Uno', 10)]);
  assert.equal(fs.existsSync(path.join(dir, 'backups')), false); // todavía no había archivo
  lb.guardarPartida([j('Dos', 20)]);
  const copia = path.join(dir, 'backups', 'puntajes-2026-11-10.jsonl');
  assert.equal(fs.readFileSync(copia, 'utf8').trim().split('\n').length, 1);
  lb.guardarPartida([j('Tres', 30)]);
  assert.equal(fs.readFileSync(copia, 'utf8').trim().split('\n').length, 1); // una sola por día
  reloj.t += 24 * HORA;
  lb.guardarPartida([j('Cuatro', 40)]);
  assert.ok(fs.existsSync(path.join(dir, 'backups', 'puntajes-2026-11-11.jsonl')));

  const archivado = lb.reiniciar();
  assert.match(archivado, /^archivo[/\\]puntajes-2026-11-11T12-00-00\.jsonl$/);
  assert.equal(fs.existsSync(path.join(dir, 'puntajes.jsonl')), false);
  assert.deepEqual(lb.top('siempre'), []);
  assert.equal(fs.readFileSync(path.join(dir, archivado), 'utf8').trim().split('\n').length, 4);
});

test('filtro de nombres con reemplazos y letras repetidas', () => {
  const { dir, lb } = nuevo();
  for (const malo of ['puto', 'PUTO', 'Put0', 'p u t o', 'Juan Boludo', 'bolud0s', 'puuuuto', 'P0r0ng4', 'Mierdá']) {
    assert.equal(lb.nombrePermitido(malo), false, malo);
  }
  for (const bueno of ['Lucía', 'Caputo', 'Mariano', 'Luciano', 'Penélope', 'Ortiz', 'Tomás 5I']) {
    assert.equal(lb.nombrePermitido(bueno), true, bueno);
  }
  // la lista se puede editar en caliente
  fs.appendFileSync(path.join(dir, 'palabras-prohibidas.txt'), 'pepino\n');
  assert.equal(lb.nombrePermitido('Pepino'), false);
});

test('csv con BOM, separador ";" y tildes', () => {
  const { lb } = nuevo();
  lb.guardarPartida([j('Lucía', 87, 2, 1)]);
  const csv = lb.csv();
  assert.ok(csv.startsWith('﻿Fecha;Hora;Nombre;Puntaje'));
  const fila = csv.trim().split('\r\n')[1].split(';');
  assert.deepEqual(fila.slice(0, 7), ['2026-11-10', '12:00:00', 'Lucía', '87', '3', '2', '1']);
});

test('si falla la copia diaria, el puntaje se guarda igual', () => {
  const { dir, lb } = nuevo();
  lb.guardarPartida([j('Uno', 10)]);
  fs.writeFileSync(path.join(dir, 'backups'), 'no soy una carpeta'); // mkdir de backups/ va a fallar
  const r = lb.guardarPartida([j('Dos', 20)]);
  assert.equal(r.length, 1);
  assert.deepEqual(lb.top('siempre').map((x) => x.nombre), ['Dos', 'Uno']);
});

test('filtro: apellidos que empiezan como una palabra prohibida pasan; plurales y aumentativos no', () => {
  const { lb } = nuevo();
  for (const bueno of ['Vergara', 'Ana Vergara', 'Penélope', 'Ortiz', 'Caputo']) {
    assert.equal(lb.nombrePermitido(bueno), true, bueno);
  }
  for (const malo of ['Forros', 'Boludazo', 'Boludito', 'Pelotudas', 'Conchudos', 'Forra', 'P3l0tud0n']) {
    assert.equal(lb.nombrePermitido(malo), false, malo);
  }
});
