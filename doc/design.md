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
- **connect** - per broker: where each entity was dragged to, the zoom and position of the view, the
  type filters, graph or map - so a broker's graph opens the way it was left.
- **ui** - the last page, the window size.

Secrets - a broker's token, a CKAN API key - are not in it: they go in a separate file readable only
by the user (mode 600), or the desktop's keyring where there is one, so `c3.json` can be shared or
committed. The entity positions of a large broker can grow big; they are the first candidate to move
to a file of their own per broker if the main file gets slow to write.

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
