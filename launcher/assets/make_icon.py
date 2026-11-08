"""Draws the SA Co-op icon (original artwork, no game art): a hazy Los Santos sunset, the city skyline, two palm
silhouettes and Grove Street green ground, in a rounded square. Sister of the VC co-op icon (sea + one palm).
No dependencies. Writes icon.ico (256/48/32/16 PNG entries), icon64.rgba (window icon) and icon256.png."""
import struct, zlib, math

def lerp(a, b, t):
    t = max(0.0, min(1.0, t))
    return a + (b - a) * t

def seg(p, a, b):
    vx, vy, wx, wy = b[0] - a[0], b[1] - a[1], p[0] - a[0], p[1] - a[1]
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
    return math.hypot(wx - t * vx, wy - t * vy)

def palm(x0, h, lean):
    # trunk from the ground up, fronds from the top (unit square coordinates)
    base = (x0, 0.80)
    top = (x0 + lean, 0.80 - h)
    trunk = [base, (x0 + lean * 0.3, 0.80 - h * 0.45), top]
    fronds = [(-0.17, 0.05), (-0.11, -0.07), (0.03, -0.11), (0.14, -0.05), (0.17, 0.07)]
    return trunk, top, [(top[0] + dx * h / 0.5, top[1] + dy * h / 0.5) for dx, dy in fronds]

PALMS = [palm(0.20, 0.50, 0.04), palm(0.80, 0.40, -0.03)]
SKY = [0.60, 0.53, 0.58, 0.46, 0.55, 0.62, 0.49, 0.43, 0.56, 0.60, 0.52, 0.58, 0.63, 0.57]

def draw(n):
    px = []
    s = float(n)
    w = 1.6 / s
    horizon = 0.72
    for y in range(n):
        for x in range(n):
            fx, fy = (x + 0.5) / s, (y + 0.5) / s
            r = 0.2
            dx, dy = abs(fx - 0.5) - (0.5 - r), abs(fy - 0.5) - (0.5 - r)
            outside = math.hypot(max(dx, 0), max(dy, 0)) - r
            alpha = max(0.0, min(1.0, 0.5 - outside * s))
            # hazy sky: deep red-brown to orange to pale yellow at the horizon
            t = fy / horizon
            c = [lerp(70, 255, t), lerp(24, 196, t * t), lerp(30, 90, t * t)]
            # big sun, horizontal cuts in the lower half
            d = math.hypot(fx - 0.5, fy - 0.58)
            stripe = fy > 0.52 and int((fy - 0.52) * s / max(1.0, s / 26)) % 2 == 1
            if d < 0.25 and not stripe:
                c = [255, lerp(240, 150, (fy - 0.33) / 0.38), lerp(150, 40, (fy - 0.33) / 0.38)]
            # skyline
            if fy > SKY[min(int(fx * len(SKY)), len(SKY) - 1)] + 0.08 and fy < horizon:
                c = [44, 22, 30]
            # Grove Street green ground
            if fy >= horizon:
                c = [lerp(48, 20, (fy - horizon) / 0.28), lerp(150, 84, (fy - horizon) / 0.28), lerp(58, 34, (fy - horizon) / 0.28)]
            # palms (near black)
            ink = 9.0
            for trunk, top, fronds in PALMS:
                for a, b in zip(trunk, trunk[1:]):
                    ink = min(ink, seg((fx, fy), a, b) - (0.026 + w))
                for f in fronds:
                    mid = ((top[0] + f[0]) / 2, (top[1] + f[1]) / 2 - 0.035)
                    ink = min(ink, min(seg((fx, fy), top, mid), seg((fx, fy), mid, f)) - (0.019 + w))
            if ink < 0:
                a = max(0.0, min(1.0, -ink * s))
                c = [lerp(c[0], 20, a), lerp(c[1], 12, a), lerp(c[2], 16, a)]
            px.append((int(c[0]), int(c[1]), int(c[2]), int(255 * alpha)))
    return px

def png(n, px):
    raw = b"".join(b"\0" + bytes(v for p in px[y * n:(y + 1) * n] for v in p) for y in range(n))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

sizes = [256, 48, 32, 16]
images = [png(sz, draw(sz)) for sz in sizes]
head = struct.pack("<HHH", 0, 1, len(sizes)); off = 6 + 16 * len(sizes); dirs = b""
for sz, im in zip(sizes, images):
    dirs += struct.pack("<BBBBHHII", sz % 256, sz % 256, 0, 0, 1, 32, len(im), off); off += len(im)
open("icon.ico", "wb").write(head + dirs + b"".join(images))
open("icon64.rgba", "wb").write(bytes(v for p in draw(64) for v in p))
open("icon256.png", "wb").write(images[0])
print("ok")
