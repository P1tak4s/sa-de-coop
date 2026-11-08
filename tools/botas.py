"""Test friend without a friend: joins the session the launcher wrote (as host) and walks in a circle around
player 0 (you). Run while the game is running: python -I tools/botas.py [masina]
With "masina" it drives an Infernus on a 15 m circle instead of walking; with "suzeistas" it lies down and waits
for you to revive it (E). It always revives you when you are down (after 3 s)."""
import math, os, socket, struct, sys, time
MODE = sys.argv[1] if len(sys.argv) > 1 else ""
SKIN = int(os.environ.get("SKIN", "1"))  # 1 = Sweet: tests the story-character look
DRIVE = MODE == "masina"
down = MODE == "suzeistas"; you_down_since = None; rider_since = None

CODE = os.environ.get("KODAS", "")
if CODE:  # in-game host (F9): the code from the screen; the bot runs on the host's PC, so 127.0.0.1
    A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; v = 0
    for c in CODE.replace("-", "").upper(): v = v << 5 | A.index(c)
    srv = ("127.0.0.1", (v >> 32) & 0xFFFF); key = v & 0xFFFFFFFF
else:
    sess = dict(l.split("=", 1) for l in open(os.path.join(os.environ["LOCALAPPDATA"], "sa-de-coop", "session.used")).read().split())
    host, port = sess["server"].rsplit(":", 1)
    srv = (host, int(port)); key = int(sess["key"], 16)
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(0.05)
MAGIC = b"SDC1"
s.sendto(MAGIC + bytes([1]) + struct.pack("<I", key) + b"Botas".ljust(16, b"\0"), srv)
center = None; t0 = time.time(); slot = None
while True:
    try:
        d, _ = s.recvfrom(512)
        if d[:4] == MAGIC and d[4] == 2: slot = d[5]; print("joined, slot", slot)
        if d[:4] == MAGIC and d[4] == 3: print("server refused"); break
        if d[:4] == MAGIC and d[4] == 4:
            if center is None: center = struct.unpack_from("<3f", d, 6); print("your position", center)
            if rider_since is None and struct.unpack_from("<i", d, 6 + 48)[0] == 2:
                rider_since = time.time(); print("you are in, driving")
            if struct.unpack_from("<i", d, 6 + 56)[0] < 0:  # you are down
                you_down_since = you_down_since or time.time()
                if time.time() - you_down_since > 3:
                    s.sendto(MAGIC + bytes([6, d[5]]), srv); print("reviving you"); you_down_since = None
            else:
                you_down_since = None
        if d[:4] == MAGIC and d[4] == 8 and len(d) > 7:
            print("event", d[6], d[7:].split(bytes([0]))[0].decode(errors="replace"))
        if d[:4] == MAGIC and d[4] == 9 and len(d) > 7:
            print("mission entities:", d[6])
        if d[:4] == MAGIC and d[4] == 6 and len(d) >= 7 and d[6] == slot:
            print("you revived me"); down = False
    except socket.timeout:
        pass
    if slot is None:
        s.sendto(MAGIC + bytes([1]) + struct.pack("<I", key) + b"Botas".ljust(16, b"\0"), srv); time.sleep(0.5); continue
    if center is None: continue
    if MODE == "tiesiai":  # drive north at 8 m/s from where you are, stop after 25 s (passenger test)
        if rider_since is None: t, v = 0.0, 0.0  # wait in place until you sit in (G)
        else: t = min(time.time() - rider_since, 25.0); v = 8.0 if t < 25 else 0.0
        st = struct.pack("<12f8i", center[0], center[1] + 8.0 * t, center[2] + 0.3, 0, 0, 0, 0, 0, 0, 0, 1, v,
                         1, 411, 100, 1000, 0, 720, 0, SKIN << 16)
    elif MODE == "stovi":  # in the car, parked 4 m east of you: for testing G (ride along)
        st = struct.pack("<12f8i", center[0] + 4, center[1], center[2] + 0.5, 0, 0, 0, 0, 0, 0, 0, 1, 0,
                         1, 411, 100, 1000, 0, 720, 0, SKIN << 16)
    elif DRIVE:
        r, w = 15.0, 0.5  # 7.5 m/s around a 15 m circle
        a = (time.time() - t0) * w
        x, y = center[0] + r * math.cos(a), center[1] + r * math.sin(a)
        heading = math.degrees(a) % 360  # SA: 0 = north (+y), counter-clockwise; at angle a the circle runs (-sin a, cos a)
        h = math.radians(heading)
        st = struct.pack("<12f8i", x, y, center[2] + 0.5, heading, 0, 0, 0, 0, 0, math.sin(h / 2), math.cos(h / 2), r * w,
                         1, 411, 100, 1000, 0, 720, 0, SKIN << 16)
    else:
        a = (time.time() - t0) * 0.4  # ~1.6 m/s on a 4 m circle: a walk
        x, y = center[0] + 4 * math.cos(a), center[1] + 4 * math.sin(a)
        heading = (math.degrees(a) + 180) % 360
        if down: x, y = center[0] + 3, center[1]
        st = struct.pack("<12f8i", x, y, center[2], heading, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, -1 if down else 100, 0, 0, 720, 0, SKIN << 16)
    s.sendto(MAGIC + bytes([4]) + st, srv)
    time.sleep(0.05)
