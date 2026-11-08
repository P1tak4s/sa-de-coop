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
];

pub static PARTNER_PED: AtomicI32 = AtomicI32::new(-1); // script handle of the partner's copy in our world
pub static PARTNER_NEAR: AtomicBool = AtomicBool::new(false);
static INSTALLED: AtomicBool = AtomicBool::new(false);

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
        if !crate::is_host() {
            return 0; // the guest plays the host's story, never its own
        }
        if PARTNER_PED.load(Ordering::Relaxed) > 0 && !PARTNER_NEAR.load(Ordering::Relaxed) {
            return 0; // the host waits in the marker until the partner is there too
        }
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
