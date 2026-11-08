"""Loopback test of coopnet64.asi without the game: host in the DLL, a bot joins with the code, states and
names travel both ways. python -I tools/dll_test.py"""
import ctypes, os, socket, struct, sys, time
dll = ctypes.WinDLL(os.path.abspath("game/coopnet64.asi"))
for f in ("coop_host", "coop_status", "coop_slot", "coop_send", "coop_get", "coop_code", "coop_name"):
    getattr(dll, f).restype = ctypes.c_int64
assert dll.coop_host() == 1, "host failed"
buf = ctypes.create_string_buffer(32)
for _ in range(50):
    n = dll.coop_code(buf, 32)
    if n: break
    time.sleep(0.1)
code = buf.raw[:n].decode(); print("code", code)
A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; v = 0
for c in code.replace("-", ""): v = v << 5 | A.index(c)
srv = ("127.0.0.1", (v >> 32) & 0xFFFF); key = v & 0xFFFFFFFF
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(0.05)
M = b"SDC1"
s.sendto(M + bytes([1]) + struct.pack("<I", key) + b"Botas".ljust(16, b"\0"), srv)
mine = struct.pack("<12f8i", 2000, 1000, 10, 90, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 100, 0, 0, 720, 0, 0)
got_dll_state = None; bot_slot = None
t0 = time.time()
while time.time() - t0 < 5:
    dll.coop_send(mine)
    try:
        d, _ = s.recvfrom(512)
        if d[:5] == M + bytes([2]): bot_slot = d[5]
        if d[:5] == M + bytes([4]): got_dll_state = struct.unpack_from("<3f", d, 6)
    except socket.timeout:
        pass
    if bot_slot is not None:
        st = struct.pack("<12f8i", 2010, 1005, 10, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 77, 0, 0, 720, 0, 0)
        s.sendto(M + bytes([4]) + st, srv)
out = ctypes.create_string_buffer(80)
ok = dll.coop_get(bot_slot if bot_slot is not None else 1, out)
peer = struct.unpack_from("<3f", out.raw) if ok else None
nb = ctypes.create_string_buffer(16); nl = dll.coop_name(bot_slot if bot_slot is not None else 1, nb, 16)
print("status", dll.coop_status(), "my slot", dll.coop_slot(), "bot slot", bot_slot)
print("bot got DLL state:", got_dll_state)
print("DLL got bot state:", peer, "name:", nb.raw[:nl].decode())
sys.exit(0 if (got_dll_state and peer and nb.raw[:nl] == b"Botas") else 1)
