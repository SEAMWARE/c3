//
// FILE            proxy.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// /api/proxy/<path>?<query> - the same request to a broker, its answer back to the page
//
// The page names the broker in the X-C3-Broker header (http://host:port). The page and the API come
// from the same origin, so the browser has no CORS rule to apply, and the broker needs no --corsOrigin.
//
// GET: the NGSI-LD API (/ngsi-ld/...), /version, coraine's /admin/tenants (the tenants Connect offers) and
// /.well-known/oauth-protected-resource (RFC 9728: how to get a token the broker takes - Connect reads it on
// a 401).
// POST, PATCH, PUT, DELETE: the entities only (/ngsi-ld/v1/entities, /ngsi-ld/v1/entities/...), with the
// body and its Content-Type - and only from c3's own page: a write must carry an Origin of this machine
// (a browser always sends one on them; a page of another site cannot set it, nor the X-C3-Broker header
// without a preflight c3 never answers). The broker's access token (creds.c) goes with every request, as
// Authorization: Bearer; the tenant is the page's NGSILD-Tenant.
//
// The broker may be slow or not there at all, and the HTTP loop has one thread: the request is
// suspended (corHttpSuspend), a thread of its own sends it with corRest's client, and the answer goes
// back through corHttpResume - the one corHttp call made from another thread.
//
// corRest's multi engine, not corRestClientSend: a response of the multi engine stays valid until
// corRestClientMultiDestroy (its connection stays with the request), and it has a cap on the size of
// the body (corRestClientMultiMaxResponse).
//
#include <pthread.h>                             // pthread_create, pthread_attr_*
#include <stdio.h>                               // snprintf
#include <stdlib.h>                              // malloc, free
#include <string.h>                              // strlen, strcasecmp, memcpy

#include "corAlloc/corAlloc.h"                   // corAlloc
#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup
#include "corRest/corRestClient.h"               // corRestClient*
#include "corRest/corRestClientProxy.h"          // corRestClientProxyFromEnv

#include "c3.h"



// -----------------------------------------------------------------------------
//
// Limits
//
#define PROXY_TIMEOUT_MS      15000              // the whole request, connect included
#define PROXY_MAX_RESPONSE    (64 * 1024 * 1024) // a body larger than this is refused (502)
#define PROXY_URL_MAX         8192



// -----------------------------------------------------------------------------
//
// ProxyJob - what the thread needs, copied out of the request
//
typedef struct ProxyJob
{
  CorHttpConn*  connP;
  char          url[PROXY_URL_MAX];
  char          tenant[256];
  char*         auth;                            // "Bearer <token>" (malloc), or NULL
  CorRestVerb   verb;
  char*         body;                            // a write's body (malloc), or NULL
  int           bodyLen;
  char          contentType[128];
} ProxyJob;



// -----------------------------------------------------------------------------
//
// proxyInit - corRest's client, once
//
void proxyInit(void)
{
  corRestClientInit(8, 30, "c3/" C3_VERSION);
  corRestClientTlsInit();                        // the multi engine does not initialise TLS by itself: https brokers

  //
  // The proxies of the environment - https_proxy, http_proxy, no_proxy - for every request c3 sends: to a
  // broker, to an OpenID provider, to a verifier
  //
  char err[300];

  if (corRestClientProxyFromEnv(err, sizeof(err)) == false)
  {
    printf("c3: %s - no proxy is used\n", err);
    fflush(stdout);
  }
}



// -----------------------------------------------------------------------------
//
// jsonEscapeTo - 's' as the inside of a JSON string, in 'out'
//
static void jsonEscapeTo(const char* s, char* out, int outLen)
{
  int o = 0;

  for (; (*s != 0) && (o < outLen - 7); ++s)
  {
    unsigned char c = (unsigned char) *s;

    if ((c == '"') || (c == '\\'))
    {
      out[o++] = '\\';
      out[o++] = c;
    }
    else if (c < 0x20)
      o += snprintf(&out[o], outLen - o, "\\u%04x", c);
    else
      out[o++] = c;
  }

  out[o] = 0;
}



// -----------------------------------------------------------------------------
//
// answerError - the proxy's own error: 502, with what went wrong
//
// "broker": false tells the page the broker was not reached, as opposed to an error the broker sent.
//
static void answerError(ProxyJob* jobP, const char* what, const char* detail)
{
  CorHttpConn* connP = jobP->connP;
  char         urlE[PROXY_URL_MAX * 2];
  char         detailE[1024];
  int          size = sizeof(urlE) + sizeof(detailE) + 256;
  char*        body = corAlloc(&connP->alloc, size);

  jsonEscapeTo(jobP->url, urlE, sizeof(urlE));
  jsonEscapeTo(detail,    detailE, sizeof(detailE));

  int len = snprintf(body, size, "{\"title\": \"%s\", \"detail\": \"%s\", \"url\": \"%s\", \"broker\": false}", what, detailE, urlE);

  corHttpResponseStatus(connP, 502);
  corHttpResponseHeader(connP, "Content-Type", "application/json");
  corHttpResponseHeader(connP, "Cache-Control", "no-store");
  corHttpResponseBody(connP, body, len);
}



// -----------------------------------------------------------------------------
//
// clientError - a corRest client error code, in words
//
static const char* clientError(int error)
{
  switch (error)
  {
  case CORR_ERR_URL:           return "Bad broker URL";
  case CORR_ERR_CONNECT:       return "Broker not reachable";
  case CORR_ERR_TIMEOUT:       return "Broker did not answer in time";
  case CORR_ERR_SEND:          return "Request could not be sent";
  case CORR_ERR_RECV:          return "Broker closed the connection";
  case CORR_ERR_CLOSED:        return "Broker closed the connection";
  case CORR_ERR_PARSE:         return "Broker answer is not HTTP";
  case CORR_ERR_TLS:           return "TLS failed";
  case CORR_ERR_TOO_LARGE:     return "Broker answer is too large";
  case CORR_ERR_TOO_MANY_REDIR: return "Too many redirects";
  }

  return "Request failed";
}



// -----------------------------------------------------------------------------
//
// proxyThread - send, answer, resume
//
static void* proxyThread(void* vP)
{
  ProxyJob*          jobP  = (ProxyJob*) vP;
  CorHttpConn*       connP = jobP->connP;
  CorRestKeyValue    headers[4];
  int                headerCount = 0;
  CorRestClientMulti* multiP     = corRestClientMultiCreate(1);

  headers[headerCount].key   = (char*) "Accept";
  headers[headerCount].value = (char*) "application/json";
  ++headerCount;

  if (jobP->tenant[0] != 0)
  {
    headers[headerCount].key   = (char*) "NGSILD-Tenant";
    headers[headerCount].value = jobP->tenant;
    ++headerCount;
  }

  if (jobP->auth != NULL)
  {
    headers[headerCount].key   = (char*) "Authorization";
    headers[headerCount].value = jobP->auth;
    ++headerCount;
  }

  if (jobP->body != NULL)
  {
    headers[headerCount].key   = (char*) "Content-Type";
    headers[headerCount].value = jobP->contentType;
    ++headerCount;
  }

  if (multiP == NULL)
  {
    answerError(jobP, "Request failed", "out of memory");
    goto done;
  }

  corRestClientMultiMaxResponse(multiP, PROXY_MAX_RESPONSE);

  if (corRestClientMultiAdd(multiP, jobP->verb, jobP->url, headers, headerCount, jobP->body, jobP->bodyLen, NULL, NULL) < 0)
  {
    answerError(jobP, "Bad broker URL", "the URL could not be used");
    goto done;
  }

  corRestClientMultiPerform(multiP, PROXY_TIMEOUT_MS);

  CorRestClientResponse* respP = corRestClientMultiResponse(multiP, 0);

  if ((respP == NULL) || (respP->error != CORR_OK) || (respP->statusCode == 0))
  {
    int error = (respP != NULL) ? respP->error : CORR_ERR_CONNECT;
    if ((respP != NULL) && (error == CORR_OK))
      error = CORR_ERR_TIMEOUT;                  // never completed

    answerError(jobP, clientError(error), ((respP != NULL) && (respP->errorDetail[0] != 0)) ? respP->errorDetail : "");
    goto done;
  }

  //
  // The broker's answer: status, body, and the headers the page uses - copied into the connection's
  // allocator, as the response must outlive this function and the engine
  //
  corHttpResponseStatus(connP, respP->statusCode);
  corHttpResponseHeader(connP, "Cache-Control", "no-store");

  //
  // Every Link header, joined: a query answer has one for the pages (rel="next") and one for the
  // @context, and the page needs the first
  //
  int linkLen = 0;
  for (int ix = 0; ix < respP->headerCount; ix++)
  {
    if (strcasecmp(respP->headerV[ix].key, "Link") == 0)
      linkLen += strlen(respP->headerV[ix].value) + 2;
  }

  char* link = (linkLen > 0) ? corAlloc(&connP->alloc, linkLen + 1) : NULL;
  if (link != NULL)
    link[0] = 0;

  for (int ix = 0; ix < respP->headerCount; ix++)
  {
    const char* key   = respP->headerV[ix].key;
    const char* value = respP->headerV[ix].value;

    if (strcasecmp(key, "Link") == 0)
    {
      if (link[0] != 0)
        strcat(link, ", ");
      strcat(link, value);
    }
    else if (strcasecmp(key, "Content-Type") == 0)
      corHttpResponseHeader(connP, "Content-Type", corAllocStrdup(&connP->alloc, value));
    else if (strcasecmp(key, "NGSILD-Results-Count") == 0)
      corHttpResponseHeader(connP, "NGSILD-Results-Count", corAllocStrdup(&connP->alloc, value));
    else if (strcasecmp(key, "Location") == 0)
      corHttpResponseHeader(connP, "Location", corAllocStrdup(&connP->alloc, value));
  }

  if (link != NULL)
    corHttpResponseHeader(connP, "Link", link);

  if ((respP->body != NULL) && (respP->bodyLen > 0))
  {
    char* body = corAlloc(&connP->alloc, respP->bodyLen + 1);

    memcpy(body, respP->body, respP->bodyLen);
    body[respP->bodyLen] = 0;
    corHttpResponseBody(connP, body, respP->bodyLen);
  }

 done:
  if (multiP != NULL)
    corRestClientMultiDestroy(multiP);

  free(jobP->auth);
  free(jobP->body);
  free(jobP);
  corHttpResume(connP);
  return NULL;
}



// -----------------------------------------------------------------------------
//
// proxyRequest - called on the loop's thread with the path after /api/proxy
//
void proxyRequest(CorHttpConn* connP, const char* path)
{
  const char* broker = corHttpHeader(connP, "X-C3-Broker");
  const char* tenant = corHttpHeader(connP, "NGSILD-Tenant");

  const char*  method = connP->method.s;
  CorRestVerb  verb;

  if      (strcmp(method, "GET")    == 0) verb = CorVerbGet;
  else if (strcmp(method, "POST")   == 0) verb = CorVerbPost;
  else if (strcmp(method, "PATCH")  == 0) verb = CorVerbPatch;
  else if (strcmp(method, "PUT")    == 0) verb = CorVerbPut;
  else if (strcmp(method, "DELETE") == 0) verb = CorVerbDelete;
  else
  {
    serveError(connP, 405, "Method not allowed", "GET, POST, PATCH, PUT or DELETE");
    return;
  }

  if ((tenant != NULL) && (tenantValid(tenant) == false))
  {
    serveError(connP, 400, "Bad request", "NGSILD-Tenant: 1-255 printable characters, no blank");
    return;
  }

  if ((broker == NULL) || ((strncmp(broker, "http://", 7) != 0) && (strncmp(broker, "https://", 8) != 0)))
  {
    serveError(connP, 400, "Bad request", "X-C3-Broker must name the broker: http://host:port");
    return;
  }

  if (verb == CorVerbGet)
  {
    if ((strncmp(path, "/ngsi-ld/", 9) != 0) && (strcmp(path, "/version") != 0) && (strcmp(path, "/admin/tenants") != 0) &&
        (strcmp(path, "/.well-known/oauth-protected-resource") != 0))
    {
      serveError(connP, 403, "Forbidden", "the proxy forwards GET for the NGSI-LD API (/ngsi-ld/...), /version, /admin/tenants and /.well-known/oauth-protected-resource only");
      return;
    }
  }
  else
  {
    if ((strcmp(path, "/ngsi-ld/v1/entities") != 0) && (strncmp(path, "/ngsi-ld/v1/entities/", 21) != 0))
    {
      serveError(connP, 403, "Forbidden", "the proxy forwards writes for the entities only (/ngsi-ld/v1/entities...)");
      return;
    }

    const char* origin = corHttpHeader(connP, "Origin");
    if ((origin == NULL) ||
        ((strncmp(origin, "http://localhost:", 17) != 0) && (strncmp(origin, "http://127.0.0.1:", 17) != 0) && (strncmp(origin, "http://[::1]:", 13) != 0)))
    {
      serveError(connP, 403, "Forbidden", "a write must come from c3's own page (Origin: this machine)");
      return;
    }
  }

  ProxyJob* jobP = calloc(1, sizeof(ProxyJob));
  if (jobP == NULL)
  {
    serveError(connP, 500, "Internal error", "out of memory");
    return;
  }

  int blen = strlen(broker);
  while ((blen > 0) && (broker[blen - 1] == '/'))
    --blen;

  int n = snprintf(jobP->url, sizeof(jobP->url), "%.*s%s%s%s", blen, broker, path,
                   ((connP->query.s != NULL) && (connP->query.s[0] != 0)) ? "?" : "",
                   (connP->query.s != NULL) ? connP->query.s : "");
  if (n >= (int) sizeof(jobP->url))
  {
    free(jobP);
    serveError(connP, 414, "URI too long", "the broker URL and path are too long");
    return;
  }

  if (tenant != NULL)
    snprintf(jobP->tenant, sizeof(jobP->tenant), "%s", tenant);

  jobP->verb = verb;

  //
  // A write's body, as the page sent it, with its Content-Type (application/json by default)
  //
  if ((verb != CorVerbGet) && (verb != CorVerbDelete) && (connP->body.s != NULL) && (connP->body.len > 0))
  {
    const char* ct = corHttpHeader(connP, "Content-Type");

    jobP->body = malloc(connP->body.len + 1);
    if (jobP->body == NULL)
    {
      free(jobP);
      serveError(connP, 500, "Internal error", "out of memory");
      return;
    }
    memcpy(jobP->body, connP->body.s, connP->body.len);
    jobP->body[connP->body.len] = 0;
    jobP->bodyLen = connP->body.len;
    snprintf(jobP->contentType, sizeof(jobP->contentType), "%s", ((ct != NULL) && (strlen(ct) < sizeof(jobP->contentType))) ? ct : "application/json");
  }

  //
  // The broker's token - the broker as the configuration names it: no trailing slash
  //
  char brokerKey[512];
  snprintf(brokerKey, sizeof(brokerKey), "%.*s", blen, broker);

  char* token = credsToken(brokerKey, NULL);
  if (token != NULL)
  {
    int alen   = strlen(token) + 8;
    jobP->auth = malloc(alen);
    if (jobP->auth != NULL)
      snprintf(jobP->auth, alen, "Bearer %s", token);
    free(token);
  }

  jobP->connP = connP;

  pthread_t      tid;
  pthread_attr_t attr;

  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

  corHttpSuspend(connP);

  if (pthread_create(&tid, &attr, proxyThread, jobP) != 0)
  {
    free(jobP->auth);
    free(jobP->body);
    free(jobP);
    serveError(connP, 503, "Busy", "no thread for the request");
    corHttpResumeHere(connP);
  }

  pthread_attr_destroy(&attr);
}
