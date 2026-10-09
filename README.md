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

Status: **milestone 1c** - the `c3` command, its backend, the configuration file, the splash screen and
**Connect, read-only**: discovery, the types picked, an entity's menu (linked entities, neighbourhood),
and the entities **on a map**, online or from downloaded areas offline. [doc/design.md](doc/design.md)
is the plan, [doc/areas.md](doc/areas.md) the milestones, [design/](design/) the screen designs.

## Try it

The backend builds against the cor-libs as coraine does: sibling checkouts (`../corHttp`, `../corRest`,
`../corJson`, `../corTree`, `../corArgs`, `../corLog`, `../corAlloc`, `../corBase`), each one built
(`make` in it). It also needs OpenSSL (`libssl-dev`), for corRest's client, and zlib (`zlib1g-dev`), for
the map files. Two corRest fixes matter:

- [SEAMWARE/corRest#37](https://github.com/SEAMWARE/corRest/pull/37) - a neighbourhood's query (below) is
  a long URL, and the multi client's send buffer must count the path; without it, a request whose path
  and query pass about 450 characters is not sent and the proxy answers 502.
- [SEAMWARE/corRest#38](https://github.com/SEAMWARE/corRest/pull/38) - over TLS, the multi client must
  read what OpenSSL has already decrypted; without it, about one HTTPS request in a hundred waits for its
  timeout, and "Download this area" takes a minute longer each time (it retries, and completes).

```sh
make                                                   # ./c3

coraine -fg -db corDB -p 1090 &                        # a broker, in RAM, on a port of its own
examples/factory.sh http://localhost:1090              # 25 entities with Relationships, locations, areas and routes
examples/factory.sh http://localhost:1090 300          # ... and 300 sensors more, to page through
examples/ckan-bikes.sh http://localhost:1090           # real open data: 572 Boston bike stations + 13 districts (areas) from a CKAN portal

./c3                                                   # opens the application; Ctrl-C stops it
```

In Connect, enter `http://localhost:1090` and press **Connect**. With the factory alone (25 entities)
everything is loaded at once; with the bike stations too (610), tick the types to see - **District**,
then **BikeStation** - and press **Load**. Right-click a Robot for its linked entities (Dock, Floor,
Building) or its neighbourhood. The next start connects to the last broker by itself, with the types
picked last time.

**Map** (top left of the graph) puts the same entities on a map. With the bike stations: **colour by**
`inDistrict →` gives each district its colour - its stations and its area; click a station for its
attributes and the line to its district. **Download this area** shows the size of the area in view
down to the level chosen, then downloads it: from then on it is drawn from the file, also offline.

`make run ARGS="--port 7901 --no-browser"` builds and runs from the checkout; `make install`
(`PREFIX=/usr/local`, `DESTDIR` for packaging) installs `bin/c3` and `share/c3/www`; `make clean`.

## The `c3` command

```
c3 [--port <port>] [--config <file>] [--no-browser] [--www <directory>] [--planet <url>]
```

| Option | Default | |
|---|---|---|
| `--port`, `-p` | 7900 | the backend's TCP port |
| `--config`, `-c` | `$XDG_CONFIG_HOME/c3/c3.json`, else `~/.config/c3/c3.json` | the configuration file |
| `--no-browser`, `-nb` | | serve only, and print the URL |
| `--www`, `-w` | `<binary's dir>/www`, else `<binary's dir>/../share/c3/www` | the pages |
| `--planet`, `-pl` | the newest daily build at `build.protomaps.com` | the Protomaps planet (`.pmtiles` URL) map areas are extracted from |

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

Not yet: the WebSocket transport and live values, a rectangle drawn on the map as a `georel=within`
query, saved views, tenants, Compile, Configure, Docs, Operate.

## How it is built

**Backend - C, on coraine's own libraries.** One binary, `c3`, from six files in [src/](src/) - `maps.c`
is the map's downloaded areas (the planet read by Range, the extract, the fonts, the job and its API):

| Library | Used for |
|---|---|
| corHttp | the HTTP server: one event loop, one request callback - the pages and the API |
| corRest | the HTTP client the proxy and the map downloads send with - its multi engine, for the cap on the response size and a response that stays valid until the engine is destroyed |
| corJson, corTree | reading and writing the configuration file, and the API's JSON bodies |
| corArgs | the command line |
| corAlloc, corBase, corLog | under the others |
| zlib | the PMTiles directories (gzip) |

The backend's API, used by the pages:

| Request | |
|---|---|
| `GET /api/status` | version, port, configuration file, its error if any |
| `GET /api/config` | the configuration |
| `POST /api/brokers` `{"url", "name"}` | a broker connected to: first in the list, `lastUsed` now |
| `DELETE /api/brokers` `{"url"}` | forget a broker |
| `PUT /api/brokers/types` `{"url", "types"}` | the types Connect loads from a broker, as its `connect.types` (the broker must be in the list) |
| `PUT /api/brokers/connect` `{"url", "view", "map", "colourBy"}` | Connect's view of a broker: each member given replaces the stored one |
| `PUT /api/ui` `{"lastPage"}` | |
| `GET /api/maps` | the data directory, the downloaded areas, whether the fonts are there, the download (`job`) |
| `POST /api/maps/estimate` `{"bbox", "maxzoom"}` | tiles and bytes of an area, from the planet's directories (`422` past 1 000 000 tiles) |
| `POST /api/maps/download` `{"name", "bbox", "maxzoom"}` | start the download (`202`; `409` while one runs); `GET` its progress, `DELETE` cancels it |
| `DELETE /api/maps/areas` `{"id"}` | delete an area: its file and its entry |
| `GET /api/maps/areas/<id>.pmtiles` | the file, with Range |
| `GET /api/maps/fonts/<fontstack>/<range>.pbf` | a glyph range of a downloaded font stack |
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
| `js/main.js` | the splash screen, then Connect |
| `js/api.js` | the backend's API |
| `js/ngsild.js` | discovery, the paged load (all, or the types picked), linked entities, Relationships, values as text |
| `js/layout.js` | the layout |
| `js/graph.js` | boxes, arrows, zoom, pan, drag, selection, filters, a box expanded in place |
| `js/menu.js` | the context menu, mouse and keyboard |
| `js/connect.js` | the Connect page: discovery panel, picks, an entity's menu, neighbourhood, linked entities, graph or map, colour by |
| `js/map.js` | the map: GeoProperties as markers, lines and areas, Relationships with arrowheads, selection, click and menu |
| `js/basemap.js` | the base map: c³'s dark style for OpenFreeMap's tiles, the downloaded areas' Protomaps layers, the tile and glyph protocols |
| `js/offline.js` | "Download this area": the estimate, the download's progress, the list of areas |

Fonts: Outfit, Source Sans 3 and JetBrains Mono are in `www/fonts/` (SIL Open Font License, the
licences beside them); the coraine mark and the Seamware logo in `www/img/`.

## Layout

```
src/               the backend (C)
www/               the pages, served by the backend
www/vendor/        MapLibre GL JS, pmtiles, @protomaps/basemaps - as published, with their licences
examples/          factory.sh - sample entities for Connect; ckan-bikes.sh - real open data from a CKAN portal
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
