//! AI partner brain: TypeSafe Jev picks the partner's next action from a short situation text (about 0.3 s).
//! The request runs on its own thread; the script polls the answer. Key: %USERPROFILE%\.config\jev\.env
//! (TYPESAFE_API_KEY), the same file the jev skills and pilot read. Nothing is sent but the situation text.

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

pub static ENABLED: AtomicBool = AtomicBool::new(false);
static BUSY: AtomicBool = AtomicBool::new(false);
static RESULT: AtomicI32 = AtomicI32::new(-1);

/// Index order is the script's: 0 follow, 1 enter_car, 2 attack, 3 take_cover, 4 wait.
pub const ACTIONS: [(&str, &str); 5] = [
    ("follow", "walk or run after CJ and stay close, CJ is moving or nothing is happening"),
    ("enter_car", "get into CJ's car as a passenger because CJ is in a car"),
    ("attack", "shoot the nearest enemy who is attacking CJ or the partner"),
    ("take_cover", "get away from the enemies and hide because the partner is badly hurt"),
    ("wait", "stand still where you are, CJ told you to wait or is standing still nearby"),
];

fn key() -> Option<String> {
    let home = std::env::var_os("USERPROFILE")?;
    let text = std::fs::read_to_string(std::path::PathBuf::from(home).join(r".config\jev\.env")).ok()?;
    text.lines()
        .find_map(|l| l.trim().strip_prefix("TYPESAFE_API_KEY").map(|v| v.trim_start_matches([' ', '=']).trim().trim_matches(['"', '\'']).to_string()))
        .filter(|k| !k.is_empty())
}

fn ask_jev(situation: &str) -> Option<i32> {
    let key = key()?;
    let mut criteria = serde_json::Map::new();
    for (name, about) in ACTIONS {
        criteria.insert(name.into(), serde_json::Value::String(about.into()));
    }
    let body = serde_json::json!({
        "model": "jev-latest",
        "state": {
            "task": "You control the co-op partner of CJ in GTA San Andreas. Pick the partner's next action. If CJ gave an order, follow the order.",
            "situation": situation,
        },
        "questions": { "action": { "type": "choice", "instructions": "What should the partner do now?", "criteria": criteria } }
    });
    let resp = ureq::post("https://api.typesafe.ai/v1/systemone")
        .timeout(std::time::Duration::from_secs(4))
        .set("authorization", &format!("Bearer {key}"))
        .send_json(body)
        .ok()?;
    let v: serde_json::Value = resp.into_json().ok()?;
    let answers = v.get("answers").or_else(|| v.get("result").and_then(|r| r.get("answers")))?;
    let choice = answers.get("action")?.get("choice")?.as_str()?;
    ACTIONS.iter().position(|(n, _)| *n == choice).map(|i| i as i32)
}

/// Start a question about `situation` unless one is already on its way. 1 = asked, 0 = busy.
pub fn ask(situation: String) -> i64 {
    if BUSY.swap(true, Ordering::SeqCst) {
        return 0;
    }
    std::thread::spawn(move || {
        match ask_jev(&situation) {
            Some(i) => RESULT.store(i, Ordering::SeqCst),
            None => crate::log_line("ai: no answer from Jev"),
        }
        BUSY.store(false, Ordering::SeqCst);
    });
    1
}

/// The latest answer once (-1 = none yet).
pub fn take() -> i64 {
    RESULT.swap(-1, Ordering::SeqCst) as i64
}
