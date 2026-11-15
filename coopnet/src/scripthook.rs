//! The host's story with a partner (the SA:COOP model, ported to the Definitive Edition, build 1.0.113.49697469):
//! - every script command goes through the opcode handler table (0x4307D00, 27 group handlers); we wrap them so
//!   that, for chosen checks, a false answer is asked again with $PLAYER_ACTOR set to the partner's copy
//!   ("either player": in a car, on a train, shooting, damaged by...);
//! - CPlayerPed::CanPlayerStartMission (0x124E750): the guest never starts a mission of its own, the host only
//!   when the partner stands with it in the marker.
//! The script tells us the partner's ped handle and whether it is near (coop_set_partner).

use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

const OPCODE_TABLE: usize = 0x4307D00;
const CAN_START_MISSION: usize = 0x124E750;
const SCRIPT_SPACE: usize = 0x51BEAE0;
const PLAYER_ACTOR: usize = SCRIPT_SPACE + 12; // $PLAYER_ACTOR, the player's ped handle

// CRunningScript (x64)
const S_IP: usize = 0x20;
const S_COND: usize = 0x115;
const S_LOGIC: usize = 0x120;
const S_NOT: usize = 0x122;
const S_MISSION: usize = 0x12C;

/// Checks a partner can answer for the host ("either player"). From SA:COOP's generic rules plus vehicle checks.
// No "is in a car" checks (0x00DB, 0x00DD, 0x00DF, 0x0448, 0x0449, 0x047A, 0x04A7, 0x04A9, 0x04AB, 0x04C8): when the
// partner answered "yes, in a car" the mission went on to use the HOST's car, the host had none, and the game read
// through a null car (crash of 11-15 17:28 at 0x10B9516, [car + 0x780]). The partner driving the mission car is
// handled by putting the partner's copy at its wheel instead (EV_DRIVE).
const EITHER: &[u32] = &[
    0x02D6, // IS_CHAR_SHOOTING_IN_AREA
    0x02E0, // IS_CHAR_SHOOTING
    0x051A, // HAS_CHAR_BEEN_DAMAGED_BY_CHAR
    0x051C, // HAS_CAR_BEEN_DAMAGED_BY_CHAR
    0x0457, // IS_PLAYER_TARGETTING_CHAR
    0x068C, // IS_PLAYER_TARGETTING_ANYTHING
    // 11-15, "only one of us can take part in the mission": where the player has to BE. A mission's "go to the
    // marker", "get to the car", "stand in this area" is now done when either of the two is there, as in Saints Row 2.
    0x00A3, 0x00A4, // IS_CHAR_IN_AREA_2D / 3D
    0x00EC, 0x00ED, 0x00EE, 0x00EF, 0x00F0, 0x00F1, // LOCATE_(STOPPED_)CHAR_*_2D
    0x00F2, 0x00F3, 0x00F4, // LOCATE_CHAR_*_CHAR_2D (next to somebody)
    0x00FE, 0x00FF, 0x0100, 0x0101, 0x0102, 0x0103, // LOCATE_(STOPPED_)CHAR_*_3D
    0x0104, 0x0105, 0x0106, // LOCATE_CHAR_*_CHAR_3D
    0x0154, // IS_CHAR_IN_ZONE
    0x01A1, 0x01A2, 0x01A3, 0x01A4, 0x01A5, 0x01A6, 0x01A7, 0x01A8, 0x01A9, 0x01AA, // IS_CHAR_(STOPPED_)IN_AREA_*
    0x0202, 0x0203, 0x0204, 0x0205, 0x0206, 0x0207, // LOCATE_CHAR_*_CAR_2D / 3D (next to a car)
    0x0471, 0x0472, 0x0473, 0x0474, 0x0475, 0x0476, // LOCATE_CHAR_*_OBJECT_2D / 3D
    0x05F6, 0x05F7, 0x05F8, 0x05F9, 0x05FA, 0x05FB, 0x05FC, 0x05FD, 0x05FE, 0x05FF, 0x0600, 0x0601, // angled areas
    0x0179, 0x023B, 0x0547, 0x0737, // touching an object or vehicle, holding an object
];

pub static PARTNER_PED: AtomicI32 = AtomicI32::new(-1); // script handle of the partner's copy in our world
pub static PARTNER_NEAR: AtomicBool = AtomicBool::new(false);
/// The guest's own missions are refused (set by the script: only while the guest is in the host's story).
pub static GUEST_LOCK: AtomicBool = AtomicBool::new(false);
/// Why a mission start was just refused, for the script to tell the player: 1 = we are the guest, 2 = the host's
/// partner is not next to it. Without a word the marker simply did nothing (11-15: "it will not let me in the house").
pub static REFUSED: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static INSTALLED: AtomicBool = AtomicBool::new(false);

// ---- a cutscene is skipped only when both players want it (11-15) -------------------------------------------------
// 0xFF9EC0 is the game's "is the skip button being pressed" (no parameters, bool). CCutsceneMgr::Update calls it
// every frame and skips (0xFF96C0) on true; two script commands call it too (a mission's own skippable scenes).
// Found in the exe: WAS_CUTSCENE_SKIPPED reads 0x572A439, which only 0xFF96C0 sets, and its button caller is 0xFF951A.
// With a friend connected a press is only noted (SKIP_PRESSED, read by the script) and false is returned, until the
// script says both have pressed (SKIP_OK): then true is returned once and the game skips as it always does.
const SKIP_BUTTON: usize = 0xFF9EC0;
type SkipButton = unsafe extern "C" fn() -> u8;
static mut ORIG_SKIP: Option<SkipButton> = None;
pub static SKIP_PRESSED: AtomicBool = AtomicBool::new(false);
pub static SKIP_OK: AtomicBool = AtomicBool::new(false);
static SKIP_WAS_DOWN: AtomicBool = AtomicBool::new(false);
unsafe extern "C" fn skip_button() -> u8 {
    let r = match ORIG_SKIP { Some(f) => f(), None => 0 };
    if !connected() || crate::coop_friends() == 0 {
        SKIP_OK.store(false, Ordering::Relaxed);
        return r;
    }
    if SKIP_OK.swap(false, Ordering::Relaxed) {
        return 1;
    }
    // a press is a new press: held down it is noted once
    let was = SKIP_WAS_DOWN.swap(r != 0, Ordering::Relaxed);
    if r != 0 && !was {
        SKIP_PRESSED.store(true, Ordering::Relaxed);
    }
    0
}

/// The hooks are in: this is the build of the game our addresses are for.
pub fn installed() -> bool {
    INSTALLED.load(Ordering::Relaxed)
}

// ---- a few commands run on the game's own thread (11-15) ---------------------------------------------------------
// CLEO runs its scripts on a thread of its own. A command that makes the game build something new there (a
// cutscene's actors) crashes the Definitive Edition: "AssembleReferenceTokenStream ... called on a non-game thread".
// The game's own scripts go through the same handler table on the game thread, so a script may leave a command
// here and the next command the game itself runs carries it out. Only commands without parameters, from a short
// list. The game thread is learned in the menu hook (the first menu event of the run).
pub static GAME_THREAD: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static NATIVE_QUEUE: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());
pub static NATIVE_DONE: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
const NATIVE_ALLOWED: [u32; 2] = [0x02E7, 0x02EA]; // START_CUTSCENE, CLEAR_CUTSCENE

// ---- the script's turn counts as the game thread (11-15) ---------------------------------------------------------
// CLEO gives every script a thread of its own and runs one at a time while the game thread waits inside CLEO (seen
// in a crash dump: the game thread blocked in cleo_redux64, the script's thread on top of the game's code). Unreal
// compares the calling thread with GGameThreadId (RVA 0x5764170, checked in the running game: it holds the main
// thread's id) and stops the game when something is built "on a non-game thread": a model, an interior, a cutscene's
// actors, a vehicle's lights. While our script has its turn it writes its own thread id there and puts the real one
// back before it waits. If a script ever stops without putting it back, the game thread does it itself (heal, called
// from the menu hook, which runs on the game thread all the time).
const GAME_THREAD_ID: usize = 0x5764170;
const GAME_THREAD_ID_SET: usize = 0x5764159;
static REAL_GAME_THREAD: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static CLAIMED: AtomicBool = AtomicBool::new(false);

unsafe fn game_thread_slot() -> Option<*mut u32> {
    let base = windows_sys::Win32::System::LibraryLoader::GetModuleHandleA(std::ptr::null()) as usize;
    if base == 0 || crate::game_build_ok() == false || *((base + GAME_THREAD_ID_SET) as *const u8) != 1 {
        return None;
    }
    Some((base + GAME_THREAD_ID) as *mut u32)
}

/// The calling script thread becomes "the game thread" until release(). False = left alone (the game thread is not
/// known yet, or the value there is not the thread the menu events come from: another build of the game).
pub unsafe fn claim() -> bool {
    let Some(p) = game_thread_slot() else { return false };
    let me = windows_sys::Win32::System::Threading::GetCurrentThreadId();
    let cur = std::ptr::read_volatile(p);
    if cur == me {
        return true;
    }
    let known = GAME_THREAD.load(Ordering::Relaxed);
    if known == 0 || cur != known {
        return false;
    }
    REAL_GAME_THREAD.store(known, Ordering::SeqCst);
    std::ptr::write_volatile(p, me);
    CLAIMED.store(true, Ordering::SeqCst);
    true
}

pub unsafe fn release() {
    if !CLAIMED.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Some(p) = game_thread_slot() {
        let real = REAL_GAME_THREAD.load(Ordering::SeqCst);
        if real != 0 {
            std::ptr::write_volatile(p, real);
        }
    }
}

/// On the game thread: a claim still standing means its script is not running any more (it waits or it is gone).
pub unsafe fn heal() {
    if CLAIMED.load(Ordering::Relaxed) && windows_sys::Win32::System::Threading::GetCurrentThreadId() == REAL_GAME_THREAD.load(Ordering::Relaxed) {
        release();
        crate::log_line("game thread: a script left its claim standing, put back");
    }
}

pub fn queue_native(op: u32) -> bool {
    if !NATIVE_ALLOWED.contains(&op) || GAME_THREAD.load(Ordering::Relaxed) == 0 {
        return false;
    }
    NATIVE_QUEUE.lock().unwrap().push(op);
    true
}

unsafe fn run_native(s: *mut u8) {
    let game = GAME_THREAD.load(Ordering::Relaxed);
    if game == 0 || windows_sys::Win32::System::Threading::GetCurrentThreadId() != game {
        return;
    }
    let op = {
        let mut q = NATIVE_QUEUE.lock().unwrap();
        if q.is_empty() {
            return;
        }
        q.remove(0)
    };
    let h: Handler = std::mem::transmute(ORIG[(op / 100) as usize % 27]);
    // these commands take no parameters: the running script's place in its code is not touched; its last answer
    // (the compare flag) is put back in case the handler changed it
    let cond = *s.add(S_COND);
    h(s, op);
    *s.add(S_COND) = cond;
    NATIVE_DONE.fetch_add(1, Ordering::Relaxed);
    crate::log_line(&format!("native: command {op:#06x} run on the game thread"));
}

// ---- a mission's scenes, replayed in the guest's game (the CoopAndreas way, 11-15) ---------------------------------
// The host's mission runs its camera, fade and widescreen commands; each one is sent with its parameters, and the
// guest's game runs the same command with the same numbers on its own game thread, through a stand-in script whose
// instruction pointer points at those parameters (as CoopAndreas runs received opcodes through a fake CRunningScript).
// Only commands whose parameters are plain numbers written in the script: a parameter held in a variable has
// another value (or no meaning) in the guest's game, so such a command is not sent at all.
pub const EV_REPLAY: u8 = 34;
const REPLAY: &[u32] = &[
    0x015F, // SET_FIXED_CAMERA_POSITION x y z ox oy oz
    0x0160, // POINT_CAMERA_AT_POINT x y z mode
    0x015A, // RESTORE_CAMERA
    0x02EB, // RESTORE_CAMERA_JUMPCUT
    0x0373, // SET_CAMERA_BEHIND_PLAYER
    0x016A, // DO_FADE time direction
    0x02A3, // SWITCH_WIDESCREEN on
    0x0003, // SHAKE_CAM strength
    0x0920, // CAMERA_SET_VECTOR_TRACK
    0x0936, // CAMERA_SET_VECTOR_MOVE
    0x092F, // CAMERA_PERSIST_TRACK
    0x0930, // CAMERA_PERSIST_POS
    0x0925, // CAMERA_RESET_NEW_SCRIPTABLES
];
static REPLAY_QUEUE: std::sync::Mutex<Vec<Vec<u8>>> = std::sync::Mutex::new(Vec::new());
pub static REPLAYED: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// The parameters from `ip` to `end`, if every one is a number written in the script (types 1 int32, 4 int8, 5 int16,
/// 6 float). None for anything else (variables, strings, arrays).
unsafe fn plain_params(ip: usize, end: usize) -> Option<Vec<u8>> {
    if end < ip || end - ip > 80 {
        return None;
    }
    let b = std::slice::from_raw_parts(ip as *const u8, end - ip);
    let mut i = 0;
    while i < b.len() {
        i += match b[i] { 1 | 6 => 5, 4 => 2, 5 => 3, _ => return None };
    }
    (i == b.len()).then(|| b.to_vec())
}

/// Received from the host: [opcode lo, opcode hi, parameters...].
pub fn queue_replay(ev: &[u8]) {
    if ev.len() < 2 || ev.len() > 84 {
        return;
    }
    let op = u16::from_le_bytes([ev[0], ev[1]]) as u32;
    if !REPLAY.contains(&op) {
        return; // only what this build knows how to run
    }
    let mut q = REPLAY_QUEUE.lock().unwrap();
    if q.len() < 64 {
        q.push(ev.to_vec());
    }
}

static mut STAND_IN: [u8; 0x400] = [0; 0x400];
static mut PARAMS: [u8; 96] = [0; 96];
unsafe fn run_replay() {
    let game = GAME_THREAD.load(Ordering::Relaxed);
    if game == 0 || windows_sys::Win32::System::Threading::GetCurrentThreadId() != game || crate::is_host() {
        return;
    }
    let ev = {
        let mut q = REPLAY_QUEUE.lock().unwrap();
        if q.is_empty() {
            return;
        }
        q.remove(0)
    };
    let op = u16::from_le_bytes([ev[0], ev[1]]) as u32;
    let params = &ev[2..];
    let si = std::ptr::addr_of_mut!(STAND_IN) as *mut u8;
    let pp = std::ptr::addr_of_mut!(PARAMS) as *mut u8;
    std::ptr::write_bytes(si, 0, 0x400);
    std::ptr::write_bytes(pp, 0, 96);
    std::ptr::copy_nonoverlapping(params.as_ptr(), pp, params.len());
    *(si.add(S_IP) as *mut usize) = pp as usize;
    *si.add(S_MISSION) = 1;
    let h: Handler = std::mem::transmute(ORIG[(op / 100) as usize % 27]);
    h(si, op);
    // it read exactly what was sent, or something is wrong with this command here: say so once
    let read = *(si.add(S_IP) as *const usize) - pp as usize;
    if read != params.len() {
        static SAID: AtomicBool = AtomicBool::new(false);
        if !SAID.swap(true, Ordering::Relaxed) {
            crate::log_line(&format!("replay: command {op:#06x} read {read} of {} bytes", params.len()));
        }
    }
    REPLAYED.fetch_add(1, Ordering::Relaxed);
}

// ---- down, not dead (11-15) -------------------------------------------------------------------------------------
// 0x119B510 is CPedDamageResponseCalculator::ComputeWillKillPed(this, ped, response, speak): `this` holds the damage
// (+8, f32) and the weapon (+0x10); it takes the damage from the ped's health (+0x76C) and kills the ped when less
// than 1.0 would be left. Our player is CWorld::Players[0].m_pPed (*0x53EB720, as the function itself compares).
// While the script allows it (a friend is connected and not down), a hit that would kill our player leaves it 2
// health instead: the script then puts it down, to be revived. With both down the game kills as always.
const WILL_KILL: usize = 0x119B510;
const PLAYER0_PED: usize = 0x53EB720;
const PED_HEALTH: usize = 0x76C;
type WillKill = unsafe extern "C" fn(*mut u8, *mut u8, *mut u8, u8);
static mut ORIG_WILL_KILL: Option<WillKill> = None;
pub static DOWN_NOT_DEAD: AtomicBool = AtomicBool::new(false);
unsafe extern "C" fn will_kill(calc: *mut u8, ped: *mut u8, resp: *mut u8, speak: u8) {
    if DOWN_NOT_DEAD.load(Ordering::Relaxed) && connected() && !ped.is_null() && !calc.is_null() {
        let me = *((BASE + PLAYER0_PED) as *const *mut u8);
        if ped == me {
            let health = *(ped.add(PED_HEALTH) as *const f32);
            let dmg = calc.add(8) as *mut f32;
            if health.is_finite() && (*dmg).is_finite() && health - *dmg < 2.0 && health > 2.0 {
                *dmg = health - 2.0;
            }
        }
    }
    if let Some(f) = ORIG_WILL_KILL {
        f(calc, ped, resp, speak);
    }
}

// ---- enemies fight both players (11-15) ----------------------------------------------------------------------------
// Read out of all 151 missions of the Definitive Edition's main script: enemies are told to attack the player's
// character ($PLAYER_ACTOR) about 700 times (TASK_KILL_CHAR_ON_FOOT alone 597), never anyone else, so in co-op they
// all went for the host and left the friend alone. Every second such order, while the friend is near, is given again
// with $PLAYER_ACTOR set to the friend's copy: that enemy fights the friend (its copy in the friend's game fires at
// the friend). An order given TO the player ($PLAYER_ACTOR as the first parameter, a scene) is left alone.
const ATTACKS: &[u32] = &[0x05E2, 0x0634, 0x0635, 0x0637, 0x074D, 0x07A5];
// The missions move the player's character about 900 times (SET_CHAR_COORDINATES and kin on $PLAYER_ACTOR: after a
// cutscene, at the start of a part); the friend was left behind. Each such move is told to the friends (the place is
// in CTheScripts::ScriptParams, 0x5212F90, after the command has read its parameters), and they come along.
const MOVES: &[u32] = &[0x00A1, 0x08C7, 0x0972, 0x09BC];
const SCRIPT_PARAMS: usize = 0x5212F90;
pub const EV_MOVED: u8 = 40;
static ATTACK_TURN: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

type Handler = unsafe extern "C" fn(*mut u8, u32) -> u8;
type CanStart = unsafe extern "C" fn(*mut u8) -> u8;
static mut ORIG: [usize; 27] = [0; 27];
static mut ORIG_CAN_START: Option<CanStart> = None;
static mut BASE: usize = 0;

// ---- which script is asking (11-15) --------------------------------------------------------------------------------
// The places that start a story mission all look the same in the game's script: a check that the player stands in
// the marker, CAN_PLAYER_START_MISSION, and soon after LOAD_AND_LAUNCH_MISSION_INTERNAL with a story mission's
// number. Shops, gyms, odd jobs and the rest ask CAN_PLAYER_START_MISSION too, but start no story mission.
// - The guest was refused everywhere, so it could not buy food, guns, clothes, a haircut or a tattoo. Now it is
//   refused only where a story mission would start.
// - The host's story markers now also count the partner standing in them, so either player can start a mission.
const OP_CAN_START: u32 = 0x03EE;
// The main script (265 302 bytes in the game's main.scm) and the running mission's block (68 915). Checked against
// that file: every one of the 103 story missions is started within 629 bytes after a CAN_PLAYER_START_MISSION, and
// 15 other places (shops, odd jobs) ask the same without starting one.
const SCRIPT_SPACE_LEN: usize = 330_000;
const SCAN: usize = 1200;
/// -1 = not inside CAN_PLAYER_START_MISSION, 0 = asked by a script that starts no story mission, 1 = by one that does
static STORY_CHECK: AtomicI32 = AtomicI32::new(-1);
static mut STORY_CACHE: [(usize, bool); 64] = [(0, false); 64];

/// Does the script code after `ip` start a story mission (numbers 11..=113) within the next few thousand bytes?
/// None = `ip` is not in the game's own script space (a streamed shop script, a CLEO script): not looked at.
unsafe fn launches_story(ip: usize) -> Option<bool> {
    let start = BASE + SCRIPT_SPACE;
    if BASE == 0 || ip < start || ip + SCAN + 8 > start + SCRIPT_SPACE_LEN {
        return None;
    }
    let slot = (ip >> 1) % 64;
    if STORY_CACHE[slot].0 == ip {
        return Some(STORY_CACHE[slot].1);
    }
    let code = std::slice::from_raw_parts(ip as *const u8, SCAN + 8);
    let mut found = false;
    for i in 0..SCAN {
        if code[i] == 0x17 && code[i + 1] == 0x04 {
            let id = match code[i + 2] {
                0x04 => code[i + 3] as i8 as i32,
                0x05 => i16::from_le_bytes([code[i + 3], code[i + 4]]) as i32,
                0x01 => i32::from_le_bytes([code[i + 3], code[i + 4], code[i + 5], code[i + 6]]),
                _ => -1,
            };
            if (11..=113).contains(&id) {
                found = true;
                break;
            }
        }
    }
    STORY_CACHE[slot] = (ip, found);
    Some(found)
}

/// Is `handle` a character that exists right now? The game's own commands look a handle up in the ped pool and many
/// do not check the answer: asked about the partner's copy just after it died, IS_CHAR_IN_AREA read from address
/// 0x634 and the game was gone (crash of 11-15 17:22, the handler at 0x10B7DDB). The same lookup, done first.
const PED_POOL: usize = 0x572B5A0;
unsafe fn ped_exists(handle: i32) -> bool {
    if handle < 0 || BASE == 0 {
        return false;
    }
    let pool = *((BASE + PED_POOL) as *const *const u8);
    if pool.is_null() {
        return false;
    }
    let objects = *(pool as *const *const u8);
    let flags = *(pool.add(8) as *const *const u8);
    let size = *(pool.add(0x10) as *const i32);
    let idx = handle >> 8;
    !objects.is_null() && !flags.is_null() && idx < size && *flags.add(idx as usize) == (handle & 0xFF) as u8
}

fn connected() -> bool {
    crate::status_code() == 2
}

unsafe extern "C" fn wrap(s: *mut u8, op: u32) -> u8 {
    let f: Handler = std::mem::transmute(ORIG[(op / 100) as usize % 27]);
    let ip = *(s.add(S_IP) as *const usize);
    let cond = *s.add(S_COND);
    let logic = *(s.add(S_LOGIC) as *const u16);
    let not = *s.add(S_NOT);
    let asking = op == OP_CAN_START;
    if asking {
        // a mission's own script and scripts outside the game's script space start no story mission
        let story = *s.add(S_MISSION) == 0 && launches_story(ip) == Some(true);
        STORY_CHECK.store(story as i32, Ordering::Relaxed);
    }
    let r = f(s, op);
    if asking {
        STORY_CHECK.store(-1, Ordering::Relaxed);
    }
    run_native(s);
    run_replay();
    // the host's mission ran a scene command: the guests run it too
    if REPLAY.contains(&op) && *s.add(S_MISSION) != 0 && connected() && crate::is_host() && crate::coop_friends() > 0 {
        if let Some(p) = plain_params(ip, *(s.add(S_IP) as *const usize)) {
            let mut ev = vec![EV_REPLAY, op as u8, (op >> 8) as u8];
            ev.extend(p);
            crate::send_raw_event(ev);
        }
    }
    let partner = PARTNER_PED.load(Ordering::Relaxed);
    if MOVES.contains(&op) && *s.add(S_MISSION) != 0 && connected() && crate::is_host() && crate::coop_friends() > 0 {
        let first = std::slice::from_raw_parts(ip as *const u8, 3);
        if first == [2, 12, 0] {
            let p = (BASE + SCRIPT_PARAMS) as *const f32;
            let (x, y, z) = (*p.add(1), *p.add(2), *p.add(3));
            if x.is_finite() && y.is_finite() && z.is_finite() && x.abs() < 6000.0 && y.abs() < 6000.0 {
                let mut ev = vec![EV_MOVED];
                ev.extend(format!("{x:.2},{y:.2},{z:.2}").bytes());
                crate::send_raw_event(ev);
            }
        }
    }
    if ATTACKS.contains(&op)
        && *s.add(S_MISSION) != 0
        && partner > 0
        && PARTNER_NEAR.load(Ordering::Relaxed)
        && connected()
        && crate::is_host()
        && ped_exists(partner)
    {
        // the first parameter is not the player itself (global variable type 2 at offset 12 = $PLAYER_ACTOR)
        let first = std::slice::from_raw_parts(ip as *const u8, 3);
        let to_player = first == [2, 12, 0];
        if !to_player && ATTACK_TURN.fetch_add(1, Ordering::Relaxed) % 2 == 1 {
            let actor = (BASE + PLAYER_ACTOR) as *mut i32;
            let end_ip = *(s.add(S_IP) as *const usize);
            let saved = *actor;
            *(s.add(S_IP) as *mut usize) = ip;
            *actor = partner;
            f(s, op);
            *actor = saved;
            *(s.add(S_IP) as *mut usize) = end_ip;
        }
        return r;
    }
    // ask again for the partner: host only, mission scripts only, plain (not NOT-ed) checks that said no
    if partner > 0
        && ped_exists(partner)
        && not == 0
        && *s.add(S_COND) == 0
        // a mission's own checks, or the checks of a place that starts a story mission (its marker)
        && (*s.add(S_MISSION) != 0 || (EITHER.contains(&op) && launches_story(ip) == Some(true)))
        && EITHER.contains(&op)
        && connected()
        && crate::is_host()
    {
        let actor = (BASE + PLAYER_ACTOR) as *mut i32;
        let end_ip = *(s.add(S_IP) as *const usize);
        let saved_actor = *actor;
        *(s.add(S_IP) as *mut usize) = ip;
        *s.add(S_COND) = cond;
        *(s.add(S_LOGIC) as *mut u16) = logic;
        *actor = partner;
        let r2 = f(s, op);
        *actor = saved_actor;
        // same command, same parameters: it must end where the first run ended
        if *(s.add(S_IP) as *const usize) != end_ip {
            *(s.add(S_IP) as *mut usize) = end_ip;
        }
        return r2;
    }
    r
}

unsafe extern "C" fn can_start(ped: *mut u8) -> u8 {
    if connected() {
        // one story for both: the guest plays the host's missions, never its own (the host's save is sent to the
        // guest when it joins, so the guest is not left without progress). Only while a host is really there.
        // ...and only when the guest is in the host's story (the script compares the two games' progress): a guest
        // that could not load the host's save was left unable to do anything at all (11-15)
        // ...and only where a story mission would start: shops, gyms, odd jobs ask the same question (STORY_CHECK)
        // not "while the host is seen": right after a load or a reconnect the guest's game did not see the host yet
        // for a moment, and a guest standing in a marker then started the mission in its own game (11-15 18:27)
        if !crate::is_host()
            && GUEST_LOCK.load(Ordering::Relaxed)
            && STORY_CHECK.load(Ordering::Relaxed) != 0
        {
            REFUSED.store(1, Ordering::Relaxed);
            return 0;
        }
        // 11-15, asked for after all: a story mission starts only with both players at its marker (the partner within
        // 25 m, told by the script). The script says so to both, so it no longer reads as "it will not let me in".
        if crate::is_host()
            && crate::coop_friends() > 0
            && STORY_CHECK.load(Ordering::Relaxed) == 1
            && !PARTNER_NEAR.load(Ordering::Relaxed)
        {
            REFUSED.store(2, Ordering::Relaxed);
            return 0;
        }
        // Before that: the host started its missions whenever it liked. It used to wait in the marker until the partner stood
        // next to it; in the first real sessions that only read as "it will not let me in" (11-15, eight refusals
        // in a row in the log). A partner who is far away is offered the jump (J) by the script instead.
    }
    match ORIG_CAN_START {
        Some(f) => f(ped),
        None => 1,
    }
}

/// Install both hooks once (game process only; checks the bytes of the build we know).
pub unsafe fn install() {
    use hudhook::mh::{MH_CreateHook, MH_EnableHook, MH_Initialize, MH_STATUS};
    use windows_sys::Win32::System::Memory::{VirtualProtect, PAGE_READWRITE};
    if INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    BASE = windows_sys::Win32::System::LibraryLoader::GetModuleHandleW(std::ptr::null()) as usize;
    let cs = (BASE + CAN_START_MISSION) as *const u8;
    if std::slice::from_raw_parts(cs, 6) != [0x40, 0x53, 0x48, 0x83, 0xEC, 0x20] {
        crate::log_line("story hooks: unknown game build, off");
        return;
    }
    let table = (BASE + OPCODE_TABLE) as *mut usize;
    let mut old = 0u32;
    if VirtualProtect(table as *const _, 27 * 8, PAGE_READWRITE, &mut old) == 0 {
        crate::log_line("story hooks: cannot unprotect the opcode table");
        return;
    }
    for i in 0..27 {
        ORIG[i] = *table.add(i);
        *table.add(i) = wrap as *const () as usize;
    }
    VirtualProtect(table as *const _, 27 * 8, old, &mut old);
    let _ = MH_Initialize();
    let mut orig: *mut std::ffi::c_void = std::ptr::null_mut();
    let st = MH_CreateHook(cs as *mut _, can_start as *mut _, &mut orig);
    if matches!(st, MH_STATUS::MH_OK) {
        ORIG_CAN_START = Some(std::mem::transmute::<*mut std::ffi::c_void, CanStart>(orig));
        let e = MH_EnableHook(cs as *mut _);
        crate::log_line(&format!("story hooks: opcode table wrapped, mission start {e:?}"));
    } else {
        crate::log_line(&format!("story hooks: mission start hook failed {st:?}"));
    }
    let wk = (BASE + WILL_KILL) as *const u8;
    if std::slice::from_raw_parts(wk, 6) == [0x48, 0x89, 0x5C, 0x24, 0x08, 0x48] {
        let mut o: *mut std::ffi::c_void = std::ptr::null_mut();
        if matches!(MH_CreateHook(wk as *mut _, will_kill as *mut _, &mut o), MH_STATUS::MH_OK) {
            ORIG_WILL_KILL = Some(std::mem::transmute::<*mut std::ffi::c_void, WillKill>(o));
            let e = MH_EnableHook(wk as *mut _);
            crate::log_line(&format!("story hooks: down instead of dead {e:?}"));
        }
    } else {
        crate::log_line("story hooks: down instead of dead: unknown bytes, off");
    }
    let sb = (BASE + SKIP_BUTTON) as *const u8;
    if std::slice::from_raw_parts(sb, 6) == [0x40, 0x53, 0x48, 0x83, 0xEC, 0x20] {
        let mut o: *mut std::ffi::c_void = std::ptr::null_mut();
        if matches!(MH_CreateHook(sb as *mut _, skip_button as *mut _, &mut o), MH_STATUS::MH_OK) {
            ORIG_SKIP = Some(std::mem::transmute::<*mut std::ffi::c_void, SkipButton>(o));
            let e = MH_EnableHook(sb as *mut _);
            crate::log_line(&format!("story hooks: cutscene skip held for both players {e:?}"));
        }
    } else {
        crate::log_line("story hooks: cutscene skip: unknown bytes, off");
    }
}
