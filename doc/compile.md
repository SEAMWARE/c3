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
  --list-features`; dependencies shown (SNAPSHOT_SUBSCRIPTIONS needs SUBSCRIPTIONS and
  SNAPSHOT_WRITE); presets from the configuration file ("edge node", "full").
- **Optimisation** - release, profile-guided, tuned (with a workload file chosen or recorded).
- **Stores** - MONGOC on or off (corDB is always built); temporal plugins are always built.
- **Build** - the command shown before it runs; the build's output streamed as it happens; a
  progress line per phase (unpack, libraries, broker, training, profile-use, plugins, install);
  Cancel.
- **The result** - size on disk, the feature set and flags it was built with (`GET /version` and
  `/build` of the built broker), "Run it" (Run, milestone 2b), and the directory.
- **Builds kept** - the list of earlier builds with their options, size and date; delete one.

## What has to exist first

1. **`coraine-build --list-features --json`** (coraine) - today the list is text formatted for a
   terminal. c³ needs `[{ "name", "default", "description", "requires": [...] }]`, generated from
   `CMakeLists.txt` the same way the text is, so the two cannot disagree.
2. **Phase markers in `coraine-build`'s output** (coraine) - one line per phase
   (`coraine-build: phase <name>`), so c³ can show progress without parsing make's output.
3. **A streaming response in corHttp** (corHttp) - a response is one buffer in memory today. The
   build's output needs to reach the page as it is produced: chunked transfer encoding, or
   server-sent events, or a WebSocket. A WebSocket needs the framing as a reusable library (the one
   in coraine's `ws.so` is inside the plugin). The smallest step: chunked responses in corHttp.
4. **A file-streaming response in corHttp** - downloading a built image or package without
   reading it into memory first.
5. **Process control in c³'s backend** - start `coraine-build` as a child process, its output to a
   file and to the stream, Cancel (SIGTERM to the process group), one build at a time, the exit
   status kept with the build.

Later, in `coraine-build` itself: the target architecture (cross-compiling for arm64), the
distribution, and the output kind (a container image, a Debian package) - shown greyed in c³ until
then.

## Where the builds live

`~/.local/share/c3/builds/<name>/` (`$XDG_DATA_HOME`): one directory per build, `coraine-build`'s
`<dir>`, with a `c3-build.json` beside it - the options, the start and end time, the exit status, the
log file. The configuration file lists them by name.
