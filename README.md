# SA Co-op

Online co-op for **GTA San Andreas – The Definitive Edition** (PC, Steam). It works like Saints Row 2: pick
**co-op** in the game's own menu, create a session with a name and a password, your friend joins with the same name
and password, and you play the story together, each on your own PC with your own copy of the game.

> **Status: early, work in progress.** Most of it has been tested with a bot friend on one PC; a full play-through
> with two real players over Steam has not been done yet. Expect bugs. The mod keeps co-op saves apart from yours and
> backs your saves up (see [Saves](#saves)).

## Contents

- [What works](#what-works)
- [Requirements](#requirements)
- [Install (step by step)](#install-step-by-step)
- [Play with a friend](#play-with-a-friend)
- [Controls](#controls)
- [AI partner (playing alone)](#ai-partner-playing-alone)
- [Saves](#saves)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Build from source](#build-from-source)
- [Credits and licence](#credits-and-licence)

## What works

- A **co-op** entry in the main menu and the pause menu, opening a co-op screen styled like the game's options
- Sessions through **Steam lobbies**: a name and a password, no port forwarding, no IP addresses
- Your friend in your world: walking, running, driving, the same weapon, a name over their head and a map blip
- Ride along in your friend's car; when it is full (a two-seater in a mission) or a bike, you ride on the trunk or behind the rider
- **Down, not dead**: below 40 health you fall instead of dying. A red banner at the top counts down 30 seconds;
  your friend walks up and holds **E** for 3 seconds to get you up. Nobody in time: the normal death
- Shared clock, weather and wanted level; cutscenes and mission start/end are shared
- An optional **AI partner** for when you play alone
- Your last car is remembered (map blip), also after save/load
- Optional graphics settings: sharper image, longer view distance, better shadows, no motion blur

Not yet, or not tested: full mission sync for two real players (enemies, shared money), your friend wearing CJ's
clothes, the train mission special case.

## Requirements

- A **legally owned** copy of GTA San Andreas – The Definitive Edition on **Steam**, game build
  **1.0.113.49697469**. The mod reads game memory at fixed addresses for this build; other builds will not work.
- Windows 10 or 11 (64-bit)
- For co-op: your friend needs their own PC and their own Steam copy of the game. Pirated copies are not supported.

## Install (step by step)

<img src="docs/installer.png" alt="The SA Co-op installer: game found, options, Play" width="420">

1. Close the game.
2. Open [**Releases**](https://github.com/P1tak4s/sa-de-coop/releases) and download `SA-Coop-<version>-windows-x64.zip`.
3. Unpack the zip anywhere, for example to `Downloads\SA-Coop`. Keep the folders together: `sa-coop.exe` needs the
   `game` and `extra` folders next to it.
4. Run **`sa-coop.exe`**. Windows SmartScreen may warn about an unknown app: click **More info → Run anyway**
   (the exe is not code-signed; you can build it yourself, see [Build from source](#build-from-source)).
5. The installer finds the game by itself in all your Steam libraries. Pick the options (better car handling,
   graphics preset) and click **Install**. It:
   - copies the mod loader (Ultimate ASI Loader, CLEO Redux), `coopnet64.asi` and the scripts into
     `...\GTA San Andreas - The Definitive Edition\Gameface\Binaries\Win64`
   - builds the **co-op** menu entry on your PC from your own game files (nothing from Rockstar is in the download)
   - copies the menu fonts from your own game files
   - sets the graphics preset and car handling you picked
6. Click **Play** (or start the game from Steam as usual). You should see **co-op** in the main menu.

Your friend does the same on their PC.

## Play with a friend

Both of you must be logged in to Steam.

1. **Host** (the one whose story you play): in the main menu pick **co-op**, open the **Create** tab, type a session
   name and a password, and press **Create session**. Then load a save or start a new game.
2. **Friend**: in the main menu pick **co-op**, open the **Join** tab, type the **same** name and password, press
   **Join**, then load a save. You are placed in the host's world.
3. In game you can open the co-op screen any time: **Esc → co-op**, or **F9**.

The host's story is the one you both play. The friend's own story is not touched (see [Saves](#saves)).

## Controls

| Key | What it does |
| --- | --- |
| **F9** or **Esc → co-op** | open / close the co-op screen |
| **G** (next to your friend's car) | ride along: a free seat, or on the trunk / behind the rider on a bike when the car is full (you can shoot from there) |
| **F** / **Enter** | get out of the car, or get off the trunk / bike |
| **E** (hold 3 s next to a downed friend) | revive them |
| **H** (AI partner, next to a car) | the partner drives you to your map waypoint; **H** again to stop |

## AI partner (playing alone)

Turn it on in the co-op screen. A Grove Street member joins you: he follows you, gets into the back seat of your car,
shoots rival gangs, revives you when you are down, and you can revive him the same way (hold **E**). Next to a car,
**H** makes him drive you to the waypoint you set on the map.

His decisions come from [TypeSafe Jev](https://typesafe.ai). You need your own key, in this text file:

```
%USERPROFILE%\.config\jev\.env
```

with one line: `TYPESAFE_API_KEY=your-key`.

Or use OpenAI instead: put `OPENAI_API_KEY=your-key` in `%USERPROFILE%\.config\openai\.env` (optionally a second
line `OPENAI_MODEL=...`, default `gpt-6-luna`). When that file exists, OpenAI is used. Keys are read only from these
files on your PC; only a one-line description of the situation is sent.

Without any key he still follows you and shoots enemies close to you.

## Better graphics

**Presets (in the installer):** pick **Off / Balanced / High / Ultra** in `sa-coop.exe` and click **Install** or
**Update / reinstall**. It writes the game's `Engine.ini`; restart the game to see the change.

| Preset | For | What it adds |
| --- | --- | --- |
| Balanced | any GPU | sharper image, longer view distance, better shadows, no motion blur |
| High | RTX 3060 / RX 6600 and up | 125 % render resolution, better anti-aliasing, ambient occlusion, reflections on wet roads and cars, longer shadows |
| Ultra | RTX 4070 / RX 7800 XT and up | 150 % render resolution, 8K shadows, the longest view distance |

Your own `Engine.ini`, if you had one, is kept as `Engine.ini.before-sa-coop`; **Off** puts it back.

**ReShade (optional, a different look):**

1. Download [ReShade](https://reshade.me) and run its setup. Pick `SanAndreas.exe` in
   `Gameface\Binaries\Win64`, choose **DirectX 10/11/12**, and tick the effect packages **Standard effects** and
   **qUINT by Marty McFly**.
2. Copy `extra\reshade\SA-Coop-ReShade.ini` from the release into the same `Win64` folder.
3. In game press **Home**, choose `SA-Coop-ReShade.ini` as the preset. **Scroll Lock** turns the effects on and off.

The preset adds a light sharpen, a little more colour and contrast, and removes banding in the sky.

## Saves

The co-op screen has a **Mine / Co-op** switch. Co-op games are saved separately, so a co-op session never
overwrites your own story. Before switching, the mod copies your saves to `%LOCALAPPDATA%\sa-de-coop\saves-backup`.

## Troubleshooting

- **No co-op entry in the menu**: run `sa-coop.exe` again and press **Update / reinstall**. **F9** still opens the
  co-op screen in game.
- **The game crashes at start**: check that your game build is 1.0.113.49697469 (Steam may have updated the game).
  The mod's log is `%LOCALAPPDATA%\sa-de-coop\coopnet.log`; please open an issue with it.
- **Crash at start with DirectX errors**: install the
  [DirectX End-User Runtimes (June 2010)](https://www.microsoft.com/en-us/download/details.aspx?id=8109).
- **Friend cannot join**: both must type exactly the same session name and password, and both must be online in Steam.
- **Camera feels slow up and down**: raise **Mouse Sensitivity Y** in the game's control settings.
- Script messages are logged in `Gameface\Binaries\Win64\cleo_redux.log`.

## Uninstall

The installer has an **Uninstall** button. By hand: delete these from `Gameface\Binaries\Win64`: `version.dll`, `cleo_redux64.asi`, `coopnet64.asi` and the `CLEO`
folder. Delete `Gameface\Content\Paks\~mods\coop_P.pak`. If the installer created your `Engine.ini`
(`Documents\Rockstar Games\GTA San Andreas Definitive Edition\Config\WindowsNoEditor\Engine.ini`), delete it too.
Your saves stay where they are.

## Build from source

| Part | What it does |
| --- | --- |
| `proto/` | wire format (80-byte player state, events, join code) |
| `relay/` | UDP relay server for the direct IP mode (testing), UPnP |
| `coopnet/` | `coopnet64.asi`: networking (Steam lobby + P2P, or UDP), the in-game co-op screen (hudhook / Dear ImGui), the menu hook, AI partner calls |
| `game/CLEO/` | CLEO Redux scripts: friend sync, passenger, revive, names, world sync, your car, AI partner |
| `launcher/` | `sa-coop.exe`: the installer (finds the game, installs, graphics, car handling, Play) |
| `menu-mod/tool/` | MenuPatch (UAssetAPI): adds the co-op entry to the game's menu templates |
| `tools/` | `dll_test.py` (loopback test without the game), `botas.py` (a test friend bot) |

Needs Rust stable (MSVC toolchain), CMake and the .NET 8 SDK.

```
cargo build --release
dotnet publish menu-mod/tool -c Release -r win-x64 --self-contained
```

`target/release/coopnet64.dll` is installed as `coopnet64.asi`. Release zip layout: `sa-coop.exe`; `game/` (the
files from `game/` plus `coopnet64.asi`); `extra/` (`MenuPatch.exe`, `repak.exe`, `Engine.ini` from `game-config/`,
`THIRD_PARTY.txt`).

## Credits and licence

[CLEO Redux](https://re.cleo.li) by Seemann, [Ultimate ASI Loader](https://github.com/ThirteenAG/Ultimate-ASI-Loader)
by ThirteenAG, [hudhook](https://github.com/veeenu/hudhook), [repak](https://github.com/trumank/repak),
[UAssetAPI](https://github.com/atenfyr/UAssetAPI). Ideas from [SA:COOP](https://github.com/Karimov-Akbar/sa-coop)
for the classic game. Third-party files keep their own licences (included).

Code in this repository: [MIT](LICENSE).

Not affiliated with or endorsed by Rockstar Games or Take-Two Interactive. Grand Theft Auto and San Andreas are their
trademarks. This mod contains no game files; you need your own copy of the game.
