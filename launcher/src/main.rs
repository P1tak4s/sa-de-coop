//! sa-coop.exe: the installer. It finds GTA San Andreas The Definitive Edition in the Steam libraries, puts the mod
//! in, sets graphics and car handling, and starts the game. Sessions are made in the game itself (co-op menu, Steam).
#![windows_subsystem = "windows"]

use eframe::egui;
use std::path::{Path, PathBuf};

const STEAM_APP: &str = "steam://rungameid/1547000";
const GAME_SUBDIR: &str = r"steamapps\common\GTA San Andreas - The Definitive Edition\Gameface\Binaries\Win64";

fn main() -> eframe::Result {
    let icon = egui::IconData { rgba: include_bytes!("../assets/icon64.rgba").to_vec(), width: 64, height: 64 };
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("SA Co-op installer")
            .with_inner_size([520.0, 600.0])
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
fn bundle_dir() -> PathBuf {
    std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.join("game"))).unwrap_or_else(|| PathBuf::from("game"))
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

// ---- better car handling: the game's own handling.cfg, retuned on this PC, packed as coopcars_P.pak ------------
// More grip, stronger brakes, a little more pull, less wobble. Both players should use the same setting.
const HANDLING: &str = "Gameface/Content/OriginalData/GTASA/data/handling.cfg";

/// One vehicle line of handling.cfg retuned; other lines unchanged. Columns: J traction (8), O engine
/// acceleration (13), Q drive type (15), R engine type (16), S brake deceleration (17), b suspension damping (22).
fn retune_line(line: &str) -> String {
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
    let scale = |out: &mut Vec<String>, i: usize, k: f32, max: f32| {
        if let Ok(v) = out[i].parse::<f32>() {
            out[i] = format!("{:.3}", (v * k).min(max));
        }
    };
    scale(&mut out, 8, 1.12, 2.0); // traction
    scale(&mut out, 13, 1.08, 100.0); // acceleration
    scale(&mut out, 17, 1.25, 20.0); // brakes
    scale(&mut out, 22, 1.15, 1.0); // damping: less bounce and body roll
    out.join(" ")
}

/// Build or remove `~mods\coopcars_P.pak`.
fn set_car_handling(extra: &Path, gameface: &Path, on: bool) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    let target = gameface.join(r"Content\Paks\~mods\coopcars_P.pak");
    if !on {
        let _ = std::fs::remove_file(&target);
        return Ok("Car handling: the game's own.".into());
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
    let tuned: Vec<String> = text.lines().map(retune_line).collect();
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
    Ok("Better car handling on. Restart the game to feel it.".into())
}

fn car_handling_on(game: &Path) -> bool {
    game.parent().and_then(|p| p.parent()).is_some_and(|g| g.join(r"Content\Paks\~mods\coopcars_P.pak").is_file())
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
// AUDIENCE:  a GTA fan at home, maybe wary of random exes; Windows, any GPU
// WORLD:     San Andreas at dusk: the sunset over the skyline, Grove Street green, the game's own Beckett title font
// SIGNATURE: the sunset header with the title in Beckett; everything below is calm and dark
// SYSTEM:    Beckett (from the player's game) + egui default; dark #141216, accent Grove green, 4/8/16/24 spacing

const BG: egui::Color32 = egui::Color32::from_rgb(20, 18, 22);
const CARD: egui::Color32 = egui::Color32::from_rgb(30, 27, 34);
const CARD_HI: egui::Color32 = egui::Color32::from_rgb(44, 40, 50);
const TEXT: egui::Color32 = egui::Color32::from_rgb(236, 232, 226);
const MUTED: egui::Color32 = egui::Color32::from_rgb(160, 152, 148);
const GREEN: egui::Color32 = egui::Color32::from_rgb(46, 150, 64);
const GREEN_HI: egui::Color32 = egui::Color32::from_rgb(60, 176, 80);
const RED: egui::Color32 = egui::Color32::from_rgb(232, 96, 80);
const REPO: &str = "https://github.com/P1tak4s/sa-de-coop";

/// The game's own Beckett font from this PC's copy (cached by an earlier install, or read from the pak now).
fn title_font(game: Option<&Path>) -> Option<Vec<u8>> {
    let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join(r"sa-de-coop\fonts");
    if let Ok(b) = std::fs::read(dir.join("Beckett.ttf")) {
        return Some(b);
    }
    use std::os::windows::process::CommandExt;
    let gf = game?.parent()?.parent()?;
    let o = std::process::Command::new(bundle_dir().with_file_name("extra").join("repak.exe"))
        .arg("get")
        .arg(gf.join(r"Content\Paks\pakchunk0-WindowsNoEditor.pak"))
        .arg("Gameface/Content/Common/Fonts/Beckett.ufont")
        .creation_flags(0x0800_0000)
        .output()
        .ok()?;
    (o.status.success() && o.stdout.len() > 1000).then(|| {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("Beckett.ttf"), &o.stdout);
        o.stdout
    })
}

fn style(ctx: &egui::Context, beckett: Option<Vec<u8>>) {
    let mut fonts = egui::FontDefinitions::default();
    let fallback = fonts.families[&egui::FontFamily::Proportional].clone();
    if let Some(b) = beckett {
        fonts.font_data.insert("beckett".into(), egui::FontData::from_owned(b).into());
        let mut fam = vec!["beckett".to_string()];
        fam.extend(fallback);
        fonts.families.insert(egui::FontFamily::Name("beckett".into()), fam);
    } else {
        fonts.families.insert(egui::FontFamily::Name("beckett".into()), fallback);
    }
    ctx.set_fonts(fonts);
    let mut v = egui::Visuals::dark();
    v.panel_fill = BG;
    v.window_fill = BG;
    v.override_text_color = Some(TEXT);
    v.selection.bg_fill = GREEN;
    v.hyperlink_color = egui::Color32::from_rgb(250, 170, 80);
    v.widgets.inactive.weak_bg_fill = CARD_HI;
    v.widgets.inactive.bg_fill = CARD_HI;
    v.widgets.hovered.weak_bg_fill = egui::Color32::from_rgb(58, 52, 64);
    v.widgets.active.weak_bg_fill = egui::Color32::from_rgb(66, 60, 72);
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

/// The sunset header: dusk sky into orange, the title in Beckett.
fn header(ui: &mut egui::Ui) {
    let (rect, _) = ui.allocate_exact_size(egui::vec2(ui.available_width(), 128.0), egui::Sense::hover());
    let mut mesh = egui::Mesh::default();
    let stops = [
        (0.0, egui::Color32::from_rgb(40, 20, 56)),
        (0.6, egui::Color32::from_rgb(196, 78, 60)),
        (0.86, egui::Color32::from_rgb(240, 140, 52)),
        (1.0, BG),
    ];
    for (k, (t, c)) in stops.iter().enumerate() {
        let y = rect.top() + rect.height() * t;
        mesh.colored_vertex(egui::pos2(rect.left(), y), *c);
        mesh.colored_vertex(egui::pos2(rect.right(), y), *c);
        if k > 0 {
            let b = (k as u32) * 2;
            mesh.add_triangle(b - 2, b - 1, b);
            mesh.add_triangle(b - 1, b + 1, b);
        }
    }
    let p = ui.painter();
    p.add(egui::Shape::mesh(mesh));
    let title = egui::FontId::new(48.0, egui::FontFamily::Name("beckett".into()));
    let at = egui::pos2(rect.left() + 24.0, rect.top() + 22.0);
    p.text(at + egui::vec2(2.0, 2.0), egui::Align2::LEFT_TOP, "SA Co-op", title.clone(), egui::Color32::from_black_alpha(140));
    p.text(at, egui::Align2::LEFT_TOP, "SA Co-op", title, egui::Color32::WHITE);
    p.text(
        egui::pos2(rect.left() + 26.0, rect.top() + 82.0),
        egui::Align2::LEFT_TOP,
        "Online co-op for GTA San Andreas: The Definitive Edition",
        egui::FontId::proportional(14.0),
        egui::Color32::from_rgb(255, 236, 214),
    );
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
    let fill = if primary { GREEN } else { CARD_HI };
    let b = egui::Button::new(egui::RichText::new(text).size(19.0).color(egui::Color32::WHITE).strong())
        .fill(fill)
        .corner_radius(8)
        .min_size(egui::vec2(ui.available_width(), 46.0));
    let r = ui.add(b);
    if r.hovered() {
        ui.painter().rect_filled(r.rect, 8, egui::Color32::from_white_alpha(14));
    }
    r
}

fn uninstall(game: &Path) -> Vec<String> {
    for f in ["version.dll", "cleo_redux64.asi", "coopnet64.asi", "ULTIMATE_ASI_LOADER_LICENSE.txt"] {
        let _ = std::fs::remove_file(game.join(f));
    }
    let _ = std::fs::remove_dir_all(game.join("CLEO"));
    if let Some(gf) = game.parent().and_then(|p| p.parent()) {
        for f in ["coop_P.pak", "coopcars_P.pak"] {
            let _ = std::fs::remove_file(gf.join(r"Content\Paks\~mods").join(f));
        }
    }
    let g = set_graphics("");
    vec!["Mod removed. Your saves are untouched.".into(), g]
}

/// Everything the Install button does; runs on its own thread so the window never freezes.
fn run_install(game: &Path, graphics: usize, cars: bool) -> (bool, Vec<String>) {
    let mut log = match install(game) {
        Ok(l) => l,
        Err(e) => return (false, vec![e]),
    };
    log.push(set_graphics(GRAPHICS[graphics].1));
    if let Some(gf) = game.parent().and_then(|p| p.parent()) {
        match set_car_handling(&bundle_dir().with_file_name("extra"), gf, cars) {
            Ok(m) | Err(m) => log.push(m),
        }
    }
    (installed(game), log)
}

type Job = std::sync::Arc<std::sync::Mutex<Option<(bool, Vec<String>)>>>;

struct App {
    game: Option<PathBuf>,
    path_text: String,
    graphics: usize, // index into GRAPHICS
    cars: bool,
    job: Option<Job>,
    result: Option<(bool, Vec<String>)>,
}

impl App {
    fn new(ctx: &egui::Context) -> App {
        let game = find_game();
        style(ctx, title_font(game.as_deref()));
        let graphics = match current_graphics() {
            "Off" | "your own" => 2,
            g => GRAPHICS.iter().position(|(n, _)| *n == g).unwrap_or(2),
        };
        let cars = game.as_deref().map(|g| car_handling_on(g) || !installed(g)).unwrap_or(true);
        App { game, path_text: String::new(), graphics, cars, job: None, result: None }
    }

    fn start(&mut self, game: PathBuf) {
        let job: Job = Default::default();
        let (j, g, c) = (job.clone(), self.graphics, self.cars);
        std::thread::spawn(move || {
            let r = run_install(&game, g, c);
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
            header(ui);
            egui::Frame::new().inner_margin(egui::Margin { left: 20, right: 20, top: 4, bottom: 16 }).show(ui, |ui| {
                // 1. the game
                let game = card(ui, "GAME", |ui| match self.game.clone() {
                    Some(g) => {
                        ui.horizontal(|ui| {
                            ui.label(egui::RichText::new("✔").color(GREEN_HI).strong());
                            ui.label("Found in your Steam library");
                        });
                        ui.add(egui::Label::new(egui::RichText::new(g.display().to_string()).small().color(MUTED)).truncate());
                        Some(g)
                    }
                    None => {
                        ui.label(egui::RichText::new("Not found in your Steam libraries.").color(RED));
                        ui.label("Paste the game folder (the one that has Gameface inside):");
                        ui.text_edit_singleline(&mut self.path_text);
                        if ui.button("Use this folder").clicked() {
                            let p = PathBuf::from(self.path_text.trim()).join(r"Gameface\Binaries\Win64");
                            if p.join("SanAndreas.exe").is_file() {
                                self.game = Some(p);
                            } else {
                                self.result = Some((false, vec!["SanAndreas.exe is not in that folder.".into()]));
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
                        ui.checkbox(&mut self.cars, "Better car handling: more grip, stronger brakes");
                        ui.add_space(4.0);
                        ui.horizontal(|ui| {
                            ui.label("Graphics");
                            for (i, (name, _)) in GRAPHICS.iter().enumerate() {
                                ui.selectable_value(&mut self.graphics, i, *name);
                            }
                        });
                        ui.label(
                            egui::RichText::new("High for most PCs (RTX 3060 and up), Ultra for RTX 4070 and up. Off keeps the game's own look.")
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
                        ui.label("Installing… this takes a few seconds.");
                    });
                } else if is_installed {
                    if big_button(ui, "Play", true).clicked() {
                        start_game();
                    }
                    if big_button(ui, "Apply options / reinstall", false).clicked() {
                        self.start(game.clone());
                    }
                } else if big_button(ui, "Install", true).clicked() {
                    self.start(game.clone());
                }

                if let Some((ok, log)) = &self.result {
                    let (icon, text, color) = if *ok {
                        ("✔", "Done. Click Play, then pick co-op in the game's main menu.", GREEN_HI)
                    } else {
                        ("✖", "Something went wrong. Details below.", RED)
                    };
                    ui.label(egui::RichText::new(format!("{icon} {text}")).color(color));
                    egui::CollapsingHeader::new("Details").default_open(!*ok).show(ui, |ui| {
                        for m in log {
                            ui.label(egui::RichText::new(m).small().color(MUTED));
                        }
                    });
                }
                egui::CollapsingHeader::new("What this installer changes").show(ui, |ui| {
                    for line in [
                        "Adds to the game's Win64 folder: version.dll (ASI Loader), cleo_redux64.asi (CLEO Redux), coopnet64.asi and the CLEO folder.",
                        "Adds Content\\Paks\\~mods\\coop_P.pak (the co-op menu entry) and coopcars_P.pak (car handling), both built from your own game files.",
                        "Writes Engine.ini for the graphics preset. Your own Engine.ini is kept as Engine.ini.before-sa-coop.",
                        "Never touches your saves or other game files. Uninstall removes everything.",
                    ] {
                        ui.label(egui::RichText::new(format!("• {line}")).small().color(MUTED));
                    }
                });

                // footer
                ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| {
                    ui.horizontal(|ui| {
                        ui.hyperlink_to(egui::RichText::new("Open source on GitHub").small(), REPO);
                        ui.label(
                            egui::RichText::new(format!("v{}  ·  not affiliated with Rockstar Games", env!("CARGO_PKG_VERSION")))
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
