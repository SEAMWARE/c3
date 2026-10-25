#!/usr/bin/env python3
#
# docsStale.py - the guides of the Documentation page whose sources changed since they were written
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
# Usage: tools/docsStale.py [<directory holding the clones>]      (default: the one c3 is in)
#
# Each guide in www/docs/guides.json names the Markdown it is written from ('from') and the commit of that
# repository it was last brought up to date with ('at'). A source with commits after 'at' is listed, with
# them; the guide is then read against them and 'at' moved on. Exit 1 when anything is listed.
#
import json
import os
import subprocess
import sys

here   = os.path.dirname(os.path.abspath(__file__))
c3     = os.path.dirname(here)
clones = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(c3)

with open(os.path.join(c3, 'www', 'docs', 'guides.json')) as f:
    contents = json.load(f)

stale = 0
for group in contents['groups']:
    for item in group['items']:
        for src in item.get('from', []):
            repo = os.path.join(clones, src['repo'])
            try:
                log = subprocess.run(['git', '-C', repo, 'log', '--oneline', src['at'] + '..HEAD', '--', src['path']],
                                     capture_output=True, text=True, check=True).stdout.strip()
            except (subprocess.CalledProcessError, FileNotFoundError) as e:
                print(f"{item['id']}: {src['repo']}/{src['path']}: cannot be checked ({repo}: {getattr(e, 'stderr', e) or e})".strip())
                stale += 1
                continue
            if log:
                stale += 1
                print(f"{item['id']}: {src['repo']}/{src['path']} changed since {src['at']}:")
                for line in log.splitlines():
                    print('    ' + line)

sys.exit(1 if stale else 0)
