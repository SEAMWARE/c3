//
// FILE            assistService.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// AI Assist, the service engine (for paying customers, later - OFF unless $C3_ASSIST_URL names the service):
// questions about the broker Explore is connected to, answered by the Coraine Assistant, Seamware's hosted
// service, reached with the user's AI Assist token. The model, its
// instructions and its knowledge are the service's; the tools are c3's, and run here - corMcp against the broker
// (with the broker's token, which never leaves this machine), and the c3 commands of the page (c3tools.js). So
// the service never reaches the broker, and the broker need not be reachable from outside.
//
//   GET    /api/assist          {"available", "provider", "service", "tokenSet", "tokenSource", "serviceStatus",
//                                "me": {"name", "model", "month", "spentUsd", "limitUsd"}} or {"available": false, "reason"}
//   PUT    /api/assist/token    {"token", "remember"}: the AI Assist token - checked with the service first
//   DELETE /api/assist/token    the token forgotten (and out of assist.json)
//   POST   /api/assist/ask      {"broker", "tenant", "question", "session", "uiTools"}: the answer as server-sent events
//   POST   /api/assist/stop     {"session"}: the question being answered there is given up
//   POST   /api/assist/ui       {"call", "ok", "text"}: the page's result of a c3 command (a "ui" event)
//
// The events of an ask:
//
//   start       {"session"}                         the conversation the question is part of (the service's id)
//   text        {"text"}                            the answer, a piece at a time
//   tool        {"id", "kind", "name", "input"}     a tool call - kind "broker" (corMcp) or "c3" (a page command)
//   toolResult  {"id", "isError", "text"}           a broker tool's result, the text cut at 4000 characters
//   ui          {"call", "name", "args"}            a c3 command for the page to carry out - its result comes
//                                                   back on POST /api/assist/ui
//   usage       {"spentUsd", "limitUsd", "model"}   this month's spending of the token's holder
//   end         {"answer", "turns", "seconds", "costUsd", "input", "output", "cacheRead", "isError"}
//   error       {"detail"}                          no answer: why
//
// A question is one or more turns: one model call each, at the service. When the model calls tools, they run
// here and their results are the next turn. The service is asked with curl (an answer streams; corRest's client
// reads whole responses) - the token in a header file and the body in a file, both mode 600, never on a command
// line.
//
// The token, in this order: $C3_ASSIST_TOKEN; the one given in the panel - kept in memory, and with "remember"
// in assist.json beside the configuration (mode 600). Never sent to the page. The service: $C3_ASSIST_URL, else
// the default.
//
#define _GNU_SOURCE                              // pipe2
#include <errno.h>                               // errno
#include <fcntl.h>                               // open, O_*
#include <poll.h>                                // poll
#include <pthread.h>                             // pthread_*
#include <signal.h>                              // kill, SIGTERM
#include <stdio.h>                               // snprintf
#include <stdlib.h>                              // getenv, malloc, realloc, free
#include <string.h>                              // strcmp, strlen, memchr, memmove, strerror
#if defined(__linux__)
#include <sys/prctl.h>                           // prctl, PR_SET_PDEATHSIG
#endif
#include <sys/random.h>                          // getentropy
#include <sys/wait.h>                            // waitpid
#include <time.h>                                // time, clock_gettime
#include <unistd.h>                              // pipe2, read, write, close, unlink, fork, execve

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

extern char** environ;



// -----------------------------------------------------------------------------
//
// Limits
//
#define ASKS_MAX           4                     // questions being answered at the same time
#define QUESTION_MAX       8000
#define TURNS_MAX          30                    // model calls for one question
#define CALLS_MAX          32                    // tool calls in one turn
#define LINE_MAX_BYTES     (4 * 1024 * 1024)     // a longer line of the service's is skipped
#define RESULT_TEXT_MAX    4000                  // a tool result, as the page shows it
#define TOOL_RESULT_MAX    (200 * 1024)          // a tool result, as the model gets it
#define MCP_TIMEOUT_S      60                    // a corMcp call
#define UI_TIMEOUT_S       600                   // a c3 command may wait for the user's yes or no
#define TOKEN_MAX          256



// -----------------------------------------------------------------------------
//
// What was found at start
//
static bool  available = false;
static char  reason[256];
static char  curlPath[1024];
static char  corMcpPath[1024];
static char  asksDir[1024];
static char  service[512];
static char  tokenPath[4200];                    // assist.json, beside c3.json

static char*        token       = NULL;          // the AI Assist token (malloc'ed), under aMutex
static const char*  tokenSource = NULL;          // "environment", "remembered", "this session"



// -----------------------------------------------------------------------------
//
// Call - a tool call of a turn
//
typedef struct Call
{
  char*  id;
  char*  name;
  char*  input;                                  // JSON
  bool   c3;                                     // a page command, not corMcp's
} Call;



// -----------------------------------------------------------------------------
//
// Ask - one question being answered
//
typedef struct Ask
{
  char            session[33];                   // the service's conversation id ("" before the first turn)
  char            broker[512];
  char            tenant[256];
  char*           question;
  char*           brokerToken;                   // the broker's, or NULL
  char*           uiTools;                       // the c3 commands the page offers (a JSON array), or NULL
  CorHttpStream*  streamP;
  bool            stopped;
  bool            gone;                          // the page closed the stream
  pid_t           curlPid;                       // the turn being asked, 0 between turns (under aMutex)
  pid_t           mcpPid;
  int             mcpIn;                         // corMcp's stdin
  int             mcpOut;                        // corMcp's stdout
  char*           mcpBuf;
  int             mcpLen;
  int             mcpCap;
  int             mcpId;
  char            hdrPath[1100];
  char            bodyPath[1100];

  // A turn
  Call            calls[CALLS_MAX];
  int             nCalls;
  char            stopReason[64];
  Str             text;                          // the turn's answer text
  double          costUsd;
  double          input, output, cacheRead;
  bool            failed;                        // an error event was sent
} Ask;

static pthread_mutex_t aMutex = PTHREAD_MUTEX_INITIALIZER;
static Ask*            asks[ASKS_MAX];



// -----------------------------------------------------------------------------
//
// UiCall - a c3 command waiting for the page's result
//
#define UI_CALLS_MAX     16

typedef struct UiCall
{
  char    id[33];
  bool    done;                                  // the page answered
  bool    ok;
  char*   text;
} UiCall;

static pthread_cond_t  uiCond = PTHREAD_COND_INITIALIZER;   // with aMutex
static UiCall*         uiCalls[UI_CALLS_MAX];



// -----------------------------------------------------------------------------
//
// hexNew - 'bytes' random bytes as hex; hexValid - 'len' lower-case hex digits
//
static bool hexNew(char* out, int bytes)
{
  unsigned char b[32];

  if ((bytes > 32) || (getentropy(b, bytes) != 0))
    return false;

  for (int ix = 0; ix < bytes; ix++)
    snprintf(&out[ix * 2], 3, "%02x", b[ix]);
  return true;
}

static bool hexValid(const char* s, int len)
{
  if ((int) strlen(s) != len)
    return false;
  for (int ix = 0; ix < len; ix++)
  {
    if (((s[ix] < '0') || (s[ix] > '9')) && ((s[ix] < 'a') || (s[ix] > 'f')))
      return false;
  }
  return true;
}



// -----------------------------------------------------------------------------
//
// tokenValid - an AI Assist token: printable ASCII, no blank
//
static bool tokenValid(const char* t)
{
  int len = strlen(t);

  if ((len < 8) || (len > TOKEN_MAX))
    return false;
  for (int ix = 0; ix < len; ix++)
  {
    if ((t[ix] <= ' ') || (t[ix] > '~'))
      return false;
  }
  return true;
}



// -----------------------------------------------------------------------------
//
// fileWrite600 - a whole file, mode 600 (replaced if there)
//
static bool fileWrite600(const char* path, const char* data, int len)
{
  unlink(path);

  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
  if (fd == -1)
    return false;

  bool ok = (write(fd, data, len) == (ssize_t) len);
  close(fd);
  return ok;
}



// -----------------------------------------------------------------------------
//
// nodeNumber / nodeString
//
static double nodeNumber(CorNode* nP, double dflt)
{
  if (nP == NULL)
    return dflt;
  if (nP->type == CorInt)
    return (double) nP->value.i;
  if (nP->type == CorFloat)
    return nP->value.f;
  return dflt;
}

static const char* nodeString(CorNode* objectP, const char* name)
{
  CorNode* nP = (objectP != NULL) ? corTreeLookup(objectP, name) : NULL;
  return ((nP != NULL) && (nP->type == CorString)) ? nP->value.s : NULL;
}



// -----------------------------------------------------------------------------
//
// tokenRead - the remembered token, from assist.json
//
static char* tokenRead(void)
{
  char* text = fileText(tokenPath);

  if (text == NULL)
    return NULL;

  char     abuf[4096];
  CorAlloc alloc;
  CorJson  json;
  char*    t = NULL;

  corAllocBufferInit(&alloc, abuf, sizeof(abuf), 64 * 1024, NULL, "c3 assist");
  corJsonCreate(&json, &alloc);

  CorNode*    rootP = corJsonParse(&json, text);
  const char* tok   = nodeString(rootP, "token");

  if ((tok != NULL) && (tokenValid(tok) == true))
    t = strdup(tok);

  corAllocBufferReset(&alloc, false);
  free(text);
  return t;
}



// -----------------------------------------------------------------------------
//
// assistServiceInit - curl, corMcp, the service and the token; only when $C3_ASSIST_URL names the service
//
bool assistServiceInit(void)
{
  const char* url = getenv("C3_ASSIST_URL");
  if ((url == NULL) || (url[0] == 0))
  {
    snprintf(reason, sizeof(reason), "no Coraine Assistant service set ($C3_ASSIST_URL)");
    return false;
  }
  snprintf(service, sizeof(service), "%s", url);
  int slen = strlen(service);
  while ((slen > 0) && (service[slen - 1] == '/'))
    service[--slen] = 0;

  snprintf(tokenPath, sizeof(tokenPath), "%s", c3ConfigPath);
  char* slash = strrchr(tokenPath, '/');
  if (slash != NULL)
    snprintf(slash + 1, sizeof(tokenPath) - (slash + 1 - tokenPath), "assist.json");
  else
    snprintf(tokenPath, sizeof(tokenPath), "assist.json");

  const char* envToken = getenv("C3_ASSIST_TOKEN");
  if ((envToken != NULL) && (tokenValid(envToken) == true))
  {
    token       = strdup(envToken);
    tokenSource = "environment";
  }
  else if ((token = tokenRead()) != NULL)
    tokenSource = "remembered";

  if (inPath("curl", curlPath, sizeof(curlPath)) == false)
  {
    snprintf(reason, sizeof(reason), "no curl in $PATH - AI Assist asks its service with it");
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
    snprintf(reason, sizeof(reason), "no corMcp in $PATH (or C3_CORMCP=<its path>) - the assistant reads the broker with it");
    return false;
  }

  if ((dataHome("assist/asks", asksDir, sizeof(asksDir)) == false) || (dirsMake(asksDir) == false))
  {
    snprintf(reason, sizeof(reason), "no data directory for the assistant ($XDG_DATA_HOME/c3/assist)");
    return false;
  }

  available = true;
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

  bool ok = (aP->gone == false) && corHttpStreamWrite(aP->streamP, s.s, s.len);

  if (ok == false)
    aP->gone = true;

  strFree(&s);
  strFree(dataP);
  return ok;
}

static void emitError(Ask* aP, const char* detail)
{
  Str s = { NULL, 0, 0 };

  strAdd(&s, "{\"detail\": ");
  strAddJson(&s, detail);
  strAdd(&s, "}");
  emit(aP, "error", &s);
  aP->failed = true;
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

  while ((max > 0) && (((unsigned char) s[max] & 0xC0) == 0x80))
    --max;

  Str t = { NULL, 0, 0 };
  strAddN(&t, s, max);
  strAdd(&t, " …");
  strAddJson(sP, t.s);
  strFree(&t);
}



// -----------------------------------------------------------------------------
//
// headerFile - the service's headers, the token among them, in a file of mode 600 (curl -H @file)
//
static bool headerFile(const char* path, const char* tok)
{
  Str h = { NULL, 0, 0 };

  strAddf(&h, "Authorization: Bearer %s\nContent-Type: application/json\nAccept: text/event-stream\nUser-Agent: c3/%s\n", tok, C3_VERSION);
  bool ok = fileWrite600(path, h.s, h.len);
  strFree(&h);
  return ok;
}



// -----------------------------------------------------------------------------
//
// serviceGet - a GET of the service's, whole; the HTTP status (0: not reached), the body in 'out'
//
static int serviceGet(const char* path, const char* tok, char* out, int outSize)
{
  char hdr[1100];
  char url[700];
  char hArg[1200];
  char hexb[17];

  out[0] = 0;
  if (hexNew(hexb, 8) == false)
    return 0;
  snprintf(hdr, sizeof(hdr), "%s/get-%s.hdr", asksDir, hexb);
  snprintf(url, sizeof(url), "%s%s", service, path);
  snprintf(hArg, sizeof(hArg), "@%s", hdr);

  if (headerFile(hdr, tok) == false)
    return 0;

  char* argv[] = { curlPath, (char*) "-sS", (char*) "--max-time", (char*) "15", (char*) "-H", hArg, (char*) "-w", (char*) "\n%{http_code}", url, NULL };
  int   status = runCapture(argv, out, outSize, 20);

  unlink(hdr);

  if ((status == -1) || !WIFEXITED(status) || (WEXITSTATUS(status) != 0))
    return 0;

  char* nl = strrchr(out, '\n');
  if (nl == NULL)
    return 0;
  *nl = 0;
  return atoi(nl + 1);
}



// -----------------------------------------------------------------------------
//
// mcpStart - corMcp for this ask: the broker, the tenant, and the broker's token in its environment
//
static bool mcpStart(Ask* aP)
{
  int toChild[2];
  int fromChild[2];

  if (pipe2(toChild, O_CLOEXEC) != 0)
    return false;
  if (pipe2(fromChild, O_CLOEXEC) != 0)
  {
    close(toChild[0]);
    close(toChild[1]);
    return false;
  }

  //
  // Everything the child needs, made before the fork (only exec-safe calls after it)
  //
  char* argv[12];
  int   argc = 0;
  argv[argc++] = corMcpPath;
  argv[argc++] = (char*) "--broker";
  argv[argc++] = aP->broker;
  if (aP->tenant[0] != 0)
  {
    argv[argc++] = (char*) "--tenant";
    argv[argc++] = aP->tenant;
  }
  if (aP->brokerToken != NULL)
  {
    argv[argc++] = (char*) "--token-env";
    argv[argc++] = (char*) "C3_BROKER_TOKEN";
  }
  argv[argc] = NULL;

  int nEnv = 0;
  while (environ[nEnv] != NULL)
    nEnv++;

  char** envp   = calloc(nEnv + 2, sizeof(char*));
  Str    tokEnv = { NULL, 0, 0 };

  if (envp == NULL)
  {
    close(toChild[0]); close(toChild[1]); close(fromChild[0]); close(fromChild[1]);
    return false;
  }

  int e = 0;
  for (int ix = 0; ix < nEnv; ix++)
  {
    if ((strncmp(environ[ix], "C3_BROKER_TOKEN=", 16) != 0) && (strncmp(environ[ix], "C3_ASSIST_TOKEN=", 16) != 0))
      envp[e++] = environ[ix];
  }
  if (aP->brokerToken != NULL)
  {
    strAddf(&tokEnv, "C3_BROKER_TOKEN=%s", aP->brokerToken);
    envp[e++] = tokEnv.s;
  }
  envp[e] = NULL;

  pid_t parent = getpid();
  pid_t pid    = fork();

  if (pid == 0)
  {
    setpgid(0, 0);
#if defined(__linux__)
    prctl(PR_SET_PDEATHSIG, SIGTERM);
#endif
    if (getppid() != parent)
      _exit(1);

    int devNull = open("/dev/null", O_WRONLY);
    dup2(toChild[0], 0);
    dup2(fromChild[1], 1);
    if (devNull != -1)
      dup2(devNull, 2);
    execve(corMcpPath, argv, envp);
    _exit(127);
  }

  close(toChild[0]);
  close(fromChild[1]);
  free(envp);
  strFree(&tokEnv);

  if (pid < 0)
  {
    close(toChild[1]);
    close(fromChild[0]);
    return false;
  }

  aP->mcpPid = pid;
  aP->mcpIn  = toChild[1];
  aP->mcpOut = fromChild[0];
  return true;
}

static void mcpStop(Ask* aP)
{
  if (aP->mcpPid <= 0)
    return;

  close(aP->mcpIn);
  close(aP->mcpOut);
  kill(-aP->mcpPid, SIGTERM);
  waitpid(aP->mcpPid, NULL, 0);
  aP->mcpPid = 0;
  free(aP->mcpBuf);
  aP->mcpBuf = NULL;
}



// -----------------------------------------------------------------------------
//
// mcpSend - one JSON-RPC message to corMcp (a line); the id it was given (0: a notification, -1: not sent)
//
static int mcpSend(Ask* aP, const char* method, const char* paramsJson, bool notification)
{
  Str s  = { NULL, 0, 0 };
  int id = notification ? 0 : ++aP->mcpId;

  strAdd(&s, "{\"jsonrpc\": \"2.0\", ");
  if (notification == false)
    strAddf(&s, "\"id\": %d, ", id);
  strAdd(&s, "\"method\": ");
  strAddJson(&s, method);
  if (paramsJson != NULL)
  {
    strAdd(&s, ", \"params\": ");
    strAdd(&s, paramsJson);
  }
  strAdd(&s, "}\n");

  bool ok  = true;
  int  off = 0;
  while ((ok == true) && (off < (int) s.len))
  {
    ssize_t n = write(aP->mcpIn, &s.s[off], s.len - off);
    if ((n < 0) && (errno == EINTR))
      continue;
    ok   = (n > 0);
    off += (n > 0) ? n : 0;
  }
  strFree(&s);
  return ok ? id : -1;
}



// -----------------------------------------------------------------------------
//
// mcpReceive - corMcp's answer to request 'id': its result, rendered (malloc'ed), or NULL with 'errBuf' said
//
static char* mcpReceive(Ask* aP, int id, char* errBuf, int errLen)
{
  time_t deadline = time(NULL) + MCP_TIMEOUT_S;

  while (true)
  {
    //
    // A whole line in the buffer?
    //
    char* nl = (aP->mcpBuf != NULL) ? memchr(aP->mcpBuf, '\n', aP->mcpLen) : NULL;

    if (nl != NULL)
    {
      *nl = 0;

      char*    result = NULL;
      bool     mine   = false;
      char     abuf[16 * 1024];
      CorAlloc alloc;
      CorJson  json;

      corAllocBufferInit(&alloc, abuf, sizeof(abuf), 64 * 1024 * 1024, NULL, "c3 assist mcp");
      corJsonCreate(&json, &alloc);

      CorNode* msgP = corJsonParse(&json, aP->mcpBuf);
      CorNode* idP  = (msgP != NULL) ? corTreeLookup(msgP, "id") : NULL;

      if ((idP != NULL) && (idP->type == CorInt) && (idP->value.i == id))
      {
        CorNode* resP = corTreeLookup(msgP, "result");

        mine = true;
        if (resP != NULL)
        {
          Str r = { NULL, 0, 0 };
          strAddNode(&r, resP);
          result = r.s;
        }
        else
        {
          const char* m = nodeString(corTreeLookup(msgP, "error"), "message");
          snprintf(errBuf, errLen, "corMcp: %s", (m != NULL) ? m : "an error");
        }
      }

      corAllocBufferReset(&alloc, false);

      int used = (nl - aP->mcpBuf) + 1;
      memmove(aP->mcpBuf, nl + 1, aP->mcpLen - used);
      aP->mcpLen -= used;

      if (mine == true)
        return result;
      continue;                                  // a notification, or another id: not this one
    }

    if (aP->mcpCap - aP->mcpLen < 65536)
    {
      int   cap  = (aP->mcpCap == 0) ? 131072 : aP->mcpCap * 2;
      char* newP = (cap <= LINE_MAX_BYTES * 4) ? realloc(aP->mcpBuf, cap) : NULL;

      if (newP == NULL)
      {
        snprintf(errBuf, errLen, "corMcp's answer is too long");
        return NULL;
      }
      aP->mcpBuf = newP;
      aP->mcpCap = cap;
    }

    int left = (int) (deadline - time(NULL));
    if (left <= 0)
    {
      snprintf(errBuf, errLen, "corMcp did not answer in %d s", MCP_TIMEOUT_S);
      return NULL;
    }

    struct pollfd pfd = { aP->mcpOut, POLLIN, 0 };
    int           r   = poll(&pfd, 1, left * 1000);

    if (r <= 0)
      continue;                                  // EINTR, or the deadline - checked above

    ssize_t n = read(aP->mcpOut, &aP->mcpBuf[aP->mcpLen], aP->mcpCap - aP->mcpLen - 1);
    if ((n < 0) && (errno == EINTR))
      continue;
    if (n <= 0)
    {
      snprintf(errBuf, errLen, "corMcp ended");
      return NULL;
    }
    aP->mcpLen += n;
  }
}



// -----------------------------------------------------------------------------
//
// mcpTools - corMcp started and initialised; its tools as a JSON array (malloc'ed)
//
static char* mcpTools(Ask* aP, char* errBuf, int errLen)
{
  if (mcpStart(aP) == false)
  {
    snprintf(errBuf, errLen, "corMcp could not be started");
    return NULL;
  }

  int   id = mcpSend(aP, "initialize", "{\"protocolVersion\": \"2025-06-18\", \"capabilities\": {}, \"clientInfo\": {\"name\": \"c3\", \"version\": \"" C3_VERSION "\"}}", false);
  char* r  = (id > 0) ? mcpReceive(aP, id, errBuf, errLen) : NULL;

  if (r == NULL)
  {
    if (id <= 0)
      snprintf(errBuf, errLen, "corMcp did not start");
    return NULL;
  }
  free(r);

  mcpSend(aP, "notifications/initialized", NULL, true);

  id = mcpSend(aP, "tools/list", "{}", false);
  r  = (id > 0) ? mcpReceive(aP, id, errBuf, errLen) : NULL;
  if (r == NULL)
    return NULL;

  //
  // {"tools": [...]} -> [...]
  //
  char     abuf[16 * 1024];
  CorAlloc alloc;
  CorJson  json;
  char*    tools = NULL;

  corAllocBufferInit(&alloc, abuf, sizeof(abuf), 16 * 1024 * 1024, NULL, "c3 assist tools");
  corJsonCreate(&json, &alloc);

  CorNode* resP   = corJsonParse(&json, r);
  CorNode* toolsP = (resP != NULL) ? corTreeLookup(resP, "tools") : NULL;

  if ((toolsP != NULL) && (toolsP->type == CorArray) && (toolsP->value.head != NULL))
  {
    Str t = { NULL, 0, 0 };
    strAddNode(&t, toolsP);
    tools = t.s;
  }
  else
    snprintf(errBuf, errLen, "corMcp listed no tools");

  corAllocBufferReset(&alloc, false);
  free(r);
  return tools;
}



// -----------------------------------------------------------------------------
//
// mcpCall - a corMcp tool call: the text of its result (malloc'ed), *isErrorP
//
static char* mcpCall(Ask* aP, const char* name, const char* inputJson, bool* isErrorP)
{
  Str p = { NULL, 0, 0 };
  strAdd(&p, "{\"name\": ");
  strAddJson(&p, name);
  strAdd(&p, ", \"arguments\": ");
  strAdd(&p, ((inputJson != NULL) && (inputJson[0] == '{')) ? inputJson : "{}");
  strAdd(&p, "}");

  char  err[512];
  int   id = mcpSend(aP, "tools/call", p.s, false);
  char* r  = (id > 0) ? mcpReceive(aP, id, err, sizeof(err)) : NULL;
  strFree(&p);

  *isErrorP = true;
  if (r == NULL)
    return strdup((id > 0) ? err : "corMcp is not running");

  char     abuf[16 * 1024];
  CorAlloc alloc;
  CorJson  json;
  Str      text = { NULL, 0, 0 };

  corAllocBufferInit(&alloc, abuf, sizeof(abuf), 64 * 1024 * 1024, NULL, "c3 assist call");
  corJsonCreate(&json, &alloc);

  CorNode* resP     = corJsonParse(&json, r);
  CorNode* contentP = (resP != NULL) ? corTreeLookup(resP, "content") : NULL;
  CorNode* errP     = (resP != NULL) ? corTreeLookup(resP, "isError") : NULL;

  if ((contentP != NULL) && (contentP->type == CorArray))
  {
    for (CorNode* cP = contentP->value.head; cP != NULL; cP = cP->next)
    {
      const char* t = nodeString(cP, "text");
      if (t != NULL)
        strAdd(&text, t);
    }
  }
  *isErrorP = (errP != NULL) && (errP->type == CorBoolean) && (errP->value.b == true);

  corAllocBufferReset(&alloc, false);
  free(r);

  return (text.s != NULL) ? text.s : strdup("");
}



// -----------------------------------------------------------------------------
//
// uiCall - a c3 command: handed to the page as a ui event, its result awaited; the text (malloc'ed), *okP
//
static char* uiCall(Ask* aP, const char* name, const char* inputJson, bool* okP)
{
  UiCall* cP = calloc(1, sizeof(UiCall));

  *okP = false;
  if ((cP == NULL) || (hexNew(cP->id, 16) == false))
  {
    free(cP);
    return strdup("no memory for the command");
  }

  pthread_mutex_lock(&aMutex);
  int slot = -1;
  for (int ix = 0; (ix < UI_CALLS_MAX) && (slot == -1); ix++)
  {
    if (uiCalls[ix] == NULL)
      slot = ix;
  }
  if (slot == -1)
  {
    pthread_mutex_unlock(&aMutex);
    free(cP);
    return strdup("too many commands waiting for the page");
  }
  uiCalls[slot] = cP;
  pthread_mutex_unlock(&aMutex);

  Str e = { NULL, 0, 0 };
  strAdd(&e, "{\"call\": ");
  strAddJson(&e, cP->id);
  strAdd(&e, ", \"name\": ");
  strAddJson(&e, name);
  strAdd(&e, ", \"args\": ");
  strAdd(&e, ((inputJson != NULL) && (inputJson[0] == '{')) ? inputJson : "{}");
  strAdd(&e, "}");
  bool sent = emit(aP, "ui", &e);

  struct timespec deadline;
  clock_gettime(CLOCK_REALTIME, &deadline);
  deadline.tv_sec += UI_TIMEOUT_S;

  pthread_mutex_lock(&aMutex);
  while ((sent == true) && (cP->done == false) && (aP->stopped == false))
  {
    if (pthread_cond_timedwait(&uiCond, &aMutex, &deadline) == ETIMEDOUT)
      break;
  }
  uiCalls[slot] = NULL;
  pthread_mutex_unlock(&aMutex);

  char* text;
  if (cP->done == true)
  {
    *okP = cP->ok;
    text = (cP->text != NULL) ? cP->text : strdup("done");
  }
  else
    text = strdup(aP->stopped ? "the question was stopped - not carried out" : "c³'s page did not carry it out in time (closed, or busy)");

  free(cP);
  return text;
}



// -----------------------------------------------------------------------------
//
// callsFree - the turn's tool calls, gone
//
static void callsFree(Ask* aP)
{
  for (int ix = 0; ix < aP->nCalls; ix++)
  {
    free(aP->calls[ix].id);
    free(aP->calls[ix].name);
    free(aP->calls[ix].input);
  }
  aP->nCalls = 0;
}



// -----------------------------------------------------------------------------
//
// eventHandle - one event of the service's turn
//
static void eventHandle(Ask* aP, const char* event, CorNode* dP, const char* c3Names)
{
  if (strcmp(event, "conversation") == 0)
  {
    const char* id = nodeString(dP, "id");

    if ((id != NULL) && (hexValid(id, 32) == true) && (strcmp(id, aP->session) != 0))
    {
      pthread_mutex_lock(&aMutex);
      snprintf(aP->session, sizeof(aP->session), "%s", id);
      pthread_mutex_unlock(&aMutex);

      Str s = { NULL, 0, 0 };
      strAdd(&s, "{\"session\": ");
      strAddJson(&s, id);
      strAdd(&s, "}");
      emit(aP, "start", &s);
    }
  }
  else if (strcmp(event, "text") == 0)
  {
    const char* text = nodeString(dP, "text");
    if (text == NULL)
      return;

    strAdd(&aP->text, text);
    Str s = { NULL, 0, 0 };
    strAdd(&s, "{\"text\": ");
    strAddJson(&s, text);
    strAdd(&s, "}");
    emit(aP, "text", &s);
  }
  else if (strcmp(event, "tool") == 0)
  {
    const char* id   = nodeString(dP, "id");
    const char* name = nodeString(dP, "name");

    if ((id == NULL) || (name == NULL) || (strlen(name) > 64) || (aP->nCalls >= CALLS_MAX))
      return;

    char quoted[80];
    snprintf(quoted, sizeof(quoted), "\"%s\"", name);

    Call* cP = &aP->calls[aP->nCalls++];
    Str   in = { NULL, 0, 0 };
    strAddNode(&in, corTreeLookup(dP, "input"));
    cP->id    = strdup(id);
    cP->name  = strdup(name);
    cP->input = in.s;
    cP->c3    = (c3Names != NULL) && (strstr(c3Names, quoted) != NULL);

    Str s = { NULL, 0, 0 };
    strAdd(&s, "{\"id\": ");
    strAddJson(&s, id);
    strAddf(&s, ", \"kind\": \"%s\", \"name\": ", cP->c3 ? "c3" : "broker");
    strAddJson(&s, name);
    strAdd(&s, ", \"input\": ");
    strAdd(&s, (cP->input != NULL) ? cP->input : "{}");
    strAdd(&s, "}");
    emit(aP, "tool", &s);
  }
  else if (strcmp(event, "end") == 0)
  {
    const char* stop = nodeString(dP, "stopReason");
    CorNode*    uP   = corTreeLookup(dP, "usage");

    snprintf(aP->stopReason, sizeof(aP->stopReason), "%s", (stop != NULL) ? stop : "end_turn");
    aP->costUsd   += nodeNumber(corTreeLookup(dP, "costUsd"), 0);
    aP->input     += nodeNumber((uP != NULL) ? corTreeLookup(uP, "input") : NULL, 0);
    aP->output    += nodeNumber((uP != NULL) ? corTreeLookup(uP, "output") : NULL, 0);
    aP->cacheRead += nodeNumber((uP != NULL) ? corTreeLookup(uP, "cacheRead") : NULL, 0);

    CorNode*    limitP = corTreeLookup(dP, "limitUsd");
    const char* model  = nodeString(dP, "model");
    Str         s      = { NULL, 0, 0 };
    strAddf(&s, "{\"spentUsd\": %.4f, \"limitUsd\": ", nodeNumber(corTreeLookup(dP, "spentUsd"), 0));
    if ((limitP != NULL) && ((limitP->type == CorInt) || (limitP->type == CorFloat)))
      strAddf(&s, "%.2f", nodeNumber(limitP, 0));
    else
      strAdd(&s, "null");
    strAdd(&s, ", \"model\": ");
    strAddJson(&s, (model != NULL) ? model : "");
    strAdd(&s, "}");
    emit(aP, "usage", &s);
  }
  else if (strcmp(event, "error") == 0)
  {
    const char* detail = nodeString(dP, "detail");
    emitError(aP, (detail != NULL) ? detail : "the service ended the turn with an error");
  }
}



// -----------------------------------------------------------------------------
//
// turnAsk - one turn at the service: 'content' (a JSON array) sent, the answer's events handled as they come.
// false: no turn (said to the page)
//
static bool turnAsk(Ask* aP, const char* tools, const char* content, const char* c3Names)
{
  //
  // The request: the body and the headers in files of this ask's (mode 600), so neither is on a command line
  //
  Str b = { NULL, 0, 0 };
  strAdd(&b, "{\"conversation\": ");
  if (aP->session[0] != 0)
    strAddJson(&b, aP->session);
  else
    strAdd(&b, "null");
  strAdd(&b, ", \"context\": {\"broker\": ");
  strAddJson(&b, aP->broker);
  strAdd(&b, ", \"tenant\": ");
  if (aP->tenant[0] != 0)
    strAddJson(&b, aP->tenant);
  else
    strAdd(&b, "null");
  strAdd(&b, "}, \"tools\": ");
  strAdd(&b, tools);
  strAdd(&b, ", \"content\": ");
  strAdd(&b, content);
  strAdd(&b, "}");

  pthread_mutex_lock(&aMutex);
  char* tok = (token != NULL) ? strdup(token) : NULL;
  pthread_mutex_unlock(&aMutex);

  bool haveToken = (tok != NULL);
  bool written   = haveToken && fileWrite600(aP->bodyPath, b.s, b.len) && headerFile(aP->hdrPath, tok);
  strFree(&b);
  free(tok);

  if (written == false)
  {
    emitError(aP, haveToken ? "the request could not be written (the assist directory)" : "no AI Assist token - give it in the panel");
    return false;
  }

  char url[700];
  char hArg[1200];
  char dArg[1200];
  snprintf(url, sizeof(url), "%s/turn", service);
  snprintf(hArg, sizeof(hArg), "@%s", aP->hdrPath);
  snprintf(dArg, sizeof(dArg), "@%s", aP->bodyPath);

  char* argv[] = { curlPath, (char*) "-sS", (char*) "-N", (char*) "--fail-with-body", (char*) "--connect-timeout", (char*) "15",
                   (char*) "--max-time", (char*) "600", (char*) "-H", hArg, (char*) "--data-binary", dArg, url, NULL };

  int fds[2];
  if (pipe2(fds, O_CLOEXEC) != 0)
  {
    emitError(aP, "no pipe for the service's answer");
    return false;
  }

  ProcSpawn spawn = { argv, NULL, fds[1], NULL, true, false, SIGTERM };
  pid_t     pid   = procSpawn(&spawn);
  close(fds[1]);

  if (pid < 0)
  {
    close(fds[0]);
    emitError(aP, "curl could not be started");
    return false;
  }

  pthread_mutex_lock(&aMutex);
  aP->curlPid  = pid;
  bool stopped = aP->stopped;
  pthread_mutex_unlock(&aMutex);
  if (stopped == true)
    kill(-pid, SIGTERM);

  //
  // The answer, line by line: server-sent events - or, on an HTTP error, the service's JSON, or curl's own say
  //
  aP->nCalls        = 0;
  aP->stopReason[0] = 0;
  strFree(&aP->text);

  char*    buf        = NULL;
  int      bufLen     = 0;
  int      bufCap     = 0;
  bool     skip       = false;
  char     event[32]  = "";
  char     tail[1024] = "";
  char     abuf[64 * 1024];
  CorAlloc alloc;

  corAllocBufferInit(&alloc, abuf, sizeof(abuf), 64 * 1024 * 1024, NULL, "c3 assist turn");

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

    ssize_t n = read(fds[0], &buf[bufLen], bufCap - bufLen - 1);

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
      if ((nl > start) && (nl[-1] == '\r'))
        nl[-1] = 0;

      if (skip == true)
        skip = false;
      else if (strncmp(start, "event: ", 7) == 0)
        snprintf(event, sizeof(event), "%s", &start[7]);
      else if ((strncmp(start, "data: ", 6) == 0) && (event[0] != 0))
      {
        CorJson json;
        corJsonCreate(&json, &alloc);
        CorNode* dP = corJsonParse(&json, &start[6]);

        if ((dP != NULL) && (dP->type == CorObject) && (aP->gone == false))
          eventHandle(aP, event, dP, c3Names);
        corAllocBufferReset(&alloc, true);
        event[0] = 0;
      }
      else if (start[0] == '{')                  // an HTTP error's body: {"detail": ...}
      {
        CorJson json;
        corJsonCreate(&json, &alloc);
        CorNode*    dP     = corJsonParse(&json, start);
        const char* detail = nodeString(dP, "detail");

        if (detail != NULL)
          snprintf(tail, sizeof(tail), "%s", detail);
        corAllocBufferReset(&alloc, true);
      }
      else if (start[0] != 0)
        snprintf(tail, sizeof(tail), "%s", start);

      start = nl + 1;
    }

    bufLen -= (start - buf);
    memmove(buf, start, bufLen);

    if (aP->gone == true)
      kill(-pid, SIGTERM);                       // the page closed the stream: the question is given up
  }

  corAllocBufferReset(&alloc, false);
  free(buf);
  close(fds[0]);

  int status = 0;
  waitpid(pid, &status, 0);

  pthread_mutex_lock(&aMutex);
  aP->curlPid = 0;
  pthread_mutex_unlock(&aMutex);

  unlink(aP->bodyPath);
  unlink(aP->hdrPath);

  if ((aP->stopReason[0] != 0) || (aP->failed == true))
    return (aP->failed == false);

  //
  // No end of the turn: why
  //
  Str d = { NULL, 0, 0 };
  if (aP->stopped == true)
    strAdd(&d, "stopped");
  else if (WIFEXITED(status) && (WEXITSTATUS(status) == 22))
    strAddf(&d, "The assistant service refused: %s", (tail[0] != 0) ? tail : "an HTTP error");
  else if (WIFEXITED(status) && (WEXITSTATUS(status) != 0))
    strAddf(&d, "The assistant service at %s was not reached%s%s", service, (tail[0] != 0) ? ": " : "", tail);
  else
    strAdd(&d, "The assistant service ended the answer early");

  emitError(aP, d.s);
  strFree(&d);
  return false;
}



// -----------------------------------------------------------------------------
//
// toolsJoin - corMcp's tools and the page's commands, one array; a page command named as a corMcp tool is
// left out. 'c3NamesP': the page commands' names, each quoted ("name"), for telling a call's kind
//
static char* toolsJoin(const char* mcpTools, const char* uiTools, char** c3NamesP)
{
  Str t = { NULL, 0, 0 };
  Str n = { NULL, 0, 0 };

  strAddN(&t, mcpTools, strlen(mcpTools) - 1);   // without its ']'

  if (uiTools != NULL)
  {
    char     abuf[16 * 1024];
    CorAlloc alloc;
    CorJson  json;

    corAllocBufferInit(&alloc, abuf, sizeof(abuf), 16 * 1024 * 1024, NULL, "c3 assist tools");
    corJsonCreate(&json, &alloc);

    char*    copy   = corAllocStrdup(&alloc, uiTools);
    CorNode* arrayP = (copy != NULL) ? corJsonParse(&json, copy) : NULL;

    for (CorNode* tP = ((arrayP != NULL) && (arrayP->type == CorArray)) ? arrayP->value.head : NULL; tP != NULL; tP = tP->next)
    {
      const char* name = nodeString(tP, "name");
      char        quoted[80];

      if ((name == NULL) || (strlen(name) > 64))
        continue;
      snprintf(quoted, sizeof(quoted), "\"name\":\"%s\"", name);
      if (strstr(mcpTools, quoted) != NULL)
        continue;

      strAdd(&t, ",");
      strAddNode(&t, tP);
      strAddf(&n, "\"%s\" ", name);
    }
    corAllocBufferReset(&alloc, false);
  }

  strAdd(&t, "]");
  *c3NamesP = n.s;                               // NULL: none
  return t.s;
}



// -----------------------------------------------------------------------------
//
// askFree - out of the table, its corMcp stopped
//
static void askFree(Ask* aP)
{
  pthread_mutex_lock(&aMutex);
  for (int ix = 0; ix < ASKS_MAX; ix++)
  {
    if (asks[ix] == aP)
      asks[ix] = NULL;
  }
  pthread_mutex_unlock(&aMutex);

  if (aP->streamP != NULL)
    corHttpStreamEnd(aP->streamP);

  mcpStop(aP);
  callsFree(aP);
  strFree(&aP->text);
  free(aP->question);
  free(aP->brokerToken);
  free(aP->uiTools);
  free(aP);
}



// -----------------------------------------------------------------------------
//
// askThread - the question: turns at the service, the tool calls of each run here, until the model answers
//
static void* askThread(void* arg)
{
  Ask*   aP      = (Ask*) arg;
  time_t started = time(NULL);
  char   err[512];
  char*  c3Names = NULL;
  char*  tools   = NULL;
  char*  mcp     = mcpTools(aP, err, sizeof(err));
  int    turns   = 0;

  if (mcp == NULL)
    emitError(aP, err);
  else
    tools = toolsJoin(mcp, aP->uiTools, &c3Names);
  free(mcp);

  //
  // The first turn: the question
  //
  Str content = { NULL, 0, 0 };
  strAdd(&content, "[{\"type\": \"text\", \"text\": ");
  strAddJson(&content, aP->question);
  strAdd(&content, "}]");

  while ((tools != NULL) && (aP->stopped == false) && (aP->gone == false) && (turns < TURNS_MAX))
  {
    ++turns;
    if (turnAsk(aP, tools, content.s, c3Names) == false)
      break;
    strFree(&content);

    if (strcmp(aP->stopReason, "tool_use") != 0)
    {
      if (strcmp(aP->stopReason, "refusal") == 0)
        emitError(aP, "The model declined to answer this question.");
      else if (strcmp(aP->stopReason, "max_tokens_in_tool_call") == 0)
        emitError(aP, "The answer was cut short in a tool call - ask again, perhaps more narrowly.");
      break;
    }

    //
    // The tool calls: run here, their results the next turn
    //
    strAdd(&content, "[");
    for (int ix = 0; ix < aP->nCalls; ix++)
    {
      Call* cP      = &aP->calls[ix];
      bool  isError = false;
      char* text;

      if (aP->stopped == true)
      {
        text    = strdup("not run: the user stopped the question");
        isError = true;
      }
      else if (cP->c3 == true)
      {
        bool ok = false;
        text    = uiCall(aP, cP->name, cP->input, &ok);
        isError = !ok;
      }
      else
        text = mcpCall(aP, cP->name, cP->input, &isError);

      if (text == NULL)
        text = strdup("");

      if (cP->c3 == false)
      {
        Str s = { NULL, 0, 0 };
        strAdd(&s, "{\"id\": ");
        strAddJson(&s, cP->id);
        strAddf(&s, ", \"isError\": %s, \"text\": ", isError ? "true" : "false");
        strAddJsonCut(&s, text, RESULT_TEXT_MAX);
        strAdd(&s, "}");
        emit(aP, "toolResult", &s);
      }

      strAdd(&content, (ix > 0) ? ", " : "");
      strAdd(&content, "{\"type\": \"tool_result\", \"tool_use_id\": ");
      strAddJson(&content, cP->id);
      strAddf(&content, ", \"is_error\": %s, \"content\": ", isError ? "true" : "false");
      strAddJsonCut(&content, (text[0] != 0) ? text : "(empty)", TOOL_RESULT_MAX);
      strAdd(&content, "}");
      free(text);
    }
    strAdd(&content, "]");
    callsFree(aP);
  }
  strFree(&content);

  if ((aP->failed == false) && (aP->gone == false))
  {
    if (aP->stopped == true)
      emitError(aP, "stopped");
    else if (turns >= TURNS_MAX)
      emitError(aP, "The question took too many steps - ask it more narrowly.");
    else if (aP->stopReason[0] != 0)
    {
      Str s = { NULL, 0, 0 };
      strAdd(&s, "{\"answer\": ");
      strAddJson(&s, (aP->text.s != NULL) ? aP->text.s : "");
      strAddf(&s, ", \"turns\": %d, \"seconds\": %ld, \"costUsd\": %.4f, \"input\": %.0f, \"output\": %.0f, \"cacheRead\": %.0f, \"isError\": false}",
              turns, (long) (time(NULL) - started), aP->costUsd, aP->input, aP->output, aP->cacheRead);
      emit(aP, "end", &s);
    }
  }

  free(tools);
  free(c3Names);
  askFree(aP);
  return NULL;
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
  if ((session != NULL) && (hexValid(session, 32) == false))
  {
    serveError(connP, 400, "Bad request", "session: the id a start event gave");
    return;
  }

  pthread_mutex_lock(&aMutex);
  bool haveToken = (token != NULL);
  pthread_mutex_unlock(&aMutex);
  if (haveToken == false)
  {
    serveError(connP, 401, "No token", "AI Assist needs its token - give it in the panel");
    return;
  }

  CorNode* uiToolsP = corTreeLookup(bodyP, "uiTools");
  if ((uiToolsP != NULL) && (uiToolsP->type != CorArray))
  {
    serveError(connP, 400, "Bad request", "uiTools: an array of MCP tool definitions");
    return;
  }

  Ask* aP = calloc(1, sizeof(Ask));
  char hexb[17];
  if ((aP == NULL) || (hexNew(hexb, 8) == false))
  {
    free(aP);
    serveError(connP, 500, "Internal error", "out of memory");
    return;
  }

  int blen = strlen(broker);
  while ((blen > 0) && (broker[blen - 1] == '/'))
    --blen;
  snprintf(aP->broker, sizeof(aP->broker), "%.*s", blen, broker);
  snprintf(aP->tenant, sizeof(aP->tenant), "%s", (tenant != NULL) ? tenant : "");
  snprintf(aP->session, sizeof(aP->session), "%s", (session != NULL) ? session : "");
  snprintf(aP->hdrPath, sizeof(aP->hdrPath), "%s/%s.hdr", asksDir, hexb);
  snprintf(aP->bodyPath, sizeof(aP->bodyPath), "%s/%s.json", asksDir, hexb);

  aP->question    = strdup(question);
  aP->brokerToken = credsToken(aP->broker, NULL);
  aP->mcpIn       = -1;
  aP->mcpOut      = -1;

  if ((uiToolsP != NULL) && (uiToolsP->value.head != NULL))
  {
    Str t = { NULL, 0, 0 };
    strAddNode(&t, uiToolsP);
    aP->uiTools = t.s;

    if ((aP->uiTools == NULL) || (t.len > 256 * 1024))
    {
      askFree(aP);
      serveError(connP, 400, "Bad request", "uiTools: at most 256 KiB");
      return;
    }
  }

  //
  // A place in the table - one question at a time per conversation
  //
  pthread_mutex_lock(&aMutex);
  int slot = -1;
  for (int ix = 0; ix < ASKS_MAX; ix++)
  {
    if ((asks[ix] != NULL) && (aP->session[0] != 0) && (strcmp(asks[ix]->session, aP->session) == 0))
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

  corHttpResponseStatus(connP, 200);
  corHttpResponseHeader(connP, "Content-Type", "text/event-stream");
  corHttpResponseHeader(connP, "Cache-Control", "no-store");
  aP->streamP = corHttpResponseStream(connP);

  if (aP->session[0] != 0)
  {
    Str s = { NULL, 0, 0 };
    strAdd(&s, "{\"session\": ");
    strAddJson(&s, aP->session);
    strAdd(&s, "}");
    emit(aP, "start", &s);
  }

  pthread_t      tid;
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

  if (pthread_create(&tid, &attr, askThread, aP) != 0)
  {
    emitError(aP, "no thread to answer the question");
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
      if (asks[ix]->curlPid > 0)
        kill(-asks[ix]->curlPid, SIGTERM);       // the ask's thread sees the end of the answer, and reaps it
      found = true;
    }
  }
  pthread_cond_broadcast(&uiCond);               // a command waiting for the page: not any more
  pthread_mutex_unlock(&aMutex);

  if (found == false)
    serveError(connP, 404, "Not found", "no question of that conversation is being answered");
  else
    serveJson(connP, 200, "{}");
}



// -----------------------------------------------------------------------------
//
// uiResult - POST /api/assist/ui: what the page made of a c3 command
//
static void uiResult(CorHttpConn* connP, CorNode* bodyP)
{
  const char* call  = nodeString(bodyP, "call");
  const char* text  = nodeString(bodyP, "text");
  CorNode*    okP   = corTreeLookup(bodyP, "ok");
  bool        found = false;

  pthread_mutex_lock(&aMutex);
  for (int ix = 0; (ix < UI_CALLS_MAX) && (call != NULL); ix++)
  {
    UiCall* cP = uiCalls[ix];

    if ((cP != NULL) && (cP->done == false) && (strcmp(cP->id, call) == 0))
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
// tokenSet - PUT /api/assist/token: checked with the service, then kept (and with "remember", in assist.json)
//
static void tokenSet(CorHttpConn* connP, CorNode* bodyP)
{
  const char* t         = nodeString(bodyP, "token");
  CorNode*    rememberP = corTreeLookup(bodyP, "remember");
  bool        remember  = (rememberP != NULL) && (rememberP->type == CorBoolean) && (rememberP->value.b == true);

  if ((t == NULL) || (tokenValid(t) == false))
  {
    serveError(connP, 400, "Bad request", "token: the AI Assist token Seamware gave you (8-256 characters, no blank)");
    return;
  }

  char out[4096];
  int  status = serviceGet("/me", t, out, sizeof(out));

  if (status == 401)
  {
    serveError(connP, 403, "Not accepted", "the assistant service does not know this token");
    return;
  }
  if (status != 200)
  {
    char d[700];
    snprintf(d, sizeof(d), "the assistant service at %s could not check it (%s)", service, (status == 0) ? "not reached" : "an error");
    serveError(connP, 502, "Not checked", d);
    return;
  }

  if (remember == true)
  {
    Str f = { NULL, 0, 0 };
    strAdd(&f, "{\"token\": ");
    strAddJson(&f, t);
    strAdd(&f, "}\n");
    bool ok = fileWrite600(tokenPath, f.s, f.len);
    strFree(&f);
    if (ok == false)
    {
      char d[4400];
      snprintf(d, sizeof(d), "%s: %s", tokenPath, strerror(errno));
      serveError(connP, 500, "Not remembered", d);
      return;
    }
  }
  else
    unlink(tokenPath);

  pthread_mutex_lock(&aMutex);
  free(token);
  token       = strdup(t);
  tokenSource = remember ? "remembered" : "this session";
  pthread_mutex_unlock(&aMutex);

  serveJson(connP, 200, out);                   // the service's /me: who, the model, this month's spending
}

static void tokenForget(CorHttpConn* connP)
{
  unlink(tokenPath);

  pthread_mutex_lock(&aMutex);
  free(token);
  token       = NULL;
  tokenSource = NULL;
  pthread_mutex_unlock(&aMutex);

  serveJson(connP, 200, "{}");
}



// -----------------------------------------------------------------------------
//
// infoGet - GET /api/assist
//
static void infoGet(CorHttpConn* connP)
{
  Str s = { NULL, 0, 0 };

  if (available == false)
  {
    strAdd(&s, "{\"available\": false, \"reason\": ");
    strAddJson(&s, reason);
    strAdd(&s, "}");
    respondStr(connP, 200, &s);
    return;
  }

  pthread_mutex_lock(&aMutex);
  char*       tok    = (token != NULL) ? strdup(token) : NULL;
  const char* source = tokenSource;
  pthread_mutex_unlock(&aMutex);

  strAdd(&s, "{\"available\": true, \"engine\": \"service\", \"provider\": \"Coraine Assistant\", \"service\": ");
  strAddJson(&s, service);
  strAddf(&s, ", \"tokenSet\": %s, \"tokenSource\": ", (tok != NULL) ? "true" : "false");
  strAddJson(&s, source);

  //
  // With a token: the service's word on it - who, the model, this month's spending
  //
  if (tok != NULL)
  {
    char out[4096];
    int  status = serviceGet("/me", tok, out, sizeof(out));

    strAddf(&s, ", \"serviceStatus\": %d", status);
    if ((status == 200) && (out[0] == '{'))
    {
      strAdd(&s, ", \"me\": ");
      strAdd(&s, out);
    }
    free(tok);
  }

  strAdd(&s, "}");
  respondStr(connP, 200, &s);
}



// -----------------------------------------------------------------------------
//
// assistServiceRequest - /api/assist...
//
void assistServiceRequest(CorHttpConn* connP, const char* path)
{
  const char* method = connP->method.s;

  if ((strcmp(path, "/api/assist") == 0) && (strcmp(method, "GET") == 0))
  {
    infoGet(connP);
    return;
  }

  bool known = ((strcmp(path, "/api/assist/token") == 0) && ((strcmp(method, "PUT") == 0) || (strcmp(method, "DELETE") == 0))) ||
               ((strcmp(method, "POST") == 0) &&
                ((strcmp(path, "/api/assist/ask") == 0) || (strcmp(path, "/api/assist/stop") == 0) || (strcmp(path, "/api/assist/ui") == 0)));
  if (known == false)
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
  // Only from c3's own page: a question spends the token holder's money, and runs programs here
  //
  const char* origin = corHttpHeader(connP, "Origin");
  if ((origin == NULL) ||
      ((strncmp(origin, "http://localhost:", 17) != 0) && (strncmp(origin, "http://127.0.0.1:", 17) != 0) && (strncmp(origin, "http://[::1]:", 13) != 0)))
  {
    serveError(connP, 403, "Forbidden", "AI Assist is asked from c3's own page only (Origin: this machine)");
    return;
  }

  if (strcmp(method, "DELETE") == 0)
  {
    tokenForget(connP);
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

  if (strcmp(path, "/api/assist/token") == 0)
  {
    tokenSet(connP, bodyP);
    return;
  }

#ifndef COR_HTTP_STREAM_PENDING_MAX
  (void) askStart;
  (void) askStop;
  (void) uiResult;
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
