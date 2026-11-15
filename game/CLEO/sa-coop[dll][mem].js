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
                      "coop_send", "coop_get", "coop_revive", "coop_take_revived", "coop_name", "coop_event_send", "coop_event_poll", "coop_ents_send", "coop_ents_get", "coop_is_host", "coop_my_skin", "coop_set_partner", "coop_track", "coop_untrack", "coop_take_tracked", "coop_setting", "coop_world_send", "coop_world_get", "coop_tracked", "coop_take_refused", "coop_native", "coop_native_done", "coop_claim", "coop_release", "coop_flag", "coop_latest"]) {
    api[name] = Memory.Fn.X64(lib.getProcedure(name));
  }
} catch (e) {
  err(`[sa-coop] setup failed: ${e}`);
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

// ---- this script's turn counts as the game thread ---------------------------------------------------------------
// See coopnet/src/scripthook.rs: CLEO runs us on a thread of our own while the game thread waits, and the game
// refuses to build anything "on a non-game thread". For our turn we are the game thread; before every wait the real
// one is put back. Behind a marker: if the game dies in the first 20 s of the first claim, the next run goes without.
// marker files kept by coopnet64.asi (a script may not write files without [fs] in its name: the ini markers of
// 0.8.11 to 0.8.21 never worked, the log shows CLEO refusing them)
const flagBuf = Memory.Allocate(32);
function flag(op, name) {
  try {
    for (let i = 0; i < name.length && i < 24; i++) Memory.WriteU8(flagBuf + i, name.charCodeAt(i) & 0x7f, false, false);
    Memory.WriteU8(flagBuf + Math.min(name.length, 24), 0, false, false);
    return api.coop_flag(op, flagBuf);
  } catch (e) { return 0; }
}
let claimOff = false, claimWanted = false, claimFrom = 0, claimSafe = false;
try { claimOff = flag(0, "claim") === 1; if (claimOff) log("[sa-coop] game thread claim: the game died right after one last time, off"); } catch (e) {}
function pause(ms) {
  try { api.coop_release(); } catch (e) {}
  wait(ms);
  if (!claimWanted || claimOff) return;
  try {
    if (api.coop_claim() === 1 && !claimFrom) {
      claimFrom = Date.now();
      try { flag(1, "claim"); } catch (e) {}
      log("[sa-coop] game thread claim: on");
    }
    if (claimFrom && !claimSafe && Date.now() - claimFrom > 20000) {
      claimSafe = true;
      try { flag(2, "claim"); } catch (e) {}
    }
  } catch (e) {}
}

const player = new Player(0);
const remotes = [null, null, null, null];
let downed = false, downedAt = 0, downWeapon = 0;

// ---- small helpers ------------------------------------------------------------------------------------
function say(text) { if (!text) return; try { showTextBox(text); } catch (e) {} log(`[sa-coop] ${text}`); }

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
    try { FxtStore.insert(`COOPN${slot}`, name); } catch (e) { err(`[sa-coop] name key: ${e}`); }
  }
  return `COOPN${slot}`;
}

// world point -> the 640 x 448 screen the game's text uses; null when behind the camera or far away.
// From the camera's place, where it looks and its field of view. The game's own CSprite::CalcScreenCoors (used from
// 11-08) showed no name at all in the first two-player test (11-15), so this is the projection that was seen working,
// with the widescreen maths put right: the game's FOV is the horizontal one of a 4:3 picture and a wider screen
// shows more at the sides (the first version treated it as the 16:9 one, so names slid away from the middle).
function toScreen(p) {
  const cam = Camera.GetActiveCoordinates(), at = Camera.GetActivePointAt();
  let fx = at.x - cam.x, fy = at.y - cam.y, fz = at.z - cam.z;
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  let rx = fy, ry = -fx; const rl = Math.sqrt(rx * rx + ry * ry) || 1; rx /= rl; ry /= rl; // right = forward x up
  const ux = ry * fz, uy = -rx * fz, uz = rx * fy - ry * fx;                                 // up = right x forward
  const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
  const depth = dx * fx + dy * fy + dz * fz;
  if (depth < 1 || depth > 80) return null;
  // Two test rounds settled it (11-08: right over a car, off over a ped; 11-15: right height, off to the side):
  // the picture is as tall as a 4:3 one with this FOV and wider at the sides, and the text's 640 units across are
  // the 4:3 middle of the screen, its 448 down the full height. So across uses the FOV as it is, down uses 3/4 of it.
  const tanX = Math.tan((Camera.GetFov() * Math.PI / 180) / 2), tanY = tanX * 0.75;
  const sx = 320 + ((dx * rx + dy * ry) / depth / tanX) * 320;
  const sy = 224 - ((dx * ux + dy * uy + dz * uz) / depth / tanY) * 224;
  // a wide screen shows more than the 640 units: up to a third beyond each side
  return sx < -110 || sx > 750 || sy < 0 || sy > 448 ? null : { x: sx, y: sy - 8 }; // text is drawn from its top
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
      if (!r.drawErr) { r.drawErr = true; err(`[sa-coop] draw name: ${e}`); }
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

let lastMyCar = null;
function remoteWithCar(car) {
  // also the car a friend has just got out of: a passenger stays in it and still rides "with" that friend
  for (let i = 0; i < 4; i++) {
    const r = remotes[i];
    if (r && ((r.car && +r.car === +car) || (r.parked && +r.parked === +car))) return i;
  }
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
      lastMyCar = car; // a friend may stay in it as a passenger after we get out
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

// ---- a friend at the wheel of a mission car ------------------------------------------------------------------------
// The guest sees a copy of the host's mission car and may drive it. In the host's game that used to make a second
// car for the guest, and the mission never saw anybody in ITS car. Now the guest says which mission car it drives
// (EV_DRIVE: its slot and the host's handle of that car), and the host puts the guest's copy at the wheel of the
// real car and lets the guest's driving move it. Such a car is "borrowed": never deleted, parked or repainted by us.
const EV_DRIVE = 23;
let drivingProxy = 0, driveSentAt = 0;
function driveProxyTick(me, now) {
  let h = 0;
  try {
    if (me.isInAnyCar()) {
      const car = me.storeCarIsInNoSave(), d = car.getDriver();
      if (d && +d === +me) for (const [owner, pr] of proxies) { if (pr.kind === 1 && +pr.ent === +car) { h = owner; break; } }
    }
  } catch (e) {}
  if (h !== drivingProxy || (h && now - driveSentAt > 2000)) {
    drivingProxy = h; driveSentAt = now;
    sendEvent(EV_DRIVE, `${api.coop_slot()}:${h}`);
  }
}
function onDrive(text) {
  const [slot, h] = text.split(":").map((v) => parseInt(v, 10));
  const r = remotes[slot];
  if (!r || !Number.isFinite(h)) return;
  // only a car of our own running mission
  r.missionCar = h > 0 && missionHandles().has(h) ? h : 0;
}
function borrowedCar(r) {
  try { return r.missionCar && Car.DoesExist(r.missionCar) ? new Car(r.missionCar) : null; } catch (e) { return null; }
}

function dropCar(r) {
  if (!r.car) return;
  if (r.borrowed) { // the host's own mission car: the copy of the friend gets out, the car stays as it is
    try { if (r.ped.isInAnyCar()) { const c = r.car.getCoordinates(); r.ped.warpFromCarToCoord(c.x + 2, c.y, c.z); } } catch (e) {}
    r.car = null; r.carModel = 0; r.rx = null; r.borrowed = false;
    return;
  }
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
  const real = borrowedCar(r);
  if (real && !(r.borrowed && +r.car === +real)) {
    // into the real mission car, if its wheel is free (we may be driving it ourselves)
    let free = true;
    try { const d = real.getDriver(); free = !d || +d <= 0 || +d === +r.ped; } catch (e) {}
    if (free) {
      dropCar(r);
      r.car = real; r.borrowed = true; r.carModel = s.carModel; r.rx = null;
      leaveCar(r, s);
      try { r.ped.warpIntoCar(r.car); } catch (e) { err(`[sa-coop] mission car: ${e}`); }
      log(`[sa-coop] friend drives our mission car ${+real}`);
    } else return; // somebody of ours is at its wheel: no second car on top of it
  } else if (!real && r.borrowed) dropCar(r);
  if (!r.borrowed && (!r.car || r.carModel !== s.carModel || !Car.DoesExist(r.car))) {
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
      try { r.car.changeColor((s.flags >>> 24) & 0xff, (s.carHealth >>> 16) & 0xff); } catch (e) { err(`[sa-coop] colour: ${e}`); }
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
    else { try { if (lastMyCar && Car.DoesExist(lastMyCar)) car = lastMyCar; } catch (e) {} } // we got out, they stayed
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
  } catch (e) { err(`[sa-coop] passenger: ${e}`); }
}

// Out of a car: first the copy gets out, only on a later frame the car is let go (parked, the game clears it later).
// Deleting it in the same frame took the copy along (11-15, VC test: the friend vanished every time he left a car).
function releaseCar(r, s) {
  try {
    if (r.ped.isInAnyCar()) { r.ped.warpFromCarToCoord(s.x, s.y, s.z); return false; }
  } catch (e) {}
  if (r.borrowed) { r.car = null; r.carModel = 0; r.rx = null; r.borrowed = false; return true; }
  dropParked(r);
  try {
    if (Car.DoesExist(r.car)) {
      // a passenger stays in (11-15: "when my friend gets out I am thrown out too"): the parked car still counts
      // as that friend's, see remoteWithCar
      r.car.setMission(0); r.parked = r.car; r.parkedModel = r.carModel;
      log(`[sa-coop] friend left the car: ${+r.car} stays parked`);
    } else log("[sa-coop] friend left the car: the copy was already gone");
  } catch (e) { err(`[sa-coop] release car: ${e}`); }
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
  } catch (e) { err(`[sa-coop] parked car: ${e}`); }
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
    } catch (e) { r.weapon = s.weapon; err(`[sa-coop] weapon ${s.weapon}: ${e}`); }
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
      // the door a friend went in by: where they last stood outside (see followTick)
      if (s.interior === 0) { r.lastOut = { x: s.x, y: s.y, z: s.z }; r.door = null; }
      else if ((r.area || 0) === 0 && r.lastOut) r.door = r.lastOut;
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
      err(`[sa-coop] sync ${slot}: ${e}`);
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
  } catch (e) { err(`[sa-coop] G: ${e}`); }
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
// ---- a friend's cutscene, played here too ---------------------------------------------------------------------
// text: name|interior|x|y|z. The cutscene is loaded from here, but started and cleared on the game's own thread
// (coop_native): started from this script's thread it crashed the Definitive Edition whenever the game had to build
// the cutscene's actors for the first time ("AssembleReferenceTokenStream for BP_player_character_Cutscene",
// 11-15). A marker in an ini file guards it: if the game dies during a start, the next run only says that the
// friend is watching one. The interior it plays in is shown; the game streams the place itself.
let cutOff = false;
try { cutOff = flag(0, "cutscene") === 1; if (cutOff) log("[sa-coop] cutscenes: the game died during one last time, off"); } catch (e) {}
// A mission's texts (its lines and its cutscenes' subtitles) are only in memory while that mission's text table is
// loaded, and the guest runs no mission: a cutscene played here showed "INT2_FA missing!" for every subtitle
// (11-15). The table is named after the mission script. Behind the same kind of marker as the cutscenes.
let textTable = "", textOff = false;
try { textOff = flag(0, "missiontext") === 1; if (textOff) log("[sa-coop] mission text: the game died loading one last time, off"); } catch (e) {}
function loadFriendText(mission) {
  const table = String(mission || "").toUpperCase();
  if (textOff || table === textTable || !/^[A-Z0-9_]{2,7}$/.test(table) || table === "NONAME") return;
  textTable = table;
  try {
    flag(1, "missiontext");
    Text.LoadMissionText(table);
    flag(2, "missiontext");
    log(`[sa-coop] mission text ${table} loaded`);
  } catch (e) { err(`[sa-coop] mission text ${table}: ${e}`); }
}

function nativeCall(op, timeoutMs) {
  try {
    const before = api.coop_native_done();
    if (!api.coop_native(op)) return false;
    for (let i = 0; i < timeoutMs / 25; i++) { pause(25); if (api.coop_native_done() !== before) return true; }
  } catch (e) { err(`[sa-coop] native ${op}: ${e}`); }
  return false;
}
function playCutscene(text, me) {
  const [name, a, x, y, z] = text.split("|");
  if (!/^[A-Za-z0-9_]{2,24}$/.test(name) || (ONMISSION && !isGuest()) || me.isInAnyCar() || downed) return;
  if (cutOff) { say("SA Co-op: your friend is watching a cutscene"); return; }
  const area = Number(a), at = { x: Number(x), y: Number(y), z: Number(z) };
  const placed = area >= 0 && area <= 255 && [at.x, at.y, at.z].every(Number.isFinite) && Math.abs(at.x) < 6000 && Math.abs(at.y) < 6000;
  playingCut = true;
  let myArea = 0, changed = false, started = false;
  try {
    if (placed) {
      myArea = Streaming.GetAreaVisible();
      Streaming.SetAreaVisible(area);
      Streaming.RequestCollision(at.x, at.y);
      changed = true;
    }
    try { Text.ClearHelp(); } catch (e) {}
    loadFriendText(friendMission); // its subtitles
    Cutscene.Load(name);
    for (let i = 0; i < 400 && !Cutscene.HasLoaded(); i++) pause(25);
    if (Cutscene.HasLoaded()) {
      try { flag(1, "cutscene"); } catch (e) {}
      started = nativeCall(0x02E7, 2000);
      if (started) {
        const from = Date.now();
        let cleared = false;
        while (!Cutscene.HasFinished()) {
          pause(0);
          // it has been running for 3 s: the start did not kill the game
          if (!cleared && Date.now() - from > 3000) { cleared = true; try { flag(2, "cutscene"); } catch (e) {} }
        }
        log(`[sa-coop] cutscene ${name} played`);
      } else log(`[sa-coop] cutscene ${name}: the game's own thread did not take the start, not shown`);
      try { flag(2, "cutscene"); } catch (e) {}
    }
    if (!nativeCall(0x02EA, 2000)) Cutscene.Clear();
  } catch (e) { err(`[sa-coop] cutscene ${name}: ${e}`); }
  if (changed) {
    try {
      Streaming.SetAreaVisible(myArea);
      const p = me.getCoordinates();
      Streaming.RequestCollision(p.x, p.y);
    } catch (e) { err(`[sa-coop] cutscene ${name}, back: ${e}`); }
  }
  if (!started) say("SA Co-op: your friend is watching a cutscene");
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
  } catch (e) { if (!statsErr) { statsErr = true; err(`[sa-coop] skills: ${e}`); } }
}
function onStats(text) {
  const v = text.split(",").map(Number);
  if (v.length !== SKILL_F.length + SKILL_I.length || v.some((x) => !Number.isFinite(x) || x < 0 || x > 10000)) return;
  const raised = [];
  try {
    SKILL_F.forEach((id, i) => { if (v[i] > Stat.GetFloat(id) + 0.5) { Stat.SetFloat(id, v[i]); raised.push(id); } });
    SKILL_I.forEach((id, i) => { const t = Math.round(v[SKILL_F.length + i]); if (t > Stat.GetInt(id)) { Stat.SetInt(id, t); raised.push(id); } });
  } catch (e) { err(`[sa-coop] skills from a friend: ${e}`); }
  if (raised.length) log(`[sa-coop] skills raised to your friend's: ${raised.join(", ")}`);
}

// ---- which key does what, shown while it applies -----------------------------------------------------------------
try {
  FxtStore.insert("COOPHG", "G - get in your friend's car");
  FxtStore.insert("COOPHF", "F - get out");
  FxtStore.insert("COOPHI", "Your friend is inside: use the door (J if it is shut)");
  FxtStore.insert("COOPHO", "J - go out to your friend");
} catch (e) {}
// ---- through doors together -----------------------------------------------------------------------------------
// A house, a shop or a barber opens for the player whose story unlocked it; in the friend's game the same door can
// be shut (11-15: "he cannot go into houses, the barber and so on"). So doors are followed, not opened: a friend
// who went inside leaves a mark where they stood outside; standing there takes you in beside them, and J takes you
// to them from anywhere (in or out).
let followAt = 0, unfreezeAt = 0, doorHint = "", doorSince = 0, doorArmed = false;
function followTick(me, now) {
  doorHint = "";
  let atDoor = false;
  if (unfreezeAt && now > unfreezeAt) { unfreezeAt = 0; try { me.freezePosition(false); } catch (e) {} }
  if (downed) return;
  try {
    const mine = me.getAreaVisible(), p = me.getCoordinates();
    if (mine !== 0) doorArmed = false; // indoors: whatever door we come out by does not count until we walk away
    for (const r of remotes) {
      if (!r || !Char.DoesExist(r.ped) || r.down) continue;
      const theirs = r.area || 0;
      if (theirs === mine) continue;
      if (mine === 0 && theirs !== 0 && r.door) {
        const d = dist2(p, r.door);
        // The game's own door first: walking in the normal way starts the place's own life (the people behind
        // the counter, the buying, the way out). Carried in by us, a Burger Shot was empty, sold nothing and had no
        // exit (11-15). Only when we have stood at the door for 3 s and the game has not taken us in (a door that
        // is shut in our game) are we taken to the friend.
        // Coming OUT of a building puts us right at this door while the friend is still inside: following from
        // there threw us straight back in ("I cannot leave the Burger Shot, the house, anywhere", 11-15). The door
        // only counts once we have been more than 8 m away from it since we were last indoors.
        if (d > 8 * 8) doorArmed = true;
        if (d < 3 * 3 && !me.isInAnyCar() && doorArmed) {
          if (!doorSince) doorSince = now;
          if (now - doorSince > 3000 && now - followAt > 3000) { followAt = now; doorSince = 0; jumpToFriend(me); return; }
          atDoor = true;
        }
        if (d < 40 * 40) doorHint = "COOPHI";
      } else if (mine !== 0) doorHint = "COOPHO"; // we are inside, they are not (or in another building)
    }
  } catch (e) {}
  if (!atDoor) doorSince = 0;
}

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
    if (!key) key = doorHint;
    if (!key) return;
    Text.UseCommands(true); Text.SetFont(1); Text.SetScale(0.4, 1.6); Text.SetCenter(true);
    Text.SetColor(255, 255, 255, 255); Text.SetDropshadow(1, 0, 0, 0, 255);
    Text.Display(320, 345, key); // above the game's own subtitles
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
    else if (kind === EVW.HIT || kind === EVW.TAKE) onWorldEvent(kind, text);
    else if (kind === EV_NOTE) { hostSaveNote = text; say(`SA Co-op: ${text}`); }
    else if (kind === EV_VERSION) onVersion(text, Date.now());
    else if (kind === EV_LOG) log(`[friend] ${text.replace(/`/g, " ")}`);
    else if (kind === EV_DRIVE) onDrive(text);
    else if (kind === 6 || kind === 7 || kind === 15 || kind === 16) onStoryEvent(kind, text);
    else if (kind === EV.MISSION && (friendMission = text, true)) say(text && text !== "noname" ? "SA Co-op: your friend started a mission. Press J to join them" : text ? "" : "SA Co-op: your friend's mission ended");
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
        // the "dead" byte also carries the weapon (bits 1..6) and "is shooting" (bit 7)
        let extra = 0;
        try { extra = (Math.min(46, Math.max(0, c.getCurrentWeapon())) << 1) | (c.isShooting() ? 0x80 : 0); } catch (e) {}
        out.push({ h, kind, dead: (hp <= 0 ? 1 : 0) | extra, model: c.getModel(), x: p.x, y: p.y, z: p.z, heading: c.getHeading(), hp });
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
    const h = Memory.ReadI32(b, false, false), kind = Memory.ReadU8(b + 4, false, false), deadByte = Memory.ReadU8(b + 5, false, false);
    const dead = deadByte & 1, weapon = (deadByte >> 1) & 0x3f, shooting = (deadByte & 0x80) !== 0;
    const model = Memory.ReadU8(b + 6, false, false) | (Memory.ReadU8(b + 7, false, false) << 8);
    const x = Memory.ReadFloat(b + 8, false, false), y = Memory.ReadFloat(b + 12, false, false), z = Memory.ReadFloat(b + 16, false, false);
    const heading = Memory.ReadFloat(b + 20, false, false), hp = Memory.ReadFloat(b + 24, false, false);
    seen.add(h);
    if (h === drivingProxy && proxies.has(h)) continue; // we are at its wheel: our driving decides where it is
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
      // armed like the original, firing when it fires: in the owner's game it shoots at our copy, here at us
      const firing = kind === 2 && armCopy(p, weapon, shooting, { x, y, z, heading }, now);
      if (kind === 1) {
        // a car: far off it is put in place, close by it is drawn towards its place in small steps (no jumps)
        if (d2 > 100) { p.ent.setCoordinatesNoOffset(x, y, z); p.ent.setHeading(heading); }
        else if (d2 > 1) { p.ent.setCoordinatesNoOffset(c.x + (x - c.x) * 0.3, c.y + (y - c.y) * 0.3, c.z + (z - c.z) * 0.3); p.ent.setHeading(heading); }
      } else if (d2 > 16) {
        p.ent.setCoordinatesNoOffset(x, y, z);
        p.ent.setHeading(heading);
      } else if (firing) {
        // no walk task over the shot
      } else if (d2 > 1) {
        Task.GoStraightToCoord(p.ent, x, y, z, d2 > 6 ? 6 : 4, 1000); // run when behind, else walk
      } else if (Math.abs(((p.ent.getHeading() - heading + 540) % 360) - 180) > 20) {
        p.ent.setHeading(heading);
      }
    } catch (e) { err(`[sa-coop] mission entity ${h}: ${e}`); }
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
const KEY_J = 74, FAR = 60; // further than this during a mission: the jump (J) is offered
try { FxtStore.insert("COOPFAR", "Your friend is on a mission. Press J to join them"); } catch (e) {}

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
      Streaming.RequestCollision(c.x, c.y); // no LOAD_SCENE: it crashes the Definitive Edition from a script
      me.setCoordinates(c.x + 0.6, c.y + 0.6, c.z);
      // indoors the floor is loaded a moment later: held still until then, or we fall through it
      if (area !== 0) { try { me.freezePosition(true); unfreezeAt = Date.now() + 1500; } catch (e) {} }
    }
    farSince = 0;
    say("SA Co-op: you jumped to your friend");
  } catch (e) { err(`[sa-coop] J: ${e}`); }
}

function catchUpTick(me, now) {
  if (pressed(KEY_J)) { jumpToFriend(me); return; }
  const mission = ONMISSION || friendMission;
  const f = mission ? nearestFriend(me) : null;
  if (!f || f.d < FAR || downed) { farSince = 0; return; }
  if (!farSince) farSince = now;
  if (now - farSince > 3000) {
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
const EVS = { TEXT: 6, BLIPS: 7, WORDS: 15, MORE: 16 };
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
      const ms = Memory.ReadU32(SRVA.brief + 0x14, false, true);
      // the words themselves, not the key: the guest's game has no texts of a mission it is not running and
      // showed "INT2_CG missing!" (11-15). Spaces travel as ` (events carry no spaces); two events when long.
      const words = readBriefText().replace(/`/g, "'").replace(/ /g, "`");
      if (words) {
        sendEvent(EVS.WORDS, `${ms}|${words.slice(0, 110)}`);
        if (words.length > 110) sendEvent(EVS.MORE, words.slice(110, 228));
      } else sendEvent(EVS.TEXT, `${key}:${ms}`);
    }
  } else {
    lastBriefKey = "";
  }
  // host: destination blips (type 4 = coord) every second when they change
  if (now - lastBlipsAt < 1000) return;
  lastBlipsAt = now;
  // The objective on the map: blips on a place (type 4), and on a car (1) or a person (2) the mission points at
  // ("get in the car", "follow him"). Not ours (friends and their cars) and not mission peds (their copies in the
  // guest's game carry a blip of their own). 11-15: "the same objective must show for both".
  const parts = [];
  const mine = new Set(), missionPeds = missionHandles();
  for (const r of remotes) { if (r) { mine.add(+r.ped); if (r.car) mine.add(+r.car); if (r.parked) mine.add(+r.parked); } }
  for (let i = 0; i < 250 && parts.length < 5; i++) {
    const e = SRVA.radar + i * 0x30;
    if (!(Memory.ReadU8(e + 0x29, false, true) & 2)) continue;
    const f = Memory.ReadU8(e + 0x2A, false, true), kind = (f >> 2) & 15;
    if (!(f & 3)) continue;
    // +0x28 is the icon: 0 = a plain marker, which is what a mission's target is. Shops, safehouses and the like
    // have an icon; before 11-15 the first four of those were sent instead of the mission's target (seen in the
    // running game: 86 icon blips ahead of the one real marker), so the guest never got the objective on its map.
    if (Memory.ReadU8(e + 0x28, false, true) !== 0) continue;
    let pos = null;
    if (kind === 4) {
      pos = { x: Memory.ReadFloat(e + 8, false, true), y: Memory.ReadFloat(e + 12, false, true), z: Memory.ReadFloat(e + 16, false, true) };
    } else if (kind === 1 || kind === 2) {
      const h = Memory.ReadI32(e + 4, false, true);
      if (h <= 0 || mine.has(h) || (kind === 2 && missionPeds.has(h))) continue;
      try {
        if (kind === 1 && Car.DoesExist(h)) pos = new Car(h).getCoordinates();
        else if (kind === 2 && Char.DoesExist(h)) pos = new Char(h).getCoordinates();
      } catch (e2) {}
    }
    if (!pos || ![pos.x, pos.y, pos.z].every(Number.isFinite)) continue;
    parts.push(`${pos.x.toFixed(0)},${pos.y.toFixed(0)},${pos.z.toFixed(0)},${Memory.ReadU32(e, false, true) & 0xff}`);
  }
  const msg = parts.join(";");
  if (msg !== lastBlipsSent) { lastBlipsSent = msg; sendEvent(EVS.BLIPS, msg || "-"); }
}

// the mission line on the host's screen: brief + 8 points at its text (8-bit or 16-bit characters), ASCII only
function readBriefText() {
  try {
    const at = ptr(SRVA.brief + 8, true);
    if (at < 0x10000 || at > 0x7FFFFFFFFFFF) return "";
    const wide = Memory.ReadU8(at + 1, false, false) === 0 && Memory.ReadU8(at, false, false) !== 0;
    let out = "";
    for (let i = 0; i < 228; i++) {
      const c = wide ? Memory.ReadU16(at + i * 2, false, false) : Memory.ReadU8(at + i, false, false);
      if (!c) break;
      out += c >= 32 && c < 127 ? String.fromCharCode(c) : "?";
    }
    return out.trim();
  } catch (e) { return ""; }
}
let guestWords = "", guestWordsMs = 4000;
function showGuestWords() {
  try {
    FxtStore.insert("COOPMS", guestWords);
    Text.PrintNow("COOPMS", guestWordsMs, 1);
  } catch (e) { err(`[sa-coop] mission line: ${e}`); }
}

function onStoryEvent(kind, text) {
  if (!isGuest()) return;
  if (kind === EVS.WORDS) {
    const cut = text.indexOf("|");
    guestWordsMs = Math.min(parseInt(text.slice(0, cut), 10) || 4000, 15000);
    guestWords = text.slice(cut + 1).replace(/`/g, " ");
    showGuestWords();
  } else if (kind === EVS.MORE) {
    guestWords += text.replace(/`/g, " ");
    showGuestWords();
  } else if (kind === EVS.TEXT) {
    loadFriendText(friendMission);
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
      near = same && (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 < 25 * 25 ? 1 : 0; // 25 m (was 6)
    } catch (e) {}
    break;
  }
  api.coop_set_partner(handle, near);
}

// ---- main loop ------------------------------------------------------------------------------------------
log("[sa-coop] loaded");
// ---- one world for both (11-15, from the Vice City build) ---------------------------------------------------------
// Near the host, the guest's game makes no peds or traffic of its own: the host sends its ordinary peds and cars
// around the guest (WORLD, about 8 times a second) and the guest shows copies of them. Far from the host the guest's
// own population comes back. The police stay each player's own (a game only sends its police after its own player),
// so each side also sends its police to the other: everyone sees every policeman, the real ones chase you, the
// copies chase your friend. Damage done to a copy of a ped goes to its owner (EVW.HIT); a copied car a player drives
// off in becomes that player's and its owner removes the original (EVW.TAKE).
// The pools, from the game's own code (Steam build 1.0.113.49697469): vehicles at RVA 0x572B598, 0xDB8 bytes each,
// peds at 0x572B5A0, 0xB10 each; a pool is { objects, flags, count i32 }, a slot is free when its flag byte has bit 7,
// a handle is slot * 256 + flag; the model id is the i16 at +0x3A. Everything else is asked through the game's own
// script commands, by handle. A handle that comes from a friend carries that friend's slot in its top byte (set by
// coopnet64.asi), so copies from two friends never mix and an event finds its way back to the owner.
const WRVA = { vehPool: 0x572B598, vehSize: 0xDB8, pedPool: 0x572B5A0, pedSize: 0xB10, model: 0x3A };
const WORLD_SIZE = 44, WORLD_MAX = 240, WORLD_RADIUS = 120, SHARE_NEAR = 150;
const worldBuf = Memory.Allocate(WORLD_SIZE * WORLD_MAX);
const EVW = { HIT: 13, TAKE: 14 };
const EV_NOTE = 20; // a line from coopnet64.asi for the player (the host's save arrived)
const worldProxies = new Map(); // owner's handle (with its slot) -> { kind, ent, driver, model, seen, hp, ... }
const takenFromHost = new Set();
let lastWorldSend = 0, lastDensityAt = 0, lastLocalClear = 0, sharedMode = false, worldDiagAt = 0, worldErr = false;
// never copied: trains and the tram (made on rails by the game only), trailers, radio-controlled toys
const NO_COPY_CARS = new Set([449, 537, 538, 569, 570, 590, 435, 450, 584, 591, 606, 607, 608, 610, 611, 441, 464, 465, 501, 564, 594,
  // aircraft, boats and machines with moving gear: their extra parts are built the way the flashing lights were
  417, 425, 447, 460, 469, 476, 487, 488, 511, 512, 513, 519, 520, 548, 553, 563, 577, 592, 593,
  446, 452, 453, 454, 472, 473, 484, 493, 595, 539,
  406, 443, 486, 524, 530, 531, 532, 571, 572, 574, 525, 578, 455]);
// the law: police, SWAT, FBI and army peds; their cars, bike, vans, helicopter, boat, tank and trucks
const LAW_CARS = new Set([596, 597, 598, 599, 523, 427, 490, 528, 601, 497, 430, 432, 433, 470]);
function lawPed(model) { return model >= 280 && model <= 288; }
let emptyDm = null;

function poolEach(poolRva, size, fn) {
  const pool = ptr(poolRva, true);
  if (!pool) return;
  const objects = ptr(pool, false), flags = ptr(pool + 8, false), count = Memory.ReadI32(pool + 0x10, false, false);
  if (!objects || !flags || count <= 0 || count > 4096) return;
  for (let idx = 0; idx < count; idx++) {
    const f = Memory.ReadU8(flags + idx, false, false);
    if (f & 0x80) continue; // free slot
    fn(idx * 256 + f, objects + idx * size);
  }
}
function missionHandles() {
  const out = new Set();
  for (let i = 0; i < 75; i++) {
    const at = MRVA.cleanup + i * 8;
    const kind = Memory.ReadU8(at, false, true);
    if (kind === 1 || kind === 2) out.add(Memory.ReadI32(at + 4, false, true));
  }
  return out;
}
// handles that are players, friends' copies, mission things or copies of anything else: never shared, never cleared
function ownedHandles(me) {
  const out = missionHandles();
  out.add(+me);
  try { if (me.isInAnyCar()) out.add(+me.storeCarIsInNoSave()); } catch (e) {}
  for (const r of remotes) { if (r) { out.add(+r.ped); if (r.car) out.add(+r.car); if (r.parked) out.add(+r.parked); } }
  for (const p of proxies.values()) out.add(+p.ent);
  for (const p of worldProxies.values()) { out.add(+p.ent); if (p.driver) out.add(+p.driver); }
  return out;
}
// something another script of the mod made and keeps (the AI partner, a kept car)
function tracked(h) { try { return api.coop_tracked(h) === 1; } catch (e) { return false; } }
function outside() { try { return Streaming.GetAreaVisible() === 0; } catch (e) { return true; } }

// ---- sending: the host everything ordinary around its guests, a guest only the police after it
function sendWorldTick(me, t, guest) {
  if (t - lastWorldSend < 125) return;
  lastWorldSend = t;
  const around = [];
  if (guest) { if (sharedMode) around.push(me.getCoordinates()); }
  else for (const r of remotes) { try { if (r && Char.DoesExist(r.ped)) around.push(r.ped.getCoordinates()); } catch (e) {} }
  // inside a building nothing is shared: shops and safehouses keep their own people
  if (!around.length || !outside()) { api.coop_world_send(worldBuf, 0); return; }
  const near = (p) => around.some((g) => (g.x - p.x) ** 2 + (g.y - p.y) ** 2 < WORLD_RADIUS * WORLD_RADIUS);
  const skip = ownedHandles(me);
  const list = [];
  poolEach(WRVA.vehPool, WRVA.vehSize, (h, p) => {
    if (list.length >= WORLD_MAX || skip.has(h)) return;
    const model = Memory.ReadI16(p + WRVA.model, false, false);
    if (model < 400 || model > 611 || NO_COPY_CARS.has(model) || (guest && !LAW_CARS.has(model))) return;
    try {
      if (!Car.DoesExist(h)) return;
      const car = new Car(h), pos = car.getCoordinates();
      if (!near(pos)) return;
      let c1 = 0, c2 = 0, drv = 0, v = { x: 0, y: 0, z: 0 };
      try { const cc = Object.values(car.getColors()); c1 = cc[0]; c2 = cc[1]; } catch (e) {}
      try { const d = car.getDriver(); if (d && +d > 0 && Char.DoesExist(+d) && !skip.has(+d)) drv = d.getModel(); } catch (e) {}
      try { v = car.getSpeedVector(); } catch (e) {}
      list.push({ h, kind: 1, c1, c2, flags: drv > 0 ? 1 : 0, model, drv, pos, heading: car.getHeading(), v, hp: car.getHealth() });
    } catch (e) {}
  });
  poolEach(WRVA.pedPool, WRVA.pedSize, (h, p) => {
    if (list.length >= WORLD_MAX || skip.has(h)) return;
    const model = Memory.ReadI16(p + WRVA.model, false, false);
    if (model < 7 || model > 288 || (guest && !lawPed(model))) return; // CJ and special characters cannot be made by a script
    try {
      if (!Char.DoesExist(h)) return;
      const c = new Char(h);
      if (c.isInAnyCar()) return; // drivers come with their car
      const pos = c.getCoordinates();
      if (!near(pos)) return;
      let v = { x: 0, y: 0, z: 0 }, weapon = 0, flags = 0;
      try { v = c.getVelocity(); } catch (e) {}
      try { weapon = c.getCurrentWeapon(); if (c.isShooting()) flags |= 2; } catch (e) {}
      list.push({ h, kind: 2, c1: weapon, c2: 0, flags, model, drv: 0, pos, heading: c.getHeading(), v, hp: c.getHealth() });
    } catch (e) {}
  });
  list.forEach((e, i) => {
    const b = worldBuf + i * WORLD_SIZE;
    Memory.WriteI32(b, e.h, false, false);
    Memory.WriteU8(b + 4, e.kind, false, false);
    Memory.WriteU8(b + 5, e.c1 & 0xff, false, false);
    Memory.WriteU8(b + 6, e.c2 & 0xff, false, false);
    Memory.WriteU8(b + 7, e.flags, false, false);
    Memory.WriteU8(b + 8, e.model & 0xff, false, false); Memory.WriteU8(b + 9, (e.model >> 8) & 0xff, false, false);
    Memory.WriteU8(b + 10, e.drv & 0xff, false, false); Memory.WriteU8(b + 11, (e.drv >> 8) & 0xff, false, false);
    const f = [e.pos.x, e.pos.y, e.pos.z, e.heading, e.v.x, e.v.y, e.v.z, e.hp];
    f.forEach((x, k) => Memory.WriteFloat(b + 12 + k * 4, Number.isFinite(x) ? x : 0, false, false));
  });
  api.coop_world_send(worldBuf, list.length);
  if (t - worldDiagAt > 10000) { worldDiagAt = t; log(`[sa-coop] world: sending ${list.length}, showing ${worldProxies.size} copies`); }
}

// an event about one of our own peds or cars: the handle carries the owner's slot
function onWorldEvent(kind, text) {
  const parts = text.split(":").map((v) => parseInt(v, 10));
  const tagged = parts[0];
  if (!Number.isFinite(tagged) || ((tagged >>> 24) & 0xff) !== api.coop_slot()) return; // somebody else's
  const h = tagged & 0xffffff;
  try {
    if (ownedHandles(player.getChar()).has(h)) return;
    if (kind === EVW.HIT) {
      const dmg = parts[1];
      if (dmg > 0 && Char.DoesExist(h)) { const c = new Char(h); c.setHealth(Math.max(0, c.getHealth() - dmg)); }
    } else if (kind === EVW.TAKE && Car.DoesExist(h)) {
      const car = new Car(h);
      try { const d = car.getDriver(); if (d && +d > 0 && Char.DoesExist(+d)) d.delete(); } catch (e) {}
      car.delete();
    }
  } catch (e) { err(`[sa-coop] world event ${kind} ${h}: ${e}`); }
}

// ---- receiving: copies of a friend's world
function setPopulation(on) {
  try { World.SetPedDensityMultiplier(on ? 1.0 : 0.0); } catch (e) { err(`[sa-coop] ped density: ${e}`); }
  try { World.SetCarDensityMultiplier(on ? 1.0 : 0.0); } catch (e) { err(`[sa-coop] car density: ${e}`); }
}
function dropWorldProxy(h) {
  const p = worldProxies.get(h);
  worldProxies.delete(h);
  if (!p) return;
  try { if (p.driver && Char.DoesExist(p.driver)) { untrack(p.driver); p.driver.delete(); } } catch (e) {}
  try {
    if (p.kind === 2 && Char.DoesExist(p.ent)) { untrack(p.ent); p.ent.delete(); }
    if (p.kind === 1 && Car.DoesExist(p.ent)) {
      const me = player.getChar();
      untrack(p.ent);
      if (me.isInAnyCar() && +me.storeCarIsInNoSave() === +p.ent) p.ent.markAsNoLongerNeeded(); // we sit in it: ours now
      else p.ent.delete();
    }
  } catch (e) {}
}
// The guest's own people on foot and its own moving traffic go at once when sharing starts (the host's are shown
// instead). Left alone: the police (they stay each player's own), anything of a mission or of the mod, the player's
// gang, and every car without a driver (parked cars, garage cars, a kept car: deleting those could lose them).
function clearLocalPopulation(me) {
  const skip = ownedHandles(me), mp = me.getCoordinates();
  const close = (c) => { const p = c.getCoordinates(); return (p.x - mp.x) ** 2 + (p.y - mp.y) ** 2 < SHARE_NEAR * SHARE_NEAR; };
  let group = null;
  try { group = player.getGroup(); } catch (e) {}
  const peds = [], cars = [];
  poolEach(WRVA.pedPool, WRVA.pedSize, (h, p) => {
    const model = Memory.ReadI16(p + WRVA.model, false, false);
    if (skip.has(h) || model < 7 || model > 288 || lawPed(model) || tracked(h)) return;
    try {
      const c = new Char(h);
      if (!Char.DoesExist(h) || c.isInAnyCar() || !close(c)) return;
      if (group !== null && c.isGroupMember(group)) return;
      peds.push(c);
    } catch (e) {}
  });
  poolEach(WRVA.vehPool, WRVA.vehSize, (h, p) => {
    const model = Memory.ReadI16(p + WRVA.model, false, false);
    if (skip.has(h) || model < 400 || model > 611 || LAW_CARS.has(model) || NO_COPY_CARS.has(model) || tracked(h)) return;
    try {
      if (!Car.DoesExist(h)) return;
      const car = new Car(h);
      if (!close(car)) return;
      const d = car.getDriver();
      if (!d || +d <= 0 || !Char.DoesExist(+d) || skip.has(+d) || tracked(+d)) return; // nobody at the wheel: not traffic
      cars.push({ car, d });
    } catch (e) {}
  });
  for (const c of peds) { try { c.delete(); } catch (e) {} }
  for (const { car, d } of cars) { try { d.delete(); car.delete(); } catch (e) {} }
  return peds.length + cars.length;
}
function guestModeTick(me, t) {
  // shared only near a friend and in the open: far away the host's game has nothing there to send
  const mp = me.getCoordinates();
  const near = outside() && remotes.some((r) => r && Char.DoesExist(r.ped) && dist2(mp, r.ped.getCoordinates()) < SHARE_NEAR * SHARE_NEAR);
  if (near !== sharedMode || t - lastDensityAt > 5000) {
    if (near !== sharedMode) log(`[sa-coop] world: ${near ? "shared with the host" : "own (far from the host or indoors)"}`);
    sharedMode = near; lastDensityAt = t;
    setPopulation(!near);
    if (!near) for (const h of [...worldProxies.keys()]) dropWorldProxy(h);
  }
  if (sharedMode && t - lastLocalClear > 500) {
    lastLocalClear = t;
    const n = clearLocalPopulation(me);
    if (n > 20) log(`[sa-coop] world: ${n} of our own peds and cars removed`);
  }
}
function receiveWorldTick(me, t, guest) {
  const n = api.coop_world_get(worldBuf, WORLD_MAX);
  // a guest far from the host or anyone indoors shows no copies
  const show = guest ? sharedMode : outside();
  if (!show) { for (const h of [...worldProxies.keys()]) dropWorldProxy(h); return; }
  for (let i = 0; i < n; i++) {
    const b = worldBuf + i * WORLD_SIZE;
    const h = Memory.ReadI32(b, false, false), kind = Memory.ReadU8(b + 4, false, false);
    if (takenFromHost.has(h)) continue;
    const c1 = Memory.ReadU8(b + 5, false, false), c2 = Memory.ReadU8(b + 6, false, false), flags = Memory.ReadU8(b + 7, false, false);
    const model = Memory.ReadU8(b + 8, false, false) | Memory.ReadU8(b + 9, false, false) << 8;
    const drv = Memory.ReadU8(b + 10, false, false) | Memory.ReadU8(b + 11, false, false) << 8;
    const f = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => Memory.ReadFloat(b + 12 + k * 4, false, false));
    if (!f.every(Number.isFinite) || Math.abs(f[0]) > 6000 || Math.abs(f[1]) > 6000) continue;
    const s = { x: f[0], y: f[1], z: f[2], heading: f[3], vx: f[4], vy: f[5], vz: f[6], hp: f[7] };
    try { updateWorldProxy(h, kind, model, drv, flags, c1, c2, s, t); } catch (e) { err(`[sa-coop] world ${h}: ${e}`); }
  }
  for (const [h, p] of worldProxies) {
    if (t - p.seen > 1500) { dropWorldProxy(h); continue; }
    // we drove off in a copy: it is ours now, its owner removes the original
    if (p.kind === 1 && me.isInAnyCar()) {
      try {
        if (+me.storeCarIsInNoSave() === +p.ent) {
          worldProxies.delete(h); takenFromHost.add(h);
          if (p.driver) { try { untrack(p.driver); if (Char.DoesExist(p.driver)) p.driver.delete(); } catch (e) {} }
          untrack(p.ent);
          try { p.ent.setMission(0); } catch (e) {}
          sendEvent(EVW.TAKE, String(h));
        }
      } catch (e) {}
    }
  }
  if (takenFromHost.size > 400) takenFromHost.clear();
}
// a copy holds what the original holds and fires when it fires (straight ahead, as a friend's copy does)
function armCopy(p, weapon, shooting, s, t) {
  if (weapon !== p.weapon) {
    try {
      const wm = weapon > 0 && weapon <= 46 ? Weapon.GetModel(weapon) : 0;
      if (wm > 0 && !loadModel(wm)) return;
      p.weapon = weapon;
      if (weapon > 0 && weapon <= 46) { p.ent.giveWeapon(weapon, 9999); if (wm > 0) Streaming.MarkModelAsNoLongerNeeded(wm); p.ent.setCurrentWeapon(weapon); }
      else p.ent.setCurrentWeapon(0);
    } catch (e) { p.weapon = weapon; }
  }
  if (shooting && weapon > 15 && t - (p.lastShot || 0) > 300) {
    const hr = s.heading * Math.PI / 180;
    try { Task.ShootAtCoord(p.ent, s.x - Math.sin(hr) * 25, s.y + Math.cos(hr) * 25, s.z + 0.5, 350); } catch (e) {}
    p.lastShot = t;
    return true;
  }
  return t - (p.lastShot || 0) < 400;
}
function updateWorldProxy(h, kind, model, drv, flags, c1, c2, s, t) {
  let p = worldProxies.get(h);
  if (!p) {
    if (s.hp <= 0) return; // dead before we saw it
    if (kind === 1) {
      // a flashing-light vehicle the game has not loaded here is left out (see safeCarModel)
      if (model < 400 || model > 611 || NO_COPY_CARS.has(model) || safeCarModel(model) !== model || !loadModel(model)) return;
      const withDriver = (flags & 1) && drv >= 7 && drv <= 288;
      if (withDriver && !loadModel(drv)) return;
      const car = track(Car.Create(model, s.x, s.y, s.z), 1, model);
      Streaming.MarkModelAsNoLongerNeeded(model);
      try { car.changeColor(c1, c2); } catch (e) {}
      try { car.setHeading(s.heading); } catch (e) {}
      let driver = null;
      if (withDriver) {
        driver = track(Char.CreateInsideCar(car, 4, drv), 2, drv);
        Streaming.MarkModelAsNoLongerNeeded(drv);
        try { driver.setCantBeDraggedOut(false); } catch (e) {}
      }
      try { car.setMission(0); } catch (e) {}
      p = { kind, ent: car, driver, model, seen: t, hp: s.hp, headAt: 0, driveAt: 0 };
    } else if (kind === 2) {
      if (model < 7 || model > 288 || !loadModel(model)) return;
      const ped = track(Char.Create(4, model, s.x, s.y, s.z), 2, model);
      Streaming.MarkModelAsNoLongerNeeded(model);
      try { ped.setHeading(s.heading); ped.setKeepTask(true); } catch (e) {}
      // no reactions of its own (it would run from gunfire while the original stands): the original decides
      try { if (!emptyDm) emptyDm = DecisionMakerChar.Load(0); ped.setDecisionMaker(emptyDm); } catch (e) {}
      p = { kind, ent: ped, driver: null, model, seen: t, hp: s.hp, lastTask: 0, moving: false, weapon: 0 };
    } else return;
    worldProxies.set(h, p);
    return;
  }
  p.seen = t;
  if (p.kind === 2) {
    if (!Char.DoesExist(p.ent)) { worldProxies.delete(h); return; }
    const local = p.ent.getHealth();
    if (local < p.hp - 3) sendEvent(EVW.HIT, `${h}:${Math.round(p.hp - local)}`); // our hit: the owner's game decides
    if (s.hp <= 0) { if (local > 0) p.ent.setHealth(0); p.hp = 0; return; }
    if (Math.abs(local - s.hp) > 1) p.ent.setHealth(Math.max(1, Math.round(s.hp)));
    p.hp = s.hp;
    const firing = armCopy(p, c1, (flags & 2) !== 0, s, t);
    const c = p.ent.getCoordinates();
    const d = Math.sqrt(dist2(c, s));
    const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
    if (d > 4) {
      p.ent.setCoordinatesNoOffset(s.x, s.y, s.z); p.ent.setHeading(s.heading); p.moving = false;
    } else if (firing) {
      // shooting: no walk task over the shot
    } else if (speed > 0.3 || d > 1) {
      if (t - p.lastTask > 300) {
        const moveState = speed + d > 6 ? 7 : speed + d > 2.5 ? 6 : 4; // sprint, run, walk
        Task.GoStraightToCoord(p.ent, s.x + s.vx * 0.6, s.y + s.vy * 0.6, s.z, moveState, 1000);
        p.lastTask = t; p.moving = true;
      }
    } else if (p.moving) { p.moving = false; p.ent.setHeading(s.heading); }
    return;
  }
  if (!Car.DoesExist(p.ent)) { worldProxies.delete(h); return; }
  // a wreck in the owner's game: the copy just stops being moved (an explosion made from here would have the game
  // build its effects on the script's thread)
  if (s.hp <= 0) { p.hp = 0; return; }
  p.hp = s.hp;
  const c = p.ent.getCoordinates();
  const ex = s.x - c.x, ey = s.y - c.y, ez = s.z - c.z;
  const err = Math.sqrt(ex * ex + ey * ey + ez * ez);
  const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
  if (err > 10) { p.ent.setCoordinatesNoOffset(s.x, s.y, s.z); p.ent.setHeading(s.heading); }
  else if (err > 1) p.ent.setCoordinatesNoOffset(c.x + ex * 0.3, c.y + ey * 0.3, c.z + ez * 0.3);
  if (t - p.headAt > 100) {
    p.headAt = t;
    let dh = Math.abs(p.ent.getHeading() - s.heading) % 360; if (dh > 180) dh = 360 - dh;
    if (dh > 4) p.ent.setHeading(s.heading);
  }
  // which way it faces: moving against that is reverse
  const hr = s.heading * Math.PI / 180, fx = -Math.sin(hr), fy = Math.cos(hr);
  const sign = s.vx * fx + s.vy * fy < 0 ? -1 : 1;
  p.ent.setForwardSpeed(sign * speed);
  // a driver with nothing to do holds the handbrake: give it a drive towards a point ahead (as for a friend's car)
  if (p.driver && t - p.driveAt > 500) {
    p.driveAt = t;
    try {
      if (speed > 0.5 && sign > 0) { p.ent.setCruiseSpeed(Math.max(10, speed * 3.6)); p.ent.gotoCoordinatesAccurate(s.x + fx * 25, s.y + fy * 25, s.z); }
      else p.ent.setMission(0);
    } catch (e) {}
  }
}
function leaveSharedWorld() {
  if (!sharedMode && !worldProxies.size) return;
  for (const h of [...worldProxies.keys()]) dropWorldProxy(h);
  sharedMode = false;
  setPopulation(true);
}
// ---- both must run the same version: say so in the game when they do not ---------------------------------------
// The update happens when SA-Coop.exe is started, not when the game is started from Steam: in the first sessions
// the two games were several versions apart without anyone seeing it. Keep VERSION equal to launcher/Cargo.toml.
const VERSION = "0.8.22", EV_VERSION = 21;
let versionSentAt = 0, versionToldAt = 0;
function versionTick(t) {
  if (t - versionSentAt < 20000) return;
  versionSentAt = t;
  sendEvent(EV_VERSION, VERSION);
}
// a newer release than the one running: said in the game, every 10 minutes until it is installed
const latestBuf = Memory.Allocate(32);
let latestAt = 0, latestToldAt = 0;
function latestTick(t) {
  if (t - latestAt < 30000) return;
  latestAt = t;
  try {
    const latest = readAscii(latestBuf, api.coop_latest(latestBuf, 32));
    if (!/^\d+\.\d+\.\d+$/.test(latest)) return;
    const num = (v) => v.split(".").reduce((a, n) => a * 1000 + Number(n), 0);
    if (num(latest) > num(VERSION) && (!latestToldAt || t - latestToldAt > 600000)) {
      latestToldAt = t;
      say(`SA Co-op: version ${latest} is out (you have ${VERSION}). Close the game and start SA-Coop.exe to get it`);
    }
  } catch (e) {}
}
function onVersion(text, t) {
  if (!/^\d+\.\d+\.\d+$/.test(text) || text === VERSION || t - versionToldAt < 60000) return;
  versionToldAt = t;
  const num = (v) => v.split(".").reduce((a, n) => a * 1000 + Number(n), 0);
  say(num(text) > num(VERSION)
    ? `SA Co-op: your friend has version ${text}, you have ${VERSION}. Close the game and start SA-Coop.exe to update`
    : `SA Co-op: your friend has an older version (${text}, you have ${VERSION}). They must close the game and start SA-Coop.exe`);
}

// ---- one log for both games ---------------------------------------------------------------------------------------
// What goes wrong in a friend's game was invisible from here. Script errors (at most one every 5 s) and a status
// line every 30 s are sent to the friends, who write them to their own log as "[friend] ...".
const EV_LOG = 22;
let errSentAt = 0, statusSentAt = 0;
function err(text) {
  log(text);
  try { // everything in the try: this may be called before the lines above have run (a failed setup)
    const t = Date.now();
    if (t - errSentAt < 5000) return;
    errSentAt = t;
    sendEvent(EV_LOG, text.replace(/^\[sa-coop\] /, "E:").replace(/ /g, "`").slice(0, 118));
  } catch (e) {}
}
function statusTick(t) {
  if (t - statusSentAt < 30000) return;
  statusSentAt = t;
  try {
    const st = `S:v${VERSION}` + (isGuest() ? ` guest shared=${sharedMode ? 1 : 0}` : " host") + ` copies=${worldProxies.size} mission=${proxies.size}` +
      ` area=${Streaming.GetAreaVisible()}` + (cutOff ? " cutscenes-off" : "");
    sendEvent(EV_LOG, st.replace(/ /g, "`"));
  } catch (e) {}
}

// a mission marker that does nothing says why
let hostSaveNote = "", refusedAt = 0, refusedCheckAt = 0;
function refusedTick(t) {
  if (t - refusedCheckAt < 1000) return;
  refusedCheckAt = t;
  let why = 0;
  try { why = api.coop_take_refused(); } catch (e) {}
  if (!why || t - refusedAt < 8000) return;
  refusedAt = t;
  if (why === 2) return; // older DLL only: the host is no longer held back
  say(`SA Co-op: you play your friend's story, not your own. ${hostSaveNote || "Load the host's save: Esc, Load Game"}`);
}

function sharedWorldTick(me, t) {
  try {
    if (!anyFriend()) { leaveSharedWorld(); return; }
    const guest = isGuest();
    if (guest) guestModeTick(me, t);
    sendWorldTick(me, t, guest);
    receiveWorldTick(me, t, guest);
  } catch (e) { if (!worldErr) { worldErr = true; err(`[sa-coop] world: ${e}`); } }
}

let started = false, announced = -1, lastCode = "", lastCodeCheck = 0;

while (true) {
  pause(0);
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
  claimWanted = status === 2; // only in a session: alone the script makes nothing
  if (status !== announced) {
    announced = status;
    if (status === 2) say("SA Co-op: connected");
    if (status === 3) say("SA Co-op: server refused (wrong code or no free slots)");
  }
  if (status !== 2) { leaveSharedWorld(); continue; }

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
  sharedWorldTick(me, now);
  refusedTick(now);
  versionTick(now);
  latestTick(now);
  statusTick(now);
  followTick(me, now);
  driveProxyTick(me, now);
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
