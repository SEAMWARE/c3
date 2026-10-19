//
// FILE            live.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Live values - the changes of the entities Connect shows, pushed to the page as they happen
//
//   GET  /api/live              the page's WebSocket to the backend (one per page)
//   POST /api/notify/<session>  a broker's notification, for a subscription made over HTTP
//
// The page says what it shows - {"op": "watch", "broker", "tenant", "types"} - and the backend keeps ONE
// subscription on that broker, in that tenant, for those types, every attribute, every change (entityCreated,
// entityDeleted, attributeCreated/Updated/Deleted), normalized. Two ways to get its notifications:
//
//   (a) the broker's WebSocket transport (coraine --transports ws): the backend opens a WebSocket to
//       GET /ngsi-ld/v1/ws, creates the subscription over it, and the notifications come back on the
//       same socket. The broker deletes the subscription itself when the socket closes - also when
//       c3 dies.
//   (b) any other broker: an ordinary HTTP subscription whose endpoint is this backend,
//       http://127.0.0.1:<port>/api/notify/<session> - the broker must reach it (a broker on this
//       machine).
//
// Every request to the broker carries the tenant (NGSILD-Tenant - over the WebSocket in each message's
// metadata, as coraine reads it) and the broker's access token (creds.c, Authorization: Bearer).
//
// (a) is tried first; a broker that does not upgrade GET /ngsi-ld/v1/ws gets (b). Whichever it is, each
// notification goes to the page as {"op": "notify", "broker", "message": {"body": <Notification>}}.
//
// No subscription is left behind: a changed pick creates the new one, then deletes the old; the page
// closing (its WebSocket) or the backend stopping deletes it. An HTTP subscription of an earlier run that
// died (named "c3-live:<port>", notifying this port) is deleted when the backend starts (the brokers of
// the configuration) and before the first subscription on a broker.
//
// Alerts: the page also sends its alert rules - {"op": "alerts", "broker", "tenant", "rules": [{"id", "type",
// "q"}]} - and the backend makes each one a subscription of its own (the type, the q, the same endpoint as
// the watch), on that broker while it is watched. A notification of one of them goes to the page as
// {"op": "alert", "broker", "rule", "message"} - not as a "notify": the change itself comes with the watch's
// subscription. The answer to the op is {"op": "alerts", "broker", "installed": [{"rule", "subscription"}],
// "failed": [{"rule", "detail"}]}, again after a watch that started over. The rules are deleted with the
// watch; kept, and installed again, when the same broker is watched again.
//
// Threads: one per page (reads its socket, runs its watch/unwatch - each may wait for the broker), one
// per broker WebSocket (reads it: responses, notifications). Writes to a socket from any thread, under
// its write lock.
//
#include <stdio.h>                               // snprintf, printf
#include <stdlib.h>                              // malloc, calloc, free
#include <string.h>                              // strcmp, strncmp, strlen, strrchr
#include <strings.h>                             // strcasecmp, strcasestr
#include <sys/random.h>                          // getrandom
#include <sys/socket.h>                          // shutdown
#include <time.h>                                // clock_gettime
#include <unistd.h>                              // close, usleep

#include "corAlloc/corAlloc.h"                   // corAlloc
#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup
#include "corJson/CorJson.h"                     // CorJson
#include "corJson/corJsonCreate.h"               // corJsonCreate
#include "corJson/corJsonParse.h"                // corJsonParse
#include "corTree/corTreeLookup.h"               // corTreeLookup
#include "corRest/corRestClient.h"               // corRestClient*

#include "c3.h"



// -----------------------------------------------------------------------------
//
// Limits
//
#define LIVE_TIMEOUT_MS      10000               // a request to the broker, over HTTP or the WebSocket
#define LIVE_CONNECT_MS      3000                // the WebSocket's TCP connect and handshake
#define LIVE_PAGE_MAX        (1024 * 1024)       // a message from the page
#define LIVE_BROKER_MAX      (64 * 1024 * 1024)  // a message from the broker
#define LIVE_TYPES_MAX       1000
#define LIVE_RULES_MAX       32                  // alert rules per page
#define LIVE_NAME            "c3-live"           // the subscriptions' name starts with it: c3-live:<port>



// -----------------------------------------------------------------------------
//
// LiveMode -
//
typedef enum LiveMode
{
  LiveOff  = 0,
  LiveWs   = 1,                                  // (a) the broker's WebSocket transport
  LiveHttp = 2                                   // (b) an HTTP subscription notifying /api/notify/<session>
} LiveMode;

static const char* modeName[] = { "off", "ws", "http" };



// -----------------------------------------------------------------------------
//
// LiveRule - an alert rule of the page, and its subscription
//
typedef struct LiveRule
{
  char              id[65];
  char*             type;                        // malloc
  char*             q;                           // malloc, NULL: none
  char              subId[512];                  // "": not installed
} LiveRule;



// -----------------------------------------------------------------------------
//
// Live - a page's session
//
typedef struct Live
{
  char              id[33];                      // random, 128 bits: the notification endpoint's last part
  WsConn            page;
  struct Live*      next;

  //
  // Set by the page's thread; read under 'lock' by the others
  //
  pthread_mutex_t   lock;
  pthread_cond_t    cond;
  char              broker[512];
  char              tenant[256];                 // "": the default tenant
  char*             brokerE;                     // the broker, JSON-escaped (malloc)
  char*             typesJson;                   // ["A", "B"] (malloc)
  LiveMode          mode;
  char              subId[512];
  char              why[600];                    // why not the WebSocket, when (b)

  //
  // The alert rules, for 'rulesBroker' in 'rulesTenant'
  //
  LiveRule          rules[LIVE_RULES_MAX];
  int               nRules;
  char              rulesBroker[512];
  char              rulesTenant[256];

  //
  // (a) the broker's WebSocket
  //
  WsConn            bws;
  bool              bwsOpen;
  bool              bwsClosed;                   // its reader saw the end
  bool              bwsClosing;                  // closed by us: the page is not told it was lost
  pthread_t         bwsThread;
  char              connection[256];             // the broker's name for the connection (the endpoint)
  int               reqNo;
  char              waitId[32];                  // the requestId waited for
  bool              gotResp;
  int               respStatus;
  char              respLocation[512];
  char              respDetail[600];
} Live;

static Live*            lives      = NULL;
static int              liveCount  = 0;
static pthread_mutex_t  livesLock  = PTHREAD_MUTEX_INITIALIZER;
static char             notifyPrefix[128];       // http://127.0.0.1:<port>/api/notify/
static char             subName[64];             // c3-live:<port>



// -----------------------------------------------------------------------------
//
// jsonEscapeDup - 's' as the inside of a JSON string, malloc'ed
//
static char* jsonEscapeDup(const char* s)
{
  char* out = malloc(strlen(s) * 6 + 1);
  int   o   = 0;

  if (out == NULL)
    return NULL;

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
// Parsed - a JSON text parsed in an allocator of its own
//
typedef struct Parsed
{
  CorAlloc  alloc;
  char      buf[16 * 1024];
  CorJson   json;
  CorNode*  treeP;
} Parsed;

static CorNode* parse(Parsed* pP, const char* text)
{
  corAllocBufferInit(&pP->alloc, pP->buf, sizeof(pP->buf), 256 * 1024, NULL, "c3 live");
  corJsonCreate(&pP->json, &pP->alloc);

  char* copy = corAllocStrdup(&pP->alloc, text);
  pP->treeP  = (copy != NULL) ? corJsonParse(&pP->json, copy) : NULL;

  return pP->treeP;
}

static void parsedRelease(Parsed* pP)
{
  corAllocBufferReset(&pP->alloc, false);
}

static const char* stringOf(CorNode* objectP, const char* name)
{
  CorNode* nodeP = (objectP != NULL) && (objectP->type == CorObject) ? corTreeLookup(objectP, name) : NULL;
  return ((nodeP != NULL) && (nodeP->type == CorString)) ? nodeP->value.s : NULL;
}



// -----------------------------------------------------------------------------
//
// HttpAnswer - a request to a broker over HTTP
//
typedef struct HttpAnswer
{
  int    status;                                 // 0: not reached
  char   location[512];
  char*  body;                                   // malloc'ed, zero-terminated, or NULL
  char   error[256];
} HttpAnswer;

static void httpCall(CorRestVerb verb, const char* broker, const char* tenant, const char* url, const char* body, int timeoutMs, HttpAnswer* aP)
{
  CorRestKeyValue     headers[4];
  int                 headerCount = 0;
  CorRestClientMulti* multiP      = corRestClientMultiCreate(1);

  memset(aP, 0, sizeof(*aP));

  headers[headerCount].key   = (char*) "Accept";
  headers[headerCount].value = (char*) "application/json";
  ++headerCount;

  if (body != NULL)
  {
    headers[headerCount].key   = (char*) "Content-Type";
    headers[headerCount].value = (char*) "application/json";
    ++headerCount;
  }

  if ((tenant != NULL) && (tenant[0] != 0))
  {
    headers[headerCount].key   = (char*) "NGSILD-Tenant";
    headers[headerCount].value = (char*) tenant;
    ++headerCount;
  }

  char* token = credsToken(broker, NULL);
  char* auth  = NULL;
  if (token != NULL)
  {
    int alen = strlen(token) + 8;
    auth     = malloc(alen);
    if (auth != NULL)
    {
      snprintf(auth, alen, "Bearer %s", token);
      headers[headerCount].key   = (char*) "Authorization";
      headers[headerCount].value = auth;
      ++headerCount;
    }
    free(token);
  }

  if (multiP == NULL)
  {
    snprintf(aP->error, sizeof(aP->error), "out of memory");
    free(auth);
    return;
  }

  corRestClientMultiMaxResponse(multiP, LIVE_BROKER_MAX);

  if (corRestClientMultiAdd(multiP, verb, url, headers, headerCount, body, (body != NULL) ? strlen(body) : 0, NULL, NULL) < 0)
  {
    snprintf(aP->error, sizeof(aP->error), "the URL could not be used");
    corRestClientMultiDestroy(multiP);
    free(auth);
    return;
  }

  corRestClientMultiPerform(multiP, timeoutMs);

  CorRestClientResponse* respP = corRestClientMultiResponse(multiP, 0);

  if ((respP == NULL) || (respP->error != CORR_OK) || (respP->statusCode == 0))
    snprintf(aP->error, sizeof(aP->error), "%s", ((respP != NULL) && (respP->errorDetail[0] != 0)) ? respP->errorDetail : "the broker did not answer");
  else
  {
    aP->status = respP->statusCode;

    for (int ix = 0; ix < respP->headerCount; ix++)
    {
      if (strcasecmp(respP->headerV[ix].key, "Location") == 0)
        snprintf(aP->location, sizeof(aP->location), "%s", respP->headerV[ix].value);
    }

    if ((respP->body != NULL) && (respP->bodyLen > 0))
    {
      aP->body = malloc(respP->bodyLen + 1);
      if (aP->body != NULL)
      {
        memcpy(aP->body, respP->body, respP->bodyLen);
        aP->body[respP->bodyLen] = 0;
      }
    }
  }

  corRestClientMultiDestroy(multiP);
  free(auth);
}



// -----------------------------------------------------------------------------
//
// problemText - a broker's error answer, in one line: "<title> - <detail>", or the start of the body
//
static void problemText(const char* body, char* out, int outLen)
{
  out[0] = 0;
  if (body == NULL)
    return;

  Parsed   p;
  CorNode* treeP = parse(&p, body);

  const char* title  = stringOf(treeP, "title");
  const char* detail = stringOf(treeP, "detail");

  if ((title != NULL) || (detail != NULL))
    snprintf(out, outLen, "%s%s%s", (title != NULL) ? title : "", ((title != NULL) && (detail != NULL)) ? " - " : "", (detail != NULL) ? detail : "");
  else
    snprintf(out, outLen, "%.300s", body);

  parsedRelease(&p);
}



// -----------------------------------------------------------------------------
//
// sessionLive - is 'id' a session of this backend?
//
static bool sessionLive(const char* id, int idLen)
{
  bool found = false;

  pthread_mutex_lock(&livesLock);
  for (Live* s = lives; s != NULL; s = s->next)
  {
    if (((int) strlen(s->id) == idLen) && (strncmp(s->id, id, idLen) == 0))
    {
      found = true;
      break;
    }
  }
  pthread_mutex_unlock(&livesLock);

  return found;
}



// -----------------------------------------------------------------------------
//
// sweep - the HTTP subscriptions an earlier run of c3 on this port left on 'broker': named c3-live,
// notifying this port, for a session that is not ours. Once per broker and run.
//
static pthread_mutex_t sweepLock = PTHREAD_MUTEX_INITIALIZER;
static char            swept[64][800];         // "<broker> <tenant>"
static int             sweptN = 0;

static void sweep(const char* broker, const char* tenant, int timeoutMs)
{
  char key[800];
  snprintf(key, sizeof(key), "%s %s", broker, tenant);

  pthread_mutex_lock(&sweepLock);
  for (int ix = 0; ix < sweptN; ix++)
  {
    if (strcmp(swept[ix], key) == 0)
    {
      pthread_mutex_unlock(&sweepLock);
      return;
    }
  }
  if (sweptN < 64)
    snprintf(swept[sweptN++], sizeof(swept[0]), "%s", key);
  pthread_mutex_unlock(&sweepLock);

  char       url[1024];
  HttpAnswer a;

  snprintf(url, sizeof(url), "%s/ngsi-ld/v1/subscriptions?limit=1000", broker);
  httpCall(CorVerbGet, broker, tenant, url, NULL, timeoutMs, &a);
  if (a.status == 400)                           // a broker with a lower maximum
  {
    free(a.body);
    snprintf(url, sizeof(url), "%s/ngsi-ld/v1/subscriptions?limit=100", broker);
    httpCall(CorVerbGet, broker, tenant, url, NULL, timeoutMs, &a);
  }

  if ((a.status != 200) || (a.body == NULL))
  {
    free(a.body);
    return;
  }

  Parsed   p;
  CorNode* listP   = parse(&p, a.body);
  int      deleted = 0;
  int      plen    = strlen(notifyPrefix);

  if ((listP != NULL) && (listP->type == CorArray))
  {
    for (CorNode* subP = listP->value.head; subP != NULL; subP = subP->next)
    {
      const char* id   = stringOf(subP, "id");
      const char* name = stringOf(subP, "subscriptionName");
      CorNode*    nP   = (subP->type == CorObject) ? corTreeLookup(subP, "notification") : NULL;
      CorNode*    eP   = ((nP != NULL) && (nP->type == CorObject)) ? corTreeLookup(nP, "endpoint") : NULL;
      const char* uri  = stringOf(eP, "uri");

      if ((id == NULL) || (name == NULL) || (uri == NULL))
        continue;
      if ((strncmp(name, LIVE_NAME, strlen(LIVE_NAME)) != 0) || (strncmp(uri, notifyPrefix, plen) != 0))
        continue;
      if (sessionLive(&uri[plen], strlen(&uri[plen])))
        continue;

      HttpAnswer d;
      snprintf(url, sizeof(url), "%s/ngsi-ld/v1/subscriptions/%s", broker, id);
      httpCall(CorVerbDelete, broker, tenant, url, NULL, timeoutMs, &d);
      if ((d.status == 204) || (d.status == 200))
        ++deleted;
      free(d.body);
    }
  }

  if (deleted > 0)
  {
    printf("c3 live: %s%s%s - %d subscription%s of an earlier run deleted\n", broker, (tenant[0] != 0) ? ", tenant " : "", tenant, deleted, (deleted == 1) ? "" : "s");
    fflush(stdout);
  }

  parsedRelease(&p);
  free(a.body);
}



// -----------------------------------------------------------------------------
//
// pageSend - a message to the page
//
static void pageSend(Live* s, const char* text)
{
  wsSendText(&s->page, text, strlen(text));
}



// -----------------------------------------------------------------------------
//
// statusSend - what the session does now: {"op": "status", "broker", "mode", "subscription", "types", "why", "detail"}
//
static void statusSend(Live* s, const char* detail)
{
  char* whyE    = jsonEscapeDup(s->why);
  char* detailE = jsonEscapeDup((detail != NULL) ? detail : "");
  char* subE    = jsonEscapeDup(s->subId);
  int   size    = 512 + strlen(whyE) + strlen(detailE) + strlen(subE) + ((s->brokerE != NULL) ? strlen(s->brokerE) : 0) + ((s->typesJson != NULL) ? strlen(s->typesJson) : 0);
  char* out     = malloc(size);

  if (out != NULL)
  {
    snprintf(out, size, "{\"op\": \"status\", \"broker\": \"%s\", \"mode\": \"%s\", \"subscription\": %s%s%s, \"types\": %s, \"why\": \"%s\", \"detail\": \"%s\"}",
             (s->brokerE != NULL) ? s->brokerE : "",
             modeName[s->mode],
             (s->subId[0] != 0) ? "\"" : "", (s->subId[0] != 0) ? subE : "null", (s->subId[0] != 0) ? "\"" : "",
             (s->typesJson != NULL) ? s->typesJson : "[]",
             whyE, detailE);
    pageSend(s, out);
    free(out);
  }

  free(whyE);
  free(detailE);
  free(subE);
}



// -----------------------------------------------------------------------------
//
// notifyForward - a notification to the page: {"op": "notify", "broker", "message": <message>}
//
// 'message' is the broker's WebSocket message as it came ({"metadata", "body"}), or {"body": <the
// HTTP notification's body>} - forwarded as text, not parsed and rendered again.
//
static void notifyForward(Live* s, const char* brokerE, const char* pre, const char* message, const char* post)
{
  int   size = strlen(message) + strlen(brokerE) + strlen(pre) + strlen(post) + 64;
  char* out  = malloc(size);

  if (out == NULL)
    return;

  snprintf(out, size, "{\"op\": \"notify\", \"broker\": \"%s\", \"message\": %s%s%s}", brokerE, pre, message, post);
  pageSend(s, out);
  free(out);
}



// -----------------------------------------------------------------------------
//
// alertForward - an alert rule's notification: {"op": "alert", "broker", "rule", "message": <message>}
//
static void alertForward(Live* s, const char* brokerE, const char* rule, const char* pre, const char* message, const char* post)
{
  int   size = strlen(message) + strlen(brokerE) + strlen(rule) + strlen(pre) + strlen(post) + 80;
  char* out  = malloc(size);

  if (out == NULL)
    return;

  snprintf(out, size, "{\"op\": \"alert\", \"broker\": \"%s\", \"rule\": \"%s\", \"message\": %s%s%s}", brokerE, rule, pre, message, post);
  pageSend(s, out);
  free(out);
}



// -----------------------------------------------------------------------------
//
// ruleOf - the alert rule a notification is for (its subscriptionId), copied to 'out'; false: none -
// the watch's own. Under the session's lock.
//
static bool ruleOf(Live* s, CorNode* bodyP, char* out, int outLen)
{
  const char* subId = stringOf(bodyP, "subscriptionId");

  if (subId == NULL)
    return false;

  for (int ix = 0; ix < s->nRules; ix++)
  {
    if ((s->rules[ix].subId[0] != 0) && (strcmp(s->rules[ix].subId, subId) == 0))
    {
      snprintf(out, outLen, "%s", s->rules[ix].id);
      return true;
    }
  }

  return false;
}



// -----------------------------------------------------------------------------
//
// bwsReader - the broker's WebSocket: the connection's name, the responses, the notifications
//
static void* bwsReader(void* vP)
{
  Live* s = (Live*) vP;

  for (;;)
  {
    char* data;
    int   len;

    if (wsRead(&s->bws, &data, &len, LIVE_BROKER_MAX) != 1)
      break;

    Parsed      p;
    CorNode*    treeP = parse(&p, data);
    CorNode*    mdP   = ((treeP != NULL) && (treeP->type == CorObject)) ? corTreeLookup(treeP, "metadata") : NULL;
    const char* conn  = stringOf(mdP, "connection");
    const char* reqId = stringOf(mdP, "requestId");

    if (conn != NULL)
    {
      pthread_mutex_lock(&s->lock);
      snprintf(s->connection, sizeof(s->connection), "%s", conn);
      pthread_cond_broadcast(&s->cond);
      pthread_mutex_unlock(&s->lock);
    }
    else if (reqId != NULL)
    {
      CorNode* statusP = corTreeLookup(mdP, "status");
      CorNode* bodyP   = corTreeLookup(treeP, "body");

      pthread_mutex_lock(&s->lock);
      if (strcmp(reqId, s->waitId) == 0)
      {
        const char* loc    = stringOf(mdP, "Location");
        const char* title  = stringOf(bodyP, "title");
        const char* detail = stringOf(bodyP, "detail");

        s->respStatus = ((statusP != NULL) && (statusP->type == CorInt)) ? (int) statusP->value.i : 0;
        snprintf(s->respLocation, sizeof(s->respLocation), "%s", (loc != NULL) ? loc : "");
        snprintf(s->respDetail, sizeof(s->respDetail), "%s%s%s", (title != NULL) ? title : "", ((title != NULL) && (detail != NULL)) ? " - " : "", (detail != NULL) ? detail : "");
        s->gotResp = true;
        pthread_cond_broadcast(&s->cond);
      }
      pthread_mutex_unlock(&s->lock);
    }
    else if ((treeP != NULL) && (corTreeLookup(treeP, "body") != NULL))
    {
      char rule[65];

      pthread_mutex_lock(&s->lock);
      char* brokerE = (s->brokerE != NULL) ? strdup(s->brokerE) : strdup("");
      bool  alert   = ruleOf(s, corTreeLookup(treeP, "body"), rule, sizeof(rule));
      pthread_mutex_unlock(&s->lock);

      if (alert)
        alertForward(s, brokerE, rule, "", data, "");
      else
        notifyForward(s, brokerE, "", data, "");
      free(brokerE);
    }

    parsedRelease(&p);
    free(data);
  }

  pthread_mutex_lock(&s->lock);
  s->bwsClosed = true;
  pthread_cond_broadcast(&s->cond);
  bool  closing = s->bwsClosing;
  char* brokerE = (s->brokerE != NULL) ? strdup(s->brokerE) : strdup("");
  pthread_mutex_unlock(&s->lock);

  if (closing)
  {
    free(brokerE);
    return NULL;
  }

  //
  // The page hears of it, and watches again when it wants to
  //
  char msg[1200];
  snprintf(msg, sizeof(msg), "{\"op\": \"lost\", \"broker\": \"%s\", \"detail\": \"the broker closed the WebSocket\"}", brokerE);
  pageSend(s, msg);
  free(brokerE);

  return NULL;
}



// -----------------------------------------------------------------------------
//
// deadline - now + ms, for pthread_cond_timedwait
//
static struct timespec deadline(int ms)
{
  struct timespec t;

  clock_gettime(CLOCK_REALTIME, &t);
  t.tv_sec  += ms / 1000;
  t.tv_nsec += (long) (ms % 1000) * 1000000L;
  if (t.tv_nsec >= 1000000000L)
  {
    t.tv_sec  += 1;
    t.tv_nsec -= 1000000000L;
  }

  return t;
}



// -----------------------------------------------------------------------------
//
// bwsRequest - a request over the broker's WebSocket, and its response: the status (0: none in time,
// or the socket closed), Location and the error in 'locOut' / 'detailOut'
//
static int bwsRequest(Live* s, const char* method, const char* path, const char* body, char* locOut, int locLen, char* detailOut, int detailLen)
{
  char  reqId[32];
  char* pathE = jsonEscapeDup(path);
  char* token = credsToken(s->broker, NULL);    // b64token characters: nothing to escape
  char* extraE = (s->tenant[0] != 0) ? jsonEscapeDup(s->tenant) : NULL;
  int   size  = 512 + strlen(pathE) + ((body != NULL) ? strlen(body) : 0) + ((token != NULL) ? strlen(token) : 0) + ((extraE != NULL) ? strlen(extraE) : 0);
  char* msg   = malloc(size);
  char* extra = malloc(size);

  locOut[0]    = 0;
  detailOut[0] = 0;

  if ((msg == NULL) || (extra == NULL))
  {
    free(msg);
    free(extra);
    free(token);
    free(extraE);
    free(pathE);
    snprintf(detailOut, detailLen, "out of memory");
    return 0;
  }

  pthread_mutex_lock(&s->lock);
  snprintf(reqId, sizeof(reqId), "c3-%d", ++s->reqNo);
  snprintf(s->waitId, sizeof(s->waitId), "%s", reqId);
  s->gotResp = false;
  pthread_mutex_unlock(&s->lock);

  //
  // The tenant and the token, in the metadata: a connection carries neither (coraine, doc/websocket.md)
  //
  int eo = 0;
  extra[0] = 0;
  if (extraE != NULL)
    eo += snprintf(&extra[eo], size - eo, ", \"NGSILD-Tenant\": \"%s\"", extraE);
  if (token != NULL)
    snprintf(&extra[eo], size - eo, ", \"Authorization\": \"Bearer %s\"", token);

  if (body != NULL)
    snprintf(msg, size, "{\"metadata\": {\"method\": \"%s\", \"path\": \"%s\", \"requestId\": \"%s\", \"Content-Type\": \"application/json\"%s}, \"body\": %s}", method, pathE, reqId, extra, body);
  else
    snprintf(msg, size, "{\"metadata\": {\"method\": \"%s\", \"path\": \"%s\", \"requestId\": \"%s\"%s}}", method, pathE, reqId, extra);
  free(pathE);
  free(extra);
  free(extraE);
  free(token);

  bool sent = wsSendText(&s->bws, msg, strlen(msg));
  free(msg);

  if (sent == false)
  {
    snprintf(detailOut, detailLen, "the request could not be sent on the WebSocket");
    return 0;
  }

  struct timespec until  = deadline(LIVE_TIMEOUT_MS);
  int             status = 0;

  pthread_mutex_lock(&s->lock);
  while ((s->gotResp == false) && (s->bwsClosed == false))
  {
    if (pthread_cond_timedwait(&s->cond, &s->lock, &until) != 0)
      break;
  }

  if (s->gotResp)
  {
    status = s->respStatus;
    snprintf(locOut, locLen, "%s", s->respLocation);
    snprintf(detailOut, detailLen, "%s", s->respDetail);
  }
  else
    snprintf(detailOut, detailLen, s->bwsClosed ? "the broker closed the WebSocket" : "no response on the WebSocket in %d s", LIVE_TIMEOUT_MS / 1000);
  s->waitId[0] = 0;
  pthread_mutex_unlock(&s->lock);

  return status;
}



// -----------------------------------------------------------------------------
//
// bwsClose - the broker's WebSocket closed, its reader joined
//
static void bwsClose(Live* s)
{
  if (s->bwsOpen == false)
    return;

  pthread_mutex_lock(&s->lock);
  s->bwsClosing = true;
  pthread_mutex_unlock(&s->lock);

  wsSendClose(&s->bws, 1000);
  shutdown(s->bws.fd, SHUT_RDWR);
  pthread_join(s->bwsThread, NULL);
  close(s->bws.fd);
  wsRelease(&s->bws);

  s->bwsOpen       = false;
  s->bwsClosed     = false;
  s->bwsClosing    = false;
  s->connection[0] = 0;
}



// -----------------------------------------------------------------------------
//
// bwsOpen - (a): the broker's WebSocket and the connection's name; false with why not in s->why
//
static bool bwsOpen(Live* s)
{
  int  status = 0;
  char err[400];
  int  r = wsConnect(&s->bws, s->broker, "/ngsi-ld/v1/ws", LIVE_CONNECT_MS, &status, err, sizeof(err));

  if (r == -2)
  {
    snprintf(s->why, sizeof(s->why), "the broker answered GET /ngsi-ld/v1/ws (Upgrade: websocket) with %d - it has no WebSocket transport (coraine --transports ws)", status);
    return false;
  }

  if (r != 0)
  {
    snprintf(s->why, sizeof(s->why), "no WebSocket to the broker: %s", err);
    return false;
  }

  s->bwsOpen       = true;
  s->bwsClosed     = false;
  s->connection[0] = 0;

  if (pthread_create(&s->bwsThread, NULL, bwsReader, s) != 0)
  {
    close(s->bws.fd);
    wsRelease(&s->bws);
    s->bwsOpen = false;
    snprintf(s->why, sizeof(s->why), "no thread for the WebSocket");
    return false;
  }

  //
  // The broker's first message names the connection - the subscriptions' endpoint
  //
  struct timespec until = deadline(LIVE_CONNECT_MS);

  pthread_mutex_lock(&s->lock);
  while ((s->connection[0] == 0) && (s->bwsClosed == false))
  {
    if (pthread_cond_timedwait(&s->cond, &s->lock, &until) != 0)
      break;
  }
  bool named = (s->connection[0] != 0);
  pthread_mutex_unlock(&s->lock);

  if (named == false)
  {
    bwsClose(s);
    snprintf(s->why, sizeof(s->why), "the broker's WebSocket sent no {\"metadata\": {\"connection\"}} first");
    return false;
  }

  s->why[0] = 0;
  return true;
}



// -----------------------------------------------------------------------------
//
// subBody - the subscription: the types, every attribute, every kind of change, normalized
//
static char* subBody(Live* s, char** types, int nTypes)
{
  int size = 1024 + strlen(s->connection) + strlen(notifyPrefix) + strlen(s->id);
  for (int ix = 0; ix < nTypes; ix++)
    size += strlen(types[ix]) * 6 + 24;

  char* out = malloc(size);
  if (out == NULL)
    return NULL;

  int o = snprintf(out, size, "{\"type\": \"Subscription\", \"subscriptionName\": \"%s\", "
                   "\"description\": \"c3 Connect - live values; deleted when c3 disconnects\", \"entities\": [", subName);

  for (int ix = 0; ix < nTypes; ix++)
  {
    char* tE = jsonEscapeDup(types[ix]);
    o += snprintf(&out[o], size - o, "%s{\"type\": \"%s\"}", (ix > 0) ? ", " : "", (tE != NULL) ? tE : "");
    free(tE);
  }

  char endpoint[512];
  if (s->mode == LiveWs)
    snprintf(endpoint, sizeof(endpoint), "%s", s->connection);
  else
    snprintf(endpoint, sizeof(endpoint), "%s%s", notifyPrefix, s->id);

  snprintf(&out[o], size - o, "], \"notificationTrigger\": [\"entityCreated\", \"entityDeleted\", \"attributeCreated\", \"attributeUpdated\", \"attributeDeleted\"], "
           "\"notification\": {\"format\": \"normalized\", \"endpoint\": {\"uri\": \"%s\", \"accept\": \"application/json\"}}}", endpoint);

  return out;
}



// -----------------------------------------------------------------------------
//
// idFromLocation - the subscription's id: the last part of the Location
//
static void idFromLocation(const char* loc, char* out, int outLen)
{
  const char* slash = strrchr(loc, '/');
  snprintf(out, outLen, "%s", (slash != NULL) ? slash + 1 : loc);
}



// -----------------------------------------------------------------------------
//
// subPost - a subscription ('body'), by the session's way; its id in 'idOut', or false with the broker's
// answer in 'detail'
//
static bool subPost(Live* s, const char* body, char* idOut, int idLen, char* detail, int detailLen)
{
  char  loc[512];
  int   status;

  if (s->mode == LiveWs)
  {
    char err[600];
    status = bwsRequest(s, "POST", "/ngsi-ld/v1/subscriptions", body, loc, sizeof(loc), err, sizeof(err));
    if (status != 201)
      snprintf(detail, detailLen, "POST /ngsi-ld/v1/subscriptions over the WebSocket: %s%d%s%s", (status == 0) ? "no answer " : "", status, (err[0] != 0) ? " - " : "", err);
  }
  else
  {
    char       url[1024];
    HttpAnswer a;
    char       err[600];

    snprintf(url, sizeof(url), "%s/ngsi-ld/v1/subscriptions", s->broker);
    httpCall(CorVerbPost, s->broker, s->tenant, url, body, LIVE_TIMEOUT_MS, &a);
    status = a.status;
    snprintf(loc, sizeof(loc), "%s", a.location);
    problemText(a.body, err, sizeof(err));
    if (status == 0)
      snprintf(detail, detailLen, "POST /ngsi-ld/v1/subscriptions: %s", a.error);
    else if (status != 201)
      snprintf(detail, detailLen, "POST /ngsi-ld/v1/subscriptions: %d%s%s", status, (err[0] != 0) ? " - " : "", err);
    free(a.body);
  }

  if ((status != 201) || (loc[0] == 0))
  {
    if (status == 201)
      snprintf(detail, detailLen, "POST /ngsi-ld/v1/subscriptions: 201 without a Location");
    return false;
  }

  idFromLocation(loc, idOut, idLen);
  return true;
}



// -----------------------------------------------------------------------------
//
// subCreate - the watch's subscription
//
static bool subCreate(Live* s, char** types, int nTypes, char* idOut, int idLen, char* detail, int detailLen)
{
  char* body = subBody(s, types, nTypes);

  if (body == NULL)
  {
    snprintf(detail, detailLen, "out of memory");
    return false;
  }

  bool ok = subPost(s, body, idOut, idLen, detail, detailLen);
  free(body);

  return ok;
}



// -----------------------------------------------------------------------------
//
// subDeleteId - a subscription of the session deleted (a 404 counts: it is gone)
//
static void subDeleteId(Live* s, const char* subId)
{
  char path[700];
  int  status;
  char detail[600] = "";

  snprintf(path, sizeof(path), "/ngsi-ld/v1/subscriptions/%s", subId);

  if ((s->mode == LiveWs) && s->bwsOpen && (s->bwsClosed == false))
  {
    char loc[512];
    status = bwsRequest(s, "DELETE", path, NULL, loc, sizeof(loc), detail, sizeof(detail));
  }
  else if (s->mode == LiveWs)
    status = 204;                                // the socket is gone, and with it the subscription
  else
  {
    char       url[1300];
    HttpAnswer a;

    snprintf(url, sizeof(url), "%s%s", s->broker, path);
    httpCall(CorVerbDelete, s->broker, s->tenant, url, NULL, LIVE_TIMEOUT_MS, &a);
    status = a.status;
    problemText(a.body, detail, sizeof(detail));
    if (status == 0)
      snprintf(detail, sizeof(detail), "%s", a.error);
    free(a.body);
  }

  if ((status != 204) && (status != 200) && (status != 404))
  {
    printf("c3 live: %s - DELETE %s answered %d %s\n", s->broker, path, status, detail);
    fflush(stdout);
  }
}



// -----------------------------------------------------------------------------
//
// subDelete - the watch's subscription deleted
//
static void subDelete(Live* s)
{
  if (s->subId[0] == 0)
    return;

  subDeleteId(s, s->subId);

  pthread_mutex_lock(&s->lock);
  s->subId[0] = 0;
  pthread_mutex_unlock(&s->lock);
}



// -----------------------------------------------------------------------------
//
// alertBody - an alert rule's subscription: its type, its q, normalized, the watch's endpoint
//
static char* alertBody(Live* s, LiveRule* rP)
{
  char* typeE = jsonEscapeDup(rP->type);
  char* qE    = (rP->q != NULL) ? jsonEscapeDup(rP->q) : NULL;
  int   size  = 1024 + strlen(typeE) + ((qE != NULL) ? strlen(qE) : 0) + strlen(s->connection) + strlen(notifyPrefix) + strlen(s->id);
  char* out   = malloc(size);

  if (out != NULL)
  {
    char endpoint[512];
    if (s->mode == LiveWs)
      snprintf(endpoint, sizeof(endpoint), "%s", s->connection);
    else
      snprintf(endpoint, sizeof(endpoint), "%s%s", notifyPrefix, s->id);

    snprintf(out, size, "{\"type\": \"Subscription\", \"subscriptionName\": \"%s\", "
             "\"description\": \"c3 Connect - alert rule %s; deleted when c3 disconnects\", \"entities\": [{\"type\": \"%s\"}], %s%s%s"
             "\"notification\": {\"format\": \"normalized\", \"endpoint\": {\"uri\": \"%s\", \"accept\": \"application/json\"}}}",
             subName, rP->id, typeE, (qE != NULL) ? "\"q\": \"" : "", (qE != NULL) ? qE : "", (qE != NULL) ? "\", " : "", endpoint);
  }

  free(typeE);
  free(qE);
  return out;
}



// -----------------------------------------------------------------------------
//
// alertsRemove - the rules' subscriptions deleted (the rules kept)
//
static void alertsRemove(Live* s)
{
  for (int ix = 0; ix < s->nRules; ix++)
  {
    if (s->rules[ix].subId[0] == 0)
      continue;

    if (s->mode != LiveOff)
      subDeleteId(s, s->rules[ix].subId);

    pthread_mutex_lock(&s->lock);
    s->rules[ix].subId[0] = 0;
    pthread_mutex_unlock(&s->lock);
  }
}



// -----------------------------------------------------------------------------
//
// alertsInstall - a subscription per rule, when their broker is the one watched; the page is told
// {"op": "alerts", "broker", "installed", "failed"}
//
static void alertsInstall(Live* s)
{
  if ((s->mode == LiveOff) || (s->nRules == 0) || (strcmp(s->rulesBroker, s->broker) != 0) || (strcmp(s->rulesTenant, s->tenant) != 0))
    return;

  int   size = 256 + strlen(s->brokerE) + s->nRules * 1400;
  char* out  = malloc(size);
  char* fail = malloc(size);
  int   o    = 0;
  int   f    = 0;

  if ((out == NULL) || (fail == NULL))
  {
    free(out);
    free(fail);
    return;
  }

  out[0]  = 0;
  fail[0] = 0;

  for (int ix = 0; ix < s->nRules; ix++)
  {
    LiveRule* rP = &s->rules[ix];
    char      newId[512];
    char      detail[800];
    char*     body = alertBody(s, rP);
    bool      ok   = (body != NULL) && subPost(s, body, newId, sizeof(newId), detail, sizeof(detail));

    free(body);

    if (ok)
    {
      pthread_mutex_lock(&s->lock);
      snprintf(rP->subId, sizeof(rP->subId), "%s", newId);
      pthread_mutex_unlock(&s->lock);

      char* idE = jsonEscapeDup(newId);
      o += snprintf(&out[o], size - o, "%s{\"rule\": \"%s\", \"subscription\": \"%s\"}", (o > 0) ? ", " : "", rP->id, idE);
      free(idE);
    }
    else
    {
      char* detailE = jsonEscapeDup((body != NULL) ? detail : "out of memory");
      f += snprintf(&fail[f], size - f, "%s{\"rule\": \"%s\", \"detail\": \"%s\"}", (f > 0) ? ", " : "", rP->id, detailE);
      free(detailE);
      printf("c3 live: %s - alert rule %s: %s\n", s->broker, rP->id, detail);
      fflush(stdout);
    }
  }

  int nFailed = 0;
  for (int ix = 0; ix < s->nRules; ix++)
    nFailed += (s->rules[ix].subId[0] == 0) ? 1 : 0;
  printf("c3 live: %s - alert rules: %d installed, %d failed\n", s->broker, s->nRules - nFailed, nFailed);
  fflush(stdout);

  int   msgSize = 2 * size + 128;
  char* msg     = malloc(msgSize);
  if (msg != NULL)
  {
    snprintf(msg, msgSize, "{\"op\": \"alerts\", \"broker\": \"%s\", \"installed\": [%s], \"failed\": [%s]}", s->brokerE, out, fail);
    pageSend(s, msg);
    free(msg);
  }

  free(out);
  free(fail);
}



// -----------------------------------------------------------------------------
//
// rulesFree - the rules forgotten (their subscriptions deleted first)
//
static void rulesFree(Live* s)
{
  pthread_mutex_lock(&s->lock);
  for (int ix = 0; ix < s->nRules; ix++)
  {
    free(s->rules[ix].type);
    free(s->rules[ix].q);
  }
  s->nRules = 0;
  pthread_mutex_unlock(&s->lock);
}



// -----------------------------------------------------------------------------
//
// unwatch - nothing watched: the subscription deleted, the broker's WebSocket closed
//
static void unwatch(Live* s)
{
  if (s->mode == LiveOff)
    return;

  alertsRemove(s);
  subDelete(s);
  bwsClose(s);

  pthread_mutex_lock(&s->lock);
  s->mode      = LiveOff;
  s->broker[0] = 0;
  s->tenant[0] = 0;
  free(s->brokerE);
  s->brokerE   = NULL;
  pthread_mutex_unlock(&s->lock);
}



// -----------------------------------------------------------------------------
//
// watch - the entities of 'types' on 'broker', in 'tenant': one subscription, (a) or (b)
//
static void watch(Live* s, const char* broker, const char* tenant, char** types, int nTypes)
{
  //
  // Another broker or tenant, or a WebSocket the broker closed: start over
  //
  if ((s->mode != LiveOff) && ((strcmp(s->broker, broker) != 0) || (strcmp(s->tenant, tenant) != 0) || ((s->mode == LiveWs) && s->bwsClosed)))
    unwatch(s);

  //
  // The types, as the status shows them
  //
  int size = 8;
  for (int ix = 0; ix < nTypes; ix++)
    size += strlen(types[ix]) * 6 + 8;
  char* typesJson = malloc(size);
  int   o         = snprintf(typesJson, size, "[");
  for (int ix = 0; ix < nTypes; ix++)
  {
    char* tE = jsonEscapeDup(types[ix]);
    o += snprintf(&typesJson[o], size - o, "%s\"%s\"", (ix > 0) ? ", " : "", tE);
    free(tE);
  }
  snprintf(&typesJson[o], size - o, "]");

  pthread_mutex_lock(&s->lock);
  free(s->typesJson);
  s->typesJson = typesJson;
  pthread_mutex_unlock(&s->lock);

  bool fresh = (s->mode == LiveOff);

  if (s->mode == LiveOff)
  {
    pthread_mutex_lock(&s->lock);
    snprintf(s->broker, sizeof(s->broker), "%s", broker);
    snprintf(s->tenant, sizeof(s->tenant), "%s", tenant);
    s->brokerE = jsonEscapeDup(broker);
    pthread_mutex_unlock(&s->lock);

    sweep(broker, tenant, 3000);

    LiveMode mode = bwsOpen(s) ? LiveWs : LiveHttp;

    pthread_mutex_lock(&s->lock);
    s->mode = mode;
    pthread_mutex_unlock(&s->lock);

    printf("c3 live: %s - %s%s%s\n", broker, (mode == LiveWs) ? "the broker's WebSocket transport (connection " : "HTTP subscriptions - ",
           (mode == LiveWs) ? s->connection : s->why, (mode == LiveWs) ? ")" : "");
    fflush(stdout);
  }

  if (nTypes == 0)
  {
    subDelete(s);
    statusSend(s, "nothing to watch: no types loaded");
    return;
  }

  //
  // The new subscription first, then the old one deleted: no change is missed in between
  //
  char newId[512];
  char detail[800];

  if (subCreate(s, types, nTypes, newId, sizeof(newId), detail, sizeof(detail)) == false)
  {
    printf("c3 live: %s - %s\n", broker, detail);
    fflush(stdout);
    statusSend(s, detail);
    unwatch(s);                                  // the next watch starts over: the WebSocket tried again
    return;
  }

  subDelete(s);

  pthread_mutex_lock(&s->lock);
  snprintf(s->subId, sizeof(s->subId), "%s", newId);
  pthread_mutex_unlock(&s->lock);

  printf("c3 live: %s - subscription %s (%s) for %d type%s\n", broker, newId, modeName[s->mode], nTypes, (nTypes == 1) ? "" : "s");
  fflush(stdout);

  statusSend(s, NULL);

  if (fresh)
    alertsInstall(s);
}



// -----------------------------------------------------------------------------
//
// ruleIdValid - an alert rule's id: 1-64 of [A-Za-z0-9._-] (it goes into JSON unescaped)
//
static bool ruleIdValid(const char* id)
{
  int n = 0;

  for (; *id != 0; ++id, ++n)
  {
    char c = *id;
    if (((c < 'a') || (c > 'z')) && ((c < 'A') || (c > 'Z')) && ((c < '0') || (c > '9')) && (c != '.') && (c != '_') && (c != '-'))
      return false;
  }

  return (n > 0) && (n <= 64);
}



// -----------------------------------------------------------------------------
//
// alertsSet - {"op": "alerts", "broker", "tenant", "rules"}: the old rules' subscriptions deleted, the new
// ones installed (now, when their broker is watched; else when it is)
//
static bool alertsSet(Live* s, CorNode* treeP)
{
  const char* broker = stringOf(treeP, "broker");
  const char* tenant = stringOf(treeP, "tenant");
  CorNode*    rulesP = corTreeLookup(treeP, "rules");

  if ((broker == NULL) || (strlen(broker) >= 500) || ((strncmp(broker, "http://", 7) != 0) && (strncmp(broker, "https://", 8) != 0)) ||
      (rulesP == NULL) || (rulesP->type != CorArray) || ((tenant != NULL) && (tenant[0] != 0) && (tenantValid(tenant) == false)))
    return false;

  int n = 0;
  for (CorNode* rP = rulesP->value.head; rP != NULL; rP = rP->next, ++n)
  {
    const char* id   = stringOf(rP, "id");
    const char* type = stringOf(rP, "type");
    CorNode*    qP   = (rP->type == CorObject) ? corTreeLookup(rP, "q") : NULL;

    if ((n == LIVE_RULES_MAX) || (id == NULL) || (ruleIdValid(id) == false) || (type == NULL) || (type[0] == 0) || (strlen(type) > 500) ||
        ((qP != NULL) && (qP->type != CorNull) && ((qP->type != CorString) || (strlen(qP->value.s) > 1024))))
      return false;
  }

  alertsRemove(s);
  rulesFree(s);

  pthread_mutex_lock(&s->lock);
  snprintf(s->rulesBroker, sizeof(s->rulesBroker), "%s", broker);
  snprintf(s->rulesTenant, sizeof(s->rulesTenant), "%s", (tenant != NULL) ? tenant : "");
  for (CorNode* rP = rulesP->value.head; rP != NULL; rP = rP->next)
  {
    LiveRule*   lrP = &s->rules[s->nRules++];
    CorNode*    qP  = corTreeLookup(rP, "q");

    snprintf(lrP->id, sizeof(lrP->id), "%s", stringOf(rP, "id"));
    lrP->type     = strdup(stringOf(rP, "type"));
    lrP->q        = ((qP != NULL) && (qP->type == CorString) && (qP->value.s[0] != 0)) ? strdup(qP->value.s) : NULL;
    lrP->subId[0] = 0;
  }
  pthread_mutex_unlock(&s->lock);

  if ((s->mode != LiveOff) && (strcmp(s->broker, broker) == 0) && (strcmp(s->tenant, s->rulesTenant) == 0))
  {
    if (s->nRules > 0)
      alertsInstall(s);
    else
    {
      char* bE  = jsonEscapeDup(broker);
      char  msg[1200];
      snprintf(msg, sizeof(msg), "{\"op\": \"alerts\", \"broker\": \"%s\", \"installed\": [], \"failed\": []}", bE);
      pageSend(s, msg);
      free(bE);
    }
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// pageMessage - {"op": "watch", "broker", "tenant", "types"}, {"op": "unwatch"} or {"op": "alerts", "broker", "tenant", "rules"}
//
static void pageMessage(Live* s, const char* text)
{
  Parsed      p;
  CorNode*    treeP = parse(&p, text);
  const char* op    = stringOf(treeP, "op");

  if (op == NULL)
  {
    parsedRelease(&p);
    return;
  }

  if (strcmp(op, "watch") == 0)
  {
    const char* broker = stringOf(treeP, "broker");
    const char* tenant = stringOf(treeP, "tenant");
    CorNode*    typesP = corTreeLookup(treeP, "types");
    char*       types[LIVE_TYPES_MAX];
    int         nTypes = 0;
    bool        ok     = (broker != NULL) && (strlen(broker) < 500) && ((strncmp(broker, "http://", 7) == 0) || (strncmp(broker, "https://", 8) == 0)) &&
                         (typesP != NULL) && (typesP->type == CorArray) &&
                         ((tenant == NULL) || (tenant[0] == 0) || tenantValid(tenant));

    if (ok)
    {
      for (CorNode* tP = typesP->value.head; tP != NULL; tP = tP->next)
      {
        if ((tP->type != CorString) || (tP->value.s[0] == 0) || (strlen(tP->value.s) > 500) || (nTypes == LIVE_TYPES_MAX))
        {
          ok = false;
          break;
        }
        types[nTypes++] = tP->value.s;
      }
    }

    if (ok)
      watch(s, broker, (tenant != NULL) ? tenant : "", types, nTypes);
    else
      pageSend(s, "{\"op\": \"error\", \"detail\": \"watch: {\\\"broker\\\": \\\"http://host:port\\\", \\\"tenant\\\": \\\"optional\\\", \\\"types\\\": [up to 1000 type names]}\"}");
  }
  else if (strcmp(op, "unwatch") == 0)
  {
    unwatch(s);
    statusSend(s, NULL);
  }
  else if (strcmp(op, "alerts") == 0)
  {
    if (alertsSet(s, treeP) == false)
      pageSend(s, "{\"op\": \"error\", \"detail\": \"alerts: {\\\"broker\\\": \\\"http://host:port\\\", \\\"tenant\\\": \\\"optional\\\", \\\"rules\\\": [up to 32 {\\\"id\\\", \\\"type\\\", \\\"q\\\"}]}\"}");
  }

  parsedRelease(&p);
}



// -----------------------------------------------------------------------------
//
// pageThread - the page's socket, until it closes; then nothing is left behind
//
static void* pageThread(void* vP)
{
  Live* s = (Live*) vP;
  char  hello[128];

  snprintf(hello, sizeof(hello), "{\"op\": \"hello\", \"session\": \"%s\"}", s->id);
  pageSend(s, hello);

  for (;;)
  {
    char* data;
    int   len;

    if (wsRead(&s->page, &data, &len, LIVE_PAGE_MAX) != 1)
      break;

    pageMessage(s, data);
    free(data);
  }

  unwatch(s);
  rulesFree(s);

  pthread_mutex_lock(&livesLock);
  for (Live** pP = &lives; *pP != NULL; pP = &(*pP)->next)
  {
    if (*pP == s)
    {
      *pP = s->next;
      break;
    }
  }
  --liveCount;
  pthread_mutex_unlock(&livesLock);

  wsSendClose(&s->page, 1000);
  close(s->page.fd);
  wsRelease(&s->page);
  pthread_mutex_destroy(&s->lock);
  pthread_cond_destroy(&s->cond);
  free(s->typesJson);
  free(s->brokerE);
  free(s);

  return NULL;
}



// -----------------------------------------------------------------------------
//
// pageTake - the 101 is written: the socket is the session's
//
static void pageTake(int fd, char* extra, int extraLen, void* cls)
{
  (void) cls;

  Live* s = calloc(1, sizeof(Live));
  if (s == NULL)
  {
    close(fd);
    return;
  }

  unsigned char r[16];
  if (getrandom(r, sizeof(r), 0) != sizeof(r))
  {
    free(s);
    close(fd);
    return;
  }
  for (int ix = 0; ix < 16; ix++)
    snprintf(&s->id[ix * 2], 3, "%02x", r[ix]);

  wsInit(&s->page, fd, false, extra, extraLen);
  pthread_mutex_init(&s->lock, NULL);
  pthread_cond_init(&s->cond, NULL);

  pthread_mutex_lock(&livesLock);
  s->next = lives;
  lives   = s;
  ++liveCount;
  pthread_mutex_unlock(&livesLock);

  pthread_t      tid;
  pthread_attr_t attr;

  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  if (pthread_create(&tid, &attr, pageThread, s) != 0)
    shutdown(fd, SHUT_RDWR);                     // no thread: nothing reads it - the page sees it close
  pthread_attr_destroy(&attr);
}



// -----------------------------------------------------------------------------
//
// headerHas - a comma-separated header has 'token' (case-insensitive)
//
static bool headerHas(const char* value, const char* token)
{
  return (value != NULL) && (strcasestr(value, token) != NULL);
}



// -----------------------------------------------------------------------------
//
// liveUpgrade - GET /api/live: the page's WebSocket
//
// The Origin, when the browser sends one, must be this machine (Host is checked for every request).
//
void liveUpgrade(CorHttpConn* connP)
{
  const char* key     = corHttpHeader(connP, "Sec-WebSocket-Key");
  const char* version = corHttpHeader(connP, "Sec-WebSocket-Version");
  const char* origin  = corHttpHeader(connP, "Origin");

  if ((strcmp(connP->method.s, "GET") != 0) || (headerHas(corHttpHeader(connP, "Upgrade"), "websocket") == false) || (key == NULL))
  {
    serveError(connP, 400, "Bad request", "GET /api/live is a WebSocket (Upgrade: websocket)");
    return;
  }

  if ((version == NULL) || (strcmp(version, "13") != 0))
  {
    corHttpResponseHeader(connP, "Sec-WebSocket-Version", "13");
    serveError(connP, 426, "Upgrade required", "WebSocket version 13");
    return;
  }

  if ((origin != NULL) && (strncmp(origin, "http://localhost:", 17) != 0) && (strncmp(origin, "http://127.0.0.1:", 17) != 0) && (strncmp(origin, "http://[::1]:", 13) != 0))
  {
    serveError(connP, 403, "Forbidden", "the page must come from this backend");
    return;
  }

  char* accept = corAlloc(&connP->alloc, 64);
  if ((accept == NULL) || (wsAcceptKey(key, accept, 64) == false))
  {
    serveError(connP, 400, "Bad request", "Sec-WebSocket-Key");
    return;
  }

  corHttpResponseStatus(connP, 101);
  corHttpResponseHeader(connP, "Upgrade", "websocket");
  corHttpResponseHeader(connP, "Sec-WebSocket-Accept", accept);
  corHttpUpgrade(connP, pageTake, NULL);
}



// -----------------------------------------------------------------------------
//
// liveNotify - POST /api/notify/<session>: a broker's notification, to the session's page
//
void liveNotify(CorHttpConn* connP, const char* session)
{
  if (strcmp(connP->method.s, "POST") != 0)
  {
    serveError(connP, 405, "Method not allowed", "POST");
    return;
  }

  const char* body = connP->body.s;
  while ((body != NULL) && ((*body == ' ') || (*body == '\n') || (*body == '\r') || (*body == '\t')))
    ++body;

  if ((body == NULL) || (*body != '{'))
  {
    serveError(connP, 400, "Bad request", "a notification (a JSON object) is expected");
    return;
  }

  bool found = false;

  pthread_mutex_lock(&livesLock);
  for (Live* s = lives; s != NULL; s = s->next)
  {
    if (strcmp(s->id, session) != 0)
      continue;

    Parsed   p;
    CorNode* treeP = parse(&p, body);
    char     rule[65];

    pthread_mutex_lock(&s->lock);
    char*    brokerE = (s->brokerE != NULL) ? strdup(s->brokerE) : NULL;
    LiveMode mode    = s->mode;
    bool     alert   = ruleOf(s, treeP, rule, sizeof(rule));
    pthread_mutex_unlock(&s->lock);
    parsedRelease(&p);

    if ((mode == LiveHttp) && (brokerE != NULL))
    {
      if (alert)
        alertForward(s, brokerE, rule, "{\"body\": ", body, "}");
      else
        notifyForward(s, brokerE, "{\"body\": ", body, "}");
      found = true;
    }
    free(brokerE);
    break;
  }
  pthread_mutex_unlock(&livesLock);

  if (found == false)
  {
    serveError(connP, 404, "Not found", "no such session - the subscription is left over");
    return;
  }

  corHttpResponseStatus(connP, 204);
  corHttpResponseBody(connP, (char*) "", 0);
}



// -----------------------------------------------------------------------------
//
// startupSweep - the brokers of the configuration, swept of an earlier run's subscriptions
//
typedef struct SweepList
{
  int   n;
  char  url[10][512];
  char  tenant[10][256];
} SweepList;

static void* startupSweep(void* vP)
{
  SweepList* lP = (SweepList*) vP;

  for (int ix = 0; ix < lP->n; ix++)
    sweep(lP->url[ix], lP->tenant[ix], 2000);

  free(lP);
  return NULL;
}



// -----------------------------------------------------------------------------
//
// liveInit - called before the server starts, after the configuration is loaded
//
void liveInit(void)
{
  snprintf(notifyPrefix, sizeof(notifyPrefix), "http://127.0.0.1:%d/api/notify/", c3Port);
  snprintf(subName, sizeof(subName), "%s:%d", LIVE_NAME, c3Port);

  SweepList* lP = calloc(1, sizeof(SweepList));
  if (lP == NULL)
    return;

  Parsed   p;
  CorNode* treeP    = parse(&p, configText());
  CorNode* brokersP = ((treeP != NULL) && (treeP->type == CorObject)) ? corTreeLookup(treeP, "brokers") : NULL;

  if ((brokersP != NULL) && (brokersP->type == CorArray))
  {
    for (CorNode* bP = brokersP->value.head; (bP != NULL) && (lP->n < 10); bP = bP->next)
    {
      const char* url    = stringOf(bP, "url");
      const char* tenant = stringOf(bP, "tenant");      // the tenant Connect works on, at this broker
      if ((url != NULL) && (strncmp(url, "http://", 7) == 0) && (strlen(url) < 500))
      {
        snprintf(lP->url[lP->n], sizeof(lP->url[0]), "%s", url);
        snprintf(lP->tenant[lP->n], sizeof(lP->tenant[0]), "%s", ((tenant != NULL) && tenantValid(tenant)) ? tenant : "");
        ++lP->n;
      }
    }
  }
  parsedRelease(&p);

  pthread_t      tid;
  pthread_attr_t attr;

  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  if (pthread_create(&tid, &attr, startupSweep, lP) != 0)
    free(lP);
  pthread_attr_destroy(&attr);
}



// -----------------------------------------------------------------------------
//
// liveShutdown - the backend stops: every page's socket shut, so its thread deletes its subscription;
// waits for them (at most 12 s - a broker that does not answer takes LIVE_TIMEOUT_MS)
//
void liveShutdown(void)
{
  pthread_mutex_lock(&livesLock);
  for (Live* s = lives; s != NULL; s = s->next)
    shutdown(s->page.fd, SHUT_RDWR);
  pthread_mutex_unlock(&livesLock);

  for (int ix = 0; ix < 1200; ix++)
  {
    pthread_mutex_lock(&livesLock);
    int n = liveCount;
    pthread_mutex_unlock(&livesLock);

    if (n == 0)
      return;

    usleep(10 * 1000);
  }
}
