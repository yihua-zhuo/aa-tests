#!/usr/bin/env python3
"""Generate a reproducible OCR pack for ultra-wide tables and merged headers.

The pack targets the Phase 1 gap "ultra-wide tables and complex merged cells".
Everything is synthetic and dependency-free apart from numpy: images are drawn
with a bitmap font and encoded as PNG with zlib, and the optional text-layer PDF
is assembled byte-by-byte with the built-in Helvetica base font.

Usage:
  PYTHONDONTWRITEBYTECODE=1 python3 scripts/generate_wide_table_corpus.py \
      [--dir benchmarks/corpus-v2/wide-tables] [--check]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import zlib
from pathlib import Path

import numpy as np

SCALE = 2
GLYPH_ADVANCE = 6
PAPER = 246
INK = 28
ANNOTATED_AT = "2026-10-31T00:00:00Z"
GENERATOR = "scripts/generate_wide_table_corpus.py"

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


def draw_line(image: np.ndarray, x1: int, y1: int, x2: int, y2: int, ink: int = INK) -> None:
    steps = max(abs(x2 - x1), abs(y2 - y1), 1)
    for step in range(steps + 1):
        ratio = step / steps
        x = round(x1 + (x2 - x1) * ratio)
        y = round(y1 + (y2 - y1) * ratio)
        if 0 <= y < image.shape[0] and 0 <= x < image.shape[1]:
            image[y, x] = ink


# ---------------------------------------------------------------------------
# Wide table model
# ---------------------------------------------------------------------------

# A spanned cell is (text, column_span). Levels are rendered top-down.
SpanCell = tuple[str, int]


class TableSpec:
    def __init__(
        self,
        levels: list[list[SpanCell]],
        data: list[list[str]],
        total: list[SpanCell] | None,
        widths: list[int],
        aligns: list[str],
    ) -> None:
        self.levels = levels
        self.data = data
        self.total = total
        self.widths = widths
        self.aligns = aligns
        self.columns = len(widths)
        for row in levels:
            self._validate_spans(row)
        for row in data:
            if len(row) != self.columns:
                raise ValueError(f"data row has {len(row)} cells, expected {self.columns}")
        if total is not None:
            self._validate_spans(total)

    def _validate_spans(self, cells: list[SpanCell]) -> None:
        span = sum(item[1] for item in cells)
        if span != self.columns:
            raise ValueError(f"header/total spans {span} columns, expected {self.columns}")

    @staticmethod
    def _expand(cells: list[SpanCell]) -> list[str]:
        row: list[str] = []
        for text, span in cells:
            row.append(text)
            row.extend([""] * (span - 1))
        return row

    def truth_rows(self) -> list[list[str]]:
        rows = [self._expand(level) for level in self.levels]
        rows.extend([list(row) for row in self.data])
        if self.total is not None:
            rows.append(self._expand(self.total))
        return rows

    def render_rows(self) -> list[list[SpanCell]]:
        rows = [list(level) for level in self.levels]
        rows.extend([[(cell, 1) for cell in row] for row in self.data])
        if self.total is not None:
            rows.append(list(self.total))
        return rows

    def merged_cells(self) -> list[dict]:
        cells: list[dict] = []
        for row_index, level in enumerate(self.levels):
            column = 0
            for text, span in level:
                if span > 1:
                    cells.append(
                        {
                            "row": row_index,
                            "column": column,
                            "text": text,
                            "rowSpan": 1,
                            "columnSpan": span,
                        }
                    )
                column += span
        if self.total is not None:
            row_index = len(self.levels) + len(self.data)
            column = 0
            for text, span in self.total:
                if span > 1:
                    cells.append(
                        {
                            "row": row_index,
                            "column": column,
                            "text": text,
                            "rowSpan": 1,
                            "columnSpan": span,
                        }
                    )
                column += span
        return cells


def draw_table(
    image: np.ndarray,
    x: int,
    y: int,
    spec: TableSpec,
    header_height: int,
    body_height: int,
    scale: int = SCALE,
) -> int:
    total_width = sum(spec.widths)
    starts = [0]
    for width in spec.widths:
        starts.append(starts[-1] + width)
    rows = spec.render_rows()
    top = y
    for row_index, cells in enumerate(rows):
        height = header_height if row_index < len(spec.levels) else body_height
        draw_line(image, x, top, x + total_width, top)
        column = 0
        for text, span in cells:
            left = x + starts[column]
            right = x + starts[column + span]
            if text:
                width = text_width(text, scale)
                available = right - left - 8
                if width > available:
                    raise ValueError(
                        f"cell {text!r} is {width}px wide but only {available}px fit "
                        f"(row {row_index}, column {column})"
                    )
                if row_index < len(spec.levels):
                    align = "center"
                else:
                    align = spec.aligns[column] if column < len(spec.aligns) else "center"
                if align == "right":
                    text_x = right - width - 4
                elif align == "left":
                    text_x = left + 4
                else:
                    text_x = left + (right - left - width) // 2
                text_y = top + (height - 7 * scale) // 2
                draw_text(image, text_x, text_y, text, scale)
            draw_line(image, x + starts[column + span], top, x + starts[column + span], top + height)
            column += span
        draw_line(image, x, top + height, x + total_width, top + height)
        top += height
    draw_line(image, x, y, x, top)
    draw_line(image, x + total_width, y, x + total_width, top)
    return top


# ---------------------------------------------------------------------------
# Raster effects and PNG output
# ---------------------------------------------------------------------------


def add_noise(image: np.ndarray, sigma: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    noise = rng.normal(0.0, sigma, image.shape)
    return np.clip(image.astype(np.float32) + noise, 0, 255).astype(np.uint8)


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


# ---------------------------------------------------------------------------
# Pack content
# ---------------------------------------------------------------------------

INVENTORY_WIDTHS = [110, 230, 130, 120, 100, 100, 80, 130, 140, 100, 120, 240]
INVENTORY_ALIGNS = [
    "left", "left", "left", "left", "right", "right",
    "right", "right", "right", "right", "left", "left",
]
INVENTORY_LEVELS: list[list[SpanCell]] = [
    [("PRODUCT", 3), ("SUPPLY", 3), ("PRICING", 3), ("STATUS", 3)],
    [
        ("SKU", 1), ("DESCRIPTION", 1), ("CATEGORY", 1), ("WAREHOUSE", 1),
        ("ON HAND", 1), ("REORDER", 1), ("QTY", 1), ("UNIT PRICE", 1),
        ("AMOUNT", 1), ("LEAD", 1), ("SUPPLIER", 1), ("NOTE", 1),
    ],
]
INVENTORY_DATA = [
    ["A-1001", "WIRELESS HEADSET", "AUDIO", "EAST", "42", "10", "2", "5,980.00", "11,960.00", "5", "ACME", ""],
    ["A-1002", "DOCKING STATION", "ACCESSORY", "EAST", "18", "6", "1", "2,450.00", "2,450.00", "7", "ACME", ""],
    ["A-1003", "USB-C CABLE 2M", "CABLE", "SOUTH", "240", "80", "4", "120.00", "480.00", "3", "BETA", ""],
    ["A-1004", "MONITOR STAND", "ACCESSORY", "WEST", "0", "12", "", "890.00", "", "14", "GAMMA", "BACKORDER"],
    ["A-1005", "WEBCAM 1080P", "VIDEO", "EAST", "35", "15", "3", "1,280.00", "3,840.00", "6", "ACME", ""],
    ["A-1006", "KEYBOARD", "INPUT", "NORTH", "76", "20", "5", "450.00", "2,250.00", "4", "DELTA", ""],
    ["A-1007", "HEADSET STAND", "AUDIO", "SOUTH", "54", "10", "", "320.00", "", "9", "BETA", ""],
    ["A-1008", "HDMI CABLE 3M", "CABLE", "WEST", "120", "40", "6", "95.00", "570.00", "3", "GAMMA", ""],
]
INVENTORY_TOTAL: list[SpanCell] = [
    ("TOTAL", 6), ("21", 1), ("", 1), ("21,550.00", 1), ("", 1), ("", 1), ("", 1),
]

LEDGER_WIDTHS = [90, 210, 110, 110, 150, 150, 150, 160, 160, 120, 110, 100, 140, 110]
LEDGER_ALIGNS = [
    "left", "left", "left", "center", "right", "right", "right",
    "right", "right", "right", "center", "left", "center", "left",
]
LEDGER_LEVELS: list[list[SpanCell]] = [
    [("ACCOUNT", 4), ("PERIOD", 3), ("BALANCE", 4), ("REVIEW", 3)],
    [
        ("CODE", 1), ("NAME", 1), ("TYPE", 1), ("CURRENCY", 1),
        ("OPENING", 1), ("DEBIT", 1), ("CREDIT", 1), ("CLOSING", 1),
        ("AVAILABLE", 1), ("HOLD", 1), ("STATUS", 1), ("OWNER", 1),
        ("DATE", 1), ("FLAG", 1),
    ],
]
LEDGER_DATA = [
    ["1000", "CASH", "ASSET", "USD", "125,000.00", "18,500.00", "7,250.00", "136,250.00", "136,250.00", "0.00", "OPEN", "FIN", "2026-10-31", ""],
    ["1100", "RECEIVABLES", "ASSET", "USD", "84,300.00", "12,400.00", "9,800.00", "86,900.00", "81,900.00", "5,000.00", "HOLD", "FIN", "2026-10-30", "REVIEW"],
    ["2000", "PAYABLES", "LIAB", "USD", "42,750.00", "6,200.00", "15,300.00", "51,850.00", "51,850.00", "0.00", "OPEN", "OPS", "2026-10-31", ""],
    ["3000", "EQUITY", "EQUITY", "USD", "210,000.00", "0.00", "0.00", "210,000.00", "210,000.00", "0.00", "OPEN", "FIN", "2026-10-29", ""],
    ["4000", "REVENUE", "INCOME", "USD", "0.00", "128,500.00", "0.00", "128,500.00", "128,500.00", "0.00", "OPEN", "SALES", "2026-10-31", ""],
    ["5000", "COGS", "EXPENSE", "USD", "0.00", "64,250.00", "0.00", "64,250.00", "64,250.00", "0.00", "OPEN", "OPS", "2026-10-31", ""],
    ["6000", "PAYROLL", "EXPENSE", "USD", "0.00", "22,800.00", "0.00", "22,800.00", "20,300.00", "2,500.00", "HOLD", "HR", "2026-10-28", "CHECK"],
    ["7000", "TRAVEL", "EXPENSE", "USD", "0.00", "3,450.00", "0.00", "3,450.00", "3,450.00", "0.00", "OPEN", "OPS", "2026-10-27", ""],
]
LEDGER_TOTAL: list[SpanCell] = [
    ("TOTAL", 4), ("462,050.00", 1), ("256,100.00", 1), ("32,350.00", 1),
    ("704,000.00", 1), ("", 1), ("", 1), ("", 1), ("", 1), ("", 1), ("", 1),
]

ORDER_WIDTHS = [180, 120, 230, 100, 80, 80, 130, 90, 140, 120, 150, 280]
ORDER_ALIGNS = [
    "left", "left", "left", "left", "right", "center", "right",
    "right", "right", "right", "right", "left",
]
ORDER_LEVELS: list[list[SpanCell]] = [
    [("ORDER", 2), ("PRODUCT", 2), ("QUANTITY", 2), ("PRICE", 3), ("AMOUNT", 3)],
    [
        ("PO", 1), ("SKU", 1), ("DESCRIPTION", 1), ("DEPT", 1),
        ("QTY", 1), ("UOM", 1), ("UNIT PRICE", 1), ("DISC %", 1),
        ("NET PRICE", 1), ("TAX", 1), ("AMOUNT", 1), ("NOTE", 1),
    ],
]
ORDER_PAGE_1 = [
    ["PO-2026-8841", "A-1001", "WIRELESS HEADSET", "IT", "2", "EA", "5,980.00", "0", "5,980.00", "598.00", "12,558.00", ""],
    ["PO-2026-8841", "A-1002", "DOCKING STATION", "IT", "1", "EA", "2,450.00", "5", "2,327.50", "232.75", "2,560.25", ""],
    ["PO-2026-8841", "A-1003", "USB-C CABLE 2M", "OPS", "4", "EA", "120.00", "0", "120.00", "48.00", "528.00", ""],
    ["PO-2026-8841", "A-1005", "WEBCAM 1080P", "IT", "3", "EA", "1,280.00", "10", "1,152.00", "345.60", "3,801.60", ""],
    ["PO-2026-8841", "A-1006", "KEYBOARD", "OPS", "5", "EA", "450.00", "0", "450.00", "225.00", "2,475.00", ""],
    ["PO-2026-8841", "A-1008", "HDMI CABLE 3M", "OPS", "6", "EA", "95.00", "0", "95.00", "57.00", "627.00", ""],
]
ORDER_PAGE_2 = [
    ["PO-2026-8842", "A-1004", "MONITOR STAND", "OPS", "2", "EA", "890.00", "0", "890.00", "178.00", "1,958.00", ""],
    ["PO-2026-8842", "A-1007", "HEADSET STAND", "IT", "3", "EA", "320.00", "5", "304.00", "91.20", "1,003.20", ""],
    ["PO-2026-8842", "B-2001", "LABEL PRINTER", "OPS", "1", "EA", "3,450.00", "0", "3,450.00", "345.00", "3,795.00", ""],
    ["PO-2026-8842", "B-2002", "THERMAL ROLL", "OPS", "12", "RL", "18.00", "0", "18.00", "21.60", "237.60", ""],
    ["PO-2026-8842", "B-2003", "PACKING TAPE", "OPS", "24", "RL", "6.50", "0", "6.50", "15.60", "171.60", ""],
    ["PO-2026-8842", "B-2004", "SHIPPING BOX", "OPS", "50", "EA", "2.20", "0", "2.20", "11.00", "121.00", ""],
]
ORDER_TOTAL_1: list[SpanCell] = [
    ("PAGE TOTAL", 4), ("21", 1), ("", 1), ("", 1), ("", 1), ("", 1),
    ("", 1), ("22,549.85", 1), ("", 1),
]
ORDER_TOTAL_2: list[SpanCell] = [
    ("PAGE TOTAL", 4), ("92", 1), ("", 1), ("", 1), ("", 1), ("", 1),
    ("", 1), ("7,286.40", 1), ("", 1),
]

PDF_WIDTHS = [70, 60, 130, 55, 45, 45, 75, 55, 70, 107]
PDF_ALIGNS = ["left", "left", "left", "left", "right", "center", "right", "right", "right", "right"]
PDF_LEVELS: list[list[SpanCell]] = [
    [("ORDER", 2), ("PRODUCT", 2), ("QUANTITY", 2), ("PRICING", 4)],
    [
        ("PO", 1), ("SKU", 1), ("DESCRIPTION", 1), ("DEPT", 1),
        ("QTY", 1), ("UOM", 1), ("UNIT PRICE", 1), ("DISC", 1),
        ("TAX", 1), ("AMOUNT", 1),
    ],
]
PDF_DATA = [
    ["PO-2026-8842", "B-2001", "LABEL PRINTER", "OPS", "1", "EA", "3,450.00", "0", "345.00", "3,795.00"],
    ["PO-2026-8842", "B-2002", "THERMAL ROLL", "OPS", "12", "RL", "18.00", "0", "21.60", "237.60"],
    ["PO-2026-8842", "B-2003", "PACKING TAPE", "OPS", "24", "RL", "6.50", "0", "15.60", "171.60"],
    ["PO-2026-8842", "B-2004", "SHIPPING BOX", "OPS", "50", "EA", "2.20", "0", "11.00", "121.00"],
    ["PO-2026-8842", "B-2005", "BUBBLE WRAP", "OPS", "8", "RL", "24.00", "5", "18.24", "200.64"],
    ["PO-2026-8842", "B-2006", "SAFETY GLOVES", "OPS", "20", "PR", "4.50", "0", "9.00", "99.00"],
    ["PO-2026-8842", "B-2007", "BOX CUTTER", "OPS", "4", "EA", "8.75", "0", "3.50", "38.50"],
    ["PO-2026-8842", "B-2008", "PALLET WRAP", "OPS", "6", "RL", "32.00", "10", "17.28", "190.08"],
]
PDF_TOTAL: list[SpanCell] = [
    ("TOTAL", 4), ("125", 1), ("", 1), ("", 1), ("", 1), ("", 1), ("4,853.42", 1),
]


def table_text(rows: list[list[str]]) -> str:
    return " ".join(cell for row in rows for cell in row if cell)


def inventory_spec() -> TableSpec:
    return TableSpec(INVENTORY_LEVELS, INVENTORY_DATA, INVENTORY_TOTAL, INVENTORY_WIDTHS, INVENTORY_ALIGNS)


def ledger_spec() -> TableSpec:
    return TableSpec(LEDGER_LEVELS, LEDGER_DATA, LEDGER_TOTAL, LEDGER_WIDTHS, LEDGER_ALIGNS)


def order_spec(page_rows: list[list[str]], total: list[SpanCell]) -> TableSpec:
    return TableSpec(ORDER_LEVELS, page_rows, total, ORDER_WIDTHS, ORDER_ALIGNS)


def pdf_spec() -> TableSpec:
    return TableSpec(PDF_LEVELS, PDF_DATA, PDF_TOTAL, PDF_WIDTHS, PDF_ALIGNS)


def truth_entry(
    spec: TableSpec,
    *,
    difficulty: str,
    degradations: list[str],
    keywords: list[str],
    fields: dict[str, str],
    text: str,
    conditions: dict[str, str],
    extra_tables: list[TableSpec] | None = None,
) -> dict:
    specs = [spec] + (extra_tables or [])
    tables = []
    for item in specs:
        tables.append({"rows": item.truth_rows(), "cells": item.merged_cells()})
    return {
        "kind": "table",
        "lang": "en",
        "difficulty": difficulty,
        "degradations": degradations,
        "keywords": keywords,
        "fields": fields,
        "text": text,
        "tables": tables,
        "conditions": conditions,
    }


# ---------------------------------------------------------------------------
# Raster pack members
# ---------------------------------------------------------------------------


def inventory_png() -> tuple[np.ndarray, dict]:
    image = blank(1700, 900)
    draw_text(image, 50, 40, "WIDE INVENTORY TABLE - WAREHOUSE 07", scale=3)
    draw_text(image, 50, 92, "PERIOD 2026 Q3 - CURRENCY USD", scale=2)
    spec = inventory_spec()
    draw_table(image, 50, 150, spec, header_height=56, body_height=48)
    draw_text(image, 50, 790, "PRICES INCLUDE STANDARD DISCOUNT. VERIFY BACKORDER LINES.", scale=2)
    rows = spec.truth_rows()
    text = (
        "WIDE INVENTORY TABLE - WAREHOUSE 07 PERIOD 2026 Q3 - CURRENCY USD "
        + table_text(rows)
        + " PRICES INCLUDE STANDARD DISCOUNT. VERIFY BACKORDER LINES."
    )
    truth = truth_entry(
        spec,
        difficulty="moderate",
        degradations=["wide_table", "merged_cells", "empty_cells", "dense_text"],
        keywords=[
            "WIDE INVENTORY TABLE",
            "WAREHOUSE 07",
            "WIRELESS HEADSET",
            "21,550.00",
            "BACKORDER",
            "MONITOR STAND",
        ],
        fields={
            "sku": "A-1001",
            "product": "WIRELESS HEADSET",
            "quantity": "21",
            "unit_price": "5,980.00",
            "amount": "11,960.00",
            "total": "21,550.00",
        },
        text=text,
        conditions={"mode": "structure"},
    )
    return image, truth


def ledger_png() -> tuple[np.ndarray, dict]:
    image = blank(2000, 900)
    draw_text(image, 40, 40, "WIDE GENERAL LEDGER - MULTI-LEVEL HEADERS", scale=3)
    draw_text(image, 40, 92, "PERIOD 2026-10 - CURRENCY USD - ALL AMOUNTS ROUNDED", scale=2)
    spec = ledger_spec()
    draw_table(image, 40, 150, spec, header_height=56, body_height=48)
    draw_text(image, 40, 790, "HOLD AMOUNTS REQUIRE REVIEW BEFORE PERIOD CLOSE.", scale=2)
    rows = spec.truth_rows()
    text = (
        "WIDE GENERAL LEDGER - MULTI-LEVEL HEADERS "
        "PERIOD 2026-10 - CURRENCY USD - ALL AMOUNTS ROUNDED "
        + table_text(rows)
        + " HOLD AMOUNTS REQUIRE REVIEW BEFORE PERIOD CLOSE."
    )
    truth = truth_entry(
        spec,
        difficulty="moderate",
        degradations=["wide_table", "merged_cells", "empty_cells", "dense_text"],
        keywords=[
            "WIDE GENERAL LEDGER",
            "MULTI-LEVEL HEADERS",
            "RECEIVABLES",
            "704,000.00",
            "256,100.00",
            "REVIEW",
        ],
        fields={
            "account": "CASH",
            "account_code": "1000",
            "period": "2026-10",
            "closing_balance": "136,250.00",
            "total_debit": "256,100.00",
            "total_credit": "32,350.00",
            "total_closing": "704,000.00",
        },
        text=text,
        conditions={"mode": "structure"},
    )
    return image, truth


def order_png() -> tuple[np.ndarray, dict]:
    image = blank(1800, 1500)
    page_1 = order_spec(ORDER_PAGE_1, ORDER_TOTAL_1)
    page_2 = order_spec(ORDER_PAGE_2, ORDER_TOTAL_2)

    draw_text(image, 50, 35, "PURCHASE ORDER CONTINUATION - PAGE 1 OF 2", scale=3)
    draw_text(image, 50, 88, "HEADER REPEATS AFTER THE PAGE BREAK - CURRENCY USD", scale=2)
    draw_table(image, 50, 150, page_1, header_height=50, body_height=50)

    draw_line(image, 50, 690, 1750, 690)
    draw_text(image, 50, 712, "PAGE BREAK - CONTINUED ON PAGE 2 - HEADER REPEATS BELOW", scale=2)
    draw_line(image, 50, 750, 1750, 750)

    draw_text(image, 50, 780, "PURCHASE ORDER CONTINUATION - PAGE 2 OF 2", scale=3)
    draw_text(image, 50, 833, "HEADER REPEATED - CURRENCY USD", scale=2)
    draw_table(image, 50, 890, page_2, header_height=50, body_height=50)
    draw_text(image, 50, 1370, "GRAND TOTAL 29,836.25 - TOTAL QUANTITY 113", scale=2)
    draw_text(image, 50, 1420, "SIGNED OFF BY PROCUREMENT OPERATIONS ON 2026-10-31", scale=2)

    text = (
        "PURCHASE ORDER CONTINUATION - PAGE 1 OF 2 "
        "HEADER REPEATS AFTER THE PAGE BREAK - CURRENCY USD "
        + table_text(page_1.truth_rows())
        + " PAGE BREAK - CONTINUED ON PAGE 2 - HEADER REPEATS BELOW "
        + "PURCHASE ORDER CONTINUATION - PAGE 2 OF 2 HEADER REPEATED - CURRENCY USD "
        + table_text(page_2.truth_rows())
        + " GRAND TOTAL 29,836.25 - TOTAL QUANTITY 113 "
        + "SIGNED OFF BY PROCUREMENT OPERATIONS ON 2026-10-31"
    )
    truth = truth_entry(
        page_1,
        difficulty="severe",
        degradations=[
            "wide_table",
            "merged_cells",
            "empty_cells",
            "dense_text",
            "page_continuation",
            "repeated_header",
        ],
        keywords=[
            "PURCHASE ORDER CONTINUATION",
            "PAGE BREAK",
            "PO-2026-8841",
            "PO-2026-8842",
            "29,836.25",
            "22,549.85",
            "7,286.40",
        ],
        fields={
            "order": "PO-2026-8841",
            "continuation_order": "PO-2026-8842",
            "quantity": "113",
            "page_1_total": "22,549.85",
            "page_2_total": "7,286.40",
            "total": "29,836.25",
        },
        text=text,
        conditions={"mode": "structure"},
        extra_tables=[page_2],
    )
    return image, truth


# ---------------------------------------------------------------------------
# PDF writer (PDF 1.4, Helvetica base fonts, real text layer)
# ---------------------------------------------------------------------------


def pdf_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def pdf_approx_width(text: str, size: float) -> float:
    # Helvetica digits are 0.556 em; uppercase letters average about 0.68 em.
    width = 0.0
    for char in text:
        if char.isdigit() or char in ".,%- ":
            width += 0.556
        elif char.isupper():
            width += 0.70
        else:
            width += 0.60
    return width * size


def build_pdf() -> tuple[bytes, dict]:
    spec = pdf_spec()
    rows = spec.render_rows()
    widths = PDF_WIDTHS
    total_width = sum(widths)
    x0 = 40.0
    top = 530.0
    header_height = 17.0
    body_height = 17.0

    lines: list[str] = ["0.6 w", "0 0 0 RG"]

    def line(x1: float, y1: float, x2: float, y2: float) -> None:
        lines.append(f"{x1:.2f} {y1:.2f} m {x2:.2f} {y2:.2f} l S")

    def text(x: float, y: float, value: str, size: float = 7.0, bold: bool = False) -> None:
        font = "F2" if bold else "F1"
        lines.append(f"BT /{font} {size:.2f} Tf {x:.2f} {y:.2f} Td ({pdf_escape(value)}) Tj ET")

    text(x0, 578, "WIDE TABLE - QUARTERLY SUPPLY SUMMARY", size=12, bold=True)
    text(x0, 562, "PERIOD 2026 Q3 - CURRENCY USD - PDF TEXT LAYER WITH HELVETICA", size=8)

    starts = [0.0]
    for width in widths:
        starts.append(starts[-1] + width)

    current_top = top
    for row_index, cells in enumerate(rows):
        height = header_height if row_index < len(spec.levels) else body_height
        line(x0, current_top, x0 + total_width, current_top)
        column = 0
        for value, span in cells:
            left = x0 + starts[column]
            right = x0 + starts[column + span]
            if value:
                size = 7.0
                width = pdf_approx_width(value, size)
                if row_index < len(spec.levels):
                    align = "center"
                else:
                    align = spec.aligns[column] if column < len(spec.aligns) else "center"
                if align == "right":
                    text_x = right - width - 3
                elif align == "left":
                    text_x = left + 3
                else:
                    text_x = left + (right - left - width) / 2
                text(text_x, current_top - 11.5, value, size=size, bold=row_index < len(spec.levels))
            line(right, current_top, right, current_top - height)
            column += span
        line(x0, current_top - height, x0 + total_width, current_top - height)
        current_top -= height

    line(x0, top, x0, current_top)
    line(x0 + total_width, top, x0 + total_width, current_top)
    text(x0, 330, "GENERATED FOR OCR BENCHMARK - SYNTHETIC DATA", size=7)

    stream = ("\n".join(lines) + "\n").encode("ascii")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 792 612] "
            b"/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>"
        ),
        (
            b"<< /Length "
            + str(len(stream)).encode("ascii")
            + b" >>\nstream\n"
            + stream
            + b"endstream"
        ),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    ]

    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for index, obj in enumerate(objects, start=1):
        offsets.append(len(output))
        output += f"{index} 0 obj\n".encode("ascii") + obj + b"\nendobj\n"
    xref_offset = len(output)
    output += f"xref\n0 {len(objects) + 1}\n".encode("ascii")
    output += b"0000000000 65535 f \n"
    for offset in offsets:
        output += f"{offset:010d} 00000 n \n".encode("ascii")
    output += (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n"
    ).encode("ascii")

    rows_truth = spec.truth_rows()
    text_value = (
        "WIDE TABLE - QUARTERLY SUPPLY SUMMARY "
        "PERIOD 2026 Q3 - CURRENCY USD - PDF TEXT LAYER WITH HELVETICA "
        + table_text(rows_truth)
        + " GENERATED FOR OCR BENCHMARK - SYNTHETIC DATA"
    )
    truth = truth_entry(
        spec,
        difficulty="moderate",
        degradations=["wide_table", "merged_cells", "dense_text", "text_layer"],
        keywords=[
            "WIDE TABLE",
            "QUARTERLY SUPPLY SUMMARY",
            "PO-2026-8842",
            "LABEL PRINTER",
            "4,853.42",
        ],
        fields={
            "order": "PO-2026-8842",
            "quantity": "125",
            "amount": "4,853.42",
            "total": "4,853.42",
            "supplier_item": "LABEL PRINTER",
        },
        text=text_value,
        conditions={"mode": "structure"},
    )
    return bytes(output), truth


def verify_pdf(path: Path) -> None:
    data = path.read_bytes()
    if not data.startswith(b"%PDF-1.4"):
        raise ValueError(f"{path.name}: missing PDF-1.4 header")
    if b"%%EOF" not in data[-64:]:
        raise ValueError(f"{path.name}: missing %%EOF trailer")
    if b"/BaseFont /Helvetica" not in data:
        raise ValueError(f"{path.name}: missing Helvetica base font")
    marker = data.rfind(b"startxref")
    if marker < 0:
        raise ValueError(f"{path.name}: missing startxref")
    tail = data[marker:].split(b"\n")
    xref_offset = int(tail[1])
    if not data[xref_offset:].startswith(b"xref\n"):
        raise ValueError(f"{path.name}: startxref does not point at xref")
    lines = data[xref_offset:].split(b"\n")
    count = int(lines[1].split()[1])
    for index in range(1, count):
        entry = lines[2 + index]
        offset = int(entry[:10])
        prefix = f"{index} 0 obj".encode("ascii")
        if not data[offset:].startswith(prefix):
            raise ValueError(f"{path.name}: xref entry {index} points at wrong offset")


# ---------------------------------------------------------------------------
# Generation and verification
# ---------------------------------------------------------------------------


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


def generate(corpus: Path) -> None:
    corpus.mkdir(parents=True, exist_ok=True)
    truth: dict[str, dict] = {}

    clean_image, clean_truth = inventory_png()
    skew_image = add_noise(rotate(clean_image, 1.8), sigma=3.5, seed=1101)
    skew_truth = truth_entry(
        inventory_spec(),
        difficulty="moderate",
        degradations=[
            "wide_table",
            "merged_cells",
            "empty_cells",
            "dense_text",
            "rotation",
            "skew",
            "noise",
        ],
        keywords=clean_truth["keywords"],
        fields=clean_truth["fields"],
        text=clean_truth["text"],
        conditions={"mode": "structure"},
    )

    ledger_image, ledger_truth = ledger_png()
    ledger_skew_image = add_noise(rotate(ledger_image, -2.2), sigma=4.0, seed=2202)
    ledger_skew_truth = truth_entry(
        ledger_spec(),
        difficulty="moderate",
        degradations=[
            "wide_table",
            "merged_cells",
            "empty_cells",
            "dense_text",
            "rotation",
            "skew",
            "noise",
        ],
        keywords=ledger_truth["keywords"],
        fields=ledger_truth["fields"],
        text=ledger_truth["text"],
        conditions={"mode": "structure"},
    )

    order_image, order_truth = order_png()
    pdf_bytes, pdf_truth = build_pdf()

    members: list[tuple[str, bytes | np.ndarray, dict]] = [
        ("wide_inventory_clean.png", clean_image, clean_truth),
        ("wide_inventory_skew.png", skew_image, skew_truth),
        ("wide_ledger_clean.png", ledger_image, ledger_truth),
        ("wide_ledger_skew.png", ledger_skew_image, ledger_skew_truth),
        ("wide_order_continuation.png", order_image, order_truth),
        ("wide_tables.pdf", pdf_bytes, pdf_truth),
    ]

    for name, payload, entry in members:
        path = corpus / name
        if isinstance(payload, np.ndarray):
            write_png(path, payload)
        else:
            path.write_bytes(payload)
        if name.endswith(".pdf"):
            verify_pdf(path)
        truth[name] = enrich(entry, path)
        size = path.stat().st_size
        detail = (
            f"{payload.shape[1]}x{payload.shape[0]}"
            if isinstance(payload, np.ndarray)
            else "pdf"
        )
        print(f"wrote {path.name} ({detail}, {size} bytes)")

    truth_path = corpus / "ground_truth.json"
    truth_path.write_text(
        json.dumps(truth, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf8",
    )
    print(f"wrote {truth_path.name} ({truth_path.stat().st_size} bytes, {len(truth)} entries)")


def check(corpus: Path) -> int:
    truth_path = corpus / "ground_truth.json"
    if not truth_path.exists():
        print(f"missing {truth_path}")
        return 1
    truth = json.loads(truth_path.read_text(encoding="utf8"))
    files = sorted(
        path.name
        for path in corpus.iterdir()
        if path.is_file() and path.name != "ground_truth.json"
    )
    keys = sorted(truth)
    failures = 0

    if files != keys:
        failures += 1
        print("bijection: FAIL")
        print(f"  files only: {sorted(set(files) - set(keys))}")
        print(f"  truth only: {sorted(set(keys) - set(files))}")
    else:
        print(f"bijection: ok ({len(files)} files <-> {len(keys)} truth entries)")

    for name in files:
        entry = truth.get(name)
        if entry is None:
            failures += 1
            continue
        expected = (entry.get("provenance") or {}).get("sha256")
        path = corpus / name
        actual = sha256_of(path)
        status = "ok" if expected == actual else "MISMATCH"
        if expected != actual:
            failures += 1
        print(f"{name}: sha256 {status} ({actual})")
        if "tables" not in entry or not entry["tables"]:
            failures += 1
            print(f"{name}: missing tables truth")
        if name.endswith(".pdf"):
            try:
                verify_pdf(path)
                print(f"{name}: pdf structure ok")
            except ValueError as error:
                failures += 1
                print(f"{name}: pdf INVALID - {error}")

    if failures == 0:
        print("check: ok")
        return 0
    print(f"check: {failures} failure(s)")
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dir",
        default="benchmarks/corpus-v2/wide-tables",
        help="corpus directory",
    )
    parser.add_argument("--check", action="store_true", help="verify hashes and bijection")
    args = parser.parse_args()
    corpus = Path(args.dir)
    if args.check:
        return check(corpus)
    generate(corpus)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
