//
// FILE            c3.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// c3 - the coraine Control Center
//
// Starts the backend on a local port, serves the pages and the API, and opens the application.
//
//   c3 [--port <port>] [--config <file>] [--no-browser] [--www <directory>] [--planet <url>]
//      [--coraine-build <path>] [--source <tarball>]
//
// If the port is taken by a c3 already, that one opens its window (POST /api/window/open) and this one exits.
//
#include <limits.h>                              // PATH_MAX
#include <signal.h>                              // signal, kill
#include <stdio.h>                               // printf, fprintf, snprintf
#include <stdlib.h>                              // exit, atoi
#include <string.h>                              // strrchr, strstr
#include <sys/stat.h>                            // stat
#include <unistd.h>                              // readlink, getpid, usleep

#include <arpa/inet.h>                           // htons, htonl
#include <netinet/in.h>                          // sockaddr_in, INADDR_LOOPBACK
#include <sys/socket.h>                          // socket, connect

#include "corArgs/corArgs.h"                     // corArgsInit, corArgsParse
#include "corArgs/CorArg.h"                      // CorArg
#include "corRest/corRestClient.h"               // corRestClientMulti*

#include "c3.h"



// -----------------------------------------------------------------------------
//
// Globals
//
unsigned short  c3Port = 7900;
char            c3WwwDir[4096];
char            c3ConfigPath[4096];

static char*    configArg  = NULL;
static char*    wwwArg     = NULL;
static bool     noBrowser  = false;
static char*    tokenFileArg = NULL;
static CorHttpServer server;



// -----------------------------------------------------------------------------
//
// options -
//
static CorArg options[] =
{
  { "--port",       "-p",  CorArgUShort, &c3Port,    CorArgOpt, _vp 7900, _vp 1, _vp 65535, "TCP port of the backend (this machine only)" },
  { "--config",     "-c",  CorArgString, &configArg, CorArgOpt, NULL,     NULL,  NULL,      "configuration file (default: $XDG_CONFIG_HOME/c3/c3.json, ~/.config/c3/c3.json)" },
  { "--no-browser", "-nb", CorArgBool,   &noBrowser, CorArgOpt, _vp false, NULL, NULL,      "serve only - print the URL, open no browser" },
  { "--www",        "-w",  CorArgString, &wwwArg,    CorArgOpt, NULL,     NULL,  NULL,      "directory of the pages (default: next to the binary, or ../share/c3/www)" },
  { "--planet",     "-pl", CorArgString, &c3Planet,  CorArgOpt, NULL,     NULL,  NULL,      "the Protomaps planet (.pmtiles URL) map areas are extracted from (default: the newest daily build)" },
  { "--coraine-build", "-cb", CorArgString, &c3CoraineBuild, CorArgOpt, NULL, NULL, NULL,   "coraine-build, for Compile (default: the one in $PATH - coraine-dev; else the coraine clone's, beside the cor-libs c3 was built against)" },
  { "--source",     "-src", CorArgString, &c3Source, CorArgOpt, NULL,     NULL,  NULL,      "the coraine source Compile builds from: a tarball, or a directory of git clones (default: the tarball coraine-dev installs; else the clones c3 was built against)" },
  { "--token-file", "-tf", CorArgString, &tokenFileArg, CorArgOpt, NULL,  NULL,  NULL,      "a file holding the access token sent to brokers that have none of their own - read again when it changes (default: $C3_TOKEN)" },
  CORARGS_END
};



// -----------------------------------------------------------------------------
//
// onSignal -
//
static void onSignal(int sigNo)
{
  (void) sigNo;
  corHttpStop(&server);
}



// -----------------------------------------------------------------------------
//
// isDir / hasIndex -
//
static bool hasIndex(const char* dir)
{
  char        path[4200];
  struct stat st;

  snprintf(path, sizeof(path), "%s/index.html", dir);
  return (stat(path, &st) == 0) && S_ISREG(st.st_mode);
}



// -----------------------------------------------------------------------------
//
// wwwResolve - --www, else <binary's dir>/www (a checkout), else <binary's dir>/../share/c3/www (installed)
//
static bool wwwResolve(const char* argv0)
{
  if (wwwArg != NULL)
  {
    snprintf(c3WwwDir, sizeof(c3WwwDir), "%s", wwwArg);
    return hasIndex(c3WwwDir);
  }

  char exe[3072];
  int  len = readlink("/proc/self/exe", exe, sizeof(exe) - 1);

  if (len > 0)
    exe[len] = 0;
  else
  {
    char* real = realpath(argv0, NULL);
    snprintf(exe, sizeof(exe), "%s", (real != NULL) ? real : argv0);
    free(real);
  }

  char* slash = strrchr(exe, '/');
  if (slash != NULL)
    *slash = 0;
  else
    snprintf(exe, sizeof(exe), ".");

  snprintf(c3WwwDir, sizeof(c3WwwDir), "%s/www", exe);
  if (hasIndex(c3WwwDir))
    return true;

  snprintf(c3WwwDir, sizeof(c3WwwDir), "%s/../share/c3/www", exe);
  if (hasIndex(c3WwwDir) == false)
    return false;

  char* real = realpath(c3WwwDir, NULL);         // /usr/bin/../share/c3/www -> /usr/share/c3/www
  if (real != NULL)
  {
    snprintf(c3WwwDir, sizeof(c3WwwDir), "%s", real);
    free(real);
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// otherC3 - is the process on the port a c3? Its pid in *pidP (0: a c3 that does not say)
//
static bool otherC3(const char* url, int* pidP)
{
  char                statusUrl[256];
  CorRestClientMulti* multiP = corRestClientMultiCreate(1);
  bool                isC3   = false;

  *pidP = 0;
  if (multiP == NULL)
    return false;

  snprintf(statusUrl, sizeof(statusUrl), "%s/api/status", url);
  corRestClientMultiMaxResponse(multiP, 64 * 1024);

  if (corRestClientMultiAdd(multiP, CorVerbGet, statusUrl, NULL, 0, NULL, 0, NULL, NULL) >= 0)
  {
    corRestClientMultiPerform(multiP, 2000);

    CorRestClientResponse* respP = corRestClientMultiResponse(multiP, 0);
    if ((respP != NULL) && (respP->statusCode == 200) && (respP->body != NULL))
    {
      isC3 = (strstr(respP->body, "\"c3\"") != NULL);

      const char* pid = strstr(respP->body, "\"pid\": ");
      if (isC3 && (pid != NULL))
        *pidP = atoi(pid + 7);
    }
  }

  corRestClientMultiDestroy(multiP);
  return isC3;
}



// -----------------------------------------------------------------------------
//
// otherC3Open - the c3 on the port opens its window: true when it did
//
// Not opened from here: this c3 exits now, and a Chrome it started with the DevTools pipe would exit with
// it (browser.c). A c3 without POST /api/window/open (an earlier version), or with no screen, answers
// other than 200.
//
static bool otherC3Open(const char* url, const char* token, char* answer, int answerLen)
{
  char                openUrl[256];
  char                body[512];
  CorRestKeyValue     contentType = { (char*) "Content-Type", (char*) "application/json", 0 };
  CorRestClientMulti* multiP = corRestClientMultiCreate(1);
  bool                opened = false;

  if (multiP == NULL)
    return false;

  snprintf(openUrl, sizeof(openUrl), "%s/api/window/open", url);
  if (token != NULL)
    snprintf(body, sizeof(body), "{\"activationToken\": \"%s\"}", token);
  else
    snprintf(body, sizeof(body), "{}");
  corRestClientMultiMaxResponse(multiP, 64 * 1024);

  if (corRestClientMultiAdd(multiP, CorVerbPost, openUrl, &contentType, 1, body, strlen(body), NULL, NULL) >= 0)
  {
    corRestClientMultiPerform(multiP, 5000);

    CorRestClientResponse* respP = corRestClientMultiResponse(multiP, 0);
    opened = (respP != NULL) && (respP->statusCode == 200);
    snprintf(answer, answerLen, "%s", ((respP != NULL) && (respP->body != NULL)) ? respP->body : "");
  }

  corRestClientMultiDestroy(multiP);
  return opened;
}



// -----------------------------------------------------------------------------
//
// portTaken - something answers on 127.0.0.1:<port>
//
// Asked before corHttpInit, not left to bind() failing: corHttp sets SO_REUSEPORT on its listener, so a
// second server of the same user binds the port too, and the two share its connections.
//
static bool portTaken(unsigned short port)
{
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd == -1)
    return false;

  struct sockaddr_in sa;
  memset(&sa, 0, sizeof(sa));
  sa.sin_family      = AF_INET;
  sa.sin_port        = htons(port);
  sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

  bool taken = (connect(fd, (struct sockaddr*) &sa, sizeof(sa)) == 0);
  close(fd);

  return taken;
}



// -----------------------------------------------------------------------------
//
// earlierBuild - the c3 of pid is an earlier build of this very file: its executable is this one's path, deleted
//
// An install replaces the file a running c3 was started from (/proc/<pid>/exe then reads "<path> (deleted)"); a
// c3 started again from it finds the earlier one on its port. A c3 of another file - a checkout, another
// install - is not one.
//
static bool earlierBuild(int pid)
{
  char self[PATH_MAX];
  char other[PATH_MAX + 16];
  char link[64];

  ssize_t selfLen = readlink("/proc/self/exe", self, sizeof(self) - 1);
  snprintf(link, sizeof(link), "/proc/%d/exe", pid);
  ssize_t otherLen = readlink(link, other, sizeof(other) - 1);

  if ((pid <= 0) || (pid == getpid()) || (selfLen <= 0) || (otherLen <= 0))
    return false;

  self[selfLen]   = 0;
  other[otherLen] = 0;

  return (strncmp(other, self, selfLen) == 0) && (strcmp(&other[selfLen], " (deleted)") == 0);
}



// -----------------------------------------------------------------------------
//
// earlierBuildStop - SIGTERM to the earlier c3, and its port free again - 10 s at most
//
static bool earlierBuildStop(int pid)
{
  if (kill(pid, SIGTERM) != 0)
    return false;

  for (int ix = 0; ix < 100; ix++)
  {
    if (portTaken(c3Port) == false)
      return true;
    usleep(100 * 1000);
  }

  return false;
}



// -----------------------------------------------------------------------------
//
// main -
//
int main(int argC, char* argV[])
{
  if (corArgsInit("c3", options, "C3_") != CorArgsOk)
  {
    fprintf(stderr, "c3: corArgsInit failed\n");
    return 1;
  }

  if (corArgsParse(argC, argV) != CorArgsOk)
    return 1;

  if (wwwResolve(argV[0]) == false)
  {
    fprintf(stderr, "c3: no pages in %s (index.html) - --www <directory>\n", c3WwwDir);
    return 1;
  }

  if (configPathResolve(configArg, c3ConfigPath, sizeof(c3ConfigPath)) == false)
  {
    fprintf(stderr, "c3: no $HOME and no $XDG_CONFIG_HOME - --config <file>\n");
    return 1;
  }

  signal(SIGINT,  onSignal);
  signal(SIGTERM, onSignal);
  signal(SIGPIPE, SIG_IGN);

  proxyInit();
  oidcInit();                                    // after proxyInit: corRest's client, TLS

  char url[128];
  snprintf(url, sizeof(url), "http://127.0.0.1:%d", c3Port);

  int otherPid = 0;

  if (portTaken(c3Port) && otherC3(url, &otherPid) && earlierBuild(otherPid))
  {
    printf("c3: the c3 on port %d (pid %d) is an earlier build of this one, replaced since it started - stopping it\n", c3Port, otherPid);
    if (earlierBuildStop(otherPid) == false)
    {
      fprintf(stderr, "c3: the earlier c3 (pid %d) is still on port %d - stop it, or --port <port>\n", otherPid, c3Port);
      return 1;
    }
  }

  if (portTaken(c3Port))
  {
    if (otherC3(url, &otherPid))
    {
      printf("c3: already running on port %d\n", c3Port);

      const char* token = activationToken(getenv("XDG_ACTIVATION_TOKEN"));
      char        answer[256] = "";

      if ((noBrowser == false) && otherC3Open(url, token, answer, sizeof(answer)))
        printf("c3: %s - its window opened %s (%s)\n", url, answer, (token != NULL) ? "with the activation token of the start" : "no activation token: the desktop may say \"ready\" instead");
      else
        browserOpen(url, noBrowser, false, token);  // no pipe: this c3 is gone in a moment, the window stays

      return 0;
    }

    fprintf(stderr, "c3: port %d is taken - --port <port>\n", c3Port);
    return 1;
  }

  if (corHttpInit(&server, c3Port, 64, serveRequest) != CorHttpOk)
  {
    fprintf(stderr, "c3: cannot listen on port %d - --port <port>\n", c3Port);
    return 1;
  }

  server.maxRequestSize = 16 * 1024 * 1024;      // a notification carries whole entities
  configLoad();
  credsInit(tokenFileArg);                       // before liveInit: its sweep sends the tokens
  liveInit();

  if (mapsInit() == false)
    fprintf(stderr, "c3: no $HOME and no $XDG_DATA_HOME - the map cannot download areas\n");

  if (compileInit() == false)
    fprintf(stderr, "c3: no $HOME and no $XDG_DATA_HOME - Compile has nowhere to build\n");

  if (runInit() == false)
    fprintf(stderr, "c3: no $HOME and no $XDG_DATA_HOME - Run has nowhere to keep its brokers' logs and data\n");

  printf("c3 %s - backend on port %d (this machine only), pages from %s, configuration %s\n", C3_VERSION, c3Port, c3WwwDir, c3ConfigPath);
  fflush(stdout);

  browserOpen(url, noBrowser, true, activationToken(getenv("XDG_ACTIVATION_TOKEN")));

  corHttpServe(&server);
  liveShutdown();                                // no subscription left behind on any broker
  compileShutdown();                             // a build that runs is cancelled: nothing of it outlives c3
  runShutdown();                                 // the brokers started keep running: the next c3 attaches to them
  corHttpRelease(&server);

  printf("c3: stopped\n");
  return 0;
}
