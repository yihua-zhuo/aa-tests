#!/usr/bin/env python3
"""Generate the degraded-layout OCR benchmark pack without image libraries.

The pack stresses reading order and photometric quality: a dense multi-column
page with a sidebar and uneven columns, a rotated/warped photo, motion blur,
defocus, glare plus a shadow gradient, a low-resolution fax with speckle,
mixed tiny/headline text, and a two-page report with repeated headers and a
footnote.

Glyphs come from the same 5x7 uppercase bitmap font used by
``generate_ocr_corpus.py``; PNGs are written with zlib and every random
operation is seeded, so repeated runs are byte identical.

Usage:
  PYTHONDONTWRITEBYTECODE=1 python3 scripts/generate_degraded_corpus.py
  PYTHONDONTWRITEBYTECODE=1 python3 scripts/generate_degraded_corpus.py --check
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import zlib
from pathlib import Path

import numpy as np

INK = 30
PAPER = 246
ANNOTATED_AT = "2026-10-31T00:00:00Z"
ANNOTATOR = "synthetic-generator"
GENERATOR = "scripts/generate_degraded_corpus.py"
DEFAULT_DIR = Path(__file__).resolve().parents[1] / "benchmarks/corpus-v2/degraded-layout"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".pdf"}

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
    "&": ("01100", "10010", "10100", "01000", "10101", "10010", "01101"),
    "_": ("00000", "00000", "00000", "00000", "00000", "00000", "11111"),
    "!": ("00100", "00100", "00100", "00100", "00100", "00000", "00100"),
}

GLYPH_ADVANCE = 6
GLYPH_HEIGHT = 7


# --------------------------------------------------------------------------- #
# Bitmap text rendering
# --------------------------------------------------------------------------- #


def blank(width: int, height: int, value: int = PAPER) -> np.ndarray:
    return np.full((height, width), value, dtype=np.uint8)


def text_width(text: str, scale: int) -> int:
    return len(text) * GLYPH_ADVANCE * scale


def _validate_text(text: str, x: int, y: int, scale: int, width: int, height: int) -> None:
    if not text:
        raise ValueError("empty text block")
    if " ".join(text.split()) != text:
        raise ValueError(f"text must use single spaces: {text!r}")
    unknown = sorted(set(text) - set(FONT))
    if unknown:
        raise ValueError(f"unsupported glyphs {unknown} in {text!r}")
    if x < 0 or y < 0:
        raise ValueError(f"negative origin for {text!r}")
    if x + text_width(text, scale) > width:
        raise ValueError(f"text overflows width: {text!r} at x={x}")
    if y + GLYPH_HEIGHT * scale > height:
        raise ValueError(f"text overflows height: {text!r} at y={y}")


def draw_char(image: np.ndarray, x: int, y: int, char: str, scale: int, ink: int) -> None:
    glyph = FONT[char]
    height, width = image.shape
    for row, bits in enumerate(glyph):
        for column, bit in enumerate(bits):
            if bit != "1":
                continue
            top = y + row * scale
            left = x + column * scale
            bottom = min(height, top + scale)
            right = min(width, left + scale)
            if top < height and left < width and bottom > top and right > left:
                image[top:bottom, left:right] = ink


def draw_text(
    image: np.ndarray, x: int, y: int, text: str, scale: int, ink: int = INK
) -> int:
    _validate_text(text, x, y, scale, image.shape[1], image.shape[0])
    cursor = x
    for char in text:
        draw_char(image, cursor, y, char, scale, ink)
        cursor += GLYPH_ADVANCE * scale
    return cursor


def draw_right(
    image: np.ndarray, right_x: int, y: int, text: str, scale: int, ink: int = INK
) -> None:
    draw_text(image, right_x - text_width(text, scale), y, text, scale, ink)


def paragraph_lines(text: str, width: int, scale: int) -> list[str]:
    """Greedy word wrap; joining the returned lines reproduces ``text``."""
    words = text.split()
    lines: list[str] = []
    line = ""
    for word in words:
        candidate = word if not line else f"{line} {word}"
        if text_width(candidate, scale) > width and line:
            lines.append(line)
            line = word
        else:
            line = candidate
    if line:
        lines.append(line)
    return lines


def draw_paragraph(
    image: np.ndarray,
    x: int,
    y: int,
    width: int,
    text: str,
    scale: int,
    ink: int = INK,
    line_height: int | None = None,
) -> int:
    lines = paragraph_lines(text, width, scale)
    if " ".join(lines) != text:
        raise ValueError(f"paragraph wrap changed text: {text!r}")
    step = line_height if line_height is not None else 9 * scale
    for line in lines:
        draw_text(image, x, y, line, scale, ink)
        y += step
    return y


def draw_line(image: np.ndarray, x1: int, y1: int, x2: int, y2: int, ink: int = INK) -> None:
    steps = max(abs(x2 - x1), abs(y2 - y1), 1)
    for step in range(steps + 1):
        ratio = step / steps
        x = round(x1 + (x2 - x1) * ratio)
        y = round(y1 + (y2 - y1) * ratio)
        if 0 <= y < image.shape[0] and 0 <= x < image.shape[1]:
            image[y, x] = ink


def draw_dashed(image: np.ndarray, x1: int, y: int, x2: int, ink: int = INK) -> None:
    for x in range(x1, x2, 22):
        draw_line(image, x, y, min(x + 12, x2), y, ink)


def draw_box(image: np.ndarray, x: int, y: int, width: int, height: int, ink: int = INK) -> None:
    draw_line(image, x, y, x + width, y, ink)
    draw_line(image, x, y + height, x + width, y + height, ink)
    draw_line(image, x, y, x, y + height, ink)
    draw_line(image, x + width, y, x + width, y + height, ink)


def draw_table(
    image: np.ndarray,
    x: int,
    y: int,
    rows: list[list[str]],
    widths: list[int],
    row_height: int,
    scale: int,
    ink: int = INK,
    pad: int = 8,
) -> list[str]:
    """Draw a ruled grid and return row-major cell text in reading order."""
    total = sum(widths)
    if x + total > image.shape[1]:
        raise ValueError("table overflows width")
    if y + len(rows) * row_height > image.shape[0]:
        raise ValueError("table overflows height")
    for row_index, row in enumerate(rows):
        top = y + row_index * row_height
        draw_line(image, x, top, x + total, top, ink)
        cursor = x
        for column, cell in enumerate(row):
            if cell:
                if text_width(cell, scale) > widths[column] - 2 * pad:
                    raise ValueError(f"cell does not fit: {cell!r}")
                draw_text(
                    image,
                    cursor + pad,
                    top + (row_height - GLYPH_HEIGHT * scale) // 2,
                    cell,
                    scale,
                    ink,
                )
            cursor += widths[column]
        draw_line(image, x, top + row_height, x + total, top + row_height, ink)
        cursor = x
        for column in range(1, len(widths)):
            cursor += widths[column - 1]
            draw_line(image, cursor, top, cursor, top + row_height, ink)
    draw_line(image, x, y, x, y + len(rows) * row_height, ink)
    draw_line(image, x + total, y, x + total, y + len(rows) * row_height, ink)
    return [" ".join(cell for cell in row if cell) for row in rows]


# --------------------------------------------------------------------------- #
# Degradations (all deterministic)
# --------------------------------------------------------------------------- #


def add_grain(image: np.ndarray, sigma: float, seed: int, block: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    if block <= 1:
        noise = rng.normal(0.0, sigma, image.shape)
    else:
        height, width = image.shape
        rows = (height + block - 1) // block
        columns = (width + block - 1) // block
        small = rng.normal(0.0, sigma, (rows, columns))
        noise = np.repeat(np.repeat(small, block, axis=0), block, axis=1)[:height, :width]
    return np.clip(image.astype(np.float32) + noise, 0, 255).astype(np.uint8)


def box_blur(image: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return image
    kernel = radius * 2 + 1
    source = image.astype(np.float32)
    height, width = source.shape

    padded = np.pad(source, ((0, 0), (radius, radius)), mode="edge")
    horizontal = np.cumsum(padded, axis=1)
    horizontal = np.concatenate([np.zeros((height, 1), dtype=np.float32), horizontal], axis=1)
    horizontal = (horizontal[:, kernel:] - horizontal[:, :-kernel]) / kernel

    padded = np.pad(horizontal, ((radius, radius), (0, 0)), mode="edge")
    vertical = np.cumsum(padded, axis=0)
    vertical = np.concatenate([np.zeros((1, width), dtype=np.float32), vertical], axis=0)
    vertical = (vertical[kernel:, :] - vertical[:-kernel, :]) / kernel
    return np.clip(vertical, 0, 255).astype(np.uint8)


def motion_blur(image: np.ndarray, length: int, dx: float, dy: float) -> np.ndarray:
    accumulator = np.zeros(image.shape, dtype=np.float32)
    source = image.astype(np.float32)
    for step in range(length):
        offset = step - (length - 1) / 2
        shift_x = int(round(dx * offset))
        shift_y = int(round(dy * offset))
        accumulator += np.roll(np.roll(source, shift_y, axis=0), shift_x, axis=1)
    return np.clip(accumulator / length, 0, 255).astype(np.uint8)


def low_contrast(image: np.ndarray, factor: float, lift: int) -> np.ndarray:
    return np.clip(image.astype(np.float32) * factor + lift, 0, 255).astype(np.uint8)


def light_gradient(
    image: np.ndarray, left: float, right: float, top: float, bottom: float
) -> np.ndarray:
    height, width = image.shape
    xn = np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :]
    yn = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None]
    light = (left + (right - left) * xn) * (top + (bottom - top) * yn)
    return np.clip(image.astype(np.float32) * light, 0, 255).astype(np.uint8)


def add_glare(
    image: np.ndarray, center_x: int, center_y: int, radius_x: int, radius_y: int, amount: float
) -> np.ndarray:
    height, width = image.shape
    ys, xs = np.mgrid[0:height, 0:width]
    distance = ((xs - center_x) / radius_x) ** 2 + ((ys - center_y) / radius_y) ** 2
    glow = amount * np.exp(-2.4 * distance)
    return np.clip(image.astype(np.float32) + glow, 0, 255).astype(np.uint8)


def rotate_onto(
    page: np.ndarray, degrees: float, canvas_w: int, canvas_h: int, backdrop: int
) -> np.ndarray:
    """Rotate ``page`` about its centre onto a larger canvas, filling with backdrop."""
    radians = np.deg2rad(degrees)
    cosine = np.cos(radians)
    sine = np.sin(radians)
    page_h, page_w = page.shape
    ys, xs = np.mgrid[0:canvas_h, 0:canvas_w]
    dx = xs - canvas_w / 2.0
    dy = ys - canvas_h / 2.0
    source_x = dx * cosine + dy * sine + page_w / 2.0
    source_y = -dx * sine + dy * cosine + page_h / 2.0
    inside = (
        (source_x >= 0)
        & (source_x <= page_w - 1)
        & (source_y >= 0)
        & (source_y <= page_h - 1)
    )
    index_x = np.clip(np.rint(source_x).astype(np.int32), 0, page_w - 1)
    index_y = np.clip(np.rint(source_y).astype(np.int32), 0, page_h - 1)
    return np.where(inside, page[index_y, index_x], np.uint8(backdrop)).astype(np.uint8)


def _homography(source: list[tuple[float, float]], target: list[tuple[float, float]]) -> np.ndarray:
    rows = []
    values = []
    for (x, y), (u, v) in zip(source, target):
        rows.append([x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y])
        rows.append([0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y])
        values.extend([u, v])
    coefficients = np.linalg.solve(np.asarray(rows, dtype=np.float64), np.asarray(values))
    return np.array(
        [
            [coefficients[0], coefficients[1], coefficients[2]],
            [coefficients[3], coefficients[4], coefficients[5]],
            [coefficients[6], coefficients[7], 1.0],
        ]
    )


def warp_perspective(
    image: np.ndarray, quad: list[tuple[float, float]], fill: int
) -> np.ndarray:
    """Map the image onto ``quad`` (destination corners) with bilinear sampling."""
    height, width = image.shape
    source = [(0, 0), (width - 1, 0), (width - 1, height - 1), (0, height - 1)]
    transform = _homography(quad, source)
    ys, xs = np.mgrid[0:height, 0:width]
    denominator = transform[2, 0] * xs + transform[2, 1] * ys + transform[2, 2]
    source_x = (transform[0, 0] * xs + transform[0, 1] * ys + transform[0, 2]) / denominator
    source_y = (transform[1, 0] * xs + transform[1, 1] * ys + transform[1, 2]) / denominator
    inside = (
        (source_x >= 0)
        & (source_x <= width - 1)
        & (source_y >= 0)
        & (source_y <= height - 1)
    )
    x0 = np.clip(np.floor(source_x).astype(np.int32), 0, width - 2)
    y0 = np.clip(np.floor(source_y).astype(np.int32), 0, height - 2)
    x1 = x0 + 1
    y1 = y0 + 1
    fx = np.clip(source_x - x0, 0.0, 1.0)
    fy = np.clip(source_y - y0, 0.0, 1.0)
    pixels = image.astype(np.float32)
    sampled = (
        pixels[y0, x0] * (1 - fx) * (1 - fy)
        + pixels[y0, x1] * fx * (1 - fy)
        + pixels[y1, x0] * (1 - fx) * fy
        + pixels[y1, x1] * fx * fy
    )
    return np.clip(np.where(inside, sampled, np.float32(fill)), 0, 255).astype(np.uint8)


def downsample2(image: np.ndarray) -> np.ndarray:
    height, width = image.shape
    if height % 2 or width % 2:
        raise ValueError("downsample2 needs even dimensions")
    blocks = image.reshape(height // 2, 2, width // 2, 2).astype(np.float32)
    return np.clip(blocks.mean(axis=(1, 3)), 0, 255).astype(np.uint8)


def fax_degrade(page: np.ndarray, seed: int) -> np.ndarray:
    """Half-resolution fax: downsample, hard threshold, speckle and scan streaks.

    ``page`` is rendered at 2x so that downsampling leaves two-pixel strokes;
    one-pixel strokes would vanish under the threshold.
    """
    reduced = downsample2(page)
    binary = np.where(reduced < 150, 16, 250).astype(np.uint8)

    rng = np.random.default_rng(seed)
    black = rng.random(binary.shape) < 0.0007
    white = rng.random(binary.shape) < 0.0004
    binary[black] = 12
    binary[white] = 248

    streaks = np.random.default_rng(seed + 11)
    height = binary.shape[0]
    for row in streaks.choice(height, size=max(4, height // 140), replace=False):
        binary[row, :] = np.clip(binary[row, :].astype(np.int16) - 26, 0, 255)
    for _ in range(3):
        column = int(streaks.integers(0, binary.shape[1]))
        binary[:, column] = np.clip(binary[:, column].astype(np.int16) - 18, 0, 255)

    return binary


# --------------------------------------------------------------------------- #
# Documents
# --------------------------------------------------------------------------- #


def _truth(
    kind: str,
    difficulty: str,
    degradations: list[str],
    blocks: list[str],
    keywords: list[str],
    fields: dict[str, str],
    conditions: dict | None = None,
) -> dict:
    text = " ".join(blocks)
    for keyword in keywords:
        if keyword not in text:
            raise ValueError(f"keyword not rendered: {keyword!r}")
    for name, value in fields.items():
        if value and value not in text:
            raise ValueError(f"field {name!r} value not rendered: {value!r}")
    entry = {
        "kind": kind,
        "lang": "en",
        "difficulty": difficulty,
        "degradations": degradations,
        "text": text,
        "keywords": keywords,
        "fields": fields,
    }
    if conditions:
        entry["conditions"] = conditions
    return entry


def multi_column_sidebar() -> tuple[np.ndarray, dict]:
    width, height = 1300, 1360
    image = blank(width, height)
    blocks: list[str] = []

    header = "NORTHWIND LOGISTICS BULLETIN"
    page_number = "PAGE 3 OF 8"
    draw_text(image, 60, 56, header, 2)
    draw_right(image, width - 60, 56, page_number, 2)
    blocks.extend([header, page_number])
    draw_line(image, 60, 88, width - 60, 88)

    title = "NETWORK CAPACITY REVIEW"
    kicker = "REGION NORTH - PERIOD 2026 Q3"
    draw_text(image, 60, 112, title, 5)
    draw_text(image, 60, 172, kicker, 3)
    blocks.extend([title, kicker])
    draw_line(image, 60, 210, width - 60, 210)

    side_x, side_y, side_w = 60, 246, 300
    side_heading = "AT A GLANCE"
    side_items = [
        "412,880 PARCELS",
        "UP 9.4% QUARTER OVER QUARTER",
        "91% DOCK UTILIZATION",
        "SECOND SHIFT ADDED IN AUGUST",
    ]
    side_lines: list[str] = []
    for item in side_items:
        side_lines.extend(paragraph_lines(item, side_w - 36, 2))
    side_height = 18 + GLYPH_HEIGHT * 2 + 18 + len(side_lines) * 24 + 10
    draw_box(image, side_x, side_y, side_w, side_height)
    draw_text(image, side_x + 18, side_y + 18, side_heading, 2)
    body_y = side_y + 18 + 18 + 18
    for line in side_lines:
        draw_text(image, side_x + 18, body_y, line, 2)
        body_y += 24
    blocks.append(side_heading)
    blocks.extend(side_items)

    mid_text = (
        "THE NORTH CORRIDOR CARRIED 412,880 PARCELS IN Q3, UP 9.4% QUARTER OVER "
        "QUARTER. SORTING CAPACITY AT THE DOCK REMAINED THE BINDING CONSTRAINT "
        "DURING PEAK WEEKS. THE TEAM ADDED A SECOND SHIFT IN AUGUST AND CUT QUEUE "
        "TIME BY 14 MINUTES. DOCK 4 RAN AT 91 PERCENT UTILIZATION FOR MOST OF "
        "SEPTEMBER."
    )
    mid_y = draw_paragraph(image, 410, 246, 430, mid_text, 3, line_height=32)
    blocks.append(mid_text)

    mid_text_two = (
        "TWO NEW DOCK DOORS ARE SCHEDULED FOR COMMISSIONING IN JANUARY. UNTIL THEN, "
        "OVERFLOW TRAILERS ARE STAGED AT THE WEST YARD."
    )
    mid_y = draw_paragraph(image, 410, mid_y + 30, 430, mid_text_two, 3, line_height=32)
    blocks.append(mid_text_two)

    mid_text_three = (
        "THE REGIONAL CONTROL TOWER WILL PUBLISH A REVISED CAPACITY PLAN BEFORE THE "
        "NEXT PLANNING CYCLE."
    )
    draw_paragraph(image, 410, mid_y + 30, 430, mid_text_three, 3, line_height=32)
    blocks.append(mid_text_three)

    right_text = (
        "QUEUE TIME AT THE GATE AVERAGED 6 MINUTES. THE FLEET TRAVELLED 88,400 KM "
        "WITH 2.1 PERCENT IDLE TIME. FUEL COST PER PARCEL FELL TO 0.42 CNY, THE "
        "LOWEST LEVEL SINCE 2024."
    )
    right_y = draw_paragraph(image, 880, 246, 360, right_text, 3, line_height=32)
    blocks.append(right_text)

    right_text_two = (
        "THE SOUTH CORRIDOR REMAINS BELOW PLAN AT 71 PERCENT UTILIZATION. VOLUME "
        "THERE IS FLAT."
    )
    draw_paragraph(image, 880, right_y + 30, 360, right_text_two, 3, line_height=32)
    blocks.append(right_text_two)

    call_x, call_y, call_w = 880, 760, 360
    call_heading = "NOTE"
    call_text = "THE 2027 PLAN ASSUMES NO ADDITIONAL DOCK CAPACITY."
    call_lines = paragraph_lines(call_text, call_w - 36, 2)
    call_height = 18 + GLYPH_HEIGHT * 2 + 14 + len(call_lines) * 24 + 10
    draw_box(image, call_x, call_y, call_w, call_height)
    draw_text(image, call_x + 18, call_y + 18, call_heading, 2)
    call_body = call_y + 18 + 14 + 18
    for line in call_lines:
        draw_text(image, call_x + 18, call_body, line, 2)
        call_body += 24
    blocks.extend([call_heading, call_text])

    draw_line(image, 60, 1276, width - 60, 1276)
    footer = "NORTHWIND LOGISTICS BULLETIN"
    notice = "INTERNAL USE ONLY"
    draw_text(image, 60, 1300, footer, 2)
    draw_text(image, 560, 1300, notice, 2)
    draw_right(image, width - 60, 1300, page_number, 2)
    blocks.extend([footer, notice, page_number])

    return image, _truth(
        kind="image-multicolumn",
        difficulty="moderate",
        degradations=[
            "multi_column",
            "uneven_columns",
            "sidebar",
            "reading_order",
            "running_header",
            "running_footer",
            "dense_text",
        ],
        blocks=blocks,
        keywords=[
            "NETWORK CAPACITY REVIEW",
            "412,880",
            "9.4%",
            "91 PERCENT",
            "88,400",
            "0.42 CNY",
        ],
        fields={
            "report": "NETWORK CAPACITY REVIEW",
            "parcels": "412,880",
            "growth": "9.4%",
            "dock_utilization": "91 PERCENT",
            "fleet_distance": "88,400",
            "fuel_cost": "0.42 CNY",
        },
        conditions={"mode": "auto"},
    )


def skewed_photo() -> tuple[np.ndarray, dict]:
    page = blank(1100, 1450)
    blocks: list[str] = []

    title = "SITE SURVEY NOTES"
    draw_text(page, 90, 90, title, 5)
    blocks.append(title)
    draw_line(page, 90, 152, 1010, 152)

    lines = [
        "SITE: HARBOR GATE 2",
        "DATE: 2026-10-29",
        "INSPECTOR: M. OKAFOR",
        "ASSET: PUMP P-118",
    ]
    y = 190
    for line in lines:
        draw_text(page, 90, y, line, 3)
        y += 36
    blocks.extend(lines)

    body = (
        "INSPECTION FOUND CORROSION ON THE DISCHARGE FLANGE. REPLACEMENT PARTS ARE "
        "ON ORDER. THE UNIT REMAINS IN SERVICE AT REDUCED PRESSURE. NEXT SURVEY DUE "
        "2026-12-15."
    )
    draw_paragraph(page, 90, 360, 900, body, 3, line_height=34)
    blocks.append(body)

    note = "RECORDED BY: M. OKAFOR"
    draw_text(page, 90, 560, note, 3)
    blocks.append(note)

    photo = rotate_onto(page, 8.5, 1500, 1850, backdrop=64)
    photo = warp_perspective(
        photo, [(46, 26), (1454, 102), (1470, 1820), (30, 1788)], fill=58
    )
    photo = light_gradient(photo, 0.94, 0.66, 1.0, 0.8)
    photo = low_contrast(photo, 0.86, 32)
    photo = box_blur(photo, 1)
    photo = add_grain(photo, 4.5, seed=11, block=2)

    return photo, _truth(
        kind="image-skewed",
        difficulty="severe",
        degradations=[
            "rotation",
            "perspective",
            "shadow_gradient",
            "low_contrast",
            "noise",
        ],
        blocks=blocks,
        keywords=[
            "SITE SURVEY NOTES",
            "HARBOR GATE 2",
            "PUMP P-118",
            "DISCHARGE FLANGE",
            "REDUCED PRESSURE",
        ],
        fields={
            "site": "HARBOR GATE 2",
            "date": "2026-10-29",
            "inspector": "M. OKAFOR",
            "asset": "PUMP P-118",
            "next_survey": "2026-12-15",
        },
        conditions={"mode": "enhanced"},
    )


def motion_blur_receipt() -> tuple[np.ndarray, dict]:
    width, height = 1200, 1000
    image = blank(width, height)
    blocks: list[str] = []

    title = "EASTLINE COURIER"
    draw_text(image, 264, 90, title, 7)
    blocks.append(title)
    subtitle = "SAME DAY DELIVERY"
    draw_text(image, 456, 170, subtitle, 3)
    blocks.append(subtitle)
    draw_line(image, 200, 220, 1000, 220)

    lines = [
        "RECEIPT #R-88421",
        "DATE: 2026-10-27",
        "SERVICE: SAME DAY",
        "WEIGHT: 12.4 KG",
        "CHARGE: 386.00 CNY",
        "PAID BY CARD",
    ]
    y = 260
    for line in lines:
        draw_text(image, 300, y, line, 5)
        y += 78
    blocks.extend(lines)

    draw_line(image, 200, 730, 1000, 730)
    thanks = "THANK YOU"
    draw_text(image, 465, 770, thanks, 5)
    blocks.append(thanks)
    footer = "KEEP THIS RECEIPT FOR YOUR RECORDS"
    draw_text(image, 300, 880, footer, 3)
    blocks.append(footer)

    image = low_contrast(image, 0.55, 100)
    image = motion_blur(image, length=7, dx=1.0, dy=0.35)
    image = add_grain(image, 4.0, seed=23, block=2)

    return image, _truth(
        kind="image-blurred",
        difficulty="severe",
        degradations=["motion_blur", "low_contrast", "noise"],
        blocks=blocks,
        keywords=["EASTLINE COURIER", "R-88421", "386.00 CNY", "12.4 KG"],
        fields={
            "receipt": "R-88421",
            "date": "2026-10-27",
            "weight": "12.4 KG",
            "amount": "386.00 CNY",
            "payment": "CARD",
        },
        conditions={"mode": "enhanced"},
    )


def out_of_focus_log() -> tuple[np.ndarray, dict]:
    width, height = 1200, 1500
    image = blank(width, height)
    blocks: list[str] = []

    header = "APEX WAREHOUSE RECEIVING LOG"
    page_number = "PAGE 4 OF 12"
    draw_text(image, 60, 50, header, 2)
    draw_right(image, width - 60, 50, page_number, 2)
    blocks.extend([header, page_number])
    draw_line(image, 60, 82, width - 60, 82)

    title = "RECEIVING LOG"
    subtitle = "DOCK 2 - SHIFT B"
    draw_text(image, 60, 106, title, 5)
    draw_text(image, 60, 166, subtitle, 3)
    blocks.extend([title, subtitle])

    rows = [
        ["TIME", "CARRIER", "PALLETS", "SEAL"],
        ["07:40", "RIDGELINE", "12", "S-4410"],
        ["08:15", "NORTHPORT", "8", "S-4411"],
        ["09:05", "RIDGELINE", "10", "S-4412"],
    ]
    blocks.extend(draw_table(image, 80, 230, rows, [210, 410, 210, 250], 70, 3))

    body = (
        "PALLET COUNTS WERE VERIFIED AGAINST THE MANIFEST. TWO PALLETS ON THE "
        "SECOND TRUCK SHOWED WATER DAMAGE AND WERE HELD FOR INSPECTION."
    )
    draw_paragraph(image, 80, 580, 1000, body, 3, line_height=34)
    blocks.append(body)

    signature = "DRIVER SIGNATURE: R. HALE"
    draw_text(image, 80, 720, signature, 3)
    blocks.append(signature)

    draw_line(image, 60, 1380, width - 60, 1380)
    draw_text(image, 60, 1410, header, 2)
    draw_right(image, width - 60, 1410, page_number, 2)
    blocks.extend([header, page_number])

    blurry = box_blur(box_blur(image, 3), 3)
    image = np.clip(
        blurry.astype(np.float32) * 0.82 + image.astype(np.float32) * 0.18, 0, 255
    ).astype(np.uint8)
    image = low_contrast(image, 0.78, 48)
    image = add_grain(image, 3.0, seed=31, block=2)

    return image, _truth(
        kind="image-defocused",
        difficulty="severe",
        degradations=[
            "defocus_blur",
            "low_contrast",
            "noise",
            "running_header",
            "running_footer",
        ],
        blocks=blocks,
        keywords=[
            "APEX WAREHOUSE RECEIVING LOG",
            "RIDGELINE",
            "S-4410",
            "WATER DAMAGE",
        ],
        fields={
            "dock": "DOCK 2",
            "carrier": "RIDGELINE",
            "pallets": "12",
            "seal": "S-4410",
            "page": "PAGE 4 OF 12",
        },
        conditions={"mode": "enhanced"},
    )


def glare_shadow_notice() -> tuple[np.ndarray, dict]:
    width, height = 1200, 1600
    image = blank(width, height)
    blocks: list[str] = []

    title = "AUDIT NOTICE"
    reference = "REF: AUD-2026-114"
    draw_text(image, 100, 100, title, 7)
    draw_text(image, 100, 190, reference, 3)
    blocks.extend([title, reference])
    draw_line(image, 100, 240, 1100, 240)

    first = "PLEASE PROVIDE THE FOLLOWING RECORDS FOR THE PERIOD ENDING 2026-09-30."
    second = (
        "BANK STATEMENTS, PURCHASE LEDGER, AND INVENTORY COUNTS ARE DUE WITHIN TEN "
        "WORKING DAYS OF THIS NOTICE."
    )
    third = (
        "CONTACT THE AUDIT DESK IF ANY RECORD IS UNAVAILABLE. LATE SUBMISSIONS ARE "
        "LOGGED AND REPORTED."
    )
    draw_paragraph(image, 100, 290, 980, first, 4, line_height=56)
    draw_paragraph(image, 100, 440, 980, second, 4, line_height=56)
    draw_paragraph(image, 100, 650, 980, third, 4, line_height=56)
    blocks.extend([first, second, third])

    deadline = "RESPONSE DUE: 2026-11-09"
    draw_text(image, 100, 850, deadline, 5)
    blocks.append(deadline)

    desk = "AUDIT DESK - EXTENSION 4412"
    draw_text(image, 100, 1450, desk, 3)
    blocks.append(desk)
    draw_line(image, 100, 1420, 1100, 1420)

    image = light_gradient(image, 0.55, 1.0, 1.0, 0.92)
    image = add_glare(image, 720, 640, 390, 330, 72.0)
    image = add_grain(image, 3.0, seed=37, block=2)

    return image, _truth(
        kind="image-glare",
        difficulty="severe",
        degradations=["glare", "shadow_gradient", "uneven_lighting", "noise"],
        blocks=blocks,
        keywords=[
            "AUDIT NOTICE",
            "BANK STATEMENTS",
            "TEN WORKING DAYS",
            "2026-11-09",
        ],
        fields={
            "reference": "AUD-2026-114",
            "period_end": "2026-09-30",
            "deadline": "2026-11-09",
            "extension": "4412",
        },
        conditions={"mode": "enhanced"},
    )


def fax_low_resolution() -> tuple[np.ndarray, dict]:
    # Rendered at 2x and downsampled to 1000x1400 so the fax carries two-pixel
    # strokes, the way a 200 dpi transmission of a typewritten page does.
    page = blank(2000, 2800)
    blocks: list[str] = []

    title = "FAX TRANSMISSION"
    draw_text(page, 120, 120, title, 6)
    blocks.append(title)

    header_lines = [
        "TO: DOCUMENT CONTROL",
        "FROM: SITE 14",
        "DATE: 2026-10-26",
        "PAGES: 2 OF 3",
        "RE: DAILY PLANT LOG",
    ]
    y = 220
    for line in header_lines:
        draw_text(page, 120, y, line, 4)
        y += 60
    blocks.extend(header_lines)
    draw_line(page, 120, 560, 1880, 560)

    body = (
        "UNIT 3 TRIPPED AT 04:12 AND WAS RESTARTED AT 05:05. NO INJURIES WERE "
        "REPORTED. THE CAUSE WAS A FAILED PRESSURE SENSOR. A REPLACEMENT WAS FITTED "
        "FROM STORES. THE LINE RAN AT 88 PERCENT OF RATED SPEED FOR THE REST OF THE "
        "SHIFT."
    )
    draw_paragraph(page, 120, 620, 1760, body, 4, line_height=44)
    blocks.append(body)

    shifts = ["SHIFT A: 214 UNITS", "SHIFT B: 198 UNITS", "SHIFT C: 206 UNITS"]
    y = 900
    for line in shifts:
        draw_text(page, 120, y, line, 4)
        y += 60
    blocks.extend(shifts)

    draw_line(page, 120, 1160, 1880, 1160)
    signed = "SIGNED: R. VOSS"
    draw_text(page, 120, 1200, signed, 4)
    blocks.append(signed)

    footer = "FAX LOG 2026-10-26 / PAGE 1"
    draw_text(page, 120, 2680, footer, 4)
    blocks.append(footer)

    image = fax_degrade(page, seed=41)

    return image, _truth(
        kind="image-fax",
        difficulty="severe",
        degradations=["fax", "low_resolution", "speckle", "scan_lines"],
        blocks=blocks,
        keywords=["FAX TRANSMISSION", "PRESSURE SENSOR", "214 UNITS", "R. VOSS"],
        fields={
            "recipient": "DOCUMENT CONTROL",
            "date": "2026-10-26",
            "pages": "2 OF 3",
            "shift_a": "214 UNITS",
            "signed": "R. VOSS",
        },
        conditions={"mode": "enhanced", "dpi": 200},
    )


def mixed_scale_brief() -> tuple[np.ndarray, dict]:
    width, height = 1400, 1750
    image = blank(width, height)
    blocks: list[str] = []

    header = "ANNUAL LOGISTICS BRIEF / SECTION 2"
    page_number = "PAGE 7"
    draw_text(image, 60, 50, header, 2)
    draw_right(image, width - 60, 50, page_number, 2)
    blocks.extend([header, page_number])

    headline_one = "STORAGE COSTS"
    headline_two = "JUMP AGAIN"
    draw_text(image, 60, 110, headline_one, 10)
    draw_text(image, 60, 196, headline_two, 10)
    blocks.extend([headline_one, headline_two])

    stat = "38.6%"
    draw_text(image, 60, 340, stat, 13)
    blocks.append(stat)
    caption = "YEAR OVER YEAR INCREASE"
    draw_text(image, 560, 430, caption, 2)
    blocks.append(caption)
    draw_line(image, 60, 540, width - 60, 540)

    small_one = (
        "WAREHOUSE RENTS ROSE ACROSS ALL THREE REGIONS. THE LARGEST INCREASE WAS "
        "RECORDED AT THE INLAND HUB, WHERE NEW LEASES SIGNED IN JUNE RESET THE BASE "
        "RATE. SHORT TERM OVERFLOW SPACE COST 2.4 TIMES THE CONTRACT RATE AND "
        "ACCOUNTED FOR MOST OF THE VARIANCE."
    )
    small_two = (
        "OPERATIONS RECOMMENDS CONSOLIDATING SLOW MOVING STOCK INTO THE SOUTH ANNEX "
        "BEFORE THE NEXT PEAK SEASON."
    )
    draw_paragraph(image, 60, 570, 900, small_one, 2, line_height=24)
    draw_paragraph(image, 60, 720, 900, small_two, 2, line_height=24)
    blocks.extend([small_one, small_two])

    medium = (
        "THE INLAND HUB NOW ACCOUNTS FOR 41 PERCENT OF TOTAL STORAGE SPEND, UP FROM "
        "28 PERCENT LAST YEAR. MONTHLY COST PER PALLET REACHED 96 CNY."
    )
    draw_paragraph(image, 60, 820, 1240, medium, 4, line_height=50)
    blocks.append(medium)

    subhead = "WHAT CHANGED"
    draw_text(image, 60, 1030, subhead, 6)
    blocks.append(subhead)

    small_three = (
        "THE 2027 BUDGET ASSUMES A FLAT VOLUME AND A 6 PERCENT RENT ESCALATION. ANY "
        "NEW CONTRACT ABOVE 120 CNY PER PALLET REQUIRES REGIONAL APPROVAL."
    )
    draw_paragraph(image, 60, 1110, 900, small_three, 2, line_height=24)
    blocks.append(small_three)

    label = "COST PER PALLET"
    draw_text(image, 60, 1290, label, 2)
    blocks.append(label)
    big_number = "96 CNY"
    draw_text(image, 60, 1330, big_number, 8)
    blocks.append(big_number)

    draw_line(image, 60, 1660, width - 60, 1660)
    footer = "ANNUAL LOGISTICS BRIEF"
    draw_text(image, 60, 1684, footer, 2)
    draw_right(image, width - 60, 1684, page_number, 2)
    blocks.extend([footer, page_number])

    return image, _truth(
        kind="image-mixed-scale",
        difficulty="moderate",
        degradations=["mixed_text_scale", "small_text", "dense_text"],
        blocks=blocks,
        keywords=["STORAGE COSTS", "38.6%", "41 PERCENT", "96 CNY", "SOUTH ANNEX"],
        fields={
            "headline": "STORAGE COSTS",
            "growth": "38.6%",
            "share": "41 PERCENT",
            "cost": "96 CNY",
            "escalation": "6 PERCENT",
        },
        conditions={"mode": "auto"},
    )


def two_page_footnote() -> tuple[np.ndarray, dict]:
    width, height = 1200, 1700
    image = blank(width, height)
    blocks: list[str] = []

    header = "ACME FIELD SERVICE REPORT"
    page_one = "PAGE 1 OF 2"
    page_two = "PAGE 2 OF 2"
    title = "WEEKLY LABOR SUMMARY"
    week = "WEEK 43 - 2026"

    # Page 1
    draw_text(image, 60, 40, header, 2)
    draw_right(image, width - 60, 40, page_one, 2)
    blocks.extend([header, page_one])
    draw_line(image, 60, 70, width - 60, 70)
    draw_text(image, 60, 92, title, 4)
    draw_text(image, 60, 142, week, 3)
    blocks.extend([title, week])

    page_one_rows = [
        ["TECHNICIAN", "HOURS", "RATE", "AMOUNT"],
        ["A. LIND", "18.5", "120.00", "2,220.00"],
        ["B. OKORO", "12.0", "135.00", "1,620.00"],
        ["C. DIAZ", "6.0", "110.00", "660.00"],
    ]
    blocks.extend(draw_table(image, 80, 200, page_one_rows, [300, 200, 240, 240], 62, 3))

    total_one = "TOTAL HOURS 36.5(1)"
    draw_text(image, 80, 490, total_one, 3)
    blocks.append(total_one)

    body_one = (
        "OVERTIME IS BILLED AT 1.5 TIMES THE STANDARD RATE. MILEAGE IS NOT INCLUDED "
        "IN THIS SUMMARY."
    )
    draw_paragraph(image, 80, 536, 1000, body_one, 3, line_height=32)
    blocks.append(body_one)

    draw_line(image, 80, 850, 440, 850)
    footnote = "(1) INCLUDES TRAVEL TIME AND STANDBY."
    draw_text(image, 80, 872, footnote, 2)
    blocks.append(footnote)

    draw_line(image, 60, 908, width - 60, 908)
    draw_text(image, 60, 930, header, 2)
    draw_right(image, width - 60, 930, page_one, 2)
    blocks.extend([header, page_one])

    # Page break
    draw_dashed(image, 60, 985, width - 60, ink=120)

    # Page 2 (same running header/footer and repeated table header)
    draw_text(image, 60, 1030, header, 2)
    draw_right(image, width - 60, 1030, page_two, 2)
    blocks.extend([header, page_two])
    draw_line(image, 60, 1060, width - 60, 1060)
    draw_text(image, 60, 1082, title, 4)
    blocks.append(title)

    page_two_rows = [
        ["TECHNICIAN", "HOURS", "RATE", "AMOUNT"],
        ["D. NOVAK", "9.0", "125.00", "1,125.00"],
        ["E. SILVA", "3.0", "140.00", "420.00"],
    ]
    blocks.extend(draw_table(image, 80, 1140, page_two_rows, [300, 200, 240, 240], 62, 3))

    total_two = "TOTAL HOURS 12.0"
    draw_text(image, 80, 1366, total_two, 3)
    blocks.append(total_two)

    body_two = (
        "ALL HOURS WERE APPROVED BY THE SITE SUPERVISOR. WORK ORDER WO-2026-331 IS "
        "NOW CLOSED."
    )
    draw_paragraph(image, 80, 1410, 1000, body_two, 3, line_height=32)
    blocks.append(body_two)

    end = "END OF REPORT"
    draw_text(image, 456, 1510, end, 5)
    blocks.append(end)

    draw_line(image, 60, 1578, width - 60, 1578)
    draw_text(image, 60, 1600, header, 2)
    draw_right(image, width - 60, 1600, page_two, 2)
    blocks.extend([header, page_two])

    return image, _truth(
        kind="image-report",
        difficulty="moderate",
        degradations=[
            "page_break",
            "footnote",
            "repeated_header",
            "repeated_footer",
            "multi_page",
        ],
        blocks=blocks,
        keywords=[
            "ACME FIELD SERVICE REPORT",
            "WEEKLY LABOR SUMMARY",
            "36.5",
            "WO-2026-331",
            "INCLUDES TRAVEL TIME",
        ],
        fields={
            "week": "WEEK 43 - 2026",
            "page_one_total": "36.5",
            "page_two_total": "12.0",
            "order": "WO-2026-331",
            "technician": "A. LIND",
        },
        conditions={"mode": "structure"},
    )


GENERATORS = {
    "multicolumn_sidebar.png": multi_column_sidebar,
    "skewed_photo_warp.png": skewed_photo,
    "motion_blur_receipt.png": motion_blur_receipt,
    "defocused_receiving_log.png": out_of_focus_log,
    "glare_shadow_notice.png": glare_shadow_notice,
    "fax_low_resolution.png": fax_low_resolution,
    "mixed_text_scale.png": mixed_scale_brief,
    "two_page_footnote.png": two_page_footnote,
}


# --------------------------------------------------------------------------- #
# PNG output and CLI
# --------------------------------------------------------------------------- #


def write_png(path: Path, image: np.ndarray) -> None:
    height, width = image.shape
    rgb = np.repeat(image[:, :, None], 3, axis=2)
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


def image_files(corpus: Path) -> list[str]:
    found = []
    for entry in sorted(corpus.iterdir()):
        if not entry.is_file() or entry.name.startswith("."):
            continue
        if entry.name == "ground_truth.json":
            continue
        if entry.suffix.lower() in IMAGE_SUFFIXES:
            found.append(entry.name)
    return found


def verify(corpus: Path) -> int:
    truth_path = corpus / "ground_truth.json"
    if not truth_path.is_file():
        print(f"missing {truth_path}")
        return 1
    raw = truth_path.read_text(encoding="utf8")
    truth = json.loads(raw)
    if not isinstance(truth, dict) or not truth:
        print("ground_truth.json: not a non-empty object")
        return 1
    canonical = json.dumps(truth, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    failures = 0
    if raw != canonical:
        print("ground_truth.json: not canonical (sorted keys / indent / newline)")
        failures += 1
    else:
        print(f"ground_truth.json: ok ({len(truth)} entries)")

    files = image_files(corpus)
    file_set = set(files)
    truth_set = set(truth)
    missing = sorted(truth_set - file_set)
    extra = sorted(file_set - truth_set)
    for name in extra:
        print(f"{name}: extra file without truth entry")
        failures += 1
    for name in missing:
        print(f"{name}: truth entry without file")
        failures += 1

    for name in sorted(file_set & truth_set):
        path = corpus / name
        entry = truth[name]
        problems = []
        if not isinstance(entry, dict):
            problems.append("entry is not an object")
            entry = {}
        expected = ((entry.get("provenance") or {}).get("sha256") or "").lower()
        actual = sha256_of(path)
        if len(expected) != 64 or any(c not in "0123456789abcdef" for c in expected):
            problems.append("bad sha256 in provenance")
        elif expected != actual:
            problems.append(f"sha256 {actual} != {expected}")
        for key in ("kind", "difficulty", "lang"):
            if not isinstance(entry.get(key), str) or not entry[key]:
                problems.append(f"missing {key}")
        if not isinstance(entry.get("text"), str) or not entry["text"].strip():
            problems.append("missing text")
        if not isinstance(entry.get("fields"), dict) or not entry["fields"]:
            problems.append("missing fields")
        if not isinstance(entry.get("keywords"), list) or not entry["keywords"]:
            problems.append("missing keywords")
        if not isinstance(entry.get("degradations"), list) or not entry["degradations"]:
            problems.append("missing degradations")
        source = (entry.get("provenance") or {}).get("source")
        if source != GENERATOR:
            problems.append(f"provenance.source is {source!r}")
        if problems:
            failures += 1
            print(f"{name}: FAIL ({'; '.join(problems)})")
        else:
            print(f"{name}: ok sha256={actual}")

    print(
        "summary: files={} truth={} missing={} extra={} failures={}".format(
            len(files), len(truth), len(missing), len(extra), failures
        )
    )
    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", default=str(DEFAULT_DIR), help="corpus directory")
    parser.add_argument("--check", action="store_true", help="verify hashes and bijection")
    args = parser.parse_args()

    corpus = Path(args.dir)
    if args.check:
        if not corpus.is_dir():
            print(f"missing corpus directory: {corpus}")
            return 1
        return verify(corpus)

    corpus.mkdir(parents=True, exist_ok=True)
    truth: dict[str, dict] = {}
    total_bytes = 0
    for name, factory in GENERATORS.items():
        image, entry = factory()
        path = corpus / name
        write_png(path, image)
        entry = dict(entry)
        entry["provenance"] = {
            "annotator": ANNOTATOR,
            "annotatedAt": ANNOTATED_AT,
            "source": GENERATOR,
            "sha256": sha256_of(path),
        }
        truth[name] = entry
        size = path.stat().st_size
        total_bytes += size
        print(f"wrote {path} ({image.shape[1]}x{image.shape[0]}, {size} bytes)")

    truth_path = corpus / "ground_truth.json"
    truth_path.write_text(
        json.dumps(truth, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf8",
    )
    total_bytes += truth_path.stat().st_size
    print(f"wrote {truth_path} ({len(truth)} entries)")
    print(f"pack size: {total_bytes} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
