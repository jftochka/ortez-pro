#!/usr/bin/env python3
"""Fail if content/ or data/ contain executable HTML or javascript: URLs."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SCAN_DIRS = (ROOT / "content", ROOT / "data")
FORBIDDEN = (
    re.compile(r"<\s*script\b", re.I),
    re.compile(r"\bjavascript\s*:", re.I),
    re.compile(r"\bon[a-z]+\s*=", re.I),
    re.compile(r"<\s*iframe\b", re.I),
    re.compile(r"data\s*:\s*text/html", re.I),
)


def iter_files() -> list[Path]:
    files: list[Path] = []
    for d in SCAN_DIRS:
        if not d.exists():
            continue
        files.extend(p for p in d.rglob("*") if p.is_file() and p.suffix in {".md", ".yaml", ".yml"})
    return files


def scan(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    hits = []
    for rx in FORBIDDEN:
        if rx.search(text):
            try:
                label = path.relative_to(ROOT)
            except ValueError:
                label = path
            hits.append(f"{label}: {rx.pattern}")
    return hits


def main() -> int:
    errors: list[str] = []
    for path in iter_files():
        errors.extend(scan(path))
    if errors:
        print("Forbidden markup in content/data:")
        for e in errors:
            print(f"  {e}")
        return 1
    print("content/data: no executable markup")
    return 0


if __name__ == "__main__":
    sys.exit(main())
