# Installing c³

c³ runs on your machine - **macOS** (Apple silicon) or **Linux** - and opens in a browser window. The
**broker it works with can run anywhere**: on the same machine in Docker, on a server, in the cloud. c³
only needs to reach the broker's URL; its backend makes the requests, so the broker needs no CORS setup.

1. [c³ on macOS](#c-on-macos) - Homebrew
2. [c³ on Linux](#c-on-linux) - from the sources
3. [A broker, in Docker](#a-broker-in-docker) - one command, on the Mac or anywhere else
4. [AI Assist](#ai-assist) - Claude Code on your own login
5. [What runs where](#what-runs-where)

## c³ on macOS

c³ is installed with [Homebrew](https://brew.sh), the package manager most Mac developers use. It is not
part of macOS: `brew --version` in the Terminal (Applications → Utilities → Terminal) says whether you have it.

**Homebrew, once** - when `brew --version` says *command not found*:

```sh
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

It asks for your Mac password (it installs into `/opt/homebrew`), installs Apple's Command Line Tools - the
compiler and git, which c³'s build needs too - and takes a few minutes. At the end it prints, under *Next
steps*, the commands that put `brew` in your `PATH`; run the ones it prints. For zsh, the Mac's own shell,
they are:

```sh
echo >> ~/.zprofile
echo 'eval "$(/opt/homebrew/bin/brew shellenv zsh)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv zsh)"
```

Then `brew --version` answers. Homebrew also has a `.pkg` installer, for those who prefer one:
[github.com/Homebrew/brew/releases](https://github.com/Homebrew/brew/releases/latest).

**c³** - Homebrew builds it on your Mac from the sources - c³, corMcp and the cor-libs they use, about half a
minute - so macOS needs no signed download:

```sh
brew tap seamware/c3 https://github.com/SEAMWARE/c3
brew install seamware/c3/c3
c3
```

That is the release (0.8.0); `brew install --HEAD seamware/c3/c3` builds c³'s main instead, with the cor-libs' main.

`c3` opens c³ in Google Chrome when it is installed (a window of its own), else in your default browser;
`Ctrl-C` in the terminal stops it. `c3 -u` lists its options, `c3 --version` names the version.

Newer c³: `brew update && brew upgrade seamware/c3/c3` (a `--HEAD` installation: `brew upgrade --fetch-HEAD seamware/c3/c3`). Removed: `brew uninstall c3`; its configuration stays in
`~/.config/c3/c3.json`.

## c³ on Linux

Needs `gcc`, `make`, OpenSSL and zlib (Debian / Ubuntu: `apt install build-essential libssl-dev zlib1g-dev`)
and a browser. c³ builds against the cor-libs, checked out beside it:

```sh
mkdir seamware && cd seamware
for r in corBase corLog corAlloc corArgs corTree corJson corHttp corRest corMcp; do
  git clone https://github.com/SEAMWARE-cor/$r
done
git clone https://github.com/SEAMWARE/c3
for r in corBase corLog corAlloc corArgs corTree corJson corHttp corRest; do make -C $r; done
make -C corMcp && sudo make -C corMcp install       # AI Assist's tool server
cd c3 && make && sudo make install                  # c3 in /usr/local/bin, and in the desktop's menu
c3
```

That is main. The release instead: `git clone -b v0.8.0` for c3 and the eight cor-libs (corMcp has no release
tags - `git -C corMcp checkout 4d3df05d5ddb`, the commit c³ 0.8.0 was tested with).

With Qt 6 WebEngine installed (`qt6-webengine-dev`), `make` also builds `c3-window`, c³'s own window; without
it, c³ opens in Chrome or the default browser. [README.md](README.md#try-it) has the rest: example data, the
install targets, Compile's needs.

## A broker, in Docker

Needs Docker. On a Mac that is [Docker Desktop](https://www.docker.com/products/docker-desktop/) (not part
of macOS either): download it for Apple silicon, drag it to Applications, start it once and accept its
terms - the whale in the menu bar says when it is running. (`brew install --cask docker-desktop` installs the
same.) The images are coraine's published ones (`quay.io/seamware/coraine`, amd64 and arm64).

The compose file, then the broker:

```sh
mkdir -p ~/coraine && cd ~/coraine
curl -fsSLO https://raw.githubusercontent.com/SEAMWARE/c3/main/docker/compose.yml
docker compose -f compose.yml up -d
```

(In a clone of c³ the files are in `docker/`: `docker compose -f docker/compose.yml up -d`.)

That is the broker on **http://localhost:1026** (the first start downloads the image, a minute or two): coraine on corDB, which keeps the entities **and their
history** (temporal queries, AI Assist's test data with history) on a volume - one container, nothing else.
In c³'s **Connect**, enter `http://localhost:1026` and press Connect.

The same with MongoDB for the entities and TimescaleDB for their history - three containers:

```sh
curl -fsSLO https://raw.githubusercontent.com/SEAMWARE/c3/main/docker/compose-mongo.yml
docker compose -f compose-mongo.yml up -d
```

Either way (with `compose-mongo.yml` for the second):

| | |
|---|---|
| Stop | `docker compose -f compose.yml down` - the data stays; `down -v` deletes it too |
| Another port | `CORAINE_PORT=1030 docker compose -f compose.yml up -d` |
| Another broker version | `CORAINE_TAG=<tag> ...` - the tags at [quay.io/seamware/coraine](https://quay.io/repository/seamware/coraine?tab=tags) |
| Its log | `docker compose -f compose.yml logs -f coraine` |

**On another machine**: the same command there, and in c³ that machine's address -
`http://<host>:1026`. The port has to be reachable from the machine c³ runs on (a firewall, a security group);
for a broker on the internet, put it behind HTTPS and an access token
([coraine's installation guide](https://github.com/SEAMWARE/coraine/blob/main/doc/installation.md)).

A broker without Docker: `apt install coraine` from [seamware.github.io/apt](https://seamware.github.io/apt)
(Debian / Ubuntu) - [coraine's installation guide](https://github.com/SEAMWARE/coraine/blob/main/doc/installation.md).

## AI Assist

AI Assist runs [Claude Code](https://claude.com/claude-code) on **your own Claude login** (your
subscription or your company's seat), with corMcp - installed with c³ - as its tool server.

1. Install Claude Code and log in: `claude` once in a terminal.
2. Its instructions and knowledge: a clone of `SEAMWARE-cor/coraine-assistant` (a private repository - ask
   Seamware for access) in `~/git/coraine-assistant`, or anywhere with `C3_ASSIST_DIR=<the clone>`:
   `git clone https://github.com/SEAMWARE-cor/coraine-assistant ~/git/coraine-assistant`
3. Start c³ with AI Assist on: `C3_DEV=1 c3`. The **AI** button, top right, opens it.

Every change the assistant proposes to the broker (an entity, a subscription, test data) is shown to you
first and runs only when you say yes; each can be undone.

## What runs where

| | macOS | Linux |
|---|---|---|
| Explore, the map, live values, Connect to any broker | ✓ | ✓ |
| AI Assist | ✓ ¹ | ✓ |
| Documentation | ✓ | ✓ |
| A broker in Docker (above) | ✓ | ✓ |
| Compile - building a broker (`coraine-build`) | - | ✓ |
| Operate - brokers started natively | - | ✓ |
| Dashboard - WireCloud in containers | not tried yet | ✓ |
| c³'s own window (`c3-window`) | - (Chrome or the browser) | ✓ |

¹ Built, and its tool server tested, on macOS; not yet run end to end on a Mac.

On macOS, c³ is built and tested on every change by the [macOS workflow](.github/workflows/macos.yml) (Apple
silicon): the cor-libs' own tests, c³'s tests, corMcp, and the Homebrew formula installed and tested.
