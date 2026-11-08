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
                      "coop_send", "coop_get", "coop_revive", "coop_take_revived", "coop_name", "coop_event_send", "coop_event_poll", "coop_ents_send", "coop_ents_get", "coop_is_host", "coop_my_skin", "coop_set_partner", "coop_track", "coop_untrack", "coop_take_tracked"]) {
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
const BLEED_OUT = 30000;            // ms down before the game takes over
const REVIVE_HOLD = 3000;           // hold E this long next to a downed friend
const DOWN_ANIM = ["KO_skid_back", "PED"];
// top-centre banner with a seconds countdown (~1~ is the number)
try {
  FxtStore.insert("COOPDN1", "TU SUZEISTAS! Draugas gali atgaivinti: ~1~ s");
  FxtStore.insert("COOPDN2", "YOUR HOMIE IS DOWN! Atgaivink: ~1~ s");
  FxtStore.insert("COOPDN3", "Laikyk E, kad atgaivintum: ~1~ %");
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
let downed = false, downedAt = 0;

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

// world point -> the 640 x 448 screen the game's text uses; null when behind the camera or far away
function toScreen(p) {
  const cam = Camera.GetActiveCoordinates(), at = Camera.GetActivePointAt();
  let fx = at.x - cam.x, fy = at.y - cam.y, fz = at.z - cam.z;
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  let rx = fy, ry = -fx; const rl = Math.sqrt(rx * rx + ry * ry) || 1; rx /= rl; ry /= rl; // right = forward x up
  const ux = ry * fz, uy = -rx * fz, uz = rx * fy - ry * fx;                                 // up = right x forward
  const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
  const depth = dx * fx + dy * fy + dz * fz;
  if (depth < 1 || depth > 80) return null;
  const tanX = Math.tan((Camera.GetFov() * Math.PI / 180) / 2), aspect = 16 / 9;
  const sx = 320 + ((dx * rx + dy * ry) / depth / tanX) * 320;
  const sy = 224 - ((dx * ux + dy * uy + dz * uz) / depth / (tanX / aspect)) * 224;
  return sx < 0 || sx > 640 || sy < 0 || sy > 448 ? null : { x: sx, y: sy };
}

function drawNames() {
  for (let slot = 0; slot < 4; slot++) {
    const r = remotes[slot];
    if (!r || !Char.DoesExist(r.ped)) continue;
    const head = r.ped.getCoordinates();
    head.z += 1.1;
    const at = toScreen(head);
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

function loadModel(id) {
  Streaming.RequestModel(id);
  Streaming.LoadAllModelsNow();
  for (let i = 0; i < 40 && !Streaming.HasModelLoaded(id); i++) wait(25);
  return Streaming.HasModelLoaded(id);
}

function remoteWithCar(car) {
  for (let i = 0; i < 4; i++) if (remotes[i] && remotes[i].car && +remotes[i].car === +car) return i;
  return -1;
}

// ---- our state ------------------------------------------------------------------------------------------
function writeMine(me) {
  const p = me.getCoordinates();
  let v = { x: 0, y: 0, z: 0 }, q = { x: 0, y: 0, z: 0, w: 1 }, carSpeed = 0, inCar = 0, carModel = 0, carHealth = 0;
  if (me.isInAnyCar()) {
    const car = me.storeCarIsInNoSave();
    const c = car.getCoordinates();
    p.x = c.x; p.y = c.y; p.z = c.z;
    const ownerSlot = remoteWithCar(car);
    let driver = null;
    try { driver = car.getDriver(); } catch (e) {}
    if (ownerSlot >= 0 && !(driver && +driver === +me)) {
      inCar = 2; carModel = ownerSlot; carHealth = 0; // riding with a friend: they send the car
    } else {
      q = car.getQuaternion();
      carSpeed = car.getSpeed();
      inCar = 1;
      carModel = car.getModel();
      carHealth = car.getHealth();
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
  player.setControl(false);
  try { Task.PlayAnim(me, DOWN_ANIM[0], DOWN_ANIM[1], 4.0, false, false, false, true, -1); } catch (e) {}
  say("SA Co-op: tu suzeistas. Draugas gali tave atgaivinti (30 s)");
}

function getUp(me, health) {
  downed = false;
  try { me.clearTasksImmediately(); } catch (e) {}
  me.setProofs(false, false, false, false, false);
  player.setControl(true);
  me.setHealth(health);
}

function handleOwnHealth(me, now) {
  if (!downed) {
    if (anyFriend() && me.getHealth() < DOWN_AT && me.getHealth() > 0) goDown(me, now);
    return;
  }
  banner("COOPDN1", (BLEED_OUT - (now - downedAt)) / 1000);
  if (api.coop_take_revived()) { getUp(me, 60); say("SA Co-op: draugas tave atgaivino"); return; }
  if (now - downedAt > BLEED_OUT || !anyFriend()) { getUp(me, 0); } // nobody came: the game's own death
}

// ---- friends --------------------------------------------------------------------------------------------
// story characters load through their own special slots (290 + slot - 1); creating them directly crashes
const STORY_LOOKS = ["", "sweet", "ryder", "smoke", "cesar", "kendl", "wuzimu", "truth"];
function lookModel(slot, look) {
  const name = STORY_LOOKS[look] || "";
  if (!name) { const m = SKINS[slot]; return loadModel(m) ? m : 0; }
  const special = 10 - slot; // slots 10, 9, 8, 7: missions use the low ones first
  try {
    // the game's own scripts use upper case names; give the streamer up to 3 s (it was 1 s and fell back silently)
    Streaming.LoadSpecialCharacter(special, name.toUpperCase());
    Streaming.RequestModel(290 + special - 1);
    Streaming.LoadAllModelsNow();
    for (let i = 0; i < 120 && !Streaming.HasSpecialCharacterLoaded(special); i++) wait(25);
    if (Streaming.HasSpecialCharacterLoaded(special)) { log(`[sa-coop] look ${name} loaded in slot ${special}`); return 290 + special - 1; }
    log(`[sa-coop] look ${name}: not loaded after 3 s, using a Grove Street look`);
  } catch (e) { log(`[sa-coop] look ${name}: ${e}`); }
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
  try { r.blip.remove(); } catch (e) {}
  try { untrack(r.ped); r.ped.delete(); } catch (e) {}
  remotes[slot] = null;
  log(`[sa-coop] friend ${slot} left`);
}

function driveRemote(r, s, now) {
  if (!r.car || r.carModel !== s.carModel || !Car.DoesExist(r.car)) {
    dropCar(r);
    if (!loadModel(s.carModel)) return;
    r.car = track(Car.Create(s.carModel, s.x, s.y, s.z), 1, s.carModel);
    Streaming.MarkModelAsNoLongerNeeded(s.carModel);
    r.car.setProofs(true, true, true, true, true);
    r.carModel = s.carModel;
    leaveCar(r, s);
    r.ped.warpIntoCar(r.car);
    r.rx = null;
  }
  // a new packet: remember where and when, and how fast it moved since the last one
  if (r.rx === null || s.x !== r.rx || s.y !== r.ry || s.z !== r.rz) {
    if (r.rx !== null && now > r.rt) {
      const dt = (now - r.rt) / 1000;
      r.vx = (s.x - r.rx) / dt; r.vy = (s.y - r.ry) / dt; r.vz = (s.z - r.rz) / dt;
    } else { r.vx = r.vy = r.vz = 0; }
    r.rx = s.x; r.ry = s.y; r.rz = s.z; r.rt = now;
  }
  const ahead = Math.min((now - r.rt) / 1000, 0.3);
  const tx = r.rx + r.vx * ahead, ty = r.ry + r.vy * ahead, tz = r.rz + r.vz * ahead;
  const c = r.car.getCoordinates();
  const ex = tx - c.x, ey = ty - c.y, ez = tz - c.z;
  const err = Math.sqrt(ex * ex + ey * ey + ez * ez);
  const speed = Math.sqrt(r.vx * r.vx + r.vy * r.vy);
  r.car.setQuaternion(s.qx, s.qy, s.qz, s.qw);
  if (err > 2) {
    r.car.setCoordinatesNoOffset(tx, ty, tz); // too far off: put it where it should be
    const fx0 = 2 * (s.qx * s.qy - s.qw * s.qz), fy0 = 1 - 2 * (s.qx * s.qx + s.qz * s.qz);
    r.car.setForwardSpeed(r.vx * fx0 + r.vy * fy0 < 0 ? -speed : speed);
    return;
  }
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
      if (speed > 0.5 && sign > 0) {
        r.car.setCruiseSpeed(Math.max(10, speed * 3.6));
        r.car.gotoCoordinatesAccurate(tx + fx * 25, ty + fy * 25, tz);
      } else {
        r.car.setMission(0); // standing or reversing: no AI driving
      }
    } catch (e) {}
  }
}

function rideRemote(r, s, mySlot, me) {
  if (r.car) dropCar(r);
  const driverSlot = s.carModel;
  let car = null;
  if (driverSlot === mySlot) {
    if (me.isInAnyCar()) car = me.storeCarIsInNoSave(); // they sit in our car
  } else if (remotes[driverSlot] && remotes[driverSlot].car) {
    car = remotes[driverSlot].car; // they sit in another friend's car
  }
  if (!car) { r.ped.setCoordinatesNoOffset(s.x, s.y, s.z); return; }
  if (!r.ped.isInAnyCar()) {
    try { r.ped.warpIntoCarAsPassenger(car, s.carHealth); } catch (e) { log(`[sa-coop] passenger: ${e}`); }
  }
}

function walkRemote(r, s, now) {
  if (r.car) dropCar(r);
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
  leaveCar(r, s);
  if (r.car) dropCar(r);
  if (!r.down) {
    r.down = true; r.hinted = false; r.downAt = Date.now(); r.holdStart = 0;
    r.ped.setCoordinatesNoOffset(s.x, s.y, s.z);
    try { Task.PlayAnim(r.ped, DOWN_ANIM[0], DOWN_ANIM[1], 4.0, false, false, false, true, -1); } catch (e) {}
    say("SA Co-op: draugas suzeistas! Prieik ir spausk E");
  }
  const left = (BLEED_OUT - (Date.now() - (r.downAt || Date.now()))) / 1000;
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
    r.weapon = s.weapon;
    try {
      if (s.weapon > 0) {
        const model = Weapon.GetModel(s.weapon);
        if (model > 0) loadModel(model);
        r.ped.giveWeapon(s.weapon, 9999);
        if (model > 0) Streaming.MarkModelAsNoLongerNeeded(model);
      }
      r.ped.setCurrentWeapon(s.weapon);
    } catch (e) { log(`[sa-coop] weapon ${s.weapon}: ${e}`); }
  }
  if ((s.flags & 2) && s.inCar === 0 && s.weapon > 15 && now - (r.lastShot || 0) > 300) {
    const h = s.heading * Math.PI / 180;
    try { Task.ShootAtCoord(r.ped, s.x - Math.sin(h) * 25, s.y + Math.cos(h) * 25, s.z + 0.5, 350); } catch (e) {}
    r.lastShot = now;
  }
}

// notoriety is shared: if a friend has more stars, we get them too (never lowered here)
function shareWanted(s) {
  const theirs = (s.flags >> 8) & 0xff;
  try { if (theirs > player.storeWantedLevel()) player.alterWantedLevel(theirs); } catch (e) {}
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
      shareWanted(s);
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

// G: sit next to the nearest friend who drives
function tryRideAlong(me) {
  if (me.isInAnyCar() || downed) return;
  const p = me.getCoordinates();
  let best = null, bestD = 7 * 7;
  for (const r of remotes) {
    if (!r || !r.car || !Car.DoesExist(r.car)) continue;
    const d = dist2(p, r.car.getCoordinates());
    if (d < bestD) { best = r; bestD = d; }
  }
  // straight into the seat: the friend's car is moved every frame, which breaks the walk-in animation (CJ hung)
  if (best) { try { me.warpIntoCarAsPassenger(best.car, 0); } catch (e) { log(`[sa-coop] G: ${e}`); } }
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
  if (running && !cutWas && !playingCut) sendEvent(EV.CUTSCENE, readStr(RVA.cutName, 24, true));
  cutWas = running;
  const m = missionName();
  if (m !== missionWas) { missionWas = m; sendEvent(EV.MISSION, m); }
}

// a friend's cutscene: play the same one here (only when we are free: on foot, not on our own mission)
function playCutscene(name, me) {
  if (!/^[A-Za-z0-9_]{2,24}$/.test(name) || (ONMISSION && !isGuest()) || me.isInAnyCar() || downed) return;
  playingCut = true;
  try {
    Cutscene.Load(name);
    for (let i = 0; i < 400 && !Cutscene.HasLoaded(); i++) wait(25);
    if (Cutscene.HasLoaded()) {
      Cutscene.Start();
      while (!Cutscene.HasFinished()) wait(0);
    }
    Cutscene.Clear();
  } catch (e) { log(`[sa-coop] cutscene ${name}: ${e}`); }
  playingCut = false;
}

function hearWorld(me) {
  let kind;
  while ((kind = api.coop_event_poll(evBuf)) > 0) {
    const text = readStr(evBuf, 127, false);
    if (kind === EV.WEATHER) { const w = parseInt(text, 10); if (w >= 0 && w < 64) try { Weather.ForceNow(w); } catch (e) {} }
    else if (kind === EV.CUTSCENE) playCutscene(text, me);
    else if (kind === 4 || kind === 5) onMissionEvent(kind, text);
    else if (kind === 6 || kind === 7) onStoryEvent(kind, text);
    else if (kind === EV.MISSION) say(text ? `SA Co-op: draugas pradejo misija (${text})` : "SA Co-op: draugo misija baigesi");
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
        if (!loadModel(model)) continue;
        const ent = track(kind === 2 ? Char.Create(18, model, x, y, z) : Car.Create(model, x, y, z), kind, model);
        Streaming.MarkModelAsNoLongerNeeded(model);
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
      say(`SA Co-op: misija baigta, gavai $${earned}`);
    }
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
    if (!guestLocked) { guestLocked = true; say("SA Co-op: zaidi draugo istorija. Issaugoti gali savo namuose"); }
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
    if (!api.coop_start() && api.coop_status() !== 2) say("SA Co-op: F9 - co-op langas (pavadinimas ir slaptazodis)");
  }
  if (now - lastCodeCheck > 1000) {
    lastCodeCheck = now;
    const code = readCode();
    if (code && code !== lastCode) { lastCode = code; say(`SA Co-op kodas (nukopijuotas): ${code}`); }
  }

  const status = api.coop_status();
  if (status !== announced) {
    announced = status;
    if (status === 2) say("SA Co-op: prisijungta");
    if (status === 3) say("SA Co-op: serveris neprieme (blogas kodas arba nera vietu)");
  }
  if (status !== 2) continue;

  const me = player.getChar();
  handleOwnHealth(me, now);
  writeMine(me);
  syncRemotes(me, api.coop_slot(), now);
  tellPartner(me);
  drawNames();
  const slotNow = api.coop_slot();
  tellWorld(slotNow, now);
  hearWorld(me);
  missionsTick(now);
  if (pressed(KEY.G)) tryRideAlong(me);
  // F in a friend's car: straight out beside it (the car is moved every frame, which breaks the exit animation)
  if (pressed(70) && me.isInAnyCar()) {
    try {
      const car = me.storeCarIsInNoSave();
      if (remoteWithCar(car) >= 0) { const c = car.getCoordinates(); me.warpFromCarToCoord(c.x + 2.5, c.y + 1, c.z); }
    } catch (e) {}
  }
}
