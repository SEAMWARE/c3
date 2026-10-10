//
// FILE            util.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// What Compile and Run share: a growing string, files and directories, processes (run and captured, found
// in $PATH, a process group stopped), and a log followed as server-sent events
//
#define _GNU_SOURCE                              // posix_spawn_file_actions_addclosefrom_np

#include <errno.h>                               // errno
#include <fcntl.h>                               // open, O_*
#include <ftw.h>                                 // nftw
#include <poll.h>                                // poll
#include <sys/prctl.h>                           // prctl, PR_SET_PDEATHSIG
#include <signal.h>                              // kill, SIGTERM, SIGKILL
#include <spawn.h>                               // posix_spawn
#include <stdarg.h>                              // va_list
#include <stdio.h>                               // snprintf
#include <stdlib.h>                              // realloc, free, getenv
#include <string.h>                              // strlen, memcpy, strchr
#include <sys/stat.h>                            // stat, mkdir
#include <sys/wait.h>                            // waitpid
#include <time.h>                                // time, gmtime_r
#include <unistd.h>                              // read, close, access, usleep

#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup

#include "c3.h"

extern char** environ;



// -----------------------------------------------------------------------------
//
// Str - a growing string, malloc'ed
//

static void strGrow(Str* sP, int more)
{
  if (sP->len + more + 1 <= sP->size)
    return;

  int size = (sP->size == 0) ? 1024 : sP->size;
  while (size < sP->len + more + 1)
    size *= 2;

  char* s = realloc(sP->s, size);
  if (s == NULL)
    abort();                                     // a few KiB of JSON: there is no recovering from this

  sP->s    = s;
  sP->size = size;
}

void strAddN(Str* sP, const char* s, int len)
{
  if (len < 0)
    return;

  strGrow(sP, len);
  memcpy(&sP->s[sP->len], s, len);
  sP->len += len;
  sP->s[sP->len] = 0;
}

void strAdd(Str* sP, const char* s)
{
  strAddN(sP, s, strlen(s));
}

void strAddf(Str* sP, const char* fmt, ...)
{
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(NULL, 0, fmt, ap);
  va_end(ap);

  strGrow(sP, n);
  va_start(ap, fmt);
  vsnprintf(&sP->s[sP->len], n + 1, fmt, ap);
  va_end(ap);
  sP->len += n;
}

//
// strAddJson - 's' as a JSON string, quotes included; NULL: null
//
void strAddJson(Str* sP, const char* s)
{
  if (s == NULL)
  {
    strAdd(sP, "null");
    return;
  }

  strAdd(sP, "\"");
  for (; *s != 0; ++s)
  {
    unsigned char c = (unsigned char) *s;

    if      (c == '"')   strAdd(sP, "\\\"");
    else if (c == '\\')  strAdd(sP, "\\\\");
    else if (c == '\n')  strAdd(sP, "\\n");
    else if (c == '\t')  strAdd(sP, "\\t");
    else if (c < 0x20)   strAddf(sP, "\\u%04x", c);
    else                 strAddN(sP, (const char*) &c, 1);
  }
  strAdd(sP, "\"");
}

void strFree(Str* sP)
{
  free(sP->s);
  sP->s    = NULL;
  sP->len  = 0;
  sP->size = 0;
}



// -----------------------------------------------------------------------------
//
// isoTime - "2026-10-10T01:02:03Z"
//
void isoTime(time_t t, char* out, int outLen)
{
  struct tm tm;
  gmtime_r(&t, &tm);
  strftime(out, outLen, "%Y-%m-%dT%H:%M:%SZ", &tm);
}



// -----------------------------------------------------------------------------
//
// runCapture - run argv[0] (a path, or a name found in $PATH), its stdout and stderr into 'out'
//
// The exit status (as waitpid gives it), or -1 when it could not be run; killed after 'timeoutS'. No file
// descriptor of c3's is passed on - the listening socket least of all.
//
int runCapture(char* const argv[], char* out, int outSize, int timeoutS)
{
  int fds[2];

  out[0] = 0;
  if (pipe2(fds, O_CLOEXEC) != 0)
    return -1;

  posix_spawn_file_actions_t fa;
  posix_spawn_file_actions_init(&fa);
  posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0);
  posix_spawn_file_actions_adddup2(&fa, fds[1], 1);
  posix_spawn_file_actions_adddup2(&fa, fds[1], 2);
  posix_spawn_file_actions_addclosefrom_np(&fa, 3);

  posix_spawnattr_t attr;
  sigset_t          none, dfl;
  sigemptyset(&none);
  sigemptyset(&dfl);
  sigaddset(&dfl, SIGPIPE);                      // c3 ignores SIGPIPE; the child must not inherit that
  posix_spawnattr_init(&attr);
  posix_spawnattr_setsigmask(&attr, &none);
  posix_spawnattr_setsigdefault(&attr, &dfl);
  posix_spawnattr_setflags(&attr, POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF);

  pid_t pid;
  int   r = posix_spawnp(&pid, argv[0], &fa, &attr, argv, environ);

  posix_spawn_file_actions_destroy(&fa);
  posix_spawnattr_destroy(&attr);
  close(fds[1]);

  if (r != 0)
  {
    close(fds[0]);
    return -1;
  }

  int    got      = 0;
  time_t deadline = time(NULL) + timeoutS;

  while (true)
  {
    struct pollfd pfd = { fds[0], POLLIN, 0 };
    int           ms  = (int) (deadline - time(NULL)) * 1000;

    if ((ms <= 0) || (poll(&pfd, 1, ms) <= 0))
    {
      kill(pid, SIGKILL);
      break;
    }

    char    buf[4096];
    ssize_t n = read(fds[0], buf, sizeof(buf));

    if (n <= 0)
    {
      if ((n < 0) && (errno == EINTR))
        continue;
      break;
    }

    int take = (got + n < outSize - 1) ? n : outSize - 1 - got;
    memcpy(&out[got], buf, take);
    got += take;
  }

  out[got] = 0;
  close(fds[0]);

  int status = -1;
  while ((waitpid(pid, &status, 0) == -1) && (errno == EINTR))
    ;

  return status;
}



// -----------------------------------------------------------------------------
//
// inPath - 'name' found in $PATH as an executable file, its path into 'out'
//
bool inPath(const char* name, char* out, int outLen)
{
  const char* path = getenv("PATH");

  if (path == NULL)
    path = "/usr/local/bin:/usr/bin:/bin";

  while (*path != 0)
  {
    const char* colon = strchr(path, ':');
    int         len   = (colon != NULL) ? (int) (colon - path) : (int) strlen(path);
    struct stat st;

    snprintf(out, outLen, "%.*s/%s", len, path, name);
    if ((len > 0) && (stat(out, &st) == 0) && S_ISREG(st.st_mode) && (access(out, X_OK) == 0))
      return true;

    path += len;
    if (*path == ':')
      ++path;
  }

  out[0] = 0;
  return false;
}



// -----------------------------------------------------------------------------
//
// shellQuote - an argument as a shell would need it
//
void shellQuote(Str* sP, const char* arg)
{
  bool plain = (arg[0] != 0);

  for (const char* p = arg; *p != 0; ++p)
  {
    char c = *p;
    if (!(((c >= 'a') && (c <= 'z')) || ((c >= 'A') && (c <= 'Z')) || ((c >= '0') && (c <= '9')) || (strchr("_./=,:@+-%", c) != NULL)))
      plain = false;
  }

  if (plain)
  {
    strAdd(sP, arg);
    return;
  }

  strAdd(sP, "'");
  for (const char* p = arg; *p != 0; ++p)
  {
    if (*p == '\'')
      strAdd(sP, "'\\''");
    else
      strAddN(sP, p, 1);
  }
  strAdd(sP, "'");
}



// -----------------------------------------------------------------------------
//
// sseLines - complete lines of output as one server-sent event: a "data:" line each, the log's byte
// offset after them as its id (where a page that reconnects goes on from: Last-Event-ID)
//
void sseLines(Str* sP, const char* data, int len, int64_t endOffset)
{
  int start = 0;

  if (len <= 0)
    return;

  for (int ix = 0; ix <= len; ix++)
  {
    if ((ix < len) && (data[ix] != '\n'))
      continue;

    if ((ix == len) && (start == len))
      break;                                     // the newline ended the data: no empty line after it

    strAdd(sP, "data: ");
    for (int jx = start; jx < ix; jx++)
    {
      if (data[jx] != '\r')                      // an event's line ends at a CR too
        strAddN(sP, &data[jx], 1);
    }
    strAdd(sP, "\n");
    start = ix + 1;
  }

  strAddf(sP, "id: %lld\n\n", (long long) endOffset);
}




// -----------------------------------------------------------------------------
//
// groupStop - what is left of a process group: SIGTERM, up to 3 s, then SIGKILL
//
void groupStop(pid_t pgid)
{
  if (kill(-pgid, 0) != 0)
    return;                                      // nothing left

  kill(-pgid, SIGTERM);
  for (int ix = 0; ix < 30; ix++)
  {
    if (kill(-pgid, 0) != 0)
      return;
    usleep(100 * 1000);
  }

  kill(-pgid, SIGKILL);
}



// -----------------------------------------------------------------------------
//
// respondStr - a JSON answer from a Str (copied into the connection, the Str freed)
//
void respondStr(CorHttpConn* connP, int status, Str* sP)
{
  char* body = corAllocStrdup(&connP->alloc, (sP->s != NULL) ? sP->s : "null");
  strFree(sP);
  serveJson(connP, status, body);
}



// -----------------------------------------------------------------------------
//
// fileText - a whole (small) file, malloc'ed; NULL if it cannot be read
//
char* fileText(const char* path)
{
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd == -1)
    return NULL;

  struct stat st;
  if ((fstat(fd, &st) != 0) || (st.st_size < 0) || (st.st_size > 4 * 1024 * 1024))
  {
    close(fd);
    return NULL;
  }

  char*   text = malloc(st.st_size + 1);
  ssize_t n    = read(fd, text, st.st_size);
  close(fd);

  if (n != st.st_size)
  {
    free(text);
    return NULL;
  }

  text[n] = 0;
  return text;
}



// -----------------------------------------------------------------------------
//
// removeAll - rm -rf (nftw, depth first, not following links)
//
static int removeOne(const char* path, const struct stat* stP, int flag, struct FTW* ftwP)
{
  (void) stP;
  (void) flag;
  (void) ftwP;
  return remove(path);
}

bool removeAll(const char* path)
{
  struct stat st;

  if (lstat(path, &st) != 0)
    return true;

  return nftw(path, removeOne, 16, FTW_DEPTH | FTW_PHYS) == 0;
}




bool dirsMake(const char* dir)
{
  char path[2048];
  snprintf(path, sizeof(path), "%s", dir);

  for (char* p = path + 1; *p != 0; ++p)
  {
    if (*p != '/')
      continue;
    *p = 0;
    mkdir(path, 0700);
    *p = '/';
  }

  return (mkdir(path, 0700) == 0) || (errno == EEXIST);
}



// -----------------------------------------------------------------------------
//
// dataHome - $XDG_DATA_HOME/c3/<sub>, else ~/.local/share/c3/<sub>; false without either
//
bool dataHome(const char* sub, char* out, int outLen)
{
  const char* xdg  = getenv("XDG_DATA_HOME");
  const char* home = getenv("HOME");

  if ((xdg != NULL) && (xdg[0] == '/'))
    snprintf(out, outLen, "%s/c3/%s", xdg, sub);
  else if ((home != NULL) && (home[0] != 0))
    snprintf(out, outLen, "%s/.local/share/c3/%s", home, sub);
  else
    return false;

  return true;
}



// -----------------------------------------------------------------------------
//
// procSpawn - a child process: stdin /dev/null, stdout and stderr to 'outFd', none of c3's other file
// descriptors (its listening socket least of all), the signals as a shell would have them
//
// group:    a process group of its own - the whole group can be signalled (Cancel, Stop)
// session:  a session of its own (setsid, so also a group): no terminal, nothing of c3's job control - a
//           broker that is meant to outlive c3
// deathSig: sent to the child when c3 dies (0: none)
//
// Only async-signal-safe calls between fork and exec - c3 has threads: argv[0] is a path (resolved before,
// inPath), the environment is built before. The pid, or -1 with errno.
//
pid_t procSpawn(const ProcSpawn* sP)
{
  pid_t pid = fork();

  if (pid != 0)
  {
    if ((pid > 0) && sP->group && !sP->session)
      setpgid(pid, pid);                         // also here: the child may not have run yet (not for a session: setsid
                                                 // refuses a process group leader, which this would make it)
    return pid;
  }

  if (sP->session)
    setsid();
  else if (sP->group)
    setpgid(0, 0);

  if (sP->deathSig != 0)
    prctl(PR_SET_PDEATHSIG, sP->deathSig);

  int null = open("/dev/null", O_RDWR);
  if (null != -1)
    dup2(null, 0);

  int out = (sP->outFd >= 0) ? sP->outFd : null;
  if (out != -1)
  {
    dup2(out, 1);
    dup2(out, 2);
  }
  close_range(3, ~0U, 0);

  if (sP->cwd != NULL)
  {
    if (chdir(sP->cwd) != 0)
      _exit(126);
  }

  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = SIG_DFL;
  sigaction(SIGPIPE, &sa, NULL);
  sigaction(SIGINT,  &sa, NULL);
  sigaction(SIGTERM, &sa, NULL);
  sigaction(SIGHUP,  &sa, NULL);

  sigset_t none;
  sigemptyset(&none);
  sigprocmask(SIG_SETMASK, &none, NULL);

  execve(sP->argv[0], sP->argv, (sP->envp != NULL) ? sP->envp : environ);
  _exit(127);
}



// -----------------------------------------------------------------------------
//
// procStartTime - when a process started, in clock ticks since boot (/proc/<pid>/stat, field 22); 0 when
// there is no such process. A pid and its start time name one process: a pid used again is another start.
//
long long procStartTime(pid_t pid)
{
  char path[64];
  char buf[1024];

  snprintf(path, sizeof(path), "/proc/%d/stat", (int) pid);

  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd == -1)
    return 0;

  ssize_t n = read(fd, buf, sizeof(buf) - 1);
  close(fd);
  if (n <= 0)
    return 0;
  buf[n] = 0;

  //
  // After the command's ")" (the command may hold spaces and parentheses): field 3 is the state; a
  // zombie has not run since it ended
  //
  char* p = strrchr(buf, ')');
  if ((p == NULL) || (p[1] != ' '))
    return 0;
  p += 2;

  if (*p == 'Z')
    return 0;

  for (int field = 3; field < 22; field++)
  {
    p = strchr(p, ' ');
    if (p == NULL)
      return 0;
    ++p;
  }

  return atoll(p);
}



// -----------------------------------------------------------------------------
//
// SseSubs - the pages following a log (a corHttp stream each)
//
// sseSubsSend: text to every one; one that is gone (or more than corHttp keeps for it behind) is let go of
//
bool sseSubsAdd(SseSubs* subsP, CorHttpStream* streamP)
{
  if (subsP->n >= SSE_SUBS_MAX)
    return false;

  subsP->v[subsP->n++] = streamP;
  return true;
}

void sseSubsSend(SseSubs* subsP, const char* text, int len)
{
  for (int ix = 0; ix < subsP->n; )
  {
    if (corHttpStreamWrite(subsP->v[ix], text, len) == true)
    {
      ++ix;
      continue;
    }

    corHttpStreamEnd(subsP->v[ix]);
    subsP->v[ix] = subsP->v[--subsP->n];
  }
}

void sseSubsEnd(SseSubs* subsP)
{
  for (int ix = 0; ix < subsP->n; ix++)
    corHttpStreamEnd(subsP->v[ix]);
  subsP->n = 0;
}



// -----------------------------------------------------------------------------
//
// sseFromFile - the start of a log stream: "retry", then the log's bytes [from, end) as events of their
// lines - at most the last SSE_BACKLOG_MAX, from a line's start, after an event "skipped" with how many
// bytes are left out (the file has them)
//
void sseFromFile(Str* sP, int fd, int64_t from, int64_t end)
{
  if ((from < 0) || (from > end))
    from = 0;

  strAdd(sP, "retry: 2000\n\n");

  bool cut = false;
  if (end - from > SSE_BACKLOG_MAX)
  {
    strAddf(sP, "event: skipped\ndata: %lld\n\n", (long long) (end - SSE_BACKLOG_MAX - from));
    from = end - SSE_BACKLOG_MAX;
    cut  = true;
  }

  if (end <= from)
    return;

  int   len = end - from;
  char* buf = malloc(len);
  int   got = pread(fd, buf, len, from);

  if (got == len)
  {
    int skip = 0;
    if (cut)                                     // from the start of the next line
    {
      while ((skip < len) && (buf[skip] != '\n'))
        ++skip;
      if (skip < len)
        ++skip;
    }
    sseLines(sP, &buf[skip], len - skip, end);
  }

  free(buf);
}
