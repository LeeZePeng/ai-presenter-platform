#!/usr/bin/env python3
"""Validate that a presenter script has a complete, non-bait closing."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


ENGAGEMENT_BAIT = re.compile(
    r"(?:点赞|点个赞|关注|收藏|转发|评论区|评论告诉我|留言告诉我|扣[个一二三四五六七八九十\d]|"
    r"双击|一键三连|投币|私信我|@\s*\S+)",
    re.IGNORECASE,
)
CLOSING_SIGNAL = re.compile(
    r"(?:下期见|再见|这就是|记住|别等|先.{0,12}(?:做|跑通|开始|行动)|下一步|现在就|从.{0,12}开始|"
    r"做出|用.{0,12}(?:改进|变好|验证)|最终|最后)",
    re.IGNORECASE,
)


def validate_script(text: str) -> list[str]:
    normalized = re.sub(r"\s+", " ", text).strip()
    issues: list[str] = []
    if len(normalized) < 40:
        issues.append("口播文案过短，无法形成完整开场和片尾")
        return issues

    closing = normalized[-180:]
    bait = ENGAGEMENT_BAIT.search(closing)
    if bait:
        issues.append(f"片尾包含互动诱导“{bait.group(0)}”；禁止用点赞、关注、收藏、评论或转发换互动")
    if not CLOSING_SIGNAL.search(closing):
        issues.append("片尾缺少自然收束；最后一段必须回收结论，并给出真实行动、下一步或告别")

    sentences = [part.strip() for part in re.split(r"[。！？!?]+", closing) if part.strip()]
    if len(sentences) < 2:
        issues.append("片尾不完整；最后 180 个字符内至少需要两个完整分句")
    if normalized[-1] not in "。！？!?":
        issues.append("口播文案结尾缺少完整句号或问号")
    return issues


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    args = parser.parse_args()
    text = args.input.read_text(encoding="utf-8")
    issues = validate_script(text)
    if issues:
        for issue in issues:
            print(f"ERROR: {issue}")
        return 1
    print("OK: narration closing is complete and contains no engagement bait")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
