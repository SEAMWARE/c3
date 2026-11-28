//
// FILE            external.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// A broker on this machine that c3 did not start - the process listening on its port: how it was started, kept so
// that it can be started again from c3 once it has stopped (Operate: Start makes it one of c3's own, from:
// "command"), and stopped:
//
//   GET  /api/run/external?port=<port>       { "port", "running": <launch> | null, "recorded": <launch> | null }
//   POST /api/run/external/stop?port=<port>  SIGTERM to it (the broker's ordered shutdown) - 202 { "pid" }
//
//   <launch>: { "pid", "exe", "cwd", "env", "command", "build", "at" }
//     exe       the executable (/proc/<pid>/exe; " (deleted)" - a binary replaced since it started - cut)
//     cwd       its working directory - relative paths in its options are from there
//     env       its own environment that a broker reads - CORAINE_*, SEAMWARE_*, LD_LIBRARY_PATH, LD_PRELOAD -
//               NAME=value, space-separated, quoted as the command is
//     command   its arguments after the executable, quoted (whitespace inside: '...', a ' inside: "...")
//     build     a build of Compile's (the executable is <builds>/<name>/install/bin/...): its name, else null
//     at        when this was read (ISO 8601)
//
// "running" is read now, from /proc: the socket listening on the port (/proc/net/tcp, tcp6: state 0A), the
// process holding it (/proc/<pid>/fd) - a process of this user's (another user's /proc/<pid>/fd cannot be read).
// Each read of a coraine is also written to <run>/external/<port>.json - "recorded", what is known of it once it
// has stopped. Linux only: elsewhere both are null.
//
// Only a coraine (the executable's name starts with "coraine") is recorded or stopped.
//
#include <dirent.h>                              // opendir, readdir
#include <signal.h>                              // kill, SIGTERM
#include <stdbool.h>                             // bool
#include <stdio.h>                               // snprintf, fopen, fgets, fclose
#include <stdlib.h>                              // atoi, free, strtoul
#include <string.h>                              // strcmp, strncmp, strlen, strrchr, strstr, strchr
#include <time.h>                                // time
#include <unistd.h>                              // readlink

#include "corAlloc/corAlloc.h"                   // corAlloc

#include "c3.h"



#ifdef __linux__
// -----------------------------------------------------------------------------
//
// Launch - what is known of a broker's process
//
typedef struct Launch
{
  int    pid;
  char   exe[1024];
  char   cwd[1024];
  Str    env;
  Str    command;
  char   build[65];
} Launch;



// -----------------------------------------------------------------------------
//
// argQuote - one argument as lineSplit (run.c) reads it back: as it is, or in quotes when it has whitespace or quotes
//
static void argQuote(Str* sP, const char* arg)
{
  if (sP->len > 0)
    strAdd(sP, " ");

  bool plain = (arg[0] != 0) && (strpbrk(arg, " \t\n'\"") == NULL);
  if (plain)
    strAdd(sP, arg);
  else if (strchr(arg, '\'') == NULL)
  {
    strAdd(sP, "'"); strAdd(sP, arg); strAdd(sP, "'");
  }
  else
  {
    strAdd(sP, "\""); strAdd(sP, arg); strAdd(sP, "\"");
  }
}



// -----------------------------------------------------------------------------
//
// portInode - the inode of the socket listening on the port (any address, IPv4 or IPv6); 0: none
//
static unsigned long portInode(int port)
{
  const char* files[2] = { "/proc/net/tcp", "/proc/net/tcp6" };

  for (int f = 0; f < 2; f++)
  {
    FILE* fP = fopen(files[f], "r");
    if (fP == NULL)
      continue;

    char line[512];
    if (fgets(line, sizeof(line), fP) == NULL)   // the header
    {
      fclose(fP);
      continue;
    }

    while (fgets(line, sizeof(line), fP) != NULL)
    {
      unsigned int  lport = 0;
      unsigned int  state = 0;
      unsigned long inode = 0;

      // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode
      if (sscanf(line, " %*d: %*[0-9A-Fa-f]:%X %*[0-9A-Fa-f]:%*X %X %*X:%*X %*X:%*X %*X %*u %*d %lu", &lport, &state, &inode) != 3)
        continue;
      if ((state == 0x0A) && ((int) lport == port) && (inode != 0))
      {
        fclose(fP);
        return inode;
      }
    }
    fclose(fP);
  }

  return 0;
}



// -----------------------------------------------------------------------------
//
// portPid - the process of this user's holding the socket listening on the port; 0: none
//
static int portPid(int port)
{
  unsigned long inode = portInode(port);
  if (inode == 0)
    return 0;

  char want[64];
  snprintf(want, sizeof(want), "socket:[%lu]", inode);

  DIR* procP = opendir("/proc");
  if (procP == NULL)
    return 0;

  int            found = 0;
  struct dirent* eP;
  while ((found == 0) && ((eP = readdir(procP)) != NULL))
  {
    if ((eP->d_name[0] < '1') || (eP->d_name[0] > '9'))
      continue;

    char fdDir[64];
    snprintf(fdDir, sizeof(fdDir), "/proc/%s/fd", eP->d_name);
    DIR* fdP = opendir(fdDir);                   // another user's: not readable
    if (fdP == NULL)
      continue;

    struct dirent* fP;
    while ((fP = readdir(fdP)) != NULL)
    {
      char link[320];
      char target[64];
      snprintf(link, sizeof(link), "%s/%s", fdDir, fP->d_name);
      ssize_t n = readlink(link, target, sizeof(target) - 1);
      if (n <= 0)
        continue;
      target[n] = 0;
      if (strcmp(target, want) == 0)
      {
        found = atoi(eP->d_name);
        break;
      }
    }
    closedir(fdP);
  }
  closedir(procP);

  return found;
}



// -----------------------------------------------------------------------------
//
// procFile - a /proc/<pid>/<what> file, whole (NUL-separated: cmdline, environ); its length in *lenP; NULL: unreadable
//
static char* procFile(int pid, const char* what, int* lenP)
{
  char path[64];
  snprintf(path, sizeof(path), "/proc/%d/%s", pid, what);

  FILE* fP = fopen(path, "r");
  if (fP == NULL)
    return NULL;

  Str  s = { NULL, 0, 0 };
  char buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), fP)) > 0)
    strAddN(&s, buf, (int) n);
  fclose(fP);

  *lenP = s.len;
  if (s.s == NULL)
    strAddN(&s, "", 0);
  return s.s;
}



// -----------------------------------------------------------------------------
//
// launchRead - how the process started: its executable, working directory, arguments, a broker's environment
//
static bool launchRead(int pid, Launch* lP)
{
  char path[64];
  ssize_t n;

  memset(lP, 0, sizeof(*lP));
  lP->pid = pid;

  snprintf(path, sizeof(path), "/proc/%d/exe", pid);
  if ((n = readlink(path, lP->exe, sizeof(lP->exe) - 1)) <= 0)
    return false;
  lP->exe[n] = 0;
  char* deleted = strstr(lP->exe, " (deleted)");
  if ((deleted != NULL) && (deleted[sizeof(" (deleted)") - 1] == 0))
    *deleted = 0;

  snprintf(path, sizeof(path), "/proc/%d/cwd", pid);
  if ((n = readlink(path, lP->cwd, sizeof(lP->cwd) - 1)) > 0)
    lP->cwd[n] = 0;

  int   len  = 0;
  char* args = procFile(pid, "cmdline", &len);
  if (args == NULL)
    return false;
  for (int off = strlen(args) + 1; off < len; off += strlen(&args[off]) + 1)    // argv[0] left out: exe is the program
    argQuote(&lP->command, &args[off]);
  free(args);

  char* env = procFile(pid, "environ", &len);
  for (int off = 0; (env != NULL) && (off < len); off += strlen(&env[off]) + 1)
  {
    const char* e = &env[off];
    if ((strncmp(e, "CORAINE_", 8) == 0) || (strncmp(e, "SEAMWARE_", 9) == 0) || (strncmp(e, "LD_LIBRARY_PATH=", 16) == 0) || (strncmp(e, "LD_PRELOAD=", 11) == 0))
      argQuote(&lP->env, e);
  }
  if (env != NULL) free(env);

  //
  // A build of Compile's: <builds>/<name>/install/bin/<exe>
  //
  char builds[2048];
  if (dataHome("builds", builds, sizeof(builds)))
  {
    int bl = strlen(builds);
    if ((strncmp(lP->exe, builds, bl) == 0) && (lP->exe[bl] == '/'))
    {
      const char* name  = &lP->exe[bl + 1];
      const char* slash = strchr(name, '/');
      if ((slash != NULL) && (strncmp(slash, "/install/bin/", 13) == 0) && (slash - name < (int) sizeof(lP->build)))
        snprintf(lP->build, sizeof(lP->build), "%.*s", (int) (slash - name), name);
    }
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// coraineIs - the executable is a coraine (its name starts so: coraine, coraine-dev builds' coraine)
//
static bool coraineIs(const char* exe)
{
  const char* base = strrchr(exe, '/');
  return strncmp((base != NULL) ? base + 1 : exe, "coraine", 7) == 0;
}



// -----------------------------------------------------------------------------
//
// launchRender - a Launch as JSON
//
static void launchRender(Str* sP, const Launch* lP, const char* at)
{
  strAddf(sP, "{\"pid\": %d, \"exe\": ", lP->pid);  strAddJson(sP, lP->exe);
  strAdd(sP, ", \"cwd\": ");                          strAddJson(sP, (lP->cwd[0] != 0) ? lP->cwd : NULL);
  strAdd(sP, ", \"env\": ");                          strAddJson(sP, (lP->env.s != NULL) ? lP->env.s : "");
  strAdd(sP, ", \"command\": ");                      strAddJson(sP, (lP->command.s != NULL) ? lP->command.s : "");
  strAdd(sP, ", \"build\": ");                        strAddJson(sP, (lP->build[0] != 0) ? lP->build : NULL);
  strAdd(sP, ", \"at\": ");                           strAddJson(sP, at);
  strAdd(sP, "}");
}
#endif



// -----------------------------------------------------------------------------
//
// portParam - ?port=<1-65535>; 0 and a 400 answered when not
//
static int portParam(CorHttpConn* connP)
{
  const char* portP = corHttpUriParam(connP, "port");
  int         port  = (portP != NULL) ? atoi(portP) : 0;

  if ((port <= 0) || (port > 65535))
  {
    serveError(connP, 400, "Bad request", "?port=<the broker's port, on this machine>");
    return 0;
  }
  return port;
}



// -----------------------------------------------------------------------------
//
// externalProcess - GET /api/run/external?port=<port>
//
void externalProcess(CorHttpConn* connP)
{
  int port = portParam(connP);
  if (port == 0)
    return;

  char dir[2048];
  char file[2100];
  bool where = dataHome("run/external", dir, sizeof(dir));
  snprintf(file, sizeof(file), "%s/%d.json", dir, port);

  Str answer = { NULL, 0, 0 };
  strAddf(&answer, "{\"port\": %d, \"running\": ", port);

  bool running = false;
#ifdef __linux__
  int    pid = portPid(port);
  Launch l;
  if ((pid > 0) && launchRead(pid, &l) && coraineIs(l.exe))
  {
    char at[32];
    isoTime(time(NULL), at, sizeof(at));

    Str one = { NULL, 0, 0 };
    launchRender(&one, &l, at);
    strAdd(&answer, one.s);
    running = true;

    if (where && dirsMake(dir))                  // kept: what is known of it once it has stopped
    {
      char  tmp[2120];
      snprintf(tmp, sizeof(tmp), "%s.tmp", file);
      FILE* fP = fopen(tmp, "w");
      if (fP != NULL)
      {
        bool ok = (fputs(one.s, fP) >= 0);
        if ((fclose(fP) == 0) && ok)
          rename(tmp, file);
        else
          remove(tmp);
      }
    }
    strFree(&one);
  }
  strFree(&l.env);
  strFree(&l.command);
#endif
  if (running == false)
    strAdd(&answer, "null");

  strAdd(&answer, ", \"recorded\": ");
  char* kept = where ? fileText(file) : NULL;
  strAdd(&answer, ((kept != NULL) && (kept[0] == '{')) ? kept : "null");
  if (kept != NULL) free(kept);
  strAdd(&answer, "}");

  char* out = corAlloc(&connP->alloc, answer.len + 1);
  memcpy(out, answer.s, answer.len + 1);
  strFree(&answer);
  serveJson(connP, 200, out);
}



// -----------------------------------------------------------------------------
//
// externalStop - POST /api/run/external/stop?port=<port>: SIGTERM - the broker stops in order, as on Ctrl-C
//
void externalStop(CorHttpConn* connP)
{
  int port = portParam(connP);
  if (port == 0)
    return;

#ifdef __linux__
  int pid = portPid(port);
  if (pid <= 0)
  {
    serveError(connP, 404, "Not found", "no process of yours listens on that port");
    return;
  }

  char    path[64];
  char    exe[1024];
  ssize_t n;
  snprintf(path, sizeof(path), "/proc/%d/exe", pid);
  if (((n = readlink(path, exe, sizeof(exe) - 1)) <= 0) || ((exe[n] = 0), coraineIs(exe) == false))
  {
    serveError(connP, 409, "Not a coraine", "the process listening on that port is not a coraine - c3 stops only brokers");
    return;
  }

  if (kill(pid, SIGTERM) != 0)
  {
    serveError(connP, 500, "Not stopped", "kill(SIGTERM) failed");
    return;
  }

  char* out = corAlloc(&connP->alloc, 32);
  snprintf(out, 32, "{\"pid\": %d}", pid);
  serveJson(connP, 202, out);
#else
  serveError(connP, 501, "Not available", "stopping a broker c3 did not start: Linux only");
#endif
}
