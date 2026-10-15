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
//   PUT    /api/brokers/types   {"url", "types"}: the entity types Connect loads from a broker
//   PUT    /api/brokers/connect {"url", "view", "map", "colourBy"}: Connect's view of a broker
//   GET    /api/brokers/tokens  which brokers have an access token, from where - never the token (creds.c)
//   PUT    /api/brokers/token   {"url", "token", "remember"}; DELETE {"url"} (creds.c)
//   PUT    /api/ui              {"lastPage"}
//   ...    /api/maps/...        the map's downloaded areas (maps.c)
//   GET    /api/proxy/<path>    the same GET to the broker named in X-C3-Broker (proxy.c)
//   GET    /api/live            the page's WebSocket: live values (live.c)
//   POST   /api/notify/<id>     a broker's notification for a session's HTTP subscription (live.c)
//   GET    /api/capabilities    what this machine can do (compile.c)
//   ...    /api/compile/...     Compile: the feature list (compile.c); the choice and the presets (config.c)
//   ...    /api/builds...       Compile: the builds - start, follow, cancel, delete (compile.c)
//   ...    /api/run...          Run: brokers and their services - start, stop, follow (run.c)
//   GET    /<file>              a file of the www directory; / is index.html (Range taken)
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
#include <stdlib.h>                              // strtoll
#include <string.h>                              // strcmp, strncmp, strstr, strrchr
#include <sys/socket.h>                          // getpeername
#include <sys/stat.h>                            // fstat
#include <unistd.h>                              // read, close

#include "corAlloc/corAlloc.h"                   // corAlloc
#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup

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
  if (strcmp(dot, ".mjs")   == 0)     return "text/javascript; charset=utf-8";
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
// rangeParse - a Range header: one range of bytes in a file of 'size' bytes
//
// "bytes=a-b", "bytes=a-", "bytes=-n". Answers 1 with [*fromP, *toP] (to clamped to the file), 0 when
// there is no Range to apply (none, or one c3 does not take: several ranges, another unit), -1 when the
// range starts past the end (416).
//
static int rangeParse(const char* h, int64_t size, int64_t* fromP, int64_t* toP)
{
  if ((h == NULL) || (strncmp(h, "bytes=", 6) != 0) || (strchr(h, ',') != NULL))
    return 0;

  const char* p = h + 6;
  char*       end;

  if (*p == '-')
  {
    long long n = strtoll(p + 1, &end, 10);
    if ((end == p + 1) || (*end != 0) || (n <= 0))
      return 0;
    if (size == 0)
      return -1;
    *fromP = (n >= size) ? 0 : size - n;
    *toP   = size - 1;
    return 1;
  }

  long long a = strtoll(p, &end, 10);
  if ((end == p) || (*end != '-') || (a < 0))
    return 0;

  p = end + 1;
  long long b = size - 1;
  if (*p != 0)
  {
    b = strtoll(p, &end, 10);
    if ((end == p) || (*end != 0) || (b < a))
      return 0;
  }

  if (a >= size)
    return -1;

  *fromP = a;
  *toP   = (b >= size) ? size - 1 : b;
  return 1;
}



// -----------------------------------------------------------------------------
//
// serveFileRange - a file, whole or the part a Range header asks for (206, Content-Range)
//
// The ETag (size and modification time) lets the reader see the file change under it.
//
// Built on a corHttp with file responses (corHttpResponseFile - COR_HTTP_STREAM_PENDING_MAX is its
// mark): the bytes are sent from the file, whole or the range, whatever the size. On a corHttp without
// them, the part is read into memory: a request without Range gets the whole file if it has 'maxWhole'
// bytes or fewer (0: 32 MiB), a larger one is read by ranges only - the page's PMTiles reader does that -
// and a range is at most 16 MiB.
//
#define RANGE_MAX  (16 * 1024 * 1024)

void serveFileRange(CorHttpConn* connP, const char* file, const char* type, int maxWhole)
{
  int fd = open(file, O_RDONLY);
  if (fd == -1)
  {
    serveError(connP, 404, "Not found", strrchr(file, '/') ? strrchr(file, '/') + 1 : file);
    return;
  }

  struct stat st;
  if ((fstat(fd, &st) == -1) || (!S_ISREG(st.st_mode)))
  {
    close(fd);
    serveError(connP, 404, "Not found", strrchr(file, '/') ? strrchr(file, '/') + 1 : file);
    return;
  }

  if (maxWhole <= 0)
    maxWhole = 32 * 1024 * 1024;

  int64_t size = st.st_size;
  int64_t from = 0;
  int64_t to   = size - 1;
  int     r    = rangeParse(corHttpHeader(connP, "Range"), size, &from, &to);
  char*   etag = corAlloc(&connP->alloc, 64);

  snprintf(etag, 64, "\"%llx-%llx\"", (unsigned long long) size, (unsigned long long) st.st_mtime);

  if (r == -1)
  {
    char* cr = corAlloc(&connP->alloc, 64);
    close(fd);
    snprintf(cr, 64, "bytes */%lld", (long long) size);
    corHttpResponseStatus(connP, 416);
    corHttpResponseHeader(connP, "Content-Range", cr);
    corHttpResponseHeader(connP, "Accept-Ranges", "bytes");
    corHttpResponseHeader(connP, "ETag", etag);
    corHttpResponseBody(connP, (char*) "", 0);
    return;
  }

#ifdef COR_HTTP_STREAM_PENDING_MAX
  (void) maxWhole;

  if (r == 1)
  {
    char* cr = corAlloc(&connP->alloc, 96);
    snprintf(cr, 96, "bytes %lld-%lld/%lld", (long long) from, (long long) to, (long long) size);
    corHttpResponseStatus(connP, 206);
    corHttpResponseHeader(connP, "Content-Range", cr);
  }
  else
    corHttpResponseStatus(connP, 200);

  corHttpResponseHeader(connP, "Content-Type", type);
  corHttpResponseHeader(connP, "Accept-Ranges", "bytes");
  corHttpResponseHeader(connP, "ETag", etag);
  corHttpResponseHeader(connP, "Cache-Control", "no-cache");
  corHttpResponseFile(connP, fd, from, (size == 0) ? 0 : to - from + 1);   // the fd is corHttp's now
  return;
#endif

  if ((r == 0) && (size > maxWhole))
  {
    close(fd);
    serveError(connP, 413, "Too large", "the file is read by ranges (Range: bytes=a-b)");
    return;
  }

  if ((r == 1) && (to - from + 1 > RANGE_MAX))
    to = from + RANGE_MAX - 1;

  int64_t len  = (size == 0) ? 0 : to - from + 1;
  char*   body = corAlloc(&connP->alloc, len + 1);
  int64_t got  = 0;

  while (got < len)
  {
    ssize_t n = pread(fd, body + got, len - got, from + got);
    if (n <= 0)
    {
      if ((n == -1) && (errno == EINTR))
        continue;
      break;
    }
    got += n;
  }
  close(fd);

  if (got != len)
  {
    serveError(connP, 500, "Read error", strrchr(file, '/') ? strrchr(file, '/') + 1 : file);
    return;
  }

  if (r == 1)
  {
    char* cr = corAlloc(&connP->alloc, 96);
    snprintf(cr, 96, "bytes %lld-%lld/%lld", (long long) from, (long long) to, (long long) size);
    corHttpResponseStatus(connP, 206);
    corHttpResponseHeader(connP, "Content-Range", cr);
  }
  else
    corHttpResponseStatus(connP, 200);

  corHttpResponseHeader(connP, "Content-Type", type);
  corHttpResponseHeader(connP, "Accept-Ranges", "bytes");
  corHttpResponseHeader(connP, "ETag", etag);
  corHttpResponseHeader(connP, "Cache-Control", "no-cache");
  corHttpResponseBody(connP, body, (int) len);
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
  serveFileRange(connP, file, contentType(file), 0);
}



// -----------------------------------------------------------------------------
//
// configCopy - the configuration's text, copied into the connection: the response is sent after the
// callback returns, and a later change frees the text it was taken from
//
static char* configCopy(CorHttpConn* connP)
{
  return corAllocStrdup(&connP->alloc, configText());
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

  serveJson(connP, 200, configCopy(connP));
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
  else if (strcmp(path, "/api/live") == 0)
    liveUpgrade(connP);
  else if (strncmp(path, "/api/notify/", 12) == 0)
    liveNotify(connP, &path[12]);
  else if ((strcmp(path, "/api/maps") == 0) || (strncmp(path, "/api/maps/", 10) == 0))
    mapsRequest(connP, path);
  else if ((strcmp(path, "/api/compile/choice") == 0) && (strcmp(method, "PUT") == 0))
    serveConfigChange(connP, configCompileChoice);
  else if ((strcmp(path, "/api/compile/presets") == 0) && (strcmp(method, "PUT") == 0))
    serveConfigChange(connP, configCompilePreset);
  else if ((strcmp(path, "/api/compile/presets") == 0) && (strcmp(method, "DELETE") == 0))
    serveConfigChange(connP, configCompilePresetDelete);
  else if ((strcmp(path, "/api/capabilities") == 0) || (strncmp(path, "/api/compile/", 13) == 0) ||
           (strcmp(path, "/api/builds") == 0) || (strncmp(path, "/api/builds/", 12) == 0))
    compileRequest(connP, path);
  else if ((strcmp(path, "/api/run") == 0) || (strncmp(path, "/api/run/", 9) == 0))
    runRequest(connP, path);
  else if ((strcmp(path, "/api/status") == 0) && (strcmp(method, "GET") == 0))
    serveStatus(connP);
  else if ((strcmp(path, "/api/config") == 0) && (strcmp(method, "GET") == 0))
    serveJson(connP, 200, configCopy(connP));
  else if ((strcmp(path, "/api/brokers") == 0) && (strcmp(method, "POST") == 0))
    serveConfigChange(connP, configBrokerTouch);
  else if ((strcmp(path, "/api/brokers") == 0) && (strcmp(method, "DELETE") == 0))
    serveConfigChange(connP, configBrokerForget);
  else if ((strcmp(path, "/api/brokers/types") == 0) && (strcmp(method, "PUT") == 0))
    serveConfigChange(connP, configBrokerTypes);
  else if ((strcmp(path, "/api/brokers/connect") == 0) && (strcmp(method, "PUT") == 0))
    serveConfigChange(connP, configBrokerConnect);
  else if ((strcmp(path, "/api/brokers/token") == 0) || (strcmp(path, "/api/brokers/tokens") == 0))
    credsRequest(connP, path);
  else if ((strcmp(path, "/api/ui") == 0) && (strcmp(method, "PUT") == 0))
    serveConfigChange(connP, configUiSet);
  else
    serveError(connP, 404, "Not found", path);
}
