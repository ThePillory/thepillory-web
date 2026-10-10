#!/bin/bash
# TEMPORARY: build the first candidate data on this branch. Remove before merge.
set -u
mkdir -p tmp-research/out-fec
python3 tools/build_federal_races.py 2>&1 | tail -5 > tmp-research/out-fec/run.txt
node tools/build_candidates.mjs --year 2026 --max-requests 550 2>&1 | tail -30 >> tmp-research/out-fec/run.txt
cat tmp-research/out-fec/run.txt
