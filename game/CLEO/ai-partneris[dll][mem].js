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
  while (takeTracked(2, out)) {
    const model = Memory.ReadI32(out + 4, false, false), h = Memory.ReadI32(out + 8, false, false);
    try { if (Char.DoesExist(h) && new Char(h).getModel() === model) new Char(h).delete(); } catch (e) {}
  }
  Memory.Free(out);
}
const buf = Memory.Allocate(512);

const MODEL = 106;          // a Grove Street member
const WEAPON = 30, AMMO = 600; // AK-47
const ACTIONS = ["follow", "enter_car", "attack", "take_cover", "wait"];
const SAY = { follow: "AI: following", enter_car: "AI: getting in", attack: "AI: attacking", take_cover: "AI: taking cover", wait: "AI: waiting" };
const CLEANUP = 0x53DB410; // mission cleanup list (Steam build 1.0.113.49697469): peds of the current mission

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
  ped = Char.Create(8, MODEL, p.x + 1.5, p.y + 1.5, p.z);
  try { trackFn(2, 2, MODEL, +ped); } catch (e) {}
  Streaming.MarkModelAsNoLongerNeeded(MODEL);
  try { ped.setHealth(200); } catch (e) {}
  try { ped.giveWeapon(WEAPON, AMMO); ped.setCurrentWeapon(WEAPON); } catch (e) {}
  // hate the rival gangs and cops-free hostiles, so the game's own combat AI shoots them too
  for (const t of RIVALS) try { ped.setRelationship(4, t); } catch (e) {}
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

// rival gangs: Ballas 7, Vagos 9, Rifa 10, Da Nang 11, Mafia 12, Triads 13, Aztecas 14 (Grove 8 is ours)
const RIVALS = [7, 9, 10, 11, 12, 13, 14];

// mission peds that are alive and within 60 m, plus rival gang members within 35 m
function enemies(me) {
  const p = me.getCoordinates(), out = [], seen = new Set();
  try {
    let first = true;
    for (let k = 0; k < 30; k++) {
      const c = World.GetRandomCharInSphereNoSaveRecursive(p.x, p.y, p.z, 35, !first, true);
      first = false;
      if (!c || +c <= 0 || seen.has(+c)) break;
      seen.add(+c);
      if (ped && +c === +ped) continue;
      if (!RIVALS.includes(c.getPedType()) || c.getHealth() <= 0) continue;
      out.push({ c, dd: d2(p, c.getCoordinates()) });
    }
  } catch (e) {}
  for (let i = 0; i < 75; i++) {
    const at = CLEANUP + i * 8;
    if (Memory.ReadU8(at, false, true) !== 2) continue;
    const h = Memory.ReadI32(at + 4, false, true);
    try {
      if (!Char.DoesExist(h)) continue;
      const c = new Char(h);
      if (ped && +c === +ped) continue;
      if (seen.has(+c)) continue;
      if (c.getHealth() <= 0) continue;
      // mission peds include allies (Sweet, Ryder, Big Smoke): skip CJ's group and Grove Street (ped type 8)
      try { if (c.isGroupMember(player.getGroup())) continue; } catch (e) {}
      try { if (c.getPedType() === 8) continue; } catch (e) {}
      const dd = d2(p, c.getCoordinates());
      if (dd < 3600) out.push({ c, dd });
    } catch (e) {}
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
    if (dd > 16) Task.GoStraightToCoord(ped, a.x, a.y, a.z, dd > 400 ? 7 : 6, 3000);
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
function toScreen(p) {
  const cam = Camera.GetActiveCoordinates(), at = Camera.GetActivePointAt();
  let fx = at.x - cam.x, fy = at.y - cam.y, fz = at.z - cam.z;
  const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  let rx = fy, ry = -fx; const rl = Math.sqrt(rx * rx + ry * ry) || 1; rx /= rl; ry /= rl;
  const ux = ry * fz, uy = -rx * fz, uz = rx * fy - ry * fx;
  const dx = p.x - cam.x, dy = p.y - cam.y, dz = p.z - cam.z;
  const depth = dx * fx + dy * fy + dz * fz;
  if (depth < 1 || depth > 80) return null;
  const tanX = Math.tan((Camera.GetFov() * Math.PI / 180) / 2), aspect = 16 / 9;
  const sx = 320 + ((dx * rx + dy * ry) / depth / tanX) * 320;
  const sy = 224 - ((dx * ux + dy * uy + dz * uz) / depth / (tanX / aspect)) * 224;
  return sx < 0 || sx > 640 || sy < 0 || sy > 448 ? null : { x: sx, y: sy };
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

let cjDown = false, cjDownAt = 0, reviveStart = 0;
function cjUp(me, health) {
  cjDown = false; reviveStart = 0;
  try { player.setControl(true); } catch (e) {}
  standUp(me, health);
}
function handleDown(me) {
  const now = Date.now();
  if (!cjDown) {
    const h = me.getHealth();
    if (h > 0 && h < DOWN_AT && !aiDown && ped.getHealth() > 0) {
      cjDown = true; cjDownAt = now; reviveStart = 0;
      if (me.isInAnyCar()) { try { const p = me.getCoordinates(); me.warpFromCarToCoord(p.x + 2, p.y, p.z); } catch (e) {} }
      try { player.setControl(false); } catch (e) {}
      knockDown(me);
      log("[ai] CJ down, partner coming");
    }
    return false;
  }
  banner("COOPAD1", (BLEED_OUT - (now - cjDownAt)) / 1000);
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
      knockDown(ped);
      log("[ai] partner down");
    }
    return false;
  }
  const left = (BLEED_OUT - (now - aiDownAt)) / 1000;
  banner("COOPAD2", left);
  if (left <= 0) { aiDown = false; try { ped.setProofs(false, false, false, false, false); ped.setHealth(0); } catch (e) {} return false; }
  if (!cjDown && !me.isInAnyCar() && d2(me.getCoordinates(), ped.getCoordinates()) < 2.5 * 2.5) {
    if (Pad.IsKeyPressed(KEY_E)) {
      if (!holdStart) holdStart = now;
      const pct = (now - holdStart) / REVIVE_MS * 100;
      banner("COOPAD3", Math.min(100, pct), 60);
      if (pct >= 100) {
        aiDown = false; holdStart = 0;
        standUp(ped, 120);
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
  // too far behind (e.g. CJ drove off alone): catch up next to CJ
  // or a cutscene / interior change moved CJ: warp next to CJ (40 m, and into CJ's interior)
  if (!me.isInAnyCar() && !ped.isInAnyCar() && d2(me.getCoordinates(), ped.getCoordinates()) > 40 * 40) {
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
