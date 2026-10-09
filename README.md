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

Status: **milestone 1** - the `c3` command, its backend, the configuration file, the splash screen and
**Connect, read-only**. [doc/design.md](doc/design.md) is the plan, [doc/areas.md](doc/areas.md) the
milestones, [design/](design/) the screen designs.

## Try it

The backend builds against the cor-libs as coraine does: sibling checkouts (`../corHttp`, `../corRest`,
`../corJson`, `../corTree`, `../corArgs`, `../corLog`, `../corAlloc`, `../corBase`), each one built
(`make` in it). It also needs OpenSSL (`libssl-dev`), for corRest's client.

```sh
make                                                   # ./c3

coraine -fg -db corDB -p 1090 &                        # a broker, in RAM, on a port of its own
examples/factory.sh http://localhost:1090              # 25 entities with Relationships and locations
examples/factory.sh http://localhost:1090 300          # ... and 300 sensors more, to page through
examples/ckan-bikes.sh http://localhost:1090           # real open data: 572 Boston bike stations from a CKAN portal

./c3                                                   # opens the application; Ctrl-C stops it
```

In Connect, enter `http://localhost:1090` and press **Connect**. The next start connects to the last
broker by itself.

`make run ARGS="--port 7901 --no-browser"` builds and runs from the checkout; `make install`
(`PREFIX=/usr/local`, `DESTDIR` for packaging) installs `bin/c3` and `share/c3/www`; `make clean`.

## The `c3` command

```
c3 [--port <port>] [--config <file>] [--no-browser] [--www <directory>]
```

| Option | Default | |
|---|---|---|
| `--port`, `-p` | 7900 | the backend's TCP port |
| `--config`, `-c` | `$XDG_CONFIG_HOME/c3/c3.json`, else `~/.config/c3/c3.json` | the configuration file |
| `--no-browser`, `-nb` | | serve only, and print the URL |
| `--www`, `-w` | `<binary's dir>/www`, else `<binary's dir>/../share/c3/www` | the pages |

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

`~/.config/c3/c3.json`, written by the backend as the user works - never by the page. Milestone 1
holds the brokers connected to and the last page:

```json
{
  "version": 1,
  "brokers": [
    { "url": "http://localhost:1090", "name": "localhost:1090", "lastUsed": "2026-10-09T17:35:43Z" }
  ],
  "ui": { "lastPage": "connect" }
}
```

- A broker is added, or moved to the front with a new `lastUsed`, when its entities have loaded; the
  50 most recent are kept.
- Written whole to `c3.json.tmp`, then renamed over `c3.json` (mode 600, the directory 700).
- Members this version does not know are kept. A file that is not a JSON object is moved to
  `c3.json.broken` and c³ starts from an empty one; a file with a `version` above 1 is read and never
  written.

## Connect - milestone 1

- **Loading.** `GET /ngsi-ld/v1/entities?local=true&limit=100&count=true`, then every `rel="next"` of
  the `Link` header, up to **2000 entities** - past that, a notice says how many there are. A broker
  that refuses `local=true` as the whole query (400) is asked for `GET /ngsi-ld/v1/types` and then
  queried with `type=<every type>`.
- **The graph.** An entity is a box (type, the end of its id, its first two Properties); a
  Relationship (or ListRelationship) to another loaded entity is an arrow, labelled with its name
  from 55 % zoom up, and always when one of its ends is selected.
- **The layout** ([www/js/layout.js](www/js/layout.js)) is deterministic: the same entities and
  Relationships give the same picture, whatever order the broker sent them in. Layers along the
  Relationships (every arrow points up: a Robot below its Dock, the Dock below its Floor), the order
  in a layer from the neighbours' positions (barycentres), ties by type and id; a wide layer wraps,
  grouped by type; entities with no Relationship either way go in a grid below.
- **Moving around.** The wheel zooms at the cursor; the buttons and `+` `−` zoom at the centre, **Fit**
  and `0` show everything; drag the background or the arrow keys to move the view; drag a box to move
  it. The view stays fitted - also when the window changes size - until it is moved by hand.
- **An entity.** A click shows its attributes, with their kinds, values, `unitCode`, `observedAt`,
  `datasetId` and sub-attributes, and its JSON. A Relationship's target is a link: it selects the
  target, centres the view on it, and switches its type on if it was off.
- **Types.** The panel on the left lists the types with their counts and colours (by the type's place
  in the sorted list); each one switches its entities, and their arrows, on and off.
- **States.** A splash screen while the backend gets ready - each step a real request (the backend,
  the configuration, the last broker's `/version`, at most 3 s); loading, with progress over the
  pages; connected; an error card when the broker cannot be reached or answers with an error, with
  **Retry**.

Not in milestone 1: the WebSocket transport and live values, the map, saved views, tenants, Compile,
Configure, Docs, Operate.

## How it is built

**Backend - C, on coraine's own libraries.** One binary, `c3`, from five files in [src/](src/):

| Library | Used for |
|---|---|
| corHttp | the HTTP server: one event loop, one request callback - the pages and the API |
| corRest | the HTTP client the proxy sends with - its multi engine, for the cap on the response size and a response that stays valid until the engine is destroyed |
| corJson, corTree | reading and writing the configuration file, and the API's JSON bodies |
| corArgs | the command line |
| corAlloc, corBase, corLog | under the others |

The backend's API, used by the pages:

| Request | |
|---|---|
| `GET /api/status` | version, port, configuration file, its error if any |
| `GET /api/config` | the configuration |
| `POST /api/brokers` `{"url", "name"}` | a broker connected to: first in the list, `lastUsed` now |
| `DELETE /api/brokers` `{"url"}` | forget a broker |
| `PUT /api/ui` `{"lastPage"}` | |
| `GET /api/proxy/<path>?<query>` | the same GET to the broker named in the `X-C3-Broker` header - the NGSI-LD API (`/ngsi-ld/...`) and `/version` only. Answers the broker's status, body, `Content-Type`, `NGSILD-Results-Count` and every `Link` header joined into one; a broker not reached is a 502 with `"broker": false`. |

The proxy is why the browser never talks to a broker: the page and the API share one origin, so there
is no CORS to configure on the broker. A proxied request leaves the event loop (`corHttpSuspend`) and
is sent on a thread of its own, its answer handed back with `corHttpResume`; a slow or absent broker
holds up nothing else. The timeout is 15 s, the largest answer 64 MiB.

**Frontend - plain JavaScript modules, HTML and CSS** in [www/](www/): no build step, no framework,
nothing from a CDN, so it works offline. The graph is the world element moved with a CSS transform,
the boxes are elements in it and the arrows one SVG beneath them, as in the Connect design.

| File | |
|---|---|
| `index.html`, `css/c3.css` | the shell and the look (dark only - Seamware magenta `#A72E60` on `#0E1014`) |
| `js/main.js` | the splash screen, then Connect |
| `js/api.js` | the backend's API |
| `js/ngsild.js` | the paged load, Relationships, values as text |
| `js/layout.js` | the layout |
| `js/graph.js` | boxes, arrows, zoom, pan, drag, selection, filters |
| `js/connect.js` | the Connect page |

Fonts: Outfit, Source Sans 3 and JetBrains Mono are in `www/fonts/` (SIL Open Font License, the
licences beside them); the coraine mark and the Seamware logo in `www/img/`.

## Layout

```
src/               the backend (C)
www/               the pages, served by the backend
examples/          factory.sh - sample entities for Connect; ckan-bikes.sh - real open data from a CKAN portal
doc/design.md      what c³ is and how it is built
doc/areas.md       the parts of the work and the milestones
design/            screen designs (Splash, Compile, Configure, Connect)
```

## Licence

Apache License 2.0 - see [LICENSE](LICENSE). The fonts in `www/fonts/`: SIL Open Font License 1.1.
