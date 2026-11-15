# SA Co-op: what works and what is left

How a session works: the story runs in the **host's** game. The guest's game shows copies of the host's mission
people and cars, the host's traffic and police, the mission's texts, cutscenes and objective markers, and sends the
guest's actions back. Status as of 0.9.36 (15 Nov 2026).

Legend:
- `[x]` works, seen in a real two-player test
- `[~]` built, not yet confirmed in a real test
- `[ ]` not done

## Sessions and installer

- [x] Steam lobby or short code, two players
- [x] Installer with self-update (`SA-Coop.exe`), version check in the game
- [x] The host's save sent to the guest
- [x] One log for both games (the friend's lines appear as `[friend] ...`)
- [~] A crash report reaches the shared log on the next start (0.9.24)
- [~] Co-op entry in the pause menu (0.9.23); F9 always works
- [x] F9 window: create, join, settings (car handling, gun range, graphics, DLSS)
- [~] Enemies: Normal / Tougher / Hard (0.9.23)
- [~] Look: how your friend sees you, 14 characters (0.9.19)

## Players

- [x] Friend shown with name tag and map icon
- [~] Friend's map icon: CJ head on foot, car while driving (0.9.13)
- [x] Walking, running, shooting shown
- [x] Down instead of dead, revive by holding E
- [ ] Down instead of dead after one big hit (explosion, fall): the game kills at once
- [ ] Mission failed only when both are down
- [x] Riding as a passenger in a friend's car
- [~] No crash when a third person gets into a two-seat car (0.9.35)
- [~] J: jump to your friend; never hangs you on a car's outside (0.9.29)
- [x] Skills shared (the higher one is kept)
- [x] Wanted level shared
- [~] Max health shared (the higher one is kept) (0.9.36)
- [ ] Breath bar, other stats
- [ ] Idle animations
- [ ] Parachute
- [ ] Hydraulics
- [~] Radio: a passenger hears the driver's station (0.9.36)

## World

- [x] One world: the guest sees the host's people, traffic and police
- [x] Damage the guest does goes to the host's game
- [~] People and cars vanishing when the friend crashes into them: logged since 0.9.26, cause not found yet
- [~] Trains: the host's trains near the guest (0.9.38)
- [ ] Fire
- [ ] Pickups
- [ ] Gang wars
- [ ] Unique stunt jumps
- [ ] Cheat codes
- [ ] Property purchases

## Cars

- [x] Friend's car, its colour, smooth movement
- [x] Friend at the wheel of the host's mission car
- [~] No doubled cars: five causes fixed (0.9.4, 0.9.8, 0.9.22, 0.9.27, 0.9.32), not yet confirmed
- [~] A mission car stays under its driver (0.9.22)
- [~] Cars matched between the games by their id, not guessed by model and place (0.9.41)
- [ ] One owner per car for every car (as CoopAndreas does)

## Missions

- [x] Mission texts on the guest's screen
- [x] Objective blips on the guest's map
- [~] Red marker on the ground for the guest (0.9.7)
- [~] The host's mission icons on the guest's map (0.9.12)
- [~] A mission starts only with both players at its marker (0.9.13)
- [~] The guest never starts a mission in its own game (0.9.31)
- [~] The guest is taken to the host when a mission starts (0.9.14)
- [x] Mission cutscenes shown to the guest, with subtitles and sound
- [~] The guest loads a cutscene together with the host (0.9.32)
- [~] Skipping a cutscene needs both players (0.9.21, 0.9.30)
- [~] A mission's own scenes: camera, fades and widescreen replayed in the guest's game (0.9.28, 0.9.33)
- [x] Mission enemies and allies copied to the guest, armed
- [x] The mission's weapons given to the guest
- [~] "Mission passed" with money, respect and tune for the guest (0.9.12)
- [~] Either player counts for "be here" steps
- [x] Either player's hits on mission enemies count (their damage is sent to the host)
- [~] Either player's damage to mission cars counts: "destroy that car" (0.9.40)
- [ ] Either player counts for "pick this up"
- [ ] Sweet, Ryder and other story characters shown as themselves (a stand-in is shown)

### Story missions

Script names seen running in real co-op tests: `SWEET5`, `SMOKE1`, `SMOKE4`. None has been played through from
start to end by both players and checked yet. The rest are untested.

- [ ] Los Santos (Big Smoke to Reuniting The Families)
- [ ] Badlands (Badlands to Are You Going To San Fierro?)
- [ ] San Fierro (Wear Flowers In Your Hair to Toreno's Last Flight)
- [ ] Desert (Monster to Verdant Meadows, Learning To Fly)
- [ ] Las Venturas (Fender Ketchup to Saint Mark's Bistro)
- [ ] Return to Los Santos (A Home In The Hills to End Of The Line)

## Side content (untested in co-op)

- [~] Shops, food, guns, clothes, barber, tattoos, gym for the guest (0.9.12)
- [ ] Save disk for the guest in safehouses (cause not found)
- [ ] Taxi, firefighter, vigilante, paramedic, pimp, freight train
- [ ] Races, BMX, NRG-500, Chiliad Challenge, stadium events
- [ ] Driving, flying, bike and boat schools
- [ ] Asset missions (trucker, valet, quarry, courier)
- [ ] Import / Export

## Known limits of the Definitive Edition

- A script cannot load story characters (Sweet, Ryder...) or force model loads: both crash the game. Stand-ins are
  used.
- Script commands that build something new (models, cutscene actors) must run on the game's own thread; the mod
  borrows it while its script runs.
