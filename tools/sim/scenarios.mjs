// What happens around the script while it runs: each scenario is a list of timed steps on a Sim (see mock.mjs).
// on(tick, fn) runs once, on(from, to, fn) every tick in [from, to). A tick is one wait() of the script (16 ms).
// Everything is seeded from inside the steps (tick 1 on), when the script's own tables (RVA, F, I...) can be read.
const X = 2495, Y = -1687, Z = 13.5; // where CJ stands
const KEY = { E: 69, F: 70, G: 71, J: 74 };
const scn = (id, title, ticks, build, extra) => ({ id, title, ticks, build, ...extra });

// ---- seeding the game memory the script reads (addresses come from the script's own RVA tables) -------------------
function seedCleanup(s, list) { // the mission cleanup list: [kind, handle] each (see ownMissionEntities)
  for (let i = 0; i < 75; i++) {
    const at = s.ib(s.rva.MRVA.cleanup + i * 8), e = list[i];
    s.mem.w('U8', at, e ? e[0] : 0); s.mem.w('I32', at + 4, e ? e[1] : 0);
  }
}
function seedMissionName(s, name) { // see missionName: the on-mission flag and the list of running scripts
  const R = s.rva.RVA, sc = 0x30000000000;
  s.mem.w('U32', s.ib(R.onMission), name ? 0x400 : 0);
  s.mem.w('I32', s.ib(R.scriptSpace + 0x400), name ? 1 : 0);
  s.mem.wptr(s.ib(R.activeScripts), sc);
  s.mem.wptr(sc, sc + 0x1000); s.mem.wstr(sc + 0x10, 'main'); s.mem.w('U8', sc + 0x12C, 0);
  s.mem.wptr(sc + 0x1000, 0); s.mem.wstr(sc + 0x1010, name || 'x'); s.mem.w('U8', sc + 0x112C, name ? 1 : 0);
}
function seedCut(s, name) { // a cutscene running in our own game (see tellWorld)
  s.mem.w('U8', s.ib(s.rva.RVA.cutRunning), name ? 1 : 0);
  s.mem.wstr(s.ib(s.rva.RVA.cutName), name || '');
}
function seedBrief(s, key, text, ms, wide) { // the mission line on screen (see storyTick, readBriefText)
  const b = s.ib(s.rva.SRVA.brief), at = 0x30000100000;
  s.mem.wstr(b, key);
  s.mem.wptr(b + 8, text ? at : key ? 1 : 0); // 1: something is shown, but its words cannot be read
  s.mem.w('U32', b + 0x14, ms);
  if (!text) return;
  if (wide) { for (let i = 0; i <= text.length; i++) s.mem.w('U16', at + i * 2, text.charCodeAt(i) || 0); }
  else s.mem.wstr(at, text);
}
function seedBlip(s, i, o) { // one entry of the radar list (see storyTick, iconsTick, blipIconTick)
  const e = s.ib(s.rva.SRVA.radar + i * 0x30);
  s.mem.w('U32', e, o.color || 0); s.mem.w('I32', e + 4, o.h || 0);
  s.mem.w('Float', e + 8, o.x || 0); s.mem.w('Float', e + 12, o.y || 0); s.mem.w('Float', e + 16, o.z || 0);
  s.mem.w('U8', e + 0x28, o.icon || 0); s.mem.w('U8', e + 0x29, o.off ? 0 : 2 | (o.close ? 4 : 0)); s.mem.w('U8', e + 0x2A, (o.kind << 2) | 1);
}
const nearMe = (s, dx = 3) => ({ x: s.me.x + dx, y: s.me.y, z: s.me.z });
const proxyOf = (s, map, h) => s.peek(`${map}.get(${h}) ? +${map}.get(${h}).ent : 0`) || 0; // the script's copy of a friend's entity

export const scenarios = [
  scn('y', 'coopnet64.asi is not there: the script must say so and exit', 10, (s) => { s.noLib = true; }, { roles: ['host'], expectExit: true }),
  scn('z', 'the DLL lacks one function: setup fails before the rest of the script has run', 10, (s) => { s.badProc = 'coop_flag'; }, { roles: ['host'], expectExit: true }),

  scn('a', 'alone, not connected', 1500, (s, on) => {
    s.status = 0; s.playing = false;
    const c = s.addCar({ model: 492 }), p = s.addChar({ model: 105 });
    s.leftovers = [[1, 492, c.h], [2, 105, p.h], [1, 400, 123456], [2, 106, p.h]]; // tracked by the previous run
    on(20, () => { s.playing = true; });
    on(60, () => { s.code = 'XK42Z'; });
    on(300, () => { s.status = 3; });
    on(400, () => { s.status = 2; });
    on(600, () => s.press(KEY.G));
    on(700, () => s.press(KEY.J));
    on(800, () => s.press(KEY.F));
    on(900, () => { s.ONMISSION = true; seedMissionName(s, 'intro1'); });
    on(1100, () => { s.ONMISSION = false; seedMissionName(s, ''); });
    on(1200, () => { s.skip(40000); s.latest = '9.9.9'; s.refused = 1; });
    on(1260, () => { s.refused = 2; s.skip(9000); });
    on(1400, () => { s.status = 0; });
  }),

  scn('b', 'friend on foot: walks, runs, shoots, changes look, leaves and comes back', 3000, (s, on) => {
    let saved;
    on(1, () => s.F({}));
    on(100, 500, () => { s.friend.x += 0.03; });
    on(500, 800, () => { s.friend.x += 0.07; s.friend.heading = 270; });
    on(800, 1000, () => { s.friend.y += 0.12; });
    on(1000, () => { s.friend.x += 50; });
    on(1050, () => s.F({ weapon: 22, flags: 1 }));
    on(1060, 1200, (k) => s.F({ flags: k % 40 < 20 ? 3 : 1 }));
    on(1200, () => s.F({ weapon: 30, flags: 2 }));
    on(1300, () => s.F({ weapon: 0, flags: 0 }));
    on(1350, () => { s.wanted = 1; s.F({ flags: 2 << 8 }); });
    on(1450, () => s.F({ flags: 0 }));
    on(1500, () => s.F({ flags: 3 << 16 }));        // another look
    on(1600, () => s.F({ clock: 100 }));
    on(1650, () => s.F({ clock: 5000 }));           // not a time of day
    on(1700, () => { saved = s.friend; s.friend = null; });
    on(2100, () => { s.friend = saved; });
    on(2200, () => s.skip(20000));
    on(2300, () => { s.me.weapon = 24; s.me.ammo.set(24, 50); });
    on(2310, 2330, () => s.me.ammo.set(24, s.me.ammo.get(24) - 1));
    on(2340, () => { s.me.shooting = true; });
    on(2350, () => { s.me.shooting = false; s.targeting = true; });
    on(2400, () => { s.slowModels = true; s.F({ weapon: 31, flags: 7 << 16 }); }); // a look and a gun whose models take long
    on(2500, () => s.deleteChar(s.copy()));        // the game removed the copy
    on(2600, () => { s.me.x = s.friend.x - 2; s.me.y = s.friend.y; });
    on(2800, () => s.skip(20000));
  }),

  scn('c', 'friend drives a car, gets out, gets back in, rides as a passenger; we ride with them', 3500, (s, on) => {
    const paint = (c2) => 1000 | (c2 << 16) | (1 << 24);
    let my, saved;
    on(1, () => { s.F({}); my = s.addCar({ model: 410, x: X - 4, y: Y, z: Z, colors: [3, 7] }); });
    on(100, () => s.F({ inCar: 1, carModel: 492, carHealth: paint(3), flags: 5 << 24, vy: 12, carSpeed: 12 }));
    on(100, 300, () => { s.friend.y += 0.2; });
    on(300, () => s.F({ vy: 0, carSpeed: 0, flags: (5 << 24) | 8 }));                    // burnout
    on(400, 500, () => { s.friend.x += 0.2; s.F({ qz: 0.7, qw: -0.7, flags: 5 << 24 }); }); // an old build: no velocity sent
    on(500, () => s.F({ inCar: 0, carModel: 0, carHealth: 0, flags: 0, qz: 0, qw: 1 }));
    on(600, 650, () => { s.friend.x += 0.05; });
    on(700, () => s.F({ inCar: 1, carModel: 492, carHealth: paint(3) }));                // back into the parked car
    on(800, () => s.F({ inCar: 0, carModel: 0 }));
    on(850, () => { s.friend.x += 200; });                                              // far from it: the parked car goes
    on(900, () => s.F({ inCar: 1, carModel: 596, carHealth: 1000 }));                   // flashing lights, none here
    on(950, () => { s.addCar({ model: 599, x: X + 500, y: Y, z: Z }); s.F({ carModel: 599 }); }); // ...one of the game's own exists
    on(1000, () => s.F({ carModel: 411 }));
    on(1100, () => s.F({ carModel: 522 }));
    on(1200, () => s.F({ inCar: 0, carModel: 0, ...nearMe(s) }));
    on(1300, () => s.seat(s.me.h, my.h));                                               // we drive our own car
    on(1320, () => { s.padState = 255; });
    on(1340, () => { s.padState = 0; });
    on(1400, () => s.F({ inCar: 2, carModel: s.mySlot, carHealth: 1 }));                // the friend in our back seat
    on(1500, () => s.unseat(s.me.h, X, Y, Z));                                          // we get out, they stay
    on(1550, () => s.F({ inCar: 0, carModel: 0, carHealth: 0 }));
    on(1560, () => { s.seat(s.me.h, my.h); s.F({ inCar: 2, carModel: s.mySlot, carHealth: 100 }); }); // on our trunk
    on(1600, () => s.F({ inCar: 0 }));
    on(1610, () => { s.seat(s.addChar({ model: 12 }).h, my.h, 1); s.F({ inCar: 2, carModel: s.mySlot, carHealth: 1 }); }); // seat taken
    on(1640, () => s.F({ inCar: 0 }));
    on(1650, () => { s.unseat(s.me.h, X, Y, Z); s.deleteCar(my.h); s.F({ inCar: 2, carModel: s.mySlot, carHealth: 0 }); }); // no car at all
    on(1700, () => s.F({ inCar: 1, carModel: 492, carHealth: paint(1), ...nearMe(s, 4) }));
    on(1750, () => s.press(KEY.G));                                                     // into their car
    on(1850, () => s.press(KEY.F));
    on(1880, () => s.press(KEY.G));
    on(1900, () => s.F({ inCar: 0, carModel: 0 }));                                     // they get out, we stay in
    on(1950, () => { s.friend.x += 300; });
    on(2000, () => { s.unseat(s.me.h, X, Y, Z); s.F({ inCar: 1, carModel: 522, ...nearMe(s) }); }); // a bike
    on(2050, () => s.press(KEY.G));
    on(2100, () => s.press(KEY.F));
    on(2120, () => { s.seat(s.addChar({ model: 13 }).h, s.copyCar(), 0); s.press(KEY.G); }); // its seat taken: we ride outside
    on(2200, () => s.press(KEY.F));
    on(2250, () => s.press(KEY.G));
    on(2300, () => s.deleteCar(s.copyCar()));                                           // the game removed the bike under us
    on(2400, () => s.F({ carModel: 411 }));
    on(2420, () => s.press(KEY.J));
    on(2440, () => { s.unseat(s.me.h, X, Y, Z); for (const seat of [0, 1, 2]) s.seat(s.addChar({ model: 14 }).h, s.copyCar(), seat); s.press(KEY.J); }); // their car is full
    on(2470, () => s.press(KEY.F));
    on(2500, () => s.F({ inCar: 0, carModel: 0 }));
    on(2520, () => { s.me.x = X - 100; });
    on(2530, () => s.press(KEY.J));
    on(2600, () => { const f = s.friend; s.addCar({ model: 404, x: f.x + 2, y: f.y, z: f.z }); s.F({ inCar: 1, carModel: 404, x: f.x + 2 }); }); // a car of our own game
    on(2700, () => s.F({ health: -1 }));                                                // down at the wheel
    on(2760, () => s.F({ health: 100 }));
    on(2800, () => { saved = s.friend; s.friend = null; });                             // gone, with a car
    on(3200, () => { s.friend = saved; });
    on(3300, () => s.skip(40000));
  }),

  scn('d', 'on a mission (ONMISSION, cleanup list in memory); the friend takes the wheel of the mission car', 3000, (s, on) => {
    let M, A, B, C, D;
    const long = 'Drive Sweet to the cemetery before the Ballas get there, and stay close to him when the shooting starts, he is the one they want. Do not lose the car on the way.';
    on(1, () => {
      s.F({});
      M = s.addCar({ model: 492, x: X + 8, y: Y + 4, z: Z });
      A = s.addChar({ model: 270, pedType: 8 }); s.seat(A.h, M.h, 0);
      B = s.addChar({ model: 105, x: X + 20, y: Y, z: Z, weapon: 22, shooting: true });
      C = s.addChar({ model: 106, x: X + 2, y: Y + 2, z: Z, inGroup: true });
      D = s.addChar({ model: 50, x: X + 30, y: Y, z: Z });
      s.mem.w('I16', s.ib(s.rva.RVA.newWeather), 3);
      s.mem.w('I32', s.ib(s.rva.MRVA.money), 1000);
      s.tag = { x: X + 3, y: Y, z: Z }; s.tagPct = 40;
      seedBlip(s, 0, { kind: 4, icon: 34, x: 2300, y: -1650, z: 13 });               // a mission's letter on the map
      seedBlip(s, 1, { kind: 4, icon: 20, close: true, x: 2400, y: -1700, z: 13 });  // a shop
      seedBlip(s, 2, { kind: 4, icon: 41, x: 2000, y: -1000, z: 13 });               // our own waypoint
    });
    on(50, () => {
      s.ONMISSION = true; seedMissionName(s, 'sweet1');
      seedCleanup(s, [[2, A.h], [2, B.h], [1, M.h], [2, C.h], [1, 99999], [3, 5], [2, 88888]]);
      seedBlip(s, 3, { kind: 4, x: 2200, y: -1500, z: 20, color: 2 });               // the objective: a place
      seedBlip(s, 4, { kind: 1, h: M.h }); seedBlip(s, 5, { kind: 2, h: B.h }); seedBlip(s, 6, { kind: 2, h: D.h });
      seedBlip(s, 7, { kind: 2, h: s.copy() });                                      // the friend's own blip
    });
    on(100, () => seedBrief(s, 'SWE1_A', 'Get in the car and drive to the cemetery.', 5000));
    on(200, () => s.F({ inCar: 1, carModel: 492, carHealth: 1000, x: M.x, y: M.y, z: M.z })); // at the wheel of OUR mission car
    on(260, () => s.ev(23, `${s.friendSlot}:${M.h}`));
    on(300, () => seedBrief(s, 'SWE1_B', long, 6000, true));
    on(400, 600, () => { s.friend.y += 0.2; s.friend.vy = 12; });
    on(500, () => seedBrief(s, '', '', 0));
    on(520, () => seedBrief(s, 'SWE1_C', '', 3000));
    on(560, () => s.ev(23, `${s.friendSlot}:0`));                                     // "not a mission car any more" while they drive it
    on(580, () => s.ev(23, `${s.friendSlot}:${M.h}`));
    on(600, () => s.F({ inCar: 0, carModel: 0, vy: 0 }));
    on(650, () => s.ev(23, `${s.friendSlot}:0`));
    on(690, () => s.ev(23, `${s.friendSlot}:${M.h}`));
    on(700, () => { s.seat(s.me.h, M.h); s.F({ inCar: 1, carModel: 492, x: M.x, y: M.y, z: M.z }); }); // we drive it: its wheel is not free
    on(800, () => { s.unseat(s.me.h, X, Y, Z); s.F({ inCar: 0, carModel: 0 }); });
    on(900, () => { s.cutOffset = { xOffset: 2500, yOffset: -1680, zOffset: 13 }; seedCut(s, 'sweet1a'); });
    on(1000, () => seedCut(s, 'sweet1b'));
    on(1100, () => { s.cutSkipped = true; seedCut(s, ''); });
    on(1140, () => { seedCut(s, 'sweet1c'); s.ev(30, '1'); });
    on(1170, () => seedCut(s, ''));
    on(1200, () => { s.ev(4, `${B.h}:30`); s.ev(13, `${(s.mySlot << 24) | B.h}:10`); s.ev(4, 'x'); s.mem.w('I16', s.ib(s.rva.RVA.newWeather), 8); });
    on(1300, () => { s.me.ammo.set(41, 500); s.me.ammo.set(22, 60); s.me.weapon = 41; });
    on(1350, () => { s.tagPct = 100; });
    on(1400, () => { B.health = 0; });
    on(1500, () => { M.health = 0; });
    on(1600, () => { s.friend.x += 300; });
    on(1900, () => { // passed
      s.mem.w('I32', s.ib(s.rva.MRVA.money), 1500); s.mem.wstr(s.ib(0x523A158), 'M_PASS');
      s.ONMISSION = false; seedMissionName(s, ''); seedCleanup(s, []);
    });
    on(2000, () => { s.ONMISSION = true; seedMissionName(s, 'ryder1'); });
    on(2100, () => { s.ONMISSION = false; seedMissionName(s, ''); });                 // failed: nothing paid
    on(2200, () => s.F(nearMe(s)));
    on(2300, () => s.skip(20000));
    on(2500, () => s.skip(70000));
  }),

  scn('e', 'receiving mission entities (peds on foot, peds in a car, cars), the list going silent and coming back', 3600, (s, on) => {
    let saved;
    const sweet = { h: 1281, kind: 2 | 4, model: 291, x: X + 5, y: Y + 3, z: Z, hp: 100 };        // a story character, on our side
    const enemy = { h: 1537, kind: 2, dead: 22 << 1, model: 105, x: X + 12, y: Y, z: Z, hp: 100 };
    const rider = { h: 1793, kind: 2 | 8, model: 106, x: X + 8, y: Y + 6, z: Z, hp: 100 };        // sits in the car below
    const car = { h: 2049, kind: 1, model: 492, x: X + 8, y: Y + 6, z: Z, heading: 90, hp: 1000 };
    const cop = { h: 2305, kind: 1, model: 596, x: X + 20, y: Y + 6, z: Z, hp: 1000 };            // flashing lights
    const corpse = { h: 2561, kind: 2, dead: 1, model: 107, x: X, y: Y + 9, z: Z, hp: 0 };
    const junk = { h: 2817, kind: 2, model: 500, x: X, y: Y, z: Z, hp: 100 };                     // not a ped model
    const all = [sweet, enemy, rider, car, cop, corpse, junk];
    on(1, () => s.F({}));
    on(50, () => s.ev(3, 'sweet1'));
    on(100, () => { s.ents = all; });
    on(150, 400, (k) => { enemy.x += 0.03; enemy.dead = (22 << 1) | (k % 60 < 30 ? 0x80 : 0); car.y += 0.2; rider.y += 0.2; sweet.heading = 200; });
    on(300, () => { enemy.x += 30; car.y += 40; rider.y += 40; });                     // jumps
    on(400, () => { const c = s.chars.get(proxyOf(s, 'proxies', 1537)); if (c) c.health -= 20; }); // we hit the copy
    on(500, () => { enemy.hp = 50; car.hp = 600; });
    on(600, () => { enemy.dead = 1; enemy.hp = 0; });
    on(700, () => { rider.kind = 2; rider.x += 2; });                                  // out of the car
    on(800, () => s.seat(s.me.h, proxyOf(s, 'proxies', 2049)));                        // we take the wheel of the mission car's copy
    on(900, () => s.unseat(s.me.h, X, Y, Z));
    on(950, () => s.F({ inCar: 1, carModel: 492, carHealth: 1000, x: car.x, y: car.y, z: car.z })); // the friend drives the car we show
    on(1000, 1100, () => { s.friend.y += 0.2; car.y += 0.2; });
    on(1100, () => s.F({ inCar: 0, carModel: 0 }));
    on(1200, () => { s.ents = all.filter((e) => e !== sweet); });                      // one left the list
    on(1300, () => { s.ents = -1; });                                                  // silent: the friend pressed ESC
    on(1500, () => { s.ents = all; rider.kind = 2 | 8; });
    on(1600, () => s.F({ inCar: 1, carModel: 492, x: car.x, y: car.y, z: car.z }));
    on(1650, () => { s.ents = -1; s.ev(3, ''); });                                     // the mission ended while they drive the copy
    on(1750, () => s.F({ inCar: 0, carModel: 0 }));
    on(1800, () => s.ev(3, 'noname'));
    on(1900, () => { s.ev(3, 'ryder1'); s.ents = all; enemy.dead = 0; enemy.hp = 100; });
    on(2000, () => { s.ents = -1; });
    on(2010, () => s.skip(181000));                                                    // silent for more than 3 minutes
    on(2100, () => { s.ents = all; });
    on(2200, () => { saved = s.friend; s.friend = null; s.ents = -1; });               // the friend is gone
    on(2600, () => { s.friend = saved; s.ents = all; });
    on(2700, () => { s.ents = []; });                                                  // an empty list
    on(2800, () => { s.ents = Array.from({ length: 40 }, (_, i) => ({ h: 4000 + i * 256, kind: i % 3 ? 2 : 1, model: i % 3 ? 100 + i : 400 + i, x: X + i, y: Y - 10, z: Z, hp: 100 })); });
    on(3000, () => { s.ONMISSION = true; });                                           // our own mission begins: the copies go (host)
    on(3100, () => { s.ONMISSION = false; });
    on(3300, () => s.skip(30000));
  }),

  scn('f', 'receiving world traffic and peds, then silence; our own pools for sending and clearing', 3600, (s, on) => {
    let saved, drivenByUs, ped, carD, parked;
    const T = (n) => ((s.friendSlot << 24) | n) >>> 0 | 0;                              // a friend's handle carries its slot
    const car1 = { h: T(513), kind: 1, c1: 3, c2: 4, flags: 1, model: 410, drv: 12, x: X + 15, y: Y + 10, z: Z, vy: 8, hp: 1000 };
    const still = { h: T(769), kind: 1, c1: 1, c2: 1, model: 492, x: X - 6, y: Y + 6, z: Z, hp: 1000 }; // parked; our own stands there too
    const walker = { h: T(1025), kind: 2, model: 15, x: X + 6, y: Y - 5, z: Z, vx: 1.2, hp: 100 };
    const gunman = { h: T(1281), kind: 2, c1: 22, flags: 2, model: 30, x: X + 9, y: Y - 8, z: Z, hp: 100 };
    const police = { h: T(1537), kind: 1, flags: 1, model: 596, drv: 281, x: X + 25, y: Y, z: Z, hp: 1000 };
    const train = { h: T(1793), kind: 1, model: 449, x: X, y: Y + 30, z: Z, hp: 1000 };
    const wreck = { h: T(2049), kind: 1, model: 411, x: X, y: Y + 20, z: Z, hp: 0 };
    const farOff = { h: T(2305), kind: 2, model: 20, x: 9999, y: 0, z: 0, hp: 100 };
    const broken = { h: T(2561), kind: 2, model: 21, x: NaN, y: Y, z: Z, hp: 100 };
    const odd = { h: T(2817), kind: 3, model: 22, x: X, y: Y, z: Z, hp: 100 };
    const all = [car1, still, walker, gunman, police, train, wreck, farOff, broken, odd];
    on(1, () => {
      s.F({ x: X + 20, y: Y, z: Z });
      s.poolsOn = true;
      // the game's own people and traffic around us
      s.addChar({ model: 10, x: X + 4, y: Y + 4, z: Z, vel: { x: 1, y: 0, z: 0 } });
      ped = s.addChar({ model: 20, x: X - 4, y: Y - 4, z: Z, weapon: 22, shooting: true });
      s.addChar({ model: 281, x: X + 5, y: Y - 9, z: Z });                               // a policeman on foot
      s.addChar({ model: 106, x: X + 1, y: Y + 1, z: Z, inGroup: true });                // one of CJ's gang
      carD = s.addCar({ model: 410, x: X + 10, y: Y - 12, z: Z }); s.seat(s.addChar({ model: 14 }).h, carD.h);
      const cop = s.addCar({ model: 596, x: X - 12, y: Y - 12, z: Z }); s.seat(s.addChar({ model: 281 }).h, cop.h);
      parked = s.addCar({ model: 492, x: X - 6, y: Y + 6, z: Z });
      s.addCar({ model: 449, x: X, y: Y + 40, z: Z });                                   // the tram
    });
    on(50, () => { s.worldEnts = all; });
    on(50, 600, () => { car1.y += 0.13; walker.x += 0.02; gunman.flags = s.tick % 80 < 40 ? 2 : 0; });
    on(400, () => { car1.y += 30; walker.x += 10; });                                  // jumps
    on(600, () => { walker.hp = 40; const c = s.chars.get(proxyOf(s, 'worldProxies', gunman.h)); if (c) c.health -= 30; });
    on(700, () => { walker.hp = 0; });
    on(750, () => { car1.hp = 0; });
    on(790, () => { car1.hp = 1000; });
    on(800, () => { drivenByUs = proxyOf(s, 'worldProxies', police.h) || proxyOf(s, 'worldProxies', car1.h); s.seat(s.me.h, drivenByUs); }); // we drive off in a copy
    on(900, () => { s.unseat(s.me.h, X, Y, Z); s.F({ inCar: 1, carModel: 492, carHealth: 1000, x: still.x, y: still.y, z: still.z }); }); // the friend drives a car of their traffic we show
    on(1000, () => s.F({ inCar: 0, carModel: 0, x: X + 20, y: Y, z: Z }));
    on(1050, () => { // events about our own world
      const mine = (h) => ((s.mySlot << 24) | h) >>> 0 | 0;
      s.ev(13, `${mine(ped.h)}:25`); s.ev(14, `${mine(carD.h)}`); s.ev(14, `${mine(s.me.h)}`); s.ev(13, `${((s.friendSlot ^ 3) << 24) | 5}:10`); s.ev(13, 'x:y'); s.ev(14, `${mine(parked.h)}`);
    });
    on(1200, () => { s.worldEnts = []; });                                             // silent: the friend pressed ESC
    on(1320, () => { s.worldEnts = all; });
    on(1400, () => { s.worldEnts = []; });
    on(1410, () => s.skip(181000));                                                    // ...for more than 3 minutes
    on(1500, () => { s.worldEnts = all; });
    on(1600, () => { s.me.area = 5; s.areaShown = 5; });                               // we go indoors
    on(1700, () => { s.me.area = 0; s.areaShown = 0; });
    on(1800, () => { s.friend.x += 400; });                                            // the friend is far away
    on(1900, () => { s.friend.x -= 400; });
    on(2000, () => s.F({ interior: 3 }));
    on(2050, () => { s.worldEnts = []; });
    on(2100, () => { s.F({ interior: 0 }); s.worldEnts = all; });
    on(2200, () => { s.worldEnts = Array.from({ length: 240 }, (_, i) => ({ h: T(8000 + i * 256), kind: i % 2 ? 2 : 1, flags: i % 4 ? 0 : 1, drv: 40 + i % 100, model: i % 2 ? 9 + (i % 250) : 400 + (i % 200), x: X + (i % 20) * 4, y: Y + 15 + (i >> 4) * 4, z: Z, hp: 100 })); });
    on(2300, () => { s.worldEnts = all; });
    on(2400, () => { saved = s.friend; s.friend = null; });                            // the friend leaves
    on(2800, () => { s.friend = saved; });
    on(2900, () => s.skip(12000));
    on(3200, () => { s.ONMISSION = true; seedCleanup(s, [[1, carD.h], [2, ped.h]]); }); // our mission's things are not traffic
  }),

  scn('g', 'every event the script hears, once each, with plausible and with broken text', 4200, (s, on) => {
    const cutAt = (t, name, during) => {
      on(t, () => s.ev(2, `${name}|1|${X}|${Y}|${Z}`));
      for (const [dt, kind, text] of during || []) on(t + dt, () => s.ev(kind, text));
    };
    let my;
    on(1, () => { s.F({}); my = s.addCar({ model: 410, x: X - 4, y: Y, z: Z }); s.cutSkipped = true; });
    on(40, () => { s.ev(1, '5'); s.ev(1, '99'); s.ev(1, 'x'); });
    on(60, () => { s.ev(3, 'sweet1'); });
    cutAt(100, 'sweet1a', [[30, 22, 'E:a`line`of`the`friend'], [40, 29, 'said`while`it`plays']]);  // plays to its end; we "skip" it
    cutAt(400, 'sweet1b', [[50, 28, '1']]);                                                       // skipped in the friend's game
    cutAt(700, 'sweet2a', [[50, 2, `sweet2b|0|${X}|${Y}|${Z}`], [120, 28, '0']]);                 // the next one begins while it plays
    on(1090, () => s.seat(s.me.h, my.h));
    cutAt(1100, 'ryder1a');                                                                       // while we sit in a car
    on(1290, () => { s.cutLoadDelay = 1e9; });
    cutAt(1300, 'ryder1b');                                                                       // never loads
    on(1790, () => { s.cutLoadDelay = 10; s.nativeRefuse = true; });
    cutAt(1800, 'ryder2a');                                                                       // the game's thread does not take the start
    on(1890, () => { s.nativeRefuse = false; s.cutLoadDelay = 30; });
    cutAt(1900, 'ryder2b', [[10, 28, '0']]);                                                      // over there before it loaded here
    on(2080, () => { s.cutLoadDelay = 10; s.cutSkipped = false; });
    on(2100, () => { s.ev(2, 'x|0|0|0|0'); s.ev(2, 'bad name!|0|0|0|0'); s.ev(2, ''); });
    cutAt(2110, 'sweet3a|999|a|b|c');                                                             // no place given
    on(2390, () => { s.ONMISSION = true; });
    cutAt(2400, 'sweet3b');                                                                       // while we are on a mission
    on(2420, () => { s.ONMISSION = false; });
    on(2440, () => s.ev(28, '0'));                                                                // cut-end with nothing playing
    on(2460, () => { s.ev(3, 'noname'); s.ev(3, ''); s.ev(3, 'sweet2'); });
    on(2480, () => { s.ev(4, '257:30'); s.ev(4, 'x'); });
    on(2500, () => { s.ev(5, '250'); s.ev(5, '0'); s.ev(5, '-5'); s.ev(5, 'x'); });               // mission passed, with and without money
    on(2520, () => { s.ev(6, 'SWE1_A:4000'); s.ev(6, 'bad key!:x'); s.ev(6, ''); });
    on(2540, () => { s.ev(7, '2500,-1680,13.0,2,1;2400,-1600,14.5,12,0;x,y,z,1,1'); });
    on(2560, () => { s.ev(7, '-'); });
    on(2580, () => { s.ev(8, 'ff=1;rev=45'); s.ev(8, 'ff=0;rev=5'); s.ev(8, 'nonsense'); });
    on(2600, () => { s.ev(9, `${s.mySlot}:30`); s.ev(9, `${s.friendSlot}:30`); s.ev(9, 'x:y'); });
    on(2620, () => { s.ev(10, '500,600,700,800,900,100,200,300,400,500,600,700,800,900,100,200,300'); s.ev(10, '1,2,3'); s.ev(10, 'a,b'); });
    on(2640, () => { s.ev(13, `${(s.mySlot << 24) | 9999}:10`); s.ev(14, `${(s.mySlot << 24) | 9999}`); s.ev(13, ''); });
    on(2660, () => { s.ev(15, '4000|Get`in`the`car,`CJ'); s.ev(16, '`and`drive'); s.ev(15, 'no bar'); });
    on(2680, () => { s.ev(20, 'Load`the`save`in`slot`8'); });
    on(2700, () => { s.ev(21, '9.9.9'); });
    on(2710, () => { s.skip(61000); s.ev(21, '0.0.1'); s.ev(21, 'abc'); s.ev(21, s.peek('VERSION')); });
    on(2720, () => { s.ev(22, 'E:something`went`wrong'); s.ev(22, 'S:v0.9.13`host`copies=0'); });
    on(2740, () => { s.ev(23, `${s.friendSlot}:0`); s.ev(23, 'x'); s.ev(23, '7:1'); });
    on(2760, () => { s.ev(24, '12.50'); });
    on(2780, () => { s.ev(24, '55.10'); s.ev(24, 'x'); });
    on(2790, () => { s.skip(181000); s.ev(24, '60.00'); });
    on(2800, () => { s.ev(25, '41:500,22:100,99:1,x'); });
    on(2830, () => { s.slowModels = true; s.ev(25, '31:300'); });
    on(2860, () => { s.ev(25, '-'); });
    on(2880, () => { s.ev(26, '2500:-1680'); s.ev(26, 'x:y'); s.ev(26, '99999:0'); });
    on(2900, () => { s.ev(27, '2300.0,-1650.0,13.0,34;2000.0,-1000.0,13.0,12;x,y,z,1;1,2,3,99'); });
    on(2905, () => { seedBlip(s, 0, { kind: 4, icon: 34, x: 2300, y: -1650, z: 13 }); s.ev(27, '2300.0,-1650.0,13.0,34;2100.0,-1000.0,13.0,13'); }); // one is on our map already
    on(2920, () => { s.ev(27, '-'); });
    on(2940, () => { s.ev(29, 'both`of`you`must`be`at`the`marker'); });
    on(2960, () => { s.ev(30, '1'); });
    on(2970, () => { seedCut(s, 'intro1a'); s.ev(30, '1'); });
    on(2990, () => seedCut(s, ''));
    on(3000, () => { s.ev(99, 'a kind nobody knows'); s.ev(11, ''); s.ev(12, ''); s.ev(17, ''); s.ev(18, ''); s.ev(19, ''); });
    on(3020, () => { s.ev(1, 'x'.repeat(126)); });
    on(3100, () => { s.F({ health: -1 }); });
    on(3200, () => s.skip(40000));
    on(3300, () => { for (let i = 0; i < 700; i++) s.ev(22, 'flood`' + i); });                    // more than the deferred queue holds
    cutAt(3310, 'cesar1a');
    on(3900, () => s.skip(40000));
  }),

  scn('h', 'own health: down below the mark, revived, bled out, health 0; the friend down and revived; friendly fire', 3600, (s, on) => {
    let saved, my;
    on(1, () => { s.F({}); s.settings = [0, 10]; s.ev(8, 'ff=0;rev=10'); my = s.addCar({ model: 410, x: X - 4, y: Y, z: Z }); });
    on(100, () => { s.me.health = 30; });                                              // down
    on(200, () => { s.revived = 1; });                                                 // the friend revived us
    on(450, () => { s.seat(s.me.h, my.h); s.me.health = 20; });                        // down in a car
    on(1200, () => { s.me.health = 100; });                                            // bled out (10 s) and back from hospital
    on(1300, () => { s.me.health = 0; });                                              // killed outright, on foot
    on(1350, () => { s.me.health = 100; s.seat(s.me.h, my.h); });
    on(1400, () => { s.me.health = 0; });                                              // ...and in a car
    on(1450, () => { s.me.health = 100; });
    on(1500, () => s.unseat(s.me.h, X, Y, Z));                                         // just out of a car
    on(1560, () => { s.me.health = 39; s.ONMISSION = true; });
    on(1600, () => { saved = s.friend; s.friend = null; });                            // down, and the friend leaves
    on(2000, () => { s.friend = saved; s.me.health = 100; s.ONMISSION = false; });
    on(2050, () => s.F({ health: -1, ...nearMe(s, 1) }));                              // the friend is down next to us
    on(2100, 2320, () => s.press(KEY.E));                                              // E held for 3 s
    on(2350, () => s.F({ health: 100 }));
    on(2400, () => s.F({ health: -1, x: s.me.x + 30 }));                               // down far away
    on(2450, () => s.F({ health: 100, inCar: 1, carModel: 411, carHealth: 1000 }));
    on(2500, () => s.F({ health: -1 }));                                               // down at the wheel
    on(2550, () => s.F({ health: 80, inCar: 0, carModel: 0, ...nearMe(s, 2) }));
    on(2600, () => { s.settings = [1, 30]; s.ev(8, 'ff=1;rev=30'); });                 // friendly fire on
    on(2650, () => { const c = s.chars.get(s.copy()); if (c) { c.health = 900; c.hitByPlayer = true; } }); // we hit their copy
    on(2700, () => { s.ev(9, `${s.mySlot}:50`); s.ev(9, `${s.mySlot}:300`); s.ev(9, `${s.friendSlot}:50`); }); // they hit us
    on(2800, () => { s.revived = 1; });
    on(2900, () => { s.settings = [0, 30]; s.ev(8, 'ff=0;rev=30'); });
    on(3000, () => { s.me.health = 10; });
    on(3020, () => s.ev(2, `sweet1a|0|${X}|${Y}|${Z}`));                               // a cutscene while we are down
    on(3060, () => s.press(KEY.G));
    on(3080, () => s.press(KEY.J));
    on(3100, () => { s.revived = 1; });
    on(3300, () => s.skip(40000));
  }),

  scn('i', 'the friend goes indoors (interior not 0) and comes back; doors followed, J', 3000, (s, on) => {
    const door = { x: X + 25, y: Y, z: Z }, room = { x: 372, y: -131, z: 1001 };
    let my;
    on(1, () => { s.F({}); my = s.addCar({ model: 410, x: X - 4, y: Y, z: Z }); });
    on(100, () => s.F(door));
    on(150, () => s.F({ ...room, interior: 5 }));                                      // inside: the door is where they last stood
    on(300, () => { s.me.x = door.x - 1; });                                           // we stand at the door for 3 s
    on(600, () => s.F({ ...door, interior: 0 }));                                      // they come out, we are inside
    on(700, () => s.press(KEY.J));
    on(800, () => { s.F({ ...room, interior: 5 }); s.seat(s.me.h, my.h); });           // we sit in a car at the door
    on(900, () => { s.unseat(s.me.h, room.x + 1, room.y, room.z); s.me.area = 5; s.areaShown = 5; }); // in by the game's own door
    on(1000, () => { Object.assign(s.me, door); s.me.area = 0; s.areaShown = 0; });    // out again, right at the door
    on(1300, () => { s.me.x = door.x - 20; });
    on(1350, () => { s.me.x = door.x - 1; });
    on(1700, () => { s.F({ ...nearMe(s), interior: 0 }); s.me.area = 0; s.areaShown = 1; }); // the shown area left wrong
    on(1800, () => { seedCut(s, 'intro1a'); s.areaShown = 2; });
    on(1830, () => seedCut(s, ''));
    on(2100, () => s.F({ inCar: 1, carModel: 411, carHealth: 1000 }));
    on(2150, () => s.F({ interior: 2 }));                                              // drives into a garage
    on(2200, () => { s.seat(s.me.h, my.h); s.press(KEY.J); });                         // J from our car
    on(2300, () => s.F({ health: -1 }));                                               // down indoors
    on(2400, () => s.F({ health: 100, inCar: 0, carModel: 0, interior: 0 }));
    on(2500, () => { s.me.area = 3; s.areaShown = 3; });                               // we are inside, they are not
    on(2700, () => s.skip(40000));
  }),
];
