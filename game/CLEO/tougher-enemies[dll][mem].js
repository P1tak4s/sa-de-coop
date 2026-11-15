/// <reference path=".config/sa.d.ts" />
// Tougher enemies (a mod setting: installer or the co-op menu's Settings tab, works at once): armed enemies around
// you aim better, shoot more often and take more hits. Grove Street, cops, civilians, your AI partner and your
// friends' copies are left alone.
let lib;
for (const path of ["coopnet64.asi", "../coopnet64.asi"]) { lib = DynamicLibrary.Load(path); if (lib) break; }
if (!lib) exit("coopnet64.asi not found");
const setting = Memory.Fn.X64(lib.getProcedure("coop_setting"));
const RADIUS = 50;
const SKIP_TYPES = [4, 5, 6, 8, 24]; // civilians, cops, Grove Street, mission-1 (the AI partner)
// F9, Settings, Enemies: 1 = tougher, 2 = hard (they aim like marksmen, wear armour, take about three times the
// hits and are not dropped by one lucky headshot)
const LEVELS = {
  1: { accuracy: 75, rate: 85, hpX: 1.5, hpMax: 250, armour: 0, radius: 50, noCrit: false },
  2: { accuracy: 92, rate: 100, hpX: 2.2, hpMax: 400, armour: 100, radius: 80, noCrit: true },
};
const player = new Player(0);
const done = new Map(); // handle -> the level it got
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

log("[tougher-enemies] on");

while (true) {
  wait(1000);
  const level = setting(2);
  const L = LEVELS[level];
  if (!player.isPlaying() || !L) continue;
  try {
    const me = player.getChar(), p = me.getCoordinates();
    for (const c of nearbyPeds(p, L.radius)) {
      if (+c === +me || (done.get(+c) || 0) >= level) continue;
      try {
        if (c.getHealth() <= 0 || SKIP_TYPES.includes(c.getPedType())) continue;
        if (c.isGroupMember(player.getGroup())) continue;
        if (c.getCurrentWeapon() === 0) continue; // fists only: not a gunman
        c.setAccuracy(L.accuracy).setShootRate(L.rate);
        c.setHealth(Math.min(L.hpMax, Math.round(c.getHealth() * L.hpX)));
        if (L.armour) { try { c.addArmor(L.armour); } catch (e) {} }
        if (L.noCrit) { try { c.setSuffersCriticalHits(false); } catch (e) {} }
        done.set(+c, level);
      } catch (e) {}
    }
    if (done.size > 500) done.clear(); // handles are reused; forget old ones now and then
  } catch (e) { log(`[tougher-enemies] ${e}`); }
}
