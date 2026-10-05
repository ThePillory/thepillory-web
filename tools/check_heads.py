#!/usr/bin/env python3
"""Every page carries the same <head>: the icons, the manifest and the link-share tags.

There is one head template, `head_tags()` in tools/build.py. Static pages get it
when build.py writes them; the Pages Functions (the hub, the map, state, place and
district pages, reps, bills, meetings, admin...) get it through PAGE in
functions/_lib/generated.js, which only `page()` in functions/_lib/render.js uses.
This check fails if:

  - a static .html page is missing any of the head tags, or has them outside <head>;
  - PAGE (the Functions' shell) is missing any of them;
  - any Function writes its own <html>/<head> instead of calling page(), or sends
    an HTML response that didn't come from page().

Standard library only. Run: python3 tools/check_heads.py
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import build  # noqa: E402

# The tags every page must carry, taken from the template itself so this check
# can't drift from it.
REQUIRED = [line.strip() for line in build.head_tags("x").splitlines()
            if re.search(r'rel="(icon|apple-touch-icon|manifest)"', line)]
# Not pages: design exports kept for reference.
SKIP_DIRS = ("design/",)
# The only files under functions/ allowed to hold a document shell or send HTML.
SHELL_FILES = {"functions/_lib/generated.js"}
HTML_SENDERS = {"functions/_lib/render.js", "functions/_lib/generated.js"}


def tracked(pattern):
    out = subprocess.run(["git", "ls-files", pattern], cwd=ROOT, capture_output=True, text=True, check=True)
    return [p for p in out.stdout.splitlines() if p]


def head_of(html):
    m = re.search(r"<head>(.*?)</head>", html, re.S | re.I)
    return m.group(1) if m else ""


def main():
    problems = []
    if len(REQUIRED) != 4:
        problems.append(f"head_tags() should have 4 icon/manifest links, found {len(REQUIRED)}")

    pages = [p for p in tracked("*.html") if not p.startswith(SKIP_DIRS)]
    for p in pages:
        head = head_of((ROOT / p).read_text(encoding="utf-8"))
        missing = [t for t in REQUIRED if t not in head]
        if missing:
            problems.append(f"{p}: missing from <head>: {', '.join(missing)}")

    gen = (ROOT / "functions/_lib/generated.js").read_text(encoding="utf-8")
    m = re.search(r'export const PAGE = ("(?:[^"\\]|\\.)*");', gen)
    shell = __import__("json").loads(m.group(1)) if m else ""
    for t in REQUIRED:
        if t not in head_of(shell):
            problems.append(f"functions/_lib/generated.js PAGE: missing from <head>: {t}")

    for p in tracked("functions/**.js"):
        src = (ROOT / p).read_text(encoding="utf-8")
        if p not in SHELL_FILES and re.search(r"<!doctype|<html[\s>]|<head>", src, re.I):
            problems.append(f"{p}: builds its own document shell; render pages with page() from _lib/render.js")
        if p not in HTML_SENDERS and re.search(r"text/html", src, re.I):
            problems.append(f"{p}: sends HTML directly; render pages with page() from _lib/render.js")

    if problems:
        print("Head check failed:\n  " + "\n  ".join(problems))
        return 1
    print(f"Head check passed: {len(pages)} static pages and the Functions' shell carry all {len(REQUIRED)} icon and manifest tags; "
          "no Function builds its own <head>.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
