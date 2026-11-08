//! sa-coop.exe: the installer. It finds GTA San Andreas The Definitive Edition in the Steam libraries, puts the mod
//! in, sets graphics and car handling, and starts the game. Sessions are made in the game itself (co-op menu, Steam).
#![windows_subsystem = "windows"]

use eframe::egui;
use std::path::{Path, PathBuf};

const STEAM_APP: &str = "steam://rungameid/1547000";
const GAME_SUBDIR: &str = r"steamapps\common\GTA San Andreas - The Definitive Edition\Gameface\Binaries\Win64";

fn main() -> eframe::Result {
    // sa-coop.exe --install: no window, same steps as the Install button (current options), log in
    // %LOCALAPPDATA%\sa-de-coop\setup.log. For testing and for people who script their setups.
    if std::env::args().any(|a| a == "--install") {
        let log = match find_game() {
            Some(g) => {
                let graphics = GRAPHICS.iter().position(|(n, _)| *n == current_graphics()).unwrap_or(2);
                let (ok, lines) = run_install(&g, graphics, load_opts(&g));
                format!("ok={ok}
{}
", lines.join("
"))
            }
            None => "ok=false
game not found
".into(),
        };
        let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("sa-de-coop");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("setup.log"), log);
        return Ok(());
    }
    let icon = egui::IconData { rgba: include_bytes!("../assets/icon64.rgba").to_vec(), width: 64, height: 64 };
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("SA Co-op installer")
            .with_inner_size([520.0, 660.0])
            .with_resizable(false)
            .with_icon(icon),
        ..Default::default()
    };
    eframe::run_native("SA Co-op installer", options, Box::new(|cc| Ok(Box::new(App::new(&cc.egui_ctx)))))
}

// ---- game folder and install ---------------------------------------------------------------------------

/// Every Steam library from libraryfolders.vdf, checked for the game's exe.
fn find_game() -> Option<PathBuf> {
    let steam = PathBuf::from(r"C:\Program Files (x86)\Steam");
    let mut libs = vec![steam.clone()];
    if let Ok(vdf) = std::fs::read_to_string(steam.join(r"steamapps\libraryfolders.vdf")) {
        for line in vdf.lines() {
            let l = line.trim();
            if let Some(rest) = l.strip_prefix("\"path\"") {
                libs.push(PathBuf::from(rest.trim().trim_matches('"').replace("\\\\", "\\")));
            }
        }
    }
    libs.into_iter().map(|l| l.join(GAME_SUBDIR)).find(|p| p.join("SanAndreas.exe").is_file())
}

/// The files to put next to SanAndreas.exe live in `game\` beside this exe (same layout).
/// The mod files packed into this exe by build.rs (empty in a development build).
static PAYLOAD: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/payload.bin"));

/// Unpack the payload once per run into %TEMP%\sa-coop-setup-<version>; returns its game\ folder.
fn unpacked() -> Option<PathBuf> {
    static DIR: std::sync::OnceLock<Option<PathBuf>> = std::sync::OnceLock::new();
    DIR.get_or_init(|| {
        let count = u32::from_le_bytes(PAYLOAD.get(0..4)?.try_into().ok()?) as usize;
        if count == 0 {
            return None;
        }
        let root = std::env::temp_dir().join(format!("sa-coop-setup-{}", env!("CARGO_PKG_VERSION")));
        let _ = std::fs::remove_dir_all(&root);
        let mut at = 4;
        for _ in 0..count {
            let n = u16::from_le_bytes(PAYLOAD.get(at..at + 2)?.try_into().ok()?) as usize;
            let name = std::str::from_utf8(PAYLOAD.get(at + 2..at + 2 + n)?).ok()?;
            at += 2 + n;
            let len = u64::from_le_bytes(PAYLOAD.get(at..at + 8)?.try_into().ok()?) as usize;
            at += 8;
            let data = PAYLOAD.get(at..at + len)?;
            at += len;
            if name.contains("..") {
                return None;
            }
            let path = root.join(name.replace('/', "\\"));
            std::fs::create_dir_all(path.parent()?).ok()?;
            std::fs::write(&path, data).ok()?;
        }
        Some(root.join("game"))
    })
    .clone()
}

fn bundle_dir() -> PathBuf {
    if let Some(dir) = unpacked() {
        return dir;
    }
    // release layout: SA-Coop.exe next to files\game and files\extra (older layout: game\ and extra\ beside it)
    let here = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)).unwrap_or_default();
    if here.join(r"files\game").is_dir() { here.join(r"files\game") } else { here.join("game") }
}

fn copy_tree(from: &Path, to: &Path, log: &mut Vec<String>) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dst = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &dst, log)?;
        } else {
            // another mod's ASI loader under the same name: keep a copy instead of losing it
            if entry.file_name() == "version.dll" && dst.is_file() && std::fs::read(&dst)? != std::fs::read(entry.path())? {
                std::fs::copy(&dst, dst.with_extension("dll.sa-coop-backup"))?;
                log.push("Previous version.dll kept as version.dll.sa-coop-backup".into());
            }
            std::fs::copy(entry.path(), &dst)?;
        }
    }
    Ok(())
}

fn install(game: &Path) -> Result<Vec<String>, String> {
    let src = bundle_dir();
    if !src.join("coopnet64.asi").is_file() {
        return Err(format!("Mod package not found: {}", src.display()));
    }
    let mut log = vec![];
    copy_tree(&src, game, &mut log).map_err(|e| format!("Copy failed: {e}"))?;
    // files of older versions: a second copy of the DLL would run its own, separate network
    for old in ["coopnet64.dll", r"CLEO\sa-coop.js", r"CLEO\coop-test.js", r"CLEO\mano-masina.js"] {
        let _ = std::fs::remove_file(game.join(old));
    }
    log.push("Mod installed.".into());
    extras(game, &mut log);
    Ok(log)
}

// ---- car tuning: the game's own handling.cfg, retuned on this PC, packed as coopcars_P.pak ---------------------
// Better handling: turns in quicker (more steering lock, less turn mass), more grip, stronger brakes, more pull, less wobble.
// Faster cars: top speed at least 200 for road cars and motorbikes, with the pull to get there.
// Both players should pick the same. The choice is remembered in %LOCALAPPDATA%\sa-de-coop\cars.txt.
const HANDLING: &str = "Gameface/Content/OriginalData/GTASA/data/handling.cfg";
const FAST_TOP_SPEED: f32 = 200.0;
/// Not made faster: trains, RC toys, bicycles and work machines (boats and aircraft are found in the file itself).
const NOT_FAST: [&str; 19] = [
    "FREIGHT", "STREAK", "TRAM", "FREIFLAT", "STREAKC", "RCBANDIT", "RCTIGER", "RCCAM", "BIKE", "BMX", "MTBIKE",
    "FORKLIFT", "TRACTOR", "MOWER", "SWEEPER", "KART", "COMBINE", "TUG", "BAGGAGE",
];

/// One vehicle line of handling.cfg retuned; other lines unchanged. Columns: C turn mass (2), J traction (8), N top speed (12),
/// O engine acceleration (13), Q drive type (15), R engine type (16), S brake deceleration (17), b damping (22).
fn retune_line(line: &str, grip: bool, fast: bool, not_fast: &std::collections::HashSet<String>) -> String {
    let t: Vec<&str> = line.split_whitespace().collect();
    let first = t.first().copied().unwrap_or("");
    let vehicle = t.len() > 22
        && !first.starts_with([';', '!', '$', '%', '^'])
        && matches!(t[15], "F" | "R" | "4")
        && matches!(t[16], "P" | "D" | "E");
    if !vehicle {
        return line.to_string();
    }
    let mut out: Vec<String> = t.iter().map(|s| s.to_string()).collect();
    let num = |out: &Vec<String>, i: usize| out[i].parse::<f32>().ok();
    let set = |out: &mut Vec<String>, i: usize, v: f32| out[i] = format!("{v:.3}");
    if grip {
        // 2 turn mass (lower = turns in quicker), 8 traction, 10 traction bias (towards the front: less understeer at
        // speed), 13 acceleration, 17 brakes, 20 steering lock, 22 damping
        for (i, k, max) in [(2, 0.7, 50000.0), (8, 1.12, 2.0), (10, 1.06, 0.65), (13, 1.15, 100.0), (17, 1.25, 20.0), (20, 1.2, 45.0), (22, 1.15, 1.0)] {
            if let Some(v) = num(&out, i) {
                set(&mut out, i, (v * k).min(max));
            }
        }
    }
    if fast && !not_fast.contains(first) && !NOT_FAST.contains(&first) {
        if let (Some(top), Some(acc)) = (num(&out, 12), num(&out, 13)) {
            if top > 0.0 && top < FAST_TOP_SPEED {
                // more pull in proportion, so a slow car can actually reach the new top speed
                let k = (FAST_TOP_SPEED / top).sqrt().min(1.6);
                set(&mut out, 12, FAST_TOP_SPEED);
                set(&mut out, 13, (acc * k).min(100.0));
            }
        }
    }
    out.join(" ")
}

/// The installer's gameplay choices. Both players should pick the same.
#[derive(Clone, Copy)]
struct Opts {
    grip: bool,
    fast: bool,
    range: bool,
    tough: bool,
}

fn save_opts(o: Opts) {
    let _ = std::fs::create_dir_all(cars_file().parent().unwrap());
    let _ = std::fs::write(
        cars_file(),
        format!("grip={}\nfast={}\nrange={}\ntough={}\n", o.grip as u8, o.fast as u8, o.range as u8, o.tough as u8),
    );
}

/// Last installed choices; a fresh install gets better handling on and the rest off.
fn load_opts(game: &Path) -> Opts {
    let (grip, fast) = cars_choice(game);
    let t = std::fs::read_to_string(cars_file()).unwrap_or_default();
    Opts { grip: grip || !installed(game), fast, range: t.contains("range=1"), tough: t.contains("tough=1") }
}

fn cars_file() -> PathBuf {
    PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join(r"sa-de-coop\cars.txt")
}

/// (better handling, faster cars) as last installed.
fn cars_choice(game: &Path) -> (bool, bool) {
    let pak = game.parent().and_then(|p| p.parent()).is_some_and(|g| g.join(r"Content\Paks\~mods\coopcars_P.pak").is_file());
    match std::fs::read_to_string(cars_file()) {
        Ok(t) if pak => (t.contains("grip=1"), t.contains("fast=1")),
        _ => (pak, false),
    }
}

/// Build or remove `~mods\coopcars_P.pak`.
fn set_car_handling(extra: &Path, gameface: &Path, grip: bool, fast: bool) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let target = gameface.join(r"Content\Paks\~mods\coopcars_P.pak");
    if !grip && !fast {
        let _ = std::fs::remove_file(&target);
        return Ok("Cars: the game's own handling and speed.".into());
    }
    let repak = extra.join("repak.exe");
    if !repak.is_file() {
        return Err("repak.exe is missing".into());
    }
    let pak = gameface.join(r"Content\Paks\pakchunk0-WindowsNoEditor.pak");
    let o = std::process::Command::new(&repak).args(["get".as_ref(), pak.as_os_str(), HANDLING.as_ref()])
        .creation_flags(0x0800_0000).output().map_err(|e| e.to_string())?;
    if !o.status.success() || o.stdout.len() < 10_000 {
        return Err("could not read handling.cfg from the game".into());
    }
    let text = String::from_utf8_lossy(&o.stdout);
    // boats (%) and aircraft ($) have extra lines that name them: never made faster
    let not_fast: std::collections::HashSet<String> = text
        .lines()
        .filter(|l| l.starts_with(['%', '$']))
        .filter_map(|l| l.split_whitespace().nth(1).map(str::to_string))
        .collect();
    let tuned: Vec<String> = text.lines().map(|l| retune_line(l, grip, fast, &not_fast)).collect();
    let tmp = std::env::temp_dir().join("sa-coop-cars");
    let _ = std::fs::remove_dir_all(&tmp);
    let file = tmp.join("dst").join(HANDLING);
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&file, tuned.join("\r\n") + "\r\n").map_err(|e| e.to_string())?;
    let out = tmp.join("coopcars_P.pak");
    let o = std::process::Command::new(&repak)
        .args(["pack".as_ref(), "--version".as_ref(), "V11".as_ref(), "--mount-point".as_ref(), "../../../".as_ref(), tmp.join("dst").as_os_str(), out.as_os_str()])
        .creation_flags(0x0800_0000).output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
    }
    std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::copy(&out, &target).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(match (grip, fast) {
        (true, true) => "Better handling and faster cars on. Restart the game to feel it.",
        (true, false) => "Better car handling on. Restart the game to feel it.",
        _ => "Faster cars on. Restart the game to feel it.",
    }
    .into())
}

/// The co-op entry for the game's menus, made on this PC from this PC's own game files: the two menu templates come
/// out of pakchunk0 (repak), MenuPatch adds "co-op" (FunctionToCallOnPress = COOP), repak packs them as a mod pak.
fn build_menu_pak(extra: &Path, gameface: &Path, mods: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const REL: &str = "Gameface/Content/SanAndreas/UI/MenuTemplates";
    let (repak, patch) = (extra.join("repak.exe"), extra.join("MenuPatch.exe"));
    if !repak.is_file() || !patch.is_file() {
        return Err("repak.exe or MenuPatch.exe is missing".into());
    }
    let pak = gameface.join(r"Content\Paks\pakchunk0-WindowsNoEditor.pak");
    let tmp = std::env::temp_dir().join("sa-coop-menu");
    let _ = std::fs::remove_dir_all(&tmp);
    let (src, dst) = (tmp.join("src"), tmp.join("dst"));
    std::fs::create_dir_all(src.join(REL)).map_err(|e| e.to_string())?;
    let run = |exe: &Path, args: &[&std::ffi::OsStr]| -> Result<Vec<u8>, String> {
        let o = std::process::Command::new(exe).args(args).creation_flags(0x0800_0000).output().map_err(|e| e.to_string())?;
        if o.status.success() { Ok(o.stdout) } else { Err(String::from_utf8_lossy(&o.stderr).trim().to_string()) }
    };
    for m in ["GTASA_MainMenu", "GTASA_PauseMenu"] {
        for ext in ["uasset", "uexp"] {
            let inner = format!("{REL}/{m}.{ext}");
            let bytes = run(&repak, &["get".as_ref(), pak.as_os_str(), inner.as_ref()])?;
            std::fs::write(src.join(REL).join(format!("{m}.{ext}")), bytes).map_err(|e| e.to_string())?;
        }
    }
    run(&patch, &["patch".as_ref(), src.as_os_str(), dst.as_os_str()])?;
    let out = tmp.join("coop_P.pak");
    run(&repak, &["pack".as_ref(), "--version".as_ref(), "V11".as_ref(), "--mount-point".as_ref(), "../../../".as_ref(), dst.as_os_str(), out.as_os_str()])?;
    std::fs::create_dir_all(mods).map_err(|e| e.to_string())?;
    std::fs::copy(&out, mods.join("coop_P.pak")).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(())
}

/// Beside `game\`: `extra\coop_P.pak` (the co-op entry in the game's menus), `extra\Engine.ini` (sharper, further
/// graphics; only if the player has none) and `extra\repak.exe`, which takes the menu fonts out of this PC's own
/// copy of the game (they are never shipped with the mod).
fn extras(win64: &Path, log: &mut Vec<String>) {
    let extra = bundle_dir().with_file_name("extra");
    let Some(gameface) = win64.parent().and_then(|p| p.parent()) else { return };
    let mods = gameface.join(r"Content\Paks\~mods");
    match build_menu_pak(&extra, gameface, &mods) {
        Ok(()) => log.push("Co-op menu entry installed.".into()),
        Err(e) => log.push(format!("Could not create the co-op menu entry: {e}")),
    }
    if let Some(docs) = std::env::var_os("USERPROFILE").map(|u| PathBuf::from(u).join(r"Documents\Rockstar Games\GTA San Andreas Definitive Edition\Config\WindowsNoEditor")) {
        let ini = docs.join("Engine.ini");
        if !ini.exists() && extra.join("Engine.ini").is_file() && std::fs::create_dir_all(&docs).is_ok() && std::fs::copy(extra.join("Engine.ini"), &ini).is_ok() {
            log.push("Graphics improvements on (Engine.ini).".into());
        }
    }
    let fonts = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join(r"sa-de-coop\fonts");
    let pak = gameface.join(r"Content\Paks\pakchunk0-WindowsNoEditor.pak");
    if extra.join("repak.exe").is_file() && std::fs::create_dir_all(&fonts).is_ok() {
        use std::os::windows::process::CommandExt;
        for f in ["Beckett", "BankGothicMdBT"] {
            let out = std::process::Command::new(extra.join("repak.exe"))
                .arg("get")
                .arg(&pak)
                .arg(format!("Gameface/Content/Common/Fonts/{f}.ufont"))
                .creation_flags(0x0800_0000)
                .output();
            if let Ok(o) = out {
                if o.status.success() && o.stdout.len() > 1000 && std::fs::write(fonts.join(format!("{f}.ttf")), &o.stdout).is_ok() {
                    log.push(format!("Font {f} taken from the game."));
                }
            }
        }
    }
}

fn installed(game: &Path) -> bool {
    ["version.dll", "cleo_redux64.asi", "coopnet64.asi", r"CLEO\sa-coop[dll][mem].js"].iter().all(|f| game.join(f).is_file())
}

fn start_game() {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("cmd").args(["/C", "start", "", STEAM_APP]).creation_flags(0x0800_0000).spawn();
}

// ---- UI -------------------------------------------------------------------------------------------------

// ---- graphics presets: extra\graphics\Engine-<level>.ini -> the game's Engine.ini ---------------------------
// Only our own file (first line "; SA Co-op graphics") is ever replaced or removed; a player's own Engine.ini is
// kept as Engine.ini.before-sa-coop the first time.
const GRAPHICS: [(&str, &str); 4] = [("Off", ""), ("Balanced", "balanced"), ("High", "high"), ("Ultra", "ultra")];

fn engine_ini() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(|u| {
        PathBuf::from(u).join(r"Documents\Rockstar Games\GTA San Andreas Definitive Edition\Config\WindowsNoEditor\Engine.ini")
    })
}

fn current_graphics() -> &'static str {
    let Some(text) = engine_ini().and_then(|p| std::fs::read_to_string(p).ok()) else { return "Off" };
    let first = text.lines().next().unwrap_or("").to_lowercase();
    if !first.starts_with("; sa co-op graphics") {
        return "your own";
    }
    ["ultra", "high", "balanced"].into_iter().find(|f| first.contains(&format!("graphics, {f}"))).map(|f| match f { "ultra" => "Ultra", "high" => "High", _ => "Balanced" }).unwrap_or("Balanced")
}

fn set_graphics(level: &str) -> String {
    let Some(ini) = engine_ini() else { return "No user folder.".into() };
    let ours = std::fs::read_to_string(&ini).map(|t| t.starts_with("; SA Co-op graphics")).unwrap_or(false);
    if ini.exists() && !ours {
        let keep = ini.with_file_name("Engine.ini.before-sa-coop");
        if !keep.exists() && std::fs::copy(&ini, &keep).is_err() {
            return "Could not back up your own Engine.ini, nothing changed.".into();
        }
    }
    if level.is_empty() {
        if ours {
            let _ = std::fs::remove_file(&ini);
        }
        let keep = ini.with_file_name("Engine.ini.before-sa-coop");
        if keep.exists() {
            let _ = std::fs::rename(&keep, &ini);
            return "Graphics: your own Engine.ini is back.".into();
        }
        return "Graphics: the game's own look.".into();
    }
    let src = bundle_dir().with_file_name("extra").join("graphics").join(format!("Engine-{level}.ini"));
    if let Some(dir) = ini.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    match std::fs::copy(&src, &ini) {
        Ok(_) => format!("Graphics set to {level}. Restart the game to see it."),
        Err(e) => format!("Could not set graphics: {e}"),
    }
}

// THESIS:    one button puts co-op into the player's own game; nothing about it may look shady
// AUDIENCE:  a GTA fan at home, rightly wary of unknown exes; Windows
// WORLD:     a game launcher: near black, white headings, one yellow accent (same family as the VC co-op installer)
// SIGNATURE: the game's own hero art and logo at the top, read from this PC's Steam library cache (never shipped)
// SYSTEM:    Segoe UI from Windows, greys on #0D0D0D, yellow only on the primary button and the active choice

const BG: egui::Color32 = egui::Color32::from_rgb(13, 13, 13);
const CARD: egui::Color32 = egui::Color32::from_rgb(23, 23, 23);
const CARD_HI: egui::Color32 = egui::Color32::from_rgb(38, 38, 42);
const TEXT: egui::Color32 = egui::Color32::from_rgb(244, 244, 244);
const MUTED: egui::Color32 = egui::Color32::from_rgb(150, 150, 156);
const YELLOW: egui::Color32 = egui::Color32::from_rgb(252, 175, 23);
const GREEN_HI: egui::Color32 = egui::Color32::from_rgb(92, 200, 110);
const RED: egui::Color32 = egui::Color32::from_rgb(240, 100, 86);
const REPO: &str = "https://github.com/P1tak4s/sa-de-coop";


fn style(ctx: &egui::Context, _game_font: Option<Vec<u8>>) {
    let mut fonts = egui::FontDefinitions::default();
    for (name, file) in [("segoe", r"C:\Windows\Fonts\segoeui.ttf"), ("segoe-sb", r"C:\Windows\Fonts\seguisb.ttf")] {
        if let Ok(bytes) = std::fs::read(file) {
            fonts.font_data.insert(name.into(), egui::FontData::from_owned(bytes).into());
        }
    }
    let prop = fonts.families[&egui::FontFamily::Proportional].clone();
    if fonts.font_data.contains_key("segoe") {
        fonts.families.get_mut(&egui::FontFamily::Proportional).unwrap().insert(0, "segoe".into());
    }
    let strong = if fonts.font_data.contains_key("segoe-sb") { vec!["segoe-sb".to_string()] } else { prop };
    // the family is still called "beckett" so the rest of the code needs no change
    fonts.families.insert(egui::FontFamily::Name("beckett".into()), strong);
    ctx.set_fonts(fonts);
    let mut v = egui::Visuals::dark();
    v.panel_fill = BG;
    v.window_fill = BG;
    // no override_text_color: it would paint selected labels white on the yellow fill
    v.widgets.noninteractive.fg_stroke.color = TEXT;
    v.widgets.inactive.fg_stroke.color = TEXT;
    v.widgets.hovered.fg_stroke.color = egui::Color32::WHITE;
    v.widgets.active.fg_stroke.color = egui::Color32::WHITE;
    v.selection.bg_fill = YELLOW;
    v.selection.stroke = egui::Stroke::new(1.0_f32, egui::Color32::BLACK);
    v.hyperlink_color = YELLOW;
    v.widgets.inactive.weak_bg_fill = CARD_HI;
    v.widgets.inactive.bg_fill = CARD_HI;
    v.widgets.hovered.weak_bg_fill = egui::Color32::from_rgb(52, 52, 58);
    v.widgets.active.weak_bg_fill = egui::Color32::from_rgb(62, 62, 68);
    for w in [&mut v.widgets.inactive, &mut v.widgets.hovered, &mut v.widgets.active] {
        w.corner_radius = egui::CornerRadius::same(6);
    }
    ctx.set_visuals(v);
    ctx.style_mut(|s| {
        s.spacing.item_spacing = egui::vec2(8.0, 8.0);
        s.spacing.button_padding = egui::vec2(12.0, 6.0);
        s.text_styles.insert(egui::TextStyle::Body, egui::FontId::proportional(15.0));
        s.text_styles.insert(egui::TextStyle::Button, egui::FontId::proportional(15.0));
        s.text_styles.insert(egui::TextStyle::Small, egui::FontId::proportional(12.5));
    });
}

/// Steam's own library art for the game on this PC: (hero, logo). Read at run time, never shipped with the mod.
fn steam_art(ctx: &egui::Context, game: Option<&Path>) -> (Option<egui::TextureHandle>, Option<egui::TextureHandle>) {
    // ...\steamapps\common\<game>\Gameface\Binaries\Win64 -> the Steam folder is the default one; the cache is there
    let _ = game;
    let dir = PathBuf::from(r"C:\Program Files (x86)\Steam\appcache\librarycache\1547000");
    let load = |file: &str| -> Option<egui::TextureHandle> {
        let img = image::open(dir.join(file)).ok()?;
        // the hero art is 3840 px wide: more than a GL texture may hold here, which closed the window
        let img = if img.width() > 1200 { img.thumbnail(1200, 1200) } else { img };
        let img = img.to_rgba8();
        let (w, h) = img.dimensions();
        let ci = egui::ColorImage::from_rgba_unmultiplied([w as usize, h as usize], img.as_raw());
        Some(ctx.load_texture(format!("sa-{file}"), ci, egui::TextureOptions::LINEAR))
    };
    (load("library_hero.jpg"), load("logo.png"))
}

/// The top of the window: the game's hero art (cropped to fill), a fade into the page, the logo and our name.
fn header(ui: &mut egui::Ui, art: &(Option<egui::TextureHandle>, Option<egui::TextureHandle>)) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 190.0), egui::Sense::hover());
    let p = ui.painter_at(rect);
    match &art.0 {
        Some(tex) => {
            let [tw, th] = tex.size();
            let (ta, ra) = (tw as f32 / th as f32, rect.width() / rect.height());
            let uv = if ta > ra {
                let w = ra / ta;
                egui::Rect::from_min_max(egui::pos2(0.5 - w / 2.0, 0.0), egui::pos2(0.5 + w / 2.0, 1.0))
            } else {
                let h = ta / ra;
                egui::Rect::from_min_max(egui::pos2(0.0, 0.5 - h / 2.0), egui::pos2(1.0, 0.5 + h / 2.0))
            };
            p.image(tex.id(), rect, uv, egui::Color32::WHITE);
        }
        None => {
            p.rect_filled(rect, 0, egui::Color32::from_rgb(28, 22, 18));
        }
    }
    let fade = egui::Rect::from_min_max(egui::pos2(rect.left(), rect.bottom() - 100.0), rect.max);
    let mut mesh = egui::Mesh::default();
    mesh.colored_vertex(fade.left_top(), egui::Color32::TRANSPARENT);
    mesh.colored_vertex(fade.right_top(), egui::Color32::TRANSPARENT);
    mesh.colored_vertex(fade.left_bottom(), BG);
    mesh.colored_vertex(fade.right_bottom(), BG);
    mesh.add_triangle(0, 1, 2);
    mesh.add_triangle(1, 3, 2);
    p.add(egui::Shape::mesh(mesh));
    let strong = egui::FontId::new(26.0, egui::FontFamily::Name("beckett".into()));
    match &art.1 {
        Some(logo) => {
            let [lw, lh] = logo.size();
            let h = 64.0_f32;
            let w = (lw as f32 / lh as f32 * h).min(rect.width() * 0.5);
            let at = egui::Rect::from_min_size(egui::pos2(rect.left() + 24.0, rect.bottom() - w / (lw as f32 / lh as f32) - 20.0), egui::vec2(w, w / (lw as f32 / lh as f32)));
            p.image(logo.id(), at, egui::Rect::from_min_max(egui::pos2(0.0, 0.0), egui::pos2(1.0, 1.0)), egui::Color32::WHITE);
            p.text(egui::pos2(rect.right() - 24.0, rect.bottom() - 22.0), egui::Align2::RIGHT_BOTTOM, "CO-OP", strong, YELLOW);
        }
        None => {
            p.text(egui::pos2(rect.left() + 24.0, rect.bottom() - 22.0), egui::Align2::LEFT_BOTTOM, "SA CO-OP", strong, TEXT);
        }
    }
}

fn card<R>(ui: &mut egui::Ui, title: &str, add: impl FnOnce(&mut egui::Ui) -> R) -> R {
    egui::Frame::new()
        .fill(CARD)
        .corner_radius(8)
        .inner_margin(egui::Margin::same(14))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(egui::RichText::new(title).size(12.0).color(MUTED).strong());
            add(ui)
        })
        .inner
}

fn big_button(ui: &mut egui::Ui, text: &str, primary: bool) -> egui::Response {
    let (fill, ink) = if primary { (YELLOW, egui::Color32::BLACK) } else { (CARD_HI, TEXT) };
    let b = egui::Button::new(egui::RichText::new(text).size(19.0).color(ink).strong())
        .fill(fill)
        .corner_radius(8)
        .min_size(egui::vec2(ui.available_width(), 46.0));
    let r = ui.add(b);
    if r.hovered() {
        ui.painter().rect_filled(r.rect, 8, egui::Color32::from_white_alpha(14));
    }
    r
}

// ---- fights: longer gun range (weapon.dat -> coopweapons_P.pak) and tougher enemies (a CLEO script) ----------
const WEAPONS: &str = "Gameface/Content/OriginalData/GTASA/data/weapon.dat";
const RANGE_X: f32 = 1.6;

/// Gun lines ("$ NAME INSTANT_HIT targetRange weaponRange ...") get both ranges x1.6; everything else unchanged.
fn longer_range(line: &str) -> String {
    let t: Vec<&str> = line.split_whitespace().collect();
    if t.len() < 6 || t[0] != "$" || t[2] != "INSTANT_HIT" {
        return line.to_string();
    }
    let mut out: Vec<String> = t.iter().map(|s| s.to_string()).collect();
    for i in [3, 4] {
        if let Ok(v) = out[i].parse::<f32>() {
            out[i] = format!("{:.1}", (v * RANGE_X).min(250.0));
        }
    }
    out.join("\t")
}

fn set_weapon_range(extra: &Path, gameface: &Path, on: bool) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let target = gameface.join(r"Content\Paks\~mods\coopweapons_P.pak");
    if !on {
        let _ = std::fs::remove_file(&target);
        return Ok("Guns: the game's own range.".into());
    }
    let repak = extra.join("repak.exe");
    let pak = gameface.join(r"Content\Paks\pakchunk0-WindowsNoEditor.pak");
    let o = std::process::Command::new(&repak).args(["get".as_ref(), pak.as_os_str(), WEAPONS.as_ref()])
        .creation_flags(0x0800_0000).output().map_err(|e| e.to_string())?;
    if !o.status.success() || o.stdout.len() < 2_000 {
        return Err("could not read weapon.dat from the game".into());
    }
    let text = String::from_utf8_lossy(&o.stdout);
    let tuned: Vec<String> = text.lines().map(longer_range).collect();
    let tmp = std::env::temp_dir().join("sa-coop-weapons");
    let _ = std::fs::remove_dir_all(&tmp);
    let file = tmp.join("dst").join(WEAPONS);
    std::fs::create_dir_all(file.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&file, tuned.join("\r\n") + "\r\n").map_err(|e| e.to_string())?;
    let out = tmp.join("coopweapons_P.pak");
    let o = std::process::Command::new(&repak)
        .args(["pack".as_ref(), "--version".as_ref(), "V11".as_ref(), "--mount-point".as_ref(), "../../../".as_ref(), tmp.join("dst").as_os_str(), out.as_os_str()])
        .creation_flags(0x0800_0000).output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(String::from_utf8_lossy(&o.stderr).trim().to_string());
    }
    std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::copy(&out, &target).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&tmp);
    Ok("Longer gun range on. Restart the game to feel it.".into())
}

fn set_tough_enemies(extra: &Path, game: &Path, on: bool) -> String {
    let dst = game.join(r"CLEO\tougher-enemies.js");
    if !on {
        let _ = std::fs::remove_file(&dst);
        return "Enemies: the game's own.".into();
    }
    match std::fs::copy(extra.join(r"optional\tougher-enemies.js"), &dst) {
        Ok(_) => "Tougher enemies on.".into(),
        Err(e) => format!("Could not turn on tougher enemies: {e}"),
    }
}

fn uninstall(game: &Path) -> Vec<String> {
    for f in ["version.dll", "cleo_redux64.asi", "coopnet64.asi", "ULTIMATE_ASI_LOADER_LICENSE.txt"] {
        let _ = std::fs::remove_file(game.join(f));
    }
    let _ = std::fs::remove_dir_all(game.join("CLEO"));
    if let Some(gf) = game.parent().and_then(|p| p.parent()) {
        for f in ["coop_P.pak", "coopcars_P.pak", "coopweapons_P.pak"] {
            let _ = std::fs::remove_file(gf.join(r"Content\Paks\~mods").join(f));
        }
    }
    let g = set_graphics("");
    vec!["Mod removed. Your saves are untouched.".into(), g]
}

/// Everything the Install button does; runs on its own thread so the window never freezes.
fn run_install(game: &Path, graphics: usize, o: Opts) -> (bool, Vec<String>) {
    let mut log = match install(game) {
        Ok(l) => l,
        Err(e) => return (false, vec![e]),
    };
    log.push(set_graphics(GRAPHICS[graphics].1));
    if let Some(gf) = game.parent().and_then(|p| p.parent()) {
        let extra = bundle_dir().with_file_name("extra");
        match set_car_handling(&extra, gf, o.grip, o.fast) {
            Ok(m) | Err(m) => log.push(m),
        }
        match set_weapon_range(&extra, gf, o.range) {
            Ok(m) | Err(m) => log.push(m),
        }
        log.push(set_tough_enemies(&extra, game, o.tough));
    }
    save_opts(o);
    (installed(game), log)
}

type Job = std::sync::Arc<std::sync::Mutex<Option<(bool, Vec<String>)>>>;

struct App {
    game: Option<PathBuf>,
    path_text: String,
    graphics: usize, // index into GRAPHICS
    opts: Opts,
    job: Option<Job>,
    result: Option<(bool, Vec<String>)>,
    art: (Option<egui::TextureHandle>, Option<egui::TextureHandle>),
}

impl App {
    fn new(ctx: &egui::Context) -> App {
        let game = find_game();
        style(ctx, None);
        let graphics = match current_graphics() {
            "Off" | "your own" => 2,
            g => GRAPHICS.iter().position(|(n, _)| *n == g).unwrap_or(2),
        };
        let opts = game.as_deref().map(load_opts).unwrap_or(Opts { grip: true, fast: false, range: false, tough: false });
        let art = steam_art(ctx, game.as_deref());
        App { game, path_text: String::new(), graphics, opts, job: None, result: None, art }
    }

    fn start(&mut self, game: PathBuf) {
        let job: Job = Default::default();
        let (j, g, o) = (job.clone(), self.graphics, self.opts);
        std::thread::spawn(move || {
            let r = run_install(&game, g, o);
            *j.lock().unwrap() = Some(r);
        });
        self.result = None;
        self.job = Some(job);
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _: &mut eframe::Frame) {
        if let Some(job) = &self.job {
            let done = job.lock().unwrap().take();
            match done {
                Some(r) => {
                    self.result = Some(r);
                    self.job = None;
                }
                None => ctx.request_repaint_after(std::time::Duration::from_millis(100)),
            }
        }
        let busy = self.job.is_some();
        egui::CentralPanel::default().frame(egui::Frame::new().fill(BG)).show(ctx, |ui| {
            header(ui, &self.art);
            egui::Frame::new().inner_margin(egui::Margin { left: 20, right: 20, top: 4, bottom: 16 }).show(ui, |ui| {
                // 1. the game
                let game = card(ui, "YOUR GAME", |ui| match self.game.clone() {
                    Some(g) => {
                        ui.horizontal(|ui| {
                            ui.label(egui::RichText::new("✔").color(GREEN_HI).strong());
                            ui.label("GTA San Andreas: The Definitive Edition")
                                .on_hover_text(g.display().to_string());
                        });
                        ui.label(egui::RichText::new("Found in your Steam library.").small().color(MUTED));
                        Some(g)
                    }
                    None => {
                        ui.label(egui::RichText::new("We could not find the game in Steam.").color(RED));
                        ui.label("Paste the game's folder here (the one with the Gameface folder inside):");
                        ui.text_edit_singleline(&mut self.path_text);
                        if ui.button("Use this folder").clicked() {
                            let p = PathBuf::from(self.path_text.trim()).join(r"Gameface\Binaries\Win64");
                            if p.join("SanAndreas.exe").is_file() {
                                self.game = Some(p);
                            } else {
                                self.result = Some((false, vec!["That folder does not have the game in it.".into()]));
                            }
                        }
                        None
                    }
                });
                let Some(game) = game else { return };
                let is_installed = installed(&game);

                // 2. options
                card(ui, "OPTIONS", |ui| {
                    ui.add_enabled_ui(!busy, |ui| {
                        ui.checkbox(&mut self.opts.grip, "Better car handling");
                        ui.label(egui::RichText::new("Cars grip the road better and brake harder. Pick the same as your friend.").small().color(MUTED));
                        ui.checkbox(&mut self.opts.fast, "Faster cars");
                        ui.label(egui::RichText::new("Every car and motorbike can reach at least 200 km/h. Boats, planes and trains stay as they are.").small().color(MUTED));
                        ui.checkbox(&mut self.opts.range, "Longer gun range");
                        ui.label(egui::RichText::new("Guns reach and lock on 60% further, for you and for everyone else.").small().color(MUTED));
                        ui.checkbox(&mut self.opts.tough, "Tougher enemies");
                        ui.label(egui::RichText::new("Armed enemies aim better, shoot more often and take more hits.").small().color(MUTED));
                        ui.add_space(4.0);
                        ui.horizontal(|ui| {
                            ui.label("Graphics");
                            for (i, (name, _)) in GRAPHICS.iter().enumerate() {
                                let ink = if self.graphics == i { egui::Color32::BLACK } else { TEXT };
                                ui.selectable_value(&mut self.graphics, i, egui::RichText::new(*name).color(ink));
                            }
                        });
                        ui.label(
                            egui::RichText::new("High suits most gaming PCs. Ultra needs a strong graphics card. Off keeps the original look.")
                                .small()
                                .color(MUTED),
                        );
                    });
                });
                ui.add_space(4.0);

                // 3. the action
                if busy {
                    ui.horizontal(|ui| {
                        ui.spinner();
                        ui.label("Installing. This takes a few seconds…");
                    });
                } else if is_installed {
                    if big_button(ui, "Play", true).clicked() {
                        start_game();
                    }
                    if big_button(ui, "Save options", false).clicked() {
                        self.start(game.clone());
                    }
                } else if big_button(ui, "Install", true).clicked() {
                    self.start(game.clone());
                }

                if let Some((ok, log)) = &self.result {
                    let (icon, text, color) = if *ok {
                        ("✔", "Ready. Press Play, then choose Co-op in the game's main menu.", GREEN_HI)
                    } else {
                        ("✖", "That did not work. See the details below.", RED)
                    };
                    ui.label(egui::RichText::new(format!("{icon} {text}")).color(color));
                    egui::CollapsingHeader::new("Details").default_open(!*ok).show(ui, |ui| {
                        for m in log {
                            ui.label(egui::RichText::new(m).small().color(MUTED));
                        }
                    });
                }
                egui::CollapsingHeader::new("What does this change on my PC?").show(ui, |ui| {
                    for line in [
                        "Adds the co-op mod to your game folder. Nothing else on your PC is touched.",
                        "Your saved games are not changed. Co-op has its own saves.",
                        "The co-op menu button and car handling are made from your own game files. No game files are downloaded.",
                        "Uninstall removes everything and puts your game back as it was.",
                    ] {
                        ui.label(egui::RichText::new(format!("• {line}")).small().color(MUTED));
                    }
                });

                // footer
                ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| {
                    ui.horizontal(|ui| {
                        ui.hyperlink_to(egui::RichText::new("Free and open source").small(), REPO);
                        ui.label(
                            egui::RichText::new(format!("v{}  ·  Not made by Rockstar Games", env!("CARGO_PKG_VERSION")))
                                .small()
                                .color(MUTED),
                        );
                        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                            if is_installed && !busy && ui.small_button("Uninstall").clicked() {
                                self.result = Some((true, uninstall(&game)));
                            }
                        });
                    });
                });
            });
        });
    }
}
