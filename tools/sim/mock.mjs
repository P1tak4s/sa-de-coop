// Mock CLEO Redux runtime for tools/sim/harness.mjs: game memory, game classes, the coopnet64 DLL and a fake clock.
// Nothing here knows the scenarios; they drive a Sim through its fields (see scenarios.mjs).
import vm from 'node:vm';

export const IMAGE_BASE = 0x7ff600000000; // where "ib = true" addresses land
const HEAP = 0x20000000000, HEAP_END = HEAP + 0x40000000; // Memory.Allocate hands out from here
const POOL_AT = { veh: 0x31000000000, ped: 0x32000000000 };
const BIKES = new Set([448, 461, 462, 463, 468, 471, 481, 509, 510, 521, 522, 523, 581, 586]);
// used only when sa.d.ts cannot be read
const FALLBACK_CLASSES = ['Char', 'Car', 'Player', 'Blip', 'Sphere', 'DecisionMakerChar', 'DynamicLibrary', 'Group'];
const FALLBACK_SPACES = ['Streaming', 'Text', 'Camera', 'Cutscene', 'Task', 'World', 'Weather', 'Stat', 'Audio', 'Pad',
  'Weapon', 'FxtStore', 'Game', 'Hud', 'Clock'];

export class SimStop { toString() { return '__SIM_STOP__'; } }
export class SimExit { constructor(reason) { this.reason = reason; } toString() { return '__SIM_EXIT__'; } }

// sa.d.ts -> { classes/namespaces: { cls, inst: {method: returnType}, stat: {...} }, funcs, vars }
export function parseDts(text) {
  const decl = {}, funcs = new Set(), vars = new Set();
  const lines = text.split(/\r?\n/);
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    let m;
    if ((m = /^(?:declare )?(class|interface) (\w+)/.exec(l))) {
      cur = decl[m[2]] ??= { cls: false, inst: {}, stat: {} };
      if (m[1] === 'class') cur.cls = true;
      continue;
    }
    if (l.startsWith('}')) { cur = null; continue; }
    if (!cur) {
      if ((m = /^declare function (\w+)/.exec(l))) funcs.add(m[1]);
      else if ((m = /^declare (?:const|var|let) (\w+)/.exec(l))) vars.add(m[1]);
      continue;
    }
    m = /^(?: {2}| {4})(static )?(\w+)(?:<[^>]*>)?\(.*\): (.+?);?\s*(?:\/\*.*)?$/.exec(l);
    if (!m) continue;
    let type = m[3];
    if (type === '{') { // a multi-line object type
      type = {};
      while (++i < lines.length && !/^ {4}}/.test(lines[i])) { const f = /^\s+(\w+): (.+?);/.exec(lines[i]); if (f) type[f[1]] = f[2]; }
    }
    (m[1] ? cur.stat : cur.inst)[m[2]] = type;
  }
  return { decl, funcs, vars };
}

const SIZE = { U8: 1, I8: 1, U16: 2, I16: 2, U32: 4, I32: 4, Float: 4 };
const GET = { U8: 'getUint8', I8: 'getInt8', U16: 'getUint16', I16: 'getInt16', U32: 'getUint32', I32: 'getInt32', Float: 'getFloat32' };

// Sparse byte memory: real bytes wherever something was written, 0 everywhere else.
class Mem {
  constructor(note) { this.pages = new Map(); this.allocs = []; this.top = HEAP; this.note = note; this.dv = new DataView(new ArrayBuffer(8)); }
  byte(a) { const p = this.pages.get(Math.floor(a / 4096)); return p ? p[a % 4096] : 0; }
  setByte(a, v) {
    const k = Math.floor(a / 4096);
    let p = this.pages.get(k);
    if (!p) this.pages.set(k, p = new Uint8Array(4096));
    p[a % 4096] = v;
  }
  // an access inside the heap must fall inside one live buffer of the script
  ok(a, n, what) {
    if (!Number.isFinite(a) || a < 0 || a > 2 ** 48) { this.note(`${what}: bad address ${a}`); return false; }
    if (a >= HEAP && a < HEAP_END && !this.allocs.some((b) => !b.freed && a >= b.base && a + n <= b.base + b.size)) {
      const i = this.allocs.findLastIndex((b) => b.base <= a), b = this.allocs[i];
      this.note(`${what}: outside the script's buffers (${b ? `buffer #${i} of ${b.size} bytes${b.freed ? ', freed' : ''}, offset ${a - b.base}` : 'no buffer'})`);
    }
    return true;
  }
  r(kind, a, what = 'read') {
    const n = SIZE[kind];
    if (!this.ok(a, n, what)) return 0;
    for (let i = 0; i < n; i++) this.dv.setUint8(i, this.byte(a + i));
    return this.dv[GET[kind]](0, true);
  }
  w(kind, a, v, what = 'write') {
    const n = SIZE[kind];
    if (!this.ok(a, n, what)) return;
    this.dv[GET[kind].replace('get', 'set')](0, v, true);
    for (let i = 0; i < n; i++) this.setByte(a + i, this.dv.getUint8(i));
  }
  alloc(n) {
    const base = this.top;
    this.allocs.push({ base, size: n, freed: false });
    this.top += Math.ceil((n + 64) / 16) * 16; // a gap after each buffer, so an overrun is seen
    return base;
  }
  free(a) { const b = this.allocs.find((x) => x.base === a && !x.freed); if (b) b.freed = true; else this.note(`Memory.Free: ${a} is not a live buffer`); }
  str(a, max) { let s = ''; for (let i = 0; i < max; i++) { const c = this.byte(a + i); if (!c) break; s += String.fromCharCode(c); } return s; }
  wstr(a, s, what) { for (let i = 0; i < s.length; i++) this.w('U8', a + i, s.charCodeAt(i) & 0x7f, what); this.w('U8', a + s.length, 0, what); }
  wptr(a, v) { this.w('U32', a, v % 0x100000000); this.w('U32', a + 4, Math.floor(v / 0x100000000)); }
}

export class Sim {
  constructor({ role, dts, file, maxTicks, strictApi }) {
    this.role = role; this.host = role === 'host';
    this.mySlot = this.host ? 0 : 1; this.friendSlot = this.host ? 1 : 0;
    this.dts = dts; this.decl = dts?.decl; this.file = file; this.maxTicks = maxTicks; this.strictApi = strictApi;
    this.tick = 0; this.now = 1_760_000_000_000; this.stop = new SimStop(); this.peeking = 0;
    this.plan = [];
    // what the report reads
    this.logs = new Map(); this.findings = new Map(); this.throws = new Map(); this.fallbacks = new Map();
    this.sent = new Map(); this.apiCalls = new Map(); this.exited = null;
    this.mem = new Mem((text) => this.finding('MEM', text));
    // the game world
    this.chars = new Map(); this.cars = new Map(); this.idx = { ped: [], car: [] }; this.miscHandle = 5000;
    this.me = this.addChar({ model: 0, x: 2495, y: -1687, z: 13.5 });
    this.playing = true; this.wanted = 0; this.targeting = false; this.padState = 0; this.areaShown = 0;
    this.keys = new Set(); this.keyUntil = new Map();
    this.loaded = new Set(); this.pending = new Map(); this.slowModels = false;
    this.stats = new Map(); this.progress = 12.5; this.tag = null; this.tagPct = 0;
    this.cut = null; this.cutLoadDelay = 10; this.cutLen = 120; this.cutSkipped = false; this.cutOffset = { xOffset: 0, yOffset: 0, zOffset: 0 };
    this.poolsOn = false;
    // the DLL
    this.status = 2; this.friend = null; this.events = []; this.ents = -1; this.worldEnts = [];
    this.settings = [0, 30]; this.revived = 0; this.refused = 0; this.code = ''; this.latest = '0.0.1'; this.friendName = 'Tomas';
    this.leftovers = []; this.nativeRefuse = false; this.nativeOp = null; this.nativeDone = 0; this.procs = [];
    this.api = this.makeApi();
    this.impl = this.makeImpl();
  }

  // ---- scenario helpers -------------------------------------------------------------------------------------
  on(a, b, fn) { if (typeof b === 'function') this.plan.push([a, a + 1, b]); else this.plan.push([a, b, fn]); }
  F(patch) { // the friend's state, as coop_get hands it out
    this.friend ??= { x: this.me.x + 3, y: this.me.y, z: this.me.z, heading: 0, vx: 0, vy: 0, vz: 0, qx: 0, qy: 0, qz: 0, qw: 1,
      carSpeed: 0, inCar: 0, carModel: 0, health: 100, carHealth: 0, interior: 0, clock: 720, weapon: 0, flags: 0 };
    return Object.assign(this.friend, patch);
  }
  ev(kind, text) { this.events.push([kind, String(text)]); }
  press(code, ticks = 3) { this.keys.add(code); this.keyUntil.set(code, this.tick + ticks); }
  skip(ms) { this.now += ms; }
  ib(rva) { return IMAGE_BASE + rva; }
  set ONMISSION(v) { this.ctx.ONMISSION = v; }
  get ONMISSION() { return this.ctx.ONMISSION; }
  // a look into the running script (its top-level let/const are reachable from another script in the same context)
  peek(expr) { this.peeking++; try { return vm.runInContext(expr, this.ctx); } catch (e) { return undefined; } finally { this.peeking--; } }
  get rva() { return this._rva ??= this.peek('({ RVA, MRVA, SRVA, WRVA })'); }
  copy() { return this.peek(`remotes[${this.friendSlot}] ? +remotes[${this.friendSlot}].ped : 0`) || 0; }       // our copy of the friend
  copyCar() { return this.peek(`remotes[${this.friendSlot}] && remotes[${this.friendSlot}].car ? +remotes[${this.friendSlot}].car : 0`) || 0; }

  handle(kind) { // slot * 256 + flag, as in the game's pools; a reused slot gets the next flag
    const list = this.idx[kind];
    let i = list.findIndex((f, k) => k > 0 && f < 0);
    if (i < 0) i = Math.max(kind === 'car' ? 64 : 1, list.length); // apart, so a ped and a car seldom share a number
    const flag = (Math.abs(list[i] || 0) % 0x7f) + 1;
    list[i] = flag;
    return i * 256 + flag;
  }
  release(kind, h) { this.idx[kind][h >> 8] = -(h & 0xff); }
  addChar(o = {}) {
    const m = this.me || { x: 0, y: 0, z: 0 };
    const c = { h: this.handle('ped'), model: 7, x: m.x, y: m.y, z: m.z, heading: 0, health: 100, car: 0, seat: -1, area: 0, weapon: 0,
      ammo: new Map(), vel: { x: 0, y: 0, z: 0 }, shooting: false, pedType: 4, inGroup: false, hitByPlayer: false, ...o };
    this.chars.set(c.h, c);
    return c;
  }
  addCar(o = {}) {
    const m = this.me;
    const c = { h: this.handle('car'), model: 410, x: m.x, y: m.y, z: m.z, heading: 0, q: { x: 0, y: 0, z: 0, w: 1 }, health: 1000, driver: 0,
      pass: [0, 0, 0], colors: [1, 1], vel: { x: 0, y: 0, z: 0 }, speed: 0, ...o };
    c.seats = BIKES.has(c.model) ? 1 : 3;
    this.cars.set(c.h, c);
    return c;
  }
  seat(ph, ch, seat = -1) {
    this.unseat(ph);
    const p = this.chars.get(ph), c = this.cars.get(ch);
    if (!p || !c) return;
    if (seat < 0) { if (c.driver) this.unseat(c.driver); c.driver = ph; } else { if (c.pass[seat]) this.unseat(c.pass[seat]); c.pass[seat] = ph; }
    p.car = ch; p.seat = seat;
  }
  unseat(ph, x, y, z) {
    const p = this.chars.get(ph);
    if (!p) return;
    const c = this.cars.get(p.car);
    if (c) { if (c.driver === ph) c.driver = 0; c.pass = c.pass.map((v) => (v === ph ? 0 : v)); if (x === undefined) ({ x, y, z } = c); }
    p.car = 0; p.seat = -1;
    if (x !== undefined) Object.assign(p, { x, y, z });
  }
  deleteChar(h) { if (!this.chars.has(h)) return; this.unseat(h); this.chars.delete(h); this.release('ped', h); }
  deleteCar(h) {
    const c = this.cars.get(h);
    if (!c) return;
    for (const p of [c.driver, ...c.pass]) if (p) this.unseat(p);
    this.cars.delete(h); this.release('car', h);
  }

  // ---- recording --------------------------------------------------------------------------------------------
  scriptLine() { // the line of the script that is calling into the mock right now
    const l = new Error().stack.split('\n').find((x) => x.includes(this.file));
    const m = l && /:(\d+):\d+\)?$/.exec(l);
    return m ? +m[1] : 0;
  }
  finding(kind, text) {
    const f = this.findings.get(kind + text);
    if (f) f.n++; else this.findings.set(kind + text, { kind, text, line: this.scriptLine(), n: 1 });
  }
  thrown(line, fn, msg) {
    const k = `${line}|${msg}`, t = this.throws.get(k);
    if (t) t.n++; else this.throws.set(k, { line, fn, msg, n: 1 });
  }
  onLog(text) {
    if (text.includes('__SIM_STOP__')) return; // the stop signal, caught by a try of the script on its way out
    const k = text.replace(/-?\d+(\.\d+)?/g, '#'), l = this.logs.get(k);
    if (l) l.n++; else this.logs.set(k, { text, n: 1 });
  }
  guard(what, fn) { // a mistake of the harness must not look like one of the script
    try { return fn(); } catch (e) {
      if (!(e instanceof SimStop) && !(e instanceof SimExit) && !e.simulated) this.finding('HARNESS', `${what}: ${String(e.stack).split('\n').slice(0, 2).join(' ')}`);
      throw e;
    }
  }
  checkArgs(key, args) {
    args.forEach((a, i) => { if (a === undefined || a === null || (typeof a === 'number' && Number.isNaN(a))) this.finding('ARGS', `${key}() argument ${i + 1} is ${a}`); });
  }

  // ---- the frame ---------------------------------------------------------------------------------------------
  wait(ms) {
    if (!(ms >= 0)) this.finding('ARGS', `wait() argument is ${ms}`);
    this.tick++; this.now += Math.max(16, ms | 0);
    if (this.tick > this.maxTicks) throw this.stop;
    try {
      if (this.nativeOp !== null) { // the game's own thread took the call
        if (this.nativeOp === 0x02E7 && this.cut) this.cut.started = this.tick;
        if (this.nativeOp === 0x02EA) this.cut = null;
        this.nativeOp = null; this.nativeDone++;
      }
      for (const [id, at] of this.pending) if (this.tick >= at) { this.pending.delete(id); this.loaded.add(id); }
      for (const [k, t] of this.keyUntil) if (this.tick >= t) { this.keys.delete(k); this.keyUntil.delete(k); }
      for (const [a, b, fn] of this.plan) if (this.tick >= a && this.tick < b) fn(this.tick - a);
      if (this.poolsOn) this.syncPools();
    } catch (e) { this.finding('HARNESS', `scenario step at tick ${this.tick}: ${String(e.stack).split('\n').slice(0, 2).join(' ')}`); }
  }
  // the game's ped and vehicle pools, from the entities that exist (the script walks them: poolEach)
  syncPools() {
    const W = this.rva?.WRVA;
    if (!W) return;
    for (const [rva, size, map, list, pool] of [[W.vehPool, W.vehSize, this.cars, this.idx.car, POOL_AT.veh], [W.pedPool, W.pedSize, this.chars, this.idx.ped, POOL_AT.ped]]) {
      const objects = pool + 0x1000000, flags = pool + 0x1000;
      this.mem.wptr(IMAGE_BASE + rva, pool); this.mem.wptr(pool, objects); this.mem.wptr(pool + 8, flags);
      this.mem.w('I32', pool + 0x10, list.length);
      for (let i = 0; i < list.length; i++) this.mem.w('U8', flags + i, 0x80);
      for (const e of map.values()) { this.mem.w('U8', flags + (e.h >> 8), e.h & 0xff); this.mem.w('I16', objects + (e.h >> 8) * size + W.model, e.model); }
    }
  }

  // ---- the DLL -----------------------------------------------------------------------------------------------
  makeApi() {
    const S = this, M = this.mem;
    const put = (buf, s, what) => { M.wstr(buf, s, what); return s.length; };
    return {
      coop_start: () => 0, coop_host: () => 0, coop_join_clipboard: () => 0,
      coop_status: () => S.status, coop_slot: () => (S.status === 2 ? S.mySlot : -1), coop_is_host: () => (S.host ? 1 : 0),
      coop_code: (buf) => put(buf, S.code, 'coop_code'),
      coop_name: (slot, buf) => put(buf, S.friendName, 'coop_name'),
      coop_latest: (buf) => put(buf, S.latest, 'coop_latest'),
      coop_send: () => 0,
      coop_get: (slot, buf) => {
        if (!S.friend || slot !== S.friendSlot) return 0;
        const L = S.layout ??= S.peek('({ F, I })');
        for (const k in L.F) M.w('Float', buf + L.F[k], S.friendField(k), 'coop_get');
        for (const k in L.I) M.w('I32', buf + L.I[k], S.friendField(k), 'coop_get');
        return 1;
      },
      coop_revive: () => 0, coop_take_revived: () => { const v = S.revived; S.revived = 0; return v; },
      coop_take_refused: () => { const v = S.refused; S.refused = 0; return v; },
      coop_event_send: (kind, buf) => {
        const e = S.sent.get(kind) || { n: 0, last: '' };
        e.n++; e.last = M.str(buf, 127); S.sent.set(kind, e);
        return 1;
      },
      coop_event_poll: (buf) => { const e = S.events.shift(); if (!e) return 0; M.wstr(buf, e[1].slice(0, 126), 'coop_event_poll'); return e[0]; },
      // layouts: sendMissionEntities / mirrorMissionEntities and sendWorldTick / receiveWorldTick of the script
      coop_ents_send: (buf, n) => { for (let i = 0; i < n; i++) S.sentHandle('coop_ents_send', M.r('I32', buf + i * 28), M.r('U8', buf + i * 28 + 4) & 3); return 0; },
      coop_ents_get: (buf) => {
        if (!Array.isArray(S.ents)) return -1;
        const size = S.peek('ENT_SIZE') || 28;
        S.ents.forEach((e, i) => {
          const b = buf + i * size, w = 'coop_ents_get';
          M.w('I32', b, e.h, w); M.w('U8', b + 4, e.kind, w); M.w('U8', b + 5, e.dead || 0, w); M.w('U16', b + 6, e.model, w);
          [e.x, e.y, e.z, e.heading || 0, e.hp ?? 100].forEach((v, k) => M.w('Float', b + 8 + k * 4, v, w));
        });
        return S.ents.length;
      },
      coop_world_send: (buf, n) => { for (let i = 0; i < n; i++) S.sentHandle('coop_world_send', M.r('I32', buf + i * 44), M.r('U8', buf + i * 44 + 4)); return 0; },
      coop_world_get: (buf, max) => {
        const size = S.peek('WORLD_SIZE') || 44, list = S.worldEnts.slice(0, max);
        list.forEach((e, i) => {
          const b = buf + i * size, w = 'coop_world_get';
          M.w('I32', b, e.h, w); M.w('U8', b + 4, e.kind, w); M.w('U8', b + 5, e.c1 || 0, w); M.w('U8', b + 6, e.c2 || 0, w); M.w('U8', b + 7, e.flags || 0, w);
          M.w('U16', b + 8, e.model, w); M.w('U16', b + 10, e.drv || 0, w);
          [e.x, e.y, e.z, e.heading || 0, e.vx || 0, e.vy || 0, e.vz || 0, e.hp ?? 100].forEach((v, k) => M.w('Float', b + 12 + k * 4, v, w));
        });
        return list.length;
      },
      coop_my_skin: () => 0, coop_set_partner: () => 0, coop_track: () => 0, coop_untrack: () => 0, coop_tracked: () => 0,
      coop_take_tracked: (owner, out) => {
        const e = S.leftovers.shift();
        if (!e) return 0;
        e.forEach((v, k) => M.w('I32', out + k * 4, v, 'coop_take_tracked'));
        return 1;
      },
      coop_setting: (i) => S.settings[i] ?? 0,
      coop_native: (op) => { if (S.nativeRefuse) return 0; S.nativeOp = op; return 1; },
      coop_native_done: () => S.nativeDone,
      coop_claim: () => 1, coop_release: () => 0, coop_flag: () => 0, coop_guest_lock: () => 0,
    };
  }
  friendField(k) {
    if (!(k in this.friend)) { this.finding('HARNESS', `the script's state table has a field "${k}" the harness does not fill`); return 0; }
    return this.friend[k];
  }
  // what the script sends about its own world must be something that exists there
  sentHandle(what, h, kind) {
    if (!(kind === 1 ? this.cars : this.chars).has(h)) this.finding('MEM', `${what}: entry with handle ${h} (kind ${kind}) that is not in the game: layout drift?`);
  }
  apiCall(name, args) {
    this.apiCalls.set(name, (this.apiCalls.get(name) || 0) + 1);
    this.checkArgs(`api.${name}`, args);
    const f = this.api[name];
    if (!f) { this.finding('HARNESS', `api.${name} has no mock: returns 0`); return 0; }
    return this.guard(`api.${name}`, () => f(...args.map(Number))) | 0;
  }

  // ---- game classes ------------------------------------------------------------------------------------------
  def(type, cls, recv, name, st) { // a default value of the declared return type
    if (type === undefined) return /^(is|has|does|was|can|are)[A-Z]/i.test(name) ? false : /Coord|Position|Velocity|Offset/.test(name) ? { x: 0, y: 0, z: 0 } : /^(get|store)/i.test(name) ? 0 : undefined;
    if (typeof type === 'object') return Object.fromEntries(Object.entries(type).map(([k, t]) => [k, this.def(t, cls, recv, k, st)]));
    type = type.trim();
    if (type === 'void' || /\| undefined$/.test(type)) return undefined;
    if (type === 'boolean') return false;
    if (/^(int|float|number)$/.test(type)) return /Health/.test(name) ? 100 : 0;
    if (type === 'string') return '';
    if (this.G[type]) return !st && type === cls ? recv : new this.G[type](/^(Create|Add|Load)/.test(name) ? this.miscHandle++ : -1);
    return 0;
  }
  call(cls, name, st, t, r, a) {
    const d = this.decl?.[cls];
    const type = d ? (st && d.cls ? d.stat[name] : d.inst[name]) : undefined;
    const key = `${cls}${st ? '.' : '#'}${name}`;
    if (d && type === undefined) this.finding('UNDECLARED', `${key}() is not in sa.d.ts: a TypeError in the game`);
    this.checkArgs(key, a);
    if (!st && (cls === 'Char' || cls === 'Car') && !(cls === 'Char' ? this.chars : this.cars).has(t.h)) {
      this.finding('DEAD', `${key}() on handle ${t.h > 0 ? 'of something that is gone' : t.h}`);
      return this.def(type, cls, r, name, st);
    }
    const impl = this.impl[cls]?.[st ? 'stat' : 'inst']?.[name];
    if (impl) {
      const v = this.guard(key, () => (st ? impl(...a) : impl(t, ...a)));
      return v === undefined && !st && type === cls ? r : v;
    }
    const v = this.def(type, cls, r, name, st);
    const f = this.fallbacks.get(key);
    if (f) f.n++; else this.fallbacks.set(key, { n: 1, line: this.scriptLine(), noop: v === undefined || v === r, value: v === undefined || v === r ? '' : typeof v === 'object' ? (v.h !== undefined ? `${typeof type === 'string' ? type : 'object'}(${v.h})` : JSON.stringify(v)) : String(v) });
    return v;
  }
  fn(cls, name, st, t, r) {
    if (this.strictApi && this.decl?.[cls]) { // as the game: a name that is not there is not a function
      const d = this.decl[cls];
      if ((st && d.cls ? d.stat[name] : d.inst[name]) === undefined) { this.finding('UNDECLARED', `${cls}${st ? '.' : '#'}${name}() is not in sa.d.ts: a TypeError in the game`); return undefined; }
    }
    return (...a) => this.call(cls, name, st, t, r, a);
  }
  makeClass(name) {
    const S = this;
    class K {
      constructor(h) { this.h = Number(h); return new Proxy(this, inst); }
      valueOf() { return this.h; }
      toString() { return String(this.h); }
    }
    Object.defineProperty(K, 'name', { value: name });
    const inst = { get(t, p, r) { return typeof p === 'symbol' || p in t ? Reflect.get(t, p) : S.fn(name, p, false, t, r); } };
    return new Proxy(K, { get(t, p) { return typeof p === 'symbol' || p === 'prototype' || p === 'name' || p === 'length' ? Reflect.get(t, p) : S.fn(name, p, true); } });
  }
  makeSpace(name) {
    return new Proxy({}, { get: (t, p) => (typeof p === 'symbol' ? undefined : this.fn(name, p, true)) });
  }
  makeMemory() {
    const S = this, M = this.mem;
    const call = (name, a) => {
      const key = `Memory.${name}`;
      let m;
      if (S.decl?.Memory && S.decl.Memory.inst[name] === undefined) S.finding('UNDECLARED', `${key}() is not in sa.d.ts: a TypeError in the game`);
      S.checkArgs(key, a);
      if ((m = /^Read(U8|I8|U16|I16|U32|I32|Float)$/.exec(name))) return M.r(m[1], a[0] + (a[2] ? IMAGE_BASE : 0), key);
      if ((m = /^Write(U8|I8|U16|I16|U32|I32|Float)$/.exec(name))) {
        if (typeof a[1] !== 'number') S.finding('ARGS', `${key}() value is ${typeof a[1]} ${a[1]}`);
        return M.w(m[1], a[0] + (a[3] ? IMAGE_BASE : 0), a[1], key);
      }
      if (name === 'Allocate') return M.alloc(a[0]);
      if (name === 'Free') return M.free(a[0]);
      const f = S.fallbacks.get(key);
      if (f) f.n++; else S.fallbacks.set(key, { n: 1, line: S.scriptLine(), noop: false, value: '0' });
      return 0;
    };
    const Fn = { X64: (proc) => { const name = S.procs[proc - 1]; return (...a) => S.apiCall(name || `proc#${proc}`, a); } };
    return new Proxy({}, { get: (t, p) => (typeof p === 'symbol' ? undefined : p === 'Fn' ? Fn : (...a) => call(p, a)) });
  }
  makeImpl() {
    const S = this;
    const ch = (t) => S.chars.get(t.h), cr = (t) => S.cars.get(t.h);
    const xyz = (o) => ({ x: o.x, y: o.y, z: o.z });
    const put = (o, x, y, z) => { o.x = x; o.y = y; o.z = z; };
    const Char = (h) => new S.G.Char(h), Car = (h) => new S.G.Car(h);
    const d2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
    return {
      Char: {
        stat: {
          Create: (pedType, model, x, y, z) => Char(S.addChar({ model, x, y, z, pedType }).h),
          CreateInsideCar: (car, pedType, model) => { const c = S.cars.get(+car), p = S.addChar({ model, pedType, x: c.x, y: c.y, z: c.z }); S.seat(p.h, c.h); return Char(p.h); },
          DoesExist: (h) => S.chars.has(+h),
        },
        inst: {
          getCoordinates: (t) => xyz(S.cars.get(ch(t).car) || ch(t)),
          setCoordinates: (t, x, y, z) => put(ch(t), x, y, z),
          setCoordinatesNoOffset: (t, x, y, z) => put(ch(t), x, y, z),
          getHeading: (t) => ch(t).heading, setHeading: (t, v) => { ch(t).heading = v; },
          getHealth: (t) => ch(t).health, setHealth: (t, v) => { ch(t).health = v; },
          getModel: (t) => ch(t).model,
          isInAnyCar: (t) => S.cars.has(ch(t).car),
          storeCarIsInNoSave: (t) => Car(S.cars.has(ch(t).car) ? ch(t).car : -1),
          warpIntoCar: (t, car) => S.seat(t.h, +car),
          warpIntoCarAsPassenger: (t, car, seat) => S.seat(t.h, +car, seat),
          warpFromCarToCoord: (t, x, y, z) => S.unseat(t.h, x, y, z),
          delete: (t) => S.deleteChar(t.h),
          getAreaVisible: (t) => ch(t).area, setAreaVisible: (t, v) => { ch(t).area = v; },
          getCurrentWeapon: (t) => ch(t).weapon, setCurrentWeapon: (t, v) => { ch(t).weapon = v; },
          giveWeapon: (t, id, ammo) => { ch(t).ammo.set(id, ammo); },
          hasGotWeapon: (t, id) => ch(t).ammo.has(id),
          getAmmoInWeapon: (t, id) => ch(t).ammo.get(id) || 0,
          getVelocity: (t) => ({ ...ch(t).vel }),
          isShooting: (t) => ch(t).shooting,
          getPedType: (t) => ch(t).pedType,
          isGroupMember: (t) => ch(t).inGroup,
          hasBeenDamagedByChar: (t) => ch(t).hitByPlayer,
          clearLastDamageEntity: (t) => { ch(t).hitByPlayer = false; },
        },
      },
      Car: {
        stat: {
          Create: (model, x, y, z) => Car(S.addCar({ model, x, y, z }).h),
          DoesExist: (h) => S.cars.has(+h),
        },
        inst: {
          getCoordinates: (t) => xyz(cr(t)),
          setCoordinates: (t, x, y, z) => put(cr(t), x, y, z),
          setCoordinatesNoOffset: (t, x, y, z) => put(cr(t), x, y, z),
          getHeading: (t) => cr(t).heading, setHeading: (t, v) => { cr(t).heading = v; },
          getQuaternion: (t) => ({ ...cr(t).q }), setQuaternion: (t, x, y, z, w) => { cr(t).q = { x, y, z, w }; },
          getModel: (t) => cr(t).model,
          getHealth: (t) => cr(t).health, setHealth: (t, v) => { cr(t).health = v; },
          getDriver: (t) => Char(cr(t).driver || -1),
          getSpeed: (t) => cr(t).speed, setForwardSpeed: (t, v) => { cr(t).speed = v; },
          getSpeedVector: (t) => ({ ...cr(t).vel }),
          getColors: (t) => ({ color1: cr(t).colors[0], color2: cr(t).colors[1] }),
          changeColor: (t, a, b) => { cr(t).colors = [a, b]; },
          isPassengerSeatFree: (t, seat) => seat < cr(t).seats && !cr(t).pass[seat],
          getMaximumNumberOfPassengers: (t) => cr(t).seats,
          getCharInPassengerSeat: (t, seat) => Char(cr(t).pass[seat] || -1),
          delete: (t) => S.deleteCar(t.h),
        },
      },
      Player: {
        inst: {
          getChar: () => Char(S.me.h), isPlaying: () => S.playing,
          storeWantedLevel: () => S.wanted, alterWantedLevel: (t, v) => { S.wanted = v; },
          isTargetingAnything: () => S.targeting,
        },
      },
      DynamicLibrary: {
        stat: { Load: (path) => (S.noLib ? undefined : new S.G.DynamicLibrary(1)) },
        inst: { getProcedure: (t, name) => { if (name === S.badProc) throw Object.assign(new Error(`procedure ${name} not found`), { simulated: true }); return S.procs.push(name); } },
      },
      Streaming: {
        stat: {
          HasModelLoaded: (id) => S.loaded.has(id),
          RequestModel: (id) => { if (!S.loaded.has(id) && !S.pending.has(id)) S.pending.set(id, S.tick + (S.slowModels ? 260 : 1)); },
          MarkModelAsNoLongerNeeded: () => {}, // stays loaded: something made of it is still there
          GetAreaVisible: () => S.areaShown, SetAreaVisible: (v) => { S.areaShown = v; },
          IsThisModelABoat: () => false,
        },
      },
      Camera: {
        stat: {
          GetActiveCoordinates: () => ({ x: S.me.x, y: S.me.y - 6, z: S.me.z + 2 }),
          GetActivePointAt: () => xyz(S.me),
          GetFov: () => 70,
        },
      },
      Clock: {
        stat: {
          GetTimeOfDay: () => ({ hours: Math.floor(S.clock / 60), minutes: S.clock % 60 }),
          SetTimeOfDay: (h, m) => { S.clock = h * 60 + m; },
        },
      },
      Cutscene: {
        stat: {
          Load: (name) => { S.cut = { name, loadedAt: S.tick + S.cutLoadDelay, started: null }; },
          HasLoaded: () => !!S.cut && S.tick >= S.cut.loadedAt,
          HasFinished: () => !S.cut || (S.cut.started !== null && S.tick >= S.cut.started + S.cutLen),
          WasSkipped: () => S.cutSkipped,
          GetOffset: () => ({ ...S.cutOffset }),
          Clear: () => { S.cut = null; },
        },
      },
      Pad: { stat: { IsKeyPressed: (code) => S.keys.has(code), GetState: () => S.padState } },
      Weapon: { stat: { GetModel: (id) => 320 + id } },
      World: {
        stat: {
          GetRandomCarOfTypeInAreaNoSave: (x1, y1, x2, y2, model) => {
            for (const c of S.cars.values()) if ((model < 0 || c.model === model) && c.x >= x1 && c.x <= x2 && c.y >= y1 && c.y <= y2) return Car(c.h);
            return Car(-1);
          },
          GetRandomCarInSphereNoSave: (x, y, z, r, model) => {
            for (const c of S.cars.values()) if ((model < 0 || c.model === model) && d2(c, { x, y, z }) <= r * r) return Car(c.h);
            return Car(-1);
          },
          GetNearestTagPosition: () => (S.tag ? { ...S.tag } : { x: 0, y: 0, z: 0 }),
          GetPercentageTaggedInArea: () => S.tagPct,
        },
      },
      Stat: {
        stat: {
          GetFloat: (id) => S.stats.get(id) || 0, GetInt: (id) => S.stats.get(id) || 0,
          SetFloat: (id, v) => { S.stats.set(id, v); }, SetInt: (id, v) => { S.stats.set(id, v); },
          GetProgressPercentage: () => S.progress,
        },
      },
    };
  }

  // the globals of the script, in a context of their own with the fake clock behind Date.now
  context() {
    const g = { ONMISSION: false, TIMERA: 0, TIMERB: 0, HOST: 'sa_unreal', __dirname: '', __filename: this.file };
    this.G = g; this.clock = 720;
    const d = this.dts;
    const classes = d ? Object.keys(d.decl).filter((k) => d.decl[k].cls) : FALLBACK_CLASSES;
    const spaces = d ? Object.keys(d.decl).filter((k) => !d.decl[k].cls && d.vars.has(k) && k !== 'Math') : FALLBACK_SPACES;
    for (const k of classes) g[k] = this.makeClass(k);
    for (const k of spaces) g[k] = this.makeSpace(k);
    g.Memory = this.makeMemory();
    for (const k of d ? d.funcs : []) g[k] = () => { this.finding('HARNESS', `global ${k}() has no mock: does nothing`); };
    g.log = (...v) => this.onLog(v.join(' '));
    g.wait = (ms) => this.wait(ms);
    g.exit = (reason) => { throw new SimExit(reason); };
    g.showTextBox = (text) => { this.checkArgs('showTextBox', [text]); };
    g.__now = () => this.now;
    this.ctx = vm.createContext(g);
    vm.runInContext('Date.now = __now;', this.ctx);
    return this.ctx;
  }
}
