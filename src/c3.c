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
//   c3 [--port <port>] [--config <file>] [--no-browser] [--www <directory>]
//
// If the port is taken by a c3 already, that one is opened and this one exits.
//
#include <limits.h>                              // PATH_MAX
#include <signal.h>                              // signal
#include <stdio.h>                               // printf, fprintf, snprintf
#include <stdlib.h>                              // exit
#include <string.h>                              // strrchr, strstr
#include <sys/stat.h>                            // stat
#include <unistd.h>                              // readlink

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
// otherC3 - is the process on the port a c3?
//
static bool otherC3(const char* url)
{
  char                statusUrl[256];
  CorRestClientMulti* multiP = corRestClientMultiCreate(1);
  bool                isC3   = false;

  if (multiP == NULL)
    return false;

  snprintf(statusUrl, sizeof(statusUrl), "%s/api/status", url);
  corRestClientMultiMaxResponse(multiP, 64 * 1024);

  if (corRestClientMultiAdd(multiP, CorVerbGet, statusUrl, NULL, 0, NULL, 0, NULL, NULL) >= 0)
  {
    corRestClientMultiPerform(multiP, 2000);

    CorRestClientResponse* respP = corRestClientMultiResponse(multiP, 0);
    if ((respP != NULL) && (respP->statusCode == 200) && (respP->body != NULL))
      isC3 = (strstr(respP->body, "\"c3\"") != NULL);
  }

  corRestClientMultiDestroy(multiP);
  return isC3;
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

  char url[128];
  snprintf(url, sizeof(url), "http://127.0.0.1:%d", c3Port);

  if (portTaken(c3Port))
  {
    if (otherC3(url))
    {
      printf("c3: already running on port %d\n", c3Port);
      browserOpen(url, noBrowser);
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

  server.maxRequestSize = 1024 * 1024;
  configLoad();

  printf("c3 %s - backend on port %d (this machine only), pages from %s, configuration %s\n", C3_VERSION, c3Port, c3WwwDir, c3ConfigPath);
  fflush(stdout);

  browserOpen(url, noBrowser);

  corHttpServe(&server);
  corHttpRelease(&server);

  printf("c3: stopped\n");
  return 0;
}
