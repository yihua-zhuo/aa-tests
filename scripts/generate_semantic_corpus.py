#!/usr/bin/env python3
"""Generate a deterministic synthetic OCR pack for semantic/region features.

The pack is a standalone corpus directory: top-level PNG files plus its own
ground_truth.json. It covers formula-like blocks, vertical text, red stamps,
signature strokes, jittered handwriting, and a labelled bar chart.

Only numpy is required. The PNG writer and the 5x7 bitmap font are adapted from
scripts/generate_ocr_corpus.py, which is intentionally left untouched.

Usage:
  PYTHONDONTWRITEBYTECODE=1 python3 scripts/generate_semantic_corpus.py \
      [--dir benchmarks/corpus-v2/semantic-regions] [--check]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import struct
import zlib
from pathlib import Path

import numpy as np

SCALE = 4
PAPER = (246, 246, 243)
INK = (28, 30, 34)
RED = (183, 32, 46)
BLUE = (34, 63, 142)
GRID = (211, 211, 207)
ANNOTATED_AT = "2026-10-31T00:00:00Z"
GENERATOR = "scripts/generate_semantic_corpus.py"
GLYPH_ADVANCE = 6
SUPPORTED = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".pdf"}

FONT = {
    "A": ("01110", "10001", "10001", "11111", "10001", "10001", "10001"),
    "B": ("11110", "10001", "10001", "11110", "10001", "10001", "11110"),
    "C": ("01111", "10000", "10000", "10000", "10000", "10000", "01111"),
    "D": ("11110", "10001", "10001", "10001", "10001", "10001", "11110"),
    "E": ("11111", "10000", "10000", "11110", "10000", "10000", "11111"),
    "F": ("11111", "10000", "10000", "11110", "10000", "10000", "10000"),
    "G": ("01111", "10000", "10000", "10111", "10001", "10001", "01111"),
    "H": ("10001", "10001", "10001", "11111", "10001", "10001", "10001"),
    "I": ("11111", "00100", "00100", "00100", "00100", "00100", "11111"),
    "J": ("00111", "00010", "00010", "00010", "10010", "10010", "01100"),
    "K": ("10001", "10010", "10100", "11000", "10100", "10010", "10001"),
    "L": ("10000", "10000", "10000", "10000", "10000", "10000", "11111"),
    "M": ("10001", "11011", "10101", "10101", "10001", "10001", "10001"),
    "N": ("10001", "11001", "10101", "10011", "10001", "10001", "10001"),
    "O": ("01110", "10001", "10001", "10001", "10001", "10001", "01110"),
    "P": ("11110", "10001", "10001", "11110", "10000", "10000", "10000"),
    "Q": ("01110", "10001", "10001", "10001", "10101", "10010", "01101"),
    "R": ("11110", "10001", "10001", "11110", "10100", "10010", "10001"),
    "S": ("01111", "10000", "10000", "01110", "00001", "00001", "11110"),
    "T": ("11111", "00100", "00100", "00100", "00100", "00100", "00100"),
    "U": ("10001", "10001", "10001", "10001", "10001", "10001", "01110"),
    "V": ("10001", "10001", "10001", "10001", "10001", "01010", "00100"),
    "W": ("10001", "10001", "10001", "10101", "10101", "10101", "01010"),
    "X": ("10001", "01010", "00100", "00100", "00100", "01010", "10001"),
    "Y": ("10001", "01010", "00100", "00100", "00100", "00100", "00100"),
    "Z": ("11111", "00001", "00010", "00100", "01000", "10000", "11111"),
    "0": ("01110", "10001", "10011", "10101", "11001", "10001", "01110"),
    "1": ("00100", "01100", "00100", "00100", "00100", "00100", "01110"),
    "2": ("01110", "10001", "00001", "00010", "00100", "01000", "11111"),
    "3": ("11111", "00010", "00100", "00010", "00001", "10001", "01110"),
    "4": ("00010", "00110", "01010", "10010", "11111", "00010", "00010"),
    "5": ("11111", "10000", "11110", "00001", "00001", "10001", "01110"),
    "6": ("00110", "01000", "10000", "11110", "10001", "10001", "01110"),
    "7": ("11111", "00001", "00010", "00100", "01000", "01000", "01000"),
    "8": ("01110", "10001", "10001", "01110", "10001", "10001", "01110"),
    "9": ("01110", "10001", "10001", "01111", "00001", "00010", "01100"),
    " ": ("00000", "00000", "00000", "00000", "00000", "00000", "00000"),
    ".": ("00000", "00000", "00000", "00000", "00000", "01100", "01100"),
    ",": ("00000", "00000", "00000", "00000", "01100", "01100", "00100"),
    ":": ("00000", "01100", "01100", "00000", "01100", "01100", "00000"),
    "/": ("00001", "00010", "00010", "00100", "01000", "01000", "10000"),
    "-": ("00000", "00000", "00000", "11111", "00000", "00000", "00000"),
    "#": ("01010", "01010", "11111", "01010", "11111", "01010", "01010"),
    "%": ("11001", "11010", "00010", "00100", "01000", "01011", "10011"),
    "(": ("00010", "00100", "01000", "01000", "01000", "00100", "00010"),
    ")": ("01000", "00100", "00010", "00010", "00010", "00100", "01000"),
    "$": ("00100", "01111", "10100", "01110", "00101", "11110", "00100"),
    "?": ("01110", "10001", "00001", "00010", "00100", "00000", "00100"),
    "+": ("00000", "00100", "00100", "11111", "00100", "00100", "00000"),
    "=": ("00000", "00000", "11111", "00000", "11111", "00000", "00000"),
    "*": ("00000", "10101", "01110", "11111", "01110", "10101", "00000"),
    "&": ("01100", "10010", "10100", "01000", "10101", "10010", "01101"),
    "_": ("00000", "00000", "00000", "00000", "00000", "00000", "11111"),
    "!": ("00100", "00100", "00100", "00100", "00100", "00000", "00100"),
}


def blank(width: int, height: int, color: tuple[int, int, int] = PAPER) -> np.ndarray:
    image = np.empty((height, width, 3), dtype=np.uint8)
    image[:, :] = color
    return image


def text_width(text: str, scale: int = SCALE) -> int:
    return len(text) * GLYPH_ADVANCE * scale


def draw_char(
    image: np.ndarray,
    x: int,
    y: int,
    char: str,
    scale: int,
    color: tuple[int, int, int],
) -> None:
    glyph = FONT.get(char.upper(), FONT["?"])
    height, width = image.shape[:2]
    for row, bits in enumerate(glyph):
        for column, bit in enumerate(bits):
            if bit != "1":
                continue
            top = y + row * scale
            left = x + column * scale
            bottom = min(height, top + scale)
            right = min(width, left + scale)
            if top < height and left < width and bottom > top and right > left:
                image[top:bottom, left:right] = color


def draw_text(
    image: np.ndarray,
    x: int,
    y: int,
    text: str,
    scale: int = SCALE,
    color: tuple[int, int, int] = INK,
) -> int:
    cursor = x
    for char in text:
        draw_char(image, cursor, y, char, scale, color)
        cursor += GLYPH_ADVANCE * scale
    return cursor


def draw_paragraph(
    image: np.ndarray,
    x: int,
    y: int,
    width: int,
    text: str,
    scale: int = SCALE,
    color: tuple[int, int, int] = INK,
    line_height: int | None = None,
) -> int:
    if line_height is None:
        line_height = 9 * scale
    words = text.split()
    line = ""
    for word in words:
        candidate = word if not line else f"{line} {word}"
        if text_width(candidate, scale) > width and line:
            draw_text(image, x, y, line, scale, color)
            y += line_height
            line = word
        else:
            line = candidate
    if line:
        draw_text(image, x, y, line, scale, color)
        y += line_height
    return y


def fill_rect(
    image: np.ndarray,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    color: tuple[int, int, int],
) -> None:
    height, width = image.shape[:2]
    left = max(0, min(x1, x2))
    top = max(0, min(y1, y2))
    right = min(width, max(x1, x2) + 1)
    bottom = min(height, max(y1, y2) + 1)
    if right > left and bottom > top:
        image[top:bottom, left:right] = color


def draw_line(
    image: np.ndarray,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    color: tuple[int, int, int] = INK,
    thickness: int = 1,
) -> None:
    steps = max(abs(x2 - x1), abs(y2 - y1), 1)
    radius = max(0, thickness // 2)
    for step in range(steps + 1):
        ratio = step / steps
        x = round(x1 + (x2 - x1) * ratio)
        y = round(y1 + (y2 - y1) * ratio)
        fill_rect(image, x - radius, y - radius, x + radius, y + radius, color)


def draw_rect_outline(
    image: np.ndarray,
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    color: tuple[int, int, int],
    thickness: int = 2,
) -> None:
    for offset in range(thickness):
        draw_line(image, x1 + offset, y1 + offset, x2 - offset, y1 + offset, color)
        draw_line(image, x1 + offset, y2 - offset, x2 - offset, y2 - offset, color)
        draw_line(image, x1 + offset, y1 + offset, x1 + offset, y2 - offset, color)
        draw_line(image, x2 - offset, y1 + offset, x2 - offset, y2 - offset, color)


def draw_ellipse_outline(
    image: np.ndarray,
    cx: float,
    cy: float,
    rx: float,
    ry: float,
    color: tuple[int, int, int],
    thickness: int = 2,
) -> None:
    height, width = image.shape[:2]
    x0 = max(0, int(cx - rx - thickness - 1))
    x1 = min(width, int(cx + rx + thickness + 2))
    y0 = max(0, int(cy - ry - thickness - 1))
    y1 = min(height, int(cy + ry + thickness + 2))
    if x1 <= x0 or y1 <= y0:
        return
    ys, xs = np.mgrid[y0:y1, x0:x1]
    outer = ((xs - cx) / max(rx, 1.0)) ** 2 + ((ys - cy) / max(ry, 1.0)) ** 2 <= 1.0
    inner_rx = max(rx - thickness, 0.1)
    inner_ry = max(ry - thickness, 0.1)
    inner = ((xs - cx) / inner_rx) ** 2 + ((ys - cy) / inner_ry) ** 2 > 1.0
    mask = outer & inner
    image[ys[mask], xs[mask]] = color


def rotate_rgb(image: np.ndarray, degrees: float) -> np.ndarray:
    if degrees == 0:
        return image
    radians = math.radians(degrees)
    cosine = math.cos(radians)
    sine = math.sin(radians)
    height, width = image.shape[:2]
    center_x = (width - 1) / 2
    center_y = (height - 1) / 2
    ys, xs = np.mgrid[0:height, 0:width]
    source_x = (xs - center_x) * cosine + (ys - center_y) * sine + center_x
    source_y = -(xs - center_x) * sine + (ys - center_y) * cosine + center_y
    source_x = np.clip(np.rint(source_x).astype(np.int32), 0, width - 1)
    source_y = np.clip(np.rint(source_y).astype(np.int32), 0, height - 1)
    return image[source_y, source_x]


def paste(image: np.ndarray, patch: np.ndarray, x: int, y: int) -> None:
    height, width = image.shape[:2]
    patch_height, patch_width = patch.shape[:2]
    x0 = max(0, x)
    y0 = max(0, y)
    x1 = min(width, x + patch_width)
    y1 = min(height, y + patch_height)
    if x1 > x0 and y1 > y0:
        image[y0:y1, x0:x1] = patch[y0 - y:y1 - y, x0 - x:x1 - x]


def draw_glyph_rotated(
    image: np.ndarray,
    cx: float,
    cy: float,
    char: str,
    scale: int,
    angle_degrees: float,
    color: tuple[int, int, int],
) -> None:
    glyph = FONT.get(char.upper(), FONT["?"])
    glyph_width = 5 * scale
    glyph_height = 7 * scale
    radians = math.radians(angle_degrees)
    cosine = math.cos(radians)
    sine = math.sin(radians)
    extent = int(math.ceil(0.5 * math.hypot(glyph_width, glyph_height))) + 2
    height, width = image.shape[:2]
    left = int(round(cx))
    top = int(round(cy))
    for dy in range(-extent, extent + 1):
        for dx in range(-extent, extent + 1):
            source_x = dx * cosine + dy * sine + glyph_width / 2
            source_y = -dx * sine + dy * cosine + glyph_height / 2
            column = int(source_x // scale)
            row = int(source_y // scale)
            if 0 <= row < 7 and 0 <= column < 5 and glyph[row][column] == "1":
                px = left + dx
                py = top + dy
                if 0 <= py < height and 0 <= px < width:
                    image[py, px] = color


def draw_hand_text(
    image: np.ndarray,
    x: int,
    y: int,
    text: str,
    scale: int,
    color: tuple[int, int, int],
    seed: int,
) -> int:
    """Draw uppercase text with deterministic per-glyph offset and rotation."""
    rng = np.random.default_rng(seed)
    cursor = float(x)
    advance = 7 * scale
    glyph_width = 5 * scale
    glyph_height = 7 * scale
    for char in text:
        if char == " ":
            cursor += advance
            continue
        jitter_x = int(rng.integers(-scale // 2, scale // 2 + 1))
        jitter_y = int(rng.integers(-scale // 2, scale // 2 + 1))
        drift = int(round(math.sin(cursor / 95.0) * scale * 0.7))
        angle = float(rng.uniform(-6.5, 6.5))
        draw_glyph_rotated(
            image,
            cursor + jitter_x + glyph_width / 2,
            y + jitter_y + drift + glyph_height / 2,
            char,
            scale,
            angle,
            color,
        )
        cursor += advance
    return int(round(cursor))


def draw_signature(
    image: np.ndarray,
    x: int,
    y: int,
    width: int,
    height: int,
    seed: int,
    color: tuple[int, int, int] = BLUE,
) -> None:
    """Draw smooth hand-drawn loops; deliberately no readable characters."""
    rng = np.random.default_rng(seed)
    samples = 420
    t = np.linspace(0.0, 1.0, samples)
    xs = x + width * t + 20.0 * np.sin(6.0 * math.pi * t) + 9.0 * np.sin(
        14.0 * math.pi * t + 0.8
    )
    ys = (
        y
        + height * 0.62
        - height * 0.24 * np.sin(2.0 * math.pi * t)
        - height * 0.17 * np.sin(5.0 * math.pi * t + 0.4)
        + 7.0 * np.sin(31.0 * math.pi * t)
    )
    xs = xs + rng.normal(0.0, 1.1, samples)
    ys = ys + rng.normal(0.0, 1.1, samples)
    for index in range(samples - 1):
        draw_line(
            image,
            round(float(xs[index])),
            round(float(ys[index])),
            round(float(xs[index + 1])),
            round(float(ys[index + 1])),
            color,
            thickness=3,
        )
    draw_line(
        image,
        x + int(width * 0.05),
        y + int(height * 0.86),
        x + int(width * 0.92),
        y + int(height * 0.78),
        color,
        thickness=2,
    )
    draw_line(
        image,
        x + int(width * 0.10),
        y + int(height * 0.16),
        x + int(width * 0.20),
        y + int(height * 0.76),
        color,
        thickness=2,
    )


def draw_stamp(
    image: np.ndarray,
    cx: int,
    cy: int,
    word: str,
    scale: int = 5,
    angle: float = 0.0,
    color: tuple[int, int, int] = RED,
) -> None:
    """Red word inside a double border and a decorative ellipse."""
    text_w = text_width(word, scale)
    rect_w = text_w + 100
    rect_h = 190
    patch = blank(rect_w + 40, rect_h + 40)
    patch_cx = patch.shape[1] // 2
    patch_cy = patch.shape[0] // 2
    draw_ellipse_outline(
        patch,
        patch_cx,
        patch_cy,
        rect_w / 2 - 30,
        rect_h / 2 - 28,
        color,
        thickness=3,
    )
    draw_rect_outline(
        patch,
        patch_cx - rect_w // 2,
        patch_cy - rect_h // 2,
        patch_cx + rect_w // 2,
        patch_cy + rect_h // 2,
        color,
        thickness=4,
    )
    draw_rect_outline(
        patch,
        patch_cx - rect_w // 2 + 12,
        patch_cy - rect_h // 2 + 12,
        patch_cx + rect_w // 2 - 12,
        patch_cy + rect_h // 2 - 12,
        color,
        thickness=2,
    )
    draw_text(
        patch,
        patch_cx - text_w // 2,
        patch_cy - (7 * scale) // 2,
        word,
        scale,
        color,
    )
    patch = rotate_rgb(patch, angle)
    paste(image, patch, cx - patch.shape[1] // 2, cy - patch.shape[0] // 2)


def rotated_text(text: str, scale: int, color: tuple[int, int, int] = INK) -> np.ndarray:
    width = text_width(text, scale) + 2 * scale
    height = 9 * scale
    block = blank(width, height)
    draw_text(block, scale, scale, text, scale, color)
    return np.rot90(block, k=-1)


def formula_block() -> tuple[np.ndarray, dict]:
    image = blank(1200, 1400)
    heading = "FORMULA SUMMARY"
    intro = "THE FOLLOWING EXPRESSIONS WERE EXTRACTED FROM THE RATE MODEL."
    label = "EXPRESSION BLOCK"
    formulas = ["TOTAL=A+B", "RATE=0.185", "X=Y*Z"]
    outro = "FORMULAS ARE EVALUATED AT RUNTIME. RESULTS ARE NOT STORED IN THE LEDGER."
    draw_text(image, 90, 80, heading, 5)
    draw_paragraph(image, 90, 160, 1000, intro, 4)
    draw_line(image, 90, 250, 1110, 250, INK, 2)
    draw_rect_outline(image, 150, 290, 1050, 700, (150, 150, 146), 2)
    draw_text(image, 180, 320, label, 3, (90, 90, 88))
    for index, formula in enumerate(formulas):
        draw_text(image, 250, 400 + index * 95, formula, 6)
    draw_line(image, 90, 760, 1110, 760, INK, 2)
    draw_paragraph(image, 90, 820, 1000, outro, 4)
    truth = {
        "kind": "image",
        "lang": "en",
        "difficulty": "moderate",
        "degradations": ["formula"],
        "text": " ".join([heading, intro, label, *formulas, outro]),
        "keywords": [heading, label, *formulas],
        "fields": {
            "report": heading,
            "total_formula": formulas[0],
            "rate_formula": formulas[1],
            "product_formula": formulas[2],
        },
        "conditions": {"region": "formula"},
    }
    return image, truth


def vertical_text() -> tuple[np.ndarray, dict]:
    image = blank(1200, 1600)
    heading = "SIDEWAYS SECTION"
    intro = "THE FOLLOWING LABEL IS ROTATED NINETY DEGREES CLOCKWISE."
    label = "REGION EAST REPORT 2026"
    draw_text(image, 100, 100, heading, 5)
    draw_paragraph(image, 100, 180, 1000, intro, 4)
    block = rotated_text(label, 5)
    paste(image, block, 830, 330)
    draw_line(image, 100, 320, 720, 320, GRID, 2)
    truth = {
        "kind": "image",
        "lang": "en",
        "difficulty": "moderate",
        "degradations": ["vertical_text"],
        "text": " ".join([heading, intro, label]),
        "keywords": [heading, label, "ROTATED NINETY DEGREES"],
        "fields": {"label": label, "orientation": "90"},
        "conditions": {"region": "vertical_label"},
    }
    return image, truth


def red_stamp() -> tuple[np.ndarray, dict]:
    image = blank(1200, 1200)
    heading = "DOCUMENT STATUS"
    body = "THE FOLLOWING DOCUMENT HAS BEEN REVIEWED AND RECORDED."
    reference = "REFERENCE: DOC-2026-118"
    stamp = "PAID"
    footer = "KEEP THIS COPY WITH THE ORIGINAL FILING."
    draw_text(image, 90, 90, heading, 5)
    draw_paragraph(image, 90, 170, 1000, body, 4)
    draw_text(image, 90, 250, reference, 4)
    draw_stamp(image, 700, 560, stamp, 6, angle=-6.0)
    draw_paragraph(image, 90, 850, 1000, footer, 4)
    truth = {
        "kind": "image",
        "lang": "en",
        "difficulty": "moderate",
        "degradations": ["stamp"],
        "text": " ".join([heading, body, reference, stamp, footer]),
        "keywords": [heading, reference, stamp],
        "fields": {"status": stamp, "reference": "DOC-2026-118"},
        "conditions": {"region": "red_stamp"},
    }
    return image, truth


def signature_block() -> tuple[np.ndarray, dict]:
    image = blank(1200, 1200)
    heading = "AUTHORIZATION FORM"
    body = "REQUEST REVIEWED BY OPERATIONS."
    label = "SIGNATURE"
    name = "AUTHORIZED BY OPERATIONS LEAD"
    date = "DATE: 2026-10-31"
    draw_text(image, 90, 90, heading, 5)
    draw_text(image, 90, 170, body, 4)
    draw_text(image, 90, 320, label, 4)
    draw_signature(image, 90, 390, 620, 210, seed=111)
    draw_line(image, 90, 620, 760, 620, GRID, 2)
    draw_text(image, 90, 680, name, 4)
    draw_text(image, 90, 750, date, 4)
    truth = {
        "kind": "image",
        "lang": "en",
        "difficulty": "moderate",
        "degradations": ["signature"],
        "text": " ".join([heading, body, label, name, date]),
        "keywords": [heading, label, "OPERATIONS LEAD"],
        "fields": {"signatory": "OPERATIONS LEAD", "date": "2026-10-31"},
        "conditions": {"region": "signature_line"},
    }
    return image, truth


def handwriting_note() -> tuple[np.ndarray, dict]:
    image = blank(1300, 1050)
    heading = "HANDWRITTEN NOTE"
    line_one = "MEETING MOVED TO ROOM 4B AT 3 PM"
    line_two = "BRING THE DRAFT REPORT"
    footer = "FROM: OPERATIONS"
    draw_text(image, 90, 90, heading, 5)
    draw_line(image, 90, 180, 760, 180, INK, 2)
    draw_hand_text(image, 90, 300, line_one, 4, BLUE, seed=202)
    draw_hand_text(image, 90, 460, line_two, 4, BLUE, seed=303)
    draw_text(image, 90, 760, footer, 4)
    truth = {
        "kind": "image",
        "lang": "en",
        "difficulty": "severe",
        "degradations": ["handwriting"],
        "text": " ".join([heading, line_one, line_two, footer]),
        "keywords": [heading, "MEETING MOVED", "ROOM 4B", "DRAFT REPORT"],
        "fields": {
            "note": line_one,
            "followup": line_two,
            "from": "OPERATIONS",
        },
        "conditions": {"region": "handwriting"},
    }
    return image, truth


def bar_chart() -> tuple[np.ndarray, dict]:
    image = blank(1300, 1100)
    title = "QUARTERLY REVENUE BY REGION"
    subtitle = "FY 2026 Q3"
    ylabel = "REVENUE K CNY"
    xlabel = "REGION"
    ticks = ["800", "600", "400", "200", "0"]
    categories = ["EAST", "SOUTH", "NORTH", "WEST"]
    values = [640, 384, 256, 190]
    draw_text(image, 90, 70, title, 5)
    draw_text(image, 90, 145, subtitle, 4)
    draw_text(image, 60, 205, ylabel, 3)
    plot_left = 250
    plot_right = 1180
    plot_top = 260
    plot_bottom = 900
    for index, tick in enumerate(ticks):
        tick_value = 800 - index * 200
        y = plot_bottom - int((tick_value / 800) * (plot_bottom - plot_top))
        draw_line(image, plot_left, y, plot_right, y, GRID, 2)
        tick_width = text_width(tick, 3)
        draw_text(image, plot_left - 30 - tick_width, y - 10, tick, 3)
    draw_line(image, plot_left, plot_top, plot_left, plot_bottom, INK, 3)
    draw_line(image, plot_left, plot_bottom, plot_right, plot_bottom, INK, 3)
    centers = [365, 597, 829, 1061]
    colors = [(72, 112, 182), (76, 148, 120), (198, 138, 62), (148, 92, 160)]
    for center, value, color in zip(centers, values, colors):
        bar_height = int(round((value / 800) * (plot_bottom - plot_top)))
        top = plot_bottom - bar_height
        fill_rect(image, center - 55, top, center + 55, plot_bottom - 3, color)
        draw_rect_outline(image, center - 55, top, center + 55, plot_bottom - 3, INK, 2)
        value_text = str(value)
        draw_text(image, center - text_width(value_text, 3) // 2, top - 45, value_text, 3)
    for center, category in zip(centers, categories):
        draw_text(
            image,
            center - text_width(category, 4) // 2,
            930,
            category,
            4,
        )
    draw_text(image, 630, 1005, xlabel, 4)
    truth = {
        "kind": "image",
        "lang": "en",
        "difficulty": "moderate",
        "degradations": ["chart"],
        "text": " ".join(
            [
                title,
                subtitle,
                ylabel,
                *ticks,
                *[f"{category} {value}" for category, value in zip(categories, values)],
                xlabel,
            ]
        ),
        "keywords": [title, ylabel, categories[0], str(values[0]), categories[3], str(values[3])],
        "fields": {
            "title": title,
            "east": str(values[0]),
            "south": str(values[1]),
            "north": str(values[2]),
            "west": str(values[3]),
        },
        "conditions": {"region": "chart"},
    }
    return image, truth


def approval_page() -> tuple[np.ndarray, dict]:
    image = blank(1300, 1450)
    heading = "DOCUMENT APPROVAL"
    body = "THIS PAGE CONFIRMS THAT THE REQUEST HAS BEEN REVIEWED."
    stamp = "APPROVED"
    label = "SIGNATURE"
    name = "AUTHORIZED BY OPERATIONS LEAD"
    date = "DATE: 2026-10-31"
    draw_text(image, 100, 90, heading, 6)
    draw_paragraph(image, 100, 210, 1080, body, 5)
    draw_stamp(image, 900, 520, stamp, 5, angle=4.0)
    draw_text(image, 100, 800, label, 4)
    draw_signature(image, 100, 860, 560, 210, seed=404)
    draw_line(image, 100, 1090, 720, 1090, GRID, 2)
    draw_text(image, 100, 1140, name, 4)
    draw_text(image, 100, 1210, date, 4)
    truth = {
        "kind": "image",
        "lang": "en",
        "difficulty": "severe",
        "degradations": ["stamp", "signature"],
        "text": " ".join([heading, body, stamp, label, name, date]),
        "keywords": [heading, stamp, label, "OPERATIONS LEAD"],
        "fields": {
            "status": stamp,
            "signatory": "OPERATIONS LEAD",
            "date": "2026-10-31",
        },
        "conditions": {"region": "combined"},
    }
    return image, truth


GENERATORS = {
    "formula_block.png": formula_block,
    "vertical_text.png": vertical_text,
    "red_stamp.png": red_stamp,
    "signature_block.png": signature_block,
    "handwriting_note.png": handwriting_note,
    "chart_bars.png": bar_chart,
    "approval_stamp_signature.png": approval_page,
}


def write_png(path: Path, image: np.ndarray) -> None:
    height, width = image.shape[:2]
    if image.ndim == 2:
        rgb = np.repeat(image[:, :, None], 3, axis=2)
    else:
        rgb = image
    raw = b"".join(b"\x00" + rgb[row].tobytes() for row in range(height))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def enrich(truth: dict, path: Path) -> dict:
    enriched = dict(truth)
    enriched["provenance"] = {
        "annotator": "synthetic-generator",
        "annotatedAt": ANNOTATED_AT,
        "source": GENERATOR,
        "sha256": sha256_of(path),
    }
    return enriched


def image_files(corpus: Path) -> list[str]:
    if not corpus.exists():
        return []
    return sorted(
        entry.name
        for entry in corpus.iterdir()
        if entry.is_file()
        and not entry.name.startswith(".")
        and entry.suffix.lower() in SUPPORTED
    )


def check_corpus(corpus: Path) -> int:
    truth_path = corpus / "ground_truth.json"
    if not truth_path.exists():
        print(f"FAILED: missing {truth_path}")
        return 1
    try:
        truth = json.loads(truth_path.read_text(encoding="utf8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"FAILED: cannot read ground truth: {error}")
        return 1
    if not isinstance(truth, dict):
        print("FAILED: ground_truth.json must contain an object")
        return 1

    files = image_files(corpus)
    file_set = set(files)
    truth_keys = set(truth)
    problems = 0
    for name in sorted(file_set | truth_keys):
        if name not in truth:
            print(f"{name}: missing-truth")
            problems += 1
            continue
        if name not in file_set:
            print(f"{name}: missing-file")
            problems += 1
            continue
        entry = truth[name]
        provenance = entry.get("provenance") if isinstance(entry, dict) else None
        expected = provenance.get("sha256") if isinstance(provenance, dict) else None
        actual = sha256_of(corpus / name)
        if not expected or expected != actual:
            print(f"{name}: hash-mismatch")
            problems += 1
        else:
            print(f"{name}: ok")

    if problems:
        print(f"FAILED: {problems} problem(s); {len(files)} images, {len(truth)} truth entries")
        return 1
    print(
        f"OK: {len(files)} images and {len(truth)} truth entries; "
        "SHA-256 and file/truth bijection verified"
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dir",
        default="benchmarks/corpus-v2/semantic-regions",
        help="standalone corpus directory",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify hashes and file/truth bijection without writing files",
    )
    args = parser.parse_args()

    corpus = Path(args.dir)
    if args.check:
        return check_corpus(corpus)

    corpus.mkdir(parents=True, exist_ok=True)
    truth: dict[str, dict] = {}
    for name, factory in GENERATORS.items():
        path = corpus / name
        image, entry = factory()
        write_png(path, image)
        truth[name] = enrich(entry, path)
        print(f"wrote {path} ({image.shape[1]}x{image.shape[0]})")

    truth_path = corpus / "ground_truth.json"
    truth_path.write_text(
        json.dumps(truth, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf8",
    )
    print(f"wrote {truth_path} ({len(truth)} entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
