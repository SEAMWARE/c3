//
// FILE            trimmed.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// A broker's trimmed-off log lines saved on this machine, then deleted on the broker. coraine's log trim (built with
// COR_FEATURE_LOG_TRIM) keeps the lines it drops, gzipped, until they are fetched or --logTrimKeepFor runs out:
//
//   POST /api/run/trimmed   { "broker": "http://host:port", "name": "<the file>" }
//                           -> { "path": "<where it is now>", "size": <bytes> }
//
// The file is read in parts (GET /admin/log/trimmed/<name>, Range - the broker answers a file over 1 GiB only in
// parts), written to $XDG_DATA_HOME/c3/logs/<host_port>/<name> (else ~/.local/share/c3/logs/...) as <name>.part,
// its size checked against the broker's list (GET /admin/log/trimmed) and the Content-Range total, renamed, and only
// then deleted on the broker (DELETE /admin/log/trimmed/<name>; 404: gone already, which is as good). A failure on the
// way leaves the broker's file where it is, and nothing half-written here.
//
// Only from c3's own page (Origin: this machine): it deletes a file on the broker.
//
#include <stdbool.h>                             // bool
#include <stdio.h>                               // snprintf, fopen, fwrite, fclose, rename, remove
#include <stdlib.h>                              // malloc, free, strtoll
#include <string.h>                              // strcmp, strncmp, strlen, strspn, strchr
#include <strings.h>                             // strcasecmp

#include "corAlloc/corAlloc.h"                   // corAlloc
#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup
#include "corJson/corJsonCreate.h"               // corJsonCreate
#include "corJson/corJsonParse.h"                // corJsonParse
#include "corTree/corTreeLookup.h"               // corTreeLookup
#include "corRest/corRestClient.h"               // corRestClient*

#include "c3.h"



// -----------------------------------------------------------------------------
//
// Got - one request to the broker: its status (0: not reached), Content-Range's total, the body (malloc'ed)
//
typedef struct Got
{
  int        status;
  long long  total;                              // Content-Range: bytes a-b/<total>, -1 without
  char*      body;
  long long  bodyLen;
  char       error[256];
} Got;

static void brokerCall(CorRestVerb verb, const char* broker, const char* path, const char* range, Got* gP)
{
  CorRestKeyValue     headers[20];
  CorRestKeyValue     own[17];
  int                 n      = 0;
  int                 ownN   = credsHeaders(broker, own, 17);
  CorRestClientMulti* multiP = corRestClientMultiCreate(1);
  char                url[2048];

  memset(gP, 0, sizeof(*gP));
  gP->total = -1;
  snprintf(url, sizeof(url), "%s%s", broker, path);

  if (range != NULL)
  {
    headers[n].key   = (char*) "Range";
    headers[n].value = (char*) range;
    ++n;
  }
  for (int ix = 0; ix < ownN; ix++)
    headers[n++] = own[ix];

  if ((multiP == NULL) || (corRestClientMultiAdd(multiP, verb, url, headers, n, NULL, 0, NULL, NULL) < 0))
  {
    snprintf(gP->error, sizeof(gP->error), "the broker's URL could not be used");
    if (multiP != NULL) corRestClientMultiDestroy(multiP);
    credsHeadersFree(own, ownN);
    return;
  }

  corRestClientMultiMaxResponse(multiP, 48 * 1024 * 1024);
  corRestClientMultiPerform(multiP, 120000);

  CorRestClientResponse* respP = corRestClientMultiResponse(multiP, 0);

  if ((respP == NULL) || (respP->error != CORR_OK) || (respP->statusCode == 0))
    snprintf(gP->error, sizeof(gP->error), "%s", ((respP != NULL) && (respP->errorDetail[0] != 0)) ? respP->errorDetail : "the broker did not answer");
  else
  {
    gP->status = respP->statusCode;

    for (int ix = 0; ix < respP->headerCount; ix++)
    {
      if (strcasecmp(respP->headerV[ix].key, "Content-Range") == 0)
      {
        const char* slash = strchr(respP->headerV[ix].value, '/');
        if ((slash != NULL) && (slash[1] != '*'))
          gP->total = strtoll(&slash[1], NULL, 10);
      }
    }

    if ((respP->body != NULL) && (respP->bodyLen > 0))
    {
      gP->body = malloc(respP->bodyLen + 1);
      if (gP->body != NULL)
      {
        memcpy(gP->body, respP->body, respP->bodyLen);
        gP->body[respP->bodyLen] = 0;
        gP->bodyLen = respP->bodyLen;
      }
    }
  }

  corRestClientMultiDestroy(multiP);
  credsHeadersFree(own, ownN);
}



// -----------------------------------------------------------------------------
//
// listedSize - the file's size in the broker's list (GET /admin/log/trimmed), -1 when not listed
//
static long long listedSize(CorHttpConn* connP, const char* broker, const char* name)
{
  Got g;
  brokerCall(CorVerbGet, broker, "/admin/log/trimmed", NULL, &g);

  long long size = -1;
  if ((g.status == 200) && (g.body != NULL))
  {
    CorJson json;
    corJsonCreate(&json, &connP->alloc);
    CorNode* listP = corJsonParse(&json, corAllocStrdup(&connP->alloc, g.body));

    for (CorNode* fP = ((listP != NULL) && (listP->type == CorArray)) ? listP->value.head : NULL; fP != NULL; fP = fP->next)
    {
      CorNode* nP = (fP->type == CorObject) ? corTreeLookup(fP, "name") : NULL;
      CorNode* sP = (fP->type == CorObject) ? corTreeLookup(fP, "size") : NULL;
      if ((nP != NULL) && (nP->type == CorString) && (strcmp(nP->value.s, name) == 0) && (sP != NULL) && (sP->type == CorInt))
        size = sP->value.i;
    }
  }

  free(g.body);
  return size;
}



// -----------------------------------------------------------------------------
//
// trimmedSave - POST /api/run/trimmed
//
void trimmedSave(CorHttpConn* connP)
{
  const char* origin = corHttpHeader(connP, "Origin");
  if ((origin == NULL) ||
      ((strncmp(origin, "http://localhost:", 17) != 0) && (strncmp(origin, "http://127.0.0.1:", 17) != 0) && (strncmp(origin, "http://[::1]:", 13) != 0)))
  {
    serveError(connP, 403, "Forbidden", "trimmed-off log lines are saved from c3's own page only (Origin: this machine)");
    return;
  }

  CorJson json;
  corJsonCreate(&json, &connP->alloc);

  char*       copy    = ((connP->bodyRefused == false) && (connP->body.s != NULL)) ? corAllocStrdup(&connP->alloc, connP->body.s) : NULL;
  CorNode*    bodyP   = (copy != NULL) ? corJsonParse(&json, copy) : NULL;
  CorNode*    brokerP = ((bodyP != NULL) && (bodyP->type == CorObject)) ? corTreeLookup(bodyP, "broker") : NULL;
  CorNode*    nameP   = ((bodyP != NULL) && (bodyP->type == CorObject)) ? corTreeLookup(bodyP, "name")   : NULL;
  const char* broker  = ((brokerP != NULL) && (brokerP->type == CorString)) ? brokerP->value.s : NULL;
  const char* name    = ((nameP   != NULL) && (nameP->type   == CorString)) ? nameP->value.s   : NULL;
  const char* nameOk  = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-";

  if ((broker == NULL) || ((strncmp(broker, "http://", 7) != 0) && (strncmp(broker, "https://", 8) != 0)) || (strlen(broker) > 512) ||
      (name == NULL) || (name[0] == 0) || (name[0] == '.') || (strlen(name) > 200) || (name[strspn(name, nameOk)] != 0))
  {
    serveError(connP, 400, "Bad request", "the body: {\"broker\": \"http://host:port\", \"name\": \"<a file of GET /admin/log/trimmed>\"}");
    return;
  }

  //
  // Where: logs/<host_port> - the broker's host and port, nothing that is not a name's character
  //
  char        hostPort[256];
  const char* h = &broker[(broker[4] == 's') ? 8 : 7];
  int         n = 0;
  for (; (*h != 0) && (*h != '/') && (n < (int) sizeof(hostPort) - 1); h++)
    hostPort[n++] = ((*h == ':') || (strchr(nameOk, *h) == NULL)) ? '_' : *h;
  hostPort[n] = 0;

  char sub[300];
  char dir[2048];
  snprintf(sub, sizeof(sub), "logs/%s", hostPort);
  if ((dataHome(sub, dir, sizeof(dir)) == false) || (dirsMake(dir) == false))
  {
    serveError(connP, 500, "No directory", "no directory for the saved log lines ($XDG_DATA_HOME/c3/logs)");
    return;
  }

  long long size = listedSize(connP, broker, name);
  if (size < 0)
  {
    serveError(connP, 404, "Not found", "the broker does not list that file (GET /admin/log/trimmed) - gone already, or its time ran out");
    return;
  }

  char path[2400];
  char part[2410];
  snprintf(path, sizeof(path), "%s/%s", dir, name);
  snprintf(part, sizeof(part), "%s.part", path);

  FILE* fP = fopen(part, "w");
  if (fP == NULL)
  {
    serveError(connP, 500, "Not saved", "the file could not be created here");
    return;
  }

  //
  // In parts of 32 MiB, until the total is read
  //
  char      brokerPath[512];
  char      detail[512] = "";
  long long have  = 0;
  long long total = size;
  snprintf(brokerPath, sizeof(brokerPath), "/admin/log/trimmed/%s", name);

  while (have < total)                           // an empty file: nothing to read
  {
    char range[64];
    Got  g;

    snprintf(range, sizeof(range), "bytes=%lld-%lld", have, have + 32 * 1024 * 1024 - 1);
    brokerCall(CorVerbGet, broker, brokerPath, range, &g);

    if ((g.status != 206) && (g.status != 200))
    {
      if (g.status != 0) snprintf(detail, sizeof(detail), "GET %s: HTTP %d", brokerPath, g.status);
      else               snprintf(detail, sizeof(detail), "GET %s: %s", brokerPath, g.error);
      free(g.body);
      break;
    }

    if (g.total >= 0) total = g.total;
    if (g.status == 200)                         // the whole file, not a part
    {
      have = 0;
      fseek(fP, 0, SEEK_SET);
    }

    if ((g.bodyLen > 0) && (fwrite(g.body, 1, g.bodyLen, fP) != (size_t) g.bodyLen))
    {
      snprintf(detail, sizeof(detail), "the file could not be written here (disk full?)");
      free(g.body);
      break;
    }
    have += g.bodyLen;
    free(g.body);

    if ((g.status == 200) || (g.bodyLen == 0))
      break;
  }

  if ((fclose(fP) != 0) && (detail[0] == 0))
    snprintf(detail, sizeof(detail), "the file could not be written here (disk full?)");

  if ((detail[0] == 0) && ((have != total) || (have != size)))
    snprintf(detail, sizeof(detail), "%lld bytes read, the broker lists %lld", have, size);

  if ((detail[0] == 0) && (rename(part, path) != 0))
    snprintf(detail, sizeof(detail), "the file could not be renamed here");

  if (detail[0] != 0)
  {
    remove(part);
    serveError(connP, 502, "Not saved - kept on the broker", detail);
    return;
  }

  //
  // Here, whole: the broker's copy goes
  //
  Got d;
  brokerCall(CorVerbDelete, broker, brokerPath, NULL, &d);
  bool deleted = (d.status == 204) || (d.status == 200) || (d.status == 404);
  free(d.body);

  char* pathE  = jsonEscape(connP, path);
  int   len    = strlen(pathE) + 200;
  char* answer = corAlloc(&connP->alloc, len);
  snprintf(answer, len, "{\"path\": \"%s\", \"size\": %lld, \"deleted\": %s}", pathE, have, deleted ? "true" : "false");
  serveJson(connP, 200, answer);
}
