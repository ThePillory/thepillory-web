import re, urllib.request, urllib.parse
UA = {"User-Agent": "ThePillory"}
t = urllib.request.urlopen(urllib.request.Request("https://dos.elections.myflorida.com/candidates/downloadcanlist.asp", headers=UA), timeout=90).read().decode("latin-1")
f = t[t.find("<form"):t.find("</form>")+7]
print(re.sub(r"<option[^>]*>[^<]*</option>\s*", "", f)[:3000])
print(re.findall(r'<option[^>]*value="([^"]*)"[^>]*>\s*2026 Election', t))
i = t.find("description of the fields"); print(re.sub(r"<[^>]+>", " ", t[i:i+4000]))
