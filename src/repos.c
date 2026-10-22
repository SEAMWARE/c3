//
// FILE            repos.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The private repositories of SEAMWARE that the user of this machine can read - for the Documentation page,
// which lists them only then, and names none of them in its own source
//
//   GET /api/repos/private   [ { "name", "description" }, ... ] - [] without gh, or not logged in with it
//
// Asked of GitHub as the user: gh repo list SEAMWARE --visibility private - the repositories their
// account may read, and no other. Kept ten minutes: gh takes about a second, and c3 serves nothing
// else meanwhile.
//
#include <stdio.h>                               // snprintf
#include <string.h>                              // strcmp, strlen
#include <sys/wait.h>                            // WIFEXITED, WEXITSTATUS
#include <time.h>                                // time

#include "c3.h"



static char   cache[64 * 1024];
static time_t cacheAt = 0;



// -----------------------------------------------------------------------------
//
// reposRequest - /api/repos/private
//
void reposRequest(CorHttpConn* connP, const char* path)
{
  if ((strcmp(path, "/api/repos/private") != 0) || (strcmp(connP->method.s, "GET") != 0))
  {
    serveError(connP, 404, "Not found", path);
    return;
  }

  if ((cacheAt == 0) || (time(NULL) - cacheAt > 600))
  {
    char  gh[4096];
    char* argv[] = { gh, (char*) "repo", (char*) "list", (char*) "SEAMWARE", (char*) "--visibility", (char*) "private",
                     (char*) "--limit", (char*) "300", (char*) "--json", (char*) "name,description", NULL };
    int   status = -1;

    if (inPath("gh", gh, sizeof(gh)))
      status = runCapture(argv, cache, sizeof(cache), 15);

    //
    // Anything but a JSON array from a clean exit - no gh, not logged in, no network - is no repository
    //
    if ((status == -1) || (WIFEXITED(status) == false) || (WEXITSTATUS(status) != 0) || (cache[0] != '['))
      snprintf(cache, sizeof(cache), "[]");

    cacheAt = time(NULL);
  }

  serveJson(connP, 200, cache);
}
