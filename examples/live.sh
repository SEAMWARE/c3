#!/usr/bin/env bash
#
# live.sh - the factory's robots at work, for c³ Connect's live values
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
# Usage: examples/live.sh [broker-url] [seconds-per-step] [steps]
#
#   broker-url         default http://localhost:1026 - run examples/factory.sh on it first
#   seconds-per-step   default 0.5
#   steps              default 0: until Ctrl-C
#
# Each step PATCHes the factory's entities (examples/factory.sh) as a running floor would:
#
#   - the robots of the three running Missions drive their Mission's route (route, a LineString) to
#     the end and back: their location moves along it, their speed changes, their battery runs down
#     (and is swapped for a full one at 15 %), and the Mission's progress follows the robot;
#   - the two robots at a charger charge (batteryLevel up, until full - then start again from 20 %);
#   - every 16 steps a Mission is created (urn:ngsi-ld:Mission:m-live, queued for amr2), and deleted
#     16 steps later: an entity appearing and disappearing.
#
# CHURN=0 leaves out the created and deleted Mission.
#
set -euo pipefail

BROKER="${1:-http://localhost:1026}"
STEP="${2:-0.5}"
STEPS="${3:-0}"
CHURN="${CHURN:-1}"
BROKER="${BROKER%/}"

U() { echo "urn:ngsi-ld:$1:$2"; }

#
# robot | mission | route (lon lat;...) | steps from one end of the route to the other
#
MOVERS=(
  "amr1|m-0714|13.4052 52.5199;13.4054 52.5199;13.4054 52.52015|24"
  "amr3|m-0712|13.4049 52.5199;13.4049 52.5201;13.4045 52.5201|18"
  "amr4|m-0715|13.4048 52.5203;13.4051 52.5203;13.4051 52.52025|30"
)
CHARGERS=(amr2 amr5)

#
# send - one request; a broker that cannot be reached, or a factory that is not there, stops the script
#
send()
{
  local method="$1" path="$2" body="${3:-}"
  local args=(-s -o /tmp/live.$$.out -w '%{http_code}' -X "$method" "$BROKER$path")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data-binary "$body")
  local status
  status=$(curl "${args[@]}" || echo 000)
  case "$status" in
    2*) ;;
    000) echo "live.sh: $BROKER cannot be reached" >&2; rm -f /tmp/live.$$.out; exit 1;;
    404) if [ "$method" = PATCH ]; then echo "live.sh: $path: 404 - run examples/factory.sh $BROKER first" >&2; rm -f /tmp/live.$$.out; exit 1; fi;;
    *)   echo "live.sh: $method $path answered $status: $(cat /tmp/live.$$.out)" >&2;;
  esac
}

#
# On the way out (also Ctrl-C), a Mission created and not yet deleted is not left behind
#
cleanup()
{
  rm -f /tmp/live.$$.out
  [ "$CHURN" = 1 ] && curl -s -o /dev/null -m 2 -X DELETE "$BROKER/ngsi-ld/v1/entities/$(U Mission m-live)" || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

#
# The state the script starts from: the batteries as factory.sh left them
#
declare -A BATTERY=([amr1]=0.74 [amr2]=0.31 [amr3]=0.88 [amr4]=0.55 [amr5]=0.12)

echo "live.sh: moving the factory's robots on $BROKER every ${STEP}s - Ctrl-C stops"

step=0
while [ "$STEPS" -eq 0 ] || [ "$step" -lt "$STEPS" ]
do
  for m in "${MOVERS[@]}"
  do
    IFS='|' read -r robot mission route legs <<< "$m"

    #
    # Where on the route (ping-pong), the speed, the battery - one awk for the arithmetic
    #
    read -r lon lat speed progress battery <<< "$(awk -v route="$route" -v step="$step" -v legs="$legs" -v b="${BATTERY[$robot]}" 'BEGIN {
      n = split(route, p, ";")
      for (i = 1; i <= n; i++) { split(p[i], xy, " "); x[i] = xy[1]; y[i] = xy[2] }
      total = 0
      for (i = 2; i <= n; i++) { d[i] = sqrt((x[i]-x[i-1])^2 + (y[i]-y[i-1])^2); total += d[i] }
      k = step % (2 * legs); t = (k <= legs) ? k / legs : (2 * legs - k) / legs
      want = t * total; px = x[n]; py = y[n]
      for (i = 2; i <= n; i++) {
        if (want <= d[i]) { f = (d[i] > 0) ? want / d[i] : 0; px = x[i-1] + f * (x[i]-x[i-1]); py = y[i-1] + f * (y[i]-y[i-1]); break }
        want -= d[i]
      }
      speed = (k == 0 || k == legs) ? 0 : 0.7 + 0.45 * sin(step * 0.7 + legs)
      b -= 0.006; if (b < 0.15) b = 0.95
      printf "%.7f %.7f %.2f %.2f %.3f\n", px, py, speed, t, b
    }')"
    BATTERY[$robot]=$battery

    send PATCH "/ngsi-ld/v1/entities/$(U Robot "$robot")/attrs" \
      "{\"location\": {\"type\": \"GeoProperty\", \"value\": {\"type\": \"Point\", \"coordinates\": [$lon, $lat]}}, \"speed\": {\"type\": \"Property\", \"value\": $speed}, \"batteryLevel\": {\"type\": \"Property\", \"value\": $battery}}"
    send PATCH "/ngsi-ld/v1/entities/$(U Mission "$mission")/attrs" "{\"progress\": {\"type\": \"Property\", \"value\": $progress}}"
  done

  for robot in "${CHARGERS[@]}"
  do
    BATTERY[$robot]=$(awk -v b="${BATTERY[$robot]}" 'BEGIN { b += 0.01; if (b > 1) b = 0.2; printf "%.3f", b }')
    send PATCH "/ngsi-ld/v1/entities/$(U Robot "$robot")/attrs" "{\"batteryLevel\": {\"type\": \"Property\", \"value\": ${BATTERY[$robot]}}}"
  done

  if [ "$CHURN" = 1 ] && [ $((step % 16)) -eq 0 ] && [ "$step" -gt 0 ]
  then
    if [ $((step / 16 % 2)) -eq 1 ]
    then
      send POST "/ngsi-ld/v1/entities" "{\"id\": \"$(U Mission m-live)\", \"type\": \"Mission\", \"status\": {\"type\": \"Property\", \"value\": \"queued\"}, \"progress\": {\"type\": \"Property\", \"value\": 0}, \"assignedTo\": {\"type\": \"Relationship\", \"object\": \"$(U Robot amr2)\"}, \"target\": {\"type\": \"Relationship\", \"object\": \"$(U Shelf shelf20)\"}}"
    else
      send DELETE "/ngsi-ld/v1/entities/$(U Mission m-live)"
    fi
  fi

  step=$((step + 1))
  sleep "$STEP"
done
