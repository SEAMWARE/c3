# Compile - milestone 2

What Compile does, what it drives, and what has to exist in coraine and the libraries first.

## What it drives

Compile is a front-end to `coraine-build`, the script in the `coraine-dev` package
(`/usr/bin/coraine-build`, source in coraine's `packaging/deb/coraine-build`). c³ builds nothing
itself: every build is `coraine-build`, run by the backend, so a build made in c³ and one made on the
command line are the same build.

`coraine-build [options] <dir>` today:

| Option | |
|---|---|
| `--release` (default) | optimised, traces compiled out |
| `--debug` | traces compiled in (`--traceLevels` works) |
| `--pgo` | profile-guided: built instrumented, trained on the measured request shapes, rebuilt |
| `--tune <workload>` | `--pgo` trained on the user's workload, the knobs measured on it (`<dir>/install/etc/tune.env`) |
| `--features NAME=ON\|OFF,...` | the feature switches (`COR_FEATURE_*` without the prefix) |
| `--list-features` | every switch, its default and what it is |
| `--source <file>` | another source tarball |

The result is `<dir>/install`: `bin/coraine`, `bin/coraine-import`, `plugins/`, `etc/`, `env`.

## The screen

As in the design (`design/Main.dc.html`):

- **Features** - every switch with its default and description, from `coraine-build
  --list-features`, in the groups `CMakeLists.txt` puts them in (NGSI-LD API, Snapshots, JSON-LD
  @context, Geo, Security, Beyond NGSI-LD, Operations, Stores and tools): a header per group, its
  switches shown when it is opened, "n of m on" and how many are changed on the header; Expand all /
  Collapse all; the open groups remembered in the browser. Dependencies shown on the switch ("Needs
  ADMIN_API"), and a switch whose dependency is off is off ("Off: needs ..."): a switch, or a build
  setting coraine-build always builds with (`HTTP_SERVER=mhd`, POLICY_API's). Presets from the
  configuration file ("edge node", "full").
- **Optimisation** - release, profile-guided, tuned (with a workload file chosen or recorded).
- **HTTP server** - libmicrohttpd (coraine-build's default) or corHttp, the built-in server
  (`--http-server builtin`). Choosing corHttp when a switch that needs libmicrohttpd is on asks first: a
  dialog lists what is not built with it (POLICY_API - its port is a second listener) and why; Escape or
  "Keep libmicrohttpd" leaves the choice as it was. With corHttp those switches are greyed out, their
  tooltip saying why and how to have them back; Profile-guided and Tuned are greyed out too (coraine-build
  trains with libmicrohttpd only), and corHttp while one of them is chosen.
- **Stores** - MONGOC on or off (corDB is always built); temporal plugins are always built.
- **Build** - the command shown before it runs; the build's output streamed as it happens; a
  progress line per phase (unpack, libraries, broker, training, profile-use, plugins, install);
  Cancel.
- **The result** - size on disk, the feature set and flags it was built with (`GET /version` and
  `/build` of the built broker), "Run it" (Run, milestone 2b), and the directory.
- **Builds kept** - the list of earlier builds with their options, size and date; delete one.

## What it rests on

1. **`coraine-build --list-features --json`** (coraine #316; "group" and `NAME=value` requirements:
   coraine `feat/feature-groups`) - `[{ "name", "default", "description", "group", "requires": [...] }]`,
   generated from `CMakeLists.txt` the same way the text is. A source without groups puts every switch
   in "Other".
2. **Phase markers in `coraine-build`'s output** (coraine #316) - `coraine-build: phase <name>`: `build`,
   `tools` and `train` (`--pgo`, `--tune`), `install`, `bridges`, `check`, `done`.
3. **A streamed response in corHttp** ([corHttp#13](https://github.com/SEAMWARE/corHttp/pull/13)) -
   `corHttpResponseStream`: a chunked body written from any thread. The build's output reaches the page
   as server-sent events over it (`EventSource`: no library, reconnects by itself, `Last-Event-ID` to go
   on from where it was).
4. **A file response in corHttp** (the same PR) - `corHttpResponseFile`: bytes of a file sent with
   `sendfile`, never read into memory; c³'s files and the map areas' Range answers use it.
5. **Process control in c³'s backend** (`src/compile.c`) - `coraine-build` as a child in a process group of
   its own, its output to a file and to the stream, Cancel (SIGTERM to the process group, SIGKILL 5 s
   later), one build at a time, the exit status kept with the build.

Later, in `coraine-build` itself: the target architecture (cross-compiling for arm64), the
distribution, the HTTP server, and the output kind (a container image, a Debian package) - shown greyed
in c³ until then.

## Where the builds live

`~/.local/share/c3/builds/` (`$XDG_DATA_HOME`): `<name>/` is `coraine-build`'s `<dir>`; beside it
`<name>.json` - the build's record (c3-build.json): the options, the command, the start and end, the
phases, the exit status, the size of `install/`, the built broker's `--version` - and `<name>.log`.
Beside and not inside: `coraine-build` takes only a new or empty directory, or one it unpacked into.
The directory is the truth: the configuration file keeps the current choice and the presets, not the
list of builds. The API and the details: the README's Compile section.
