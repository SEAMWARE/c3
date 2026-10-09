# c³ - the coraine Control Center

One application for everything around a [coraine](https://github.com/SEAMWARE/coraine) broker: build
it, configure its bridges, watch it live, and learn it - including how to write a plugin for it.

| Part | What it does |
|---|---|
| **Compile** | Build a broker for a deployment: the features compiled in or out, profile training (PGO) and tuning on a workload, the target hardware - the result as a binary, a container image or a Debian package. Drives `coraine-build` from the `coraine-dev` package. |
| **Configure** | The mapping tools: DDS topics, services and actions to NGSI-LD entities and attributes (the file the DDS bridge reads), the same for OPC UA, and the column mapping for the CKAN and CSV bridges. |
| **Operate** | The brokers themselves, several at once: live logs, log and trace levels changed on a running broker, metrics as charts, health. |
| **Docs** | All of coraine's documentation in one place, much easier to read than Markdown on GitHub: the broker (everything on Read the Docs), every cor-lib, the plugin and bridge contracts, searchable, offline. And help to write a new plugin: a skeleton repository - makefile, template `.c`/`.h` files, a functest - for each kind of plugin. |
| **Connect** | A live connection to a running broker: entities as boxes, Relationships as arrows, zoom, pan, entities dragged into place; the entities with a GeoProperty on a map; values as they change. |

Status: **design**. No code yet - [doc/design.md](doc/design.md) is the plan, [design/](design/)
holds the screen designs.

## Layout

```
doc/design.md      what c³ is and how it is built
doc/areas.md       the parts of the work, each one can be taken on its own
design/            screen designs (Splash, Compile, Configure, Connect)
```

## Licence

Apache License 2.0 - see [LICENSE](LICENSE).
