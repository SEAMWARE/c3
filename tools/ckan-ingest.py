#!/usr/bin/env python3
#
# ckan-ingest.py - one CKAN DataStore resource into an NGSI-LD broker, one entity per record
#
# ckan-ingest.py <ckan-base-url> <resource-id> <entity-type> <id-field> <lat-field> <lon-field> [broker-url]
#
# Every other field becomes a Property (numbers as numbers), the coordinates a GeoProperty 'location'.
# Upserts in batches of 100, so it can be re-run.
#
# e.g. Boston's Blue Bike stations:
#   ckan-ingest.py https://data.boston.gov 44c931aa-4577-4caa-a8f2-ed1e38263e70 BikeStation Number Latitude Longitude
#
import json, re, sys, urllib.parse, urllib.request

ckan, rid, etype, idf, latf, lonf = sys.argv[1:7]
broker = sys.argv[7] if len(sys.argv) > 7 else 'http://localhost:1026'
SKIP = {'_id', idf, latf, lonf, 'shape_wkt', 'POINT_X', 'POINT_Y'}

def num(v):
    try:
        return int(v) if re.fullmatch(r'-?\d+', v) else float(v) if re.fullmatch(r'-?\d+\.\d*', v) else v
    except (TypeError, ValueError):
        return v

def records():
    offset = 0
    while True:
        q = urllib.parse.urlencode({'resource_id': rid, 'limit': 500, 'offset': offset})
        r = json.load(urllib.request.urlopen(f'{ckan}/api/3/action/datastore_search?{q}'))['result']
        yield from r['records']
        offset += len(r['records'])
        if not r['records'] or offset >= r['total']:
            return

def entity(rec):
    e = {'id': f'urn:ngsi-ld:{etype}:{urllib.parse.quote(str(rec[idf]), safe="")}', 'type': etype,
         'location': {'type': 'GeoProperty', 'value': {'type': 'Point',
                      'coordinates': [float(rec[lonf]), float(rec[latf])]}}}
    for k, v in rec.items():
        if k not in SKIP and v not in (None, ''):
            e[re.sub(r'\W', '_', k).strip('_') or 'field'] = {'type': 'Property', 'value': num(v)}
    return e

batch, n = [], 0
def send():
    global n
    req = urllib.request.Request(f'{broker}/ngsi-ld/v1/entityOperations/upsert', json.dumps(batch).encode(),
                                 {'Content-Type': 'application/json'}, method='POST')
    urllib.request.urlopen(req).read()
    n += len(batch); batch.clear()

for rec in records():
    try:
        batch.append(entity(rec))
    except (KeyError, TypeError, ValueError):
        continue                     # a record without coordinates
    if len(batch) == 100:
        send()
if batch:
    send()
print(f'{n} {etype} entities into {broker}')
