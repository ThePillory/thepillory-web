"""Tests for tools/d1sql.py: loads write only what changed.  python3 -m unittest tools.test_d1sql"""
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import d1sql as D  # noqa: E402


def db():
    c = sqlite3.connect(":memory:")
    c.executescript("""
      CREATE TABLE t (scope TEXT NOT NULL, n INTEGER NOT NULL, name TEXT, amount REAL, url TEXT, updated_at TEXT, PRIMARY KEY (scope, n));
      CREATE TABLE one (id TEXT PRIMARY KEY, v TEXT);
    """)
    return c


def run(c, stmts):
    before = c.total_changes
    c.executescript("\n".join(stmts))
    return c.total_changes - before


COLS = ["scope", "n", "name", "amount", "url"]


class Upserts(unittest.TestCase):
    def test_identical_rows_write_nothing(self):
        c = db()
        rows = [["a", 1, "One", 10.0, "https://x"], ["a", 2, "Two", 20.0, None]]
        self.assertEqual(run(c, D.upserts("t", COLS, rows, ["scope", "n"], stamp="updated_at")), 2)
        self.assertEqual(run(c, D.upserts("t", COLS, rows, ["scope", "n"], stamp="updated_at")), 0)
        rows[1][3] = 25.0
        self.assertEqual(run(c, D.upserts("t", COLS, rows, ["scope", "n"], stamp="updated_at")), 1)
        self.assertEqual(c.execute("SELECT amount FROM t WHERE n = 2").fetchone()[0], 25.0)

    def test_keep_old_keeps_a_saved_value_over_null(self):
        c = db()
        run(c, D.upserts("t", COLS, [["a", 1, "One", 10.0, "https://x"]], ["scope", "n"]))
        self.assertEqual(run(c, D.upserts("t", COLS, [["a", 1, "One", 10.0, None]], ["scope", "n"], keep_old=["url"])), 0)
        self.assertEqual(c.execute("SELECT url FROM t").fetchone()[0], "https://x")

    def test_statements_split_under_the_size_limit(self):
        rows = [["a", i, "x" * 500, i, None] for i in range(400)]
        out = D.upserts("t", COLS, rows, ["scope", "n"])
        self.assertGreater(len(out), 2)
        self.assertTrue(all(len(s.encode()) < D.MAX_STATEMENT + 1000 for s in out))
        c = db()
        self.assertEqual(run(c, out), 400)


class Prune(unittest.TestCase):
    def test_deletes_only_rows_gone_from_the_source(self):
        c = db()
        run(c, D.upserts("t", COLS, [["a", 1, "One", 1, None], ["a", 2, "Two", 2, None], ["b", 1, "Other", 3, None]], ["scope", "n"]))
        self.assertEqual(run(c, D.prune("t", {"scope": "a"}, ["n"], [1, 2])), 0)
        self.assertEqual(run(c, D.prune("t", {"scope": "a"}, ["n"], [1])), 1)
        self.assertEqual(sorted(r[0] for r in c.execute("SELECT scope || n FROM t")), ["a1", "b1"])
        self.assertEqual(run(c, D.prune("t", {"scope": "a"}, ["n"], [])), 1)

    def test_composite_keys_and_long_lists(self):
        c = db()
        run(c, D.upserts("t", COLS, [["a", i, None, None, None] for i in range(3000)], ["scope", "n"]))
        keep = [("a", i) for i in range(2990)]
        with self.assertRaises(ValueError):
            D.prune("t", {}, ["scope", "n"], keep, max_size=5000)
        existing = [tuple(r) for r in c.execute("SELECT scope, n FROM t")]
        out = D.prune("t", {}, ["scope", "n"], keep, existing=existing, max_size=200)
        self.assertGreater(len(out), 1)
        self.assertEqual(run(c, out), 10)
        self.assertEqual(c.execute("SELECT COUNT(*) FROM t").fetchone()[0], 2990)
        self.assertEqual(D.prune("t", {}, ["scope", "n"], keep, existing=keep), [])


if __name__ == "__main__":
    unittest.main()
