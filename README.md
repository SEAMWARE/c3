# c³ - the coraine Control Center

One application for everything around a [coraine](https://github.com/SEAMWARE/coraine) broker: build
it, configure its bridges, watch it live, and learn it - including how to write a plugin for it.

| Part | What it does |
|---|---|
| **Compile** | Build a broker for a deployment: the features compiled in or out, profile training (PGO) and tuning on a workload, the target hardware - the result as a binary, a container image or a Debian package. Drives `coraine-build` from the `coraine-dev` package. |
| **Configure** | The mapping tools: DDS topics, services and actions to NGSI-LD entities and attributes (the file the DDS bridge reads), the same for OPC UA, and the column mapping for the CKAN and CSV bridges. |
| **Run** | Start and stop brokers - natively or in a container - and the services they need: MongoDB, PostgreSQL/TimescaleDB, Mosquitto. |
| **Operate** | The brokers themselves, several at once: live logs, log and trace levels changed on a running broker, metrics as charts, health. |
| **Docs** | All of coraine's documentation in one place, much easier to read than Markdown on GitHub: the broker (everything on Read the Docs), every cor-lib, the plugin and bridge contracts, searchable, offline. And help to write a new plugin: a skeleton repository - makefile, template `.c`/`.h` files, a functest - for each kind of plugin. |
| **Connect** | A live connection to a running broker: entities as boxes, Relationships as arrows, zoom, pan, entities dragged into place; the entities with a GeoProperty on a map; values as they change. |

Status: **milestone 2b** - the `c3` command, its backend, the configuration file, the splash screen,
**Connect, read-only**: discovery, the types picked, an entity's menu (linked entities, neighbourhood),
the entities **on a map**, online or from downloaded areas offline, and **live values** - over the
broker's WebSocket transport, or HTTP notifications to the backend - and **Compile**: a broker built by
`coraine-build` with the features chosen, its output followed live, the builds kept - and **Run**: brokers
started and stopped natively or in a container, with MongoDB, PostgreSQL/TimescaleDB and Mosquitto as
containers. [doc/design.md](doc/design.md)
is the plan, [doc/areas.md](doc/areas.md) the milestones, [design/](design/) the screen designs.

## Try it

The backend builds against the cor-libs as coraine does: sibling checkouts (`../corHttp`, `../corRest`,
`../corJson`, `../corTree`, `../corArgs`, `../corLog`, `../corAlloc`, `../corBase`), each one built
(`make` in it). It also needs OpenSSL (`libssl-dev`), for corRest's client, and zlib (`zlib1g-dev`), for
the map files. One corHttp change and two corRest fixes matter:

- [SEAMWARE/corHttp#13](https://github.com/SEAMWARE/corHttp/pull/13) - file and streamed response bodies:
  Compile's live log (server-sent events) and files sent from the file. Until it is merged, build against
  its branch `feat/stream-file` (`COR_LIBS=<dir>` with that checkout as `<dir>/corHttp`). Built against a
  corHttp without it, c³ still works: `GET /api/capabilities` says `"liveLog": false`, the page reads a
  build's log by Range once a second, and files are read into memory (a range of 16 MiB at most).


- [SEAMWARE/corRest#37](https://github.com/SEAMWARE/corRest/pull/37) - a neighbourhood's query (below) is
  a long URL, and the multi client's send buffer must count the path; without it, a request whose path
  and query pass about 450 characters is not sent and the proxy answers 502.
- [SEAMWARE/corRest#38](https://github.com/SEAMWARE/corRest/pull/38) - over TLS, the multi client must
  read what OpenSSL has already decrypted; without it, about one HTTPS request in a hundred waits for its
  timeout, and "Download this area" takes a minute longer each time (it retries, and completes).

```sh
make                                                   # ./c3

coraine -fg -db corDB -p 1090 --transports ws &        # a broker, in RAM, on a port of its own, with its WebSocket transport
examples/factory.sh http://localhost:1090              # 25 entities with Relationships, locations, areas and routes
examples/live.sh http://localhost:1090 &               # ... and its robots at work: the values change every 0.5 s
examples/factory.sh http://localhost:1090 300          # ... and 300 sensors more, to page through
examples/ckan-bikes.sh http://localhost:1090           # real open data: 572 Boston bike stations + 13 districts (areas) from a CKAN portal

./c3                                                   # opens the application; Ctrl-C stops it
```

In Connect, enter `http://localhost:1090` and press **Connect**. With the factory alone (25 entities)
everything is loaded at once; with the bike stations too (610), tick the types to see - **District**,
then **BikeStation** - and press **Load**. Right-click a Robot for its linked entities (Dock, Floor,
Building) or its neighbourhood. The next start connects to the last broker by itself, with the types
picked last time.

With `examples/live.sh` running, the robots' boxes show their speed and battery as they change, and on
the map they drive their Missions' routes; every 8 s a Mission appears or disappears. **Live ·
WebSocket** at the top says how the changes arrive (below).

**Map** (top left of the graph) puts the same entities on a map. With the bike stations: **colour by**
`inDistrict →` gives each district its colour - its stations and its area; click a station for its
attributes and the line to its district. **Download this area** shows the size of the area in view
down to the level chosen, then downloads it: from then on it is drawn from the file, also offline.

`make run ARGS="--port 7901 --no-browser"` builds and runs from the checkout; `make install`
(`PREFIX=/usr/local`, `DESTDIR` for packaging) installs `bin/c3` and `share/c3/www`; `make clean`.

## The `c3` command

```
c3 [--port <port>] [--config <file>] [--no-browser] [--www <directory>] [--planet <url>]
   [--coraine-build <path>] [--source <tarball>]
```

| Option | Default | |
|---|---|---|
| `--port`, `-p` | 7900 | the backend's TCP port |
| `--config`, `-c` | `$XDG_CONFIG_HOME/c3/c3.json`, else `~/.config/c3/c3.json` | the configuration file |
| `--no-browser`, `-nb` | | serve only, and print the URL |
| `--www`, `-w` | `<binary's dir>/www`, else `<binary's dir>/../share/c3/www` | the pages |
| `--planet`, `-pl` | the newest daily build at `build.protomaps.com` | the Protomaps planet (`.pmtiles` URL) map areas are extracted from |
| `--coraine-build`, `-cb` | `coraine-build` in `$PATH` (the `coraine-dev` package) | the script Compile runs |
| `--source`, `-src` | `coraine-build`'s own, `/usr/share/coraine/src/coraine-src.tar.xz` | the coraine source tarball Compile builds from (passed on as `--source`) |

Every option can also be given in the environment: `C3_` and the option's name, upper case, `-` as `_`
(`C3_CORAINE_BUILD`, `C3_SOURCE`).

Opening the application:

- **Chrome or Chromium** in `$PATH` (`google-chrome`, `google-chrome-stable`, `chromium`,
  `chromium-browser`; on macOS also in `/Applications`): an application window of its own,
  `--app=<url> --start-fullscreen`, with a profile of its own in `$XDG_STATE_HOME/c3/chrome`
  (`~/.local/state/c3/chrome`). A Chrome that is already running with the normal profile would take
  the request over and open an ordinary window, ignoring both flags.
- Otherwise the default browser: `xdg-open`, `open` on macOS.
- **No screen** (Linux, no `$DISPLAY` and no `$WAYLAND_DISPLAY`): the URL is printed, with the
  `ssh -L` line to reach it from another machine.

The backend answers **this machine only**: a connection from another address gets 403, and so does a
request whose `Host` is not `localhost`, `127.0.0.1` or `[::1]` (another site's page, through DNS
rebinding, cannot reach the proxy). From another machine: `ssh -L 7900:localhost:7900 <host>`.

A second `c3` on a port where one is running opens the running one and exits; any other program on
the port is an error.

## The configuration file

`~/.config/c3/c3.json`, written by the backend as the user works - never by the page. It holds the
brokers connected to, with Connect's choices for each (the types, graph or map, the map's view, what the
markers are coloured by), the downloaded map areas, and the last page:

```json
{
  "version": 1,
  "brokers": [
    {
      "url": "http://localhost:1090",
      "name": "localhost:1090",
      "lastUsed": "2026-10-09T17:35:43Z",
      "connect": {
        "types": ["BikeStation", "District"],
        "view": "map",
        "colourBy": "inDistrict",
        "map": { "center": [-71.135, 42.3836], "zoom": 13.3 }
      }
    }
  ],
  "maps": {
    "areas": [
      { "id": "area-20261009-191900", "name": "Boston", "bbox": [-71.19, 42.3, -70.99, 42.4],
        "maxzoom": 15, "bytes": 13929458, "created": "2026-10-09T19:19:00Z", "build": "20261009" }
    ]
  },
  "compile": {
    "choice": { "mode": "release", "features": { "REGISTRATIONS": false, "MONGOC": false } },
    "presets": [ { "name": "edge node", "mode": "release", "features": { "REGISTRATIONS": false, "SUBSCRIPTIONS": false, "MONGOC": false } } ]
  },
  "run": {
    "brokers": [
      { "name": "mt", "from": "installed", "build": null, "image": null, "where": "native", "set": "mongoc-timescale",
        "store": "mongoc", "dbDir": false, "history": "timescale", "port": 1592, "healthPort": 1593,
        "transports": ["ws"], "bridges": [], "bridgeConfig": null, "admin": true, "verbose": true, "args": "",
        "grace": 30, "lastStarted": "2026-10-10T08:00:00Z" }
    ]
  },
  "ui": { "lastPage": "connect" }
}
```

- A broker is added, or moved to the front with a new `lastUsed`, when it has answered the discovery;
  the 50 most recent are kept. A broker already in the list keeps its other members.
- `connect.types`: the types loaded with **Load**, sorted. `[]` is a choice too (nothing loaded); a
  broker with no `types` was never picked for.
- `connect.view` (`graph` or `map`), `connect.colourBy` (`type`, or a Relationship's name) and
  `connect.map` (`center` `[lon, lat]`, `zoom`, `bearing`, `pitch`): kept as they change - the map's view
  when the map is moved by hand.
- `maps.areas`: the areas downloaded, one `.pmtiles` file each in the data directory. The directory is
  the truth: a finished download is added, an area whose file is gone is dropped, a file with no entry
  is added under its id (its bounds and levels read from the file's header).
- Written whole to `c3.json.tmp`, then renamed over `c3.json` (mode 600, the directory 700).
- `compile.choice`: Compile's choice as it is (`mode`, the `features` set by hand, `workload`), kept as it
  changes; `compile.presets`: the choices saved under a name. The builds themselves are not listed here:
  their directory is the truth (Compile, below).
- `run.brokers`: the brokers Run started, with their options (Run, below) - kept when one is started, removed
  with **Forget**. What runs is not in the file: the processes and containers are the truth.
- Members this version does not know are kept. A file that is not a JSON object is moved to
  `c3.json.broken` and c³ starts from an empty one; a file with a `version` above 1 is read and never
  written.

## Connect

- **Discovery** - what a broker holds, before any entity is loaded:
  - `GET /ngsi-ld/v1/types?details=true` - the types and their attribute names (a broker that does not
    answer it is asked for `GET /types`);
  - `GET /ngsi-ld/v1/types/{type}` per type, six at a time - its entity count (`entityCount`) and its
    attributes with their kinds (`attributeDetails[].attributeTypes`: Property, Relationship,
    GeoProperty, ...); a broker that does not answer it is asked for
    `GET /entities?type=T&limit=0&count=true&local=true` (the count only);
  - `GET /ngsi-ld/v1/attributes?details=true` - the types each attribute is used in (`typeNames`).

  The panel on the left lists the types, sorted, with their counts; **▸** opens a type's attributes,
  each with its kinds and the other types that have it. **Relationships** lists Relationship name, from
  type and to type, with how many: NGSI-LD's discovery gives an attribute's kind but not the type of
  the entity a Relationship points to, so these come from the loaded entities, and the panel says so
  until some are loaded. A broker with no `/types` at all is loaded whole, as in milestone 1.
- **Choosing what to see.** Each type has a tick: **Load** loads the types ticked - one query,
  `GET /entities?type=A,B&local=true&limit=100&count=true` (without `local=true` if the broker refuses
  it), one per type when the list is longer than 2000 characters - every `rel="next"` page, up to
  **2000 entities** in all; past that, a notice says how many there are. The choice is kept in
  `c3.json` under the broker. On a first connect a broker of **300 entities or fewer** is loaded whole;
  a larger one shows its types and waits for the pick. Clicking a type shows or hides its entities.
- **The graph.** An entity is a box (type, the end of its id, its first two Properties); a
  Relationship (or ListRelationship) to another loaded entity is an arrow, labelled with its name
  from 55 % zoom up, and always when one of its ends is selected. A type's colour comes from its place
  in the broker's sorted list of types: the same broker, the same colours, whatever is picked.
- **The layout** ([www/js/layout.js](www/js/layout.js)) is deterministic: the same entities and
  Relationships give the same picture, whatever order the broker sent them in, so the same picks give
  the same picture. Layers along the Relationships (every arrow points up: a Robot below its Dock, the
  Dock below its Floor), the order in a layer from the neighbours' positions (barycentres), ties by
  type and id; a wide layer wraps, grouped by type; entities with no Relationship either way go in a
  grid below.
- **Moving around.** The wheel zooms at the cursor; the buttons and `+` `−` zoom at the centre, **Fit**
  and `0` show everything; drag the background or the arrow keys to move the view; drag a box to move
  it. The view stays fitted - also when the window changes size - until it is moved by hand.
- **An entity.** A click (or Tab to its box) shows its attributes, with their kinds, values,
  `unitCode`, `observedAt`, `datasetId` and sub-attributes, and its JSON. A Relationship's target is a
  link: it selects the target and centres the view on it (switching its type on if it was off); a
  target that is not loaded opens its neighbourhood.
- **An entity's menu** - right-click its box, or the context-menu key / **Shift+F10** on a focused box.
  Arrows, Home/End and a letter move in it, Enter or Space chooses, Right/Left open and close a
  submenu, Esc closes it and gives the focus back to the box.
  - **With linked entities** › Level 1, 2, 3 - `GET /entities/{id}?join=inline&joinLevel=N`: the box
    grows into one box holding the entities its Relationships point to - each with its type, the end
    of its id and up to three Properties - and inside them theirs, level by level (`entity` of a
    Relationship, `entityList` of a ListRelationship). A Relationship not embedded says why: deeper
    than the level asked for, or not embedded by the broker. × or Esc closes it.
  - **Neighbourhood** - only this entity and the entities one Relationship away, out or in: its targets
    (the loaded ones, the others by `GET /entities?id=a,b,...&local=true`) and the entities pointing at
    it (the loaded ones, and the broker's: `q=<r1>=="<id>"|<r2>=="<id>"|...&local=true` over every
    Relationship name of the discovery, the first 300). Laid out on its own; **Back to the picked
    types** returns to them.
  - **Follow** › one item per Relationship target: selects and centres it, or opens its neighbourhood
    when it is not loaded.
  - **Hide type <T>**, **Copy id**, **Show JSON** (the entity as the broker returned it, in a panel
    with **Copy**; Esc closes it).
- **States.** A splash screen while the backend gets ready - each step a real request (the backend,
  the configuration, the last broker's `/version`, at most 3 s); discovering, with progress over the
  types; loading, with progress over the pages; connected; an error card when the broker cannot be
  reached or answers with an error, with **Retry**.

### The map

- **Graph / Map** switches the view, kept per broker. On the map: every loaded entity with a GeoProperty
  (`location` first, then any other - `route`, `observationSpace`, ...), each geometry drawn: a **Point**
  as a marker, a **LineString** as a line, a **Polygon** as an area (and the Multi- forms), in the type's
  colour - the same colours as the graph. An area's or a line's name is written at its centre.
- **Relationships** between two entities on the map are lines from one to the other, with an arrowhead
  at the target (from zoom 15). A selected entity's are drawn in magenta with their names, as in the
  graph. An entity's Relationships start at its first Point, else the middle of its first line or the
  centre of its first area.
- **Click** selects (the attribute panel); **right-click** opens the entity's menu, with **Show in the
  graph** - and the graph's menu has **Show on the map**. On the map's canvas the menu key / Shift+F10
  opens the selected entity's menu, Esc unselects, `0` fits. **With linked entities** opens in the graph.
  Hiding a type hides it on the map too.
- **Fit** zooms to the entities shown; `on the map: N · not on the map: M` counts them (the title names
  the types of those without a location).
- **Colour by**: `type`, or any Relationship of the loaded entities (`inDistrict →`): each target gets its
  colour, and the entities pointing at it and the target itself are drawn in it, with a legend. Kept per
  broker.
- The first time a broker's entities are drawn, the map takes the view kept for it, else fits them.

**The base map.** MapLibre GL JS, styled dark in c³'s colours (land `#111419`, sea `#0B1620`, roads in
the panel greys - the entities' colours are what stands out), with no POI icons or road shields, so no
sprite is needed. Two sources of OpenStreetMap data, one look:

- **online** - OpenFreeMap's vector tiles (`tiles.openfreemap.org/planet`, OpenMapTiles schema, no key),
  drawn with c³'s own style layers;
- **downloaded areas** - Protomaps basemap tiles from the `.pmtiles` files, drawn with the layers of
  `@protomaps/basemaps` in the same colours; the online tiles that lie wholly inside an area are not
  asked for, a mask in the sea colour covers the area's box, and the online labels are kept out of it.
- Labels: the Noto Sans glyphs - from the data directory once an area is downloaded, else from
  `protomaps.github.io/basemaps-assets` online.
- "© OpenStreetMap contributors", OpenFreeMap / OpenMapTiles and Protomaps are credited in the corner.
  When the online tiles cannot be reached, a notice says so: `online map not reachable - downloaded areas
  only`.

**Download this area** (on the map's bar):

1. **The size first.** The area in view, the level of detail chosen (10, 12, 13, 14 or 15 - each level
   adds about four times the tiles), and its size: the backend reads the planet's directories for the
   tiles of that box and adds up their lengths - exact, before anything is downloaded. "Plus the fonts,
   about 14 MB, once" the first time.
2. **The extract.** `POST /api/maps/download`: the backend extracts the tiles from the newest Protomaps
   planet build (`build.protomaps.com/YYYYMMDD.pmtiles`, ~139 GB, read by HTTP Range requests - grouped
   into ranges of up to 4 MiB, 6 at a time) into one PMTiles v3 file, `<data>/c3/maps/<id>.pmtiles`
   (`$XDG_DATA_HOME`, else `~/.local/share`); written as `<id>.pmtiles.part` and renamed when complete;
   cancelled or failed, the part file is deleted. Then, the first time, the glyphs: 3 font stacks × 256
   ranges into `<data>/c3/maps/fonts/`. Progress and **Cancel** in the panel; one download at a time.
   An area of more than 1 000 000 tiles is refused (a smaller area or a lower level).
3. **Drawn from the file.** The page reads it with the pmtiles library through
   `GET /api/maps/areas/<id>.pmtiles`, which the backend serves with HTTP Range (`206`, `Content-Range`,
   `ETag`; `416` past the end). Inside the area the file is used down to its level, then magnified.
4. **The list**: name, size, level, date and planet build of each area, **Show** (zooms to it) and
   **Delete** (press twice). The areas' boxes are outlined on the map, dashed.

Offline means: the tiles and labels of the downloaded areas. Outside them, offline, the map is empty
(the low-zoom tiles of an area cover more than its box, so its surroundings show coarsely). Making an
area needs the network once: the planet is read online.

**Why the backend extracts, in C.** OpenFreeMap's terms forbid collecting its data "in automated ways
without permission", so its tiles cannot be bulk-downloaded; Protomaps publishes its planet builds for
exactly this, with `pmtiles extract` (the Go CLI, BSD) as the reference. c³ does what that command does,
in `src/maps.c`, rather than running the CLI:

- one thing to install fewer - the CLI is a separate binary in no distribution's packages, and c³ is
  meant to be a package itself;
- the size **before** the download (the CLI prints it only with `--dry-run`, as text), progress and
  **Cancel** through the API, the part file cleaned up;
- the same result: for the same box and level (central Boston, level 15) both read the same 377 tiles,
  byte for byte, and `pmtiles verify` accepts c³'s file.

The cost: the tiles of the online map (OpenMapTiles schema) and of the downloaded areas (Protomaps
schema) need two sets of style layers, kept in the same colours.

### Live values

When an attribute of a loaded entity changes in the broker, its box and its marker change within about
a second - flashed for a moment, the rows that changed in amber; an entity of the loaded types created
in the broker appears (in green), one deleted disappears; a changed Relationship moves its arrow. The
attribute panel of the selected entity follows. Nothing is reloaded.

- **One subscription per page**, for the types loaded, watching every attribute and every kind of
  change: `notificationTrigger` `entityCreated`, `entityDeleted`, `attributeCreated`,
  `attributeUpdated`, `attributeDeleted`; `format` `normalized`; named `c3-live:<port>`. Created after
  a load, replaced when the picks change (the new one first, then the old one deleted - no change is
  missed in between), deleted when the page closes (the window, or the page left - it is closed on
  `pagehide`, so a page kept in the browser's back/forward cache keeps none) and when the backend
  stops.
- **How the notifications arrive** - the backend holds the broker side; the page has one WebSocket to
  the backend, `GET /api/live`:
  - **(a) the broker's WebSocket transport** ([coraine's doc/websocket.md](https://github.com/SEAMWARE/coraine/blob/main/doc/websocket.md),
    `coraine --transports ws`): the backend opens `GET /ngsi-ld/v1/ws` on the broker, creates the
    subscription over it (`POST /ngsi-ld/v1/subscriptions` in a message's `metadata`, the endpoint the
    connection's name, `urn:ngsi-ld:WebSocket:<n>`) and the notifications come back on the same
    socket. The broker needs to reach nothing, and it deletes the subscription itself when the socket
    closes - also when c³ is killed. **Tried first.**
  - **(b) an HTTP subscription** whose endpoint is the backend,
    `http://127.0.0.1:<port>/api/notify/<session>` (a random 128-bit session id): any NGSI-LD
    broker, as long as it can reach the backend - a broker on the same machine. Used when the broker
    does not upgrade `GET /ngsi-ld/v1/ws` (a broker without the transport answers 404).

  **Live · WebSocket** / **Live · HTTP** next to the counts says which; its tooltip gives the
  subscription and, for HTTP, why not the WebSocket. **Not live** with the broker's answer when the
  subscription is refused.
- **No orphans.** A subscription made over the WebSocket dies with the socket. An HTTP one of a backend
  that was killed (`kill -9`, a crash) is deleted by the next start on that port: the brokers of the
  configuration (the 10 most recent) and, before its first subscription, any broker connected to, are
  asked for their subscriptions, and those named `c3-live` that notify this port's `/api/notify/` for a
  session that is not running are deleted.
- **In batches.** The changes are gathered and applied every 250 ms - one entity notified several times
  in that time is applied once - not one redraw per notification. A changed value rewrites the box's
  rows and moves the marker; an entity created or deleted lays the graph out again (keeping the view,
  the selection and the boxes moved by hand); a changed Relationship redraws the arrows only.
- **When the broker goes away** (stopped, restarted): **Live · reconnecting**, and the page watches
  again every few seconds until it is back; when the backend goes away, the page reconnects to it.
- In a neighbourhood, the values of its boxes change; created and deleted entities show on **Back**.
- A broker with no discovery (milestone 1's "every entity") is watched for the types of the entities
  loaded.

The page gets the changes over a WebSocket to the backend - the page sends on it too (what it
watches) - and corHttp's `corHttpUpgrade` hands the backend the socket - the same contract coraine's
WebSocket transport is built on. If WebSocket between the backend and the brokers turns out too slow,
[cor:// in the backend](doc/design.md) is the plan; not before measuring.

**[examples/live.sh](examples/live.sh)** `[broker-url] [seconds-per-step] [steps]` - the factory at work:
the robots of the three running Missions drive their Mission's route (`route`, a LineString) to the end
and back - `location`, `speed` and `batteryLevel` change, the Mission's `progress` follows; the robots at
a charger charge; every 16 steps a Mission (`urn:ngsi-ld:Mission:m-live`) is created, 16 steps later
deleted (`CHURN=0` leaves that out). Ctrl-C deletes it if it is there.

Not yet: a rectangle drawn on the map as a `georel=within` query, saved views, tenants, Configure,
Docs, Operate.

## Compile

A front-end to `coraine-build` ([doc/compile.md](doc/compile.md)): c³ builds nothing itself - every build
is the command shown, run by the backend, the same build as on the command line.

- **What this machine can do** - `GET /api/capabilities`: `coraine-build` (`--coraine-build`, else
  `$PATH`) and the source tarball (`--source`, else the one `coraine-dev` installs) must both be there.
  Without them the page is greyed with *Install coraine-dev to build brokers*; the builds kept are still
  listed and can be deleted. Also: whether `--pgo`/`--tune` can train here (`curl`, `wrk`, `python3`),
  whether the mongo-c driver v2 is installed (MONGOC), the host's architecture and distribution. Asked
  again every time the page is shown.
- **Features** - from `coraine-build --list-features --json` (cached per `coraine-build` and tarball):
  each switch with its default and description; one changed from its default is marked; one whose
  `requires` are off is greyed with what it needs (CMakeLists.txt turns it off). MONGOC is the **Stores**
  choice (corDB only / corDB + mongoc); without the mongo-c driver the page starts at corDB only.
- **Optimisation** - Release, Profile-guided (`--pgo`), Tuned for a workload (`--tune <file>`, the
  workload by its absolute path on this machine), Debug. The training modes are greyed when the tools
  are missing.
- **Target, HTTP server** - shown greyed: `coraine-build` builds a binary for the host, with its default
  HTTP server.
- **The command** - `POST /api/builds/command` answers the exact `argv` for the choice; the page shows it,
  one option a line. Only the switches that differ from their defaults are passed. **Build** starts that
  command under the name it showed (the name field, else `<mode>-<date>-<time>`).
- **Following a build** - its output line by line, a bar over the phases `coraine-build` announces
  (`coraine-build: phase build`, `install`, `bridges`, `check`, `done`; `tools` and `train` for the
  training modes; *unpack* before the first): how far into a phase is its line count against the same
  phase of the last build of that mode that succeeded, with that build's phase times as the weights.
  **Cancel**: SIGTERM to the build's process group, SIGKILL 5 s later.
- **The result** - the size of `install/` and of the broker, the mode and time, the features as the
  built broker reports them (`install/bin/coraine --version`, the switches off struck through), its
  `--version`, the directory, the whole log. **Run it** opens Run with that build in the form.
- **Builds kept** - newest first, with their mode, date, size and the features turned off; a click
  opens one (its log and result); **Delete** (press twice) removes its directory, log and record.
- **Presets** - the choice (mode, the features changed, the workload) saved under a name in `c3.json`,
  loaded again, deleted. The current choice is kept there too, as it changes.

**Where the builds live**: `$XDG_DATA_HOME/c3/builds/` (else `~/.local/share/c3/builds/`):

```
<name>/          coraine-build's <dir>: the source, the build tree, install/ (the result)
<name>.json      the build's record - c3-build.json
<name>.log       everything coraine-build wrote, stdout and stderr, after two lines of c³'s own
```

The record and the log are beside the directory, not in it: `coraine-build` takes a new or empty
directory (or one it unpacked into), so nothing of c³'s can be there first. The record:

```json
{
  "name": "page-edge", "state": "succeeded", "mode": "release",
  "features": {"REGISTRATIONS": false, "SUBSCRIPTIONS": false, "MONGOC": false},
  "workload": null,
  "command": "/usr/bin/coraine-build --release --features REGISTRATIONS=OFF,SUBSCRIPTIONS=OFF,MONGOC=OFF ~/.local/share/c3/builds/page-edge",
  "dir": ".../builds/page-edge", "install": ".../builds/page-edge/install", "log": ".../builds/page-edge.log",
  "phase": "done", "phases": [{"name": "build", "at": "2026-10-10T00:08:14Z", "line": 4}, ...],
  "lines": 741, "started": "2026-10-10T00:08:14Z", "ended": "2026-10-10T00:08:38Z", "seconds": 24,
  "exitStatus": 0, "signal": null, "installBytes": 11415094, "binaryBytes": 4569928,
  "version": "coraine 0.4.0\nfeatures: SUBSCRIPTIONS=0 REGISTRATIONS=0 ...\nhttpServer: mhd\n",
  "builtFeatures": {"SUBSCRIPTIONS": false, "REGISTRATIONS": false, "GEOQ": true, ...},
  "error": null
}
```

`state`: `running`, `succeeded`, `failed` (with `error`), `cancelled`, or `interrupted` - a record c³
finds `running` when it starts (it stopped during the build).

**Process control.** One build at a time (`409` for a second). `coraine-build` runs as a child in a
process group of its own, stdin `/dev/null`, stdout and stderr into a pipe, none of c³'s file descriptors
(its listening socket least of all), SIGTERM if c³ dies; a thread of the build reads the pipe, writes the
log, counts the lines and notes the phases. When the script has exited, whatever is left of its process
group is stopped too (SIGTERM, then SIGKILL after 3 s), and when c³ stops, a build that runs is cancelled
and waited for: no make, gcc or training broker outlives a build. `coraine-build` writes only under its
`<dir>`: it passes `PLUGIN_DIR=<dir>/install/plugins` to every make, and never runs the broker's own
`install` (whose `ETC_DIR` is `/opt/seamware/etc`).

**The live log** - `GET /api/builds/<name>/log` with `Accept: text/event-stream` (the page's
`EventSource`): server-sent events over a chunked response (corHttp's `corHttpResponseStream`). Each read
of the pipe is one event of its complete lines, `data:` a line, its `id` the log's byte offset after
them - a page that reconnects (`Last-Event-ID`) goes on from there; at most the last 4 MiB of the log
first (an `event: skipped` says how much is left out). `event: build` carries the record at the start
and at each phase, `event: end` the final record, and the stream ends; a comment every 15 s while the
build is quiet. Without that `Accept`, the request answers the log file (`text/plain`, Range taken).

Server-sent events and not the page's WebSocket (`/api/live`): the log only flows one way and resumes by
its byte offset, which `EventSource` does by itself (`Last-Event-ID`); and a write to a corHttp stream
never waits - bytes a page has not taken wait in the stream (16 MiB at most, then that page is
disconnected) - so a slow page cannot hold up the thread that reads the build's pipe.

## Run

Brokers started and stopped on this machine, and the services they use ([doc/design.md](doc/design.md), Run).

**What a broker is started from**

| From | Runs | How |
|---|---|---|
| the installed `coraine` (`$PATH`) | natively | `coraine -fg <options>` |
| a build of Compile's | natively | `/bin/sh -c '. "$0" && exec "$@"' <build>/install/env <build>/install/bin/coraine -fg <options>` - its own `PATH`, `SEAMWARE_PLUGIN_DIR` and `etc`, as `. install/env` by hand |
| an image (`quay.io/seamware/coraine:<tag>`) | in a container | `docker run -d --name c3-broker-<name> ... <image> <options>` - the image's entry point is `coraine -fg` |

An image of Compile's is greyed (Compile makes no image yet), and so is a build in a container. The tag is
chosen from the images here and the tags published on quay.io (`GET /api/run/images`, which reads quay.io's
API: the multi-architecture tags, not the `-amd64`/`-arm64` ones), or typed; a tag that is not here is
pulled at the start, its progress in the broker's log. Images are named by their tags - none is
`latest`.

**The form** - one of three sets, then each option as wanted:

| Set | Store | History | Bridges | Services (containers) |
|---|---|---|---|---|
| corDB alone | corDB, on disk | corDB | - | - |
| mongoc + timescale | mongoc | timescale | - | MongoDB (`mongo:8.2`), PostgreSQL + TimescaleDB (`timescale/timescaledb-ha:pg16`) |
| with MQTT | corDB, on disk | corDB | mqtt | Mosquitto (`eclipse-mosquitto:2`, `/mosquitto-no-auth.conf`) |

- **Store** corDB or mongoc; corDB's **keep it on disk** is `--dbDir`: natively `<run>/<name>/data`, in a
  container the volume `c3-broker-<name>` at `/data`.
- **History** `--troe` none, corDB or timescale.
- **Port** and **health port** (`--healthPort`; empty: none), **grace** - the seconds from SIGTERM to SIGKILL.
- **Plugins** - the WebSocket transport (`--transports ws`), the admin API (`--apiPlugins admin`), `-v`.
- **Bridges** - those the broker has (the `bridge/*.so` of its plugin directory), and a bridge
  configuration file; with mqtt and no file, c³ writes `<run>/<name>/bridges.json` naming the set's Mosquitto.
- **More options** - anything else, as typed (quotes keep words together).
- What the broker is built without is greyed with the reason - mongoc without `MONGOC`, the health port
  without `HEALTH`, the transport without `TRANSPORTS`, the admin API without `ADMIN_API` - from its
  `--version` (the installed one's, or the build's record); an image's are not known before it runs.
  Tenants have no switch at start: the form says whether the broker has them compiled in.
- The command, exactly as it will run, from the backend (`POST /api/run/command`), and the services it
  starts first with their ports.

**Services.** A set's services are containers of its own, `c3-<set>-<service>`, shared by the brokers of the
set, each with a volume of the same name and on the network `c3`; published on `127.0.0.1` only, on the
service's port + 10000 (MongoDB 37017, PostgreSQL 15432, Mosquitto 11883 - the next free one when that is
taken), so they do not collide with a MongoDB or PostgreSQL of one's own. Each broker has its own
database in them: mongoc `--dbName c3_<name>`, timescale `--troeName c3_<name>_h` (`.` and `-` as `_`).
A native broker reaches them on `127.0.0.1:<port>`, a container broker by name on the network
(`c3-mongoc-timescale-mongo:27017`).

- Started before the broker that needs them and waited for: MongoDB until `mongosh` answers its ping,
  PostgreSQL until `pg_isready`, Mosquitto until it takes a connection (3 minutes at most). MongoDB is a
  single node, not a replica set: coraine needs one only for `--high-availability mongo`.
- `mongo:8.2`, not 8.0: mongo 8.0 does not start on Linux 6.19 and newer (SERVER-121912).
- Stopped (`docker stop`, then `docker rm`) when the broker using them stops and nothing else started from
  c³ uses them; **Stop** on a service nothing uses. The volume is kept: **Delete data** (press twice) removes
  it, and only a volume c³ made (label `c3=run`) whose container does not run.

**Starting.** The broker joins Connect's list (`http://localhost:<port>`, named as in Run) and is kept in
`c3.json`. A native broker is started in a session of its own (`setsid`), its stdout and stderr appended
to its log, in its directory, with c³'s environment less `CORAINE_*` and `SEAMWARE_PLUGIN_DIR` (each option
of the broker's can be set from the environment; the form is the whole of it). It does not need c³: when
c³ stops, the brokers keep running. A container broker listens on 1026 inside its container, the port
chosen published on `127.0.0.1` - the image's `HEALTHCHECK` asks `localhost:1026/version`, and a broker on
another port inside is reported `unhealthy`.

**Stopping.** SIGTERM to the broker's process group - corDB syncs its log and writes its snapshots - and
SIGKILL when the grace period is over; the page counts it down. A container: `docker stop -t <grace>`
(the same two signals), then `docker rm`. Then its services, as above.

**Status** - every 2 s for each broker that runs: `GET /ready` on its health port, whose answer is the
health report (uptime, the store and the history plugin loaded and reachable, memory, requests), else
`GET /version` on its port. Shown as ready, not ready, answers (no health port) or no answer. A broker
that ends by itself is shown with its exit status and why.

**After a restart of c³.** A native broker's `state.json` holds its pid and the start time of that process
(`/proc/<pid>/stat`): when that process still runs, c³ attaches to it - it is watched by pid and start time,
not reaped (it is not c³'s child any more), and its exit status is not known. Containers are found by
their label `c3=run`. A container's log follower (`docker logs -f`) is started again from the time the log
file last changed.

**The log** - `GET /api/run/brokers/<name>/log` (and `/api/run/services/<container>/log`) as server-sent
events, as a build's: the file from `Last-Event-ID`, then each new line; `event: reset` when a new run
starts its log (the run before is `broker.log.1`). Without `Accept: text/event-stream`, the file (Range
taken). A native broker writes its log itself; a container's is filled by `docker logs -f`; c³'s own lines
start with `c3: `.

**Containers** go through `docker`, else `podman` (the same commands), found in `$PATH` and asked for its
version. Without either, or with a daemon that does not answer, the container parts are greyed with what
to install. c³ creates only `c3-*` containers, volumes and the network `c3`, all labelled `c3=run`, and
touches nothing else.

**Where it lives**: `$XDG_DATA_HOME/c3/run/` (else `~/.local/share/c3/run/`):

```
<name>/broker.log     its output and c3's lines about it; broker.log.1 the run before
<name>/state.json     a native broker that runs: {pid, procStart, started} - and broker.pid, the pid alone
<name>/data/          --dbDir of a native corDB
<name>/bridges.json   the MQTT bridge's configuration c3 writes
services/<container>.log
```

**Forget** (press, then keep or delete the data) removes a broker that does not run from `c3.json`; with its
data, also its directory and its volume.

## How it is built

**Backend - C, on coraine's own libraries.** One binary, `c3`, from eleven files in [src/](src/) - `maps.c`
is the map's downloaded areas (the planet read by Range, the extract, the fonts, the job and its API),
`live.c` the live values (the page's sessions, their subscriptions, the notifications) and `ws.c`
WebSocket (RFC 6455) both ways - the client end to a broker, the server end for the page - and
`compile.c` Compile (the capabilities, the feature list, the builds and their processes, the live log),
`run.c` Run (brokers and services, their processes and containers, status, logs) and `util.c` what those two
share (a growing string, files, processes spawned and stopped, a log followed as server-sent events):

| Library | Used for |
|---|---|
| corHttp | the HTTP server: one event loop, one request callback - the pages and the API; `corHttpUpgrade` hands over the page's WebSocket; files sent from the file, a build's log as a stream |
| corRest | the HTTP client the proxy and the map downloads send with - its multi engine, for the cap on the response size and a response that stays valid until the engine is destroyed |
| corJson, corTree | reading and writing the configuration file, and the API's JSON bodies |
| corArgs | the command line |
| corAlloc, corBase, corLog | under the others |
| zlib | the PMTiles directories (gzip) |
| OpenSSL (libcrypto) | also `Sec-WebSocket-Accept` (SHA-1, base64) |

The backend's API, used by the pages:

| Request | |
|---|---|
| `GET /api/status` | version, port, configuration file, its error if any |
| `GET /api/config` | the configuration |
| `POST /api/brokers` `{"url", "name"}` | a broker connected to: first in the list, `lastUsed` now |
| `DELETE /api/brokers` `{"url"}` | forget a broker |
| `PUT /api/brokers/types` `{"url", "types"}` | the types Connect loads from a broker, as its `connect.types` (the broker must be in the list) |
| `PUT /api/brokers/connect` `{"url", "view", "map", "colourBy"}` | Connect's view of a broker: each member given replaces the stored one |
| `PUT /api/ui` `{"lastPage"}` | `compile`, `run` or `connect` |
| `GET /api/capabilities` | what this machine can do: `host`, `arch`, `distribution`, `compile` (`available`, `why`, `coraineBuild`, `source`, `version`, `builds`, `pgo`, `pgoWhy`, `mongoc`, `mongocWhy`, `liveLog`), `run` (`coraine`, `coraineWhy`, `containers`, `engine`, `engineVersion`, `containersWhy`, `dir`) |
| `GET /api/compile/features` | `coraine-build --list-features --json` as `{"coraineBuild", "source", "version", "features": [{"name", "default", "description", "requires"}]}` |
| `PUT /api/compile/choice` `{"mode", "features", "workload"}` | Compile's choice, kept as `compile.choice` |
| `PUT /api/compile/presets` `{"name", "mode", "features", "workload"}` | a preset, added or replaced (in its place) in `compile.presets` |
| `DELETE /api/compile/presets` `{"name"}` | |
| `POST /api/builds/command` `{"name"?, "mode", "features", "workload"?}` | the build that body would start: `name`, `dir`, `argv`, `command` - nothing run |
| `POST /api/builds` (the same body) | start it: `202` with the record; `409` while a build runs or when the name is taken; `503` without `coraine-build`; `422` for a training mode without its tools or a tune without its workload |
| `GET /api/builds` | `{"dir", "builds": [records, newest first]}` |
| `GET /api/builds/<name>` | a record |
| `GET /api/builds/<name>/log` | the live log as server-sent events (`Accept: text/event-stream`), else the log file |
| `DELETE /api/builds/<name>` | the build that runs: cancelled (`202`); a finished one: deleted (`204`) |
| `GET /api/run` | `{dir, engine, brokers, services, sets}`: each broker kept with its options (`def`), `state` (`stopped`, `starting`, `running`, `stopping`, `exited`, `failed`), `why`, `pid`, `attached`, `container`, `url`, `started`, `ended`, `stop` (`asked`, `grace`, `killIn`, `killed`), `exitStatus`, `ready`, `health` (the report), `services`, `log`, `dataDir`/`volume`; each service with `container`, `set`, `service`, `image`, `state`, `port`, `volume`, `volumeExists`, `usedBy`, `neededBy` |
| `GET /api/run/sources` | the installed broker and the builds that succeeded: `version` (`--version`), their plugin directory and bridges |
| `GET /api/run/images` | `{repository, local: [{tag, created, size}], published: [{tag, modified}], publishedError}` |
| `POST /api/run/command` `{broker}` | `{def, argv, command, services, problem}` - nothing run |
| `POST /api/run/brokers` `{broker}` | kept (replacing one of that name) and started: `202`; `409` while it runs or when a port is taken; `422` when it cannot start from its source (`problem`) |
| `POST /api/run/brokers/<name>/start` | start one kept |
| `POST /api/run/brokers/<name>/stop` | `202`; SIGTERM, SIGKILL after its grace |
| `DELETE /api/run/brokers/<name>` | forget one that does not run (`204`); `?data=true` its directory and volume too |
| `GET /api/run/brokers/<name>/log`, `GET /api/run/services/<container>/log` | the log as server-sent events (`Accept: text/event-stream`), else the file |
| `POST /api/run/services/<container>/stop` | a service no broker uses: `202`; `409` while one does |
| `DELETE /api/run/volumes/<volume>` | one of c³'s volumes (`c3=run`), its container not running: `204` |
| `GET /api/maps` | the data directory, the downloaded areas, whether the fonts are there, the download (`job`) |
| `POST /api/maps/estimate` `{"bbox", "maxzoom"}` | tiles and bytes of an area, from the planet's directories (`422` past 1 000 000 tiles) |
| `POST /api/maps/download` `{"name", "bbox", "maxzoom"}` | start the download (`202`; `409` while one runs); `GET` its progress, `DELETE` cancels it |
| `DELETE /api/maps/areas` `{"id"}` | delete an area: its file and its entry |
| `GET /api/maps/areas/<id>.pmtiles` | the file, with Range |
| `GET /api/maps/fonts/<fontstack>/<range>.pbf` | a glyph range of a downloaded font stack |
| `GET /api/live` | the page's WebSocket (live values). The page sends `{"op": "watch", "broker", "types"}` or `{"op": "unwatch"}`; the backend sends `hello` (the session), `status` (`mode` `ws`, `http` or `off`, `subscription`, `types`, `why` not the WebSocket, `detail` of a failure), `notify` (`{"broker", "message"}` - the broker's WebSocket message as it came, or `{"body": ...}` for an HTTP notification: `message.body` is the Notification) and `lost` (the broker closed its WebSocket). The `Origin`, when sent, must be this machine. |
| `POST /api/notify/<session>` | a broker's notification for a session's HTTP subscription: to the page (`204`); an unknown session is a `404` |
| `GET /api/proxy/<path>?<query>` | the same GET to the broker named in the `X-C3-Broker` header - the NGSI-LD API (`/ngsi-ld/...`) and `/version` only. Answers the broker's status, body, `Content-Type`, `NGSILD-Results-Count` and every `Link` header joined into one; a broker not reached is a 502 with `"broker": false`. |

The proxy is why the browser never talks to a broker: the page and the API share one origin, so there
is no CORS to configure on the broker. A proxied request leaves the event loop (`corHttpSuspend`) and
is sent on a thread of its own, its answer handed back with `corHttpResume`; a slow or absent broker
holds up nothing else. The timeout is 15 s, the largest answer 64 MiB.

**Frontend - plain JavaScript modules, HTML and CSS** in [www/](www/): no build step, no framework,
nothing from a CDN, so it works offline. The graph is the world element moved with a CSS transform,
the boxes are elements in it and the arrows one SVG beneath them, as in the Connect design. The map's
libraries are copied, as published, into `www/vendor/` (below) and loaded when the map is first shown.

| File | |
|---|---|
| `index.html`, `css/c3.css` | the shell and the look (dark only - Seamware magenta `#A72E60` on `#0E1014`) |
| `css/compile.css`, `js/compile.js` | the Compile page |
| `css/run.css`, `js/run.js` | the Run page |
| `js/main.js` | the splash screen, then the pages (`#compile`, `#run`, `#connect`; the last one shown is `ui.lastPage`) |
| `js/api.js` | the backend's API |
| `js/ngsild.js` | discovery, the paged load (all, or the types picked), linked entities, Relationships, values as text |
| `js/layout.js` | the layout |
| `js/graph.js` | boxes, arrows, zoom, pan, drag, selection, filters, a box expanded in place |
| `js/menu.js` | the context menu, mouse and keyboard |
| `js/connect.js` | the Connect page: discovery panel, picks, an entity's menu, neighbourhood, linked entities, graph or map, colour by |
| `js/map.js` | the map: GeoProperties as markers, lines and areas, Relationships with arrowheads, selection, click and menu, the changed entities ringed |
| `js/live.js` | live values: the backend's WebSocket, watch/unwatch, the notifications gathered into batches (250 ms), reconnecting |
| `js/basemap.js` | the base map: c³'s dark style for OpenFreeMap's tiles, the downloaded areas' Protomaps layers, the tile and glyph protocols |
| `js/offline.js` | "Download this area": the estimate, the download's progress, the list of areas |

Fonts: Outfit, Source Sans 3 and JetBrains Mono are in `www/fonts/` (SIL Open Font License, the
licences beside them); the coraine mark and the Seamware logo in `www/img/`.

## Layout

```
src/               the backend (C)
www/               the pages, served by the backend
www/vendor/        MapLibre GL JS, pmtiles, @protomaps/basemaps - as published, with their licences
examples/          factory.sh - sample entities for Connect; live.sh - its robots at work (live values);
                   ckan-bikes.sh - real open data from a CKAN portal
doc/design.md      what c³ is and how it is built
doc/areas.md       the parts of the work and the milestones
design/            screen designs (Splash, Compile, Configure, Connect)
```

## Licence

Apache License 2.0 - see [LICENSE](LICENSE).

### Third-party

Bundled in `www/`, each with its licence beside it:

| | Version | Licence | Files |
|---|---|---|---|
| Outfit, Source Sans 3, JetBrains Mono | | SIL Open Font License 1.1 | `www/fonts/` |
| [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) | 6.13.0 | BSD 3-Clause | `www/vendor/maplibre-gl/` (`maplibre-gl.mjs`, `maplibre-gl-worker.mjs`, `maplibre-gl.css`, `LICENSE.txt`) |
| [pmtiles](https://github.com/protomaps/PMTiles) (JS) | 4.5.0 | BSD 3-Clause; it bundles [fflate](https://github.com/101arrowz/fflate) (MIT) | `www/vendor/pmtiles/` (`pmtiles.js`, `LICENSE.txt`, `LICENSE-fflate.txt`) |
| [@protomaps/basemaps](https://github.com/protomaps/basemaps) | 5.7.2 | BSD 3-Clause (code); the visual design CC0 | `www/vendor/protomaps-basemaps/` (`basemaps.mjs`, `LICENSE.txt`) |

Used at run time, not bundled:

- **Map data**: © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright) - credited
  on the map, as the licence requires.
- **Online tiles**: [OpenFreeMap](https://openfreemap.org) (no key; its credit "OpenFreeMap © OpenMapTiles
  Data from OpenStreetMap" on the map). Its terms forbid collecting its data in automated ways, which is
  why downloads come from Protomaps.
- **Downloaded areas**: extracts of the [Protomaps](https://docs.protomaps.com/basemaps/downloads) daily
  planet build - an ODbL Produced Work, OpenStreetMap attribution required (and given).
- **Glyphs**: Noto Sans (SIL Open Font License 1.1), from
  [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets), downloaded with the first area.
