import re, sys, pathlib

SRC = pathlib.Path("/tmp/mockup-src")
OUT = pathlib.Path("/Users/smokingmouse/python/learning/trellis/docs/ui-redesign/mockups")
LUCIDE = pathlib.Path.home() / ".bun/install/cache/lucide-react@1.33.0@@registry.npmmirror.com@@@1/dist/esm/icons"

tokens = (OUT / "tokens.css").read_text()
base = (SRC / "base.css").read_text()

def symbol(name):
    f = LUCIDE / f"{name}.mjs"
    if not f.exists():
        raise SystemExit(f"missing lucide icon: {name}")
    src = f.read_text()
    alias = re.search(r"export \{ default \} from './([a-z0-9-]+)\.mjs'", src)
    if alias:
        return symbol(alias.group(1)).replace(f'id="i-{alias.group(1)}"', f'id="i-{name}"')
    m = re.search(r"__iconNode = \[(.*?)\];\s*const", src, re.S)
    parts = []
    for tag, attrs in re.findall(r'\[\s*"(\w+)",\s*\{(.*?)\}\s*\]', m.group(1), re.S):
        kv = [(k, v) for k, v in re.findall(r'(\w+): "([^"]*)"', attrs) if k != "key"]
        parts.append(f"<{tag} " + " ".join(f'{k}="{v}"' for k, v in kv) + "/>")
    return f'<symbol id="i-{name}" viewBox="0 0 24 24">{"".join(parts)}</symbol>'

for tpl in sorted(SRC.glob("*.html")):
    html = tpl.read_text()
    names = sorted(set(re.findall(r"#i-([a-z0-9-]+)", html)) | set(re.findall(r"""ic\(['"]([a-z0-9-]+)['"]""", html)) | set(re.findall(r"""icon: ['"]([a-z0-9-]+)['"]""", html)) | set(" ".join(re.findall(r"icons: ([a-z0-9 -]+)-->", html)).split()))
    sprite = '<svg width="0" height="0" style="position:absolute" aria-hidden="true">' + "".join(symbol(n) for n in names) + "</svg>"
    html = html.replace("/*@TOKENS*/", tokens).replace("/*@BASE*/", base).replace("<!--@SPRITE-->", sprite)
    (OUT / tpl.name).write_text(html)
    print(tpl.name, len(html), "bytes,", len(names), "icons")
