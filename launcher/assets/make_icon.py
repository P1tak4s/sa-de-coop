"""Draws the SA Co-op icon (original artwork: a dusk sun over the city, Grove green ground). No dependencies.
Writes icon.ico (256/48/32/16 PNG entries) and icon64.rgba (raw RGBA for the window icon)."""
import struct, zlib, math

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def draw(n):
    px = []
    r_corner = n * 0.18
    for y in range(n):
        for x in range(n):
            fx, fy = (x + 0.5) / n, (y + 0.5) / n
            # rounded square mask (anti-aliased)
            dx = max(abs(fx - 0.5) * n - (n / 2 - r_corner), 0); dy = max(abs(fy - 0.5) * n - (n / 2 - r_corner), 0)
            a = max(0.0, min(1.0, r_corner - math.hypot(dx, dy) + 0.5))
            # dusk sky
            c = lerp((44, 22, 58), (232, 110, 48), min(1, fy / 0.68))
            # sun with horizontal cut stripes
            d = math.hypot(fx - 0.5, fy - 0.56)
            if d < 0.27 and fy < 0.68:
                stripe = fy > 0.5 and int((fy - 0.5) * n / max(1, n * 0.045)) % 2 == 1
                if not stripe:
                    c = lerp((255, 214, 92), (246, 120, 40), max(0, min(1, (fy - 0.3) / 0.38)))
            # skyline
            bx = int(fx * 12)
            heights = [0.62, 0.55, 0.6, 0.48, 0.58, 0.64, 0.5, 0.44, 0.57, 0.61, 0.53, 0.6]
            if fy > heights[bx % 12] + 0.08 and fy < 0.72:
                c = (24, 16, 30)
            # Grove green ground
            if fy >= 0.72:
                c = lerp((46, 160, 67), (22, 92, 38), (fy - 0.72) / 0.28)
            px.append((*c, int(255 * a)))
    return px

def png(n, px):
    raw = b"".join(b"\0" + bytes(v for p in px[y * n:(y + 1) * n] for v in p) for y in range(n))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

sizes = [256, 48, 32, 16]
images = [png(s, draw(s)) for s in sizes]
head = struct.pack("<HHH", 0, 1, len(sizes)); off = 6 + 16 * len(sizes); dirs = b""
for s, im in zip(sizes, images):
    dirs += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(im), off); off += len(im)
open("icon.ico", "wb").write(head + dirs + b"".join(images))
open("icon64.rgba", "wb").write(bytes(v for p in draw(64) for v in p))
open("icon256.png", "wb").write(images[0])
print("ok")
