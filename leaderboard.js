/*
 * Leaderboard del Bowling Tótem: guarda todos los puntajes en data/puntajes.jsonl
 * (un JSON por renglón, solo se agrega al final) y responde las tablas.
 *
 *   const lb = createLeaderboard({ dir: 'data', frames: 3 });
 *   lb.guardarPartida([{ nombre: 'Lucía', puntaje: 87, plenos: 2, semiplenos: 1 }]);
 *   lb.top('hoy');
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ZONA = 'America/Argentina/Buenos_Aires';
const DIA_MS = 24 * 60 * 60 * 1000;
const TABLAS = ['hoy', 'semana', 'siempre'];

const PALABRAS_BASE = `# Una palabra por renglón. Se compara sin tildes, sin mayúsculas y detectando
# reemplazos como 4→a, 3→e, 0→o, 1→i, 5→s, 7→t y letras repetidas ("puuuto").
# Una palabra prohibida rechaza el nombre si aparece como palabra suelta; las de 5 letras
# o más también si el nombre empieza con ella ("boludos"). Se puede editar en cualquier momento.
puto
puta
trolo
trola
pija
poronga
concha
conchudo
conchuda
chota
culo
orto
ojete
mierda
boludo
boluda
pelotudo
pelotuda
forro
forra
garca
sorete
verga
pene
coger
cogida
pajero
pajera
culiado
culiao
cagon
cagona
mogolico
mogolica
tarado
tarada
idiota
imbecil
estupido
estupida
hdp
ptm
lpm
sexo
porno
nazi
hitler
violador
`;

/** Minúsculas, sin tildes y sin espacios repetidos: "  LUCÍA  Pérez" → "lucia perez" */
function nombreClave(nombre) {
  return String(nombre == null ? '' : nombre)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Para el filtro: además deshace reemplazos (p0rong4 → poronga) y letras repetidas */
function normalizarFiltro(s) {
  return nombreClave(s)
    .replace(/[4@]/g, 'a').replace(/3/g, 'e').replace(/0/g, 'o').replace(/[1!]/g, 'i')
    .replace(/5/g, 's').replace(/7/g, 't')
    .replace(/[^a-zñ ]/g, '')
    .replace(/(.)\1+/g, '$1');
}

/** Fecha y hora de Argentina con su desfase: "2026-11-01T14:32:10-03:00" */
const formatoFecha = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
});
function fechaLocal(ms) {
  const p = {};
  formatoFecha.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  const desfase = p.timeZoneName.replace('GMT', '') || '+00:00';
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${desfase}`;
}

const entero = (v, min, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
};

/** Mejor primero: más puntos, más plenos y, si siguen empatados, quien lo logró antes */
function comparar(a, b) {
  return b.puntaje - a.puntaje || b.plenos - a.plenos || a.t - b.t;
}

function esRegistro(r) {
  return r && typeof r.id === 'string' && typeof r.nombre === 'string' &&
    Number.isFinite(r.puntaje) && Number.isFinite(r.frames) && typeof r.fecha === 'string' &&
    Number.isFinite(Date.parse(r.fecha));
}

function createLeaderboard(opts) {
  opts = opts || {};
  const dir = opts.dir || path.join(__dirname, 'data');
  const frames = opts.frames || 3;
  const now = opts.now || Date.now;
  const archivo = path.join(dir, 'puntajes.jsonl');
  const archivoPalabras = path.join(dir, 'palabras-prohibidas.txt');

  let registros = [];        // todos los puntajes leídos (con t = fecha en ms)
  let borrados = new Set();  // ids marcados como borrados

  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(archivoPalabras)) fs.writeFileSync(archivoPalabras, PALABRAS_BASE);
  cargar();

  function cargar() {
    registros = [];
    borrados = new Set();
    let texto = '';
    try { texto = fs.readFileSync(archivo, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    texto.split('\n').forEach((linea) => {
      if (!linea.trim()) return;
      let obj;
      try { obj = JSON.parse(linea); } catch { return; } // renglón dañado (ej. corte de luz): se ignora
      if (obj && typeof obj.borrar === 'string') borrados.add(obj.borrar);
      else if (esRegistro(obj)) registros.push(Object.assign(obj, { t: Date.parse(obj.fecha) }));
    });
  }

  /** Agrega renglones al final del archivo; si el último quedó cortado, empieza en uno nuevo */
  function agregar(objs) {
    let prefijo = '';
    try {
      const fd = fs.openSync(archivo, 'r');
      const { size } = fs.fstatSync(fd);
      if (size > 0) {
        const b = Buffer.alloc(1);
        fs.readSync(fd, b, 0, 1, size - 1);
        if (b[0] !== 0x0a) prefijo = '\n';
      }
      fs.closeSync(fd);
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    fs.appendFileSync(archivo, prefijo + objs.map((o) => JSON.stringify(o)).join('\n') + '\n');
  }

  const vigentes = () => registros.filter((r) => !borrados.has(r.id) && r.frames === frames);
  const hoy = () => fechaLocal(now()).slice(0, 10);

  function filtrar(tabla, lista) {
    if (tabla === 'hoy') { const d = hoy(); return lista.filter((r) => r.fecha.slice(0, 10) === d); }
    if (tabla === 'semana') { const desde = now() - 7 * DIA_MS; return lista.filter((r) => r.t >= desde); }
    return lista;
  }

  const publico = (r) => ({
    id: r.id, nombre: r.nombre, puntaje: r.puntaje, plenos: r.plenos, semiplenos: r.semiplenos,
    fecha: r.fecha, jugadores: r.jugadores,
  });

  /** Top de una tabla ('hoy', 'semana' o 'siempre'); la misma persona puede repetirse */
  function top(tabla, n) {
    if (!TABLAS.includes(tabla)) throw new Error('Tabla desconocida: ' + tabla);
    return filtrar(tabla, vigentes()).sort(comparar).slice(0, n || 10)
      .map((r, i) => Object.assign(publico(r), { puesto: i + 1 }));
  }

  /** Mejor puntaje de cada persona (agrupando por nombreClave), con partidas y promedio */
  function jugadores(n) {
    const grupos = new Map();
    vigentes().forEach((r) => {
      const g = grupos.get(r.nombreClave) || { lista: [] };
      g.lista.push(r);
      grupos.set(r.nombreClave, g);
    });
    return [...grupos.values()].map((g) => {
      const mejor = g.lista.slice().sort(comparar)[0];
      const suma = g.lista.reduce((s, r) => s + r.puntaje, 0);
      return Object.assign(publico(mejor), {
        nombreClave: mejor.nombreClave, t: mejor.t,
        partidas: g.lista.length, promedio: Math.round((suma / g.lista.length) * 10) / 10,
      });
    }).sort(comparar).slice(0, n || 10).map((j, i) => {
      delete j.t;
      return Object.assign(j, { puesto: i + 1 });
    });
  }

  /** Partidas de una persona, de la más nueva a la más vieja */
  function historial(nombre) {
    const clave = nombreClave(nombre);
    const lista = vigentes().filter((r) => r.nombreClave === clave);
    if (!lista.length) return null;
    const mejor = lista.slice().sort(comparar)[0];
    const suma = lista.reduce((s, r) => s + r.puntaje, 0);
    return {
      nombre: mejor.nombre,
      partidas: lista.length,
      mejor: mejor.puntaje,
      promedio: Math.round((suma / lista.length) * 10) / 10,
      lista: lista.slice().sort((a, b) => b.t - a.t).map(publico),
    };
  }

  /** Puesto de un puntaje ya guardado, comparado con lo que había antes de su partida */
  function puesto(r) {
    const todos = vigentes();
    const lugar = (lista) => lista.sort(comparar).indexOf(r) + 1;
    const anteriores = todos.filter((x) => x.partidaId !== r.partidaId);
    const propios = anteriores.filter((x) => x.nombreClave === r.nombreClave);
    const maxAnterior = anteriores.reduce((m, x) => Math.max(m, x.puntaje), -1);
    const puestoSiempre = lugar(todos.slice());
    return {
      puntaje: r.puntaje,
      puestoHoy: lugar(filtrar('hoy', todos)),
      puestoSiempre,
      esRecordPersonal: propios.length > 0 && r.puntaje > Math.max(...propios.map((x) => x.puntaje)),
      esRecordHistorico: r.puntaje > 0 && puestoSiempre === 1 && r.puntaje > maxAnterior,
    };
  }

  /** Copia del archivo una vez por día, antes del primer puntaje de ese día */
  function copiaDiaria(dia) {
    if (!fs.existsSync(archivo)) return;
    const destino = path.join(dir, 'backups', `puntajes-${dia}.jsonl`);
    if (fs.existsSync(destino)) return;
    try {
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.copyFileSync(archivo, destino);
    } catch (err) {
      // una copia fallida no puede impedir que se guarde el puntaje
      console.error('No se pudo hacer la copia diaria de los puntajes:', err.message);
    }
  }

  /**
   * Guarda los puntajes de una partida terminada.
   * jugadores: [{ nombre, puntaje, plenos, semiplenos }] → devuelve cada registro con su puesto.
   */
  function guardarPartida(lista, idPartida) {
    const t = now();
    const fecha = fechaLocal(t);
    copiaDiaria(fecha.slice(0, 10));
    // el id lo pone el tótem (así un reenvío no se guarda dos veces); si no viene, se inventa uno
    const partidaId = typeof idPartida === 'string' && /^[\w-]{1,64}$/.test(idPartida)
      ? idPartida : 'p-' + t.toString(36) + '-' + crypto.randomBytes(2).toString('hex');
    const nuevos = lista.map((j) => ({
      id: crypto.randomBytes(4).toString('hex'),
      nombre: String(j.nombre),
      nombreClave: nombreClave(j.nombre),
      puntaje: entero(j.puntaje, 0, 30 * frames),
      frames,
      plenos: entero(j.plenos, 0, frames + 2),
      semiplenos: entero(j.semiplenos, 0, frames + 1),
      fecha,
      partidaId,
      jugadores: lista.length,
    }));
    if (!nuevos.length) return [];
    agregar(nuevos);
    nuevos.forEach((r) => registros.push(Object.assign({}, r, { t })));
    const guardados = registros.slice(-nuevos.length);
    return guardados.map((r) => Object.assign({ registro: publico(r) }, puesto(r)));
  }

  /** ¿Ya se guardó esta partida? (incluye puntajes borrados: no se vuelven a cargar) */
  function tienePartida(partidaId) {
    return typeof partidaId === 'string' && registros.some((r) => r.partidaId === partidaId);
  }

  /** Borrar = agregar {"borrar": id}; el renglón original no se toca */
  function borrar(id) {
    const r = registros.find((x) => x.id === id);
    if (!r || borrados.has(id)) return false;
    agregar([{ borrar: id, fecha: fechaLocal(now()) }]);
    borrados.add(id);
    return true;
  }

  /** Todos los puntajes vigentes (de cualquier cantidad de frames), el más nuevo primero */
  function listar() {
    return registros.filter((r) => !borrados.has(r.id))
      .sort((a, b) => b.t - a.t)
      .map((r) => Object.assign(publico(r), { frames: r.frames, partidaId: r.partidaId }));
  }

  /** CSV para Excel: separador ";" y BOM para que se vean bien las tildes */
  function csv() {
    const celda = (v) => {
      const s = String(v == null ? '' : v);
      return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const filas = [['Fecha', 'Hora', 'Nombre', 'Puntaje', 'Frames', 'Plenos', 'Semiplenos', 'Jugadores', 'Partida', 'Id']];
    listar().forEach((r) => filas.push([
      r.fecha.slice(0, 10), r.fecha.slice(11, 19), r.nombre, r.puntaje, r.frames,
      r.plenos, r.semiplenos, r.jugadores, r.partidaId, r.id,
    ]));
    return '﻿' + filas.map((f) => f.map(celda).join(';')).join('\r\n') + '\r\n';
  }

  /** Archiva el archivo actual con la fecha y empieza de cero */
  function reiniciar() {
    let archivado = null;
    if (fs.existsSync(archivo)) {
      const nombre = `puntajes-${fechaLocal(now()).slice(0, 19).replace(/:/g, '-')}.jsonl`;
      const destino = path.join(dir, 'archivo', nombre);
      fs.mkdirSync(path.dirname(destino), { recursive: true });
      fs.renameSync(archivo, destino);
      archivado = path.relative(dir, destino);
    }
    registros = [];
    borrados = new Set();
    return archivado;
  }

  /**
   * Filtro de malas palabras. La lista se vuelve a leer solo si cambió el archivo (se puede
   * editar en caliente). Cada palabra bloquea el nombre si aparece como palabra suelta, si se
   * escribe todo junto ("p u t o") o, en las de 5 letras o más, con terminaciones de plural,
   * diminutivo o aumentativo ("boludos", "boludito", "boludazo"); así "Vergara" no se bloquea.
   */
  const SUFIJOS = new Set(['o', 'a', 'e', 's', 'os', 'as', 'es', 'ito', 'ita', 'itos', 'itas',
    'azo', 'aza', 'azos', 'azas', 'on', 'ona', 'ones', 'onas']);
  let filtro = { mtime: -1, palabras: [] };
  function palabrasProhibidas() {
    let mtime = 0;
    try { mtime = fs.statSync(archivoPalabras).mtimeMs; } catch { /* sin archivo: lista base */ }
    if (mtime !== filtro.mtime) {
      let texto = PALABRAS_BASE;
      try { texto = fs.readFileSync(archivoPalabras, 'utf8'); } catch { /* sin archivo: lista base */ }
      const palabras = [];
      texto.split('\n').forEach((l) => {
        const cruda = nombreClave(l.replace(/#.*/, ''));
        const norm = normalizarFiltro(cruda);
        if (norm) palabras.push({ norm, raiz: cruda.length >= 5 ? norm.replace(/[aeo]$/, '') : null });
      });
      filtro = { mtime, palabras };
    }
    return filtro.palabras;
  }

  function nombrePermitido(nombre) {
    const prohibidas = palabrasProhibidas();
    const norm = normalizarFiltro(nombre);
    const palabras = norm.split(' ').filter(Boolean);
    const junto = palabras.join('');
    return !prohibidas.some((p) => junto === p.norm || palabras.some((w) => w === p.norm ||
      (w === p.norm + 's') ||
      (p.raiz && w.startsWith(p.raiz) && SUFIJOS.has(w.slice(p.raiz.length)))));
  }

  /** Lo que reciben el tótem y los celus en leaderboard:update */
  function tablas() {
    return { frames, hoy: top('hoy'), semana: top('semana'), siempre: top('siempre') };
  }

  return {
    archivo, guardarPartida, tienePartida, top, jugadores, historial, borrar, listar, csv, reiniciar,
    nombrePermitido, tablas, recargar: cargar,
  };
}

module.exports = { createLeaderboard, nombreClave, normalizarFiltro, fechaLocal, TABLAS };
