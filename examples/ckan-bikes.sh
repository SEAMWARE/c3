#!/usr/bin/env bash
#
# ckan-bikes.sh - real open data for c³: a city's bike-share stations, read from a CKAN portal
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
# Usage: examples/ckan-bikes.sh [broker-url] [limit]
#
#   broker-url   default http://localhost:1026
#   limit        stations to ingest (default: all of them)
#
# Reads Boston's "Blue Bike Stations" (data.boston.gov, licence ODC PDDL) through CKAN's
# DataStore API (datastore_search, rows as JSON), turns every row into an NGSI-LD entity and
# upserts them into the broker:
#
#   BikeStation  urn:ngsi-ld:BikeStation:<Number>   name, totalDocks, public, location (Point),
#                                                   inDistrict -> District
#   District     urn:ngsi-ld:District:<District>    name, location (Polygon)
#
# The Relationship to the District gives the graph its structure; the location puts every
# station on the map. A District's location is the convex hull of its stations - drawn from the
# stations, not the district's official boundary (a district of one or two stations: their centre,
# a Point).
#
# This is CKAN ingest by hand, once - what the CKAN bridge on the roadmap does as a Channel, with
# the column mapping made in c³ Configure. The column-to-attribute mapping is the jq program below.
#
# Needs curl and jq. Running it twice leaves the same entities (upsert).
#
set -euo pipefail

BROKER="${1:-http://localhost:1026}"
LIMIT="${2:-0}"
BROKER="${BROKER%/}"

PORTAL=https://data.boston.gov
RESOURCE=44c931aa-4577-4caa-a8f2-ed1e38263e70        # Blue Bike Stations, CSV in the DataStore
PAGE=100

rows=$(mktemp)
trap 'rm -f "$rows"' EXIT
echo '[]' > "$rows"

# Every row, a page at a time
offset=0
while :; do
  page=$(curl -sf -m 30 "$PORTAL/api/3/action/datastore_search?resource_id=$RESOURCE&limit=$PAGE&offset=$offset")
  n=$(jq '.result.records | length' <<< "$page")
  jq -s '.[0] + .[1].result.records' "$rows" <(echo "$page") > "$rows.new" && mv "$rows.new" "$rows"
  offset=$((offset + n))
  total=$(jq '.result.total' <<< "$page")
  { [ "$n" -lt "$PAGE" ] || [ "$offset" -ge "$total" ]; } && break
  { [ "$LIMIT" -gt 0 ] && [ "$offset" -ge "$LIMIT" ]; } && break
done

[ "$LIMIT" -gt 0 ] && jq ".[:$LIMIT]" "$rows" > "$rows.new" && mv "$rows.new" "$rows"

# The mapping: a row -> a BikeStation, every District named -> a District
entities=$(jq '
  def id($t; $s): "urn:ngsi-ld:\($t):\($s | gsub("[^A-Za-z0-9._-]"; "_"))";
  def prop($v):   {type: "Property", value: $v};

  # The convex hull of points (monotone chain), closed - null for fewer than three corners
  def cross($o; $a; $b): ($a[0] - $o[0]) * ($b[1] - $o[1]) - ($a[1] - $o[1]) * ($b[0] - $o[0]);
  def half: reduce .[] as $p ([]; until(length < 2 or cross(.[-2]; .[-1]; $p) > 0; .[:-1]) + [$p]);
  def hull: unique as $s | ($s | half)[:-1] + ($s | reverse | half)[:-1] |
            if length < 3 then null else . + [.[0]] end;

  [ .[] | select(.Latitude != null and .Longitude != null and .Number != null) |
    { id:   id("BikeStation"; .Number),
      type: "BikeStation",
      name:       prop(.Name),
      totalDocks: prop(.Total_docks | tonumber? // 0),
      public:     prop(.Public_ == "Yes"),
      location:   {type: "GeoProperty",
                   value: {type: "Point", coordinates: [(.Longitude | tonumber), (.Latitude | tonumber)]}}
    } + (if (.District // "") != "" then {inDistrict: {type: "Relationship", object: id("District"; .District)}} else {} end)
  ]
  + ( [ .[] | select(.Latitude != null and .Longitude != null and (.District // "") != "") ] |
      group_by(.District) |
      map(. as $g |
          [ $g[] | [(.Longitude | tonumber), (.Latitude | tonumber)] ] as $pts |
          {id: id("District"; $g[0].District), type: "District", name: prop($g[0].District)} +
          (($pts | hull) as $h |
           if $h != null then {location: {type: "GeoProperty", value: {type: "Polygon", coordinates: [$h]}}}
           else {location: {type: "GeoProperty", value: {type: "Point", coordinates: [($pts | map(.[0]) | add / length), ($pts | map(.[1]) | add / length)]}}}
           end)) )
' "$rows")

count=$(jq 'length' <<< "$entities")

# Upsert, in batches the broker accepts
batch=100
for ((i = 0; i < count; i += batch)); do
  jq ".[$i:$((i + batch))]" <<< "$entities" |
    curl -sf -m 60 -o /dev/null -X POST "$BROKER/ngsi-ld/v1/entityOperations/upsert" \
         -H 'Content-Type: application/json' --data-binary @-
done

stations=$(jq '[.[] | select(.type == "BikeStation")] | length' <<< "$entities")
districts=$((count - stations))
echo "$stations bike stations and $districts districts from $PORTAL upserted into $BROKER"
