/// <reference path=".config/sa.d.ts" />
// AI partner: a Grove Street gang member that follows you, rides with you, drives (H) and fights,
// with TypeSafe Jev choosing what it does every few seconds from a short description of the situation.
// Switched on in the co-op menu ("AI partner"). Talks to coopnet64.asi (Jev runs there, off the game thread).

let lib;
for (const path of ["coopnet64.asi", "../coopnet64.asi"]) { lib = DynamicLibrary.Load(path); if (lib) break; }
if (!lib) exit("coopnet64.asi not found");
const fn = (n) => Memory.Fn.X64(lib.getProcedure(n));
const aiEnabled = fn("coop_ai_enabled"), aiAsk = fn("coop_ai_ask"), aiResult = fn("coop_ai_result");
// the partner ped is remembered in coopnet64.asi: a reloaded script deletes the old one (no doubles)
const friends = fn("coop_friends");
const trackFn = fn("coop_track"), untrackFn = fn("coop_untrack"), takeTracked = fn("coop_take_tracked");
{
  const out = Memory.Allocate(12);
  let n = 0;
  while (takeTracked(2, out)) {
    const model = Memory.ReadI32(out + 4, false, false), h = Memory.ReadI32(out + 8, false, false);
    try { if (Char.DoesExist(h) && new Char(h).getModel() === model) { new Char(h).delete(); n++; } } catch (e) {}
  }
  Memory.Free(out);
  log(`[ai] removed ${n} remembered old partner(s)`);
}
const buf = Memory.Allocate(512);

const MODEL = 106;          // a Grove Street member
const WEAPON = 30, AMMO = 600; // AK-47
const ACTIONS = ["follow", "enter_car", "attack", "take_cover", "wait"];
const SAY = { follow: "AI: following", enter_car: "AI: getting in", attack: "AI: attacking", take_cover: "AI: taking cover", wait: "AI: waiting" };

const player = new Player(0);
let ped = null, blip = null, action = "follow", lastAsk = 0, lastSit = "", deadAt = 0, target = null;

function writeAscii(text) {
  const n = Math.min(text.length, 500);
  for (let i = 0; i < n; i++) Memory.WriteU8(buf + i, text.charCodeAt(i) & 0x7f, false, false);
  Memory.WriteU8(buf + n, 0, false, false);
}

function d2(a, b) { return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2; }

function spawn(me) {
  Streaming.RequestModel(MODEL);
  Streaming.LoadAllModelsNow();
  for (let i = 0; i < 40 && !Streaming.HasModelLoaded(MODEL); i++) wait(25);
  const p = me.getCoordinates();
  // ped type 24 (mission 1): no built-in gang hatred. As a Grove ped (8) he shot every Ballas and Vagos in sight.
  ped = Char.Create(24, MODEL, p.x + 1.5, p.y + 1.5, p.z);
  // empty decision maker: no own reactions (as a mission-1 ped he put his hands up in a gunfight); our tasks drive him
  try { ped.setDecisionMaker(DecisionMakerChar.Load(0)); } catch (e) { log(`[ai] decision maker: ${e}`); }
  try { trackFn(2, 2, MODEL, +ped); log(`[ai] partner handle ${+ped} remembered`); } catch (e) { log(`[ai] track: ${e}`); }
  Streaming.MarkModelAsNoLongerNeeded(MODEL);
  try { ped.setHealth(200); } catch (e) {}
  try { ped.giveWeapon(WEAPON, AMMO); ped.setCurrentWeapon(WEAPON); } catch (e) {}
  // not in the player's group: its AI would pull the partner out of the driver's seat (we follow by ourselves)
  try { blip = Blip.AddForChar(ped); blip.setAsFriendly(true); } catch (e) {}
  action = "follow";
  log("[ai] partner spawned");
}

function despawn() {
  try { if (blip) blip.remove(); } catch (e) {}
  try { if (ped) untrackFn(+ped); if (ped && Char.DoesExist(ped)) ped.delete(); } catch (e) {}
  ped = null; blip = null;
}

// People around a point: the game has no "all peds near me" call here, so ask for the first ped in each cell of a
// 10 m grid (GET_RANDOM_CHAR_IN_AREA_OFFSET_NO_SAVE: does not take the ped over, unlike GET_RANDOM_CHAR_IN_SPHERE).
function nearbyPeds(p, radius) {
  const out = new Map(), step = 10, n = Math.ceil(radius / step);
  for (let gx = -n; gx <= n; gx++) {
    for (let gy = -n; gy <= n; gy++) {
      if ((gx * gx + gy * gy) * step * step > radius * radius) continue;
      try {
        const c = World.GetRandomCharInAreaOffsetNoSave(p.x + gx * step, p.y + gy * step, p.z, step / 2 + 1, step / 2 + 1, 12);
        if (c && +c > 0 && !out.has(+c) && Char.DoesExist(+c)) out.set(+c, c);
      } catch (e) {}
    }
  }
  return [...out.values()];
}

// Only people who are actually fighting us: they hurt CJ or the partner, or fire a gun within 30 m. Remembered for
// 20 s. Passers-by, rival gang members just walking around, and mission allies are never targets.
const AGGRO_MS = 20000;
const aggressors = new Map(); // handle -> last time seen fighting

function enemies(me) {
  const p = me.getCoordinates(), now = Date.now(), out = [];
  try {
    for (const c of nearbyPeds(p, 40)) {
      if (me && +c === +me) continue;
      if ((ped && +c === +ped) || c.getHealth() <= 0) continue;
      try { if (c.isGroupMember(player.getGroup()) || c.getPedType() === 8) continue; } catch (e) {}
      let fighting = false;
      // they hurt CJ or the partner, or CJ is shooting them: help CJ in his fight
      try { fighting = me.hasBeenDamagedByChar(c) || (ped && ped.hasBeenDamagedByChar(c)) || c.hasBeenDamagedByChar(me); } catch (e) {}
      try { if (!fighting && c.isShooting() && d2(p, c.getCoordinates()) < 30 * 30) fighting = true; } catch (e) {}
      if (fighting) aggressors.set(+c, now);
    }
    try { me.clearLastDamageEntity(); } catch (e) {}
    // (the people CJ hit keep that record; they stay "fighting" for AGGRO_MS after the last time we saw it)
    try { if (ped) ped.clearLastDamageEntity(); } catch (e) {}
  } catch (e) {}
  for (const [h, t] of aggressors) {
    try {
      if (now - t > AGGRO_MS || !Char.DoesExist(h)) { aggressors.delete(h); continue; }
      const c = new Char(h);
      if (c.getHealth() <= 0) { aggressors.delete(h); continue; }
      const dd = d2(p, c.getCoordinates());
      if (dd < 3600) out.push({ c, dd });
    } catch (e) { aggressors.delete(h); }
  }
  return out.sort((a, b) => a.dd - b.dd);
}

function situation(me, foes) {
  const inCar = me.isInAnyCar();
  const dist = Math.sqrt(d2(me.getCoordinates(), ped.getCoordinates())).toFixed(0);
  return `CJ is ${inCar ? "in a car" : "on foot"}, CJ health ${me.getHealth()}; partner on foot ${dist} m from CJ, ` +
    `partner health ${ped.getHealth()}; ${ONMISSION ? "a story mission is running" : "free roam"}; ` +
    `${foes.length ? `${foes.length} hostile mission enemies within 60 m, nearest ${Math.sqrt(foes[0].dd).toFixed(0)} m` : "no enemies around"}.`;
}

function apply(next, me, foes) {
  if (next !== action) { action = next; try { showTextBox(SAY[next]); } catch (e) {} }
  try {
    if (next === "attack" && foes.length) {
      target = foes[0].c;
      Task.KillCharOnFoot(ped, target);
    } else if (next === "take_cover" && foes.length) {
      Task.SmartFleeChar(ped, foes[0].c, 25, 6000);
    } else if (next === "wait") {
      Task.StandStill(ped, 6000);
    }
    // follow and enter_car are driven every frame in keepUp(), so nothing to start here
  } catch (e) { log(`[ai] ${next}: ${e}`); }
}

// follow / enter_car: run after CJ, sit in CJ's car (straight into the seat when close)
let lastMove = 0;
function keepUp(me, now) {
  if (action !== "follow" && action !== "enter_car") return;
  if (now - lastMove < 700) return;
  lastMove = now;
  try {
    const a = me.getCoordinates(), b = ped.getCoordinates(), dd = d2(a, b);
    if (me.isInAnyCar()) {
      const car = me.storeCarIsInNoSave();
      if (ped.isInAnyCar() && +ped.storeCarIsInNoSave() === +car) return;
      if (dd < 64 && car.getSpeed() < 3) {
        // only a FREE seat: never throw out Sweet or other mission passengers
        let seat = -1;
        try {
          const n = car.getMaximumNumberOfPassengers();
          // back seats first (1, 2), the front one (0) only if the back is taken
          for (const s of [1, 2, 0]) if (s < n && car.isPassengerSeatFree(s)) { seat = s; break; }
        } catch (e) {}
        if (seat >= 0) ped.warpIntoCarAsPassenger(car, seat);
        return; // no free seat: stay put, catch up after (40 m warp)
      }
      Task.GoStraightToCoord(ped, a.x, a.y, a.z, 7, 3000);
      return;
    }
    if (ped.isInAnyCar()) { ped.warpFromCarToCoord(a.x + 2, a.y + 1, a.z); return; }
    // sprint as soon as he falls a few metres behind, so he keeps up with a running CJ instead of warping
    if (dd > 9) Task.GoStraightToCoord(ped, a.x, a.y, a.z, dd > 36 ? 7 : 6, 3000);
  } catch (e) { log(`[ai] keep up: ${e}`); }
}

// H: the partner drives. Near an empty car (your stolen one, any): it takes the wheel, you the passenger seat, and
// it cruises the streets. H again: it stops and you both get out.
let chauffeur = null, hWas = false, dest = null;
const RADAR = 0x542A7B0; // radar trace, 250 x 0x30 (Steam build 1.0.113.49697469)
const GROVE = { x: 2495, y: -1680, z: 13.3 };
// the map waypoint the player placed: a radar entry in use with the waypoint sprite (41)
function waypoint() {
  for (let i = 0; i < 250; i++) {
    const e = RADAR + i * 0x30;
    if (!(Memory.ReadU8(e + 0x29, false, true) & 2)) continue;
    if (Memory.ReadU8(e + 0x28, false, true) !== 41) continue;
    return { x: Memory.ReadFloat(e + 8, false, true), y: Memory.ReadFloat(e + 12, false, true), z: Memory.ReadFloat(e + 16, false, true) };
  }
  return null;
}
function chauffeurKey(me) {
  const down = Pad.IsKeyPressed(72); // H
  const press = down && !hWas;
  hWas = down;
  if (!press || !ped) return;
  try {
    if (chauffeur) {
      const c = chauffeur.getCoordinates();
      chauffeur.setCruiseSpeed(0);
      chauffeur.setMission(11); // stop for good
      wait(800);
      if (me.isInAnyCar()) me.warpFromCarToCoord(c.x + 2.5, c.y, c.z);
      if (ped.isInAnyCar()) ped.warpFromCarToCoord(c.x - 2.5, c.y, c.z);
      chauffeur = null;
      action = "follow";
      showTextBox("AI: stopping");
      return;
    }
    const p = me.getCoordinates();
    const car = me.isInAnyCar() ? me.storeCarIsInNoSave() : World.GetRandomCarInSphereNoSave(p.x, p.y, p.z, 8, -1);
    if (!car || +car <= 0) { showTextBox("Walk up to a car (within 8 m) and press H"); return; }
    if (me.isInAnyCar()) me.warpFromCarToCoord(p.x + 2, p.y, p.z);
    if (ped.isInAnyCar()) { const q = ped.getCoordinates(); ped.warpFromCarToCoord(q.x, q.y, q.z); }
    ped.warpIntoCar(car);
    me.warpIntoCarAsPassenger(car, 0);
    dest = waypoint() || GROVE;
    car.setCruiseSpeed(45);   // in a hurry
    car.setDrivingStyle(2);   // around other cars, keeps to the roads
    car.gotoCoordinates(dest.x, dest.y, dest.z);
    chauffeur = car;
    action = "drive";
    showTextBox(dest === GROVE ? "AI: driving to Grove Street. H - stop" : "AI: driving to your waypoint. H - stop");
  } catch (e) { log(`[ai] H: ${e}`); }
}

// name tag over the partner's head (same drawing as the co-op script: the game's text, by key)
try { FxtStore.insert("COOPAI", "AI partner"); } catch (e) {}
// world point -> the 640 x 448 screen the game's text uses, by the game's own CSprite::CalcScreenCoors
// (RVA 0x1277370, Steam build 1.0.113.49697469); null when behind the camera or too far
const CALC_SCREEN = Memory.Fn.X64U8(0x1277370, true);
const SCREEN_W = 0x531B218, SCREEN_H = 0x531B21C;
const projIn = Memory.Allocate(16), projOut = Memory.Allocate(16);
function toScreen(p) {
  Memory.WriteFloat(projIn, p.x, false, false); Memory.WriteFloat(projIn + 4, p.y, false, false); Memory.WriteFloat(projIn + 8, p.z, false, false);
  if (!CALC_SCREEN(projIn, projOut, 0, 0)) return null;
  const depth = Memory.ReadFloat(projOut + 8, false, false);
  if (depth > 80) return null;
  const w = Memory.ReadI32(SCREEN_W, false, true), h = Memory.ReadI32(SCREEN_H, false, true);
  if (w <= 0 || h <= 0) return null;
  const sx = Memory.ReadFloat(projOut, false, false) * 640 / w, sy = Memory.ReadFloat(projOut + 4, false, false) * 448 / h;
  return sx < 0 || sx > 640 || sy < 0 || sy > 448 ? null : { x: sx, y: sy - 8 }; // text is drawn from its top
}
function drawTag() {
  try {
    if (!ped || !Char.DoesExist(ped) || ped.isInAnyCar()) return;
    const h = ped.getCoordinates(); h.z += 1.1;
    const at = toScreen(h);
    if (!at) return;
    Text.UseCommands(true); Text.SetFont(1); Text.SetScale(0.35, 1.4); Text.SetCenter(true);
    Text.SetColor(140, 230, 140, 255); Text.SetDropshadow(1, 0, 0, 0, 255);
    Text.Display(at.x, at.y, "COOPAI");
  } catch (e) {}
}

log("[ai] ready");
// Second net for old partners the list above missed (older builds, a failed track): partner-looking peds around CJ
// (our model, ped type 24, or type 8 from builds before 11-08 23:00) are removed once at start.
try {
  const me0 = player.getChar(), p0 = me0.getCoordinates();
  let n = 0;
  for (const c of nearbyPeds(p0, 150)) {
    try {
      if (c.getModel() !== MODEL || c.isGroupMember(player.getGroup())) continue;
      const t = c.getPedType();
      if (t === 24 || t === 8) { c.delete(); n++; }
    } catch (e) {}
  }
  log(`[ai] swept ${n} leftover partner(s) nearby`);
} catch (e) { log(`[ai] sweep: ${e}`); }
// Down instead of dead, both ways, 30 s:
//  - CJ down: the partner runs over and revives CJ (3 s next to him)
//  - partner down: top banner "YOUR HOMIE IS DOWN", walk up to him and HOLD E for 3 s
// Nobody in time: the normal death (CJ: wasted / mission failed; partner: back after 10 s).
const DOWN_AT = 40, BLEED_OUT = 30000, REVIVE_MS = 3000, KEY_E = 69;
try {
  FxtStore.insert("COOPAD1", "YOU ARE DOWN! AI partner is coming: ~1~ s");
  FxtStore.insert("COOPAD2", "YOUR HOMIE IS DOWN! Revive: ~1~ s");
  FxtStore.insert("COOPAD3", "Hold E to revive: ~1~ %");
} catch (e) {}
function banner(key, num, y) {
  try {
    Text.UseCommands(true); Text.SetFont(1); Text.SetScale(0.5, 2.0); Text.SetCenter(true);
    Text.SetColor(255, 80, 80, 255); Text.SetDropshadow(2, 0, 0, 0, 255);
    Text.DisplayWithNumber(320, y || 30, key, Math.max(0, Math.ceil(num)));
  } catch (e) {}
}
function knockDown(c) {
  try { c.setProofs(true, true, true, true, true); } catch (e) {}
  try { c.clearTasksImmediately(); } catch (e) {}
  try { Task.PlayAnim(c, "KO_skid_back", "PED", 4.0, false, false, false, true, -1); } catch (e) {}
}
function standUp(c, health) {
  try { c.clearTasksImmediately(); } catch (e) {}
  try { c.setProofs(false, false, false, false, false); } catch (e) {}
  c.setHealth(health);
}

let cjDown = false, cjDownAt = 0, reviveStart = 0, cjWeapon = 0;
function cjUp(me, health) {
  cjDown = false; reviveStart = 0;
  try { me.freezePosition(false); } catch (e) {}
  try { if (cjWeapon) me.setCurrentWeapon(cjWeapon); } catch (e) {}
  standUp(me, health);
}
function handleDown(me) {
  const now = Date.now();
  if (!cjDown) {
    const h = me.getHealth();
    if (h > 0 && h < DOWN_AT && !aiDown && ped.getHealth() > 0) {
      cjDown = true; cjDownAt = now; reviveStart = 0;
      if (me.isInAnyCar()) { try { const p = me.getCoordinates(); me.warpFromCarToCoord(p.x + 2, p.y, p.z); } catch (e) {} }
      // keep the controls (the mouse still turns the camera); hold CJ in place and without a gun instead
      try { cjWeapon = me.getCurrentWeapon(); me.setCurrentWeapon(0); } catch (e) {}
      try { me.freezePosition(true); } catch (e) {}
      knockDown(me);
      log("[ai] CJ down, partner coming");
    }
    return false;
  }
  banner("COOPAD1", (BLEED_OUT - (now - cjDownAt)) / 1000);
  try { if (me.getCurrentWeapon() !== 0) me.setCurrentWeapon(0); if (!me.isPlayingAnim("KO_skid_back")) Task.PlayAnim(me, "KO_skid_back", "PED", 4.0, false, false, false, true, -1); } catch (e) {}
  if (now - cjDownAt > BLEED_OUT || ped.getHealth() <= 0) { cjUp(me, 0); return false; }
  const a = me.getCoordinates();
  if (d2(a, ped.getCoordinates()) > 2 * 2) {
    reviveStart = 0;
    try { if (ped.isInAnyCar()) ped.warpFromCarToCoord(a.x + 2, a.y + 1, a.z); else if (now - lastMove > 1000) { lastMove = now; Task.GoStraightToCoord(ped, a.x, a.y, a.z, 7, 1500); } } catch (e) {}
    return true;
  }
  if (!reviveStart) { reviveStart = now; try { Task.StandStill(ped, REVIVE_MS); } catch (e) {} }
  if (now - reviveStart >= REVIVE_MS) {
    cjUp(me, 60);
    try { showTextBox("AI partner revived you"); } catch (e) {}
    log("[ai] CJ revived");
  }
  return true;
}

let aiDown = false, aiDownAt = 0, holdStart = 0;
// returns true while the partner is down (the main loop then skips its AI)
function handlePartnerDown(me) {
  const now = Date.now();
  if (!aiDown) {
    const h = ped.getHealth();
    if (h > 0 && h < DOWN_AT) {
      aiDown = true; aiDownAt = now; holdStart = 0; chauffeur = null; action = "follow";
      if (ped.isInAnyCar()) { try { const p = ped.getCoordinates(); ped.warpFromCarToCoord(p.x + 2, p.y, p.z); } catch (e) {} }
      // no gun while down: the game's own combat AI kept him standing and shooting
      try { ped.removeAllWeapons(); } catch (e) {}
      knockDown(ped);
      log("[ai] partner down");
    }
    return false;
  }
  const left = (BLEED_OUT - (now - aiDownAt)) / 1000;
  banner("COOPAD2", left);
  // stay on the ground: if anything stood him up (combat AI, a bump), lay him down again
  try { if (!ped.isPlayingAnim("KO_skid_back")) knockDown(ped); } catch (e) {}
  if (left <= 0) { aiDown = false; try { ped.setProofs(false, false, false, false, false); ped.setHealth(0); } catch (e) {} return false; }
  if (!cjDown && !me.isInAnyCar() && d2(me.getCoordinates(), ped.getCoordinates()) < 2.5 * 2.5) {
    if (Pad.IsKeyPressed(KEY_E)) {
      if (!holdStart) holdStart = now;
      const pct = (now - holdStart) / REVIVE_MS * 100;
      banner("COOPAD3", Math.min(100, pct), 60);
      if (pct >= 100) {
        aiDown = false; holdStart = 0;
        standUp(ped, 120);
        try { ped.giveWeapon(WEAPON, AMMO); ped.setCurrentWeapon(WEAPON); } catch (e) {}
        try { showTextBox("You revived the AI partner"); } catch (e) {}
        log("[ai] partner revived");
      }
    } else { holdStart = 0; banner("COOPAD3", 0, 60); }
  } else holdStart = 0;
  return true;
}

while (true) {
  wait(0);
  if (!player.isPlaying()) continue;
  drawTag();
  const me = player.getChar();
  if (!aiEnabled()) { if (ped) { despawn(); try { showTextBox("AI partner off"); } catch (e) {} } continue; }

  if (ped && (!Char.DoesExist(ped) || ped.getHealth() <= 0)) {
    if (!deadAt) { deadAt = Date.now(); try { showTextBox("AI partner died. Back in 10 s"); } catch (e) {} }
    if (Date.now() - deadAt < 10000) continue;
    despawn(); deadAt = 0;
  }
  if (!ped) { spawn(me); continue; }
  try { if (ped.isGroupMember(player.getGroup())) ped.removeFromGroup(); } catch (e) {} // older builds put it there
  if (handlePartnerDown(me)) continue;
  // a real friend in the session: sa-coop does CJ's down/revive, not us (no double revive)
  if (!cjDown && friends() > 0) {} else if (handleDown(me)) continue;
  chauffeurKey(me);
  if (chauffeur) {
    if (!Car.DoesExist(chauffeur) || !me.isInAnyCar()) { chauffeur = null; action = "follow"; continue; }
    try {
      if (dest && d2(chauffeur.getCoordinates(), dest) < 25 * 25) {
        chauffeur.setCruiseSpeed(0); chauffeur.setMission(11); dest = null; showTextBox("AI: we are here");
      }
    } catch (e) {}
    continue;
  }
  // warp next to CJ only when running can't fix it: another interior (a cutscene or a door moved CJ), or more than
  // 120 m behind and out of sight. While you can see him, he runs (he used to warp at 40 m, even mid-run).
  let otherArea = false, seen = true;
  try { otherArea = ped.getAreaVisible() !== Streaming.GetAreaVisible(); } catch (e) {}
  try { const q = ped.getCoordinates(); q.z += 1.0; seen = toScreen(q) !== null; } catch (e) {}
  const far = d2(me.getCoordinates(), ped.getCoordinates());
  if (!me.isInAnyCar() && !ped.isInAnyCar() && (otherArea || (far > 120 * 120 && !seen) || far > 300 * 300)) {
    try {
      const p = me.getCoordinates();
      ped.setCoordinates(p.x + 1.5, p.y + 1.5, p.z);
      ped.setAreaVisible(Streaming.GetAreaVisible());
      log("[ai] warped next to CJ");
    } catch (e) { log(`[ai] warp: ${e}`); }
  }

  const now = Date.now();
  const foes = enemies(me);
  const sit = situation(me, foes);
  // ask when something changed, at most every 2.5 s, and at least every 8 s
  if ((sit !== lastSit && now - lastAsk > 2500) || now - lastAsk > 8000) {
    writeAscii(sit);
    if (aiAsk(buf)) { lastAsk = now; lastSit = sit; }
  }
  const r = aiResult();
  if (r >= 0 && r < ACTIONS.length) { if (ACTIONS[r] !== action) log(`[ai] Jev: ${ACTIONS[r]} (${sit})`); apply(ACTIONS[r], me, foes); }
  // a foe within 25 m and the partner on foot: shoot it, whatever Jev said last (Jev may still be thinking)
  if (foes.length && foes[0].dd < 625 && !ped.isInAnyCar() && action !== "attack" && action !== "take_cover") {
    apply("attack", me, foes);
  }
  // the target died: take the next one, or go back to following
  if (action === "attack") {
    let dead = true;
    try { dead = !target || !Char.DoesExist(target) || target.getHealth() <= 0; } catch (e) {}
    if (dead) { if (foes.length) apply("attack", me, foes); else apply("follow", me, foes); }
  }
  keepUp(me, now);
}
