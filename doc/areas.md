# The parts of the work

## Milestones

Something running first, then grow it.

1. **Shell + Connect, read-only** - `c3` starts the backend and opens the window; the config file
   holds the brokers connected to. Connect: a broker URL, its entities by ordinary queries
   (`GET /entities`, paged), boxes and Relationship arrows in an automatic layout, zoom, pan, drag,
   an entity's attributes on a click. No WebSocket, no map, no saved views, no live values yet.
1b. **Connect - discovery and choosing** - the broker's types and attributes (`/types`,
   `/attributes`), the entity view loading only the types picked, and a right-click menu on an
   entity: with its linked entities embedded (`join=inline`, `joinLevel`), its neighbourhood, follow a
   Relationship, hide a type, copy the id, the JSON.
1c. **Connect - the map** - Graph / Map switch; GeoProperty entities as points, lines, areas; the
   Relationships as arrows; MapLibre + OpenStreetMap (OpenFreeMap online); "Download this area" to a
   `.pmtiles` file, offline and faster.
2. **Compile** - the hardest part: the feature switches from `coraine-build --list-features`, the
   optimisation choice, the build run and its output, the result.
2b. **Run** - start and stop brokers (the one just built, the installed one, or an image) natively or
   in a container, and the services they need (MongoDB, PostgreSQL/TimescaleDB, Mosquitto) as
   containers; status from the health port; a started broker joins Connect's list.
2c. **Changing data** - create/edit/delete entities, attributes, registrations, subscriptions from
   Connect - after authorisation in the broker (or the APISIX plugin): sign-in, the user's token on
   every request, actions the policy forbids greyed with the reason.
3. Then, in no fixed order: live values over the WebSocket transport, saved views,
   Configure (DDS first), Docs (the bridge skeleton first), Operate.

c³ is built by several people; each part below can be taken on its own. The seams between them are
the backend's API (served to the pages) and the files c³ writes for the broker and its bridges.

## Shell

The `c3` command, the backend's HTTP server and the static pages, the splash screen, navigation, the
look (dark only - the coraine mark is made for a dark background), and the configuration file
(`~/.config/c3/c3.json`: brokers, compile choices, mappings, saved views - saved on every change).
Everything else plugs into it.

## Compile

- The feature switches, read from `coraine-build --list-features` - never a copy of the list.
- The optimisation choice: release, profile-guided, tuned on a workload (`--tune`).
- Target architecture, distribution and output (binary, image, Debian package) - not in
  `coraine-build` yet; added there first, then shown here.
- The build itself: run `coraine-build`, stream its output, keep the result for download.

## Configure - industry

- **DDS / ROS 2** - the inventory from a broker running the dds bridge (every topic, service and
  action with its type), three sections with one line each (entity id, entity type, attribute
  name, or skip), and the output: the bridge configuration plus the user @context for
  `--defaultUserContext`. Needs in coraine: type name and fields in the discovery report, the
  inventory kept per bridge and served (`/admin/bridges/{bridge}/discovered`, and live).
- **One mapping tool, an adapter per protocol** - inventory, lines (entity id / type / attribute),
  Smart Data Models, @context and round-trip merge written once.
- **OPC UA** - the address space (objects as entities, variables as attributes with their
  sampling, methods as commands, events), from a running server through the bridge or from a
  NodeSet2 file; companion specifications as entity types.
- **Modbus**, **MQTT** - the same for the other bridges.

## Configure - data

- **CKAN** - pick a dataset from a portal, preview its rows, map columns to attributes (id, a place
  as `location`, a column naming another row as a Relationship), choose the mode (once, poll, push).
- **CSV** - the same for a file.

## Docs

- Bring every Markdown source together - coraine's `doc/` and Read the Docs, each cor-lib's README
  and `doc/` - rendered in c³'s look, with search and navigation, offline from `coraine-dev`.
- An API reference per lib, generated from its headers.
- The plugin skeletons: one repository per kind (current-state store, temporal store, API,
  transport, bridge) - makefile, template `.c`/`.h`, a functest, CI - and `c3 new plugin`.

## Connect

- The connection: the broker's WebSocket transport - the initial state by queries, then one
  subscription; headers in each message's metadata.
- The graph: entities as boxes, Relationships as arrows; zoom, pan, drag; type filters; an entity's
  attributes, Relationships followed by a click. An automatic layout that gives the same picture
  for the same graph; **Save view** to keep a named selection with its positions.
- The map: GeoProperty entities on a map, the same arrows between them.
- Authorisation on the socket - settled together with the broker's authorisation.

## Run

- Brokers started and stopped natively (a process of the backend, its log in a file) or in a
  container (`docker`/`podman`), with their options from a form.
- MongoDB, PostgreSQL/TimescaleDB and Mosquitto as containers; ready-made sets per kind of
  deployment; started before the broker, stopped when nothing uses them.
- Kept in the configuration file, so they can be started again.

## Operate

- Several brokers at once: their live logs (level and text filters), the log and trace levels
  (`/admin/log`), metrics as charts (`/admin/metrics`), health (`--healthPort`).
- In coraine and corLog: a log callback in corLog, a ring buffer and a log subscription in coraine,
  carried on the WebSocket transport.

## Smart Data Models

- The catalogue kept locally (subjects, models, schemas, @contexts), refreshed on demand.
- Suggestions in Configure (models that fit an entity type), the model's IRIs in the output @context.
- Checking entities against a model's schema in Connect (warnings), the models a broker's types follow.
- The catalogue browsable in Docs.
