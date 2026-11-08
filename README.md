# SA Co-op

Online co-op for **GTA San Andreas – The Definitive Edition** (PC, Steam), in the spirit of Saints Row 2: pick
**co-op** in the game's own menu, create a session with a name and password, your friend joins with the same
name and password, and you play in each other's world.

Status: work in progress. See "What works" below before you expect a full story co-op.

## What works

- **co-op** entry in the main and pause menus, with an in-game co-op screen styled like the game's options
- Sessions through **Steam lobbies** (name + password, P2P through Steam's relay: no port forwarding, no IPs shown);
  a direct IP mode with a join code is in the launcher
- Your friend in your world: walking, running, driving (with reverse), same weapon, shots, name over the head,
  map blip, same interior only
- **G** to ride as a passenger in your friend's car
- **Down, not dead**: below 40 health you fall instead of dying (also in a car). A red banner at the top counts
  down 30 s; your friend walks up and **holds E** for 3 s to get you up. Nobody in time: the normal death
- **AI partner** (switch in the co-op screen) for when you play alone: a Grove Street member who follows you, sits
  in the back seat, shoots rival gangs, revives you, and you revive him the same way. **H** next to a car: he drives
  you to your map waypoint. His choices come from [TypeSafe Jev](https://typesafe.ai) (needs your own key in
  `%USERPROFILE%\.config\jev\.env`)
- Shared clock, weather (from the first player), wanted level (the higher one spreads)
- Cutscenes started in one game play in the other; mission start/end is announced
- Your last car keeps its place and a map blip, also after save/load
- Cars and people the mod created are cleaned up when its scripts reload (no "ghost" cars)
- Optional graphics settings (sharper image, longer view distance, better shadows, no motion blur)

Not yet: shared mission entities (enemies, targets), shared money, your friend wearing CJ's clothes.

## Requirements

- A legally owned copy of GTA San Andreas – The Definitive Edition on Steam, build **1.0.113.49697469**
  (memory addresses are for this build; another build needs new ones)
- Windows 10/11, each player on their own PC with their own copy

## Install

1. Download the release and unpack it anywhere.
2. Run `sa-coop.exe` and press **Įdiegti / atnaujinti modą** (install / update). It finds the game in your Steam
   libraries and installs:
   - CLEO Redux and Ultimate ASI Loader (their licences are included)
   - `coopnet64.asi` and the game scripts
   - the **co-op** menu entry, built on your PC from your own game files (nothing from Rockstar is shipped)
   - the menu fonts, taken from your own game files
   - `Engine.ini` graphics settings, only if you have none
3. Start the game from Steam. Press **co-op** in the menu (or **F9** anywhere).

To remove: delete `version.dll`, `cleo_redux64.asi`, `coopnet64.asi` and the `CLEO` folder from
`Gameface\Binaries\Win64`, `Gameface\Content\Paks\~mods\coop_P.pak`, and the `Engine.ini` the installer created.

## How it is built

| Part | What it does |
| --- | --- |
| `proto/` | wire format (80-byte player state, events, join code) |
| `relay/` | UDP relay server for IP mode, UPnP |
| `coopnet/` | `coopnet64.asi`: network (Steam lobby + P2P or UDP), the in-game co-op screen (hudhook / Dear ImGui), the menu hook (UObject::ProcessEvent) |
| `game/CLEO/` | CLEO Redux scripts: friend sync, passenger, revive, names, world sync, your car |
| `launcher/` | `sa-coop.exe`: installer and IP-mode host/join |
| `menu-mod/tool/` | MenuPatch (UAssetAPI): adds the co-op entry to the game's menu templates |
| `tools/` | `dll_test.py` (loopback test without the game), `botas.py` (a test friend) |

Build: Rust stable (MSVC), `cargo build --release`; MenuPatch: .NET 8, `dotnet publish -r win-x64 --self-contained`.

## Credits

[CLEO Redux](https://re.cleo.li) by Seemann, [Ultimate ASI Loader](https://github.com/ThirteenAG/Ultimate-ASI-Loader)
by ThirteenAG, [hudhook](https://github.com/veeenu/hudhook), [repak](https://github.com/trumank/repak),
[UAssetAPI](https://github.com/atenfyr/UAssetAPI). Ideas from [SA:COOP](https://github.com/Karimov-Akbar/sa-coop)
for the classic game.

Not affiliated with Rockstar Games or Take-Two Interactive. Licence: MIT.
