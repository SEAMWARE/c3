//
// FILE            serve.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The request callback: the backend's API and the static pages
//
//   GET    /api/status          what the splash screen shows: version, port, configuration file
//   GET    /api/config          the configuration
//   POST   /api/brokers         {"url", "name"}: a broker connected to - first in the list, lastUsed now
//   DELETE /api/brokers         {"url"}: forget a broker
//   PUT    /api/ui              {"lastPage"}
//   GET    /api/proxy/<path>    the same GET to the broker named in X-C3-Broker (proxy.c)
//   GET    /<file>              a file of the www directory; / is index.html
//
// Only for this machine: a connection from another address is refused, and so is a request whose Host
// is not localhost / 127.0.0.1 / [::1] (a page of another site, through DNS rebinding, must not reach
// the proxy). From another machine: ssh -L.
//
#include <arpa/inet.h>                           // ntohl
#include <errno.h>                               // errno
#include <fcntl.h>                               // open
#include <netinet/in.h>                          // sockaddr_in, sockaddr_in6
#include <stdio.h>                               // snprintf
#include <string.h>                              // strcmp, strncmp, strstr, strrchr
#include <sys/socket.h>                          // getpeername
#include <sys/stat.h>                            // fstat
#include <unistd.h>                              // read, close

#include "corAlloc/corAlloc.h"                   // corAlloc

#include "c3.h"



// -----------------------------------------------------------------------------
//
// jsonEscape - 's' as the inside of a JSON string, allocated from the connection
//
static char* jsonEscape(CorHttpConn* connP, const char* s)
{
  int   len = strlen(s);
  char* out = corAlloc(&connP->alloc, len * 6 + 1);
  int   o   = 0;

  for (; *s != 0; ++s)
  {
    unsigned char c = (unsigned char) *s;

    if ((c == '"') || (c == '\\'))
    {
      out[o++] = '\\';
      out[o++] = c;
    }
    else if (c < 0x20)
      o += sprintf(&out[o], "\\u%04x", c);
    else
      out[o++] = c;
  }

  out[o] = 0;
  return out;
}



// -----------------------------------------------------------------------------
//
// serveJson - a JSON answer; 'json' must outlive the callback (a literal, or from connP->alloc)
//
void serveJson(CorHttpConn* connP, int status, const char* json)
{
  corHttpResponseStatus(connP, status);
  corHttpResponseHeader(connP, "Content-Type", "application/json");
  corHttpResponseHeader(connP, "Cache-Control", "no-store");
  corHttpResponseBody(connP, (char*) json, strlen(json));
}



// -----------------------------------------------------------------------------
//
// serveError - {"title", "detail"}
//
void serveError(CorHttpConn* connP, int status, const char* title, const char* detail)
{
  const char* t    = jsonEscape(connP, title);
  const char* d    = jsonEscape(connP, detail);
  int         size = strlen(t) + strlen(d) + 64;
  char*       body = corAlloc(&connP->alloc, size);

  snprintf(body, size, "{\"title\": \"%s\", \"detail\": \"%s\"}", t, d);
  serveJson(connP, status, body);
}



// -----------------------------------------------------------------------------
//
// peerIsLocal - the connection comes from this machine
//
static bool peerIsLocal(int fd)
{
  struct sockaddr_storage sa;
  socklen_t               saLen = sizeof(sa);

  if (getpeername(fd, (struct sockaddr*) &sa, &saLen) == -1)
    return false;

  if (sa.ss_family == AF_INET)
  {
    struct sockaddr_in* inP = (struct sockaddr_in*) &sa;
    return (ntohl(inP->sin_addr.s_addr) >> 24) == 127;
  }

  if (sa.ss_family == AF_INET6)
  {
    struct sockaddr_in6* in6P = (struct sockaddr_in6*) &sa;
    if (IN6_IS_ADDR_LOOPBACK(&in6P->sin6_addr))
      return true;
    if (IN6_IS_ADDR_V4MAPPED(&in6P->sin6_addr))
      return in6P->sin6_addr.s6_addr[12] == 127;
  }

  return false;
}



// -----------------------------------------------------------------------------
//
// hostIsLocal - the Host header names this machine (localhost, 127.0.0.1, [::1]), with or without a port
//
static bool hostIsLocal(const char* host)
{
  if (host == NULL)
    return false;

  static const char* names[] = { "localhost", "127.0.0.1", "[::1]" };

  for (unsigned int ix = 0; ix < sizeof(names) / sizeof(names[0]); ix++)
  {
    int len = strlen(names[ix]);

    if ((strncmp(host, names[ix], len) == 0) && ((host[len] == 0) || (host[len] == ':')))
      return true;
  }

  return false;
}



// -----------------------------------------------------------------------------
//
// contentType - by the file's extension
//
static const char* contentType(const char* path)
{
  const char* dot = strrchr(path, '.');

  if (dot == NULL)                    return "application/octet-stream";
  if (strcmp(dot, ".html")  == 0)     return "text/html; charset=utf-8";
  if (strcmp(dot, ".js")    == 0)     return "text/javascript; charset=utf-8";
  if (strcmp(dot, ".css")   == 0)     return "text/css; charset=utf-8";
  if (strcmp(dot, ".json")  == 0)     return "application/json";
  if (strcmp(dot, ".svg")   == 0)     return "image/svg+xml";
  if (strcmp(dot, ".png")   == 0)     return "image/png";
  if (strcmp(dot, ".woff2") == 0)     return "font/woff2";
  if (strcmp(dot, ".txt")   == 0)     return "text/plain; charset=utf-8";
  if (strcmp(dot, ".ico")   == 0)     return "image/x-icon";

  return "application/octet-stream";
}



// -----------------------------------------------------------------------------
//
// serveFile - a file of the www directory
//
static void serveFile(CorHttpConn* connP, const char* path)
{
  if (strcmp(path, "/") == 0)
    path = "/index.html";

  //
  // Nothing outside the www directory: no "..", no hidden files
  //
  if ((strstr(path, "/.") != NULL) || (strstr(path, "\\") != NULL))
  {
    serveError(connP, 404, "Not found", path);
    return;
  }

  char file[8192];
  snprintf(file, sizeof(file), "%s%s", c3WwwDir, path);

  int fd = open(file, O_RDONLY);
  if (fd == -1)
  {
    serveError(connP, 404, "Not found", path);
    return;
  }

  struct stat st;
  if ((fstat(fd, &st) == -1) || (!S_ISREG(st.st_mode)) || (st.st_size > 32 * 1024 * 1024))
  {
    close(fd);
    serveError(connP, 404, "Not found", path);
    return;
  }

  char* body = corAlloc(&connP->alloc, st.st_size + 1);
  int   got  = 0;

  while (got < st.st_size)
  {
    int n = read(fd, body + got, st.st_size - got);
    if (n <= 0)
    {
      if ((n == -1) && (errno == EINTR))
        continue;
      break;
    }
    got += n;
  }
  close(fd);

  corHttpResponseStatus(connP, 200);
  corHttpResponseHeader(connP, "Content-Type", contentType(file));
  corHttpResponseHeader(connP, "Cache-Control", "no-cache");
  corHttpResponseBody(connP, body, got);
}



// -----------------------------------------------------------------------------
//
// serveStatus - GET /api/status
//
static void serveStatus(CorHttpConn* connP)
{
  const char* error = configError();
  const char* path  = jsonEscape(connP, c3ConfigPath);
  const char* errE  = (error != NULL) ? jsonEscape(connP, error) : NULL;
  int         size  = strlen(path) + ((errE != NULL) ? strlen(errE) : 0) + 256;
  char*       body  = corAlloc(&connP->alloc, size);

  snprintf(body, size, "{\"c3\": \"%s\", \"port\": %d, \"config\": \"%s\", \"configError\": %s%s%s, \"brokers\": %d}",
           C3_VERSION, c3Port, path,
           (errE != NULL) ? "\"" : "", (errE != NULL) ? errE : "null", (errE != NULL) ? "\"" : "",
           configBrokers());

  serveJson(connP, 200, body);
}



// -----------------------------------------------------------------------------
//
// serveConfigChange - a change of the configuration: the new configuration, or 400 with why not
//
static void serveConfigChange(CorHttpConn* connP, bool (*change)(char* body, char* errBuf, int errLen))
{
  char err[1024];

  if (connP->bodyRefused)
  {
    serveError(connP, 413, "Payload too large", "the body is too large");
    return;
  }

  if (change(connP->body.s, err, sizeof(err)) == false)
  {
    serveError(connP, 400, "Bad request", err);
    return;
  }

  serveJson(connP, 200, configText());
}



// -----------------------------------------------------------------------------
//
// serveRequest - the one corHttp callback
//
void serveRequest(CorHttpConn* connP)
{
  const char* method = connP->method.s;
  const char* path   = connP->path.s;

  if ((peerIsLocal(connP->fd) == false) || (hostIsLocal(corHttpHeader(connP, "Host")) == false))
  {
    serveError(connP, 403, "Forbidden", "c3 answers this machine only (from another one: ssh -L)");
    return;
  }

  if (strncmp(path, "/api/", 5) != 0)
  {
    if ((strcmp(method, "GET") != 0) && (strcmp(method, "HEAD") != 0))
      serveError(connP, 405, "Method not allowed", path);
    else
      serveFile(connP, path);
    return;
  }

  if (strncmp(path, "/api/proxy/", 11) == 0)
    proxyRequest(connP, &path[10]);
  else if ((strcmp(path, "/api/status") == 0) && (strcmp(method, "GET") == 0))
    serveStatus(connP);
  else if ((strcmp(path, "/api/config") == 0) && (strcmp(method, "GET") == 0))
    serveJson(connP, 200, configText());
  else if ((strcmp(path, "/api/brokers") == 0) && (strcmp(method, "POST") == 0))
    serveConfigChange(connP, configBrokerTouch);
  else if ((strcmp(path, "/api/brokers") == 0) && (strcmp(method, "DELETE") == 0))
    serveConfigChange(connP, configBrokerForget);
  else if ((strcmp(path, "/api/ui") == 0) && (strcmp(method, "PUT") == 0))
    serveConfigChange(connP, configUiSet);
  else
    serveError(connP, 404, "Not found", path);
}
