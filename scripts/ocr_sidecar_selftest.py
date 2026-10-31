#!/usr/bin/env python3
"""Dependency-free checks for DIR routing helpers in ocr_sidecar.py."""

from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import types
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import ocr_sidecar as sidecar  # noqa: E402


def block(number: int, kind: str, text: str, box: tuple[float, float, float, float]) -> dict:
    return sidecar.dir_block(
        f"b{number}",
        kind,
        text,
        sidecar.box_bbox(*box),
        0.9,
        sidecar.dir_source("test", "test", "visual"),
        number,
    )


def check_line_grouping() -> None:
    blocks = [
        block(0, "paragraph", "首页标题", (10, 10, 400, 40)),
        block(1, "paragraph", "正文第一行内容比较长。", (10, 80, 400, 100)),
        block(2, "paragraph", "a=b+c=2", (10, 120, 400, 140)),
        block(3, "paragraph", "页脚注释", (10, 940, 400, 960)),
    ]
    sidecar.classify_text_blocks(blocks, 1000)
    assert blocks[0]["type"] == "heading", blocks[0]
    assert blocks[2]["type"] == "formula", blocks[2]
    assert blocks[3].get("meta", {}).get("region") == "footnote", blocks[3]


def check_mixed_table_routing() -> None:
    result = {
        "rec_texts": ["表单标题", "项目", "金额", "A", "100", "B", "200", "表后说明"],
        "rec_scores": [0.99] * 8,
        "rec_boxes": [
            [10, 10, 300, 30],
            [10, 100, 90, 120],
            [100, 100, 180, 120],
            [10, 130, 90, 150],
            [100, 130, 180, 150],
            [10, 160, 90, 180],
            [100, 160, 180, 180],
            [10, 300, 400, 320],
        ],
    }
    table_bbox = {"x": 0, "y": 90, "width": 200, "height": 100}
    text, _, blocks, _, _ = sidecar.paddle_page_blocks(
        result, 1, "visual", "test", "test", table_hint=True, table_bbox=table_bbox
    )
    kinds = [item["type"] for item in blocks]
    assert kinds == ["paragraph", "table", "paragraph"], kinds
    assert blocks[1]["rows"] == [["项目", "金额"], ["A", "100"], ["B", "200"]]
    cells = blocks[1]["cells"]
    assert [(cell["row"], cell["column"]) for cell in cells] == [
        (0, 0),
        (0, 1),
        (1, 0),
        (1, 1),
        (2, 0),
        (2, 1),
    ], cells
    assert all(cell["confidence"] == 0.99 for cell in cells), cells
    assert cells[0]["bbox"] == {"x": 10, "y": 100, "width": 80, "height": 20}, cells[0]
    assert blocks[0]["text"] == "表单标题"
    assert blocks[2]["text"] == "表后说明"
    assert text.count("表后说明") == 1


def check_table_pred_cells() -> None:
    grid = [["项目", "金额"], ["A", "100"]]
    table = {
        "table_ocr_pred": {
            "rec_texts": ["项目", "金额", "A", "100"],
            "rec_scores": [0.99, 0.98, 0.97, 0.96],
            "rec_boxes": [
                [0, 0, 10, 10],
                [20, 0, 30, 10],
                [0, 20, 10, 30],
                [20, 20, 30, 30],
            ],
        }
    }
    cells = sidecar.table_pred_cells(grid, table)
    assert cells and cells[1]["confidence"] == 0.98, cells
    assert cells[1]["bbox"] == {"x": 20, "y": 0, "width": 10, "height": 10}, cells[1]
    assert sidecar.table_pred_cells(grid, {"table_ocr_pred": {"rec_texts": ["项目"]}}) is None


def check_table_hint_without_region() -> None:
    result = {
        "rec_texts": ["A", "B", "1", "2"],
        "rec_scores": [0.9] * 4,
        "rec_boxes": [[0, 0, 50, 20], [60, 0, 110, 20], [0, 30, 50, 50], [60, 30, 110, 50]],
    }
    _, _, blocks, _, _ = sidecar.paddle_page_blocks(
        result, 1, "visual", "test", "test", table_hint=True
    )
    assert len(blocks) == 1 and blocks[0]["type"] == "table"
    assert len(blocks[0]["cells"]) == 4, blocks[0]["cells"]


def check_colored_regions() -> None:
    blocks = [
        block(0, "paragraph", "普通正文", (0, 0, 300, 40)),
        block(1, "paragraph", "盖章处", (50, 100, 120, 140)),
    ]
    regions = [
        {"label": "stamp", "bbox": sidecar.box_bbox(40, 90, 140, 150), "ratio": 0.01},
        {"label": "signature", "bbox": sidecar.box_bbox(300, 400, 420, 470), "ratio": 0.005},
    ]
    sidecar.attach_colored_regions(
        blocks, regions, 1, sidecar.dir_source("test", "test", "visual")
    )
    assert blocks[1]["type"] == "stamp"
    assert blocks[1]["meta"]["regionSource"] == "color"
    assert blocks[2]["type"] == "signature"
    assert blocks[2]["text"] == ""
    assert blocks[0]["type"] == "paragraph"


class GrayImage:
    """Pure-python stand-in for a PIL grayscale image.

    The ink detector only asks for size, mode conversion, a histogram, proportional
    shrinking and the buffer protocol, so a page can be described as nested lists
    here and the selftest stays free of image dependencies. `thumbnail` keeps the
    darkest pixel of each skipped block, which is what a scan of dark ink on white
    reduces to; the exact resampling filter does not matter to the detector.
    """

    def __init__(self, height: int, width: int, value: int = 240) -> None:
        self._rows = [[value] * width for _ in range(height)]

    @property
    def size(self) -> tuple[int, int]:
        return len(self._rows[0]), len(self._rows)

    def paint(self, box: dict) -> None:
        """Fill a DIR bbox with ink; box coordinates are the pixel grid."""
        top, left = int(box["y"]), int(box["x"])
        for y in range(top, min(len(self._rows), top + int(box["height"]))):
            row = self._rows[y]
            for x in range(left, min(len(row), left + int(box["width"]))):
                row[x] = 20

    def clear(self, box: dict) -> None:
        """Set a DIR bbox back to the page background."""
        top, left = int(box["y"]), int(box["x"])
        for y in range(top, min(len(self._rows), top + int(box["height"]))):
            row = self._rows[y]
            for x in range(left, min(len(row), left + int(box["width"]))):
                row[x] = 240

    def convert(self, mode: str) -> "GrayImage":
        # PIL returns a new image; shrinking must not corrupt the caller's page.
        copy = GrayImage(1, 1)
        copy._rows = [list(row) for row in self._rows]
        return copy

    def thumbnail(self, box: tuple[int, int]) -> None:
        width, height = self.size
        factor = min(box[0] / width, box[1] / height, 1.0)
        if factor >= 1.0:
            return
        rows = []
        for index in range(max(1, int(height * factor))):
            source = self._rows[min(height - 1, int(index / factor))]
            rows.append(
                [
                    source[min(len(source) - 1, int(column / factor))]
                    for column in range(max(1, int(width * factor)))
                ]
            )
        self._rows = rows

    def histogram(self) -> list[int]:
        counts = [0] * 256
        for row in self._rows:
            for value in row:
                counts[value] += 1
        return counts

    def __array__(self, dtype=None, copy=None):  # noqa: ANN001 - numpy protocol
        import numpy as np

        return np.array(self._rows, dtype=dtype or np.uint8)


def check_ink_gaps() -> None:
    if importlib.util.find_spec("numpy") is None:
        return
    source = sidecar.dir_source("test", "test", "visual")
    lines = [
        sidecar.box_bbox(10, 10, 120, 22),
        sidecar.box_bbox(10, 40, 120, 52),
        sidecar.box_bbox(10, 70, 120, 82),
    ]
    missed = sidecar.box_bbox(10, 100, 120, 112)
    image = GrayImage(130, 140)
    for box in [*lines, missed]:
        image.paint(box)

    def recognized(box: dict, index: int) -> dict:
        return sidecar.dir_block(f"p1-b{index}", "paragraph", "文字", box, 0.9, source, index)

    gaps = sidecar.detect_ink_gaps(
        image, [recognized(box, i) for i, box in enumerate(lines)], 1
    )
    assert len(gaps) == 1, gaps
    assert gaps[0]["kind"] == "region", gaps
    assert gaps[0]["blockId"] is None, gaps
    assert abs(gaps[0]["bbox"]["y"] - 100) <= 2, gaps
    assert gaps[0]["pixels"] > 0 and gaps[0]["density"] > 0.5, gaps

    all_covered = [recognized(box, i) for i, box in enumerate([*lines, missed])]
    assert sidecar.detect_ink_gaps(image, all_covered, 1) == []
    # No boxes at all means nothing can be attributed, not that the page is clean.
    assert sidecar.detect_ink_gaps(image, [], 1) is None

    cells = [
        sidecar.box_bbox(10, 10, 60, 24),
        sidecar.box_bbox(70, 10, 120, 24),
        sidecar.box_bbox(10, 40, 60, 54),
    ]
    empty_cell = sidecar.box_bbox(70, 40, 120, 54)
    grid = GrayImage(70, 140)
    for box in [*cells, empty_cell]:
        grid.paint(box)
    table = sidecar.dir_block(
        "p1-t",
        "table",
        "",
        sidecar.box_bbox(5, 5, 125, 60),
        None,
        source,
        0,
        rows=[["a", "b"], ["c", ""]],
        cells=[
            {"row": index // 2, "column": index % 2, "text": "值", "bbox": box}
            for index, box in enumerate(cells)
        ],
    )
    gaps = sidecar.detect_ink_gaps(grid, [table], 1)
    assert len(gaps) == 1, gaps
    assert gaps[0]["kind"] == "cell" and gaps[0]["blockId"] == "p1-t", gaps

    # The other half of the brief: the engine *did* return the cell and read it as
    # empty or as a placeholder. Its borders are explained; ink inside it is not.
    def table_with_last_cell(text: str) -> dict:
        return sidecar.dir_block(
            "p1-t2",
            "table",
            "",
            sidecar.box_bbox(5, 5, 125, 60),
            None,
            source,
            0,
            rows=[["a", "b"], ["c", ""]],
            cells=[
                {"row": index // 2, "column": index % 2, "text": "值", "bbox": box}
                for index, box in enumerate(cells)
            ]
            + [{"row": 1, "column": 1, "text": text, "bbox": empty_cell}],
        )

    for blank_text in ("", "  ", "—", "N/A", "暂无"):
        gaps = sidecar.detect_ink_gaps(grid, [table_with_last_cell(blank_text)], 1)
        assert len(gaps) == 1, (blank_text, gaps)
        assert gaps[0]["kind"] == "cell" and gaps[0]["blockId"] == "p1-t2", (blank_text, gaps)
        assert abs(gaps[0]["bbox"]["y"] - 40) <= 3, gaps

    # A cell that is genuinely empty still carries ruled-line ink, and that alone is
    # not a miss: only the borders are drawn here, so nothing is left unexplained.
    borders = GrayImage(70, 140)
    for box in cells:
        borders.paint(box)
    rules = [
        sidecar.box_bbox(70, 40, 120, 42),
        sidecar.box_bbox(70, 52, 120, 54),
        sidecar.box_bbox(70, 40, 72, 54),
        sidecar.box_bbox(118, 40, 120, 54),
    ]
    for box in rules:
        borders.paint(box)
    assert sidecar.detect_ink_gaps(borders, [table_with_last_cell("")], 1) == [], (
        sidecar.detect_ink_gaps(borders, [table_with_last_cell("")], 1)
    )

    # Ink pixels belong to one component each: a ring must not report the figure
    # inside it as its own, or the same missed text is cropped twice.
    ring_out = sidecar.box_bbox(150, 10, 250, 110)
    ring_in = sidecar.box_bbox(156, 16, 244, 104)
    blob = sidecar.box_bbox(190, 60, 210, 80)
    mixed = GrayImage(140, 260)
    for box in lines:
        mixed.paint(box)
    mixed.paint(ring_out)
    mixed.clear(ring_in)
    mixed.paint(blob)
    blocks = [recognized(box, i) for i, box in enumerate(lines)]
    gaps = sidecar.detect_ink_gaps(mixed, blocks, 1)
    assert len(gaps) == 2, gaps
    painted = 100 * 100 - 88 * 88 + 20 * 20
    assert sum(gap["pixels"] for gap in gaps) <= painted + 4 * 36, gaps
    assert gaps[0]["pixels"] < 2400, gaps
    assert {gap["kind"] for gap in gaps} == {"region"}, gaps

    # A table without per-cell coordinates cannot be attributed, so no gap is
    # invented inside it.
    plain = sidecar.dir_block(
        "p1-p", "table", "", sidecar.box_bbox(5, 5, 125, 60), None, source, 0, rows=[["a", "b"]]
    )
    assert sidecar.detect_ink_gaps(grid, [plain], 1) == []

    # A `table_hint` grouping is one page-sized table whose cells are the recognized
    # lines, so containment would call every missed paragraph an empty cell.
    wide_rows = [sidecar.box_bbox(10, top, 130, top + 12) for top in (10, 40, 70)]
    wide_grid = GrayImage(130, 140)
    for box in [*wide_rows, missed]:
        wide_grid.paint(box)
    wide_table = sidecar.dir_block(
        "p1-t0",
        "table",
        "",
        sidecar.box_bbox(0, 0, 140, 130),
        None,
        source,
        0,
        rows=[["a"], ["b"], ["c"]],
        cells=[
            {"row": index, "column": 0, "text": "值", "bbox": box}
            for index, box in enumerate(wide_rows)
        ],
    )
    gaps = sidecar.detect_ink_gaps(wide_grid, [wide_table], 1)
    assert len(gaps) == 1, gaps
    assert gaps[0]["kind"] == "region" and gaps[0]["blockId"] is None, gaps

    # Shrinking runs on the analysis grid but bboxes, ink counts and thresholds are
    # page space, so a downscaled page has to report the same missed line.
    large = GrayImage(1300, 1400)
    big_lines = [
        sidecar.box_bbox(100, 100, 1200, 150),
        sidecar.box_bbox(100, 400, 1200, 450),
        sidecar.box_bbox(100, 700, 1200, 750),
    ]
    big_missed = sidecar.box_bbox(100, 1000, 1200, 1060)
    for box in [*big_lines, big_missed]:
        large.paint(box)
    large_blocks = [
        sidecar.dir_block(f"p1-b{index}", "paragraph", "文字", box, 0.9, source, index)
        for index, box in enumerate(big_lines)
    ]
    gaps = sidecar.detect_ink_gaps(large, large_blocks, 1)
    assert len(gaps) == 1, gaps
    assert gaps[0]["kind"] == "region", gaps
    assert abs(gaps[0]["bbox"]["y"] - 1000) <= 30, gaps
    assert abs(gaps[0]["bbox"]["height"] - 60) <= 30, gaps
    assert gaps[0]["pixels"] >= 60 * 1100 * 0.5, gaps

    # The knobs: `OCR_INK_MAX_GAPS=0` means off, and `env_int`'s floor of 1 keeps
    # `OCR_INK_MIN_PIXELS=0` from turning every speck of dust into a missed line.
    knobs = {"OCR_INK_MAX_GAPS", "OCR_INK_MIN_PIXELS"}
    previous = {name: os.environ.get(name) for name in knobs}
    try:
        os.environ["OCR_INK_MAX_GAPS"] = "0"
        assert sidecar.detect_ink_gaps(image, blocks, 1) is None
        del os.environ["OCR_INK_MAX_GAPS"]
        assert sidecar.env_int_zero_ok("OCR_INK_MAX_GAPS", 12) == 12
        os.environ["OCR_INK_MAX_GAPS"] = "-2"
        assert sidecar.env_int_zero_ok("OCR_INK_MAX_GAPS", 12) == 0
        os.environ["OCR_INK_MAX_GAPS"] = "nonsense"
        assert sidecar.env_int_zero_ok("OCR_INK_MAX_GAPS", 12) == 12

        dust = GrayImage(140, 260)
        for box in lines:
            dust.paint(box)
        dust.paint(sidecar.box_bbox(150, 60, 152, 62))
        os.environ["OCR_INK_MAX_GAPS"] = "12"
        os.environ["OCR_INK_MIN_PIXELS"] = "0"
        dust_gaps = sidecar.detect_ink_gaps(dust, blocks, 1)
        assert dust_gaps == [], dust_gaps
        os.environ["OCR_INK_MIN_PIXELS"] = "20"
        assert len(sidecar.detect_ink_gaps(mixed, blocks, 1)) == 2
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def check_embedded_image_regions() -> None:
    native = {
        "width": 1000,
        "height": 1400,
        "lines": [
            {"x0": 10, "top": 200, "x1": 300, "bottom": 220},
            {"x0": 10, "top": 240, "x1": 300, "bottom": 260},
            {"x0": 10, "top": 280, "x1": 300, "bottom": 300},
        ],
        "images": [
            {"bbox": sidecar.box_bbox(0, 0, 1000, 1400)},
            {"bbox": sidecar.box_bbox(10, 10, 100, 100)},
            {"bbox": sidecar.box_bbox(10, 150, 400, 350)},
            {"bbox": sidecar.box_bbox(400, 500, 700, 800)},
        ],
    }
    previous = os.environ.get("OCR_HYBRID_IMAGE_MAX_REGIONS")
    os.environ["OCR_HYBRID_IMAGE_MAX_REGIONS"] = "1"
    try:
        regions = sidecar.PaddleEngine._embedded_image_regions(native)
        assert regions == [
            {"x": 400, "y": 500, "width": 300, "height": 300, "type": "stamp"}
        ], regions
        assert (
            sidecar.PaddleEngine._classify_image_region(
                sidecar.box_bbox(50, 100, 800, 400), 1000, 1400, 0.15
            )
            == "chart"
        )
    finally:
        if previous is None:
            os.environ.pop("OCR_HYBRID_IMAGE_MAX_REGIONS", None)
        else:
            os.environ["OCR_HYBRID_IMAGE_MAX_REGIONS"] = previous


def check_text_layer_trust() -> None:
    good = "季度营业收入 18.5%，同比增长 12.3%。客户数 42 家。"
    score, reasons = sidecar.text_layer_trust(good)
    assert score >= 0.6 and reasons == [], (score, reasons)
    assert sidecar.usable_text_layer(good)

    empty_score, empty_reasons = sidecar.text_layer_trust("  \n\t ")
    assert empty_score == 0.0 and empty_reasons == ["empty"], empty_reasons
    short_score, short_reasons = sidecar.text_layer_trust("ABC")
    assert short_score < 0.6 and "short" in short_reasons, (short_score, short_reasons)
    assert not sidecar.usable_text_layer("ABC")

    garbage = good + "\ufffd" * 40
    garbage_score, garbage_reasons = sidecar.text_layer_trust(garbage)
    assert garbage_score < 0.6 and "garbage" in garbage_reasons, (garbage_score, garbage_reasons)
    diluted = good + " " * 200 + "\ufffd" * 5
    diluted_score, _ = sidecar.text_layer_trust(diluted)
    assert diluted_score < 0.6, diluted_score
    private_use, private_reasons = sidecar.text_layer_trust(good + "\ue000" * 5)
    assert private_use < 0.6 and "garbage" in private_reasons, (private_use, private_reasons)
    symbols_score, symbols_reasons = sidecar.text_layer_trust("——" * 20)
    assert symbols_score == 0.0 and "symbols" in symbols_reasons, (
        symbols_score,
        symbols_reasons,
    )

    summary = sidecar.text_layer_summary(
        [sidecar.text_layer_trust(good), sidecar.text_layer_trust(garbage)]
    )
    assert summary["pages"] == 2 and summary["trusted"] == 1, summary
    assert summary["reasons"].get("garbage") == 1, summary

    previous = os.environ.get("OCR_PDF_TEXT_TRUST_MIN")
    os.environ["OCR_PDF_TEXT_TRUST_MIN"] = "3"
    try:
        assert sidecar.text_layer_threshold() == 1.0
        assert sidecar.usable_text_layer(good)
        assert not sidecar.usable_text_layer(garbage)
    finally:
        if previous is None:
            os.environ.pop("OCR_PDF_TEXT_TRUST_MIN", None)
        else:
            os.environ["OCR_PDF_TEXT_TRUST_MIN"] = previous


def check_text_crosscheck() -> None:
    trusted = list(range(10))
    assert sidecar.select_crosscheck_pages(trusted, 0.1, 2) == [5], trusted
    assert sidecar.select_crosscheck_pages(trusted, 1.0, 2) == [0, 9], trusted
    assert sidecar.select_crosscheck_pages(trusted, 0.1, 3) == [5], "ceil(1) wins"
    assert sidecar.select_crosscheck_pages([3, 7], 1.0, 5) == [3, 7]
    assert sidecar.select_crosscheck_pages(trusted, 0.0, 3) == []
    assert sidecar.select_crosscheck_pages([], 1.0, 3) == []
    # Deterministic across calls.
    assert sidecar.select_crosscheck_pages(trusted, 0.6, 5) == sidecar.select_crosscheck_pages(
        trusted, 0.6, 5
    )
    # Numeric-risk pages win a slot even when the rate would skip them.
    assert sidecar.select_crosscheck_pages(trusted, 0.1, 2, priority=[7]) == [7]
    assert sidecar.select_crosscheck_pages(trusted, 1.0, 3, priority=[7, 8]) == [4, 7, 8]
    assert sidecar.select_crosscheck_pages(trusted, 0.1, 2, priority=[99]) == [5]
    ranking = [
        {"text": "无数字"},
        {"text": "金额 1,200.00"},
        {"text": "1 2 3"},
        {"text": ""},
    ]
    assert sidecar.crosscheck_priority_pages(ranking, [0, 1, 2, 3]) == [2, 1]
    assert sidecar.crosscheck_numeric_tokens("金额 1,200.00 与 １，３００") == [
        "1200.00",
        "1300",
    ]

    assert sidecar.text_similarity("季度 收入 18.5%", "季度收入18.5%") == 1.0
    assert sidecar.text_similarity("", "  ") == 1.0
    assert sidecar.text_similarity("abc", "") == 0.0
    partial = sidecar.text_similarity("营业收入 18.5%", "营业收入 16.5%")
    assert 0.8 <= partial < 1.0, partial

    record = sidecar.crosscheck_record(3, "营业收入 18.5%", "营业收入 18.5%", 0.85)
    assert record == {
        "page": 3,
        "similarity": 1.0,
        "matched": True,
        "numericMismatch": False,
    }, record
    mismatch = sidecar.crosscheck_record(4, "营业收入 18.5%", "完全不同", 0.85)
    assert mismatch["matched"] is False and mismatch["page"] == 4, mismatch
    numeric = sidecar.crosscheck_record(5, "营业收入 18.5%", "营业收入 16.5%", 0.85)
    assert numeric["matched"] is True and numeric["numericMismatch"] is True, numeric

    summary = sidecar.crosscheck_summary([record, mismatch, numeric], 0.85, 4, failed=1)
    assert summary["sampled"] == 3 and summary["planned"] == 4, summary
    assert summary["matched"] == 2 and summary["mismatched"] == 1, summary
    # Both the empty reading and the altered amount lose the expected numbers.
    assert summary["numericMismatched"] == 2, summary
    assert summary["minSimilarity"] == mismatch["similarity"], summary
    assert summary["budgetExceeded"] is False, summary
    exhausted = sidecar.crosscheck_summary([record], 0.85, 3)
    assert exhausted["budgetExceeded"] is True, exhausted
    empty = sidecar.crosscheck_summary([], 0.85, 0)
    assert empty["minSimilarity"] is None and empty["budgetExceeded"] is False, empty

    previous = {
        name: os.environ.get(name)
        for name in (
            "OCR_PDF_TEXT_CROSSCHECK_RATE",
            "OCR_PDF_TEXT_CROSSCHECK_MAX_PAGES",
            "OCR_PDF_TEXT_CROSSCHECK_MIN_SIMILARITY",
        )
    }
    try:
        os.environ["OCR_PDF_TEXT_CROSSCHECK_RATE"] = "2"
        os.environ["OCR_PDF_TEXT_CROSSCHECK_MAX_PAGES"] = "0"
        os.environ["OCR_PDF_TEXT_CROSSCHECK_MIN_SIMILARITY"] = "-1"
        assert sidecar.text_crosscheck_rate() == 1.0
        assert sidecar.text_crosscheck_max_pages() == 1
        assert sidecar.text_crosscheck_min_similarity() == 0.0
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def check_bbox_inverse() -> None:
    identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    mapped = sidecar.map_bbox_back(sidecar.box_bbox(10, 20, 110, 70), identity, 500, 500)
    assert mapped == {"x": 10, "y": 20, "width": 100, "height": 50}, mapped
    translated = [[1.0, 0.0, -5.0], [0.0, 1.0, -7.0], [0.0, 0.0, 1.0]]
    moved = sidecar.map_bbox_back(sidecar.box_bbox(10, 20, 110, 70), translated, 500, 500)
    assert moved == {"x": 5, "y": 13, "width": 100, "height": 50}, moved


def check_truncation_metadata() -> None:
    """Truncation is DIR metadata; the text body must never carry the note."""
    pages = [
        sidecar.dir_page(
            1, 595.0, 842.0, [block(1, "paragraph", "正文", (0, 0, 10, 10))], None
        )
    ]
    document = sidecar.dir_document(
        "native",
        pages,
        {"truncated": True, "processedPages": 1, "totalPages": 2},
    )
    assert document["meta"]["truncated"] is True, document["meta"]
    assert document["meta"]["processedPages"] == 1, document["meta"]
    body = "\n".join(
        str(item.get("text") or "")
        for page in document["pages"]
        for item in page["blocks"]
    )
    assert "已截断" not in body and "仅解析" not in body, body
    extraction = sidecar.Extraction(
        text=body,
        confidence=0.9,
        model="m",
        base_model="m",
        pages=1,
        truncated=True,
        route="native",
        document=document,
    )
    assert extraction.truncated is True, extraction


def check_normalization_keeps_field_values() -> None:
    """Normalization is a display concern: it must never rewrite a field value."""
    values = [
        "12:30",
        "09：15：30",
        "1：2",
        "https://例.com/a b",
        "www.AB123.com",
        "订单号：AB123-2",
        "统一社会信用代码：91310115MA1H9D6Y7K",
        "1，2，3",
        "型号X1-2",
        "IBAN：DE89370400440532013000",
    ]
    for value in values:
        normalized = sidecar.normalize_ocr_text(f"标签：{value}")
        assert value in normalized, (value, normalized)

    # Thousands folding still works, prose spacing still happens.
    assert sidecar.normalize_ocr_text("金额 1，280，500 元") == "金额 1,280,500 元"
    assert sidecar.normalize_ocr_text("新增客户42家") == "新增客户 42 家"
    assert sidecar.normalize_ocr_text("客户Customer") == "客户 Customer"
    assert sidecar.normalize_ocr_text("客户：上海") == "客户： 上海"
    assert sidecar.normalize_ocr_text("完成。Next step") == "完成。 Next step"

    document = sidecar.dir_document(
        "visual",
        [
            sidecar.dir_page(
                1,
                100.0,
                100.0,
                [block(1, "paragraph", "订单号：AB123", (0, 0, 10, 10))],
                None,
            )
        ],
        None,
    )
    raw = sidecar.raw_text_from_document(document)
    assert raw == "订单号：AB123", raw
    assert sidecar.raw_text_from_document(None) is None


def expect_request_error(action, status: int) -> sidecar.RequestError:
    try:
        action()
    except sidecar.RequestError as error:
        assert error.status == status, (status, error.status, error.message)
        return error
    raise AssertionError(f"expected RequestError {status}")


def check_input_hardening() -> None:
    assert sidecar.image_budget_issue(800, 600, 1) is None
    assert sidecar.image_budget_issue(0, 600, 1)[0] == 422
    oversized = sidecar.image_budget_issue(sidecar.MAX_IMAGE_PIXELS, 2, 1)
    assert oversized is not None and oversized[0] == 413, oversized
    frames = sidecar.image_budget_issue(100, 100, 999)
    assert frames is not None and "frames" in frames[1], frames

    sidecar.reject_explosive_xml("word/document.xml", b'<?xml version="1.0"?><w:document/>')
    expect_request_error(
        lambda: sidecar.reject_explosive_xml("word/document.xml", b"<!DOCTYPE w:document []>"), 422
    )

    with tempfile.TemporaryDirectory() as tmp:
        benign = Path(tmp) / "ok.docx"
        with zipfile.ZipFile(benign, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types/>')
        sidecar.validate_office_archive(benign)

        bomb = Path(tmp) / "bomb.docx"
        with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("word/document.xml", b"\0" * 6_000_000)
            archive.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types/>')
        expect_request_error(lambda: sidecar.validate_office_archive(bomb), 413)

        entity = Path(tmp) / "entity.docx"
        with zipfile.ZipFile(entity, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr(
                "word/document.xml", b'<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY x "y">]>'
            )
        expect_request_error(lambda: sidecar.validate_office_archive(entity), 422)


def _stub_pdfminer(mode: str) -> None:
    """Install a fake pdfminer so the password classifier can be exercised offline."""
    package = types.ModuleType("pdfminer")
    document_module = types.ModuleType("pdfminer.pdfdocument")
    parser_module = types.ModuleType("pdfminer.pdfparser")

    class NoPasswordError(Exception):
        pass

    class PDFParser:
        def __init__(self, handle) -> None:
            self.handle = handle

    def PDFDocument(parser, password=""):
        if mode == "needs_password":
            raise NoPasswordError("no password supplied")
        if mode == "corrupt":
            raise ValueError("invalid PDF header")
        return object()

    document_module.PDFDocument = PDFDocument
    parser_module.PDFParser = PDFParser
    package.pdfdocument = document_module
    package.pdfparser = parser_module
    sys.modules["pdfminer"] = package
    sys.modules["pdfminer.pdfdocument"] = document_module
    sys.modules["pdfminer.pdfparser"] = parser_module


def check_pdf_password_detection() -> None:
    saved = {
        name: sys.modules.get(name)
        for name in ("pdfminer", "pdfminer.pdfdocument", "pdfminer.pdfparser")
    }
    try:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.pdf"
            path.write_bytes(b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n")
            _stub_pdfminer("needs_password")
            assert sidecar.pdf_needs_password(path) is True
            _stub_pdfminer("open")
            assert sidecar.pdf_needs_password(path) is False
            _stub_pdfminer("corrupt")
            assert sidecar.pdf_needs_password(path) is False
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module


def check_engine_extension_sets() -> None:
    office = sidecar.DOCLING_OFFICE_EXTENSIONS
    assert office == {".docx", ".xlsx", ".pptx"}, office
    assert office <= sidecar.DOCLING_EXTENSIONS, sidecar.DOCLING_EXTENSIONS
    page_inputs = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp"}
    assert page_inputs <= sidecar.DOCLING_EXTENSIONS, sidecar.DOCLING_EXTENSIONS
    assert ".gif" not in sidecar.DOCLING_EXTENSIONS, "Docling has no GIF reader"
    assert not (office & sidecar.PADDLE_EXTENSIONS), "Paddle must not claim Office"
    assert sidecar.ENGINE_EXTENSIONS["paddle"] is sidecar.PADDLE_EXTENSIONS
    assert sidecar.ENGINE_EXTENSIONS["docling"] is sidecar.DOCLING_EXTENSIONS


def check_mrz_and_machine_symbols() -> None:
    td3 = (
        "P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<\n"
        "L898902C36UTO7408122F1204159ZE184226B<<<<<10"
    )
    entries = sidecar.parse_mrz(td3, 2)
    assert len(entries) == 1, entries
    entry = entries[0]
    assert entry["format"] == "mrz" and entry["page"] == 2, entry
    assert entry["checks"] == {"valid": True, "failed": []}, entry["checks"]
    fields = entry["fields"]
    assert fields["documentNumber"] == "L898902C3", fields
    assert fields["birthDate"] == "1974-08-12", fields
    assert fields["expiryDate"] == "2012-04-15", fields
    assert fields["sex"] == "F", fields
    assert fields["surname"] == "ERIKSSON", fields
    assert fields["givenNames"] == "ANNA MARIA", fields

    broken = sidecar.parse_mrz(td3.replace("L898902C36", "L898902C35"))[0]
    assert broken["checks"]["valid"] is False, broken["checks"]
    assert "documentNumber" in broken["checks"]["failed"], broken["checks"]

    saved = os.environ.get("OCR_MACHINE_READABLE")
    os.environ["OCR_MACHINE_READABLE"] = "0"
    try:
        assert sidecar.decode_machine_symbols(Path("unused.png")) == []
        page = sidecar.dir_page(1, 10, 10, [], None)
        sidecar.attach_machine_readable(page, sidecar.parse_mrz(td3))
        assert page["meta"]["machineReadable"][0]["format"] == "mrz", page
        sidecar.attach_machine_readable(page, sidecar.parse_mrz(td3))
        assert len(page["meta"]["machineReadable"]) == 1, page
    finally:
        if saved is None:
            os.environ.pop("OCR_MACHINE_READABLE", None)
        else:
            os.environ["OCR_MACHINE_READABLE"] = saved


def check_photometric_selection() -> None:
    same = sidecar.photometric_selection(("合计 100", 0.9), ("合计 100", 0.9))
    assert same["selected"] == "original" and same["basis"] == "no_gain", same

    conflict = sidecar.photometric_selection(("合计 100", 0.99), ("合计 100 200", 0.8))
    assert conflict["selected"] == "original", conflict
    assert conflict["basis"] == "numeric_conflict" and conflict["conflict"] is True, conflict
    assert conflict["enhanced"]["missingTokens"] == 1, conflict

    cleaner = sidecar.photometric_selection(("合计 100 日期 2024-01-01", 0.9), ("合计 1?0 日期 2024-01-01", 0.9))
    assert cleaner["selected"] == "enhanced" and cleaner["basis"] == "corrupt", cleaner

    richer = sidecar.photometric_selection(("合计 100 税额 13", 0.9), ("合计 100", 0.9))
    assert richer["selected"] == "enhanced" and richer["basis"] == "tokens", richer
    assert richer["enhanced"]["addedTokens"] >= 1, richer

    trusted = sidecar.photometric_selection(("合计 100", 0.94), ("合计 100", 0.9))
    assert trusted["selected"] == "enhanced" and trusted["basis"] == "confidence", trusted

    tie = sidecar.photometric_selection(("合计 100", 0.9), ("合计 100", 0.91))
    assert tie["selected"] == "original" and tie["conflict"] is False, tie


def check_docx_tracked_changes() -> None:
    w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    xml = (
        f'<w:p xmlns:w="{w}">'
        "<w:r><w:t>保留</w:t></w:r>"
        "<w:ins><w:r><w:t>插入</w:t></w:r></w:ins>"
        "<w:del><w:r><w:delText>删除</w:delText></w:r></w:del>"
        "<w:r><w:tab/><w:t>尾</w:t></w:r>"
        "</w:p>"
    )
    text, stats = sidecar._docx_element_text(ET.fromstring(xml))
    assert text == "保留插入\t尾", repr(text)
    assert stats == {"deleted": 2, "inserted": 2, "changes": 2}, stats

    # mc:Fallback duplicates drawing content and must not be read twice.
    mc = "http://schemas.openxmlformats.org/markup-compatibility/2006"
    pick = (
        f'<w:p xmlns:w="{w}" xmlns:mc="{mc}">'
        "<mc:AlternateContent>"
        "<mc:Choice><w:r><w:t>一次</w:t></w:r></mc:Choice>"
        "<mc:Fallback><w:r><w:t>一次</w:t></w:r></mc:Fallback>"
        "</mc:AlternateContent>"
        "</w:p>"
    )
    assert sidecar._docx_element_text(ET.fromstring(pick))[0] == "一次"

    try:
        sidecar._safe_xml(b'<!DOCTYPE x [<!ENTITY a "b">]><x/>')
    except ValueError:
        pass
    else:
        raise AssertionError("DTD declarations must be rejected")


def check_office_side_parts() -> None:
    chart = (
        '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" '
        'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
        "<c:title><a:t>季度销售额</a:t></c:title>"
        "<c:ser><c:val><c:numRef><c:numCache>"
        "<c:pt><c:v>1200</c:v></c:pt><c:pt><c:v>1500</c:v></c:pt>"
        "</c:numCache></c:numRef></c:val></c:ser>"
        "</c:chartSpace>"
    )
    parsed = sidecar._chart_text(chart.encode())
    assert parsed["values"] == 2, parsed
    assert "季度销售额" in parsed["text"] and "1200" in parsed["text"], parsed

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "book.xlsx"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("xl/charts/chart1.xml", chart)
            archive.writestr("xl/media/image1.png", b"png")
            archive.writestr("xl/embeddings/ole1.bin", b"ole")
            archive.writestr(
                "xl/comments1.xml",
                '<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                "<commentList><comment><text><t>请核对税额</t></text></comment></commentList>"
                "</comments>",
            )
        parts = sidecar._office_zip_parts(path)
        assert len(parts["charts"]) == 1, parts
        assert len(parts["media"]) == 1 and len(parts["embeddings"]) == 1, parts
        assert parts["comments"][0]["text"] == "请核对税额", parts


def main() -> int:
    check_line_grouping()
    check_mixed_table_routing()
    check_table_pred_cells()
    check_table_hint_without_region()
    check_colored_regions()
    check_ink_gaps()
    check_embedded_image_regions()
    check_text_layer_trust()
    check_text_crosscheck()
    check_bbox_inverse()
    check_truncation_metadata()
    check_normalization_keeps_field_values()
    check_input_hardening()
    check_pdf_password_detection()
    check_engine_extension_sets()
    check_mrz_and_machine_symbols()
    check_photometric_selection()
    check_docx_tracked_changes()
    check_office_side_parts()
    print("ocr_sidecar selftest: ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
