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
const EITHER: &[u32] = &[
    0x00DB, // IS_CHAR_IN_CAR
    0x00DD, // IS_CHAR_IN_MODEL
    0x00DF, // IS_CHAR_IN_ANY_CAR
    0x0449, // IS_CHAR_IN_ANY_TRAIN? (classic: IS_CHAR_IN_ANY_POLICE_VEHICLE family varies; harmless if false)
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
    0x0448, // IS_CHAR_SITTING_IN_CAR
    0x047A, 0x04A7, 0x04A9, 0x04AB, 0x04C8, // on a bike, in a boat, helicopter, plane, flying vehicle
    0x0179, 0x023B, 0x0547, 0x0737, // touching an object or vehicle, holding an object
];

pub static PARTNER_PED: AtomicI32 = AtomicI32::new(-1); // script handle of the partner's copy in our world
pub static PARTNER_NEAR: AtomicBool = AtomicBool::new(false);
/// Why a mission start was just refused, for the script to tell the player: 1 = we are the guest, 2 = the host's
/// partner is not next to it. Without a word the marker simply did nothing (11-15: "it will not let me in the house").
pub static REFUSED: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);
static INSTALLED: AtomicBool = AtomicBool::new(false);

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

type Handler = unsafe extern "C" fn(*mut u8, u32) -> u8;
type CanStart = unsafe extern "C" fn(*mut u8) -> u8;
static mut ORIG: [usize; 27] = [0; 27];
static mut ORIG_CAN_START: Option<CanStart> = None;
static mut BASE: usize = 0;

fn connected() -> bool {
    crate::status_code() == 2
}

unsafe extern "C" fn wrap(s: *mut u8, op: u32) -> u8 {
    let f: Handler = std::mem::transmute(ORIG[(op / 100) as usize % 27]);
    let ip = *(s.add(S_IP) as *const usize);
    let cond = *s.add(S_COND);
    let logic = *(s.add(S_LOGIC) as *const u16);
    let not = *s.add(S_NOT);
    let r = f(s, op);
    run_native(s);
    // ask again for the partner: host only, mission scripts only, plain (not NOT-ed) checks that said no
    let partner = PARTNER_PED.load(Ordering::Relaxed);
    if partner > 0
        && not == 0
        && *s.add(S_MISSION) != 0
        && *s.add(S_COND) == 0
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
        if !crate::is_host() && crate::coop_friends() > 0 {
            REFUSED.store(1, Ordering::Relaxed);
            return 0;
        }
        // The host starts its missions whenever it likes. It used to wait in the marker until the partner stood
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
}
