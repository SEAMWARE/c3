//
// FILE            issues.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// AI Assist's reports (report_gap), filed on GitHub as the user of this machine - with gh, when it is installed and
// logged in; without it the page opens GitHub's new-issue page, filled in, as before
//
//   GET  /api/issues   { "gh": true | false }   gh installed and logged in (gh auth status) - kept ten minutes
//   POST /api/issues   { "repo": "assistant" | "c3", "title", "body", "labels": [] } -> { "url": "<the issue>" }
//                      gh issue create in SEAMWARE-cor/coraine-assistant (the assistant: what it could not do, got
//                      wrong, did slowly) or SEAMWARE/c3 (c³ itself: a bug, an improvement) - c3 names the repository,
//                      the page only picks one of the two. Labels, each repository's own: gap, wrong-answer, slow;
//                      bug, enhancement - any other is left out
//
// Only from c3's own page (Origin: this machine): it posts on GitHub in the user's name. The page asks only when
// the user presses "File on GitHub" in the draft - that press is their go-ahead.
//
#include <stdbool.h>                             // bool
#include <stdio.h>                               // snprintf
#include <string.h>                              // strcmp, strncmp, strlen, strstr, strspn, strcspn
#include <sys/wait.h>                            // WIFEXITED, WEXITSTATUS
#include <time.h>                                // time

#include "corAlloc/corAlloc.h"                   // corAlloc
#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup
#include "corJson/corJsonCreate.h"               // corJsonCreate
#include "corJson/corJsonParse.h"                // corJsonParse
#include "corTree/corTreeLookup.h"               // corTreeLookup

#include "c3.h"



static bool   ghOk   = false;
static time_t ghAt   = 0;



// -----------------------------------------------------------------------------
//
// ghReady - gh in $PATH ('gh' its path) and logged in; asked again after ten minutes, or at once after a failure
//
static bool ghReady(char* gh, int ghLen)
{
  if (inPath("gh", gh, ghLen) == false)
    return false;

  if ((ghAt == 0) || (time(NULL) - ghAt > 600) || (ghOk == false))
  {
    char  out[4096];
    char* argv[] = { gh, (char*) "auth", (char*) "status", (char*) "--hostname", (char*) "github.com", NULL };
    int   status = runCapture(argv, out, sizeof(out), 15);

    ghOk = (status != -1) && WIFEXITED(status) && (WEXITSTATUS(status) == 0);
    ghAt = time(NULL);
  }

  return ghOk;
}



// -----------------------------------------------------------------------------
//
// issuesRequest - /api/issues
//
void issuesRequest(CorHttpConn* connP, const char* path)
{
  const char* method = connP->method.s;
  char        gh[4096];

  if (strcmp(path, "/api/issues") != 0)
  {
    serveError(connP, 404, "Not found", path);
    return;
  }

  if (strcmp(method, "GET") == 0)
  {
    serveJson(connP, 200, ghReady(gh, sizeof(gh)) ? "{\"gh\": true}" : "{\"gh\": false}");
    return;
  }

  if (strcmp(method, "POST") != 0)
  {
    serveError(connP, 405, "Method not allowed", path);
    return;
  }

  const char* origin = corHttpHeader(connP, "Origin");
  if ((origin == NULL) ||
      ((strncmp(origin, "http://localhost:", 17) != 0) && (strncmp(origin, "http://127.0.0.1:", 17) != 0) && (strncmp(origin, "http://[::1]:", 13) != 0)))
  {
    serveError(connP, 403, "Forbidden", "an issue is filed from c3's own page only (Origin: this machine)");
    return;
  }

  CorJson json;
  corJsonCreate(&json, &connP->alloc);

  char*    copy    = ((connP->bodyRefused == false) && (connP->body.s != NULL)) ? corAllocStrdup(&connP->alloc, connP->body.s) : NULL;
  CorNode* bodyP   = (copy != NULL) ? corJsonParse(&json, copy) : NULL;
  CorNode* titleP  = ((bodyP != NULL) && (bodyP->type == CorObject)) ? corTreeLookup(bodyP, "title")  : NULL;
  CorNode* textP   = ((bodyP != NULL) && (bodyP->type == CorObject)) ? corTreeLookup(bodyP, "body")   : NULL;
  CorNode* labelsP = ((bodyP != NULL) && (bodyP->type == CorObject)) ? corTreeLookup(bodyP, "labels") : NULL;
  CorNode* repoP   = ((bodyP != NULL) && (bodyP->type == CorObject)) ? corTreeLookup(bodyP, "repo")   : NULL;
  bool     forC3   = (repoP != NULL) && (repoP->type == CorString) && (strcmp(repoP->value.s, "c3") == 0);
  const char* repo = forC3 ? "SEAMWARE/c3" : "SEAMWARE-cor/coraine-assistant";

  if ((repoP != NULL) && ((repoP->type != CorString) || ((forC3 == false) && (strcmp(repoP->value.s, "assistant") != 0))))
  {
    serveError(connP, 400, "Bad request", "repo: \"assistant\" or \"c3\"");
    return;
  }

  if ((titleP == NULL) || (titleP->type != CorString) || (titleP->value.s[0] == 0) || (strlen(titleP->value.s) > 256) ||
      (textP  == NULL) || (textP->type  != CorString) || (strlen(textP->value.s) > 60000))
  {
    serveError(connP, 400, "Bad request", "the body: {\"title\": \"<1 to 256 characters>\", \"body\": \"<the text>\", \"labels\": [...]}");
    return;
  }

  if (ghReady(gh, sizeof(gh)) == false)
  {
    serveError(connP, 409, "No gh", "gh is not installed here, or not logged in (gh auth login) - open the draft on GitHub instead");
    return;
  }

  //
  // argv, no shell: the title and the text go to gh as they are
  //
  char* argv[24];
  int   argc = 0;

  argv[argc++] = gh;
  argv[argc++] = (char*) "issue";
  argv[argc++] = (char*) "create";
  argv[argc++] = (char*) "--repo";
  argv[argc++] = (char*) repo;
  argv[argc++] = (char*) "--title";
  argv[argc++] = titleP->value.s;
  argv[argc++] = (char*) "--body";
  argv[argc++] = textP->value.s;

  if ((labelsP != NULL) && (labelsP->type == CorArray))
  {
    for (CorNode* lP = labelsP->value.head; (lP != NULL) && (argc < 20); lP = lP->next)
    {
      if (lP->type != CorString)
        continue;
      if ((forC3 == true) && (strcmp(lP->value.s, "bug") != 0) && (strcmp(lP->value.s, "enhancement") != 0))
        continue;
      if ((forC3 == false) && (strcmp(lP->value.s, "gap") != 0) && (strcmp(lP->value.s, "wrong-answer") != 0) && (strcmp(lP->value.s, "slow") != 0))
        continue;
      argv[argc++] = (char*) "--label";
      argv[argc++] = lP->value.s;
    }
  }
  argv[argc] = NULL;

  char out[8192];
  int  status = runCapture(argv, out, sizeof(out), 30);

  //
  // gh prints the issue's URL - its last line
  //
  char prefix[128];
  snprintf(prefix, sizeof(prefix), "https://github.com/%s/issues/", repo);
  char* url = strstr(out, prefix);
  if ((status == -1) || (WIFEXITED(status) == false) || (WEXITSTATUS(status) != 0) || (url == NULL))
  {
    ghAt = 0;                                    // asked again next time - a logout, a lost network
    out[strcspn(out, "\n")] = 0;                // its first line says why
    serveError(connP, 502, "gh issue create", (out[0] != 0) ? out : "gh did not run");
    return;
  }

  url[strspn(url, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:/.-_")] = 0;

  int   size   = strlen(url) + 16;
  char* answer = corAlloc(&connP->alloc, size);
  snprintf(answer, size, "{\"url\": \"%s\"}", url);
  serveJson(connP, 200, answer);
}
