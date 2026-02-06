#!/usr/bin/env python3
"""Generate Chrome Web Store promotional screenshots for QuizSolve.

Creates 3 screenshots at 1280x800 (required by Chrome Web Store):
1. Hero - Brand showcase with icon and tagline
2. How It Works - 3-step walkthrough
3. Features - Question types and capabilities
"""
from PIL import Image, ImageDraw, ImageFont
import os
import math

# ---- Colors matching quizsolve.vercel.app ----
BG = (10, 10, 15)
BG_CARD = (17, 17, 24)
BG_CARD_BORDER = (37, 37, 48)
TEAL = (45, 212, 191)
BLUE = (59, 130, 246)
WHITE = (232, 232, 236)
GRAY = (139, 143, 163)
MUTED = (92, 95, 112)
DARK_TEAL = (26, 154, 136)

W, H = 1280, 800


def gradient_color(t):
    """Interpolate blue→teal for t in [0,1]."""
    r = int(BLUE[0] + (TEAL[0] - BLUE[0]) * t)
    g = int(BLUE[1] + (TEAL[1] - BLUE[1]) * t)
    b = int(BLUE[2] + (TEAL[2] - BLUE[2]) * t)
    return (r, g, b)


def get_font(size):
    """Get best available font at given size."""
    paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
    ]
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def get_font_regular(size):
    """Get regular weight font."""
    paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    ]
    for p in paths:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def draw_rounded_rect(draw, xy, radius, fill=None, outline=None, width=1):
    """Draw a rounded rectangle."""
    x0, y0, x1, y1 = xy
    r = radius
    if fill:
        draw.rectangle([x0 + r, y0, x1 - r, y1], fill=fill)
        draw.rectangle([x0, y0 + r, x1, y1 - r], fill=fill)
        draw.pieslice([x0, y0, x0 + 2 * r, y0 + 2 * r], 180, 270, fill=fill)
        draw.pieslice([x1 - 2 * r, y0, x1, y0 + 2 * r], 270, 360, fill=fill)
        draw.pieslice([x0, y1 - 2 * r, x0 + 2 * r, y1], 90, 180, fill=fill)
        draw.pieslice([x1 - 2 * r, y1 - 2 * r, x1, y1], 0, 90, fill=fill)
    if outline:
        draw.arc([x0, y0, x0 + 2 * r, y0 + 2 * r], 180, 270, fill=outline, width=width)
        draw.arc([x1 - 2 * r, y0, x1, y0 + 2 * r], 270, 360, fill=outline, width=width)
        draw.arc([x0, y1 - 2 * r, x0 + 2 * r, y1], 90, 180, fill=outline, width=width)
        draw.arc([x1 - 2 * r, y1 - 2 * r, x1, y1], 0, 90, fill=outline, width=width)
        draw.line([x0 + r, y0, x1 - r, y0], fill=outline, width=width)
        draw.line([x0 + r, y1, x1 - r, y1], fill=outline, width=width)
        draw.line([x0, y0 + r, x0, y1 - r], fill=outline, width=width)
        draw.line([x1, y0 + r, x1, y1 - r], fill=outline, width=width)


def draw_gradient_text(img, position, text, font, color_start, color_end):
    """Draw text with horizontal gradient color."""
    x, y = position
    bbox = font.getbbox(text)
    tw = bbox[2] - bbox[0]
    # Render text in white first on a mask
    mask = Image.new('L', (tw + 20, bbox[3] - bbox[1] + 20), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.text((0, 0), text, fill=255, font=font)

    # Create gradient colored image
    gradient = Image.new('RGB', mask.size)
    for gx in range(mask.size[0]):
        t = gx / max(1, mask.size[0] - 1)
        c = (
            int(color_start[0] + (color_end[0] - color_start[0]) * t),
            int(color_start[1] + (color_end[1] - color_start[1]) * t),
            int(color_start[2] + (color_end[2] - color_start[2]) * t),
        )
        for gy in range(mask.size[1]):
            gradient.putpixel((gx, gy), c)

    # Paste with mask
    img.paste(gradient, (x, y), mask)


def draw_radial_glow(img, cx, cy, radius, color, intensity=0.15):
    """Draw a subtle radial glow."""
    draw = ImageDraw.Draw(img)
    for r in range(radius, 0, -2):
        alpha = int(255 * intensity * (1 - r / radius) ** 2)
        if alpha < 1:
            continue
        c = (
            min(255, int(BG[0] + color[0] * alpha / 255)),
            min(255, int(BG[1] + color[1] * alpha / 255)),
            min(255, int(BG[2] + color[2] * alpha / 255)),
        )
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)


def draw_icon(img, x, y, size):
    """Draw the QuizSolve Q+checkmark icon at position."""
    # Load the generated icon and resize
    icon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icons', 'icon128.png')
    if os.path.exists(icon_path):
        icon = Image.open(icon_path).convert('RGBA').resize((size, size), Image.LANCZOS)
        img.paste(icon, (x, y), icon)


def create_base_image():
    """Create base image with dark bg and subtle gradient glow."""
    img = Image.new('RGB', (W, H), BG)
    # Subtle teal glow in center-top
    draw_radial_glow(img, W // 2, 100, 500, TEAL, 0.08)
    # Subtle blue glow on left
    draw_radial_glow(img, 200, H // 2, 400, BLUE, 0.05)
    return img


def draw_bottom_bar(draw):
    """Draw subtle bottom attribution bar."""
    draw.line([(0, H - 50), (W, H - 50)], fill=BG_CARD_BORDER, width=1)
    font = get_font_regular(16)
    draw.text((W // 2, H - 30), "quizsolve.vercel.app", fill=MUTED, font=font, anchor="mm")


# ============================================================
# SCREENSHOT 1: Hero — Brand Showcase
# ============================================================
def generate_hero(output_dir):
    img = create_base_image()
    draw = ImageDraw.Draw(img)

    # Larger centered glow
    draw_radial_glow(img, W // 2, H // 2 - 50, 350, TEAL, 0.1)

    # Icon
    draw_icon(img, W // 2 - 60, 140, 120)

    # Title with gradient
    font_title = get_font(64)
    draw_gradient_text(img, (W // 2 - 220, 290), "QuizSolve", font_title, BLUE, TEAL)

    # Tagline
    font_tag = get_font_regular(28)
    draw.text((W // 2, 380), "Your exam. Your answers.", fill=WHITE, font=font_tag, anchor="mm")

    # Subtitle
    font_sub = get_font_regular(18)
    draw.text(
        (W // 2, 430),
        "Double-tap any question and the answer appears instantly — no tabs, no paste, no trace.",
        fill=GRAY, font=font_sub, anchor="mm"
    )

    # Feature pills
    pills = ["Auto-Answer", "MCQ & Essays", "Image Support", "Stealth Mode", "All Platforms"]
    pill_font = get_font(16)
    total_w = len(pills) * 160 + (len(pills) - 1) * 16
    start_x = (W - total_w) // 2
    py = 500

    for i, pill in enumerate(pills):
        px = start_x + i * 176
        t = i / max(1, len(pills) - 1)
        pill_color = gradient_color(t)
        border_color = (*pill_color, 80)
        fill_color = (pill_color[0] // 8, pill_color[1] // 8, pill_color[2] // 8)
        draw_rounded_rect(draw, [px, py, px + 156, py + 40], 20, fill=fill_color, outline=pill_color, width=1)
        draw.text((px + 78, py + 20), pill, fill=pill_color, font=pill_font, anchor="mm")

    # Stats row
    stats_font = get_font(36)
    stats_label_font = get_font_regular(14)
    stats = [("Ctrl+Shift+U", "Activate"), ("2 Clicks", "To Answer"), ("0", "Traces Left")]
    stat_y = 600
    for i, (value, label) in enumerate(stats):
        sx = W // 2 - 300 + i * 300
        draw.text((sx, stat_y), value, fill=TEAL, font=stats_font, anchor="mm")
        draw.text((sx, stat_y + 30), label, fill=MUTED, font=stats_label_font, anchor="mm")

    draw_bottom_bar(draw)

    img.save(os.path.join(output_dir, 'screenshot_1_hero.png'), 'PNG')
    print(f"Generated screenshot_1_hero.png")


# ============================================================
# SCREENSHOT 2: How It Works — 3-Step Walkthrough
# ============================================================
def generate_how_it_works(output_dir):
    img = create_base_image()
    draw = ImageDraw.Draw(img)

    # Title
    font_title = get_font(44)
    draw_gradient_text(img, (W // 2 - 180, 60), "How It Works", font_title, BLUE, TEAL)

    font_sub = get_font_regular(20)
    draw.text((W // 2, 125), "Get answers in seconds — completely invisible", fill=GRAY, font=font_sub, anchor="mm")

    # 3 Step cards
    steps = [
        ("1", "Activate", "Press Ctrl+Shift+U\nor click the extension icon\nto enable QuizSolve", BLUE),
        ("2", "Double-Click", "Double-click on any\nquestion on any website\nto trigger the AI", gradient_color(0.5)),
        ("3", "Get Answer", "Answer is auto-selected,\nhighlighted, or copied\nto your clipboard", TEAL),
    ]

    card_w = 340
    card_h = 380
    gap = 40
    total = len(steps) * card_w + (len(steps) - 1) * gap
    start_x = (W - total) // 2
    card_y = 180

    font_num = get_font(72)
    font_step_title = get_font(26)
    font_step_desc = get_font_regular(17)

    for i, (num, title, desc, color) in enumerate(steps):
        cx = start_x + i * (card_w + gap)

        # Card background
        draw_rounded_rect(draw, [cx, card_y, cx + card_w, card_y + card_h], 16,
                          fill=BG_CARD, outline=BG_CARD_BORDER, width=1)

        # Subtle glow at top of card
        draw_radial_glow(img, cx + card_w // 2, card_y + 60, 100, color, 0.08)

        # Step number (large, colored)
        draw.text((cx + card_w // 2, card_y + 70), num, fill=color, font=font_num, anchor="mm")

        # Step title
        draw.text((cx + card_w // 2, card_y + 140), title, fill=WHITE, font=font_step_title, anchor="mm")

        # Divider line
        div_w = 60
        draw.line([(cx + card_w // 2 - div_w // 2, card_y + 170),
                    (cx + card_w // 2 + div_w // 2, card_y + 170)], fill=color, width=2)

        # Description (multi-line)
        lines = desc.split('\n')
        for j, line in enumerate(lines):
            draw.text((cx + card_w // 2, card_y + 210 + j * 28), line,
                       fill=GRAY, font=font_step_desc, anchor="mm")

    # Connecting arrows between cards
    arrow_y = card_y + card_h // 2
    for i in range(len(steps) - 1):
        ax = start_x + (i + 1) * (card_w + gap) - gap // 2
        # Arrow line
        draw.line([(ax - 12, arrow_y), (ax + 12, arrow_y)], fill=MUTED, width=2)
        # Arrow head
        draw.polygon([(ax + 12, arrow_y), (ax + 6, arrow_y - 5), (ax + 6, arrow_y + 5)], fill=MUTED)

    # Bottom note
    font_note = get_font_regular(16)
    draw.text((W // 2, 620),
              "Works on Canvas, Blackboard, Google Forms, Quizlet, Moodle, and 100+ platforms",
              fill=MUTED, font=font_note, anchor="mm")

    # Stealth badge
    badge_y = 670
    draw_rounded_rect(draw, [W // 2 - 140, badge_y, W // 2 + 140, badge_y + 36], 18,
                      fill=(TEAL[0] // 10, TEAL[1] // 10, TEAL[2] // 10), outline=DARK_TEAL, width=1)
    badge_font = get_font(14)
    draw.text((W // 2, badge_y + 18), "Undetectable  —  No Branding  —  Stealth",
              fill=TEAL, font=badge_font, anchor="mm")

    draw_bottom_bar(draw)
    img.save(os.path.join(output_dir, 'screenshot_2_how_it_works.png'), 'PNG')
    print(f"Generated screenshot_2_how_it_works.png")


# ============================================================
# SCREENSHOT 3: Features — Question Types & Capabilities
# ============================================================
def generate_features(output_dir):
    img = create_base_image()
    draw = ImageDraw.Draw(img)

    # Title
    font_title = get_font(44)
    draw_gradient_text(img, (W // 2 - 230, 50), "Powerful Features", font_title, BLUE, TEAL)

    font_sub = get_font_regular(20)
    draw.text((W // 2, 115), "Everything you need to ace any online quiz", fill=GRAY, font=font_sub, anchor="mm")

    # Left column: Question Types
    col1_x = 80
    col1_y = 170

    font_section = get_font(22)
    draw.text((col1_x + 10, col1_y), "Supported Question Types", fill=TEAL, font=font_section)

    types = [
        ("Multiple Choice (MCQ)", "Auto-detects and selects the correct option"),
        ("Multiple Select", "Handles multi-answer questions"),
        ("True / False", "Instant binary classification"),
        ("Fill in the Blank", "Types the answer directly"),
        ("Short Answer & Essay", "AI-generated contextual responses"),
        ("Matching", "Auto-matches paired items"),
        ("Image-Based Questions", "Analyzes diagrams, charts, screenshots"),
        ("Numerical / Calculation", "Step-by-step math verification"),
    ]

    font_type = get_font(16)
    font_type_desc = get_font_regular(13)

    for i, (name, desc) in enumerate(types):
        ty = col1_y + 50 + i * 58
        # Dot
        t = i / max(1, len(types) - 1)
        dot_color = gradient_color(t)
        draw.ellipse([col1_x + 14, ty + 4, col1_x + 24, ty + 14], fill=dot_color)
        draw.text((col1_x + 36, ty), name, fill=WHITE, font=font_type)
        draw.text((col1_x + 36, ty + 22), desc, fill=MUTED, font=font_type_desc)

    # Right column: Key Features
    col2_x = 680
    col2_y = 170

    draw.text((col2_x + 10, col2_y), "Key Capabilities", fill=TEAL, font=font_section)

    # Vertical divider
    draw.line([(col2_x - 30, col2_y), (col2_x - 30, H - 100)], fill=BG_CARD_BORDER, width=1)

    features = [
        ("Dual API Mode", "Use our free QuizSolve API\nor bring your own key (OpenAI, Gemini, Anthropic)"),
        ("Smart Model Switching", "Auto-upgrades to a powerful model\nwhen images are detected in questions"),
        ("Accuracy Enhancement", "Detects negative, EXCEPT, and numerical\nquestions for specialized AI prompts"),
        ("Vision / Multimodal", "Sends images, diagrams, and charts\nto AI for accurate visual analysis"),
        ("Stealth Architecture", "No visible UI, no branding overlays\ndefault double-click behavior preserved"),
        ("Universal Compatibility", "Works on Canvas, Blackboard, Moodle,\nGoogle Forms, Quizlet, and 100+ sites"),
    ]

    font_feat = get_font(16)
    font_feat_desc = get_font_regular(13)

    for i, (name, desc) in enumerate(features):
        fy = col2_y + 50 + i * 82
        t = i / max(1, len(features) - 1)
        feat_color = gradient_color(t)

        # Feature icon placeholder (small rounded rect)
        draw_rounded_rect(draw, [col2_x + 10, fy, col2_x + 36, fy + 26], 6,
                          fill=(feat_color[0] // 6, feat_color[1] // 6, feat_color[2] // 6),
                          outline=feat_color, width=1)
        # Checkmark inside
        draw.text((col2_x + 23, fy + 13), "✓", fill=feat_color, font=get_font(14), anchor="mm")

        draw.text((col2_x + 48, fy), name, fill=WHITE, font=font_feat)
        lines = desc.split('\n')
        for j, line in enumerate(lines):
            draw.text((col2_x + 48, fy + 22 + j * 18), line, fill=MUTED, font=font_feat_desc)

    draw_bottom_bar(draw)
    img.save(os.path.join(output_dir, 'screenshot_3_features.png'), 'PNG')
    print(f"Generated screenshot_3_features.png")


def main():
    output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'store_assets')
    os.makedirs(output_dir, exist_ok=True)

    generate_hero(output_dir)
    generate_how_it_works(output_dir)
    generate_features(output_dir)

    print(f"\nAll screenshots saved to {output_dir}/")
    print("Upload these to Chrome Web Store under 'Screenshots'")
    print("Required size: 1280x800 — all images match this spec.")


if __name__ == '__main__':
    main()
