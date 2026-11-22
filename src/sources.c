//
// FILE            sources.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Compile's source as git clones - a directory of them (~/git), as corLibs/bootstrap.sh clones them: coraine,
// c3 and the Cor-Libs side by side. What a build needs of it, and getting what is missing.
//
//   GET  /api/compile/repos?bridges=<repo>,<repo>   the repositories a build from the clones needs - coraine, c3,
//                                                   and what coraine's docker/vendor-libs.sh --list says, the
//                                                   bridges' repositories only of the bridges ticked - each with
//                                                   where it is, its branch and commit, and what goes into a build
//   POST /api/compile/clone {"repo"}                git clone it into the directory (202); the directory is made
//   GET  /api/compile/clone                         the clones started: [{"repo", "state", "message"}]
//
// What goes into a build: coraine as its clone has it checked out (HEAD - uncommitted changes are NOT in it),
// c3 and the libraries at origin/main as last fetched - coraine-build's default (LIBS_REF).
//
// A repository found elsewhere (Source: "it is elsewhere") is kept in c3.json; coraine-build takes ONE directory
// of siblings, so the source handed to it is then a directory of links (sourcesView): the clones' entries, and
// the ones elsewhere in their place.
//
// The repository list runs a few git commands per repository - a thread of its own, the request suspended
// (c3 serves one request at a time on its loop). A clone runs in a thread too; the page asks how it went.
//
#include <dirent.h>                              // opendir, readdir
#include <errno.h>                               // errno
#include <pthread.h>                             // pthread_*
#include <stdio.h>                               // snprintf
#include <stdlib.h>                              // malloc, free, getenv, realpath
#include <limits.h>                              // PATH_MAX
#include <string.h>                              // strcmp, strlen, strstr
#include <sys/stat.h>                            // stat, mkdir
#include <unistd.h>                              // symlink, readlink, unlink, access

#include "corAlloc/CorAlloc.h"                   // CorAlloc
#include "corAlloc/corAllocBufferInit.h"         // corAllocBufferInit
#include "corAlloc/corAllocBufferReset.h"        // corAllocBufferReset
#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup
#include "corTree/CorNode.h"                     // CorNode
#include "corTree/corTreeLookup.h"               // corTreeLookup
#include "corJson/CorJson.h"                     // CorJson
#include "corJson/corJsonCreate.h"               // corJsonCreate
#include "corJson/corJsonParse.h"                // corJsonParse

#include "c3.h"

#define REPOS_MAX       48
#define CLONES_MAX      48
#define PATHS_MAX       32



// -----------------------------------------------------------------------------
//
// repoNameValid - letters, digits, - and _: a repository name, safe in a path and a URL
//
static bool repoNameValid(const char* name)
{
  if ((name == NULL) || (name[0] == 0) || (strlen(name) > 60))
    return false;

  for (const char* c = name; *c != 0; c++)
  {
    if (!(((*c >= 'a') && (*c <= 'z')) || ((*c >= 'A') && (*c <= 'Z')) || ((*c >= '0') && (*c <= '9')) || (*c == '-') || (*c == '_')))
      return false;
  }
  return true;
}



// -----------------------------------------------------------------------------
//
// urlDecodeInPlace - %XX and + of a query parameter's value
//
static void urlDecodeInPlace(char* s)
{
  char* out = s;

  for (char* in = s; *in != 0; in++)
  {
    if ((in[0] == '%') && (in[1] != 0) && (in[2] != 0))
    {
      char hex[3] = { in[1], in[2], 0 };
      *out++ = (char) strtol(hex, NULL, 16);
      in += 2;
    }
    else
      *out++ = (*in == '+') ? ' ' : *in;
  }
  *out = 0;
}



// -----------------------------------------------------------------------------
//
// repoUrl - where a repository is cloned from: coraine and c3 are SEAMWARE's, the other cor repositories
// SEAMWARE-cor's (as the Documentation page's repoOrg)
//
static void repoUrl(const char* name, char* out, int outLen)
{
  bool seamware = (strcmp(name, "coraine") == 0) || (strcmp(name, "c3") == 0) || (strcmp(name, "corApisixNgsild") == 0);

  snprintf(out, outLen, "https://github.com/%s/%s.git", seamware ? "SEAMWARE" : "SEAMWARE-cor", name);
}



// -----------------------------------------------------------------------------
//
// mkdirs - mkdir -p
//
static bool mkdirs(const char* path)
{
  char buf[1100];

  snprintf(buf, sizeof(buf), "%s", path);
  for (char* p = &buf[1]; *p != 0; p++)
  {
    if (*p != '/')
      continue;
    *p = 0;
    if ((mkdir(buf, 0755) != 0) && (errno != EEXIST))
      return false;
    *p = '/';
  }
  return (mkdir(buf, 0755) == 0) || (errno == EEXIST);
}



// -----------------------------------------------------------------------------
//
// linkSet - 'link' a symbolic link to 'target', touched only when it is not already that: an unchanged view
// keeps its mtime (the feature list is cached by it)
//
static void linkSet(const char* link, const char* target)
{
  char    now[1100];
  ssize_t n = readlink(link, now, sizeof(now) - 1);

  if (n >= 0)
  {
    now[n] = 0;
    if (strcmp(now, target) == 0)
      return;
  }
  unlink(link);
  if (symlink(target, link) != 0)
    fprintf(stderr, "c3: link %s -> %s: %s\n", link, target, strerror(errno));
}



// -----------------------------------------------------------------------------
//
// sourcesView - the directory coraine-build is given when repositories are elsewhere: a link per entry of 'dir',
// and the ones elsewhere (names[i] at paths[i]) in their place - $XDG_DATA_HOME/c3/clones-view. Its path into out.
//
void sourcesView(const char* dir, char names[][64], char paths[][1024], int n, char* out, int outLen)
{
  const char* xdg  = getenv("XDG_DATA_HOME");
  const char* home = getenv("HOME");
  char        view[1100];
  char        link[1300];
  char        target[1300];

  if ((xdg != NULL) && (xdg[0] == '/'))
    snprintf(view, sizeof(view), "%s/c3/clones-view", xdg);
  else
    snprintf(view, sizeof(view), "%s/.local/share/c3/clones-view", (home != NULL) ? home : "");
  mkdirs(view);
  snprintf(out, outLen, "%s", view);

  //
  // Every entry of the view that is neither in 'dir' nor elsewhere goes
  //
  DIR* vP = opendir(view);
  if (vP != NULL)
  {
    struct dirent* deP;
    while ((deP = readdir(vP)) != NULL)
    {
      if (deP->d_name[0] == '.')
        continue;

      bool keep = false;
      for (int ix = 0; ix < n; ix++)
        keep = keep || (strcmp(names[ix], deP->d_name) == 0);

      struct stat st;
      snprintf(target, sizeof(target), "%s/%s", dir, deP->d_name);
      keep = keep || (stat(target, &st) == 0);

      if (keep == false)
      {
        snprintf(link, sizeof(link), "%s/%s", view, deP->d_name);
        unlink(link);
      }
    }
    closedir(vP);
  }

  DIR* dP = opendir(dir);
  if (dP != NULL)
  {
    struct dirent* deP;
    while ((deP = readdir(dP)) != NULL)
    {
      if (deP->d_name[0] == '.')
        continue;
      snprintf(link, sizeof(link), "%s/%s", view, deP->d_name);
      snprintf(target, sizeof(target), "%s/%s", dir, deP->d_name);
      linkSet(link, target);
    }
    closedir(dP);
  }

  for (int ix = 0; ix < n; ix++)
  {
    snprintf(link, sizeof(link), "%s/%s", view, names[ix]);
    linkSet(link, paths[ix]);
  }
}



// -----------------------------------------------------------------------------
//
// The repository list - a thread per request, the request suspended
//
typedef struct ReposJob
{
  CorHttpConn* connP;
  char         kind[16];
  char         dir[1024];                        // the directory of clones
  char         bridges[1024];                    // the bridge repositories, comma separated
  int          nPaths;
  char         names[PATHS_MAX][64];
  char         paths[PATHS_MAX][1024];
} ReposJob;

static const char* pathOf(ReposJob* jP, const char* repo, char* out, int outLen, bool* elsewhereP)
{
  *elsewhereP = false;
  for (int ix = 0; ix < jP->nPaths; ix++)
  {
    if (strcmp(jP->names[ix], repo) == 0)
    {
      //
      // A path kept for the repository that IS the one in the directory (the directory chosen after) is not
      // elsewhere
      //
      char here[1024];
      char hereReal[PATH_MAX];
      char thereReal[PATH_MAX];

      snprintf(here, sizeof(here), "%s/%s", jP->dir, repo);
      if ((realpath(here, hereReal) != NULL) && (realpath(jP->paths[ix], thereReal) != NULL) && (strcmp(hereReal, thereReal) == 0))
        break;

      *elsewhereP = true;
      snprintf(out, outLen, "%s", jP->paths[ix]);
      return out;
    }
  }
  snprintf(out, outLen, "%s/%s", jP->dir, repo);
  return out;
}



//
// repoAdd - one repository's member of the answer
//
static void repoAdd(Str* sP, ReposJob* jP, const char* repo, const char* role, bool first)
{
  char        path[1100];
  char        git[1200];
  char        url[256];
  bool        elsewhere;
  struct stat st;
  const char* ref = (strcmp(repo, "coraine") == 0) ? "HEAD" : "origin/main";

  pathOf(jP, repo, path, sizeof(path), &elsewhere);
  snprintf(git, sizeof(git), "%s/.git", path);
  repoUrl(repo, url, sizeof(url));

  bool present = (stat(git, &st) == 0);

  strAdd(sP, first ? "\n  " : ",\n  ");
  strAdd(sP, "{\"name\": ");          strAddJson(sP, repo);
  strAdd(sP, ", \"role\": ");         strAddJson(sP, role);
  strAdd(sP, ", \"path\": ");         strAddJson(sP, path);
  strAdd(sP, ", \"elsewhere\": ");    strAdd(sP, elsewhere ? "true" : "false");
  strAdd(sP, ", \"present\": ");      strAdd(sP, present ? "true" : "false");
  strAdd(sP, ", \"url\": ");          strAddJson(sP, url);
  strAdd(sP, ", \"ref\": ");          strAddJson(sP, ref);

  if (present)
  {
    //
    // One shell per repository: the branch, HEAD, the ref that goes in, the uncommitted changes
    //
    char  out[1024];
    char* argv[] = { (char*) "sh", (char*) "-c",
                     (char*) "cd \"$1\" || exit 1; "
                             "b=$(git rev-parse --abbrev-ref HEAD 2>/dev/null); "
                             "h=$(git rev-parse --short HEAD 2>/dev/null); "
                             "r=$(git rev-parse --short \"$2^{commit}\" 2>/dev/null); "
                             "d=$(git status --porcelain --untracked-files=no 2>/dev/null | wc -l); "
                             "echo \"${b:--} ${h:--} ${r:--} $d\"",
                     (char*) "sh", path, (char*) ref, NULL };
    char  branch[256] = "-", head[64] = "-", refSha[64] = "-";
    int   dirty = 0;

    if (runCapture(argv, out, sizeof(out), 20) == 0)
      sscanf(out, "%255s %63s %63s %d", branch, head, refSha, &dirty);

    strAdd(sP, ", \"branch\": ");     strAddJson(sP, (strcmp(branch, "-") != 0) ? branch : NULL);
    strAdd(sP, ", \"head\": ");       strAddJson(sP, (strcmp(head, "-") != 0) ? head : NULL);
    strAdd(sP, ", \"refSha\": ");     strAddJson(sP, (strcmp(refSha, "-") != 0) ? refSha : NULL);

    char n[32];
    snprintf(n, sizeof(n), "%d", dirty);
    strAdd(sP, ", \"dirty\": ");      strAdd(sP, n);
  }
  strAdd(sP, "}");
}



static void* reposThread(void* vP)
{
  ReposJob* jP = (ReposJob*) vP;
  Str       s  = { NULL, 0, 0 };
  char      corainePath[1100];
  char      vendor[1300];
  bool      elsewhere;

  pathOf(jP, "coraine", corainePath, sizeof(corainePath), &elsewhere);
  snprintf(vendor, sizeof(vendor), "%s/docker/vendor-libs.sh", corainePath);

  //
  // The libraries: coraine's own list - only from a vendor-libs.sh that has --list (an older one would EXPORT)
  //
  char* script  = fileText(vendor);
  bool  hasList = (script != NULL) && (strstr(script, "--list") != NULL);
  free(script);

  char  libs[8192] = "";
  int   libsStatus = -1;

  if (hasList)
  {
    char env[1100];
    snprintf(env, sizeof(env), "VENDOR_BRIDGES=%s", jP->bridges);

    char* argv[] = { (char*) "env", env, vendor, (char*) "--list", NULL };
    libsStatus = runCapture(argv, libs, sizeof(libs), 20);
  }

  strAdd(&s, "{\"kind\": ");    strAddJson(&s, jP->kind);
  strAdd(&s, ", \"dir\": ");    strAddJson(&s, jP->dir);
  strAdd(&s, ", \"complete\": ");
  strAdd(&s, (libsStatus == 0) ? "true" : "false");
  strAdd(&s, ", \"why\": ");
  if (libsStatus == 0)
    strAddJson(&s, NULL);
  else if (access(vendor, F_OK) != 0)
    strAddJson(&s, "the libraries a build needs are listed by the coraine clone - clone coraine first");
  else
    strAddJson(&s, "this coraine clone cannot list the repositories a build needs (docker/vendor-libs.sh --list) - update it");
  strAdd(&s, ", \"repos\": [");

  repoAdd(&s, jP, "coraine", "broker", true);
  repoAdd(&s, jP, "c3", "c3", false);

  if (libsStatus == 0)
  {
    char* save = NULL;
    for (char* line = strtok_r(libs, "\n", &save); line != NULL; line = strtok_r(NULL, "\n", &save))
    {
      if (repoNameValid(line) == false)
        continue;
      bool bridge = (strstr(line, "Bridge") != NULL) && (strcmp(line, "corBridge") != 0);
      repoAdd(&s, jP, line, bridge ? "bridge" : "library", false);
    }
  }
  strAdd(&s, "\n]}");

  char* body = corAllocStrdup(&jP->connP->alloc, s.s);
  serveJson(jP->connP, 200, body);
  corHttpResume(jP->connP);
  strFree(&s);
  free(jP);
  return NULL;
}



static void reposList(CorHttpConn* connP)
{
  ReposJob* jP = (ReposJob*) calloc(1, sizeof(ReposJob));

  if (jP == NULL)
  {
    serveError(connP, 500, "Out of memory", "the repository list");
    return;
  }

  jP->connP  = connP;
  jP->nPaths = configSourceGet(jP->kind, sizeof(jP->kind), jP->dir, sizeof(jP->dir), jP->names, jP->paths, PATHS_MAX);

  //
  // The directory Compile builds from - capsFind's choice when none was made (the page shows it the same way)
  //
  const char* given = NULL;
  const char* query = (connP->query.s != NULL) ? connP->query.s : "";
  char        qdir[1024] = "";
  const char* d         = strstr(query, "dir=");

  if (d != NULL)
  {
    d += 4;
    int len = strcspn(d, "&");
    snprintf(qdir, sizeof(qdir), "%.*s", (len < 1000) ? len : 1000, d);
    urlDecodeInPlace(qdir);
    given = qdir;
  }
  if (given != NULL)
    snprintf(jP->dir, sizeof(jP->dir), "%s", given);
  else if (jP->dir[0] == 0)
    compileClonesDir(jP->dir, sizeof(jP->dir));

  if (jP->dir[0] == 0)
  {
    free(jP);
    serveError(connP, 400, "No directory of clones", "choose one under Source");
    return;
  }

  const char* b = strstr(query, "bridges=");
  if (b != NULL)
  {
    b += 8;
    int len = strcspn(b, "&");
    snprintf(jP->bridges, sizeof(jP->bridges), "%.*s", (len < 1000) ? len : 1000, b);
    urlDecodeInPlace(jP->bridges);
    for (char* c = jP->bridges; *c != 0; c++)    // names and commas only
    {
      if (!(((*c >= 'a') && (*c <= 'z')) || ((*c >= 'A') && (*c <= 'Z')) || ((*c >= '0') && (*c <= '9')) || (*c == ',') || (*c == '-') || (*c == '_')))
        *c = ',';
    }
  }

  pthread_t      tid;
  pthread_attr_t attr;

  corHttpSuspend(connP);
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  if (pthread_create(&tid, &attr, reposThread, jP) != 0)
  {
    corHttpResume(connP);
    serveError(connP, 500, "No thread", "the repository list");
    free(jP);
  }
  pthread_attr_destroy(&attr);
}



// -----------------------------------------------------------------------------
//
// Cloning - one thread per clone; the page asks how they went (GET /api/compile/clone)
//
typedef struct Clone
{
  char repo[64];
  char state[16];                                // "running", "done", "failed"
  char message[1024];
  char url[256];
  char dest[1200];
} Clone;

static pthread_mutex_t cloneMutex = PTHREAD_MUTEX_INITIALIZER;
static Clone           cloneV[CLONES_MAX];
static int             clones = 0;

static void* cloneThread(void* vP)
{
  Clone* cP = (Clone*) vP;
  char   out[4096];
  char*  argv[] = { (char*) "env", (char*) "GIT_TERMINAL_PROMPT=0", (char*) "git", (char*) "clone", (char*) "--quiet",
                    cP->url, cP->dest, NULL };
  int    status = runCapture(argv, out, sizeof(out), 900);

  pthread_mutex_lock(&cloneMutex);
  if (status == 0)
  {
    snprintf(cP->state, sizeof(cP->state), "done");
    cP->message[0] = 0;
  }
  else
  {
    int len = strlen(out);
    while ((len > 0) && ((out[len - 1] == '\n') || (out[len - 1] == ' ')))
      out[--len] = 0;
    snprintf(cP->state, sizeof(cP->state), "failed");
    snprintf(cP->message, sizeof(cP->message), "%s", (out[0] != 0) ? out : "git clone failed");
  }
  pthread_mutex_unlock(&cloneMutex);
  return NULL;
}



static void cloneStart(CorHttpConn* connP)
{
  char kind[16];
  char dir[1024];
  char names[PATHS_MAX][64];
  char paths[PATHS_MAX][1024];

  configSourceGet(kind, sizeof(kind), dir, sizeof(dir), names, paths, PATHS_MAX);
  if (kind[0] == 0)                              // nothing chosen: the default directory, as the page shows it
  {
    compileClonesDir(dir, sizeof(dir));
    if (dir[0] != 0)
      snprintf(kind, sizeof(kind), "clones");
  }
  if ((strcmp(kind, "clones") != 0) || (dir[0] == 0))
  {
    serveError(connP, 409, "No directory of clones", "choose the directory under Source first - the clone goes there");
    return;
  }

  if (connP->bodyRefused || (connP->body.s == NULL))
  {
    serveError(connP, 400, "No body", "{\"repo\": \"<name>\"}");
    return;
  }

  CorAlloc alloc;
  char     buf[4096];
  CorJson  json;

  corAllocBufferInit(&alloc, buf, sizeof(buf), 16 * 1024, NULL, "c3 clone");
  corJsonCreate(&json, &alloc);

  CorNode* bodyP = corJsonParse(&json, corAllocStrdup(&alloc, connP->body.s));
  CorNode* repoP = (bodyP != NULL) ? corTreeLookup(bodyP, "repo") : NULL;
  char     repo[64];

  if ((repoP == NULL) || (repoP->type != CorString) || (repoNameValid(repoP->value.s) == false))
  {
    corAllocBufferReset(&alloc, false);
    serveError(connP, 400, "Bad body", "{\"repo\": \"<name>\"} - a repository name");
    return;
  }
  snprintf(repo, sizeof(repo), "%s", repoP->value.s);
  corAllocBufferReset(&alloc, false);

  char        dest[1200];
  struct stat st;

  snprintf(dest, sizeof(dest), "%s/%s", dir, repo);
  if (stat(dest, &st) == 0)
  {
    serveError(connP, 409, "Already there", dest);
    return;
  }
  if (mkdirs(dir) == false)
  {
    serveError(connP, 500, "Cannot make the directory", dir);
    return;
  }

  pthread_mutex_lock(&cloneMutex);

  Clone* cP = NULL;
  for (int ix = 0; ix < clones; ix++)            // a repository cloned again: its slot reused
  {
    if (strcmp(cloneV[ix].repo, repo) == 0)
    {
      if (strcmp(cloneV[ix].state, "running") == 0)
      {
        pthread_mutex_unlock(&cloneMutex);
        serveError(connP, 409, "Being cloned", repo);
        return;
      }
      cP = &cloneV[ix];
    }
  }
  if ((cP == NULL) && (clones < CLONES_MAX))
    cP = &cloneV[clones++];
  if (cP == NULL)
  {
    pthread_mutex_unlock(&cloneMutex);
    serveError(connP, 503, "Too many clones", "restart c3");
    return;
  }

  snprintf(cP->repo, sizeof(cP->repo), "%s", repo);
  snprintf(cP->state, sizeof(cP->state), "running");
  cP->message[0] = 0;
  repoUrl(repo, cP->url, sizeof(cP->url));
  snprintf(cP->dest, sizeof(cP->dest), "%s", dest);

  pthread_t      tid;
  pthread_attr_t attr;

  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  int rc = pthread_create(&tid, &attr, cloneThread, cP);
  pthread_attr_destroy(&attr);
  if (rc != 0)
    snprintf(cP->state, sizeof(cP->state), "failed");
  pthread_mutex_unlock(&cloneMutex);

  Str s = { NULL, 0, 0 };
  strAdd(&s, "{\"repo\": ");  strAddJson(&s, repo);
  strAdd(&s, ", \"url\": ");  strAddJson(&s, cP->url);
  strAdd(&s, ", \"dest\": "); strAddJson(&s, dest);
  strAdd(&s, "}");
  respondStr(connP, (rc == 0) ? 202 : 500, &s);
}



static void cloneList(CorHttpConn* connP)
{
  Str s = { NULL, 0, 0 };

  strAdd(&s, "[");
  pthread_mutex_lock(&cloneMutex);
  for (int ix = 0; ix < clones; ix++)
  {
    strAdd(&s, (ix == 0) ? "{\"repo\": " : ", {\"repo\": ");
    strAddJson(&s, cloneV[ix].repo);
    strAdd(&s, ", \"state\": ");   strAddJson(&s, cloneV[ix].state);
    strAdd(&s, ", \"message\": "); strAddJson(&s, (cloneV[ix].message[0] != 0) ? cloneV[ix].message : NULL);
    strAdd(&s, "}");
  }
  pthread_mutex_unlock(&cloneMutex);
  strAdd(&s, "]");
  respondStr(connP, 200, &s);
}



// -----------------------------------------------------------------------------
//
// sourcesRequest - /api/compile/repos, /api/compile/clone
//
void sourcesRequest(CorHttpConn* connP, const char* path)
{
  const char* method = connP->method.s;

  if ((strcmp(path, "/api/compile/repos") == 0) && (strcmp(method, "GET") == 0))
    reposList(connP);
  else if ((strcmp(path, "/api/compile/clone") == 0) && (strcmp(method, "POST") == 0))
    cloneStart(connP);
  else if ((strcmp(path, "/api/compile/clone") == 0) && (strcmp(method, "GET") == 0))
    cloneList(connP);
  else
    serveError(connP, 405, "Method not allowed", path);
}
