import json, urllib.request
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
spec = json.load(urllib.request.urlopen(urllib.request.Request("https://netfile.com/Connect2/api/openapi.json", headers={"User-Agent": UA}), timeout=120))
for path, ops in sorted(spec["paths"].items()):
    if not path.startswith("/public"):
        continue
    for m, op in ops.items():
        if m == "parameters":
            continue
        params = []
        for p in op.get("parameters", []):
            if p.get("in") == "body":
                ref = p.get("schema", {}).get("$ref", "").split("/")[-1]
                props = spec["definitions"].get(ref, {}).get("properties", {})
                params.append("BODY{" + ",".join(f"{k}:{v.get('type') or v.get('$ref','').split('/')[-1]}{'='+str(v.get('enum'))[:80] if v.get('enum') else ''}" for k, v in props.items()) + "}")
            else:
                params.append(f"{p['in']}:{p['name']}{'='+str(p.get('enum'))[:100] if p.get('enum') else ''}")
        print(m.upper(), path, " ".join(params))
