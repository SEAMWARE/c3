//
// FILE            assistLocal.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// AI Assist, the development engine: Claude Code (`claude -p`) as the model, on the login of whoever runs c3 -
// their own subscription or Seamware seat, their own use - with corMcp as its tool server. On with C3_DEV=1
// alone: while the Coraine Assistant is developed, every tester asks on their own login, nothing is billed per
// question, and no login is ever shared. The instructions: system.md of the private repository
// SEAMWARE-cor/coraine-assistant ($C3_ASSIST_DIR, default ~/git/coraine-assistant) when it is there, else the
// short ones built in.
//
//   GET    /api/assist          {"available", "provider", "model"} or {"available": false, "reason"}
//   POST   /api/assist/ask      {"broker", "tenant", "question", "session"}: the answer as server-sent events
//   POST   /api/assist/stop     {"session"}: the question being answered there is given up
//   POST   /api/assist/ui       {"call", "ok", "text"}: the page's result of a c3 command (a "ui" event)
//   POST   /api/assist/mcp/<s>  c3's own MCP server (Streamable HTTP, JSON answers) - the c3 commands the page
//                               sent with the question ("uiTools"); <s> is the ask's secret, in its MCP config
//
// The events of an ask - the panel's vocabulary, not Claude Code's (another provider sends the same):
//
//   start       {"session"}                         the conversation the question is part of
//   text        {"text"}                            the answer, a piece at a time
//   tool        {"id", "name", "input"}             a tool call (the name without mcp__ngsild__)
//   toolResult  {"id", "isError", "text"}           its result, the text cut at 4000 characters
//   usage       {"window", "utilization", "resetsAt"} how much of the plan's window is used
//   end         {"answer", "turns", "seconds", "costUsd", "input", "output", "cacheRead", "isError"}
//   error       {"detail"}                          no answer: why
//   serverDown  {"server", "status"}                a tool server (ngsild, c3) did not connect - its tools are missing
//   ui          {"call", "name", "args"}            a c3 command for the page to carry out - its result
//                                                   comes back on POST /api/assist/ui
//
// A tool event's "kind" is "broker" (corMcp) or "c3" (a command - the page shows those from the ui event).
//
// A conversation is Claude Code's session: --session-id on its first question, --resume on the next ones,
// always run in the same (empty) directory - $XDG_DATA_HOME/c3/assist/work. The broker, the tenant and the
// token are corMcp's command line and environment, in an MCP configuration file of mode 600 that lives as
// long as the ask. No built-in tool of Claude Code's is offered, no setting file read, corMcp's write tools
// are not enabled: the model reads the broker, nothing else.
//
// Environment: C3_DEV=1 (else nothing here answers but "not available"), C3_ASSIST_MODEL (sonnet), C3_CORMCP
// (corMcp's path; default: found in $PATH), C3_ASSIST_DIR (the coraine-assistant checkout).
//
#define _GNU_SOURCE                              // pipe2
#include <errno.h>                               // errno
#include <fcntl.h>                               // open, O_*
#include <pthread.h>                             // pthread_*
#include <signal.h>                              // kill, SIGTERM
#include <stdio.h>                               // snprintf
#include <stdlib.h>                              // getenv, malloc, realloc, free
#include <string.h>                              // strcmp, strlen, memchr, memmove, strerror
#include <sys/random.h>                          // getrandom
#include <sys/wait.h>                            // waitpid
#include <time.h>                                // time
#include <unistd.h>                              // pipe2, read, close, unlink, write

#include "corAlloc/corAlloc.h"                   // CorAlloc
#include "corAlloc/corAllocBufferInit.h"         // corAllocBufferInit
#include "corAlloc/corAllocBufferReset.h"        // corAllocBufferReset
#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup
#include "corJson/CorJson.h"                     // CorJson
#include "corJson/corJsonCreate.h"               // corJsonCreate
#include "corJson/corJsonParse.h"                // corJsonParse
#include "corJson/corJsonRender.h"               // corJsonFastRender
#include "corJson/corJsonRenderSize.h"           // corJsonFastRenderSize
#include "corTree/CorNode.h"                     // CorNode
#include "corTree/corTreeLookup.h"               // corTreeLookup

#include "c3.h"

#ifndef C3_CLONES
#define C3_CLONES ""
#endif
#define C3_CLONES_DIR C3_CLONES                 // the clones c3 was built against (the makefile's COR_LIBS)



// -----------------------------------------------------------------------------
//
// Limits
//
#define ASKS_MAX           4                     // questions being answered at the same time
#define QUESTION_MAX       8000
#define LINE_MAX_BYTES     (16 * 1024 * 1024)    // a longer line of Claude Code's is skipped
#define RESULT_TEXT_MAX    4000



// -----------------------------------------------------------------------------
//
// What was found at start
//
static bool  available = false;
static char  reason[256];
static char  claudePath[1024];
static char* instructions = NULL;              // system.md of coraine-assistant, NULL: the built-in ones
static char  instructionsFrom[1200];
static char  docsDirs[2600];                    // corMcp's --docs: coraine's doc/ and the knowledge base, those there are
static char  corMcpPath[1024];
static char  model[64];
static char  workDir[1024];
static char  asksDir[1024];



// -----------------------------------------------------------------------------
//
// Ask - one question being answered
//
typedef struct Ask
{
  char            session[37];
  char            broker[512];
  char            tenant[256];
  char*           question;
  char*           token;                         // the broker's, or NULL
  bool            resume;
  char            cfgPath[1100];
  pid_t           pid;
  int             pipeFd;
  CorHttpStream*  streamP;
  bool            stopped;
  char            secret[33];                    // the path of c3's MCP server for this ask
  char*           uiTools;                       // the c3 commands the page offers (a JSON array), or NULL
} Ask;

static pthread_mutex_t aMutex = PTHREAD_MUTEX_INITIALIZER;
static Ask*            asks[ASKS_MAX];



// -----------------------------------------------------------------------------
//
// UiCall - a c3 command waiting for the page's result; its MCP request suspended meanwhile
//
#define UI_CALLS_MAX     16
#define UI_TIMEOUT_S     600                   // a command may wait for the user's yes or no

typedef struct UiCall
{
  char          id[33];
  char          session[37];
  CorHttpConn*  connP;
  char*         rpcId;                           // the JSON-RPC id, as JSON
  bool          done;                            // the page answered
  bool          cancelled;                       // the ask ended first
  bool          ok;
  char*         text;
} UiCall;

static pthread_cond_t  uiCond = PTHREAD_COND_INITIALIZER;   // with aMutex
static UiCall*         uiCalls[UI_CALLS_MAX];



// -----------------------------------------------------------------------------
//
// assistLocalInit - is the dev provider there?
//
bool assistLocalInit(void)
{
  const char* dev = getenv("C3_DEV");

  if ((dev == NULL) || (strcmp(dev, "1") != 0))
  {
    snprintf(reason, sizeof(reason), "not in this build of c3");
    return false;
  }

  if (inPath("claude", claudePath, sizeof(claudePath)) == false)
  {
    snprintf(reason, sizeof(reason), "C3_DEV=1, but no claude in $PATH");
    return false;
  }

  const char* mcp = getenv("C3_CORMCP");
  if ((mcp != NULL) && (mcp[0] != 0))
  {
    snprintf(corMcpPath, sizeof(corMcpPath), "%s", mcp);
    if (access(corMcpPath, X_OK) != 0)
    {
      snprintf(reason, sizeof(reason), "C3_CORMCP=%.200s: not an executable", mcp);
      return false;
    }
  }
  else if (inPath("corMcp", corMcpPath, sizeof(corMcpPath)) == false)
  {
    snprintf(reason, sizeof(reason), "C3_DEV=1, but no corMcp in $PATH (or C3_CORMCP=<its path>)");
    return false;
  }

  const char* m = getenv("C3_ASSIST_MODEL");
  snprintf(model, sizeof(model), "%s", ((m != NULL) && (m[0] != 0)) ? m : "sonnet");

  if ((dataHome("assist/work", workDir, sizeof(workDir)) == false) || (dataHome("assist/asks", asksDir, sizeof(asksDir)) == false) ||
      (dirsMake(workDir) == false) || (dirsMake(asksDir) == false))
  {
    snprintf(reason, sizeof(reason), "no data directory for the assistant ($XDG_DATA_HOME/c3/assist)");
    return false;
  }

  //
  // The instructions: the private repository's, when it is checked out here
  //
  const char* dir = getenv("C3_ASSIST_DIR");
  const char* home = getenv("HOME");
  char        path[1200];

  if ((dir != NULL) && (dir[0] != 0))
    snprintf(path, sizeof(path), "%s/system.md", dir);
  else
    snprintf(path, sizeof(path), "%s/git/coraine-assistant/system.md", (home != NULL) ? home : "");
  //
  // What the assistant may search (corMcp --docs): $C3_ASSIST_DOCS, else coraine's doc/ of the clone c3 builds
  // from, and the knowledge/ of the coraine-assistant checkout - the ones that are there
  //
  const char* docs = getenv("C3_ASSIST_DOCS");
  if ((docs != NULL) && (docs[0] != 0))
    snprintf(docsDirs, sizeof(docsDirs), "%s", docs);
  else
  {
    char d1[1200];
    char d2[1300];
    snprintf(d1, sizeof(d1), "%s/coraine/doc", C3_CLONES_DIR);
    snprintf(d2, sizeof(d2), "%.*s/knowledge", (int) (strlen(path) - strlen("/system.md")), path);
    if ((C3_CLONES_DIR[0] != 0) && (access(d1, R_OK) == 0))
      snprintf(docsDirs, sizeof(docsDirs), "%s", d1);
    if (access(d2, R_OK) == 0)
      snprintf(docsDirs + strlen(docsDirs), sizeof(docsDirs) - strlen(docsDirs), "%s%s", (docsDirs[0] != 0) ? ":" : "", d2);
  }

  instructions = fileText(path);                 // there now? (read again with every question: a git pull takes effect at once)
  snprintf(instructionsFrom, sizeof(instructionsFrom), "%s", (instructions != NULL) ? path : "");

  available = true;
  return true;
}



// -----------------------------------------------------------------------------
//
// uuidValid / uuidNew - a session id, as Claude Code takes it
//
static bool uuidValid(const char* s)
{
  if (strlen(s) != 36)
    return false;

  for (int ix = 0; ix < 36; ix++)
  {
    char c = s[ix];

    if ((ix == 8) || (ix == 13) || (ix == 18) || (ix == 23))
    {
      if (c != '-')
        return false;
    }
    else if (((c < '0') || (c > '9')) && ((c < 'a') || (c > 'f')))
      return false;
  }

  return true;
}

static bool uuidNew(char* out)
{
  unsigned char b[16];

  if (getrandom(b, sizeof(b), 0) != (ssize_t) sizeof(b))
    return false;

  b[6] = (b[6] & 0x0F) | 0x40;                   // version 4
  b[8] = (b[8] & 0x3F) | 0x80;                   // the RFC 4122 variant

  snprintf(out, 37, "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
           b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]);
  return true;
}



static bool hexNew(char* out, int bytes)
{
  unsigned char b[32];

  if ((bytes > 32) || (getrandom(b, bytes, 0) != (ssize_t) bytes))
    return false;

  for (int ix = 0; ix < bytes; ix++)
    snprintf(&out[ix * 2], 3, "%02x", b[ix]);
  return true;
}



// -----------------------------------------------------------------------------
//
// emit - one event to the page; false: the page is gone
//
static bool emit(Ask* aP, const char* event, Str* dataP)
{
  Str s = { NULL, 0, 0 };

  strAddf(&s, "event: %s\ndata: ", event);
  strAddN(&s, dataP->s, dataP->len);
  strAdd(&s, "\n\n");

  bool ok = corHttpStreamWrite(aP->streamP, s.s, s.len);

  strFree(&s);
  strFree(dataP);
  return ok;
}



// -----------------------------------------------------------------------------
//
// strAddNode - a node as compact JSON
//
static void strAddNode(Str* sP, CorNode* nodeP)
{
  if (nodeP == NULL)
  {
    strAdd(sP, "null");
    return;
  }

  int   size = corJsonFastRenderSize(nodeP) + 1;
  char* buf  = malloc(size);

  if (buf == NULL)
  {
    strAdd(sP, "null");
    return;
  }

  corJsonFastRender(nodeP, buf);                 // a member node alone - corJson#10
  strAdd(sP, buf);
  free(buf);
}



// -----------------------------------------------------------------------------
//
// strAddJsonCut - a JSON string of at most 'max' bytes of 's' (cut on a UTF-8 character boundary)
//
static void strAddJsonCut(Str* sP, const char* s, int max)
{
  int len = strlen(s);

  if (len <= max)
  {
    strAddJson(sP, s);
    return;
  }

  while ((max > 0) && ((((unsigned char) s[max]) & 0xC0) == 0x80))
    --max;

  char* cut = malloc(max + 4);                   // the cut, '…' (3 bytes) and the terminating zero
  if (cut == NULL)
  {
    strAdd(sP, "\"\"");
    return;
  }
  memcpy(cut, s, max);
  memcpy(&cut[max], "…", 4);                     // 3 bytes and the terminating zero
  strAddJson(sP, cut);
  free(cut);
}



// -----------------------------------------------------------------------------
//
// nodeNumber - an Int or a Float as a double; 'dflt' if neither
//
static double nodeNumber(CorNode* nP, double dflt)
{
  if (nP == NULL)                return dflt;
  if (nP->type == CorInt)        return (double) nP->value.i;
  if (nP->type == CorFloat)      return nP->value.f;
  return dflt;
}

static const char* nodeString(CorNode* objectP, const char* name)
{
  CorNode* nP = (objectP != NULL) ? corTreeLookup(objectP, name) : NULL;
  return ((nP != NULL) && (nP->type == CorString)) ? nP->value.s : NULL;
}



// -----------------------------------------------------------------------------
//
// lineHandle - one line of Claude Code's stream-json, as the panel's events. false: the page is gone.
// *endedP: the result came.
//
static bool lineHandle(Ask* aP, CorNode* evP, bool* endedP)
{
  const char* type = nodeString(evP, "type");

  if (type == NULL)
    return true;

  if (strcmp(type, "stream_event") == 0)
  {
    CorNode*    eP    = corTreeLookup(evP, "event");
    const char* etype = nodeString(eP, "type");

    if ((etype == NULL) || (strcmp(etype, "content_block_delta") != 0))
      return true;

    CorNode*    dP   = corTreeLookup(eP, "delta");
    const char* dt   = nodeString(dP, "type");
    const char* text = nodeString(dP, "text");

    if ((dt == NULL) || (strcmp(dt, "text_delta") != 0) || (text == NULL))
      return true;

    Str s = { NULL, 0, 0 };
    strAdd(&s, "{\"text\": ");
    strAddJson(&s, text);
    strAdd(&s, "}");
    return emit(aP, "text", &s);
  }

  if ((strcmp(type, "assistant") == 0) || (strcmp(type, "user") == 0))
  {
    CorNode* mP       = corTreeLookup(evP, "message");
    CorNode* contentP = (mP != NULL) ? corTreeLookup(mP, "content") : NULL;

    if ((contentP == NULL) || (contentP->type != CorArray))
      return true;

    for (CorNode* bP = contentP->value.head; bP != NULL; bP = bP->next)
    {
      const char* bt = nodeString(bP, "type");
      const char* id = (bt != NULL) ? nodeString(bP, (strcmp(bt, "tool_use") == 0) ? "id" : "tool_use_id") : NULL;

      if ((bt == NULL) || (id == NULL))
        continue;

      Str s = { NULL, 0, 0 };

      if (strcmp(bt, "tool_use") == 0)
      {
        const char* name = nodeString(bP, "name");

        if (name == NULL)
          continue;

        const char* kind = "broker";
        if (strncmp(name, "mcp__ngsild__", 13) == 0)
          name = &name[13];
        else if (strncmp(name, "mcp__c3__", 9) == 0)
        {
          name = &name[9];
          kind = "c3";
        }

        strAdd(&s, "{\"id\": ");
        strAddJson(&s, id);
        strAddf(&s, ", \"kind\": \"%s\"", kind);
        strAdd(&s, ", \"name\": ");
        strAddJson(&s, name);
        strAdd(&s, ", \"input\": ");
        strAddNode(&s, corTreeLookup(bP, "input"));
        strAdd(&s, "}");

        if (emit(aP, "tool", &s) == false)
          return false;
      }
      else if (strcmp(bt, "tool_result") == 0)
      {
        CorNode* errP = corTreeLookup(bP, "is_error");
        CorNode* cP   = corTreeLookup(bP, "content");
        Str      text = { NULL, 0, 0 };

        if ((cP != NULL) && (cP->type == CorString))
          strAdd(&text, cP->value.s);
        else if ((cP != NULL) && (cP->type == CorArray))
        {
          for (CorNode* pP = cP->value.head; pP != NULL; pP = pP->next)
          {
            const char* t = nodeString(pP, "text");
            if (t != NULL)
              strAdd(&text, t);
          }
        }

        strAdd(&s, "{\"id\": ");
        strAddJson(&s, id);
        strAddf(&s, ", \"isError\": %s, \"text\": ", ((errP != NULL) && (errP->type == CorBoolean) && (errP->value.b == true)) ? "true" : "false");
        strAddJsonCut(&s, (text.s != NULL) ? text.s : "", RESULT_TEXT_MAX);
        strAdd(&s, "}");
        strFree(&text);

        if (emit(aP, "toolResult", &s) == false)
          return false;
      }
    }

    return true;
  }

  //
  // The start: an MCP server that did not connect is said - in c3's log and to the page
  //
  if (strcmp(type, "system") == 0)
  {
    const char* sub     = nodeString(evP, "subtype");
    CorNode*    serversP = corTreeLookup(evP, "mcp_servers");

    if ((sub == NULL) || (strcmp(sub, "init") != 0) || (serversP == NULL) || (serversP->type != CorArray))
      return true;

    for (CorNode* mP = serversP->value.head; mP != NULL; mP = mP->next)
    {
      const char* name   = nodeString(mP, "name");
      const char* status = nodeString(mP, "status");

      if ((name == NULL) || (status == NULL) || (strcmp(status, "connected") == 0))
        continue;

      fprintf(stderr, "c3 assist: the MCP server %s did not connect: %s\n", name, status);

      Str s = { NULL, 0, 0 };
      strAdd(&s, "{\"server\": ");
      strAddJson(&s, name);
      strAdd(&s, ", \"status\": ");
      strAddJson(&s, status);
      strAdd(&s, "}");
      if (emit(aP, "serverDown", &s) == false)
        return false;
    }
    return true;
  }

  if (strcmp(type, "rate_limit_event") == 0)
  {
    CorNode*    iP     = corTreeLookup(evP, "rate_limit_info");
    const char* window = nodeString(iP, "rateLimitType");
    CorNode*    wsP    = (iP != NULL) ? corTreeLookup(iP, "unifiedWindows") : NULL;
    CorNode*    wP     = ((wsP != NULL) && (window != NULL)) ? corTreeLookup(wsP, window) : NULL;
    double      used   = nodeNumber((wP != NULL) ? corTreeLookup(wP, "utilization") : NULL, -1);

    if ((window == NULL) || (used < 0))
      return true;

    Str s = { NULL, 0, 0 };
    strAdd(&s, "{\"window\": ");
    strAddJson(&s, window);
    strAddf(&s, ", \"utilization\": %.3f, \"resetsAt\": %.0f}", used, nodeNumber(corTreeLookup(wP, "resetsAt"), 0));
    return emit(aP, "usage", &s);
  }

  if (strcmp(type, "result") == 0)
  {
    const char* answer = nodeString(evP, "result");
    CorNode*    errP   = corTreeLookup(evP, "is_error");
    CorNode*    uP     = corTreeLookup(evP, "usage");
    Str         s      = { NULL, 0, 0 };

    strAdd(&s, "{\"answer\": ");
    strAddJson(&s, (answer != NULL) ? answer : "");
    strAddf(&s, ", \"turns\": %.0f, \"seconds\": %.1f, \"costUsd\": %.4f, \"input\": %.0f, \"output\": %.0f, \"cacheRead\": %.0f, \"isError\": %s}",
            nodeNumber(corTreeLookup(evP, "num_turns"), 0),
            nodeNumber(corTreeLookup(evP, "duration_ms"), 0) / 1000,
            nodeNumber(corTreeLookup(evP, "total_cost_usd"), 0),
            nodeNumber((uP != NULL) ? corTreeLookup(uP, "input_tokens") : NULL, 0),
            nodeNumber((uP != NULL) ? corTreeLookup(uP, "output_tokens") : NULL, 0),
            nodeNumber((uP != NULL) ? corTreeLookup(uP, "cache_read_input_tokens") : NULL, 0),
            ((errP != NULL) && (errP->type == CorBoolean) && (errP->value.b == true)) ? "true" : "false");

    *endedP = true;
    return emit(aP, "end", &s);
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// askFree - out of the table, its file gone
//
static void askFree(Ask* aP)
{
  pthread_mutex_lock(&aMutex);
  for (int ix = 0; ix < ASKS_MAX; ix++)
  {
    if (asks[ix] == aP)
      asks[ix] = NULL;
  }

  //
  // Its commands still waiting for the page: answered now - nobody will carry them out
  //
  for (int ix = 0; ix < UI_CALLS_MAX; ix++)
  {
    if ((uiCalls[ix] != NULL) && (strcmp(uiCalls[ix]->session, aP->session) == 0))
      uiCalls[ix]->cancelled = true;
  }
  pthread_cond_broadcast(&uiCond);
  pthread_mutex_unlock(&aMutex);

  //
  // Out of the table first: an emit from another thread (a ui event) holds aMutex and finds the ask or not
  //
  if (aP->streamP != NULL)
    corHttpStreamEnd(aP->streamP);

  if (aP->cfgPath[0] != 0)
    unlink(aP->cfgPath);

  free(aP->question);
  free(aP->token);
  free(aP->uiTools);
  free(aP);
}



// -----------------------------------------------------------------------------
//
// askThread - Claude Code's output, line by line, to the page; then the end of the stream
//
static void* askThread(void* arg)
{
  Ask*     aP     = (Ask*) arg;
  char*    buf    = NULL;
  int      bufLen = 0;
  int      bufCap = 0;
  bool     skip   = false;                       // inside a line that was too long
  bool     ended  = false;
  bool     gone   = false;
  char     tail[1024];                           // the last line that was not JSON - stderr, mostly
  char     abuf[64 * 1024];
  CorAlloc alloc;

  tail[0] = 0;
  corAllocBufferInit(&alloc, abuf, sizeof(abuf), 64 * 1024 * 1024, NULL, "c3 assist");

  while (true)
  {
    if (bufCap - bufLen < 65536)
    {
      int   cap  = (bufCap == 0) ? 131072 : bufCap * 2;
      char* newP = (cap <= LINE_MAX_BYTES + 65536) ? realloc(buf, cap) : NULL;

      if (newP == NULL)
      {
        bufLen = 0;                              // the line so far is dropped, and the rest of it
        skip   = true;
      }
      else
      {
        buf    = newP;
        bufCap = cap;
      }
    }

    ssize_t n = read(aP->pipeFd, &buf[bufLen], bufCap - bufLen - 1);

    if ((n < 0) && (errno == EINTR))
      continue;
    if (n <= 0)
      break;

    bufLen += n;

    char* start = buf;
    char* nl;

    while ((nl = memchr(start, '\n', bufLen - (start - buf))) != NULL)
    {
      *nl = 0;

      if (skip == true)
        skip = false;
      else if ((gone == false) && (start[0] == '{'))
      {
        CorJson  json;
        corJsonCreate(&json, &alloc);
        CorNode* evP = corJsonParse(&json, start);

        if ((evP != NULL) && (evP->type == CorObject))
        {
          if (lineHandle(aP, evP, &ended) == false)
          {
            gone = true;                         // the page closed the stream: the question is given up
            kill(-aP->pid, SIGTERM);
          }
        }
        corAllocBufferReset(&alloc, true);
      }
      else if (start[0] != 0)
        snprintf(tail, sizeof(tail), "%s", start);

      start = nl + 1;
    }

    bufLen -= (start - buf);
    memmove(buf, start, bufLen);
  }

  corAllocBufferReset(&alloc, false);
  free(buf);
  close(aP->pipeFd);

  int status = 0;
  waitpid(aP->pid, &status, 0);

  if ((gone == false) && (ended == false))
  {
    Str s = { NULL, 0, 0 };
    Str d = { NULL, 0, 0 };

    if (aP->stopped == true)
      strAdd(&d, "stopped");
    else if (WIFEXITED(status))
      strAddf(&d, "Claude Code exited with %d%s%s", WEXITSTATUS(status), (tail[0] != 0) ? ": " : "", tail);
    else
      strAddf(&d, "Claude Code was killed (signal %d)", WIFSIGNALED(status) ? WTERMSIG(status) : 0);

    strAdd(&s, "{\"detail\": ");
    strAddJson(&s, d.s);
    strAdd(&s, "}");
    strFree(&d);
    emit(aP, "error", &s);
  }

  askFree(aP);
  return NULL;
}



// -----------------------------------------------------------------------------
//
// cfgWrite - corMcp for this ask: the broker, the tenant, the token - mode 600, removed when the ask ends
//
static bool cfgWrite(Ask* aP, char* errBuf, int errLen)
{
  snprintf(aP->cfgPath, sizeof(aP->cfgPath), "%s/%s.json", asksDir, aP->session);

  Str s = { NULL, 0, 0 };
  strAdd(&s, "{\"mcpServers\": {\"ngsild\": {\"command\": ");
  strAddJson(&s, corMcpPath);
  strAdd(&s, ", \"args\": [\"--broker\", ");
  strAddJson(&s, aP->broker);
  if (docsDirs[0] != 0)
  {
    strAdd(&s, ", \"--docs\", ");
    strAddJson(&s, docsDirs);
  }
  if (aP->tenant[0] != 0)
  {
    strAdd(&s, ", \"--tenant\", ");
    strAddJson(&s, aP->tenant);
  }
  if (aP->token != NULL)
  {
    strAdd(&s, ", \"--token-env\", \"C3_BROKER_TOKEN\"], \"env\": {\"C3_BROKER_TOKEN\": ");
    strAddJson(&s, aP->token);
    strAdd(&s, "}}");
  }
  else
    strAdd(&s, "]}");
  if (aP->uiTools != NULL)
    strAddf(&s, ", \"c3\": {\"type\": \"http\", \"url\": \"http://127.0.0.1:%d/api/assist/mcp/%s\"}", (int) c3Port, aP->secret);
  strAdd(&s, "}}\n");

  int fd = open(aP->cfgPath, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd == -1)
  {
    snprintf(errBuf, errLen, "%s: %s", aP->cfgPath, strerror(errno));
    aP->cfgPath[0] = 0;
    strFree(&s);
    return false;
  }

  bool ok = (write(fd, s.s, s.len) == (ssize_t) s.len);
  close(fd);
  strFree(&s);

  if (ok == false)
    snprintf(errBuf, errLen, "%s: cannot be written", aP->cfgPath);
  return ok;
}



// -----------------------------------------------------------------------------
//
// systemPrompt - who the model is, and what it is connected to
//
static void systemPrompt(Ask* aP, Str* sP)
{
  char now[64];
  isoTime(time(NULL), now, sizeof(now));

  char* fresh = (instructionsFrom[0] != 0) ? fileText(instructionsFrom) : NULL;

  if (fresh != NULL)
  {
    strAdd(sP, fresh);
    free(fresh);
    strAddf(sP, "\n\nConnected to: the broker at %s, tenant %s. The current time is %s.",
            aP->broker, (aP->tenant[0] != 0) ? aP->tenant : "(the default tenant)", now);
    return;
  }

  strAddf(sP,
          "You are the assistant in c³, the control centre of coraine, an NGSI-LD context broker. "
          "You are connected to the broker at %s, tenant %s, and you read it with the tools - you cannot change anything in it. "
          "Answer the user's questions from the broker's data. Never invent data: when the broker does not have it, say so. "
          "Prefer counting before listing, and ask for only the attributes you need. "
          "Be brief: the answer first, then what supports it. "
          "Write every entity id in full, as code (`urn:ngsi-ld:Store:S-17`) - the user can click it to see the entity. "
          "Answer in the language of the question. The current time is %s.",
          aP->broker, (aP->tenant[0] != 0) ? aP->tenant : "(the default tenant)", now);

  if (aP->uiTools != NULL)
    strAdd(sP, " "
           "With the c3 tools you also steer c³ itself. In Explore: colours, the types shown or loaded, highlights, the "
           "selected entity, graph or map - they change the view only, never the broker's data, so carry them out without "
           "asking; before a command that names types, use get_view. In Compile and Operate: builds (compile_options, "
           "start_build, build_status) and brokers (operate_status, start_broker, stop_broker), and connect_explore - "
           "c³ shows the user the exact command and asks before any of these runs, so do not ask in words first. A build "
           "takes minutes: start it, say so, and do not wait for it in the same answer. Every change is recorded: when the "
           "user regrets one (\"undo that\", \"go back to what we had\"), use list_changes and undo.");
}



// -----------------------------------------------------------------------------
//
// askStart - POST /api/assist/ask
//
static void askStart(CorHttpConn* connP, CorNode* bodyP)
{
  const char* broker   = nodeString(bodyP, "broker");
  const char* tenant   = nodeString(bodyP, "tenant");
  const char* question = nodeString(bodyP, "question");
  const char* session  = nodeString(bodyP, "session");

  if ((broker == NULL) || ((strncmp(broker, "http://", 7) != 0) && (strncmp(broker, "https://", 8) != 0)) || (strlen(broker) >= 512))
  {
    serveError(connP, 400, "Bad request", "broker: the broker's URL, http(s)://host:port");
    return;
  }
  if ((tenant != NULL) && (tenant[0] != 0) && (tenantValid(tenant) == false))
  {
    serveError(connP, 400, "Bad request", "tenant: 1-255 printable characters, no blank");
    return;
  }
  if ((question == NULL) || (question[0] == 0) || (strlen(question) > QUESTION_MAX))
  {
    serveError(connP, 400, "Bad request", "question: 1-8000 characters");
    return;
  }
  if ((session != NULL) && (uuidValid(session) == false))
  {
    serveError(connP, 400, "Bad request", "session: the id a start event gave");
    return;
  }

  CorNode* uiToolsP = corTreeLookup(bodyP, "uiTools");
  if ((uiToolsP != NULL) && (uiToolsP->type != CorArray))
  {
    serveError(connP, 400, "Bad request", "uiTools: an array of MCP tool definitions");
    return;
  }

  Ask* aP = calloc(1, sizeof(Ask));
  if (aP == NULL)
  {
    serveError(connP, 500, "Internal error", "out of memory");
    return;
  }

  int blen = strlen(broker);
  while ((blen > 0) && (broker[blen - 1] == '/'))
    --blen;
  snprintf(aP->broker, sizeof(aP->broker), "%.*s", blen, broker);
  snprintf(aP->tenant, sizeof(aP->tenant), "%s", (tenant != NULL) ? tenant : "");

  aP->question = strdup(question);
  aP->token    = credsToken(aP->broker, NULL);
  aP->pipeFd   = -1;

  if ((uiToolsP != NULL) && (uiToolsP->value.head != NULL))
  {
    Str t = { NULL, 0, 0 };
    strAddNode(&t, uiToolsP);
    aP->uiTools = t.s;                           // the Str's buffer, kept

    if ((aP->uiTools == NULL) || (t.len > 256 * 1024) || (hexNew(aP->secret, 16) == false))
    {
      askFree(aP);
      serveError(connP, 400, "Bad request", "uiTools: at most 256 KiB");
      return;
    }
  }

  if (session != NULL)
  {
    snprintf(aP->session, sizeof(aP->session), "%s", session);
    aP->resume = true;
  }
  else if (uuidNew(aP->session) == false)
  {
    askFree(aP);
    serveError(connP, 500, "Internal error", "no random bytes for a session id");
    return;
  }

  //
  // A place in the table - one question at a time per conversation
  //
  pthread_mutex_lock(&aMutex);
  int slot = -1;
  for (int ix = 0; ix < ASKS_MAX; ix++)
  {
    if ((asks[ix] != NULL) && (strcmp(asks[ix]->session, aP->session) == 0))
    {
      pthread_mutex_unlock(&aMutex);
      askFree(aP);
      serveError(connP, 409, "Conflict", "a question of this conversation is being answered");
      return;
    }
    if ((asks[ix] == NULL) && (slot == -1))
      slot = ix;
  }
  if (slot == -1)
  {
    pthread_mutex_unlock(&aMutex);
    askFree(aP);
    serveError(connP, 503, "Busy", "four questions are being answered already");
    return;
  }
  asks[slot] = aP;
  pthread_mutex_unlock(&aMutex);

  char err[1200];
  if (cfgWrite(aP, err, sizeof(err)) == false)
  {
    askFree(aP);
    serveError(connP, 500, "Cannot ask", err);
    return;
  }

  Str sys = { NULL, 0, 0 };
  systemPrompt(aP, &sys);

  char* argv[32];
  int   argc = 0;

  argv[argc++] = claudePath;
  argv[argc++] = (char*) "-p";
  argv[argc++] = (char*) "--model";
  argv[argc++] = model;
  argv[argc++] = (char*) "--mcp-config";
  argv[argc++] = aP->cfgPath;
  argv[argc++] = (char*) "--strict-mcp-config";
  argv[argc++] = (char*) "--tools";
  argv[argc++] = (char*) "";
  argv[argc++] = (char*) "--allowedTools";
  argv[argc++] = (char*) "mcp__ngsild";
  if (aP->uiTools != NULL)
    argv[argc++] = (char*) "mcp__c3";
  argv[argc++] = (char*) "--system-prompt";
  argv[argc++] = sys.s;
  argv[argc++] = (char*) "--setting-sources";
  argv[argc++] = (char*) "";
  argv[argc++] = (char*) (aP->resume ? "--resume" : "--session-id");
  argv[argc++] = aP->session;
  argv[argc++] = (char*) "--output-format";
  argv[argc++] = (char*) "stream-json";
  argv[argc++] = (char*) "--verbose";
  argv[argc++] = (char*) "--include-partial-messages";
  argv[argc++] = (char*) "--";
  argv[argc++] = aP->question;
  argv[argc]   = NULL;

  int fds[2];
  if (pipe2(fds, O_CLOEXEC) != 0)
  {
    strFree(&sys);
    askFree(aP);
    serveError(connP, 500, "Cannot ask", "no pipe");
    return;
  }

  ProcSpawn spawn = { argv, NULL, fds[1], workDir, true, false, SIGTERM };
  pid_t     pid   = procSpawn(&spawn);

  close(fds[1]);
  strFree(&sys);

  if (pid < 0)
  {
    close(fds[0]);
    askFree(aP);
    serveError(connP, 500, "Cannot ask", "Claude Code could not be started");
    return;
  }

  aP->pid    = pid;
  aP->pipeFd = fds[0];

  corHttpResponseStatus(connP, 200);
  corHttpResponseHeader(connP, "Content-Type", "text/event-stream");
  corHttpResponseHeader(connP, "Cache-Control", "no-store");
  aP->streamP = corHttpResponseStream(connP);

  Str s = { NULL, 0, 0 };
  strAdd(&s, "{\"session\": ");
  strAddJson(&s, aP->session);
  strAdd(&s, "}");
  emit(aP, "start", &s);

  pthread_t      tid;
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

  if (pthread_create(&tid, &attr, askThread, aP) != 0)
  {
    groupStop(pid);
    waitpid(pid, NULL, 0);
    close(aP->pipeFd);
    s = (Str) { NULL, 0, 0 };
    strAdd(&s, "{\"detail\": \"no thread to follow the answer\"}");
    emit(aP, "error", &s);
    askFree(aP);
  }

  pthread_attr_destroy(&attr);
}



// -----------------------------------------------------------------------------
//
// askStop - POST /api/assist/stop
//
static void askStop(CorHttpConn* connP, CorNode* bodyP)
{
  const char* session = nodeString(bodyP, "session");
  bool        found   = false;

  pthread_mutex_lock(&aMutex);
  for (int ix = 0; (ix < ASKS_MAX) && (session != NULL); ix++)
  {
    if ((asks[ix] != NULL) && (strcmp(asks[ix]->session, session) == 0))
    {
      asks[ix]->stopped = true;
      kill(-asks[ix]->pid, SIGTERM);             // the ask's thread sees the end of the output, and reaps it
      found = true;
    }
  }
  pthread_mutex_unlock(&aMutex);

  if (found == false)
    serveError(connP, 404, "Not found", "no question of that conversation is being answered");
  else
    serveJson(connP, 200, "{}");
}



// -----------------------------------------------------------------------------
//
// rpcAnswer / rpcFail - a JSON-RPC answer, on a request the loop may or may not hold (respondStr copies)
//
static void rpcAnswer(CorHttpConn* connP, const char* id, Str* resultP)
{
  Str s = { NULL, 0, 0 };

  strAdd(&s, "{\"jsonrpc\": \"2.0\", \"id\": ");
  strAdd(&s, id);
  strAdd(&s, ", \"result\": ");
  strAddN(&s, (resultP->s != NULL) ? resultP->s : "{}", (resultP->s != NULL) ? resultP->len : 2);
  strAdd(&s, "}");
  strFree(resultP);
  respondStr(connP, 200, &s);
}

static void rpcFail(CorHttpConn* connP, const char* id, int code, const char* message)
{
  Str s = { NULL, 0, 0 };

  strAddf(&s, "{\"jsonrpc\": \"2.0\", \"id\": %s, \"error\": {\"code\": %d, \"message\": ", id, code);
  strAddJson(&s, message);
  strAdd(&s, "}}");
  respondStr(connP, 200, &s);
}



// -----------------------------------------------------------------------------
//
// uiWait - a c3 command's MCP request, answered when the page has carried it out (or could not)
//
static void* uiWait(void* arg)
{
  UiCall*         cP = (UiCall*) arg;
  struct timespec deadline;

  clock_gettime(CLOCK_REALTIME, &deadline);
  deadline.tv_sec += UI_TIMEOUT_S;

  pthread_mutex_lock(&aMutex);
  while ((cP->done == false) && (cP->cancelled == false))
  {
    if (pthread_cond_timedwait(&uiCond, &aMutex, &deadline) == ETIMEDOUT)
      break;
  }

  for (int ix = 0; ix < UI_CALLS_MAX; ix++)
  {
    if (uiCalls[ix] == cP)
      uiCalls[ix] = NULL;
  }
  pthread_mutex_unlock(&aMutex);

  const char* text = (cP->done == true)      ? ((cP->text != NULL) ? cP->text : "done") :
                     (cP->cancelled == true) ? "the question was stopped - not carried out" :
                                               "c³'s page did not carry it out in time (closed, or busy)";
  bool        ok   = (cP->done == true) && (cP->ok == true);
  Str         r    = { NULL, 0, 0 };

  strAdd(&r, "{\"content\": [{\"type\": \"text\", \"text\": ");
  strAddJson(&r, text);
  strAddf(&r, "}], \"isError\": %s}", ok ? "false" : "true");
  rpcAnswer(cP->connP, cP->rpcId, &r);
  corHttpResume(cP->connP);

  free(cP->rpcId);
  free(cP->text);
  free(cP);
  return NULL;
}



// -----------------------------------------------------------------------------
//
// mcpRequest - POST /api/assist/mcp/<secret>: c3's MCP server for one ask - initialize, tools/list (the
// page's commands), tools/call (handed to the page as a ui event)
//
static void mcpRequest(CorHttpConn* connP, const char* secret)
{
  if (strcmp(connP->method.s, "POST") != 0)
  {
    serveError(connP, 405, "Method not allowed", "POST - this server sends no stream of its own");
    return;
  }

  CorJson json;
  corJsonCreate(&json, &connP->alloc);

  char*    copy  = (connP->body.s != NULL) ? corAllocStrdup(&connP->alloc, connP->body.s) : NULL;
  CorNode* bodyP = (copy != NULL) ? corJsonParse(&json, copy) : NULL;

  if ((bodyP == NULL) || (bodyP->type != CorObject))
  {
    rpcFail(connP, "null", -32700, "a JSON-RPC object is expected");
    return;
  }

  CorNode*    idP    = corTreeLookup(bodyP, "id");
  const char* method = nodeString(bodyP, "method");
  CorNode*    paramsP = corTreeLookup(bodyP, "params");

  if (idP == NULL)                               // a notification (notifications/initialized ...): nothing to say
  {
    corHttpResponseStatus(connP, 202);
    return;
  }

  Str id = { NULL, 0, 0 };
  strAddNode(&id, idP);
  if ((id.s == NULL) || (id.len > 200) || ((idP->type != CorString) && (idP->type != CorInt)))
  {
    strFree(&id);
    rpcFail(connP, "null", -32600, "id: a string or a number");
    return;
  }
  char* idText = corAllocStrdup(&connP->alloc, id.s);
  strFree(&id);

  pthread_mutex_lock(&aMutex);

  Ask* aP = NULL;
  for (int ix = 0; (ix < ASKS_MAX) && (aP == NULL); ix++)
  {
    if ((asks[ix] != NULL) && (asks[ix]->uiTools != NULL) && (strcmp(asks[ix]->secret, secret) == 0))
      aP = asks[ix];
  }

  if (aP == NULL)
  {
    pthread_mutex_unlock(&aMutex);
    serveError(connP, 404, "Not found", "no such question being answered");
    return;
  }

  Str r = { NULL, 0, 0 };

  if ((method != NULL) && (strcmp(method, "initialize") == 0))
  {
    const char* version = nodeString(paramsP, "protocolVersion");
    strAdd(&r, "{\"protocolVersion\": ");
    strAddJson(&r, (version != NULL) ? version : "2025-06-18");
    strAdd(&r, ", \"capabilities\": {\"tools\": {}}, \"serverInfo\": {\"name\": \"c3\", \"version\": \"" C3_VERSION "\"}}");
  }
  else if ((method != NULL) && (strcmp(method, "ping") == 0))
    strAdd(&r, "{}");
  else if ((method != NULL) && (strcmp(method, "tools/list") == 0))
  {
    strAdd(&r, "{\"tools\": ");
    strAdd(&r, aP->uiTools);
    strAdd(&r, "}");
  }
  else if ((method != NULL) && (strcmp(method, "tools/call") == 0))
  {
    const char* name  = nodeString(paramsP, "name");
    CorNode*    argsP = (paramsP != NULL) ? corTreeLookup(paramsP, "arguments") : NULL;
    int         slot  = -1;

    for (int ix = 0; (ix < UI_CALLS_MAX) && (slot == -1); ix++)
    {
      if (uiCalls[ix] == NULL)
        slot = ix;
    }

    UiCall* cP = ((name != NULL) && (slot != -1)) ? calloc(1, sizeof(UiCall)) : NULL;

    if ((cP == NULL) || (hexNew(cP->id, 16) == false))
    {
      pthread_mutex_unlock(&aMutex);
      free(cP);
      rpcFail(connP, idText, -32602, (name == NULL) ? "params.name: the tool" : "too many commands waiting for the page");
      return;
    }

    snprintf(cP->session, sizeof(cP->session), "%s", aP->session);
    cP->connP = connP;
    cP->rpcId = strdup(idText);
    uiCalls[slot] = cP;

    Str e = { NULL, 0, 0 };
    strAdd(&e, "{\"call\": ");
    strAddJson(&e, cP->id);
    strAdd(&e, ", \"name\": ");
    strAddJson(&e, name);
    strAdd(&e, ", \"args\": ");
    if ((argsP != NULL) && (argsP->type == CorObject))
      strAddNode(&e, argsP);
    else
      strAdd(&e, "{}");
    strAdd(&e, "}");

    if (emit(aP, "ui", &e) == false)
      cP->cancelled = true;                      // the page is gone: uiWait answers at once
    pthread_mutex_unlock(&aMutex);

    corHttpSuspend(connP);

    pthread_t      tid;
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

    if (pthread_create(&tid, &attr, uiWait, cP) != 0)
    {
      pthread_mutex_lock(&aMutex);
      uiCalls[slot] = NULL;
      pthread_mutex_unlock(&aMutex);
      rpcFail(connP, idText, -32603, "no thread to wait for the page");
      corHttpResumeHere(connP);
      free(cP->rpcId);
      free(cP);
    }
    pthread_attr_destroy(&attr);
    return;
  }
  else
  {
    pthread_mutex_unlock(&aMutex);
    rpcFail(connP, idText, -32601, "no such method");
    return;
  }

  pthread_mutex_unlock(&aMutex);
  rpcAnswer(connP, idText, &r);
}



// -----------------------------------------------------------------------------
//
// uiResult - POST /api/assist/ui: what the page made of a c3 command
//
static void uiResult(CorHttpConn* connP, CorNode* bodyP)
{
  const char* call = nodeString(bodyP, "call");
  const char* text = nodeString(bodyP, "text");
  CorNode*    okP  = corTreeLookup(bodyP, "ok");
  bool        found = false;

  pthread_mutex_lock(&aMutex);
  for (int ix = 0; (ix < UI_CALLS_MAX) && (call != NULL); ix++)
  {
    UiCall* cP = uiCalls[ix];

    if ((cP != NULL) && (cP->done == false) && (cP->cancelled == false) && (strcmp(cP->id, call) == 0))
    {
      cP->done = true;
      cP->ok   = (okP != NULL) && (okP->type == CorBoolean) && (okP->value.b == true);
      cP->text = (text != NULL) ? strndup(text, 64 * 1024) : NULL;
      found    = true;
    }
  }
  pthread_cond_broadcast(&uiCond);
  pthread_mutex_unlock(&aMutex);

  if (found == false)
    serveError(connP, 404, "Not found", "no command of that id is waiting");
  else
    serveJson(connP, 200, "{}");
}



// -----------------------------------------------------------------------------
//
// assistLocalRequest - /api/assist...
//
void assistLocalRequest(CorHttpConn* connP, const char* path)
{
  const char* method = connP->method.s;

  if ((strcmp(path, "/api/assist") == 0) && (strcmp(method, "GET") == 0))
  {
    Str s = { NULL, 0, 0 };

    if (available == true)
    {
      strAdd(&s, "{\"available\": true, \"version\": \"" C3_VERSION "\", \"engine\": \"local\", \"provider\": \"Claude Code - your own login\", \"model\": ");
      strAddJson(&s, model);
      strAdd(&s, ", \"instructions\": ");
      strAddJson(&s, (instructions != NULL) ? instructionsFrom : "built in (no coraine-assistant checkout)");
      strAdd(&s, ", \"docs\": ");
      strAddJson(&s, docsDirs);
      strAdd(&s, ", \"tokenSet\": true}");
    }
    else
    {
      strAdd(&s, "{\"available\": false, \"reason\": ");
      strAddJson(&s, reason);
      strAdd(&s, "}");
    }
    respondStr(connP, 200, &s);
    return;
  }

  if ((available == true) && (strncmp(path, "/api/assist/mcp/", 16) == 0))
  {
    mcpRequest(connP, &path[16]);                // Claude Code's requests: no Origin - the secret is the key
    return;
  }

  if ((strcmp(method, "POST") != 0) ||
      ((strcmp(path, "/api/assist/ask") != 0) && (strcmp(path, "/api/assist/stop") != 0) && (strcmp(path, "/api/assist/ui") != 0)))
  {
    serveError(connP, 404, "Not found", path);
    return;
  }

  if (available == false)
  {
    serveError(connP, 404, "Not available", reason);
    return;
  }

  //
  // Only from c3's own page: a question spends the user's plan, and runs a program
  //
  const char* origin = corHttpHeader(connP, "Origin");
  if ((origin == NULL) ||
      ((strncmp(origin, "http://localhost:", 17) != 0) && (strncmp(origin, "http://127.0.0.1:", 17) != 0) && (strncmp(origin, "http://[::1]:", 13) != 0)))
  {
    serveError(connP, 403, "Forbidden", "a question must come from c3's own page (Origin: this machine)");
    return;
  }

  CorJson json;
  corJsonCreate(&json, &connP->alloc);

  char*    copy  = (connP->body.s != NULL) ? corAllocStrdup(&connP->alloc, connP->body.s) : NULL;
  CorNode* bodyP = (copy != NULL) ? corJsonParse(&json, copy) : NULL;

  if ((bodyP == NULL) || (bodyP->type != CorObject))
  {
    serveError(connP, 400, "Bad request", "a JSON object is expected as the body");
    return;
  }

#ifndef COR_HTTP_STREAM_PENDING_MAX
  (void) askStart;
  (void) askStop;
  (void) uiResult;
  (void) mcpRequest;
  serveError(connP, 501, "Not implemented", "this corHttp has no response streams");
#else
  if (strcmp(path, "/api/assist/ask") == 0)
    askStart(connP, bodyP);
  else if (strcmp(path, "/api/assist/ui") == 0)
    uiResult(connP, bodyP);
  else
    askStop(connP, bodyP);
#endif
}
