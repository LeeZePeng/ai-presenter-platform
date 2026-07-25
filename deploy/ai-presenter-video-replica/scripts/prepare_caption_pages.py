#!/usr/bin/env python3
"""Precompute deterministic two-line caption pages without splitting product names."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


DEFAULT_PROTECTED_TERMS = ("Opus 5", "Mythos 5", "Fable 5", "Kimi K3", "Anthropic")
BREAK_PUNCTUATION = set("，。！？；：、,.!?;:）】》 ")


class CaptionPageError(ValueError):
    pass


def visible_units(text: str) -> float:
    return sum(0.55 if ord(character) < 128 else 1.0 for character in text)


def protected_spans(text: str, terms: list[str]) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    for term in terms:
        if not term:
            continue
        for match in re.finditer(re.escape(term), text, flags=re.IGNORECASE):
            spans.append((match.start(), match.end()))
    for match in re.finditer(r"(?<![A-Za-z0-9])(?:[A-Za-z][A-Za-z0-9.+-]*)(?:\s+[A-Za-z0-9][A-Za-z0-9.+-]*)?(?![A-Za-z0-9])", text):
        spans.append((match.start(), match.end()))
    return sorted(set(spans))


def _valid_boundary(index: int, spans: list[tuple[int, int]]) -> bool:
    return not any(start < index < end for start, end in spans)


def paginate_caption(text: str, max_units: float = 30, min_last_units: float = 8, terms: list[str] | None = None) -> list[str]:
    if max_units <= 0 or min_last_units < 0:
        raise CaptionPageError("caption page limits must be positive")
    if not text:
        return []
    spans = protected_spans(text, list(DEFAULT_PROTECTED_TERMS) + list(terms or []))
    pages: list[str] = []
    cursor = 0
    while visible_units(text[cursor:]) > max_units:
        candidates: list[int] = []
        for index in range(cursor + 1, len(text) + 1):
            if visible_units(text[cursor:index]) > max_units:
                break
            if _valid_boundary(index, spans):
                candidates.append(index)
        if not candidates:
            protected_end = max((end for start, end in spans if start <= cursor < end), default=cursor + 1)
            candidates = [protected_end]
        balanced = [index for index in candidates if visible_units(text[index:]) >= min_last_units]
        usable = balanced or candidates
        punctuation = [index for index in usable if text[index - 1] in BREAK_PUNCTUATION]
        boundary = (punctuation or usable)[-1]
        if boundary <= cursor:
            raise CaptionPageError("caption pagination made no progress")
        pages.append(text[cursor:boundary])
        cursor = boundary
    pages.append(text[cursor:])
    if "".join(pages) != text:
        raise CaptionPageError("caption pages do not reconstruct the authoritative text")
    return pages


def prepare_timeline(value: Any, max_units: float, min_last_units: float, terms: list[str]) -> tuple[Any, dict[str, Any]]:
    if isinstance(value, list):
        segments = value
    elif isinstance(value, dict):
        segments = value.get("segments")
        if not isinstance(segments, list):
            segments = value.get("captions")
    else:
        segments = None
    if not isinstance(segments, list) or not segments:
        raise CaptionPageError("caption timeline must be an array or contain segments/captions")
    page_count = 0
    protected_count = 0
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict):
            raise CaptionPageError(f"caption {index} must be an object")
        text = str(segment.get("text") or "")
        if not text:
            raise CaptionPageError(f"caption {index} has empty text")
        pages = paginate_caption(text, max_units, min_last_units, terms)
        segment["pages"] = pages
        page_count += len(pages)
        protected_count += len(protected_spans(text, list(DEFAULT_PROTECTED_TERMS) + terms))
    return value, {"captionCount": len(segments), "pageCount": page_count, "protectedSpanCount": protected_count}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--max-units", type=float, default=30)
    parser.add_argument("--min-last-units", type=float, default=8)
    parser.add_argument("--protected-term", action="append", default=[])
    args = parser.parse_args()
    try:
        value = json.loads(args.input.read_text(encoding="utf-8"))
        prepared, report = prepare_timeline(value, args.max_units, args.min_last_units, args.protected_term)
    except (OSError, json.JSONDecodeError, CaptionPageError) as error:
        parser.error(str(error))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(prepared, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"valid": True, **report, "output": str(args.output.resolve())}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
