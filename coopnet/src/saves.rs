//! Two save sets: the player's own and a co-op one. Switching moves the game's .sav files between the profile
//! folder and %LOCALAPPDATA%\sa-de-coop\saves-solo / saves-coop, after a timestamped backup of whatever is there.
//! Every game start goes back to the player's own saves, so a crash can never leave them hidden.

use std::path::{Path, PathBuf};

fn data_dir() -> Option<PathBuf> {
    Some(PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("sa-de-coop"))
}

/// Documents\Rockstar Games\GTA San Andreas Definitive Edition\Profiles\<id>: the one with saves, else the first.
fn profile_dir() -> Option<PathBuf> {
    let root = PathBuf::from(std::env::var_os("USERPROFILE")?).join(r"Documents\Rockstar Games\GTA San Andreas Definitive Edition\Profiles");
    let dirs: Vec<PathBuf> = std::fs::read_dir(&root).ok()?.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
    dirs.iter().find(|d| !saves_in(d).is_empty()).cloned().or_else(|| dirs.first().cloned())
}

fn saves_in(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|r| r.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("sav"))).collect())
        .unwrap_or_default()
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
