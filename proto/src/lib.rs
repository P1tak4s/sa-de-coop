//! Wire format shared by the launcher (server) and coopnet64.dll (client). UDP, little-endian.
//! Every packet: MAGIC (4 bytes) + kind (u8) + body. The server only relays STATE; it never trusts or parses it.

pub const MAGIC: [u8; 4] = *b"SDC1";
pub const DEFAULT_PORT: u16 = 7790;
pub const MAX_PLAYERS: usize = 4;
pub const NICK_LEN: usize = 16;

pub const JOIN: u8 = 1; // client -> server: key u32, nick [16]
pub const WELCOME: u8 = 2; // server -> client: slot u8
pub const DENY: u8 = 3; // server -> client: reason u8 (1 bad key, 2 full)
pub const STATE: u8 = 4; // client -> server: State; server -> clients: slot u8 + State
pub const LEAVE: u8 = 5; // client -> server: (empty); server -> clients: slot u8
pub const EVENT: u8 = 8; // client -> server: kind u8 + ASCII text (<= 24); server -> clients: from slot u8 + same
pub const EV_WEATHER: u8 = 1; // text: weather id
pub const EV_CUTSCENE: u8 = 2; // text: cutscene name
pub const EV_HIT: u8 = 4; // text: "<handle>:<damage>" for the mission owner
pub const EV_MONEY: u8 = 5; // text: dollars earned in the mission just finished
pub const EV_MISSION: u8 = 3; // text: mission script name ("" = mission over)
pub const ENTS: u8 = 9; // mission entities of the sender's game: n u8 + n x ENT_SIZE (relayed with the sender slot first)
pub const ENT_SIZE: usize = 28; // handle u32, kind u8 (1 car, 2 char), dead u8, model u16, x y z heading health f32
pub const MAX_ENTS: usize = 40;
pub const NAMES: u8 = 7; // server -> clients: n u8, then n x (slot u8, nick [16])
pub const REVIVE: u8 = 6; // client -> server: target slot u8; server -> clients: from slot u8, target slot u8

/// One player's state as the game script sees it.
/// `in_car`: 0 on foot, 1 driving `car_model`, 2 passenger: `car_model` = the driver's slot, `car_health` = seat.
/// `health` < 0: down, waiting to be revived. `repr(C)`: the JS script reads and writes it by byte offset.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct State {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub heading: f32,
    pub vx: f32,
    pub vy: f32,
    pub vz: f32,
    pub qx: f32,
    pub qy: f32,
    pub qz: f32,
    pub qw: f32,
    pub car_speed: f32,
    pub in_car: i32,
    pub car_model: i32,
    pub health: i32,
    pub car_health: i32,
    /// interior (area) id, 0 = outside: friends are only shown in the same one
    pub interior: i32,
    /// time of day in minutes (0..1439); the player in the lowest slot sets everyone's clock
    pub clock: i32,
    /// weapon type in hand (0 = fists)
    pub weapon: i32,
    /// bit 0 aiming, bit 1 shooting, bits 8..15 wanted level (0..6)
    pub flags: i32,
}

pub const STATE_SIZE: usize = 80;
const _: () = assert!(std::mem::size_of::<State>() == STATE_SIZE);

impl State {
    pub fn to_bytes(&self) -> [u8; STATE_SIZE] {
        let mut out = [0u8; STATE_SIZE];
        let f = [self.x, self.y, self.z, self.heading, self.vx, self.vy, self.vz, self.qx, self.qy, self.qz, self.qw, self.car_speed];
        for (i, v) in f.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
        let n = [self.in_car, self.car_model, self.health, self.car_health, self.interior, self.clock, self.weapon, self.flags];
        for (i, v) in n.iter().enumerate() {
            out[48 + i * 4..52 + i * 4].copy_from_slice(&v.to_le_bytes());
        }
        out
    }

    pub fn from_bytes(b: &[u8]) -> Option<State> {
        if b.len() < STATE_SIZE {
            return None;
        }
        let f = |i: usize| f32::from_le_bytes(b[i * 4..i * 4 + 4].try_into().unwrap());
        let n = |i: usize| i32::from_le_bytes(b[48 + i * 4..52 + i * 4].try_into().unwrap());
        let s = State {
            x: f(0), y: f(1), z: f(2), heading: f(3), vx: f(4), vy: f(5), vz: f(6),
            qx: f(7), qy: f(8), qz: f(9), qw: f(10), car_speed: f(11),
            in_car: n(0), car_model: n(1), health: n(2), car_health: n(3), interior: n(4), clock: n(5), weapon: n(6), flags: n(7),
        };
        // a peer could send anything: refuse what would hurt the game (NaN positions, bogus models)
        let finite = [s.x, s.y, s.z, s.heading, s.vx, s.vy, s.vz, s.qx, s.qy, s.qz, s.qw, s.car_speed].iter().all(|v| v.is_finite());
        let in_world = s.x.abs() < 6000.0 && s.y.abs() < 6000.0 && s.z > -200.0 && s.z < 2000.0
            && (0..=255).contains(&s.interior) && (0..1440).contains(&s.clock)
            && (0..=46).contains(&s.weapon) && (s.flags >> 8 & 0xff) <= 6;
        let model_ok = match s.in_car {
            0 => true,
            1 => (400..=611).contains(&s.car_model),
            2 => (0..MAX_PLAYERS as i32).contains(&s.car_model) && (0..=2).contains(&s.car_health),
            _ => false,
        };
        (finite && in_world && model_ok).then_some(s)
    }
}

pub fn packet(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut p = Vec::with_capacity(5 + body.len());
    p.extend_from_slice(&MAGIC);
    p.push(kind);
    p.extend_from_slice(body);
    p
}

/// (kind, body) of a packet with our magic.
pub fn parse(p: &[u8]) -> Option<(u8, &[u8])> {
    (p.len() >= 5 && p[..4] == MAGIC).then(|| (p[4], &p[5..]))
}

pub fn nick_bytes(nick: &str) -> [u8; NICK_LEN] {
    let mut out = [0u8; NICK_LEN];
    let clean: String = nick.chars().filter(|c| c.is_alphanumeric() || "_-.".contains(*c)).collect();
    let b = clean.as_bytes();
    let n = b.len().min(NICK_LEN);
    out[..n].copy_from_slice(&b[..n]);
    out
}

// ---- invite code: IPv4 + port + key (u32) in Crockford base32, XXXX-XXXX-XXXX-XXXX --------------------

const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub fn make_code(ip: [u8; 4], port: u16, key: u32) -> String {
    // 80 bits: ip(32) port(16) key(32) -> 16 symbols of 5 bits
    let v: u128 = (u32::from_be_bytes(ip) as u128) << 48 | (port as u128) << 32 | key as u128;
    let s: String = (0..16).rev().map(|i| ALPHABET[((v >> (i * 5)) & 31) as usize] as char).collect();
    format!("{}-{}-{}-{}", &s[0..4], &s[4..8], &s[8..12], &s[12..16])
}

pub fn parse_code(code: &str) -> Option<([u8; 4], u16, u32)> {
    let mut v: u128 = 0;
    let mut n = 0;
    for c in code.chars().filter(|c| !c.is_whitespace() && *c != '-') {
        let c = match c.to_ascii_uppercase() { 'O' => '0', 'I' | 'L' => '1', c => c };
        let d = ALPHABET.iter().position(|&a| a as char == c)? as u128;
        v = v << 5 | d;
        n += 1;
    }
    if n != 16 {
        return None;
    }
    let ip = ((v >> 48) as u32).to_be_bytes();
    Some((ip, (v >> 32) as u16, v as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_round_trip() {
        let c = make_code([84, 15, 200, 7], 7790, 0xDEADBEEF);
        assert_eq!(c.len(), 19);
        assert_eq!(parse_code(&c), Some(([84, 15, 200, 7], 7790, 0xDEADBEEF)));
        assert_eq!(parse_code(&c.to_lowercase().replace('-', " ")), Some(([84, 15, 200, 7], 7790, 0xDEADBEEF)));
        assert_eq!(parse_code("ABC"), None);
    }

    #[test]
    fn state_round_trip_and_rejects_garbage() {
        let s = State { x: 2027.0, y: 996.1, z: 10.8, heading: 90.0, in_car: 1, car_model: 411, health: 100, interior: 1, clock: 720, ..Default::default() };
        assert_eq!(State::from_bytes(&s.to_bytes()), Some(s));
        let bad = State { x: f32::NAN, ..s };
        assert_eq!(State::from_bytes(&bad.to_bytes()), None);
        let bad_model = State { car_model: 9999, ..s };
        assert_eq!(State::from_bytes(&bad_model.to_bytes()), None);
        let passenger = State { in_car: 2, car_model: 0, car_health: 0, ..s };
        assert_eq!(State::from_bytes(&passenger.to_bytes()), Some(passenger));
        let bad_seat = State { in_car: 2, car_model: 7, ..s };
        assert_eq!(State::from_bytes(&bad_seat.to_bytes()), None);
    }
}
