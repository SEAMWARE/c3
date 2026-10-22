//
// FILE            window.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The application window: minimised or closed from a button of the page
//
// A page cannot do either: Chrome's full-screen (--start-fullscreen, as F11) is the browser's own, which
// document.exitFullscreen does not leave, and a window the page did not open is not the page's to close.
// The browser can: c3 starts Chrome with --remote-debugging-pipe, and talks to it over two pipes - the
// DevTools protocol, a JSON message ended by a 0 byte each way - that nothing else on the machine can reach
// (no port). browser.c makes the pipes; this file keeps c3's ends.
//
// Which window: the page sets its title to a word of its own (the nonce) and names it in the request -
// Target.getTargets gives each page's title. Then:
//
//   GET  /api/window                    { "control": true | false }  false: no Chrome of c3's to talk to
//   POST /api/window/minimize/<nonce>   Browser.setWindowBounds, windowState "normal" then "minimized" (Chrome
//                                       minimises no full-screen window)
//   POST /api/window/fullscreen/<nonce> "normal" then "fullscreen" - the page's, when it is shown again
//   POST /api/window/close/<nonce>      Target.closeTarget - the last window closed, Chrome exits. c3 itself
//                                       keeps running, as when the window is closed by its own X
//
#define _DEFAULT_SOURCE                          // usleep

#include <errno.h>                               // errno, EINTR
#include <fcntl.h>                               // fcntl, FD_CLOEXEC
#include <poll.h>                                // poll
#include <stdio.h>                               // snprintf
#include <string.h>                              // strcmp, strlen, memcpy, memchr, memmove
#include <time.h>                                // clock_gettime
#include <unistd.h>                              // read, write, close

#include "corAlloc/corAlloc.h"                   // corAlloc
#include "corAlloc/corAllocBufferInit.h"         // corAllocBufferInit
#include "corAlloc/corAllocBufferReset.h"        // corAllocBufferReset
#include "corJson/corJsonCreate.h"               // corJsonCreate
#include "corJson/corJsonParse.h"                // corJsonParse
#include "corTree/corTreeLookup.h"               // corTreeLookup

#include "c3.h"



// -----------------------------------------------------------------------------
//
// toChrome, fromChrome - c3's ends of the pipes, -1: none (no Chrome of c3's, or it went away)
//
static int  toChrome   = -1;
static int  fromChrome = -1;
static int  messageId  = 0;
static char inBuf[256 * 1024];                   // what Chrome sent that is not a whole message yet
static int  inLen      = 0;



// -----------------------------------------------------------------------------
//
// windowPipesSet - the ends browser.c kept for c3, of the Chrome it started
//
void windowPipesSet(int toFd, int fromFd)
{
  if (toChrome   != -1) close(toChrome);
  if (fromChrome != -1) close(fromChrome);

  toChrome   = toFd;
  fromChrome = fromFd;
  inLen      = 0;

  fcntl(toChrome,   F_SETFD, FD_CLOEXEC);        // not a build's, nor a broker's, that c3 starts
  fcntl(fromChrome, F_SETFD, FD_CLOEXEC);
}



// -----------------------------------------------------------------------------
//
// pipesGone - Chrome went away: no control
//
static void pipesGone(void)
{
  if (toChrome   != -1) close(toChrome);
  if (fromChrome != -1) close(fromChrome);

  toChrome   = -1;
  fromChrome = -1;
  inLen      = 0;
}



// -----------------------------------------------------------------------------
//
// pipesAlive - Chrome still there: what it sent is kept, its end of the pipe closed is noticed
//
static bool pipesAlive(void)
{
  while (fromChrome != -1)
  {
    struct pollfd pfd = { fromChrome, POLLIN, 0 };

    if (poll(&pfd, 1, 0) <= 0)
      break;

    if (inLen == (int) sizeof(inBuf))            // a message larger than the buffer: not one of the answers
      inLen = 0;

    ssize_t n = read(fromChrome, &inBuf[inLen], sizeof(inBuf) - inLen);

    if ((n == -1) && (errno == EINTR))
      continue;
    if (n <= 0)
      pipesGone();
    else
      inLen += (int) n;
  }

  return (toChrome != -1);
}



// -----------------------------------------------------------------------------
//
// msNow -
//
static long long msNow(void)
{
  struct timespec ts;

  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long) ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}



// -----------------------------------------------------------------------------
//
// cdp - one DevTools command, and its answer: the "result" object, NULL on an error (said in errBuf)
//
// params: the JSON of the command's params, NULL for none. Messages that are not the answer (events) are
// skipped. Waits two seconds at most - c3 serves nothing else meanwhile, and Chrome answers in a few ms.
//
static CorNode* cdp(CorAlloc* allocP, const char* method, const char* params, char* errBuf, int errLen)
{
  if (toChrome == -1)
  {
    snprintf(errBuf, errLen, "no Chrome of c3's to talk to");
    return NULL;
  }

  int  id = ++messageId;
  char msg[2048];
  int  len = snprintf(msg, sizeof(msg), "{\"id\": %d, \"method\": \"%s\"%s%s}", id, method, (params != NULL) ? ", \"params\": " : "", (params != NULL) ? params : "");

  if (len >= (int) sizeof(msg) - 1)
  {
    snprintf(errBuf, errLen, "%s: the command is too long", method);
    return NULL;
  }

  msg[len++] = 0;                                // the message's end

  for (int done = 0; done < len; )
  {
    ssize_t n = write(toChrome, &msg[done], len - done);

    if ((n == -1) && (errno == EINTR))
      continue;
    if (n <= 0)
    {
      pipesGone();
      snprintf(errBuf, errLen, "Chrome has gone away");
      return NULL;
    }
    done += n;
  }

  long long end = msNow() + 2000;

  while (true)
  {
    //
    // A whole message in inBuf: the answer, or skipped
    //
    char* zeroP = memchr(inBuf, 0, inLen);

    if (zeroP != NULL)
    {
      int   mLen = (int) (zeroP - inBuf);
      char* text = corAlloc(allocP, mLen + 1);

      memcpy(text, inBuf, mLen + 1);
      memmove(inBuf, zeroP + 1, inLen - mLen - 1);
      inLen -= mLen + 1;

      CorJson  json;
      corJsonCreate(&json, allocP);

      CorNode* treeP = corJsonParse(&json, text);
      CorNode* idP   = ((treeP != NULL) && (treeP->type == CorObject)) ? corTreeLookup(treeP, "id") : NULL;

      if ((idP == NULL) || (idP->type != CorInt) || (idP->value.i != id))
        continue;

      CorNode* errorP  = corTreeLookup(treeP, "error");
      CorNode* resultP = corTreeLookup(treeP, "result");

      if (errorP != NULL)
      {
        CorNode* messageP = corTreeLookup(errorP, "message");
        snprintf(errBuf, errLen, "%s: %s", method, ((messageP != NULL) && (messageP->type == CorString)) ? messageP->value.s : "an error");
        return NULL;
      }

      if (resultP == NULL)
        snprintf(errBuf, errLen, "%s: no result", method);
      return resultP;
    }

    if (inLen == (int) sizeof(inBuf))            // a message larger than the buffer: not one of the answers
      inLen = 0;

    long long left = end - msNow();
    if (left <= 0)
    {
      snprintf(errBuf, errLen, "%s: Chrome did not answer", method);
      return NULL;
    }

    struct pollfd pfd = { fromChrome, POLLIN, 0 };
    int           pr  = poll(&pfd, 1, (int) left);

    if ((pr == -1) && (errno == EINTR))
      continue;
    if (pr <= 0)
      continue;

    ssize_t n = read(fromChrome, &inBuf[inLen], sizeof(inBuf) - inLen);

    if ((n == -1) && (errno == EINTR))
      continue;
    if (n <= 0)
    {
      pipesGone();
      snprintf(errBuf, errLen, "Chrome has gone away");
      return NULL;
    }
    inLen += (int) n;
  }
}



// -----------------------------------------------------------------------------
//
// pageOf - the page whose title is the nonce: its targetId (a page of c3's - only those are in its Chrome)
//
// The title reaches the browser a moment after the page set it: tried for a second.
//
static const char* pageOf(CorAlloc* allocP, const char* nonce, char* errBuf, int errLen)
{
  for (int attempt = 0; attempt < 10; attempt++)
  {
    CorNode* resultP = cdp(allocP, "Target.getTargets", NULL, errBuf, errLen);

    if (resultP == NULL)
      return NULL;

    CorNode* infosP = corTreeLookup(resultP, "targetInfos");

    for (CorNode* tP = ((infosP != NULL) && (infosP->type == CorArray)) ? infosP->value.head : NULL; tP != NULL; tP = tP->next)
    {
      CorNode* typeP  = corTreeLookup(tP, "type");
      CorNode* titleP = corTreeLookup(tP, "title");
      CorNode* idP    = corTreeLookup(tP, "targetId");

      if ((typeP != NULL) && (typeP->type == CorString) && (strcmp(typeP->value.s, "page") == 0) &&
          (titleP != NULL) && (titleP->type == CorString) && (strcmp(titleP->value.s, nonce) == 0) &&
          (idP != NULL) && (idP->type == CorString))
        return idP->value.s;
    }

    usleep(100 * 1000);
  }

  snprintf(errBuf, errLen, "no window of c3's with that title");
  return NULL;
}



// -----------------------------------------------------------------------------
//
// nonceOk - the nonce is a word: letters, digits, '-'
//
static bool nonceOk(const char* nonce)
{
  if ((nonce[0] == 0) || (strlen(nonce) > 64))
    return false;

  for (const char* cP = nonce; *cP != 0; cP++)
  {
    if (((*cP < 'a') || (*cP > 'z')) && ((*cP < 'A') || (*cP > 'Z')) && ((*cP < '0') || (*cP > '9')) && (*cP != '-'))
      return false;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// windowRequest - /api/window...
//
void windowRequest(CorHttpConn* connP, const char* path)
{
  const char* method = connP->method.s;

  if (strcmp(path, "/api/window") == 0)
  {
    if (strcmp(method, "GET") != 0)
      serveError(connP, 405, "Method not allowed", path);
    else
      serveJson(connP, 200, pipesAlive() ? "{\"control\": true}" : "{\"control\": false}");
    return;
  }

  bool        minimize = (strncmp(path, "/api/window/minimize/", 21) == 0);
  bool        closing  = (strncmp(path, "/api/window/close/", 18) == 0);
  bool        full     = (strncmp(path, "/api/window/fullscreen/", 23) == 0);
  const char* nonce    = minimize ? &path[21] : closing ? &path[18] : full ? &path[23] : NULL;

  if (nonce == NULL)
  {
    serveError(connP, 404, "Not found", path);
    return;
  }

  if (strcmp(method, "POST") != 0)
  {
    serveError(connP, 405, "Method not allowed", path);
    return;
  }

  if (nonceOk(nonce) == false)
  {
    serveError(connP, 400, "Bad request", "the window's title: letters, digits and '-', 64 at most");
    return;
  }

  char     err[512];
  char     buf[8 * 1024];
  CorAlloc alloc;

  corAllocBufferInit(&alloc, buf, sizeof(buf), 1024 * 1024, NULL, "c3 window");

  const char* targetP  = pageOf(&alloc, nonce, err, sizeof(err));
  char        targetId[128];
  char        params[256];
  bool        ok       = false;

  if ((targetP != NULL) && (strlen(targetP) < sizeof(targetId)))
  {
    snprintf(targetId, sizeof(targetId), "%s", targetP);

    if (closing)
    {
      snprintf(params, sizeof(params), "{\"targetId\": \"%s\"}", targetId);
      ok = (cdp(&alloc, "Target.closeTarget", params, err, sizeof(err)) != NULL);
    }
    else
    {
      snprintf(params, sizeof(params), "{\"targetId\": \"%s\"}", targetId);

      CorNode* resultP = cdp(&alloc, "Browser.getWindowForTarget", params, err, sizeof(err));
      CorNode* windowP = (resultP != NULL) ? corTreeLookup(resultP, "windowId") : NULL;

      //
      // By way of normal: Chrome minimises no full-screen window, and makes no minimised one full-screen
      //
      if ((windowP != NULL) && (windowP->type == CorInt))
      {
        long long windowId = windowP->value.i;

        snprintf(params, sizeof(params), "{\"windowId\": %lld, \"bounds\": {\"windowState\": \"normal\"}}", windowId);
        ok = (cdp(&alloc, "Browser.setWindowBounds", params, err, sizeof(err)) != NULL);

        snprintf(params, sizeof(params), "{\"windowId\": %lld, \"bounds\": {\"windowState\": \"%s\"}}", windowId, full ? "fullscreen" : "minimized");
        ok = ok && (cdp(&alloc, "Browser.setWindowBounds", params, err, sizeof(err)) != NULL);
      }
      else if (resultP != NULL)
        snprintf(err, sizeof(err), "Browser.getWindowForTarget: no windowId");
    }
  }

  corAllocBufferReset(&alloc, false);

  if (ok)
    serveJson(connP, 200, "{}");
  else
    serveError(connP, (toChrome == -1) ? 503 : 502, "The window", err);
}
