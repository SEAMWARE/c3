//
// FILE            demo.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Named demos - a name in Connect's broker field instead of a URL
//
//   GET /api/demos/<name>     the demo's descriptor, fetched from the URL the configuration gives it
//                             ("demos", config.c) - or a built-in one: CDMAD, c3-demo-madrid
//
// The descriptor is the demo's own (served by the demo, next to the broker it starts): which broker, the
// map's view, the types to watch, the alert rules -
//
//   { "name": "Madrid", "broker": "http://127.0.0.1:9026", "tenant": null,
//     "view": { "mode": "map", "center": [-3.693, 40.43], "zoom": 12.6, "relationships": "selected" },
//     "watch": ["Bus", "Streetlight"],
//     "alerts": [ { "id": "streetlight-out", "title": "Streetlight out", "severity": "critical",
//                   "type": "Streetlight", "q": "status==\"broken\"" } ] }
//
// It is fetched here, not by the page: the demo is another origin, and needs no CORS for c3. The answer:
//
//   200 { "name": "<the name asked for>", "url": "<the descriptor's URL>", "descriptor": { ... } }
//   404 no demo of that name                    502 the demo did not answer, or answered no descriptor
//
#include <stdio.h>                               // snprintf
#include <stdlib.h>                              // free
#include <string.h>                              // strlen, strncmp, memcpy

#include "corAlloc/corAlloc.h"                   // corAlloc
#include "corAlloc/corAllocBufferInit.h"         // corAllocBufferInit
#include "corAlloc/corAllocBufferReset.h"        // corAllocBufferReset
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
#define DEMO_TIMEOUT_MS   3000                   // the demo is on this machine, or near it
#define DEMO_MAX          (256 * 1024)           // a descriptor



// -----------------------------------------------------------------------------
//
// nameValid - a demo's name: 1-64 letters, digits, '-', '_'
//
static bool nameValid(const char* name)
{
  int n = 0;

  for (; *name != 0; ++name, ++n)
  {
    char c = *name;
    if (((c < 'a') || (c > 'z')) && ((c < 'A') || (c > 'Z')) && ((c < '0') || (c > '9')) && (c != '-') && (c != '_'))
      return false;
  }

  return (n > 0) && (n <= 64);
}



// -----------------------------------------------------------------------------
//
// originOf - "http://127.0.0.1:7990/c3.json" -> "http://127.0.0.1:7990", for the messages
//
static void originOf(const char* url, char* out, int outLen)
{
  const char* host  = strstr(url, "://");
  const char* slash = (host != NULL) ? strchr(host + 3, '/') : NULL;
  int         len   = (slash != NULL) ? (int) (slash - url) : (int) strlen(url);

  snprintf(out, outLen, "%.*s", len, url);
}



// -----------------------------------------------------------------------------
//
// jsonEscape - 's' as the inside of a JSON string, allocated from the connection
//
static char* jsonEscape(CorHttpConn* connP, const char* s)
{
  char* out = corAlloc(&connP->alloc, strlen(s) * 6 + 1);
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
// demoRequest - GET /api/demos/<name>
//
void demoRequest(CorHttpConn* connP, const char* name)
{
  char url[1024];
  char hint[256];
  char origin[1024];
  char detail[1600];

  if (strcmp(connP->method.s, "GET") != 0)
  {
    serveError(connP, 405, "Method not allowed", "GET");
    return;
  }

  if ((nameValid(name) == false) || (configDemo(name, url, sizeof(url), hint, sizeof(hint)) == false))
  {
    serveError(connP, 404, "Not found", "no demo of that name - a broker is http://host:port; demos are named in the configuration's \"demos\"");
    return;
  }

  originOf(url, origin, sizeof(origin));

  if ((strncmp(url, "http://", 7) != 0) && (strncmp(url, "https://", 8) != 0))
  {
    snprintf(detail, sizeof(detail), "the descriptor URL of %s must be http(s)://: %s", name, url);
    serveError(connP, 502, "Bad gateway", detail);
    return;
  }

  //
  // The descriptor
  //
  CorRestKeyValue     accept = { (char*) "Accept", (char*) "application/json" };
  CorRestClientMulti* multiP = corRestClientMultiCreate(1);

  if (multiP == NULL)
  {
    serveError(connP, 500, "Internal error", "out of memory");
    return;
  }

  corRestClientMultiMaxResponse(multiP, DEMO_MAX);

  if (corRestClientMultiAdd(multiP, CorVerbGet, url, &accept, 1, NULL, 0, NULL, NULL) < 0)
  {
    corRestClientMultiDestroy(multiP);
    snprintf(detail, sizeof(detail), "the descriptor URL of %s cannot be used: %s", name, url);
    serveError(connP, 502, "Bad gateway", detail);
    return;
  }

  corRestClientMultiPerform(multiP, DEMO_TIMEOUT_MS);

  CorRestClientResponse* respP = corRestClientMultiResponse(multiP, 0);

  if ((respP == NULL) || (respP->error != CORR_OK) || (respP->statusCode == 0))
  {
    snprintf(detail, sizeof(detail), "%s is not running at %s%s%s", name, origin, (hint[0] != 0) ? " - " : "", hint);
    corRestClientMultiDestroy(multiP);
    serveError(connP, 502, "Bad gateway", detail);
    return;
  }

  if (respP->statusCode != 200)
  {
    snprintf(detail, sizeof(detail), "%s answered %d for its descriptor (%s)", name, respP->statusCode, url);
    corRestClientMultiDestroy(multiP);
    serveError(connP, 502, "Bad gateway", detail);
    return;
  }

  //
  // A JSON object with a "broker" - the rest the page reads
  //
  char* text = corAlloc(&connP->alloc, respP->bodyLen + 1);
  if (text != NULL)
  {
    memcpy(text, respP->body, respP->bodyLen);
    text[respP->bodyLen] = 0;
  }
  corRestClientMultiDestroy(multiP);

  CorAlloc alloc;
  char     buf[8 * 1024];
  CorJson  json;

  corAllocBufferInit(&alloc, buf, sizeof(buf), 512 * 1024, NULL, "c3 demo");
  corJsonCreate(&json, &alloc);

  char*    copy    = (text != NULL) ? corAllocStrdup(&alloc, text) : NULL;
  CorNode* treeP   = (copy != NULL) ? corJsonParse(&json, copy) : NULL;
  CorNode* brokerP = ((treeP != NULL) && (treeP->type == CorObject)) ? corTreeLookup(treeP, "broker") : NULL;
  bool     ok      = (brokerP != NULL) && (brokerP->type == CorString) &&
                     ((strncmp(brokerP->value.s, "http://", 7) == 0) || (strncmp(brokerP->value.s, "https://", 8) == 0));

  corAllocBufferReset(&alloc, false);

  if (ok == false)
  {
    snprintf(detail, sizeof(detail), "%s answered no descriptor at %s - a JSON object with \"broker\": \"http://host:port\" is expected", name, url);
    serveError(connP, 502, "Bad gateway", detail);
    return;
  }

  char* nameE = jsonEscape(connP, name);
  char* urlE  = jsonEscape(connP, url);
  int   size  = strlen(text) + strlen(nameE) + strlen(urlE) + 64;
  char* body  = corAlloc(&connP->alloc, size);

  snprintf(body, size, "{\"name\": \"%s\", \"url\": \"%s\", \"descriptor\": %s}", nameE, urlE, text);
  serveJson(connP, 200, body);
}
