//
// FILE            compile.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Compile - builds of the broker, made by coraine-build (the coraine-dev package), run by the backend
//
//   GET    /api/capabilities           what this machine can do: Compile needs coraine-build and its source
//   GET    /api/compile/features       coraine-build --list-features --json: every switch, its default, its
//                                      description, what it requires (cached per source tarball)
//   POST   /api/builds/command         {name?, mode, httpServer?, features, workload?}: the command a build would run,
//                                      without running it
//   POST   /api/builds                 the same body: start the build (202; 409 while one runs)
//   GET    /api/builds                 the builds kept, newest first
//   GET    /api/builds/<name>          one of them
//   GET    /api/builds/<name>/log      Accept: text/event-stream - the output as server-sent events, live
//                                      while it runs (Last-Event-ID: the byte of the log to go on from);
//                                      otherwise the log file (Range taken)
//   DELETE /api/builds/<name>          cancel the build that runs (SIGTERM to its process group, SIGKILL
//                                      5 s later), or delete a finished one: its directory, log and record
//
// Where the builds live: $XDG_DATA_HOME/c3/builds (else ~/.local/share/c3/builds) -
//
//   <name>/        coraine-build's <dir>: the source, the build, and install/ - the result
//   <name>.json    the build's record (c3-build.json): the options, the command, the state, the phases, the
//                  start and end, the exit status, the size of install/, the built broker's --version
//   <name>.log     everything coraine-build wrote, stdout and stderr
//
// The record and the log are BESIDE the directory, not in it: coraine-build takes a new or empty
// directory (or one it unpacked into before), and anything of c3's in it first would make it refuse.
//
// One build at a time. coraine-build runs as a child in a process group of its own, its output to a pipe;
// a thread of the build reads the pipe, appends to the log, counts the lines, notes the phases
// ("coraine-build: phase <name>"), and writes every complete line to the pages following the log (a
// corHttp stream each). The state is under one mutex: the HTTP loop's thread and the build's thread both
// touch it.
//
// When the script has exited, whatever is left of its process group is stopped too (SIGTERM, then
// SIGKILL): no make or gcc outlives a build, also a cancelled one.
//
#define _GNU_SOURCE                              // pipe2, nftw

#include <dirent.h>                              // opendir, readdir
#include <errno.h>                               // errno
#include <fcntl.h>                               // open, O_*
#include <ftw.h>                                 // nftw
#include <poll.h>                                // poll
#include <pthread.h>                             // pthread_*
#include <signal.h>                              // kill, SIGTERM, SIGKILL, sigaction
#include <stdio.h>                               // snprintf
#include <stdlib.h>                              // malloc, realloc, free, getenv, qsort
#include <string.h>                              // strcmp, strncmp, strlen, memcpy
#include <sys/stat.h>                            // stat, mkdir
#include <sys/utsname.h>                         // uname
#include <sys/wait.h>                            // waitpid
#include <time.h>                                // time, gmtime_r
#include <unistd.h>                              // fork, execv, pipe2, read, write, close, access

#include "corAlloc/corAlloc.h"                   // corAlloc
#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup
#include "corAlloc/corAllocBufferInit.h"         // corAllocBufferInit
#include "corAlloc/corAllocBufferReset.h"        // corAllocBufferReset
#include "corJson/CorJson.h"                     // CorJson
#include "corJson/corJsonCreate.h"               // corJsonCreate
#include "corJson/corJsonParse.h"                // corJsonParse
#include "corTree/CorNode.h"                     // CorNode
#include "corTree/corTreeLookup.h"               // corTreeLookup

#include "c3.h"

extern char** environ;



// -----------------------------------------------------------------------------
//
// The command line's (c3.c): --coraine-build, --source
//
char* c3CoraineBuild = NULL;
char* c3Source       = NULL;

#define SOURCE_DEFAULT      "/usr/share/coraine/src/coraine-src.tar.xz"     // coraine-build's own default
#define CANCEL_GRACE_S      5                    // SIGTERM to SIGKILL
#define LINE_MAX_BYTES      (64 * 1024)          // a "line" longer than this is cut into several
#define PHASES_MAX          16



// -----------------------------------------------------------------------------
//
// Caps - what this machine has for Compile, looked for at every request (a few stat calls)
//
typedef struct Caps
{
  bool  available;
  char  why[256];
  char  coraineBuild[2048];
  char  source[2048];
  bool  sourceGiven;                             // --source: passed on to coraine-build
  char  version[128];
  bool  pgo;
  char  pgoWhy[128];
  bool  mongoc;
  char  mongocWhy[160];
} Caps;

static pthread_mutex_t capsMutex = PTHREAD_MUTEX_INITIALIZER;
static char            versionOf[2048];          // the tarball the cached version is of ...
static time_t          versionMtime;             // ... as it was then
static char            versionCached[128];

//
// sourceVersion - the version in the tarball's SOURCE file (version=...), cached per tarball
//
static void sourceVersion(const char* source, char* out, int outLen)
{
  struct stat st;

  out[0] = 0;
  if (stat(source, &st) != 0)
    return;

  pthread_mutex_lock(&capsMutex);
  if ((strcmp(versionOf, source) == 0) && (versionMtime == st.st_mtime))
  {
    snprintf(out, outLen, "%s", versionCached);
    pthread_mutex_unlock(&capsMutex);
    return;
  }
  pthread_mutex_unlock(&capsMutex);

  char  text[4096];
  char* argv[] = { (char*) "tar", (char*) "-xJf", (char*) source, (char*) "--wildcards", (char*) "*/SOURCE", (char*) "-O", (char*) "--occurrence=1", NULL };

  runCapture(argv, text, sizeof(text), 30);

  char* v = strstr(text, "version=");
  if (v != NULL)
  {
    v += 8;
    int len = strcspn(v, "\r\n");
    snprintf(out, outLen, "%.*s", len, v);
  }

  pthread_mutex_lock(&capsMutex);
  snprintf(versionOf, sizeof(versionOf), "%s", source);
  snprintf(versionCached, sizeof(versionCached), "%s", out);
  versionMtime = st.st_mtime;
  pthread_mutex_unlock(&capsMutex);
}

static void capsFind(Caps* cP, bool withVersion)
{
  struct stat st;

  memset(cP, 0, sizeof(*cP));

  if (c3CoraineBuild != NULL)
  {
    char* real = realpath(c3CoraineBuild, NULL);
    snprintf(cP->coraineBuild, sizeof(cP->coraineBuild), "%s", (real != NULL) ? real : c3CoraineBuild);
    free(real);

    if ((stat(cP->coraineBuild, &st) != 0) || !S_ISREG(st.st_mode) || (access(cP->coraineBuild, X_OK) != 0))
    {
      snprintf(cP->why, sizeof(cP->why), "--coraine-build %s: not an executable file", c3CoraineBuild);
      cP->coraineBuild[0] = 0;
    }
  }
  else if (inPath("coraine-build", cP->coraineBuild, sizeof(cP->coraineBuild)) == false)
    snprintf(cP->why, sizeof(cP->why), "install coraine-dev to build brokers");

  if (c3Source != NULL)
  {
    char* real = realpath(c3Source, NULL);
    snprintf(cP->source, sizeof(cP->source), "%s", (real != NULL) ? real : c3Source);
    free(real);
    cP->sourceGiven = true;
  }
  else
    snprintf(cP->source, sizeof(cP->source), "%s", SOURCE_DEFAULT);

  if ((cP->why[0] == 0) && ((stat(cP->source, &st) != 0) || !S_ISREG(st.st_mode)))
    snprintf(cP->why, sizeof(cP->why), "no coraine source at %s - %s", cP->source, cP->sourceGiven ? "--source names another" : "reinstall coraine-dev");

  cP->available = (cP->why[0] == 0);

  if (cP->available && withVersion)
    sourceVersion(cP->source, cP->version, sizeof(cP->version));

  //
  // --pgo and --tune train the broker: coraine-build needs curl, wrk and python3 for that
  //
  char        found[2048];
  const char* tools[] = { "curl", "wrk", "python3" };

  cP->pgo = true;
  for (unsigned int ix = 0; ix < sizeof(tools) / sizeof(tools[0]); ix++)
  {
    if (inPath(tools[ix], found, sizeof(found)) == false)
    {
      cP->pgo = false;
      snprintf(cP->pgoWhy, sizeof(cP->pgoWhy), "training needs %s - install it", tools[ix]);
      break;
    }
  }

  //
  // The mongoc plugin needs the mongo-c driver v2: the distribution's, or the one coraine-dev bundles
  //
  char  out[256];
  char* argv[] = { (char*) "pkg-config", (char*) "--exists", (char*) "mongoc2", NULL };

  cP->mongoc = (stat("/opt/seamware/lib/pkgconfig/mongoc2.pc", &st) == 0) || (runCapture(argv, out, sizeof(out), 5) == 0);
  if (cP->mongoc == false)
    snprintf(cP->mongocWhy, sizeof(cP->mongocWhy), "needs the mongo-c driver v2 (pkg-config mongoc2) - install it, or build without it");
}



// -----------------------------------------------------------------------------
//
// buildsDir - $XDG_DATA_HOME/c3/builds, else ~/.local/share/c3/builds
//
static char buildsDir[2048];



// -----------------------------------------------------------------------------
//
// Phase - a "coraine-build: phase <name>" line: when, and at which line of the output
//
typedef struct Phase
{
  char    name[24];
  time_t  at;
  long    line;
} Phase;



// -----------------------------------------------------------------------------
//
// Build - the build that runs (one at a time); under bMutex
//
typedef struct Build
{
  char            name[65];
  char            mode[16];
  char            httpServer[16];                // mhd, builtin
  char            workload[2048];
  char*           featuresJson;                  // the features asked for, as JSON ({"REGISTRATIONS": false})
  char*           command;                       // as shown: shell-quoted
  char*           argv[16];
  char            dir[2300];
  char            logPath[2300];
  char            jsonPath[2300];

  char            state[16];                     // running, succeeded, failed, cancelled
  char            error[512];
  Phase           phases[PHASES_MAX];
  int             nPhases;
  int             exitStatus;                    // -1: none (yet), or killed
  int             termSignal;                    // 0: none
  time_t          started;
  time_t          ended;
  long            lines;
  int64_t         logEnd;                        // the log's bytes up to the end of its last complete line
  int64_t         installBytes;
  int64_t         binaryBytes;
  char*           brokerVersion;                 // install/bin/coraine --version

  pid_t           pid;                           // coraine-build - and its process group
  int             pipeFd;
  int             logFd;
  bool            cancel;
  time_t          cancelAt;
  bool            killed;

  char*           part;                          // the output after its last newline
  int             partLen;

  SseSubs         subs;                          // the pages following the log
  pthread_t       thread;
} Build;

static pthread_mutex_t bMutex = PTHREAD_MUTEX_INITIALIZER;
static Build*          cur    = NULL;            // the build that runs; NULL: none



// -----------------------------------------------------------------------------
//
// featuresFromVersion - the "features: A=1 B=0 ..." line of `coraine --version`, as a JSON object
//
static void featuresFromVersion(Str* sP, const char* version)
{
  const char* f = (version != NULL) ? strstr(version, "features: ") : NULL;

  if (f == NULL)
  {
    strAdd(sP, "null");
    return;
  }

  f += 10;
  strAdd(sP, "{");

  bool first = true;
  while ((*f != 0) && (*f != '\n'))
  {
    while (*f == ' ')
      ++f;

    const char* eq = strchr(f, '=');
    if ((eq == NULL) || (eq[1] == 0))
      break;

    int nameLen = eq - f;
    strAddf(sP, "%s\"%.*s\": %s", first ? "" : ", ", nameLen, f, (eq[1] == '1') ? "true" : "false");
    first = false;

    f = eq + 2;
    while ((*f != 0) && (*f != ' ') && (*f != '\n'))
      ++f;
  }

  strAdd(sP, "}");
}



// -----------------------------------------------------------------------------
//
// buildRender - a build's record, as JSON
//
static void buildRender(Build* bP, Str* sP)
{
  char t[32];

  strAdd(sP, "{\"name\": ");          strAddJson(sP, bP->name);
  strAdd(sP, ", \"state\": ");        strAddJson(sP, bP->state);
  strAdd(sP, ", \"mode\": ");         strAddJson(sP, bP->mode);
  strAdd(sP, ", \"httpServer\": ");   strAddJson(sP, bP->httpServer);
  strAdd(sP, ", \"features\": ");     strAdd(sP, (bP->featuresJson != NULL) ? bP->featuresJson : "{}");
  strAdd(sP, ", \"workload\": ");     strAddJson(sP, (bP->workload[0] != 0) ? bP->workload : NULL);
  strAdd(sP, ", \"command\": ");      strAddJson(sP, bP->command);
  strAdd(sP, ", \"dir\": ");          strAddJson(sP, bP->dir);
  strAddf(sP, ", \"install\": ");
  {
    char install[2400];
    snprintf(install, sizeof(install), "%s/install", bP->dir);
    strAddJson(sP, install);
  }
  strAdd(sP, ", \"log\": ");          strAddJson(sP, bP->logPath);
  strAdd(sP, ", \"phase\": ");        strAddJson(sP, (bP->nPhases > 0) ? bP->phases[bP->nPhases - 1].name : "unpack");
  strAdd(sP, ", \"phases\": [");
  for (int ix = 0; ix < bP->nPhases; ix++)
  {
    isoTime(bP->phases[ix].at, t, sizeof(t));
    strAddf(sP, "%s{\"name\": \"%s\", \"at\": \"%s\", \"line\": %ld}", (ix > 0) ? ", " : "", bP->phases[ix].name, t, bP->phases[ix].line);
  }
  strAdd(sP, "]");
  strAddf(sP, ", \"lines\": %ld", bP->lines);

  isoTime(bP->started, t, sizeof(t));
  strAddf(sP, ", \"started\": \"%s\"", t);
  if (bP->ended != 0)
  {
    isoTime(bP->ended, t, sizeof(t));
    strAddf(sP, ", \"ended\": \"%s\", \"seconds\": %ld", t, (long) (bP->ended - bP->started));
  }
  else
    strAddf(sP, ", \"ended\": null, \"seconds\": %ld", (long) (time(NULL) - bP->started));

  if (bP->exitStatus >= 0)  strAddf(sP, ", \"exitStatus\": %d", bP->exitStatus);
  else                      strAdd(sP, ", \"exitStatus\": null");
  if (bP->termSignal > 0)   strAddf(sP, ", \"signal\": %d", bP->termSignal);
  else                      strAdd(sP, ", \"signal\": null");

  if (bP->installBytes > 0) strAddf(sP, ", \"installBytes\": %lld, \"binaryBytes\": %lld", (long long) bP->installBytes, (long long) bP->binaryBytes);
  else                      strAdd(sP, ", \"installBytes\": null, \"binaryBytes\": null");

  strAdd(sP, ", \"version\": ");      strAddJson(sP, bP->brokerVersion);
  strAdd(sP, ", \"builtFeatures\": "); featuresFromVersion(sP, bP->brokerVersion);
  strAdd(sP, ", \"error\": ");        strAddJson(sP, (bP->error[0] != 0) ? bP->error : NULL);
  strAdd(sP, "}");
}



// -----------------------------------------------------------------------------
//
// buildSave - the record to <name>.json (temporary file + rename)
//
static void buildSave(Build* bP)
{
  Str  s = { NULL, 0, 0 };
  char tmp[2400];

  buildRender(bP, &s);
  strAdd(&s, "\n");

  snprintf(tmp, sizeof(tmp), "%s.tmp", bP->jsonPath);
  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd != -1)
  {
    bool ok = (write(fd, s.s, s.len) == s.len);
    close(fd);
    if (ok)
      rename(tmp, bP->jsonPath);
    else
      unlink(tmp);
  }

  strFree(&s);
}



// -----------------------------------------------------------------------------
//
// sseEvent - the build's record as an event of its own ("build", "end")
//
static void sseEvent(Str* sP, const char* event, Build* bP)
{
  strAddf(sP, "event: %s\ndata: ", event);
  buildRender(bP, sP);
  strAdd(sP, "\n\n");
}



// -----------------------------------------------------------------------------
//
// outputAdd - what coraine-build wrote: to the log, counted, its phases noted, to the pages (bMutex held)
//
static void outputAdd(Build* bP, const char* data, int len)
{
  ssize_t ignored = write(bP->logFd, data, len);
  (void) ignored;

  bP->part = realloc(bP->part, bP->partLen + len + 1);
  memcpy(&bP->part[bP->partLen], data, len);
  bP->partLen += len;

  //
  // The complete lines: up to the last newline - or all of it, for a line too long to wait for
  //
  int complete = 0;
  for (int ix = bP->partLen - 1; ix >= 0; ix--)
  {
    if (bP->part[ix] == '\n')
    {
      complete = ix + 1;
      break;
    }
  }
  if ((complete == 0) && (bP->partLen >= LINE_MAX_BYTES))
    complete = bP->partLen;

  if (complete == 0)
    return;

  bool phaseNew = false;
  int  start    = 0;

  for (int ix = 0; ix < complete; ix++)
  {
    if ((bP->part[ix] != '\n') && (ix != complete - 1))
      continue;

    const char* line   = &bP->part[start];
    int         lineLen = ix - start;
    const char* marker = "coraine-build: phase ";
    int         mLen    = strlen(marker);

    bP->lines += 1;

    if ((lineLen > mLen) && (strncmp(line, marker, mLen) == 0) && (bP->nPhases < PHASES_MAX))
    {
      Phase* pP = &bP->phases[bP->nPhases++];
      int    n  = lineLen - mLen;

      if (n > (int) sizeof(pP->name) - 1)
        n = sizeof(pP->name) - 1;
      memcpy(pP->name, &line[mLen], n);
      pP->name[n] = 0;
      for (int k = n - 1; (k >= 0) && ((pP->name[k] == '\r') || (pP->name[k] == ' ')); k--)
        pP->name[k] = 0;
      pP->at   = time(NULL);
      pP->line = bP->lines;
      phaseNew = true;
    }

    start = ix + 1;
  }

  bP->logEnd += complete;

  Str s = { NULL, 0, 0 };
  sseLines(&s, bP->part, complete, bP->logEnd);
  if (phaseNew)
  {
    buildSave(bP);
    sseEvent(&s, "build", bP);
  }
  sseSubsSend(&bP->subs, s.s, s.len);
  strFree(&s);

  memmove(bP->part, &bP->part[complete], bP->partLen - complete);
  bP->partLen -= complete;
}



// -----------------------------------------------------------------------------
//
// installSize - the bytes of the files under install/ (nftw has no user pointer: a thread-local sum)
//
static __thread int64_t sizeSum;

static int sizeAdd(const char* path, const struct stat* stP, int flag, struct FTW* ftwP)
{
  (void) path;
  (void) ftwP;

  if (flag == FTW_F)
    sizeSum += stP->st_size;

  return 0;
}

static int64_t dirBytes(const char* dir)
{
  sizeSum = 0;
  nftw(dir, sizeAdd, 16, FTW_PHYS);
  return sizeSum;
}



// -----------------------------------------------------------------------------
//
// buildFinish - the build is over: its state, the result's size and --version, the record, the pages told
//
static void buildFinish(Build* bP, int status)
{
  char  install[2400];
  char  binary[2400];

  snprintf(install, sizeof(install), "%s/install", bP->dir);
  snprintf(binary, sizeof(binary), "%s/install/bin/coraine", bP->dir);

  //
  // Measured outside the mutex: --version starts the broker
  //
  bool    ok      = WIFEXITED(status) && (WEXITSTATUS(status) == 0);
  char*   version = NULL;
  int64_t bytes   = 0;
  int64_t binBytes = 0;

  if (ok)
  {
    char        out[8192];
    char*       argv[] = { binary, (char*) "--version", NULL };
    struct stat st;

    if (runCapture(argv, out, sizeof(out), 30) == 0)
      version = strdup(out);

    bytes = dirBytes(install);
    if (stat(binary, &st) == 0)
      binBytes = st.st_size;
  }

  pthread_mutex_lock(&bMutex);

  if (bP->partLen > 0)                           // a last line with no newline
  {
    bP->lines  += 1;
    bP->logEnd += bP->partLen;

    Str s = { NULL, 0, 0 };
    sseLines(&s, bP->part, bP->partLen, bP->logEnd);
    sseSubsSend(&bP->subs, s.s, s.len);
    strFree(&s);
    bP->partLen = 0;
  }

  bP->ended        = time(NULL);
  bP->exitStatus   = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  bP->termSignal   = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
  bP->brokerVersion = version;
  bP->installBytes = bytes;
  bP->binaryBytes  = binBytes;

  if (bP->cancel)
    snprintf(bP->state, sizeof(bP->state), "cancelled");
  else if (ok)
    snprintf(bP->state, sizeof(bP->state), "succeeded");
  else
  {
    snprintf(bP->state, sizeof(bP->state), "failed");
    if (bP->termSignal > 0)
      snprintf(bP->error, sizeof(bP->error), "coraine-build was killed by signal %d", bP->termSignal);
    else
      snprintf(bP->error, sizeof(bP->error), "coraine-build exited with %d - the log says why", bP->exitStatus);
  }

  buildSave(bP);

  Str s = { NULL, 0, 0 };
  sseEvent(&s, "end", bP);
  sseSubsSend(&bP->subs, s.s, s.len);
  strFree(&s);

  sseSubsEnd(&bP->subs);

  close(bP->logFd);
  close(bP->pipeFd);
  cur = NULL;

  pthread_mutex_unlock(&bMutex);
}

static void buildFree(Build* bP)
{
  free(bP->featuresJson);
  free(bP->command);
  for (int ix = 0; bP->argv[ix] != NULL; ix++)
    free(bP->argv[ix]);
  free(bP->brokerVersion);
  free(bP->part);
  free(bP);
}



// -----------------------------------------------------------------------------
//
// buildThread - the build's own thread: the output read, the cancel enforced, the end
//
static void* buildThread(void* vP)
{
  Build*  bP       = (Build*) vP;
  char    buf[65536];
  bool    eof      = false;
  bool    exited   = false;
  int     status   = 0;
  time_t  exitedAt = 0;
  time_t  lastBeat = time(NULL);

  while ((eof == false) || (exited == false))
  {
    if (eof == false)
    {
      struct pollfd pfd = { bP->pipeFd, POLLIN, 0 };

      if (poll(&pfd, 1, 500) > 0)
      {
        ssize_t n = read(bP->pipeFd, buf, sizeof(buf));

        if (n > 0)
        {
          pthread_mutex_lock(&bMutex);
          outputAdd(bP, buf, n);
          pthread_mutex_unlock(&bMutex);
        }
        else if ((n == 0) || ((errno != EINTR) && (errno != EAGAIN)))
          eof = true;
      }
    }
    else
      usleep(100 * 1000);

    time_t now = time(NULL);

    if (exited == false)
    {
      pid_t w = waitpid(bP->pid, &status, WNOHANG);
      if (w == bP->pid)
      {
        exited   = true;
        exitedAt = now;
      }
    }
    else if ((eof == false) && (now - exitedAt >= 2))
    {
      //
      // The script is gone and something it started still holds the pipe: stopped with the rest
      //
      groupStop(bP->pid);
      if (now - exitedAt >= 6)
        eof = true;
    }

    pthread_mutex_lock(&bMutex);
    if ((bP->cancel == true) && (bP->killed == false) && (now - bP->cancelAt >= CANCEL_GRACE_S))
    {
      kill(-bP->pid, SIGKILL);
      bP->killed = true;
    }
    if (now - lastBeat >= 15)
    {
      sseSubsSend(&bP->subs, ":\n\n", 3);                 // a comment: the page knows the stream is alive
      lastBeat = now;
    }
    pthread_mutex_unlock(&bMutex);
  }

  groupStop(bP->pid);                            // no make, gcc or broker of the build outlives it
  buildFinish(bP, status);
  buildFree(bP);

  return NULL;
}



// -----------------------------------------------------------------------------
//
// nameValid - a build's name: [A-Za-z0-9._-], 1 to 64, starting with a letter or a digit
//
static bool nameValid(const char* name)
{
  int len = strlen(name);

  if ((len < 1) || (len > 64))
    return false;

  for (int ix = 0; ix < len; ix++)
  {
    char c = name[ix];
    bool alnum = ((c >= 'a') && (c <= 'z')) || ((c >= 'A') && (c <= 'Z')) || ((c >= '0') && (c <= '9'));

    if ((ix == 0) && !alnum)
      return false;
    if (!alnum && (c != '.') && (c != '_') && (c != '-'))
      return false;
  }

  return true;
}

static bool buildExists(const char* name)
{
  char        path[2300];
  struct stat st;

  snprintf(path, sizeof(path), "%s/%s", buildsDir, name);
  if (lstat(path, &st) == 0)
    return true;
  snprintf(path, sizeof(path), "%s/%s.json", buildsDir, name);
  if (lstat(path, &st) == 0)
    return true;
  snprintf(path, sizeof(path), "%s/%s.log", buildsDir, name);
  return lstat(path, &st) == 0;
}



// -----------------------------------------------------------------------------
//
// Plan - a build as asked for: the body of POST /api/builds (and /api/builds/command), checked
//
typedef struct Plan
{
  char   name[65];
  char   mode[16];
  char   httpServer[16];                         // mhd (coraine-build's default), builtin
  char   workload[2048];
  Str    features;                               // the JSON object, as asked for
  Str    featuresArg;                            // NAME=ON,NAME=OFF
  bool   bridgesGiven;                           // false: coraine-build's default bridges
  char   bridges[256];                           // mqtt,dds - or none
  char*  argv[16];
  int    argc;
  char   dir[2300];
  Str    command;
} Plan;

static void planFree(Plan* pP)
{
  strFree(&pP->features);
  strFree(&pP->featuresArg);
  strFree(&pP->command);
  for (int ix = 0; ix < pP->argc; ix++)
    free(pP->argv[ix]);
  pP->argc = 0;
}

//
// planMake - false with the status and why in errBuf
//
static bool planMake(CorHttpConn* connP, const Caps* cP, Plan* pP, int* statusP, char* errBuf, int errLen)
{
  memset(pP, 0, sizeof(*pP));
  *statusP = 400;

  if (connP->bodyRefused || (connP->body.s == NULL) || (connP->body.len == 0))
  {
    snprintf(errBuf, errLen, "a JSON object is expected as the body");
    return false;
  }

  CorJson json;
  corJsonCreate(&json, &connP->alloc);
  CorNode* bodyP = corJsonParse(&json, corAllocStrdup(&connP->alloc, connP->body.s));

  if ((bodyP == NULL) || (bodyP->type != CorObject))
  {
    snprintf(errBuf, errLen, "the body is not a JSON object");
    return false;
  }

  //
  // mode
  //
  CorNode* modeP = corTreeLookup(bodyP, "mode");
  const char* mode = ((modeP != NULL) && (modeP->type == CorString)) ? modeP->value.s : "release";

  if ((strcmp(mode, "release") != 0) && (strcmp(mode, "debug") != 0) && (strcmp(mode, "pgo") != 0) && (strcmp(mode, "tune") != 0))
  {
    snprintf(errBuf, errLen, "\"mode\" is release, debug, pgo or tune - not '%s'", mode);
    return false;
  }
  snprintf(pP->mode, sizeof(pP->mode), "%s", mode);

  if (((strcmp(mode, "pgo") == 0) || (strcmp(mode, "tune") == 0)) && (cP->pgo == false))
  {
    *statusP = 422;
    snprintf(errBuf, errLen, "--%s: %s", mode, cP->pgoWhy);
    return false;
  }

  //
  // httpServer: mhd (the default) or builtin - not with pgo / tune (coraine-build refuses: its training
  // tools are tried with libmicrohttpd only)
  //
  CorNode*    httpP = corTreeLookup(bodyP, "httpServer");
  const char* http  = ((httpP != NULL) && (httpP->type == CorString)) ? httpP->value.s : "mhd";

  if ((strcmp(http, "mhd") != 0) && (strcmp(http, "builtin") != 0))
  {
    snprintf(errBuf, errLen, "\"httpServer\" is mhd or builtin - not '%s'", http);
    return false;
  }
  if ((strcmp(http, "builtin") == 0) && ((strcmp(mode, "pgo") == 0) || (strcmp(mode, "tune") == 0)))
  {
    *statusP = 422;
    snprintf(errBuf, errLen, "the built-in HTTP server is not built with --%s yet", mode);
    return false;
  }
  snprintf(pP->httpServer, sizeof(pP->httpServer), "%s", http);

  //
  // workload (tune)
  //
  CorNode* workloadP = corTreeLookup(bodyP, "workload");
  if ((workloadP != NULL) && (workloadP->type == CorString) && (workloadP->value.s[0] != 0))
    snprintf(pP->workload, sizeof(pP->workload), "%s", workloadP->value.s);

  if (strcmp(mode, "tune") == 0)
  {
    struct stat st;

    if (pP->workload[0] == 0)
    {
      *statusP = 422;
      snprintf(errBuf, errLen, "--tune needs a workload file (\"workload\")");
      return false;
    }
    if ((pP->workload[0] != '/') || (stat(pP->workload, &st) != 0) || !S_ISREG(st.st_mode))
    {
      *statusP = 422;
      snprintf(errBuf, errLen, "the workload must be an existing file, by its absolute path: %s", pP->workload);
      return false;
    }
  }
  else
    pP->workload[0] = 0;

  //
  // features: {"NAME": true|false}
  //
  CorNode* featuresP = corTreeLookup(bodyP, "features");
  strAdd(&pP->features, "{");
  if (featuresP != NULL)
  {
    if (featuresP->type != CorObject)
    {
      snprintf(errBuf, errLen, "\"features\" is an object: {\"NAME\": true|false}");
      return false;
    }

    for (CorNode* fP = featuresP->value.head; fP != NULL; fP = fP->next)
    {
      const char* name = fP->name;
      bool        ok   = (name != NULL) && (name[0] != 0) && (strlen(name) <= 40) && (fP->type == CorBoolean);

      for (const char* c = name; ok && (*c != 0); ++c)
        ok = ((*c >= 'A') && (*c <= 'Z')) || ((*c >= '0') && (*c <= '9')) || (*c == '_');

      if (!ok)
      {
        snprintf(errBuf, errLen, "\"features\": '%s' - a switch's name (A-Z, 0-9, _) and true or false", (name != NULL) ? name : "");
        return false;
      }

      strAddf(&pP->features, "%s\"%s\": %s", (pP->featuresArg.len > 0) ? ", " : "", name, fP->value.b ? "true" : "false");
      strAddf(&pP->featuresArg, "%s%s=%s", (pP->featuresArg.len > 0) ? "," : "", name, fP->value.b ? "ON" : "OFF");
    }
  }
  strAdd(&pP->features, "}");

  //
  // bridges: ["mqtt", "dds"] - the bridge plugins to build; [] none; absent: coraine-build's default
  //
  CorNode* bridgesP = corTreeLookup(bodyP, "bridges");
  if ((bridgesP != NULL) && (bridgesP->type != CorNull))
  {
    if (bridgesP->type != CorArray)
    {
      snprintf(errBuf, errLen, "\"bridges\" is an array of bridge names: [\"mqtt\", \"dds\"]");
      return false;
    }

    pP->bridgesGiven = true;
    for (CorNode* bP = bridgesP->value.head; bP != NULL; bP = bP->next)
    {
      bool ok = (bP->type == CorString) && (bP->value.s[0] != 0) && (strlen(bP->value.s) <= 20);

      for (const char* c = (ok ? bP->value.s : ""); ok && (*c != 0); ++c)
        ok = ((*c >= 'a') && (*c <= 'z')) || ((*c >= '0') && (*c <= '9'));

      if ((ok == false) || (strlen(pP->bridges) + strlen(bP->value.s) + 2 >= sizeof(pP->bridges)))
      {
        snprintf(errBuf, errLen, "\"bridges\": '%s' - a bridge's name (a-z, 0-9)", (bP->type == CorString) ? bP->value.s : "");
        return false;
      }
      if (pP->bridges[0] != 0)
        strcat(pP->bridges, ",");
      strcat(pP->bridges, bP->value.s);
    }
    if (pP->bridges[0] == 0)
      strcpy(pP->bridges, "none");
  }

  //
  // name
  //
  CorNode* nameP = corTreeLookup(bodyP, "name");
  if ((nameP != NULL) && (nameP->type == CorString) && (nameP->value.s[0] != 0))
  {
    if (nameValid(nameP->value.s) == false)
    {
      snprintf(errBuf, errLen, "a build's name is 1 to 64 of A-Z a-z 0-9 . _ -, starting with a letter or a digit");
      return false;
    }
    snprintf(pP->name, sizeof(pP->name), "%s", nameP->value.s);
  }
  else
  {
    time_t    now = time(NULL);
    struct tm tm;
    char      stamp[32];

    localtime_r(&now, &tm);
    strftime(stamp, sizeof(stamp), "%Y%m%d-%H%M%S", &tm);
    snprintf(pP->name, sizeof(pP->name), "%s-%s", pP->mode, stamp);
  }

  snprintf(pP->dir, sizeof(pP->dir), "%s/%s", buildsDir, pP->name);

  //
  // The command
  //
  char modeArg[24];
  snprintf(modeArg, sizeof(modeArg), "--%s", pP->mode);

  pP->argv[pP->argc++] = strdup(cP->coraineBuild[0] != 0 ? cP->coraineBuild : "coraine-build");
  pP->argv[pP->argc++] = strdup(modeArg);
  if (pP->workload[0] != 0)
    pP->argv[pP->argc++] = strdup(pP->workload);
  if (strcmp(pP->httpServer, "mhd") != 0)            // the default is left out: the command says what is different
  {
    pP->argv[pP->argc++] = strdup("--http-server");
    pP->argv[pP->argc++] = strdup(pP->httpServer);
  }
  if (pP->featuresArg.len > 0)
  {
    pP->argv[pP->argc++] = strdup("--features");
    pP->argv[pP->argc++] = strdup(pP->featuresArg.s);
  }
  if (pP->bridgesGiven)
  {
    pP->argv[pP->argc++] = strdup("--bridges");
    pP->argv[pP->argc++] = strdup(pP->bridges);
  }
  if (cP->sourceGiven)
  {
    pP->argv[pP->argc++] = strdup("--source");
    pP->argv[pP->argc++] = strdup(cP->source);
  }
  pP->argv[pP->argc++] = strdup(pP->dir);
  pP->argv[pP->argc]   = NULL;

  for (int ix = 0; ix < pP->argc; ix++)
  {
    if (ix > 0)
      strAdd(&pP->command, " ");
    shellQuote(&pP->command, pP->argv[ix]);
  }

  return true;
}

static void planRender(Plan* pP, Str* sP)
{
  strAdd(sP, "{\"name\": ");     strAddJson(sP, pP->name);
  strAdd(sP, ", \"mode\": ");    strAddJson(sP, pP->mode);
  strAdd(sP, ", \"httpServer\": "); strAddJson(sP, pP->httpServer);
  strAdd(sP, ", \"features\": "); strAdd(sP, pP->features.s);
  strAdd(sP, ", \"bridges\": ");  strAddJson(sP, pP->bridgesGiven ? pP->bridges : NULL);
  strAdd(sP, ", \"workload\": "); strAddJson(sP, (pP->workload[0] != 0) ? pP->workload : NULL);
  strAdd(sP, ", \"dir\": ");     strAddJson(sP, pP->dir);
  strAdd(sP, ", \"command\": "); strAddJson(sP, pP->command.s);
  strAdd(sP, ", \"argv\": [");
  for (int ix = 0; ix < pP->argc; ix++)
  {
    if (ix > 0)
      strAdd(sP, ", ");
    strAddJson(sP, pP->argv[ix]);
  }
  strAdd(sP, "]}");
}



// -----------------------------------------------------------------------------
//
// buildStart - POST /api/builds
//
static void buildStart(CorHttpConn* connP)
{
  Caps cap;
  Plan plan;
  char err[1024];
  int  status;

  capsFind(&cap, false);
  if (cap.available == false)
  {
    serveError(connP, 503, "Compile is not available", cap.why);
    return;
  }

  if (planMake(connP, &cap, &plan, &status, err, sizeof(err)) == false)
  {
    planFree(&plan);
    serveError(connP, status, "Bad request", err);
    return;
  }

  pthread_mutex_lock(&bMutex);

  if (cur != NULL)
  {
    snprintf(err, sizeof(err), "the build '%s' is running - one at a time", cur->name);
    pthread_mutex_unlock(&bMutex);
    planFree(&plan);
    serveError(connP, 409, "A build is running", err);
    return;
  }

  if (dirsMake(buildsDir) == false)
  {
    snprintf(err, sizeof(err), "cannot make %s: %s", buildsDir, strerror(errno));
    pthread_mutex_unlock(&bMutex);
    planFree(&plan);
    serveError(connP, 500, "No builds directory", err);
    return;
  }

  if (buildExists(plan.name))
  {
    snprintf(err, sizeof(err), "a build named '%s' exists - another name, or delete it", plan.name);
    pthread_mutex_unlock(&bMutex);
    planFree(&plan);
    serveError(connP, 409, "The name is taken", err);
    return;
  }

  Build* bP = (Build*) calloc(1, sizeof(Build));

  snprintf(bP->name, sizeof(bP->name), "%s", plan.name);
  snprintf(bP->mode, sizeof(bP->mode), "%s", plan.mode);
  snprintf(bP->httpServer, sizeof(bP->httpServer), "%s", plan.httpServer);
  snprintf(bP->workload, sizeof(bP->workload), "%s", plan.workload);
  snprintf(bP->dir, sizeof(bP->dir), "%s", plan.dir);
  snprintf(bP->logPath, sizeof(bP->logPath), "%s/%s.log", buildsDir, plan.name);
  snprintf(bP->jsonPath, sizeof(bP->jsonPath), "%s/%s.json", buildsDir, plan.name);
  snprintf(bP->state, sizeof(bP->state), "running");
  bP->featuresJson = strdup(plan.features.s);
  bP->command      = strdup(plan.command.s);
  for (int ix = 0; ix < plan.argc; ix++)
    bP->argv[ix] = strdup(plan.argv[ix]);
  bP->exitStatus = -1;
  bP->started    = time(NULL);
  planFree(&plan);

  int fds[2] = { -1, -1 };
  bP->logFd = open(bP->logPath, O_WRONLY | O_CREAT | O_EXCL | O_APPEND | O_CLOEXEC, 0600);

  if ((bP->logFd == -1) || (pipe2(fds, O_CLOEXEC) != 0))
  {
    snprintf(err, sizeof(err), "cannot make the log %s: %s", bP->logPath, strerror(errno));
    if (bP->logFd != -1)
      close(bP->logFd);
    pthread_mutex_unlock(&bMutex);
    buildFree(bP);
    serveError(connP, 500, "Cannot start the build", err);
    return;
  }

  //
  // The child: a process group of its own (Cancel signals the whole group), SIGTERM if c3 dies, stdout and
  // stderr into the pipe, nothing else of c3's open
  //
  ProcSpawn spawn = { bP->argv, NULL, fds[1], NULL, true, false, SIGTERM };
  pid_t     pid   = procSpawn(&spawn);

  close(fds[1]);

  if (pid < 0)
  {
    snprintf(err, sizeof(err), "fork: %s", strerror(errno));
    close(fds[0]);
    close(bP->logFd);
    unlink(bP->logPath);
    pthread_mutex_unlock(&bMutex);
    buildFree(bP);
    serveError(connP, 500, "Cannot start the build", err);
    return;
  }

  bP->pid    = pid;
  bP->pipeFd = fds[0];

  char started[64];
  isoTime(bP->started, started, sizeof(started));
  char line[2600];
  int  n = snprintf(line, sizeof(line), "c3: %s\nc3: started %s, pid %d\n", bP->command, started, (int) pid);
  ssize_t ignored = write(bP->logFd, line, n);
  (void) ignored;
  bP->logEnd = n;
  bP->lines  = 2;

  buildSave(bP);

  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  int tr = pthread_create(&bP->thread, &attr, buildThread, bP);
  pthread_attr_destroy(&attr);

  if (tr != 0)
  {
    kill(-pid, SIGKILL);
    waitpid(pid, NULL, 0);
    snprintf(bP->state, sizeof(bP->state), "failed");
    snprintf(bP->error, sizeof(bP->error), "no thread to follow the build");
    buildSave(bP);
    close(bP->pipeFd);
    close(bP->logFd);
    pthread_mutex_unlock(&bMutex);
    buildFree(bP);
    serveError(connP, 500, "Cannot start the build", "no thread to follow the build");
    return;
  }

  cur = bP;

  Str s = { NULL, 0, 0 };
  buildRender(bP, &s);
  pthread_mutex_unlock(&bMutex);

  respondStr(connP, 202, &s);
}



// -----------------------------------------------------------------------------
//
// buildCommand - POST /api/builds/command: the command, nothing run
//
static void buildCommand(CorHttpConn* connP)
{
  Caps cap;
  Plan plan;
  char err[1024];
  int  status;

  capsFind(&cap, false);

  if (planMake(connP, &cap, &plan, &status, err, sizeof(err)) == false)
  {
    planFree(&plan);
    serveError(connP, status, "Bad request", err);
    return;
  }

  Str s = { NULL, 0, 0 };
  planRender(&plan, &s);
  planFree(&plan);
  respondStr(connP, 200, &s);
}



// -----------------------------------------------------------------------------
//
// Record - a build's record as read from its file, for the list
//
typedef struct Record
{
  char*  text;
  char   started[40];
} Record;

static int recordCompare(const void* a, const void* b)
{
  return strcmp(((const Record*) b)->started, ((const Record*) a)->started);      // newest first
}

static void recordStarted(char* text, char* out, int outLen)
{
  out[0] = 0;

  const char* s = strstr(text, "\"started\": \"");
  if (s != NULL)
    snprintf(out, outLen, "%.20s", s + 12);
}



// -----------------------------------------------------------------------------
//
// buildsList - GET /api/builds: the records, the running build's as it is now
//
static void buildsList(CorHttpConn* connP)
{
  DIR*    dirP = opendir(buildsDir);
  Record* recV = NULL;
  int     n    = 0;

  pthread_mutex_lock(&bMutex);

  if (dirP != NULL)
  {
    struct dirent* deP;

    while ((deP = readdir(dirP)) != NULL)
    {
      int len = strlen(deP->d_name);

      if ((len < 6) || (strcmp(&deP->d_name[len - 5], ".json") != 0) || (deP->d_name[0] == '.'))
        continue;

      char name[256];
      snprintf(name, sizeof(name), "%.*s", len - 5, deP->d_name);

      char* text = NULL;
      if ((cur != NULL) && (strcmp(cur->name, name) == 0))
      {
        Str s = { NULL, 0, 0 };
        buildRender(cur, &s);
        text = s.s;
      }
      else
      {
        char path[2600];
        snprintf(path, sizeof(path), "%s/%s", buildsDir, deP->d_name);
        text = fileText(path);
      }

      if ((text == NULL) || (text[0] != '{'))
      {
        free(text);
        continue;
      }

      int tlen = strlen(text);                   // a record's file ends with a newline
      while ((tlen > 0) && ((text[tlen - 1] == '\n') || (text[tlen - 1] == ' ')))
        text[--tlen] = 0;

      recV = realloc(recV, (n + 1) * sizeof(Record));
      recV[n].text = text;
      recordStarted(text, recV[n].started, sizeof(recV[n].started));
      ++n;
    }
    closedir(dirP);
  }

  pthread_mutex_unlock(&bMutex);

  qsort(recV, n, sizeof(Record), recordCompare);

  Str s = { NULL, 0, 0 };
  strAdd(&s, "{\"dir\": ");
  strAddJson(&s, buildsDir);
  strAdd(&s, ", \"builds\": [");
  for (int ix = 0; ix < n; ix++)
  {
    if (ix > 0)
      strAdd(&s, ", ");
    strAdd(&s, recV[ix].text);
    free(recV[ix].text);
  }
  strAdd(&s, "]}");
  free(recV);

  respondStr(connP, 200, &s);
}



// -----------------------------------------------------------------------------
//
// buildGet - GET /api/builds/<name>
//
static void buildGet(CorHttpConn* connP, const char* name)
{
  pthread_mutex_lock(&bMutex);
  if ((cur != NULL) && (strcmp(cur->name, name) == 0))
  {
    Str s = { NULL, 0, 0 };
    buildRender(cur, &s);
    pthread_mutex_unlock(&bMutex);
    respondStr(connP, 200, &s);
    return;
  }
  pthread_mutex_unlock(&bMutex);

  char path[2400];
  snprintf(path, sizeof(path), "%s/%s.json", buildsDir, name);

  char* text = fileText(path);
  if (text == NULL)
  {
    serveError(connP, 404, "No such build", name);
    return;
  }

  char* body = corAllocStrdup(&connP->alloc, text);
  free(text);
  serveJson(connP, 200, body);
}



// -----------------------------------------------------------------------------
//
// buildDelete - DELETE /api/builds/<name>: cancel it if it runs, else delete it
//
static void buildDelete(CorHttpConn* connP, const char* name)
{
  pthread_mutex_lock(&bMutex);

  if ((cur != NULL) && (strcmp(cur->name, name) == 0))
  {
    if (cur->cancel == false)
    {
      cur->cancel   = true;
      cur->cancelAt = time(NULL);
      kill(-cur->pid, SIGTERM);

      char line[128];
      int  n = snprintf(line, sizeof(line), "c3: cancelled - SIGTERM to the process group %d\n", (int) cur->pid);
      outputAdd(cur, line, n);
    }

    Str s = { NULL, 0, 0 };
    buildRender(cur, &s);
    pthread_mutex_unlock(&bMutex);
    respondStr(connP, 202, &s);
    return;
  }

  pthread_mutex_unlock(&bMutex);

  if (buildExists(name) == false)
  {
    serveError(connP, 404, "No such build", name);
    return;
  }

  char path[2400];
  bool ok = true;

  snprintf(path, sizeof(path), "%s/%s", buildsDir, name);
  ok = removeAll(path) && ok;
  snprintf(path, sizeof(path), "%s/%s.log", buildsDir, name);
  ok = removeAll(path) && ok;
  snprintf(path, sizeof(path), "%s/%s.json", buildsDir, name);
  ok = removeAll(path) && ok;

  if (!ok)
  {
    serveError(connP, 500, "Not all of it could be deleted", strerror(errno));
    return;
  }

  corHttpResponseStatus(connP, 204);
  corHttpResponseBody(connP, (char*) "", 0);
}



// -----------------------------------------------------------------------------
//
// buildLog - GET /api/builds/<name>/log
//
// With Accept: text/event-stream, server-sent events: what the log has from Last-Event-ID (or ?from=, or
// the start) on, then - while the build runs - each line as it comes, an event "build" at each phase,
// "end" with the record when it is over (and the stream ends). Without, the log file itself.
//
static void buildLog(CorHttpConn* connP, const char* name)
{
  const char* accept = corHttpHeader(connP, "Accept");
  char        logPath[2400];

  snprintf(logPath, sizeof(logPath), "%s/%s.log", buildsDir, name);

#ifndef COR_HTTP_STREAM_PENDING_MAX
  //
  // A corHttp without streams: the file only - the page reads it by Range, again and again
  //
  (void) accept;
  serveFileRange(connP, logPath, "text/plain; charset=utf-8", 0);
#else
  if ((accept == NULL) || (strstr(accept, "text/event-stream") == NULL))
  {
    serveFileRange(connP, logPath, "text/plain; charset=utf-8", 0);
    return;
  }

  const char* lastId = corHttpHeader(connP, "Last-Event-ID");
  const char* fromP  = corHttpUriParam(connP, "from");
  long long   from   = (lastId != NULL) ? atoll(lastId) : ((fromP != NULL) ? atoll(fromP) : 0);

  pthread_mutex_lock(&bMutex);

  Build* bP      = ((cur != NULL) && (strcmp(cur->name, name) == 0)) ? cur : NULL;
  char*  record  = NULL;

  if (bP == NULL)
  {
    char jsonPath[2400];
    snprintf(jsonPath, sizeof(jsonPath), "%s/%s.json", buildsDir, name);
    record = fileText(jsonPath);
  }

  int fd = open(logPath, O_RDONLY | O_CLOEXEC);

  if ((fd == -1) || ((bP == NULL) && (record == NULL)))
  {
    pthread_mutex_unlock(&bMutex);
    if (fd != -1)
      close(fd);
    free(record);
    serveError(connP, 404, "No such build", name);
    return;
  }

  struct stat st;
  fstat(fd, &st);

  int64_t end = (bP != NULL) ? bP->logEnd : st.st_size;
  Str     s   = { NULL, 0, 0 };

  sseFromFile(&s, fd, from, end);
  close(fd);

  corHttpResponseStatus(connP, 200);
  corHttpResponseHeader(connP, "Content-Type", "text/event-stream");
  corHttpResponseHeader(connP, "Cache-Control", "no-store");

  CorHttpStream* streamP = corHttpResponseStream(connP);

  if (bP != NULL)
  {
    sseEvent(&s, "build", bP);
    corHttpStreamWrite(streamP, s.s, s.len);

    if (sseSubsAdd(&bP->subs, streamP) == false)
    {
      corHttpStreamWrite(streamP, "event: busy\ndata: too many pages follow this build\n\n", 53);
      corHttpStreamEnd(streamP);
    }
  }
  else
  {
    int rlen = strlen(record);
    while ((rlen > 0) && (record[rlen - 1] == '\n'))
      record[--rlen] = 0;

    strAdd(&s, "event: end\ndata: ");
    strAdd(&s, record);
    strAdd(&s, "\n\n");
    corHttpStreamWrite(streamP, s.s, s.len);
    corHttpStreamEnd(streamP);
  }

  pthread_mutex_unlock(&bMutex);
  strFree(&s);
  free(record);
#endif
}



// -----------------------------------------------------------------------------
//
// Features - coraine-build --list-features --json, cached per coraine-build and source tarball (path and
// mtime). Run on a thread of its own; the requests that came meanwhile wait (suspended) for the one run.
//
static pthread_mutex_t fMutex = PTHREAD_MUTEX_INITIALIZER;
static char*           fText  = NULL;            // the answer: {"source", "version", "features": [...]}
static char            fKey[4200];
static bool            fRunning = false;
static CorHttpConn*    fWaitV[64];
static int             fWaiting = 0;

static void featuresAnswer(CorHttpConn* connP, const char* text, int status)
{
  char* body = corAllocStrdup(&connP->alloc, text);

  if (status == 200)
    serveJson(connP, 200, body);
  else
    serveError(connP, status, "No feature list", text);
}

static void* featuresThread(void* vP)
{
  Caps* cP = (Caps*) vP;
  char* argv[8];
  int   argc = 0;
  char  out[256 * 1024];

  argv[argc++] = cP->coraineBuild;
  argv[argc++] = (char*) "--list-features";
  argv[argc++] = (char*) "--json";
  if (cP->sourceGiven)
  {
    argv[argc++] = (char*) "--source";
    argv[argc++] = cP->source;
  }
  argv[argc] = NULL;

  int  status = runCapture(argv, out, sizeof(out), 120);
  Str  s      = { NULL, 0, 0 };
  int  http   = 200;

  sourceVersion(cP->source, cP->version, sizeof(cP->version));

  char* list = out;
  while ((*list == ' ') || (*list == '\n'))
    ++list;

  if ((status == 0) && (*list == '['))
  {
    strAdd(&s, "{\"coraineBuild\": "); strAddJson(&s, cP->coraineBuild);
    strAdd(&s, ", \"source\": ");      strAddJson(&s, cP->source);
    strAdd(&s, ", \"version\": ");     strAddJson(&s, (cP->version[0] != 0) ? cP->version : NULL);
    strAdd(&s, ", \"features\": ");    strAdd(&s, list);

    //
    // What each choice is and costs: the source's own doc/building-details.md (a "#### " heading per
    // choice), shown behind each box's '?'. A source without it: "doc": null
    //
    int         docSize = 512 * 1024;
    char*       doc     = (char*) malloc(docSize);
    char*       tarv[]  = { (char*) "tar", (char*) "-xJOf", cP->source, (char*) "--wildcards", (char*) "--no-anchored",
                           (char*) "coraine/doc/building-details.md", NULL };
    int         dStatus = (doc != NULL) ? runCapture(tarv, doc, docSize, 60) : -1;

    strAdd(&s, ", \"doc\": ");
    strAddJson(&s, (dStatus == 0) ? doc : NULL);
    free(doc);

    //
    // The bridges coraine-build can build (--list-bridges --json): null from one that has no such option
    //
    int         bridgesSize = 64 * 1024;
    char*       bridges     = (char*) malloc(bridgesSize);
    char*       bargv[8];
    int         bargc = 0;

    bargv[bargc++] = cP->coraineBuild;
    bargv[bargc++] = (char*) "--list-bridges";
    bargv[bargc++] = (char*) "--json";
    if (cP->sourceGiven)
    {
      bargv[bargc++] = (char*) "--source";
      bargv[bargc++] = cP->source;
    }
    bargv[bargc] = NULL;

    int   bStatus = (bridges != NULL) ? runCapture(bargv, bridges, bridgesSize, 120) : -1;
    char* bList   = (bridges != NULL) ? bridges : (char*) "";
    while ((*bList == ' ') || (*bList == '\n'))
      ++bList;

    strAdd(&s, ", \"bridges\": ");
    strAdd(&s, ((bStatus == 0) && (*bList == '[')) ? bList : "null");
    strAdd(&s, "}");
    free(bridges);
  }
  else
  {
    http = 502;
    strAdd(&s, "coraine-build --list-features --json failed: ");
    strAdd(&s, out);
  }

  pthread_mutex_lock(&fMutex);
  if (http == 200)
  {
    free(fText);
    fText = strdup(s.s);
  }
  fRunning = false;

  for (int ix = 0; ix < fWaiting; ix++)
  {
    featuresAnswer(fWaitV[ix], s.s, http);
    corHttpResume(fWaitV[ix]);
  }
  fWaiting = 0;
  pthread_mutex_unlock(&fMutex);

  strFree(&s);
  free(cP);
  return NULL;
}

static void compileFeatures(CorHttpConn* connP)
{
  Caps* cP = (Caps*) calloc(1, sizeof(Caps));
  capsFind(cP, false);

  if (cP->available == false)
  {
    serveError(connP, 503, "Compile is not available", cP->why);
    free(cP);
    return;
  }

  struct stat st;
  char        key[4200];
  stat(cP->source, &st);
  snprintf(key, sizeof(key), "%s|%s|%lld", cP->coraineBuild, cP->source, (long long) st.st_mtime);

  pthread_mutex_lock(&fMutex);

  if ((fText != NULL) && (strcmp(key, fKey) == 0))
  {
    featuresAnswer(connP, fText, 200);
    pthread_mutex_unlock(&fMutex);
    free(cP);
    return;
  }

  if (fWaiting >= (int) (sizeof(fWaitV) / sizeof(fWaitV[0])))
  {
    pthread_mutex_unlock(&fMutex);
    serveError(connP, 503, "Busy", "too many requests wait for the feature list");
    free(cP);
    return;
  }

  fWaitV[fWaiting++] = connP;
  corHttpSuspend(connP);

  if (fRunning == false)
  {
    pthread_t      tid;
    pthread_attr_t attr;

    snprintf(fKey, sizeof(fKey), "%s", key);
    fRunning = true;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    if (pthread_create(&tid, &attr, featuresThread, cP) != 0)
    {
      fRunning = false;
      for (int ix = 0; ix < fWaiting; ix++)
      {
        featuresAnswer(fWaitV[ix], "no thread for coraine-build --list-features", 500);
        corHttpResume(fWaitV[ix]);
      }
      fWaiting = 0;
      free(cP);
    }
    pthread_attr_destroy(&attr);
  }
  else
    free(cP);

  pthread_mutex_unlock(&fMutex);
}



// -----------------------------------------------------------------------------
//
// capabilities - GET /api/capabilities
//
static void capabilities(CorHttpConn* connP)
{
  Caps cap;
  char host[256] = "";
  Str  s         = { NULL, 0, 0 };

  capsFind(&cap, true);
  gethostname(host, sizeof(host) - 1);

  //
  // The machine a build is for: its architecture and distribution (coraine-build builds for the host)
  //
  struct utsname u;
  char           dist[256] = "";
  char*          osRelease = fileText("/etc/os-release");
  char*          pretty    = (osRelease != NULL) ? strstr(osRelease, "PRETTY_NAME=") : NULL;

  if (uname(&u) != 0)
    u.machine[0] = 0;
  if (pretty != NULL)
  {
    pretty += 12;
    if (*pretty == '"')
      ++pretty;
    int len = strcspn(pretty, "\"\n");
    snprintf(dist, sizeof(dist), "%.*s", len, pretty);
  }
  free(osRelease);

  strAdd(&s, "{\"host\": ");               strAddJson(&s, host);
  strAdd(&s, ", \"arch\": ");              strAddJson(&s, u.machine);
  strAdd(&s, ", \"distribution\": ");      strAddJson(&s, (dist[0] != 0) ? dist : NULL);
  strAdd(&s, ", \"compile\": {\"available\": ");  strAdd(&s, cap.available ? "true" : "false");
  strAdd(&s, ", \"why\": ");               strAddJson(&s, cap.available ? NULL : cap.why);
  strAdd(&s, ", \"coraineBuild\": ");      strAddJson(&s, (cap.coraineBuild[0] != 0) ? cap.coraineBuild : NULL);
  strAdd(&s, ", \"source\": ");            strAddJson(&s, cap.source);
  strAdd(&s, ", \"version\": ");           strAddJson(&s, (cap.version[0] != 0) ? cap.version : NULL);
  strAdd(&s, ", \"builds\": ");            strAddJson(&s, buildsDir);
  strAdd(&s, ", \"pgo\": ");               strAdd(&s, cap.pgo ? "true" : "false");
  strAdd(&s, ", \"pgoWhy\": ");            strAddJson(&s, cap.pgo ? NULL : cap.pgoWhy);
  strAdd(&s, ", \"mongoc\": ");            strAdd(&s, cap.mongoc ? "true" : "false");
  strAdd(&s, ", \"mongocWhy\": ");         strAddJson(&s, cap.mongoc ? NULL : cap.mongocWhy);
#ifdef COR_HTTP_STREAM_PENDING_MAX
  strAdd(&s, ", \"liveLog\": true");
#else
  strAdd(&s, ", \"liveLog\": false");
#endif
  strAdd(&s, "}, \"run\": ");
  runCapabilities(&s);
  strAdd(&s, "}");

  respondStr(connP, 200, &s);
}



// -----------------------------------------------------------------------------
//
// compileRequest - /api/capabilities, /api/compile/..., /api/builds...
//
void compileRequest(CorHttpConn* connP, const char* path)
{
  const char* method = connP->method.s;

  if (strcmp(path, "/api/capabilities") == 0)
  {
    if (strcmp(method, "GET") == 0)
      capabilities(connP);
    else
      serveError(connP, 405, "Method not allowed", path);
    return;
  }

  if (strcmp(path, "/api/compile/features") == 0)
  {
    if (strcmp(method, "GET") == 0)
      compileFeatures(connP);
    else
      serveError(connP, 405, "Method not allowed", path);
    return;
  }

  if (strcmp(path, "/api/builds/command") == 0)
  {
    if (strcmp(method, "POST") == 0)
      buildCommand(connP);
    else
      serveError(connP, 405, "Method not allowed", path);
    return;
  }

  if (strcmp(path, "/api/builds") == 0)
  {
    if (strcmp(method, "GET") == 0)
      buildsList(connP);
    else if (strcmp(method, "POST") == 0)
      buildStart(connP);
    else
      serveError(connP, 405, "Method not allowed", path);
    return;
  }

  if (strncmp(path, "/api/builds/", 12) == 0)
  {
    char  name[128];
    const char* rest  = &path[12];
    const char* slash = strchr(rest, '/');
    int         len   = (slash != NULL) ? (int) (slash - rest) : (int) strlen(rest);

    snprintf(name, sizeof(name), "%.*s", (len < 100) ? len : 100, rest);

    if (nameValid(name) == false)
    {
      serveError(connP, 404, "No such build", name);
      return;
    }

    if ((slash != NULL) && (strcmp(slash, "/log") == 0) && ((strcmp(method, "GET") == 0) || (strcmp(method, "HEAD") == 0)))
      buildLog(connP, name);
    else if ((slash == NULL) && (strcmp(method, "GET") == 0))
      buildGet(connP, name);
    else if ((slash == NULL) && (strcmp(method, "DELETE") == 0))
      buildDelete(connP, name);
    else
      serveError(connP, 405, "Method not allowed", path);
    return;
  }

  serveError(connP, 404, "Not found", path);
}



// -----------------------------------------------------------------------------
//
// interruptedMark - a record left "running" by a c3 that stopped during the build: "interrupted"
//
static void interruptedMark(void)
{
  DIR* dirP = opendir(buildsDir);
  if (dirP == NULL)
    return;

  struct dirent* deP;
  while ((deP = readdir(dirP)) != NULL)
  {
    int len = strlen(deP->d_name);
    if ((len < 6) || (strcmp(&deP->d_name[len - 5], ".json") != 0))
      continue;

    char path[2600];
    snprintf(path, sizeof(path), "%s/%s", buildsDir, deP->d_name);

    char* text = fileText(path);
    char* run  = (text != NULL) ? strstr(text, "\"state\": \"running\"") : NULL;

    if (run != NULL)
    {
      Str s = { NULL, 0, 0 };
      strAddN(&s, text, run - text);
      strAdd(&s, "\"state\": \"interrupted\"");
      strAdd(&s, run + strlen("\"state\": \"running\""));

      char* err = strstr(s.s, "\"error\": null");
      if (err != NULL)
      {
        Str t = { NULL, 0, 0 };
        strAddN(&t, s.s, err - s.s);
        strAdd(&t, "\"error\": \"c3 stopped during the build\"");
        strAdd(&t, err + strlen("\"error\": null"));
        strFree(&s);
        s = t;
      }

      int fd = open(path, O_WRONLY | O_TRUNC | O_CLOEXEC);
      if (fd != -1)
      {
        ssize_t ignored = write(fd, s.s, s.len);
        (void) ignored;
        close(fd);
      }
      strFree(&s);
    }
    free(text);
  }
  closedir(dirP);
}



// -----------------------------------------------------------------------------
//
// compileInit - where the builds live; records of builds a stopped c3 left running marked interrupted
//
bool compileInit(void)
{
  if (dataHome("builds", buildsDir, sizeof(buildsDir)) == false)
    return false;

  interruptedMark();
  return true;
}



// -----------------------------------------------------------------------------
//
// compileShutdown - c3 stops: a build that runs is cancelled, and waited for (at most 10 s)
//
void compileShutdown(void)
{
  pthread_mutex_lock(&bMutex);
  bool running = (cur != NULL);

  if (running && (cur->cancel == false))
  {
    cur->cancel   = true;
    cur->cancelAt = time(NULL);
    kill(-cur->pid, SIGTERM);
  }
  pthread_mutex_unlock(&bMutex);

  for (int ix = 0; running && (ix < 100); ix++)  // the build's thread sets cur to NULL when it is over
  {
    usleep(100 * 1000);
    pthread_mutex_lock(&bMutex);
    running = (cur != NULL);
    pthread_mutex_unlock(&bMutex);
  }

  if (running)
    fprintf(stderr, "c3: the build did not stop in 10 s\n");
}
