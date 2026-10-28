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
//   POST /api/window/open               the window, for a c3 started again (the dock's button) that finds this
//                                       one on its port - {"activationToken": "<its $XDG_ACTIVATION_TOKEN>"}.
//                                       This c3's Chrome gone: a new one, its pipes this c3's (the c3 started
//                                       again exits at once, and a Chrome it started with the pipe would exit
//                                       with it). Still there, with the token: a window comes to the front on
//                                       Wayland only with the token of the click that asked - a Chrome started
//                                       with it hands a new window to this c3's Chrome, the earlier pages are
//                                       closed and the new one made full-screen (it opens on the last page the
//                                       UI showed). Without a token: its first page activated only - the
//                                       desktop may answer with "c3 is ready"; shown so, the page asks for
//                                       full-screen itself (window.js).
//                                       503: no screen here
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
#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup
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
// WindowBounds - the window's state, size and position as Chrome has them
//
typedef struct WindowBounds
{
  char      state[32];                           // "normal", "minimized", "maximized", "fullscreen"; "?": unknown
  long long width;
  long long height;
  long long left;
  long long top;
} WindowBounds;



// -----------------------------------------------------------------------------
//
// windowBounds - Browser.getWindowBounds; false: Chrome did not say
//
static bool windowBounds(CorAlloc* allocP, long long windowId, WindowBounds* bP)
{
  char err[256];
  char params[64];

  snprintf(bP->state, sizeof(bP->state), "?");
  bP->width = bP->height = bP->left = bP->top = -1;

  snprintf(params, sizeof(params), "{\"windowId\": %lld}", windowId);

  CorNode* resultP = cdp(allocP, "Browser.getWindowBounds", params, err, sizeof(err));
  CorNode* boundsP = (resultP != NULL) ? corTreeLookup(resultP, "bounds") : NULL;

  if (boundsP == NULL)
    return false;

  CorNode* stateP = corTreeLookup(boundsP, "windowState");
  CorNode* wP     = corTreeLookup(boundsP, "width");
  CorNode* hP     = corTreeLookup(boundsP, "height");
  CorNode* xP     = corTreeLookup(boundsP, "left");
  CorNode* yP     = corTreeLookup(boundsP, "top");

  if ((stateP != NULL) && (stateP->type == CorString))
    snprintf(bP->state, sizeof(bP->state), "%s", stateP->value.s);
  if ((wP != NULL) && (wP->type == CorInt)) bP->width  = wP->value.i;
  if ((hP != NULL) && (hP->type == CorInt)) bP->height = hP->value.i;
  if ((xP != NULL) && (xP->type == CorInt)) bP->left   = xP->value.i;
  if ((yP != NULL) && (yP->type == CorInt)) bP->top    = yP->value.i;

  return true;
}



// -----------------------------------------------------------------------------
//
// boundsText - "fullscreen 3840x2160+0+0"
//
static const char* boundsText(const WindowBounds* bP, char* out, int outLen)
{
  snprintf(out, outLen, "%s %lldx%lld%+lld%+lld", bP->state, bP->width, bP->height, bP->left, bP->top);
  return out;
}



// -----------------------------------------------------------------------------
//
// stateApplied - the window to windowState, and waited for: up to 1 s, until Chrome has the state and - but
// for "minimized", whose bounds stay - bounds other than fromP's. The ms waited; -1: not within the second
//
// On Wayland a state is a request the compositor carries out a moment later. Asked for the next one before
// that, Chrome takes it for done and the desktop does not: a window "full-screen" in Chrome's eyes, its
// earlier size on the screen, undecorated - and taking no input
//
static int stateApplied(CorAlloc* allocP, long long windowId, const char* windowState, const WindowBounds* fromP, WindowBounds* nowP, char* errBuf, int errLen)
{
  char params[256];

  snprintf(params, sizeof(params), "{\"windowId\": %lld, \"bounds\": {\"windowState\": \"%s\"}}", windowId, windowState);
  if (cdp(allocP, "Browser.setWindowBounds", params, errBuf, errLen) == NULL)
    return -2;

  for (int waited = 0; waited <= 1000; waited += 50)
  {
    windowBounds(allocP, windowId, nowP);

    bool sameState  = (strcmp(nowP->state, windowState) == 0);
    bool moved      = (nowP->width != fromP->width) || (nowP->height != fromP->height) || (nowP->left != fromP->left) || (nowP->top != fromP->top);

    if (sameState && (moved || (strcmp(windowState, "minimized") == 0)))
      return waited;

    usleep(50 * 1000);
  }

  return -1;
}



// -----------------------------------------------------------------------------
//
// windowStateSet - the window of a page to windowState: by way of "normal" when it is in another state -
// Chrome minimises no full-screen window, and makes no minimised one full-screen - each step waited for
// (stateApplied). Already in it: nothing. Every change written to the log, its steps and their waits
//
static bool windowStateSet(CorAlloc* allocP, const char* targetId, const char* windowState, char* errBuf, int errLen)
{
  char params[256];

  snprintf(params, sizeof(params), "{\"targetId\": \"%s\"}", targetId);

  CorNode* resultP = cdp(allocP, "Browser.getWindowForTarget", params, errBuf, errLen);
  CorNode* windowP = (resultP != NULL) ? corTreeLookup(resultP, "windowId") : NULL;

  if ((windowP == NULL) || (windowP->type != CorInt))
  {
    if (resultP != NULL)
      snprintf(errBuf, errLen, "Browser.getWindowForTarget: no windowId");
    return false;
  }

  long long    windowId = windowP->value.i;
  WindowBounds was;
  WindowBounds normal;
  WindowBounds now;
  char         t1[96];
  char         t2[96];
  char         t3[96];
  int          waitNormal = 0;
  int          waitState  = 0;

  windowBounds(allocP, windowId, &was);

  if (strcmp(was.state, windowState) == 0)
  {
    printf("c3 window %lld -> %s: already %s\n", windowId, windowState, boundsText(&was, t1, sizeof(t1)));
    fflush(stdout);
    return true;
  }

  normal = was;
  if (strcmp(was.state, "normal") != 0)
    waitNormal = stateApplied(allocP, windowId, "normal", &was, &normal, errBuf, errLen);

  if (waitNormal >= -1)                          // -1: not seen within the second - the state asked for all the same
    waitState = stateApplied(allocP, windowId, windowState, &normal, &now, errBuf, errLen);
  else
    now = normal;

  bool ok = (waitNormal >= -1) && (waitState >= -1);

  printf("c3 window %lld -> %s: was %s, normal %s (%s), %s %s (%s)%s\n", windowId, windowState,
         boundsText(&was, t1, sizeof(t1)),
         boundsText(&normal, t2, sizeof(t2)), (waitNormal >= 0) ? "applied" : (waitNormal == -1) ? "NOT within 1 s" : "refused",
         windowState, boundsText(&now, t3, sizeof(t3)), (waitState >= 0) ? "applied" : (waitState == -1) ? "NOT within 1 s" : "refused",
         ok ? "" : " - FAILED");
  fflush(stdout);

  return ok;
}



// -----------------------------------------------------------------------------
//
// windowOpen - POST /api/window/open
//
static void windowOpen(CorHttpConn* connP)
{
  char        url[64];
  const char* token = NULL;

  snprintf(url, sizeof(url), "http://127.0.0.1:%d", c3Port);

  if ((connP->bodyRefused == false) && (connP->body.s != NULL) && (connP->body.len > 0))
  {
    CorJson json;

    corJsonCreate(&json, &connP->alloc);

    CorNode* bodyP  = corJsonParse(&json, corAllocStrdup(&connP->alloc, connP->body.s));
    CorNode* tokenP = ((bodyP != NULL) && (bodyP->type == CorObject)) ? corTreeLookup(bodyP, "activationToken") : NULL;

    if ((tokenP != NULL) && (tokenP->type == CorString))
      token = activationToken(tokenP->value.s);
  }

  if (pipesAlive() == false)
  {
    if (browserOpen(url, false, true, token))
      serveJson(connP, 200, "{\"window\": \"opened\"}");
    else
      serveError(connP, 503, "The window", "no screen here");
    return;
  }

  //
  // Chrome still there - not a new one with the pipe: it would hand the window over to this one and exit, and
  // windowPipesSet, closing the pipes of the one there, would end it
  //
  char     err[512];
  char     buf[16 * 1024];
  CorAlloc alloc;
  bool     ok = false;
  char     before[16][128];                      // this c3's pages before the new window
  int      beforeN = 0;
  char     answer[64];
  char     firstId[128] = "";

  corAllocBufferInit(&alloc, buf, sizeof(buf), 1024 * 1024, NULL, "c3 window");
  snprintf(err, sizeof(err), "no page of c3's");

  CorNode* resultP = cdp(&alloc, "Target.getTargets", NULL, err, sizeof(err));
  CorNode* infosP  = (resultP != NULL) ? corTreeLookup(resultP, "targetInfos") : NULL;

  for (CorNode* tP = ((infosP != NULL) && (infosP->type == CorArray)) ? infosP->value.head : NULL; tP != NULL; tP = tP->next)
  {
    CorNode* typeP = corTreeLookup(tP, "type");
    CorNode* idP   = corTreeLookup(tP, "targetId");

    if ((typeP != NULL) && (typeP->type == CorString) && (strcmp(typeP->value.s, "page") == 0) &&
        (idP != NULL) && (idP->type == CorString) && (strlen(idP->value.s) < 128) && (beforeN < 16))
      snprintf(before[beforeN++], 128, "%s", idP->value.s);
  }

  if (beforeN > 0)
    snprintf(firstId, sizeof(firstId), "%s", before[0]);

  //
  // With the token: a new window, by way of a Chrome started with it - it hands the window to this c3's Chrome,
  // the token with it, and the desktop shows it. Waited for up to 5 s; the earlier pages then closed
  //
  char newId[128] = "";

  if ((token != NULL) && browserOpen(url, false, false, token))
  {
    for (int attempt = 0; (attempt < 50) && (newId[0] == 0); attempt++)
    {
      usleep(100 * 1000);

      CorNode* nowP   = cdp(&alloc, "Target.getTargets", NULL, err, sizeof(err));
      CorNode* nowsP  = (nowP != NULL) ? corTreeLookup(nowP, "targetInfos") : NULL;

      for (CorNode* tP = ((nowsP != NULL) && (nowsP->type == CorArray)) ? nowsP->value.head : NULL; tP != NULL; tP = tP->next)
      {
        CorNode* typeP = corTreeLookup(tP, "type");
        CorNode* idP   = corTreeLookup(tP, "targetId");
        bool     seen  = false;

        if ((typeP == NULL) || (typeP->type != CorString) || (strcmp(typeP->value.s, "page") != 0) ||
            (idP == NULL) || (idP->type != CorString) || (strlen(idP->value.s) >= 128))
          continue;

        for (int ix = 0; ix < beforeN; ix++)
        {
          if (strcmp(before[ix], idP->value.s) == 0)
            seen = true;
        }

        if (seen == false)
        {
          snprintf(newId, sizeof(newId), "%s", idP->value.s);
          break;
        }
      }
    }
  }

  if (newId[0] != 0)
  {
    char params[256];

    for (int ix = 0; ix < beforeN; ix++)
    {
      snprintf(params, sizeof(params), "{\"targetId\": \"%s\"}", before[ix]);
      cdp(&alloc, "Target.closeTarget", params, err, sizeof(err));
    }

    ok = windowStateSet(&alloc, newId, "fullscreen", err, sizeof(err));
    snprintf(answer, sizeof(answer), "{\"window\": \"new\", \"closed\": %d}", beforeN);
  }
  else if (firstId[0] != 0)
  {
    char params[256];

    //
    // Activated only: a minimised window made "normal" then "fullscreen" without the token is left half
    // done on Wayland (big, undecorated, not full-screen). Shown again by the desktop ("c3 is ready"), the
    // page asks for full-screen itself (window.js, on becoming visible)
    //
    snprintf(params, sizeof(params), "{\"targetId\": \"%s\"}", firstId);
    ok = (cdp(&alloc, "Target.activateTarget", params, err, sizeof(err)) != NULL);
    snprintf(answer, sizeof(answer), "{\"window\": \"activated\"}");
  }

  corAllocBufferReset(&alloc, false);

  if (ok)
    serveJson(connP, 200, answer);
  else
    serveError(connP, 502, "The window", err);
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

  if (strcmp(path, "/api/window/open") == 0)
  {
    if (strcmp(method, "POST") != 0)
      serveError(connP, 405, "Method not allowed", path);
    else
      windowOpen(connP);
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
      ok = windowStateSet(&alloc, targetId, full ? "fullscreen" : "minimized", err, sizeof(err));
  }

  corAllocBufferReset(&alloc, false);

  if (ok)
    serveJson(connP, 200, "{}");
  else
    serveError(connP, (toChrome == -1) ? 503 : 502, "The window", err);
}
