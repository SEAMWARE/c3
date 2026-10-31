# c³ - the coraine Control Center

One application for everything around a [coraine](https://github.com/SEAMWARE/coraine) broker: build
it, configure its bridges, watch it live, and learn it - including how to write a plugin for it.

| Part | What it does |
|---|---|
| **Compile** | Build a broker for a deployment: the features compiled in or out, profile training (PGO) and tuning on a workload, the target hardware - the result as a binary, a container image or a Debian package. Drives `coraine-build` from the `coraine-dev` package. |
| **Operate** | Start and stop brokers - natively or in a container - and the services they need: MongoDB, PostgreSQL/TimescaleDB, Mosquitto; the brokers themselves, several at once: live logs, log and trace levels changed on a running broker, metrics as charts, health. |
| **Explore** | A live connection to a running broker: entities as boxes, Relationships as arrows, zoom, pan, entities dragged into place; the entities with a GeoProperty on a map; values as they change. |
| **Documentation** | All of coraine's documentation in one place, written to be read: the guides - installation, administration, the API, building, deploying, performance, the transports, the bridges, authorization, the internals - a guide and an API reference per cor-lib, with search, a guide's sections and the next one, offline; every component's repository. The same pages are the website [seamware.github.io/docs](https://seamware.github.io/docs/) (`make site`). Planned: a skeleton repository for each kind of plugin. |

Built today: the `c3` command, its backend and its configuration file; **Compile** - a broker built by
`coraine-build` with the features, bridges, HTTP server and executable name chosen, its output followed
live, the builds kept; **Operate** - brokers started and stopped natively or in a container,
with MongoDB, PostgreSQL/TimescaleDB and Mosquitto as containers, their logs, configuration, metrics and
log levels; **Explore** - discovery, the types picked, tenants, an entity's menu (linked entities,
neighbourhood), editing, the entities **on a map** (online, or offline from downloaded areas) and **live
values** over the broker's WebSocket transport or HTTP notifications. [doc/design.md](doc/design.md) is
the plan, [doc/areas.md](doc/areas.md) the parts of the work, [design/](design/) the screen designs.

**Demos** - [seamware.github.io/c3-demos](https://seamware.github.io/c3-demos/): AI Assist on video, and the
factory floor, Boston's bike stations and Madrid to run on your machine
([SEAMWARE/c3-demos](https://github.com/SEAMWARE/c3-demos)).

## Try it

What it needs (Debian / Ubuntu): `gcc`, `make`, OpenSSL (`libssl-dev`, for corRest's client)
and zlib (`zlib1g-dev`, for the map files); a browser. To connect to a broker: a coraine
([installation](https://github.com/SEAMWARE/coraine/blob/main/doc/installation.md) - `apt install
coraine` from https://seamware.github.io/apt, or Docker). For **Compile**: the `coraine-dev` package (its
`coraine-build` and source tarball) - or, without it, the git clones c³ itself is built against: coraine
beside the cor-libs. For **Operate** in containers: Docker or Podman.

The backend builds against the cor-libs as coraine does - sibling checkouts, each built with `make` in it
(`COR_LIBS=<dir>` for checkouts elsewhere):

```sh
mkdir seamware && cd seamware
for r in corBase corLog corAlloc corArgs corTree corJson corHttp corRest c3; do
  git clone https://github.com/SEAMWARE/$r
done
for r in corBase corLog corAlloc corArgs corTree corJson corHttp corRest; do make -C $r; done
cd c3
```

Then:

```sh
make                                                   # ./c3

coraine -db corDB -p 1090 --transports ws &            # a broker, in RAM, on a port of its own, with its WebSocket transport
examples/factory.sh http://localhost:1090              # 25 entities with Relationships, locations, areas and routes
examples/live.sh http://localhost:1090 &               # ... and its robots at work: the values change every 0.5 s
examples/factory.sh http://localhost:1090 300          # ... and 300 sensors more, to page through
examples/ckan-bikes.sh http://localhost:1090           # real open data: 572 Boston bike stations + 13 districts (areas) from a CKAN portal

./c3                                                   # opens the application; Ctrl-C stops it
```

In Explore, enter `http://localhost:1090` and press **Connect**. With the factory alone (25 entities)
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
(`PREFIX=/usr/local`, `DESTDIR` for packaging) installs `bin/c3`, `share/c3/www` and the menu's and
the dock's c³: `share/applications/com.seamware.c3.desktop` (`Exec` the installed `bin/c3`) and its icon,
`share/icons/hicolor/{256x256,512x512}/apps/com.seamware.c3.png`; `make uninstall`; `make clean`.
`DESKTOP_EXEC=<path>`: the desktop entry runs that instead of `bin/c3` - a launcher of one's own around it
(environment, a log file). A c³ still running from the `bin/c3` the install replaced is stopped (SIGTERM,
`tools/stopReplaced.sh`; not with `DESTDIR`): started again, it would only open the earlier build. The next
start is the new one.

A c³ started while one runs on its port has that one open its window and ends. When the running one is
an earlier build of the same file - started from `bin/c3`, the file replaced by an install since
(`/proc/<pid>/exe` reads `<path> (deleted)`; `GET /api/status` says its `pid`) - the new one stops it
(SIGTERM, the port free within 10 s) and starts in its place, as a stop by hand would: the brokers and
services it started keep running and the new one attaches to them, a build that runs is cancelled.

## The `c3` command

```
c3 [--port <port>] [--config <file>] [--no-browser] [--www <directory>] [--planet <url>]
   [--coraine-build <path>] [--source <tarball>] [--token-file <file>]
```

| Option | Default | |
|---|---|---|
| `--port`, `-p` | 7900 | the backend's TCP port |
| `--config`, `-c` | `$XDG_CONFIG_HOME/c3/c3.json`, else `~/.config/c3/c3.json` | the configuration file |
| `--no-browser`, `-nb` | | serve only, and print the URL |
| `--www`, `-w` | `<binary's dir>/www`, else `<binary's dir>/../share/c3/www` | the pages |
| `--planet`, `-pl` | the newest daily build at `build.protomaps.com` | the Protomaps planet (`.pmtiles` URL) map areas are extracted from |
| `--coraine-build`, `-cb` | `coraine-build` in `$PATH` (the `coraine-dev` package); else the coraine clone's, `<clones>/coraine/packaging/deb/coraine-build` | the script Compile runs |
| `--source`, `-src` | `coraine-build`'s own, `/usr/share/coraine/src/coraine-src.tar.xz`; else `<clones>` | the coraine source Compile builds from (passed on as `--source`): a tarball, or a directory of clones |
| `--token-file`, `-tf` | `$C3_TOKEN` | a file holding the access token sent to every broker that has none of its own (Explore, below) - read again whenever it changes |

Every request c³ sends - to a broker, an OpenID provider, a verifier - goes through the proxies of the
environment: `https_proxy`, `http_proxy`, `no_proxy` (or their upper-case names). A broker on this machine
wants `no_proxy=127.0.0.1,localhost`. A certificate of a private CA (a local data space's): `SSL_CERT_FILE`, a
bundle with it.

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

A second `c3` on a port where one is running asks that one to open its window (`POST /api/window/open`)
and exits: the running one's window shown again, full-screen, or a new one when it was closed. The
window is the running c3's, so its minimise and close buttons work. A running c3 of an earlier
version, or one with no screen, cannot: the second `c3` opens the window itself, without those
buttons. Any other program on the port is an error.

The Chrome profile in `~/.local/state/c3/chrome` is c³'s alone. A Chrome on it that no c3 controls - a
window opened without the buttons, or one whose c3 was stopped - would take every new window over, and
none could be shown again. Before c3 opens the window it controls, it stops that Chrome (SIGTERM; the
one named in the profile's `SingletonLock`, on this host, its command line naming this profile).

On Wayland a window comes to the front only with the *activation token* of the click that asked for it:
the desktop gives it to the program it starts (`$XDG_ACTIVATION_TOKEN`; GNOME only for a desktop entry
with `StartupNotify=true`, as c³'s has). A second `c3` sends its token to the running one, which opens
the window again with it - a new window of its Chrome, the earlier one closed, full-screen, on the page
the UI showed last. Without a token (a `c3` typed in a terminal) the running one's window is activated,
and the desktop may answer with "c³ is ready" instead of showing it. The second `c3` writes which it was.

GNOME gives no token to a launch from the dock. There the desktop entry does it: `StartupWMClass` names the
window c3 opens - Chrome's application window of `http://127.0.0.1:<port>` on c³'s profile, app id
`chrome-127.0.0.1__-Default` (Chrome ignores `--class` for application windows) - so GNOME takes the
window for c³'s, and the icon shows it again, minimised or not, without starting a second `c3`.

## The configuration file

`~/.config/c3/c3.json`, written by the backend as the user works - never by the page. It holds the
brokers connected to, with Explore's choices for each (the types, graph or map, the map's view, what the
markers are coloured by), the downloaded map areas, and the last page:

```json
{
  "version": 1,
  "brokers": [
    {
      "url": "http://localhost:1090",
      "name": "localhost:1090",
      "lastUsed": "2026-10-09T17:35:43Z",
      "tenant": "",
      "tenants": ["city"],
      "connect": {
        "types": ["BikeStation", "District"],
        "tenantTypes": { "city": ["Street"] },
        "view": "map",
        "colourBy": "inDistrict",
        "relationships": "selected",
        "map": { "center": [-71.135, 42.3836], "zoom": 13.3 },
        "alerts": [
          { "id": "station-empty", "title": "Station empty", "severity": "warning", "type": "BikeStation", "q": "availableBikes==0" }
        ]
      }
    }
  ],
  "demos": {
    "harbour": { "url": "http://127.0.0.1:7995/c3.json", "hint": "start it with make demo" }
  },
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
        "transports": ["ws"], "bridges": [], "bridgeConfig": null, "admin": true, "distributed": true, "verbose": true, "args": "",
        "grace": 30, "lastStarted": "2026-10-10T08:00:00Z" }
    ]
  },
  "ui": { "lastPage": "connect" }
}
```

- A broker is added, or moved to the front with a new `lastUsed`, when it has answered the discovery;
  the 50 most recent are kept. A broker already in the list keeps its other members.
- `tenant`: the tenant Explore works on at this broker (`""`: the default one); `tenants`: the ones used,
  most recent first, 20 at most.
- `connect.types`: the types loaded with **Load** in the default tenant, sorted; `connect.tenantTypes`:
  the same per tenant. `[]` is a choice too (nothing loaded); a broker with no `types` was never picked
  for.
- `connect.view` (`graph` or `map`), `connect.colourBy` (`type`, or a Relationship's name) and
  `connect.map` (`center` `[lon, lat]`, `zoom`, `bearing`, `pitch`): kept as they change - the map's view
  when the map is moved by hand. `connect.relationships`: `all` or `selected` (the map's **relationships**).
- `connect.alerts`: the broker's alert rules (Alerts, below) - `id` (letters, digits, `-`, `_`, `.`; at
  most 64), `title`, `severity` (`critical`, `warning`, `info`), `type`, `q`; at most 32.
- `demos`: named demos (Named demos, below) - a name and its descriptor's `url`, with a `hint` for when it
  does not answer (or just the URL as a string). `CDMAD` is built in.
- `maps.areas`: the areas downloaded, one `.pmtiles` file each in the data directory. The directory is
  the truth: a finished download is added, an area whose file is gone is dropped, a file with no entry
  is added under its id (its bounds and levels read from the file's header).
- Written whole to `c3.json.tmp`, then renamed over `c3.json` (mode 600, the directory 700).
- `compile.choice`: Compile's choice as it is (`mode`, the `features` set by hand, `workload`), kept as it
  changes; `compile.presets`: the choices saved under a name. The builds themselves are not listed here:
  their directory is the truth (Compile, below).
- `run.brokers`: the brokers Operate started, with their options (Operate, below) - kept when one is started, removed
  with **Forget**. What runs is not in the file: the processes and containers are the truth.
- No access token is ever in it, nor a broker's own headers: remembered, they are in `secrets.json` beside it (Explore, below).
- Members this version does not know are kept. A file that is not a JSON object is moved to
  `c3.json.broken` and c³ starts from an empty one; a file with a `version` above 1 is read and never
  written.

## Explore

- **The tenant.** The field beside the URL: the tenant (`NGSILD-Tenant`) everything is read from - the
  discovery, the entities, the live values; empty, the default tenant. It is kept per broker, and offered
  again with the ones used before and, from coraine with its admin plugin, `GET /admin/tenants`. Another
  tenant is a new connection: its own types, its own picks.
- **Local only.** The tick beside the tenant: off (the default), the broker is read as it answers - with
  the entities of its Context Source Registrations. On, every query carries `local=true`: the broker's
  own entities only, its types and attributes the same. Kept per broker (`"local"` in its `connect`).
- **The access token.** **Token** beside **Connect** - its dot is green when a token is sent. Every
  request to the broker carries `Authorization: Bearer <token>` - through the proxy, the live values'
  subscription over HTTP, and each message over the broker's WebSocket (in its `metadata`, as coraine
  reads it). The broker decides what it allows: a **401** shows the broker's reason with a **Token…**
  button, a **403** says the token was understood and the request not allowed. A delete on a broker c³ sends no token
  to - and that answered without one - asks first: anyone who can reach that broker can delete. A broker's token, in
  this order:
  - a **login** to the broker's OpenID provider (Keycloak, Auth0, Entra ID, ...) - in **Token**, or
    **Log in…** on a 401 when the broker says where its tokens come from (coraine's
    `/.well-known/oauth-protected-resource`, RFC 9728 - the issuer is then filled in): the provider's issuer,
    a client id, a scope (kept per broker in `c3.json` as `"login"`; no secret), then
    **Log in**. The provider's login page opens in a window of its own, and sends the browser back to
    `http://<c³>/api/oidc/callback` - the provider's client must be a **public** one that allows that
    redirect URI. The authorization code flow with PKCE (S256). The tokens stay in c³'s backend, in memory -
    never in the page, never on disk: after a restart, log in again. c³ renews the access token before it
    expires, until the provider ends the session; then the login is over. **Log out** forgets the tokens.
  - a **credential login** - the Data Space Connector (coraine's `fdsc.so`, or the connector itself) takes
    the tokens of its verifier (VCVerifier), for a presented Verifiable Credential: **With a Verifiable
    Credential** in the login, the verifier's discovery document, the credential type (Keycloak's
    `credential_configuration_id`) and the verifier's scope - filled in from the broker's metadata where it
    says. The login is at the consumer's Keycloak; c³ then gets the credential there (OID4VCI, Keycloak's
    pre-authorized offer), presents it signed by a holder key of its own (P-256, `did:key`, in memory - as
    the connector's DID Helper makes one), and sends the verifier's access token. Renewed: presented again
    before the token expires; a new credential (the consumer's login refreshed) before the credential does.
    The consumer's Keycloak client c³ logs in as: public, the redirect URI above, and OID4VCI enabled for it
    (`oid4vci.enabled`, "OpenID for Verifiable Credentials" in its Advanced settings) - without it Keycloak
    answers "Client not enabled for OID4VCI".
  - its own, typed in **Token**: kept in memory, and with **Remember it on this machine** in
    `secrets.json` beside `c3.json` (mode 600 - a file others can read is not used);
  - `--token-file <file>`: the default for every broker, read again whenever the file changes - so a
    script outside c³ can keep a short-lived token (the Data Space Connector's last about 30 minutes)
    fresh;
  - `$C3_TOKEN`, when there is no `--token-file`.

  A token is never on the command line, never in `c3.json`, and never sent to the page: the page learns
  where it comes from and its last four characters (`GET /api/brokers/tokens`).
- **Headers of its own** - in **Token**, below the token: up to 16 headers per broker, each a name, a
  value and **secret** - an API key, a Basic `Authorization`, whatever a gateway in front of the broker
  asks for. They go with every request to that broker, as they are: through the proxy (reads and writes),
  the live values' HTTP requests, the WebSocket's upgrade request and the metadata of each message on it.
  An `Authorization` among them takes the place of the token. Kept in memory, and with **Remember them on
  this machine** in `secrets.json` (mode 600); a secret header's value is never sent to the page - it shows
  its last four characters (more than 12 characters long) or its length, and a secret header saved with
  its value field empty keeps the value it has. Refused: the headers c³ sets itself - `Host`,
  `Content-Length`, `Content-Type`, `Transfer-Encoding`, `Connection`, `Upgrade`, `Accept`, `Keep-Alive`,
  `TE`, `Trailer`, `Sec-WebSocket-*`, `X-C3-Broker`, `NGSILD-Tenant` (the tenant is chosen in Explore). A
  value has no line break nor other control character and is 8 KB at most.
- **Discovery** - what a broker holds, before any entity is loaded:
  - `GET /ngsi-ld/v1/types?details=true` - the types and their attribute names (a broker that does not
    answer it is asked for `GET /types`);
  - `GET /ngsi-ld/v1/types/{type}` per type, six at a time - its entity count (`entityCount`) and its
    attributes with their kinds (`attributeDetails[].attributeTypes`: Property, Relationship,
    GeoProperty, ...); a broker that does not answer it is asked for
    `GET /entities?type=T&limit=0&count=true` (the count only);
  - `GET /ngsi-ld/v1/attributes?details=true` - the types each attribute is used in (`typeNames`).

  The panel on the left lists the types, sorted, with their counts; **▸** opens a type's attributes,
  each with its kinds and the other types that have it. **Relationships** lists Relationship name, from
  type and to type, with how many: NGSI-LD's discovery gives an attribute's kind but not the type of
  the entity a Relationship points to, so these come from the loaded entities, and the panel says so
  until some are loaded. A broker with no `/types` at all is loaded whole, as in milestone 1.
- **Choosing what to see.** Each type has a tick: **Load** loads the types ticked - one query,
  `GET /entities?type=A,B&limit=100&count=true` (with **Local only**, `local=true` too - without it if
  the broker refuses it), one per type when the list is longer than 2000 characters - every `rel="next"` page, up to
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
    (the loaded ones, the others by `GET /entities?id=a,b,...`) and the entities pointing at
    it (the loaded ones, and the broker's: `q=<r1>=="<id>"|<r2>=="<id>"|...` over every
    Relationship name of the discovery, the first 300). Laid out on its own; **Back to the picked
    types** returns to them.
  - **Follow** › one item per Relationship target: selects and centres it, or opens its neighbourhood
    when it is not loaded.
  - **Hide type <T>**, **Copy id**, **Show JSON** (the entity as the broker returned it, in a panel
    with **Copy**; Esc closes it).
  - **Edit…** - the editor (below), also the **Edit…** button of the attribute panel; **Replace…** - the
    same rows, Save sends the whole entity (`PUT /entities/{id}`).
  - **Delete entity…** › **Delete <id> - at the broker**: `DELETE /entities/{id}`.
- **An attribute's menu** - right-click it in the attribute panel: **Edit <name>…** (the editor, that
  attribute opened), **Delete <name>…** (`DELETE /entities/{id}/attrs/{name}`, with `datasetId` for an
  instance of its own) and, for an attribute with several instances, **Delete every instance**
  (`deleteAll=true`).
- **Creating an entity** - right-click where there is no entity: in the graph **Create entity…**, on the
  map **Create entity here…** (its `location` that point). The editor, with the id and the type typed
  in - the types of the broker offered, and **＋ <type>'s attributes**: the attributes its loaded
  entities have, each empty of its kind (a Property with the JSON type of a loaded value). Save sends
  `POST /entities`; an entity of a type not loaded is created and not shown, and a toast says so.
- **The editor** - the entity as rows, over the graph's right side (the graph stays usable):
  - each attribute instance is a row: **▸** opens its sub-attributes, **🗑** marks it deleted (struck
    through until Save; **↺** restores it); a `datasetId` shows as a badge;
  - the row's input is its kind's: a Property's value with its JSON type (number, text, true/false,
    JSON), a Relationship's target - typed, or **pick in graph** (the next entity clicked, in the graph
    or on the map) -, a Point's longitude and latitude - typed, or **pick on map**, the next point clicked -, a LanguageProperty's languages, a list's items,
    a JsonProperty's JSON; `observedAt` with **now**;
  - **＋ sub-attribute** at the end of a row's sub-attributes, **＋ attribute** at the bottom - its name
    (the names of the loaded entities' types offered), its kind, and a `datasetId` for another
    instance of an attribute; an existing attribute keeps its kind;
  - changed rows are marked, and an input that does not parse is marked and stops Save;
  - **Save as** (an edit's): how the changes are sent - kept from one edit to the next:
    - **Merge** (the default) - `PATCH /entities/{id}`, TS 104 175 § 10.2.9: what changed,
      `"urn:ngsi-ld:null"` for what was deleted - an attribute, a sub-attribute, a key inside an object
      value, one instance (with its `datasetId`). A changed attribute always carries its main member
      (`value`, `object`, ...) and a GeoProperty its whole value: the merge needs neither, some brokers
      refuse a fragment without them;
    - **Update attributes** - `PATCH /entities/{id}/attrs`: each new or changed instance whole,
      `"urn:ngsi-ld:null"` for a deleted attribute or instance;
    - **Append attributes** - `POST /entities/{id}/attrs`: each new or changed instance whole; a
      deletion is not sent (an append cannot delete) and the request says how many are left out;
    - **Append, no overwrite** - `POST /entities/{id}/attrs?options=noOverwrite`: the same, and the
      broker leaves an existing attribute as it is - its 207 names them;
    - **Partial attribute update** - `PATCH /entities/{id}/attrs/{attrId}`, one request per changed
      instance, one after the other: its changed members whole (the broker replaces them, it does not
      merge into them), `"urn:ngsi-ld:null"` for a deleted sub-attribute, its `type`, `datasetId` and
      main member always. A new attribute or instance and a deleted one are not sent (left out, and
      counted). The first request that fails ends it; those before it stay done;
  - **The request** at the bottom: what Save sends - the method, the path and the body (each of them,
    for a partial update);
  - after Save the entity is read again and drawn; the broker's error (a 401, a 403, a 400's detail,
    a 207's attributes not updated) shows in the editor, which stays open; Esc closes it (twice, with
    unsaved changes).
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
- **relationships**: `all` draws every Relationship; `selected` only the selected entity's (a route with
  dozens of stops). Kept per broker.
- **Icons**: a Point of a kind c³ knows by its type's name is an icon instead of a dot - a bus (`Bus`,
  `Tram`, a vehicle), a stop (`BusStop`, `...Stop`), a streetlight (`Streetlight`, `Streetlamp`), an air
  quality station (`AirQuality...`), a weather station (`Weather...`), a traffic sensor (`Traffic...`), a
  person (`Person`, `Driver`); any other type a dot. The entity's state colours it over its type's
  colour: a `status` that says broken (`broken`, `faulty`, `outOfOrder`, ...) or `congested` `true` red, an
  `airQualityLevel` on its scale (`good` green to `veryPoor` red), a `powerState` `on` warm yellow, `off` dim grey.
- **Movement**: a Point that a live change moves glides to its new place over the time between its last
  two changes (0.2 - 5 s; 1 s the first time), instead of jumping; its Relationships' lines follow. Not
  with `prefers-reduced-motion`. The entities that moved in the last 20 s are drawn from a source of
  their own, set again every frame; the others' source is set again only when what it draws changed.
  Measured with 30 buses moving among 1 464 other features (Chrome, the map's own render included): 2.4 ms
  a frame (median), 4.0 ms (95th percentile).
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

Not yet: a rectangle drawn on the map as a `georel=within` query, saved views.

### Named demos

A name in the broker field instead of a URL - **`CDMAD`**, Explore - is a demo: c³ asks the backend for
it (`GET /api/demos/<name>`), the backend looks the name up in the configuration's `demos` (any case;
`CDMAD`, [c3-demo-madrid](https://github.com/SEAMWARE/c3-demo-madrid), is built in as
`http://127.0.0.1:7990/c3.json`) and fetches the demo's descriptor from it:

```json
{
  "name": "Madrid",
  "broker": "http://127.0.0.1:9026",
  "tenant": null,
  "view": { "mode": "map", "center": [-3.693, 40.43], "zoom": 12.6, "relationships": "selected" },
  "watch": ["Bus", "BusStop", "Streetlight"],
  "alerts": [ { "id": "streetlight-out", "title": "Streetlight out", "severity": "critical", "type": "Streetlight", "q": "status==\"broken\"" } ]
}
```

Explore then connects to `broker` (in `tenant`). What the broker has not been given in c³ yet comes from
the descriptor: the view (`mode`, `center`, `zoom`, `relationships`), the types loaded (`watch`), the
alert rules (`alerts`); what is changed in c³ is kept for the broker as for any other, and wins the next
time. A demo that does not answer is said so: *CDMAD is not running at http://127.0.0.1:7990 - start it,
then Start broker + populate*; its broker not answering: *start it there (Start broker + populate)*. A
name the backend does not know is a host name (`localhost` is `http://localhost`).

### Alerts

**Alarms** (next to **Live**) holds the broker's alert rules and the alarms they raise.

- **A rule**: a title, a severity (`critical`, `warning`, `info`), an entity type and a `q`. Each rule is a
  subscription of its own that the backend makes on the broker, with the live values' (the same
  endpoint: the broker's WebSocket, or `/api/notify/<session>`; named `c3-live:<port>`; deleted with
  them). A rule the broker refuses (a `q` it does not take) says why under **Rules…**.
- **An alarm**: a rule's notification raises one for each entity in it - a toast (a click shows the
  entity), a row in the list, and the entity ringed on the map in the severity's colour, pulsing until
  acknowledged (**Ack**). The bell's count is the alarms not acknowledged. An alarm already raised is not
  raised again while it lasts. The loaded entities that already match a rule are alarms from the
  start, without a toast.
- **Cleared** when the live values show the entity no longer matching - c³ evaluates the simple forms of
  `q` itself: terms joined by `;`, each `<attribute><op><value>` with `==`, `!=`, `>`, `<`, `>=`, `<=` and a
  `"string"`, a number, `true` or `false`. An alarm of a rule with any other `q` clears by hand
  (**Clear**); one whose entity is deleted clears.
- **Rules…**: added and removed per broker, kept in the configuration (`connect.alerts`).

On the page's WebSocket: `{"op": "alerts", "broker", "tenant", "rules": [{"id", "type", "q"}]}` sets the
rules; the backend answers `{"op": "alerts", "broker", "installed": [{"rule", "subscription"}], "failed":
[{"rule", "detail"}]}` and sends each notification as `{"op": "alert", "broker", "rule", "message"}`.

### History

The attribute panel's **History**: each numeric Property of the selected entity over the last 10 minutes,
as a sparkline (a step line - a value holds until the next) with its range and count. Read once on
select - `GET /ngsi-ld/v1/temporal/entities/{id}?timerel=after&timeAt=<10 minutes ago>&attrs=...&timeproperty=modifiedAt&options=sysAttrs`
(every change, with an `observedAt` or not; a value's time is its `observedAt` if it has one) - then grown
from the live values. A broker without the temporal API, or whose TRoE plugin does not read history
(coraine's `--troe ramDB` answers 422), shows the live values from the moment the entity was selected,
and says so. coraine with `--troe corDB` answers it.

## Compile

A front-end to `coraine-build` ([doc/compile.md](doc/compile.md)): c³ builds nothing itself - every build
is the command shown, run by the backend, the same build as on the command line.

- **What this machine can do** - `GET /api/capabilities`: `coraine-build` (`--coraine-build`, else
  `$PATH`) and the source (`--source`, else the tarball `coraine-dev` installs) must both be there.
  Without `coraine-dev`, both come from `<clones>`: the directory of git clones c³ was built against
  (the makefile's `COR_LIBS`, made absolute - `C3_CLONES`; empty in a package). Its coraine clone's
  `coraine-build` exports them as the packages' tarball is made: coraine at the commit checked out, each
  lib at `origin/main` - committed trees only.
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
- **Target** - shown greyed: `coraine-build` builds a binary for the host.
- **HTTP server** - libmicrohttpd (the default) or coraine's own (`--http-server builtin`; not with the
  training modes).
- **Executable** - the broker's file name in `install/bin` (`--name`, default `coraine`): a broker built
  for one role named after it, a `cor-agent`. It reads the same `CORAINE_*` environment variables, and
  Operate starts it by that name.
- **The command** - `POST /api/builds/command` answers the exact `argv` for the choice; the page shows it,
  one option a line. Only the switches that differ from their defaults are passed. **Build** starts that
  command under the name it showed (the name field, else `<mode>-<date>-<time>`).
- **Following a build** - its output line by line, a bar over the phases `coraine-build` announces
  (`coraine-build: phase build`, `install`, `bridges`, `check`, `done`; `tools` and `train` for the
  training modes; *unpack* before the first): how far into a phase is its line count against the same
  phase of the last build of that mode that succeeded, with that build's phase times as the weights.
  **Cancel**: SIGTERM to the build's process group, SIGKILL 5 s later.
- **The result** - the size of `install/` and of the broker, the mode and time, the features as the
  built broker reports them (`install/bin/<executable> --version`, the switches off struck through), its
  `--version`, the directory, the whole log. **Run it** opens Operate with that build in the form.
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
  "name": "page-edge", "executable": "coraine", "state": "succeeded", "mode": "release",
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

## Operate

Brokers started and stopped on this machine, and the services they use ([doc/design.md](doc/design.md), Run).

**What a broker is started from**

| From | Runs | How |
|---|---|---|
| the installed `coraine` (`$PATH`) | natively | `coraine <options>` |
| a build of Compile's | natively | `/bin/sh -c '<script>' <build>/install/env <build>/install/bin/coraine <options>` - the script sources `install/env` (its own `PATH`, `SEAMWARE_PLUGIN_DIR` and `etc`, as `. install/env` by hand) and, for a tuned build, `install/etc/tune.env` as the image's entry point does: `TUNE_DBLOCKPREFER` as `CORAINE_DBLOCKPREFER` (an option on the command line still wins), `TUNE_ALLOCATOR` preloaded (`LD_PRELOAD`, found with `ldconfig -p`; not installed: glibc's, and the broker's log says so). It writes one line to the broker's log, `c3: <tune.env> applied - ...` |
| an image (`quay.io/seamware/coraine:<tag>`) | in a container | `docker run -d --name c3-broker-<name> ... <image> <options>` - the image's entry point is `coraine` (in the foreground, the log on stdout) |

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
- **Switches** - the WebSocket transport (`--transports ws`), the admin API (`--apiPlugins admin`),
  distributed operations (`--distributed`: queries and updates forwarded to the Context Sources registered -
  on by default; off and greyed for a broker built without REGISTRATIONS), `-v`.
- **Bridges** - those the broker has (the `bridge/*.so` of its plugin directory), and a bridge
  configuration file; without one, c³ writes `<run>/<name>/bridges.json`: the set's Mosquitto for mqtt,
  the DDS domain and mapping for dds, the CKAN datasets ticked, the OPC UA server.
- **DDS** - the bridge configuration file (`--bridgeConfig`) and the default user `@context` file
  (`--defaultUserContext`), and **Map DDS topics, services and actions**, the width of the form, active with
  the dds bridge ticked: the DDS mapper (below). A container broker with the dds bridge runs with
  `--network host --ipc host`: DDS discovery is UDP multicast, which a bridge network such as `c3` keeps to
  its own containers, and Fast DDS reaches a participant on the same machine over shared memory. Its port is
  then the host's - not published on `127.0.0.1` only: coraine listens on every interface, as a native broker
  does - and it reaches the services on `127.0.0.1:<port>`, as a native broker does. Its files are mounted:
  the `--defaultUserContext` file at `/etc/c3/user-context.jsonld`, c³'s `dds-types/` at its own path.
- **OPC UA** (native brokers - the image has no opcua bridge) - the server's URL, the model roots (an
  Object's NodeId a line: each one an AssetChannel, its model a graph of entities), the security mode and
  policy, the client's certificate, key and application URI, the server certificates to trust (or "trust
  any", which says what it means), a username and password. Filling in the URL ticks the opcua bridge.
  The password is sent once, on Start: c³ keeps it in `<run>/<name>/opcua.password` (mode 600) and names
  that file in `bridges.json`; it is never in `c3.json` or the API, which says only `passwordSet`. Empty
  keeps the one c³ has.
  **Channels** - a Variable each, its value one attribute of an entity: the NodeId, the entity's id and
  type, the attribute (the bridge's `topics` in `bridges.json`).
  **Browse the server** - for a running broker with the admin API (its **Options**): the server's nodes as
  the broker's bridge sees them, one level at a time (`GET /admin/bridges/opcua/inventory`, coraine with
  bridge ABI 14). A Variable shows its value, DataType, unit and whether it can be written, and **+ Channel**
  adds it - named as an AssetChannel on its Object would name it (the Object's `typeName` and name, the
  attribute its path from the Object), so that both write the same entity; every name stays editable. An
  Object's **+ model root** adds it to the model roots. What is picked takes effect when the broker is
  stopped and started again.
  **Map an OPC UA server**, under the DDS mapper's button, active with the opcua bridge ticked: the OPC UA
  mapper (below) - the whole address space at once, before a broker runs, written into a bridge
  configuration file of its own.
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
(`c3-mongoc-timescale-mongo:27017`) - one with the dds bridge, on the host's network, on
`127.0.0.1:<port>` too.

- Started before the broker that needs them and waited for: MongoDB until `mongosh` answers its ping,
  PostgreSQL until `pg_isready`, Mosquitto until it takes a connection (3 minutes at most). MongoDB is a
  single node, not a replica set: coraine needs one only for `--high-availability mongo`.
- `mongo:8.2`, not 8.0: mongo 8.0 does not start on Linux 6.19 and newer (SERVER-121912).
- Stopped (`docker stop`, then `docker rm`) when the broker using them stops and nothing else started from
  c³ uses them; **Stop** on a service nothing uses. The volume is kept: **Delete data** (press twice) removes
  it, and only a volume c³ made (label `c3=run`) whose container does not run.

**Starting.** The broker joins Explore's list (`http://localhost:<port>`, named as in Operate) and is kept in
`c3.json`. A native broker is started in a session of its own (`setsid`), its stdout and stderr appended
to its log, in its directory, with c³'s environment less `CORAINE_*` and `SEAMWARE_PLUGIN_DIR` (each option
of the broker's can be set from the environment; the form is the whole of it). It does not need c³: when
c³ stops, the brokers keep running. A container broker listens on 1026 inside its container, the port
chosen published on `127.0.0.1`; one with the dds bridge listens on the port chosen, on the host's
network. The image's `HEALTHCHECK` asks the port in the broker's arguments (`--healthPort`, else
`--port`); in images from before 2026-10-10 it asks `localhost:1026/version`, and a broker on another
port is reported `unhealthy`.

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

**Configuration and build** - above the log of a running broker with the admin API, read-only: what it is
built with (`GET /build` - version, debug or release, HTTP server, commit; each feature compiled in or out;
the plugins loaded) and every option it runs with (`GET /admin/config`, coraine with `ADMIN_CONFIG`) -
value, where it came from (command line, environment, default; "resolved by the broker" when a default of 0
means the broker chooses), the default, and on hover what it does, its environment variable and short form;
a plugin's options under its section. A secret (`--dbPwd`, `--dbURI`, `--troePwd`) comes masked from the broker.

**Metrics** - above the log of a running broker with the admin API: its `/admin/metrics` as charts over
the last 10 minutes, read every 5 s while the panel is open - from every broker running here with the admin
API, so one selected later has its last minutes too. Requests per second (all, reads, writes), errors (4xx,
5xx), latency (the mean and the 95th percentile of the requests in each 5 s, from the histogram's buckets),
notifications per second (sent, to context sources, Server-Sent Events, failed), subscriptions (entity,
periodic, context source, Server-Sent Events streams) and memory (used, resident, the budget); below them
the busiest operations over the last minute. A read that fails, or a request count that goes down (the
broker started again), is a break: no rate across it. A chart whose metrics the broker does not serve says
so. The summary line carries requests per second, the mean latency and the subscriptions.

**Log and trace levels** - above the log of a running broker with the admin API: verbose and info,
and a tick box per trace level, grouped by library, its tooltip what it traces - set live through coraine's
`/admin/log` (a change PUTs the whole set; a level c³ has no name for, set elsewhere, is kept). The levels
and what each traces are `www/data/traceLevels.json`, made from the libraries' trace-level headers by
`tools/traceLevels.py <dir of the cor* repos>` - run it again when a library adds one. Traces exist in
debug builds only: on coraine's `"traces": false` (a release build) the tick boxes are greyed, and say why.

### The DDS mapper

Operate's left side, given to the mapping of a DDS domain to NGSI-LD - from Operate's **Map DDS topics,
services and actions**, or from Compile's, under its Bridges with dds on: that one asks first, then shows
Operate with the dds bridge ticked in its form and the mapper open, with **← Back to Compile**. Each
topic, service or action mapped is one attribute of an entity. What was written is read back when c³
opens (`GET /api/run/dds/files`), and the mapper opens on it.

- **How c³ reaches your DDS system** - **domain** (0-232; ROS 2: `ROS_DOMAIN_ID`), **transport**
  (shared memory and UDP - DDS's default; UDP only, `udp`; shared memory only, `shm`) and **interfaces** -
  the IPv4 addresses of this host's interfaces UDP is kept to, comma-separated; empty: all; none with `shm`
  (refused). In the bridge configuration: `dds.ddsmodule.dds` `domain`, `transport`, `whitelist-interfaces`
  (a list of addresses needs corDdsBridge with SEAMWARE/corDdsBridge#21 - before it, the DDS Enabler refused
  a list of plain values and the broker did not start). Discover's broker and the broker Done starts use
  them alike. DDS discovery reaches this host and its network segment, not across a router, a VPN or a NAT;
  shared memory reaches this host alone, and a container only sharing its `/dev/shm`. A ROS 2 Discovery
  Server, unicast peers and Fast DDS XML profiles cannot be given: the DDS Enabler 1.2.2's participant reads
  none of them. Where c³ does not reach the system: **Import inventory.json**.
- **A vocabulary** - the namespace of the terms, each entity type and attribute
  `<vocabulary><term>`; empty: the default context's (`https://uri.etsi.org/ngsi-ld/default-context/`).
  **proposals' type** - the entity type the proposals give (Robot).
- **Discover** - asks the DDS system what it announces: c³ joins its domain from the machine it runs
  on, so it must reach it - DDS discovery is multicast, on that host or its network. c³ starts a broker of its own for it (`POST /api/run/dds/discover`): the form's source
  (the installed broker, a build, or the image: the container `c3-broker-<name>.discover`, `--rm`, its
  entry point under `timeout 120` - it ends by itself if c³ does not stop it) and the domain, transport and interfaces, the dds bridge
  alone, corDB in memory, no history, the admin API, a free port from 39026, its directory
  `<run>/<name>.discover/` (a container's output into `broker.log` before it is removed). One
  `GET /admin/bridges/dds/inventory` (coraine with bridge ABI 14), which the bridge answers once discovery
  has been quiet for 3 s (at most 10 s - "still announcing" when it ran out), and the broker is stopped
  again; a few seconds in all, one discovery at a time. **Import inventory.json** reads the same list from a
  file a DDS discovery tool wrote (`dds-discovery -o inventory.json`), without the fields. ROS 2's
  housekeeping (its discovery and log topics, every node's parameter services) is hidden unless asked for.
- **Three lines** - *N DDS Topics*, *N DDS Services*, *N DDS Actions*, each opened with ▸, with the number
  mapped. Open, an endpoint a line: its name, its type, and, mapped, its attribute and entity; one mapped
  and not in the last discovery is listed too.
- **The proposals** - an endpoint not mapped shows, greyed, its proposal: the name's last segment
  camelCased the attribute, the segments before it (`rt/` dropped) the entity - `rt/turtle1/pose`: `pose`
  of `urn:ngsi-ld:Robot:turtle1`; no segment: `urn:ngsi-ld:Robot:robot1` - and the proposals' type the
  entity's, once (an entity with a type keeps it). The green **✓** accepts it into the fields still
  empty; **✓ all (N)** on a group accepts those of every endpoint shown and not mapped. Each name stays
  editable.
- **An endpoint opened** - Attribute name, Entity ID, Entity type (optional), the ids and types in use
  offered as you type. The first field typed in names the attribute from the endpoint: its last segment
  (`rt/` dropped) camelCased - `rt/turtle1/cmd_vel`, `cmdVel`. **the topic's payload** (a service's
  **request and reply**, an action's **goal, feedback and result**) shows a sample of its DDS type - the
  value of the attribute it is mapped to; **not mapped** takes the endpoint out. A service keeps its request and reply types, an action its type,
  as discovered.
- **An entity's type, once** - an entity is created with its type: every entity id needs one on at least
  one of its endpoints, the others take it. Done is refused, and the endpoint says why, for: no attribute or
  no entity id, an id that is not a URI, an entity with no type anywhere, two types for one entity, a name
  with a character NGSI-LD forbids (space `< > " ' = ; ( )`), a member of every entity (`id`, `type`,
  `scope`, `createdAt`, ...) as an attribute, two endpoints on one attribute of an entity.
- **Done** - `POST /api/run/dds/files` writes `$XDG_DATA_HOME/c3/dds/` (else `~/.local/share/c3/dds/`):

  ```
  dds-bridge.json      the bridge configuration: {"dds": {"ddsmodule": {"dds": {domain, transport, whitelist-interfaces}, ...}, "ngsild": {topics, services, actions, typesDirectory}}}
  dds-context.jsonld   the @context: each entity type and attribute a term
  dds-mapping.json     the mapping as posted - what the mapper reads back
  dds-types/           the bridge's typesDirectory
  ```

- **The files screen** - the two files' full paths, each with Copy, and **Start a broker with it**: the
  broker of the form with the dds bridge, `--bridgeConfig <dds-bridge.json>`, `--defaultUserContext
  <dds-context.jsonld>`, and **More options** as typed - the command shown. **Start the broker** starts it
  and closes the mapper; **Put it in the broker form** fills the form only. A broker given both c³'s DDS
  vocabulary and a `--defaultUserContext` of its own is refused: one default user `@context`.

### The OPC UA mapper

Operate's left side, given to the mapping of an OPC UA server to NGSI-LD - from Operate's **Map an OPC UA
server**, or from Compile's, under its Bridges with opcua on: that one asks first, then shows Operate with
the opcua bridge ticked in its form and the mapper open, with **← Back to Compile**. The DDS mapper's
layout and ways; what differs is the server's: a tree of nodes, not three lists of endpoints. A Variable
mapped is one attribute of an entity (a Channel - the bridge's `topics`); an Object mapped is a model (an
AssetChannel - the bridge's `assetChannels`). What was written is read back when c³ opens
(`GET /api/run/opcua/files`), and the mapper opens on it.

- **How c³ reaches your OPC UA server** - its URL (`opc.tcp://host:port`), the security mode (None, Sign,
  SignAndEncrypt) and, secured, the policy (Basic256Sha256 unless chosen), the client's certificate and
  private key (files), the application URI the certificate names, the server certificates to trust (a file a
  line) or "trust any"; a username and password, empty: anonymous. The first time, the broker form's server
  fills them. The password is sent once: c³ keeps it in `opcua/opcua.password` (mode 600) and the bridge
  configuration names that file (`passwordFile`) - it is in no file the mapper writes, and the API says only
  `passwordSet`; empty keeps the one kept. Discover's broker and the broker Done starts use them alike.
- **A vocabulary** and **proposals' type** - as the DDS mapper's; the proposals' type is given an Object
  whose TypeDefinition says nothing (BaseObjectType, FolderType) - Machine.
- **Discover** - reads the server's address space: c³ starts a broker of its own for it
  (`POST /api/run/opcua/discover`): the form's source - native only, the image has no opcua bridge - the
  opcua bridge alone, connected to the server with the fields above, no Channels and no models, corDB in
  memory, no history, the admin API, a free port from 39026, its directory `<run>/<name>.discover/`. It asks
  the bridge's inventory (`GET /admin/bridges/opcua/inventory?depth=5`, coraine with bridge ABI 14) while it
  answers 503 - not connected yet - for at most 20 s; then asks again from each node the answer cut at depth
  5 (`&from=<NodeId>`) and grafts what it gets, namespace 0 left out, at most 20 000 nodes and 400 requests -
  "cut" when the server has more. The broker is stopped again; a few seconds in all, one discovery at a time.
  **Import inventory.json** reads the same tree from a file: c³'s answer, or the bridge's inventory as a
  broker answers it (`curl '<broker>/admin/bridges/opcua/inventory?depth=5' > inventory.json`).
  **show the server's own nodes** - namespace 0: the Server object, its diagnostics and sessions, aliases,
  locations - hidden otherwise.
- **The tree** - the Objects folder's content, a line a node: ▸ opens what it contains (the application's
  top level open), the name and what it is - a Variable's DataType, unit and whether it can be written, an
  Object's TypeDefinition, a folder, a method.
- **A Variable** - not mapped, its proposal greyed: the entity the nearest Object above it, named as an
  AssetChannel on its Objects would name it - `urn:ngsi-ld:<TypeDefinition>:<the Objects' names from the
  top>` (`urn:ngsi-ld:PressType:Press17`), the attribute its path from that Object camelCased
  (Hydraulics/Pressure: `hydraulicsPressure`) - so that both write the same entity. **✓** accepts it into
  the fields still empty. Its name opens the fields: Attribute name, Entity ID, Entity type (optional, once
  per entity, as the DDS mapper's), **its value** as discovered with its SourceTimestamp, **not mapped**. A
  write of the attribute writes the Variable when the server lets it be written.
- **An Object** - **✓** maps it as a model: the Object and every Object in it entities, named by their
  TypeDefinitions (`entities: natural`), their Variables attributes named by their paths, their parts and
  references Relationships - as the bridge makes them. The line says how many entities and attributes;
  opened, **Containers** (`attributeLayout`: an attribute per Variable; a folder one attribute, its Variables
  sub-attributes; a folder one JsonProperty), **Direction** (`channelDirection`: values in; both - a write of
  an attribute writes its Variable), **what it makes** (the entities and the attribute names), and
  **✓ its Variables (N)**: each Variable in it a Channel as proposed, instead of the model. A node inside a
  model says so and is not mapped again; a model inside another is refused.
- **A method** - shown, not mapped: a method is a service of its entity, a Service Registration with the
  endpoint `opcua://<Object NodeId>/<method NodeId>` (the opcua bridge's guide).
- **Done** - refused, the node saying why, for what the DDS mapper refuses, and a URL that is not
  `opc.tcp://`, a security mode without its certificate, key, application URI or trust, a user without a
  password. `POST /api/run/opcua/files` writes `$XDG_DATA_HOME/c3/opcua/` (else `~/.local/share/c3/opcua/`):

  ```
  opcua-bridge.json     the bridge configuration: {"opcua": {"server": {url, security, user}, "ngsild": {"defaultEntity": false, topics, assetChannels}}}
  opcua-context.jsonld  the @context: each Channel's entity type and attribute, and each model's types and attributes as the mapper reads them, a term
  opcua-mapping.json    the mapping as posted, the password left out - what the mapper reads back
  opcua.password        the user's password, mode 600 - none without a user
  ```

- **The files screen** - as the DDS mapper's, with the opcua bridge: **Start the broker** and **Put it in
  the broker form** make the form a native broker with `--bridges opcua`, `--bridgeConfig
  <opcua-bridge.json>`, `--defaultUserContext <opcua-context.jsonld>`, and its own OPC UA server, model roots
  and Channels emptied - the server is in the file, and a broker given both is refused.

**Containers** go through `docker`, else `podman` (the same commands), found in `$PATH` and asked for its
version. Without either, or with a daemon that does not answer, the container parts are greyed with what
to install. c³ creates only `c3-*` containers, volumes and the network `c3`, all labelled `c3=run`, and
touches nothing else.

**Where it lives**: `$XDG_DATA_HOME/c3/run/` (else `~/.local/share/c3/run/`):

```
<name>/broker.log     its output and c3's lines about it; broker.log.1 the run before
<name>/state.json     a native broker that runs: {pid, procStart, started} - and broker.pid, the pid alone
<name>/data/          --dbDir of a native corDB
<name>/bridges.json   the bridge configuration c3 writes (mqtt, dds, ckan, opcua)
<name>/dds-context.jsonld  the DDS mapping's terms, the broker's --defaultUserContext (a DDS vocabulary given)
<name>.discover/      the broker DDS discovery runs: its bridges.json and broker.log
dds/                  the DDS mapper's: dds-bridge.json, dds-context.jsonld, dds-mapping.json, dds-types/ (next to run/)
opcua/                the OPC UA mapper's: opcua-bridge.json, opcua-context.jsonld, opcua-mapping.json, opcua.password (next to run/)
<name>/opcua.password the OPC UA user's password, mode 600 - never in c3.json
services/<container>.log
```

**Forget** (press, then keep or delete the data) removes a broker that does not run from `c3.json`; with its
data, also its directory and its volume.

## How it is built

**Backend - C, on coraine's own libraries.** One binary, `c3`, from the files in [src/](src/) - `maps.c`
is the map's downloaded areas (the planet read by Range, the extract, the fonts, the job and its API),
`live.c` the live values (the page's sessions, their subscriptions and the alert rules', the notifications), `demo.c` the named demos' descriptors, and `ws.c`
WebSocket (RFC 6455) both ways - the client end to a broker, the server end for the page - and
`compile.c` Compile (the capabilities, the feature list, the builds and their processes, the live log),
`run.c` Operate (brokers and services, their processes and containers, status, logs) and `util.c` what those two
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
| `PUT /api/brokers/types` `{"url", "types"}` | the types Explore loads from a broker, as its `connect.types` (the broker must be in the list) |
| `PUT /api/brokers/connect` `{"url", "view", "map", "colourBy", "relationships", "alerts", "tenant", "local"}` | Explore's view of a broker: each member given replaces the stored one |
| `PUT /api/ui` `{"lastPage"}` | `compile`, `run` or `connect` |
| `GET /api/capabilities` | what this machine can do: `host`, `arch`, `distribution`, `compile` (`available`, `why`, `coraineBuild`, `source`, `version`, `builds`, `pgo`, `pgoWhy`, `mongoc`, `mongocWhy`, `liveLog`), `run` (`coraine`, `coraineWhy`, `containers`, `engine`, `engineVersion`, `containersWhy`, `dir`) |
| `GET /api/compile/features` | `coraine-build --list-features --json` as `{"coraineBuild", "source", "version", "features": [{"name", "default", "description", "requires"}]}` |
| `PUT /api/compile/choice` `{"mode", "features", "workload"}` | Compile's choice, kept as `compile.choice` |
| `PUT /api/compile/presets` `{"name", "mode", "features", "workload"}` | a preset, added or replaced (in its place) in `compile.presets` |
| `DELETE /api/compile/presets` `{"name"}` | |
| `POST /api/builds/command` `{"name"?, "executable"?, "mode", "httpServer"?, "features", "bridges"?, "workload"?}` | the build that body would start: `name`, `dir`, `argv`, `command` - nothing run |
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
| `POST /api/run/dds/discover` `{broker}` | the inventory of the broker's DDS domain - the dds bridge's (`GET /admin/bridges/dds/inventory`), from a broker of its own started and stopped for it: `200`; `422` for a container broker, `409` while another discovery runs, `502` with why when the broker did not start or answer |
| `GET /api/run/dds/files` | the DDS mapper's files: `{directory, bridgeConfig, userContext, mapping}` (`mapping` null before the first Done) |
| `POST /api/run/dds/files` `{domain, vocabulary, topics, services, actions}` | write them from a mapping: `201` with the same answer; `400` with why for a row that is not one |
| `POST /api/run/opcua/discover` `{broker}` | the OPC UA server's address space - the opcua bridge's inventory, crawled (`GET /admin/bridges/opcua/inventory`), from a broker of its own started and stopped for it: `200` `{url, complete, nodes, objects}`; `409` while another discovery runs, `502` with why - a container broker, no URL, a broker that did not start or a server it did not reach |
| `GET /api/run/opcua/files` | the OPC UA mapper's files: `{directory, bridgeConfig, userContext, mapping}` (`mapping` null before the first Done; its `user` says `passwordSet`, never the password) |
| `POST /api/run/opcua/files` `{url, security, user, vocabulary, channels, models, terms}` | write them from a mapping: `201` with the same answer; `400` with why |
| `GET /api/maps` | the data directory, the downloaded areas, whether the fonts are there, the download (`job`) |
| `POST /api/maps/estimate` `{"bbox", "maxzoom"}` | tiles and bytes of an area, from the planet's directories (`422` past 1 000 000 tiles) |
| `POST /api/maps/download` `{"name", "bbox", "maxzoom"}` | start the download (`202`; `409` while one runs); `GET` its progress, `DELETE` cancels it |
| `DELETE /api/maps/areas` `{"id"}` | delete an area: its file and its entry |
| `GET /api/maps/areas/<id>.pmtiles` | the file, with Range |
| `GET /api/maps/fonts/<fontstack>/<range>.pbf` | a glyph range of a downloaded font stack |
| `GET /api/live` | the page's WebSocket (live values). The page sends `{"op": "watch", "broker", "tenant", "types"}` (`tenant` optional, `""` the default one) or `{"op": "unwatch"}`; the backend sends `hello` (the session), `status` (`mode` `ws`, `http` or `off`, `subscription`, `types`, `why` not the WebSocket, `detail` of a failure), `notify` (`{"broker", "message"}` - the broker's WebSocket message as it came, or `{"body": ...}` for an HTTP notification: `message.body` is the Notification) and `lost` (the broker closed its WebSocket). The `Origin`, when sent, must be this machine. |
| `GET /api/brokers/tokens` | which brokers have an access token of their own, and c³'s default: `{"brokers": {"<url>": {"source", "tail", "length"}}, "default": {...} or null, "tokenFile"}` - `source` is `typed`, `remembered`, `file` or `env`; never the token |
| `PUT /api/brokers/token` | `{"url", "token", "remember"}`: the broker's token (`Bearer ` in front is taken off); RFC 6750's characters only, 16 KB at most |
| `DELETE /api/brokers/token` | `{"url"}`: the broker's token forgotten, in memory and in `secrets.json` |
| `GET /api/brokers/headers` | each broker's own headers: `{"brokers": {"<url>": {"remembered", "headers": [{"name", "secret", "value"}]}}}` - a secret one has `tail` and `length` instead of `value` |
| `PUT /api/brokers/headers` | `{"url", "headers": [{"name", "value", "secret"}], "remember"}`: the broker's headers, all of them, in their order - a secret header without `value` keeps the one it has; an empty list forgets them; `remember` false or left out keeps them in memory only (and out of `secrets.json`). Answers as the GET; a refused name, a bad value or a name given twice is a `400` and nothing changes |
| `DELETE /api/brokers/headers` | `{"url"}`: the broker's headers forgotten, in memory and in `secrets.json` |
| `POST /api/notify/<session>` | a broker's notification for a session's HTTP subscription: to the page (`204`); an unknown session is a `404` |
| `GET /api/proxy/<path>?<query>` | the same GET to the broker named in the `X-C3-Broker` header - the NGSI-LD API (`/ngsi-ld/...`), `/version`, `/build`, coraine's `/admin/tenants`, `/admin/log`, `/admin/config`, `/admin/metrics` and `/admin/bridges/<bridge>/inventory`, and `/.well-known/oauth-protected-resource` (RFC 9728) only, with the page's `NGSILD-Tenant`, the broker's own headers and its access token (`Authorization: Bearer`, unless an own header is the `Authorization`). Answers the broker's status, body, `Content-Type`, `NGSILD-Results-Count` and every `Link` header joined into one; a broker not reached is a 502 with `"broker": false`. |
| `POST`, `PATCH`, `PUT`, `DELETE /api/proxy/<path>` | the same write to the broker - the entities (`/ngsi-ld/v1/entities`, `/ngsi-ld/v1/entities/...`) and `PUT /admin/log` only, with the body and its `Content-Type` (`application/json` when none), the tenant and the token as for a GET; the broker's `Location` comes back too. Only from c³'s own page: a write without an `Origin` of this machine is a 403 - a browser always sends one on a write, and another site's page can neither set it nor send `X-C3-Broker` without a preflight c³ never answers. |

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
| `css/run.css`, `js/run.js` | the Operate page (`#run`) |
| `js/metrics.js` | Operate's Metrics: `/admin/metrics` parsed, sampled and drawn |
| `js/main.js` | the splash screen, then the pages (`#compile`, `#run`, `#connect`; the last one shown is `ui.lastPage`) |
| `js/api.js` | the backend's API |
| `js/ngsild.js` | discovery, the paged load (all, or the types picked), linked entities, Relationships, values as text |
| `js/layout.js` | the layout |
| `js/graph.js` | boxes, arrows, zoom, pan, drag, selection, filters, a box expanded in place |
| `js/menu.js` | the context menu, mouse and keyboard |
| `js/connect.js` | the Explore page (`#connect`): discovery panel, picks, an entity's menu, neighbourhood, linked entities, graph or map, colour by, named demos |
| `js/map.js` | the map: GeoProperties as markers, lines and areas, Relationships with arrowheads (all, or the selected entity's), selection, click and menu, the changed entities ringed, movers gliding, alarms ringed |
| `js/icons.js` | the icons per type, the state colours, drawn on a canvas |
| `js/alerts.js` | alert rules and alarms: the toasts, the list, `q` evaluated for clearing, the rules kept per broker |
| `js/history.js` | the attribute panel's History: the temporal API, sparklines, the live values appended |
| `js/live.js` | live values: the backend's WebSocket, watch/unwatch, the notifications gathered into batches (250 ms), the alert rules and their notifications, reconnecting |
| `js/basemap.js` | the base map: c³'s dark style for OpenFreeMap's tiles, the downloaded areas' Protomaps layers, the tile and glyph protocols |
| `js/offline.js` | "Download this area": the estimate, the download's progress, the list of areas |

Fonts: Outfit, Source Sans 3 and JetBrains Mono are in `www/fonts/` (SIL Open Font License, the
licences beside them); the coraine mark and the Seamware logo in `www/img/`.

## Layout

```
src/               the backend (C)
www/               the pages, served by the backend
www/vendor/        MapLibre GL JS, pmtiles, @protomaps/basemaps - as published, with their licences
www/data/          data the pages read: the trace levels of the cor stack, the CKAN example's portal
examples/          factory.sh - sample entities for Explore; live.sh - its robots at work (live values);
                   ckan-bikes.sh - real open data from a CKAN portal
tools/             traceLevels.py - www/data/traceLevels.json; ckan-ingest.py - a CKAN resource into a broker
doc/design.md      what c³ is and how it is built
doc/areas.md       the parts of the work and the milestones
doc/compile.md     Compile: what it needs from coraine-build and corHttp
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
