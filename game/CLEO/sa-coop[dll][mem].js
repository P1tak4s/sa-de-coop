/// <reference path=".config/sa.d.ts" />
// SA Co-op: your friend in your world. Keys:
//   F9  the co-op window (session name + password, through Steam), from the title screen on
//   G   sit next to your friend in their car      E   revive your friend when they are down
// Talks to coopnet64.asi (next to SanAndreas.exe; the ASI loader starts it with the game, we use the same copy).

// ---- the DLL -------------------------------------------------------------------------------------------
let lib;
for (const path of ["coopnet64.asi", "../coopnet64.asi"]) {
  lib = DynamicLibrary.Load(path);
  if (lib) break;
}
if (!lib) { log("[sa-coop] coopnet64.asi not found"); exit("coopnet64.asi not found"); }

const api = {};
try {
  for (const name of ["coop_start", "coop_host", "coop_join_clipboard", "coop_code", "coop_status", "coop_slot",
                      "coop_send", "coop_get", "coop_revive", "coop_take_revived", "coop_name", "coop_event_send", "coop_event_poll", "coop_ents_send", "coop_ents_get", "coop_is_host", "coop_my_skin", "coop_set_partner", "coop_track", "coop_untrack", "coop_take_tracked", "coop_setting"]) {
    api[name] = Memory.Fn.X64(lib.getProcedure(name));
  }
} catch (e) {
  log(`[sa-coop] setup failed: ${e}`);
  exit("setup failed");
}

// proto::State, 80 bytes
const SIZE = 80;
const F = { x: 0, y: 4, z: 8, heading: 12, vx: 16, vy: 20, vz: 24, qx: 28, qy: 32, qz: 36, qw: 40, carSpeed: 44 };
const I = { inCar: 48, carModel: 52, health: 56, carHealth: 60, interior: 64, clock: 68, weapon: 72, flags: 76 };
const mine = Memory.Allocate(SIZE);
const theirs = Memory.Allocate(SIZE);
const codeBuf = Memory.Allocate(32);
const nameBuf = Memory.Allocate(32);
const evBuf = Memory.Allocate(128);

const KEY = { G: 71, E: 69 };

// every car and ped we create is remembered in coopnet64.asi; a reloaded script deletes what the old copy left
// (otherwise friends' cars stayed in the world as "ghosts" after each reload)
const OWNER = 1;
function track(ent, kind, model) { try { api.coop_track(OWNER, kind, model, +ent); } catch (e) {} return ent; }
function untrack(ent) { try { api.coop_untrack(+ent); } catch (e) {} }
{
  const out = Memory.Allocate(12);
  let n = 0;
  while (api.coop_take_tracked(OWNER, out)) {
    const kind = Memory.ReadI32(out, false, false), model = Memory.ReadI32(out + 4, false, false), h = Memory.ReadI32(out + 8, false, false);
    try {
      if (kind === 1 && Car.DoesExist(h) && new Car(h).getModel() === model) { new Car(h).delete(); n++; }
      if (kind === 2 && Char.DoesExist(h) && new Char(h).getModel() === model) { new Char(h).delete(); n++; }
    } catch (e) {}
  }
  Memory.Free(out);
  if (n) log(`[sa-coop] removed ${n} leftovers of the previous run`);
}
const SKINS = [105, 106, 107, 105]; // Grove Street looks until we sync clothes
const DOWN_AT = 40;                 // health below this: down instead of dead (one AK hit would skip a lower mark)
// ---- session settings: the host picks them in the co-op menu, the script sends them to the others every 3 s ----
const EVS_SET = 8, EV_PHIT = 9;
const sess = { ff: false, revive: 30 };
let lastSettingsAt = 0;
function bleedOut() { return sess.revive * 1000; } // ms down before the game takes over
const REVIVE_HOLD = 3000;           // hold E this long next to a downed friend
const DOWN_ANIM = ["KO_skid_back", "PED"];
// top-centre banner with a seconds countdown (~1~ is the number)
try {
  FxtStore.insert("COOPDN1", "YOU ARE DOWN! A friend can revive you: ~1~ s");
  FxtStore.insert("COOPDN2", "YOUR HOMIE IS DOWN! Revive: ~1~ s");
  FxtStore.insert("COOPDN3", "Hold E to revive: ~1~ %");
} catch (e) {}
function banner(key, num, y) {
  try {
    Text.UseCommands(true); Text.SetFont(1); Text.SetScale(0.5, 2.0); Text.SetCenter(true);
    Text.SetColor(255, 80, 80, 255); Text.SetDropshadow(2, 0, 0, 0, 255);
    Text.DisplayWithNumber(320, y || 30, key, Math.max(0, Math.ceil(num)));
  } catch (e) {}
}

const player = new Player(0);
const remotes = [null, null, null, null];
let downed = false, downedAt = 0, downWeapon = 0;

// ---- small helpers ------------------------------------------------------------------------------------
function say(text) { try { showTextBox(text); } catch (e) {} log(`[sa-coop] ${text}`); }

const keyWas = {};
function pressed(code) { // true once per press
  const down = Pad.IsKeyPressed(code);
  const fired = down && !keyWas[code];
  keyWas[code] = down;
  return fired;
}

function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z; return dx * dx + dy * dy + dz * dz; }

function readAscii(buf, n) {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(Memory.ReadU8(buf + i, false, false));
  return s;
}
function readCode() { return readAscii(codeBuf, api.coop_code(codeBuf, 32)); }

// ---- names over heads -----------------------------------------------------------------------------------
// The game draws text by key: each friend's name is stored under its own key, refreshed when it changes.
function nameKey(slot, r) {
  const name = readAscii(nameBuf, api.coop_name(slot, nameBuf, 16)) || `Player${slot + 1}`;
  if (name !== r.name) {
    r.name = name;
    try { FxtStore.insert(`COOPN${slot}`, name); } catch (e) { log(`[sa-coop] name key: ${e}`); }
  }
  return `COOPN${slot}`;
}

// world point -> the 640 x 448 screen the game's text uses; null when behind the camera or far away.
// From the camera's place, where it looks and its field of view. The game's own CSprite::CalcScreenCoors (used from
// 11-08) showed no name at all in the first two-player test (11-15), so this is the projection that was seen working,
// with the widescreen maths put right: the game's FOV is the horizontal one of a 4:3 picture and a wider screen
// shows more at the sides (the first version treated it as the 16:9 one, so names slid away from the middle).
const SCREEN_W = 0x531B218, SCREEN_H = 0x531B21C;
function toScreen(p) {
  const cam = Camera.GetActiveCoordinates(), at = Camera.GetActivePointAt();
  let fx = at.x - cam.x, fy = at.y - cam.y, fz = at.z - cam.z;
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  let rx = fy, ry = -fx; const rl = Math.sqrt(rx * rx + ry * ry) || 1; rx /= rl; ry /= rl; // right = forward x up
  const ux = ry * fz, uy = -rx * fz, uz = rx * fy - ry * fx;                                 // up = right x forward
  const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
  const depth = dx * fx + dy * fy + dz * fz;
  if (depth < 1 || depth > 80) return null;
  let aspect = 16 / 9;
  try {
    const w = Memory.ReadI32(SCREEN_W, false, true), h = Memory.ReadI32(SCREEN_H, false, true);
    if (w >= 640 && w <= 8000 && h >= 360 && h <= 5000 && w / h > 1.2 && w / h < 4) aspect = w / h;
  } catch (e) {}
  const tanY = Math.tan((Camera.GetFov() * Math.PI / 180) / 2) * 0.75, tanX = tanY * aspect;
  const sx = 320 + ((dx * rx + dy * ry) / depth / tanX) * 320;
  const sy = 224 - ((dx * ux + dy * uy + dz * uz) / depth / tanY) * 224;
  return sx < 0 || sx > 640 || sy < 0 || sy > 448 ? null : { x: sx, y: sy - 8 }; // text is drawn from its top
}

function drawNames() {
  for (let slot = 0; slot < 4; slot++) {
    const r = remotes[slot];
    if (!r || !Char.DoesExist(r.ped)) continue;
    const head = r.ped.getCoordinates();
    head.z += 1.1;
    const at = toScreen(head);
    if (Date.now() - (r.nameDiagAt || 0) > 15000) { // for logs after a test: is the name placed, and where
      r.nameDiagAt = Date.now();
      log(`[sa-coop] name ${slot}: ${at ? `drawn at ${at.x.toFixed(0)}, ${at.y.toFixed(0)}` : "not on screen"}`);
    }
    if (!at) continue;
    const key = nameKey(slot, r);
    try {
      Text.UseCommands(true);
      Text.SetFont(1);
      Text.SetScale(0.35, 1.4);
      Text.SetCenter(true);
      Text.SetColor(r.down ? 255 : 120, r.down ? 80 : 200, r.down ? 80 : 255, 255);
      Text.SetDropshadow(1, 0, 0, 0, 255);
      Text.Display(at.x, at.y, key);
    } catch (e) {
      if (!r.drawErr) { r.drawErr = true; log(`[sa-coop] draw name: ${e}`); }
    }
  }
}

function readRemote() {
  const s = {};
  for (const k in F) s[k] = Memory.ReadFloat(theirs + F[k], false, false);
  for (const k in I) s[k] = Memory.ReadI32(theirs + I[k], false, false);
  return s;
}

// Never load a model from here. LOAD_ALL_MODELS_NOW makes the game build the model, its materials and shaders on
// the script's thread, and the Definitive Edition crashes on that ("Tried to access cooked shader map ID from unknown
// thread", 11-15; Vice City found the same on 11-08). Ask the game to stream it and use it on a later frame, when the
// game has loaded it itself: every caller comes back the next frame.
const requestedAt = {};
function loadModel(id) {
  if (Streaming.HasModelLoaded(id)) return true;
  const t = Date.now();
  if (!requestedAt[id] || t - requestedAt[id] > 3000) { requestedAt[id] = t; Streaming.RequestModel(id); }
  return false;
}

// Vehicles with flashing lights (police, ambulance, fire, taxi, tow truck, work machines). The game loads their light
// blueprint only when it makes such a vehicle itself; the first one made from a script crashed it (11-15, twice:
// "AssembleReferenceTokenStream for BP_VehicleLight_Blinking(_Blue) called on a non-game thread"). So a copy of one
// is made only while the game has one of its own somewhere; otherwise a plain vehicle stands in for it.
const FLASHERS = new Set([407, 416, 420, 423, 427, 428, 430, 433, 438, 485, 486, 490, 497, 523, 524, 525, 528, 530, 532,
                          544, 552, 574, 583, 588, 596, 597, 598, 599, 601]);
function safeCarModel(model) {
  if (!FLASHERS.has(model)) return model;
  try {
    const c = World.GetRandomCarOfTypeInAreaNoSave(-3000, -3000, 3000, 3000, model);
    if (c && +c > 0 && Car.DoesExist(+c)) return model;
  } catch (e) {}
  return model === 523 ? 461 : 445; // police bike -> PCJ-600, the rest -> Admiral
}

function remoteWithCar(car) {
  for (let i = 0; i < 4; i++) if (remotes[i] && remotes[i].car && +remotes[i].car === +car) return i;
  return -1;
}

// ---- our state ------------------------------------------------------------------------------------------
function writeMine(me) {
  const p = me.getCoordinates();
  let v = { x: 0, y: 0, z: 0 }, q = { x: 0, y: 0, z: 0, w: 1 }, carSpeed = 0, inCar = 0, carModel = 0, carHealth = 0, carColor = 0, burnout = false;
  if (ridingOutside && !Car.DoesExist(ridingOutside.car)) getOffOutside(me);
  if (ridingOutside) {
    const c = ridingOutside.car.getCoordinates();
    p.x = c.x; p.y = c.y; p.z = c.z;
    inCar = 2; carModel = ridingOutside.slot; carHealth = SEAT_OUTSIDE;
  } else if (me.isInAnyCar()) {
    const car = me.storeCarIsInNoSave();
    const c = car.getCoordinates();
    p.x = c.x; p.y = c.y; p.z = c.z;
    const ownerSlot = remoteWithCar(car);
    let driver = null;
    try { driver = car.getDriver(); } catch (e) {}
    if (ownerSlot >= 0 && !(driver && +driver === +me)) {
      // riding with a friend: they send the car; we send which seat we are in, so their copy of us takes the same
      let seat = 0;
      try { for (let i = 0; i < 3; i++) if (+car.getCharInCarPassengerSeat(i) === +me) { seat = i; break; } } catch (e) {}
      inCar = 2; carModel = ownerSlot; carHealth = seat;
    } else {
      q = car.getQuaternion();
      carSpeed = car.getSpeed();
      inCar = 1;
      carModel = car.getModel();
      carHealth = car.getHealth();
      try { v = car.getSpeedVector(); } catch (e) {}
      // burnout: gas and brake held while standing (pad buttons 16 and 14, the keyboard feeds the same pad)
      try { burnout = carSpeed < 3 && Pad.GetState(0, 16) > 0 && Pad.GetState(0, 14) > 0; } catch (e) {}
      // colours ride along: primary in flags bits 24..31, secondary in carHealth bits 16..23, bit 24 = colours sent
      try {
        const cc = Object.values(car.getColors());
        carColor = cc[0] & 0xff;
        carHealth = (Math.max(0, carHealth) & 0xffff) | ((cc[1] & 0xff) << 16) | (1 << 24);
      } catch (e) {}
    }
  } else {
    v = me.getVelocity();
  }
  const f = { x: p.x, y: p.y, z: p.z, heading: me.getHeading(), vx: v.x, vy: v.y, vz: v.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w, carSpeed };
  for (const k in F) Memory.WriteFloat(mine + F[k], f[k], false, false);
  Memory.WriteI32(mine + I.inCar, inCar, false, false);
  Memory.WriteI32(mine + I.carModel, carModel, false, false);
  Memory.WriteI32(mine + I.health, downed ? -1 : me.getHealth(), false, false);
  Memory.WriteI32(mine + I.carHealth, carHealth, false, false);
  let area = 0;
  try { area = me.getAreaVisible(); } catch (e) {}
  Memory.WriteI32(mine + I.interior, area, false, false);
  const t = Clock.GetTimeOfDay();
  Memory.WriteI32(mine + I.clock, t.hours * 60 + t.minutes, false, false);
  let weapon = 0, flags = 0;
  try { weapon = me.getCurrentWeapon(); } catch (e) {}
  try { if (player.isTargetingAnything()) flags |= 1; } catch (e) {}
  try { if (me.isShooting()) flags |= 2; } catch (e) {}
  try { flags |= Math.min(6, player.storeWantedLevel()) << 8; } catch (e) {}
  try { flags |= (api.coop_my_skin() & 0xff) << 16; } catch (e) {}
  flags |= carColor << 24;
  if (burnout) flags |= 8;
  Memory.WriteI32(mine + I.weapon, weapon, false, false);
  Memory.WriteI32(mine + I.flags, flags, false, false);
  api.coop_send(mine);
}

// ---- down and revive (us) -------------------------------------------------------------------------------
function anyFriend() { return remotes.some((r) => r); }

function goDown(me, now) {
  downed = true; downedAt = now;
  if (me.isInAnyCar()) { try { const p = me.getCoordinates(); me.warpFromCarToCoord(p.x + 2, p.y, p.z); } catch (e) {} }
  me.setProofs(true, true, true, true, true);
  // keep the controls (the mouse still turns the camera); hold CJ in place and without a gun instead
  try { downWeapon = me.getCurrentWeapon(); me.setCurrentWeapon(0); } catch (e) {}
  try { me.freezePosition(true); } catch (e) {}
  try { Task.PlayAnim(me, DOWN_ANIM[0], DOWN_ANIM[1], 4.0, false, false, false, true, -1); } catch (e) {}
  say("SA Co-op: you are down. A friend can revive you (30 s)");
}

let graceUntil = 0; // revived: protected for a moment, or the same gunfire puts us down again at once
function getUp(me, health) {
  downed = false;
  try { me.clearTasksImmediately(); } catch (e) {}
  if (health > 0) graceUntil = Date.now() + 3000;
  else me.setProofs(false, false, false, false, false);
  try { me.freezePosition(false); } catch (e) {}
  try { if (downWeapon) me.setCurrentWeapon(downWeapon); } catch (e) {}
  me.setHealth(health);
}

function handleOwnHealth(me, now) {
  if (!downed) {
    if (graceUntil) {
      if (now < graceUntil) return;
      graceUntil = 0;
      me.setProofs(false, false, false, false, false);
    }
    if (anyFriend() && me.getHealth() < DOWN_AT && me.getHealth() > 0) goDown(me, now);
    return;
  }
  banner("COOPDN1", (bleedOut() - (now - downedAt)) / 1000);
  try { if (me.getCurrentWeapon() !== 0) me.setCurrentWeapon(0); if (!me.isPlayingAnim(DOWN_ANIM[0])) Task.PlayAnim(me, DOWN_ANIM[0], DOWN_ANIM[1], 4.0, false, false, false, true, -1); } catch (e) {}
  if (api.coop_take_revived()) { getUp(me, 100); say("SA Co-op: your friend revived you"); return; }
  if (now - downedAt > bleedOut() || !anyFriend()) { getUp(me, 0); } // nobody came: the game's own death
}

// ---- friends --------------------------------------------------------------------------------------------
// story characters load through their own special slots (290 + slot - 1); creating them directly crashes
const STORY_LOOKS = ["", "sweet", "ryder", "smoke", "cesar", "kendl", "wuzimu", "truth"];
function lookModel(slot, look) {
  // story characters (Sweet, Ryder...) need LOAD_SPECIAL_CHARACTER, which crashes the Definitive Edition when a
  // script calls it: everyone gets a Grove Street look until that can be done on the game's own thread
  const m = SKINS[slot];
  return loadModel(m) ? m : 0;
}

function spawnPed(slot, s) {
  const look = (s.flags >> 16) & 0xff;
  const model = lookModel(slot, look);
  if (!model) return null;
  const ped = track(Char.Create(4, model, s.x, s.y, s.z), 2, model);
  if (model < 290) Streaming.MarkModelAsNoLongerNeeded(model);
  ped.setProofs(true, true, true, true, true); // traffic and cops must not kill the copy of your friend
  ped.setCantBeDraggedOut(true);
  ped.setKeepTask(true);
  const blip = Blip.AddForChar(ped);
  try { blip.setAsFriendly(true); blip.changeDisplay(2); } catch (e) {} // map and radar only: the name is over the head
  log(`[sa-coop] friend ${slot} appeared`);
  return { ped, car: null, carModel: 0, blip, lastTask: 0, lostAt: 0, lastPos: null, rx: null, down: false, hinted: false, look };
}

function leaveCar(r, s) {
  try { if (r.ped.isInAnyCar()) r.ped.warpFromCarToCoord(s.x, s.y, s.z); } catch (e) {}
}

function dropCar(r) {
  if (!r.car) return;
  // never delete a car we sit in or are climbing into: get out first, or CJ is left stuck in the enter animation
  try {
    if (Car.DoesExist(r.car)) {
      const me = player.getChar(), c = r.car.getCoordinates();
      if (me.isInAnyCar() && +me.storeCarIsInNoSave() === +r.car) me.warpFromCarToCoord(c.x + 2.5, c.y, c.z);
      else if (dist2(me.getCoordinates(), c) < 49) me.clearTasksImmediately();
    }
  } catch (e) {}
  try {
    if (Car.DoesExist(r.car)) {
      const c = r.car.getCoordinates();
      if (r.ped.isInAnyCar()) r.ped.warpFromCarToCoord(c.x, c.y, c.z);
      untrack(r.car); r.car.delete(); // our copy of their car: no wreck left behind
    }
  } catch (e) {}
  r.car = null; r.carModel = 0; r.rx = null;
}

function removeRemote(slot) {
  const r = remotes[slot];
  if (!r) return;
  dropCar(r);
  dropParked(r);
  try { r.blip.remove(); } catch (e) {}
  try { untrack(r.ped); r.ped.delete(); } catch (e) {}
  remotes[slot] = null;
  log(`[sa-coop] friend ${slot} left`);
}

function driveRemote(r, s, now) {
  if (r.outside) { try { r.ped.detachFromCar(0, 0, 0, false); } catch (e) {} r.outside = null; }
  if (!r.car || r.carModel !== s.carModel || !Car.DoesExist(r.car)) {
    dropCar(r);
    let back = false; // back into the car they left parked: the same copy, not a second one on top of it
    try { back = !!r.parked && Car.DoesExist(r.parked) && r.parkedModel === s.carModel && dist2(r.parked.getCoordinates(), s) < 8 * 8; } catch (e) {}
    if (back) { r.car = r.parked; r.parked = null; log("[sa-coop] friend is back in the parked car"); }
    else {
      dropParked(r);
      const use = safeCarModel(s.carModel); // r.carModel stays theirs, so a stand-in is not remade every frame
      if (!loadModel(use)) return;
      r.car = track(Car.Create(use, s.x, s.y, s.z), 1, use);
      Streaming.MarkModelAsNoLongerNeeded(use);
      log(`[sa-coop] friend's car ${s.carModel}${use !== s.carModel ? ` (shown as ${use}: its lights are not loaded here)` : ""} created: handle ${+r.car}`);
    }
    r.car.setProofs(true, true, true, true, true);
    if (s.carHealth & (1 << 24)) {
      try { r.car.changeColor((s.flags >>> 24) & 0xff, (s.carHealth >>> 16) & 0xff); } catch (e) { log(`[sa-coop] colour: ${e}`); }
    }
    r.carModel = s.carModel;
    leaveCar(r, s);
    r.ped.warpIntoCar(r.car);
    r.rx = null;
  }
  // a new packet: remember where and when
  if (r.rx === null || s.x !== r.rx || s.y !== r.ry || s.z !== r.rz) {
    const moved = r.rx !== null && now > r.rt;
    const dx = moved ? (s.x - r.rx) / ((now - r.rt) / 1000) : 0, dy = moved ? (s.y - r.ry) / ((now - r.rt) / 1000) : 0;
    // the sender's own car velocity: packet-to-packet deltas spike when Steam delivers two at once (11-15, VC test).
    // An older build sends none while driving: then the delta, as before.
    if (s.vx || s.vy || s.vz) { r.vx = s.vx; r.vy = s.vy; r.vz = s.vz; }
    else { r.vx = dx; r.vy = dy; r.vz = 0; }
    r.rx = s.x; r.ry = s.y; r.rz = s.z; r.rt = now;
  }
  const ahead = Math.min((now - r.rt) / 1000, 0.3);
  const tx = r.rx + r.vx * ahead, ty = r.ry + r.vy * ahead, tz = r.rz + r.vz * ahead;
  const c = r.car.getCoordinates();
  const ex = tx - c.x, ey = ty - c.y, ez = tz - c.z;
  const err = Math.sqrt(ex * ex + ey * ey + ez * ez);
  const speed = Math.sqrt(r.vx * r.vx + r.vy * r.vy);
  r.car.setQuaternion(s.qx, s.qy, s.qz, s.qw);
  // far off (a jump, a respawn): put it where it should be
  if (err > 8 + speed * 0.3) {
    r.car.setCoordinatesNoOffset(tx, ty, tz);
    const fx0 = 2 * (s.qx * s.qy - s.qw * s.qz), fy0 = 1 - 2 * (s.qx * s.qx + s.qz * s.qz);
    r.car.setForwardSpeed(r.vx * fx0 + r.vy * fy0 < 0 ? -speed : speed);
    return;
  }
  // off course by more than a metre (the speed below only corrects along the road, a turn leaves it beside the
  // line): a third of the way back each frame. One big jump every few seconds threw a passenger about (11-15:
  // "you teleport when your friend drives"). Moving it stops it, the speed below sets it going again.
  if (err > 1) r.car.setCoordinatesNoOffset(c.x + ex * 0.3, c.y + ey * 0.3, c.z + ez * 0.3);
  // close enough: the game's physics drives it (wheels turn); catch up or fall back through the speed
  // which way the car faces (quaternion applied to +y): moving against it is reverse
  const fx = 2 * (s.qx * s.qy - s.qw * s.qz), fy = 1 - 2 * (s.qx * s.qx + s.qz * s.qz);
  const sign = r.vx * fx + r.vy * fy < 0 ? -1 : 1;
  let along = 0;
  if (speed > 0.5) along = (ex * r.vx + ey * r.vy) / speed;
  r.car.setForwardSpeed(sign * Math.max(0, speed + along * 1.5));
  // a driver with nothing to do holds the handbrake (rear wheels locked): give it a drive towards a point ahead
  if (now - (r.lastDrive || 0) > 300) {
    r.lastDrive = now;
    try {
      if (s.flags & 8) {
        // their burnout: the copy's driver floors it while we hold the car in place, so the wheels spin and smoke
        r.car.setTempAction(8, 400); // TempAction.GoForward
      } else if (speed > 0.5 && sign > 0) {
        r.car.setCruiseSpeed(Math.max(10, speed * 3.6));
        r.car.gotoCoordinatesAccurate(tx + fx * 25, ty + fy * 25, tz);
      } else {
        r.car.setMission(0); // standing or reversing: no AI driving
      }
    } catch (e) {}
  }
}

function rideRemote(r, s, mySlot, me) {
  if (r.car && !releaseCar(r, s)) return;
  const driverSlot = s.carModel;
  let car = null;
  if (driverSlot === mySlot) {
    if (me.isInAnyCar()) car = me.storeCarIsInNoSave(); // they sit in our car
  } else if (remotes[driverSlot] && remotes[driverSlot].car) {
    car = remotes[driverSlot].car; // they sit in another friend's car
  }
  if (!car) { if (r.outside) { try { r.ped.detachFromCar(0, 0, 0, false); } catch (e) {} r.outside = null; } r.ped.setCoordinatesNoOffset(s.x, s.y, s.z); return; }
  if (r.ped.isInAnyCar() || (r.outside && +r.outside === +car)) return;
  try {
    // their seat here may hold someone else (Sweet in a mission): then they ride outside, nobody is pulled out
    const seat = s.carHealth;
    const free = seat !== SEAT_OUTSIDE && seat >= 0 && car.isPassengerSeatFree(seat);
    if (free) r.ped.warpIntoCarAsPassenger(car, seat);
    else { attachOutside(r.ped, car); r.outside = car; }
  } catch (e) { log(`[sa-coop] passenger: ${e}`); }
}

// Out of a car: first the copy gets out, only on a later frame the car is let go (parked, the game clears it later).
// Deleting it in the same frame took the copy along (11-15, VC test: the friend vanished every time he left a car).
function releaseCar(r, s) {
  try {
    if (r.ped.isInAnyCar()) { r.ped.warpFromCarToCoord(s.x, s.y, s.z); return false; }
  } catch (e) {}
  dropParked(r);
  try {
    if (Car.DoesExist(r.car)) {
      // we rode along: out too, or we would report this driverless car as ours
      const me = player.getChar(), c = r.car.getCoordinates();
      if (me.isInAnyCar() && +me.storeCarIsInNoSave() === +r.car) me.warpFromCarToCoord(c.x + 2.5, c.y, c.z);
      r.car.setMission(0); r.parked = r.car; r.parkedModel = r.carModel;
      log(`[sa-coop] friend left the car: ${+r.car} stays parked`);
    } else log("[sa-coop] friend left the car: the copy was already gone");
  } catch (e) { log(`[sa-coop] release car: ${e}`); }
  r.car = null; r.carModel = 0; r.rx = null;
  return true;
}

// the car a friend got out of stays parked (still ours) so they can get back in; it goes when they are far from it,
// take another car or leave. If we took it ourselves, the game keeps it.
function dropParked(r) {
  const car = r.parked;
  r.parked = null;
  try {
    if (!car) return;
    if (!Car.DoesExist(car)) { log(`[sa-coop] parked car ${+car}: the game removed it`); return; }
    log(`[sa-coop] parked car ${+car} removed`);
    untrack(car);
    const me = player.getChar();
    if (me.isInAnyCar() && +me.storeCarIsInNoSave() === +car) { car.setProofs(false, false, false, false, false); car.markAsNoLongerNeeded(); }
    else car.delete();
  } catch (e) { log(`[sa-coop] parked car: ${e}`); }
}

function walkRemote(r, s, now) {
  if (r.outside) { try { r.ped.detachFromCar(0, 0, 0, false); } catch (e) {} r.outside = null; }
  if (r.car && !releaseCar(r, s)) return;
  try { if (r.parked && (!Car.DoesExist(r.parked) || dist2(r.parked.getCoordinates(), s) > 150 * 150)) dropParked(r); } catch (e) {}
  leaveCar(r, s);
  if (!r.lastPos) { r.lastPos = { x: s.x, y: s.y }; r.lastT = now; r.speed = 0; r.ux = 0; r.uy = 0; }
  const mx = s.x - r.lastPos.x, my = s.y - r.lastPos.y, m = Math.sqrt(mx * mx + my * my);
  if (m > 0.0001 && now > r.lastT) {
    r.speed = m / ((now - r.lastT) / 1000); r.ux = mx / m; r.uy = my / m;
    r.lastPos = { x: s.x, y: s.y }; r.lastT = now;
  } else if (now - r.lastT > 300) {
    r.speed = 0;
  }
  const p = r.ped.getCoordinates();
  const d = Math.sqrt(dist2(p, s));
  if (d > 5) {
    r.ped.setCoordinatesNoOffset(s.x, s.y, s.z);
    r.ped.setHeading(s.heading);
  } else if (r.speed > 0.3 || d > 1) {
    if (now - r.lastTask > 250) {
      const moveState = r.speed > 6 ? 7 : r.speed > 2.5 ? 6 : 4; // sprint, run, walk
      Task.GoStraightToCoord(r.ped, s.x + r.ux * 1.5, s.y + r.uy * 1.5, s.z, moveState, 1000);
      r.lastTask = now;
    }
  } else {
    r.ped.setHeading(s.heading);
  }
}

function downRemote(r, s, slot, me) {
  if (r.car && !releaseCar(r, s)) return;
  leaveCar(r, s);
  if (!r.down) {
    r.down = true; r.hinted = false; r.downAt = Date.now(); r.holdStart = 0;
    r.ped.setCoordinatesNoOffset(s.x, s.y, s.z);
    try { Task.PlayAnim(r.ped, DOWN_ANIM[0], DOWN_ANIM[1], 4.0, false, false, false, true, -1); } catch (e) {}
    say("SA Co-op: your friend is down! Go over and hold E");
  }
  const left = (bleedOut() - (Date.now() - (r.downAt || Date.now()))) / 1000;
  banner("COOPDN2", left);
  if (!downed && !me.isInAnyCar() && dist2(me.getCoordinates(), r.ped.getCoordinates()) < 2.5 * 2.5) {
    if (Pad.IsKeyPressed(KEY.E)) {
      if (!r.holdStart) r.holdStart = Date.now();
      const pct = (Date.now() - r.holdStart) / REVIVE_HOLD * 100;
      banner("COOPDN3", Math.min(100, pct), 60);
      if (pct >= 100) { api.coop_revive(slot); r.holdStart = 0; }
    } else {
      r.holdStart = 0;
      banner("COOPDN3", 0, 60);
    }
  } else r.holdStart = 0;
}

// their gun in their copy's hands; shooting is shown as shots straight ahead (no hits sync yet)
function armRemote(r, s, now) {
  if (s.weapon !== r.weapon) {
    try {
      const model = s.weapon > 0 ? Weapon.GetModel(s.weapon) : 0;
      if (model > 0 && !loadModel(model)) return; // the gun appears once the game has loaded it
      r.weapon = s.weapon;
      if (s.weapon > 0) {
        r.ped.giveWeapon(s.weapon, 9999);
        if (model > 0) Streaming.MarkModelAsNoLongerNeeded(model);
      }
      r.ped.setCurrentWeapon(s.weapon);
    } catch (e) { r.weapon = s.weapon; log(`[sa-coop] weapon ${s.weapon}: ${e}`); }
  }
  if ((s.flags & 2) && s.inCar === 0 && s.weapon > 15 && now - (r.lastShot || 0) > 300) {
    const h = s.heading * Math.PI / 180;
    try { Task.ShootAtCoord(r.ped, s.x - Math.sin(h) * 25, s.y + Math.cos(h) * 25, s.z + 0.5, 350); } catch (e) {}
    r.lastShot = now;
  }
}

// notoriety is shared, but only changes travel: a friend gaining stars raises ours, a friend losing them lowers ours.
// Copying the level itself (11-15: "cannot escape the cops") had each side hand the stars back to the one who lost them.
function shareWanted(r, s) {
  const theirs = (s.flags >> 8) & 0xff, before = r.wanted || 0;
  r.wanted = theirs;
  if (theirs === before) return;
  try {
    const ours = player.storeWantedLevel();
    if (theirs > before ? theirs > ours : theirs < ours) player.alterWantedLevel(theirs);
  } catch (e) {}
}

// the lowest slot keeps time for everyone; a jump of more than 2 minutes is corrected
function followClock(minutes) {
  if (minutes < 0 || minutes >= 1440) return;
  const t = Clock.GetTimeOfDay(), ours = t.hours * 60 + t.minutes;
  let diff = Math.abs(ours - minutes); diff = Math.min(diff, 1440 - diff);
  if (diff > 2) Clock.SetTimeOfDay(Math.floor(minutes / 60), minutes % 60);
}

function syncRemotes(me, mySlot, now) {
  for (let slot = 0; slot < 4; slot++) {
    if (slot === mySlot) continue;
    if (!api.coop_get(slot, theirs)) {
      const r = remotes[slot];
      if (r && !r.lostAt) r.lostAt = now;
      if (r && now - r.lostAt > 5000) removeRemote(slot); // 5 s without them
      continue;
    }
    const s = readRemote();
    let r = remotes[slot];
    if (r && !Char.DoesExist(r.ped)) { remotes[slot] = null; r = null; }
    if (r && r.look !== ((s.flags >> 16) & 0xff)) { removeRemote(slot); r = null; } // they changed their look
    if (!r) r = remotes[slot] = spawnPed(slot, s);
    if (!r) continue;
    r.lostAt = 0;
    try {
      if (r.area !== s.interior) { r.area = s.interior; r.ped.setAreaVisible(s.interior); if (r.car) r.car.setAreaVisible(s.interior); }
      if (slot < mySlot || mySlot < 0) followClock(s.clock);
      shareWanted(r, s);
      if (s.health >= 0) armRemote(r, s, now);
      if (s.health < 0) { downRemote(r, s, slot, me); continue; }
      if (r.down) { r.down = false; try { r.ped.clearTasksImmediately(); } catch (e) {} }
      if (s.inCar === 1) driveRemote(r, s, now);
      else if (s.inCar === 2) rideRemote(r, s, mySlot, me);
      else walkRemote(r, s, now);
    } catch (e) {
      log(`[sa-coop] sync ${slot}: ${e}`);
    }
  }
}

// ---- riding along: a free seat, else on the trunk / on the back of the bike ---------------------------------
// Mission cars are often full (CJ + Sweet in a two-seater) or bikes: the second player then rides outside,
// attached to the car, and can shoot. Nobody is ever pulled out of a seat for it.
const SEAT_OUTSIDE = 100; // sent as the "seat" while attached outside

function isBike(car) {
  try { return Streaming.IsThisModelABike(car.getModel()) || Streaming.IsThisModelABoat(car.getModel()); } catch (e) { return false; }
}

// a free passenger seat, back seats first; -1 when there is none
function freeSeat(car) {
  try {
    const n = car.getMaximumNumberOfPassengers();
    for (const seat of [1, 2, 0]) if (seat < n && car.isPassengerSeatFree(seat)) return seat;
  } catch (e) {}
  return -1;
}

// hold `ped` on the outside of `car`: behind the rider on a bike (facing forward), on the trunk of a car (facing back)
function attachOutside(ped, car) {
  let weapon = 0;
  try { weapon = ped.getCurrentWeapon(); } catch (e) {}
  if (isBike(car)) ped.attachToCar(car, 0, -0.55, 0.55, 0, 180, weapon);
  else ped.attachToCar(car, 0, -2.0, 0.65, 1, 180, weapon);
}

let ridingOutside = null; // { car, slot } while we sit on a friend's trunk or bike

function getOffOutside(me) {
  if (!ridingOutside) return;
  try { me.detachFromCar(0, 0, 0, false); } catch (e) {}
  try {
    if (Car.DoesExist(ridingOutside.car)) {
      const c = ridingOutside.car.getCoordinates();
      me.setCoordinates(c.x + 2.5, c.y + 1, c.z);
    }
  } catch (e) {}
  ridingOutside = null;
}

// G: ride with the nearest friend who drives: a free seat, else outside on the car
function tryRideAlong(me) {
  if (me.isInAnyCar() || downed || ridingOutside) return;
  const p = me.getCoordinates();
  let best = null, bestD = 7 * 7, bestSlot = -1;
  remotes.forEach((r, slot) => {
    if (!r || !r.car || !Car.DoesExist(r.car)) return;
    const d = dist2(p, r.car.getCoordinates());
    if (d < bestD) { best = r; bestD = d; bestSlot = slot; }
  });
  if (!best) return;
  // straight into the seat: the friend's car is moved every frame, which breaks the walk-in animation (CJ hung)
  const seat = isBike(best.car) ? -1 : freeSeat(best.car);
  try {
    if (seat >= 0 && !(isBike(best.car))) me.warpIntoCarAsPassenger(best.car, seat);
    else if (isBike(best.car) && freeSeat(best.car) === 0) me.warpIntoCarAsPassenger(best.car, 0);
    else { attachOutside(me, best.car); ridingOutside = { car: best.car, slot: bestSlot }; say("SA Co-op: riding outside. F to get off"); }
  } catch (e) { log(`[sa-coop] G: ${e}`); }
}

// ---- shared world: weather, cutscenes, missions (addresses for Steam build 1.0.113.49697469) ------------
const RVA = { cutName: 0x51AFC68, cutRunning: 0x572A430, onMission: 0x521C91C, scriptSpace: 0x51BEAE0,
              activeScripts: 0x5211718, newWeather: 0x5300FEC, forcedWeather: 0x5301008 };
const EV = { WEATHER: 1, CUTSCENE: 2, MISSION: 3 };
let lastWeatherSent = -1, lastWeatherAt = 0, cutWas = false, missionWas = "", playingCut = false;

function readStr(addr, n, ib) {
  let s = "";
  for (let i = 0; i < n; i++) { const c = Memory.ReadU8(addr + i, false, ib); if (!c) break; s += String.fromCharCode(c); }
  return s;
}
function ptr(addr, ib) { return Memory.ReadU32(addr, false, ib) + Memory.ReadU32(addr + 4, false, ib) * 0x100000000; }
function sendEvent(kind, text) {
  for (let i = 0; i < text.length && i < 120; i++) Memory.WriteU8(evBuf + i, text.charCodeAt(i) & 0x7f, false, false);
  Memory.WriteU8(evBuf + Math.min(text.length, 120), 0, false, false);
  api.coop_event_send(kind, evBuf);
}
function missionName() {
  try {
    const off = Memory.ReadU32(RVA.onMission, false, true);
    if (!off || Memory.ReadI32(RVA.scriptSpace + off, false, true) !== 1) return "";
    for (let sc = ptr(RVA.activeScripts, true), n = 0; sc && n < 200; sc = ptr(sc, false), n++)
      if (Memory.ReadU8(sc + 0x12C, false, false)) return readStr(sc + 0x10, 8, false);
  } catch (e) {}
  return "";
}

// what happens in our game, told to the others
function tellWorld(mySlot, now) {
  if (mySlot === 0 && now - lastWeatherAt > 3000) { // the first slot's weather for everyone
    lastWeatherAt = now;
    const w = Memory.ReadI16(RVA.newWeather, false, true);
    if (w !== lastWeatherSent && w >= 0 && w < 64) { lastWeatherSent = w; sendEvent(EV.WEATHER, String(w)); }
  }
  const running = Memory.ReadU8(RVA.cutRunning, false, true) === 1;
  if (running && !cutWas && !playingCut) {
    // with where it plays: the interior and the place, so the friend's game shows the room and not an empty sky
    let area = 0, p = { x: 0, y: 0, z: 0 };
    try { area = Streaming.GetAreaVisible(); p = player.getChar().getCoordinates(); } catch (e) {}
    try { const o = Cutscene.GetOffset(); if (o && (o.xOffset || o.yOffset)) p = { x: o.xOffset, y: o.yOffset, z: o.zOffset }; } catch (e) {}
    sendEvent(EV.CUTSCENE, `${readStr(RVA.cutName, 24, true)}|${area}|${Math.round(p.x)}|${Math.round(p.y)}|${Math.round(p.z)}`);
  }
  cutWas = running;
  const m = missionName();
  if (m !== missionWas) { missionWas = m; sendEvent(EV.MISSION, m); }
}

// a friend's cutscene: play the same one here (only when we are free: on foot, not on our own mission)
// text: name|interior|x|y|z. The game only draws the interior it is told to and only loads the map around the
// player: without both, the friend's cutscene played in an empty sky (11-15). Ours are put back afterwards.
function playCutscene(text, me) {
  const [name, a, x, y, z] = text.split("|");
  if (!/^[A-Za-z0-9_]{2,24}$/.test(name) || (ONMISSION && !isGuest()) || me.isInAnyCar() || downed) return;
  const area = Number(a), at = { x: Number(x), y: Number(y), z: Number(z) };
  const placed = area >= 0 && area <= 255 && [at.x, at.y, at.z].every(Number.isFinite) && Math.abs(at.x) < 6000 && Math.abs(at.y) < 6000;
  playingCut = true;
  let myArea = 0, changed = false;
  try {
    if (placed) {
      myArea = Streaming.GetAreaVisible();
      Streaming.SetAreaVisible(area);
      Streaming.RequestCollision(at.x, at.y);
      Streaming.LoadScene(at.x, at.y, at.z);
      changed = true;
    }
    try { Text.ClearHelp(); } catch (e) {}
    Cutscene.Load(name);
    for (let i = 0; i < 400 && !Cutscene.HasLoaded(); i++) wait(25);
    if (Cutscene.HasLoaded()) {
      Cutscene.Start();
      // the map around where the cutscene's camera really is (the sender's player may stand somewhere else)
      wait(100);
      try {
        const c = Camera.GetActiveCoordinates();
        if (!Cutscene.HasFinished() && Math.abs(c.x) < 6000 && Math.abs(c.y) < 6000) { Streaming.RequestCollision(c.x, c.y); Streaming.LoadScene(c.x, c.y, c.z); }
      } catch (e) { log(`[sa-coop] cutscene ${name}, scene: ${e}`); }
      while (!Cutscene.HasFinished()) wait(0);
    }
    Cutscene.Clear();
  } catch (e) { log(`[sa-coop] cutscene ${name}: ${e}`); }
  if (changed) {
    try {
      Streaming.SetAreaVisible(myArea);
      const p = me.getCoordinates();
      Streaming.RequestCollision(p.x, p.y);
      Streaming.LoadScene(p.x, p.y, p.z);
    } catch (e) { log(`[sa-coop] cutscene ${name}, back: ${e}`); }
  }
  playingCut = false;
}

// ---- shared skills: what either of you has learned, both have -------------------------------------------------
// Missions ask for skills (driving, flying, lung capacity) and each game checks its own player. Every 10 s each side
// sends its skills; a higher one from a friend is taken over, none is ever lowered. Looks (fat, muscle) stay yours.
const EV_STATS = 10;
const SKILL_F = [22, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79]; // stamina, weapon skills (pistol ... rifle)
const SKILL_I = [160, 169, 225, 229, 230];                        // driving, flying, lung capacity, bike, cycling
let statsAt = 0, statsSent = "", statsSentAt = 0, statsErr = false;
function statsTick(now) {
  if (now - statsAt < 10000) return;
  statsAt = now;
  try {
    const text = SKILL_F.map((id) => Math.round(Stat.GetFloat(id))).concat(SKILL_I.map((id) => Stat.GetInt(id))).join(",");
    // again every minute even when nothing changed: a friend may have joined since
    if (text !== statsSent || now - statsSentAt > 60000) { statsSent = text; statsSentAt = now; sendEvent(EV_STATS, text); }
  } catch (e) { if (!statsErr) { statsErr = true; log(`[sa-coop] skills: ${e}`); } }
}
function onStats(text) {
  const v = text.split(",").map(Number);
  if (v.length !== SKILL_F.length + SKILL_I.length || v.some((x) => !Number.isFinite(x) || x < 0 || x > 10000)) return;
  const raised = [];
  try {
    SKILL_F.forEach((id, i) => { if (v[i] > Stat.GetFloat(id) + 0.5) { Stat.SetFloat(id, v[i]); raised.push(id); } });
    SKILL_I.forEach((id, i) => { const t = Math.round(v[SKILL_F.length + i]); if (t > Stat.GetInt(id)) { Stat.SetInt(id, t); raised.push(id); } });
  } catch (e) { log(`[sa-coop] skills from a friend: ${e}`); }
  if (raised.length) log(`[sa-coop] skills raised to your friend's: ${raised.join(", ")}`);
}

// ---- which key does what, shown while it applies -----------------------------------------------------------------
try {
  FxtStore.insert("COOPHG", "G - get in your friend's car");
  FxtStore.insert("COOPHF", "F - get out");
} catch (e) {}
function keyHints(me) {
  if (downed) return;
  let key = "";
  try {
    if (ridingOutside) key = "COOPHF";
    else if (me.isInAnyCar()) { if (remoteWithCar(me.storeCarIsInNoSave()) >= 0) key = "COOPHF"; }
    else {
      const p = me.getCoordinates();
      for (const r of remotes) {
        if (r && r.car && !r.down && Car.DoesExist(r.car) && dist2(p, r.car.getCoordinates()) < 7 * 7) { key = "COOPHG"; break; }
      }
    }
    if (!key) return;
    Text.UseCommands(true); Text.SetFont(1); Text.SetScale(0.4, 1.6); Text.SetCenter(true);
    Text.SetColor(255, 255, 255, 255); Text.SetDropshadow(1, 0, 0, 0, 255);
    Text.Display(320, 395, key);
  } catch (e) {}
}

function hearWorld(me) {
  let kind;
  while ((kind = api.coop_event_poll(evBuf)) > 0) {
    const text = readStr(evBuf, 127, false);
    if (kind === EV.WEATHER) { const w = parseInt(text, 10); if (w >= 0 && w < 64) try { Weather.ForceNow(w); } catch (e) {} }
    else if (kind === EV.CUTSCENE) playCutscene(text, me);
    else if (kind === 4 || kind === 5) onMissionEvent(kind, text);
    else if (kind === EVS_SET && !api.coop_is_host()) {
      const m = /ff=(\d);rev=(\d+)/.exec(text);
      if (m) { const ff = m[1] === "1", rev = Math.min(120, Math.max(10, parseInt(m[2], 10))); if (ff !== sess.ff) say(`SA Co-op: friendly fire ${ff ? "on" : "off"}`); sess.ff = ff; sess.revive = rev; }
    } else if (kind === EV_PHIT) onFriendlyHit(me, text);
    else if (kind === EV_STATS) onStats(text);
    else if (kind === 6 || kind === 7) onStoryEvent(kind, text);
    else if (kind === EV.MISSION && (friendMission = text, true)) say(text ? `SA Co-op: your friend started a mission (${text})` : "SA Co-op: your friend's mission ended");
  }
}

// ---- missions together: the owner's mission peds and cars appear in the partner's game -----------------------
// Owner (on a mission): reads the mission cleanup list and sends position, model, health, dead of each entity.
// Partner: keeps a copy of each (red blip for peds), passes its damage back to the owner (EV_HIT), and gets the
// money the owner earned when the mission ends (EV_MONEY). Addresses: Steam build 1.0.113.49697469.
const MRVA = { cleanup: 0x53DB410, money: 0x53EB808 };
const ENT_SIZE = 28, MAX_ENTS = 40;
const entBuf = Memory.Allocate(ENT_SIZE * MAX_ENTS);
const EVM = { HIT: 4, MONEY: 5 };
let missionMoneyAt = null, lastEntsAt = 0, passedAt = "";
const proxies = new Map(); // owner handle -> { kind, ent, model, blip, setHp, seen }

function ownMissionEntities() {
  const out = [];
  for (let i = 0; i < 75 && out.length < MAX_ENTS; i++) {
    const at = MRVA.cleanup + i * 8;
    const kind = Memory.ReadU8(at, false, true);
    if (kind !== 1 && kind !== 2) continue;
    const h = Memory.ReadI32(at + 4, false, true);
    try {
      if (kind === 2) {
        if (!Char.DoesExist(h)) continue;
        const c = new Char(h), p = c.getCoordinates(), hp = c.getHealth();
        out.push({ h, kind, dead: hp <= 0 ? 1 : 0, model: c.getModel(), x: p.x, y: p.y, z: p.z, heading: c.getHeading(), hp });
      } else {
        if (!Car.DoesExist(h)) continue;
        const c = new Car(h), p = c.getCoordinates(), hp = c.getHealth();
        out.push({ h, kind, dead: hp <= 0 ? 1 : 0, model: c.getModel(), x: p.x, y: p.y, z: p.z, heading: c.getHeading(), hp });
      }
    } catch (e) {}
  }
  return out;
}

function sendMissionEntities() {
  const list = ownMissionEntities();
  list.forEach((e, i) => {
    const b = entBuf + i * ENT_SIZE;
    Memory.WriteI32(b, e.h, false, false);
    Memory.WriteU8(b + 4, e.kind, false, false);
    Memory.WriteU8(b + 5, e.dead, false, false);
    Memory.WriteU8(b + 6, e.model & 0xff, false, false);
    Memory.WriteU8(b + 7, (e.model >> 8) & 0xff, false, false);
    Memory.WriteFloat(b + 8, e.x, false, false);
    Memory.WriteFloat(b + 12, e.y, false, false);
    Memory.WriteFloat(b + 16, e.z, false, false);
    Memory.WriteFloat(b + 20, e.heading, false, false);
    Memory.WriteFloat(b + 24, e.hp, false, false);
  });
  api.coop_ents_send(entBuf, list.length);
}

function dropProxy(h) {
  const p = proxies.get(h);
  if (!p) return;
  try { if (p.blip) p.blip.remove(); } catch (e) {}
  untrack(p.ent);
  try { if (p.kind === 2 && Char.DoesExist(p.ent)) p.ent.delete(); if (p.kind === 1 && Car.DoesExist(p.ent)) p.ent.delete(); } catch (e) {}
  proxies.delete(h);
}

function mirrorMissionEntities(now) {
  const n = api.coop_ents_get(entBuf);
  if (n < 0) { for (const h of [...proxies.keys()]) dropProxy(h); return; }
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    const b = entBuf + i * ENT_SIZE;
    const h = Memory.ReadI32(b, false, false), kind = Memory.ReadU8(b + 4, false, false), dead = Memory.ReadU8(b + 5, false, false);
    const model = Memory.ReadU8(b + 6, false, false) | (Memory.ReadU8(b + 7, false, false) << 8);
    const x = Memory.ReadFloat(b + 8, false, false), y = Memory.ReadFloat(b + 12, false, false), z = Memory.ReadFloat(b + 16, false, false);
    const heading = Memory.ReadFloat(b + 20, false, false), hp = Memory.ReadFloat(b + 24, false, false);
    seen.add(h);
    let p = proxies.get(h);
    try {
      if (!p) {
        if (dead || !(kind === 2 ? model > 0 && model < 312 : model >= 400 && model <= 611)) continue;
        const use = kind === 2 ? model : safeCarModel(model);
        if (!loadModel(use)) continue;
        const ent = track(kind === 2 ? Char.Create(18, use, x, y, z) : Car.Create(use, x, y, z), kind, use);
        Streaming.MarkModelAsNoLongerNeeded(use);
        let blip = null;
        if (kind === 2) {
          blip = Blip.AddForChar(ent);
          try { blip.changeColor(0); } catch (e) {} // red: a mission enemy or target
          try { ent.setRelationship(4, 0); } catch (e) {} // hates player 1
        }
        p = { kind, ent, model, blip, setHp: hp };
        proxies.set(h, p);
      }
      if (dead) {
        if (p.kind === 2 && p.ent.getHealth() > 0) p.ent.setHealth(0);
        if (p.blip) { try { p.blip.remove(); } catch (e) {} p.blip = null; }
        continue;
      }
      // damage done here goes to the owner, whose game decides
      const local = p.ent.getHealth();
      if (local < p.setHp - 3) sendEvent(EVM.HIT, `${h}:${Math.round(p.setHp - local)}`);
      if (Math.abs(local - hp) > 1) p.ent.setHealth(Math.max(1, Math.round(hp)));
      p.setHp = hp;
      const c = p.ent.getCoordinates();
      const d2 = (c.x - x) ** 2 + (c.y - y) ** 2 + (c.z - z) ** 2;
      if (d2 > 9 || kind === 1) {
        if (kind === 1 && d2 < 2) continue;
        p.ent.setCoordinatesNoOffset(x, y, z);
        p.ent.setHeading(heading);
      } else if (d2 > 1) {
        Task.GoStraightToCoord(p.ent, x, y, z, 6, 1000);
      }
    } catch (e) { log(`[sa-coop] mission entity ${h}: ${e}`); }
  }
  for (const h of [...proxies.keys()]) if (!seen.has(h)) dropProxy(h);
}

function missionsTick(now) {
  if (now - lastEntsAt < 200) return;
  lastEntsAt = now;
  storyTick(now);
  if (ONMISSION && !isGuest()) {
    if (missionMoneyAt === null) { missionMoneyAt = Memory.ReadI32(MRVA.money, false, true); passedAt = readStr(0x523A158, 8, true); }
    sendMissionEntities();
    for (const h of [...proxies.keys()]) dropProxy(h); // our own mission: no copies of a friend's
  } else {
    if (missionMoneyAt !== null) {
      const earned = Memory.ReadI32(MRVA.money, false, true) - missionMoneyAt;
      const passed = readStr(0x523A158, 8, true) !== passedAt; // a failed mission pays nothing
      if (earned > 0 && passed) sendEvent(EVM.MONEY, String(earned));
      missionMoneyAt = null;
    }
    mirrorMissionEntities(now);
  }
}

function onMissionEvent(kind, text) {
  if (kind === EVM.HIT) {
    const [h, dmg] = text.split(":").map((v) => parseInt(v, 10));
    try { if (ONMISSION && Char.DoesExist(h)) { const c = new Char(h); c.setHealth(Math.max(0, c.getHealth() - dmg)); } } catch (e) {}
  } else if (kind === EVM.MONEY) {
    const earned = parseInt(text, 10);
    if (earned > 0 && earned < 10000000) {
      Memory.WriteI32(MRVA.money, Memory.ReadI32(MRVA.money, false, true) + earned, false, true);
      say(`SA Co-op: mission passed, you got $${earned}`);
    }
  }
}

// host: our menu choices are the session's; send them now and then (late joiners get them within 3 s)
function settingsTick(now) {
  if (!api.coop_is_host()) return;
  sess.ff = api.coop_setting(0) === 1;
  const rev = api.coop_setting(1);
  if (rev >= 10) sess.revive = rev;
  if (now - lastSettingsAt > 3000) { lastSettingsAt = now; sendEvent(EVS_SET, `ff=${sess.ff ? 1 : 0};rev=${sess.revive}`); }
}

// Friendly fire: off, your friend's copy here takes no damage. On, it takes bullets and punches from you only; the
// damage goes to your friend's game (EV_PHIT), the copy is topped up again. Your friend goes down as usual.
const COPY_HP = 1000;
function friendlyFireTick(me) {
  remotes.forEach((r, slot) => {
    if (!r || !Char.DoesExist(r.ped)) return;
    try {
      if (r.ff !== sess.ff) {
        r.ff = sess.ff;
        if (sess.ff) { r.ped.setProofs(false, true, true, true, false); r.ped.setHealth(COPY_HP); }
        else r.ped.setProofs(true, true, true, true, true);
      }
      if (!sess.ff || r.down) return;
      const hp = r.ped.getHealth();
      if (hp < COPY_HP - 1) {
        if (r.ped.hasBeenDamagedByChar(me)) sendEvent(EV_PHIT, `${slot}:${Math.round(COPY_HP - hp)}`);
        r.ped.clearLastDamageEntity();
        r.ped.setHealth(COPY_HP);
      }
    } catch (e) {}
  });
}

function onFriendlyHit(me, text) {
  const [slot, dmg] = text.split(":").map((v) => parseInt(v, 10));
  if (slot !== api.coop_slot() || downed || !(dmg > 0)) return;
  try { me.setHealth(Math.max(1, me.getHealth() - Math.min(dmg, 200))); } catch (e) {} // 1, not 0: you go down, not die
}

// ---- catching up: J jumps to your friend (into a free seat, onto the trunk, or next to them) -------------------
// A mission runs in one game; the other player left far behind is no help and can strand the story. During a
// mission, more than 200 m away for 8 s, a banner offers J. J works any time.
let friendMission = "", farSince = 0;
const KEY_J = 74, FAR = 200;
try { FxtStore.insert("COOPFAR", "Your homie is far away. Press J to jump to them"); } catch (e) {}

function nearestFriend(me) {
  const p = me.getCoordinates();
  let best = null, bestD = Infinity, slot = -1;
  remotes.forEach((r, i) => {
    if (!r || !Char.DoesExist(r.ped)) return;
    const d = dist2(p, r.ped.getCoordinates());
    if (d < bestD) { best = r; bestD = d; slot = i; }
  });
  return best ? { r: best, slot, d: Math.sqrt(bestD) } : null;
}

function jumpToFriend(me) {
  const f = nearestFriend(me);
  if (!f || downed) return;
  const r = f.r;
  try {
    if (ridingOutside) getOffOutside(me);
    if (me.isInAnyCar()) { const c = me.getCoordinates(); me.warpFromCarToCoord(c.x, c.y, c.z); }
    const area = r.area || 0;
    Streaming.SetAreaVisible(area);
    me.setAreaVisible(area);
    if (r.car && Car.DoesExist(r.car)) {
      const seat = isBike(r.car) ? (freeSeat(r.car) === 0 ? 0 : -1) : freeSeat(r.car);
      if (seat >= 0) me.warpIntoCarAsPassenger(r.car, seat);
      else { attachOutside(me, r.car); ridingOutside = { car: r.car, slot: f.slot }; }
    } else {
      const c = r.ped.getCoordinates();
      Streaming.RequestCollision(c.x, c.y);
      Streaming.LoadScene(c.x, c.y, c.z);
      me.setCoordinates(c.x + 1.5, c.y + 1, c.z);
    }
    farSince = 0;
    say("SA Co-op: you jumped to your friend");
  } catch (e) { log(`[sa-coop] J: ${e}`); }
}

function catchUpTick(me, now) {
  if (pressed(KEY_J)) { jumpToFriend(me); return; }
  const mission = ONMISSION || friendMission;
  const f = mission ? nearestFriend(me) : null;
  if (!f || f.d < FAR || downed) { farSince = 0; return; }
  if (!farSince) farSince = now;
  if (now - farSince > 8000) {
    try {
      Text.UseCommands(true); Text.SetFont(1); Text.SetScale(0.45, 1.8); Text.SetCenter(true);
      Text.SetColor(255, 200, 80, 255); Text.SetDropshadow(2, 0, 0, 0, 255);
      Text.Display(320, 30, "COOPFAR");
    } catch (e) {}
  }
}

// ---- one story for both (Saints Row 2 style): the host plays the story, the guest joins it -------------------
// Guest: its own missions are switched off ($ONMISSION held at 1, so no mission markers or triggers), and it sees
// the host's mission text and destination blips. Host: sends them. Addresses: Steam build 1.0.113.49697469.
const SRVA = { scriptSpace: 0x51BEAE0, onMission: 0x521C91C, brief: 0x531CB70, radar: 0x542A7B0 };
const EVS = { TEXT: 6, BLIPS: 7 };
let lastBriefKey = "", lastBlipsSent = "", lastBlipsAt = 0, guestLocked = false;
let guestBlips = [];

function isGuest() { return api.coop_status() === 2 && !api.coop_is_host(); }

function onMissionAddr() {
  const off = Memory.ReadU32(SRVA.onMission, false, true);
  return off ? SRVA.scriptSpace + off : 0;
}

// the guest's own story stays still while it plays the host's
function lockGuestStory() {
  // The guest's own missions are refused in the DLL (CanPlayerStartMission). Release a lock left by older builds.
  const a = onMissionAddr();
  if (a && guestLocked) { guestLocked = false; Memory.WriteI32(a, 0, false, true); }
  if (!isGuest() && guestBlips.length) { for (const b of guestBlips) { try { b.remove(); } catch (e) {} } guestBlips = []; }
  return;
  // inside a building (a safehouse with its save disk) the lock is off, so the guest can save its own game
  let inside = false;
  try { inside = player.getChar().getAreaVisible() !== 0; } catch (e) {}
  if (isGuest() && !inside) {
    if (Memory.ReadI32(a, false, true) !== 1) Memory.WriteI32(a, 1, false, true);
    if (!guestLocked) { guestLocked = true; say("SA Co-op: you play your friend's story. You can save in your own safehouses"); }
  } else if (guestLocked) {
    guestLocked = false;
    Memory.WriteI32(a, 0, false, true);
    if (!isGuest()) {
      for (const b of guestBlips) { try { b.remove(); } catch (e) {} }
      guestBlips = [];
    }
  }
}

function storyTick(now) {
  lockGuestStory();
  if (isGuest() || !ONMISSION) return;
  // host: the mission text on screen (its GXT key, so the guest prints it in its own language)
  if (Memory.ReadU32(SRVA.brief + 8, false, true) || Memory.ReadU32(SRVA.brief + 12, false, true)) {
    const key = readStr(SRVA.brief, 7, true);
    if (key && key !== lastBriefKey) {
      lastBriefKey = key;
      sendEvent(EVS.TEXT, `${key}:${Memory.ReadU32(SRVA.brief + 0x14, false, true)}`);
    }
  } else {
    lastBriefKey = "";
  }
  // host: destination blips (type 4 = coord) every second when they change
  if (now - lastBlipsAt < 1000) return;
  lastBlipsAt = now;
  const parts = [];
  for (let i = 0; i < 250 && parts.length < 4; i++) {
    const e = SRVA.radar + i * 0x30;
    if (!(Memory.ReadU8(e + 0x29, false, true) & 2)) continue;
    const f = Memory.ReadU8(e + 0x2A, false, true);
    if (((f >> 2) & 15) !== 4 || !(f & 3)) continue;
    const x = Memory.ReadFloat(e + 8, false, true), y = Memory.ReadFloat(e + 12, false, true), z = Memory.ReadFloat(e + 16, false, true);
    parts.push(`${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)},${Memory.ReadU32(e, false, true) & 0xff}`);
  }
  const msg = parts.join(";");
  if (msg !== lastBlipsSent) { lastBlipsSent = msg; sendEvent(EVS.BLIPS, msg || "-"); }
}

function onStoryEvent(kind, text) {
  if (!isGuest()) return;
  if (kind === EVS.TEXT) {
    const [key, ms] = text.split(":");
    if (/^[A-Z0-9_]{1,7}$/i.test(key)) { try { Text.PrintNow(key, Math.min(parseInt(ms, 10) || 4000, 15000), 1); } catch (e) {} }
  } else if (kind === EVS.BLIPS) {
    for (const b of guestBlips) { try { b.remove(); } catch (e) {} }
    guestBlips = [];
    if (text === "-") return;
    for (const p of text.split(";")) {
      const [x, y, z, col] = p.split(",").map(Number);
      if (![x, y, z].every(Number.isFinite)) continue;
      try { const b = Blip.AddForCoord(x, y, z); if (col <= 8) b.changeColor(col); guestBlips.push(b); } catch (e) {}
    }
  }
}

function tellPartner(me) {
  let handle = -1, near = 0;
  for (const r of remotes) {
    if (!r || !Char.DoesExist(r.ped)) continue;
    handle = +r.ped;
    try {
      const a = me.getCoordinates(), b = r.ped.getCoordinates();
      const same = me.getAreaVisible() === (r.area || 0);
      near = same && (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 < 36 ? 1 : 0;
    } catch (e) {}
    break;
  }
  api.coop_set_partner(handle, near);
}

// ---- main loop ------------------------------------------------------------------------------------------
log("[sa-coop] loaded");
let started = false, announced = -1, lastCode = "", lastCodeCheck = 0;

while (true) {
  wait(0);
  if (!player.isPlaying()) continue;
  const now = Date.now();

  if (!started) {
    started = true;
    // a launcher session (IP mode) if there is one; otherwise the F9 window decides
    if (!api.coop_start() && api.coop_status() !== 2) say("SA Co-op: F9 - co-op window (name and password)");
  }
  if (now - lastCodeCheck > 1000) {
    lastCodeCheck = now;
    const code = readCode();
    if (code && code !== lastCode) { lastCode = code; say(`SA Co-op code (copied): ${code}`); }
  }

  const status = api.coop_status();
  if (status !== announced) {
    announced = status;
    if (status === 2) say("SA Co-op: connected");
    if (status === 3) say("SA Co-op: server refused (wrong code or no free slots)");
  }
  if (status !== 2) continue;

  const me = player.getChar();
  handleOwnHealth(me, now);
  writeMine(me);
  syncRemotes(me, api.coop_slot(), now);
  settingsTick(now);
  friendlyFireTick(me);
  tellPartner(me);
  drawNames();
  const slotNow = api.coop_slot();
  tellWorld(slotNow, now);
  hearWorld(me);
  statsTick(now);
  keyHints(me);
  missionsTick(now);
  if (pressed(KEY.G)) tryRideAlong(me);
  catchUpTick(me, now);
  // F in a friend's car: straight out beside it (the car is moved every frame, which breaks the exit animation)
  if (pressed(70) && ridingOutside) getOffOutside(me);
  else if (pressed(70) && me.isInAnyCar()) {
    try {
      const car = me.storeCarIsInNoSave();
      if (remoteWithCar(car) >= 0) { const c = car.getCoordinates(); me.warpFromCarToCoord(c.x + 2.5, c.y + 1, c.z); }
    } catch (e) {}
  }
}
