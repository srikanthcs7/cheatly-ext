#!/usr/bin/env python3
"""Generate simple PNG icons for QuizSolve extension."""
import struct
import zlib
import os

def create_png(width, height, pixels):
    """Create a PNG file from pixel data. pixels is a list of (r,g,b,a) tuples."""
    def chunk(chunk_type, data):
        c = chunk_type + data
        crc = zlib.crc32(c) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + c + struct.pack('>I', crc)

    # IHDR
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)  # 8-bit RGBA

    # IDAT
    raw_data = b''
    for y in range(height):
        raw_data += b'\x00'  # filter: none
        for x in range(width):
            idx = y * width + x
            r, g, b, a = pixels[idx]
            raw_data += bytes([r, g, b, a])

    idat_data = zlib.compress(raw_data, 9)

    # Assemble PNG
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', ihdr_data)
    png += chunk(b'IDAT', idat_data)
    png += chunk(b'IEND', b'')

    return png


def generate_icon(size):
    """Generate a gradient icon with 'AM' feel - purple/indigo gradient circle."""
    pixels = []
    center = size / 2
    radius = size / 2 - 1

    for y in range(size):
        for x in range(size):
            # Distance from center
            dx = x - center + 0.5
            dy = y - center + 0.5
            dist = (dx * dx + dy * dy) ** 0.5

            if dist <= radius:
                # Gradient from top-left to bottom-right
                t = (x + y) / (2 * size)
                # Purple (#6c5ce7) to lighter purple (#a29bfe)
                r = int(108 + (162 - 108) * t)
                g = int(92 + (155 - 92) * t)
                b = int(231 + (254 - 231) * t)

                # Anti-aliasing at edges
                if dist > radius - 1.5:
                    alpha = max(0, min(255, int(255 * (radius - dist + 0.75) / 1.5)))
                else:
                    alpha = 255

                pixels.append((r, g, b, alpha))
            else:
                pixels.append((0, 0, 0, 0))

    # Draw a simple "A" letter in white
    if size >= 32:
        draw_letter_a(pixels, size)
    elif size >= 16:
        draw_small_letter(pixels, size)

    return create_png(size, size, pixels)


def set_pixel(pixels, size, x, y, r, g, b, a):
    """Set a pixel if within bounds."""
    if 0 <= x < size and 0 <= y < size:
        idx = y * size + x
        # Only draw on non-transparent pixels (inside the circle)
        if pixels[idx][3] > 0:
            pixels[idx] = (r, g, b, a)


def draw_thick_line(pixels, size, x0, y0, x1, y1, thickness=1):
    """Draw a thick white line using Bresenham's."""
    dx = abs(x1 - x0)
    dy = abs(y1 - y0)
    sx = 1 if x0 < x1 else -1
    sy = 1 if y0 < y1 else -1
    err = dx - dy

    while True:
        for tx in range(-thickness, thickness + 1):
            for ty in range(-thickness, thickness + 1):
                if tx * tx + ty * ty <= thickness * thickness + 1:
                    set_pixel(pixels, size, x0 + tx, y0 + ty, 255, 255, 255, 240)

        if x0 == x1 and y0 == y1:
            break
        e2 = 2 * err
        if e2 > -dy:
            err -= dy
            x0 += sx
        if e2 < dx:
            err += dx
            y0 += sy


def draw_letter_a(pixels, size):
    """Draw a stylized 'A' letter on the icon."""
    # Scale factors
    cx = size // 2
    top = size // 4
    bottom = size * 3 // 4
    left = size // 4
    right = size * 3 // 4
    mid_y = (top + bottom) // 2 + 1
    t = max(1, size // 24)

    # Left leg of A
    draw_thick_line(pixels, size, cx, top, left, bottom, t)
    # Right leg of A
    draw_thick_line(pixels, size, cx, top, right, bottom, t)
    # Crossbar
    cross_left = left + (cx - left) * (mid_y - top) // (bottom - top)
    cross_right = right - (right - cx) * (mid_y - top) // (bottom - top)
    draw_thick_line(pixels, size, cross_left, mid_y, cross_right, mid_y, t)


def draw_small_letter(pixels, size):
    """Draw a smaller letter for 16px icon."""
    cx = size // 2
    top = size // 3
    bottom = size * 2 // 3 + 1

    # Simple A shape
    for y in range(top, bottom + 1):
        progress = (y - top) / max(1, (bottom - top))
        spread = int(progress * size // 4)

        # Left and right legs
        set_pixel(pixels, size, cx - spread, y, 255, 255, 255, 240)
        set_pixel(pixels, size, cx + spread, y, 255, 255, 255, 240)

        # Crossbar at middle
        if abs(y - (top + bottom) // 2) <= 0:
            for x in range(cx - spread, cx + spread + 1):
                set_pixel(pixels, size, x, y, 255, 255, 255, 240)


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
