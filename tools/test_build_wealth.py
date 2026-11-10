"""Tests for tools/build_wealth.py: the Fed's wealth groups as published, and runs that don't read cleanly fail."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_wealth as W  # noqa: E402

CODES = ["TopPt1", "RemainingTop1", "Next9", "Next40", "Bottom50"]
SHARE = {"TopPt1": 15.0, "RemainingTop1": 17.5, "Next9": 36.4, "Next40": 28.8, "Bottom50": 2.3}


def shares_csv(quarters):
    lines = ["Date,Category,Net worth,Assets"]
    for q in quarters:
        lines += [f"{q},{c},{SHARE[c]},1" for c in CODES]
    return "\n".join(lines) + "\n"


DETAIL = """Date,Category,Assets,Net worth,Household count,Minimum Wealth Cutoff
2026:Q2,TopPt1,28168034,27867091,136779,61000000
2026:Q2,RemainingTop1,33334932,32445932,1214225,11000000
2026:Q2,Next9,71849146,67634079,12165969,2000000
2026:Q2,Next40,62317685,53425884,54064877,190000
2026:Q2,Bottom50,10272832,4278038,67616544,
"""


def quarters(n):
    out, y, q = [], 1989, 3
    for _ in range(n):
        out.append(f"{y}:Q{q}")
        q += 1
        if q == 5:
            y, q = y + 1, 1
    return out


class Wealth(unittest.TestCase):
    def test_the_latest_groups_as_published(self):
        qs = quarters(148)
        self.assertEqual(qs[-1], "2026:Q2")
        body = W.build(W.read_shares(shares_csv(qs)), W.read_detail(DETAIL))
        self.assertEqual(body["latest"], "2026:Q2")
        self.assertEqual([g["label"] for g in body["groups"]], ["Top 0.1%", "Next 0.9% (rest of the top 1%)", "Top 1–10%", "Top 10–50%", "Bottom 50%"])
        top = body["groups"][0]
        self.assertEqual((top["share"], top["households"], top["net_worth"], top["cutoff"]), (15.0, 136779.0, 27867091 * 1e6, 61000000.0))
        self.assertIsNone(body["groups"][-1]["cutoff"])  # the bottom 50% has no floor
        self.assertEqual(len(body["series"]), 148)
        self.assertEqual(body["series"][0], {"quarter": "1989:Q3", "shares": {"top-0.1": 15.0, "next-0.9": 17.5, "top-1-10": 36.4, "top-10-50": 28.8, "bottom-50": 2.3}})

    def test_runs_that_dont_read_cleanly_fail(self):
        with self.assertRaises(ValueError):  # too few quarters
            W.build(W.read_shares(shares_csv(quarters(20))), W.read_detail(DETAIL))
        with self.assertRaises(ValueError):  # shares that don't add to 100
            bad = shares_csv(quarters(148)).replace("2026:Q2,Bottom50,2.3", "2026:Q2,Bottom50,12.3")
            W.build(W.read_shares(bad), W.read_detail(DETAIL))
        with self.assertRaises(ValueError):  # no detail for the latest quarter
            W.build(W.read_shares(shares_csv(quarters(149))), W.read_detail(DETAIL))
        with self.assertRaises(ValueError):  # the household column renamed away
            W.read_detail(DETAIL.replace("Household count", "Units"))


if __name__ == "__main__":
    unittest.main()
