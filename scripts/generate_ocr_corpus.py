#!/usr/bin/env python3
"""Generate reproducible synthetic OCR benchmark images without image libraries.

The corpus is intentionally synthetic: it exercises multi-column reading order,
complex tables, skewed photos and low-quality fax degradation without shipping
real customer documents. Point OCR_BENCH_DIR at a private corpus of real scans
when one is available.

Usage:
  python3 scripts/generate_ocr_corpus.py [--dir benchmarks/ocr] [--check]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import zlib
from pathlib import Path

import numpy as np

SCALE = 4
LINE_HEIGHT = 9 * SCALE
PAPER = 246
INK = 28
ANNOTATED_AT = "2026-10-31T00:00:00Z"
GENERATOR = "scripts/generate_ocr_corpus.py"

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


def blank(width: int, height: int, value: int = PAPER) -> np.ndarray:
    return np.full((height, width), value, dtype=np.uint8)


def text_width(text: str, scale: int = SCALE) -> int:
    return len(text) * GLYPH_ADVANCE * scale


def draw_char(image: np.ndarray, x: int, y: int, char: str, scale: int, ink: int) -> None:
    glyph = FONT.get(char.upper(), FONT["?"])
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
    image: np.ndarray,
    x: int,
    y: int,
    text: str,
    scale: int = SCALE,
    ink: int = INK,
) -> int:
    cursor = x
    for char in text:
        draw_char(image, cursor, y, char, scale, ink)
        cursor += GLYPH_ADVANCE * scale
    return cursor


def draw_paragraph(
    image: np.ndarray,
    x: int,
    y: int,
    width: int,
    text: str,
    scale: int = SCALE,
    ink: int = INK,
    line_height: int = LINE_HEIGHT,
) -> int:
    words = text.split()
    line = ""
    for word in words:
        candidate = word if not line else f"{line} {word}"
        if text_width(candidate, scale) > width and line:
            draw_text(image, x, y, line, scale, ink)
            y += line_height
            line = word
        else:
            line = candidate
    if line:
        draw_text(image, x, y, line, scale, ink)
        y += line_height
    return y


def draw_line(image: np.ndarray, x1: int, y1: int, x2: int, y2: int, ink: int = INK) -> None:
    steps = max(abs(x2 - x1), abs(y2 - y1), 1)
    for step in range(steps + 1):
        ratio = step / steps
        x = round(x1 + (x2 - x1) * ratio)
        y = round(y1 + (y2 - y1) * ratio)
        if 0 <= y < image.shape[0] and 0 <= x < image.shape[1]:
            image[y, x] = ink


def draw_table(
    image: np.ndarray,
    x: int,
    y: int,
    rows: list[list[str]],
    widths: list[int],
    row_height: int,
    scale: int = 3,
) -> int:
    total_width = sum(widths)
    for row_index, row in enumerate(rows):
        top = y + row_index * row_height
        draw_line(image, x, top, x + total_width, top)
        cursor = x
        for column_index, cell in enumerate(row):
            width = widths[column_index] if column_index < len(widths) else widths[-1]
            if cell:
                draw_text(image, cursor + 8, top + 10, cell, scale)
            cursor += width
            if column_index > 0:
                draw_line(image, cursor - width, top, cursor - width, top + row_height)
        draw_line(image, x, top + row_height, x + total_width, top + row_height)
    draw_line(image, x, y, x, y + len(rows) * row_height)
    draw_line(image, x + total_width, y, x + total_width, y + len(rows) * row_height)
    return y + len(rows) * row_height


def add_noise(image: np.ndarray, sigma: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    noise = rng.normal(0.0, sigma, image.shape)
    return np.clip(image.astype(np.float32) + noise, 0, 255).astype(np.uint8)


def add_speckle(image: np.ndarray, rate: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    mask = rng.random(image.shape) < rate
    output = image.copy()
    output[mask] = 20
    return output


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


def rotate(image: np.ndarray, degrees: float) -> np.ndarray:
    radians = np.deg2rad(degrees)
    cosine = np.cos(radians)
    sine = np.sin(radians)
    height, width = image.shape
    center_x = (width - 1) / 2
    center_y = (height - 1) / 2
    ys, xs = np.mgrid[0:height, 0:width]
    source_x = (xs - center_x) * cosine + (ys - center_y) * sine + center_x
    source_y = -(xs - center_x) * sine + (ys - center_y) * cosine + center_y
    source_x = np.clip(np.rint(source_x).astype(np.int32), 0, width - 1)
    source_y = np.clip(np.rint(source_y).astype(np.int32), 0, height - 1)
    return image[source_y, source_x]


def low_contrast(image: np.ndarray, factor: float, lift: int) -> np.ndarray:
    return np.clip(image.astype(np.float32) * factor + lift, 0, 255).astype(np.uint8)


def fax_degrade(image: np.ndarray, seed: int) -> np.ndarray:
    blurred = box_blur(image, 1)
    binary = np.where(blurred < 150, 18, 250).astype(np.uint8)
    binary = add_speckle(binary, 0.0015, seed)
    rng = np.random.default_rng(seed + 7)
    for row in rng.choice(binary.shape[0], size=max(3, binary.shape[0] // 400), replace=False):
        binary[row, :] = np.clip(binary[row, :].astype(np.int16) - 18, 0, 255)
    return binary


def write_png(path: Path, image: np.ndarray) -> None:
    height, width = image.shape
    rgb = np.repeat(image[:, :, None], 3, axis=2)
    raw = b"".join(
        b"\x00" + rgb[row].tobytes() for row in range(height)
    )

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


def multi_column() -> tuple[np.ndarray, dict]:
    image = blank(1200, 1600)
    draw_text(image, 80, 90, "QUARTERLY OPERATIONS REVIEW", SCALE + 1)
    draw_text(image, 80, 130, "REGION EAST - PERIOD 2026 Q3", SCALE)
    draw_line(image, 80, 200, 1120, 200)
    left = (
        "TOTAL REVENUE REACHED 1,280,500 CNY, UP 18.5% YEAR OVER YEAR. "
        "THE EAST CHINA REGION CONTRIBUTED THE LARGEST SHARE. CUSTOMER COUNT "
        "GREW TO 4,210."
    )
    right = (
        "NEW ORDERS INCREASED TO 920. THE AVERAGE DEAL SIZE WAS 1,392 CNY. "
        "P95 PROCESSING LATENCY STAYED AT 40 MS. RETURNS WERE 0.8% OF REVENUE."
    )
    bottom = draw_paragraph(image, 80, 260, 480, left)
    draw_paragraph(image, 640, 260, 480, right)
    y = max(bottom, 900) + 20
    draw_text(image, 80, y, "PREPARED BY FINANCE OPERATIONS", SCALE - 1)
    truth = {
        "kind": "image-multicolumn",
        "lang": "en",
        "difficulty": "moderate",
        "degradations": ["multi_column", "dense_text"],
        "text": (
            "QUARTERLY OPERATIONS REVIEW REGION EAST - PERIOD 2026 Q3 "
            + left
            + " "
            + right
            + " PREPARED BY FINANCE OPERATIONS"
        ),
        "keywords": [
            "QUARTERLY OPERATIONS REVIEW",
            "1,280,500",
            "18.5%",
            "4,210",
            "920",
            "40 MS",
        ],
        "fields": {
            "report": "QUARTERLY OPERATIONS REVIEW",
            "total": "1,280,500",
            "growth": "18.5%",
            "customers": "4,210",
        },
    }
    return image, truth


def complex_table() -> tuple[np.ndarray, dict]:
    image = blank(1200, 1400)
    draw_text(image, 80, 80, "PURCHASE ORDER SUMMARY", SCALE + 1)
    draw_text(image, 80, 130, "ORDER #PO-2026-8841", SCALE)
    rows = [
        ["PRODUCT", "QTY", "UNIT PRICE", "AMOUNT"],
        ["WIRELESS HEADSET", "2", "5,980.00", "10,392.00"],
        ["DOCKING STATION", "1", "2,450.00", "2,450.00"],
        ["USB-C CABLE", "4", "120.00", "480.00"],
        ["TOTAL", "", "", "13,322.00"],
    ]
    draw_table(image, 80, 230, rows, [380, 160, 260, 260], 90, SCALE)
    draw_paragraph(
        image,
        80,
        780,
        1040,
        "DELIVERY TO SHANGHAI WAREHOUSE. PAYMENT TERMS NET 30. "
        "GOODS RECEIVED AND INSPECTED ON 2026-10-28.",
    )
    truth = {
        "kind": "table",
        "lang": "en",
        "difficulty": "moderate",
        "degradations": ["complex_table", "empty_cells"],
        "keywords": [
            "PURCHASE ORDER SUMMARY",
            "WIRELESS HEADSET",
            "5,980.00",
            "10,392.00",
            "13,322.00",
            "NET 30",
        ],
        "fields": {
            "order": "PO-2026-8841",
            "product": "WIRELESS HEADSET",
            "unit_price": "5,980.00",
            "amount": "10,392.00",
            "total": "13,322.00",
        },
        "text": " ".join(" ".join(cell for cell in row if cell) for row in rows),
        "tables": [{"rows": rows}],
        "conditions": {"mode": "structure"},
    }
    return image, truth


def skewed_photo() -> tuple[np.ndarray, dict]:
    image = blank(1300, 1700)
    draw_text(image, 100, 120, "CUSTOMER INVOICE", SCALE + 1)
    draw_text(image, 100, 170, "CUSTOMER: SHANGHAI ACME TECHNOLOGY LTD", SCALE)
    draw_text(image, 100, 230, "INVOICE #INV-2026-0042", SCALE)
    draw_text(image, 100, 290, "DATE: 2026-10-28", SCALE)
    draw_text(image, 100, 350, "TOTAL: 128,500.00 CNY", SCALE)
    draw_text(image, 100, 410, "STATUS: PAID", SCALE)
    rows = [
        ["ITEM", "QTY", "AMOUNT"],
        ["CONSULTING", "12", "84,000.00"],
        ["SUPPORT", "1", "44,500.00"],
    ]
    draw_table(image, 100, 520, rows, [420, 160, 300], 80, SCALE - 1)
    draw_paragraph(
        image,
        100,
        900,
        980,
        "THANK YOU FOR YOUR BUSINESS. PLEASE KEEP THIS DOCUMENT FOR YOUR RECORDS.",
    )
    rotated = rotate(image, 4.5)
    rot_h, rot_w = rotated.shape
    ys, xs = np.mgrid[0:rot_h, 0:rot_w]
    light = 0.72 + 0.3 * (xs / max(1, rot_w - 1))
    shadow = np.clip(1.0 - 0.25 * (ys / max(1, rot_h - 1)), 0.65, 1.0)
    shaded = np.clip(rotated.astype(np.float32) * light * shadow, 0, 255).astype(np.uint8)
    noisy = add_noise(low_contrast(shaded, 0.82, 42), 9, seed=42)
    truth = {
        "kind": "image-skewed",
        "lang": "en",
        "difficulty": "severe",
        "degradations": ["rotation", "perspective", "low_contrast", "noise"],
        "text": (
            "CUSTOMER INVOICE CUSTOMER: SHANGHAI ACME TECHNOLOGY LTD "
            "INVOICE #INV-2026-0042 DATE: 2026-10-28 TOTAL: 128,500.00 CNY "
            "STATUS: PAID ITEM QTY AMOUNT CONSULTING 12 84,000.00 SUPPORT 1 44,500.00 "
            "THANK YOU FOR YOUR BUSINESS. PLEASE KEEP THIS DOCUMENT FOR YOUR RECORDS."
        ),
        "keywords": ["SHANGHAI ACME", "INV-2026-0042", "128,500.00", "PAID"],
        "fields": {
            "customer": "SHANGHAI ACME TECHNOLOGY LTD",
            "invoice": "INV-2026-0042",
            "date": "2026-10-28",
            "total": "128,500.00",
            "status": "PAID",
        },
        "conditions": {"mode": "enhanced"},
    }
    return noisy, truth


def fax_report() -> tuple[np.ndarray, dict]:
    image = blank(1000, 1500, 250)
    draw_text(image, 70, 70, "FAX TRANSMISSION COVER", SCALE)
    draw_text(image, 70, 110, "TO: OPS TEAM", SCALE - 1)
    draw_text(image, 70, 145, "FROM: EAST REGION", SCALE - 1)
    draw_text(image, 70, 180, "DATE: 2026-10-28", SCALE - 1)
    draw_text(image, 70, 240, "QUARTERLY REVENUE REPORT 2026 Q3", SCALE)
    body = (
        "TOTAL REVENUE REACHED 1,280,500 CNY, UP 18.5% YEAR OVER YEAR. "
        "EAST CHINA REMAINS THE LARGEST REGION. CUSTOMER COUNT GROWTH WAS 4,210."
    )
    draw_paragraph(image, 70, 300, 860, body)
    rows = [
        ["REGION", "REVENUE", "GROWTH"],
        ["EAST", "640,250", "20.1%"],
        ["SOUTH", "384,150", "17.2%"],
        ["NORTH", "256,100", "15.8%"],
    ]
    draw_table(image, 70, 560, rows, [260, 300, 260], 80, SCALE - 1)
    draw_paragraph(
        image,
        70,
        980,
        860,
        "THIS FAX IS CONFIDENTIAL. IF RECEIVED IN ERROR PLEASE NOTIFY OPERATIONS IMMEDIATELY.",
    )
    degraded = fax_degrade(image, seed=7)
    truth = {
        "kind": "image-fax",
        "lang": "en",
        "difficulty": "severe",
        "degradations": ["fax", "speckle", "low_resolution"],
        "text": (
            "FAX TRANSMISSION COVER TO: OPS TEAM FROM: EAST REGION DATE: 2026-10-28 "
            "QUARTERLY REVENUE REPORT 2026 Q3 "
            + body
            + " REGION REVENUE GROWTH EAST 640,250 20.1% SOUTH 384,150 17.2% "
            "NORTH 256,100 15.8% THIS FAX IS CONFIDENTIAL. IF RECEIVED IN ERROR "
            "PLEASE NOTIFY OPERATIONS IMMEDIATELY."
        ),
        "keywords": ["FAX TRANSMISSION", "1,280,500", "18.5%", "640,250", "4,210"],
        "fields": {
            "report": "QUARTERLY REVENUE REPORT",
            "total": "1,280,500",
            "growth": "18.5%",
            "customers": "4,210",
        },
    }
    return degraded, truth


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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", default="benchmarks/ocr", help="corpus directory")
    parser.add_argument("--check", action="store_true", help="verify hashes without rewriting")
    args = parser.parse_args()

    corpus = Path(args.dir)
    corpus.mkdir(parents=True, exist_ok=True)
    truth_path = corpus / "ground_truth.json"
    truth = json.loads(truth_path.read_text(encoding="utf8")) if truth_path.exists() else {}

    generators = {
        "multicolumn.png": multi_column,
        "complex_table.png": complex_table,
        "skewed_photo.png": skewed_photo,
        "fax.png": fax_report,
    }
    changed = False
    for name, factory in generators.items():
        path = corpus / name
        if args.check:
            entry = truth.get(name, {})
            expected = (entry.get("provenance") or {}).get("sha256")
            actual = sha256_of(path) if path.exists() else None
            status = "ok" if expected == actual else "mismatch"
            print(f"{name}: {status}")
            changed = changed or status != "ok"
            continue
        image, entry = factory()
        write_png(path, image)
        truth[name] = enrich(entry, path)
        changed = True
        print(f"wrote {path} ({image.shape[1]}x{image.shape[0]})")

    if args.check:
        return 1 if changed else 0
    truth_path.write_text(
        json.dumps(truth, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf8",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
