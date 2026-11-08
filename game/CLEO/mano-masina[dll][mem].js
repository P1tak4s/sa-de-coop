/// <reference path=".config/sa.d.ts" />
// Your car: the last car you drove stays in the world, gets a map blip while you are out of it, and is put back
// where you left it after a save/load (coopnet64.asi keeps it in %LOCALAPPDATA%\sa-de-coop\mano-masina.bin).
// Taking another car moves the mark to it; a wrecked car is forgotten; mission cars are left alone.

let lib;
for (const path of ["coopnet64.asi", "../coopnet64.asi"]) { lib = DynamicLibrary.Load(path); if (lib) break; }
const store = lib ? Memory.Fn.X64(lib.getProcedure("coop_car_store")) : null;
const load = lib ? Memory.Fn.X64(lib.getProcedure("coop_car_load")) : null;
const rec = Memory.Allocate(28);

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

function restore() {
  if (!load || !load(rec)) return;
  const model = Memory.ReadI32(rec, false, false);
  const x = Memory.ReadFloat(rec + 4, false, false), y = Memory.ReadFloat(rec + 8, false, false), z = Memory.ReadFloat(rec + 12, false, false);
  try {
    Streaming.RequestModel(model);
    Streaming.LoadAllModelsNow();
    for (let i = 0; i < 40 && !Streaming.HasModelLoaded(model); i++) wait(25);
    const car = Car.Create(model, x, y, z);
    Streaming.MarkModelAsNoLongerNeeded(model);
    car.setHeading(Memory.ReadFloat(rec + 16, false, false));
    car.changeColor(Memory.ReadI32(rec + 20, false, false), Memory.ReadI32(rec + 24, false, false));
    car.setAsMissionCar();
    mine = car;
    log(`[mano-masina] put back car ${model} at ${x.toFixed(0)} ${y.toFixed(0)}`);
  } catch (e) { log(`[mano-masina] restore: ${e}`); }
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

  if (!restored) { restored = true; if (!ONMISSION) restore(); }

  if (me.isInAnyCar()) {
    // storeCarIsIn returns -1 on the Definitive Edition; take the car and make it a mission car ourselves
    const car = me.storeCarIsInNoSave();
    // during a mission the car may belong to the mission: releasing it later could delete it and break the mission
    if (+car > 0 && !ONMISSION && (!mine || +car !== +mine)) {
      letGo();
      mine = car;
      try { mine.setAsMissionCar(); } catch (e) { log(`[mano-masina] setAsMissionCar failed: ${e}`); }
      log(`[mano-masina] keeping car ${+car}`);
    }
    wasIn = mine && +car === +mine;
    dropBlip(); // no blip while driving
    continue;
  }

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
