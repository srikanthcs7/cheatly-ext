#!/usr/bin/env python3
"""Generate PNG icons for QuizSolve extension.

Design: Rounded rectangle with blue-to-indigo gradient background,
white "Q" letter with an integrated checkmark as the tail.
"""
import struct
import zlib
import os
import math


def create_png(width, height, pixels):
    """Create a PNG file from pixel data. pixels is a list of (r,g,b,a) tuples."""
    def chunk(chunk_type, data):
        c = chunk_type + data
        crc = zlib.crc32(c) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + c + struct.pack('>I', crc)

    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)

    raw_data = b''
    for y in range(height):
        raw_data += b'\x00'
        for x in range(width):
            idx = y * width + x
            r, g, b, a = pixels[idx]
            raw_data += bytes([r, g, b, a])

    idat_data = zlib.compress(raw_data, 9)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', ihdr_data)
    png += chunk(b'IDAT', idat_data)
    png += chunk(b'IEND', b'')
    return png


def rounded_rect_sdf(x, y, cx, cy, hw, hh, radius):
    """Signed distance field for a rounded rectangle centered at (cx, cy)."""
    dx = abs(x - cx) - hw + radius
    dy = abs(y - cy) - hh + radius
    outside = math.sqrt(max(dx, 0) ** 2 + max(dy, 0) ** 2) - radius
    inside = min(max(dx, dy), 0)
    return outside + inside


def circle_sdf(x, y, cx, cy, r):
    """Signed distance field for a circle."""
    return math.sqrt((x - cx) ** 2 + (y - cy) ** 2) - r


def set_pixel_blend(pixels, size, x, y, r, g, b, a):
    """Set a pixel with alpha blending over existing pixel."""
    ix, iy = int(round(x)), int(round(y))
    if 0 <= ix < size and 0 <= iy < size:
        idx = iy * size + ix
        bg = pixels[idx]
        if bg[3] == 0:
            return
        fa = a / 255.0
        ba = bg[3] / 255.0
        oa = fa + ba * (1 - fa)
        if oa > 0:
            nr = int((r * fa + bg[0] * ba * (1 - fa)) / oa)
            ng = int((g * fa + bg[1] * ba * (1 - fa)) / oa)
            nb = int((b * fa + bg[2] * ba * (1 - fa)) / oa)
            pixels[idx] = (nr, ng, nb, int(oa * 255))


def draw_thick_line(pixels, size, x0, y0, x1, y1, thickness, r=255, g=255, b=255, a=240):
    """Draw an anti-aliased thick line."""
    length = math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2)
    if length == 0:
        return
    steps = int(length * 3) + 1
    for i in range(steps + 1):
        t = i / steps
        px = x0 + (x1 - x0) * t
        py = y0 + (y1 - y0) * t
        for dx in range(-thickness - 1, thickness + 2):
            for dy in range(-thickness - 1, thickness + 2):
                dist = math.sqrt(dx * dx + dy * dy)
                if dist <= thickness + 0.5:
                    alpha = a
                    if dist > thickness - 0.5:
                        alpha = int(a * max(0, (thickness + 0.5 - dist)))
                    if alpha > 0:
                        set_pixel_blend(pixels, size, px + dx, py + dy, r, g, b, alpha)


def draw_arc(pixels, size, cx, cy, radius, start_angle, end_angle, thickness, r=255, g=255, b=255, a=240):
    """Draw a thick arc (partial circle)."""
    circumference = abs(end_angle - start_angle) * radius
    steps = max(int(circumference * 3), 60)
    for i in range(steps + 1):
        t = i / steps
        angle = start_angle + (end_angle - start_angle) * t
        px = cx + radius * math.cos(angle)
        py = cy + radius * math.sin(angle)
        for dx in range(-thickness - 1, thickness + 2):
            for dy in range(-thickness - 1, thickness + 2):
                dist = math.sqrt(dx * dx + dy * dy)
                if dist <= thickness + 0.5:
                    alpha = a
                    if dist > thickness - 0.5:
                        alpha = int(a * max(0, (thickness + 0.5 - dist)))
                    if alpha > 0:
                        set_pixel_blend(pixels, size, px + dx, py + dy, r, g, b, alpha)


def generate_icon(size):
    """Generate QuizSolve icon: rounded rect + Q with checkmark tail."""
    pixels = []
    center = size / 2
    margin = max(1, size * 0.04)
    half_w = size / 2 - margin
    half_h = size / 2 - margin
    corner_radius = size * 0.2

    for y in range(size):
        for x in range(size):
            d = rounded_rect_sdf(x + 0.5, y + 0.5, center, center, half_w, half_h, corner_radius)

            if d < 0.75:
                # Diagonal gradient: top-left (#4F46E5 indigo-600) to bottom-right (#7C3AED violet-600)
                t = (x + y) / (2 * size)
                cr = int(79 + (124 - 79) * t)
                cg = int(70 + (58 - 70) * t)
                cb = int(229 + (237 - 229) * t)

                # Anti-aliasing at edges
                if d > -0.75:
                    alpha = max(0, min(255, int(255 * (0.75 - d) / 1.5)))
                else:
                    alpha = 255

                pixels.append((cr, cg, cb, alpha))
            else:
                pixels.append((0, 0, 0, 0))

    # Draw the Q + checkmark
    if size >= 48:
        draw_q_with_check(pixels, size)
    elif size >= 16:
        draw_q_small(pixels, size)

    return create_png(size, size, pixels)


def draw_q_with_check(pixels, size):
    """Draw a 'Q' letter whose tail becomes a checkmark. For 48px and 128px."""
    s = size / 128.0  # Scale factor relative to 128px

    # Q circle parameters
    cx = size * 0.46
    cy = size * 0.44
    q_radius = size * 0.24
    thickness = max(2, int(size * 0.055))

    # Draw the Q circle (open at bottom-right, ~300 degrees)
    # Start from bottom-right gap, go counter-clockwise almost all the way around
    gap_angle = math.radians(35)
    start_angle = gap_angle
    end_angle = math.radians(360) - math.radians(10)
    draw_arc(pixels, size, cx, cy, q_radius, start_angle, end_angle, thickness)

    # Checkmark tail starting from bottom-right of Q
    # The check starts at the bottom of the Q gap, dips down, then goes up-right
    q_bottom_x = cx + q_radius * math.cos(gap_angle)
    q_bottom_y = cy + q_radius * math.sin(gap_angle)

    # Checkmark: short down-left stroke, then long up-right stroke
    check_dip_x = q_bottom_x + size * 0.02
    check_dip_y = q_bottom_y + size * 0.12

    check_end_x = q_bottom_x + size * 0.22
    check_end_y = q_bottom_y - size * 0.08

    # Down stroke of checkmark
    draw_thick_line(pixels, size, q_bottom_x, q_bottom_y, check_dip_x, check_dip_y, thickness)
    # Up stroke of checkmark
    draw_thick_line(pixels, size, check_dip_x, check_dip_y, check_end_x, check_end_y, thickness)


def draw_q_small(pixels, size):
    """Draw a simplified Q with check for 16px icon."""
    cx = size * 0.45
    cy = size * 0.43
    q_radius = size * 0.22
    thickness = max(1, int(size * 0.09))

    # Full Q circle (nearly closed)
    gap_angle = math.radians(30)
    start_angle = gap_angle
    end_angle = math.radians(355)
    draw_arc(pixels, size, cx, cy, q_radius, start_angle, end_angle, thickness)

    # Simple checkmark tail
    q_bx = cx + q_radius * math.cos(gap_angle)
    q_by = cy + q_radius * math.sin(gap_angle)

    dip_x = q_bx + size * 0.03
    dip_y = q_by + size * 0.12

    end_x = q_bx + size * 0.20
    end_y = q_by - size * 0.06

    draw_thick_line(pixels, size, q_bx, q_by, dip_x, dip_y, thickness)
    draw_thick_line(pixels, size, dip_x, dip_y, end_x, end_y, thickness)


def main():
    icon_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icons')
    os.makedirs(icon_dir, exist_ok=True)

    for size in [16, 48, 128]:
        png_data = generate_icon(size)
        path = os.path.join(icon_dir, f'icon{size}.png')
        with open(path, 'wb') as f:
            f.write(png_data)
        print(f'Generated {path} ({len(png_data)} bytes)')


if __name__ == '__main__':
    main()
