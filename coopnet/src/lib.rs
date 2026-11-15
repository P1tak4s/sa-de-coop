//! coopnet64.dll: loaded by the CLEO Redux script `sa-coop.js` (DynamicLibrary.Load) and called through Fn.X64.
//! Only integers cross the boundary: states go through memory the script allocates (layout = proto::State).
//! The network runs on its own thread, so a slow or lost packet never stalls the game.

mod ai;
mod dialog;
mod overlay;
mod saves;
mod modsettings;
mod scripthook;
mod steam;

use proto::*;
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const STALE: Duration = Duration::from_secs(3);

#[derive(Default)]
struct Shared {
    status: i32, // 0 off, 1 joining, 2 joined, 3 denied, 4 bad session
    slot: i32,
    mine: Option<State>,
    peers: [Option<(State, Instant)>; MAX_PLAYERS],
    stop: bool,
    code: Option<String>,       // host: the code to give friends (internet one once UPnP answers)
    revive_out: Option<u8>,     // a revive to send to that slot
    revived: bool,              // someone revived us; the script takes it once
    names: [String; MAX_PLAYERS],
    host: bool, // we created the session: our story is the one both play
    events_out: Vec<Vec<u8>>,                       // kind + text, to send
    events_in: std::collections::VecDeque<Vec<u8>>, // kind + text, received
    ents_out: Option<Vec<u8>>,                      // our latest mission entity batch (n + entries)
    ents_in: Option<(Vec<u8>, Instant)>,            // the latest batch from a friend
    world_out: Option<Vec<u8>>,                     // host: n entries of WORLD_SIZE around the guests, to send
    world_in: Vec<u8>,                              // guest: entries heard since the script last asked
}

fn shared() -> &'static Mutex<Shared> {
    static S: OnceLock<Mutex<Shared>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(Shared { slot: -1, ..Default::default() }))
}

struct Session {
    server: SocketAddr,
    key: u32,
    nick: String,
}

/// `%LOCALAPPDATA%\sa-de-coop\session.txt`, written by the launcher: `server=`, `key=` (hex), `nick=`.
fn read_session() -> Option<Session> {
    let path = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("sa-de-coop").join("session.txt");
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::rename(&path, path.with_extension("used"));
    let get = |k: &str| text.lines().find_map(|l| l.strip_prefix(k).map(|v| v.trim().to_string()));
    Some(Session {
        server: get("server=")?.to_socket_addrs().ok()?.next()?,
        key: u32::from_str_radix(&get("key=")?, 16).ok()?,
        nick: get("nick=").unwrap_or_else(|| "Player".into()),
    })
}

fn net_thread(sess: Session) {
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else {
        shared().lock().unwrap().status = 4;
        return;
    };
    let _ = sock.set_read_timeout(Some(Duration::from_millis(20)));
    let mut join = Vec::with_capacity(20);
    join.extend_from_slice(&sess.key.to_le_bytes());
    join.extend_from_slice(&nick_bytes(&sess.nick));
    let join = packet(JOIN, &join);
    let mut last_join = Instant::now() - Duration::from_secs(5);
    let mut last_send = Instant::now();
    let mut last_ents = Instant::now();
    let mut buf = [0u8; 4096];
    // short-code sessions have no reliable channel: the host's save goes out three times over, a few parts per
    // turn of this loop; the guest takes each part once
    let mut save_out: std::collections::VecDeque<Vec<u8>> = Default::default();
    let mut save_seen = [false; MAX_PLAYERS];
    let mut save = SaveIn::default();

    loop {
        let (status, mine, stop, revive) = {
            let mut s = shared().lock().unwrap();
            (s.status, s.mine, s.stop, s.revive_out.take())
        };
        if let (2, Some(target)) = (status, revive) {
            let _ = sock.send_to(&packet(REVIVE, &[target]), sess.server);
        }
        if status == 2 {
            for ev in std::mem::take(&mut shared().lock().unwrap().events_out) {
                let _ = sock.send_to(&packet(EVENT, &ev), sess.server);
            }
            if last_ents.elapsed() >= Duration::from_millis(200) {
                if let Some(b) = shared().lock().unwrap().ents_out.take() {
                    let _ = sock.send_to(&packet(ENTS, &b), sess.server);
                }
                last_ents = Instant::now();
            }
            if let Some(w) = shared().lock().unwrap().world_out.take() {
                for chunk in w.chunks(WORLD_PER_PACKET * WORLD_SIZE) {
                    let mut body = vec![(chunk.len() / WORLD_SIZE) as u8];
                    body.extend_from_slice(chunk);
                    let _ = sock.send_to(&packet(WORLD, &body), sess.server);
                }
            }
            // a friend we have not seen before: the host queues its save for them
            let (host, here) = {
                let s = shared().lock().unwrap();
                (s.host, std::array::from_fn::<bool, MAX_PLAYERS, _>(|i| s.peers[i].is_some()))
            };
            for i in 0..MAX_PLAYERS {
                if host && here[i] && !save_seen[i] {
                    let packets = save_packets();
                    for _ in 0..3 {
                        save_out.extend(packets.iter().cloned());
                    }
                }
                save_seen[i] = here[i];
            }
            for _ in 0..8 {
                let Some(p) = save_out.pop_front() else { break };
                let _ = sock.send_to(&p, sess.server);
            }
        }
        if stop {
            let _ = sock.send_to(&packet(LEAVE, &[]), sess.server);
            return;
        }
        // joining: every second; joined: every 3 s as a keepalive, so a pause in the menus (no state sent)
        // cannot get us dropped for good by the server's 10 s timeout
        let every = if status == 1 { Duration::from_secs(1) } else { Duration::from_secs(3) };
        if matches!(status, 1 | 2) && last_join.elapsed() > every {
            let _ = sock.send_to(&join, sess.server);
            last_join = Instant::now();
        }
        // 20 Hz is plenty for walking and driving; the script smooths in between
        if status == 2 && last_send.elapsed() >= Duration::from_millis(50) {
            if let Some(m) = mine {
                let _ = sock.send_to(&packet(STATE, &m.to_bytes()), sess.server);
            }
            last_send = Instant::now();
        }

        let Ok((n, from)) = sock.recv_from(&mut buf) else { continue };
        if from != sess.server {
            continue; // only the server may talk to us
        }
        let Some((kind, body)) = parse(&buf[..n]) else { continue };
        let mut s = shared().lock().unwrap();
        match kind {
            WELCOME if !body.is_empty() => {
                s.status = 2;
                s.slot = body[0] as i32;
            }
            DENY => s.status = 3,
            STATE if body.len() > STATE_SIZE => {
                let slot = body[0] as usize;
                if slot < MAX_PLAYERS && slot as i32 != s.slot {
                    if let Some(st) = State::from_bytes(&body[1..]) {
                        s.peers[slot] = Some((st, Instant::now()));
                    }
                }
            }
            EVENT if body.len() >= 2 && body[1] == scripthook::EV_REPLAY => scripthook::queue_replay(&body[2..]),
            EVENT if body.len() >= 2 && s.events_in.len() < 32 => s.events_in.push_back(body[1..].to_vec()),
            ENTS if body.len() >= 2 && body.len() == 2 + body[1] as usize * ENT_SIZE => s.ents_in = Some((body[1..].to_vec(), Instant::now())),
            WORLD if body.len() >= 2 && body.len() == 2 + body[1] as usize * WORLD_SIZE && (body[0] as usize) < MAX_PLAYERS => {
                let slot = body[0] as usize;
                world_in(&mut s, slot, &body[2..]);
            }
            SAVE if body.len() > 5 && !s.host => {
                drop(s);
                save.part(&body[1..]);
                continue;
            }
            NAMES if !body.is_empty() => {
                for e in body[1..].chunks_exact(1 + NICK_LEN).take(body[0] as usize) {
                    if (e[0] as usize) < MAX_PLAYERS {
                        // ASCII only: the game's font and our script both expect it
                        let n: String = e[1..].iter().take_while(|&&b| b != 0).filter(|b| b.is_ascii_graphic()).map(|&b| b as char).collect();
                        s.names[e[0] as usize] = n;
                    }
                }
            }
            REVIVE if body.len() == 2 && body[1] as i32 == s.slot => s.revived = true,
            LEAVE if !body.is_empty() && (body[0] as usize) < MAX_PLAYERS => s.peers[body[0] as usize] = None,
            _ => {}
        }
    }
}

fn start_client(sess: Session) -> i64 {
    let mut s = shared().lock().unwrap();
    if matches!(s.status, 1 | 2) {
        return 1;
    }
    s.status = 1;
    s.stop = false;
    drop(s);
    std::thread::spawn(move || net_thread(sess));
    1
}

fn my_nick() -> String {
    let n: String = std::env::var("USERNAME").unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric()).take(NICK_LEN).collect();
    if n.is_empty() { "Player".into() } else { n }
}

/// Joins the session the launcher wrote, if there is one. 1 = joining (or already in), 0 = no session.
#[no_mangle]
pub extern "C" fn coop_start() -> i64 {
    if matches!(shared().lock().unwrap().status, 1 | 2) {
        return 1;
    }
    match read_session() {
        Some(sess) => start_client(sess),
        None => 0,
    }
}

/// F9: run the server inside the game, join it, and make a code (copied to the clipboard). 1 = hosting.
#[no_mangle]
pub extern "C" fn coop_host() -> i64 {
    if matches!(shared().lock().unwrap().status, 1 | 2) {
        return 1;
    }
    let Ok(sock) = UdpSocket::bind(("0.0.0.0", DEFAULT_PORT)) else { return 0 };
    shared().lock().unwrap().host = true;
    let key = relay::random_key();
    std::thread::spawn(move || relay::run_server(sock, key, Default::default()));
    if let Some(ip) = relay::lan_ip() {
        set_code(make_code(ip.octets(), DEFAULT_PORT, key));
    }
    // UPnP can take seconds: the LAN code is there at once, the internet one replaces it when the router answers
    std::thread::spawn(move || {
        if let Some(ip) = relay::upnp(DEFAULT_PORT) {
            set_code(make_code(ip.octets(), DEFAULT_PORT, key));
        }
    });
    start_client(Session { server: SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT)), key, nick: my_nick() })
}

fn set_code(code: String) {
    log_line(&format!("code: {code}"));
    let _ = clipboard_win::set_clipboard_string(&code);
    shared().lock().unwrap().code = Some(code);
}

/// The host's current code as ASCII into `out` (up to `max` bytes). Returns its length, 0 = none yet.
#[no_mangle]
pub unsafe extern "C" fn coop_code(out: *mut u8, max: i64) -> i64 {
    let s = shared().lock().unwrap();
    let Some(code) = &s.code else { return 0 };
    if out.is_null() || (max as usize) < code.len() {
        return 0;
    }
    std::ptr::copy_nonoverlapping(code.as_ptr(), out, code.len());
    code.len() as i64
}

/// F10: join with the code on the clipboard. 1 = joining, 0 = no valid code there.
/// "Host on my PC" from the co-op menu: a UDP server here, the key from the password, a 7-symbol code with this
/// PC's public IP (the LAN one until the router answers UPnP), copied to the clipboard.
pub(crate) fn host_on_pc(pw: &str) -> i64 {
    leave_session();
    let Ok(sock) = UdpSocket::bind(("0.0.0.0", DEFAULT_PORT)) else {
        log_line("host on PC: port 7790 is busy");
        return 0;
    };
    shared().lock().unwrap().host = true;
    let key = key_from_password(pw);
    std::thread::spawn(move || relay::run_server(sock, key, Default::default()));
    if let Some(ip) = relay::lan_ip() {
        set_code(make_short_code(ip.octets()));
    }
    std::thread::spawn(move || {
        if let Some(ip) = relay::upnp(DEFAULT_PORT) {
            set_code(make_short_code(ip.octets()));
        } else {
            log_line("host on PC: the router did not open UDP 7790 (UPnP); a friend outside your network may not get in");
        }
    });
    start_client(Session { server: SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT)), key, nick: my_nick() })
}

/// Join a "host on my PC" session by its short code and the password.
pub(crate) fn join_code(code: &str, pw: &str) -> i64 {
    let Some(ip) = parse_short_code(code) else { return 0 };
    leave_session();
    start_client(Session { server: SocketAddr::from((ip, DEFAULT_PORT)), key: key_from_password(pw), nick: my_nick() })
}

/// The current code (host on my PC), if any.
pub(crate) fn current_code() -> Option<String> {
    shared().lock().unwrap().code.clone()
}

#[no_mangle]
pub extern "C" fn coop_join_clipboard() -> i64 {
    let Ok(text) = clipboard_win::get_clipboard_string() else { return 0 };
    let Some((ip, port, key)) = parse_code(text.trim()) else { return 0 };
    start_client(Session { server: SocketAddr::from((ip, port)), key, nick: my_nick() })
}

/// Player `slot`'s name (ASCII) into `out`. Returns its length, 0 = unknown.
#[no_mangle]
pub unsafe extern "C" fn coop_name(slot: i64, out: *mut u8, max: i64) -> i64 {
    if out.is_null() || !(0..MAX_PLAYERS as i64).contains(&slot) {
        return 0;
    }
    let s = shared().lock().unwrap();
    let n = &s.names[slot as usize];
    let len = n.len().min(max.max(0) as usize);
    std::ptr::copy_nonoverlapping(n.as_ptr(), out, len);
    len as i64
}

/// Queue an event for the others: kind (EV_*) and an ASCII text (null-terminated, up to 24 bytes).
#[no_mangle]
pub unsafe extern "C" fn coop_event_send(kind: i64, text: *const u8) -> i64 {
    let t = c_str(text);
    let mut ev = vec![kind as u8];
    ev.extend(t.bytes().filter(|b| b.is_ascii_graphic()).take(120));
    let mut s = shared().lock().unwrap();
    if s.events_out.len() < 32 {
        s.events_out.push(ev);
    }
    1
}

/// An event of raw bytes from the DLL itself (kind first), sent like the script's events.
pub fn send_raw_event(ev: Vec<u8>) {
    let mut s = shared().lock().unwrap();
    if s.events_out.len() < 64 {
        s.events_out.push(ev);
    }
}

/// The cheat picked in the co-op menu's Cheats tab since the last call (1-based, 0 = none). Read once.
#[no_mangle]
pub extern "C" fn coop_cheat_take() -> i64 {
    overlay::CHEAT.swap(0, std::sync::atomic::Ordering::SeqCst) as i64
}

/// 1 = a hit that would kill our player leaves it 2 health (it goes down instead); the script sets it while a friend
/// is connected and not down.
#[no_mangle]
pub extern "C" fn coop_down_not_dead(on: i64) -> i64 {
    scripthook::DOWN_NOT_DEAD.store(on != 0, std::sync::atomic::Ordering::Relaxed);
    1
}

/// How many of the host's scene commands this game has run (the script leaves the camera to them meanwhile).
#[no_mangle]
pub extern "C" fn coop_replayed() -> i64 {
    scripthook::REPLAYED.load(std::sync::atomic::Ordering::Relaxed) as i64
}

/// Next received event: returns its kind (0 = none) and writes its text, null-terminated, into `out` (128 bytes).
#[no_mangle]
pub unsafe extern "C" fn coop_event_poll(out: *mut u8) -> i64 {
    let Some(ev) = shared().lock().unwrap().events_in.pop_front() else { return 0 };
    if out.is_null() || ev.is_empty() {
        return 0;
    }
    let text: Vec<u8> = ev[1..].iter().copied().filter(|b| b.is_ascii_graphic() || *b == b' ').take(127).collect();
    std::ptr::copy_nonoverlapping(text.as_ptr(), out, text.len());
    *out.add(text.len()) = 0;
    ev[0] as i64
}

/// Our mission entities for the others: `n` entries of ENT_SIZE bytes at `data` (sent at 5 Hz, latest wins).
#[no_mangle]
pub unsafe extern "C" fn coop_ents_send(data: *const u8, n: i64) -> i64 {
    if data.is_null() || !(0..=MAX_ENTS as i64).contains(&n) {
        return 0;
    }
    let mut b = vec![n as u8];
    b.extend_from_slice(std::slice::from_raw_parts(data, n as usize * ENT_SIZE));
    shared().lock().unwrap().ents_out = Some(b);
    1
}

/// Entries of a friend's world for the script: each handle gets the friend's slot in its top byte (handles are
/// slot * 256 + flag, far below 2^24), so copies from two friends never mix and events find their owner.
fn world_in(s: &mut Shared, slot: usize, entries: &[u8]) {
    if s.world_in.len() > 400 * WORLD_SIZE {
        s.world_in.clear(); // the script stopped asking: start over
    }
    for e in entries.chunks_exact(WORLD_SIZE) {
        let at = s.world_in.len();
        s.world_in.extend_from_slice(e);
        s.world_in[at + 3] = slot as u8;
    }
}

/// The host's newest save as SAVE packets (part u16, parts u16, [name on part 0], bytes).
fn save_packets() -> Vec<Vec<u8>> {
    let Some((name, bytes)) = saves::newest_save() else {
        log_line("saves: no save to send to the guest");
        return vec![];
    };
    let parts = bytes.len().div_ceil(SAVE_PART) as u16;
    log_line(&format!("saves: sending {name} ({} bytes, {parts} parts) to the guest", bytes.len()));
    bytes
        .chunks(SAVE_PART)
        .enumerate()
        .map(|(i, chunk)| {
            let mut body = Vec::with_capacity(chunk.len() + 40);
            body.extend_from_slice(&(i as u16).to_le_bytes());
            body.extend_from_slice(&parts.to_le_bytes());
            if i == 0 {
                body.push(name.len() as u8);
                body.extend_from_slice(name.as_bytes());
            }
            body.extend_from_slice(chunk);
            packet(SAVE, &body)
        })
        .collect()
}

/// A guest putting the host's save together from its parts (in any order, repeats ignored; once per session).
#[derive(Default)]
struct SaveIn {
    name: String,
    parts: Vec<Option<Vec<u8>>>,
    done: bool,
}

impl SaveIn {
    fn part(&mut self, body: &[u8]) {
        if self.done || body.len() <= 4 {
            return;
        }
        let part = u16::from_le_bytes([body[0], body[1]]) as usize;
        let parts = u16::from_le_bytes([body[2], body[3]]) as usize;
        let mut data = &body[4..];
        if self.parts.len() != parts {
            self.parts = vec![None; parts.min(9000)];
        }
        if part == 0 {
            if data.is_empty() || data.len() < 1 + data[0] as usize {
                return;
            }
            self.name = String::from_utf8_lossy(&data[1..1 + data[0] as usize]).into_owned();
            data = &data[1 + data[0] as usize..];
        }
        if part >= self.parts.len() {
            return;
        }
        self.parts[part] = Some(data.to_vec());
        if self.parts.iter().all(|p| p.is_some()) {
            self.done = true;
            let bytes: Vec<u8> = self.parts.drain(..).flatten().flatten().collect();
            let line = saves::receive_host_save(&self.name, &bytes).unwrap_or_else(|e| e);
            log_line(&line);
            *overlay::SAVE_NOTE.lock().unwrap() = line.clone();
            shared().lock().unwrap().events_in.push_back([&[EV_NOTE][..], line.as_bytes()].concat());
        }
    }
}

/// The guest's script says whether it is in the host's story (1): only then are the guest's own missions refused.
#[no_mangle]
pub extern "C" fn coop_guest_lock(on: i64) -> i64 {
    scripthook::GUEST_LOCK.store(on != 0, std::sync::atomic::Ordering::Relaxed);
    1
}

/// A marker file in the data folder: op 1 = create, 2 = delete, 0 = 1 if it is there. A script sets one before
/// something that might kill the game and clears it after: still there on the next run = it did. (The script cannot
/// write files itself: CLEO only lets a script do that with [fs] in its file name.)
#[no_mangle]
pub unsafe extern "C" fn coop_flag(op: i64, name: *const u8) -> i64 {
    let n = c_str(name);
    if n.is_empty() || n.len() > 24 || !n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return 0;
    }
    let Some(dir) = std::env::var_os("LOCALAPPDATA").map(|d| std::path::PathBuf::from(d).join("sa-de-coop")) else { return 0 };
    let path = dir.join(format!("{n}.flag"));
    // The marker holds the game's process id. Loading a save restarts the scripts in the same process: a marker
    // left by this same process is not "the game died" (11-15 17:55: a load within 20 s of joining turned the game
    // thread claim off for good, on both PCs, and the crashes it prevents came back).
    let pid = std::process::id().to_string();
    match op {
        1 => {
            let _ = std::fs::create_dir_all(&dir);
            std::fs::write(&path, pid.as_bytes()).is_ok() as i64
        }
        2 => std::fs::remove_file(&path).is_ok() as i64,
        _ => std::fs::read_to_string(&path).is_ok_and(|t| t.trim() != pid) as i64,
    }
}

/// The last crash of this game, if it is new since the last report: its message and the first frames of its stack,
/// one line per call ("" when there is nothing more). The game writes it to Documents\Rockstar Games\GTA San Andreas
/// Definitive Edition\Crashes\<id>\CrashContext.runtime-xml; the friend could not see it (11-15 17:49: the
/// friend's game died 13 s after joining, and nothing of it reached this side). The script logs these lines, and
/// every logged line goes to the friends. Reported once: %LOCALAPPDATA%\sa-de-coop\crash-reported.txt.
#[no_mangle]
pub unsafe extern "C" fn coop_crash_line(out: *mut u8, max: i64) -> i64 {
    static LINES: Mutex<Option<Vec<String>>> = Mutex::new(None);
    let mut g = LINES.lock().unwrap();
    let lines = g.get_or_insert_with(|| {
        let mut l = crash_report().unwrap_or_default();
        l.extend(windows_crash().unwrap_or_default());
        l
    });
    if lines.is_empty() || out.is_null() || max <= 1 {
        return 0;
    }
    let l = lines.remove(0);
    let b: Vec<u8> = l.bytes().filter(|c| (32..127).contains(c)).take(max as usize - 1).collect();
    std::ptr::copy_nonoverlapping(b.as_ptr(), out, b.len());
    *out.add(b.len()) = 0;
    b.len() as i64
}

fn crash_report() -> Option<Vec<String>> {
    let home = std::path::PathBuf::from(std::env::var_os("USERPROFILE")?);
    let newest = ["Documents", r"OneDrive\Documents"].iter()
        .filter_map(|d| std::fs::read_dir(home.join(d).join(r"Rockstar Games\GTA San Andreas Definitive Edition\Crashes")).ok())
        .flat_map(|rd| rd.flatten())
        .filter_map(|e| { let f = e.path().join("CrashContext.runtime-xml"); let t = std::fs::metadata(&f).ok()?.modified().ok()?; Some((t, f)) })
        .max_by_key(|(t, _)| *t)?;
    let stamp = format!("{:?}", newest.0);
    let mark = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join(r"sa-de-coop\crash-reported.txt");
    if std::fs::read_to_string(&mark).ok().as_deref() == Some(stamp.as_str()) {
        return None;
    }
    let _ = std::fs::write(&mark, &stamp);
    let age = std::time::SystemTime::now().duration_since(newest.0).ok()?.as_secs();
    let text = std::fs::read_to_string(&newest.1).ok()?;
    let tag = |name: &str| -> Option<String> {
        let a = text.find(&format!("<{name}>"))? + name.len() + 2;
        let b = a + text[a..].find(&format!("</{name}>"))?;
        Some(text[a..b].to_string())
    };
    let mut out = vec![format!("CRASH {} min ago: {}", age / 60, tag("ErrorMessage").unwrap_or_default().trim())];
    if let Some(st) = tag("PCallStack") {
        for l in st.lines().map(|l| l.split_whitespace().collect::<Vec<_>>()).filter(|w| w.len() >= 4).take(4) {
            out.push(format!("CRASH at {} + {}", w_name(&l), l[3]));
        }
    }
    Some(out)
}
/// The game's last crash as Windows recorded it (Application Error, event 1000): some crashes leave no report of
/// the game's own (11-15 19:31: the friend's game died and nothing reached this side). Once per crash.
fn windows_crash() -> Option<Vec<String>> {
    use std::os::windows::process::CommandExt;
    let out = std::process::Command::new("wevtutil")
        .args(["qe", "Application", "/q:*[System[Provider[@Name='Application Error']]]", "/c:5", "/rd:true", "/f:text"])
        .creation_flags(0x0800_0000) // no console window
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let ev = text.split("Event[").find(|e| e.contains("SanAndreas.exe"))?;
    let field = |k: &str| ev.lines().find_map(|l| l.trim().strip_prefix(k).map(|v| v.trim().to_string())).unwrap_or_default();
    let date = field("Date:");
    let mark = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join(r"sa-de-coop\crash-event-reported.txt");
    if date.is_empty() || std::fs::read_to_string(&mark).ok().as_deref() == Some(date.as_str()) {
        return None;
    }
    let _ = std::fs::write(&mark, &date);
    Some(vec![format!(
        "CRASH (Windows) {date}: {} + {} code {}",
        field("Faulting module name:").split(',').next().unwrap_or(""),
        field("Fault offset:"),
        field("Exception code:")
    )])
}

fn w_name(w: &[&str]) -> String {
    w[0].to_string()
}

/// The newest release's version ("0.8.22"), asked from GitHub once per run in the background; empty until known.
/// The script tells the player when it is newer than what runs.
#[no_mangle]
pub unsafe extern "C" fn coop_latest(out: *mut u8, max: i64) -> i64 {
    static LATEST: Mutex<String> = Mutex::new(String::new());
    static ASKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !ASKED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        std::thread::spawn(|| loop {
            let got = ureq::get("https://api.github.com/repos/P1tak4s/sa-de-coop/releases?per_page=1")
                .set("User-Agent", "sa-coop")
                .timeout(Duration::from_secs(10))
                .call()
                .ok()
                .and_then(|r| r.into_string().ok());
            if let Some(text) = got {
                // "tag_name":"v0.8.22"
                if let Some(at) = text.find("\"tag_name\"") {
                    let rest = &text[at + 10..];
                    let v: String = rest.chars().skip_while(|c| !c.is_ascii_digit()).take_while(|c| c.is_ascii_digit() || *c == '.').collect();
                    if v.split('.').count() == 3 {
                        *LATEST.lock().unwrap() = v;
                    }
                }
            }
            std::thread::sleep(Duration::from_secs(300)); // again every 5 minutes: a session lasts hours
        });
    }
    if out.is_null() || max <= 1 {
        return 0;
    }
    let s = LATEST.lock().unwrap().clone();
    let n = s.len().min(max as usize - 1);
    std::ptr::copy_nonoverlapping(s.as_ptr(), out, n);
    *out.add(n) = 0;
    n as i64
}

/// This build of the game is the one our addresses are for (the script hook found its tables).
pub(crate) fn game_build_ok() -> bool {
    scripthook::installed()
}

/// The script's turn begins: its thread counts as the game thread (see scripthook). 1 = done.
#[no_mangle]
pub unsafe extern "C" fn coop_claim() -> i64 {
    scripthook::claim() as i64
}

/// The script is about to wait: the real game thread is put back.
#[no_mangle]
pub unsafe extern "C" fn coop_release() -> i64 {
    scripthook::release();
    1
}

/// Leave a parameterless command for the game's own thread (see scripthook). 1 = queued, 0 = not allowed or the
/// game thread is not known yet.
#[no_mangle]
pub extern "C" fn coop_native(op: i64) -> i64 {
    scripthook::queue_native(op as u32) as i64
}

/// How many queued commands the game thread has carried out so far.
#[no_mangle]
pub extern "C" fn coop_native_done() -> i64 {
    scripthook::NATIVE_DONE.load(std::sync::atomic::Ordering::Relaxed) as i64
}

/// 1 when the player pressed the cutscene skip button since the last call (with a friend connected the game did not
/// skip: see scripthook). Read once.
#[no_mangle]
pub extern "C" fn coop_skip_take() -> i64 {
    scripthook::SKIP_PRESSED.swap(false, std::sync::atomic::Ordering::Relaxed) as i64
}

/// 1 = both players want to skip: the game skips the running cutscene on its next frame. 0 = take that back (no
/// cutscene is running any more: an unused "yes" must not skip the next one).
#[no_mangle]
pub extern "C" fn coop_skip_allow(on: i64) -> i64 {
    scripthook::SKIP_OK.store(on != 0, std::sync::atomic::Ordering::Relaxed);
    1
}

/// Why the game was just told "no mission now" (0 = it was not): 1 guest, 2 the host's partner is not near. Read once.
#[no_mangle]
pub extern "C" fn coop_take_refused() -> i64 {
    scripthook::REFUSED.swap(0, std::sync::atomic::Ordering::Relaxed) as i64
}

/// 1 when some script of the mod made this ped or car and keeps it (the AI partner, a kept car, a copy).
#[no_mangle]
pub extern "C" fn coop_tracked(handle: i64) -> i64 {
    tracked().lock().unwrap().iter().any(|e| e[3] == handle as i32) as i64
}

/// A line from the DLL for the script to show (local, never sent): event kind 20, text.
pub const EV_NOTE: u8 = 20;

/// Host: the ordinary peds and cars around the guests, `n` entries of WORLD_SIZE bytes (latest wins).
#[no_mangle]
pub unsafe extern "C" fn coop_world_send(data: *const u8, n: i64) -> i64 {
    if data.is_null() || !(0..=240).contains(&n) {
        return 0;
    }
    shared().lock().unwrap().world_out = Some(std::slice::from_raw_parts(data, n as usize * WORLD_SIZE).to_vec());
    1
}

/// Guest: the host's entries heard since the last call into `out` (room for `max`). Returns how many.
#[no_mangle]
pub unsafe extern "C" fn coop_world_get(out: *mut u8, max: i64) -> i64 {
    if out.is_null() || max <= 0 {
        return 0;
    }
    let mut s = shared().lock().unwrap();
    let n = (s.world_in.len() / WORLD_SIZE).min(max as usize);
    // more than room: keep the newest
    let start = s.world_in.len() - n * WORLD_SIZE;
    std::ptr::copy_nonoverlapping(s.world_in[start..].as_ptr(), out, n * WORLD_SIZE);
    s.world_in.clear();
    n as i64
}

/// A friend's latest mission entities into `out` (MAX_ENTS x ENT_SIZE bytes). Returns how many; -1 = none for 2 s.
#[no_mangle]
pub unsafe extern "C" fn coop_ents_get(out: *mut u8) -> i64 {
    let s = shared().lock().unwrap();
    match &s.ents_in {
        Some((b, at)) if at.elapsed() < Duration::from_secs(2) && !out.is_null() => {
            let n = b[0] as usize;
            std::ptr::copy_nonoverlapping(b[1..].as_ptr(), out, n * ENT_SIZE);
            n as i64
        }
        _ => -1,
    }
}

fn car_file() -> Option<std::path::PathBuf> {
    let dir = std::path::PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("sa-de-coop");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("mano-masina.bin"))
}

/// Remember your car across save/load: 28 bytes (model i32, x, y, z, heading f32, color1, color2 i32).
/// A null pointer forgets it (the car was wrecked).
#[no_mangle]
pub unsafe extern "C" fn coop_car_store(data: *const u8) -> i64 {
    let Some(path) = car_file() else { return 0 };
    if data.is_null() {
        let _ = std::fs::remove_file(path);
        return 1;
    }
    std::fs::write(path, std::slice::from_raw_parts(data, 28)).is_ok() as i64
}

/// The remembered car into `out` (28 bytes). 1 = there is one.
#[no_mangle]
pub unsafe extern "C" fn coop_car_load(out: *mut u8) -> i64 {
    let Some(bytes) = car_file().and_then(|p| std::fs::read(p).ok()) else { return 0 };
    if out.is_null() || bytes.len() != 28 {
        return 0;
    }
    let model = i32::from_le_bytes(bytes[0..4].try_into().unwrap());
    if !(400..=611).contains(&model) {
        return 0;
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, 28);
    1
}

/// Revive the player in `slot` (the script checked they are down and we stand next to them).
#[no_mangle]
pub extern "C" fn coop_revive(slot: i64) -> i64 {
    if !(0..MAX_PLAYERS as i64).contains(&slot) {
        return 0;
    }
    shared().lock().unwrap().revive_out = Some(slot as u8);
    1
}

/// 1 once after a friend revived us.
#[no_mangle]
pub extern "C" fn coop_take_revived() -> i64 {
    std::mem::take(&mut shared().lock().unwrap().revived) as i64
}

// ---- entities our scripts created: survives a script reload, so the new copy can delete the old ones ---------
// (a reloaded CLEO script forgets its handles and the cars stayed in the world as "ghosts")

fn tracked() -> &'static Mutex<Vec<[i32; 4]>> {
    static T: OnceLock<Mutex<Vec<[i32; 4]>>> = OnceLock::new();
    T.get_or_init(|| Mutex::new(Vec::new()))
}

/// Remember an entity: owner (1 sa-coop, 2 ai-partneris), kind (1 car, 2 ped), model, script handle.
/// Plain small integers only: JavaScript passes them exactly.
#[no_mangle]
pub extern "C" fn coop_track(owner: i64, kind: i64, model: i64, handle: i64) -> i64 {
    let e = [owner as i32, kind as i32, model as i32, handle as i32];
    let mut t = tracked().lock().unwrap();
    if !t.contains(&e) && t.len() < 512 {
        t.push(e);
    }
    1
}

/// Forget an entity the script deleted itself.
#[no_mangle]
pub extern "C" fn coop_untrack(handle: i64) -> i64 {
    tracked().lock().unwrap().retain(|e| e[3] != handle as i32);
    1
}

/// Take one remembered entity of `owner` into `out` (kind, model, handle as 3 x i32): 1, or 0 when none are left.
///
/// # Safety
/// `out` must point to 12 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn coop_take_tracked(owner: i64, out: *mut i32) -> i64 {
    if out.is_null() {
        return 0;
    }
    let mut t = tracked().lock().unwrap();
    match t.iter().position(|e| e[0] == owner as i32) {
        Some(i) => {
            let e = t.swap_remove(i);
            *out = e[1];
            *out.add(1) = e[2];
            *out.add(2) = e[3];
            1
        }
        None => 0,
    }
}

// ---- Steam mode: a named lobby with a password, P2P through Steam, no server and no ports --------------------

unsafe fn c_str(p: *const u8) -> String {
    if p.is_null() {
        return String::new();
    }
    std::ffi::CStr::from_ptr(p as *const std::ffi::c_char).to_string_lossy().trim().to_string()
}

/// Status codes the script shows: 5 = no lobby by that name, 6 = wrong password, 7 = Steam failed, 8 = lobby full.
fn steam_thread(host: bool, name: String, pw: String) {
    let fail = |code: i32| shared().lock().unwrap().status = code;
    let st = match steam::Steam::load() {
        Ok(st) => st,
        Err(e) => {
            log_line(&format!("steam: {e}"));
            return fail(7);
        }
    };
    let hash = steam::pw_hash(&pw);
    let lobby = if host {
        match st.host(&name, &hash) {
            Some(l) => l,
            None => return fail(7),
        }
    } else {
        match st.join(&name, &hash) {
            Ok(l) => l,
            Err("not found") => return fail(5),
            Err("password") => return fail(6),
            Err("full") => return fail(8),
            Err(_) => return fail(7),
        }
    };
    log_line(&format!("steam: in lobby {lobby} as {}", st.me()));

    let mut buf = [0u8; 4096];
    let mut members: Vec<u64> = vec![];
    let mut save_sent: Vec<u64> = vec![];
    let mut save = SaveIn::default();
    let mut last_members = Instant::now() - Duration::from_secs(5);
    let mut last_send = Instant::now();
    loop {
        if last_members.elapsed() > Duration::from_secs(1) {
            members = st.members(lobby);
            let mut s = shared().lock().unwrap();
            s.slot = members.iter().position(|&m| m == st.me()).map_or(-1, |i| i as i32);
            s.status = 2;
            for (i, &m) in members.iter().enumerate() {
                st.accept(m);
                s.names[i] = st.name_of(m).chars().filter(|c| c.is_ascii_graphic() || *c == ' ').take(NICK_LEN).collect();
            }
            for i in members.len()..MAX_PLAYERS {
                s.peers[i] = None;
            }
            last_members = Instant::now();
        }
        let (mine, stop, revive, my_slot) = {
            let mut s = shared().lock().unwrap();
            (s.mine, s.stop, s.revive_out.take(), s.slot)
        };
        if stop {
            st.leave(lobby);
            return;
        }
        let others = members.iter().copied().filter(|&m| m != st.me());
        if last_send.elapsed() >= Duration::from_millis(50) {
            if let Some(m) = mine {
                let p = packet(STATE, &m.to_bytes());
                for to in others.clone() {
                    st.send(to, &p, steam::SEND_UNRELIABLE);
                }
            }
            last_send = Instant::now();
        }
        if let Some(b) = shared().lock().unwrap().ents_out.take() {
            for to in members.iter().copied().filter(|&m| m != st.me()) {
                st.send(to, &packet(ENTS, &b), steam::SEND_UNRELIABLE);
            }
        }
        if let Some(w) = shared().lock().unwrap().world_out.take() {
            for chunk in w.chunks(WORLD_PER_PACKET * WORLD_SIZE) {
                let mut body = vec![(chunk.len() / WORLD_SIZE) as u8];
                body.extend_from_slice(chunk);
                let p = packet(WORLD, &body);
                for to in members.iter().copied().filter(|&m| m != st.me()) {
                    st.send(to, &p, steam::SEND_UNRELIABLE);
                }
            }
        }
        // the host gives every guest that joins its newest save, so both play the same story (11-15)
        if host {
            let new: Vec<u64> = members.iter().copied().filter(|&m| m != st.me() && !save_sent.contains(&m)).collect();
            for m in new {
                save_sent.push(m);
                for p in save_packets() {
                    st.send(m, &p, steam::SEND_RELIABLE);
                }
            }
        }
        for ev in std::mem::take(&mut shared().lock().unwrap().events_out) {
            let mut body = vec![my_slot.max(0) as u8];
            body.extend_from_slice(&ev);
            for to in members.iter().copied().filter(|&m| m != st.me()) {
                st.send(to, &packet(EVENT, &body), steam::SEND_RELIABLE);
            }
        }
        if let Some(t) = revive {
            if let Some(&to) = members.get(t as usize) {
                st.send(to, &packet(REVIVE, &[my_slot.max(0) as u8, t]), steam::SEND_RELIABLE);
            }
        }
        let mut got = false;
        while let Some((from, n)) = st.recv(&mut buf) {
            got = true;
            let Some(slot) = members.iter().position(|&m| m == from) else { continue }; // not in our lobby
            let Some((kind, body)) = parse(&buf[..n]) else { continue };
            let mut s = shared().lock().unwrap();
            match kind {
                STATE if body.len() == STATE_SIZE => {
                    if let Some(stt) = State::from_bytes(body) {
                        s.peers[slot] = Some((stt, Instant::now()));
                    }
                }
                REVIVE if body.len() == 2 && body[1] as i32 == s.slot => s.revived = true,
                EVENT if body.len() >= 2 && body[1] == scripthook::EV_REPLAY => scripthook::queue_replay(&body[2..]),
                EVENT if body.len() >= 2 && s.events_in.len() < 32 => s.events_in.push_back(body[1..].to_vec()),
                ENTS if !body.is_empty() && body.len() == 1 + body[0] as usize * ENT_SIZE => s.ents_in = Some((body.to_vec(), Instant::now())),
                WORLD if !body.is_empty() && body.len() == 1 + body[0] as usize * WORLD_SIZE => world_in(&mut s, slot, &body[1..]),
                SAVE if body.len() > 4 && !host => {
                    drop(s);
                    save.part(body);
                }
                _ => {}
            }
        }
        if !got {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

fn log_line(text: &str) {
    if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
        let p = std::path::PathBuf::from(dir).join("sa-de-coop");
        let _ = std::fs::create_dir_all(&p);
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p.join("coopnet.log")) {
            let _ = writeln!(f, "{text}");
        }
    }
}

fn start_steam(host: bool, name: String, pw: String) -> i64 {
    if name.is_empty() {
        return 0;
    }
    let mut s = shared().lock().unwrap();
    if matches!(s.status, 1 | 2) {
        return 1;
    }
    s.status = 1;
    s.stop = false;
    s.host = host;
    drop(s);
    std::thread::spawn(move || steam_thread(host, name, pw));
    1
}

pub(crate) fn status_code() -> i32 {
    shared().lock().unwrap().status
}

pub(crate) fn start_steam_session(host: bool, name: String, pw: String) -> i64 {
    start_steam(host, name, pw)
}

/// Loaded by the ASI loader at game start (as coopnet64.asi): watch F9 for the co-op window from the title screen on.
#[no_mangle]
pub extern "system" fn DllMain(_module: *mut std::ffi::c_void, reason: u32, _reserved: *mut std::ffi::c_void) -> i32 {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if reason == 1 && !STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        let module = _module as usize;
        // hooks only inside the game itself (tools such as tools/dll_test.py load this DLL too)
        let in_game = std::env::current_exe().ok().and_then(|p| p.file_name().map(|n| n.eq_ignore_ascii_case("SanAndreas.exe"))).unwrap_or(false);
        if !in_game {
            return 1;
        }
        std::thread::spawn(dialog::hotkey_thread);
        // every start begins with the player's own saves (a crash in co-op mode must not hide them)
        std::thread::spawn(|| {
            if saves::mode() == "coop" {
                let _ = saves::switch_to("solo");
            }
        });
        std::panic::set_hook(Box::new(|info| log_line(&format!("panic: {info}"))));
        std::thread::spawn(move || unsafe {
            // the "co-op" entry of the game's menus, then the menu drawn into the game (DX12, else DX11)
            overlay::hook_menu();
            overlay::hook_cursor();
            scripthook::install();
            let hinst = hudhook::windows::Win32::Foundation::HINSTANCE(module as isize);
            // one renderer only (both hook the same Present). DX12 hooks installed but never drew on 11-08, so DX11
            // is the default; %LOCALAPPDATA%\sa-de-coop renderer.txt
            // = "dx12" switches without a rebuild.
            let choice = std::env::var_os("LOCALAPPDATA")
                .and_then(|d| std::fs::read_to_string(std::path::PathBuf::from(d).join("sa-de-coop").join("renderer.txt")).ok())
                .unwrap_or_default();
            let dx12 = choice.trim().eq_ignore_ascii_case("dx12");
            log_line(&format!("overlay: starting, {}", if dx12 { "DX12" } else { "DX11" }));
            let b = hudhook::Hudhook::builder();
            let b = if dx12 {
                b.with::<hudhook::hooks::dx12::ImguiDx12Hooks>(overlay::CoopMenu::default())
            } else {
                b.with::<hudhook::hooks::dx11::ImguiDx11Hooks>(overlay::CoopMenu::default())
            };
            let r = b.with_hmodule(hinst).build().apply();
            log_line(&format!("overlay hooks: {:?}", r.as_ref().map(|_| ()).map_err(|e| format!("{e:?}"))));
        });
    }
    1
}

/// Create a Steam lobby with this name and password (null-terminated ASCII). 1 = started.
#[no_mangle]
pub unsafe extern "C" fn coop_steam_host(name: *const u8, pw: *const u8) -> i64 {
    start_steam(true, c_str(name), c_str(pw))
}

/// Find the Steam lobby by name and join it with the password. 1 = started; watch coop_status.
#[no_mangle]
pub unsafe extern "C" fn coop_steam_join(name: *const u8, pw: *const u8) -> i64 {
    start_steam(false, c_str(name), c_str(pw))
}

/// Our chosen look (0 = Grove Street member, 1.. = story character), set in the co-op menu.
#[no_mangle]
pub extern "C" fn coop_my_skin() -> i64 {
    overlay::SKIN.load(std::sync::atomic::Ordering::SeqCst) as i64
}

/// Stop the current session (Steam or UDP) and wait for its thread to let go.
pub(crate) fn leave_session() {
    let busy = matches!(shared().lock().unwrap().status, 1 | 2);
    if !busy {
        return;
    }
    shared().lock().unwrap().stop = true;
    std::thread::sleep(std::time::Duration::from_millis(400));
    let mut s = shared().lock().unwrap();
    s.status = 0;
    s.host = false;
    s.peers = Default::default();
    s.code = None; // a "host on my PC" code must not show in a later Steam session
}

pub(crate) fn is_host() -> bool {
    shared().lock().unwrap().host
}

/// The partner's copy in our world (script handle, -1 = none) and whether it stands with us (same interior,
/// a few metres): the host's mission start waits for it, and "either player" checks ask it too.
#[no_mangle]
pub extern "C" fn coop_set_partner(handle: i64, near: i64) -> i64 {
    scripthook::PARTNER_PED.store(handle as i32, std::sync::atomic::Ordering::Relaxed);
    scripthook::PARTNER_NEAR.store(near != 0, std::sync::atomic::Ordering::Relaxed);
    1
}

/// Settings from the co-op menu: 0 = friendly fire (1 on, the host's), 1 = revive time in seconds (the host's),
/// 2 = tougher enemies (this PC's mod setting).
#[no_mangle]
pub extern "C" fn coop_setting(id: i64) -> i64 {
    use std::sync::atomic::Ordering::SeqCst;
    match id {
        0 => overlay::FRIENDLY_FIRE.load(SeqCst) as i64,
        1 => overlay::REVIVE_SECS.load(SeqCst) as i64,
        2 => { let o = modsettings::get(); if !o.tough { 0 } else if o.hard { 2 } else { 1 } } // enemies: 0 normal, 1 tougher, 2 hard
        _ => -1,
    }
}

/// AI partner switch from the co-op menu: 1 = on.
#[no_mangle]
pub extern "C" fn coop_ai_enabled() -> i64 {
    ai::ENABLED.load(std::sync::atomic::Ordering::SeqCst) as i64
}

/// Ask Jev what the AI partner should do; `situation` is ASCII text, null-terminated. 1 = asked, 0 = busy.
#[no_mangle]
pub unsafe extern "C" fn coop_ai_ask(situation: *const u8) -> i64 {
    ai::ask(c_str(situation))
}

/// Jev's latest answer once: 0 follow, 1 enter_car, 2 attack, 3 take_cover, 4 wait; -1 = none yet.
#[no_mangle]
pub extern "C" fn coop_ai_result() -> i64 {
    ai::take()
}

/// 1 = we host the session (our story), 0 = we joined someone else's.
#[no_mangle]
pub extern "C" fn coop_is_host() -> i64 {
    shared().lock().unwrap().host as i64
}

#[no_mangle]
pub extern "C" fn coop_status() -> i64 {
    shared().lock().unwrap().status as i64
}

/// How many friends sent us their state in the last 5 s (the AI partner steps back while a real friend plays).
#[no_mangle]
pub extern "C" fn coop_friends() -> i64 {
    let s = shared().lock().unwrap();
    let me = s.slot;
    s.peers
        .iter()
        .enumerate()
        .filter(|(i, p)| *i as i32 != me && p.as_ref().is_some_and(|(_, t)| t.elapsed() < Duration::from_secs(5)))
        .count() as i64
}

#[no_mangle]
pub extern "C" fn coop_slot() -> i64 {
    shared().lock().unwrap().slot as i64
}

/// Our own state, copied from script memory (64 bytes, proto::State layout).
#[no_mangle]
pub unsafe extern "C" fn coop_send(state: *const u8) -> i64 {
    if state.is_null() {
        return 0;
    }
    let bytes = std::slice::from_raw_parts(state, STATE_SIZE);
    let Some(st) = State::from_bytes(bytes) else { return 0 };
    shared().lock().unwrap().mine = Some(st);
    1
}

/// Fills `out` with peer `slot`'s latest state. 1 = fresh, 0 = nobody there (or silent for 3 s).
#[no_mangle]
pub unsafe extern "C" fn coop_get(slot: i64, out: *mut u8) -> i64 {
    if out.is_null() || !(0..MAX_PLAYERS as i64).contains(&slot) {
        return 0;
    }
    let s = shared().lock().unwrap();
    match s.peers[slot as usize] {
        Some((st, at)) if at.elapsed() < STALE => {
            std::ptr::copy_nonoverlapping(st.to_bytes().as_ptr(), out, STATE_SIZE);
            1
        }
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn coop_stop() -> i64 {
    shared().lock().unwrap().stop = true;
    1
}
