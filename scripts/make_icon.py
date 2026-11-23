"""Draw the app icon (same artwork as docs/logo.svg) into installer/EDAStudio.ico.

    .venv\\Scripts\\python.exe -m pip install pillow
    .venv\\Scripts\\python.exe scripts\\make_icon.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "installer" / "EDAStudio.ico"
S = 1024  # draw large, then downscale for smooth edges


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def main():
    c1, c2 = (0x2A, 0x78, 0xD6), (0x62, 0x50, 0xD6)
    grad = Image.new("RGB", (S, S))
    px = grad.load()
    for y in range(S):
        for x in range(S):
            px[x, y] = lerp(c1, c2, (x + y) / (2 * S - 2))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.234), fill=255)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img, "RGBA")
    k = S / 64
    for x, y0, h in ((12, 35, 17), (27.5, 24, 28), (43, 13, 39)):   # same geometry as logo.svg
        d.rounded_rectangle((x * k, y0 * k, (x + 9) * k, (y0 + h) * k), radius=2.5 * k, fill=(255, 255, 255, 242))
    for cx, cy in ((16.5, 25), (32, 14)):
        d.ellipse(((cx - 3) * k, (cy - 3) * k, (cx + 3) * k, (cy + 3) * k), fill=(255, 255, 255, 140))

    OUT.parent.mkdir(exist_ok=True)
    img.save(OUT, format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote", OUT, OUT.stat().st_size // 1024, "KB")


if __name__ == "__main__":
    main()
