"""Tests for tools/build_ca_constitution.py: one version of each section when voters amend it."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_ca_constitution as b  # noqa: E402

NOW = ("Sec. 36 amended Nov. 8, 2016, by Prop. 55. Initiative measure. Superseded on fifth day after "
       "Secretary of State files the final Statement of Vote; see amendment by Prop. 3 of 2026.")
LATER = ("Sec. 36 amended Nov. 3, 2026, by Prop. 3. Initiative measure. Effective on the fifth day after the "
         "Secretary of State files the final Statement of Vote. [Note: amended by Prop. 55, Nov. 8, 2016.]")


class InForce(unittest.TestCase):
    def test_one_version_stays_as_is(self):
        self.assertEqual(b.in_force("I", [("1", "text", "Adopted 1974.")]), [("1", "text", "Adopted 1974.", None)])

    def test_the_version_in_force_is_kept_and_the_amendment_is_pending(self):
        # Either order in the database.
        for secs in ([("36", "old text", NOW), ("36", "new text", LATER)], [("36", "new text", LATER), ("36", "old text", NOW)]):
            [(num, text, history, pending)] = b.in_force("XIII", secs)
            self.assertEqual((num, text, history), ("36", "old text", NOW))
            self.assertEqual(pending, {"text": "new text", "history": LATER})

    def test_two_versions_it_cant_tell_apart_stop_the_build(self):
        with self.assertRaises(SystemExit):
            b.in_force("XIII", [("36", "a", "Amended 2016."), ("36", "b", "Amended 2026.")])
        with self.assertRaises(SystemExit):
            b.in_force("XIII", [("36", "a", NOW), ("36", "b", NOW)])


if __name__ == "__main__":
    unittest.main()
