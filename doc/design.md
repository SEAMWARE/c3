# c³ - design


One application for everything around a broker, in three parts:

- **Compile** - build a broker for a deployment: which features are compiled in, the profile
  training (PGO) and `make tune` on a workload, the target hardware; the result as a binary, a
  container image or a Debian package. It drives `coraine-build` from the `coraine-dev` package, so
  it needs no toolchain of its own.
- **Configure** - the mapping tools: DDS topics, services and actions to NGSI-LD entities and
  attributes (the mapping file the DDS bridge reads), and the same for OPC UA variables, monitored
  items and methods.
- **Connect** - a live connection to a running broker: its entities as boxes and their
  Relationships as arrows between them - zoom, move the view, drag entities into place - the
  entities with a GeoProperty on a map, and their values as they change.

**A web application**, not a native one: the build often runs on a server without a screen, reached
from a laptop, a Mac or a tablet; the best graph libraries are web libraries; and the broker already
speaks HTTP and WebSocket. A small backend in C on the build machine serves the pages and runs what
Compile and Configure need (`coraine-build`, the mapping files). Connect can also come with the
broker itself, as an API plugin serving the page: connecting to a broker is then opening its URL.

**Starting it** - one command, `c3`: it starts the backend on a local port and opens the
application. With Chrome or Chromium installed it opens as an application window of its own
(`--app=<url>`, no tabs or address bar), full-screen (`--start-fullscreen`); otherwise a tab in the
default browser (`xdg-open`, `open` on macOS). A page cannot make itself full-screen without a click
(the browser's rule), so full-screen is the launcher's job. On a machine without a screen, `c3`
prints the URL to open from a laptop (through `ssh -L` when the port is not reachable). The first
thing shown is a **splash screen** while the backend gets ready - each step as it really completes
(the `coraine-dev` version, `coraine-build --list-features`, the brokers and bridges found), not a
timer - then Compile.

**Connect over the WebSocket transport** ([WebSocket](https://github.com/SEAMWARE/coraine/blob/main/doc/websocket.md)): the initial state by queries,
then a subscription on the same socket and the notifications it pushes - no polling. A browser cannot
set HTTP headers on a WebSocket, which the transport already allows for: every message carries its
headers (`NGSILD-Tenant`, `Link`) in its own `metadata`. Two things to settle with the broker's
authorisation, not after it: how a browser presents a token on the socket (in a message's metadata,
or a cookie), and an `Origin` check for a page not served by the broker itself (as `--corsOrigin`
does for HTTP).


### Connect - discovery, choosing what to see, linked entities

**Discovery** - what a broker holds, before loading any entity: its entity types (`GET /types`,
with `details=true` for each type's attributes) and its attributes (`GET /attributes`, with their
kinds - Property, Relationship, GeoProperty, ... - and the types that use them). Shown as a panel:
types with their counts, each one's attributes, the Relationships between types - a map of the data
model before the data.

**Choosing what to see** - the entity view loads the types the user picks from that list (`type=`),
not the whole broker: a broker with a million sensors and twenty buildings shows the buildings.
The choice is part of a saved view.

**Linked entities, embedded** - a right-click on an entity opens a menu; "with its linked entities"
shows the entity with the entities its Relationships point to embedded in it, as NGSI-LD's linked
entity retrieval returns them (`join=inline`, `joinLevel` 1, 2, ... - coraine implements it): one
box that holds the related entities inside, level by level, instead of arrows to boxes elsewhere.
The same menu: follow one Relationship, show only this entity's neighbourhood, hide this type,
copy the id, the entity as JSON.

### Run - starting and stopping brokers and what they need

c³ starts and stops brokers on the machine it runs on, and the services they use:

- **A broker, natively** - the binary Compile just built, or the installed `coraine` - with its
  options chosen in a form (store, history, ports, tenants, the health port), started as a process
  of c³'s backend, its output kept in a log file.
- **A broker in a container** - an image Compile built, or a published one (`docker run`), with the
  same options.
- **What it needs** - MongoDB, PostgreSQL with TimescaleDB, Mosquitto, as containers, started before
  the broker that uses them and found by it; a ready-made set per kind of deployment ("corDB alone",
  "mongoc + timescale", "with MQTT").
- **Status** - running or stopped, the health port's report, the ports; a broker started here is
  added to Connect's list, and Operate's logs and metrics follow it.
- **Stopping** - a broker stops cleanly (SIGTERM: corDB writes its snapshot), then its services if
  nothing else uses them; data stays unless the user deletes it, with a confirmation.

What was started, with which options, is kept in the configuration file, so the next start of c³
shows it and can start it again. Containers are driven through the `docker` command (or Podman's,
which takes the same commands); no orchestrator.

### Operating brokers - logs, log levels, metrics

Connect shows a broker's data; c³ also shows the brokers themselves, several at once:

- **Logs, live** - each broker's log lines as they are written, filtered by level and by text,
  side by side for several brokers.
- **Log and trace levels** - verbose, debug, info and the trace levels, changed on a running broker.
  coraine already has this as `/admin/log` (GET, PUT, PATCH, POST, DELETE); c³ is a front-end to it.
  Trace levels exist only in a debug build - release builds compile traces out - and c³ shows which
  kind of build it is talking to.
- **Metrics** - `/admin/metrics` (Prometheus format) as charts: request rates, latencies, entities,
  subscriptions and notifications, memory against the budget. The health port's report
  (`--healthPort`) gives liveness and readiness.

**What coraine needs for the logs.** corLog writes each line to a file descriptor and has no hook.
The change:

- corLog: an optional callback, called with each line (level, file, line, function, text) - one
  pointer test when none is set, so a broker nobody watches pays nothing.
- coraine: the callback keeps the last lines in a ring buffer, and passes new lines to whoever is
  subscribed, with the subscriber's level filter applied before anything is sent.
- The lines travel on the socket c³ already has to the broker (the WebSocket transport) as a log
  subscription - no second port. A broker built without the transports could offer the same
  through the admin API.
- Under conditional compilation, like every new concept: a broker built without it has no ring
  buffer and no hook.

### The configuration file

c³ remembers everything between starts in one JSON file, written by the backend as the user works -
every button that changes a choice saves it, no "save settings" step:

- `~/.config/c3/c3.json` (`$XDG_CONFIG_HOME`); `c3 --config <file>` for another one.
- Written whole to a temporary file and renamed over the old one, so a crash never leaves half a
  file; a `"version"` member, so a later c³ can read an older file and convert it.
- Kept by the backend, not in the browser (`localStorage`): the same settings whichever browser or
  laptop opens c³, and a file that can be read, copied and versioned.

What it holds:

- **brokers** - every broker connected to: URL (`ws://host:port`), name, tenant, subprotocol, last
  used; the list Connect offers at start.
- **compile** - the last choices (features, optimisation, target, output) and named presets ("edge
  node", "full"), the workload files used for tuning, the build directories.
- **configure** - the mapping files opened recently, DDS domains, OPC UA servers, CKAN portals.
- **connect** - per broker: the type filters, graph or map, and the **saved views** (below).
- **ui** - the last page, the window size.

Secrets - a broker's token, a CKAN API key - are not in it: they go in a separate file readable only
by the user (mode 600), or the desktop's keyring where there is one, so `c3.json` can be shared or
committed.

**Entity positions are not saved as they are dragged.** The graph lays itself out - the same
entities and Relationships give the same layout every time, so it needs no saving. Dragging is for
looking closer. What is worth keeping is saved on purpose: **Save view** on the graph stores a named
view - the entities shown (by type filter, query or a hand-picked selection), their positions, the
zoom - and the view list of a broker opens any of them again. Only what the user chose to keep is in
the file.

### Docs

All of coraine's documentation in one place, and much easier to read than Markdown on GitHub:

- **The broker** - everything on Read the Docs (`doc/*.md`, built with `mkdocs.yml`): installation,
  building, the features, performance, the roadmap.
- **Every cor-lib** - corBase, corAlloc, corLog, corArgs, corHash, corJson, corTree, corJsonld, corNgsild,
  corRest, corHttp, corDB, corProm, corPlugin, corTest, corTools, corBridge, and the bridges: each one's README
  and docs, plus an API reference generated from its headers - the functions, their arguments,
  their ownership rules.
- **Searchable, and offline** - the docs come with the `coraine-dev` package, matching the version
  installed, so the build machine needs no network to read them. The same pages can be published as
  a website.
- **Linked from where they are needed** - a feature switch in Compile links to what it removes, a
  bridge in Configure to its mapping format.

**Writing a plugin.** A skeleton repository per kind of plugin - a current-state store, a temporal
store, an API, a transport, a bridge: a makefile that builds against the installed `coraine-dev`,
template `.c`/`.h` files with the entry points the loader resolves (corPlugin) and the registration
filled in, a functest that loads the plugin into a broker, and a CI workflow. In c³: pick the kind,
name it, and get the repository (`c3 new plugin <kind> <name>` on the command line), with the docs
for that kind beside it. The plugin builds and loads before a line of its own is written.
