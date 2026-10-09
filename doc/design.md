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

### Configure - DDS mapping

**The raw data.** At start the DDS Enabler discovers the DDS network - every topic, service and
action, with its type - and reports each one to the broker through the bridge contract
(`endpointDiscoveredIn`). That inventory is what the mapping tool works from.

**Where c³ gets it: from a broker, not from DDS itself.** c³ does not link the DDS Enabler or a DDS
stack (about five times the size of the broker, C++). It asks a broker that runs the DDS bridge:

- a broker started for the purpose - Run starts one on the chosen DDS domain with the dds bridge and
  no mapping, so everything it discovers is reported and nothing is carried yet;
- or a running broker, to extend its mapping.

What the broker needs for that (coraine): today the plugin reports only the endpoint name and its
kind, and only services and actions are carried (on `urn:ngsi-ld:dds:default`). The mapping tool
needs the whole inventory: every topic, service and action, its DDS/ROS 2 type name, and the type's
fields (to preview a payload and offer attribute names). So: the bridge contract carries the type
name and description with each discovery, the broker keeps the inventory per bridge, and serves it -
`GET /admin/bridges/{bridge}/discovered`, and live on the WebSocket transport as endpoints appear.
A JSON snapshot of that inventory, saved to a file, lets the mapping be made away from the DDS
network.

**One format, shared with the other tools.** The inventory uses the discovery format already used in
ARISE - an object with `topics`, `services` and `actions`; a topic has `name` and `typeName` (and
`qos`), a service `requestType` and `replyType`, an action `goalType`, `feedbackType` and
`resultType`. So c³ reads a discovery made by a standalone script on the DDS network as well as a
broker's, and other mapping tools can read the broker's endpoint directly.

**The screen.** Three sections - **Topics**, **Services**, **Actions** - one line per endpoint: its
name, its type, and the fields to fill in: **entity id**, **entity type**, **attribute name**; or
"skip". Defaults are offered, never imposed: the `rt/` prefix stripped, the entity type from the
type's last part (`Twist`, `SetBool`), attribute names made URL-safe; logging (`/rosout`,
`rcl_interfaces/msg/Log`) skipped by default. A payload preview per line from the type's fields.

**The output.**

- the bridge configuration the broker and the Enabler read (`dds.json`: the domain, the endpoints
  carried, each one's entity id / type / attribute);
- the **user @context** the broker is started with as its default (`--defaultUserContext`): every
  short name used in the mapping (entity types, attribute names) expanded to a full IRI under a base
  the user sets.

Opening an existing mapping and a fresh discovery together keeps every decision already made and
shows only what is new. Names are checked before writing: valid URIs, no two endpoints writing the
same attribute of the same entity.

### Configure - one tool for every protocol

DDS, OPC UA, and the bridges after them share one mapping tool: the inventory, the lines, the
output are the same shape; what differs per protocol is a small adapter - how the inventory is
read, what a line's defaults are, which output file the bridge reads. The three columns (entity id,
entity type, attribute name), Smart Data Models, the user @context and the round-trip merge are
written once.

**OPC UA.** The inventory is a server's address space, browsed from the Objects folder down:

- **objects** - the natural entities (a machine, a robot, a line); their browse name is the default
  entity id and their type definition the default entity type;
- **variables** - an object's attributes: data type, unit (EngineeringUnits), whether writable
  (AccessLevel) - a writable one becomes an attribute a PATCH writes back to the server; per
  variable the sampling of its monitored item (interval, deadband);
- **methods** - an object's commands, with their input and output arguments, called by writing the
  attribute (as a DDS service is);
- **events** - the server's event types, carried as attributes when chosen.

Read by the OPC UA bridge from a running server (the way the broker reports DDS discovery), or
offline from a NodeSet2 XML file - the standard export of an information model, which also covers
the OPC UA companion specifications (Robotics, Machinery, ...): a companion specification's types
map naturally to entity types, and where a Smart Data Model exists for one, it is suggested.

**Modbus**: registers and coils have no names or types to discover; its lines are entered by hand
(address, data type, scale, poll interval), into the same table, with the same output.

### Connect - the map

A **Graph / Map** switch in Connect. On the map: the entities with a GeoProperty, where it puts them -
a point as a marker coloured by type, a LineString as a line, a Polygon as an area - and the
Relationships between them as arrows, as on the graph. The same click (the attribute panel) and
right-click menu; "Fit" zooms to what is shown; later a rectangle drawn on the map becomes a
`georel=within` query.

**The map itself** - MapLibre GL JS (open source, BSD), bundled with c³, styled dark; the map data
is OpenStreetMap's ("© OpenStreetMap contributors" shown, as its licence requires). No account, no
key, nothing paid:

- **online** - vector tiles from OpenFreeMap (hosted OpenStreetMap tiles, free, no key);
- **"Download this area"** - a button on the map: the area in view, down to a chosen level of
  detail, with its size shown before the download, saved as one Protomaps file (`.pmtiles`) in c³'s
  data directory. From then on that area is drawn from the file - offline, and faster than over the
  network - and the online tiles are used only outside it. Downloaded areas are listed, with their
  size, and can be deleted. A site without internet - a factory, a robot cell - gets its map this
  way, downloaded once from a machine that has it.

### Smart Data Models

The Smart Data Models initiative publishes the common NGSI-LD data models - each one a JSON Schema,
its attributes with their meaning, and an @context with the official IRIs. Using them is what makes
data from different deployments understandable to each other, and c³ uses them throughout:

- **Configure** - for each entity type being mapped, the models that fit are suggested (by the
  type's name and its fields); choosing one turns the attribute names into the model's, and the
  output's user @context takes the model's IRIs instead of minting new ones. A mapping can always
  go its own way; the suggestion is never forced.
- **Connect** - an entity of a known model shows which one, links to its documentation, and checks
  the entity against the model's schema: missing required attributes, wrong value types, as warnings
  beside the entity, never as errors.
- **Discovery** - for a broker's types, which Smart Data Models they follow, and how closely.
- **Docs** - the catalogue browsable next to coraine's own documentation: subjects, models, their
  attributes and examples.

The catalogue is read from the initiative's published repositories and kept locally (in c³'s data
directory), so it works offline and can be refreshed on demand.

### Changing data - after authorisation

A control center changes things: create entities, edit and delete attributes, create and modify
registrations and subscriptions, delete entities - all from the graph, the map and the entity
panel. c³ gets these only after the broker has authorisation (coraine's roadmap: authorisation
inside the broker - per entity, per type, per tenant, per attribute; ODRL, verifiable credentials -
and the NGSI-LD plugin for APISIX in front of any broker). Until then Connect reads.

With it, c³ is one more client of the broker: the user signs in, c³ presents the user's token or
credential on every request (and on the WebSocket, in each message's metadata), and the broker
decides. c³ shows what the user may do - an action the policy forbids is greyed, with the reason -
but never decides it; the broker or the gateway does. Every change c³ makes goes through the same
NGSI-LD API any other client uses, so it is checked, logged and notified like any other.

### If the connection to brokers is too slow: cor:// in the backend

A browser cannot speak cor:// (it is not HTTP or WebSocket), but c³'s backend is a C program on the
same machine as the browser, built on the libraries that speak it. So, if WebSocket between c³ and
the brokers turns out too slow, the backend becomes the proxy: cor:// to the brokers - compact,
multiplexed, the long way over the network - and WebSocket only for the short local hop to the
page. One backend keeps the connections to many brokers. Not before measuring: with thousands of
entities the time is more likely spent drawing them in the browser than moving them.

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

### Packaging - what c³ can do depends on what is installed

c³ is its own Debian package, **`coraine-c3`**, and comes with coraine: the `coraine` package
recommends it (`Recommends: coraine-c3`), and `coraine-dev` depends on `coraine`, so both bring it.
A Recommends, not a Depends: a server or a container image installed with `--no-install-recommends`
gets the broker without the GUI.

Only `coraine-dev` can build a broker (`coraine-build` and the source are in it). So c³ looks at
what is installed when it starts, and shows each part only as far as it can work:

| Needs | Part | Without it |
|---|---|---|
| `coraine-dev` (`coraine-build`) | Compile; Run of a broker just built | shown greyed, with "install coraine-dev to build brokers" |
| `coraine` | Run of the installed broker | - (always there) |
| `docker` or `podman` | Run in a container; MongoDB, PostgreSQL, Mosquitto | greyed, with what to install |
| the dds bridge plugin | Configure - DDS discovery from a broker started here | from a running broker or a snapshot file only |
| network | online map tiles, the Smart Data Models refresh | downloaded areas and the local catalogue only |

Greyed rather than hidden: the user sees what c³ can do and what to install for it. The backend
reports what it found (`GET /api/capabilities`), and checks again when asked, after an install.

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
