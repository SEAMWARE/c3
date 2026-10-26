#!/usr/bin/env python3
#
# apiRef.py - the API reference pages of the Documentation page (www/docs/api-<lib>.html), from the libraries' headers
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
# Usage: tools/apiRef.py [--ref <ref>] [<directory holding the clones>]      (default: the one c3 is in, ref HEAD)
#
# Every guide in www/docs/guides.json with "generated": "tools/apiRef.py" is one library's API reference: its
# 'from' names the repository, 'path' the headers ("*.h"), 'at' the commit they were read at. A header of the
# stack is a sequence of blocks, each a separator line, a comment whose first line is "name - what it is", and
# the declarations it is about:
#
#   // -----------------------------------------------------------------------------
#   //
#   // corTreeClone - clone a node
#   //
#   extern CorNode* corTreeClone(CorAlloc* kaP, CorNode* nodeP);
#
# The page opens with the item's 'about' - what the library solves, written by hand in guides.json. Each
# header becomes a section of the page (its own description from the comment of its licence block), each
# block an entry: the name, the declarations as they are written, the comment's text. Nothing is written by
# hand in these pages - a change to a header is a run of this script; tools/docsStale.py lists the pages whose
# headers changed since 'at'.
#
import html
import json
import os
import re
import subprocess
import sys

here   = os.path.dirname(os.path.abspath(__file__))
c3     = os.path.dirname(here)
args   = sys.argv[1:]
ref    = 'HEAD'
if len(args) >= 2 and args[0] == '--ref':
    ref  = args[1]
    args = args[2:]
clones = args[0] if args else os.path.dirname(c3)

GENERATOR  = 'tools/apiRef.py'
SEPARATOR  = re.compile(r'^// ?-{20,}\s*$')
LICENCE    = re.compile(r'^(FILE|AUTHOR|Copyright|SPDX-License-Identifier)\b')
SKIP_DIRS  = ('test/', 'tests/', 'tools/', 'example/', 'examples/', 'build/', 'BUILD')


def git(repo, *argv):
    return subprocess.run(['git', '-C', repo, *argv], capture_output=True, text=True, check=True).stdout


def esc(s):
    return html.escape(s, quote=False)


def anchor(name, taken):
    base = re.sub(r'[^\w-]+', '-', name).strip('-') or 'entry'
    a = base
    n = 2
    while a in taken:
        a = '%s-%d' % (base, n)
        n += 1
    taken.add(a)
    return a


#
# commentText - a comment's lines (the '//' gone) as HTML: paragraphs, separated by empty lines; a paragraph
# whose lines are laid out by hand (indented, or columns of two spaces or more) kept as it is written
#
def commentText(lines):
    out   = []
    paras = []
    cur   = []
    for line in lines:
        if line.strip() == '':
            if cur:
                paras.append(cur)
                cur = []
        else:
            cur.append(line)
    if cur:
        paras.append(cur)

    for p in paras:
        laid = any(l.startswith(' ') or re.search(r'\S {2,}\S', l) for l in p) and len(p) > 1
        if laid:
            out.append('<pre class="api-note">' + esc('\n'.join(p)) + '</pre>')
        else:
            out.append('<p>' + esc(' '.join(l.strip() for l in p)) + '</p>')
    return '\n'.join(out)


def uncomment(line):
    s = line.rstrip()
    if s == '//':
        return ''
    if s.startswith('// '):
        return s[3:]
    return s[2:]


#
# headerParse - (description lines, [ (title, summary, comment lines, code, note lines) ]) of a header's text
#
def headerParse(text):
    lines = text.split('\n')

    # The include guard's #endif, the last line of code, is not a declaration
    last = len(lines)
    for i in range(len(lines) - 1, -1, -1):
        if lines[i].strip().startswith('#endif'):
            last = i
            break
        if lines[i].strip():
            break

    # The description: the comment lines of the licence block, not its own
    desc = []
    i    = 0
    while i < last and not lines[i].startswith('//'):
        i += 1
    while i < last and lines[i].startswith('//') and not SEPARATOR.match(lines[i]):
        t = uncomment(lines[i])
        if not LICENCE.match(t.strip()):
            desc.append(t)
        i += 1
    while desc and desc[0].strip() == '':
        desc.pop(0)
    while desc and desc[-1].strip() == '':
        desc.pop()

    # The rest: comment runs at the start of a line, and the code after each. A run opens an entry when a
    # separator is before it or its first line is "name - ..." - any other run is a note of the entry before
    # it. #include lines and the include guard are not declarations.
    entries = []
    cur     = None
    sep     = False
    while i < last:
        line = lines[i]
        if SEPARATOR.match(line):
            sep = True
            i  += 1
            continue
        if line.startswith('//'):
            run = []
            while i < last and lines[i].startswith('//') and not SEPARATOR.match(lines[i]):
                run.append(uncomment(lines[i]))
                i += 1
            while run and run[0].strip() == '':
                run.pop(0)
            while run and run[-1].strip() == '':
                run.pop()
            if not run:
                continue
            if LICENCE.match(run[0].strip()):          # a licence block after a separator: the header's description
                more = [l for l in run if not LICENCE.match(l.strip())]
                while more and more[0].strip() == '':
                    more.pop(0)
                if not entries and more:
                    desc += ([''] if desc else []) + more
                sep = False
                continue
            if sep or titled(run[0]) or cur is None:
                cur = { 'comment': run, 'code': [], 'notes': [] }
                entries.append(cur)
            elif cur['code']:
                cur['notes'] += ([''] if cur['notes'] else []) + run
            else:
                cur['comment'] += [''] + run
            sep = False
            continue
        i += 1
        if re.match(r'\s*#\s*include\b', line) or re.match(r'\s*#\s*(ifndef|define)\s+\w+_H_?\s*$', line):
            continue
        if cur is None:
            if line.strip():
                cur = { 'comment': [], 'code': [], 'notes': [] }
                entries.append(cur)
            else:
                continue
        cur['code'].append(line.rstrip())

    out = []
    for e in entries:
        code = e['code']
        while code and code[-1].strip() == '':
            code.pop()
        while code and code[0].strip() == '':
            code.pop(0)
        code = [l for k, l in enumerate(code) if l.strip() or (k > 0 and code[k - 1].strip())]   # one empty line at most
        comment = e['comment']
        if not comment and not code:
            continue
        first   = comment[0].strip() if comment else ''
        rest    = comment[1:]
        head    = first.split(' - ', 1)
        summary = ''
        if len(head) == 2 and len(head[0].split()) <= 8:  # "name - what it is"
            title, summary = head[0].strip(), head[1].strip()
        elif first.endswith(' -'):                         # "name -", what it is on the lines after it
            title = first[:-2].strip()
        elif len(first.split()) <= 5:                      # a short heading: "Config vars"
            title = first
        else:                                              # a sentence: named by what it declares, the sentence kept
            title = codeName(code) or ' '.join(first.split()[:6]) + ' ...'
            rest  = [first] + rest
        if not title:
            title = codeName(code) or 'declarations'
        out.append((title, summary, rest, '\n'.join(code), e['notes']))
    entries = out

    return desc, entries


#
# titled - does a comment's first line name what it is about: "name - ...", "a / b - ...", "name -"
#
def titled(first):
    return re.match(r'^[A-Za-z_][\w]*(\s*[,/]\s*[A-Za-z_][\w]*)*\s+-(\s|$)', first.strip()) is not None


def codeName(code):
    for line in code:
        m = re.search(r'\b(\w+)\s*\(', line) or re.search(r'\b(\w+)\s*;', line)
        if m:
            return m.group(1)
    return None


def pageRender(item, repo, sha, headers):
    lib   = repo
    parts = []
    parts.append('<!-- Copyright 2026 Seamware - SPDX-License-Identifier: Apache-2.0 -->')
    parts.append('<!-- docs/%s.html - GENERATED by %s from %s at %s: do not edit, run it again -->' % (item['id'], GENERATOR, lib, sha[:8]))
    parts.append('<article class="guide api">')
    parts.append('<h1>%s</h1>' % esc(item['title']))
    count = sum(len(e) for _, _, e in headers)
    parts.append('<p class="lead">%s</p>' % item['about'])     # hand-written in guides.json: what the library solves
    if item.get('guide'):
        parts.append('<p>How its parts fit and how it is used: <a href="#docs/%s">the %s guide</a>.</p>' % (item['guide'], esc(lib)))
    parts.append('<p class="api-src">Below: every header of <a href="https://github.com/SEAMWARE/%s" target="_blank" rel="noopener">%s</a> '
                 'at <code>%s</code> - %d headers, %d entries, each with its declarations as written and its comment. '
                 'Included as <code>&quot;%s/&lt;header&gt;&quot;</code>.</p>' % (lib, lib, sha[:8], len(headers), count, lib))

    taken = set()
    for path, desc, entries in headers:
        hid = anchor('h-' + os.path.splitext(os.path.basename(path))[0], taken)
        parts.append('')
        parts.append('<h2 id="%s"><code>%s</code></h2>' % (hid, esc(path)))
        if desc:
            parts.append(commentText(desc))
        for title, summary, rest, code, notes in entries:
            eid = anchor(title, taken)
            parts.append('<h3 id="%s"><code>%s</code></h3>' % (eid, esc(title)))
            if summary:
                parts.append('<p class="api-summary">' + esc(summary) + '</p>')
            if code:
                parts.append('<pre class="api-decl">' + esc(code) + '</pre>')
            if rest:
                t = commentText(rest)
                if t:
                    parts.append(t)
            if notes:
                parts.append(commentText(notes))
    parts.append('</article>')
    return '\n'.join(parts) + '\n'


def headersOf(repo, sha):
    names = git(repo, 'ls-tree', '-r', '--name-only', sha).split('\n')
    hs    = [n for n in names if n.endswith('.h') and not n.startswith(SKIP_DIRS) and '/test' not in n]
    # The library's own type headers first (CorX.h), then the rest by name - the order a reader meets them
    hs.sort(key=lambda n: (0 if os.path.basename(n)[:1].isupper() else 1, n.lower()))
    return hs


def main():
    gpath = os.path.join(c3, 'www', 'docs', 'guides.json')
    with open(gpath) as f:
        text = f.read()
    contents = json.loads(text)

    done = 0
    for group in contents['groups']:
        for item in group['items']:
            if item.get('generated') != GENERATOR:
                continue
            src  = item['from'][0]
            repo = os.path.join(clones, src['repo'])
            sha  = git(repo, 'rev-parse', ref).strip()

            headers = []
            for h in headersOf(repo, sha):
                desc, entries = headerParse(git(repo, 'show', sha + ':' + h))
                headers.append((h, desc, entries))

            out = os.path.join(c3, 'www', 'docs', item['id'] + '.html')
            with open(out, 'w') as f:
                f.write(pageRender(item, src['repo'], sha, headers))

            # 'at' moved on, in the file's own text - the rest of guides.json left as it is written
            old  = '"at": "%s"' % src['at']
            pos  = text.find('"id": "%s"' % item['id'])
            at   = text.find(old, pos)
            text = text[:at] + '"at": "%s"' % sha[:8] + text[at + len(old):]
            src['at'] = sha[:8]

            print('%s: %d headers, %d entries (%s at %s)' % (out, len(headers), sum(len(e) for _, _, e in headers), src['repo'], sha[:8]))
            done += 1

    with open(gpath, 'w') as f:
        f.write(text)
    json.loads(text)
    if done == 0:
        print('apiRef.py: no guide in guides.json is generated by it', file=sys.stderr)
        sys.exit(1)


main()
