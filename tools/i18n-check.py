#!/usr/bin/env python3
#
# FILE            i18n-check.py
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
# What c³'s translations lack: every text the page shows in English - t('...') and plural(n, '...', '...') in
# www/js, the text and the title / placeholder / aria-label / alt of www/index.html, data-i18n-html elements
# whole - against each catalog, www/i18n/<lang>.json.
#
#   tools/i18n-check.py              missing and unused keys per language; exit 1 if any is missing
#   tools/i18n-check.py --keys       every key, one a line (JSON strings)
#   tools/i18n-check.py --missing es the keys es.json lacks, as a JSON object to fill in
#   tools/i18n-check.py --suspects   English literals in www/js not in t() that look like text for people
#
import html.parser, json, os, re, sys

ROOT  = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "www")
LANGS = ("es", "fr", "de")
SKIP  = {"i18n.js"}                                         # the module itself; vendor/ is not read
ATTRS = ("title", "placeholder", "aria-label", "alt")

# t('...') / t("...") / t(`...`) / tk('...') - the first argument, a literal; plural(n, 'one', 'many')
STR   = r"""('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.)*`)"""
T_RE  = re.compile(r"(?<![\w.$])tk?\(\s*" + STR)
PL_RE = re.compile(r"(?<![\w.$])plural\(\s*[^,]+,\s*" + STR + r"\s*,\s*" + STR)


def unquote(lit):
  q, body = lit[0], lit[1:-1]
  if q == "`":
    return body.replace("\\`", "`").replace("\\\\", "\\")
  return json.loads('"' + body.replace('\\' + q, q).replace('"', '\\"').replace("\\'", "'") + '"') if q == "'" else json.loads(lit)


def jsKeys():
  keys = {}
  for f in sorted(os.listdir(os.path.join(ROOT, "js"))):
    if not f.endswith(".js") or f in SKIP:
      continue
    src = open(os.path.join(ROOT, "js", f), encoding="utf-8").read()
    for m in T_RE.finditer(src):
      keys.setdefault(unquote(m.group(1)), f)
    for m in PL_RE.finditer(src):
      keys.setdefault(unquote(m.group(1)), f)
      keys.setdefault(unquote(m.group(2)), f)
  return keys


class Page(html.parser.HTMLParser):
  def __init__(self):
    super().__init__(convert_charrefs=True)
    self.keys, self.stack, self.whole, self.raw = {}, [], None, None

  def handle_starttag(self, tag, attrs):
    a = dict(attrs)
    void = tag in ("img", "input", "br", "meta", "link", "hr", "source")
    if not void:
      self.stack.append((tag, a.get("class") or ""))
    for k in ATTRS:
      if a.get(k) and re.search(r"[A-Za-z]{2}", a[k]):
        self.keys.setdefault(a[k].strip(), "index.html")

  def handle_endtag(self, tag):
    while self.stack:
      t, _ = self.stack.pop()
      if t == tag:
        break

  def handle_data(self, data):
    if any(t in ("script", "style", "code") or "mono" in c.split() for t, c in self.stack):
      return
    s = re.sub(r"\s+", " ", data).strip()
    if re.search(r"[A-Za-z]{2}", s):
      self.keys.setdefault(s, "index.html")


def pageKeys():
  src = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
  keys = {}
  # data-i18n-html elements: their inner HTML whole, and their text left out of the text nodes
  for m in re.finditer(r"<(\w+)([^>]*\sdata-i18n-html[^>]*)>(.*?)</\1>", src, re.S):
    keys.setdefault(re.sub(r"\s+", " ", m.group(3)).strip(), "index.html")
  rest = re.sub(r"<(\w+)([^>]*\sdata-i18n-html[^>]*)>(.*?)</\1>", "", src, flags=re.S)
  p = Page()
  p.feed(rest)
  for k, v in p.keys.items():
    keys.setdefault(k, v)
  return keys


def suspects():
  out = []
  pat = re.compile(r"(?:textContent|title|placeholder|label|hint|text|detail|why|ariaLabel)\s*[:=]\s*" + STR)
  for f in sorted(os.listdir(os.path.join(ROOT, "js"))):
    if not f.endswith(".js") or f in SKIP:
      continue
    for n, line in enumerate(open(os.path.join(ROOT, "js", f), encoding="utf-8"), 1):
      for m in pat.finditer(line):
        s = m.group(1)[1:-1]
        if re.search(r"[A-Za-z]{3,} [A-Za-z]", s) or re.match(r"^[A-Z][a-z]{2,}", s):
          before = line[:m.start(1)]
          if not re.search(r"(?<![\w.$])(tk?\(\s*|plural\([^()]*,\s*(" + STR + r"\s*,\s*)?)$", before):
            out.append(f"{f}:{n}: {s[:90]}")
  return out


def main():
  keys = {**pageKeys(), **jsKeys()}
  args = sys.argv[1:]
  if args[:1] == ["--keys"]:
    for k in sorted(keys):
      print(json.dumps(k, ensure_ascii=False))
    return 0
  if args[:1] == ["--suspects"]:
    s = suspects()
    print("\n".join(s))
    print(f"{len(s)} suspects", file=sys.stderr)
    return 0
  if args[:1] == ["--missing"]:
    lang = args[1]
    path = os.path.join(ROOT, "i18n", lang + ".json")
    cat  = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    print(json.dumps({k: "" for k in sorted(keys) if k not in cat}, ensure_ascii=False, indent=2))
    return 0

  bad = 0
  print(f"{len(keys)} texts")
  for lang in LANGS:
    path = os.path.join(ROOT, "i18n", lang + ".json")
    cat  = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    missing = [k for k in keys if not cat.get(k)]
    unused  = [k for k in cat if k not in keys]
    # a {name} in the English must be in the translation too
    holes   = [k for k in keys if cat.get(k) and set(re.findall(r"\{\w+\}", k)) != set(re.findall(r"\{\w+\}", cat[k]))]
    print(f"  {lang}: {len(keys) - len(missing)}/{len(keys)} translated, {len(missing)} missing, {len(unused)} unused, {len(holes)} with other {{names}}")
    for k in missing[:5]:
      print(f"      missing: {k[:80]}  ({keys[k]})")
    for k in holes[:5]:
      print(f"      names:   {k[:80]}")
    bad += len(missing) + len(holes)
  return 1 if bad else 0


sys.exit(main())
