#!/usr/bin/env python3
#
# traceLevels.py - www/data/traceLevels.json from the cor stack's trace-level headers
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
# Usage: tools/traceLevels.py <directory holding the cor* repos> > www/data/traceLevels.json
#
# Each library numbers its own trace levels in a header, a level per #define or enum member with a comment
# saying what it traces. Operate's trace-level panel shows them as tick boxes, the comment as the tooltip;
# a level without a comment gets its name, split into words. Run it again when a library adds a level.
#
import json
import re
import sys

HEADERS = [                                    # (library, header)
    ('corJson',   'corJson/corJsonTraceLevels.h'),
    ('corTree',   'corTree/corTreeTraceLevels.h'),
    ('corRest',   'corRest/corRestTraceLevels.h'),
    ('corJsonld', 'corJsonld/corLdTraceLevels.h'),
    ('corNgsild', 'corNgsild/ldTraceLevels.h'),
    ('corAlloc',  'corAlloc/CorAllocTraceLevel.h'),
    ('coraine',   'coraine/src/app/coraine/coraineTraceLevels.h'),
]

DEFINE = re.compile(r'^\s*#define\s+([A-Za-z][A-Za-z0-9_]*)\s+(\d+)\s*(?://\s*(.*))?$')
MEMBER = re.compile(r'^\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:=\s*(\d+))?\s*,?\s*(?://\s*(.*))?$')


def words(name):
    # CorLdTContextParse -> "Context parse": the library prefix dropped, the rest split at capitals
    for prefix in ('CorJsonTl', 'CorTreeTl', 'CorRestT', 'CorLdT', 'LdT', 'CorAllocTrace', 'Ct'):
        if name.startswith(prefix) and len(name) > len(prefix):
            name = name[len(prefix):]
            break
    parts = re.findall(r'[A-Z]+(?=[A-Z][a-z]|\b)|[A-Z]?[a-z0-9]+|[A-Z]+', name)
    text = ' '.join(parts).lower()
    return text[:1].upper() + text[1:]


def levels(root, lib, path):
    out = []
    inEnum = False
    nextValue = None
    for line in open(root + '/' + path, encoding='utf-8'):
        m = DEFINE.match(line)
        if m:
            out.append((int(m.group(2)), m.group(1), m.group(3)))
            continue
        if re.match(r'^\s*(typedef\s+)?enum\b', line):
            inEnum = True
            continue
        if inEnum and line.strip().startswith('}'):
            inEnum = False
            continue
        if inEnum:
            m = MEMBER.match(line)
            if not m or m.group(1) in ('typedef', 'enum'):
                continue
            value = int(m.group(2)) if m.group(2) else nextValue
            if value is None:
                continue
            nextValue = value + 1
            if not m.group(1).endswith('Last'):          # an enum's sentinel
                out.append((value, m.group(1), m.group(3)))
    def text(n, c):
        t = (c or '').strip().rstrip(',;').strip() or words(n)    # a comment going on below: its first line
        return t[:1].upper() + t[1:]
    return [{'level': v, 'name': n, 'library': lib, 'traces': text(n, c)} for v, n, c in out]


def main():
    if len(sys.argv) != 2:
        sys.exit('usage: traceLevels.py <directory holding the cor* repos>')
    all = []
    for lib, path in HEADERS:
        all += levels(sys.argv[1], lib, path)
    all.sort(key=lambda x: (x['level'], x['library']))
    json.dump(all, sys.stdout, indent=1, ensure_ascii=False)
    sys.stdout.write('\n')


main()
