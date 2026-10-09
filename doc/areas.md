# The parts of the work

c³ is built by several people; each part below can be taken on its own. The seams between them are
the backend's API (served to the pages) and the files c³ writes for the broker and its bridges.

## Shell

The `c3` command, the backend's HTTP server and the static pages, the splash screen, navigation, the
look (dark only - the coraine mark is made for a dark background). Everything else plugs into it.

## Compile

- The feature switches, read from `coraine-build --list-features` - never a copy of the list.
- The optimisation choice: release, profile-guided, tuned on a workload (`--tune`).
- Target architecture, distribution and output (binary, image, Debian package) - not in
  `coraine-build` yet; added there first, then shown here.
- The build itself: run `coraine-build`, stream its output, keep the result for download.

## Configure - industry

- **DDS / ROS 2** - discover topics, services and actions; map message fields to entities and
  attributes; write the mapping file the DDS bridge reads.
- **OPC UA** - browse a server's address space; map variables, monitored items and methods.
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
  attributes, Relationships followed by a click.
- The map: GeoProperty entities on a map, the same arrows between them.
- Authorisation on the socket - settled together with the broker's authorisation.
