#!/usr/bin/env bash
#
# factory.sh - a small factory floor as NGSI-LD entities, for c³ Connect to draw
#
# Usage: examples/factory.sh [broker-url] [sensors]
#
#   broker-url   default http://localhost:1026
#   sensors      extra TemperatureSensor entities (default 0), each one observing a
#                Shelf or a Dock - enough of them to take a load over several pages
#
# 25 entities: a Building, two Floors, Docks, Shelves, ChargingStations, Robots, Missions and
# Operators, joined by Relationships (partOf, locatedIn, isDockedAt, isChargingAt, assignedTo,
# target, supervises). The Building, the Docks and the Robots have a location (a Point), the Floors
# an outline (location, a Polygon) and the running Missions a route (route, a LineString - a
# GeoProperty other than location).
# No @context: every term expands with the core context's default vocabulary.
#
# Entities are created with POST /ngsi-ld/v1/entityOperations/upsert, so running the script
# twice leaves the same entities.
#
set -euo pipefail

BROKER="${1:-http://localhost:1026}"
SENSORS="${2:-0}"
BROKER="${BROKER%/}"

U() { echo "urn:ngsi-ld:$1:$2"; }

prop()  { printf '"%s": {"type": "Property", "value": %s}' "$1" "$2"; }
rel()   { printf '"%s": {"type": "Relationship", "object": "%s"}' "$1" "$2"; }
point() { printf '"location": {"type": "GeoProperty", "value": {"type": "Point", "coordinates": [%s, %s]}}' "$1" "$2"; }
area()  { printf '"location": {"type": "GeoProperty", "value": {"type": "Polygon", "coordinates": [[%s]]}}' "$1"; }
route() { printf '"route": {"type": "GeoProperty", "value": {"type": "LineString", "coordinates": [%s]}}' "$1"; }

ENTITIES=()
add() { ENTITIES+=("$1"); }

# entity <type> <name> <member>... - one entity, its members already rendered
entity()
{
  local type="$1" name="$2"
  shift 2
  local IFS=','
  add "{\"id\": \"$(U "$type" "$name")\", \"type\": \"$type\", $*}"
}

B=$(U Building north)
F1=$(U Floor n-1)
F2=$(U Floor n-2)

entity Building north "$(prop name '"Plant North"')" "$(prop address '"Dock Road 4"')" "$(point 13.4050 52.5200)"
entity Floor n-1 "$(prop level 1)" "$(prop area 4200)" "$(rel partOf "$B")" "$(area '[13.4044, 52.51965], [13.4056, 52.51965], [13.4056, 52.52005], [13.4044, 52.52005], [13.4044, 52.51965]')"
entity Floor n-2 "$(prop level 2)" "$(prop area 3100)" "$(rel partOf "$B")" "$(area '[13.4044, 52.52005], [13.4054, 52.52005], [13.4054, 52.52035], [13.4044, 52.52035], [13.4044, 52.52005]')"

entity Dock dock1 "$(prop status '"free"')"     "$(rel locatedIn "$F1")" "$(point 13.4046 52.5198)"
entity Dock dock2 "$(prop status '"occupied"')" "$(rel locatedIn "$F1")" "$(point 13.4049 52.5198)"
entity Dock dock3 "$(prop status '"occupied"')" "$(rel locatedIn "$F1")" "$(point 13.4052 52.5198)"

entity Shelf shelf10 "$(prop fillLevel 0.91)" "$(rel locatedIn "$F1")"
entity Shelf shelf11 "$(prop fillLevel 0.40)" "$(rel locatedIn "$F1")"
entity Shelf shelf12 "$(prop fillLevel 0.62)" "$(rel locatedIn "$F1")"
entity Shelf shelf20 "$(prop fillLevel 0.15)" "$(rel locatedIn "$F2")"
entity Shelf shelf21 "$(prop fillLevel 0.77)" "$(rel locatedIn "$F2")"

entity ChargingStation charger1 "$(prop power 3.3)" "$(prop status '"idle"')"     "$(rel locatedIn "$F1")"
entity ChargingStation charger2 "$(prop power 3.3)" "$(prop status '"charging"')" "$(rel locatedIn "$F2")"

entity Robot amr1 "$(prop batteryLevel 0.74)" "$(prop speed 0.82)" "$(rel isDockedAt "$(U Dock dock3)")"            "$(point 13.4052 52.5199)"
entity Robot amr2 "$(prop batteryLevel 0.31)" "$(prop speed 0)"    "$(rel isChargingAt "$(U ChargingStation charger2)")" "$(point 13.4051 52.5202)"
entity Robot amr3 "$(prop batteryLevel 0.88)" "$(prop speed 1.10)" "$(rel isDockedAt "$(U Dock dock2)")"            "$(point 13.4049 52.5199)"
entity Robot amr4 "$(prop batteryLevel 0.55)" "$(prop speed 0.40)" "$(rel locatedIn "$F2")"                          "$(point 13.4048 52.5203)"
entity Robot amr5 "$(prop batteryLevel 0.12)" "$(prop speed 0)"    "$(rel isChargingAt "$(U ChargingStation charger1)")" "$(point 13.4047 52.5201)"

entity Mission m-0711 "$(prop status '"done"')"    "$(prop progress 1.0)"  "$(rel assignedTo "$(U Robot amr3)")" "$(rel target "$(U Shelf shelf10)")"
entity Mission m-0712 "$(prop status '"running"')" "$(prop progress 0.80)" "$(rel assignedTo "$(U Robot amr3)")" "$(rel target "$(U Shelf shelf11)")" "$(route '[13.4049, 52.5199], [13.4049, 52.5201], [13.4045, 52.5201]')"
entity Mission m-0713 "$(prop status '"queued"')"  "$(prop progress 0)"    "$(rel assignedTo "$(U Robot amr4)")" "$(rel target "$(U Shelf shelf20)")"
entity Mission m-0714 "$(prop status '"running"')" "$(prop progress 0.35)" "$(rel assignedTo "$(U Robot amr1)")" "$(rel target "$(U Shelf shelf12)")" "$(route '[13.4052, 52.5199], [13.4054, 52.5199], [13.4054, 52.52015]')"
entity Mission m-0715 "$(prop status '"running"')" "$(prop progress 0.10)" "$(rel assignedTo "$(U Robot amr4)")" "$(rel target "$(U Shelf shelf21)")" "$(route '[13.4048, 52.5203], [13.4051, 52.5203], [13.4051, 52.52025]')"

entity Operator op-17 "$(prop shift '"B"')" "$(rel supervises "$(U Mission m-0714)")"
entity Operator op-22 "$(prop shift '"A"')" "$(rel supervises "$(U Mission m-0713)")"

TARGETS=("$(U Shelf shelf10)" "$(U Shelf shelf11)" "$(U Shelf shelf12)" "$(U Shelf shelf20)" "$(U Shelf shelf21)"
         "$(U Dock dock1)" "$(U Dock dock2)" "$(U Dock dock3)")
for ((i = 1; i <= SENSORS; i++))
do
  t=$(awk -v i="$i" 'BEGIN { printf "%.1f", 18 + (i * 37 % 90) / 10 }')
  entity TemperatureSensor "$(printf 't%04d' "$i")" "$(prop temperature "$t")" "$(rel observes "${TARGETS[$(( i % ${#TARGETS[@]} ))]}")"
done

#
# POST in batches of 100 (a broker may cap the size of a batch)
#
total=${#ENTITIES[@]}
for ((start = 0; start < total; start += 100))
do
  batch=$(IFS=','; echo "[${ENTITIES[*]:start:100}]")
  status=$(curl -s -o /tmp/factory.$$.out -w '%{http_code}' -X POST "$BROKER/ngsi-ld/v1/entityOperations/upsert" \
                -H 'Content-Type: application/json' --data-binary "$batch")
  case "$status" in
    201|204) ;;
    *) echo "factory.sh: $BROKER answered $status:" >&2; cat /tmp/factory.$$.out >&2; echo >&2; rm -f /tmp/factory.$$.out; exit 1;;
  esac
done
rm -f /tmp/factory.$$.out

echo "factory.sh: $total entities on $BROKER"
