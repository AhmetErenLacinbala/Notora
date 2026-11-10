"""Run with a Python environment containing pypdf: python apps/server/pdf_manifest_test.py."""

import json
import tempfile
import unittest
from pathlib import Path

from pypdf import PdfWriter
from pypdf.annotations import Link
from pypdf.generic import Fit, NameObject, NumberObject, RectangleObject

from pdf_manifest import main


class ManifestTest(unittest.TestCase):
    def test_original_page_destinations_and_display_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.pdf"
            output = Path(directory) / "manifest.json"
            writer = PdfWriter()
            first = writer.add_blank_page(width=500, height=700)
            first.cropbox = RectangleObject([50, 100, 450, 650])
            first[NameObject("/UserUnit")] = NumberObject(2)
            first.rotate(90)
            writer.add_blank_page(width=300, height=400)
            writer.add_outline_item("Rotated page", 0, fit=Fit.xyz(100, 250, None))
            writer.add_outline_item("Second page", 1, fit=Fit.xyz(20, 300, None))
            writer.add_annotation(0, Link(rect=(100, 150, 200, 250), target_page_index=1))
            writer.add_annotation(0, Link(rect=(120, 300, 180, 350), url="https://example.com"))
            writer.add_annotation(0, Link(rect=(120, 400, 180, 450), url="javascript:alert(1)"))
            writer.write(source)

            main(str(source), str(output))
            manifest = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(manifest["pages"], [
                {"number": 1, "width": 1100.0, "height": 800.0},
                {"number": 2, "width": 300.0, "height": 400.0},
            ])
            self.assertEqual(manifest["outline"][0]["destination"], {"page": 1, "x": 300.0, "y": 100.0})
            self.assertEqual(manifest["outline"][1]["destination"], {"page": 2, "x": 20.0, "y": 100.0})
            self.assertIn({"rect": [100.0, 100.0, 300.0, 300.0], "destination": {"page": 2}}, manifest["links"][0])
            self.assertTrue(any(link.get("url") == "https://example.com" for link in manifest["links"][0]))
            self.assertFalse(any("javascript:" in link.get("url", "") for link in manifest["links"][0]))


if __name__ == "__main__":
    unittest.main()
