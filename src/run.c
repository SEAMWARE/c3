//
// FILE            run.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Run - brokers started and stopped on this machine, natively or in a container, and the services they use
// (MongoDB, PostgreSQL with TimescaleDB, Mosquitto) as containers
//
//   GET    /api/run                             the brokers kept, the services, the sets, what each source has
//   GET    /api/run/images                      the coraine images: local ones and the published tags (quay.io)
//   POST   /api/run/command                     {broker}: the command it would run and the services it needs
//   POST   /api/run/brokers                     {broker}: kept (c3.json, "run") and started - 202
//   POST   /api/run/brokers/<name>/start        start one kept
//   POST   /api/run/brokers/<name>/stop         SIGTERM, SIGKILL after its grace period; then its services, if
//                                               nothing else uses them
//   DELETE /api/run/brokers/<name>[?data=true]  forget a stopped one (and delete its data)
//   GET    /api/run/brokers/<name>/log          Accept: text/event-stream - its log, live; else the file
//   GET    /api/run/services/<container>/log    the same for a service
//   POST   /api/run/services/<container>/stop   a service nothing uses
//   DELETE /api/run/volumes/<volume>            a service's or a container broker's data, deleted
//   POST   /api/run/dds/discover                {broker}: what its DDS domain announces - a broker of its own
//                                               for it, natively or in a container, started and stopped
//                                               again (ddsDiscoverThread)
//   GET    /api/run/dds/files                   the DDS configuration the mapper wrote: its files and mapping
//   POST   /api/run/dds/files                   {domain, transport, interfaces, vocabulary, topics, services, actions}: written (ddsFiles)
//   POST   /api/run/opcua/discover              {broker, its opcua server}: the server's address space - a broker of
//                                               its own (opcuaDiscoverThread)
//   GET    /api/run/opcua/files                 the OPC UA configuration the mapper wrote: its files and mapping
//   POST   /api/run/opcua/files                 {url, security, user, vocabulary, channels, models, terms}: written (opcuaFiles)
//
// Where it lives: $XDG_DATA_HOME/c3/run (else ~/.local/share/c3/run) -
//
//   <name>/broker.log     the broker's output (and c3's lines about it: "c3: ..."); broker.log.1 the run before
//   <name>/state.json     a native broker that runs: its pid and the process's start time - c3 attaches to it
//                         again after a restart when that process still runs
//   <name>/data/          corDB's --dbDir (a native broker)
//   <name>/bridges.json   the bridge configuration c3 writes: the MQTT set's, DDS's defaults, the CKAN datasets
//   <name>/dds-types/     the DDS types the dds bridge discovered (a native broker)
//   services/<container>.log
//
// A native broker is started in a session of its own (setsid), its stdout and stderr appended to its log
// file directly: it does not need c3 to run, and c3 stopping does not stop it. c3 reaps the brokers it
// started and watches the ones it attached to by their pid and start time.
//
// Containers go through the docker command (or podman's, the same commands). Everything c3 creates is
// labelled c3=run and named c3-...: a broker c3-broker-<name>, a service c3-<set>-<service>, their volumes
// the same, the network c3. Nothing else is touched. A container's log file is filled by `docker logs -f`,
// started by c3 (and again, from where the file ends, after a restart).
//
// One thread watches: every 0.5 s the processes, every 2 s the containers and each broker's health (the
// health port's /ready - its report - or else /version), and the logs pages follow. A start or a stop runs
// on a thread of its own. The state is under one mutex.
//
#define _GNU_SOURCE                              // pipe2

#include <arpa/inet.h>                           // htons, inet_pton
#include <dirent.h>                              // opendir
#include <errno.h>                               // errno
#include <fcntl.h>                               // open, O_*
#include <netinet/in.h>                          // sockaddr_in
#include <pthread.h>                             // pthread_*
#include <signal.h>                              // kill, SIGTERM, SIGKILL
#include <stdarg.h>                              // va_list
#include <stdio.h>                               // snprintf
#include <stdlib.h>                              // malloc, free, atoi
#include <string.h>                              // strcmp, strncmp, strlen
#include <sys/socket.h>                          // socket, connect
#include <sys/stat.h>                            // stat
#include <sys/wait.h>                            // waitpid
#include <time.h>                                // time
#include <unistd.h>                              // close, write, usleep

#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup
#include "corAlloc/corAllocBufferInit.h"         // corAllocBufferInit
#include "corAlloc/corAllocBufferReset.h"        // corAllocBufferReset
#include "corJson/CorJson.h"                     // CorJson
#include "corJson/corJsonCreate.h"               // corJsonCreate
#include "corJson/corJsonParse.h"                // corJsonParse
#include "corJson/corJsonRender.h"               // corJsonRender
#include "corJson/corJsonRenderSize.h"           // corJsonRenderSize
#include "corTree/CorNode.h"                     // CorNode
#include "corTree/corTreeLookup.h"               // corTreeLookup
#include "corTree/corTreeChildMove.h"            // corTreeChildMove
#include "corRest/corRestClient.h"               // corRestClientMulti*

#include "c3.h"

extern char** environ;



// -----------------------------------------------------------------------------
//
// Limits and defaults
//
#define BROKERS_MAX      32
#define SERVICES_MAX     24
#define GRACE_DEFAULT    30                      // seconds from SIGTERM to SIGKILL - corDB writes its snapshots in it
#define READY_WAIT_S     180                     // a service that is not ready by then is a failure
#define TICK_MS          500
#define PUBLISHED_REPO   "quay.io/seamware/coraine"



// -----------------------------------------------------------------------------
//
// ServiceKind - what a broker may need, as a container
//
// The host port is the service's own + 10000 (the next free one when that is taken), on 127.0.0.1 only: a
// service started here must not collide with one the user runs on the usual port. mongo 8.0 does not start
// on Linux 6.19 and newer (SERVER-121912): 8.2.
//
typedef struct ServiceKind
{
  const char*  id;
  const char*  label;
  const char*  image;
  int          port;                             // in the container
  int          hostPort;                         // preferred, on 127.0.0.1
  const char*  volumePath;
  const char*  env;                              // -e, or NULL
  const char*  cmd[4];                           // the command, or none (the image's)
} ServiceKind;

static const ServiceKind kinds[] =
{
  { "mongo",     "MongoDB",                  "mongo:8.2",                     27017, 37017, "/data/db",              NULL,                              { NULL } },
  { "timescale", "PostgreSQL + TimescaleDB", "timescale/timescaledb-ha:pg16", 5432,  15432, "/home/postgres/pgdata", "POSTGRES_HOST_AUTH_METHOD=trust", { NULL } },
  { "mosquitto", "Mosquitto",                "eclipse-mosquitto:2",           1883,  11883, "/mosquitto/data",       NULL,                              { "mosquitto", "-c", "/mosquitto-no-auth.conf", NULL } },
};

#define KIND_MONGO      0
#define KIND_TIMESCALE  1
#define KIND_MOSQUITTO  2
#define KINDS           3



// -----------------------------------------------------------------------------
//
// SetDef - a ready-made set: the options it starts a broker with, the services they need. The services of a
// set are its own containers (c3-<set>-<service>), shared by the brokers of the set.
//
typedef struct SetDef
{
  const char*  id;
  const char*  label;
  const char*  description;
  const char*  store;
  bool         dbDir;
  const char*  history;
  const char*  bridges;
} SetDef;

static const SetDef sets[] =
{
  { "cordb",            "corDB alone",        "No services: corDB holds the entities and their history, on disk in c3's data directory.",          "corDB",  true,  "corDB",     ""     },
  { "mongoc-timescale", "mongoc + timescale", "MongoDB for the entities, PostgreSQL with TimescaleDB for the history - each in a container.",   "mongoc", false, "timescale", ""     },
  { "mqtt",             "with MQTT",          "corDB, and the MQTT bridge connected to a Mosquitto in a container.",                               "corDB",  true,  "corDB",     "mqtt" },
};

#define SETS  ((int) (sizeof(sets) / sizeof(sets[0])))

static const SetDef* setFind(const char* id)
{
  for (int ix = 0; ix < SETS; ix++)
  {
    if (strcmp(sets[ix].id, id) == 0)
      return &sets[ix];
  }
  return NULL;
}



// -----------------------------------------------------------------------------
//
// Def - a broker as the user chose it: kept in c3.json ("run": {"brokers": [...]})
//
typedef struct Def
{
  char  name[65];
  char  from[16];                                // installed, build, image
  char  build[65];                               // from a build: its name
  char  image[512];                              // from an image: repository:tag
  char  where[16];                               // native, container
  char  set[32];
  char  store[16];                               // corDB, mongoc
  bool  dbDir;                                   // corDB: kept on disk
  char  history[16];                             // none, corDB, timescale
  int   port;
  int   healthPort;                              // 0: none
  bool  ws;                                      // --transports ws
  bool  admin;                                   // --apiPlugins admin
  bool  distributed;                             // --distributed: forwards to the Context Sources registered
  char  bridges[128];                            // comma-separated
  char  bridgeConfig[1024];                      // a file; "": the one c3 writes for mqtt and ckan
  char  userContext[1024];                       // a file: --defaultUserContext (the DDS configuration's @context); "": none
  char  ckan[512];                               // CKAN datasets (ids in www/data/ckan.json), comma-separated
  struct                                         // the OPC UA bridge's server - the bridge configuration c3 writes
  {
    char  url[512];                              // opc.tcp://host:port; "": no OPC UA
    char  roots[2048];                           // the Objects whose models are AssetChannels - NodeIds, one a line
    char  channels[16384];                       // the Variables that are Channels - a line each: NodeId, entityId, entityType, attribute, tab-separated
    char  mode[16];                              // None, Sign, SignAndEncrypt; "": None
    char  policy[32];                            // Basic256Sha256 ...; "": the bridge's default
    char  certificate[1024];                     // the client's certificate, a file
    char  privateKey[1024];                      // its key, a file
    char  applicationUri[256];                   // the URI the certificate names
    char  trustList[4096];                       // the server certificates trusted - files, one a line
    bool  trustAny;
    char  username[128];                         // "": anonymous
    char  password[256];                         // WRITE-ONLY: as a request gave it, kept in <broker dir>/opcua.password (0600) and wiped
  } opcua;
  struct                                         // the dds bridge's mapping - the bridge configuration c3 writes
  {
    int   domain;                                // the DDS domain
    char  transport[8];                          // "": DDS's default (shared memory and UDP), "udp", "shm"
    char  interfaces[256];                       // the IPv4 addresses of this host's interfaces UDP uses, comma-separated; "": all
    char  vocabulary[512];                       // the namespace of the terms mapped: dds-context.jsonld, --defaultUserContext; "": none
    char  topics[16384];                         // a line each: topic, entityId, entityType, attribute - tab-separated
    char  services[8192];                        // a line each: service, entityId, entityType, attribute, requestType, replyType
    char  actions[8192];                         // a line each: action, entityId, entityType, attribute, type (the ROS 2 action type)
  } dds;
  bool  verbose;                                 // -v
  char  args[2048];                              // more options, as typed
  int   grace;
  char  lastStarted[32];
} Def;



// -----------------------------------------------------------------------------
//
// Broker - a broker kept, and what it is doing
//
typedef struct Broker
{
  Def        def;
  char       state[16];                          // stopped, starting, running, stopping, exited, failed
  char       why[512];                           // why it failed or ended
  pid_t      pid;                                // native: the broker, leader of its own session
  bool       child;                              // started by this c3 (reaped here); false: attached after a restart
  long long  procStart;
  char       container[96];                      // a container: c3-broker-<name>
  char       usedSvc[KINDS][96];                 // the service containers this run uses
  time_t     started;
  time_t     stopAsked;
  time_t     ended;
  int        grace;                              // of the stop that runs
  bool       killed;                             // the grace period ran out: SIGKILL
  int        exitStatus;                         // -1: not known
  int        termSignal;
  bool       busy;                               // a start or a stop runs
  char       ready[16];                          // ready, not ready, answers, no answer; "": not asked yet
  char*      report;                             // the health port's report, or /version (JSON)
  time_t     reportAt;
  char       logPath[2300];
  int64_t    logEnd;                             // the bytes of the log sent to the pages so far
  SseSubs    subs;
  time_t     lastBeat;
  pid_t      follower;                           // docker logs -f, for a container
} Broker;



// -----------------------------------------------------------------------------
//
// Service - a service container c3 knows of (it made it, or a broker kept needs it)
//
typedef struct Service
{
  char       container[96];
  char       set[32];
  int        kind;
  char       state[16];                          // running, exited, created, absent, starting, stopping
  char       status[128];                        // docker's words: "Up 5 minutes"
  int        hostPort;
  char       volume[96];
  bool       volumeExists;
  bool       busy;
  char       logPath[2300];
  int64_t    logEnd;
  SseSubs    subs;
  time_t     lastBeat;
  pid_t      follower;
} Service;



// -----------------------------------------------------------------------------
//
// The state
//
static pthread_mutex_t rMutex = PTHREAD_MUTEX_INITIALIZER;
static Broker*         brokers[BROKERS_MAX];
static int             nBrokers  = 0;
static Service         svcs[SERVICES_MAX];
static int             nSvcs     = 0;
static char            runDir[2048];
static char            svcDir[2100];
static char            engine[2048];             // docker or podman, its path; "": none
static char            engineName[16];
static char            engineVersion[64];
static char            engineWhy[256];
static bool            networkMade = false;
static volatile bool   stopping    = false;
static pthread_t       monitorTid;
static bool            monitorRuns = false;

static void* monitorThread(void* vP);



// -----------------------------------------------------------------------------
//
// lineSplit - text split at whitespace, single and double quotes kept together (no escapes): extra args
//
static int lineSplit(const char* text, char** out, int max)
{
  int n = 0;

  while ((*text != 0) && (n < max))
  {
    while ((*text == ' ') || (*text == '\t') || (*text == '\n'))
      ++text;
    if (*text == 0)
      break;

    Str s = { NULL, 0, 0 };
    strAdd(&s, "");
    while ((*text != 0) && (*text != ' ') && (*text != '\t') && (*text != '\n'))
    {
      if ((*text == '\'') || (*text == '"'))
      {
        char q = *text++;
        while ((*text != 0) && (*text != q))
          strAddN(&s, text++, 1);
        if (*text == q)
          ++text;
      }
      else
        strAddN(&s, text++, 1);
    }
    out[n++] = s.s;
  }

  return n;
}



// -----------------------------------------------------------------------------
//
// Argv - an argument vector being built (malloc'ed strings)
//
typedef struct Argv
{
  char*  v[160];
  int    n;
} Argv;

static void argAdd(Argv* aP, const char* s)
{
  if (aP->n < (int) (sizeof(aP->v) / sizeof(aP->v[0])) - 1)
  {
    aP->v[aP->n++] = strdup(s);
    aP->v[aP->n]   = NULL;
  }
}

static void argAddf(Argv* aP, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
static void argAddf(Argv* aP, const char* fmt, ...)
{
  char    buf[4096];
  va_list ap;

  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  argAdd(aP, buf);
}

static void argFree(Argv* aP)
{
  for (int ix = 0; ix < aP->n; ix++)
    free(aP->v[ix]);
  aP->n    = 0;
  aP->v[0] = NULL;
}

static void argCommand(Argv* aP, Str* sP)
{
  for (int ix = 0; ix < aP->n; ix++)
  {
    if (ix > 0)
      strAdd(sP, " ");
    shellQuote(sP, aP->v[ix]);
  }
}



// -----------------------------------------------------------------------------
//
// engineRun - the container engine with these arguments (NULL-terminated), its output into 'out'
//
static int engineRun(char* out, int outSize, int timeoutS, ...)
{
  Argv    a = { { NULL }, 0 };
  va_list ap;

  if (engine[0] == 0)
  {
    snprintf(out, outSize, "no docker or podman");
    return -1;
  }

  argAdd(&a, engine);
  va_start(ap, timeoutS);
  for (const char* s = va_arg(ap, const char*); s != NULL; s = va_arg(ap, const char*))
    argAdd(&a, s);
  va_end(ap);

  int status = runCapture(a.v, out, outSize, timeoutS);
  argFree(&a);

  int len = strlen(out);                         // one line answers: without the newline
  while ((len > 0) && ((out[len - 1] == '\n') || (out[len - 1] == '\r')))
    out[--len] = 0;

  return status;
}

static int engineArgv(Argv* aP, char* out, int outSize, int timeoutS)
{
  int status = runCapture(aP->v, out, outSize, timeoutS);
  int len    = strlen(out);

  while ((len > 0) && ((out[len - 1] == '\n') || (out[len - 1] == '\r')))
    out[--len] = 0;

  return status;
}



// -----------------------------------------------------------------------------
//
// engineFind - docker, else podman, in $PATH; its server answers (`version`)
//
static void engineFind(void)
{
  char path[2048];
  char out[512];

  engine[0]        = 0;
  engineName[0]    = 0;
  engineVersion[0] = 0;

  const char* names[] = { "docker", "podman" };
  for (int ix = 0; ix < 2; ix++)
  {
    if (inPath(names[ix], path, sizeof(path)))
    {
      snprintf(engine, sizeof(engine), "%s", path);
      snprintf(engineName, sizeof(engineName), "%s", names[ix]);
      break;
    }
  }

  if (engine[0] == 0)
  {
    snprintf(engineWhy, sizeof(engineWhy), "install docker (docker.io) or podman to run brokers and services in containers");
    return;
  }

  int status = engineRun(out, sizeof(out), 10, "version", "--format", "{{.Server.Version}}", NULL);
  if (status != 0)
  {
    snprintf(engineWhy, sizeof(engineWhy), "%s does not answer: %.300s", engineName, out);
    engine[0] = 0;
    return;
  }

  snprintf(engineVersion, sizeof(engineVersion), "%s", out);
  engineWhy[0] = 0;
}



// -----------------------------------------------------------------------------
//
// portAnswers - something accepts a TCP connection on 127.0.0.1:<port>
//
static bool portAnswers(int port)
{
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd == -1)
    return false;

  struct sockaddr_in sa;
  memset(&sa, 0, sizeof(sa));
  sa.sin_family      = AF_INET;
  sa.sin_port        = htons(port);
  sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

  bool yes = (connect(fd, (struct sockaddr*) &sa, sizeof(sa)) == 0);
  close(fd);
  return yes;
}

//
// portFree - nothing listens on the port and it can be bound (0.0.0.0 - the broker listens on every address)
//
static bool portFree(int port)
{
  if (portAnswers(port))
    return false;

  int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd == -1)
    return false;

  struct sockaddr_in sa;
  memset(&sa, 0, sizeof(sa));
  sa.sin_family      = AF_INET;
  sa.sin_port        = htons(port);
  sa.sin_addr.s_addr = htonl(INADDR_ANY);

  int on = 1;                                    // as a server binds: a port with connections in TIME_WAIT is free
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));

  bool yes = (bind(fd, (struct sockaddr*) &sa, sizeof(sa)) == 0);
  close(fd);
  return yes;
}



// -----------------------------------------------------------------------------
//
// nameOk - a broker's name: [A-Za-z0-9._-], 1 to 64, starting with a letter or a digit (as a build's)
//
static bool nameOk(const char* name)
{
  int len = strlen(name);

  if ((len < 1) || (len > 64))
    return false;

  for (int ix = 0; ix < len; ix++)
  {
    char c     = name[ix];
    bool alnum = ((c >= 'a') && (c <= 'z')) || ((c >= 'A') && (c <= 'Z')) || ((c >= '0') && (c <= '9'));

    if ((ix == 0) && !alnum)
      return false;
    if (!alnum && (c != '.') && (c != '_') && (c != '-'))
      return false;
  }

  return true;
}

//
// dbNameOf - the database a broker's mongoc and timescale use: its own, so brokers of one set do not share
// their data (c3_<name>, with . and - as _)
//
static void dbNameOf(const char* name, const char* suffix, char* out, int outLen)
{
  int o = snprintf(out, outLen, "c3_");

  for (const char* c = name; (*c != 0) && (o < outLen - 1); ++c)
    out[o++] = ((*c == '.') || (*c == '-')) ? '_' : *c;
  out[o] = 0;

  snprintf(&out[o], outLen - o, "%s", suffix);
}



// -----------------------------------------------------------------------------
//
// Sources - what a broker can be started from, and what each one has compiled in
//
// installed: `coraine` in $PATH (its --version cached by path and mtime); a build: its record (the built
// broker's --version) in Compile's directory. The features decide what the form offers.
//
static pthread_mutex_t srcMutex = PTHREAD_MUTEX_INITIALIZER;
static char            instPath[2048];
static time_t          instMtime;
static char            instVersion[4096];

static void installedFind(char* path, int pathLen, char* version, int versionLen)
{
  struct stat st;

  path[0]    = 0;
  version[0] = 0;

  if (inPath("coraine", path, pathLen) == false)
    return;

  if (stat(path, &st) != 0)
    return;

  pthread_mutex_lock(&srcMutex);
  if ((strcmp(instPath, path) == 0) && (instMtime == st.st_mtime))
  {
    snprintf(version, versionLen, "%s", instVersion);
    pthread_mutex_unlock(&srcMutex);
    return;
  }
  pthread_mutex_unlock(&srcMutex);

  char  out[4096];
  char* argv[] = { path, (char*) "--version", NULL };

  if (runCapture(argv, out, sizeof(out), 15) != 0)
    out[0] = 0;

  pthread_mutex_lock(&srcMutex);
  snprintf(instPath, sizeof(instPath), "%s", path);
  instMtime = st.st_mtime;
  snprintf(instVersion, sizeof(instVersion), "%s", out);
  snprintf(version, versionLen, "%s", out);
  pthread_mutex_unlock(&srcMutex);
}

//
// featureOff - "NAME=0" in a --version's features line: the feature is compiled out (unknown: not off)
//
static bool featureOff(const char* version, const char* name)
{
  char key[64];
  snprintf(key, sizeof(key), " %s=0", name);

  const char* f = (version != NULL) ? strstr(version, "features:") : NULL;
  if (f == NULL)
    return false;

  const char* end = strchr(f, '\n');
  const char* hit = strstr(f, key);

  return (hit != NULL) && ((end == NULL) || (hit < end));
}

//
// buildDirOf - Compile's builds: <data>/c3/builds/<name>
//
static void buildDirOf(const char* build, char* out, int outLen)
{
  char builds[2048];

  if (dataHome("builds", builds, sizeof(builds)) == false)
    builds[0] = 0;
  snprintf(out, outLen, "%s/%s", builds, build);
}

//
// buildVersion - the version a build's record holds (the built broker's --version), malloc'ed; NULL: no
// such build, or one that did not succeed
//
static char* buildVersion(const char* build)
{
  char path[2300];

  buildDirOf(build, path, sizeof(path) - 8);
  strncat(path, ".json", sizeof(path) - strlen(path) - 1);

  char* text = fileText(path);
  if (text == NULL)
    return NULL;

  CorAlloc alloc;
  char     buf[8 * 1024];
  CorJson  json;
  char*    out = NULL;

  corAllocBufferInit(&alloc, buf, sizeof(buf), 64 * 1024, NULL, "run build");
  corJsonCreate(&json, &alloc);

  CorNode* recP = corJsonParse(&json, text);
  CorNode* stP  = (recP != NULL) ? corTreeLookup(recP, "state") : NULL;
  CorNode* vP   = (recP != NULL) ? corTreeLookup(recP, "version") : NULL;

  if ((stP != NULL) && (stP->type == CorString) && (strcmp(stP->value.s, "succeeded") == 0))
    out = strdup(((vP != NULL) && (vP->type == CorString)) ? vP->value.s : "");

  corAllocBufferReset(&alloc, false);
  free(text);
  return out;
}



// -----------------------------------------------------------------------------
//
// buildExecutable - the broker's file name in a build's install/bin, from its record ("executable",
// coraine-build --name): coraine for a record without one (made before it was there) or no record
//
static void buildExecutable(const char* build, char* out, int outLen)
{
  char path[2300];

  snprintf(out, outLen, "coraine");
  buildDirOf(build, path, sizeof(path) - 8);
  strncat(path, ".json", sizeof(path) - strlen(path) - 1);

  char* text = fileText(path);
  if (text == NULL)
    return;

  CorAlloc alloc;
  char     buf[8 * 1024];
  CorJson  json;

  corAllocBufferInit(&alloc, buf, sizeof(buf), 64 * 1024, NULL, "run build");
  corJsonCreate(&json, &alloc);

  CorNode* recP = corJsonParse(&json, text);
  CorNode* eP   = (recP != NULL) ? corTreeLookup(recP, "executable") : NULL;

  if ((eP != NULL) && (eP->type == CorString) && (eP->value.s[0] != 0) && (strchr(eP->value.s, '/') == NULL))
    snprintf(out, outLen, "%s", eP->value.s);

  corAllocBufferReset(&alloc, false);
  free(text);
}



// -----------------------------------------------------------------------------
//
// defDefaults - a new broker: corDB alone, natively, on 1026 with the health port on 1027
//
static void defDefaults(Def* dP)
{
  memset(dP, 0, sizeof(*dP));
  snprintf(dP->from, sizeof(dP->from), "installed");
  snprintf(dP->where, sizeof(dP->where), "native");
  snprintf(dP->set, sizeof(dP->set), "cordb");
  snprintf(dP->store, sizeof(dP->store), "corDB");
  snprintf(dP->history, sizeof(dP->history), "corDB");
  dP->dbDir      = true;
  dP->port       = 1026;
  dP->healthPort = 1027;
  dP->ws         = true;
  dP->admin       = true;
  dP->distributed = true;
  dP->verbose     = true;
  dP->grace      = GRACE_DEFAULT;
}



// -----------------------------------------------------------------------------
//
// defParse - a broker from JSON (a request's body, or c3.json); false with why
//
static bool memberString(CorNode* oP, const char* name, char* out, int outLen, char* err, int errLen)
{
  CorNode* nP = corTreeLookup(oP, name);

  if ((nP == NULL) || (nP->type == CorNull))
    return true;
  if (nP->type != CorString)
  {
    snprintf(err, errLen, "\"%s\" is a string", name);
    return false;
  }
  if ((int) strlen(nP->value.s) >= outLen)
  {
    snprintf(err, errLen, "\"%s\" is longer than %d characters", name, outLen - 1);
    return false;
  }
  snprintf(out, outLen, "%s", nP->value.s);
  return true;
}

static bool memberBool(CorNode* oP, const char* name, bool* out, char* err, int errLen)
{
  CorNode* nP = corTreeLookup(oP, name);

  if ((nP == NULL) || (nP->type == CorNull))
    return true;
  if (nP->type != CorBoolean)
  {
    snprintf(err, errLen, "\"%s\" is true or false", name);
    return false;
  }
  *out = nP->value.b;
  return true;
}

static bool memberInt(CorNode* oP, const char* name, int* out, int min, int max, char* err, int errLen)
{
  CorNode* nP = corTreeLookup(oP, name);

  if ((nP == NULL) || (nP->type == CorNull))
    return true;
  if ((nP->type != CorInt) || (nP->value.i < min) || (nP->value.i > max))
  {
    snprintf(err, errLen, "\"%s\" is a whole number from %d to %d", name, min, max);
    return false;
  }
  *out = (int) nP->value.i;
  return true;
}

//
// memberList - ["a", "b"] (or "a,b") as "a,b"; each of 'allowed'
//
//
// listHas - 'name' one of the comma-separated 'list'
//
static bool listHas(const char* list, const char* name)
{
  char  copy[512];
  char* save = NULL;

  snprintf(copy, sizeof(copy), "%s", list);
  for (char* t = strtok_r(copy, ",", &save); t != NULL; t = strtok_r(NULL, ",", &save))
  {
    if (strcmp(t, name) == 0)
      return true;
  }
  return false;
}

static bool memberList(CorNode* oP, const char* name, const char** allowed, char* out, int outLen, char* err, int errLen)
{
  CorNode* nP = corTreeLookup(oP, name);
  Str      s  = { NULL, 0, 0 };

  if ((nP == NULL) || (nP->type == CorNull))
    return true;

  strAdd(&s, "");
  if (nP->type == CorArray)
  {
    for (CorNode* iP = nP->value.head; iP != NULL; iP = iP->next)
    {
      if (iP->type != CorString)
      {
        snprintf(err, errLen, "\"%s\" is a list of names", name);
        strFree(&s);
        return false;
      }
      strAddf(&s, "%s%s", (s.len > 0) ? "," : "", iP->value.s);
    }
  }
  else if (nP->type == CorString)
    strAdd(&s, nP->value.s);
  else
  {
    snprintf(err, errLen, "\"%s\" is a list of names", name);
    strFree(&s);
    return false;
  }

  //
  // Each one known
  //
  char* save = NULL;
  char* copy = strdup(s.s);
  for (char* t = strtok_r(copy, ",", &save); t != NULL; t = strtok_r(NULL, ",", &save))
  {
    bool ok = (allowed == NULL);                  // NULL: any name
    for (int ix = 0; (allowed != NULL) && (allowed[ix] != NULL); ix++)
      ok = ok || (strcmp(t, allowed[ix]) == 0);
    if (!ok)
    {
      snprintf(err, errLen, "\"%s\": '%s' is not one of them", name, t);
      free(copy);
      strFree(&s);
      return false;
    }
  }
  free(copy);

  if (s.len >= outLen)
  {
    snprintf(err, errLen, "\"%s\" is too long", name);
    strFree(&s);
    return false;
  }

  snprintf(out, outLen, "%s", s.s);
  strFree(&s);
  return true;
}

static const char* bridgeNames[] = { "ckan", "dds", "loopback", "modbus", "mqtt", "opcua", NULL };



// -----------------------------------------------------------------------------
//
// memberLines - an array of strings as one, a line each (a file path, a NodeId may hold a comma)
//
static bool memberLines(CorNode* oP, const char* name, char* out, int outLen, char* err, int errLen)
{
  CorNode* nP = corTreeLookup(oP, name);
  int      len = 0;

  out[0] = 0;

  if ((nP == NULL) || (nP->type == CorNull))
    return true;

  if (nP->type != CorArray)
  {
    snprintf(err, errLen, "\"%s\" is a list of strings", name);
    return false;
  }

  for (CorNode* iP = nP->value.head; iP != NULL; iP = iP->next)
  {
    if ((iP->type != CorString) || (strchr(iP->value.s, '\n') != NULL))
    {
      snprintf(err, errLen, "\"%s\" is a list of strings, each one line", name);
      return false;
    }

    if (iP->value.s[0] == 0)
      continue;

    int n = snprintf(&out[len], outLen - len, "%s%s", (len > 0) ? "\n" : "", iP->value.s);

    if (n >= outLen - len)
    {
      snprintf(err, errLen, "\"%s\" is longer than %d characters", name, outLen - 1);
      return false;
    }

    len += n;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// rowsJson - lines of tab-separated strings as JSON: a list of objects, a member per name - or (keyed true)
// an object, the first string each one's name and the rest its members (a bridge configuration's "topics")
//
static void rowsJson(Str* sP, const char* lines, const char** names, int n, bool keyed)
{
  char  copy[16384];
  char* save  = NULL;
  bool  first = true;

  snprintf(copy, sizeof(copy), "%s", lines);
  strAdd(sP, keyed ? "{" : "[");

  for (char* line = strtok_r(copy, "\n", &save); line != NULL; line = strtok_r(NULL, "\n", &save))
  {
    char* f[8];
    char* fsave = NULL;
    int   got   = 0;

    for (char* t = strtok_r(line, "\t", &fsave); (t != NULL) && (got < n); t = strtok_r(NULL, "\t", &fsave))
      f[got++] = t;

    if (got != n)
      continue;

    strAdd(sP, first ? "" : ", ");
    if (keyed)
    {
      strAddJson(sP, f[0]);
      strAdd(sP, ": {");
    }
    else
    {
      strAdd(sP, "{");
      strAddJson(sP, names[0]);
      strAdd(sP, ": ");
      strAddJson(sP, f[0]);
    }
    for (int ix = 1; ix < n; ix++)
    {
      strAdd(sP, ((ix == 1) && keyed) ? "" : ", ");
      strAddJson(sP, names[ix]);
      strAdd(sP, ": ");
      strAddJson(sP, f[ix]);
    }
    strAdd(sP, "}");
    first = false;
  }

  strAdd(sP, keyed ? "}" : "]");
}



// -----------------------------------------------------------------------------
//
// rowsParse - a list of objects, each with the string members 'names' (none empty, each one line), into lines
// of them, tab-separated - a Channel each. 'what' names the list in what is answered; names[1] is the entity's
// id, a URI, and names[2] its type
//
static bool rowsParse(CorNode* nP, const char* what, const char** names, int n, char* out, int outLen, char* err, int errLen)
{
  char shape[256];
  int  len = 0;

  out[0] = 0;

  if ((nP == NULL) || (nP->type == CorNull))
    return true;

  len = snprintf(shape, sizeof(shape), "{ ");
  for (int ix = 0; ix < n; ix++)
    len += snprintf(&shape[len], sizeof(shape) - len, "%s\"%s\"", (ix > 0) ? ", " : "", names[ix]);
  snprintf(&shape[len], sizeof(shape) - len, " }");
  len = 0;

  if (nP->type != CorArray)
  {
    snprintf(err, errLen, "\"%s\" is a list of %s", what, shape);
    return false;
  }

  for (CorNode* iP = nP->value.head; iP != NULL; iP = iP->next)
  {
    const char* v[8];

    if (iP->type != CorObject)
    {
      snprintf(err, errLen, "\"%s\" is a list of %s", what, shape);
      return false;
    }

    for (int ix = 0; ix < n; ix++)
    {
      CorNode* mP = corTreeLookup(iP, names[ix]);

      if ((mP == NULL) || (mP->type != CorString) || (mP->value.s[0] == 0) || (strpbrk(mP->value.s, "\t\n") != NULL))
      {
        snprintf(err, errLen, "each of \"%s\" has \"%s\": a string of one line, not empty", what, names[ix]);
        return false;
      }

      v[ix] = mP->value.s;
    }

    if (strchr(v[1], ':') == NULL)
    {
      snprintf(err, errLen, "the channel of %s: its entityId is a URI (urn:ngsi-ld:%s:...)", v[0], v[2]);
      return false;
    }

    for (int ix = 0; ix < n; ix++)
    {
      int w = snprintf(&out[len], outLen - len, "%s%s", (ix > 0) ? "\t" : ((len > 0) ? "\n" : ""), v[ix]);

      if (w >= outLen - len)
      {
        snprintf(err, errLen, "\"%s\" is longer than %d characters", what, outLen - 1);
        return false;
      }

      len += w;
    }
  }

  return true;
}



//
// The OPC UA Channels: a Variable each, its value one attribute of an entity (rowsJson keyed: the bridge
// configuration's "topics")
//
static const char* opcuaChannelNames[] = { "node", "entityId", "entityType", "attribute" };

static void channelsJson(Str* sP, const char* channels, bool topics)
{
  rowsJson(sP, channels, opcuaChannelNames, 4, topics);
}

static bool channelsParse(CorNode* oP, char* out, int outLen, char* err, int errLen)
{
  return rowsParse(corTreeLookup(oP, "channels"), "opcua.channels", opcuaChannelNames, 4, out, outLen, err, errLen);
}



//
// The DDS mapping: a topic, a service or an action each, one attribute of an entity - the bridge
// configuration's dds.ngsild "topics", "services" and "actions", the first string each one's name
//
static const char* ddsTopicNames[]   = { "topic",   "entityId", "entityType", "attribute" };
static const char* ddsServiceNames[] = { "service", "entityId", "entityType", "attribute", "requestType", "replyType" };
static const char* ddsActionNames[]  = { "action",  "entityId", "entityType", "attribute", "type" };



// -----------------------------------------------------------------------------
//
// ddsParse - "dds": { "domain", "transport", "interfaces", "vocabulary", "topics": [...], "services": [...], "actions": [...] }
//
static bool ddsParse(CorNode* ddsP, Def* dP, char* err, int errLen)
{
  if ((ddsP == NULL) || (ddsP->type == CorNull))
    return true;

  if (ddsP->type != CorObject)
  {
    snprintf(err, errLen, "\"dds\" is an object");
    return false;
  }

  if (!memberInt(ddsP,    "domain",     &dP->dds.domain, 0, 232, err, errLen) ||
      !memberString(ddsP, "transport",  dP->dds.transport, sizeof(dP->dds.transport), err, errLen) ||
      !memberList(ddsP,   "interfaces", NULL, dP->dds.interfaces, sizeof(dP->dds.interfaces), err, errLen) ||
      !memberString(ddsP, "vocabulary", dP->dds.vocabulary, sizeof(dP->dds.vocabulary), err, errLen) ||
      !rowsParse(corTreeLookup(ddsP, "topics"),   "dds.topics",   ddsTopicNames,   4, dP->dds.topics,   sizeof(dP->dds.topics),   err, errLen) ||
      !rowsParse(corTreeLookup(ddsP, "services"), "dds.services", ddsServiceNames, 6, dP->dds.services, sizeof(dP->dds.services), err, errLen) ||
      !rowsParse(corTreeLookup(ddsP, "actions"),  "dds.actions",  ddsActionNames,  5, dP->dds.actions,  sizeof(dP->dds.actions),  err, errLen))
    return false;

  const char* t = dP->dds.transport;

  if ((t[0] != 0) && (strcmp(t, "udp") != 0) && (strcmp(t, "shm") != 0))
  {
    snprintf(err, errLen, "\"dds.transport\" is \"udp\" or \"shm\" - or none, DDS's default (shared memory and UDP)");
    return false;
  }

  char  copy[sizeof(dP->dds.interfaces)];
  char* save = NULL;

  snprintf(copy, sizeof(copy), "%s", dP->dds.interfaces);
  for (char* a = strtok_r(copy, ",", &save); a != NULL; a = strtok_r(NULL, ",", &save))
  {
    struct in_addr in;

    if (inet_pton(AF_INET, a, &in) != 1)
    {
      snprintf(err, errLen, "\"dds.interfaces\": '%s' is not an IPv4 address - the addresses of this host's interfaces", a);
      return false;
    }
  }

  if ((dP->dds.interfaces[0] != 0) && (strcmp(t, "shm") == 0))
  {
    snprintf(err, errLen, "\"dds.interfaces\" are UDP's - with \"dds.transport\" \"shm\" there is no UDP");
    return false;
  }

  const char* v = dP->dds.vocabulary;

  if ((v[0] != 0) && ((strchr(v, ':') == NULL) || (strpbrk(v, " \t\n\"<>") != NULL)))
  {
    snprintf(err, errLen, "\"dds.vocabulary\" is a URI, the namespace of the terms mapped (https://example.org/robots/)");
    return false;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// opcuaParse - "opcua": { "url", "roots": [...], "security": { "mode", "policy", "certificate", "privateKey",
// "applicationUri", "trustList": [...], "trustAny" }, "user": { "username", "password" } } - the bridge's own
// "server" shape (corOpcuaBridge's README), and the model roots
//
static bool opcuaParse(CorNode* opP, Def* dP, char* err, int errLen)
{
  if ((opP == NULL) || (opP->type == CorNull))
    return true;

  if (opP->type != CorObject)
  {
    snprintf(err, errLen, "\"opcua\" is an object");
    return false;
  }

  CorNode* secP  = corTreeLookup(opP, "security");
  CorNode* userP = corTreeLookup(opP, "user");

  if (((secP != NULL) && (secP->type != CorObject) && (secP->type != CorNull)) || ((userP != NULL) && (userP->type != CorObject) && (userP->type != CorNull)))
  {
    snprintf(err, errLen, "\"opcua.security\" and \"opcua.user\" are objects");
    return false;
  }

  if (!memberString(opP, "url", dP->opcua.url, sizeof(dP->opcua.url), err, errLen) ||
      !memberLines(opP,  "roots", dP->opcua.roots, sizeof(dP->opcua.roots), err, errLen) ||
      !channelsParse(opP, dP->opcua.channels, sizeof(dP->opcua.channels), err, errLen))
    return false;

  if ((secP != NULL) && (secP->type == CorObject) &&
      (!memberString(secP, "mode",           dP->opcua.mode,           sizeof(dP->opcua.mode),           err, errLen) ||
       !memberString(secP, "policy",         dP->opcua.policy,         sizeof(dP->opcua.policy),         err, errLen) ||
       !memberString(secP, "certificate",    dP->opcua.certificate,    sizeof(dP->opcua.certificate),    err, errLen) ||
       !memberString(secP, "privateKey",     dP->opcua.privateKey,     sizeof(dP->opcua.privateKey),     err, errLen) ||
       !memberString(secP, "applicationUri", dP->opcua.applicationUri, sizeof(dP->opcua.applicationUri), err, errLen) ||
       !memberLines(secP,  "trustList",      dP->opcua.trustList,      sizeof(dP->opcua.trustList),      err, errLen) ||
       !memberBool(secP,   "trustAny",       &dP->opcua.trustAny,      err, errLen)))
    return false;

  if ((userP != NULL) && (userP->type == CorObject) &&
      (!memberString(userP, "username", dP->opcua.username, sizeof(dP->opcua.username), err, errLen) ||
       !memberString(userP, "password", dP->opcua.password, sizeof(dP->opcua.password), err, errLen)))
    return false;

  if ((dP->opcua.url[0] != 0) && (strncmp(dP->opcua.url, "opc.tcp://", 10) != 0))
  {
    snprintf(err, errLen, "\"opcua.url\" is opc.tcp://<host>:<port>");
    return false;
  }

  const char* m = dP->opcua.mode;

  if ((m[0] != 0) && (strcmp(m, "None") != 0) && (strcmp(m, "Sign") != 0) && (strcmp(m, "SignAndEncrypt") != 0))
  {
    snprintf(err, errLen, "\"opcua.security.mode\" is None, Sign or SignAndEncrypt");
    return false;
  }

  const char* p = dP->opcua.policy;

  if ((p[0] != 0) && (strcmp(p, "Basic256Sha256") != 0) && (strcmp(p, "Aes128_Sha256_RsaOaep") != 0) && (strcmp(p, "Aes256_Sha256_RsaPss") != 0))
  {
    snprintf(err, errLen, "\"opcua.security.policy\" is Basic256Sha256, Aes128_Sha256_RsaOaep or Aes256_Sha256_RsaPss");
    return false;
  }

  bool secure = (m[0] != 0) && (strcmp(m, "None") != 0);

  if (secure && ((dP->opcua.certificate[0] == 0) || (dP->opcua.privateKey[0] == 0) || (dP->opcua.applicationUri[0] == 0)))
  {
    snprintf(err, errLen, "OPC UA security %s needs the client's certificate, its private key and the application URI the certificate names", m);
    return false;
  }

  if (secure && (dP->opcua.trustList[0] == 0) && (dP->opcua.trustAny == false))
  {
    snprintf(err, errLen, "OPC UA security %s needs the server certificates to trust - or \"trust any\", which cannot tell the server meant from one that pretends to be it", m);
    return false;
  }

  if ((dP->opcua.password[0] != 0) && (dP->opcua.username[0] == 0))
  {
    snprintf(err, errLen, "an OPC UA password needs its username");
    return false;
  }

  return true;
}

static bool defParse(CorNode* oP, Def* dP, char* err, int errLen)
{
  if ((oP == NULL) || (oP->type != CorObject))
  {
    snprintf(err, errLen, "a broker is a JSON object");
    return false;
  }

  defDefaults(dP);

  //
  // A set first: it gives the store, the history and the bridges - the members given change them
  //
  if (memberString(oP, "set", dP->set, sizeof(dP->set), err, errLen) == false)
    return false;

  const SetDef* setP = setFind(dP->set);
  if (setP == NULL)
  {
    snprintf(err, errLen, "\"set\" is one of cordb, mongoc-timescale, mqtt - not '%s'", dP->set);
    return false;
  }
  snprintf(dP->store, sizeof(dP->store), "%s", setP->store);
  snprintf(dP->history, sizeof(dP->history), "%s", setP->history);
  snprintf(dP->bridges, sizeof(dP->bridges), "%s", setP->bridges);
  dP->dbDir = setP->dbDir;

  CorNode* transportsP = corTreeLookup(oP, "transports");
  char     transports[64] = "ws";
  const char* transportNames[] = { "ws", NULL };

  if (!memberString(oP, "name",         dP->name,         sizeof(dP->name),         err, errLen) ||
      !memberString(oP, "from",         dP->from,         sizeof(dP->from),         err, errLen) ||
      !memberString(oP, "build",        dP->build,        sizeof(dP->build),        err, errLen) ||
      !memberString(oP, "image",        dP->image,        sizeof(dP->image),        err, errLen) ||
      !memberString(oP, "where",        dP->where,        sizeof(dP->where),        err, errLen) ||
      !memberString(oP, "store",        dP->store,        sizeof(dP->store),        err, errLen) ||
      !memberString(oP, "history",      dP->history,      sizeof(dP->history),      err, errLen) ||
      !memberString(oP, "bridgeConfig", dP->bridgeConfig, sizeof(dP->bridgeConfig), err, errLen) ||
      !memberString(oP, "userContext",  dP->userContext,  sizeof(dP->userContext),  err, errLen) ||
      !memberString(oP, "args",         dP->args,         sizeof(dP->args),         err, errLen) ||
      !memberString(oP, "lastStarted",  dP->lastStarted,  sizeof(dP->lastStarted),  err, errLen) ||
      !memberBool(oP,   "dbDir",        &dP->dbDir,       err, errLen) ||
      !memberBool(oP,   "admin",        &dP->admin,       err, errLen) ||
      !memberBool(oP,   "distributed",  &dP->distributed, err, errLen) ||
      !memberBool(oP,   "verbose",      &dP->verbose,     err, errLen) ||
      !memberInt(oP,    "port",         &dP->port,        1, 65535, err, errLen) ||
      !memberInt(oP,    "healthPort",   &dP->healthPort,  0, 65535, err, errLen) ||
      !memberInt(oP,    "grace",        &dP->grace,       1, 600, err, errLen) ||
      !memberList(oP,   "bridges",      bridgeNames,      dP->bridges, sizeof(dP->bridges), err, errLen) ||
      !memberList(oP,   "ckan",         NULL,             dP->ckan,    sizeof(dP->ckan),    err, errLen) ||
      !opcuaParse(corTreeLookup(oP, "opcua"), dP, err, errLen) ||
      !ddsParse(corTreeLookup(oP, "dds"), dP, err, errLen))
    return false;

  //
  // An OPC UA server is the opcua bridge's, in the bridge configuration c3 writes - and the bridge without
  // one has nothing to connect to
  //
  if (dP->opcua.url[0] != 0)
  {
    if (dP->bridgeConfig[0] != 0)
    {
      snprintf(err, errLen, "the OPC UA server goes in the bridge configuration c3 writes - not with a bridge configuration file of one's own");
      return false;
    }
    if (!listHas(dP->bridges, "opcua"))
    {
      int len = strlen(dP->bridges);
      snprintf(&dP->bridges[len], sizeof(dP->bridges) - len, "%sopcua", (len > 0) ? "," : "");
    }
  }
  else if (listHas(dP->bridges, "opcua") && (dP->bridgeConfig[0] == 0))
  {
    snprintf(err, errLen, "the opcua bridge needs an OPC UA server (its URL) - or a bridge configuration file of one's own");
    return false;
  }

  //
  // CKAN datasets are Channels of the ckan bridge, in the bridge configuration c3 writes
  //
  if (dP->ckan[0] != 0)
  {
    if (dP->bridgeConfig[0] != 0)
    {
      snprintf(err, errLen, "CKAN datasets go in the bridge configuration c3 writes - not with a bridge configuration file of one's own");
      return false;
    }
    if (!listHas(dP->bridges, "ckan"))
    {
      int len = strlen(dP->bridges);
      snprintf(&dP->bridges[len], sizeof(dP->bridges) - len, "%sckan", (len > 0) ? "," : "");
    }
  }

  //
  // The DDS mapping is the dds bridge's, in the bridge configuration c3 writes
  //
  if (((dP->dds.topics[0] != 0) || (dP->dds.services[0] != 0) || (dP->dds.actions[0] != 0) || (dP->dds.domain != 0) ||
       (dP->dds.transport[0] != 0) || (dP->dds.interfaces[0] != 0)) && (dP->bridgeConfig[0] != 0))
  {
    snprintf(err, errLen, "the DDS domain and mapping go in the bridge configuration c3 writes - not with a bridge configuration file of one's own");
    return false;
  }

  if (transportsP != NULL)
  {
    transports[0] = 0;
    if (memberList(oP, "transports", transportNames, transports, sizeof(transports), err, errLen) == false)
      return false;
  }
  dP->ws = (strstr(transports, "ws") != NULL);

  if (nameOk(dP->name) == false)
  {
    snprintf(err, errLen, "a broker's name is 1 to 64 of A-Z a-z 0-9 . _ -, starting with a letter or a digit");
    return false;
  }

  if ((strcmp(dP->from, "installed") != 0) && (strcmp(dP->from, "build") != 0) && (strcmp(dP->from, "image") != 0))
  {
    snprintf(err, errLen, "\"from\" is installed, build or image");
    return false;
  }
  if ((strcmp(dP->where, "native") != 0) && (strcmp(dP->where, "container") != 0))
  {
    snprintf(err, errLen, "\"where\" is native or container");
    return false;
  }
  if ((strcmp(dP->store, "corDB") != 0) && (strcmp(dP->store, "mongoc") != 0))
  {
    snprintf(err, errLen, "\"store\" is corDB or mongoc");
    return false;
  }
  if ((strcmp(dP->history, "none") != 0) && (strcmp(dP->history, "corDB") != 0) && (strcmp(dP->history, "timescale") != 0))
  {
    snprintf(err, errLen, "\"history\" is none, corDB or timescale");
    return false;
  }

  if (strcmp(dP->from, "image") == 0)
  {
    snprintf(dP->where, sizeof(dP->where), "container");   // an image runs in a container
    if (dP->image[0] == 0)
    {
      snprintf(err, errLen, "an image: \"image\" names it (%s:<tag>)", PUBLISHED_REPO);
      return false;
    }
    for (const char* c = dP->image; *c != 0; ++c)
    {
      if ((*c <= ' ') || (strchr("\"'\\$`;|&<>", *c) != NULL))
      {
        snprintf(err, errLen, "\"image\" has a character an image's name cannot have");
        return false;
      }
    }
  }
  else
    dP->image[0] = 0;

  if (strcmp(dP->from, "build") == 0)
  {
    if (nameOk(dP->build) == false)
    {
      snprintf(err, errLen, "a build: \"build\" names one of Compile's builds");
      return false;
    }
    if (strcmp(dP->where, "container") == 0)
    {
      snprintf(err, errLen, "a build runs natively - Compile makes no image yet");
      return false;
    }
  }
  else
    dP->build[0] = 0;

  if (strcmp(dP->from, "installed") == 0)
    snprintf(dP->where, sizeof(dP->where), "native");     // the installed broker is a file on this machine

  if (dP->healthPort == dP->port)
  {
    snprintf(err, errLen, "the health port is another port than the broker's");
    return false;
  }

  if (strcmp(dP->store, "corDB") != 0)
    dP->dbDir = false;

  return true;
}



// -----------------------------------------------------------------------------
//
// csvJson - a comma-separated string as a JSON array of strings
//
static void csvJson(Str* sP, const char* csv)
{
  char        copy[4096];
  char*       save  = NULL;
  bool        first = true;

  snprintf(copy, sizeof(copy), "%s", csv);
  strAdd(sP, "[");
  for (char* t = strtok_r(copy, ",", &save); t != NULL; t = strtok_r(NULL, ",", &save))
  {
    strAdd(sP, first ? "" : ", ");
    strAddJson(sP, t);
    first = false;
  }
  strAdd(sP, "]");
}



//
// linesJson - a string of lines as a JSON array of strings
//
static void linesJson(Str* sP, const char* lines)
{
  char        copy[4096];
  char*       save  = NULL;
  bool        first = true;

  snprintf(copy, sizeof(copy), "%s", lines);
  strAdd(sP, "[");
  for (char* t = strtok_r(copy, "\n", &save); t != NULL; t = strtok_r(NULL, "\n", &save))
  {
    strAdd(sP, first ? "" : ", ");
    strAddJson(sP, t);
    first = false;
  }
  strAdd(sP, "]");
}



// -----------------------------------------------------------------------------
//
// opcuaPasswordPath - where c3 keeps a broker's OPC UA password: its directory, 0600
//
static void brokerDir(const char* name, char* out, int outLen);

static void opcuaPasswordPath(const char* name, char* out, int outLen)
{
  char dir[2300];

  brokerDir(name, dir, sizeof(dir));
  snprintf(out, outLen, "%s/opcua.password", dir);
}



// -----------------------------------------------------------------------------
//
// opcuaServerJson - the OPC UA server as the API has it, a broker's "opcua" and the mapper's mapping: "url",
// "security", "user" - never the password: whether c3 keeps one (passwordSet)
//
static void opcuaServerJson(const Def* dP, Str* sP, bool passwordSet)
{
  strAdd(sP, "\"url\": ");                      strAddJson(sP, dP->opcua.url);
  strAdd(sP, ", \"security\": {\"mode\": ");   strAddJson(sP, (dP->opcua.mode[0] != 0) ? dP->opcua.mode : "None");
  strAdd(sP, ", \"policy\": ");                strAddJson(sP, (dP->opcua.policy[0] != 0) ? dP->opcua.policy : NULL);
  strAdd(sP, ", \"certificate\": ");           strAddJson(sP, (dP->opcua.certificate[0] != 0) ? dP->opcua.certificate : NULL);
  strAdd(sP, ", \"privateKey\": ");            strAddJson(sP, (dP->opcua.privateKey[0] != 0) ? dP->opcua.privateKey : NULL);
  strAdd(sP, ", \"applicationUri\": ");        strAddJson(sP, (dP->opcua.applicationUri[0] != 0) ? dP->opcua.applicationUri : NULL);
  strAdd(sP, ", \"trustList\": ");             linesJson(sP, dP->opcua.trustList);
  strAddf(sP, ", \"trustAny\": %s}", dP->opcua.trustAny ? "true" : "false");
  strAdd(sP, ", \"user\": {\"username\": ");   strAddJson(sP, (dP->opcua.username[0] != 0) ? dP->opcua.username : NULL);
  strAddf(sP, ", \"passwordSet\": %s}", passwordSet ? "true" : "false");
}



// -----------------------------------------------------------------------------
//
// defRender - a broker's options as JSON (c3.json and the API)
//
static void defRender(const Def* dP, Str* sP)
{
  strAdd(sP, "{\"name\": ");          strAddJson(sP, dP->name);
  strAdd(sP, ", \"from\": ");         strAddJson(sP, dP->from);
  strAdd(sP, ", \"build\": ");        strAddJson(sP, (dP->build[0] != 0) ? dP->build : NULL);
  strAdd(sP, ", \"image\": ");        strAddJson(sP, (dP->image[0] != 0) ? dP->image : NULL);
  strAdd(sP, ", \"where\": ");        strAddJson(sP, dP->where);
  strAdd(sP, ", \"set\": ");          strAddJson(sP, dP->set);
  strAdd(sP, ", \"store\": ");        strAddJson(sP, dP->store);
  strAddf(sP, ", \"dbDir\": %s", dP->dbDir ? "true" : "false");
  strAdd(sP, ", \"history\": ");      strAddJson(sP, dP->history);
  strAddf(sP, ", \"port\": %d, \"healthPort\": %d", dP->port, dP->healthPort);
  strAddf(sP, ", \"transports\": [%s]", dP->ws ? "\"ws\"" : "");
  strAdd(sP, ", \"bridges\": [");
  {
    char  copy[128];
    char* save  = NULL;
    bool  first = true;

    snprintf(copy, sizeof(copy), "%s", dP->bridges);
    for (char* t = strtok_r(copy, ",", &save); t != NULL; t = strtok_r(NULL, ",", &save))
    {
      strAdd(sP, first ? "" : ", ");
      strAddJson(sP, t);
      first = false;
    }
  }
  strAdd(sP, "]");
  strAdd(sP, ", \"bridgeConfig\": "); strAddJson(sP, (dP->bridgeConfig[0] != 0) ? dP->bridgeConfig : NULL);
  strAdd(sP, ", \"userContext\": ");  strAddJson(sP, (dP->userContext[0] != 0) ? dP->userContext : NULL);
  strAdd(sP, ", \"ckan\": [");
  {
    char  copy[512];
    char* save  = NULL;
    bool  first = true;

    snprintf(copy, sizeof(copy), "%s", dP->ckan);
    for (char* t = strtok_r(copy, ",", &save); t != NULL; t = strtok_r(NULL, ",", &save))
    {
      strAdd(sP, first ? "" : ", ");
      strAddJson(sP, t);
      first = false;
    }
  }
  strAdd(sP, "]");
  if (dP->opcua.url[0] != 0)
  {
    //
    // The OPC UA server - never the password: the API says whether c3 keeps one
    //
    char        pwPath[2400];
    struct stat st;

    opcuaPasswordPath(dP->name, pwPath, sizeof(pwPath));

    strAdd(sP, ", \"opcua\": {");
    opcuaServerJson(dP, sP, (dP->opcua.username[0] != 0) && (stat(pwPath, &st) == 0));
    strAdd(sP, ", \"roots\": ");                 linesJson(sP, dP->opcua.roots);
    strAdd(sP, ", \"channels\": ");              channelsJson(sP, dP->opcua.channels, false);
    strAdd(sP, "}");
  }
  if ((dP->dds.domain != 0) || (dP->dds.transport[0] != 0) || (dP->dds.interfaces[0] != 0) || (dP->dds.vocabulary[0] != 0) ||
      (dP->dds.topics[0] != 0) || (dP->dds.services[0] != 0) || (dP->dds.actions[0] != 0))
  {
    strAddf(sP, ", \"dds\": {\"domain\": %d, \"transport\": ", dP->dds.domain);
    strAddJson(sP, (dP->dds.transport[0] != 0) ? dP->dds.transport : NULL);
    strAdd(sP, ", \"interfaces\": ");    csvJson(sP, dP->dds.interfaces);
    strAdd(sP, ", \"vocabulary\": ");
    strAddJson(sP, (dP->dds.vocabulary[0] != 0) ? dP->dds.vocabulary : NULL);
    strAdd(sP, ", \"topics\": ");      rowsJson(sP, dP->dds.topics,   ddsTopicNames,   4, false);
    strAdd(sP, ", \"services\": ");    rowsJson(sP, dP->dds.services, ddsServiceNames, 6, false);
    strAdd(sP, ", \"actions\": ");     rowsJson(sP, dP->dds.actions,  ddsActionNames,  5, false);
    strAdd(sP, "}");
  }
  strAddf(sP, ", \"admin\": %s, \"distributed\": %s, \"verbose\": %s", dP->admin ? "true" : "false", dP->distributed ? "true" : "false", dP->verbose ? "true" : "false");
  strAdd(sP, ", \"args\": ");         strAddJson(sP, dP->args);
  strAddf(sP, ", \"grace\": %d", dP->grace);
  strAdd(sP, ", \"lastStarted\": ");  strAddJson(sP, (dP->lastStarted[0] != 0) ? dP->lastStarted : NULL);
  strAdd(sP, "}");
}



// -----------------------------------------------------------------------------
//
// needs - the services a broker's options need (a bit per kind)
//
static bool hasBridge(const Def* dP, const char* name)
{
  char  copy[128];
  char* save = NULL;

  snprintf(copy, sizeof(copy), "%s", dP->bridges);
  for (char* t = strtok_r(copy, ",", &save); t != NULL; t = strtok_r(NULL, ",", &save))
  {
    if (strcmp(t, name) == 0)
      return true;
  }
  return false;
}

static int needs(const Def* dP)
{
  int mask = 0;

  if (strcmp(dP->store, "mongoc") == 0)
    mask |= 1 << KIND_MONGO;
  if (strcmp(dP->history, "timescale") == 0)
    mask |= 1 << KIND_TIMESCALE;
  if (hasBridge(dP, "mqtt") && (dP->bridgeConfig[0] == 0))
    mask |= 1 << KIND_MOSQUITTO;

  return mask;
}

static void svcName(const char* set, int kind, char* out, int outLen)
{
  snprintf(out, outLen, "c3-%s-%s", set, kinds[kind].id);
}



// -----------------------------------------------------------------------------
//
// Paths of a broker
//
static void brokerDir(const char* name, char* out, int outLen)      { snprintf(out, outLen, "%s/%s", runDir, name); }
static void brokerDataDir(const char* name, char* out, int outLen)  { snprintf(out, outLen, "%s/%s/data", runDir, name); }
static void brokerVolume(const char* name, char* out, int outLen)   { snprintf(out, outLen, "c3-broker-%s", name); }
static void brokerContainer(const char* name, char* out, int outLen) { snprintf(out, outLen, "c3-broker-%s", name); }
static void ddsContextPath(const char* name, char* out, int outLen)  { snprintf(out, outLen, "%s/%s/dds-context.jsonld", runDir, name); }   // the DDS mapping's @context



// -----------------------------------------------------------------------------
//
// bridgesConfigOwn - c3 writes the broker's bridge configuration: a bridge that needs one (mqtt, dds, opcua) or
// CKAN datasets, and no file of the user's
//
static bool bridgesConfigOwn(const Def* dP)
{
  return (hasBridge(dP, "mqtt") || hasBridge(dP, "dds") || (dP->ckan[0] != 0) || (dP->opcua.url[0] != 0)) && (dP->bridgeConfig[0] == 0);
}



// -----------------------------------------------------------------------------
//
// argvMake - the broker's command: the program (natively) or the engine's `run` (in a container), then
// coraine's options from the form. 'ports' are the services' host ports (natively they are reached on
// 127.0.0.1, from a container by their names on the network c3). false with why.
//
// A container with the dds bridge is on the host's network and IPC namespace instead: DDS discovery is UDP
// multicast, which a bridge network keeps to its own containers, and Fast DDS reaches a participant on the
// same machine over shared memory. Its port is the host's, and it reaches the services as a native broker
// does. 'discovery': ddsDiscoverThread's container - removed when it ends, and it ends by itself in 120 s.
//
static void ddsFilesPath(const char* file, char* out, int outLen);

static bool argvMake(const Def* dP, const int* ports, bool discovery, Argv* aP, char* err, int errLen)
{
  bool container = (strcmp(dP->where, "container") == 0);
  bool hostNet   = container && hasBridge(dP, "dds");
  bool byName    = container && !hostNet;            // the services by their names on the network c3
  char dir[2300];
  char path[2400];
  char bridgeFile[2400] = "";

  brokerDir(dP->name, dir, sizeof(dir));

  if (hasBridge(dP, "mqtt") || (dP->bridgeConfig[0] != 0))
    snprintf(bridgeFile, sizeof(bridgeFile), "%s", (dP->bridgeConfig[0] != 0) ? dP->bridgeConfig : "");
  if (bridgesConfigOwn(dP) == true)
    snprintf(bridgeFile, sizeof(bridgeFile), "%s/bridges.json", dir);

  char ddsContext[2400] = "";                    // the DDS mapping's @context (ddsContextWrite), the default user context
  if (bridgesConfigOwn(dP) && hasBridge(dP, "dds") && (dP->dds.vocabulary[0] != 0))
    ddsContextPath(dP->name, ddsContext, sizeof(ddsContext));

  if ((ddsContext[0] != 0) && (dP->userContext[0] != 0))
  {
    snprintf(err, errLen, "one default user @context: the DDS vocabulary's, which c3 writes, or the file given - not both");
    return false;
  }

  if (container && (dP->ckan[0] != 0))
  {
    snprintf(err, errLen, "CKAN datasets need a native broker: the image has no ckan bridge");
    return false;
  }

  if (container && hasBridge(dP, "opcua"))
  {
    snprintf(err, errLen, "the OPC UA bridge needs a native broker: the image has no opcua bridge");
    return false;
  }

  if (container)
  {
    char name[96];
    char vol[96];

    if (engine[0] == 0)
    {
      snprintf(err, errLen, "%s", engineWhy);
      return false;
    }

    brokerContainer(dP->name, name, sizeof(name));
    brokerVolume(dP->name, vol, sizeof(vol));

    argAdd(aP, engine);
    argAdd(aP, "run");
    argAdd(aP, "-d");
    if (discovery)
      argAdd(aP, "--rm");
    argAdd(aP, "--name");     argAdd(aP, name);
    argAdd(aP, "--label");    argAdd(aP, "c3=run");
    argAdd(aP, "--label");    argAdd(aP, discovery ? "c3.kind=discovery" : "c3.kind=broker");
    argAdd(aP, "--label");    argAddf(aP, "c3.broker=%s", dP->name);
    argAdd(aP, "--stop-timeout"); argAddf(aP, "%d", dP->grace);
    if (hostNet)
    {
      argAdd(aP, "--network"); argAdd(aP, "host");
      argAdd(aP, "--ipc");     argAdd(aP, "host");
    }
    else
    {
      argAdd(aP, "--network"); argAdd(aP, "c3");
      argAdd(aP, "-p");        argAddf(aP, "127.0.0.1:%d:1026", dP->port);   // 1026 inside: the image's HEALTHCHECK asks it
      if (dP->healthPort > 0)
      {
        argAdd(aP, "-p");      argAddf(aP, "127.0.0.1:%d:%d", dP->healthPort, dP->healthPort);
      }
    }
    if (dP->dbDir)
    {
      argAdd(aP, "-v");       argAddf(aP, "%s:/data", vol);
    }
    if (bridgeFile[0] != 0)
    {
      argAdd(aP, "-v");       argAddf(aP, "%s:/etc/c3/bridges.json:ro", bridgeFile);
    }
    if (ddsContext[0] != 0)
    {
      argAdd(aP, "-v");       argAddf(aP, "%s:/etc/c3/dds-context.jsonld:ro", ddsContext);
    }
    if (dP->userContext[0] != 0)
    {
      argAdd(aP, "-v");       argAddf(aP, "%s:/etc/c3/user-context.jsonld:ro", dP->userContext);
    }

    char ddsConf[2400];
    ddsFilesPath("dds-bridge.json", ddsConf, sizeof(ddsConf));
    if (strcmp(dP->bridgeConfig, ddsConf) == 0)      // the mapper's: its typesDirectory is a host path - there in the container too
    {
      char types[2400];
      ddsFilesPath("dds-types", types, sizeof(types));
      dirsMake(types);
      argAdd(aP, "-v");       argAddf(aP, "%s:%s", types, types);
    }
    if (discovery)
    {
      argAdd(aP, "--entrypoint"); argAdd(aP, "timeout");
    }
    argAdd(aP, dP->image);
    if (discovery)
    {
      argAdd(aP, "120"); argAdd(aP, "coraine-start");
    }
    // The image's entry point is `coraine` (coraine-start) - in the foreground, logging to stdout: its defaults
  }
  else if (strcmp(dP->from, "build") == 0)
  {
    char bdir[2300];
    char env[2400];

    char exe[65];

    buildDirOf(dP->build, bdir, sizeof(bdir));
    buildExecutable(dP->build, exe, sizeof(exe));
    snprintf(env, sizeof(env), "%s/install/env", bdir);
    snprintf(path, sizeof(path), "%s/install/bin/%s", bdir, exe);

    if (access(path, X_OK) != 0)
    {
      snprintf(err, errLen, "the build '%s' has no broker (%s) - a build that succeeded, or build it again", dP->build, path);
      return false;
    }

    //
    // Its env (PATH, SEAMWARE_PLUGIN_DIR, its etc) - the same as `. install/env; coraine ...` by hand.
    // A build tuned for a workload (coraine-build --tune) also has install/etc/tune.env, what the tuning
    // chose: applied as the image's entry point does (coraine-start) - TUNE_DBLOCKPREFER the default of
    // --dbLockPrefer (CORAINE_DBLOCKPREFER: the command line's still wins), TUNE_ALLOCATOR preloaded
    // (LD_PRELOAD); an allocator that is not installed: glibc's, and the broker's log says so
    //
    argAdd(aP, "/bin/sh");
    argAdd(aP, "-c");
    argAdd(aP,
           ". \"$0\" || exit 1\n"
           "t=\"${0%/env}/etc/tune.env\"\n"
           "if [ -f \"$t\" ]; then\n"
           "  . \"$t\"\n"
           "  [ -z \"$TUNE_DBLOCKPREFER\" ] || export CORAINE_DBLOCKPREFER=\"$TUNE_DBLOCKPREFER\"\n"
           "  if [ -n \"$TUNE_ALLOCATOR\" ] && [ \"$TUNE_ALLOCATOR\" != glibc ]; then\n"
           "    lib=$(PATH=\"$PATH:/sbin:/usr/sbin\" ldconfig -p | awk -v l=\"lib$TUNE_ALLOCATOR.so\" 'index($1, l) == 1 { print $NF; exit }')\n"
           "    if [ -n \"$lib\" ]; then export LD_PRELOAD=\"$lib\"; else echo \"c3: the allocator '$TUNE_ALLOCATOR' the tuning chose is not installed - glibc's used\" >&2; fi\n"
           "  fi\n"
           "  echo \"c3: $t applied - dbLockPrefer ${TUNE_DBLOCKPREFER:-unset}, allocator ${TUNE_ALLOCATOR:-glibc}${LD_PRELOAD:+ ($LD_PRELOAD)}\" >&2\n"
           "fi\n"
           "exec \"$@\"");
    argAdd(aP, env);
    argAdd(aP, path);                                   // the foreground and the log on stdout: the broker's defaults
  }
  else
  {
    if (inPath("coraine", path, sizeof(path)) == false)
    {
      snprintf(err, errLen, "no coraine in $PATH - install the coraine package");
      return false;
    }
    argAdd(aP, path);
  }

  argAdd(aP, "--port");        argAddf(aP, "%d", byName ? 1026 : dP->port);
  if (dP->healthPort > 0)
  {
    argAdd(aP, "--healthPort"); argAddf(aP, "%d", dP->healthPort);
  }

  argAdd(aP, "--database");    argAdd(aP, dP->store);
  if (dP->dbDir)
  {
    char data[2400];
    brokerDataDir(dP->name, data, sizeof(data));
    argAdd(aP, "--dbDir");     argAdd(aP, container ? "/data" : data);
  }

  char svc[96];
  char db[96];

  if (strcmp(dP->store, "mongoc") == 0)
  {
    svcName(dP->set, KIND_MONGO, svc, sizeof(svc));
    dbNameOf(dP->name, "", db, sizeof(db));
    argAdd(aP, "--dbHost");    argAdd(aP, byName ? svc : "127.0.0.1");
    argAdd(aP, "--dbPort");    argAddf(aP, "%d", byName ? kinds[KIND_MONGO].port : ports[KIND_MONGO]);
    argAdd(aP, "--dbName");    argAdd(aP, db);
  }

  argAdd(aP, "--troe");        argAdd(aP, dP->history);
  if (strcmp(dP->history, "timescale") == 0)
  {
    svcName(dP->set, KIND_TIMESCALE, svc, sizeof(svc));
    dbNameOf(dP->name, "_h", db, sizeof(db));
    argAdd(aP, "--troeHost");  argAdd(aP, byName ? svc : "127.0.0.1");
    argAdd(aP, "--troePort");  argAddf(aP, "%d", byName ? kinds[KIND_TIMESCALE].port : ports[KIND_TIMESCALE]);
    argAdd(aP, "--troeUser");  argAdd(aP, "postgres");
    argAdd(aP, "--troeName");  argAdd(aP, db);
  }

  if (dP->admin)
  {
    argAdd(aP, "--apiPlugins"); argAdd(aP, "admin");
  }
  if (dP->distributed)
    argAdd(aP, "--distributed");
  if (dP->ws)
  {
    argAdd(aP, "--transports"); argAdd(aP, "ws");
  }
  if (dP->bridges[0] != 0)
  {
    argAdd(aP, "--bridges");   argAdd(aP, dP->bridges);
  }
  if (bridgeFile[0] != 0)
  {
    argAdd(aP, "--bridgeConfig"); argAdd(aP, container ? "/etc/c3/bridges.json" : bridgeFile);
  }
  if (ddsContext[0] != 0)
  {
    argAdd(aP, "--defaultUserContext"); argAdd(aP, container ? "/etc/c3/dds-context.jsonld" : ddsContext);
  }
  if (dP->userContext[0] != 0)
  {
    argAdd(aP, "--defaultUserContext"); argAdd(aP, container ? "/etc/c3/user-context.jsonld" : dP->userContext);
  }
  if (dP->verbose)
    argAdd(aP, "-v");

  char* extra[64];
  int   n = lineSplit(dP->args, extra, 64);
  for (int ix = 0; ix < n; ix++)
  {
    argAdd(aP, extra[ix]);
    free(extra[ix]);
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// brokerFind / svcFind (rMutex held)
//
static Broker* brokerFind(const char* name)
{
  for (int ix = 0; ix < nBrokers; ix++)
  {
    if (strcmp(brokers[ix]->def.name, name) == 0)
      return brokers[ix];
  }
  return NULL;
}

static Service* svcFind(const char* container)
{
  for (int ix = 0; ix < nSvcs; ix++)
  {
    if (strcmp(svcs[ix].container, container) == 0)
      return &svcs[ix];
  }
  return NULL;
}

//
// svcGet - the service of a set, added (absent) when not known yet
//
static Service* svcGet(const char* set, int kind)
{
  char name[96];

  svcName(set, kind, name, sizeof(name));

  Service* sP = svcFind(name);
  if ((sP != NULL) || (nSvcs >= SERVICES_MAX))
    return sP;

  sP = &svcs[nSvcs++];
  memset(sP, 0, sizeof(*sP));
  snprintf(sP->container, sizeof(sP->container), "%s", name);
  snprintf(sP->set, sizeof(sP->set), "%s", set);
  snprintf(sP->volume, sizeof(sP->volume), "%s", name);
  snprintf(sP->state, sizeof(sP->state), "absent");
  snprintf(sP->logPath, sizeof(sP->logPath), "%s/%s.log", svcDir, name);
  sP->kind = kind;

  return sP;
}



// -----------------------------------------------------------------------------
//
// logLine - a line of c3's own into a log: "c3: ..."
//
static void logLine(const char* path, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
static void logLine(const char* path, const char* fmt, ...)
{
  char    line[4096];
  char    t[32];
  va_list ap;

  isoTime(time(NULL), t, sizeof(t));
  int n = snprintf(line, sizeof(line), "c3: %s ", t);

  va_start(ap, fmt);
  n += vsnprintf(&line[n], sizeof(line) - n - 1, fmt, ap);
  va_end(ap);

  if (n > (int) sizeof(line) - 2)
    n = sizeof(line) - 2;
  line[n++] = '\n';

  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
  if (fd != -1)
  {
    ssize_t ignored = write(fd, line, n);
    (void) ignored;
    close(fd);
  }
}



// -----------------------------------------------------------------------------
//
// stateSave / stateRead - <name>/state.json: the native broker that runs
//
static void stateSave(Broker* bP)
{
  char path[2400];
  char tmp[2410];
  char t[32];
  Str  s = { NULL, 0, 0 };

  isoTime(bP->started, t, sizeof(t));
  snprintf(path, sizeof(path), "%s/%s/state.json", runDir, bP->def.name);
  snprintf(tmp, sizeof(tmp), "%s.tmp", path);

  strAddf(&s, "{\"pid\": %d, \"procStart\": %lld, \"started\": \"%s\"}\n", (int) bP->pid, bP->procStart, t);

  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd != -1)
  {
    bool ok = (write(fd, s.s, s.len) == s.len);
    close(fd);
    if (ok)
      rename(tmp, path);
    else
      unlink(tmp);
  }
  strFree(&s);

  //
  // ... and the plain pid file, for a shell: kill $(cat broker.pid)
  //
  snprintf(path, sizeof(path), "%s/%s/broker.pid", runDir, bP->def.name);
  fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd != -1)
  {
    char line[32];
    int  n = snprintf(line, sizeof(line), "%d\n", (int) bP->pid);
    ssize_t ignored = write(fd, line, n);
    (void) ignored;
    close(fd);
  }
}

static void stateClear(const char* name)
{
  char path[2400];

  snprintf(path, sizeof(path), "%s/%s/state.json", runDir, name);
  unlink(path);
  snprintf(path, sizeof(path), "%s/%s/broker.pid", runDir, name);
  unlink(path);
}

static bool stateRead(const char* name, pid_t* pidP, long long* startP, time_t* startedP)
{
  char path[2400];

  snprintf(path, sizeof(path), "%s/%s/state.json", runDir, name);

  char* text = fileText(path);
  if (text == NULL)
    return false;

  const char* p = strstr(text, "\"pid\": ");
  const char* s = strstr(text, "\"procStart\": ");
  const char* t = strstr(text, "\"started\": \"");

  if ((p == NULL) || (s == NULL))
  {
    free(text);
    return false;
  }

  *pidP   = atoi(p + 7);
  *startP = atoll(s + 13);

  if (t != NULL)
  {
    struct tm tm;
    memset(&tm, 0, sizeof(tm));
    if (strptime(t + 12, "%Y-%m-%dT%H:%M:%SZ", &tm) != NULL)
      *startedP = timegm(&tm);
  }

  free(text);
  return true;
}



// -----------------------------------------------------------------------------
//
// followerStart - `docker logs -f <container>` appending to a log file (SIGTERM when c3 dies). A file that
// already has lines: from its last change on (--since), so a restart of c3 does not write them twice.
//
static pid_t followerStart(const char* container, const char* logPath)
{
  struct stat st;
  char        since[32] = "";

  if ((stat(logPath, &st) == 0) && (st.st_size > 0))
    isoTime(st.st_mtime, since, sizeof(since));

  int fd = open(logPath, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
  if (fd == -1)
    return -1;

  Argv a = { { NULL }, 0 };
  argAdd(&a, engine);
  argAdd(&a, "logs");
  argAdd(&a, "-f");
  if (since[0] != 0)
  {
    argAdd(&a, "--since");
    argAdd(&a, since);
  }
  argAdd(&a, container);

  ProcSpawn sp  = { a.v, NULL, fd, NULL, true, false, SIGTERM };
  pid_t     pid = procSpawn(&sp);

  close(fd);
  argFree(&a);
  return pid;
}



// -----------------------------------------------------------------------------
//
// engineToLog - the engine with these arguments, its output into a log file (a pull: progress lines), waited for
//
static int engineToLog(const char* logPath, int timeoutS, Argv* aP)
{
  int fd = open(logPath, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
  if (fd == -1)
    return -1;

  ProcSpawn sp  = { aP->v, NULL, fd, NULL, true, false, SIGTERM };
  pid_t     pid = procSpawn(&sp);
  close(fd);

  if (pid < 0)
    return -1;

  int    status   = -1;
  time_t deadline = time(NULL) + timeoutS;

  while (true)
  {
    pid_t w = waitpid(pid, &status, WNOHANG);
    if (w == pid)
      break;
    if ((w == -1) && (errno != EINTR))
      return -1;
    if (time(NULL) > deadline)
    {
      kill(-pid, SIGKILL);
      waitpid(pid, &status, 0);
      return -1;
    }
    usleep(200 * 1000);
  }

  return status;
}

//
// imageEnsure - the image here, pulled when it is not (the pull's output in the log)
//
static bool imageEnsure(const char* image, const char* logPath, char* err, int errLen)
{
  char out[1024];

  if (engineRun(out, sizeof(out), 30, "image", "inspect", "--format", "{{.Id}}", image, NULL) == 0)
    return true;

  logLine(logPath, "%s pull %s", engineName, image);

  Argv a = { { NULL }, 0 };
  argAdd(&a, engine);
  argAdd(&a, "pull");
  argAdd(&a, image);
  int status = engineToLog(logPath, 1800, &a);
  argFree(&a);

  if (status != 0)
  {
    snprintf(err, errLen, "%s pull %s failed - the log says why", engineName, image);
    return false;
  }
  return true;
}

//
// networkEnsure - the network c3's containers share (by their names): c3
//
static bool networkEnsure(char* err, int errLen)
{
  char out[1024];

  if (networkMade)
    return true;

  if (engineRun(out, sizeof(out), 20, "network", "inspect", "--format", "{{.Name}}", "c3", NULL) != 0)
  {
    if (engineRun(out, sizeof(out), 30, "network", "create", "--label", "c3=run", "c3", NULL) != 0)
    {
      snprintf(err, errLen, "%s network create c3: %.300s", engineName, out);
      return false;
    }
  }

  networkMade = true;
  return true;
}



// -----------------------------------------------------------------------------
//
// svcReady - is the service up and answering (from inside its container where a client is there)?
//
static bool svcReady(const Service* sP, int hostPort)
{
  char out[512];

  if (portAnswers(hostPort) == false)
    return false;

  if (sP->kind == KIND_MONGO)
    return (engineRun(out, sizeof(out), 15, "exec", sP->container, "mongosh", "--quiet", "--eval", "db.runCommand({ping: 1}).ok", NULL) == 0) && (strcmp(out, "1") == 0);

  if (sP->kind == KIND_TIMESCALE)
    return engineRun(out, sizeof(out), 15, "exec", sP->container, "pg_isready", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres", NULL) == 0;

  return true;                                   // mosquitto: accepting connections is ready
}



// -----------------------------------------------------------------------------
//
// svcEnsure - a service of a set up and ready, for a broker that starts (its log told). Run on the start's
// thread. The host port, or -1 with why.
//
static int svcEnsure(const char* set, int kind, const char* brokerLog, char* err, int errLen)
{
  char out[2048];

  pthread_mutex_lock(&rMutex);
  Service* sP = svcGet(set, kind);
  if (sP == NULL)
  {
    pthread_mutex_unlock(&rMutex);
    snprintf(err, errLen, "too many services");
    return -1;
  }

  //
  // Another broker of the set may be starting it: wait for that
  //
  for (int ix = 0; sP->busy && (ix < READY_WAIT_S * 5); ix++)
  {
    pthread_mutex_unlock(&rMutex);
    usleep(200 * 1000);
    pthread_mutex_lock(&rMutex);
  }
  sP->busy = true;

  char name[96];
  char logPath[2300];
  snprintf(name, sizeof(name), "%s", sP->container);
  snprintf(logPath, sizeof(logPath), "%s", sP->logPath);
  pthread_mutex_unlock(&rMutex);

  int    port  = -1;
  time_t t0    = time(NULL);
  bool   fresh = false;

  //
  // Running already: its port
  //
  if ((engineRun(out, sizeof(out), 20, "inspect", "--format", "{{.State.Running}}", name, NULL) == 0) && (strcmp(out, "true") == 0))
  {
    char spec[32];
    snprintf(spec, sizeof(spec), "%d/tcp", kinds[kind].port);
    if (engineRun(out, sizeof(out), 20, "port", name, spec, NULL) == 0)
    {
      char* colon = strrchr(out, ':');
      port = (colon != NULL) ? atoi(colon + 1) : -1;
    }
    logLine(brokerLog, "%s runs already (127.0.0.1:%d)", name, port);
  }
  else
  {
    engineRun(out, sizeof(out), 30, "rm", "-f", name, NULL);    // an exited one of c3's: made again

    if ((networkEnsure(err, errLen) == false) || (imageEnsure(kinds[kind].image, brokerLog, err, errLen) == false))
      goto fail;

    for (int p = kinds[kind].hostPort; p < kinds[kind].hostPort + 50; p++)
    {
      if (portFree(p))
      {
        port = p;
        break;
      }
    }
    if (port == -1)
    {
      snprintf(err, errLen, "no free port for %s from %d on", kinds[kind].id, kinds[kind].hostPort);
      goto fail;
    }

    char label[128];
    snprintf(label, sizeof(label), "c3.set=%s", set);
    engineRun(out, sizeof(out), 30, "volume", "create", "--label", "c3=run", "--label", label, name, NULL);

    Argv a = { { NULL }, 0 };
    argAdd(&a, engine);
    argAdd(&a, "run");
    argAdd(&a, "-d");
    argAdd(&a, "--name");    argAdd(&a, name);
    argAdd(&a, "--label");   argAdd(&a, "c3=run");
    argAdd(&a, "--label");   argAdd(&a, "c3.kind=service");
    argAdd(&a, "--label");   argAdd(&a, label);
    argAdd(&a, "--label");   argAddf(&a, "c3.service=%s", kinds[kind].id);
    argAdd(&a, "--network"); argAdd(&a, "c3");
    argAdd(&a, "-p");        argAddf(&a, "127.0.0.1:%d:%d", port, kinds[kind].port);
    argAdd(&a, "-v");        argAddf(&a, "%s:%s", name, kinds[kind].volumePath);
    if (kinds[kind].env != NULL)
    {
      argAdd(&a, "-e");      argAdd(&a, kinds[kind].env);
    }
    argAdd(&a, kinds[kind].image);
    for (int ix = 0; kinds[kind].cmd[ix] != NULL; ix++)
      argAdd(&a, kinds[kind].cmd[ix]);

    Str cmd = { NULL, 0, 0 };
    argCommand(&a, &cmd);
    logLine(brokerLog, "%s", cmd.s);
    logLine(logPath, "%s", cmd.s);
    strFree(&cmd);

    int status = engineArgv(&a, out, sizeof(out), 120);
    argFree(&a);

    if (status != 0)
    {
      snprintf(err, errLen, "%s run %s: %.400s", engineName, name, out);
      goto fail;
    }
    fresh = true;

    pid_t f = followerStart(name, logPath);
    pthread_mutex_lock(&rMutex);
    sP->follower = f;
    pthread_mutex_unlock(&rMutex);
  }

  if (port <= 0)
  {
    snprintf(err, errLen, "%s: its port %d is not published", name, kinds[kind].port);
    goto fail;
  }

  pthread_mutex_lock(&rMutex);
  sP->hostPort = port;
  snprintf(sP->state, sizeof(sP->state), "starting");
  pthread_mutex_unlock(&rMutex);

  //
  // Ready: a client inside the container says so
  //
  while (svcReady(sP, port) == false)
  {
    if (time(NULL) - t0 > READY_WAIT_S)
    {
      snprintf(err, errLen, "%s is not ready after %d s - its log says why", name, READY_WAIT_S);
      goto fail;
    }
    if ((engineRun(out, sizeof(out), 20, "inspect", "--format", "{{.State.Running}}", name, NULL) != 0) || (strcmp(out, "true") != 0))
    {
      snprintf(err, errLen, "%s stopped while starting - its log says why", name);
      goto fail;
    }
    usleep(500 * 1000);
  }

  if (fresh)
    logLine(brokerLog, "%s ready on 127.0.0.1:%d after %ld s", name, port, (long) (time(NULL) - t0));

  pthread_mutex_lock(&rMutex);
  snprintf(sP->state, sizeof(sP->state), "running");
  sP->volumeExists = true;
  sP->busy         = false;
  pthread_mutex_unlock(&rMutex);
  return port;

 fail:
  logLine(brokerLog, "%s", err);
  logLine(logPath, "%s", err);
  pthread_mutex_lock(&rMutex);
  sP->busy = false;
  pthread_mutex_unlock(&rMutex);
  return -1;
}



// -----------------------------------------------------------------------------
//
// svcStop - a service container stopped and removed (its volume kept), its log told
//
static void svcStop(const char* container, const char* why)
{
  char out[1024];

  pthread_mutex_lock(&rMutex);
  Service* sP = svcFind(container);
  if ((sP == NULL) || sP->busy)
  {
    pthread_mutex_unlock(&rMutex);
    return;
  }
  sP->busy = true;
  snprintf(sP->state, sizeof(sP->state), "stopping");
  char logPath[2300];
  snprintf(logPath, sizeof(logPath), "%s", sP->logPath);
  pthread_mutex_unlock(&rMutex);

  logLine(logPath, "stop %s: %s", container, why);
  engineRun(out, sizeof(out), 60, "stop", "-t", "20", container, NULL);
  engineRun(out, sizeof(out), 30, "rm", container, NULL);
  logLine(logPath, "%s stopped and removed - its volume %s is kept", container, container);

  pthread_mutex_lock(&rMutex);
  snprintf(sP->state, sizeof(sP->state), "absent");
  sP->status[0] = 0;
  sP->busy      = false;
  pthread_mutex_unlock(&rMutex);
}

//
// svcUsedBy - the brokers using a service container that run, start or stop (rMutex held); 'except' left out
//
static int svcUsers(const char* container, const Broker* except)
{
  int n = 0;

  for (int ix = 0; ix < nBrokers; ix++)
  {
    Broker* bP = brokers[ix];

    if ((bP == except) || (strcmp(bP->state, "running") != 0 && strcmp(bP->state, "starting") != 0 && strcmp(bP->state, "stopping") != 0))
      continue;

    for (int k = 0; k < KINDS; k++)
    {
      if (strcmp(bP->usedSvc[k], container) == 0)
        ++n;
    }
  }

  return n;
}

//
// svcRelease - after a broker stopped: each service it used that nothing else uses is stopped
//
static void svcRelease(Broker* bP)
{
  char names[KINDS][96];

  pthread_mutex_lock(&rMutex);
  for (int k = 0; k < KINDS; k++)
  {
    names[k][0] = 0;
    if ((bP->usedSvc[k][0] != 0) && (svcUsers(bP->usedSvc[k], bP) == 0))
      snprintf(names[k], sizeof(names[k]), "%s", bP->usedSvc[k]);
  }
  pthread_mutex_unlock(&rMutex);

  for (int k = 0; k < KINDS; k++)
  {
    if (names[k][0] == 0)
      continue;
    logLine(bP->logPath, "%s: nothing started from c3 uses it any more - stopped (its volume kept)", names[k]);
    svcStop(names[k], "nothing started from c3 uses it any more");
  }
}



// -----------------------------------------------------------------------------
//
// cleanEnv - c3's environment for a native broker, without what would change it behind the form's back:
// CORAINE_* (every option of the broker's has one) and SEAMWARE_PLUGIN_DIR (a build's env sets its own)
//
static char** cleanEnv(void)
{
  int n = 0;
  while (environ[n] != NULL)
    ++n;

  char** env = calloc(n + 1, sizeof(char*));
  int    o   = 0;

  for (int ix = 0; ix < n; ix++)
  {
    if ((strncmp(environ[ix], "CORAINE_", 8) == 0) || (strncmp(environ[ix], "SEAMWARE_PLUGIN_DIR=", 20) == 0))
      continue;
    env[o++] = environ[ix];
  }
  env[o] = NULL;

  return env;
}



// -----------------------------------------------------------------------------
//
// ckanMember - the ckan bridge's member of the bridge configuration: one record Channel per dataset of
// the broker, its mapping as www/data/ckan.json has it; the datasets of one portal
//
static bool ckanMember(const Def* dP, Str* sP, char* err, int errLen)
{
  char path[4200];
  snprintf(path, sizeof(path), "%s/data/ckan.json", c3WwwDir);

  FILE* fP = fopen(path, "r");
  if (fP == NULL)
  {
    snprintf(err, errLen, "cannot read %s: %s", path, strerror(errno));
    return false;
  }

  Str  text = { NULL, 0, 0 };
  char buf[4096];
  int  n;
  while ((n = fread(buf, 1, sizeof(buf), fP)) > 0)
    strAddN(&text, buf, n);
  fclose(fP);

  CorAlloc alloc;
  char     allocBuf[32 * 1024];
  CorJson  json;
  bool     ok     = false;
  char*    portal = NULL;
  int      found  = 0;

  corAllocBufferInit(&alloc, allocBuf, sizeof(allocBuf), 64 * 1024, NULL, "c3 ckan");
  corJsonCreate(&json, &alloc);

  CorNode* treeP     = (text.s != NULL) ? corJsonParse(&json, corAllocStrdup(&alloc, text.s)) : NULL;
  CorNode* datasetsP = (treeP != NULL) ? corTreeLookup(treeP, "datasets") : NULL;

  if ((datasetsP == NULL) || (datasetsP->type != CorArray))
  {
    snprintf(err, errLen, "%s: no \"datasets\" list", path);
    goto done;
  }

  Str records = { NULL, 0, 0 };
  strAdd(&records, "");
  for (CorNode* dsP = datasetsP->value.head; dsP != NULL; dsP = dsP->next)
  {
    CorNode* idP       = corTreeLookup(dsP, "id");
    CorNode* portalP   = corTreeLookup(dsP, "portal");
    CorNode* resourceP = corTreeLookup(dsP, "resource");
    CorNode* entitiesP = corTreeLookup(dsP, "entities");

    if ((idP == NULL) || (idP->type != CorString) || !listHas(dP->ckan, idP->value.s))
      continue;

    if ((portalP == NULL) || (portalP->type != CorString) || (resourceP == NULL) || (resourceP->type != CorString) || (entitiesP == NULL))
    {
      snprintf(err, errLen, "%s: the dataset '%s' lacks its portal, resource or entities", path, idP->value.s);
      strFree(&records);
      goto done;
    }

    if ((portal != NULL) && (strcmp(portal, portalP->value.s) != 0))
    {
      snprintf(err, errLen, "the CKAN datasets of one broker come from one portal - %s and %s", portal, portalP->value.s);
      strFree(&records);
      goto done;
    }
    portal = portalP->value.s;

    char* name = entitiesP->name;               // the value alone, not the member
    entitiesP->name = NULL;
    int   size = corJsonRenderSize(&json, entitiesP) + 1;
    char* out  = malloc(size);
    corJsonRender(&json, entitiesP, out);
    entitiesP->name = name;

    strAdd(&records, (found > 0) ? ", " : "");
    strAddJson(&records, resourceP->value.s);
    strAdd(&records, ": {\"channelInfo\": [{\"key\": \"mode\", \"value\": \"once\"}, {\"key\": \"pageSize\", \"value\": \"100\"}], \"entities\": ");
    strAdd(&records, out);
    strAdd(&records, "}");
    free(out);
    found++;
  }

  if (found == 0)
  {
    snprintf(err, errLen, "none of the CKAN datasets '%s' is in %s", dP->ckan, path);
    strFree(&records);
    goto done;
  }

  strAdd(sP, "\"ckan\": {\"server\": {\"url\": ");
  strAddJson(sP, portal);
  strAddf(sP, ", \"timeoutMs\": 30000}, \"ngsild\": {\"defaultEntity\": false, \"records\": {%s}}}", records.s);
  strFree(&records);
  ok = true;

 done:
  corAllocBufferReset(&alloc, false);
  strFree(&text);
  return ok;
}



// -----------------------------------------------------------------------------
//
// opcuaMemberWrite - the opcua bridge's member of a bridge configuration: its "server" - the URL, the
// SecureChannel, the user (the password as the file pwPath) - its Channels, and an AssetChannel per model (a
// line each: the Object's NodeId, attributeLayout, channelDirection - opcuaModelsJson)
//
static void opcuaModelsJson(Str* sP, const char* models, bool keyed);

static void opcuaMemberWrite(const Def* dP, const char* pwPath, const char* models, Str* sP)
{
  strAdd(sP, "\"opcua\": {\"server\": {\"url\": ");
  strAddJson(sP, dP->opcua.url);

  if ((dP->opcua.mode[0] != 0) && (strcmp(dP->opcua.mode, "None") != 0))
  {
    strAdd(sP, ", \"security\": {\"mode\": ");      strAddJson(sP, dP->opcua.mode);
    if (dP->opcua.policy[0] != 0)
    {
      strAdd(sP, ", \"policy\": ");                 strAddJson(sP, dP->opcua.policy);
    }
    strAdd(sP, ", \"certificate\": ");              strAddJson(sP, dP->opcua.certificate);
    strAdd(sP, ", \"privateKey\": ");               strAddJson(sP, dP->opcua.privateKey);
    strAdd(sP, ", \"applicationUri\": ");           strAddJson(sP, dP->opcua.applicationUri);
    strAdd(sP, ", \"trustList\": ");                linesJson(sP, dP->opcua.trustList);
    if (dP->opcua.trustAny)
      strAdd(sP, ", \"trustAny\": true");
    strAdd(sP, "}");
  }

  if (dP->opcua.username[0] != 0)
  {
    strAdd(sP, ", \"user\": {\"username\": ");      strAddJson(sP, dP->opcua.username);
    strAdd(sP, ", \"passwordFile\": ");             strAddJson(sP, pwPath);
    strAdd(sP, "}");
  }

  strAdd(sP, "}, \"ngsild\": {\"defaultEntity\": false, \"topics\": ");
  channelsJson(sP, dP->opcua.channels, true);
  strAdd(sP, ", \"assetChannels\": ");
  opcuaModelsJson(sP, models, true);
  strAdd(sP, "}}");
}



//
// opcuaMember - a broker's opcua member: its password the file c3 keeps it in, an AssetChannel per model root,
// every Object of it an entity, its attributes as the bridge names them, read-only
//
static void opcuaMember(const Def* dP, Str* sP)
{
  char  pwPath[2400];
  char  models[8192] = "";
  char  copy[2048];
  char* save = NULL;
  int   len  = 0;

  opcuaPasswordPath(dP->name, pwPath, sizeof(pwPath));

  snprintf(copy, sizeof(copy), "%s", dP->opcua.roots);
  for (char* t = strtok_r(copy, "\n", &save); (t != NULL) && (len < (int) sizeof(models) - 1); t = strtok_r(NULL, "\n", &save))
    len += snprintf(&models[len], sizeof(models) - len, "%s%s\tattributes\tin", (len > 0) ? "\n" : "", t);

  opcuaMemberWrite(dP, pwPath, models, sP);
}



// -----------------------------------------------------------------------------
//
// ddsContextWriteTo - an @context: each entity type and attribute the DDS mapping names, a term in the
// vocabulary (<vocabulary><term>) - the broker's default user @context (--defaultUserContext); ddsContextWrite:
// a broker's dds-context.jsonld, in its directory
//
static bool ddsContextWriteTo(const Def* dP, const char* path, char* err, int errLen)
{
  Str         s     = { NULL, 0, 0 };
  const char* sets[3] = { dP->dds.topics, dP->dds.services, dP->dds.actions };
  char        seen[16384] = "\n";
  bool        first = true;

  strAdd(&s, "{\n  \"@context\": {");

  for (int set = 0; set < 3; set++)
  {
    char  copy[16384];
    char* save = NULL;

    snprintf(copy, sizeof(copy), "%s", sets[set]);
    for (char* line = strtok_r(copy, "\n", &save); line != NULL; line = strtok_r(NULL, "\n", &save))
    {
      char* f[4];
      char* fsave = NULL;
      int   n     = 0;

      for (char* t = strtok_r(line, "\t", &fsave); (t != NULL) && (n < 4); t = strtok_r(NULL, "\t", &fsave))
        f[n++] = t;

      if (n != 4)
        continue;

      for (int ix = 2; ix < 4; ix++)               // the entity type, the attribute
      {
        char key[300];
        int  len = strlen(seen);

        snprintf(key, sizeof(key), "\n%s\n", f[ix]);
        if ((strstr(seen, key) != NULL) || (len + (int) strlen(f[ix]) + 2 >= (int) sizeof(seen)))
          continue;
        snprintf(&seen[len], sizeof(seen) - len, "%s\n", f[ix]);

        strAdd(&s, first ? "\n    " : ",\n    ");
        strAddJson(&s, f[ix]);
        strAdd(&s, ": ");
        char iri[1024];
        snprintf(iri, sizeof(iri), "%s%s", dP->dds.vocabulary, f[ix]);
        strAddJson(&s, iri);
        first = false;
      }
    }
  }

  strAdd(&s, first ? "}\n}\n" : "\n  }\n}\n");

  int  fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  bool ok = (fd != -1) && (write(fd, s.s, s.len) == s.len);
  if (fd != -1)
    close(fd);
  strFree(&s);

  if (!ok)
    snprintf(err, errLen, "cannot write %s: %s", path, strerror(errno));
  return ok;
}



static bool ddsContextWrite(const Def* dP, char* err, int errLen)
{
  char path[2400];

  ddsContextPath(dP->name, path, sizeof(path));
  return ddsContextWriteTo(dP, path, err, errLen);
}



// -----------------------------------------------------------------------------
//
// ddsMember - "dds": the dds bridge's configuration - how the DDS Enabler reaches the DDS system (ddsmodule: the
// domain, the transport, the interfaces) and the mapping (ngsild: topics, services, actions); typesDir: where the
// bridge keeps the DDS types it discovers (NULL: not kept)
//
static void ddsMember(Str* sP, const Def* dP, const char* typesDir)
{
  strAddf(sP, "\"dds\": {\"ddsmodule\": {\"dds\": {\"domain\": %d", dP->dds.domain);
  if (dP->dds.transport[0] != 0)
  {
    strAdd(sP, ", \"transport\": ");
    strAddJson(sP, dP->dds.transport);
  }
  if (dP->dds.interfaces[0] != 0)
  {
    strAdd(sP, ", \"whitelist-interfaces\": ");
    csvJson(sP, dP->dds.interfaces);
  }
  strAdd(sP, "}, \"specs\": {\"threads\": 4, \"logging\": {\"verbosity\": \"warning\"}}}, \"ngsild\": {\"topics\": ");
  rowsJson(sP, dP->dds.topics, ddsTopicNames, 4, true);
  if (dP->dds.services[0] != 0)
  {
    strAdd(sP, ", \"services\": ");
    rowsJson(sP, dP->dds.services, ddsServiceNames, 6, true);
  }
  if (dP->dds.actions[0] != 0)
  {
    strAdd(sP, ", \"actions\": ");
    rowsJson(sP, dP->dds.actions, ddsActionNames, 5, true);
  }
  if (typesDir != NULL)
  {
    dirsMake(typesDir);                            // the bridge writes in it, it makes none
    strAdd(sP, ", \"typesDirectory\": ");
    strAddJson(sP, typesDir);
  }
  strAdd(sP, "}}");
}



// -----------------------------------------------------------------------------
//
// bridgesConfigWrite - the bridge configuration c3 writes: the MQTT bridge for the set's Mosquitto (no
// Channels, the server only - notifications to mqtt:// work), the DDS bridge with its domain and the mapping
// (topics, services, actions - the types it discovers kept in the broker's directory, natively), the CKAN
// datasets of the broker, and its OPC UA server (opcuaMember). With a DDS vocabulary, the @context of the
// terms mapped too (ddsContextWrite)
//
static bool bridgesConfigWrite(const Def* dP, int port, char* err, int errLen)
{
  char path[2400];
  char dir[2300];
  char svc[96];
  Str  s = { NULL, 0, 0 };

  brokerDir(dP->name, dir, sizeof(dir));
  snprintf(path, sizeof(path), "%s/bridges.json", dir);

  strAdd(&s, "{");
  if (hasBridge(dP, "mqtt"))
  {
    svcName(dP->set, KIND_MOSQUITTO, svc, sizeof(svc));
    if ((strcmp(dP->where, "container") == 0) && !hasBridge(dP, "dds"))   // with dds: the host's network (argvMake)
      strAddf(&s, "\"mqtt\": {\"server\": {\"uri\": \"mqtt://%s:%d\", \"clientId\": \"c3-%s\"}, \"ngsild\": {\"topics\": {}}}", svc, kinds[KIND_MOSQUITTO].port, dP->name);
    else
      strAddf(&s, "\"mqtt\": {\"server\": {\"uri\": \"mqtt://127.0.0.1:%d\", \"clientId\": \"c3-%s\"}, \"ngsild\": {\"topics\": {}}}", port, dP->name);
  }
  if (hasBridge(dP, "dds"))
  {
    char types[2400];

    snprintf(types, sizeof(types), "%s/dds-types", dir);
    strAdd(&s, (s.len > 1) ? ", " : "");
    ddsMember(&s, dP, (strcmp(dP->where, "container") != 0) ? types : NULL);
  }
  if (dP->ckan[0] != 0)
  {
    strAdd(&s, (s.len > 1) ? ", " : "");
    if (ckanMember(dP, &s, err, errLen) == false)
    {
      strFree(&s);
      return false;
    }
  }
  if (dP->opcua.url[0] != 0)
  {
    char        pwPath[2400];
    struct stat st;

    opcuaPasswordPath(dP->name, pwPath, sizeof(pwPath));

    if ((dP->opcua.username[0] != 0) && (stat(pwPath, &st) != 0))
    {
      snprintf(err, errLen, "the OPC UA user '%s' has no password: give it once, c3 keeps it", dP->opcua.username);
      strFree(&s);
      return false;
    }

    strAdd(&s, (s.len > 1) ? ", " : "");
    opcuaMember(dP, &s);
  }
  strAdd(&s, "}\n");

  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  bool ok = (fd != -1) && (write(fd, s.s, s.len) == s.len);
  if (fd != -1)
    close(fd);
  strFree(&s);

  if (!ok)
  {
    snprintf(err, errLen, "cannot write %s: %s", path, strerror(errno));
    return false;
  }

  if (hasBridge(dP, "dds") && (dP->dds.vocabulary[0] != 0))
    return ddsContextWrite(dP, err, errLen);

  return true;
}



// -----------------------------------------------------------------------------
//
// startThread - a broker started: its services first, then the broker - natively or in a container
//
static void startFail(Broker* bP, const char* why)
{
  logLine(bP->logPath, "not started: %s", why);

  pthread_mutex_lock(&rMutex);
  snprintf(bP->state, sizeof(bP->state), "failed");
  snprintf(bP->why, sizeof(bP->why), "%s", why);
  bP->ended = time(NULL);
  bP->busy  = false;
  pthread_mutex_unlock(&rMutex);
}

static void* startThread(void* vP)
{
  Broker* bP = (Broker*) vP;
  Def     d;
  char    err[1024] = "";
  int     ports[KINDS] = { 0, 0, 0 };
  char    dir[2300];

  pthread_mutex_lock(&rMutex);
  d = bP->def;
  pthread_mutex_unlock(&rMutex);

  brokerDir(d.name, dir, sizeof(dir));

  //
  // The services, each up and ready before the broker
  //
  int mask = needs(&d);
  for (int k = 0; k < KINDS; k++)
  {
    if ((mask & (1 << k)) == 0)
      continue;

    if (engine[0] == 0)
    {
      snprintf(err, sizeof(err), "%s needs %s in a container: %s", d.name, kinds[k].label, engineWhy);
      startFail(bP, err);
      return NULL;
    }

    char svc[96];
    svcName(d.set, k, svc, sizeof(svc));
    logLine(bP->logPath, "%s (%s) for %s", svc, kinds[k].label, d.name);

    pthread_mutex_lock(&rMutex);
    snprintf(bP->usedSvc[k], sizeof(bP->usedSvc[k]), "%s", svc);
    pthread_mutex_unlock(&rMutex);

    ports[k] = svcEnsure(d.set, k, bP->logPath, err, sizeof(err));
    if (ports[k] < 0)
    {
      startFail(bP, err);
      svcRelease(bP);
      return NULL;
    }
  }

  if ((bridgesConfigOwn(&d) == true) && (bridgesConfigWrite(&d, ports[KIND_MOSQUITTO], err, sizeof(err)) == false))
  {
    startFail(bP, err);
    svcRelease(bP);
    return NULL;
  }

  //
  // The broker
  //
  Argv a = { { NULL }, 0 };
  if (argvMake(&d, ports, false, &a, err, sizeof(err)) == false)
  {
    argFree(&a);
    startFail(bP, err);
    svcRelease(bP);
    return NULL;
  }

  Str cmd = { NULL, 0, 0 };
  argCommand(&a, &cmd);
  logLine(bP->logPath, "%s", cmd.s);
  strFree(&cmd);

  if (strcmp(d.where, "container") == 0)
  {
    char out[2048];
    char name[96];
    char vol[96];

    brokerContainer(d.name, name, sizeof(name));
    brokerVolume(d.name, vol, sizeof(vol));

    if ((networkEnsure(err, sizeof(err)) == false) || (imageEnsure(d.image, bP->logPath, err, sizeof(err)) == false))
    {
      argFree(&a);
      startFail(bP, err);
      svcRelease(bP);
      return NULL;
    }

    engineRun(out, sizeof(out), 30, "rm", "-f", name, NULL);    // c3's own, from a run before
    if (d.dbDir)
    {
      char label[128];
      snprintf(label, sizeof(label), "c3.broker=%s", d.name);
      engineRun(out, sizeof(out), 30, "volume", "create", "--label", "c3=run", "--label", label, vol, NULL);
    }

    int status = engineArgv(&a, out, sizeof(out), 120);
    argFree(&a);

    if (status != 0)
    {
      snprintf(err, sizeof(err), "%s run: %.600s", engineName, out);
      startFail(bP, err);
      svcRelease(bP);
      return NULL;
    }

    logLine(bP->logPath, "container %s (%.12s)", name, out);
    pid_t f = followerStart(name, bP->logPath);

    pthread_mutex_lock(&rMutex);
    snprintf(bP->container, sizeof(bP->container), "%s", name);
    bP->follower = f;
    bP->pid      = 0;
  }
  else
  {
    if (d.dbDir)
    {
      char data[2400];
      brokerDataDir(d.name, data, sizeof(data));
      dirsMake(data);
    }

    int fd = open(bP->logPath, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
    if (fd == -1)
    {
      argFree(&a);
      snprintf(err, sizeof(err), "cannot open %s: %s", bP->logPath, strerror(errno));
      startFail(bP, err);
      svcRelease(bP);
      return NULL;
    }

    //
    // A session of its own: no terminal, nothing of c3's process group - it outlives c3, which reaps it
    // while it runs and attaches to it again after a restart
    //
    char**    env = cleanEnv();
    ProcSpawn sp  = { a.v, env, fd, dir, false, true, 0 };
    pid_t     pid = procSpawn(&sp);
    free(env);
    close(fd);
    argFree(&a);

    if (pid < 0)
    {
      snprintf(err, sizeof(err), "fork: %s", strerror(errno));
      startFail(bP, err);
      svcRelease(bP);
      return NULL;
    }

    long long ps = 0;
    for (int ix = 0; (ix < 50) && (ps == 0); ix++)       // /proc has it as soon as fork returned - but a moment, at most
    {
      ps = procStartTime(pid);
      if (ps == 0)
        usleep(10 * 1000);
    }

    pthread_mutex_lock(&rMutex);
    bP->pid       = pid;
    bP->child     = true;
    bP->procStart = ps;
    bP->container[0] = 0;
    stateSave(bP);
    logLine(bP->logPath, "pid %d - stop: SIGTERM to its process group, SIGKILL %d s later", (int) pid, d.grace);
  }

  snprintf(bP->state, sizeof(bP->state), "running");
  bP->started  = time(NULL);
  bP->busy     = false;
  bP->ready[0] = 0;
  pthread_mutex_unlock(&rMutex);

  return NULL;
}



// -----------------------------------------------------------------------------
//
// stopThread - SIGTERM (corDB syncs its log and writes its snapshots), SIGKILL when the grace period is over;
// then the services nothing else uses
//
static bool brokerAlive(Broker* bP)              // rMutex held; the monitor reaps
{
  if (bP->container[0] != 0)
    return (strcmp(bP->state, "stopping") == 0) || (strcmp(bP->state, "running") == 0);
  return bP->pid > 0;
}

static void* stopThread(void* vP)
{
  Broker* bP = (Broker*) vP;
  char    out[1024];

  pthread_mutex_lock(&rMutex);
  int   grace = bP->def.grace;
  pid_t pid   = bP->pid;
  char  container[96];
  snprintf(container, sizeof(container), "%s", bP->container);
  bP->grace     = grace;
  bP->stopAsked = time(NULL);
  bP->killed    = false;
  pthread_mutex_unlock(&rMutex);

  if (container[0] != 0)
  {
    //
    // The engine does the same: SIGTERM, SIGKILL after -t seconds
    //
    char t[16];
    snprintf(t, sizeof(t), "%d", grace);
    logLine(bP->logPath, "%s stop -t %d %s", engineName, grace, container);
    engineRun(out, sizeof(out), grace + 30, "stop", "-t", t, container, NULL);

    char code[64]  = "";
    char oom[64]   = "";
    engineRun(code, sizeof(code), 20, "inspect", "--format", "{{.State.ExitCode}}", container, NULL);
    engineRun(oom, sizeof(oom), 20, "inspect", "--format", "{{.State.OOMKilled}}", container, NULL);
    engineRun(out, sizeof(out), 30, "rm", container, NULL);

    pthread_mutex_lock(&rMutex);
    bP->exitStatus = atoi(code);
    bP->killed     = (bP->exitStatus == 137);
    if (bP->killed)
      snprintf(bP->why, sizeof(bP->why), "stopped - killed after %d s (SIGKILL)", grace);
    else
      snprintf(bP->why, sizeof(bP->why), "stopped - exit status %d", bP->exitStatus);
    snprintf(bP->state, sizeof(bP->state), "stopped");
    bP->container[0] = 0;
    bP->ended    = time(NULL);
    bP->ready[0] = 0;
    free(bP->report);
    bP->report   = NULL;
    pthread_mutex_unlock(&rMutex);
    logLine(bP->logPath, "%s", bP->why);
  }
  else if (pid > 0)
  {
    logLine(bP->logPath, "SIGTERM to %d - SIGKILL in %d s if it has not stopped", (int) pid, grace);
    kill(-pid, SIGTERM);

    bool alive = true;
    for (int ix = 0; alive; ix++)
    {
      usleep(100 * 1000);

      pthread_mutex_lock(&rMutex);
      alive = brokerAlive(bP);
      if (alive && !bP->killed && (time(NULL) - bP->stopAsked >= grace))
      {
        kill(-pid, SIGKILL);
        bP->killed = true;
        pthread_mutex_unlock(&rMutex);
        logLine(bP->logPath, "the grace period of %d s is over: SIGKILL to %d", grace, (int) pid);
        continue;
      }
      pthread_mutex_unlock(&rMutex);

      if (ix > (grace + 10) * 10)
        break;
    }
  }

  svcRelease(bP);

  pthread_mutex_lock(&rMutex);
  bP->busy = false;
  pthread_mutex_unlock(&rMutex);

  return NULL;
}



// -----------------------------------------------------------------------------
//
// threadStart - a detached thread
//
static bool threadStart(void* (*fn)(void*), void* arg)
{
  pthread_t      tid;
  pthread_attr_t attr;

  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  int r = pthread_create(&tid, &attr, fn, arg);
  pthread_attr_destroy(&attr);

  return r == 0;
}



// -----------------------------------------------------------------------------
//
// brokerEnded - a native broker's process is gone (rMutex held). 'status' as waitpid gives it; -1: not known
// (a broker c3 attached to after a restart is not its child)
//
static void brokerEnded(Broker* bP, int status)
{
  time_t now = time(NULL);
  long   ran = (bP->started != 0) ? (long) (now - bP->started) : 0;
  char   what[128];

  bP->exitStatus = (status != -1) && WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  bP->termSignal = (status != -1) && WIFSIGNALED(status) ? WTERMSIG(status) : 0;

  if (status == -1)
    snprintf(what, sizeof(what), "it ended (its exit status is not known: c3 attached to it after a restart)");
  else if (bP->termSignal != 0)
    snprintf(what, sizeof(what), "killed by signal %d", bP->termSignal);
  else
    snprintf(what, sizeof(what), "exit status %d", bP->exitStatus);

  if (strcmp(bP->state, "stopping") == 0)
  {
    snprintf(bP->state, sizeof(bP->state), "stopped");
    if (bP->killed)
      snprintf(bP->why, sizeof(bP->why), "stopped - killed after its grace period of %d s (SIGKILL)", bP->grace);
    else
      snprintf(bP->why, sizeof(bP->why), "stopped %ld s after SIGTERM - %s", (long) (now - bP->stopAsked), what);
  }
  else
  {
    bool clean = (bP->exitStatus == 0);
    snprintf(bP->state, sizeof(bP->state), clean ? "exited" : "failed");
    snprintf(bP->why, sizeof(bP->why), "ended by itself after %ld s - %s%s", ran, what, clean ? "" : " - the log says why");
  }

  logLine(bP->logPath, "%s", bP->why);

  bP->pid      = 0;
  bP->child    = false;
  bP->ended    = now;
  bP->ready[0] = 0;
  free(bP->report);
  bP->report   = NULL;
  stateClear(bP->def.name);
}



// -----------------------------------------------------------------------------
//
// procWatch - the native brokers: reaped (c3's children) or looked for (attached); the log followers reaped
//
static void procWatch(void)
{
  pthread_mutex_lock(&rMutex);

  for (int ix = 0; ix < nBrokers; ix++)
  {
    Broker* bP = brokers[ix];

    if (bP->pid > 0)
    {
      if (bP->child)
      {
        int   status;
        pid_t w = waitpid(bP->pid, &status, WNOHANG);

        if (w == bP->pid)
          brokerEnded(bP, status);
        else if ((w == -1) && (errno == ECHILD))
          brokerEnded(bP, -1);
      }
      else if (procStartTime(bP->pid) != bP->procStart)
        brokerEnded(bP, -1);
    }

    if ((bP->follower > 0) && (waitpid(bP->follower, NULL, WNOHANG) == bP->follower))
      bP->follower = 0;
  }

  for (int ix = 0; ix < nSvcs; ix++)
  {
    if ((svcs[ix].follower > 0) && (waitpid(svcs[ix].follower, NULL, WNOHANG) == svcs[ix].follower))
      svcs[ix].follower = 0;
  }

  pthread_mutex_unlock(&rMutex);
}



// -----------------------------------------------------------------------------
//
// engineScan - c3's containers and volumes as the engine has them: the services' state and ports, the
// container brokers' state; a container that runs gets its log follower (also after a restart of c3)
//
static int portOf(const char* ports, int inner)
{
  char  key[32];
  snprintf(key, sizeof(key), "->%d/tcp", inner);

  const char* hit = strstr(ports, key);
  if (hit == NULL)
    return 0;

  const char* p = hit;
  while ((p > ports) && (p[-1] != ':'))
    --p;

  return atoi(p);
}

static void engineScan(void)
{
  static char out[64 * 1024];
  static char vols[16 * 1024];

  if (engine[0] == 0)
    return;

  if (engineRun(out, sizeof(out), 20, "ps", "-a", "--filter", "label=c3=run", "--format",
                "{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Label \"c3.kind\"}}\t{{.Label \"c3.set\"}}\t{{.Label \"c3.service\"}}\t{{.Label \"c3.broker\"}}\t{{.Ports}}", NULL) != 0)
    return;
  if (engineRun(vols, sizeof(vols), 20, "volume", "ls", "--filter", "label=c3=run", "--format", "{{.Name}}", NULL) != 0)
    vols[0] = 0;

  pthread_mutex_lock(&rMutex);

  bool svcSeen[SERVICES_MAX]   = { false };
  bool brokerSeen[BROKERS_MAX] = { false };

  char* save = NULL;
  for (char* line = strtok_r(out, "\n", &save); line != NULL; line = strtok_r(NULL, "\n", &save))
  {
    char* f[8] = { NULL };
    int   n    = 0;
    char* p    = line;

    while ((n < 8) && (p != NULL))
    {
      f[n++] = p;
      p = strchr(p, '\t');
      if (p != NULL)
        *p++ = 0;
    }
    if (n < 8)
      continue;

    const char* name  = f[0];
    const char* state = f[1];

    if (strcmp(f[3], "service") == 0)
    {
      int kind = -1;
      for (int k = 0; k < KINDS; k++)
      {
        if (strcmp(kinds[k].id, f[5]) == 0)
          kind = k;
      }
      if ((kind == -1) || (f[4][0] == 0))
        continue;

      Service* sP = svcGet(f[4], kind);
      if ((sP == NULL) || (strcmp(sP->container, name) != 0))
        continue;

      svcSeen[sP - svcs] = true;
      snprintf(sP->status, sizeof(sP->status), "%s", f[2]);
      if (sP->busy == false)
        snprintf(sP->state, sizeof(sP->state), "%s", state);

      int port = portOf(f[7], kinds[kind].port);
      if (port > 0)
        sP->hostPort = port;

      if ((strcmp(state, "running") == 0) && (sP->follower == 0) && (sP->busy == false))
        sP->follower = followerStart(sP->container, sP->logPath);
    }
    else if (strcmp(f[3], "broker") == 0)
    {
      Broker* bP = brokerFind(f[6]);
      if ((bP == NULL) || (strcmp(bP->def.where, "container") != 0))
        continue;

      for (int ix = 0; ix < nBrokers; ix++)
      {
        if (brokers[ix] == bP)
          brokerSeen[ix] = true;
      }

      if (bP->busy)
        continue;

      if (strcmp(state, "running") == 0)
      {
        if (strcmp(bP->state, "running") != 0)
        {
          snprintf(bP->state, sizeof(bP->state), "running");     // attached: it ran when c3 started
          snprintf(bP->container, sizeof(bP->container), "%s", name);
          bP->why[0] = 0;
          if (bP->started == 0)
            bP->started = time(NULL);
        }
        if (bP->follower == 0)
          bP->follower = followerStart(name, bP->logPath);
      }
      else if (strcmp(bP->state, "running") == 0)
      {
        int code = -1;
        const char* ex = strstr(f[2], "Exited (");
        if (ex != NULL)
          code = atoi(ex + 8);

        bP->exitStatus = code;
        snprintf(bP->state, sizeof(bP->state), (code == 0) ? "exited" : "failed");
        snprintf(bP->why, sizeof(bP->why), "the container ended by itself - %s%s", f[2], (code == 0) ? "" : " - the log says why");
        bP->ended    = time(NULL);
        bP->ready[0] = 0;
        logLine(bP->logPath, "%s", bP->why);
      }
    }
  }

  //
  // Not there at all
  //
  for (int ix = 0; ix < nSvcs; ix++)
  {
    Service* sP = &svcs[ix];

    if ((svcSeen[ix] == false) && (sP->busy == false))
    {
      snprintf(sP->state, sizeof(sP->state), "absent");
      sP->status[0] = 0;
    }

    char  copy[sizeof(vols)];
    char* vs = NULL;
    sP->volumeExists = false;
    snprintf(copy, sizeof(copy), "%s", vols);
    for (char* v = strtok_r(copy, "\n", &vs); v != NULL; v = strtok_r(NULL, "\n", &vs))
    {
      if (strcmp(v, sP->volume) == 0)
        sP->volumeExists = true;
    }
  }

  for (int ix = 0; ix < nBrokers; ix++)
  {
    Broker* bP = brokers[ix];

    if ((strcmp(bP->def.where, "container") != 0) || bP->busy)
      continue;

    if ((brokerSeen[ix] == false) && (strcmp(bP->state, "running") == 0))
    {
      snprintf(bP->state, sizeof(bP->state), "exited");
      snprintf(bP->why, sizeof(bP->why), "its container is gone");
      bP->container[0] = 0;
      bP->ended        = time(NULL);
      bP->ready[0]     = 0;
    }
  }

  pthread_mutex_unlock(&rMutex);
}



// -----------------------------------------------------------------------------
//
// healthProbe - each broker that runs: the health port's /ready (its answer is the report), else /version
//
static void healthProbe(void)
{
  char names[BROKERS_MAX][65];
  char urls[BROKERS_MAX][128];
  bool hp[BROKERS_MAX];
  int  n = 0;

  pthread_mutex_lock(&rMutex);
  for (int ix = 0; ix < nBrokers; ix++)
  {
    Broker* bP = brokers[ix];

    if ((strcmp(bP->state, "running") != 0) && (strcmp(bP->state, "stopping") != 0))
      continue;

    snprintf(names[n], sizeof(names[n]), "%s", bP->def.name);
    hp[n] = (bP->def.healthPort > 0);
    if (hp[n])
      snprintf(urls[n], sizeof(urls[n]), "http://127.0.0.1:%d/ready", bP->def.healthPort);
    else
      snprintf(urls[n], sizeof(urls[n]), "http://127.0.0.1:%d/version", bP->def.port);
    ++n;
  }
  pthread_mutex_unlock(&rMutex);

  if (n == 0)
    return;

  CorRestClientMulti* multiP = corRestClientMultiCreate(n);
  if (multiP == NULL)
    return;

  corRestClientMultiMaxResponse(multiP, 256 * 1024);

  int index[BROKERS_MAX];
  for (int ix = 0; ix < n; ix++)
    index[ix] = corRestClientMultiAdd(multiP, CorVerbGet, urls[ix], NULL, 0, NULL, 0, NULL, NULL);

  corRestClientMultiPerform(multiP, 1500);

  pthread_mutex_lock(&rMutex);
  for (int ix = 0; ix < n; ix++)
  {
    Broker* bP = brokerFind(names[ix]);
    if (bP == NULL)
      continue;

    CorRestClientResponse* respP = (index[ix] >= 0) ? corRestClientMultiResponse(multiP, index[ix]) : NULL;
    int                    code  = ((respP != NULL) && (respP->error == 0)) ? respP->statusCode : 0;

    if (code == 0)
      snprintf(bP->ready, sizeof(bP->ready), "no answer");
    else if (hp[ix])
      snprintf(bP->ready, sizeof(bP->ready), (code == 200) ? "ready" : "not ready");
    else
      snprintf(bP->ready, sizeof(bP->ready), (code == 200) ? "answers" : "not ready");

    free(bP->report);
    bP->report = NULL;
    if ((code != 0) && (respP->body != NULL) && ((respP->body[0] == '{') || (respP->body[0] == '[')))
      bP->report = strndup(respP->body, respP->bodyLen);
    bP->reportAt = time(NULL);
  }
  pthread_mutex_unlock(&rMutex);

  corRestClientMultiDestroy(multiP);
}



// -----------------------------------------------------------------------------
//
// tail - a log's new complete lines to the pages following it (rMutex held)
//
static void tail(const char* path, int64_t* endP, SseSubs* subsP, time_t* beatP)
{
  if (subsP->n == 0)
    return;

  time_t      now = time(NULL);
  struct stat st;

  if (stat(path, &st) != 0)
    st.st_size = 0;

  if (st.st_size < *endP)                        // a new run's log (the old one is .1), or the file made again
  {
    sseSubsSend(subsP, "event: reset\ndata: \n\n", 21);
    *endP = 0;
  }

  if (st.st_size > *endP)
  {
    int64_t want = st.st_size - *endP;
    if (want > 1024 * 1024)
      want = 1024 * 1024;

    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd != -1)
    {
      char*   buf = malloc(want);
      ssize_t got = pread(fd, buf, want, *endP);
      close(fd);

      int take = 0;
      for (int ix = (int) got - 1; ix >= 0; ix--)
      {
        if (buf[ix] == '\n')
        {
          take = ix + 1;
          break;
        }
      }
      if ((take == 0) && (got >= 64 * 1024))
        take = got;                              // a line too long to wait for

      if (take > 0)
      {
        Str s = { NULL, 0, 0 };
        *endP += take;
        sseLines(&s, buf, take, *endP);
        sseSubsSend(subsP, s.s, s.len);
        strFree(&s);
        *beatP = now;
      }
      free(buf);
    }
  }

  if (now - *beatP >= 15)
  {
    sseSubsSend(subsP, ":\n\n", 3);              // a comment: the page knows the stream is alive
    *beatP = now;
  }
}

static void tailAll(void)
{
  pthread_mutex_lock(&rMutex);
  for (int ix = 0; ix < nBrokers; ix++)
    tail(brokers[ix]->logPath, &brokers[ix]->logEnd, &brokers[ix]->subs, &brokers[ix]->lastBeat);
  for (int ix = 0; ix < nSvcs; ix++)
    tail(svcs[ix].logPath, &svcs[ix].logEnd, &svcs[ix].subs, &svcs[ix].lastBeat);
  pthread_mutex_unlock(&rMutex);
}



// -----------------------------------------------------------------------------
//
// monitorThread -
//
static void* monitorThread(void* vP)
{
  (void) vP;

  for (long tick = 0; stopping == false; tick++)
  {
    procWatch();

    if (tick % 4 == 0)
    {
      engineScan();
      healthProbe();
    }

    tailAll();
    usleep(TICK_MS * 1000);
  }

  return NULL;
}



// -----------------------------------------------------------------------------
//
// brokerRender / svcRender (rMutex held)
//
static void brokerRender(Broker* bP, Str* sP)
{
  const Def* dP = &bP->def;
  char       t[32];
  char       path[2400];
  struct stat st;

  strAdd(sP, "{\"name\": ");    strAddJson(sP, dP->name);
  strAdd(sP, ", \"def\": ");    defRender(dP, sP);
  strAdd(sP, ", \"state\": ");  strAddJson(sP, bP->state);
  strAdd(sP, ", \"why\": ");    strAddJson(sP, (bP->why[0] != 0) ? bP->why : NULL);
  strAddf(sP, ", \"busy\": %s", bP->busy ? "true" : "false");
  if (bP->pid > 0) strAddf(sP, ", \"pid\": %d, \"attached\": %s", (int) bP->pid, bP->child ? "false" : "true");
  else             strAdd(sP, ", \"pid\": null, \"attached\": false");
  strAdd(sP, ", \"container\": ");
  if (strcmp(dP->where, "container") == 0)
  {
    char name[96];
    brokerContainer(dP->name, name, sizeof(name));
    strAddJson(sP, name);
  }
  else
    strAdd(sP, "null");
  strAddf(sP, ", \"url\": \"http://localhost:%d\"", dP->port);

  if (bP->started != 0) { isoTime(bP->started, t, sizeof(t)); strAddf(sP, ", \"started\": \"%s\"", t); }
  else                  strAdd(sP, ", \"started\": null");
  if (bP->ended != 0)   { isoTime(bP->ended, t, sizeof(t)); strAddf(sP, ", \"ended\": \"%s\"", t); }
  else                  strAdd(sP, ", \"ended\": null");

  if (strcmp(bP->state, "stopping") == 0)
  {
    long left = (long) (bP->stopAsked + bP->grace - time(NULL));
    isoTime(bP->stopAsked, t, sizeof(t));
    strAddf(sP, ", \"stop\": {\"asked\": \"%s\", \"grace\": %d, \"killIn\": %ld, \"killed\": %s}", t, bP->grace, (left > 0) ? left : 0, bP->killed ? "true" : "false");
  }
  else
    strAdd(sP, ", \"stop\": null");

  if (bP->exitStatus >= 0) strAddf(sP, ", \"exitStatus\": %d", bP->exitStatus);
  else                     strAdd(sP, ", \"exitStatus\": null");
  strAdd(sP, ", \"ready\": ");  strAddJson(sP, (bP->ready[0] != 0) ? bP->ready : NULL);
  strAdd(sP, ", \"health\": "); strAdd(sP, (bP->report != NULL) ? bP->report : "null");
  if (bP->reportAt != 0) { isoTime(bP->reportAt, t, sizeof(t)); strAddf(sP, ", \"healthAt\": \"%s\"", t); }
  else                   strAdd(sP, ", \"healthAt\": null");

  strAdd(sP, ", \"services\": [");
  int mask  = needs(dP);
  bool first = true;
  for (int k = 0; k < KINDS; k++)
  {
    if ((mask & (1 << k)) == 0)
      continue;
    char svc[96];
    svcName(dP->set, k, svc, sizeof(svc));
    strAdd(sP, first ? "" : ", ");
    strAddJson(sP, svc);
    first = false;
  }
  strAdd(sP, "]");

  strAdd(sP, ", \"log\": ");    strAddJson(sP, bP->logPath);
  brokerDir(dP->name, path, sizeof(path));
  strAdd(sP, ", \"dir\": ");    strAddJson(sP, path);

  if (strcmp(dP->where, "container") == 0)
  {
    char vol[96];
    brokerVolume(dP->name, vol, sizeof(vol));
    strAdd(sP, ", \"dataDir\": null, \"volume\": ");
    strAddJson(sP, dP->dbDir ? vol : NULL);
  }
  else
  {
    brokerDataDir(dP->name, path, sizeof(path));
    strAdd(sP, ", \"dataDir\": ");
    strAddJson(sP, dP->dbDir ? path : NULL);
    strAdd(sP, ", \"volume\": null");
    strAddf(sP, ", \"dataExists\": %s", (stat(path, &st) == 0) ? "true" : "false");
  }

  strAdd(sP, "}");
}

static void svcRender(Service* sP, Str* out)
{
  const ServiceKind* kP = &kinds[sP->kind];

  strAdd(out, "{\"container\": ");  strAddJson(out, sP->container);
  strAdd(out, ", \"set\": ");       strAddJson(out, sP->set);
  strAdd(out, ", \"service\": ");   strAddJson(out, kP->id);
  strAdd(out, ", \"label\": ");     strAddJson(out, kP->label);
  strAdd(out, ", \"image\": ");     strAddJson(out, kP->image);
  strAdd(out, ", \"state\": ");     strAddJson(out, sP->state);
  strAdd(out, ", \"status\": ");    strAddJson(out, (sP->status[0] != 0) ? sP->status : NULL);
  if (sP->hostPort > 0) strAddf(out, ", \"port\": %d", sP->hostPort);
  else                  strAdd(out, ", \"port\": null");
  strAddf(out, ", \"innerPort\": %d", kP->port);
  strAdd(out, ", \"volume\": ");    strAddJson(out, sP->volume);
  strAddf(out, ", \"volumeExists\": %s, \"busy\": %s", sP->volumeExists ? "true" : "false", sP->busy ? "true" : "false");

  strAdd(out, ", \"usedBy\": [");
  bool first = true;
  for (int ix = 0; ix < nBrokers; ix++)
  {
    Broker* bP = brokers[ix];
    bool    uses = false;

    for (int k = 0; k < KINDS; k++)
      uses = uses || (strcmp(bP->usedSvc[k], sP->container) == 0);

    if (uses && ((strcmp(bP->state, "running") == 0) || (strcmp(bP->state, "starting") == 0) || (strcmp(bP->state, "stopping") == 0)))
    {
      strAdd(out, first ? "" : ", ");
      strAddJson(out, bP->def.name);
      first = false;
    }
  }
  strAdd(out, "]");

  strAdd(out, ", \"neededBy\": [");
  first = true;
  for (int ix = 0; ix < nBrokers; ix++)
  {
    char svc[96];
    int  mask = needs(&brokers[ix]->def);

    if ((mask & (1 << sP->kind)) == 0)
      continue;
    svcName(brokers[ix]->def.set, sP->kind, svc, sizeof(svc));
    if (strcmp(svc, sP->container) != 0)
      continue;
    strAdd(out, first ? "" : ", ");
    strAddJson(out, brokers[ix]->def.name);
    first = false;
  }
  strAdd(out, "]");

  strAdd(out, ", \"log\": ");       strAddJson(out, sP->logPath);
  strAdd(out, "}");
}

static void setsRender(Str* sP)
{
  strAdd(sP, "[");
  for (int ix = 0; ix < SETS; ix++)
  {
    const SetDef* s = &sets[ix];
    Def           d;

    defDefaults(&d);
    snprintf(d.store, sizeof(d.store), "%s", s->store);
    snprintf(d.history, sizeof(d.history), "%s", s->history);
    snprintf(d.bridges, sizeof(d.bridges), "%s", s->bridges);

    strAdd(sP, (ix > 0) ? ", " : "");
    strAdd(sP, "{\"id\": ");          strAddJson(sP, s->id);
    strAdd(sP, ", \"label\": ");      strAddJson(sP, s->label);
    strAdd(sP, ", \"description\": "); strAddJson(sP, s->description);
    strAdd(sP, ", \"store\": ");      strAddJson(sP, s->store);
    strAddf(sP, ", \"dbDir\": %s", s->dbDir ? "true" : "false");
    strAdd(sP, ", \"history\": ");    strAddJson(sP, s->history);
    strAdd(sP, ", \"bridges\": [");
    if (s->bridges[0] != 0)
      strAddJson(sP, s->bridges);
    strAdd(sP, "], \"services\": [");
    int  mask  = needs(&d);
    bool first = true;
    for (int k = 0; k < KINDS; k++)
    {
      if ((mask & (1 << k)) == 0)
        continue;
      strAddf(sP, "%s{\"service\": \"%s\", \"label\": \"%s\", \"image\": \"%s\", \"container\": \"c3-%s-%s\"}", first ? "" : ", ", kinds[k].id, kinds[k].label, kinds[k].image, s->id, kinds[k].id);
      first = false;
    }
    strAdd(sP, "]}");
  }
  strAdd(sP, "]");
}



// -----------------------------------------------------------------------------
//
// runState - GET /api/run
//
static void runState(CorHttpConn* connP)
{
  Str s = { NULL, 0, 0 };

  pthread_mutex_lock(&rMutex);

  for (int ix = 0; ix < nBrokers; ix++)          // every service a kept broker needs is listed, running or not
  {
    int mask = needs(&brokers[ix]->def);
    for (int k = 0; k < KINDS; k++)
    {
      if (mask & (1 << k))
        svcGet(brokers[ix]->def.set, k);
    }
  }

  strAdd(&s, "{\"dir\": ");        strAddJson(&s, runDir);
  strAdd(&s, ", \"engine\": {\"name\": ");
  strAddJson(&s, (engine[0] != 0) ? engineName : NULL);
  strAdd(&s, ", \"path\": ");      strAddJson(&s, (engine[0] != 0) ? engine : NULL);
  strAdd(&s, ", \"version\": ");   strAddJson(&s, (engineVersion[0] != 0) ? engineVersion : NULL);
  strAdd(&s, ", \"why\": ");       strAddJson(&s, (engine[0] == 0) ? engineWhy : NULL);
  strAdd(&s, "}, \"brokers\": [");
  for (int ix = 0; ix < nBrokers; ix++)
  {
    if (ix > 0)
      strAdd(&s, ", ");
    brokerRender(brokers[ix], &s);
  }
  strAdd(&s, "], \"services\": [");
  bool first = true;
  for (int ix = 0; ix < nSvcs; ix++)
  {
    strAdd(&s, first ? "" : ", ");
    svcRender(&svcs[ix], &s);
    first = false;
  }
  strAdd(&s, "], \"sets\": ");
  setsRender(&s);
  strAdd(&s, "}");

  pthread_mutex_unlock(&rMutex);
  respondStr(connP, 200, &s);
}



// -----------------------------------------------------------------------------
//
// runSources - GET /api/run/sources: the installed broker and the builds that succeeded, with what each has
// compiled in (their --version), and the bridge plugins each one has
//
static void bridgesOf(const char* pluginDir, Str* sP)
{
  char dir[2400];
  snprintf(dir, sizeof(dir), "%s/bridge", pluginDir);

  strAdd(sP, "[");
  DIR* dP = opendir(dir);
  if (dP != NULL)
  {
    struct dirent* eP;
    bool           first = true;
    char           names[16][64];
    int            n = 0;

    while (((eP = readdir(dP)) != NULL) && (n < 16))
    {
      int len = strlen(eP->d_name);
      if ((len > 3) && (strcmp(&eP->d_name[len - 3], ".so") == 0) && (len < 60))
        snprintf(names[n++], 64, "%.*s", len - 3, eP->d_name);
    }
    closedir(dP);

    qsort(names, n, 64, (int (*)(const void*, const void*)) strcmp);
    for (int ix = 0; ix < n; ix++)
    {
      strAdd(sP, first ? "" : ", ");
      strAddJson(sP, names[ix]);
      first = false;
    }
  }
  strAdd(sP, "]");
}

static void runSources(CorHttpConn* connP)
{
  char path[2048];
  char version[4096];
  Str  s = { NULL, 0, 0 };

  installedFind(path, sizeof(path), version, sizeof(version));

  strAdd(&s, "{\"installed\": ");
  if (path[0] != 0)
  {
    const char* pd = "/opt/seamware/plugins";
    strAdd(&s, "{\"path\": ");      strAddJson(&s, path);
    strAdd(&s, ", \"version\": ");  strAddJson(&s, version);
    strAdd(&s, ", \"plugins\": ");  strAddJson(&s, pd);
    strAdd(&s, ", \"bridges\": ");  bridgesOf(pd, &s);
    strAdd(&s, "}");
  }
  else
    strAdd(&s, "null");

  strAdd(&s, ", \"builds\": [");

  char builds[2048];
  bool first = true;
  if (dataHome("builds", builds, sizeof(builds)))
  {
    DIR* dP = opendir(builds);
    if (dP != NULL)
    {
      struct dirent* eP;
      while ((eP = readdir(dP)) != NULL)
      {
        int len = strlen(eP->d_name);
        if ((len < 6) || (strcmp(&eP->d_name[len - 5], ".json") != 0) || (len > 69))
          continue;

        char name[65];
        snprintf(name, sizeof(name), "%.*s", len - 5, eP->d_name);
        if (nameOk(name) == false)
          continue;

        char* v = buildVersion(name);
        if (v == NULL)
          continue;

        char pd[2400];
        snprintf(pd, sizeof(pd), "%s/%s/install/plugins", builds, name);

        strAdd(&s, first ? "" : ", ");
        strAdd(&s, "{\"name\": ");      strAddJson(&s, name);
        strAdd(&s, ", \"version\": ");  strAddJson(&s, v);
        strAdd(&s, ", \"plugins\": ");  strAddJson(&s, pd);
        strAdd(&s, ", \"bridges\": ");  bridgesOf(pd, &s);
        strAdd(&s, "}");
        first = false;
        free(v);
      }
      closedir(dP);
    }
  }
  strAdd(&s, "], \"repository\": \"" PUBLISHED_REPO "\"}");

  respondStr(connP, 200, &s);
}



// -----------------------------------------------------------------------------
//
// bodyDef - a request's body as a broker; false with the answer given
//
static bool bodyDef(CorHttpConn* connP, Def* dP)
{
  char err[1024];

  if (connP->bodyRefused || (connP->body.s == NULL) || (connP->body.len == 0))
  {
    serveError(connP, 400, "Bad request", "a JSON object is expected as the body");
    return false;
  }

  CorJson json;
  corJsonCreate(&json, &connP->alloc);
  CorNode* bodyP = corJsonParse(&json, corAllocStrdup(&connP->alloc, connP->body.s));

  if (defParse(bodyP, dP, err, sizeof(err)) == false)
  {
    serveError(connP, 400, "Bad request", err);
    return false;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// sourceCheck - can this broker start from what it names, with what that has compiled in? false: why (422)
//
static bool sourceCheck(const Def* dP, char* err, int errLen)
{
  char* version = NULL;

  if (strcmp(dP->where, "container") == 0)
  {
    if (engine[0] == 0)
      engineFind();
    if (engine[0] == 0)
    {
      snprintf(err, errLen, "in a container: %s", engineWhy);
      return false;
    }
  }

  if ((needs(dP) != 0) && (engine[0] == 0))
  {
    engineFind();
    if (engine[0] == 0)
    {
      snprintf(err, errLen, "its services run in containers: %s", engineWhy);
      return false;
    }
  }

  if (strcmp(dP->from, "installed") == 0)
  {
    char path[2048];
    char v[4096];

    installedFind(path, sizeof(path), v, sizeof(v));
    if (path[0] == 0)
    {
      snprintf(err, errLen, "no coraine in $PATH - install the coraine package");
      return false;
    }
    version = strdup(v);
  }
  else if (strcmp(dP->from, "build") == 0)
  {
    version = buildVersion(dP->build);
    if (version == NULL)
    {
      snprintf(err, errLen, "no build '%s' that succeeded - Compile lists them", dP->build);
      return false;
    }
  }

  //
  // What the broker does not have compiled in, it cannot be asked for
  //
  struct { bool asked; const char* feature; const char* what; } checks[] =
  {
    { strcmp(dP->store, "mongoc") == 0, "MONGOC",     "mongoc"                 },
    { dP->healthPort > 0,               "HEALTH",     "a health port"          },
    { dP->ws,                           "TRANSPORTS", "the WebSocket transport" },
    { dP->admin,                        "ADMIN_API",  "the admin API"          },
    { dP->distributed,                  "REGISTRATIONS", "distributed operations (Context Source Registrations)" },
  };

  for (unsigned int ix = 0; ix < sizeof(checks) / sizeof(checks[0]); ix++)
  {
    if (checks[ix].asked && featureOff(version, checks[ix].feature))
    {
      snprintf(err, errLen, "this broker is built without %s (%s=OFF)", checks[ix].what, checks[ix].feature);
      free(version);
      return false;
    }
  }

  free(version);
  return true;
}



// -----------------------------------------------------------------------------
//
// runCommand - POST /api/run/command: what a start would run - nothing run
//
static void runCommand(CorHttpConn* connP)
{
  Def  d;
  char err[1024];
  int  ports[KINDS];
  Str  s = { NULL, 0, 0 };

  if (bodyDef(connP, &d) == false)
    return;

  pthread_mutex_lock(&rMutex);
  for (int k = 0; k < KINDS; k++)
  {
    char     svc[96];
    svcName(d.set, k, svc, sizeof(svc));
    Service* sP = svcFind(svc);
    ports[k] = ((sP != NULL) && (sP->hostPort > 0)) ? sP->hostPort : kinds[k].hostPort;
  }
  pthread_mutex_unlock(&rMutex);

  Argv a = { { NULL }, 0 };
  bool ok = argvMake(&d, ports, false, &a, err, sizeof(err));

  strAdd(&s, "{\"def\": ");
  defRender(&d, &s);
  strAdd(&s, ", \"argv\": [");
  for (int ix = 0; ok && (ix < a.n); ix++)
  {
    strAdd(&s, (ix > 0) ? ", " : "");
    strAddJson(&s, a.v[ix]);
  }
  strAdd(&s, "], \"command\": ");
  if (ok)
  {
    Str c = { NULL, 0, 0 };
    argCommand(&a, &c);
    strAddJson(&s, c.s);
    strFree(&c);
  }
  else
    strAdd(&s, "null");
  argFree(&a);

  strAdd(&s, ", \"services\": [");
  int  mask  = needs(&d);
  bool first = true;
  for (int k = 0; k < KINDS; k++)
  {
    if ((mask & (1 << k)) == 0)
      continue;
    char svc[96];
    svcName(d.set, k, svc, sizeof(svc));
    strAddf(&s, "%s{\"container\": \"%s\", \"service\": \"%s\", \"label\": \"%s\", \"image\": \"%s\", \"port\": %d}", first ? "" : ", ", svc, kinds[k].id, kinds[k].label, kinds[k].image, ports[k]);
    first = false;
  }
  strAdd(&s, "]");

  char why[1024] = "";
  if (ok && (sourceCheck(&d, why, sizeof(why)) == false))
    ok = false;
  strAdd(&s, ", \"problem\": ");
  strAddJson(&s, ok ? NULL : ((why[0] != 0) ? why : err));
  strAdd(&s, "}");

  respondStr(connP, 200, &s);
}



// -----------------------------------------------------------------------------
//
// logRotate - a new run's log: broker.log -> broker.log.1
//
static void logRotate(const char* path)
{
  char old[2400];
  snprintf(old, sizeof(old), "%s.1", path);
  rename(path, old);
}



// -----------------------------------------------------------------------------
//
// opcuaPasswordKeep - a password the request gave: into <broker dir>/opcua.password (0600), and wiped from the
// Def - c3.json and the API never hold it. None given: the file c3 keeps stays (empty keeps it). false: answered
//
static bool opcuaPasswordKeep(CorHttpConn* connP, Def* dP)
{
  if (dP->opcua.password[0] == 0)
    return true;

  char dir[2300];
  char path[2400];

  brokerDir(dP->name, dir, sizeof(dir));
  dirsMake(dir);
  opcuaPasswordPath(dP->name, path, sizeof(path));

  int  fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  int  n  = strlen(dP->opcua.password);
  bool ok = (fd != -1) && (fchmod(fd, 0600) == 0) && (write(fd, dP->opcua.password, n) == n) && (write(fd, "\n", 1) == 1);

  if (fd != -1)
    close(fd);

  memset(dP->opcua.password, 0, sizeof(dP->opcua.password));

  if (ok == false)
  {
    serveError(connP, 500, "Internal error", "the OPC UA password cannot be kept");
    return false;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// brokerStart - a broker kept (and replaced, when 'newDef') and started: 202 with it
//
static void brokerStart(CorHttpConn* connP, const Def* dP)
{
  char err[1024];
  char t[32];

  if (sourceCheck(dP, err, sizeof(err)) == false)
  {
    serveError(connP, 422, "Cannot start it", err);
    return;
  }

  pthread_mutex_lock(&rMutex);

  Broker* bP = brokerFind(dP->name);

  if ((bP != NULL) && (bP->busy || (strcmp(bP->state, "running") == 0) || (strcmp(bP->state, "starting") == 0) || (strcmp(bP->state, "stopping") == 0)))
  {
    snprintf(err, sizeof(err), "'%s' is %s - stop it first", dP->name, bP->state);
    pthread_mutex_unlock(&rMutex);
    serveError(connP, 409, "It runs", err);
    return;
  }

  //
  // Its ports: free, and not those of another broker of c3's that runs
  //
  for (int ix = 0; ix < nBrokers; ix++)
  {
    Broker* oP = brokers[ix];

    if ((oP == bP) || (strcmp(oP->state, "stopped") == 0) || (strcmp(oP->state, "exited") == 0) || (strcmp(oP->state, "failed") == 0))
      continue;

    if ((oP->def.port == dP->port) || (oP->def.healthPort == dP->port) || ((dP->healthPort > 0) && ((oP->def.port == dP->healthPort) || (oP->def.healthPort == dP->healthPort))))
    {
      snprintf(err, sizeof(err), "'%s' uses that port", oP->def.name);
      pthread_mutex_unlock(&rMutex);
      serveError(connP, 409, "The port is taken", err);
      return;
    }
  }

  if ((portFree(dP->port) == false) || ((dP->healthPort > 0) && (portFree(dP->healthPort) == false)))
  {
    snprintf(err, sizeof(err), "port %d is in use on this machine - another port", portFree(dP->port) ? dP->healthPort : dP->port);
    pthread_mutex_unlock(&rMutex);
    serveError(connP, 409, "The port is taken", err);
    return;
  }

  if (bP == NULL)
  {
    if (nBrokers >= BROKERS_MAX)
    {
      pthread_mutex_unlock(&rMutex);
      serveError(connP, 409, "Too many brokers", "forget one first");
      return;
    }
    bP = calloc(1, sizeof(Broker));
    brokers[nBrokers++] = bP;
    snprintf(bP->logPath, sizeof(bP->logPath), "%s/%s/broker.log", runDir, dP->name);
    bP->exitStatus = -1;
  }

  bP->def = *dP;
  isoTime(time(NULL), t, sizeof(t));
  snprintf(bP->def.lastStarted, sizeof(bP->def.lastStarted), "%s", t);

  char dir[2300];
  brokerDir(dP->name, dir, sizeof(dir));
  dirsMake(dir);
  logRotate(bP->logPath);

  snprintf(bP->state, sizeof(bP->state), "starting");
  bP->why[0]     = 0;
  bP->ready[0]   = 0;
  bP->busy       = true;
  bP->started    = time(NULL);
  bP->ended      = 0;
  bP->stopAsked  = 0;
  bP->killed     = false;
  bP->exitStatus = -1;
  bP->termSignal = 0;
  bP->pid        = 0;
  free(bP->report);
  bP->report     = NULL;
  memset(bP->usedSvc, 0, sizeof(bP->usedSvc));

  logLine(bP->logPath, "start '%s' - %s, %s", dP->name,
          (strcmp(dP->from, "installed") == 0) ? "the installed coraine" : (strcmp(dP->from, "build") == 0) ? "a build of Compile's" : dP->image,
          (strcmp(dP->where, "native") == 0) ? "natively" : "in a container");

  Str def = { NULL, 0, 0 };
  defRender(&bP->def, &def);

  Str s = { NULL, 0, 0 };
  brokerRender(bP, &s);
  pthread_mutex_unlock(&rMutex);

  //
  // Kept in c3.json, and in Connect's list
  //
  if (configRunBrokerPut(def.s, err, sizeof(err)) == false)
    fprintf(stderr, "c3: the broker '%s' is not kept in the configuration: %s\n", dP->name, err);
  strFree(&def);

  char touch[512];
  snprintf(touch, sizeof(touch), "{\"url\": \"http://localhost:%d\", \"name\": \"%s\"}", dP->port, dP->name);
  configBrokerTouch(touch, err, sizeof(err));

  if (threadStart(startThread, bP) == false)
  {
    pthread_mutex_lock(&rMutex);
    snprintf(bP->state, sizeof(bP->state), "failed");
    snprintf(bP->why, sizeof(bP->why), "no thread to start it");
    bP->busy = false;
    pthread_mutex_unlock(&rMutex);
  }

  respondStr(connP, 202, &s);
}



// -----------------------------------------------------------------------------
//
// brokerStop - POST /api/run/brokers/<name>/stop
//
static void brokerStop(CorHttpConn* connP, Broker* bP)
{
  if (bP->busy || (strcmp(bP->state, "running") != 0))
  {
    char err[256];
    snprintf(err, sizeof(err), "'%s' is %s", bP->def.name, bP->busy ? "busy - starting or stopping" : bP->state);
    pthread_mutex_unlock(&rMutex);
    serveError(connP, 409, "Not running", err);
    return;
  }

  snprintf(bP->state, sizeof(bP->state), "stopping");
  bP->busy      = true;
  bP->stopAsked = time(NULL);
  bP->grace     = bP->def.grace;

  Str s = { NULL, 0, 0 };
  brokerRender(bP, &s);
  pthread_mutex_unlock(&rMutex);

  threadStart(stopThread, bP);
  respondStr(connP, 202, &s);
}



// -----------------------------------------------------------------------------
//
// brokerForget - DELETE /api/run/brokers/<name>: a broker that does not run, out of c3.json; ?data=true: its
// directory (log, data) and its volume too
//
static void brokerForget(CorHttpConn* connP, Broker* bP)
{
  char err[1024];
  char name[65];

  if (bP->busy || (strcmp(bP->state, "running") == 0) || (strcmp(bP->state, "starting") == 0) || (strcmp(bP->state, "stopping") == 0))
  {
    snprintf(err, sizeof(err), "'%s' is %s - stop it first", bP->def.name, bP->state);
    pthread_mutex_unlock(&rMutex);
    serveError(connP, 409, "It runs", err);
    return;
  }

  snprintf(name, sizeof(name), "%s", bP->def.name);
  bool container = (strcmp(bP->def.where, "container") == 0);

  for (int ix = 0; ix < nBrokers; ix++)
  {
    if (brokers[ix] == bP)
    {
      brokers[ix] = brokers[--nBrokers];
      break;
    }
  }
  sseSubsEnd(&bP->subs);
  if (bP->follower > 0)
    kill(-bP->follower, SIGTERM);
  pthread_mutex_unlock(&rMutex);

  free(bP->report);
  free(bP);

  configRunBrokerDelete(name, err, sizeof(err));

  const char* data = corHttpUriParam(connP, "data");
  if ((data != NULL) && (strcmp(data, "true") == 0))
  {
    char dir[2300];
    char out[1024];

    if (container && (engine[0] != 0))
    {
      char vol[96];
      char ctr[96];
      brokerVolume(name, vol, sizeof(vol));
      brokerContainer(name, ctr, sizeof(ctr));
      engineRun(out, sizeof(out), 30, "rm", "-f", ctr, NULL);
      engineRun(out, sizeof(out), 30, "volume", "rm", vol, NULL);
    }

    brokerDir(name, dir, sizeof(dir));
    removeAll(dir);
  }

  corHttpResponseStatus(connP, 204);
  corHttpResponseBody(connP, (char*) "", 0);
}



// -----------------------------------------------------------------------------
//
// logFollow - GET .../log: server-sent events (Accept: text/event-stream) or the file
//
static void logFollow(CorHttpConn* connP, const char* path, int64_t* endP, SseSubs* subsP, time_t* beatP)
{
  const char* accept = corHttpHeader(connP, "Accept");

#ifndef COR_HTTP_STREAM_PENDING_MAX
  (void) accept; (void) endP; (void) subsP; (void) beatP;
  pthread_mutex_unlock(&rMutex);
  serveFileRange(connP, path, "text/plain; charset=utf-8", 0);
#else
  if ((accept == NULL) || (strstr(accept, "text/event-stream") == NULL))
  {
    char copy[2400];
    snprintf(copy, sizeof(copy), "%s", path);
    pthread_mutex_unlock(&rMutex);
    serveFileRange(connP, copy, "text/plain; charset=utf-8", 0);
    return;
  }

  const char* lastId = corHttpHeader(connP, "Last-Event-ID");
  const char* fromP  = corHttpUriParam(connP, "from");
  long long   from   = (lastId != NULL) ? atoll(lastId) : ((fromP != NULL) ? atoll(fromP) : 0);
  int         fd     = open(path, O_RDONLY | O_CLOEXEC);
  Str         s      = { NULL, 0, 0 };

  //
  // No page follows it yet: what was sent ends at the log's last complete line now
  //
  if (subsP->n == 0)
  {
    *endP = 0;
    if (fd != -1)
    {
      struct stat st;
      fstat(fd, &st);

      int64_t look = (st.st_size > 65536) ? 65536 : st.st_size;
      char    buf[65536];
      ssize_t got  = (look > 0) ? pread(fd, buf, look, st.st_size - look) : 0;
      int64_t end  = st.st_size - look;

      for (ssize_t ix = got - 1; ix >= 0; ix--)
      {
        if (buf[ix] == '\n')
        {
          end += ix + 1;
          break;
        }
        if (ix == 0)
          end = st.st_size - look;
      }
      *endP  = (got > 0) ? end : 0;
      *beatP = time(NULL);
    }
  }

  if (fd != -1)
  {
    sseFromFile(&s, fd, from, *endP);
    close(fd);
  }
  else
    strAdd(&s, "retry: 2000\n\n");

  corHttpResponseStatus(connP, 200);
  corHttpResponseHeader(connP, "Content-Type", "text/event-stream");
  corHttpResponseHeader(connP, "Cache-Control", "no-store");

  CorHttpStream* streamP = corHttpResponseStream(connP);
  corHttpStreamWrite(streamP, s.s, s.len);
  if (sseSubsAdd(subsP, streamP) == false)
  {
    corHttpStreamWrite(streamP, "event: busy\ndata: too many pages follow this log\n\n", 51);
    corHttpStreamEnd(streamP);
  }

  pthread_mutex_unlock(&rMutex);
  strFree(&s);
#endif
}



// -----------------------------------------------------------------------------
//
// Engine jobs - answered from a thread of their own (the request suspended meanwhile)
//
typedef struct Job
{
  CorHttpConn*  connP;
  char          arg[128];
} Job;

static void jobAnswer(Job* jP, int status, Str* sP)
{
  respondStr(jP->connP, status, sP);
  corHttpResume(jP->connP);
  free(jP);
}

static void jobError(Job* jP, int status, const char* title, const char* detail)
{
  serveError(jP->connP, status, title, detail);
  corHttpResume(jP->connP);
  free(jP);
}

static bool jobStart(CorHttpConn* connP, void* (*fn)(void*), const char* arg)
{
  Job* jP = calloc(1, sizeof(Job));

  jP->connP = connP;
  snprintf(jP->arg, sizeof(jP->arg), "%s", (arg != NULL) ? arg : "");
  corHttpSuspend(connP);

  if (threadStart(fn, jP) == false)
  {
    jobError(jP, 500, "No thread", "no thread for the request");
    return false;
  }
  return true;
}

//
// imagesThread - GET /api/run/images: the coraine images here, and the published tags (quay.io's API)
//
static void* imagesThread(void* vP)
{
  Job*        jP = (Job*) vP;
  static char out[64 * 1024];
  Str         s  = { NULL, 0, 0 };

  strAdd(&s, "{\"repository\": \"" PUBLISHED_REPO "\", \"local\": [");
  if ((engine[0] != 0) && (engineRun(out, sizeof(out), 30, "images", PUBLISHED_REPO, "--format", "{{.Tag}}\t{{.CreatedAt}}\t{{.Size}}", NULL) == 0))
  {
    char* save  = NULL;
    bool  first = true;
    for (char* line = strtok_r(out, "\n", &save); line != NULL; line = strtok_r(NULL, "\n", &save))
    {
      char* t1 = strchr(line, '\t');
      char* t2 = (t1 != NULL) ? strchr(t1 + 1, '\t') : NULL;
      if ((t2 == NULL) || (strcmp(line, "<none>") == 0))
        continue;
      *t1 = 0;
      *t2 = 0;
      if (strcmp(line, "<none>") == 0)
        continue;
      strAdd(&s, first ? "" : ", ");
      strAdd(&s, "{\"tag\": ");      strAddJson(&s, line);
      strAdd(&s, ", \"created\": "); strAddJson(&s, t1 + 1);
      strAdd(&s, ", \"size\": ");    strAddJson(&s, t2 + 1);
      strAdd(&s, "}");
      first = false;
    }
  }
  strAdd(&s, "], \"published\": [");

  //
  // quay.io: the active tags, newest first. A tag per architecture (-amd64, -arm64) is part of the one
  // without it (a manifest list): only those are offered
  //
  CorRestClientMulti* multiP = corRestClientMultiCreate(1);
  const char*         error  = NULL;
  char                errBuf[300];

  if (multiP != NULL)
  {
    corRestClientMultiMaxResponse(multiP, 4 * 1024 * 1024);
    corRestClientMultiAdd(multiP, CorVerbGet, "https://quay.io/api/v1/repository/seamware/coraine/tag/?limit=100&onlyActiveTags=true", NULL, 0, NULL, 0, NULL, NULL);
    corRestClientMultiPerform(multiP, 10000);

    CorRestClientResponse* respP = corRestClientMultiResponse(multiP, 0);

    if ((respP == NULL) || (respP->error != 0) || (respP->statusCode != 200) || (respP->body == NULL))
    {
      snprintf(errBuf, sizeof(errBuf), "quay.io did not answer%s%s", ((respP != NULL) && (respP->errorDetail[0] != 0)) ? ": " : "", (respP != NULL) ? respP->errorDetail : "");
      error = errBuf;
    }
    else
    {
      CorAlloc alloc;
      char     buf[16 * 1024];
      CorJson  json;

      corAllocBufferInit(&alloc, buf, sizeof(buf), 256 * 1024, NULL, "run images");
      corJsonCreate(&json, &alloc);

      CorNode* rootP = corJsonParse(&json, corAllocStrdup(&alloc, respP->body));
      CorNode* tagsP = (rootP != NULL) ? corTreeLookup(rootP, "tags") : NULL;
      bool     first = true;

      for (CorNode* tP = (tagsP != NULL) ? tagsP->value.head : NULL; tP != NULL; tP = tP->next)
      {
        CorNode* nP = corTreeLookup(tP, "name");
        CorNode* mP = corTreeLookup(tP, "last_modified");

        if ((nP == NULL) || (nP->type != CorString))
          continue;

        const char* n   = nP->value.s;
        int         len = strlen(n);
        const char* sfx[] = { "-amd64", "-arm64", "-amd64-debug", "-arm64-debug" };
        bool        arch  = false;

        for (int ix = 0; ix < 4; ix++)
        {
          int sl = strlen(sfx[ix]);
          arch = arch || ((len > sl) && (strcmp(&n[len - sl], sfx[ix]) == 0));
        }
        if (arch)
          continue;

        strAdd(&s, first ? "" : ", ");
        strAdd(&s, "{\"tag\": ");       strAddJson(&s, n);
        strAdd(&s, ", \"modified\": "); strAddJson(&s, ((mP != NULL) && (mP->type == CorString)) ? mP->value.s : NULL);
        strAdd(&s, "}");
        first = false;
      }

      corAllocBufferReset(&alloc, false);
    }

    corRestClientMultiDestroy(multiP);
  }
  else
    error = "no HTTP client";

  strAdd(&s, "], \"publishedError\": ");
  strAddJson(&s, error);
  strAdd(&s, "}");

  jobAnswer(jP, 200, &s);
  return NULL;
}

//
// volumeThread - DELETE /api/run/volumes/<volume>: one of c3's volumes, its container not running
//
static void* volumeThread(void* vP)
{
  Job* jP = (Job*) vP;
  char out[2048];
  char label[256] = "";

  if (engineRun(label, sizeof(label), 20, "volume", "inspect", "--format", "{{index .Labels \"c3\"}}", jP->arg, NULL) != 0)
  {
    jobError(jP, 404, "No such volume", jP->arg);
    return NULL;
  }
  if (strcmp(label, "run") != 0)
  {
    jobError(jP, 403, "Not c3's", "c3 deletes only the volumes it made (label c3=run)");
    return NULL;
  }

  //
  // The container that uses it, c3's (same name): it must not run, and goes first
  //
  if ((engineRun(out, sizeof(out), 20, "inspect", "--format", "{{.State.Running}}", jP->arg, NULL) == 0) && (strcmp(out, "true") == 0))
  {
    jobError(jP, 409, "It is in use", "its container runs - stop it first");
    return NULL;
  }
  engineRun(out, sizeof(out), 30, "rm", jP->arg, NULL);

  if (engineRun(out, sizeof(out), 60, "volume", "rm", jP->arg, NULL) != 0)
  {
    jobError(jP, 409, "Not deleted", out);
    return NULL;
  }

  pthread_mutex_lock(&rMutex);
  for (int ix = 0; ix < nSvcs; ix++)
  {
    if (strcmp(svcs[ix].volume, jP->arg) == 0)
      svcs[ix].volumeExists = false;
  }
  pthread_mutex_unlock(&rMutex);

  corHttpResponseStatus(jP->connP, 204);
  corHttpResponseBody(jP->connP, (char*) "", 0);
  corHttpResume(jP->connP);
  free(jP);
  return NULL;
}

//
// svcStopThread - POST /api/run/services/<container>/stop (answered at once: 202)
//
static void* svcStopThread(void* vP)
{
  char* name = (char*) vP;
  svcStop(name, "asked for");
  free(name);
  return NULL;
}



// -----------------------------------------------------------------------------
//
// Discovery - what a broker's bridge sees of its source, for a mapper: a broker of its own for it, where the form
// says (installed, a build or an image - a container on the host's network, argvMake) - the one bridge, in memory,
// the admin API, a free port. Its bridge's inventory is asked (discoverGet) and the broker is stopped again (a
// container removed). Its log: <broker dir>.discover/broker.log.
//
//   DDS      the form's domain, transport and interfaces and no mapping - one GET of the dds bridge's inventory,
//            which answers once discovery has gone quiet (corDdsBridge)
//   OPC UA   the mapper's server, security and user and no Channels - the opcua bridge's inventory, asked again
//            below every node it cut, until the address space is whole (opcuaCrawl)
//
typedef struct DiscoverJob
{
  Job  job;                                      // first: jobAnswer frees the whole
  Def  def;
} DiscoverJob;

typedef struct Discovery
{
  int   port;                                    // the broker's
  pid_t pid;                                     // natively: the broker's; -1: none
  char  name[96];                                // in a container: the container, while it runs; "": none
  char  logPath[2400];
} Discovery;

static bool discovering = false;                 // rMutex - one discovery at a time



// -----------------------------------------------------------------------------
//
// discoverStart - the discovery's broker, started and answering on its port: dP as discoverPrepare left it (its
// name, store, bridge and switches); false: why, in err (and nothing left running)
//
static bool discoverStart(Def* dP, Discovery* xP, char* err, int errLen)
{
  char dir[2300];

  xP->pid     = -1;
  xP->name[0] = 0;
  dP->port    = 0;

  for (int port = 39026; (port < 39126) && (dP->port == 0); port++)
  {
    if (portFree(port))
      dP->port = port;
  }
  xP->port = dP->port;

  brokerDir(dP->name, dir, sizeof(dir));
  dirsMake(dir);
  snprintf(xP->logPath, sizeof(xP->logPath), "%s/broker.log", dir);

  Argv  a         = { { NULL }, 0 };
  int   fd        = -1;
  bool  container = (strcmp(dP->where, "container") == 0);
  char  out[2048];

  if (dP->port == 0)
    snprintf(err, errLen, "no free port in 39026-39125 for the discovery's broker");
  else if ((bridgesConfigWrite(dP, 0, err, errLen) == false) || (argvMake(dP, (int[KINDS]) { 0 }, true, &a, err, errLen) == false))
    ;
  else if ((fd = open(xP->logPath, O_WRONLY | O_CREAT | O_TRUNC | O_APPEND | O_CLOEXEC, 0600)) == -1)   // appended: logLine writes in it too
    snprintf(err, errLen, "cannot open %s: %s", xP->logPath, strerror(errno));
  else if (container)
  {
    close(fd);
    fd = -1;

    if (imageEnsure(dP->image, xP->logPath, err, errLen) == true)
    {
      Str cmd = { NULL, 0, 0 };
      argCommand(&a, &cmd);
      logLine(xP->logPath, "%s", cmd.s);
      strFree(&cmd);

      brokerContainer(dP->name, xP->name, sizeof(xP->name));
      engineRun(out, sizeof(out), 30, "rm", "-f", xP->name, NULL);    // one a c3 that died left (it ends in 120 s anyway)

      if (engineArgv(&a, out, sizeof(out), 120) != 0)
      {
        snprintf(err, errLen, "%s run: %.600s", engineName, out);
        xP->name[0] = 0;
      }
    }
  }
  else
  {
    Str cmd = { NULL, 0, 0 };
    argCommand(&a, &cmd);
    logLine(xP->logPath, "%s", cmd.s);
    strFree(&cmd);

    char**    env = cleanEnv();
    ProcSpawn sp  = { a.v, env, fd, dir, true, false, SIGKILL };   // its own group (stopped as one), dies with c3
    xP->pid = procSpawn(&sp);
    free(env);

    if (xP->pid < 0)
      snprintf(err, errLen, "fork: %s", strerror(errno));
  }

  if (fd != -1)
    close(fd);
  argFree(&a);

  //
  // Up: it answers on its port
  //
  int  status = 0;
  bool up     = false;

  for (int ix = 0; ((xP->pid > 0) || (xP->name[0] != 0)) && (ix < 300) && !up; ix++)
  {
    bool ended = false;

    if (xP->pid > 0)
      ended = (waitpid(xP->pid, &status, WNOHANG) == xP->pid);
    else if ((ix % 10) == 9)                     // a container: asked once a second (--rm: gone when it ends)
      ended = (engineRun(out, sizeof(out), 20, "inspect", "--format", "{{.State.Running}}", xP->name, NULL) != 0) || (strcmp(out, "true") != 0);

    if (ended)
    {
      snprintf(err, errLen, "the discovery's broker ended before it answered - its log: %s", xP->logPath);
      xP->pid     = -1;
      xP->name[0] = 0;
      return false;
    }
    up = portAnswers(dP->port);
    if (!up)
      usleep(100 * 1000);
  }

  if (((xP->pid > 0) || (xP->name[0] != 0)) && !up)
    snprintf(err, errLen, "the discovery's broker did not answer on port %d in 30 s - its log: %s", dP->port, xP->logPath);

  return up;
}



// -----------------------------------------------------------------------------
//
// discoverStop - the discovery's broker stopped: SIGTERM to its group, SIGKILL 5 s later; a container's output
// into the log, and the container removed
//
static void discoverStop(Discovery* xP)
{
  int status = 0;

  if (xP->pid > 0)
  {
    kill(-xP->pid, SIGTERM);
    for (int ix = 0; ix < 50; ix++)
    {
      if (waitpid(xP->pid, &status, WNOHANG) == xP->pid)
      {
        xP->pid = -1;
        break;
      }
      usleep(100 * 1000);
    }
    if (xP->pid > 0)
    {
      kill(-xP->pid, SIGKILL);
      waitpid(xP->pid, &status, 0);
      xP->pid = -1;
    }
    logLine(xP->logPath, "stopped - the discovery is over");
  }

  if (xP->name[0] != 0)
  {
    char out[2048];
    Argv l = { { NULL }, 0 };

    argAdd(&l, engine);
    argAdd(&l, "logs");
    argAdd(&l, xP->name);
    engineToLog(xP->logPath, 30, &l);
    argFree(&l);

    engineRun(out, sizeof(out), 30, "rm", "-f", xP->name, NULL);
    logLine(xP->logPath, "%s removed - the discovery is over", xP->name);
    xP->name[0] = 0;
  }
}



// -----------------------------------------------------------------------------
//
// discoverGet - a GET of the discovery's broker: its status code and body (in s, appended); 0: no answer (why, in
// err)
//
static int discoverGet(const Discovery* xP, const char* path, int timeoutMs, Str* sP, char* err, int errLen)
{
  char                url[2048];
  int                 code   = 0;
  CorRestClientMulti* multiP = corRestClientMultiCreate(1);

  if (multiP == NULL)
  {
    snprintf(err, errLen, "no HTTP client for the inventory");
    return 0;
  }

  snprintf(url, sizeof(url), "http://127.0.0.1:%d%s", xP->port, path);
  corRestClientMultiMaxResponse(multiP, 16 * 1024 * 1024);
  corRestClientMultiAdd(multiP, CorVerbGet, url, NULL, 0, NULL, 0, NULL, NULL);
  corRestClientMultiPerform(multiP, timeoutMs);

  CorRestClientResponse* respP = corRestClientMultiResponse(multiP, 0);

  if ((respP == NULL) || (respP->error != 0))
    snprintf(err, errLen, "the discovery's broker did not answer the inventory%s%s", ((respP != NULL) && (respP->errorDetail[0] != 0)) ? ": " : "", (respP != NULL) ? respP->errorDetail : "");
  else
  {
    code = respP->statusCode;
    if (respP->body != NULL)
      strAddN(sP, respP->body, respP->bodyLen);
  }

  corRestClientMultiDestroy(multiP);
  return code;
}



// -----------------------------------------------------------------------------
//
// discoverPrepare - the form's broker, as little of it as the discovery needs: its own name, corDB in memory,
// the one bridge and the admin API - no file of one's own, no mapping, no other bridge's source
//
static void discoverPrepare(Def* dP, const char* bridge)
{
  char name[64];

  snprintf(name, sizeof(name), "%.50s.discover", dP->name);
  snprintf(dP->name, sizeof(dP->name), "%s", name);
  snprintf(dP->store, sizeof(dP->store), "corDB");
  snprintf(dP->history, sizeof(dP->history), "none");
  snprintf(dP->bridges, sizeof(dP->bridges), "%s", bridge);
  dP->dbDir             = false;
  dP->healthPort        = 0;
  dP->ws                = false;
  dP->admin             = true;
  dP->distributed       = false;
  dP->verbose           = false;
  dP->bridgeConfig[0]   = 0;
  dP->userContext[0]    = 0;
  dP->ckan[0]           = 0;
  dP->args[0]           = 0;
  dP->dds.vocabulary[0] = 0;
  dP->dds.topics[0]     = 0;
  dP->dds.services[0]   = 0;
  dP->dds.actions[0]    = 0;
  dP->opcua.roots[0]    = 0;
  dP->opcua.channels[0] = 0;

  if (strcmp(bridge, "opcua") != 0)
    dP->opcua.url[0] = 0;
}



// -----------------------------------------------------------------------------
//
// discoverEnd - one discovery less, and its answer: the inventory (s), or why there is none
//
static void discoverEnd(DiscoverJob* djP, Str* sP, const char* err)
{
  pthread_mutex_lock(&rMutex);
  discovering = false;
  pthread_mutex_unlock(&rMutex);

  if (sP->len > 0)
    jobAnswer(&djP->job, 200, sP);
  else
    jobError(&djP->job, 502, "No inventory", err);

  strFree(sP);
}



// -----------------------------------------------------------------------------
//
// ddsDiscoverThread - the dds bridge's inventory: one GET, answered once discovery has gone quiet (at most 10 s)
//
static void* ddsDiscoverThread(void* vP)
{
  DiscoverJob* djP = (DiscoverJob*) vP;
  Def          d   = djP->def;
  Discovery    x;
  char         err[1024] = "";
  Str          s   = { NULL, 0, 0 };

  discoverPrepare(&d, "dds");

  if (discoverStart(&d, &x, err, sizeof(err)) == true)
  {
    int code = discoverGet(&x, "/admin/bridges/dds/inventory", 20000, &s, err, sizeof(err));

    if ((code != 200) && (code != 0))
    {
      snprintf(err, sizeof(err), "the discovery's broker answered %d: %.700s", code, (s.s != NULL) ? s.s : "");
      strFree(&s);
    }
  }

  discoverStop(&x);
  discoverEnd(djP, &s, err);
  return NULL;
}



// -----------------------------------------------------------------------------
//
// opcuaCut - the nodes of a tree the inventory cut (hasChildren, no "children"), in a namespace of the server's
// application: ns=0 - the server's own nodes, its Server object and its sessions - is not followed
//
static void opcuaCut(CorNode* nP, CorNode** cutV, int* cutsP, int max, int* nodesP, bool* fullP)
{
  (*nodesP)++;

  CorNode* idP       = corTreeLookup(nP, "id");
  CorNode* moreP     = corTreeLookup(nP, "hasChildren");
  CorNode* childrenP = corTreeLookup(nP, "children");

  if ((childrenP == NULL) && (moreP != NULL) && (moreP->type == CorBoolean) && moreP->value.b && (idP != NULL) && (idP->type == CorString) &&
      (strncmp(idP->value.s, "ns=", 3) == 0) && (strncmp(idP->value.s, "ns=0;", 5) != 0))
  {
    if (*cutsP < max)
      cutV[(*cutsP)++] = nP;
    else
      *fullP = true;
  }

  if ((childrenP != NULL) && (childrenP->type == CorArray))
  {
    for (CorNode* cP = childrenP->value.head; cP != NULL; cP = cP->next)
      opcuaCut(cP, cutV, cutsP, max, nodesP, fullP);
  }
}



// -----------------------------------------------------------------------------
//
// opcuaCrawl - the server's address space, from its Objects folder: the inventory five levels at a time, asked
// again below each node it cut, the answers grafted into one tree - at most 20 000 nodes and 400 requests (a
// larger address space is cut there: "complete" false). The answer: { "url", "complete", "nodes", "objects" }
//
static bool opcuaCrawl(const Discovery* xP, const char* url, Str* sP, char* err, int errLen)
{
  CorAlloc  alloc;
  char      buf[16 * 1024];
  CorJson   json;
  Str       body   = { NULL, 0, 0 };
  CorNode*  rootP  = NULL;
  bool      ok     = false;
  int       code   = 0;

  corAllocBufferInit(&alloc, buf, sizeof(buf), 4 * 1024 * 1024, NULL, "c3 opcua inventory");
  corJsonCreate(&json, &alloc);

  //
  // The bridge answers 503 until it has a connection to the server - asked again for at most 20 s
  //
  for (int ix = 0; ix < 40; ix++)
  {
    strFree(&body);
    code = discoverGet(xP, "/admin/bridges/opcua/inventory?depth=5", 20000, &body, err, errLen);
    if (code != 503)
      break;
    usleep(500 * 1000);
  }

  if (code == 200)
    rootP = corJsonParse(&json, corAllocStrdup(&alloc, (body.s != NULL) ? body.s : ""));

  if (code == 0)
    ;
  else if (code == 503)
    snprintf(err, errLen, "the opcua bridge has no connection to %s: %.700s", url, (body.s != NULL) ? body.s : "");
  else if (code != 200)
    snprintf(err, errLen, "the discovery's broker answered %d: %.700s", code, (body.s != NULL) ? body.s : "");
  else if ((rootP == NULL) || (rootP->type != CorObject))
    snprintf(err, errLen, "the opcua bridge's inventory is not a JSON object");
  else
  {
    CorNode* cutV[512];
    int      cuts      = 0;
    int      nodes     = 0;
    int      requests  = 1;
    bool     complete  = true;
    bool     full      = false;              // more cut than the list holds: those are not asked for

    opcuaCut(rootP, cutV, &cuts, 512, &nodes, &full);

    while ((cuts > 0) && complete)
    {
      CorNode* nP  = cutV[--cuts];
      CorNode* idP = corTreeLookup(nP, "id");
      char     path[1400];
      int      len = snprintf(path, sizeof(path), "/admin/bridges/opcua/inventory?depth=5&from=");

      for (const char* c = idP->value.s; (*c != 0) && (len < (int) sizeof(path) - 4); c++)
      {
        unsigned char u = (unsigned char) *c;
        if (((u >= 'A') && (u <= 'Z')) || ((u >= 'a') && (u <= 'z')) || ((u >= '0') && (u <= '9')) || (u == '-') || (u == '.') || (u == '_') || (u == '~'))
          path[len++] = *c;
        else
          len += snprintf(&path[len], sizeof(path) - len, "%%%02X", u);
      }
      path[len] = 0;

      if ((nodes >= 20000) || (requests >= 400))
      {
        complete = false;
        break;
      }

      Str more = { NULL, 0, 0 };
      requests++;

      if (discoverGet(xP, path, 20000, &more, err, errLen) == 200)
      {
        CorNode* subP      = corJsonParse(&json, corAllocStrdup(&alloc, (more.s != NULL) ? more.s : ""));
        CorNode* childrenP = ((subP != NULL) && (subP->type == CorObject)) ? corTreeLookup(subP, "children") : NULL;

        if (childrenP != NULL)
        {
          corTreeChildMove(subP, nP, childrenP);
          nodes--;                                 // nP itself is counted again
          opcuaCut(nP, cutV, &cuts, 512, &nodes, &full);
        }
      }
      strFree(&more);
    }

    if ((cuts > 0) || full)
      complete = false;

    int   size = corJsonRenderSize(&json, rootP) + 2;
    char* text = malloc(size);

    if (text == NULL)
      snprintf(err, errLen, "no room for the inventory");
    else
    {
      corJsonRender(&json, rootP, text);
      strAdd(sP, "{\"url\": ");          strAddJson(sP, url);
      strAddf(sP, ", \"complete\": %s, \"nodes\": %d, \"objects\": ", complete ? "true" : "false", nodes);
      strAdd(sP, text);
      strAdd(sP, "}");
      free(text);
      ok = true;
    }
  }

  strFree(&body);
  corAllocBufferReset(&alloc, false);
  return ok;
}



// -----------------------------------------------------------------------------
//
// opcuaDiscoverThread - the opcua bridge's view of the server: its address space, whole (opcuaCrawl). The
// user's password: the one the request gave, else the one the mapper keeps - for the discovery's broker in its
// own directory (opcuaPasswordPath), as for any broker
//
static void opcuaPasswordWrite(const char* path, const char* password, char* err, int errLen);
static void opcuaMapperPath(const char* file, char* out, int outLen);

static void* opcuaDiscoverThread(void* vP)
{
  DiscoverJob* djP = (DiscoverJob*) vP;
  Def          d   = djP->def;
  Discovery    x   = { 0, -1, "", "" };
  char         err[1024] = "";
  Str          s   = { NULL, 0, 0 };

  discoverPrepare(&d, "opcua");
  memset(djP->def.opcua.password, 0, sizeof(djP->def.opcua.password));

  if (d.opcua.url[0] == 0)
    snprintf(err, sizeof(err), "the OPC UA server to discover: its URL (opc.tcp://host:port)");
  else if (strcmp(d.where, "container") == 0)
    snprintf(err, sizeof(err), "OPC UA discovery needs a native broker - an installed coraine or a build: the image has no opcua bridge");
  else
  {
    if (d.opcua.username[0] != 0)
    {
      char dir[2300];
      char path[2400];

      brokerDir(d.name, dir, sizeof(dir));
      dirsMake(dir);
      opcuaPasswordPath(d.name, path, sizeof(path));

      if (d.opcua.password[0] != 0)
        opcuaPasswordWrite(path, d.opcua.password, err, sizeof(err));
      else
      {
        char  kept[2400];
        opcuaMapperPath("opcua.password", kept, sizeof(kept));
        char* text = fileText(kept);

        if (text != NULL)
        {
          char* nl = strchr(text, '\n');
          if (nl != NULL)
            *nl = 0;
          opcuaPasswordWrite(path, text, err, sizeof(err));
          memset(text, 0, strlen(text));
          free(text);
        }
      }
      memset(d.opcua.password, 0, sizeof(d.opcua.password));
    }

    if ((err[0] == 0) && (discoverStart(&d, &x, err, sizeof(err)) == true))
      opcuaCrawl(&x, d.opcua.url, &s, err, sizeof(err));

    discoverStop(&x);

    char path[2400];                             // the discovery's copy of the password: gone with it
    opcuaPasswordPath(d.name, path, sizeof(path));
    unlink(path);
  }

  discoverEnd(djP, &s, err);
  return NULL;
}



// -----------------------------------------------------------------------------
//
// discoverRequest - POST /api/run/<bridge>/discover {broker}: the form's broker, its discovery in a thread of
// its own - one at a time
//
static void discoverRequest(CorHttpConn* connP, void* (*thread)(void*))
{
  DiscoverJob* djP = calloc(1, sizeof(DiscoverJob));

  if (djP == NULL)
  {
    serveError(connP, 500, "Out of memory", "no room for the discovery");
    return;
  }

  if (bodyDef(connP, &djP->def) == false)
  {
    free(djP);
    return;
  }

  pthread_mutex_lock(&rMutex);
  bool busy = discovering;
  discovering = true;
  pthread_mutex_unlock(&rMutex);

  if (busy)
  {
    memset(djP->def.opcua.password, 0, sizeof(djP->def.opcua.password));
    free(djP);
    serveError(connP, 409, "A discovery runs", "one discovery at a time - wait for the one that runs");
    return;
  }

  djP->job.connP = connP;
  corHttpSuspend(connP);

  if (threadStart(thread, djP) == false)
  {
    pthread_mutex_lock(&rMutex);
    discovering = false;
    pthread_mutex_unlock(&rMutex);
    jobError(&djP->job, 500, "No thread", "no thread for the discovery");
  }
}




// -----------------------------------------------------------------------------
//
// textWrite - a file, its whole text (0644); false: why, in err
//
static bool textWrite(const char* path, const char* text, int len, char* err, int errLen)
{
  int  fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  bool ok = (fd != -1) && (write(fd, text, len) == len);

  if (fd != -1)
    close(fd);
  if (!ok)
    snprintf(err, errLen, "cannot write %s: %s", path, strerror(errno));
  return ok;
}



// -----------------------------------------------------------------------------
//
// ddsFilesPath - a file of the DDS configuration the mapper writes: <data>/c3/dds/<file>, beside run/
//
static void ddsFilesPath(const char* file, char* out, int outLen)
{
  const char* slash = strrchr(runDir, '/');
  int         len   = (slash != NULL) ? (int) (slash - runDir) : (int) strlen(runDir);

  snprintf(out, outLen, "%.*s/dds%s%s", len, runDir, (file != NULL) ? "/" : "", (file != NULL) ? file : "");
}



// -----------------------------------------------------------------------------
//
// ddsFilesAnswer - {"directory", "bridgeConfig", "userContext", "mapping"}: the files' paths, and the mapping
// they were written from (mappingJson: JSON text; NULL: null - nothing written yet)
//
static void ddsFilesAnswer(CorHttpConn* connP, int status, const char* mappingJson)
{
  char dir[2400];
  char conf[2400];
  char ctx[2400];
  Str  s = { NULL, 0, 0 };

  ddsFilesPath(NULL, dir, sizeof(dir));
  ddsFilesPath("dds-bridge.json", conf, sizeof(conf));
  ddsFilesPath("dds-context.jsonld", ctx, sizeof(ctx));

  strAdd(&s, "{\"directory\": ");      strAddJson(&s, dir);
  strAdd(&s, ", \"bridgeConfig\": ");  strAddJson(&s, conf);
  strAdd(&s, ", \"userContext\": ");   strAddJson(&s, ctx);
  strAdd(&s, ", \"mapping\": ");       strAdd(&s, (mappingJson != NULL) ? mappingJson : "null");
  strAdd(&s, "}");
  respondStr(connP, status, &s);
}



// -----------------------------------------------------------------------------
//
// ddsFiles - the DDS configuration the mapper makes, for a broker started with it (--bridges dds
// --bridgeConfig <bridgeConfig> --defaultUserContext <userContext>):
//
//   POST {domain, transport, interfaces, vocabulary, topics, services, actions} - the "dds" of a broker's definition - writes
//        dds-bridge.json      the bridge configuration: how the dds bridge reaches the DDS system, and the mapping (ddsMember)
//        dds-context.jsonld   each entity type and attribute a term of the vocabulary (ddsContextWriteTo) - with
//                             no vocabulary, of the default context's: the terms expand as they would without it
//        dds-mapping.json     what was posted, as posted - what GET answers, the mapper's to edit again
//   GET  the paths, and the mapping last written (null: none)
//
static void ddsFiles(CorHttpConn* connP, bool post)
{
  char mapping[2400];
  char err[1024];

  ddsFilesPath("dds-mapping.json", mapping, sizeof(mapping));

  if (!post)
  {
    char* text = fileText(mapping);
    ddsFilesAnswer(connP, 200, ((text != NULL) && (text[0] != 0)) ? text : NULL);
    free(text);
    return;
  }

  if (connP->bodyRefused || (connP->body.s == NULL) || (connP->body.len == 0))
  {
    serveError(connP, 400, "Bad request", "a JSON object is expected as the body - the mapping: {domain, transport, interfaces, vocabulary, topics, services, actions}");
    return;
  }

  CorJson json;
  corJsonCreate(&json, &connP->alloc);
  CorNode* bodyP = corJsonParse(&json, corAllocStrdup(&connP->alloc, connP->body.s));
  Def*     dP    = calloc(1, sizeof(Def));

  if ((bodyP == NULL) || (bodyP->type != CorObject))
  {
    free(dP);
    serveError(connP, 400, "Bad request", "the mapping is a JSON object: {domain, transport, interfaces, vocabulary, topics, services, actions}");
    return;
  }
  if (ddsParse(bodyP, dP, err, sizeof(err)) == false)
  {
    free(dP);
    serveError(connP, 400, "Bad request", err);
    return;
  }

  if (dP->dds.vocabulary[0] == 0)
    snprintf(dP->dds.vocabulary, sizeof(dP->dds.vocabulary), "https://uri.etsi.org/ngsi-ld/default-context/");

  char dir[2400];
  char conf[2400];
  char ctx[2400];
  char types[2400];
  Str  s = { NULL, 0, 0 };

  ddsFilesPath(NULL, dir, sizeof(dir));
  ddsFilesPath("dds-bridge.json", conf, sizeof(conf));
  ddsFilesPath("dds-context.jsonld", ctx, sizeof(ctx));
  ddsFilesPath("dds-types", types, sizeof(types));
  dirsMake(dir);

  strAdd(&s, "{");
  ddsMember(&s, dP, types);
  strAdd(&s, "}\n");

  bool ok = textWrite(conf, s.s, s.len, err, sizeof(err)) &&
            ddsContextWriteTo(dP, ctx, err, sizeof(err)) &&
            textWrite(mapping, connP->body.s, connP->body.len, err, sizeof(err));
  strFree(&s);
  free(dP);

  if (!ok)
  {
    serveError(connP, 500, "The DDS configuration was not written", err);
    return;
  }

  ddsFilesAnswer(connP, 201, connP->body.s);
}



// -----------------------------------------------------------------------------
//
// opcuaMapperPath - a file of the OPC UA configuration the mapper writes: <data>/c3/opcua/<file>, beside run/
//
static void opcuaMapperPath(const char* file, char* out, int outLen)
{
  const char* slash = strrchr(runDir, '/');
  int         len   = (slash != NULL) ? (int) (slash - runDir) : (int) strlen(runDir);

  snprintf(out, outLen, "%.*s/opcua%s%s", len, runDir, (file != NULL) ? "/" : "", (file != NULL) ? file : "");
}



// -----------------------------------------------------------------------------
//
// opcuaPasswordWrite - a password, into a file only its owner reads (0600), and a newline after it - the
// bridge's passwordFile reads its first line
//
static void opcuaPasswordWrite(const char* path, const char* password, char* err, int errLen)
{
  int  fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  int  n  = strlen(password);
  bool ok = (fd != -1) && (fchmod(fd, 0600) == 0) && (write(fd, password, n) == n) && (write(fd, "\n", 1) == 1);

  if (fd != -1)
    close(fd);
  if (!ok)
    snprintf(err, errLen, "the OPC UA password cannot be kept in %s: %s", path, strerror(errno));
}



//
// The models the mapper names: an Object each, its model an AssetChannel - a line each: NodeId, attributeLayout,
// channelDirection, tab-separated (entities "natural": every Object of it an entity)
//
static const char* layouts[]    = { "attributes", "subAttributes", "value", NULL };
static const char* directions[] = { "in", "both", NULL };

static bool oneOf(const char* s, const char** allowed)
{
  for (int ix = 0; allowed[ix] != NULL; ix++)
  {
    if (strcmp(s, allowed[ix]) == 0)
      return true;
  }
  return false;
}

static bool modelsParse(CorNode* nP, char* out, int outLen, char* err, int errLen)
{
  int len = 0;

  out[0] = 0;

  if ((nP == NULL) || (nP->type == CorNull))
    return true;

  if (nP->type != CorArray)
  {
    snprintf(err, errLen, "\"models\" is a list of { \"node\", \"attributeLayout\", \"channelDirection\" }");
    return false;
  }

  for (CorNode* iP = nP->value.head; iP != NULL; iP = iP->next)
  {
    CorNode* nodeP   = (iP->type == CorObject) ? corTreeLookup(iP, "node") : NULL;
    CorNode* layoutP = (iP->type == CorObject) ? corTreeLookup(iP, "attributeLayout") : NULL;
    CorNode* dirP    = (iP->type == CorObject) ? corTreeLookup(iP, "channelDirection") : NULL;

    if ((nodeP == NULL) || (nodeP->type != CorString) || (nodeP->value.s[0] == 0) || (strpbrk(nodeP->value.s, "\t\n") != NULL))
    {
      snprintf(err, errLen, "each of \"models\" has \"node\": an Object's NodeId (ns=2;s=Press17)");
      return false;
    }

    const char* layout = ((layoutP != NULL) && (layoutP->type == CorString)) ? layoutP->value.s : "attributes";
    const char* dir    = ((dirP != NULL) && (dirP->type == CorString)) ? dirP->value.s : "in";

    if (!oneOf(layout, layouts))
    {
      snprintf(err, errLen, "the model of %s: \"attributeLayout\" is attributes, subAttributes or value", nodeP->value.s);
      return false;
    }
    if (!oneOf(dir, directions))
    {
      snprintf(err, errLen, "the model of %s: \"channelDirection\" is in or both", nodeP->value.s);
      return false;
    }

    int w = snprintf(&out[len], outLen - len, "%s%s\t%s\t%s", (len > 0) ? "\n" : "", nodeP->value.s, layout, dir);
    if (w >= outLen - len)
    {
      snprintf(err, errLen, "\"models\" is longer than %d characters", outLen - 1);
      return false;
    }
    len += w;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// opcuaModelsJson - the models as the bridge configuration's "assetChannels" (keyed: true) - or as the mapping
// was posted, a list
//
static void opcuaModelsJson(Str* sP, const char* models, bool keyed)
{
  char  copy[8192];
  char* save  = NULL;
  bool  first = true;

  snprintf(copy, sizeof(copy), "%s", models);
  strAdd(sP, keyed ? "{" : "[");

  for (char* line = strtok_r(copy, "\n", &save); line != NULL; line = strtok_r(NULL, "\n", &save))
  {
    char* f[3];
    char* fsave = NULL;
    int   n     = 0;

    for (char* t = strtok_r(line, "\t", &fsave); (t != NULL) && (n < 3); t = strtok_r(NULL, "\t", &fsave))
      f[n++] = t;
    if (n != 3)
      continue;

    strAdd(sP, first ? "" : ", ");
    if (keyed)
    {
      strAddJson(sP, f[0]);
      strAdd(sP, ": {\"entities\": \"natural\", \"attributeLayout\": ");
    }
    else
    {
      strAdd(sP, "{\"node\": ");
      strAddJson(sP, f[0]);
      strAdd(sP, ", \"attributeLayout\": ");
    }
    strAddJson(sP, f[1]);
    strAdd(sP, ", \"channelDirection\": ");
    strAddJson(sP, f[2]);
    strAdd(sP, "}");
    first = false;
  }

  strAdd(sP, keyed ? "}" : "]");
}



// -----------------------------------------------------------------------------
//
// termsAdd - a term to the @context being written, once
//
static bool termsAdd(Str* sP, Str* seenP, const char* vocabulary, const char* term, bool* firstP)
{
  char key[600];

  snprintf(key, sizeof(key), "\n%s\n", term);
  if ((seenP->s != NULL) && (strstr(seenP->s, key) != NULL))
    return true;
  strAdd(seenP, (seenP->len == 0) ? "\n" : "");
  strAdd(seenP, term);
  strAdd(seenP, "\n");

  strAdd(sP, *firstP ? "\n    " : ",\n    ");
  strAddJson(sP, term);
  strAdd(sP, ": ");

  char iri[1200];
  snprintf(iri, sizeof(iri), "%s%s", vocabulary, term);
  strAddJson(sP, iri);
  *firstP = false;
  return true;
}



// -----------------------------------------------------------------------------
//
// opcuaContextText - the @context of an OPC UA mapping: each entity type and attribute its Channels name, and the
// terms the mapper predicts its models make (their Objects' types, their attributes' and Relationships' names),
// a term in the vocabulary
//
static void opcuaContextText(Str* sP, const char* vocabulary, const char* channels, const char* terms)
{
  Str  seen  = { NULL, 0, 0 };
  bool first = true;

  strAdd(sP, "{\n  \"@context\": {");

  char* copy = strdup(channels);
  char* save = NULL;

  for (char* line = (copy != NULL) ? strtok_r(copy, "\n", &save) : NULL; line != NULL; line = strtok_r(NULL, "\n", &save))
  {
    char* f[4];
    char* fsave = NULL;
    int   n     = 0;

    for (char* t = strtok_r(line, "\t", &fsave); (t != NULL) && (n < 4); t = strtok_r(NULL, "\t", &fsave))
      f[n++] = t;

    if (n == 4)
    {
      termsAdd(sP, &seen, vocabulary, f[2], &first);   // the entity type
      termsAdd(sP, &seen, vocabulary, f[3], &first);   // the attribute
    }
  }
  free(copy);

  copy = strdup(terms);
  save = NULL;
  for (char* t = (copy != NULL) ? strtok_r(copy, "\n", &save) : NULL; t != NULL; t = strtok_r(NULL, "\n", &save))
    termsAdd(sP, &seen, vocabulary, t, &first);
  free(copy);

  strAdd(sP, first ? "}\n}\n" : "\n  }\n}\n");
  strFree(&seen);
}



// -----------------------------------------------------------------------------
//
// opcuaFilesAnswer - {"directory", "bridgeConfig", "userContext", "mapping"}: the files' paths, and the mapping
// they were written from (mappingJson: JSON text; NULL: null - nothing written yet), "passwordSet" in its "user"
// when c3 keeps a password for it
//
static void opcuaFilesAnswer(CorHttpConn* connP, int status, const char* mappingJson)
{
  char dir[2400];
  char conf[2400];
  char ctx[2400];
  Str  s = { NULL, 0, 0 };

  opcuaMapperPath(NULL, dir, sizeof(dir));
  opcuaMapperPath("opcua-bridge.json", conf, sizeof(conf));
  opcuaMapperPath("opcua-context.jsonld", ctx, sizeof(ctx));

  strAdd(&s, "{\"directory\": ");      strAddJson(&s, dir);
  strAdd(&s, ", \"bridgeConfig\": ");  strAddJson(&s, conf);
  strAdd(&s, ", \"userContext\": ");   strAddJson(&s, ctx);
  strAdd(&s, ", \"mapping\": ");       strAdd(&s, (mappingJson != NULL) ? mappingJson : "null");
  strAdd(&s, "}");
  respondStr(connP, status, &s);
}



// -----------------------------------------------------------------------------
//
// opcuaFiles - the OPC UA configuration the mapper makes, for a broker started with it (--bridges opcua
// --bridgeConfig <bridgeConfig> --defaultUserContext <userContext>):
//
//   POST {url, security, user, vocabulary, channels, models, terms} - the server as a broker's "opcua" has it,
//        the Channels, the models (AssetChannels) and the terms they make - writes
//        opcua-bridge.json      the bridge configuration: the server, the Channels and the AssetChannels (opcuaMember's
//                               shape; the password as the file below)
//        opcua-context.jsonld   each entity type and attribute a term of the vocabulary (opcuaContextText) - with
//                               no vocabulary, of the default context's: the terms expand as they would without it
//        opcua-mapping.json     the mapping, the password left out - what GET answers, the mapper's to edit again
//        opcua.password         the user's password, readable by its owner only (0600) - given once, kept
//   GET  the paths, and the mapping last written (null: none)
//
static void opcuaFiles(CorHttpConn* connP, bool post)
{
  char mapping[2400];
  char pwPath[2400];
  char err[1024] = "";

  opcuaMapperPath("opcua-mapping.json", mapping, sizeof(mapping));
  opcuaMapperPath("opcua.password", pwPath, sizeof(pwPath));

  if (!post)
  {
    char* text = fileText(mapping);
    opcuaFilesAnswer(connP, 200, ((text != NULL) && (text[0] != 0)) ? text : NULL);
    free(text);
    return;
  }

  const char* shape = "a JSON object is expected as the body - the mapping: {url, security, user, vocabulary, channels, models, terms}";

  if (connP->bodyRefused || (connP->body.s == NULL) || (connP->body.len == 0))
  {
    serveError(connP, 400, "Bad request", shape);
    return;
  }

  CorJson json;
  corJsonCreate(&json, &connP->alloc);
  CorNode* bodyP = corJsonParse(&json, corAllocStrdup(&connP->alloc, connP->body.s));

  if ((bodyP == NULL) || (bodyP->type != CorObject))
  {
    serveError(connP, 400, "Bad request", shape);
    return;
  }

  Def*  dP     = calloc(1, sizeof(Def));
  char* models = calloc(1, 8192);
  char* terms  = calloc(1, 16384);
  char  vocabulary[512] = "";

  if ((dP == NULL) || (models == NULL) || (terms == NULL))
    snprintf(err, sizeof(err), "no room for the mapping");
  else if (!opcuaParse(bodyP, dP, err, sizeof(err)) ||
           !modelsParse(corTreeLookup(bodyP, "models"), models, 8192, err, sizeof(err)) ||
           !memberLines(bodyP, "terms", terms, 16384, err, sizeof(err)) ||
           !memberString(bodyP, "vocabulary", vocabulary, sizeof(vocabulary), err, sizeof(err)))
    ;
  else if (dP->opcua.url[0] == 0)
    snprintf(err, sizeof(err), "\"url\": the OPC UA server, opc.tcp://<host>:<port>");
  else if ((dP->opcua.channels[0] == 0) && (models[0] == 0))
    snprintf(err, sizeof(err), "nothing mapped: no \"channels\" and no \"models\"");
  else if ((vocabulary[0] != 0) && (strstr(vocabulary, "://") == NULL) && (strncmp(vocabulary, "urn:", 4) != 0))
    snprintf(err, sizeof(err), "\"vocabulary\" is a URI, the namespace of the terms mapped (https://example.org/plant/)");
  else
  {
    for (char* t = terms; *t != 0; t++)
    {
      if (strchr(" <>\"'=;()\t", *t) != NULL)
      {
        snprintf(err, sizeof(err), "\"terms\": a term has a character NGSI-LD forbids in a name");
        break;
      }
    }
  }

  if (err[0] != 0)
  {
    if (dP != NULL)
      memset(dP->opcua.password, 0, sizeof(dP->opcua.password));
    free(dP);
    free(models);
    free(terms);
    serveError(connP, 400, "Bad request", err);
    return;
  }

  char dir[2400];
  char conf[2400];
  char ctx[2400];
  Str  s = { NULL, 0, 0 };
  Str  c = { NULL, 0, 0 };
  Str  m = { NULL, 0, 0 };
  int  status = 500;

  opcuaMapperPath(NULL, dir, sizeof(dir));
  opcuaMapperPath("opcua-bridge.json", conf, sizeof(conf));
  opcuaMapperPath("opcua-context.jsonld", ctx, sizeof(ctx));
  dirsMake(dir);

  //
  // The password: given - kept; no user - none kept; a user and none given - the one kept, which must exist
  //
  struct stat st;

  if (dP->opcua.username[0] == 0)
    unlink(pwPath);
  else if (dP->opcua.password[0] != 0)
    opcuaPasswordWrite(pwPath, dP->opcua.password, err, sizeof(err));
  else if (stat(pwPath, &st) != 0)
  {
    snprintf(err, sizeof(err), "the OPC UA user '%s' has no password: give it once, c3 keeps it", dP->opcua.username);
    status = 400;
  }
  memset(dP->opcua.password, 0, sizeof(dP->opcua.password));

  if (err[0] == 0)
  {
    if (vocabulary[0] == 0)
      snprintf(vocabulary, sizeof(vocabulary), "https://uri.etsi.org/ngsi-ld/default-context/");

    strAdd(&s, "{");
    opcuaMemberWrite(dP, pwPath, models, &s);
    strAdd(&s, "}\n");

    opcuaContextText(&c, vocabulary, dP->opcua.channels, terms);

    //
    // The mapping, as posted but for the password
    //
    CorNode* vocP = corTreeLookup(bodyP, "vocabulary");

    strAdd(&m, "{");
    opcuaServerJson(dP, &m, (dP->opcua.username[0] != 0));
    strAdd(&m, ", \"vocabulary\": ");   strAddJson(&m, ((vocP != NULL) && (vocP->type == CorString) && (vocP->value.s[0] != 0)) ? vocP->value.s : NULL);
    strAdd(&m, ", \"channels\": ");     rowsJson(&m, dP->opcua.channels, opcuaChannelNames, 4, false);
    strAdd(&m, ", \"models\": ");       opcuaModelsJson(&m, models, false);
    strAdd(&m, ", \"terms\": [");
    bool  first = true;
    char* save  = NULL;
    for (char* t = strtok_r(terms, "\n", &save); t != NULL; t = strtok_r(NULL, "\n", &save))
    {
      strAdd(&m, first ? "" : ", ");
      strAddJson(&m, t);
      first = false;
    }
    strAdd(&m, "]}\n");

    if (textWrite(conf, s.s, s.len, err, sizeof(err)) &&
        textWrite(ctx, c.s, c.len, err, sizeof(err)) &&
        textWrite(mapping, m.s, m.len, err, sizeof(err)))
      status = 201;
  }

  free(dP);
  free(models);
  free(terms);
  strFree(&s);
  strFree(&c);

  if (status != 201)
  {
    strFree(&m);
    serveError(connP, status, (status == 400) ? "Bad request" : "The OPC UA configuration was not written", err);
    return;
  }

  opcuaFilesAnswer(connP, 201, m.s);
  strFree(&m);
}




// -----------------------------------------------------------------------------
//
// runRequest - /api/run...
//
void runRequest(CorHttpConn* connP, const char* path)
{
  const char* method = connP->method.s;
  bool        get    = (strcmp(method, "GET") == 0);
  bool        post   = (strcmp(method, "POST") == 0);

  if (runDir[0] == 0)
  {
    serveError(connP, 503, "Run is not available", "no $HOME and no $XDG_DATA_HOME");
    return;
  }

  if (strcmp(path, "/api/run") == 0)
  {
    if (get) runState(connP); else serveError(connP, 405, "Method not allowed", path);
    return;
  }
  if (strcmp(path, "/api/run/sources") == 0)
  {
    if (get) runSources(connP); else serveError(connP, 405, "Method not allowed", path);
    return;
  }
  if (strcmp(path, "/api/run/images") == 0)
  {
    if (get) jobStart(connP, imagesThread, NULL); else serveError(connP, 405, "Method not allowed", path);
    return;
  }
  if (strcmp(path, "/api/run/command") == 0)
  {
    if (post) runCommand(connP); else serveError(connP, 405, "Method not allowed", path);
    return;
  }
  if (strcmp(path, "/api/run/dds/discover") == 0)
  {
    if (post) discoverRequest(connP, ddsDiscoverThread); else serveError(connP, 405, "Method not allowed", path);
    return;
  }
  if (strcmp(path, "/api/run/opcua/discover") == 0)
  {
    if (post) discoverRequest(connP, opcuaDiscoverThread); else serveError(connP, 405, "Method not allowed", path);
    return;
  }
  if (strcmp(path, "/api/run/opcua/files") == 0)
  {
    if (post || get) opcuaFiles(connP, post); else serveError(connP, 405, "Method not allowed", path);
    return;
  }
  if (strcmp(path, "/api/run/dds/files") == 0)
  {
    if (post || get) ddsFiles(connP, post); else serveError(connP, 405, "Method not allowed", path);
    return;
  }
  if (strcmp(path, "/api/run/brokers") == 0)
  {
    Def d;
    if (!post)
      serveError(connP, 405, "Method not allowed", path);
    else if (bodyDef(connP, &d))
    {
      if (opcuaPasswordKeep(connP, &d) == true)    // the password into its file, out of the Def
        brokerStart(connP, &d);
    }
    return;
  }

  //
  // /api/run/<what>/<name>[/<action>]
  //
  char        what[16];
  char        name[128];
  char        action[16] = "";
  const char* rest  = &path[9];
  const char* slash = strchr(rest, '/');

  if (slash == NULL)
  {
    serveError(connP, 404, "Not found", path);
    return;
  }
  snprintf(what, sizeof(what), "%.*s", (int) (slash - rest) < 15 ? (int) (slash - rest) : 15, rest);
  rest  = slash + 1;
  slash = strchr(rest, '/');
  snprintf(name, sizeof(name), "%.*s", (slash != NULL) ? (((int) (slash - rest) < 127) ? (int) (slash - rest) : 127) : 127, rest);
  if (slash != NULL)
    snprintf(action, sizeof(action), "%s", slash + 1);

  if ((nameOk(name) == false) || (strlen(name) > 96))
  {
    serveError(connP, 404, "Not found", path);
    return;
  }

  if (strcmp(what, "brokers") == 0)
  {
    pthread_mutex_lock(&rMutex);
    Broker* bP = brokerFind(name);
    if (bP == NULL)
    {
      pthread_mutex_unlock(&rMutex);
      serveError(connP, 404, "No such broker", name);
      return;
    }

    if (post && (strcmp(action, "start") == 0))
    {
      Def d = bP->def;
      pthread_mutex_unlock(&rMutex);
      brokerStart(connP, &d);
    }
    else if (post && (strcmp(action, "stop") == 0))
      brokerStop(connP, bP);                     // unlocks
    else if ((strcmp(method, "DELETE") == 0) && (action[0] == 0))
      brokerForget(connP, bP);                   // unlocks
    else if (get && (strcmp(action, "log") == 0))
      logFollow(connP, bP->logPath, &bP->logEnd, &bP->subs, &bP->lastBeat);   // unlocks
    else if (get && (action[0] == 0))
    {
      Str s = { NULL, 0, 0 };
      brokerRender(bP, &s);
      pthread_mutex_unlock(&rMutex);
      respondStr(connP, 200, &s);
    }
    else
    {
      pthread_mutex_unlock(&rMutex);
      serveError(connP, 405, "Method not allowed", path);
    }
    return;
  }

  if (strcmp(what, "services") == 0)
  {
    pthread_mutex_lock(&rMutex);
    Service* sP = svcFind(name);
    if (sP == NULL)
    {
      pthread_mutex_unlock(&rMutex);
      serveError(connP, 404, "No such service", name);
      return;
    }

    if (get && (strcmp(action, "log") == 0))
      logFollow(connP, sP->logPath, &sP->logEnd, &sP->subs, &sP->lastBeat);   // unlocks
    else if (post && (strcmp(action, "stop") == 0))
    {
      int users = svcUsers(sP->container, NULL);
      bool busy = sP->busy;
      pthread_mutex_unlock(&rMutex);

      if ((users > 0) || busy)
        serveError(connP, 409, "It is in use", busy ? "it is starting or stopping" : "a broker started from c3 uses it - stop the broker");
      else
      {
        threadStart(svcStopThread, strdup(name));
        serveJson(connP, 202, "{}");
      }
    }
    else
    {
      pthread_mutex_unlock(&rMutex);
      serveError(connP, 405, "Method not allowed", path);
    }
    return;
  }

  if ((strcmp(what, "volumes") == 0) && (strcmp(method, "DELETE") == 0) && (action[0] == 0))
  {
    if ((strncmp(name, "c3-", 3) != 0) || (engine[0] == 0))
      serveError(connP, 404, "No such volume", name);
    else
      jobStart(connP, volumeThread, name);
    return;
  }

  serveError(connP, 404, "Not found", path);
}



// -----------------------------------------------------------------------------
//
// runCapabilities - GET /api/capabilities's "run"
//
void runCapabilities(Str* sP)
{
  char path[2048];
  char version[4096];

  if (engine[0] == 0)
    engineFind();                                // installed since: found now

  installedFind(path, sizeof(path), version, sizeof(version));

  strAdd(sP, "{\"coraine\": ");     strAddJson(sP, (path[0] != 0) ? path : NULL);
  strAdd(sP, ", \"coraineWhy\": "); strAddJson(sP, (path[0] != 0) ? NULL : "install the coraine package to run the installed broker");
  strAdd(sP, ", \"containers\": "); strAdd(sP, (engine[0] != 0) ? "true" : "false");
  strAdd(sP, ", \"engine\": ");     strAddJson(sP, (engine[0] != 0) ? engineName : NULL);
  strAdd(sP, ", \"engineVersion\": "); strAddJson(sP, (engineVersion[0] != 0) ? engineVersion : NULL);
  strAdd(sP, ", \"containersWhy\": "); strAddJson(sP, (engine[0] != 0) ? NULL : engineWhy);
  strAdd(sP, ", \"dir\": ");        strAddJson(sP, runDir);
  strAdd(sP, "}");
}



// -----------------------------------------------------------------------------
//
// runInit - the brokers kept (c3.json), attached to when they still run; the watching thread
//
bool runInit(void)
{
  if (dataHome("run", runDir, sizeof(runDir)) == false)
  {
    runDir[0] = 0;
    return false;
  }

  snprintf(svcDir, sizeof(svcDir), "%s/services", runDir);
  dirsMake(runDir);
  dirsMake(svcDir);

  engineFind();

  //
  // The brokers kept
  //
  CorAlloc alloc;
  char     buf[16 * 1024];
  CorJson  json;

  corAllocBufferInit(&alloc, buf, sizeof(buf), 256 * 1024, NULL, "run init");
  corJsonCreate(&json, &alloc);

  CorNode* rootP    = corJsonParse(&json, corAllocStrdup(&alloc, configText()));
  CorNode* runP     = (rootP != NULL) ? corTreeLookup(rootP, "run") : NULL;
  CorNode* brokersP = ((runP != NULL) && (runP->type == CorObject)) ? corTreeLookup(runP, "brokers") : NULL;

  for (CorNode* bnP = ((brokersP != NULL) && (brokersP->type == CorArray)) ? brokersP->value.head : NULL; bnP != NULL; bnP = bnP->next)
  {
    Def  d;
    char err[512];

    if (nBrokers >= BROKERS_MAX)
      break;
    if (defParse(bnP, &d, err, sizeof(err)) == false)
    {
      fprintf(stderr, "c3: a broker of Run in the configuration is left out: %s\n", err);
      continue;
    }
    if (brokerFind(d.name) != NULL)
      continue;

    Broker* bP = calloc(1, sizeof(Broker));
    bP->def        = d;
    bP->exitStatus = -1;
    snprintf(bP->state, sizeof(bP->state), "stopped");
    snprintf(bP->logPath, sizeof(bP->logPath), "%s/%s/broker.log", runDir, d.name);

    //
    // A native broker that runs still: its pid, and the process it names started when that one did
    //
    pid_t     pid;
    long long ps;
    time_t    started = 0;

    if ((strcmp(d.where, "native") == 0) && stateRead(d.name, &pid, &ps, &started))
    {
      if ((pid > 0) && (procStartTime(pid) == ps))
      {
        snprintf(bP->state, sizeof(bP->state), "running");
        bP->pid       = pid;
        bP->procStart = ps;
        bP->child     = false;
        bP->started   = started;
        logLine(bP->logPath, "c3 started again and attached to pid %d", (int) pid);
      }
      else
        stateClear(d.name);
    }

    //
    // The services it uses when it runs: those of its set that its options need
    //
    int mask = needs(&d);
    for (int k = 0; k < KINDS; k++)
    {
      if (mask & (1 << k))
      {
        svcGet(d.set, k);
        if (strcmp(bP->state, "running") == 0)
          svcName(d.set, k, bP->usedSvc[k], sizeof(bP->usedSvc[k]));
      }
    }

    brokers[nBrokers++] = bP;
  }

  corAllocBufferReset(&alloc, false);

  //
  // A container broker that runs is found by the first scan, which marks it as using its services too
  //
  engineScan();
  pthread_mutex_lock(&rMutex);
  for (int ix = 0; ix < nBrokers; ix++)
  {
    Broker* bP = brokers[ix];
    if ((strcmp(bP->def.where, "container") == 0) && (strcmp(bP->state, "running") == 0))
    {
      int mask = needs(&bP->def);
      for (int k = 0; k < KINDS; k++)
      {
        if (mask & (1 << k))
          svcName(bP->def.set, k, bP->usedSvc[k], sizeof(bP->usedSvc[k]));
      }
    }
  }
  pthread_mutex_unlock(&rMutex);

  monitorRuns = (pthread_create(&monitorTid, NULL, monitorThread, NULL) == 0);
  return true;
}



// -----------------------------------------------------------------------------
//
// runShutdown - c3 stops: the brokers and services keep running (the next c3 attaches to them); a start or
// stop under way is given 10 s; the log followers stop
//
void runShutdown(void)
{
  stopping = true;
  if (monitorRuns)
    pthread_join(monitorTid, NULL);

  for (int round = 0; round < 100; round++)
  {
    bool busy = false;

    pthread_mutex_lock(&rMutex);
    for (int ix = 0; ix < nBrokers; ix++)
      busy = busy || brokers[ix]->busy;
    pthread_mutex_unlock(&rMutex);

    if (!busy)
      break;
    usleep(100 * 1000);
  }

  pthread_mutex_lock(&rMutex);
  for (int ix = 0; ix < nBrokers; ix++)
  {
    sseSubsEnd(&brokers[ix]->subs);
    if (brokers[ix]->follower > 0)
    {
      kill(-brokers[ix]->follower, SIGTERM);
      waitpid(brokers[ix]->follower, NULL, 0);
    }
  }
  for (int ix = 0; ix < nSvcs; ix++)
  {
    sseSubsEnd(&svcs[ix].subs);
    if (svcs[ix].follower > 0)
    {
      kill(-svcs[ix].follower, SIGTERM);
      waitpid(svcs[ix].follower, NULL, 0);
    }
  }
  pthread_mutex_unlock(&rMutex);
}
