import re, urllib.request, urllib.parse
UA = {"User-Agent": "ThePillory"}
t = urllib.request.urlopen(urllib.request.Request("https://dos.elections.myflorida.com/candidates/downloadcanlist.asp", headers=UA), timeout=90).read().decode("latin-1")
print("FORMS", re.findall(r"<form[^>]*>", t, re.I))
print("INPUTS", re.findall(r"<input[^>]*>", t, re.I))
print("SELECTS", re.findall(r"<select[^>]*>", t, re.I))
opts = re.findall(r'<option[^>]*value\s*=\s*"?([^"> ]*)"?[^>]*>\s*([^<]*?)\s*<', t, re.S)
print("OPTIONS 2026", [o for o in opts if "2026" in o[1] or "2026" in o[0]][:20])
txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", t))
i = txt.find("Field"); print("FIELDS", txt[i:i+2500])
