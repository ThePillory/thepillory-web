#!/usr/bin/env python3
"""Tests for the district numbers in tools/build_zip_districts.py (and, through the
map data it matches, tools/build_geo.mjs's districtId()): only Congress maps the
delegate code 98 to "0"; a state legislature's district 98 stays 98. Also checks
the built map data: no state legislative layer has a district "0". Standard library.

    python3 tools/test_build_zip_districts.py
"""
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_zip_districts as Z  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


class Numbers(unittest.TestCase):
    def test_congress(self):
        self.assertEqual(Z.district_number("05"), "5")
        self.assertEqual(Z.district_number("00"), "0", "at large")
        self.assertEqual(Z.district_number("98"), "0", "a delegate (DC, the territories)")
        self.assertEqual(Z.geo_id("98"), "0")

    def test_legislatures_keep_98(self):
        self.assertEqual(Z.district_number("098", congress=False), "98")
        self.assertEqual(Z.geo_id("098", "sldl"), "98")
        self.assertEqual(Z.geo_id("098", "sldu"), "98")
        self.assertEqual(Z.geo_id("ZZZ", "sldl"), None)
        self.assertEqual(Z.geo_id("7th Middlesex", "sldl"), "7th-middlesex")

    def test_built_map_data(self):
        bad = []
        for f in sorted((ROOT / "data" / "geo" / "places").glob("*.json")):
            d = json.loads(f.read_text())
            for layer in ("sldu", "sldl"):
                if "0" in ((d.get("districts") or {}).get(layer) or {}):
                    bad.append(f"{d['st']} {layer}")
        self.assertEqual(bad, [], "a state legislative layer with a district \"0\": rebuild with the Refresh map data workflow")


if __name__ == "__main__":
    unittest.main()
