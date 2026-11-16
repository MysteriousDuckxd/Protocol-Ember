// =====================================================================
//  PROTOCOL: EMBER — dedicated game server
//  Zero dependencies: plain Node.js (v18+). Serves the game page and
//  runs online rooms over WebSockets.
//    node server.js            → http://localhost:8080
// =====================================================================
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const MAX_ROOMS = 30;
const TICK_MS = 100;          // game logic tick
const SNAP_MS = 50;           // position snapshots (20/s)

// ---------------------------------------------------------------------
//  Map data (same layouts as the client)
// ---------------------------------------------------------------------
const MAPS = {"dustline": {"name": "Dustline", "rows": ["########################################", "#BBBBBBBBB#####dddddddddd#####AAAAAAAAA#", "#BBBcBBBBB#####dddddddddd..^..AAAAAAcAA#", "#BCBBBBBBB.^...dddddddddd..^..AAACAAAAA#", "#BBBBBoBBB.^...dddddddddd#####AAAAAAAoA#", "#BBBBBBBBB####.........o..####AcAAAAAAA#", "#BBBBCBBBB####...c........####AAoAAACAA#", "#BBcBBBBBB...#............####AAAAAAAAA#", "##########uuu#####....########..##....##", "##########uuu#####.o............##....##", "##########uuu#####.......c......##..C.##", "##########uuu#####....############....##", "##########uuu######^^#############....##", "##########uuu#####....^....#######.o..##", "##########uuu#####......c...^.........##", "##########uuu#####.c.......#######....##", "##########uuu#####....#############^^###", "###...........####....############....##", "###..c........####....#######.........##", "###......C....####....#######...c.....##", "###...........####....#######.........##", "###.....c......C......................##", "###.....................o.....c.......##", "#############..............#############", "#############aaaaaaaaaaaaaa#############", "#############aaaaaaaaaaaCaa#############", "#############aacaaaaaaaaaaa#############", "#############aaaaaaaaaaaaaa#############", "#############aaaaaaaaaaaaaa#############", "########################################"]}, "foundry": {"name": "Warehouse", "rows": ["###################################", "###########ddddddddddddd###########", "###########ddddddddddddd###########", "###.............................###", "###..c......###.....###......c..###", "###.........###..C..###.........###", "###.....#####...........#####...###", "#..AAAAA#####.....c.....#####BBBBB#", "#..AAcAA.......................BcB#", "#..AAAAA......C.......C......BBBBB#", "#..AACAA#####.....o.....#####BBCBB#", "#..AAAAA#####...........#####BBBBB#", "###.........###.......###.......###", "###..c......###...C...###.....o.###", "###.............................###", "###########aaaaaaaaaaaaa###########", "###########aaaaaaaaaaaaa###########", "###################################"]}, "harbor": {"name": "Harbor", "rows": ["#####################################", "#dddd.......#############.......cc###", "#dddd.......#############........####", "#dddd..c....#############..C.....####", "#dddd............................####", "#dddd.......####.....####........####", "###.....C...####..o..####...######.##", "###.........####.....####...######.##", "#######.#######.......######.......##", "#AAAAAA.........C.................BB#", "#AAcAAA.............c.........BBBBBB#", "#AAAAAA...######.....######...BBBoBB#", "#AAACAA...######.....######...BBBBBB#", "#######...######.....######.......###", "###.......................C.......###", "###..c.......#####aaaa#####...o...###", "###..........#####aaaa#####.......###", "##################aaaa###############", "#####################################"]}};
const S = 3;
function prepMap(key) {
  const src = MAPS[key].rows, H = src.length, W = Math.max(...src.map(r => r.length));
  const grid = src.map((r, y) => r.padEnd(W, '#').split('').map((ch, x) => (y === 0 || x === 0 || y === H - 1 || x === W - 1) ? '#' : ch));
  const spawns = { T: [], CT: [] };
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { const ch = grid[r][c]; if (ch === 'a') spawns.T.push([c, r]); if (ch === 'd') spawns.CT.push([c, r]); }
  const cen = l => { let x = 0, z = 0; l.forEach(([c, r]) => { x += c * S + S / 2; z += r * S + S / 2; }); return [x / l.length, z / l.length]; };
  return { key, W, H, grid, spawns, spawnC: { T: cen(spawns.T), CT: cen(spawns.CT) } };
}
const MAPDATA = {}; for (const k in MAPS) MAPDATA[k] = prepMap(k);
function cellChar(m, x, z) { const c = Math.floor(x / S), r = Math.floor(z / S); if (c < 0 || r < 0 || c >= m.W || r >= m.H) return '#'; return m.grid[r][c]; }

// ---------------------------------------------------------------------
//  Rules data (kept in sync with the client)
// ---------------------------------------------------------------------
const W = {
  knife: { dmg: 180, cost: 0, slot: 3, pen: .85, rate: 2.2 },
  glock: { dmg: 30, head: 4, pen: .47, rate: 6.5, cost: 0, slot: 2 },
  mpistol: { dmg: 22, head: 4, pen: .5, rate: 15, cost: 500, slot: 2 },
  deagle: { dmg: 63, head: 3.9, pen: .93, rate: 3.2, cost: 700, slot: 2 },
  mp5: { dmg: 27, head: 4, pen: .62, rate: 13.3, cost: 1500, slot: 1 },
  shotgun: { dmg: 20, head: 2.5, pen: .5, rate: 1.15, cost: 1200, slot: 1, pellets: 9 },
  ak: { dmg: 36, head: 4, pen: .78, rate: 10, cost: 2700, slot: 1 },
  sniper: { dmg: 115, head: 4, pen: .98, rate: .68, cost: 4750, slot: 1 },
  he: { dmg: 100, pen: .57 },
  rpg: { dmg: 230, pen: .9, rate: .9, cost: 3500, slot: 1, chaos: 1, multi: 5 },
  minigun: { dmg: 15, head: 2.5, pen: .6, rate: 24, cost: 3000, slot: 1, chaos: 1 },
  railgun: { dmg: 95, head: 1.6, pen: 1, rate: .85, cost: 3200, slot: 1, chaos: 1, multi: 4 },
  plasma: { dmg: 44, pen: .8, rate: 7, cost: 2500, slot: 1, chaos: 1, multi: 3 },
  katana: { dmg: 180, pen: .9, rate: 2, cost: 1500, slot: 2 },
};
const ITEMS = { wall: { cost: 800, max: 1 }, medkit: { cost: 600, max: 2 }, stim: { cost: 400, max: 1, any: 1 }, dash: { cost: 500, max: 2, any: 1 }, boots: { cost: 350, max: 1, any: 1 } };
const resp = r => r.mode !== 'bomb';
const OWNER_NAME = 'Ducky'; // only this username can use AUTO-NUKE online
const NUKE_KS = process.env.NUKE_KS !== undefined ? +process.env.NUKE_KS : 7;
const respMoney = r => r.mode === 'chaos' ? 10000 : 16000;
const KILL_REWARD = { knife: 1500, shotgun: 900, mp5: 600, mpistol: 600 };
const BUY_TIME = 15, ROUND_TIME = 115, BOMB_TIME = 40, END_TIME = 5, DEFUSE_TIME = 7;
const BOT_NAMES = ['Ash', 'Grim', 'Shade', 'Brand', 'Cinder', 'Wraith', 'Soot', 'Hawk', 'Reyes', 'Kovac', 'Nash', 'Ortiz', 'Volk', 'Rook', 'Juno', 'Atlas'];
const PATS = ['solid', 'woodland', 'digital', 'desert', 'urban', 'arctic', 'tiger', 'carbon'];

const clean = (s, n) => String(s || '').replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
function cleanOutfit(o) {
  const out = {}; if (!o || typeof o !== 'object') return null;
  for (const side of ['ct', 't']) {
    const src = o[side] || {}, d = {};
    for (const k of ['top', 'pants', 'vest', 'head', 'gloves', 'boots']) d[k] = /^#[0-9a-f]{6}$/i.test(src[k]) ? src[k] : null;
    for (const k of ['topPat', 'pantsPat']) d[k] = PATS.includes(src[k]) ? src[k] : 'solid';
    if (Object.values(d).some(v => v === null)) return null;
    out[side] = d;
  }
  return out;
}
const r1 = v => Math.round(v * 100) / 100;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];

// ---------------------------------------------------------------------
//  Minimal WebSocket implementation (RFC 6455)
// ---------------------------------------------------------------------
class Conn {
  constructor(sock) {
    this.sock = sock; this.buf = Buffer.alloc(0); this.frag = null; this.closed = false;
    this.msgCount = 0; this.msgWindow = Date.now();
    sock.on('data', d => this.onData(d));
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
  }
  onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1], fin = b0 & 0x80, op = b0 & 0x0f, masked = b1 & 0x80;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 64 * 1024) { this.close(); return; }
      const mOff = off; if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let payload = Buffer.from(this.buf.subarray(off, off + len));
      if (masked) { const m = this.buf.subarray(mOff, mOff + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      this.buf = this.buf.subarray(off + len);
      if (op === 0x8) { this.close(); return; }
      if (op === 0x9) { this.frame(0xA, payload); continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2) { if (fin) this.deliver(payload); else this.frag = [payload]; }
      else if (op === 0x0 && this.frag) { this.frag.push(payload); if (fin) { const p = Buffer.concat(this.frag); this.frag = null; this.deliver(p); } }
    }
  }
  deliver(p) {
    const now = Date.now(); if (now - this.msgWindow > 1000) { this.msgWindow = now; this.msgCount = 0; }
    if (++this.msgCount > 120) return;           // flood protection
    if (this.onmessage) { try { this.onmessage(p.toString('utf8')); } catch (e) { console.error('msg error', e); } }
  }
  frame(op, data) {
    if (this.closed || this.sock.destroyed) return;
    if (this.sock.writableLength > 1 << 20) return;  // slow client: drop
    const len = data.length; let h;
    if (len < 126) h = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    this.sock.write(Buffer.concat([h, data]));
  }
  send(obj) { this.frame(0x1, Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj))); }
  close() { if (this.closed) return; try { this.frame(0x8, Buffer.alloc(0)); } catch (e) { } this.sock.end(); this._closed(); }
  _closed() { if (this.closed) return; this.closed = true; if (this.onclose) this.onclose(); }
}

// ---------------------------------------------------------------------
//  Rooms
// ---------------------------------------------------------------------
const rooms = new Map();
let nextId = 1;
const newId = p => p + (nextId++).toString(36);

function makeRoom(o, persistent) {
  const map = MAPS[o.map] ? o.map : 'dustline';
  const mode = ['tdm', 'chaos'].includes(o.mode) ? o.mode : 'bomb';
  const r = {
    id: newId('r'), name: clean(o.name, 32) || 'Server', map, mode,
    theme: ['day', 'dusk', 'overcast', 'night'].includes(o.theme) ? o.theme : 'day',
    max: Math.max(2, Math.min(12, o.max | 0 || 10)), bots: o.bots !== false,
    toWin: Math.max(2, Math.min(16, o.toWin | 0 || 8)), killLimit: Math.max(10, Math.min(150, o.killLimit | 0 || 40)),
    persistent: !!persistent, players: new Map(), phase: 'lobby', owner: null, cdAt: 0, forced: false, autoAt: 0, timer: 0, round: 0, score: { T: 0, CT: 0 },
    streak: { T: 0, CT: 0 }, bomb: { st: 'none', c: null, p: [0, 0, 0], tm: 0, df: null, dfs: 0 }, host: null, emptySince: Date.now(),
    m: MAPDATA[map], overT: 0,
  };
  rooms.set(r.id, r); return r;
}
const humans = r => [...r.players.values()].filter(p => !p.bot);
const teamOf = (r, t) => [...r.players.values()].filter(p => p.team === t);
const freshInv = () => ({ 1: null, 2: 'glock' });

function roomInfo(r) {
  return { id: r.id, name: r.name, map: r.map, mapName: MAPS[r.map].name, mode: r.mode, theme: r.theme, n: humans(r).length, b: r.players.size - humans(r).length, max: r.max, ph: r.phase, sc: r.score, rd: r.round, persistent: r.persistent };
}
function bcast(r, msg, except) { const s = JSON.stringify(msg); for (const p of r.players.values()) if (p.conn && p !== except) p.conn.send(s); }
function pubP(p) { return { i: p.id, n: p.name, tm: p.team, bot: p.bot, al: p.alive, hp: p.hp, x: r1(p.pos[0]), z: r1(p.pos[2]), yaw: r1(p.yaw), w: p.inv[1] || p.inv[2], out: p.outfit, k: p.kills, d: p.deaths }; }
function meData(p) { return { money: p.money, inv: p.inv, nades: p.nades, ar: p.armor, hl: p.helmet, items: p.items, os: Math.round(p.oshield) }; }

function newPlayer(o) {
  return { id: o.id, name: o.name, conn: o.conn || null, bot: !!o.bot, team: o.team, outfit: o.outfit || null, hp: 100, armor: 0, helmet: false, alive: false,
    money: 800, inv: freshInv(), nades: { he: 0, flash: 0 }, items: { wall: 0, medkit: 0, stim: 0, dash: 0, boots: 0 }, oshield: 0, protectUntil: 0, pos: [0, 0, 0], yaw: 0, pitch: 0, crouch: 0, w: 'glock', kills: 0, deaths: 0,
    dmgWin: 0, dmgT: 0, respawnAt: 0, lastSeen: Date.now(), streak: 0, ready: false };
}

function spawnPoint(r, team, used) {
  const list = r.m.spawns[team]; let cell;
  for (let i = 0; i < 40; i++) { cell = pick(list); if (!used || !used.has(cell + '')) break; }
  if (used) used.add(cell + '');
  const x = cell[0] * S + S / 2 + rand(-.6, .6), z = cell[1] * S + S / 2 + rand(-.6, .6);
  const o = r.m.spawnC[team === 'T' ? 'CT' : 'T'];
  return { x, z, yaw: Math.atan2(-(o[0] - x), -(o[1] - z)) };
}

// keep teams filled with bots
function balanceBots(r) {
  const hs = humans(r);
  if (!hs.length) { for (const p of [...r.players.values()]) if (p.bot) removePlayer(r, p, true); return; }
  const target = r.bots ? r.max : 0;
  const per = { T: Math.ceil(target / 2), CT: Math.floor(target / 2) };
  for (const t of ['T', 'CT']) {
    let team = teamOf(r, t), h = team.filter(p => !p.bot).length;
    let want = Math.max(0, per[t] - h);
    let bots = team.filter(p => p.bot);
    while (bots.length > want) { removePlayer(r, bots.pop(), true); }
    while (bots.length < want && r.players.size < Math.max(r.max, hs.length)) {
      const used = new Set([...r.players.values()].map(p => p.name));
      const name = 'BOT ' + (BOT_NAMES.find(n => !used.has('BOT ' + n)) || ('Unit' + nextId));
      const b = newPlayer({ id: newId('b'), name, bot: true, team: t });
      r.players.set(b.id, b); bots.push(b);
      if (resp(r) && r.phase === 'live') { b.respawnAt = Date.now() + 1000; }
      bcast(r, { t: 'pj', p: pubP(b) });
    }
  }
}
function pickHost(r) {
  const hs = humans(r); const old = r.host;
  if (!hs.length) r.host = null; else if (!r.host || !r.players.has(r.host) || r.players.get(r.host).bot) r.host = hs[0].id;
  if (r.host !== old) bcast(r, { t: 'h', i: r.host });
}
function removePlayer(r, p, quiet) {
  r.players.delete(p.id);
  if (r.bomb.c === p.id && r.bomb.st === 'carried') { r.bomb.st = 'dropped'; r.bomb.c = null; r.bomb.p = [p.pos[0], 0, p.pos[2]]; bcast(r, { t: 'b', ...r.bomb }); }
  if (r.bomb.df === p.id) r.bomb.df = null;
  bcast(r, { t: 'pl', i: p.id });
  if (!quiet) { balanceBots(r); pickHost(r); pickOwner(r); checkRoundEnd(r); if (!humans(r).length) { r.emptySince = Date.now(); if (r.phase !== 'lobby') { r.phase = 'lobby'; r.cdAt = 0; r.autoAt = 0; resetMatch(r); } } else if (r.phase !== 'lobby' && r.phase !== 'over' && !canStart(r)) toLobby(r); else sendLobby(r); }
}

// ----- lobby -----
function lobbyState(r) {
  const now = Date.now();
  return { owner: r.owner, cd: r.cdAt ? Math.max(0, r.cdAt - now) : 0, auto: (!r.cdAt && r.autoAt) ? Math.max(0, r.autoAt - now) : 0, canStart: canStart(r),
    players: [...r.players.values()].map(p => ({ i: p.id, n: p.name, tm: p.team, bot: p.bot, ready: !!p.ready })) };
}
function sendLobby(r) { if (r.phase === 'lobby') bcast(r, { t: 'lb', ...lobbyState(r) }); }
function pickOwner(r) { if (!r.owner || !r.players.has(r.owner) || r.players.get(r.owner).bot) { const h = humans(r)[0]; r.owner = h ? h.id : null; } }
function toLobby(r) {
  r.phase = 'lobby'; r.timer = 0; r.cdAt = 0; r.forced = false; r.autoAt = r.persistent && humans(r).length ? Date.now() + 45000 : 0;
  r.bomb = { st: 'none', c: null, p: [0, 0, 0], tm: 0, df: null, dfs: 0 };
  for (const p of r.players.values()) { p.alive = false; p.ready = false; p.respawnAt = 0; }
  bcast(r, { t: 'ph', ph: 'lobby', tm: 0 }); sendLobby(r);
}
// ----- match flow -----
function setPhase(r, ph, tm) { r.phase = ph; r.timer = tm; bcast(r, { t: 'ph', ph, tm }); }
function canStart(r) { return teamOf(r, 'T').length > 0 && teamOf(r, 'CT').length > 0; }
function resetMatch(r) {
  r.nuke = null; r.round = 0; r.score = { T: 0, CT: 0 }; r.streak = { T: 0, CT: 0 };
  for (const p of r.players.values()) { p.money = resp(r) ? respMoney(r) : 800; p.inv = freshInv(); p.armor = 0; p.helmet = false; p.nades = { he: 0, flash: 0 }; p.kills = 0; p.deaths = 0; p.alive = false; p.items = { wall: 0, medkit: 0, stim: 0, dash: 0, boots: 0 }; }
}
function startRound(r) {
  r.round++;
  const used = { T: new Set(), CT: new Set() };
  const ts = teamOf(r, 'T');
  for (const p of r.players.values()) {
    p.jailed = false;
    if (!p.alive) { p.inv = freshInv(); p.armor = 0; p.helmet = false; p.nades = { he: 0, flash: 0 }; p.items = { wall: 0, medkit: 0, stim: 0, dash: 0, boots: 0 }; }
    p.alive = true; p.hp = 100; p.protectUntil = Date.now() + (r.mode === 'chaos' ? 2000 : 0); p.oshield = 0; const sp = spawnPoint(r, p.team, used[p.team]); p.pos = [sp.x, 0, sp.z]; p.yaw = sp.yaw;
  }
  if (r.mode === 'bomb' && ts.length) { const c = pick(ts.filter(p => !p.bot).length && Math.random() < .5 ? ts.filter(p => !p.bot) : ts); r.bomb = { st: 'carried', c: c.id, p: [0, 0, 0], tm: BOMB_TIME, df: null, dfs: 0 }; }
  else r.bomb = { st: 'none', c: null, p: [0, 0, 0], tm: 0, df: null, dfs: 0 };
  r.phase = resp(r) ? 'live' : 'buy'; r.timer = resp(r) ? 600 : BUY_TIME;
  const ps = [...r.players.values()].map(pubP);
  for (const p of r.players.values()) if (p.conn) p.conn.send({ t: 'r', n: r.round, ph: r.phase, tm: r.timer, sc: r.score, ps, me: meData(p), bomb: r.bomb, mode: r.mode });
  if (resp(r)) for (const p of r.players.values()) { p.buyUntil = Date.now() + 12000; if (r.mode === 'chaos') p.money = respMoney(r); }
}
function endRound(r, winner, reason) {
  if (r.phase === 'end' || r.phase === 'over') return;
  r.score[winner]++;
  for (const p of r.players.values()) {
    if (p.team === winner) { p.money += 3250; }
    else { p.money += 1400 + Math.min(4, r.streak[p.team]) * 500; }
    p.money = Math.min(16000, p.money);
  }
  r.streak[winner] = 0; r.streak[winner === 'T' ? 'CT' : 'T']++;
  r.bomb.df = null;
  bcast(r, { t: 'e', w: winner, r: reason, sc: r.score });
  if (r.score[winner] >= r.toWin) { r.phase = 'over'; r.timer = 10; bcast(r, { t: 'o', w: winner, sc: r.score, tm: 10 }); }
  else setPhase(r, 'end', END_TIME);
}
function checkRoundEnd(r) {
  if (r.mode !== 'bomb' || !['live', 'planted'].includes(r.phase)) return;
  const tA = teamOf(r, 'T').some(p => p.alive), ctA = teamOf(r, 'CT').some(p => p.alive);
  if (r.phase === 'live') { if (!tA) endRound(r, 'CT', 'Terrorists eliminated'); else if (!ctA) endRound(r, 'T', 'Soldiers eliminated'); }
  else if (!ctA) endRound(r, 'T', 'Soldiers eliminated');
}
function killPlayer(r, v, att, w, head) {
  if (v.jailed) { v.jailed = false; if (att && att !== v && att.team === v.team) { att.kills++; att.money = Math.min(16000, att.money + 300); } }
  if (!v.alive) return;
  v.alive = false; v.hp = 0; v.deaths++; v.diedAt = Date.now();
  if (att && att !== v && att.team !== v.team && w !== 'nuke') att.ks = (att.ks || 0) + 1; v.ks = 0;
  if (att && att !== v && att.team !== v.team) { att.kills++; att.money = Math.min(16000, att.money + (KILL_REWARD[w] || 300)); }
  bcast(r, { t: 'k', k: att ? att.id : null, v: v.id, w, h: !!head });
  if (r.bomb.c === v.id && r.bomb.st === 'carried') { r.bomb.st = 'dropped'; r.bomb.c = null; r.bomb.p = [r1(v.pos[0]), 0, r1(v.pos[2])]; bcast(r, { t: 'b', ...r.bomb }); }
  if (r.bomb.df === v.id) { r.bomb.df = null; bcast(r, { t: 'b', ...r.bomb }); }
  if (resp(r)) {
    if (att && att !== v && att.team !== v.team) { r.score[att.team]++; bcast(r, { t: 'sc', sc: r.score }); if (r.score[att.team] >= r.killLimit) { r.phase = 'over'; r.timer = 10; bcast(r, { t: 'o', w: att.team, sc: r.score, tm: 10 }); } }
    v.respawnAt = Date.now() + (v.bot ? 3000 : 5600);
  }
  checkRoundEnd(r);
}
function respawn(r, p) {
  const sp = spawnPoint(r, p.team); p.alive = true; p.hp = 100; p.protectUntil = Date.now() + 2000; p.pos = [sp.x, 0, sp.z]; p.yaw = sp.yaw; p.respawnAt = 0;
  if (resp(r)) { p.money = respMoney(r); p.buyUntil = Date.now() + 12000; p.items = { wall: 0, medkit: 0, stim: 0, dash: 0, boots: 0 }; p.oshield = 0; }
  const msg = { t: 'rs', i: p.id, x: r1(sp.x), z: r1(sp.z), yaw: r1(sp.yaw), w: p.inv[1] || p.inv[2] };
  for (const q of r.players.values()) if (q.conn) q.conn.send(q === p ? { ...msg, me: meData(p) } : msg);
}

function tick(r) {
  const now = Date.now(), dt = TICK_MS / 1000;
  if (!humans(r).length) return;
  r.timer = Math.max(0, r.timer - dt);
  if (r.nuke && now >= r.nuke.at) { const nk = r.nuke; r.nuke = null; const by = r.players.get(nk.by) || null; const okPh = () => r.phase === 'live' || r.phase === 'planted'; if (okPh()) for (const q of [...r.players.values()]) { if (!okPh()) break; if (q.alive && q.team !== nk.team) killPlayer(r, q, by, 'nuke', false); } }
  for (const p of r.players.values()) if (p.oshield > 0) p.oshield = Math.max(0, p.oshield - 5 * dt);
  // respawns (TDM / warmup)
  if (resp(r) && r.phase === 'live') for (const p of r.players.values()) if (!p.alive && p.respawnAt && now >= p.respawnAt) respawn(r, p);
  switch (r.phase) {
    case 'lobby': {
      const hs = humans(r), allReady = hs.length > 0 && hs.every(p => p.ready), auto = r.autoAt && now >= r.autoAt;
      if (!r.cdAt) { if ((allReady || auto) && canStart(r)) { r.cdAt = now + 5000; sendLobby(r); } }
      else if (!canStart(r) || (!r.forced && !allReady && !auto)) { r.cdAt = 0; sendLobby(r); }
      else if (now >= r.cdAt) { r.cdAt = 0; r.forced = false; r.autoAt = 0; for (const p of r.players.values()) p.ready = false; resetMatch(r); startRound(r); }
      break;
    }
    case 'buy': if (r.timer <= 0) setPhase(r, 'live', ROUND_TIME); break;
    case 'live':
      if (resp(r)) { if (r.timer <= 0) { const w = r.score.T >= r.score.CT ? 'T' : 'CT'; r.phase = 'over'; r.timer = 10; bcast(r, { t: 'o', w, sc: r.score, tm: 10 }); } }
      else if (r.timer <= 0) endRound(r, 'CT', 'Time ran out — no plant');
      break;
    case 'planted':
      r.bomb.tm = Math.max(0, r.bomb.tm - dt);
      if (r.bomb.tm <= 0) {
        r.bomb.st = 'exploded'; bcast(r, { t: 'b', ...r.bomb });
        for (const p of r.players.values()) if (p.alive && Math.hypot(p.pos[0] - r.bomb.p[0], p.pos[2] - r.bomb.p[2]) < 16) killPlayer(r, p, null, 'bomb', false);
        endRound(r, 'T', 'Target destroyed');
      }
      break;
    case 'end': if (r.timer <= 0) { if (!canStart(r)) { toLobby(r); break; } startRound(r); } break;
    case 'over': if (r.timer <= 0) { resetMatch(r); toLobby(r); } break;
  }
}
function snapshot(r) {
  if (!humans(r).length) return;
  const l = []; for (const p of r.players.values()) l.push([p.id, r1(p.pos[0]), r1(p.pos[1]), r1(p.pos[2]), r1(p.yaw), r1(p.pitch), p.crouch, p.w]);
  bcast(r, { t: 'S', l });
}

// ----- messages from a client -----
function actor(r, p, as) { // who is this action for? (host may act for bots)
  if (!as || as === p.id) return p;
  const a = r.players.get(as); if (a && a.bot && r.host === p.id) return a; return null;
}
function handle(c, msg) {
  let m; try { m = JSON.parse(msg); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  const p = c.player, r = c.room;
  switch (m.t) {
    case 'hello': c.name = clean(m.name, 16) || 'Player'; c.outfit = cleanOutfit(m.outfit); c.send({ t: 'welcome', rooms: [...rooms.values()].map(roomInfo) }); return;
    case 'list': c.send({ t: 'L', rooms: [...rooms.values()].map(roomInfo) }); return;
    case 'pi': c.send({ t: 'po', c: m.c }); return;
    case 'create': {
      if (rooms.size >= MAX_ROOMS) { c.send({ t: 'err', msg: 'Server is full of rooms — join an existing one.' }); return; }
      const nr = makeRoom(m); joinRoom(c, nr); if (c.player) { nr.owner = c.player.id; sendLobby(nr); } return;
    }
    case 'join': { const nr = rooms.get(m.room); if (!nr) { c.send({ t: 'err', msg: 'That server no longer exists.' }); return; } joinRoom(c, nr); return; }
    case 'leave': leaveRoom(c); return;
  }
  if (!p || !r) return;
  p.lastSeen = Date.now();
  switch (m.t) {
    case 's': if (Array.isArray(m.p) && m.p.length === 3 && m.p.every(Number.isFinite)) { p.pos = m.p; p.yaw = +m.y || 0; p.pitch = +m.pi || 0; p.crouch = m.c ? 1 : 0; if (W[m.w]) p.w = m.w; } break;
    case 'bs': if (r.host === p.id && Array.isArray(m.b)) for (const e of m.b) { const b = r.players.get(e[0]); if (b && b.bot && [e[1], e[2], e[3]].every(Number.isFinite)) { b.pos = [e[1], e[2], e[3]]; b.yaw = +e[4] || 0; b.pitch = +e[6] || 0; if (W[e[5]]) b.w = e[5]; } } break;
    case 'bl': if (r.host === p.id && Array.isArray(m.b)) for (const e of m.b) { const b = r.players.get(e[0]); if (b && b.bot) { b.armor = Math.min(100, +e[1] || 0); b.helmet = !!e[2]; } } break;
    case 'f': { const a = actor(r, p, m.as); if (a && a.alive) bcast(r, { t: 'f', i: a.id, w: m.w, a: m.a, b: m.b }, p); break; }
    case 'hit': {
      const a = actor(r, p, m.as), v = r.players.get(m.v); const w = W[m.w];
      if (!a || !v || !w || !v.alive) break;
      if (!a.alive && !['he', 'rpg', 'plasma'].includes(m.w)) break;
      if (w.chaos && r.mode !== 'chaos') break;
      if (Date.now() < (v.protectUntil || 0)) break;
      if (a.team === v.team && a !== v && !v.jailed) break;
      if (a.jailed && a !== v) break;
      if ((r.phase === 'buy' && !v.jailed) || r.phase === 'end' || r.phase === 'over') break;
      if (m.w !== 'he' && Math.hypot(a.pos[0] - v.pos[0], a.pos[2] - v.pos[2]) > (m.w === 'knife' ? 6 : 170)) break;
      const now = Date.now(); if (now - a.dmgT > 1000) { a.dmgT = now; a.dmgWin = 0; }
      const maxShot = w.dmg * (w.head || 1) * (w.pellets || 1);
      let d = Math.max(0, Math.min(+m.d || 0, maxShot));
      a.dmgWin += d; if (m.w !== 'he' && a.dmgWin > maxShot * (w.rate || 2) * 1.6 * (w.multi || 1) + 200) break;   // too much damage per second
      const head = !!m.h;
      if (v.oshield > 0) { const sh = Math.min(v.oshield, d); v.oshield -= sh; d -= sh; }
      if (v.armor > 0 && (!head || v.helmet)) { const hpD = d * w.pen; v.armor = Math.max(0, v.armor - (d - hpD) * .5); d = hpD; }
      v.hp -= d;
      bcast(r, { t: 'd', v: v.id, hp: Math.max(0, Math.round(v.hp)), ar: Math.round(v.armor), os: Math.round(v.oshield), a: a.id, h: head });
      if (v.hp <= 0) killPlayer(r, v, a, m.w, head);
      break;
    }
    case 'buy': {
      const inBuy = r.mode === 'bomb' ? r.phase === 'buy' : (r.phase === 'live' && Date.now() < (p.buyUntil || 0));
      if (!inBuy || !p.alive) break;
      const it = m.item;
      if (W[it] && it !== 'knife' && it !== 'he') {
        const w = W[it]; if (w.chaos && r.mode !== 'chaos') break; if (p.inv[w.slot] === it) break;
        if (p.money < w.cost) break; p.money -= w.cost; p.inv[w.slot] = it;
      } else if (it === 'vest') { if (p.armor >= 100 || p.money < 650) break; p.money -= 650; p.armor = 100; }
      else if (it === 'helmet') { if (p.armor >= 100 && p.helmet) break; const cst = p.armor >= 100 ? 350 : 1000; if (p.money < cst) break; p.money -= cst; p.armor = 100; p.helmet = true; }
      else if (ITEMS[it]) { if ((r.mode !== 'chaos' && !ITEMS[it].any) || (p.items[it] | 0) >= ITEMS[it].max || p.money < ITEMS[it].cost) break; p.money -= ITEMS[it].cost; p.items[it] = (p.items[it] | 0) + 1; }
      else if (it === 'oshield') { if (r.mode !== 'chaos' || p.oshield >= 50 || p.money < 1200) break; p.money -= 1200; p.oshield = 100; }
      else if (it === 'nhe' || it === 'nflash') { const k = it.slice(1), cst = k === 'he' ? 300 : 200, mx = k === 'he' ? 1 : 2; if (p.nades[k] >= mx || p.money < cst) break; p.money -= cst; p.nades[k]++; }
      else break;
      c.send({ t: 'inv', ...meData(p) });
      bcast(r, { t: 'lo', i: p.id, w: p.inv[1] || p.inv[2] }, p);
      break;
    }
    case 'nade': {
      const a = actor(r, p, m.as); if (!a || !a.alive || !['he', 'flash'].includes(m.k)) break;
      if (!a.bot) { if (a.nades[m.k] <= 0) break; a.nades[m.k]--; }
      bcast(r, { t: 'n', i: a.id, k: m.k, p: m.p, v: m.v }, p); break;
    }
    case 'pickup': {
      const a = actor(r, p, m.as); if (!a || !a.alive || a.team !== 'T' || r.bomb.st !== 'dropped') break;
      if (Math.hypot(a.pos[0] - r.bomb.p[0], a.pos[2] - r.bomb.p[2]) > 2.5) break;
      r.bomb.st = 'carried'; r.bomb.c = a.id; bcast(r, { t: 'b', ...r.bomb }); break;
    }
    case 'plant': {
      const a = actor(r, p, m.as); if (!a || !a.alive || r.phase !== 'live' || r.bomb.st !== 'carried' || r.bomb.c !== a.id) break;
      const ch = cellChar(r.m, a.pos[0], a.pos[2]); if (ch !== 'A' && ch !== 'B') break;
      r.bomb = { st: 'planted', c: null, p: [r1(a.pos[0]), r1(a.pos[1]), r1(a.pos[2])], tm: BOMB_TIME, df: null, dfs: 0, site: ch };
      a.money = Math.min(16000, a.money + 300);
      r.phase = 'planted'; r.timer = BOMB_TIME; bcast(r, { t: 'b', ...r.bomb, by: a.id }); bcast(r, { t: 'ph', ph: 'planted', tm: BOMB_TIME });
      break;
    }
    case 'dfz': {
      const a = actor(r, p, m.as); if (!a || r.phase !== 'planted') break;
      if (m.on) { if (!a.alive || a.team !== 'CT' || Math.hypot(a.pos[0] - r.bomb.p[0], a.pos[2] - r.bomb.p[2]) > 3.2) break; if (r.bomb.df === a.id) { a.conn && a.conn.send({ t: 'b', ...r.bomb, dfe: (Date.now() - r.bomb.dfs) / 1000 }); break; } if (r.bomb.df && r.bomb.df !== a.id) break; r.bomb.df = a.id; r.bomb.dfs = Date.now(); }
      else if (r.bomb.df === a.id) r.bomb.df = null;
      bcast(r, { t: 'b', ...r.bomb, dfe: r.bomb.df ? (Date.now() - r.bomb.dfs) / 1000 : 0 }); break;
    }
    case 'defused': {
      const a = actor(r, p, m.as); if (!a || !a.alive || r.phase !== 'planted' || r.bomb.df !== a.id) break;
      if (Date.now() - r.bomb.dfs < (DEFUSE_TIME - .6) * 1000) break;
      r.bomb.st = 'defused'; bcast(r, { t: 'b', ...r.bomb, by: a.id }); a.money = Math.min(16000, a.money + 300);
      endRound(r, 'CT', 'Bomb defused'); break;
    }
    case 'team': {
      if (m.team !== 'T' && m.team !== 'CT' || p.team === m.team) break;
      if (p.alive && !['lobby', 'buy'].includes(r.phase) && r.mode === 'bomb') killPlayer(r, p, null, 'switch', false);
      p.team = m.team; bcast(r, { t: 'tm', i: p.id, tm: p.team }); balanceBots(r); sendLobby(r);
      if (resp(r) && r.phase === 'live') p.respawnAt = Date.now() + 1500;
      break;
    }
    case 'pr': { const a = actor(r, p, m.as); if (a && a.alive && r.mode === 'chaos') bcast(r, { t: 'pr', i: a.id, k: m.k === 'rocket' ? 'rocket' : 'plasma', w: m.w, p: m.p, v: m.v }, p); break; }
    case 'wall': { const a = actor(r, p, m.as); if (!a || !a.alive || r.mode !== 'chaos') break; if (!a.bot) { if (a.items.wall <= 0) break; a.items.wall--; } bcast(r, { t: 'w', i: a.id, p: m.p, y: +m.y || 0 }, p); break; }
    case 'heal': { const a = actor(r, p, m.as); if (!a || !a.alive || r.mode !== 'chaos') break; if (!a.bot) { if (a.items.medkit <= 0) break; a.items.medkit--; } a.hp = Math.min(100, a.hp + 60); bcast(r, { t: 'd', v: a.id, hp: Math.round(a.hp), ar: Math.round(a.armor), os: Math.round(a.oshield), a: a.id, h: false }); break; }
    case 'item': { const a = actor(r, p, m.as); if (a && !a.bot && (m.k === 'stim' || m.k === 'dash') && a.items[m.k] > 0) a.items[m.k]--; break; }
    case 'ready': if (r.phase === 'lobby') { p.ready = !!m.on; sendLobby(r); } break;
    case 'start': pickOwner(r); if (r.phase === 'lobby' && r.owner === p.id && canStart(r)) { r.forced = true; r.cdAt = Date.now() + 5000; sendLobby(r); } break;
    case 'nuke': { const auto = !!m.auto && p.name === OWNER_NAME && (r.phase === 'live' || r.phase === 'planted'); if (r.nuke) break; if (!auto && (r.mode !== 'chaos' || r.phase !== 'live' || !p.alive || (p.ks || 0) < NUKE_KS)) break; if (!auto) p.ks = 0; r.nuke = { at: Date.now() + 5000, by: p.id, team: p.team }; bcast(r, { t: 'nk', i: p.id, n: p.name }); break; }
    case 'skipkc': { if (!p.alive && p.respawnAt) p.respawnAt = Math.min(p.respawnAt, Math.max(Date.now() + 200, (p.diedAt || 0) + 1500)); break; }
    case 'hacker': { if (!p.alive || p.jailed || r.phase === 'lobby' || r.phase === 'over') break; for (const q of r.players.values()) if (q.jailed) q.jailed = false; p.jailed = true; p.protectUntil = Date.now() + 7600; bcast(r, { t: 'jail', i: p.id, n: p.name }); break; }
    case 'chat': { const txt = clean(m.msg, 120); if (txt) bcast(r, { t: 'chat', i: p.id, n: p.name, msg: txt, tm: p.team }); break; }
  }
}
function joinRoom(c, r) {
  if (c.room) leaveRoom(c);
  if (humans(r).length >= r.max) { c.send({ t: 'err', msg: 'That server is full.' }); return; }
  const tc = humans(r).filter(p => p.team === 'T').length, cc = humans(r).filter(p => p.team === 'CT').length;
  const team = tc <= cc ? 'T' : 'CT';
  const p = newPlayer({ id: newId('p'), name: c.name || 'Player', conn: c, team, outfit: c.outfit });
  if (resp(r)) p.money = respMoney(r);
  // make the name unique in the room
  let base = p.name, n = 2; while ([...r.players.values()].some(q => q.name === p.name)) p.name = base + ' ' + (n++);
  r.players.set(p.id, p); c.player = p; c.room = r;
  bcast(r, { t: 'pj', p: pubP(p) }, p);
  balanceBots(r); pickHost(r); pickOwner(r);
  if (r.phase === 'lobby' && r.persistent && !r.autoAt) r.autoAt = Date.now() + 45000;
  const spawnNow = resp(r) && r.phase === 'live';
  c.send({ t: 'j', you: p.id, team: p.team, room: { id: r.id, name: r.name, map: r.map, theme: r.theme, mode: r.mode, toWin: r.toWin, killLimit: r.killLimit },
    ps: [...r.players.values()].map(pubP), host: r.host, ph: r.phase, tm: r.timer, sc: r.score, bomb: r.bomb, round: r.round, me: meData(p), lobby: lobbyState(r) });
  sendLobby(r);
  if (spawnNow) respawn(r, p);
  for (const b of r.players.values()) if (b.bot && !b.alive && spawnNow) b.respawnAt = Date.now() + 500;
  console.log(`[join] ${p.name} -> ${r.name} (${humans(r).length} players)`);
}
function leaveRoom(c) {
  const r = c.room, p = c.player; if (!r || !p) return;
  c.room = null; c.player = null; removePlayer(r, p);
  if (!r.persistent && !humans(r).length) { rooms.delete(r.id); }
  console.log(`[leave] ${p.name} <- ${r.name}`);
}

// ---------------------------------------------------------------------
//  HTTP + upgrade
// ---------------------------------------------------------------------
const PUBLIC = path.join(__dirname, 'public');
// ===================== ACCOUNTS (cloud saves) =====================
// Storage: Upstash Redis REST if UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN are set (survives restarts),
// otherwise a local JSON file (fine for testing, but Render's free disk is wiped on every restart/redeploy).
const KV_URL = process.env.UPSTASH_REDIS_REST_URL || '', KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const DATA_FILE = path.join(__dirname, 'data', 'accounts.json');
let fileKV = {}; try { fileKV = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
let fileSaveT = null;
function fileFlush() { clearTimeout(fileSaveT); fileSaveT = setTimeout(() => { try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(fileKV)); } catch (e) { console.log('save failed', e.message); } }, 400); }
async function kv(cmd) {
  if (KV_URL) { const r = await fetch(KV_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + KV_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) }); const j = await r.json(); if (j.error) throw new Error(j.error); return j.result; }
  const [op, k, v] = cmd; if (op === 'GET') return k in fileKV ? fileKV[k] : null; if (op === 'SET') { fileKV[k] = v; fileFlush(); return 'OK'; } if (op === 'DEL') { delete fileKV[k]; fileFlush(); return 1; } return null;
}
const kvGet = async k => { const v = await kv(['GET', k]); return v == null ? null : JSON.parse(v); };
const kvSet = (k, v) => kv(['SET', k, JSON.stringify(v)]);
const kvDel = k => kv(['DEL', k]);
const hashPass = (pass, salt) => crypto.scryptSync(pass, salt, 32).toString('hex');
const loginHits = new Map();
function rateOk(ip) { const now = Date.now(); const h = (loginHits.get(ip) || []).filter(t => now - t < 60000); h.push(now); loginHits.set(ip, h); return h.length <= 12; }
function readBody(req, max) { return new Promise((res, rej) => { let b = '', n = 0; req.on('data', c => { n += c.length; if (n > max) { rej(new Error('too big')); req.destroy(); } else b += c; }); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(new Error('bad json')); } }); req.on('error', rej); }); }
function jsonRes(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
async function authUser(req) { const t = (req.headers.authorization || '').replace(/^Bearer\s+/, ''); if (!/^[a-f0-9]{48}$/.test(t)) return null; const u = await kvGet('tok:' + t); if (!u) return null; const a = await kvGet('acct:' + u); return a ? { a, t } : null; }
async function handleApi(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (url === '/api/register' || url === '/api/login') {
      if (req.method !== 'POST') return jsonRes(res, 405, { error: 'POST only' });
      if (!rateOk(ip)) return jsonRes(res, 429, { error: 'Too many tries. Wait a minute.' });
      const b = await readBody(req, 4096); const user = String(b.user || '').trim(), pass = String(b.pass || '');
      if (!/^[A-Za-z0-9_]{3,16}$/.test(user)) return jsonRes(res, 400, { error: 'Username must be 3-16 letters, numbers or _' });
      if (pass.length < 6 || pass.length > 72) return jsonRes(res, 400, { error: 'Password must be at least 6 characters' });
      const key = 'acct:' + user.toLowerCase(); let a = await kvGet(key);
      if (url === '/api/register') { if (a) return jsonRes(res, 409, { error: 'That username is taken' }); const salt = crypto.randomBytes(16).toString('hex'); a = { user, salt, hash: hashPass(pass, salt), tokens: [], save: null, updated: 0, created: Date.now() }; }
      else { if (!a || !crypto.timingSafeEqual(Buffer.from(hashPass(pass, a.salt), 'hex'), Buffer.from(a.hash, 'hex'))) return jsonRes(res, 401, { error: 'Wrong username or password' }); }
      const tok = crypto.randomBytes(24).toString('hex'); a.tokens = (a.tokens || []).concat(tok); while (a.tokens.length > 8) { const old = a.tokens.shift(); await kvDel('tok:' + old); }
      await kvSet(key, a); await kvSet('tok:' + tok, user.toLowerCase());
      return jsonRes(res, 200, { token: tok, user: a.user, save: a.save, updated: a.updated || 0 });
    }
    if (url === '/api/save') {
      const au = await authUser(req); if (!au) return jsonRes(res, 401, { error: 'Please log in again' });
      if (req.method === 'GET') return jsonRes(res, 200, { user: au.a.user, save: au.a.save, updated: au.a.updated || 0 });
      if (req.method === 'POST') { const b = await readBody(req, 300000); if (!b || typeof b.save !== 'object') return jsonRes(res, 400, { error: 'No save data' });
        au.a.save = b.save; au.a.updated = Date.now(); await kvSet('acct:' + au.a.user.toLowerCase(), au.a); return jsonRes(res, 200, { ok: true, updated: au.a.updated }); }
      return jsonRes(res, 405, { error: 'GET or POST' });
    }
    if (url === '/api/logout' && req.method === 'POST') { const au = await authUser(req); if (au) { au.a.tokens = (au.a.tokens || []).filter(x => x !== au.t); await kvSet('acct:' + au.a.user.toLowerCase(), au.a); await kvDel('tok:' + au.t); } return jsonRes(res, 200, { ok: true }); }
    if (url === '/api/status') return jsonRes(res, 200, { accounts: true, storage: KV_URL ? 'cloud' : 'file' });
    return jsonRes(res, 404, { error: 'Unknown endpoint' });
  } catch (e) { console.log('api error', e.message); return jsonRes(res, e.message === 'too big' ? 413 : 500, { error: e.message === 'too big' ? 'Save too large' : 'Server error' }); }
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) { handleApi(req, res, url); return; }
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/rooms') { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify([...rooms.values()].map(roomInfo))); return; }
  const file = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
  const fp = path.join(PUBLIC, path.normalize(file).replace(/^(\.\.[\/\\])+/, ''));
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const type = fp.endsWith('.html') ? 'text/html; charset=utf-8' : fp.endsWith('.js') ? 'text/javascript' : fp.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': fp.endsWith('.mp3') ? 'public, max-age=86400' : 'no-cache' }); res.end(data);
  });
});
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { sock.destroy(); return; }
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + acc + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = new Conn(sock);
  c.onmessage = msg => handle(c, msg);
  c.onclose = () => leaveRoom(c);
});

// default public servers that are always listed
makeRoom({ name: 'Dustline · Bomb Defusal 24/7', map: 'dustline', mode: 'bomb', theme: 'day', max: 10, bots: true, toWin: 8 }, true);
makeRoom({ name: 'Warehouse · Team Deathmatch', map: 'foundry', mode: 'tdm', theme: 'dusk', max: 10, bots: true, killLimit: 40 }, true);
makeRoom({ name: 'Harbor Nights · Bomb Defusal', map: 'harbor', mode: 'bomb', theme: 'night', max: 8, bots: true, toWin: 6 }, true);
makeRoom({ name: 'Dustline · CHAOS 24/7', map: 'dustline', mode: 'chaos', theme: 'dusk', max: 10, bots: true, killLimit: 50 }, true);

setInterval(() => { for (const r of rooms.values()) tick(r); }, TICK_MS);
setInterval(() => { for (const r of rooms.values()) snapshot(r); }, SNAP_MS);
setInterval(() => { // keep-alive pings + cleanup of empty custom rooms
  for (const r of [...rooms.values()]) if (!r.persistent && !humans(r).length && Date.now() - r.emptySince > 30000) rooms.delete(r.id);
}, 10000);

server.listen(PORT, () => console.log(`PROTOCOL: EMBER server running on port ${PORT}`));
