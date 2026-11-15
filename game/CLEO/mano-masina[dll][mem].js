/// <reference path=".config/sa.d.ts" />
// Your car: the last car you drove stays in the world, gets a map blip while you are out of it, and is put back
// where you left it after a save/load (coopnet64.asi keeps it in %LOCALAPPDATA%\sa-de-coop\mano-masina.bin).
// Taking another car moves the mark to it; a wrecked car is forgotten; mission cars are left alone.

let lib;
for (const path of ["coopnet64.asi", "../coopnet64.asi"]) { lib = DynamicLibrary.Load(path); if (lib) break; }
const store = lib ? Memory.Fn.X64(lib.getProcedure("coop_car_store")) : null;
const load = lib ? Memory.Fn.X64(lib.getProcedure("coop_car_load")) : null;
const rec = Memory.Allocate(28);
let trackedFn = null;
try { trackedFn = lib ? Memory.Fn.X64(lib.getProcedure("coop_tracked")) : null; } catch (e) {}
// a car the co-op script made (a friend's car, a copy of the host's traffic): never ours to keep
function coopCar(car) { try { return trackedFn ? trackedFn(+car) === 1 : false; } catch (e) { return false; } }
// another car of this model near a point (not `not`): the game or a mission has put its own one there
function twinNear(model, x, y, z, radius, not) {
  for (let i = 0; i < 8; i++) {
    try {
      const c = World.GetRandomCarInSphereNoSave(x, y, z, radius, model);
      if (c && +c > 0 && Car.DoesExist(+c) && (!not || +c !== +not)) return c;
    } catch (e) { return null; }
  }
  return null;
}
let missionWas = false;

const player = new Player(0);
let mine = null;   // the car we keep
let blip = null;   // its blip while we are on foot
let restored = false;

function exists(car) {
  try { return car && Car.DoesExist(car) && car.getHealth() > 0; } catch (e) { return false; }
}

function dropBlip() {
  if (blip) { try { blip.remove(); } catch (e) {} blip = null; }
}

function letGo() {
  dropBlip();
  if (mine) { try { if (Car.DoesExist(mine)) mine.markAsNoLongerNeeded(); } catch (e) {} mine = null; }
}

function remember(car) {
  if (!store) return;
  try {
    const c = car.getCoordinates(), col = car.getColors();
    Memory.WriteI32(rec, car.getModel(), false, false);
    Memory.WriteFloat(rec + 4, c.x, false, false);
    Memory.WriteFloat(rec + 8, c.y, false, false);
    Memory.WriteFloat(rec + 12, c.z, false, false);
    Memory.WriteFloat(rec + 16, car.getHeading(), false, false);
    Memory.WriteI32(rec + 20, col.color1, false, false);
    Memory.WriteI32(rec + 24, col.color2, false, false);
    store(rec);
  } catch (e) { log(`[mano-masina] remember: ${e}`); }
}

// true when done (or nothing to do); false = the model is still loading, call again
let restoreAskedAt = 0;
function restore() {
  if (!load || !load(rec)) return true;
  const model = Memory.ReadI32(rec, false, false);
  // never LOAD_ALL_MODELS_NOW from a script: it crashes the Definitive Edition (see sa-coop). Ask, come back later.
  if (!Streaming.HasModelLoaded(model)) {
    if (Date.now() - restoreAskedAt > 3000) { restoreAskedAt = Date.now(); try { Streaming.RequestModel(model); } catch (e) { return true; } }
    return false;
  }
  const x = Memory.ReadFloat(rec + 4, false, false), y = Memory.ReadFloat(rec + 8, false, false), z = Memory.ReadFloat(rec + 12, false, false);
  try {
    // the same car is already standing there (the game kept it, or a mission brought one): keep that one. A second
    // one on top of it was the "two cars when the mission starts" of 11-15.
    const twin = twinNear(model, x, y, z, 15, null);
    if (twin) {
      mine = twin;
      try { mine.setAsMissionCar(); } catch (e) {}
      log(`[mano-masina] car ${model} is already there, keeping that one`);
      return true;
    }
    const car = Car.Create(model, x, y, z);
    Streaming.MarkModelAsNoLongerNeeded(model);
    car.setHeading(Memory.ReadFloat(rec + 16, false, false));
    car.changeColor(Memory.ReadI32(rec + 20, false, false), Memory.ReadI32(rec + 24, false, false));
    car.setAsMissionCar();
    mine = car;
    log(`[mano-masina] put back car ${model} at ${x.toFixed(0)} ${y.toFixed(0)}`);
  } catch (e) { log(`[mano-masina] restore: ${e}`); }
  return true;
}

log("[mano-masina] ready");
let wasIn = false;

while (true) {
  wait(250);
  let me;
  try {
    if (!player.isPlaying()) continue;
    me = player.getChar();
  } catch (e) { continue; }

  if (!restored) { restored = ONMISSION || restore(); }

  if (me.isInAnyCar()) {
    // storeCarIsIn returns -1 on the Definitive Edition; take the car and make it a mission car ourselves
    const car = me.storeCarIsInNoSave();
    // during a mission the car may belong to the mission: releasing it later could delete it and break the mission
    // only a car we drive ourselves, and never one of the co-op script's (riding in a friend's car used to make
    // it "ours", and it came back as a second car after the next load)
    let driving = false;
    try { const d = car.getDriver(); driving = !!d && +d === +me; } catch (e) {}
    if (+car > 0 && !ONMISSION && driving && !coopCar(car) && (!mine || +car !== +mine)) {
      letGo();
      mine = car;
      try { mine.setAsMissionCar(); } catch (e) { log(`[mano-masina] setAsMissionCar failed: ${e}`); }
      log(`[mano-masina] keeping car ${+car}`);
    }
    wasIn = mine && +car === +mine;
    dropBlip(); // no blip while driving
    continue;
  }

  // a mission has just started and brought its own car of the same kind next to ours: ours goes
  if (ONMISSION && !missionWas && mine && exists(mine)) {
    try {
      const c = mine.getCoordinates();
      if (twinNear(mine.getModel(), c.x, c.y, c.z, 30, mine)) {
        log("[mano-masina] the mission brought the same car: ours removed");
        dropBlip();
        mine.delete();
        mine = null;
        if (store) store(0);
      }
    } catch (e) { log(`[mano-masina] mission start: ${e}`); }
  }
  missionWas = !!ONMISSION;
  if (mine && !exists(mine)) {
    log("[mano-masina] car wrecked or gone, letting go");
    letGo();
    if (store) store(0); // forget it
    continue;
  }
  if (mine && wasIn) { remember(mine); wasIn = false; } // just got out: this is where it stays
  if (mine && !blip) {
    try { blip = Blip.AddForCar(mine); } catch (e) { log(`[mano-masina] blip failed: ${e}`); }
  }
}
