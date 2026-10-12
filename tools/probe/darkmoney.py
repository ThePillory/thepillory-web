"""Temporary probe round 6: tools/load_nonprofits.py in measure mode on three nonprofits."""
import subprocess, sys
from pathlib import Path
out = subprocess.run([sys.executable, "tools/load_nonprofits.py", "--mode", "measure", "--ein", "271937961", "--ein", "530045720", "--ein", "833690373", "--ein", "753148958"], capture_output=True, text=True)
Path("tools/probe/out").mkdir(parents=True, exist_ok=True)
Path("tools/probe/out/measure.txt").write_text(out.stdout + "\n--- stderr\n" + out.stderr[-3000:])
