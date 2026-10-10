#!/bin/bash
# TEMPORARY: build the first candidate data on this branch. Remove before merge.
set -eu
python3 tools/build_federal_races.py
node tools/build_candidates.mjs --year 2026 --max-requests 650
