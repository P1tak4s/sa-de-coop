//! sa-coop.exe: install the mod into GTA San Andreas The Definitive Edition, host a game (the server runs here)
//! or join one with a code, then start the game through Steam. Like Saints Row 2: everything before the game starts.
#![windows_subsystem = "windows"]

use eframe::egui;
use proto::*;
use relay::{lan_ip, random_key, run_server, upnp, Players};
use std::net::{SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

const STEAM_APP: &str = "steam://rungameid/1547000";
const GAME_SUBDIR: &str = r"steamapps\common\GTA San Andreas - The Definitive Edition\Gameface\Binaries\Win64";

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_inner_size([460.0, 520.0]).with_resizable(false),
        ..Default::default()
    };
    eframe::run_native("SA Co-op", options, Box::new(|_| Ok(Box::new(App::new()))))
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

// ---- session file the game's DLL reads --------------------------------------------------------------------

fn write_session(server: SocketAddr, key: u32, nick: &str) -> std::io::Result<()> {
    let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join("sa-de-coop");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("session.txt"), format!("server={server}\nkey={key:08x}\nnick={nick}\n"))
}

fn start_game() {
    use std::os::windows::process::CommandExt;
    let _ = std::process::Command::new("cmd").args(["/C", "start", "", STEAM_APP]).creation_flags(0x0800_0000).spawn();
}

// ---- UI -------------------------------------------------------------------------------------------------

#[derive(PartialEq)]
enum Tab {
    Host,
    Join,
}

struct Hosting {
    internet_code: Option<String>,
    lan_code: Option<String>,
    players: Players,
}

struct App {
    game: Option<PathBuf>,
    nick: String,
    tab: Tab,
    code: String,
    hosting: Option<Hosting>,
    msg: Vec<String>,
}

impl App {
    fn new() -> App {
        App { game: find_game(), nick: "Player".into(), tab: Tab::Host, code: String::new(), hosting: None, msg: vec![] }
    }

    fn host(&mut self) {
        let sock = match UdpSocket::bind(("0.0.0.0", DEFAULT_PORT)) {
            Ok(s) => s,
            Err(e) => return self.msg.push(format!("Could not open port {DEFAULT_PORT}: {e}")),
        };
        let key = random_key();
        let players: Players = Arc::default();
        let p2 = players.clone();
        std::thread::spawn(move || run_server(sock, key, p2));
        let internet_code = upnp(DEFAULT_PORT).map(|ip| make_code(ip.octets(), DEFAULT_PORT, key));
        let lan_code = lan_ip().map(|ip| make_code(ip.octets(), DEFAULT_PORT, key));
        if internet_code.is_none() {
            self.msg.push(format!("The router did not open the port (UPnP). For a friend over the internet, open UDP {DEFAULT_PORT} by hand."));
        }
        if let Err(e) = write_session(SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT)), key, &self.nick) {
            self.msg.push(format!("Could not save the session: {e}"));
        }
        self.hosting = Some(Hosting { internet_code, lan_code, players });
    }

    fn join(&mut self) -> bool {
        let Some((ip, port, key)) = parse_code(&self.code) else {
            self.msg.push("Invalid code: it must have 16 characters.".into());
            return false;
        };
        match write_session(SocketAddr::from((ip, port)), key, &self.nick) {
            Ok(()) => true,
            Err(e) => {
                self.msg.push(format!("Could not save the session: {e}"));
                false
            }
        }
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _: &mut eframe::Frame) {
        ctx.request_repaint_after(Duration::from_millis(500));
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("SA Co-op");
            ui.label("GTA San Andreas – The Definitive Edition");
            ui.separator();

            match self.game.clone() {
                None => {
                    ui.colored_label(egui::Color32::RED, "Game not found in your Steam libraries.");
                    return;
                }
                Some(game) => {
                    if installed(&game) {
                        ui.label("✔ Mod installed");
                    } else {
                        ui.label("Mod not installed yet.");
                    }
                    if ui.button("Install / update mod").clicked() {
                        match install(&game) {
                            Ok(l) => self.msg.extend(l),
                            Err(e) => self.msg.push(e),
                        }
                    }
                }
            }
            ui.separator();

            ui.horizontal(|ui| {
                ui.label("Nickname:");
                ui.add(egui::TextEdit::singleline(&mut self.nick).char_limit(NICK_LEN));
            });
            ui.horizontal(|ui| {
                ui.selectable_value(&mut self.tab, Tab::Host, "Host game");
                ui.selectable_value(&mut self.tab, Tab::Join, "Join");
            });
            ui.add_space(6.0);

            match self.tab {
                Tab::Host => match &self.hosting {
                    None => {
                        ui.label("The server runs on this PC. Give your friend the code.");
                        if ui.button("Host game").clicked() {
                            self.host();
                        }
                    }
                    Some(h) => {
                        for (label, code) in [("Code for a friend over the internet:", &h.internet_code), ("Code on the same network:", &h.lan_code)] {
                            if let Some(code) = code {
                                ui.label(label);
                                ui.horizontal(|ui| {
                                    ui.monospace(code);
                                    if ui.button("Copy").clicked() {
                                        ctx.copy_text(code.clone());
                                    }
                                });
                            }
                        }
                        let players = h.players.lock().unwrap().clone();
                        ui.label(format!("Joined: {}", if players.is_empty() { "nobody yet".into() } else { players.join(", ") }));
                        if ui.button("Start game").clicked() {
                            start_game();
                        }
                        ui.small("Keep this window open while you play: the server runs in it.");
                    }
                },
                Tab::Join => {
                    ui.label("Friend's code:");
                    ui.text_edit_singleline(&mut self.code);
                    if ui.button("Join and start game").clicked() && self.join() {
                        start_game();
                        self.msg.push("Starting the game. You join automatically once you load a save.".into());
                    }
                }
            }

            ui.separator();
            for m in self.msg.iter().rev().take(6) {
                ui.small(m);
            }
        });
    }
}
