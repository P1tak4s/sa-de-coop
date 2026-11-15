//! Two save sets: the player's own and a co-op one. Switching moves the game's .sav files between the profile
//! folder and %LOCALAPPDATA%\sa-de-coop\saves-solo / saves-coop, after a timestamped backup of whatever is there.
//! Every game start goes back to the player's own saves, so a crash can never leave them hidden.

use std::path::{Path, PathBuf};

fn data_dir() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("sa-de-coop"))
}

/// Documents\Rockstar Games\GTA San Andreas Definitive Edition\Profiles\<id>: the one with saves, else the first.
/// Documents may be redirected to OneDrive, and there may be several profile folders: the one the game is using is
/// the one with the most recently changed file (the game touches its profile data every time it starts). Before
/// 11-15 this took Documents\...\Profiles and the first folder with saves: on a PC with OneDrive documents the
/// host's save went into a folder the game never reads ("it says slot 9 but that slot is empty").
fn profile_dir() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("USERPROFILE")?);
    let mut dirs: Vec<PathBuf> = vec![];
    for docs in ["Documents", r"OneDrive\Documents"] {
        let root = home.join(docs).join(r"Rockstar Games\GTA San Andreas Definitive Edition\Profiles");
        if let Ok(rd) = std::fs::read_dir(&root) {
            dirs.extend(rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()));
        }
    }
    let newest = |d: &PathBuf| {
        std::fs::read_dir(d).ok().and_then(|rd| rd.flatten().filter_map(|e| e.metadata().and_then(|m| m.modified()).ok()).max())
    };
    dirs.into_iter().max_by_key(|d| newest(d))
}

fn saves_in(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|r| r.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("sav"))).collect())
        .unwrap_or_default()
}

/// The newest save in the game's profile folder (the set in use): (file name, bytes). What the host sends a guest.
pub fn newest_save() -> Option<(String, Vec<u8>)> {
    let profile = profile_dir()?;
    let newest = saves_in(&profile).into_iter().max_by_key(|p| p.metadata().and_then(|m| m.modified()).ok())?;
    let name = newest.file_name()?.to_str()?.to_string();
    Some((name, std::fs::read(&newest).ok()?))
}

/// A guest got the host's save: switch to the co-op set (own saves backed up and put aside, as the menu toggle does)
/// and put the host's file in the profile under the host's slot name. Returns a line for the player.
pub fn receive_host_save(name: &str, bytes: &[u8]) -> Result<String, String> {
    let ok_name = name.len() < 32
        && name.to_ascii_lowercase().ends_with(".sav")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    if !ok_name || bytes.len() < 1000 || bytes.len() > 8_000_000 {
        return Err(format!("host save refused: {name}, {} bytes", bytes.len()));
    }
    if mode() != "coop" {
        switch_to("coop")?;
    }
    let profile = profile_dir().ok_or("game save folder not found")?;
    // always into slot 1: the host's newest save is often an autosave (GTASAsf9, GTASAsf10), which the Load Game
    // list shows in its own row or not at all. The co-op set is empty at this point, so slot 1 is free.
    let file = "GTASAsf1.sav";
    std::fs::write(profile.join(file), bytes).map_err(|e| format!("could not write host save: {e}"))?;
    crate::log_line(&format!("saves: host save {name} ({} bytes) written as {}", bytes.len(), profile.join(file).display()));
    Ok("Host's save received: Esc, Load Game, slot 1".into())
}

pub fn mode() -> String {
    data_dir().and_then(|d| std::fs::read_to_string(d.join("saves-mode.txt")).ok()).map(|s| s.trim().to_string()).unwrap_or_else(|| "solo".into())
}

/// Move the game's saves to `store_away`, bring in those from `bring_in`. Backup first; copy before delete.
fn swap(store_away: &Path, bring_in: &Path, backup: &Path, profile: &Path) -> std::io::Result<usize> {
    std::fs::create_dir_all(store_away)?;
    std::fs::create_dir_all(bring_in)?;
    std::fs::create_dir_all(backup)?;
    let current = saves_in(profile);
    for f in &current {
        let name = f.file_name().unwrap();
        std::fs::copy(f, backup.join(name))?;
    }
    for f in saves_in(store_away) {
        std::fs::remove_file(f)?; // the set we store away replaces its previous copy
    }
    for f in &current {
        std::fs::copy(f, store_away.join(f.file_name().unwrap()))?;
    }
    for f in &current {
        std::fs::remove_file(f)?;
    }
    let incoming = saves_in(bring_in);
    for f in &incoming {
        std::fs::copy(f, profile.join(f.file_name().unwrap()))?;
    }
    Ok(incoming.len())
}

/// Switch to "coop" or "solo". Returns a line for the player.
pub fn switch_to(target: &str) -> Result<String, String> {
    let data = data_dir().ok_or("LOCALAPPDATA is not set")?;
    let profile = profile_dir().ok_or("game save folder not found")?;
    if mode() == target {
        return Ok(String::new());
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let backup = data.join("saves-backup").join(stamp.to_string());
    let (away, inn) = if target == "coop" { (data.join("saves-solo"), data.join("saves-coop")) } else { (data.join("saves-coop"), data.join("saves-solo")) };
    let n = swap(&away, &inn, &backup, &profile).map_err(|e| format!("could not move the saves: {e}"))?;
    std::fs::write(data.join("saves-mode.txt"), target).map_err(|e| e.to_string())?;
    crate::log_line(&format!("saves: now {target}, {n} brought in, backup {}", backup.display()));
    Ok(if target == "coop" {
        if n == 0 { "No co-op saves yet: start a New Game and save.".into() } else { format!("Co-op saves loaded ({n}).") }
    } else {
        format!("Your own saves are back ({n}).")
    })
}
