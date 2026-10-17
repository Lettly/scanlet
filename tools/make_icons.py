#!/usr/bin/env python3
"""Generate the Scanlet app icons as PNGs (no external dependencies).

Draws a rounded-square badge with a document, a folded corner and an accent
scan bar, with 4x supersampling for anti-aliasing.
"""

import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
SS = 4  # supersample factor


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def inside_round_rect(x, y, x0, y0, x1, y1, r):
    if x < x0 or x > x1 or y < y0 or y > y1:
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def shade(px, py, n):
    """Return RGBA for a point in the unit square."""
    bg_top = (0x6D, 0x71, 0xF3)
    bg_bot = (0x38, 0x3B, 0xD8)
    page = (0xFF, 0xFF, 0xFF)
    fold = (0xC9, 0xCD, 0xDE)
    line = (0xB4, 0xBB, 0xD4)
    accent = (0x2C, 0xD4, 0xEE)

    # background badge
    if not inside_round_rect(px, py, 0.0, 0.0, 1.0, 1.0, 0.225):
        return (0, 0, 0, 0)
    color = lerp(bg_top, bg_bot, py)

    # document sheet
    if inside_round_rect(px, py, 0.255, 0.145, 0.745, 0.845, 0.035):
        color = page

        # folded top-right corner
        fx, fy = 0.745, 0.145
        size = 0.20
        if px >= fx - size and py <= fy + size and (px - (fx - size)) + (fy + size - py) <= size:
            color = fold

        # text lines
        for ly, lx1 in ((0.455, 0.635), (0.565, 0.585), (0.675, 0.615)):
            if inside_round_rect(px, py, 0.355, ly - 0.032, lx1, ly + 0.032, 0.032):
                color = line

    # accent scan bar under the sheet
    if inside_round_rect(px, py, 0.20, 0.885, 0.80, 0.955, 0.035):
        color = accent

    return (color[0], color[1], color[2], 255)


def render(size):
    n = size * SS
    acc = [[0, 0, 0, 0] for _ in range(n * n)]
    for yy in range(n):
        py = (yy + 0.5) / n
        for xx in range(n):
            px = (xx + 0.5) / n
            r, g, b, a = shade(px, py, n)
            i = yy * n + xx
            # premultiply for correct averaging over transparent pixels
            acc[i] = [r * a, g * a, b * a, a]
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            sr = sg = sb = sa = 0
            for dy in range(SS):
                for dx in range(SS):
                    v = acc[(y * SS + dy) * n + (x * SS + dx)]
                    sr += v[0]
                    sg += v[1]
                    sb += v[2]
                    sa += v[3]
            total = SS * SS
            a = sa / total
            if a <= 0:
                row += bytes((0, 0, 0, 0))
            else:
                # un-premultiply
                row += bytes((round(sr / (a * total)), round(sg / (a * total)), round(sb / (a * total)), round(a)))
        rows.append(bytes(row))
    return size, b"".join(b"\x00" + r for r in rows)


def write_png(path, size, raw):
    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    blob = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(blob)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (32, 180, 192, 512, 1024):
        s, raw = render(size)
        name = "favicon-32.png" if size == 32 else ("apple-touch-icon.png" if size == 180 else f"icon-{size}.png")
        write_png(os.path.join(OUT, name), s, raw)
        print("wrote", name, size)


if __name__ == "__main__":
    main()
