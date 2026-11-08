//! The relay server (the host runs it, in the launcher or inside the game via coopnet64.dll) and helpers to
//! reach it from the internet: UPnP port forward, LAN address, session keys.

use proto::*;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub fn random_key() -> u32 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(Instant::now().elapsed().as_nanos() ^ std::process::id() as u128);
    (h.finish() as u32) | 1
}

pub fn lan_ip() -> Option<Ipv4Addr> {
    let s = UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("1.1.1.1:80").ok()?; // no packet is sent: this only picks the outgoing interface
    match s.local_addr().ok()?.ip() {
        IpAddr::V4(v) => Some(v),
        _ => None,
    }
}

// ---- server ---------------------------------------------------------------------------------------------

struct Peer {
    addr: SocketAddr,
    nick: String,
    seen: Instant,
}

pub type Players = Arc<Mutex<Vec<String>>>;

pub fn run_server(sock: UdpSocket, key: u32, players: Players) {
    let _ = sock.set_read_timeout(Some(Duration::from_millis(200)));
    let mut peers: [Option<Peer>; MAX_PLAYERS] = Default::default();
    let mut buf = [0u8; 2048];
    loop {
        // drop the silent: a crashed game must not hold a seat
        for slot in 0..MAX_PLAYERS {
            if peers[slot].as_ref().is_some_and(|p| p.seen.elapsed() > Duration::from_secs(10)) {
                peers[slot] = None;
                broadcast(&sock, &peers, None, &packet(LEAVE, &[slot as u8]));
            }
        }
        *players.lock().unwrap() = peers.iter().flatten().map(|p| p.nick.clone()).collect();

        let Ok((n, from)) = sock.recv_from(&mut buf) else { continue };
        let Some((kind, body)) = parse(&buf[..n]) else { continue };
        let known = peers.iter().position(|p| p.as_ref().is_some_and(|p| p.addr == from));
        match (kind, known) {
            (JOIN, _) if body.len() >= 4 + NICK_LEN => {
                if u32::from_le_bytes(body[..4].try_into().unwrap()) != key {
                    let _ = sock.send_to(&packet(DENY, &[1]), from);
                    continue;
                }
                let nick = String::from_utf8_lossy(&body[4..4 + NICK_LEN]).trim_end_matches('\0').to_string();
                let slot = known.or_else(|| peers.iter().position(|p| p.is_none()));
                match slot {
                    Some(s) => {
                        peers[s] = Some(Peer { addr: from, nick, seen: Instant::now() });
                        let _ = sock.send_to(&packet(WELCOME, &[s as u8]), from);
                        // everyone learns everyone's name (the game draws it over their head)
                        let mut names = vec![peers.iter().flatten().count() as u8];
                        for (i, p) in peers.iter().enumerate() {
                            if let Some(p) = p {
                                names.push(i as u8);
                                names.extend_from_slice(&nick_bytes(&p.nick));
                            }
                        }
                        broadcast(&sock, &peers, None, &packet(NAMES, &names));
                    }
                    None => {
                        let _ = sock.send_to(&packet(DENY, &[2]), from);
                    }
                }
            }
            (STATE, Some(s)) if body.len() == STATE_SIZE => {
                if let Some(p) = peers[s].as_mut() {
                    p.seen = Instant::now();
                }
                if State::from_bytes(body).is_some() {
                    let mut out = vec![s as u8];
                    out.extend_from_slice(body);
                    broadcast(&sock, &peers, Some(s), &packet(STATE, &out));
                }
            }
            (REVIVE, Some(s)) if body.len() == 1 && (body[0] as usize) < MAX_PLAYERS => {
                broadcast(&sock, &peers, Some(s), &packet(REVIVE, &[s as u8, body[0]]));
            }
            (EVENT, Some(s)) if (2..=121).contains(&body.len()) => {
                let mut out = vec![s as u8];
                out.extend_from_slice(body);
                broadcast(&sock, &peers, Some(s), &packet(EVENT, &out));
            }
            (ENTS, Some(s)) if !body.is_empty() && body.len() == 1 + body[0] as usize * ENT_SIZE && (body[0] as usize) <= MAX_ENTS => {
                let mut out = vec![s as u8];
                out.extend_from_slice(body);
                broadcast(&sock, &peers, Some(s), &packet(ENTS, &out));
            }
            (LEAVE, Some(s)) => {
                peers[s] = None;
                broadcast(&sock, &peers, None, &packet(LEAVE, &[s as u8]));
            }
            _ => {}
        }
    }
}

fn broadcast(sock: &UdpSocket, peers: &[Option<Peer>; MAX_PLAYERS], except: Option<usize>, p: &[u8]) {
    for (i, peer) in peers.iter().enumerate() {
        if let Some(peer) = peer {
            if Some(i) != except {
                let _ = sock.send_to(p, peer.addr);
            }
        }
    }
}

/// Ask the router (UPnP) to forward the port and tell us the outside address. None: no UPnP, the host forwards
/// the port by hand and the LAN code still works.
pub fn upnp(port: u16) -> Option<Ipv4Addr> {
    let gw = igd_next::search_gateway(Default::default()).ok()?;
    let local = SocketAddr::new(IpAddr::V4(lan_ip()?), port);
    gw.add_port(igd_next::PortMappingProtocol::UDP, port, local, 6 * 3600, "SA Co-op").ok()?;
    match gw.get_external_ip().ok()? {
        IpAddr::V4(v) => Some(v),
        _ => None,
    }
}

