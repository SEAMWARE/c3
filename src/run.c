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
//   GET    /api/run/image?ref=<image>           what an image's broker has: its --version, once per image ID
//   GET    /api/run/options?from=&src=&database=&troe=   a broker's options: its -u and -U
//   POST   /api/run/command                     {broker}: the command it would run and the services it needs
//   POST   /api/run/brokers                     {broker}: kept (c3.json, "run") and started - 202
//   POST   /api/run/brokers/<name>/start        start one kept
//   POST   /api/run/brokers/<name>/stop         SIGTERM, SIGKILL after its grace period; then its services, if
//                                               nothing else uses them
//   DELETE /api/run/brokers/<name>[?data=true]  forget a stopped one (and delete its data)
//   GET    /api/run/brokers/<name>/log          Accept: text/event-stream - its log, live; else the file
//   GET    /api/run/services/<container>/log    the same for a service
//   POST   /api/run/services/<container>/stop   a service nothing uses
//   POST   /api/run/containers/<name>/start|stop   any container on the machine (Operate's Containers)
//   GET    /api/run/containers/<name>/log       its last 500 lines
//   GET    /api/run/external/log?port=<port>    the log of a broker on this machine c3 did not start - <logDir>/coraine.log
//                                               as its GET /admin/config says, when it logs to a file; by Range (externalLog)
//   DELETE /api/run/volumes/<volume>            a service's or a container broker's data, deleted
//   POST   /api/run/dds/discover                {broker}: what its DDS domain announces - a broker of its own
//                                               for it, natively or in a container, started and stopped
//                                               again (ddsDiscoverThread)
//   GET    /api/run/dds/files                   the DDS configuration the mapper wrote: its files and mapping
//   POST   /api/run/dds/files                   {domain, transport, interfaces, vocabulary, topics, services, actions}: written (ddsFiles)
//   POST   /api/run/opcua/discover              {broker, its opcua server}: the server's address space - a broker of
//                                               its own (opcuaDiscoverThread)
//   GET    /api/run/opcua/files                 the OPC UA configuration the mapper wrote: its files and mapping
//   POST   /api/run/aas/discover                {broker, its aas server}: the server's shells and submodels, each one's
//                                               model - a broker of its own (aasDiscoverThread)
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
#include <ftw.h>                                 // nftw
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
#include <sys/time.h>                            // struct timeval
#include <sys/wait.h>                            // waitpid
#include <time.h>                                // time
#include <unistd.h>                              // close, write, usleep
#include <zlib.h>                                // crc32 - the widgets' .wgt

#include "corAlloc/corAlloc.h"                   // corAlloc
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
  const char*  env[8];                           // -e each, "{set}" the set's name; NULL-terminated
  const char*  cmd[4];                           // the command, or none (the image's)
  bool         secretEnv;                        // also --env-file: the set's generated keys (dashboardEnvFile)
} ServiceKind;

static const ServiceKind kinds[] =
{
  { "mongo",     "MongoDB",                  "mongo:8.2",                     27017, 37017, "/data/db",              { NULL },                             { NULL }, false },
  { "timescale", "PostgreSQL + TimescaleDB", "timescale/timescaledb-ha:pg16", 5432,  15432, "/home/postgres/pgdata", { "POSTGRES_HOST_AUTH_METHOD=trust", NULL }, { NULL }, false },
  { "mosquitto", "Mosquitto",                "eclipse-mosquitto:2",           1883,  11883, "/mosquitto/data",       { NULL },                             { "mosquitto", "-c", "/mosquitto-no-auth.conf", NULL }, false },

  //
  // The Dashboard's (dashboard.c reads these through runDashboard*): WireCloud and what it stores in. No
  // published WireCloud 2 image yet (Ficodes/WireCloud#7): the one built from its source, by that name.
  // MongoDB without a replica set has no transactions - WireCloud is told so instead of finding out.
  //
  { "elasticsearch", "Elasticsearch", "docker.elastic.co/elasticsearch/elasticsearch:8.13.4", 9200, 19200, "/usr/share/elasticsearch/data",
    { "discovery.type=single-node", "xpack.security.enabled=false", "ES_JAVA_OPTS=-Xms512m -Xmx512m", NULL }, { NULL }, false },
  { "wirecloud", "WireCloud", "wirecloud-fastapi:latest", 8000, 18000, "/var/lib/wirecloud",
    { "WIRECLOUD_DB_HOST=c3-{set}-mongo", "WIRECLOUD_ES_HOST=c3-{set}-elasticsearch", "WIRECLOUD_DB_USE_TRANSACTIONS=false",
      "WIRECLOUD_BASEDIR=/var/lib/wirecloud", NULL }, { NULL }, true },
};

#define KIND_MONGO          0
#define KIND_TIMESCALE      1
#define KIND_MOSQUITTO      2
#define KIND_ELASTICSEARCH  3
#define KIND_WIRECLOUD      4
#define KINDS               5



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
  char  store[16];                               // corDB, ramDB, mongoc
  bool  dbDir;                                   // corDB: kept on disk
  char  dbPath[1024];                            // corDB on disk, native: the directory chosen; "": <run>/<name>/data
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
  struct                                         // the aas bridge's server and AssetChannels - the bridge configuration c3 writes
  {
    char  url[512];                              // http[s]://host[:port][/base path]; "": no AAS
    char  caFile[1024];                          // the CAs the server's certificate is verified against, a PEM file; "": the system's
    bool  insecure;                              // the server's certificate not verified
    char  clientCert[1024];                      // the bridge's own certificate (and its chain), PEM - mutual TLS; "": none
    char  clientKey[1024];                       // its private key, PEM; "": in clientCert's file
    char  credentials[16];                       // none, authorization (the Authorization header c3 keeps) or oauth2
    char  tokenUrl[512];                         // oauth2: the token endpoint (the client credentials grant)
    char  clientId[256];                         // oauth2: the client's id
    char  scope[256];                            // oauth2: the scope asked for; "": none
    char  clientSecret[512];                     // WRITE-ONLY: the oauth2 client's secret as a request gave it, kept in
                                                 // <broker dir>/aas.client-secret (0600) and wiped
    char  registry[512];                         // an AAS Registry, http[s]://host[:port][/base path]; "": none
    char  push[512];                             // the MQTT broker the AAS server publishes its change events to, mqtt://host[:port]; "": none
    char  channels[16384];                       // the AssetChannels - a line each: shell (or submodel) id, entities ("natural" or the
                                                 // rules as JSON), attributeLayout, channelDirection, pollInterval ("": the bridge's) - tab-separated
    char  authorization[2048];                   // WRITE-ONLY: the Authorization header's value as a request gave it, kept in
                                                 // <broker dir>/aas.authorization (0600) and wiped
  } aas;
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
  char  options[4096];                           // the form's options of the broker's usage (-u), quoted as args
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
static char*           containers = NULL;      // every container on the machine, as JSON (engineScan) - Operate's Containers
static Broker*         brokers[BROKERS_MAX];
static int             nBrokers  = 0;
static Service         svcs[SERVICES_MAX];
static int             nSvcs     = 0;

//
// The Dashboard's state (its section: "The Dashboard", below)
//
#define DASHBOARD_SET   "dashboard"
#define DASHBOARD_USER  "admin"

typedef struct DashStep
{
  char     text[200];
  time_t   start;
  time_t   end;                                  // 0: it runs
  bool     failed;
} DashStep;

#define DASH_STEPS  40

typedef struct Dashboard
{
  bool     busy;                                 // a start or a stop runs
  char     doing[200];                           // what it does now ("" when not busy)
  bool     stepsOfStart;                         // the steps are a start's (else a stop's)
  DashStep steps[DASH_STEPS];                    // the last start's or stop's steps, kept after it ended
  int      nSteps;
  int      total;                                // how many steps it should take, as far as known
  char     why[600];                             // why the last start failed; "" - it did not
  bool     loginFailed;                          // WireCloud's admin does not take c3's password (reset-password helps)
  char     logPath[2300];
  int64_t  logEnd;
  SseSubs  subs;
  time_t   lastBeat;
} Dashboard;

static Dashboard dash;                           // rMutex
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
  char*  v[320];
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

static int engineArgvEnv(Argv* aP, char* const envp[], char* out, int outSize, int timeoutS)
{
  int status = runCaptureEnv(aP->v, envp, out, outSize, timeoutS);
  int len    = strlen(out);

  while ((len > 0) && ((out[len - 1] == '\n') || (out[len - 1] == '\r')))
    out[--len] = 0;

  return status;
}

#define engineArgv(aP, out, outSize, timeoutS)  engineArgvEnv(aP, NULL, out, outSize, timeoutS)   // in c3's environment



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
// installed: `coraine` in $PATH; a build: its install/bin/<executable>, with its install/plugins. Their
// --version (brokerVersion: as a start sees them) is cached by path and mtime: features, HTTP servers and the
// plugins found - the "plugins:" line, coraine#631 - decide what the form offers.
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

  char out[4096];

  if (brokerVersion(path, NULL, out, sizeof(out)) != 0)
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
// The builds' --version, by binary: asked again when the binary changes. A record made before the plugins line
// (coraine#631), or with c3's own plugin directory, says less than the binary does
//
typedef struct BuildVersion
{
  char    binary[2400];
  time_t  mtime;
  char*   version;
} BuildVersion;

static BuildVersion bvCache[32];
static int          bvNext = 0;

static char* buildBinaryVersion(const char* binary, const char* pluginDir)
{
  struct stat st;
  if (stat(binary, &st) != 0)
    return NULL;

  pthread_mutex_lock(&srcMutex);
  for (int ix = 0; ix < 32; ix++)
  {
    if ((bvCache[ix].version != NULL) && (bvCache[ix].mtime == st.st_mtime) && (strcmp(bvCache[ix].binary, binary) == 0))
    {
      char* v = strdup(bvCache[ix].version);
      pthread_mutex_unlock(&srcMutex);
      return v;
    }
  }
  pthread_mutex_unlock(&srcMutex);

  char out[8192];
  if ((brokerVersion(binary, pluginDir, out, sizeof(out)) != 0) || (out[0] == 0))
    return NULL;

  pthread_mutex_lock(&srcMutex);
  BuildVersion* bP = &bvCache[bvNext];
  bvNext = (bvNext + 1) % 32;
  if (bP->version != NULL) free(bP->version);
  snprintf(bP->binary, sizeof(bP->binary), "%s", binary);
  bP->mtime   = st.st_mtime;
  bP->version = strdup(out);
  pthread_mutex_unlock(&srcMutex);

  return strdup(out);
}

//
// buildVersion - a build's --version (the built broker's own, with its install/plugins - buildBinaryVersion;
// the record's when that cannot be run), malloc'ed; NULL: no such build, or one that did not succeed
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
  {
    CorNode* eP = corTreeLookup(recP, "executable");
    char     dir[2300];
    char     binary[2400];
    char     plugins[2400];

    buildDirOf(build, dir, sizeof(dir));
    snprintf(binary,  sizeof(binary),  "%s/install/bin/%s", dir,
             ((eP != NULL) && (eP->type == CorString) && (eP->value.s[0] != 0) && (strchr(eP->value.s, '/') == NULL)) ? eP->value.s : "coraine");
    snprintf(plugins, sizeof(plugins), "%s/install/plugins", dir);

    out = buildBinaryVersion(binary, plugins);
    if (out == NULL)
      out = strdup(((vP != NULL) && (vP->type == CorString)) ? vP->value.s : "");
  }

  corAllocBufferReset(&alloc, false);
  free(text);
  return out;
}



// -----------------------------------------------------------------------------
//
// buildMember - a string of a build's record: "executable" (the broker's file name in install/bin, coraine-build
// --name), "image" (its container image, coraine-build --image), "mode", "ended"; 'dflt' for a record without it (made before it
// was there) or no record. No '/' in an executable; an image's name has them
//
static void buildMember(const char* build, const char* member, const char* dflt, char* out, int outLen)
{
  char path[2300];

  snprintf(out, outLen, "%s", dflt);
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
  CorNode* eP   = (recP != NULL) ? corTreeLookup(recP, member) : NULL;

  if ((eP != NULL) && (eP->type == CorString) && (eP->value.s[0] != 0) && ((strcmp(member, "image") == 0) || (strchr(eP->value.s, '/') == NULL)))
    snprintf(out, outLen, "%s", eP->value.s);

  corAllocBufferReset(&alloc, false);
  free(text);
}



// -----------------------------------------------------------------------------
//
// pluginsLacks - a --version's "plugins:" line (coraine#631: db troe api auth bridges transports, each
// comma-separated) names 'kind' without 'name': the broker cannot be asked for it. No line, or no such kind
// in it (a coraine before #631): not known, so not lacking
//
static bool pluginsLacks(const char* version, const char* kind, const char* name)
{
  const char* line = (version != NULL) ? strstr(version, "plugins: ") : NULL;
  if ((line == NULL) || ((line != version) && (line[-1] != '\n')))
    return false;

  const char* end = strchr(line, '\n');
  int         len = (end != NULL) ? (int) (end - line) : (int) strlen(line);
  char        buf[1024];
  char        key[32];

  snprintf(buf, sizeof(buf), " %.*s", len - 8, &line[8]);   // " db=... troe=..." - each kind after a blank
  snprintf(key, sizeof(key), " %s=", kind);

  char* kP = strstr(buf, key);
  if (kP == NULL)
    return false;

  char* list = kP + strlen(key);
  char* stop = strchr(list, ' ');
  if (stop != NULL)
    *stop = 0;

  char* save = NULL;
  for (char* item = strtok_r(list, ",", &save); item != NULL; item = strtok_r(NULL, ",", &save))
  {
    if (strcmp(item, name) == 0)
      return false;
  }
  return true;
}

//
// pluginsKnown - the --version has the "plugins:" line
//
static bool pluginsKnown(const char* version)
{
  const char* line = (version != NULL) ? strstr(version, "plugins: ") : NULL;
  return (line != NULL) && ((line == version) || (line[-1] == '\n'));
}



// -----------------------------------------------------------------------------
//
// The images' --version (docker run --rm --entrypoint coraine <image> --version, ~1 s), by image ID - asked
// again when the tag names another image. An image that is not here is not known before its start pulls it
//
typedef struct ImageVersion
{
  char    ref[512];
  char    id[80];
  char*   version;
} ImageVersion;

static ImageVersion ivCache[16];
static int          ivNext = 0;

//
// imageVersionCached - the last --version read for this image reference (malloc'ed), NULL: none read
//
static char* imageVersionCached(const char* ref)
{
  char* v = NULL;

  pthread_mutex_lock(&srcMutex);
  for (int ix = 0; ix < 16; ix++)
  {
    if ((ivCache[ix].version != NULL) && (strcmp(ivCache[ix].ref, ref) == 0))
    {
      v = strdup(ivCache[ix].version);
      break;
    }
  }
  pthread_mutex_unlock(&srcMutex);
  return v;
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

static const char* bridgeNames[] = { "aas", "cep", "ckan", "dds", "loopback", "modbus", "mqtt", "opcua", NULL };



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



// -----------------------------------------------------------------------------
//
// aasRulesText - an AssetChannel's "entities" rules, [{ "from", "type", "semanticId" }], as compact JSON in 'out':
// "from" shell, submodel or collection (the AAS node kinds coraine's AssetMap makes entities of), "type" the
// entity type, "semanticId" (optional) the meaning a node must have - false with why
//
static bool aasRulesText(CorNode* rulesP, char* out, int outLen, char* err, int errLen)
{
  Str s = { NULL, 0, 0 };

  if ((rulesP->type != CorArray) || (rulesP->value.head == NULL))
  {
    snprintf(err, errLen, "\"aas.channels[].entities\" is \"natural\" or a non-empty array of rules: { \"from\", \"type\", \"semanticId\" }");
    return false;
  }

  strAdd(&s, "[");
  for (CorNode* rP = rulesP->value.head; rP != NULL; rP = rP->next)
  {
    CorNode* fromP = (rP->type == CorObject) ? corTreeLookup(rP, "from")       : NULL;
    CorNode* typeP = (rP->type == CorObject) ? corTreeLookup(rP, "type")       : NULL;
    CorNode* semP  = (rP->type == CorObject) ? corTreeLookup(rP, "semanticId") : NULL;

    if ((fromP == NULL) || (fromP->type != CorString) ||
        ((strcmp(fromP->value.s, "shell") != 0) && (strcmp(fromP->value.s, "submodel") != 0) && (strcmp(fromP->value.s, "collection") != 0)))
    {
      snprintf(err, errLen, "an AAS entity rule's \"from\" is shell, submodel or collection - the kind of node it makes an entity of");
      strFree(&s);
      return false;
    }
    if ((typeP == NULL) || (typeP->type != CorString) || (typeP->value.s[0] == 0) || (strpbrk(typeP->value.s, " \t\n\"<>") != NULL))
    {
      snprintf(err, errLen, "an AAS entity rule's \"type\" is the entity type it makes - a name without spaces (Nameplate)");
      strFree(&s);
      return false;
    }
    if ((semP != NULL) && (semP->type != CorNull) && ((semP->type != CorString) || (strpbrk(semP->value.s, "\t\n") != NULL)))
    {
      snprintf(err, errLen, "an AAS entity rule's \"semanticId\" is a string - the meaning a node must have (its semanticId's first key)");
      strFree(&s);
      return false;
    }

    strAdd(&s, (rP == rulesP->value.head) ? "{\"from\": " : ", {\"from\": ");
    strAddJson(&s, fromP->value.s);
    if ((semP != NULL) && (semP->type == CorString) && (semP->value.s[0] != 0))
    {
      strAdd(&s, ", \"semanticId\": ");
      strAddJson(&s, semP->value.s);
    }
    strAdd(&s, ", \"type\": ");
    strAddJson(&s, typeP->value.s);
    strAdd(&s, "}");
  }
  strAdd(&s, "]");

  if (s.len >= outLen)
  {
    snprintf(err, errLen, "an AAS AssetChannel's entity rules are too long");
    strFree(&s);
    return false;
  }
  snprintf(out, outLen, "%s", s.s);
  strFree(&s);
  return true;
}



// -----------------------------------------------------------------------------
//
// aasChannelsParse - "channels": [{ "id", "entities", "attributeLayout", "channelDirection", "pollInterval" }] - an
// AssetChannel each, its endpoint a shell's (or a submodel's) id - as aas.channels' lines
//
static bool aasChannelsParse(CorNode* chP, char* out, int outLen, char* err, int errLen)
{
  int len = 0;

  out[0] = 0;
  if ((chP == NULL) || (chP->type == CorNull))
    return true;

  if (chP->type != CorArray)
  {
    snprintf(err, errLen, "\"aas.channels\" is an array: an AssetChannel each - { \"id\", \"entities\", \"attributeLayout\", \"channelDirection\", \"pollInterval\" }");
    return false;
  }

  for (CorNode* cP = chP->value.head; cP != NULL; cP = cP->next)
  {
    char id[1024]      = "";
    char layout[16]    = "";
    char direction[8]  = "";
    char poll[32]      = "";
    char entities[4096];

    if (cP->type != CorObject)
    {
      snprintf(err, errLen, "an AAS AssetChannel is an object: { \"id\", \"entities\", \"attributeLayout\", \"channelDirection\", \"pollInterval\" }");
      return false;
    }

    if (!memberString(cP, "id",               id,        sizeof(id),        err, errLen) ||
        !memberString(cP, "attributeLayout",  layout,    sizeof(layout),    err, errLen) ||
        !memberString(cP, "channelDirection", direction, sizeof(direction), err, errLen) ||
        !memberString(cP, "pollInterval",     poll,      sizeof(poll),      err, errLen))
      return false;

    if ((id[0] == 0) || (strpbrk(id, "\t\n") != NULL))
    {
      snprintf(err, errLen, "an AAS AssetChannel's \"id\" is the id of a shell or a submodel of the server");
      return false;
    }

    CorNode* entP = corTreeLookup(cP, "entities");

    if ((entP == NULL) || (entP->type == CorNull) || ((entP->type == CorString) && (strcmp(entP->value.s, "natural") == 0)))
      snprintf(entities, sizeof(entities), "natural");
    else if (entP->type == CorString)
    {
      snprintf(err, errLen, "\"aas.channels[].entities\" is \"natural\" or an array of rules: { \"from\", \"type\", \"semanticId\" }");
      return false;
    }
    else if (aasRulesText(entP, entities, sizeof(entities), err, errLen) == false)
      return false;

    if (layout[0] == 0)
      snprintf(layout, sizeof(layout), "attributes");
    if ((strcmp(layout, "attributes") != 0) && (strcmp(layout, "subAttributes") != 0) && (strcmp(layout, "value") != 0))
    {
      snprintf(err, errLen, "\"aas.channels[].attributeLayout\" is attributes, subAttributes or value - what a collection that is no entity becomes");
      return false;
    }

    if (direction[0] == 0)
      snprintf(direction, sizeof(direction), "in");
    if ((strcmp(direction, "in") != 0) && (strcmp(direction, "both") != 0))
    {
      snprintf(err, errLen, "\"aas.channels[].channelDirection\" is in or both (a client's write goes to the AAS server first)");
      return false;
    }

    bool pollOk = (poll[0] == 0) || ((strncmp(poll, "PT", 2) == 0) && (poll[2] != 0) && (strspn(&poll[2], "0123456789.HMS") == strlen(&poll[2])) &&
                                     (strchr("HMS", poll[strlen(poll) - 1]) != NULL));
    if (pollOk == false)
    {
      snprintf(err, errLen, "\"aas.channels[].pollInterval\" is an ISO 8601 duration: PT10S, PT0.5S, PT1M - or none, the bridge's (10 s)");
      return false;
    }

    int n = snprintf(&out[len], outLen - len, "%s%s\t%s\t%s\t%s\t%s", (len > 0) ? "\n" : "", id, entities, layout, direction, poll);
    if (n >= outLen - len)
    {
      snprintf(err, errLen, "too many AAS AssetChannels");
      return false;
    }
    len += n;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// aasUrlOk - 'u' empty, or one of the schemes (space-separated, each with its "://") and no space, tab, newline or quote
//
static bool aasUrlOk(const char* u, const char* schemes)
{
  if (u[0] == 0)
    return true;
  if (strpbrk(u, " \t\r\n\"") != NULL)
    return false;

  char copy[64];
  char* save = NULL;

  snprintf(copy, sizeof(copy), "%s", schemes);
  for (char* sch = strtok_r(copy, " ", &save); sch != NULL; sch = strtok_r(NULL, " ", &save))
  {
    int n = strlen(sch);
    if ((strncmp(u, sch, n) == 0) && (u[n] != 0))
      return true;
  }

  return false;
}



// -----------------------------------------------------------------------------
//
// aasParse - "aas": { "url", "caFile", "insecure", "clientCert", "clientKey", "credentials", "authorization",
// "oauth2": { "tokenUrl", "clientId", "clientSecret", "scope" }, "registry", "push", "channels": [...] } - the bridge's
// own "server" shape (corAasBridge's README), "registry" and "push" its url, but the secrets: the Authorization
// header's value and the OAuth2 client's secret, which c3 keeps in files and hands the broker in its environment.
// "credentials" says which one the broker uses: none, authorization (absent: an older c3.json) or oauth2
//
static bool aasParse(CorNode* aP, Def* dP, char* err, int errLen)
{
  if ((aP == NULL) || (aP->type == CorNull))
    return true;

  if (aP->type != CorObject)
  {
    snprintf(err, errLen, "\"aas\" is an object");
    return false;
  }

  CorNode* oP = corTreeLookup(aP, "oauth2");

  if ((oP != NULL) && (oP->type != CorNull) && (oP->type != CorObject))
  {
    snprintf(err, errLen, "\"aas.oauth2\" is an object: { \"tokenUrl\", \"clientId\", \"clientSecret\", \"scope\" }");
    return false;
  }

  if (!memberString(aP, "url",           dP->aas.url,           sizeof(dP->aas.url),           err, errLen) ||
      !memberString(aP, "caFile",        dP->aas.caFile,        sizeof(dP->aas.caFile),        err, errLen) ||
      !memberBool(aP,   "insecure",      &dP->aas.insecure,     err, errLen) ||
      !memberString(aP, "clientCert",    dP->aas.clientCert,    sizeof(dP->aas.clientCert),    err, errLen) ||
      !memberString(aP, "clientKey",     dP->aas.clientKey,     sizeof(dP->aas.clientKey),     err, errLen) ||
      !memberString(aP, "credentials",   dP->aas.credentials,   sizeof(dP->aas.credentials),   err, errLen) ||
      !memberString(aP, "authorization", dP->aas.authorization, sizeof(dP->aas.authorization), err, errLen) ||
      !memberString(aP, "registry",      dP->aas.registry,      sizeof(dP->aas.registry),      err, errLen) ||
      !memberString(aP, "push",          dP->aas.push,          sizeof(dP->aas.push),          err, errLen) ||
      ((oP != NULL) && (oP->type == CorObject) &&
       (!memberString(oP, "tokenUrl",     dP->aas.tokenUrl,     sizeof(dP->aas.tokenUrl),     err, errLen) ||
        !memberString(oP, "clientId",     dP->aas.clientId,     sizeof(dP->aas.clientId),     err, errLen) ||
        !memberString(oP, "clientSecret", dP->aas.clientSecret, sizeof(dP->aas.clientSecret), err, errLen) ||
        !memberString(oP, "scope",        dP->aas.scope,        sizeof(dP->aas.scope),        err, errLen))) ||
      !aasChannelsParse(corTreeLookup(aP, "channels"), dP->aas.channels, sizeof(dP->aas.channels), err, errLen))
    return false;

  if (dP->aas.credentials[0] == 0)
    snprintf(dP->aas.credentials, sizeof(dP->aas.credentials), "authorization");

  const char* cr = dP->aas.credentials;

  if ((strcmp(cr, "none") != 0) && (strcmp(cr, "authorization") != 0) && (strcmp(cr, "oauth2") != 0))
  {
    snprintf(err, errLen, "\"aas.credentials\" is none, authorization (an Authorization header) or oauth2 (an OAuth2 client's token)");
    return false;
  }

  if (!aasUrlOk(dP->aas.url, "http:// https://"))
  {
    snprintf(err, errLen, "\"aas.url\" is http[s]://<host>[:<port>][/<base path>] - where the AAS API is (/api/v3.0 on some servers)");
    return false;
  }

  if (!aasUrlOk(dP->aas.registry, "http:// https://"))
  {
    snprintf(err, errLen, "\"aas.registry\" is http[s]://<host>[:<port>][/<base path>] - where the AAS Registry's API is");
    return false;
  }

  if (!aasUrlOk(dP->aas.push, "mqtt://"))
  {
    snprintf(err, errLen, "\"aas.push\" is mqtt://<host>[:<port>] - the MQTT broker the AAS server publishes its changes to (no TLS yet)");
    return false;
  }

  if ((dP->aas.clientKey[0] != 0) && (dP->aas.clientCert[0] == 0))
  {
    snprintf(err, errLen, "\"aas.clientKey\" is the key of \"aas.clientCert\" - give the certificate too");
    return false;
  }

  if (strpbrk(dP->aas.authorization, "\r\n") != NULL)
  {
    snprintf(err, errLen, "\"aas.authorization\" is the Authorization header's value, one line (Bearer ...)");
    return false;
  }

  if ((dP->aas.authorization[0] != 0) && (strcmp(cr, "authorization") != 0))
  {
    snprintf(err, errLen, "an Authorization header with \"aas.credentials\" %s - the broker would not send it", cr);
    return false;
  }

  if (strcmp(cr, "oauth2") == 0)
  {
    if ((dP->aas.tokenUrl[0] == 0) || !aasUrlOk(dP->aas.tokenUrl, "http:// https://") || (dP->aas.clientId[0] == 0))
    {
      snprintf(err, errLen, "OAuth2 credentials: \"aas.oauth2.tokenUrl\" (http[s]://..., the token endpoint) and \"aas.oauth2.clientId\"");
      return false;
    }
    if (strpbrk(dP->aas.clientSecret, "\r\n") != NULL)
    {
      snprintf(err, errLen, "\"aas.oauth2.clientSecret\" is one line");
      return false;
    }
  }
  else if ((dP->aas.tokenUrl[0] != 0) || (dP->aas.clientId[0] != 0) || (dP->aas.clientSecret[0] != 0))
  {
    snprintf(err, errLen, "\"aas.oauth2\" with \"aas.credentials\" %s - the broker would not use it", cr);
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
      !memberString(oP, "dbPath",       dP->dbPath,       sizeof(dP->dbPath),       err, errLen) ||
      !memberString(oP, "args",         dP->args,         sizeof(dP->args),         err, errLen) ||
      !memberString(oP, "options",      dP->options,      sizeof(dP->options),      err, errLen) ||
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
      !aasParse(corTreeLookup(oP, "aas"), dP, err, errLen) ||
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
  // An AAS server is the aas bridge's, in the bridge configuration c3 writes - as OPC UA's
  //
  if (dP->aas.url[0] != 0)
  {
    if (dP->bridgeConfig[0] != 0)
    {
      snprintf(err, errLen, "the AAS server goes in the bridge configuration c3 writes - not with a bridge configuration file of one's own");
      return false;
    }
    if (!listHas(dP->bridges, "aas"))
    {
      int len = strlen(dP->bridges);
      snprintf(&dP->bridges[len], sizeof(dP->bridges) - len, "%saas", (len > 0) ? "," : "");
    }
  }
  else if (listHas(dP->bridges, "aas") && (dP->bridgeConfig[0] == 0))
  {
    snprintf(err, errLen, "the aas bridge needs an AAS server (its URL) - or a bridge configuration file of one's own");
    return false;
  }
  else if (dP->aas.channels[0] != 0)
  {
    snprintf(err, errLen, "AAS AssetChannels need the AAS server (its URL)");
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
  if ((strcmp(dP->store, "corDB") != 0) && (strcmp(dP->store, "ramDB") != 0) && (strcmp(dP->store, "mongoc") != 0))
  {
    snprintf(err, errLen, "\"store\" is corDB, ramDB or mongoc");
    return false;
  }
  if ((dP->dbPath[0] != 0) && (dP->dbPath[0] != '/'))
  {
    snprintf(err, errLen, "the database directory is an absolute path - not '%s'", dP->dbPath);
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
  if (!dP->dbDir || (strcmp(dP->where, "container") == 0))
    dP->dbPath[0] = 0;                           // a container's is its volume

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
// aasAuthorizationPath - where c3 keeps a broker's AAS Authorization header value: its directory, 0600
//
static void aasAuthorizationPath(const char* name, char* out, int outLen)
{
  char dir[2300];

  brokerDir(name, dir, sizeof(dir));
  snprintf(out, outLen, "%s/aas.authorization", dir);
}



// -----------------------------------------------------------------------------
//
// aasClientSecretPath - where c3 keeps a broker's AAS OAuth2 client secret: its directory, 0600
//
static void aasClientSecretPath(const char* name, char* out, int outLen)
{
  char dir[2300];

  brokerDir(name, dir, sizeof(dir));
  snprintf(out, outLen, "%s/aas.client-secret", dir);
}



// -----------------------------------------------------------------------------
//
// aasChannelsJson - the AAS AssetChannels (aas.channels' lines): as the API has them, an array of { "id", "entities",
// "attributeLayout", "channelDirection", "pollInterval" } - or 'keyed', the bridge configuration's "assetChannels":
// an object by id, the poll interval in "channelInfo"
//
static void aasChannelsJson(Str* sP, const char* lines, bool keyed)
{
  char* copy  = strdup(lines);
  char* save  = NULL;
  bool  first = true;

  strAdd(sP, keyed ? "{" : "[");
  for (char* line = (copy != NULL) ? strtok_r(copy, "\n", &save) : NULL; line != NULL; line = strtok_r(NULL, "\n", &save))
  {
    char* f[5] = { line, NULL, NULL, NULL, NULL };

    for (int ix = 1; ix < 5; ix++)
    {
      char* tab = strchr(f[ix - 1], '\t');
      if (tab == NULL)
        break;
      *tab  = 0;
      f[ix] = tab + 1;
    }
    if (f[4] == NULL)
      continue;

    strAdd(sP, first ? "" : ", ");
    first = false;

    if (keyed)
    {
      strAddJson(sP, f[0]);
      strAdd(sP, ": {\"entities\": ");
    }
    else
    {
      strAdd(sP, "{\"id\": ");
      strAddJson(sP, f[0]);
      strAdd(sP, ", \"entities\": ");
    }

    if (f[1][0] == '[')                          // the rules, JSON aasRulesText made
      strAdd(sP, f[1]);
    else
      strAddJson(sP, f[1]);

    strAdd(sP, ", \"attributeLayout\": ");  strAddJson(sP, f[2]);
    strAdd(sP, ", \"channelDirection\": "); strAddJson(sP, f[3]);

    if (keyed)
    {
      if (f[4][0] != 0)
      {
        strAdd(sP, ", \"channelInfo\": [{\"key\": \"pollInterval\", \"value\": ");
        strAddJson(sP, f[4]);
        strAdd(sP, "}]");
      }
    }
    else
    {
      strAdd(sP, ", \"pollInterval\": ");
      strAddJson(sP, (f[4][0] != 0) ? f[4] : NULL);
    }
    strAdd(sP, "}");
  }
  strAdd(sP, keyed ? "}" : "]");
  free(copy);
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
  strAdd(sP, ", \"dbPath\": ");       strAddJson(sP, (dP->dbPath[0] != 0) ? dP->dbPath : NULL);
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
  if (dP->aas.url[0] != 0)
  {
    //
    // The AAS server - never a secret: the API says whether c3 keeps the Authorization header's value, the client's secret
    //
    char        authPath[2400];
    char        secretPath[2400];
    struct stat st;

    aasAuthorizationPath(dP->name, authPath, sizeof(authPath));
    aasClientSecretPath(dP->name, secretPath, sizeof(secretPath));

    strAdd(sP, ", \"aas\": {\"url\": ");        strAddJson(sP, dP->aas.url);
    strAdd(sP, ", \"caFile\": ");                strAddJson(sP, (dP->aas.caFile[0] != 0) ? dP->aas.caFile : NULL);
    strAddf(sP, ", \"insecure\": %s, \"authorizationSet\": %s", dP->aas.insecure ? "true" : "false", (stat(authPath, &st) == 0) ? "true" : "false");
    strAdd(sP, ", \"clientCert\": ");            strAddJson(sP, (dP->aas.clientCert[0] != 0) ? dP->aas.clientCert : NULL);
    strAdd(sP, ", \"clientKey\": ");             strAddJson(sP, (dP->aas.clientKey[0] != 0) ? dP->aas.clientKey : NULL);
    strAdd(sP, ", \"credentials\": ");           strAddJson(sP, dP->aas.credentials);
    if (strcmp(dP->aas.credentials, "oauth2") == 0)
    {
      strAdd(sP, ", \"oauth2\": {\"tokenUrl\": "); strAddJson(sP, dP->aas.tokenUrl);
      strAdd(sP, ", \"clientId\": ");                 strAddJson(sP, dP->aas.clientId);
      strAdd(sP, ", \"scope\": ");                    strAddJson(sP, (dP->aas.scope[0] != 0) ? dP->aas.scope : NULL);
      strAddf(sP, ", \"clientSecretSet\": %s}", (stat(secretPath, &st) == 0) ? "true" : "false");
    }
    strAdd(sP, ", \"registry\": ");              strAddJson(sP, (dP->aas.registry[0] != 0) ? dP->aas.registry : NULL);
    strAdd(sP, ", \"push\": ");                  strAddJson(sP, (dP->aas.push[0] != 0) ? dP->aas.push : NULL);
    strAdd(sP, ", \"channels\": ");              aasChannelsJson(sP, dP->aas.channels, false);
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
  strAdd(sP, ", \"options\": ");      strAddJson(sP, dP->options);
  strAdd(sP, ", \"args\": ");         strAddJson(sP, dP->args);
  strAddf(sP, ", \"grace\": %d", dP->grace);
  strAdd(sP, ", \"lastStarted\": ");  strAddJson(sP, (dP->lastStarted[0] != 0) ? dP->lastStarted : NULL);
  strAdd(sP, "}");
}



// -----------------------------------------------------------------------------
//
// needs - the services a broker's options need (a bit per kind)
//
// -----------------------------------------------------------------------------
//
// defImage - the image a broker runs in a container: the one named (from an image), or the build's own (Compile's
// Output: Docker image - coraine-build --image); false, and why, when a build has none
//
static bool defImage(const Def* dP, char* out, int outLen, char* err, int errLen)
{
  if (strcmp(dP->from, "build") != 0)
  {
    snprintf(out, outLen, "%s", dP->image);
    return true;
  }

  buildMember(dP->build, "image", "", out, outLen);
  if (out[0] == 0)
  {
    snprintf(err, errLen, "the build '%s' has no image - build it again with Output: Binary and Docker image, or run it natively", dP->build);
    return false;
  }
  return true;
}



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

//
// svcSet - the set a broker's service belongs to: by its kind alone - every broker c3 starts shares one MongoDB
// and one TimescaleDB (each with its own database) and one Mosquitto, under the names they always had
// (c3-mongoc-timescale-mongo, c3-mongoc-timescale-timescale, c3-mqtt-mosquitto), their volumes with them. A
// broker's own "set" (the form's presets, gone) does not name them; the Dashboard's set names its own
//
static const char* svcSet(const char* set, int kind)
{
  if ((kind == KIND_MONGO) || (kind == KIND_TIMESCALE))
    return (strcmp(set, DASHBOARD_SET) == 0) ? set : "mongoc-timescale";
  if (kind == KIND_MOSQUITTO)
    return "mqtt";
  return set;
}

static void svcName(const char* set, int kind, char* out, int outLen)
{
  snprintf(out, outLen, "c3-%s-%s", svcSet(set, kind), kinds[kind].id);
}



// -----------------------------------------------------------------------------
//
// Paths of a broker
//
static void brokerDir(const char* name, char* out, int outLen)      { snprintf(out, outLen, "%s/%s", runDir, name); }
static void brokerDataDir(const char* name, char* out, int outLen)  { snprintf(out, outLen, "%s/%s/data", runDir, name); }

//
// brokerDataPath - where a native broker's corDB is: the directory chosen, else c3's <run>/<name>/data (only that
// one goes with "Delete data": a directory of one's own is never deleted)
//
static void brokerDataPath(const Def* dP, char* out, int outLen)
{
  if (dP->dbPath[0] != 0)
    snprintf(out, outLen, "%s", dP->dbPath);
  else
    brokerDataDir(dP->name, out, outLen);
}
static void brokerVolume(const char* name, char* out, int outLen)   { snprintf(out, outLen, "c3-broker-%s", name); }
static void brokerContainer(const char* name, char* out, int outLen) { snprintf(out, outLen, "c3-broker-%s", name); }
static void ddsContextPath(const char* name, char* out, int outLen)  { snprintf(out, outLen, "%s/%s/dds-context.jsonld", runDir, name); }   // the DDS mapping's @context



// -----------------------------------------------------------------------------
//
// bridgesConfigOwn - c3 writes the broker's bridge configuration: a bridge that needs one (mqtt, dds, opcua, aas) or
// CKAN datasets, and no file of the user's
//
static bool bridgesConfigOwn(const Def* dP)
{
  return (hasBridge(dP, "mqtt") || hasBridge(dP, "dds") || (dP->ckan[0] != 0) || (dP->opcua.url[0] != 0) || (dP->aas.url[0] != 0)) && (dP->bridgeConfig[0] == 0);
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

  //
  // The published image: no ckan, opcua or aas bridge - unless its --version, read, says otherwise (sourceCheck
  // then judges by its plugins line)
  //
  bool published = (strcmp(dP->from, "image") == 0);
  if (published)
  {
    char* iv = imageVersionCached(dP->image);
    if (pluginsKnown(iv))
      published = false;
    if (iv != NULL) free(iv);
  }

  if (published && (dP->ckan[0] != 0))
  {
    snprintf(err, errLen, "CKAN datasets need a native broker: the image has no ckan bridge");
    return false;
  }

  if (published && hasBridge(dP, "opcua"))
  {
    snprintf(err, errLen, "the OPC UA bridge needs a native broker: the image has no opcua bridge");
    return false;
  }

  if (published && hasBridge(dP, "aas"))
  {
    snprintf(err, errLen, "the AAS bridge needs a native broker: the image has no aas bridge");
    return false;
  }

  //
  // A build - natively or in its image - has the bridges it was built with, no others
  //
  if (strcmp(dP->from, "build") == 0)
  {
    char  copy[128];
    char* save = NULL;
    char  bdir[2300];

    buildDirOf(dP->build, bdir, sizeof(bdir));
    snprintf(copy, sizeof(copy), "%s%s", dP->bridges, (dP->ckan[0] != 0) && !hasBridge(dP, "ckan") ? ",ckan" : "");
    for (char* b = strtok_r(copy, ",", &save); b != NULL; b = strtok_r(NULL, ",", &save))
    {
      char so[2600];

      snprintf(so, sizeof(so), "%s/install/plugins/bridge/%s.so", bdir, b);
      if (access(so, R_OK) != 0)
      {
        snprintf(err, errLen, "the build '%s' has no %s bridge - tick it in Compile and build again", dP->build, b);
        return false;
      }
    }
  }

  if (container)
  {
    char name[96];
    char vol[96];
    char image[512];

    if (engine[0] == 0)
    {
      snprintf(err, errLen, "%s", engineWhy);
      return false;
    }
    if (defImage(dP, image, sizeof(image), err, errLen) == false)
    {
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
    if ((dP->aas.url[0] != 0) && (bridgeFile[0] != 0))
    {
      //
      // The AAS bridge's secrets: by name - the engine takes their values from its own environment (aasEnv), so they are
      // never on its command line; its PEM files: at the same paths inside, as the bridge configuration names them
      //
      if (strcmp(dP->aas.credentials, "authorization") == 0)
      {
        argAdd(aP, "-e");     argAdd(aP, "C3_AAS_AUTHORIZATION");
      }
      else if (strcmp(dP->aas.credentials, "oauth2") == 0)
      {
        argAdd(aP, "-e");     argAdd(aP, "C3_AAS_CLIENT_SECRET");
      }

      const char* pems[3] = { dP->aas.caFile, dP->aas.clientCert, dP->aas.clientKey };
      for (int ix = 0; ix < 3; ix++)
      {
        if (pems[ix][0] != 0)
        {
          argAdd(aP, "-v");   argAddf(aP, "%s:%s:ro", pems[ix], pems[ix]);
        }
      }
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
    argAdd(aP, image);
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
    buildMember(dP->build, "executable", "coraine", exe, sizeof(exe));
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
    brokerDataPath(dP, data, sizeof(data));
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

    //
    // cep: corCep's requests go to the broker over HTTP - to this broker's own port (the plugin's default is 1026)
    //
    if (hasBridge(dP, "cep"))
    {
      argAdd(aP, "--cep-broker"); argAddf(aP, "http://127.0.0.1:%d", byName ? 1026 : dP->port);
    }
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

  char* extra[128];
  int   n = lineSplit(dP->options, extra, 128);
  for (int ix = 0; ix < n; ix++)
  {
    argAdd(aP, extra[ix]);
    free(extra[ix]);
  }
  n = lineSplit(dP->args, extra, 64);
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
  snprintf(sP->set, sizeof(sP->set), "%s", svcSet(set, kind));
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
static int engineToLogEnv(const char* logPath, int timeoutS, Argv* aP, char* const* envp)
{
  int fd = open(logPath, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
  if (fd == -1)
    return -1;

  ProcSpawn sp  = { aP->v, envp, fd, NULL, true, false, SIGTERM };
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

static int engineToLog(const char* logPath, int timeoutS, Argv* aP)
{
  return engineToLogEnv(logPath, timeoutS, aP, NULL);
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
// LocalReq - one HTTP/1.0 request to 127.0.0.1:<port> (the Dashboard's WireCloud and Elasticsearch)
//
typedef struct LocalReq
{
  const char*  method;
  const char*  path;
  const char*  auth;                             // Authorization's value, or NULL
  const char*  contentType;                      // the body's (NULL: application/json)
  const char*  body;                             // or NULL
  int          bodyLen;                          // -1: strlen(body)
  Str*         headP;                            // the response's head, when given
  Str*         respP;                            // the response's body, when given
  int          timeoutS;
} LocalReq;

//
// localRequest - the status; -1: no answer
//
static int localRequest(int port, const LocalReq* rP)
{
  int fd = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd == -1)
    return -1;

  struct timeval tv = { rP->timeoutS, 0 };
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

  struct sockaddr_in sa;
  memset(&sa, 0, sizeof(sa));
  sa.sin_family      = AF_INET;
  sa.sin_port        = htons(port);
  sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

  if (connect(fd, (struct sockaddr*) &sa, sizeof(sa)) != 0)
  {
    close(fd);
    return -1;
  }

  int bodyLen = (rP->body == NULL) ? 0 : (rP->bodyLen >= 0) ? rP->bodyLen : (int) strlen(rP->body);
  Str req     = { NULL, 0, 0 };

  // WireCloud answers 500 without a User-Agent (Ficodes/WireCloud#8)
  strAddf(&req, "%s %s HTTP/1.0\r\nHost: 127.0.0.1:%d\r\nAccept: application/json, */*\r\nUser-Agent: c3/" C3_VERSION "\r\n", rP->method, rP->path, port);
  if (rP->auth != NULL)
    strAddf(&req, "Authorization: %s\r\n", rP->auth);
  if (rP->body != NULL)
    strAddf(&req, "Content-Type: %s\r\nContent-Length: %d\r\n", (rP->contentType != NULL) ? rP->contentType : "application/json", bodyLen);
  strAdd(&req, "\r\n");
  if (rP->body != NULL)
    strAddN(&req, rP->body, bodyLen);

  bool sent = true;
  for (int off = 0; off < req.len; )
  {
    int w = write(fd, req.s + off, req.len - off);
    if (w <= 0)
    {
      sent = false;
      break;
    }
    off += w;
  }
  if (req.s != NULL)
    memset(req.s, 0, req.len);                   // a password may be in it
  strFree(&req);

  //
  // The answer: HTTP/1.0 - the server closes when it is whole (up to 4 MiB kept)
  //
  Str all = { NULL, 0, 0 };
  char buf[16 * 1024];
  while (sent)
  {
    int r = read(fd, buf, sizeof(buf));
    if (r <= 0)
      break;
    if (all.len < 4 * 1024 * 1024)
      strAddN(&all, buf, r);
    if ((rP->respP == NULL) && (all.s != NULL) && (strstr(all.s, "\r\n\r\n") != NULL))
      break;                                     // the head is all that is wanted
  }
  close(fd);

  int status = -1;
  if ((all.len > 12) && (strncmp(all.s, "HTTP/1.", 7) == 0))
    status = atoi(&all.s[9]);

  char* end = (all.s != NULL) ? strstr(all.s, "\r\n\r\n") : NULL;
  if (rP->headP != NULL)
    strAddN(rP->headP, (all.s != NULL) ? all.s : "", (end != NULL) ? (int) (end - all.s) : all.len);
  if ((rP->respP != NULL) && (end != NULL))
    strAddN(rP->respP, end + 4, all.len - (int) (end + 4 - all.s));

  strFree(&all);
  return status;
}

//
// localHttp - the common case: a JSON body or none, the head wanted or not
//
static int localHttp(int port, const char* method, const char* path, const char* body, Str* headP, int timeoutS)
{
  LocalReq r = { method, path, NULL, NULL, body, -1, headP, NULL, timeoutS };
  return localRequest(port, &r);
}



// -----------------------------------------------------------------------------
//
// wirecloudMcp - was WireCloud's image built with its MCP part (WIRECLOUD_INSTALL_MCP=true: the MCP SDK in
// it)? Asked of the image once per image id - a build of its anew is asked again.
//
static char mcpImageId[80];
static bool mcpImageHas;

static bool wirecloudMcp(void)
{
  char id[256];
  char out[256];

  if (engineRun(id, sizeof(id), 30, "image", "inspect", "--format", "{{.Id}}", kinds[KIND_WIRECLOUD].image, NULL) != 0)
    return false;
  if (strcmp(id, mcpImageId) == 0)
    return mcpImageHas;

  mcpImageHas = (engineRun(out, sizeof(out), 60, "run", "--rm", "--entrypoint", "python", kinds[KIND_WIRECLOUD].image, "-c", "import mcp", NULL) == 0);
  snprintf(mcpImageId, sizeof(mcpImageId), "%s", id);
  return mcpImageHas;
}

//
// wirecloudPackage - where the image has WireCloud's Python package (/usr/local/lib/python3.11/site-packages/wirecloud):
// c3's theme is mounted into its themes/. Asked of the image once per image id, as wirecloudMcp; "" when unknown.
//
static char pkgImageId[80];
static char pkgPath[512];

static const char* wirecloudPackage(void)
{
  char id[256];
  char out[1024];

  if (engineRun(id, sizeof(id), 30, "image", "inspect", "--format", "{{.Id}}", kinds[KIND_WIRECLOUD].image, NULL) != 0)
    return "";
  if (strcmp(id, pkgImageId) == 0)
    return pkgPath;

  pkgPath[0] = 0;
  if ((engineRun(out, sizeof(out), 60, "run", "--rm", "--entrypoint", "python", kinds[KIND_WIRECLOUD].image, "-c",
                 "import os, wirecloud; print(os.path.dirname(wirecloud.__file__))", NULL) == 0) && (out[0] == '/'))
  {
    char* nl = strchr(out, '\n');
    if (nl != NULL) *nl = 0;
    snprintf(pkgPath, sizeof(pkgPath), "%s", out);
  }
  snprintf(pkgImageId, sizeof(pkgImageId), "%s", id);
  return pkgPath;
}

//
// treeRemove / treeCopy - a directory's tree removed / copied (symbolic links as links, files' modes kept)
//
static int treeRemoveOne(const char* path, const struct stat* sbP, int flag, struct FTW* ftwP)
{
  (void) sbP; (void) flag; (void) ftwP;
  return remove(path);
}

static void treeRemove(const char* dir)
{
  nftw(dir, treeRemoveOne, 16, FTW_DEPTH | FTW_PHYS);
}

static bool treeCopy(const char* from, const char* to)
{
  struct stat st;
  if ((lstat(from, &st) != 0) || ((mkdir(to, 0755) != 0) && (errno != EEXIST)))
    return false;

  DIR* dP = opendir(from);
  if (dP == NULL)
    return false;

  bool           ok = true;
  struct dirent* eP;
  while (ok && ((eP = readdir(dP)) != NULL))
  {
    if ((strcmp(eP->d_name, ".") == 0) || (strcmp(eP->d_name, "..") == 0))
      continue;

    char src[4400];
    char dst[4400];
    snprintf(src, sizeof(src), "%s/%s", from, eP->d_name);
    snprintf(dst, sizeof(dst), "%s/%s", to, eP->d_name);
    if (lstat(src, &st) != 0)
      ok = false;
    else if (S_ISDIR(st.st_mode))
      ok = treeCopy(src, dst);
    else if (S_ISLNK(st.st_mode))
    {
      char    target[4096];
      ssize_t n = readlink(src, target, sizeof(target) - 1);
      if (n < 0)
        ok = false;
      else
      {
        target[n] = 0;
        ok = (symlink(target, dst) == 0);
      }
    }
    else if (S_ISREG(st.st_mode))
    {
      int in  = open(src, O_RDONLY | O_CLOEXEC);
      int out = open(dst, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, st.st_mode & 0777);
      char    buf[65536];
      ssize_t n = 0;
      while ((in != -1) && (out != -1) && ((n = read(in, buf, sizeof(buf))) > 0))
      {
        if (write(out, buf, n) != n) { n = -1; break; }
      }
      ok = (in != -1) && (out != -1) && (n == 0);
      if (in  != -1) close(in);
      if (out != -1) close(out);
    }
  }
  closedir(dP);
  return ok;
}

//
// wirecloudThemeArgs - WireCloud in c3's colours: www/wirecloud/c3theme (a WireCloud theme, built on defaulttheme -
// tools/wirecloud-theme.sh compiles its CSS) copied to <svcDir>/c3-<set>-wirecloud-theme and that copy mounted as the
// package's themes/c3theme, made the active theme. A copy, not c3's pages: an install or a checkout replaces the pages'
// folders, and a container's mount of a replaced folder shows it deleted (WireCloud then fails to load its themes).
// Without the theme or the package's path WireCloud keeps its own (logged).
//
static void wirecloudThemeArgs(Argv* aP, const char* logPath, const char* name, const char* set)
{
  char from[4200];
  char to[2300];

  snprintf(from, sizeof(from), "%s/wirecloud/c3theme", c3WwwDir);
  snprintf(to, sizeof(to), "%s/c3-%s-wirecloud-theme", svcDir, set);

  const char* pkg = wirecloudPackage();
  if (access(from, R_OK) != 0)
  {
    logLine(logPath, "%s: WireCloud's own theme - no c3theme in c3's pages (%s)", name, from);
    return;
  }
  if (pkg[0] == 0)
  {
    logLine(logPath, "%s: WireCloud's own theme - the image's WireCloud package was not found", name);
    return;
  }

  treeRemove(to);
  if (treeCopy(from, to) == false)
  {
    logLine(logPath, "%s: WireCloud's own theme - c3theme not copied to %s: %s", name, to, strerror(errno));
    treeRemove(to);
    return;
  }

  argAdd(aP, "-v"); argAddf(aP, "%s:%s/themes/c3theme:ro", to, pkg);
  argAdd(aP, "-e"); argAdd(aP, "WIRECLOUD_AVAILABLE_THEMES=c3theme,defaulttheme");
  argAdd(aP, "-e"); argAdd(aP, "WIRECLOUD_THEME_ACTIVE=c3theme");
  logLine(logPath, "%s: in c3's colours (theme c3theme, from %s)", name, from);
}

//
// mcpSettingsWrite - WireCloud's Docker settings, and the OAuth client AI Assist reaches its MCP server with:
// the image takes its settings from the environment, but not OAUTH2_CLIENTS. c3's settings.py is mounted over
// the image's /app/docker/settings.py (its entrypoint puts /app/docker first in PYTHONPATH: nothing beside it
// would be read); it runs the image's own - copied out of the image each time the container is made, so a
// newer image's is the one run - and adds the client c3-assist: client credentials, acting as WireCloud's
// user admin, to read, write workspaces and install components - nothing deleted.
//
static bool mcpSettingsWrite(const char* set, char* dir, int dirLen, char* err, int errLen)
{
  snprintf(dir, dirLen, "%s/c3-%s-wirecloud-settings", svcDir, set);
  if ((mkdir(dir, 0755) != 0) && (errno != EEXIST))
  {
    snprintf(err, errLen, "%s: %s", dir, strerror(errno));
    return false;
  }

  //
  // The image's own settings, as they are in it
  //
  int   size = 256 * 1024;
  char* orig = malloc(size);
  if (orig == NULL)
  {
    snprintf(err, errLen, "out of memory");
    return false;
  }
  if ((engineRun(orig, size, 60, "run", "--rm", "--entrypoint", "cat", kinds[KIND_WIRECLOUD].image, "/app/docker/settings.py", NULL) != 0) ||
      ((int) strlen(orig) >= size - 2) || (strstr(orig, "INSTALLED_APPS") == NULL))
  {
    snprintf(err, errLen, "WireCloud's image: its /app/docker/settings.py could not be read (%.200s)", orig);
    free(orig);
    return false;
  }

  char path[2400];
  snprintf(path, sizeof(path), "%s/docker_settings.py", dir);
  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  bool copied = (fd != -1) && (write(fd, orig, strlen(orig)) == (ssize_t) strlen(orig)) && (write(fd, "\n", 1) == 1);
  if (fd != -1)
    close(fd);
  free(orig);
  if (copied == false)
  {
    snprintf(err, errLen, "%s: not written", path);
    return false;
  }

  snprintf(path, sizeof(path), "%s/settings.py", dir);
  const char* text =
    "# c3's: WireCloud's own Docker settings, then the OAuth client c3's AI Assist reaches the MCP server with\n"
    "# (client credentials, as the user " DASHBOARD_USER "; its secret from c3's secrets.json, in the environment)\n"
    "exec(compile(open('/app/c3/docker_settings.py').read(), '/app/docker/settings.py', 'exec'))\n"
    "\n"
    "_c3_secret = os.environ.get('C3_ASSIST_CLIENT_SECRET', '')\n"
    "if _c3_secret and MCP_PUBLIC_URL:\n"
    "    OAUTH2_CLIENTS = [{\n"
    "        'client_id': 'c3-assist',\n"
    "        'client_name': \"c3's AI Assist\",\n"
    "        'grant_types': ['client_credentials'],\n"
    "        'token_endpoint_auth_method': 'client_secret_post',\n"
    "        'client_secret': _c3_secret,\n"
    "        'service_user': '" DASHBOARD_USER "',\n"
    "        'resource_scopes': {MCP_PUBLIC_URL: ['wirecloud:read', 'wirecloud:workspace:write', 'wirecloud:component:install']},\n"
    "    }]\n";

  fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  if (fd == -1)
  {
    snprintf(err, errLen, "%s: %s", path, strerror(errno));
    return false;
  }
  bool ok = (write(fd, text, strlen(text)) == (ssize_t) strlen(text));
  close(fd);
  if (ok == false)
    snprintf(err, errLen, "%s: not written", path);
  return ok;
}



// -----------------------------------------------------------------------------
//
// secretEnvWrite - the env file a set's WireCloud starts with (--env-file): its JWT and secret keys, made once
// and kept in secrets.json (credsDashboard). Mode 0600, removed again once the container is made. With an
// image that has the MCP part ('mcp'), also what turns it on: the OAuth and MCP apps, the MCP server's URL as
// AI Assist reaches it (on 'port'), the secret of the client c3-assist (c3's settings.py reads it).
//
static bool secretEnvWrite(const char* set, int port, bool mcp, char* path, int pathLen, char* err, int errLen)
{
  char jwtKey[65];
  char secretKey[65];

  if (credsDashboard(NULL, 0, jwtKey, sizeof(jwtKey), secretKey, sizeof(secretKey), err, errLen) == false)
    return false;

  snprintf(path, pathLen, "%s/c3-%s-wirecloud.env", svcDir, set);

  int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd == -1)
  {
    snprintf(err, errLen, "%s: %s", path, strerror(errno));
    path[0] = 0;
    return false;
  }

  char text[2048];
  int  len = snprintf(text, sizeof(text), "WIRECLOUD_JWT_KEY=%s\nWIRECLOUD_SECRET_KEY=%s\n", jwtKey, secretKey);
  if (mcp)
  {
    char assist[65];
    if (credsDashboardAssist(assist, sizeof(assist), err, errLen) == false)
    {
      close(fd);
      unlink(path);
      path[0] = 0;
      return false;
    }
    len += snprintf(&text[len], sizeof(text) - len,
                    "WIRECLOUD_INSTALLED_APPS=wirecloud.commons,wirecloud.platform,wirecloud.catalogue,wirecloud.proxy,wirecloud.fiware,wirecloud.keycloak,wirecloud.oauth2provider,wirecloud.mcp\n"
                    "WIRECLOUD_MCP_PUBLIC_URL=http://127.0.0.1:%d/mcp\n"
                    "WIRECLOUD_OAUTH2_PUBLIC_URL=http://127.0.0.1:%d\n"
                    "WIRECLOUD_OAUTH2_DYNAMIC_REGISTRATION=false\n"
                    "C3_ASSIST_CLIENT_SECRET=%s\n", port, port, assist);
    memset(assist, 0, sizeof(assist));
  }
  bool ok  = (len < (int) sizeof(text)) && (write(fd, text, len) == len);
  memset(text, 0, sizeof(text));

  close(fd);
  if (ok == false)
  {
    snprintf(err, errLen, "%s: not written", path);
    unlink(path);
    path[0] = 0;
  }
  return ok;
}



// -----------------------------------------------------------------------------
//
// runDashboardMcp - for AI Assist: WireCloud's MCP server's URL and an access token (15 minutes) for the
// client c3-assist, while the Dashboard runs with it. false: why, in 'why' (not running; the image without the
// MCP part; WireCloud did not give one).
//
static int dashPort(void);                       // below, with the Dashboard

bool runDashboardMcp(char* url, int urlLen, char* token, int tokenLen, char* why, int whyLen)
{
  int port = dashPort();
  if (port <= 0)
  {
    snprintf(why, whyLen, "the Dashboard does not run");
    return false;
  }

  char secret[65];
  char err[256];
  if (credsDashboardAssist(secret, sizeof(secret), err, sizeof(err)) == false)
  {
    snprintf(why, whyLen, "%s", err);
    return false;
  }

  snprintf(url, urlLen, "http://127.0.0.1:%d/mcp", port);
  char body[512];
  snprintf(body, sizeof(body), "grant_type=client_credentials&client_id=c3-assist&client_secret=%s&resource=http%%3A%%2F%%2F127.0.0.1%%3A%d%%2Fmcp", secret, port);
  memset(secret, 0, sizeof(secret));

  Str      resp = { NULL, 0, 0 };
  LocalReq r    = { "POST", "/oauth2/token", NULL, "application/x-www-form-urlencoded", body, -1, NULL, &resp, 15 };
  int      st   = localRequest(port, &r);
  memset(body, 0, sizeof(body));

  bool ok = false;
  if (st == 404)
    snprintf(why, whyLen, "WireCloud runs without its MCP part - its image built with WIRECLOUD_INSTALL_MCP=true, the Dashboard stopped and started again");
  else if (st != 200)
    snprintf(why, whyLen, "WireCloud gave no token for AI Assist (%d) - when it was started before c3 knew of MCP, stop the Dashboard and start it again", st);
  else
  {
    const char* at = (resp.s != NULL) ? strstr(resp.s, "\"access_token\"") : NULL;
    const char* q1 = (at != NULL) ? strchr(at + 14, '"') : NULL;
    const char* q2 = (q1 != NULL) ? strchr(q1 + 1, '"') : NULL;
    if ((q2 != NULL) && (q2 - q1 - 1 < tokenLen))
    {
      snprintf(token, tokenLen, "%.*s", (int) (q2 - q1 - 1), q1 + 1);
      ok = true;
    }
    else
      snprintf(why, whyLen, "WireCloud's token answer has no access_token");
  }
  if (resp.s != NULL)
    memset(resp.s, 0, resp.len);
  strFree(&resp);
  return ok;
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

  if (sP->kind == KIND_ELASTICSEARCH)
    return localHttp(hostPort, "GET", "/_cluster/health?wait_for_status=yellow&timeout=1s", NULL, NULL, 5) == 200;

  if (sP->kind == KIND_WIRECLOUD)                // its login page - "/" is 404 until populate has run
    return localHttp(hostPort, "GET", "/login", NULL, NULL, 5) == 200;

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
  char   envFile[2400] = "";

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
    snprintf(label, sizeof(label), "c3.set=%s", svcSet(set, kind));
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
    for (int ix = 0; kinds[kind].env[ix] != NULL; ix++)
    {
      const char* e   = kinds[kind].env[ix];
      const char* tag = strstr(e, "{set}");

      argAdd(&a, "-e");
      if (tag != NULL) argAddf(&a, "%.*s%s%s", (int) (tag - e), e, set, tag + 5);
      else             argAdd(&a, e);
    }
    if (kinds[kind].secretEnv)
    {
      bool mcp = (kind == KIND_WIRECLOUD) && wirecloudMcp();
      char settingsDir[2300];

      if (mcp && (mcpSettingsWrite(set, settingsDir, sizeof(settingsDir), err, errLen) == false))
      {
        argFree(&a);
        goto fail;
      }
      if (secretEnvWrite(set, port, mcp, envFile, sizeof(envFile), err, errLen) == false)
      {
        argFree(&a);
        goto fail;
      }
      argAdd(&a, "--env-file"); argAdd(&a, envFile);
      if (mcp)
      {
        argAdd(&a, "-v"); argAddf(&a, "%s:/app/c3:ro", settingsDir);
        argAdd(&a, "-v"); argAddf(&a, "%s/settings.py:/app/docker/settings.py:ro", settingsDir);
        logLine(logPath, "%s: its MCP server on (AI Assist builds dashboards) - 127.0.0.1:%d/mcp", name, port);
      }
    }
    if (kind == KIND_WIRECLOUD)
      wirecloudThemeArgs(&a, logPath, name, set);
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
    if (envFile[0] != 0)                         // read by the run; not left on disk
      unlink(envFile);

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
// aasMember - a broker's aas member: the server - its credentials: the Authorization header's value in the broker's
// environment, C3_AAS_AUTHORIZATION, when c3 keeps one, or the OAuth2 client, its secret C3_AAS_CLIENT_SECRET (aasEnv) -
// the registry, the push broker, an AssetChannel per shell or submodel picked
//
static void aasMember(const Def* dP, bool authorization, Str* sP)
{
  strAdd(sP, "\"aas\": {\"server\": {\"url\": ");
  strAddJson(sP, dP->aas.url);
  if (dP->aas.caFile[0] != 0)
  {
    strAdd(sP, ", \"caFile\": ");
    strAddJson(sP, dP->aas.caFile);
  }
  if (dP->aas.insecure)
    strAdd(sP, ", \"insecure\": true");
  if (dP->aas.clientCert[0] != 0)
  {
    strAdd(sP, ", \"clientCert\": ");
    strAddJson(sP, dP->aas.clientCert);
  }
  if (dP->aas.clientKey[0] != 0)
  {
    strAdd(sP, ", \"clientKey\": ");
    strAddJson(sP, dP->aas.clientKey);
  }
  if (authorization && (strcmp(dP->aas.credentials, "authorization") == 0))
    strAdd(sP, ", \"authorizationEnv\": \"C3_AAS_AUTHORIZATION\"");
  if (strcmp(dP->aas.credentials, "oauth2") == 0)
  {
    strAdd(sP, ", \"oauth2\": {\"tokenUrl\": ");
    strAddJson(sP, dP->aas.tokenUrl);
    strAdd(sP, ", \"clientId\": ");
    strAddJson(sP, dP->aas.clientId);
    strAdd(sP, ", \"clientSecretEnv\": \"C3_AAS_CLIENT_SECRET\"");
    if (dP->aas.scope[0] != 0)
    {
      strAdd(sP, ", \"scope\": ");
      strAddJson(sP, dP->aas.scope);
    }
    strAdd(sP, "}");
  }
  strAdd(sP, "}");
  if (dP->aas.registry[0] != 0)
  {
    strAdd(sP, ", \"registry\": {\"url\": ");
    strAddJson(sP, dP->aas.registry);
    strAdd(sP, "}");
  }
  if (dP->aas.push[0] != 0)
  {
    strAdd(sP, ", \"push\": {\"url\": ");
    strAddJson(sP, dP->aas.push);
    strAdd(sP, "}");
  }
  strAdd(sP, ", \"ngsild\": {\"defaultEntity\": false, \"assetChannels\": ");
  aasChannelsJson(sP, dP->aas.channels, true);
  strAdd(sP, "}}");
}



// -----------------------------------------------------------------------------
//
// aasEnv - a broker's environment (native: its own; a container: the engine's, which hands the variables on, -e):
// envClean's, and with an AAS server the secrets c3 keeps for it - C3_AAS_AUTHORIZATION (the bridge's authorizationEnv),
// C3_AAS_CLIENT_SECRET (its oauth2 clientSecretEnv). vars[0..1]: the strings to wipe and free after the start (aasEnvFree)
//
static char** aasEnv(const Def* dP, char* vars[2])
{
  char** env = envClean(NULL);
  int    n   = 0;

  vars[0] = NULL;
  vars[1] = NULL;
  if (dP->aas.url[0] == 0)
    return env;

  while (env[n] != NULL)
    ++n;

  struct { void (*pathOf)(const char*, char*, int); const char* var; const char* credentials; } secrets[2] =
  {
    { aasAuthorizationPath, "C3_AAS_AUTHORIZATION", "authorization" },
    { aasClientSecretPath,  "C3_AAS_CLIENT_SECRET", "oauth2"        }
  };

  for (int ix = 0; ix < 2; ix++)
  {
    char path[2400];

    if (strcmp(dP->aas.credentials, secrets[ix].credentials) != 0)
      continue;

    secrets[ix].pathOf(dP->name, path, sizeof(path));

    char* text = fileText(path);
    if (text == NULL)
      continue;

    char* nl = strchr(text, '\n');
    if (nl != NULL)
      *nl = 0;

    char** more = realloc(env, (n + 2) * sizeof(char*));
    if (more != NULL)
      env = more;
    if ((more != NULL) && (asprintf(&vars[ix], "%s=%s", secrets[ix].var, text) != -1))
    {
      env[n++] = vars[ix];
      env[n]   = NULL;
    }
    else
      vars[ix] = NULL;

    memset(text, 0, strlen(text));
    free(text);
  }

  return env;
}

static void aasEnvFree(char** env, char* vars[2])
{
  for (int ix = 0; ix < 2; ix++)
  {
    if (vars[ix] != NULL)
    {
      memset(vars[ix], 0, strlen(vars[ix]));
      free(vars[ix]);
    }
  }
  free(env);
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
  if (dP->aas.url[0] != 0)
  {
    char        authPath[2400];
    struct stat st;

    aasAuthorizationPath(dP->name, authPath, sizeof(authPath));

    if (strcmp(dP->aas.credentials, "oauth2") == 0)
    {
      char secretPath[2400];

      aasClientSecretPath(dP->name, secretPath, sizeof(secretPath));
      if (stat(secretPath, &st) != 0)
      {
        snprintf(err, errLen, "the AAS OAuth2 client '%s' has no secret: give it once, c3 keeps it", dP->aas.clientId);
        strFree(&s);
        return false;
      }
    }

    strAdd(&s, (s.len > 1) ? ", " : "");
    aasMember(dP, stat(authPath, &st) == 0, &s);
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
    char image[512] = "";

    brokerContainer(d.name, name, sizeof(name));
    brokerVolume(d.name, vol, sizeof(vol));

    if ((networkEnsure(err, sizeof(err)) == false) || (defImage(&d, image, sizeof(image), err, sizeof(err)) == false) ||
        (imageEnsure(image, bP->logPath, err, sizeof(err)) == false))
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

    char*  aasVars[2];
    char** env    = aasEnv(&d, aasVars);       // the engine hands the AAS secrets on (-e NAME): never on its command line
    int    status = engineArgvEnv(&a, env, out, sizeof(out), 120);
    aasEnvFree(env, aasVars);
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
      brokerDataPath(&d, data, sizeof(data));
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
    char*     aasVars[2];
    char**    env    = aasEnv(&d, aasVars);     // with an AAS server: the secrets c3 keeps for it
    ProcSpawn sp     = { a.v, env, fd, dir, false, true, 0 };
    pid_t     pid    = procSpawn(&sp);
    aasEnvFree(env, aasVars);
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

  if (engineRun(out, sizeof(out), 20, "ps", "-a", "--format",
                "{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Label \"c3.kind\"}}\t{{.Label \"c3.set\"}}\t{{.Label \"c3.service\"}}\t{{.Label \"c3.broker\"}}\t{{.Ports}}"
                "\t{{.Label \"c3\"}}\t{{.CreatedAt}}\t{{.Image}}", NULL) != 0)
    return;
  if (engineRun(vols, sizeof(vols), 20, "volume", "ls", "--filter", "label=c3=run", "--format", "{{.Name}}", NULL) != 0)
    vols[0] = 0;

  Str ctrs = { NULL, 0, 0 };                    // every container on the machine, for Operate's Containers
  strAdd(&ctrs, "[");

  pthread_mutex_lock(&rMutex);

  bool svcSeen[SERVICES_MAX]   = { false };
  bool brokerSeen[BROKERS_MAX] = { false };

  char* save = NULL;
  for (char* line = strtok_r(out, "\n", &save); line != NULL; line = strtok_r(NULL, "\n", &save))
  {
    char* f[11] = { NULL };
    int   n    = 0;
    char* p    = line;

    while ((n < 11) && (p != NULL))
    {
      f[n++] = p;
      p = strchr(p, '\t');
      if (p != NULL)
        *p++ = 0;
    }
    if (n < 11)
      continue;

    const char* name  = f[0];
    const char* state = f[1];
    bool        ours  = (strcmp(f[8], "run") == 0);

    strAdd(&ctrs, (ctrs.len > 1) ? ", {\"name\": " : "{\"name\": ");
    strAddJson(&ctrs, name);
    strAdd(&ctrs, ", \"state\": ");    strAddJson(&ctrs, state);
    strAdd(&ctrs, ", \"status\": ");   strAddJson(&ctrs, f[2]);
    strAdd(&ctrs, ", \"created\": ");  strAddJson(&ctrs, f[9]);
    strAdd(&ctrs, ", \"image\": ");    strAddJson(&ctrs, f[10]);
    strAdd(&ctrs, ", \"ports\": ");    strAddJson(&ctrs, f[7]);
    strAddf(&ctrs, ", \"c3\": %s", ours ? "true" : "false");
    strAdd(&ctrs, ", \"kind\": ");     strAddJson(&ctrs, ours ? f[3] : "");
    strAdd(&ctrs, ", \"broker\": ");   strAddJson(&ctrs, ours ? f[6] : "");
    strAdd(&ctrs, "}");

    if (ours == false)
      continue;

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

  strAdd(&ctrs, "]");
  if (containers != NULL)
    free(containers);
  containers = ctrs.s;

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
  tail(dash.logPath, &dash.logEnd, &dash.subs, &dash.lastBeat);
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
    brokerDataPath(dP, path, sizeof(path));
    strAdd(sP, ", \"dataDir\": ");
    strAddJson(sP, dP->dbDir ? path : NULL);
    strAddf(sP, ", \"dataOwn\": %s", (dP->dbPath[0] == 0) ? "true" : "false");
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
  strAdd(&s, "], \"containers\": ");
  strAdd(&s, (containers != NULL) ? containers : "[]");
  strAdd(&s, ", \"sets\": ");
  setsRender(&s);
  strAdd(&s, "}");

  pthread_mutex_unlock(&rMutex);
  respondStr(connP, 200, &s);
}



// -----------------------------------------------------------------------------
//
// runSources - GET /api/run/sources: the installed broker and the builds that succeeded, with what each has
// compiled in (their --version), the bridge plugins each one has - and a build its image, when Compile made one,
// its mode and when it ended (Operate lists the newest first)
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

        char image[512];
        buildMember(name, "image", "", image, sizeof(image));
        strAdd(&s, ", \"image\": ");    strAddJson(&s, (image[0] != 0) ? image : NULL);

        char mode[32];
        char ended[40];
        buildMember(name, "mode",  "", mode,  sizeof(mode));
        buildMember(name, "ended", "", ended, sizeof(ended));
        strAdd(&s, ", \"mode\": ");     strAddJson(&s, (mode[0]  != 0) ? mode  : NULL);
        strAdd(&s, ", \"ended\": ");    strAddJson(&s, (ended[0] != 0) ? ended : NULL);
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
  else
    version = imageVersionCached(dP->image);     // read when the form chose it (GET /api/run/image); else not known

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

  //
  // ... nor what its plugin directory does not have (the "plugins:" line)
  //
  struct { bool asked; const char* kind; const char* name; const char* what; } plugins[] =
  {
    { true,        "db",         dP->store,   "the store"                },
    { true,        "troe",       dP->history, "the history"              },
    { dP->ws,      "transports", "ws",        "the WebSocket transport"  },
    { dP->admin,   "api",        "admin",     "the admin API"            },
    { dP->ckan[0] != 0, "bridges", "ckan",    "the CKAN datasets' bridge" },
  };

  for (unsigned int ix = 0; ix < sizeof(plugins) / sizeof(plugins[0]); ix++)
  {
    if (plugins[ix].asked && pluginsLacks(version, plugins[ix].kind, plugins[ix].name))
    {
      snprintf(err, errLen, "this broker has no %s plugin '%s' (%s)", plugins[ix].kind, plugins[ix].name, plugins[ix].what);
      free(version);
      return false;
    }
  }

  char  copy[128];
  char* save = NULL;
  snprintf(copy, sizeof(copy), "%s", dP->bridges);
  for (char* b = strtok_r(copy, ",", &save); b != NULL; b = strtok_r(NULL, ",", &save))
  {
    if (pluginsLacks(version, "bridges", b))
    {
      snprintf(err, errLen, "this broker has no %s bridge", b);
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
// aasAuthorizationKeep - the same for the AAS server's Authorization header value (<broker dir>/aas.authorization) and the
// OAuth2 client's secret (<broker dir>/aas.client-secret); the one its credentials do not use removed
//
static void secretWrite(const char* path, const char* secret, const char* what, char* err, int errLen);

static bool secretKeep(CorHttpConn* connP, const char* name, char* secret, int secretSize, void (*pathOf)(const char*, char*, int), const char* what)
{
  if (secret[0] == 0)
    return true;

  char dir[2300];
  char path[2400];
  char err[2600] = "";

  brokerDir(name, dir, sizeof(dir));
  dirsMake(dir);
  pathOf(name, path, sizeof(path));
  secretWrite(path, secret, what, err, sizeof(err));
  memset(secret, 0, secretSize);

  if (err[0] != 0)
  {
    serveError(connP, 500, "Internal error", err);
    return false;
  }

  return true;
}

static bool opcuaPasswordKeep(CorHttpConn* connP, Def* dP)
{
  return secretKeep(connP, dP->name, dP->opcua.password, sizeof(dP->opcua.password), opcuaPasswordPath, "the OPC UA password");
}

static bool aasAuthorizationKeep(CorHttpConn* connP, Def* dP)
{
  char path[2400];

  //
  // The secret the credentials do not use: gone - a broker that changed its credentials keeps no stale one
  //
  if (strcmp(dP->aas.credentials, "authorization") != 0)
  {
    aasAuthorizationPath(dP->name, path, sizeof(path));
    unlink(path);
  }
  if (strcmp(dP->aas.credentials, "oauth2") != 0)
  {
    aasClientSecretPath(dP->name, path, sizeof(path));
    unlink(path);
  }

  return secretKeep(connP, dP->name, dP->aas.authorization, sizeof(dP->aas.authorization), aasAuthorizationPath, "the AAS Authorization header") &&
         secretKeep(connP, dP->name, dP->aas.clientSecret, sizeof(dP->aas.clientSecret), aasClientSecretPath, "the AAS OAuth2 client secret");
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
// externalLog - GET /api/run/external/log?port=<port>: a broker on this machine that c3 did not start, its log file
// - where it says it writes it: GET http://127.0.0.1:<port>/admin/config, --logTo file or both, <--logDir>/coraine.log.
// The page names a port, never a file; what is served is a coraine.log. The answer of the broker is kept a minute
// (the page reads the file every second). Served by Range, as serveFileRange does.
//
typedef struct ExternalLog
{
  int     port;
  time_t  at;
  char    path[2100];                                  // "": it logs to no file
  char    why[256];
} ExternalLog;

static ExternalLog externalLogs[8];

static void externalLogAsk(ExternalLog* xP)
{
  char                url[64];
  CorRestClientMulti* multiP = corRestClientMultiCreate(1);

  xP->path[0] = 0;
  xP->at      = time(NULL);
  if (multiP == NULL)
  {
    snprintf(xP->why, sizeof(xP->why), "no HTTP client");
    return;
  }

  snprintf(url, sizeof(url), "http://127.0.0.1:%d/admin/config", xP->port);
  corRestClientMultiMaxResponse(multiP, 1024 * 1024);
  corRestClientMultiAdd(multiP, CorVerbGet, url, NULL, 0, NULL, 0, NULL, NULL);
  corRestClientMultiPerform(multiP, 2000);

  CorRestClientResponse* respP = corRestClientMultiResponse(multiP, 0);

  if ((respP == NULL) || (respP->error != 0) || (respP->body == NULL))
    snprintf(xP->why, sizeof(xP->why), "port %d does not answer", xP->port);
  else if (respP->statusCode != 200)
    snprintf(xP->why, sizeof(xP->why), "GET /admin/config: HTTP %d - no admin API", respP->statusCode);
  else
  {
    CorAlloc    alloc;
    char        buf[16 * 1024];
    CorJson     json;
    const char* to  = "stdout";
    const char* dir = "/var/log/coraine";              // coraine's default

    corAllocBufferInit(&alloc, buf, sizeof(buf), 4 * 1024 * 1024, NULL, "external log");
    corJsonCreate(&json, &alloc);

    char*    text = corAlloc(&alloc, respP->bodyLen + 1);

    if (text != NULL)
    {
      memcpy(text, respP->body, respP->bodyLen);
      text[respP->bodyLen] = 0;
    }

    CorNode* topP = (text != NULL) ? corJsonParse(&json, text) : NULL;
    CorNode* optsP = ((topP != NULL) && (topP->type == CorObject)) ? corTreeLookup(topP, "options") : NULL;

    if ((optsP != NULL) && (optsP->type == CorArray))
    {
      for (CorNode* oP = optsP->value.head; oP != NULL; oP = oP->next)
      {
        CorNode* nP = (oP->type == CorObject) ? corTreeLookup(oP, "name")  : NULL;
        CorNode* vP = (oP->type == CorObject) ? corTreeLookup(oP, "value") : NULL;

        if ((nP == NULL) || (nP->type != CorString) || (vP == NULL) || (vP->type != CorString))
          continue;
        if (strcmp(nP->value.s, "--logTo") == 0)  to  = vP->value.s;
        if (strcmp(nP->value.s, "--logDir") == 0) dir = vP->value.s;
      }

      if ((strcmp(to, "file") == 0) || (strcmp(to, "both") == 0))
        snprintf(xP->path, sizeof(xP->path), "%.2048s/coraine.log", dir);
      else
        snprintf(xP->why, sizeof(xP->why), "it logs to %.32s, not to a file - where its starter sends that", to);
    }
    else
      snprintf(xP->why, sizeof(xP->why), "GET /admin/config: no options - not a coraine");

    corAllocBufferReset(&alloc, false);
  }

  corRestClientMultiDestroy(multiP);
}

static void externalLog(CorHttpConn* connP)
{
  const char* portP = corHttpUriParam(connP, "port");
  int         port  = (portP != NULL) ? atoi(portP) : 0;

  if ((port <= 0) || (port > 65535))
  {
    serveError(connP, 400, "Bad request", "?port=<the broker's port, on this machine>");
    return;
  }

  ExternalLog* xP = NULL;
  for (int ix = 0; ix < (int) (sizeof(externalLogs) / sizeof(externalLogs[0])); ix++)
  {
    if (externalLogs[ix].port == port) { xP = &externalLogs[ix]; break; }
    if ((xP == NULL) || (externalLogs[ix].at < xP->at)) xP = &externalLogs[ix];   // else the oldest goes
  }

  if ((xP->port != port) || (time(NULL) - xP->at > 60))
  {
    xP->port = port;
    externalLogAsk(xP);
  }

  if (xP->path[0] == 0)
  {
    serveError(connP, 404, "No log file", xP->why);
    return;
  }

  serveFileRange(connP, xP->path, "text/plain; charset=utf-8", 0);
}



// -----------------------------------------------------------------------------
//
// Engine jobs - answered from a thread of their own (the request suspended meanwhile)
//
typedef struct Job
{
  CorHttpConn*  connP;
  char          arg[512];
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
// imageThread - GET /api/run/image?ref=<image>: what the image's broker has - its --version, read once per image
// ID; an image that is not here: {"here": false}
//
static void* imageThread(void* vP)
{
  Job*  jP = (Job*) vP;
  char  id[256];
  char* version = NULL;
  Str   s  = { NULL, 0, 0 };

  if ((engine[0] == 0) || (engineRun(id, sizeof(id), 20, "image", "inspect", "--format", "{{.Id}}", jP->arg, NULL) != 0) || (strncmp(id, "sha256:", 7) != 0))
  {
    strAdd(&s, "{\"image\": ");  strAddJson(&s, jP->arg);
    strAdd(&s, ", \"here\": false, \"version\": null}");
    jobAnswer(jP, 200, &s);
    return NULL;
  }

  pthread_mutex_lock(&srcMutex);
  for (int ix = 0; ix < 16; ix++)
  {
    if ((ivCache[ix].version != NULL) && (strcmp(ivCache[ix].id, id) == 0))
    {
      version = strdup(ivCache[ix].version);
      snprintf(ivCache[ix].ref, sizeof(ivCache[ix].ref), "%s", jP->arg);
      break;
    }
  }
  pthread_mutex_unlock(&srcMutex);

  if (version == NULL)
  {
    static char out[8192];                       // one image job at a time reads into it (ivMutex)
    static pthread_mutex_t ivMutex = PTHREAD_MUTEX_INITIALIZER;

    pthread_mutex_lock(&ivMutex);
    if ((engineRun(out, sizeof(out), 60, "run", "--rm", "--entrypoint", "coraine", jP->arg, "--version", NULL) == 0) && (strncmp(out, "coraine", 7) == 0))
      version = strdup(out);
    pthread_mutex_unlock(&ivMutex);

    if (version != NULL)
    {
      pthread_mutex_lock(&srcMutex);
      ImageVersion* iP = &ivCache[ivNext];
      ivNext = (ivNext + 1) % 16;
      if (iP->version != NULL) free(iP->version);
      snprintf(iP->ref, sizeof(iP->ref), "%s", jP->arg);
      snprintf(iP->id,  sizeof(iP->id),  "%s", id);
      iP->version = strdup(version);
      pthread_mutex_unlock(&srcMutex);
    }
  }

  strAdd(&s, "{\"image\": ");     strAddJson(&s, jP->arg);
  strAdd(&s, ", \"here\": true, \"version\": ");  strAddJson(&s, version);
  strAdd(&s, "}");
  if (version != NULL) free(version);
  jobAnswer(jP, 200, &s);
  return NULL;
}

//
// optionsThread - GET /api/run/options?from=installed|build|image&src=<build or image>&database=<store>&troe=<history>:
// the broker's options - its -u (each with what it does, the plugins' options in sections of their own: those of the
// store and history asked) and its -U (each one's type and default), run as a start runs it; cached per source,
// store and history (an installed coraine also by its mtime)
//
typedef struct UsageCache
{
  char   key[600];
  char*  usage;
  char*  extended;
} UsageCache;

static UsageCache ucCache[16];
static int        ucNext = 0;

static void* optionsThread(void* vP)
{
  Job*  jP = (Job*) vP;
  char* f[4] = { jP->arg, NULL, NULL, NULL };      // from, src, database, troe - tab-separated

  for (int ix = 1; ix < 4; ix++)
  {
    char* tab = (f[ix - 1] != NULL) ? strchr(f[ix - 1], '\t') : NULL;
    if (tab == NULL) { jobError(jP, 400, "Bad request", "from, src, database and troe"); return NULL; }
    *tab  = 0;
    f[ix] = tab + 1;
  }

  char        binary[2400] = "";
  char        plugins[2400] = "";
  char        key[600];
  struct stat st;

  if (strcmp(f[0], "installed") == 0)
  {
    char version[64];
    installedFind(binary, sizeof(binary), version, sizeof(version));
    if (binary[0] == 0) { jobError(jP, 404, "Not found", "no coraine installed"); return NULL; }
    snprintf(key, sizeof(key), "installed:%ld:%s:%s", (stat(binary, &st) == 0) ? (long) st.st_mtime : 0L, f[2], f[3]);
  }
  else if (strcmp(f[0], "build") == 0)
  {
    char dir[2300];
    char exe[256];
    buildDirOf(f[1], dir, sizeof(dir));
    buildMember(f[1], "executable", "coraine", exe, sizeof(exe));
    snprintf(binary,  sizeof(binary),  "%s/install/bin/%s", dir, exe);
    snprintf(plugins, sizeof(plugins), "%s/install/plugins", dir);
    if (access(binary, X_OK) != 0) { jobError(jP, 404, "Not found", "no such build"); return NULL; }
    snprintf(key, sizeof(key), "build:%s:%ld:%s:%s", f[1], (stat(binary, &st) == 0) ? (long) st.st_mtime : 0L, f[2], f[3]);
  }
  else if (strcmp(f[0], "image") == 0)
  {
    if (engine[0] == 0) { jobError(jP, 409, "No container engine", "install docker or podman"); return NULL; }
    snprintf(key, sizeof(key), "image:%s:%s:%s", f[1], f[2], f[3]);
  }
  else
  {
    jobError(jP, 400, "Bad request", "from is installed, build or image");
    return NULL;
  }

  char* usage    = NULL;
  char* extended = NULL;

  pthread_mutex_lock(&srcMutex);
  for (int ix = 0; ix < 16; ix++)
  {
    if ((ucCache[ix].usage != NULL) && (strcmp(ucCache[ix].key, key) == 0))
    {
      usage    = strdup(ucCache[ix].usage);
      extended = strdup(ucCache[ix].extended);
      break;
    }
  }
  pthread_mutex_unlock(&srcMutex);

  if (usage == NULL)
  {
    static char out[64 * 1024];                  // one options job at a time reads into it (ucMutex)
    static pthread_mutex_t ucMutex = PTHREAD_MUTEX_INITIALIZER;
    const char* flags[] = { "-u", "-U" };
    char*       got[2]  = { NULL, NULL };

    pthread_mutex_lock(&ucMutex);
    for (int ix = 0; ix < 2; ix++)
    {
      out[0] = 0;
      if (strcmp(f[0], "image") == 0)
        engineRun(out, sizeof(out), 60, "run", "--rm", "--entrypoint", "coraine", f[1], "--database", f[2], "--troe", f[3], flags[ix], NULL);
      else
      {
        const char* args[] = { "--database", f[2], "--troe", f[3], flags[ix], NULL };
        brokerRun(binary, (plugins[0] != 0) ? plugins : NULL, args, out, sizeof(out));
      }
      got[ix] = strdup(out);
    }
    pthread_mutex_unlock(&ucMutex);

    usage    = got[0];
    extended = got[1];

    if (strstr(usage, "Usage:") != NULL)
    {
      pthread_mutex_lock(&srcMutex);
      UsageCache* uP = &ucCache[ucNext];
      ucNext = (ucNext + 1) % 16;
      if (uP->usage    != NULL) free(uP->usage);
      if (uP->extended != NULL) free(uP->extended);
      snprintf(uP->key, sizeof(uP->key), "%s", key);
      uP->usage    = strdup(usage);
      uP->extended = strdup(extended);
      pthread_mutex_unlock(&srcMutex);
    }
  }

  Str s = { NULL, 0, 0 };
  bool ok = (strstr(usage, "Usage:") != NULL);
  strAdd(&s, "{\"usage\": ");      strAddJson(&s, ok ? usage : NULL);
  strAdd(&s, ", \"extended\": ");  strAddJson(&s, ok ? extended : NULL);
  strAdd(&s, ", \"why\": ");       strAddJson(&s, ok ? NULL : usage);
  strAdd(&s, "}");
  free(usage);
  free(extended);
  jobAnswer(jP, 200, &s);
  return NULL;
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
// Containers - every container on the machine (engineScan), for Operate's Containers: started, stopped, its log.
// c3's brokers in containers go through their broker (POST /api/run/brokers/<name>/start|stop), not here
//
//   POST   /api/run/containers/<name>/start    202: `start` in a thread
//   POST   /api/run/containers/<name>/stop     202: `stop` in a thread (its grace period, then killed)
//   GET    /api/run/containers/<name>/log      {"log": its last 500 lines, out and err}
//
static void* containerActThread(void* vP)
{
  char* name = (char*) vP;                       // "start <name>" or "stop <name>"
  char  out[1024];
  char* sp = strchr(name, ' ');

  *sp = 0;
  engineRun(out, sizeof(out), 60, name, &sp[1], NULL);
  free(name);
  return NULL;
}

static void containerRequest(CorHttpConn* connP, const char* name, const char* action, bool get, bool post, const char* path)
{
  char quoted[160];
  snprintf(quoted, sizeof(quoted), "{\"name\": \"%s\",", name);   // nameOk: nothing to escape

  pthread_mutex_lock(&rMutex);
  bool known = (containers != NULL) && (strstr(containers, quoted) != NULL);
  pthread_mutex_unlock(&rMutex);

  if (known == false)
  {
    serveError(connP, 404, "No such container", name);
    return;
  }

  if (post && ((strcmp(action, "start") == 0) || (strcmp(action, "stop") == 0)))
  {
    char cmd[128];
    snprintf(cmd, sizeof(cmd), "%s %s", action, name);
    threadStart(containerActThread, strdup(cmd));
    serveJson(connP, 202, "{}");
  }
  else if (get && (strcmp(action, "log") == 0))
  {
    static char log[256 * 1024];                 // one at a time: logMutex
    static pthread_mutex_t logMutex = PTHREAD_MUTEX_INITIALIZER;

    pthread_mutex_lock(&logMutex);
    engineRun(log, sizeof(log), 15, "logs", "--tail", "500", name, NULL);
    Str s = { NULL, 0, 0 };
    strAdd(&s, "{\"log\": ");
    strAddJson(&s, log);
    strAdd(&s, "}");
    pthread_mutex_unlock(&logMutex);
    respondStr(connP, 200, &s);
  }
  else
    serveError(connP, 405, "Method not allowed", path);
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

    char image[512] = "";

    if ((defImage(dP, image, sizeof(image), err, errLen) == true) && (imageEnsure(image, xP->logPath, err, errLen) == true))
    {
      Str cmd = { NULL, 0, 0 };
      argCommand(&a, &cmd);
      logLine(xP->logPath, "%s", cmd.s);
      strFree(&cmd);

      brokerContainer(dP->name, xP->name, sizeof(xP->name));
      engineRun(out, sizeof(out), 30, "rm", "-f", xP->name, NULL);    // one a c3 that died left (it ends in 120 s anyway)

      char*  aasVars[2];
      char** env    = aasEnv(dP, aasVars);
      int    status = engineArgvEnv(&a, env, out, sizeof(out), 120);

      aasEnvFree(env, aasVars);
      if (status != 0)
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

    char*     aasVars[2];
    char**    env    = aasEnv(dP, aasVars);
    ProcSpawn sp     = { a.v, env, fd, dir, true, false, SIGKILL };   // its own group (stopped as one), dies with c3
    xP->pid = procSpawn(&sp);
    aasEnvFree(env, aasVars);

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
  dP->options[0]        = 0;
  dP->dds.vocabulary[0] = 0;
  dP->dds.topics[0]     = 0;
  dP->dds.services[0]   = 0;
  dP->dds.actions[0]    = 0;
  dP->opcua.roots[0]    = 0;
  dP->opcua.channels[0] = 0;
  dP->aas.channels[0]   = 0;

  if (strcmp(bridge, "opcua") != 0)
    dP->opcua.url[0] = 0;
  if (strcmp(bridge, "aas") != 0)
    dP->aas.url[0] = 0;
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
static void secretWrite(const char* path, const char* secret, const char* what, char* err, int errLen);
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
        secretWrite(path, d.opcua.password, "the OPC UA password", err, sizeof(err));
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
          secretWrite(path, text, "the OPC UA password", err, sizeof(err));
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
// aasPathAdd - 'id' percent-encoded onto a path (a query's value)
//
static void aasPathAdd(char* path, int pathSize, const char* id)
{
  int len = strlen(path);

  for (const char* c = id; (*c != 0) && (len < pathSize - 4); c++)
  {
    unsigned char u = (unsigned char) *c;
    if (((u >= 'A') && (u <= 'Z')) || ((u >= 'a') && (u <= 'z')) || ((u >= '0') && (u <= '9')) || (u == '-') || (u == '.') || (u == '_') || (u == '~'))
      path[len++] = *c;
    else
      len += snprintf(&path[len], pathSize - len, "%%%02X", u);
  }
  path[len] = 0;
}



// -----------------------------------------------------------------------------
//
// aasModels - the inventory (the server's shells and submodels) and every shell's model, and every model of a
// submodel no shell refers to - the aas bridge's inventory?from=<id>, a whole model per GET - at most 200. The
// answer: { "url", "complete", "shells": [...], "submodels": [...], "models": { "<id>": <the node tree> },
// "errors": { "<id>": why } }
//
static bool aasModels(const Discovery* xP, const char* url, Str* sP, char* err, int errLen)
{
  CorAlloc  alloc;
  char      buf[16 * 1024];
  CorJson   json;
  Str       body  = { NULL, 0, 0 };
  CorNode*  rootP = NULL;
  bool      ok    = false;
  int       code  = 0;

  corAllocBufferInit(&alloc, buf, sizeof(buf), 4 * 1024 * 1024, NULL, "c3 aas inventory");
  corJsonCreate(&json, &alloc);

  //
  // The bridge reads the server's lists when asked: a server that is not up yet answers on a later try - asked
  // again for at most 10 s while the broker answers 503
  //
  for (int ix = 0; ix < 20; ix++)
  {
    strFree(&body);
    code = discoverGet(xP, "/admin/bridges/aas/inventory", 30000, &body, err, errLen);
    if (code != 503)
      break;
    usleep(500 * 1000);
  }

  if (code == 200)
    rootP = corJsonParse(&json, corAllocStrdup(&alloc, (body.s != NULL) ? body.s : ""));

  CorNode* shellsP    = (rootP != NULL) ? corTreeLookup(rootP, "shells")    : NULL;
  CorNode* submodelsP = (rootP != NULL) ? corTreeLookup(rootP, "submodels") : NULL;

  if (code == 0)
    ;
  else if (code != 200)
    snprintf(err, errLen, "the aas bridge did not read %s - the discovery's broker answered %d: %.700s", url, code, (body.s != NULL) ? body.s : "");
  else if ((shellsP == NULL) || (shellsP->type != CorArray) || (submodelsP == NULL) || (submodelsP->type != CorArray))
    snprintf(err, errLen, "the aas bridge's inventory is not { \"shells\": [...], \"submodels\": [...] }");
  else
  {
    Str  models   = { NULL, 0, 0 };
    Str  errors   = { NULL, 0, 0 };
    int  requests = 0;
    bool complete = true;

    //
    // The ids to read: each shell, then each submodel no shell refers to
    //
    const char* ids[400];
    int         n = 0;

    for (CorNode* shP = shellsP->value.head; (shP != NULL) && (n < 400); shP = shP->next)
    {
      CorNode* idP = corTreeLookup(shP, "id");
      if ((idP != NULL) && (idP->type == CorString))
        ids[n++] = idP->value.s;
    }

    for (CorNode* smP = submodelsP->value.head; (smP != NULL) && (n < 400); smP = smP->next)
    {
      CorNode* idP     = corTreeLookup(smP, "id");
      bool     inShell = false;

      if ((idP == NULL) || (idP->type != CorString))
        continue;

      for (CorNode* shP = shellsP->value.head; (shP != NULL) && !inShell; shP = shP->next)
      {
        CorNode* refsP = corTreeLookup(shP, "submodels");
        for (CorNode* rP = ((refsP != NULL) && (refsP->type == CorArray)) ? refsP->value.head : NULL; (rP != NULL) && !inShell; rP = rP->next)
          inShell = (rP->type == CorString) && (strcmp(rP->value.s, idP->value.s) == 0);
      }

      if (!inShell)
        ids[n++] = idP->value.s;
    }

    for (int ix = 0; ix < n; ix++)
    {
      if (requests >= 200)
      {
        complete = false;
        break;
      }

      char path[2400] = "/admin/bridges/aas/inventory?from=";
      Str  one        = { NULL, 0, 0 };
      char why[1024]  = "";

      aasPathAdd(path, sizeof(path), ids[ix]);
      requests++;

      int c = discoverGet(xP, path, 30000, &one, why, sizeof(why));

      if ((c == 200) && (one.s != NULL) && (one.s[0] == '{'))
      {
        strAdd(&models, (models.len > 0) ? ", " : "");
        strAddJson(&models, ids[ix]);
        strAdd(&models, ": ");
        strAdd(&models, one.s);
      }
      else
      {
        if (c != 0)
          snprintf(why, sizeof(why), "%d: %.700s", c, (one.s != NULL) ? one.s : "");
        strAdd(&errors, (errors.len > 0) ? ", " : "");
        strAddJson(&errors, ids[ix]);
        strAdd(&errors, ": ");
        strAddJson(&errors, why);
      }
      strFree(&one);
    }

    if (n >= 400)
      complete = false;

    strAdd(sP, "{\"url\": ");           strAddJson(sP, url);
    strAddf(sP, ", \"complete\": %s, \"shells\": ", complete ? "true" : "false");
    {
      int   size = corJsonRenderSize(&json, shellsP) + 2;
      char* text = malloc(size);
      if (text != NULL) { corJsonRender(&json, shellsP, text); strAdd(sP, text); free(text); } else strAdd(sP, "[]");
    }
    strAdd(sP, ", \"submodels\": ");
    {
      int   size = corJsonRenderSize(&json, submodelsP) + 2;
      char* text = malloc(size);
      if (text != NULL) { corJsonRender(&json, submodelsP, text); strAdd(sP, text); free(text); } else strAdd(sP, "[]");
    }
    strAdd(sP, ", \"models\": {");  strAdd(sP, (models.s != NULL) ? models.s : "");  strAdd(sP, "}");
    strAdd(sP, ", \"errors\": {");  strAdd(sP, (errors.s != NULL) ? errors.s : "");  strAdd(sP, "}}");

    strFree(&models);
    strFree(&errors);
    ok = true;
  }

  strFree(&body);
  corAllocBufferReset(&alloc, false);
  return ok;
}



// -----------------------------------------------------------------------------
//
// aasSecretCopy - a secret for the discovery's broker, at 'path': the one the request gave, else the one c3 keeps
// for the form's broker ('kept'); neither: none. 'given' wiped
//
static void aasSecretCopy(char* given, int givenSize, const char* kept, const char* path, const char* what, char* err, int errLen)
{
  unlink(path);

  if (given[0] != 0)
    secretWrite(path, given, what, err, errLen);
  else
  {
    char* text = fileText(kept);

    if (text != NULL)
    {
      char* nl = strchr(text, '\n');
      if (nl != NULL)
        *nl = 0;
      secretWrite(path, text, what, err, errLen);
      memset(text, 0, strlen(text));
      free(text);
    }
  }

  memset(given, 0, givenSize);
}



// -----------------------------------------------------------------------------
//
// aasDiscoverThread - the aas bridge's view of the server: its shells and submodels, each model whole (aasModels).
// The secrets (the Authorization header's value, the OAuth2 client's): the ones the request gave, else the ones c3
// keeps for the form's broker - for the discovery's broker in its own directory, gone with it
//
static void* aasDiscoverThread(void* vP)
{
  DiscoverJob* djP = (DiscoverJob*) vP;
  Def          d   = djP->def;
  Discovery    x   = { 0, -1, "", "" };
  char         err[1024] = "";
  Str          s   = { NULL, 0, 0 };
  char         keptAuth[2400];
  char         keptSecret[2400];

  aasAuthorizationPath(d.name, keptAuth, sizeof(keptAuth));       // the form's broker's, before discoverPrepare renames it
  aasClientSecretPath(d.name, keptSecret, sizeof(keptSecret));
  discoverPrepare(&d, "aas");
  memset(djP->def.aas.authorization, 0, sizeof(djP->def.aas.authorization));
  memset(djP->def.aas.clientSecret, 0, sizeof(djP->def.aas.clientSecret));

  char authPath[2400];                           // the discovery's copies: gone with it
  char secretPath[2400];
  aasAuthorizationPath(d.name, authPath, sizeof(authPath));
  aasClientSecretPath(d.name, secretPath, sizeof(secretPath));

  if (d.aas.url[0] == 0)
    snprintf(err, sizeof(err), "the AAS server to discover: its URL (http[s]://host:port[/base path])");
  else if (strcmp(d.where, "container") == 0)
    snprintf(err, sizeof(err), "AAS discovery runs a native broker - an installed coraine or a build: a server on localhost is reached");
  else
  {
    char dir[2300];

    brokerDir(d.name, dir, sizeof(dir));
    dirsMake(dir);

    aasSecretCopy(d.aas.authorization, sizeof(d.aas.authorization), keptAuth, authPath, "the AAS Authorization header", err, sizeof(err));
    if (err[0] == 0)
      aasSecretCopy(d.aas.clientSecret, sizeof(d.aas.clientSecret), keptSecret, secretPath, "the AAS OAuth2 client secret", err, sizeof(err));

    if ((err[0] == 0) && (discoverStart(&d, &x, err, sizeof(err)) == true))
      aasModels(&x, d.aas.url, &s, err, sizeof(err));

    discoverStop(&x);
    unlink(authPath);
    unlink(secretPath);
  }

  memset(d.aas.authorization, 0, sizeof(d.aas.authorization));
  memset(d.aas.clientSecret, 0, sizeof(d.aas.clientSecret));
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
    memset(djP->def.aas.authorization, 0, sizeof(djP->def.aas.authorization));
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
// secretWrite - a secret (a password, an Authorization header's value), into a file only its owner reads (0600), and
// a newline after it - the opcua bridge's passwordFile reads its first line, as c3 does (aasEnv); 'what' names it in err
//
static void secretWrite(const char* path, const char* secret, const char* what, char* err, int errLen)
{
  int  fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  int  n  = strlen(secret);
  bool ok = (fd != -1) && (fchmod(fd, 0600) == 0) && (write(fd, secret, n) == n) && (write(fd, "\n", 1) == 1);

  if (fd != -1)
    close(fd);
  if (!ok)
    snprintf(err, errLen, "%s cannot be kept in %s: %s", what, path, strerror(errno));
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
    secretWrite(pwPath, dP->opcua.password, "the OPC UA password", err, sizeof(err));
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
// The Dashboard - WireCloud (Ficodes, AGPL-3.0), in containers of its own: the set "dashboard" - MongoDB,
// Elasticsearch and WireCloud (c3-dashboard-mongo, -elasticsearch, -wirecloud), started in that order and
// stopped in the other. c3 runs WireCloud as it is, a program of its own in a container: nothing of it is
// linked into c3.
//
//   GET    /api/run/dashboard          its state: the three services, what a start or stop does now, why the
//                                      last one failed
//   POST   /api/run/dashboard/start    202: started (dashboardThread) - the first start also installs its
//                                      widgets (populate) and makes its user admin, its password made by c3
//   POST   /api/run/dashboard/stop     202: the three stopped, their volumes kept
//   POST   /api/run/dashboard/login    c3 logs in as admin and hands the page WireCloud's session cookies -
//                                      the password never goes to the page
//   POST   /api/run/dashboard/reset-password  admin gets c3's password (one set outside this c3: loginFailed)
//   GET    /api/run/dashboard/log      what the starts and stops did - c3's lines, the commands
//
// The cookies: a browser keeps a cookie per host, not per port, so the cookies of WireCloud's login, set on
// c3's answer, go to WireCloud on its own port of the same host. The page shows WireCloud on the host it
// was itself loaded from (localhost or 127.0.0.1 - not one for the other: they are two sites).
//

static const int dashKinds[] = { KIND_MONGO, KIND_ELASTICSEARCH, KIND_WIRECLOUD };
#define DASH_KINDS  3

static void dashDoing(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
static void dashDoing(const char* fmt, ...)
{
  char    text[200];
  va_list ap;

  va_start(ap, fmt);
  vsnprintf(text, sizeof(text), fmt, ap);
  va_end(ap);

  time_t now = time(NULL);
  pthread_mutex_lock(&rMutex);
  snprintf(dash.doing, sizeof(dash.doing), "%s", text);
  if ((dash.nSteps > 0) && (dash.steps[dash.nSteps - 1].end == 0))
    dash.steps[dash.nSteps - 1].end = now;
  if (dash.nSteps == DASH_STEPS)                 // never, the steps being fewer - the last one says it then
    dash.nSteps--;
  DashStep* stP = &dash.steps[dash.nSteps++];
  snprintf(stP->text, sizeof(stP->text), "%s", text);
  stP->start  = now;
  stP->end    = 0;
  stP->failed = false;
  if (dash.nSteps > dash.total)
    dash.total = dash.nSteps;
  pthread_mutex_unlock(&rMutex);
  logLine(dash.logPath, "%s", text);
}

//
// dashSteps - more steps than planned (the first start's, a widget to install); dashStepsEnd - the last step
// over, failed or not
//
static void dashSteps(int more)
{
  pthread_mutex_lock(&rMutex);
  dash.total += more;
  pthread_mutex_unlock(&rMutex);
}

static void dashStepsEnd(bool failed)            // with rMutex
{
  if ((dash.nSteps > 0) && (dash.steps[dash.nSteps - 1].end == 0))
  {
    dash.steps[dash.nSteps - 1].end    = time(NULL);
    dash.steps[dash.nSteps - 1].failed = failed;
  }
  if (failed == false)
    dash.total = dash.nSteps;
}

//
// dashPort - WireCloud's port on 127.0.0.1, 0 when it does not run
//
static int dashPort(void)
{
  char name[96];
  int  port = 0;

  svcName(DASHBOARD_SET, KIND_WIRECLOUD, name, sizeof(name));
  pthread_mutex_lock(&rMutex);
  Service* sP = svcFind(name);
  if ((sP != NULL) && (strcmp(sP->state, "running") == 0))
    port = sP->hostPort;
  pthread_mutex_unlock(&rMutex);
  return port;
}

//
// dashLogin - WireCloud's login as admin: its Set-Cookie lines into cookiesP (when given). The status: 302 -
// logged in; 200 - wrong user or password (its login page again); else no answer (-1) or what it said.
//
static int dashLogin(int port, Str* cookiesP, char* err, int errLen)
{
  char password[65];

  if (credsDashboard(password, sizeof(password), NULL, 0, NULL, 0, err, errLen) == false)
    return -1;

  Str body = { NULL, 0, 0 };
  strAdd(&body, "{\"username\": \"" DASHBOARD_USER "\", \"password\": ");
  strAddJson(&body, password);
  strAdd(&body, "}");
  memset(password, 0, sizeof(password));

  Str head   = { NULL, 0, 0 };
  int status = localHttp(port, "POST", "/login", body.s, &head, 30);
  memset(body.s, 0, body.len);
  strFree(&body);

  if ((status == 302) && (cookiesP != NULL) && (head.s != NULL))
  {
    char* save = NULL;
    for (char* line = strtok_r(head.s, "\r\n", &save); line != NULL; line = strtok_r(NULL, "\r\n", &save))
    {
      if (strncasecmp(line, "set-cookie:", 11) != 0)
        continue;
      char* v = &line[11];
      while (*v == ' ')
        ++v;
      strAdd(cookiesP, v);
      strAdd(cookiesP, "\n");
    }
  }
  if ((status == 302) && ((cookiesP == NULL) || (cookiesP->len > 0)))
  {
    strFree(&head);
    return 302;
  }

  if (status == 302)
    snprintf(err, errLen, "WireCloud's login answered without its cookies");
  else if (status == 200)
    snprintf(err, errLen, "WireCloud does not take the password c3 made for its user " DASHBOARD_USER);
  else if (status == -1)
    snprintf(err, errLen, "WireCloud does not answer on 127.0.0.1:%d", port);
  else
    snprintf(err, errLen, "WireCloud's login answered %d", status);

  strFree(&head);
  return status;
}

//
// dashExec - a command of WireCloud's in its container (python -m manage ...), its output into the log;
// 'password' (or NULL) goes in through the environment of the exec - never on a command line
//
static int dashExec(const char* password, int timeoutS, const char* const* args)
{
  char container[96];
  svcName(DASHBOARD_SET, KIND_WIRECLOUD, container, sizeof(container));

  Argv a = { { NULL }, 0 };
  argAdd(&a, engine);
  argAdd(&a, "exec");
  if (password != NULL)
  {
    argAdd(&a, "-e");                            // the value from the environment of the exec - not on its command line
    argAdd(&a, "C3_PASSWORD");
  }
  argAdd(&a, container);
  for (int ix = 0; args[ix] != NULL; ix++)
    argAdd(&a, args[ix]);

  Str cmd = { NULL, 0, 0 };
  argCommand(&a, &cmd);
  logLine(dash.logPath, "%s", cmd.s);
  strFree(&cmd);

  //
  // c3's environment and C3_PASSWORD, for this one child - not setenv: another thread may start a broker now
  //
  char** envp = NULL;
  char*  pwVar = NULL;
  if (password != NULL)
  {
    int n = 0;
    while (environ[n] != NULL)
      ++n;
    envp = calloc(n + 2, sizeof(char*));
    for (int ix = 0; ix < n; ix++)
      envp[ix] = environ[ix];
    if (asprintf(&pwVar, "C3_PASSWORD=%s", password) == -1)
      pwVar = NULL;
    envp[n] = pwVar;
  }

  int status = engineToLogEnv(dash.logPath, timeoutS, &a, envp);

  if (pwVar != NULL)
  {
    memset(pwVar, 0, strlen(pwVar));
    free(pwVar);
  }
  free(envp);
  argFree(&a);
  return status;
}

//
// dashAdmin - WireCloud's user admin, in its database (MongoDB, the users collection - WireCloud has no command
// that changes a password): reset - its password made c3's (C3_PASSWORD, WireCloud's own hash: Django's
// pbkdf2_sha256, as wirecloud.commons.commands._hash_password); else asked whether it exists. Only
// wirecloud.database imported: no themes loaded, so a broken theme does not stop it. 0: done / it exists; 1: no
// user admin; -1: it did not run.
//
static const char dashAdminScript[] =
  "import asyncio, os, sys\n"
  "from base64 import b64encode\n"
  "from hashlib import pbkdf2_hmac\n"
  "from wirecloud.database import database\n"
  "def hashed(p):\n"
  "    salt = b64encode(os.urandom(16)).decode('ascii').rstrip('=')[:22]\n"
  "    h = pbkdf2_hmac('sha256', p.encode('utf-8'), salt.encode('ascii'), 600000)\n"
  "    return 'pbkdf2_sha256$600000$' + salt + '$' + b64encode(h).decode('ascii')\n"
  "async def main():\n"
  "    if sys.argv[1] == 'reset':\n"
  "        r = await database.users.update_one({'username': sys.argv[2]}, {'$set': {'password': hashed(os.environ['C3_PASSWORD'])}})\n"
  "        return 10 if r.matched_count == 1 else 11\n"
  "    return 10 if await database.users.find_one({'username': sys.argv[2]}) is not None else 11\n"
  "sys.exit(asyncio.run(main()))\n";

static int dashAdmin(const char* password)
{
  const char* args[] = { "python", "-c", dashAdminScript, (password != NULL) ? "reset" : "exists", DASHBOARD_USER, NULL };
  int         status = dashExec(password, 120, args);

  if ((status == -1) || (WIFEXITED(status) == false))
    return -1;
  return (WEXITSTATUS(status) == 10) ? 0 : (WEXITSTATUS(status) == 11) ? 1 : -1;
}

//
// The widgets c3 installs in WireCloud - www/widgets/<name>/, each a widget's files (config.xml first), and
// www/widgets/common/, added to every widget as js/common/. A .wgt is a zip; its entries are STORED (no
// compression: a widget is a few KiB), each with its CRC-32 (zlib).
//
typedef struct ZipEntry
{
  char      name[512];
  uint32_t  crc;
  uint32_t  size;
  uint32_t  offset;
} ZipEntry;

#define ZIP_ENTRIES_MAX  256

static void zipLe16(Str* sP, unsigned v) { char b[2] = { (char) (v & 0xff), (char) ((v >> 8) & 0xff) }; strAddN(sP, b, 2); }
static void zipLe32(Str* sP, uint32_t v) { char b[4] = { (char) (v & 0xff), (char) ((v >> 8) & 0xff), (char) ((v >> 16) & 0xff), (char) ((v >> 24) & 0xff) }; strAddN(sP, b, 4); }

static bool zipAdd(Str* zP, ZipEntry* entries, int* nP, const char* name, const char* data, int len)
{
  if ((*nP >= ZIP_ENTRIES_MAX) || (strlen(name) >= sizeof(entries[0].name)))
    return false;

  ZipEntry* eP = &entries[(*nP)++];
  snprintf(eP->name, sizeof(eP->name), "%s", name);
  eP->crc    = crc32(crc32(0L, Z_NULL, 0), (const Bytef*) data, len);
  eP->size   = len;
  eP->offset = zP->len;

  zipLe32(zP, 0x04034b50);                       // local file header
  zipLe16(zP, 20);                               // version needed: 2.0
  zipLe16(zP, 0x0800);                           // flags: the name is UTF-8
  zipLe16(zP, 0);                                // STORED
  zipLe16(zP, 0);  zipLe16(zP, 0x21);            // time, date: 1980-01-01
  zipLe32(zP, eP->crc);
  zipLe32(zP, eP->size);
  zipLe32(zP, eP->size);
  zipLe16(zP, strlen(name));
  zipLe16(zP, 0);
  strAdd(zP, name);
  strAddN(zP, data, len);
  return true;
}

static void zipEnd(Str* zP, const ZipEntry* entries, int n)
{
  uint32_t cdStart = zP->len;

  for (int ix = 0; ix < n; ix++)
  {
    zipLe32(zP, 0x02014b50);                     // central directory header
    zipLe16(zP, 20);  zipLe16(zP, 20);
    zipLe16(zP, 0x0800);
    zipLe16(zP, 0);
    zipLe16(zP, 0);  zipLe16(zP, 0x21);
    zipLe32(zP, entries[ix].crc);
    zipLe32(zP, entries[ix].size);
    zipLe32(zP, entries[ix].size);
    zipLe16(zP, strlen(entries[ix].name));
    zipLe16(zP, 0);  zipLe16(zP, 0);             // extra, comment
    zipLe16(zP, 0);  zipLe16(zP, 0);             // disk, internal attributes
    zipLe32(zP, 0);                              // external attributes
    zipLe32(zP, entries[ix].offset);
    strAdd(zP, entries[ix].name);
  }

  uint32_t cdSize = zP->len - cdStart;
  zipLe32(zP, 0x06054b50);                       // end of central directory
  zipLe16(zP, 0);  zipLe16(zP, 0);
  zipLe16(zP, n);  zipLe16(zP, n);
  zipLe32(zP, cdSize);
  zipLe32(zP, cdStart);
  zipLe16(zP, 0);
}

//
// zipDir - every regular file under dir (recursively), as <prefix><its path under dir>
//
//
// zipFile - one file into the zip, as 'name'
//
static bool zipFile(Str* zP, ZipEntry* entries, int* nP, const char* path, const char* name, char* err, int errLen)
{
  struct stat st;
  int         fd = open(path, O_RDONLY | O_CLOEXEC);
  if ((fd == -1) || (fstat(fd, &st) != 0))
  {
    if (fd != -1)
      close(fd);
    snprintf(err, errLen, "%s: %s", path, strerror(errno));
    return false;
  }

  char* data = malloc(st.st_size + 1);
  int   got  = (data != NULL) ? (int) read(fd, data, st.st_size) : -1;
  close(fd);
  bool ok = (got == st.st_size) && zipAdd(zP, entries, nP, name, data, got);
  if (ok == false)
    snprintf(err, errLen, "%s: not packed (unread, or too many files)", path);
  free(data);
  return ok;
}

static bool zipDir(Str* zP, ZipEntry* entries, int* nP, const char* dir, const char* prefix, char* err, int errLen);

//
// zipIncludes - the files of www/ a widget takes from c3, named in its file c3-include: a line per file or
// directory, "<path under www/> <path in the .wgt>" (a '#' line is a comment). The map widget takes maplibre
// and c3's base map this way - in the .wgt, so they load from WireCloud's origin (maplibre's worker must).
//
static bool zipIncludes(Str* zP, ZipEntry* entries, int* nP, const char* wdir, char* err, int errLen)
{
  char list[4200];
  snprintf(list, sizeof(list), "%s/c3-include", wdir);
  FILE* fP = fopen(list, "r");
  if (fP == NULL)
    return true;                                 // nothing to include

  char line[1024];
  bool ok = true;
  while (ok && (fgets(line, sizeof(line), fP) != NULL))
  {
    char from[512], to[512];
    if ((line[0] == '#') || (sscanf(line, "%511s %511s", from, to) != 2))
      continue;
    if ((strstr(from, "..") != NULL) || (strstr(to, "..") != NULL) || (from[0] == '/') || (to[0] == '/'))
    {
      snprintf(err, errLen, "%s: '%s %s' - paths under www/ and in the .wgt only", list, from, to);
      ok = false;
      break;
    }

    char path[4700];
    snprintf(path, sizeof(path), "%s/%s", c3WwwDir, from);
    struct stat st;
    if (stat(path, &st) != 0)
    {
      snprintf(err, errLen, "%s: %s: %s", list, path, strerror(errno));
      ok = false;
    }
    else if (S_ISDIR(st.st_mode))
    {
      char prefix[520];
      snprintf(prefix, sizeof(prefix), "%s/", to);
      ok = zipDir(zP, entries, nP, path, prefix, err, errLen);
    }
    else
      ok = zipFile(zP, entries, nP, path, to, err, errLen);
  }
  fclose(fP);
  return ok;
}

static bool zipDir(Str* zP, ZipEntry* entries, int* nP, const char* dir, const char* prefix, char* err, int errLen)
{
  DIR* dP = opendir(dir);
  if (dP == NULL)
  {
    snprintf(err, errLen, "%s: %s", dir, strerror(errno));
    return false;
  }

  struct dirent* deP;
  bool           ok = true;
  while (ok && ((deP = readdir(dP)) != NULL))
  {
    if (deP->d_name[0] == '.')
      continue;

    char path[4096];
    char name[1024];
    snprintf(path, sizeof(path), "%s/%s", dir, deP->d_name);
    snprintf(name, sizeof(name), "%s%s", prefix, deP->d_name);

    struct stat st;
    if (lstat(path, &st) != 0)
      continue;

    if (S_ISDIR(st.st_mode))
    {
      char sub[1100];
      snprintf(sub, sizeof(sub), "%s/", name);
      ok = zipDir(zP, entries, nP, path, sub, err, errLen);
    }
    else if (S_ISREG(st.st_mode) && (strcmp(name, "c3-include") != 0))
      ok = zipFile(zP, entries, nP, path, name, err, errLen);
  }
  closedir(dP);
  return ok;
}

//
// widgetIdent - vendor, name and version of a widget's config.xml (its <widget ...> element)
//
static bool widgetIdent(const char* xml, char* vendor, char* name, char* version, int len)
{
  const char* w = strstr(xml, "<widget");
  if (w == NULL)
    return false;
  const char* end = strchr(w, '>');

  struct { const char* attr; char* out; } a[] = { { " vendor=\"", vendor }, { " name=\"", name }, { " version=\"", version } };
  for (int ix = 0; ix < 3; ix++)
  {
    const char* v = strstr(w, a[ix].attr);
    if ((v == NULL) || ((end != NULL) && (v > end)))
      return false;
    v += strlen(a[ix].attr);
    const char* q = strchr(v, '"');
    if ((q == NULL) || (q - v >= len) || (q == v))
      return false;
    snprintf(a[ix].out, len, "%.*s", (int) (q - v), v);
    for (const char* c = a[ix].out; *c != 0; ++c)        // they go into a URL path
    {
      if (!(((*c >= 'a') && (*c <= 'z')) || ((*c >= 'A') && (*c <= 'Z')) || ((*c >= '0') && (*c <= '9')) || (*c == '-') || (*c == '_') || (*c == '.')))
        return false;
    }
  }
  return true;
}

//
// dashWidgets - c3's widgets installed in WireCloud for admin: each one whose vendor/name/version WireCloud
// does not have yet (a changed widget: a new version in its config.xml). Logged in through WireCloud's API
// (a bearer token: no CSRF token needed). false: why, in err.
//
static bool dashWidgets(int port, char* err, int errLen)
{
  char dir[4200];
  snprintf(dir, sizeof(dir), "%s/widgets", c3WwwDir);

  DIR* dP = opendir(dir);
  if (dP == NULL)
    return true;                                 // no widgets with this c3

  //
  // The API's login: a bearer token
  //
  char password[65];
  if (credsDashboard(password, sizeof(password), NULL, 0, NULL, 0, err, errLen) == false)
  {
    closedir(dP);
    return false;
  }
  Str body = { NULL, 0, 0 };
  strAdd(&body, "{\"username\": \"" DASHBOARD_USER "\", \"password\": ");
  strAddJson(&body, password);
  strAdd(&body, "}");
  memset(password, 0, sizeof(password));

  Str      resp = { NULL, 0, 0 };
  LocalReq lr   = { "POST", "/api/auth/login", NULL, NULL, body.s, -1, NULL, &resp, 30 };
  int      st   = localRequest(port, &lr);
  memset(body.s, 0, body.len);
  strFree(&body);

  char bearer[2048] = "";
  const char* at = (resp.s != NULL) ? strstr(resp.s, "\"access_token\"") : NULL;
  if (at != NULL)
  {
    const char* v = strchr(at + 14, '"');
    const char* e = (v != NULL) ? strchr(v + 1, '"') : NULL;
    if ((e != NULL) && (e - v - 1 < (int) sizeof(bearer) - 8))
      snprintf(bearer, sizeof(bearer), "Bearer %.*s", (int) (e - v - 1), v + 1);
  }
  strFree(&resp);
  if ((st != 200) || (bearer[0] == 0))
  {
    closedir(dP);
    snprintf(err, errLen, "WireCloud's API login answered %d", st);
    return false;
  }

  char common[4300];
  snprintf(common, sizeof(common), "%s/common", dir);

  bool           ok = true;
  struct dirent* deP;
  while (ok && ((deP = readdir(dP)) != NULL))
  {
    if ((deP->d_name[0] == '.') || (strcmp(deP->d_name, "common") == 0))
      continue;

    char wdir[4500];
    char cfg[4600];
    snprintf(wdir, sizeof(wdir), "%s/%s", dir, deP->d_name);
    snprintf(cfg, sizeof(cfg), "%s/config.xml", wdir);

    char* xml = fileText(cfg);
    if (xml == NULL)
      continue;                                  // not a widget

    char vendor[64], name[64], version[64];
    bool identified = widgetIdent(xml, vendor, name, version, sizeof(vendor));
    free(xml);
    if (identified == false)
    {
      logLine(dash.logPath, "widget %s: its config.xml names no vendor, name and version - left out", deP->d_name);
      continue;
    }

    char path[300];
    snprintf(path, sizeof(path), "/api/resource/%s/%s/%s", vendor, name, version);
    LocalReq has = { "GET", path, bearer, NULL, NULL, 0, NULL, NULL, 15 };
    if (localRequest(port, &has) == 200)
      continue;                                  // installed already

    //
    // The .wgt: the widget's files, then common/ as js/common/, then what its c3-include names
    //
    Str       zip = { NULL, 0, 0 };
    ZipEntry* entries = calloc(ZIP_ENTRIES_MAX, sizeof(ZipEntry));
    int       n = 0;
    char      zerr[512] = "";

    bool packed = (entries != NULL) && zipDir(&zip, entries, &n, wdir, "", zerr, sizeof(zerr));
    if (packed && (access(common, R_OK) == 0))
      packed = zipDir(&zip, entries, &n, common, "js/common/", zerr, sizeof(zerr));
    if (packed)
      packed = zipIncludes(&zip, entries, &n, wdir, zerr, sizeof(zerr));
    if (packed)
      zipEnd(&zip, entries, n);
    free(entries);

    if (packed == false)
    {
      strFree(&zip);
      snprintf(err, errLen, "widget %s: %s", deP->d_name, zerr);
      ok = false;
      break;
    }

    dashSteps(1);
    dashDoing("installing the widget %s/%s %s in WireCloud", vendor, name, version);
    Str      head = { NULL, 0, 0 };
    LocalReq up   = { "POST", "/api/resources/", bearer, "application/octet-stream", zip.s, zip.len, &head, NULL, 60 };
    int      us   = localRequest(port, &up);
    strFree(&zip);
    if ((us != 201) && (us != 200))
    {
      snprintf(err, errLen, "WireCloud did not take the widget %s/%s %s: it answered %d", vendor, name, version, us);
      ok = false;
    }
    strFree(&head);
  }

  closedir(dP);
  memset(bearer, 0, sizeof(bearer));
  return ok;
}

//
// runDashboardOrigin - is this Origin WireCloud's, the Dashboard's, while it runs? Its widgets read the brokers
// through c3 (serve.c answers their CORS preflights - GET only)
//
bool runDashboardOrigin(const char* origin)
{
  int port = dashPort();
  if ((origin == NULL) || (port <= 0))
    return false;

  char a[64], b[64];
  snprintf(a, sizeof(a), "http://localhost:%d", port);
  snprintf(b, sizeof(b), "http://127.0.0.1:%d", port);
  return (strcmp(origin, a) == 0) || (strcmp(origin, b) == 0);
}

//
// runDashboardWidgetWrite - a widget's write through the proxy (serve.c lets it through), in the Dashboard's log
//
void runDashboardWidgetWrite(const char* method, const char* broker, const char* tenant, const char* path)
{
  if (dash.logPath[0] != 0)
    logLine(dash.logPath, "a widget writes: %s %s%s%s%s", method, (broker != NULL) ? broker : "(no broker)", path,
            ((tenant != NULL) && (tenant[0] != 0)) ? " - tenant " : "", ((tenant != NULL) && (tenant[0] != 0)) ? tenant : "");
}

//
// dashboardBrokers - GET /api/run/dashboard/brokers: the brokers c3 knows (the configuration's), for the widgets'
// broker picker - url, name, tenant and tenants - and the types' own colours given in Explore (its
// "connect": {"typeColours"}), so the graph and the map colour a type as Explore does
//
static void dashboardBrokers(CorHttpConn* connP)
{
  CorAlloc alloc;
  char     buf[16 * 1024];
  CorJson  json;

  corAllocBufferInit(&alloc, buf, sizeof(buf), 4 * 1024 * 1024, NULL, "dashboard brokers");
  corJsonCreate(&json, &alloc);

  CorNode* rootP    = corJsonParse(&json, corAllocStrdup(&alloc, configText()));
  CorNode* brokersP = ((rootP != NULL) && (rootP->type == CorObject)) ? corTreeLookup(rootP, "brokers") : NULL;
  Str      s        = { NULL, 0, 0 };
  bool     first    = true;

  strAdd(&s, "[");
  for (CorNode* bP = ((brokersP != NULL) && (brokersP->type == CorArray)) ? brokersP->value.head : NULL; bP != NULL; bP = bP->next)
  {
    CorNode* urlP     = (bP->type == CorObject) ? corTreeLookup(bP, "url")     : NULL;
    CorNode* nameP    = (bP->type == CorObject) ? corTreeLookup(bP, "name")    : NULL;
    CorNode* tenantP  = (bP->type == CorObject) ? corTreeLookup(bP, "tenant")  : NULL;
    CorNode* tenantsP = (bP->type == CorObject) ? corTreeLookup(bP, "tenants") : NULL;

    if ((urlP == NULL) || (urlP->type != CorString))
      continue;

    strAdd(&s, first ? "{\"url\": " : ", {\"url\": ");
    strAddJson(&s, urlP->value.s);
    strAdd(&s, ", \"name\": ");   strAddJson(&s, ((nameP != NULL) && (nameP->type == CorString)) ? nameP->value.s : urlP->value.s);
    strAdd(&s, ", \"tenant\": "); strAddJson(&s, ((tenantP != NULL) && (tenantP->type == CorString)) ? tenantP->value.s : "");
    strAdd(&s, ", \"tenants\": [");
    bool tFirst = true;
    for (CorNode* tP = ((tenantsP != NULL) && (tenantsP->type == CorArray)) ? tenantsP->value.head : NULL; tP != NULL; tP = tP->next)
    {
      if (tP->type != CorString)
        continue;
      strAdd(&s, tFirst ? "" : ", ");
      strAddJson(&s, tP->value.s);
      tFirst = false;
    }
    strAdd(&s, "], \"typeColours\": {");

    CorNode* connP    = (bP->type == CorObject) ? corTreeLookup(bP, "connect") : NULL;
    CorNode* coloursP = ((connP != NULL) && (connP->type == CorObject)) ? corTreeLookup(connP, "typeColours") : NULL;
    bool     cFirst   = true;
    for (CorNode* cP = ((coloursP != NULL) && (coloursP->type == CorObject)) ? coloursP->value.head : NULL; cP != NULL; cP = cP->next)
    {
      if ((cP->type != CorString) || (cP->name == NULL))
        continue;
      strAdd(&s, cFirst ? "" : ", ");
      strAddJson(&s, cP->name);
      strAdd(&s, ": ");
      strAddJson(&s, cP->value.s);
      cFirst = false;
    }
    strAdd(&s, "}}");
    first = false;
  }
  strAdd(&s, "]");

  corAllocBufferReset(&alloc, false);
  respondStr(connP, 200, &s);
}

//
// dashboardThread - start: the three services, then WireCloud made ready for c3 (the first time: populate and
// the user admin), and logged in once to see it is
//
static void* dashboardThread(void* vP)
{
  (void) vP;
  char err[1024] = "";
  char out[1024];

  logLine(dash.logPath, "start the Dashboard");

  //
  // WireCloud's image: no published one yet - the one built from its source
  //
  dashDoing("checking WireCloud's image");
  if (engineRun(out, sizeof(out), 30, "image", "inspect", "--format", "{{.Id}}", kinds[KIND_WIRECLOUD].image, NULL) != 0)
  {
    snprintf(err, sizeof(err), "the image %s is not here - WireCloud 2 has no published image yet: build it from its source (github.com/Ficodes/WireCloud, docker/README.md)", kinds[KIND_WIRECLOUD].image);
    goto fail;
  }

  int port   = -1;
  int esPort = -1;
  for (int ix = 0; ix < DASH_KINDS; ix++)
  {
    dashDoing("starting %s", kinds[dashKinds[ix]].label);
    port = svcEnsure(DASHBOARD_SET, dashKinds[ix], dash.logPath, err, sizeof(err));
    if (port <= 0)
      goto fail;
    if (dashKinds[ix] == KIND_ELASTICSEARCH)
      esPort = port;
  }

  //
  // Logged in already works: it was made ready before
  //
  dashDoing("logging in to WireCloud");
  char lerr[512];
  int  status = dashLogin(port, NULL, lerr, sizeof(lerr));
  if (status != 302)
  {
    if (status != 200)
    {
      snprintf(err, sizeof(err), "%s", lerr);
      goto fail;
    }

    //
    // A user admin with another password (set outside this c3: another c3's, by hand): not a first start - the
    // Dashboard's Reset admin's password (POST /api/run/dashboard/reset-password) makes it c3's
    //
    if (dashAdmin(NULL) == 0)
    {
      pthread_mutex_lock(&rMutex);
      dash.loginFailed = true;
      pthread_mutex_unlock(&rMutex);
      snprintf(err, sizeof(err), "WireCloud's user " DASHBOARD_USER " does not take c3's password - it was set outside this c3 (another c3, or by hand); Reset admin's password makes it c3's");
      goto fail;
    }

    //
    // The first start (or its data deleted): its widgets, its user
    //
    dashSteps(2);
    char password[65];
    if (credsDashboard(password, sizeof(password), NULL, 0, NULL, 0, err, sizeof(err)) == false)
      goto fail;

    dashDoing("first start: installing WireCloud's widgets and operators (populate)");
    const char* populate[] = { "python", "-m", "manage", "populate", NULL };
    if (dashExec(NULL, 900, populate) != 0)
    {
      memset(password, 0, sizeof(password));
      snprintf(err, sizeof(err), "WireCloud's populate failed - the log says why");
      goto fail;
    }

    dashDoing("first start: making WireCloud's user " DASHBOARD_USER " (its password: c3's, in secrets.json)");
    const char* superuser[] = { "sh", "-c", "exec python -m manage createsuperuser --username " DASHBOARD_USER " --email " DASHBOARD_USER "@localhost --password \"$C3_PASSWORD\"", NULL };
    int made = dashExec(password, 120, superuser);
    memset(password, 0, sizeof(password));
    if (made != 0)
    {
      snprintf(err, sizeof(err), "WireCloud's createsuperuser failed - the log says why");
      goto fail;
    }

    if (dashLogin(port, NULL, lerr, sizeof(lerr)) != 302)
    {
      snprintf(err, sizeof(err), "%s - when WireCloud's user " DASHBOARD_USER " was made outside c3, delete the Dashboard's data (its MongoDB volume) and start it again", lerr);
      goto fail;
    }
  }

  //
  // WireCloud's search indexes: populate does not make them, and without them its search answers 500 (the
  // Workspace Browser: "Invalid response from server") - made when Elasticsearch has none (the first start,
  // or its volume deleted)
  //
  if (localHttp(esPort, "GET", "/workspaces", NULL, NULL, 10) == 404)
  {
    dashSteps(1);
    dashDoing("making WireCloud's search indexes (rebuildsearchindexes)");
    const char* rebuild[] = { "python", "-m", "manage", "rebuildsearchindexes", NULL };
    if (dashExec(NULL, 300, rebuild) != 0)
    {
      snprintf(err, sizeof(err), "WireCloud's rebuildsearchindexes failed - the log says why");
      goto fail;
    }
  }

  dashDoing("checking c3's widgets in WireCloud");
  if (dashWidgets(port, err, sizeof(err)) == false)
    goto fail;

  logLine(dash.logPath, "the Dashboard runs: WireCloud on 127.0.0.1:%d, logged in as " DASHBOARD_USER, port);
  pthread_mutex_lock(&rMutex);
  dashStepsEnd(false);
  dash.busy     = false;
  dash.doing[0] = 0;
  dash.why[0]   = 0;
  pthread_mutex_unlock(&rMutex);
  return NULL;

 fail:
  logLine(dash.logPath, "the Dashboard did not start: %s", err);
  pthread_mutex_lock(&rMutex);
  dashStepsEnd(true);
  dash.busy     = false;
  dash.doing[0] = 0;
  snprintf(dash.why, sizeof(dash.why), "%s", err);
  pthread_mutex_unlock(&rMutex);
  return NULL;
}

//
// dashboardStopThread - WireCloud first, then what it stores in; the volumes kept
//
static void* dashboardStopThread(void* vP)
{
  (void) vP;

  logLine(dash.logPath, "stop the Dashboard");
  for (int ix = DASH_KINDS - 1; ix >= 0; ix--)
  {
    char name[96];
    svcName(DASHBOARD_SET, dashKinds[ix], name, sizeof(name));
    dashDoing("stopping %s", kinds[dashKinds[ix]].label);
    svcStop(name, "the Dashboard stopped");
  }

  pthread_mutex_lock(&rMutex);
  dashStepsEnd(false);
  dash.busy     = false;
  dash.doing[0] = 0;
  pthread_mutex_unlock(&rMutex);
  logLine(dash.logPath, "the Dashboard stopped - its data kept");
  return NULL;
}

//
// dashboardResetThread - POST /api/run/dashboard/reset-password: WireCloud's user admin gets c3's password (secrets.json)
// - for an admin whose password was set outside this c3. Its workspaces and everything else kept.
//
static void* dashboardResetThread(void* vP)
{
  Job* jP   = (Job*) vP;
  int  port = dashPort();
  char err[512];

  if (port <= 0)
  {
    jobError(jP, 409, "The Dashboard does not run", "start it first");
    return NULL;
  }

  char password[65];
  if (credsDashboard(password, sizeof(password), NULL, 0, NULL, 0, err, sizeof(err)) == false)
  {
    jobError(jP, 500, "c3's password for WireCloud", err);
    return NULL;
  }
  logLine(dash.logPath, "resetting the password of WireCloud's user " DASHBOARD_USER " to c3's");
  int r = dashAdmin(password);
  memset(password, 0, sizeof(password));
  if (r == 1)
  {
    jobError(jP, 404, "No user " DASHBOARD_USER " in WireCloud", "the Dashboard's Stop and Start makes it");
    return NULL;
  }
  if (r != 0)
  {
    jobError(jP, 502, "The password was not reset", "WireCloud's container did not run the reset - the Dashboard's log says why");
    return NULL;
  }

  int status = dashLogin(port, NULL, err, sizeof(err));
  pthread_mutex_lock(&rMutex);
  dash.loginFailed = (status != 302);
  pthread_mutex_unlock(&rMutex);
  if (status != 302)
  {
    jobError(jP, 502, "Reset, but WireCloud's login still fails", err);
    return NULL;
  }
  logLine(dash.logPath, "WireCloud's user " DASHBOARD_USER " has c3's password");

  Str s = { NULL, 0, 0 };
  strAdd(&s, "{\"user\": \"" DASHBOARD_USER "\"}");
  jobAnswer(jP, 200, &s);
  return NULL;
}

//
// dashboardLoginThread - POST /api/run/dashboard/login: WireCloud's session cookies on c3's answer, its port
//
static void* dashboardLoginThread(void* vP)
{
  Job* jP   = (Job*) vP;
  int  port = dashPort();
  char err[512];

  if (port <= 0)
  {
    jobError(jP, 409, "The Dashboard does not run", "start it first");
    return NULL;
  }

  Str cookies = { NULL, 0, 0 };
  int status  = dashLogin(port, &cookies, err, sizeof(err));
  pthread_mutex_lock(&rMutex);
  dash.loginFailed = (status == 200);            // its password not c3's: the page offers Reset admin's password
  pthread_mutex_unlock(&rMutex);
  if (status != 302)
  {
    strFree(&cookies);
    jobError(jP, 502, "WireCloud's login failed", err);
    return NULL;
  }

  //
  // Each Set-Cookie as WireCloud set it - copied into the connection's memory, which outlives the answer
  //
  char* save = NULL;
  for (char* line = strtok_r(cookies.s, "\n", &save); line != NULL; line = strtok_r(NULL, "\n", &save))
    corHttpResponseHeader(jP->connP, "Set-Cookie", corAllocStrdup(&jP->connP->alloc, line));
  memset(cookies.s, 0, cookies.len);
  strFree(&cookies);

  //
  // c3's port for c3's widgets in WireCloud: a cookie of this host, so they read it on WireCloud's origin (not
  // HttpOnly - their script reads it; nothing secret in it)
  //
  char portCookie[96];
  snprintf(portCookie, sizeof(portCookie), "c3_port=%d; Path=/; SameSite=Lax", c3Port);
  corHttpResponseHeader(jP->connP, "Set-Cookie", corAllocStrdup(&jP->connP->alloc, portCookie));

  Str s = { NULL, 0, 0 };
  strAddf(&s, "{\"port\": %d, \"user\": \"" DASHBOARD_USER "\"}", port);
  jobAnswer(jP, 200, &s);
  return NULL;
}

//
// dashboardState - GET /api/run/dashboard
//
static void dashboardState(CorHttpConn* connP)
{
  Str s = { NULL, 0, 0 };

  pthread_mutex_lock(&rMutex);

  strAdd(&s, "{\"engine\": ");     strAddJson(&s, (engine[0] != 0) ? engineName : NULL);
  strAdd(&s, ", \"engineWhy\": "); strAddJson(&s, (engine[0] == 0) ? engineWhy : NULL);
  strAdd(&s, ", \"image\": ");     strAddJson(&s, kinds[KIND_WIRECLOUD].image);
  strAddf(&s, ", \"busy\": %s", dash.busy ? "true" : "false");
  strAdd(&s, ", \"doing\": ");     strAddJson(&s, (dash.doing[0] != 0) ? dash.doing : NULL);
  strAdd(&s, ", \"why\": ");       strAddJson(&s, (dash.why[0] != 0) ? dash.why : NULL);
  strAddf(&s, ", \"loginFailed\": %s", dash.loginFailed ? "true" : "false");

  //
  // The last start's or stop's steps: each one's text, its seconds (so far, while it runs), done or failed
  //
  time_t now = time(NULL);
  strAdd(&s, ", \"steps\": {\"of\": ");     strAddJson(&s, dash.stepsOfStart ? "start" : "stop");
  strAddf(&s, ", \"total\": %d, \"list\": [", dash.total);
  for (int ix = 0; ix < dash.nSteps; ix++)
  {
    DashStep* stP = &dash.steps[ix];
    strAdd(&s, (ix > 0) ? ", {\"text\": " : "{\"text\": ");
    strAddJson(&s, stP->text);
    strAddf(&s, ", \"seconds\": %ld, \"done\": %s, \"failed\": %s}", (long) (((stP->end != 0) ? stP->end : now) - stP->start),
            (stP->end != 0) ? "true" : "false", stP->failed ? "true" : "false");
  }
  strAdd(&s, "]}");
  strAdd(&s, ", \"log\": ");       strAddJson(&s, dash.logPath);
  strAddf(&s, ", \"widgetsWrite\": %s", configDashboardWrites() ? "true" : "false");

  int  running = 0;
  int  port    = 0;
  strAdd(&s, ", \"services\": [");
  for (int ix = 0; ix < DASH_KINDS; ix++)
  {
    Service* sP = svcGet(DASHBOARD_SET, dashKinds[ix]);
    if (sP == NULL)
      continue;
    strAdd(&s, (ix > 0) ? ", " : "");
    svcRender(sP, &s);
    if ((strcmp(sP->state, "running") == 0) && (sP->busy == false))
      ++running;
    if (dashKinds[ix] == KIND_WIRECLOUD)
      port = sP->hostPort;
  }
  strAdd(&s, "]");

  //
  // busy: a start or a stop runs; failed: the last start did (why says why) - its containers may run;
  // running: all three; stopped: none of them; else partly
  //
  const char* state = dash.busy ? "busy" : (dash.why[0] != 0) ? "failed" : (running == DASH_KINDS) ? "running" : (running == 0) ? "stopped" : "partly";
  strAdd(&s, ", \"state\": ");     strAddJson(&s, state);
  if ((strcmp(state, "running") == 0) && (port > 0)) strAddf(&s, ", \"port\": %d", port);
  else                                                strAdd(&s, ", \"port\": null");
  strAdd(&s, "}");

  pthread_mutex_unlock(&rMutex);
  respondStr(connP, 200, &s);
}

//
// dashboardRequest - /api/run/dashboard[/<action>]
//
static void dashboardRequest(CorHttpConn* connP, const char* action)
{
  const char* method = connP->method.s;
  bool        get    = (strcmp(method, "GET") == 0);
  bool        post   = (strcmp(method, "POST") == 0);

  if (action[0] == 0)
  {
    if (get) dashboardState(connP); else serveError(connP, 405, "Method not allowed", "/api/run/dashboard");
    return;
  }

  if (get && (strcmp(action, "log") == 0))
  {
    pthread_mutex_lock(&rMutex);
    logFollow(connP, dash.logPath, &dash.logEnd, &dash.subs, &dash.lastBeat);   // unlocks
    return;
  }

  if (post && (strcmp(action, "login") == 0))
  {
    jobStart(connP, dashboardLoginThread, NULL);
    return;
  }

  if (post && (strcmp(action, "reset-password") == 0))
  {
    jobStart(connP, dashboardResetThread, NULL);
    return;
  }

  if (get && (strcmp(action, "brokers") == 0))
  {
    dashboardBrokers(connP);
    return;
  }

  if (get && (strcmp(action, "maps") == 0))
  {
    mapsDashboard(connP);
    return;
  }

  if (post && ((strcmp(action, "start") == 0) || (strcmp(action, "stop") == 0)))
  {
    bool start = (strcmp(action, "start") == 0);

    if (engine[0] == 0)
    {
      serveError(connP, 409, "No container engine", engineWhy);
      return;
    }

    pthread_mutex_lock(&rMutex);
    if (dash.busy)
    {
      pthread_mutex_unlock(&rMutex);
      serveError(connP, 409, "Busy", "a start or a stop of the Dashboard runs");
      return;
    }
    dash.busy = true;
    dash.why[0] = 0;
    dash.loginFailed = false;
    snprintf(dash.doing, sizeof(dash.doing), "%s", start ? "starting" : "stopping");
    dash.stepsOfStart = start;
    dash.nSteps       = 0;
    dash.total        = start ? 6 : DASH_KINDS;     // start: the image, the three services, the login, the widgets
    pthread_mutex_unlock(&rMutex);

    if (threadStart(start ? dashboardThread : dashboardStopThread, NULL) == false)
    {
      pthread_mutex_lock(&rMutex);
      dash.busy     = false;
      dash.doing[0] = 0;
      pthread_mutex_unlock(&rMutex);
      serveError(connP, 500, "No thread", "no thread for the Dashboard");
      return;
    }
    serveJson(connP, 202, "{}");
    return;
  }

  serveError(connP, 405, "Method not allowed", action);
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
  if (strcmp(path, "/api/run/external/log") == 0)
  {
    if (get) externalLog(connP); else serveError(connP, 405, "Method not allowed", path);
    return;
  }
  if (strcmp(path, "/api/run/sources") == 0)
  {
    if (get) runSources(connP); else serveError(connP, 405, "Method not allowed", path);
    return;
  }
  if (strcmp(path, "/api/run/image") == 0)
  {
    const char* q   = (connP->query.s != NULL) ? connP->query.s : "";
    const char* r   = strstr(q, "ref=");
    char        ref[128] = "";

    if (r != NULL)
    {
      int len = strcspn(r + 4, "&");
      snprintf(ref, sizeof(ref), "%.*s", (len < 127) ? len : 127, r + 4);
      urlDecodeInPlace(ref);
    }
    if (!get)                                          serveError(connP, 405, "Method not allowed", path);
    else if ((ref[0] == 0) || (ref[0] == '-') || (strpbrk(ref, " \t\n'\"") != NULL))  serveError(connP, 400, "Bad request", "?ref=<image> - an image's name");
    else                                               jobStart(connP, imageThread, ref);
    return;
  }
  if (strcmp(path, "/api/run/options") == 0)
  {
    const char* p[4] = { corHttpUriParam(connP, "from"), corHttpUriParam(connP, "src"), corHttpUriParam(connP, "database"), corHttpUriParam(connP, "troe") };
    char        v[4][128];
    bool        bad = !get;

    for (int ix = 0; ix < 4; ix++)
    {
      snprintf(v[ix], sizeof(v[ix]), "%s", (p[ix] != NULL) ? p[ix] : "");
      urlDecodeInPlace(v[ix]);
      if ((v[ix][0] == '-') || (strpbrk(v[ix], " \t\n'\"") != NULL)) bad = true;
    }
    if ((v[2][0] == 0) || (v[3][0] == 0)) bad = true;

    if (bad) serveError(connP, get ? 400 : 405, get ? "Bad request" : "Method not allowed", "GET ?from=installed|build|image&src=<build or image>&database=<store>&troe=<history>");
    else
    {
      char arg[520];
      snprintf(arg, sizeof(arg), "%s\t%s\t%s\t%s", v[0], v[1], v[2], v[3]);
      jobStart(connP, optionsThread, arg);
    }
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
  if (strcmp(path, "/api/run/aas/discover") == 0)
  {
    if (post) discoverRequest(connP, aasDiscoverThread); else serveError(connP, 405, "Method not allowed", path);
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
      if ((opcuaPasswordKeep(connP, &d) == true) && (aasAuthorizationKeep(connP, &d) == true))    // the secrets into their files, out of the Def
        brokerStart(connP, &d);
    }
    return;
  }

  if (strcmp(path, "/api/run/dashboard") == 0)
  {
    dashboardRequest(connP, "");
    return;
  }
  if (strncmp(path, "/api/run/dashboard/", 19) == 0)
  {
    dashboardRequest(connP, &path[19]);
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

  if (strcmp(what, "containers") == 0)
  {
    containerRequest(connP, name, action, get, post, path);
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
  snprintf(dash.logPath, sizeof(dash.logPath), "%s/services/c3-dashboard.log", runDir);
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
