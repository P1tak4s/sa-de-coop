//! Steam lobbies and P2P through the game's own steam_api64.dll (already initialised by the game).
//! A lobby carries `sacoop=1`, `name` and a password hash; members talk P2P through Steam's relay, so nobody
//! forwards ports or sees an IP. Every call goes through the flat C API, looked up at run time.

use std::ffi::{c_char, c_void, CStr, CString};

#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleA(name: *const c_char) -> *mut c_void;
    fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
}

macro_rules! sym {
    ($m:expr, $name:literal, $ty:ty) => {{
        let p = GetProcAddress($m, concat!($name, "\0").as_ptr() as *const c_char);
        if p.is_null() {
            return Err(concat!("steam_api64.dll has no ", $name));
        }
        std::mem::transmute::<*mut c_void, $ty>(p)
    }};
}

type P = *mut c_void;

pub struct Steam {
    mm: P,
    net: P,
    utils: P,
    friends: P,
    me: u64,
    create_lobby: unsafe extern "C" fn(P, i32, i32) -> u64,
    request_list: unsafe extern "C" fn(P) -> u64,
    add_filter: unsafe extern "C" fn(P, *const c_char, *const c_char, i32),
    add_distance_filter: unsafe extern "C" fn(P, i32),
    lobby_by_index: unsafe extern "C" fn(P, i32) -> u64,
    set_data: unsafe extern "C" fn(P, u64, *const c_char, *const c_char) -> bool,
    get_data: unsafe extern "C" fn(P, u64, *const c_char) -> *const c_char,
    join: unsafe extern "C" fn(P, u64) -> u64,
    leave: unsafe extern "C" fn(P, u64),
    members: unsafe extern "C" fn(P, u64) -> i32,
    member: unsafe extern "C" fn(P, u64, i32) -> u64,
    call_done: unsafe extern "C" fn(P, u64, *mut bool) -> bool,
    call_result: unsafe extern "C" fn(P, u64, *mut c_void, i32, i32, *mut bool) -> bool,
    send: unsafe extern "C" fn(P, u64, *const c_void, u32, i32, i32) -> bool,
    available: unsafe extern "C" fn(P, *mut u32, i32) -> bool,
    read: unsafe extern "C" fn(P, *mut c_void, u32, *mut u32, *mut u64, i32) -> bool,
    accept: unsafe extern "C" fn(P, u64) -> bool,
    persona: unsafe extern "C" fn(P, u64) -> *const c_char,
}

unsafe impl Send for Steam {}

const LOBBY_CREATED: i32 = 513; // LobbyCreated_t { EResult, u64 lobby } (16 bytes)
const LOBBY_MATCH_LIST: i32 = 510; // LobbyMatchList_t { u32 count }
const LOBBY_ENTER: i32 = 504; // LobbyEnter_t { u64 lobby, u32 perms, bool locked, u32 response } (24 bytes)
pub const SEND_UNRELIABLE: i32 = 1;
pub const SEND_RELIABLE: i32 = 2;

fn cs(s: &str) -> CString {
    CString::new(s.replace('\0', "")).unwrap_or_default()
}

impl Steam {
    pub fn load() -> Result<Steam, &'static str> {
        unsafe {
            let m = GetModuleHandleA(c"steam_api64.dll".as_ptr());
            if m.is_null() {
                return Err("steam_api64.dll is not loaded");
            }
            let client: P = sym!(m, "SteamClient", unsafe extern "C" fn() -> P)();
            if client.is_null() {
                return Err("Steam is not running");
            }
            let user = sym!(m, "SteamAPI_GetHSteamUser", unsafe extern "C" fn() -> i32)();
            let pipe = sym!(m, "SteamAPI_GetHSteamPipe", unsafe extern "C" fn() -> i32)();
            let get3 = |name: &'static str, versions: &[&str]| -> Result<P, &'static str> {
                let f: unsafe extern "C" fn(P, i32, i32, *const c_char) -> P = match name {
                    "mm" => sym!(m, "SteamAPI_ISteamClient_GetISteamMatchmaking", _),
                    "net" => sym!(m, "SteamAPI_ISteamClient_GetISteamNetworking", _),
                    "user" => sym!(m, "SteamAPI_ISteamClient_GetISteamUser", _),
                    _ => sym!(m, "SteamAPI_ISteamClient_GetISteamFriends", _),
                };
                versions.iter().map(|v| f(client, user, pipe, cs(v).as_ptr())).find(|p| !p.is_null()).ok_or(name)
            };
            let mm = get3("mm", &["SteamMatchMaking009"])?;
            let net = get3("net", &["SteamNetworking006", "SteamNetworking005"])?;
            let usr = get3("user", &["SteamUser020", "SteamUser021", "SteamUser019"])?;
            let friends = get3("friends", &["SteamFriends017", "SteamFriends016", "SteamFriends015"])?;
            let get_utils: unsafe extern "C" fn(P, i32, *const c_char) -> P = sym!(m, "SteamAPI_ISteamClient_GetISteamUtils", _);
            let utils = ["SteamUtils009", "SteamUtils010"].iter().map(|v| get_utils(client, pipe, cs(v).as_ptr())).find(|p| !p.is_null()).ok_or("utils")?;
            let me = sym!(m, "SteamAPI_ISteamUser_GetSteamID", unsafe extern "C" fn(P) -> u64)(usr);
            let s = Steam {
                mm, net, utils, friends, me,
                create_lobby: sym!(m, "SteamAPI_ISteamMatchmaking_CreateLobby", _),
                request_list: sym!(m, "SteamAPI_ISteamMatchmaking_RequestLobbyList", _),
                add_filter: sym!(m, "SteamAPI_ISteamMatchmaking_AddRequestLobbyListStringFilter", _),
                add_distance_filter: sym!(m, "SteamAPI_ISteamMatchmaking_AddRequestLobbyListDistanceFilter", _),
                lobby_by_index: sym!(m, "SteamAPI_ISteamMatchmaking_GetLobbyByIndex", _),
                set_data: sym!(m, "SteamAPI_ISteamMatchmaking_SetLobbyData", _),
                get_data: sym!(m, "SteamAPI_ISteamMatchmaking_GetLobbyData", _),
                join: sym!(m, "SteamAPI_ISteamMatchmaking_JoinLobby", _),
                leave: sym!(m, "SteamAPI_ISteamMatchmaking_LeaveLobby", _),
                members: sym!(m, "SteamAPI_ISteamMatchmaking_GetNumLobbyMembers", _),
                member: sym!(m, "SteamAPI_ISteamMatchmaking_GetLobbyMemberByIndex", _),
                call_done: sym!(m, "SteamAPI_ISteamUtils_IsAPICallCompleted", _),
                call_result: sym!(m, "SteamAPI_ISteamUtils_GetAPICallResult", _),
                send: sym!(m, "SteamAPI_ISteamNetworking_SendP2PPacket", _),
                available: sym!(m, "SteamAPI_ISteamNetworking_IsP2PPacketAvailable", _),
                read: sym!(m, "SteamAPI_ISteamNetworking_ReadP2PPacket", _),
                accept: sym!(m, "SteamAPI_ISteamNetworking_AcceptP2PSessionWithUser", _),
                persona: sym!(m, "SteamAPI_ISteamFriends_GetFriendPersonaName", _),
            };
            if s.me == 0 {
                return Err("no Steam user");
            }
            Ok(s)
        }
    }

    pub fn me(&self) -> u64 {
        self.me
    }

    /// Wait for an async Steam call and copy its result struct. None: failed or timed out (15 s).
    fn wait_call<const N: usize>(&self, call: u64, id: i32) -> Option<[u8; N]> {
        if call == 0 {
            return None;
        }
        for _ in 0..300 {
            let mut failed = false;
            if unsafe { (self.call_done)(self.utils, call, &mut failed) } {
                let mut out = [0u8; N];
                let ok = unsafe { (self.call_result)(self.utils, call, out.as_mut_ptr() as *mut c_void, N as i32, id, &mut failed) };
                return (ok && !failed).then_some(out);
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        None
    }

    /// A public lobby for up to 4, found by its name. Returns the lobby id.
    pub fn host(&self, name: &str, pw_hash: &str) -> Option<u64> {
        let r: [u8; 16] = self.wait_call(unsafe { (self.create_lobby)(self.mm, 2, 4) }, LOBBY_CREATED)?;
        let result = i32::from_le_bytes(r[0..4].try_into().ok()?);
        let lobby = u64::from_le_bytes(r[8..16].try_into().ok()?);
        if result != 1 || lobby == 0 {
            return None;
        }
        for (k, v) in [("sacoop", "1"), ("name", &name.to_lowercase()), ("pw", pw_hash)] {
            unsafe { (self.set_data)(self.mm, lobby, cs(k).as_ptr(), cs(v).as_ptr()) };
        }
        Some(lobby)
    }

    /// Find the lobby by name, check the password and enter it. Err: what to tell the player.
    pub fn join(&self, name: &str, pw_hash: &str) -> Result<u64, &'static str> {
        unsafe {
            // worldwide: by default Steam only lists lobbies near you, so a friend abroad would not find yours
            (self.add_distance_filter)(self.mm, 3);
            (self.add_filter)(self.mm, cs("sacoop").as_ptr(), cs("1").as_ptr(), 0);
            (self.add_filter)(self.mm, cs("name").as_ptr(), cs(&name.to_lowercase()).as_ptr(), 0);
        }
        let r: [u8; 4] = self.wait_call(unsafe { (self.request_list)(self.mm) }, LOBBY_MATCH_LIST).ok_or("steam")?;
        let count = u32::from_le_bytes(r);
        let lobby = (0..count as i32).map(|i| unsafe { (self.lobby_by_index)(self.mm, i) }).find(|&l| l != 0).ok_or("not found")?;
        if self.data(lobby, "pw") != pw_hash {
            return Err("password");
        }
        let e: [u8; 24] = self.wait_call(unsafe { (self.join)(self.mm, lobby) }, LOBBY_ENTER).ok_or("steam")?;
        if u32::from_le_bytes(e[16..20].try_into().unwrap()) != 1 {
            return Err("full");
        }
        Ok(lobby)
    }

    pub fn leave(&self, lobby: u64) {
        unsafe { (self.leave)(self.mm, lobby) }
    }

    fn data(&self, lobby: u64, key: &str) -> String {
        let p = unsafe { (self.get_data)(self.mm, lobby, cs(key).as_ptr()) };
        if p.is_null() { String::new() } else { unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned() }
    }

    /// Everyone in the lobby, us included, sorted: the order gives every player the same slot numbers.
    pub fn members(&self, lobby: u64) -> Vec<u64> {
        let n = unsafe { (self.members)(self.mm, lobby) }.clamp(0, 4);
        let mut v: Vec<u64> = (0..n).map(|i| unsafe { (self.member)(self.mm, lobby, i) }).filter(|&id| id != 0).collect();
        v.sort_unstable();
        v
    }

    pub fn name_of(&self, id: u64) -> String {
        let p = unsafe { (self.persona)(self.friends, id) };
        if p.is_null() { String::new() } else { unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned() }
    }

    pub fn accept(&self, id: u64) {
        unsafe { (self.accept)(self.net, id) };
    }

    pub fn send(&self, to: u64, data: &[u8], how: i32) {
        unsafe { (self.send)(self.net, to, data.as_ptr() as *const c_void, data.len() as u32, how, 0) };
    }

    /// One waiting packet: (sender, bytes).
    pub fn recv(&self, buf: &mut [u8]) -> Option<(u64, usize)> {
        let mut size = 0u32;
        if !unsafe { (self.available)(self.net, &mut size, 0) } {
            return None;
        }
        let mut got = 0u32;
        let mut from = 0u64;
        let ok = unsafe { (self.read)(self.net, buf.as_mut_ptr() as *mut c_void, buf.len() as u32, &mut got, &mut from, 0) };
        (ok && got as usize <= buf.len()).then_some((from, got as usize))
    }
}

/// Lobby password hash: FNV-1a 64 of "sa-coop:" + password, hex. Only keeps strangers out of a named lobby.
pub fn pw_hash(pw: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in format!("sa-coop:{pw}").bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}
