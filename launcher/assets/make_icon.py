"""Draws the SA Co-op icon (original artwork, no game art or game fonts): a San Andreas loading-screen poster look.
Black tile, a big white "SA" with a heavy black outline and a drop shadow, and a Grove Street green "CO-OP" band
across the bottom. Font: Impact (Windows), only rendered into the image.

Needs Pillow (re/venv has it). Writes icon.ico (256/48/32/16), icon64.rgba (the installer's window icon) and
icon256.png (README)."""
from PIL import Image, ImageDraw, ImageFont, ImageFilter

FONT = r"C:\Windows\Fonts\impact.ttf"
GREEN = (46, 150, 64)
S = 1024  # drawn large, scaled down for each size


def poster():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = S // 8
    # black tile with a faint grain of dark grey
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=(14, 14, 14, 255))
    for y in range(0, S, 8):
        d.line([(0, y), (S, y)], fill=(22, 22, 22, 255), width=2)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=r, fill=255)

    # "SA": white, black outline, shadow
    big = ImageFont.truetype(FONT, int(S * 0.62))
    text = "SA"
    box = d.textbbox((0, 0), text, font=big, stroke_width=int(S * 0.03))
    w, h = box[2] - box[0], box[3] - box[1]
    x, y = (S - w) // 2 - box[0], int(S * 0.08) - box[1]
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).text((x + S * 0.025, y + S * 0.03), text, font=big, fill=(0, 0, 0, 230),
                                stroke_width=int(S * 0.03), stroke_fill=(0, 0, 0, 230))
    img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(S * 0.01)))
    d = ImageDraw.Draw(img)
    d.text((x, y), text, font=big, fill=(245, 245, 240, 255), stroke_width=int(S * 0.03), stroke_fill=(0, 0, 0, 255))

    # the green band with "CO-OP"
    top = int(S * 0.70)
    d.rectangle([0, top, S, int(S * 0.90)], fill=GREEN + (255,))
    d.line([(0, top), (S, top)], fill=(0, 0, 0, 255), width=int(S * 0.012))
    d.line([(0, int(S * 0.90)), (S, int(S * 0.90))], fill=(0, 0, 0, 255), width=int(S * 0.012))
    small = ImageFont.truetype(FONT, int(S * 0.16))
    t2 = "CO-OP"
    b2 = d.textbbox((0, 0), t2, font=small, stroke_width=int(S * 0.012))
    d.text(((S - (b2[2] - b2[0])) // 2 - b2[0], top + (int(S * 0.20) - (b2[3] - b2[1])) // 2 - b2[1]), t2,
           font=small, fill=(255, 255, 255, 255), stroke_width=int(S * 0.012), stroke_fill=(0, 0, 0, 255))

    img.putalpha(Image.composite(img.getchannel("A"), Image.new("L", (S, S), 0), mask))
    return img


if __name__ == "__main__":
    art = poster()
    sizes = [256, 48, 32, 16]
    art.resize((256, 256), Image.LANCZOS).save("icon256.png")
    art.resize((256, 256), Image.LANCZOS).save("icon.ico", sizes=[(n, n) for n in sizes])
    open("icon64.rgba", "wb").write(art.resize((64, 64), Image.LANCZOS).convert("RGBA").tobytes())
