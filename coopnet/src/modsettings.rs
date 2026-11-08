//! The mod's own options (the installer's checkboxes), also changeable from the co-op menu's Settings tab.
//! Stored in %LOCALAPPDATA%\sa-de-coop\cars.txt, the same file the installer writes. Tougher enemies works at once
//! (its script asks coop_setting(2)); the rest change game files that are locked while the game runs, so the menu
//! starts Win64\sa-coop\SA-Coop.exe --apply-when-closed, which applies them as soon as the game has closed.

use std::sync::Mutex;

#[derive(Clone, Copy, PartialEq)]
pub struct Opts {
    pub grip: bool,
    pub fast: bool,
    pub range: bool,
    pub tough: bool,
    pub gfx: u8, // 0 off, 1 balanced, 2 high, 3 ultra
    pub dlss: bool,
}

pub const GFX: [&str; 4] = ["Off", "Balanced", "High", "Ultra"];

fn file() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA").unwrap_or_default()).join(r"sa-de-coop\cars.txt")
}

fn read() -> Opts {
    let t = std::fs::read_to_string(file()).unwrap_or_default();
    let flag = |k: &str| t.lines().any(|l| l.trim() == format!("{k}=1"));
    let gfx = t.lines().find_map(|l| l.trim().strip_prefix("gfx=")?.parse::<u8>().ok()).unwrap_or(2).min(3);
    Opts { grip: flag("grip"), fast: flag("fast"), range: flag("range"), tough: flag("tough"), gfx, dlss: flag("dlss") }
}

fn state() -> &'static Mutex<Option<Opts>> {
    static S: Mutex<Option<Opts>> = Mutex::new(None);
    &S
}

pub fn get() -> Opts {
    let mut s = state().lock().unwrap();
    *s.get_or_insert_with(read)
}

/// Save a change; for anything but tougher enemies, make sure the helper will apply it after the game closes.
pub fn set(o: Opts) {
    let before = get();
    *state().lock().unwrap() = Some(o);
    if let Some(dir) = file().parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(
        file(),
        format!(
            "grip={}\nfast={}\nrange={}\ntough={}\ngfx={}\ndlss={}\n",
            o.grip as u8, o.fast as u8, o.range as u8, o.tough as u8, o.gfx, o.dlss as u8
        ),
    );
    let needs_restart = Opts { tough: before.tough, ..o } != before;
    if needs_restart {
        start_helper();
    }
}

/// Changes that wait for the game to close (shown in the menu).
pub fn pending() -> bool {
    HELPER.load(std::sync::atomic::Ordering::SeqCst)
}

static HELPER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn start_helper() {
    use std::os::windows::process::CommandExt;
    if HELPER.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return; // one helper per game run is enough: it reads the file when the game has closed
    }
    let exe = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.join(r"sa-coop\SA-Coop.exe")));
    match exe {
        Some(exe) if exe.is_file() => {
            // DETACHED_PROCESS | CREATE_NO_WINDOW: no console, keeps running after the game closes
            let r = std::process::Command::new(&exe).arg("--apply-when-closed").creation_flags(0x0000_0008 | 0x0800_0000).spawn();
            crate::log_line(&format!("settings: helper {}", if r.is_ok() { "started" } else { "failed to start" }));
        }
        _ => {
            crate::log_line("settings: helper missing; run SA-Coop.exe to apply");
            HELPER.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
}
