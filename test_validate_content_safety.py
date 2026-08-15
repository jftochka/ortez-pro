#!/usr/bin/env python3
import tempfile
import unittest
from pathlib import Path
import importlib.util

SPEC = importlib.util.spec_from_file_location(
    "validate_content_safety",
    Path(__file__).resolve().parent / "validate_content_safety.py",
)
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


class ScanTests(unittest.TestCase):
    def test_clean_markdown(self):
        p = Path(tempfile.mkdtemp()) / "ok.md"
        p.write_text("# Hello\n\nplain text\n", encoding="utf-8")
        self.assertEqual(mod.scan(p), [])

    def test_script_tag(self):
        p = Path(tempfile.mkdtemp()) / "bad.md"
        p.write_text('<script>alert(1)</script>', encoding="utf-8")
        self.assertTrue(mod.scan(p))

    def test_javascript_url(self):
        p = Path(tempfile.mkdtemp()) / "bad.md"
        p.write_text("[x](javascript:alert(1))", encoding="utf-8")
        self.assertTrue(mod.scan(p))


if __name__ == "__main__":
    unittest.main()
