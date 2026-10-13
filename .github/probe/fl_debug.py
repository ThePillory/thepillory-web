import re, urllib.request, html
t = urllib.request.urlopen(urllib.request.Request("https://dos.elections.myflorida.com/candidates/canlist.asp?elecid=20261103-GEN&cantype=FED", headers={"User-Agent": "ThePillory"}), timeout=90).read().decode("latin-1")
i = t.find("Hampton-Johnson")
print(t[i-3000:i+600])
print("---- office headings")
for m in re.finditer(r"United States (Senator|Representative)", t): print(m.start(), t[max(0, m.start()-200):m.start()+80].replace("\n", " ")[-280:])
