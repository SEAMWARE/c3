//
// FILE            config.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The configuration file - ~/.config/c3/c3.json ($XDG_CONFIG_HOME, or --config <file>)
//
// It holds the brokers connected to - with, per broker, the entity types Connect loads and its view (graph
// or map, the map's view, what the markers are coloured by) - the downloaded map areas, and the last page:
//
//   {
//     "version": 1,
//     "brokers": [
//       {
//         "url":      "http://localhost:1026",
//         "name":     "localhost:1026",
//         "lastUsed": "2026-10-09T17:30:00Z",
//         "connect":  { "types": ["Building", "Floor"], "view": "map",
//                       "map": { "center": [-71.06, 42.36], "zoom": 13 }, "colourBy": "type" }
//       }
//     ],
//     "maps":    { "areas": [ { "id": "area-20261009-190012", "name": "Boston", "bbox": [w, s, e, n],
//                               "maxzoom": 15, "bytes": 31457280, "created": "...", "build": "20261009" } ] },
//     "ui":      { "lastPage": "connect" }
//   }
//
// The most recently used broker is first. Members this version does not know are kept as they are,
// also inside a broker.
//
// The file is written whole to '<file>.tmp' and renamed over the old one, so a crash never leaves half a
// file. A file that cannot be parsed is moved aside to '<file>.broken' at start, not overwritten; a file
// with a "version" newer than 1 is read but never written.
//
#include <errno.h>                               // errno
#include <fcntl.h>                               // open, O_*
#include <stdio.h>                               // snprintf, fprintf
#include <stdlib.h>                              // malloc, free, getenv
#include <string.h>                              // strlen, strcmp, strncmp, strerror
#include <sys/stat.h>                            // mkdir, stat
#include <time.h>                                // time, gmtime_r, strftime
#include <unistd.h>                              // write, close, fsync, read

#include "corAlloc/CorAlloc.h"                   // CorAlloc
#include "corAlloc/corAlloc.h"                   // corAlloc
#include "corAlloc/corAllocBufferInit.h"         // corAllocBufferInit
#include "corAlloc/corAllocBufferReset.h"        // corAllocBufferReset
#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup
#include "corTree/CorNode.h"                     // CorNode
#include "corTree/corTreeBuilder.h"              // corTreeObject, corTreeArray, corTreeString, ...
#include "corTree/corTreeChildAddOrReplace.h"    // corTreeChildAddOrReplace
#include "corTree/corTreeChildPrepend.h"         // corTreeChildPrepend
#include "corTree/corTreeLookup.h"               // corTreeLookup
#include "corJson/CorJson.h"                     // CorJson
#include "corJson/corJsonCreate.h"               // corJsonCreate
#include "corJson/corJsonParse.h"                // corJsonParse
#include "corJson/corJsonRender.h"               // corJsonRender
#include "corJson/corJsonRenderSize.h"           // corJsonRenderSize

#include "c3.h"



// -----------------------------------------------------------------------------
//
// The configuration, as text, and what went wrong with the file
//
static char*  cfgText       = NULL;
static char   cfgError[1024];
static bool   cfgWritable   = true;
static int    cfgBrokerCount = 0;

#define CONFIG_VERSION      1
#define CONFIG_BROKERS_MAX  50
#define CONFIG_TYPES_MAX    1000

static const char* configDefault = "{\"version\": 1, \"brokers\": [], \"ui\": {\"lastPage\": \"connect\"}}";



// -----------------------------------------------------------------------------
//
// Doc - a configuration parsed for a change: the tree and the allocator it lives in
//
typedef struct Doc
{
  CorAlloc  alloc;
  char      allocBuf[16 * 1024];
  CorJson   json;
  CorNode*  treeP;
} Doc;



// -----------------------------------------------------------------------------
//
// docParse - parse 'text' (not modified) into 'docP'
//
static CorNode* docParse(Doc* docP, const char* text)
{
  char* copy = corAllocStrdup(&docP->alloc, text);

  if (copy == NULL)
    return NULL;

  return corJsonParse(&docP->json, copy);
}



// -----------------------------------------------------------------------------
//
// docInit / docRelease -
//
static void docInit(Doc* docP)
{
  corAllocBufferInit(&docP->alloc, docP->allocBuf, sizeof(docP->allocBuf), 64 * 1024, NULL, "c3 config");
  corJsonCreate(&docP->json, &docP->alloc);
  docP->treeP = NULL;
}

static void docRelease(Doc* docP)
{
  corAllocBufferReset(&docP->alloc, false);
}



// -----------------------------------------------------------------------------
//
// docRender - the tree as text, malloc'ed
//
static char* docRender(Doc* docP)
{
  int   size = corJsonRenderSize(&docP->json, docP->treeP) + 2;
  char* out  = malloc(size);

  if (out == NULL)
    return NULL;

  corJsonRender(&docP->json, docP->treeP, out);

  int len = strlen(out);                         // a newline at the end, as a text file has
  if ((len == 0) || (out[len - 1] != '\n'))
  {
    out[len]     = '\n';
    out[len + 1] = 0;
  }

  return out;
}



// -----------------------------------------------------------------------------
//
// docNormalise - the members milestone 1 relies on, of the right types; false if the file is not ours
//
static bool docNormalise(Doc* docP, char* errBuf, int errLen)
{
  CorNode* treeP = docP->treeP;

  if ((treeP == NULL) || (treeP->type != CorObject))
  {
    snprintf(errBuf, errLen, "not a JSON object");
    return false;
  }

  CorNode* versionP = corTreeLookup(treeP, "version");
  if (versionP == NULL)
    corTreeChildPrepend(treeP, corTreeInteger(&docP->alloc, "version", CONFIG_VERSION));
  else if (versionP->type != CorInt)
  {
    snprintf(errBuf, errLen, "\"version\" is not an integer");
    return false;
  }
  else if (versionP->value.i > CONFIG_VERSION)
  {
    snprintf(errBuf, errLen, "\"version\" %lld is newer than this c3 (%d): the file is read but not written", versionP->value.i, CONFIG_VERSION);
    cfgWritable = false;
  }

  CorNode* brokersP = corTreeLookup(treeP, "brokers");
  if (brokersP == NULL)
    corTreeChildAdd(treeP, corTreeArray(&docP->alloc, "brokers"));
  else if (brokersP->type != CorArray)
  {
    snprintf(errBuf, errLen, "\"brokers\" is not an array");
    return false;
  }

  CorNode* uiP = corTreeLookup(treeP, "ui");
  if (uiP == NULL)
    corTreeChildAdd(treeP, corTreeObject(&docP->alloc, "ui"));
  else if (uiP->type != CorObject)
  {
    snprintf(errBuf, errLen, "\"ui\" is not an object");
    return false;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// brokersCount -
//
static int brokersCount(CorNode* treeP)
{
  CorNode* brokersP = corTreeLookup(treeP, "brokers");
  int      n        = 0;

  if (brokersP != NULL)
  {
    for (CorNode* bP = brokersP->value.head; bP != NULL; bP = bP->next)
      ++n;
  }

  return n;
}



// -----------------------------------------------------------------------------
//
// mkdirs - mkdir -p of the directory part of 'path', each new directory mode 700
//
static void mkdirs(const char* path)
{
  char dir[4096];

  snprintf(dir, sizeof(dir), "%s", path);

  char* slash = strrchr(dir, '/');
  if (slash == NULL)
    return;
  *slash = 0;

  for (char* p = dir + 1; *p != 0; ++p)
  {
    if (*p == '/')
    {
      *p = 0;
      mkdir(dir, 0700);
      *p = '/';
    }
  }

  mkdir(dir, 0700);
}



// -----------------------------------------------------------------------------
//
// fileWrite - 'text' to c3ConfigPath, via '<file>.tmp' and a rename
//
static bool fileWrite(const char* text, char* errBuf, int errLen)
{
  char tmp[4200];

  snprintf(tmp, sizeof(tmp), "%s.tmp", c3ConfigPath);
  mkdirs(c3ConfigPath);

  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd == -1)
  {
    snprintf(errBuf, errLen, "%s: %s", tmp, strerror(errno));
    return false;
  }

  int len     = strlen(text);
  int written = 0;

  while (written < len)
  {
    int n = write(fd, text + written, len - written);
    if (n <= 0)
    {
      if ((n == -1) && (errno == EINTR))
        continue;
      snprintf(errBuf, errLen, "%s: %s", tmp, strerror(errno));
      close(fd);
      unlink(tmp);
      return false;
    }
    written += n;
  }

  if ((fsync(fd) == -1) || (close(fd) == -1))
  {
    snprintf(errBuf, errLen, "%s: %s", tmp, strerror(errno));
    unlink(tmp);
    return false;
  }

  if (rename(tmp, c3ConfigPath) == -1)
  {
    snprintf(errBuf, errLen, "rename %s: %s", c3ConfigPath, strerror(errno));
    unlink(tmp);
    return false;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// configPathResolve - --config, else $XDG_CONFIG_HOME/c3/c3.json, else ~/.config/c3/c3.json
//
bool configPathResolve(const char* given, char* out, int outLen)
{
  if ((given != NULL) && (given[0] != 0))
  {
    snprintf(out, outLen, "%s", given);
    return true;
  }

  const char* xdg = getenv("XDG_CONFIG_HOME");
  if ((xdg != NULL) && (xdg[0] == '/'))
  {
    snprintf(out, outLen, "%s/c3/c3.json", xdg);
    return true;
  }

  const char* home = getenv("HOME");
  if ((home == NULL) || (home[0] == 0))
    return false;

  snprintf(out, outLen, "%s/.config/c3/c3.json", home);
  return true;
}



// -----------------------------------------------------------------------------
//
// fileRead - the whole file, malloc'ed; NULL with errno set when it cannot be read
//
static char* fileRead(const char* path)
{
  int fd = open(path, O_RDONLY);
  if (fd == -1)
    return NULL;

  struct stat st;
  if ((fstat(fd, &st) == -1) || (st.st_size > 16 * 1024 * 1024))
  {
    close(fd);
    errno = EFBIG;
    return NULL;
  }

  char* buf = malloc(st.st_size + 1);
  int   got = 0;

  while (got < st.st_size)
  {
    int n = read(fd, buf + got, st.st_size - got);
    if (n <= 0)
      break;
    got += n;
  }

  buf[got] = 0;
  close(fd);
  return buf;
}



// -----------------------------------------------------------------------------
//
// configLoad - read the file, or start from the default when there is none
//
void configLoad(void)
{
  Doc   doc;
  char  err[512] = { 0 };
  char* text     = fileRead(c3ConfigPath);

  cfgError[0] = 0;

  if ((text == NULL) && (errno != ENOENT))
  {
    snprintf(cfgError, sizeof(cfgError), "%s: %s - not written this session", c3ConfigPath, strerror(errno));
    cfgWritable = false;
  }

  docInit(&doc);
  doc.treeP = docParse(&doc, (text != NULL) ? text : configDefault);

  if (docNormalise(&doc, err, sizeof(err)) == false)
  {
    //
    // Not a configuration this c3 can read: moved aside, not overwritten
    //
    char aside[4200];

    snprintf(aside, sizeof(aside), "%s.broken", c3ConfigPath);
    rename(c3ConfigPath, aside);
    snprintf(cfgError, sizeof(cfgError), "%s: %s - moved to %s, starting from an empty configuration",
             c3ConfigPath, (doc.treeP == NULL) ? doc.json.errorString : err, aside);
    fprintf(stderr, "c3: %s\n", cfgError);

    docRelease(&doc);
    docInit(&doc);
    doc.treeP = docParse(&doc, configDefault);
  }
  else if (err[0] != 0)
  {
    snprintf(cfgError, sizeof(cfgError), "%s: %s", c3ConfigPath, err);
    fprintf(stderr, "c3: %s\n", cfgError);
  }

  free(cfgText);
  cfgText        = docRender(&doc);
  cfgBrokerCount = brokersCount(doc.treeP);

  docRelease(&doc);
  free(text);
}



// -----------------------------------------------------------------------------
//
// configText / configError / configBrokers -
//
const char* configText(void)    { return cfgText; }
const char* configError(void)   { return (cfgError[0] != 0) ? cfgError : NULL; }
int         configBrokers(void) { return cfgBrokerCount; }



// -----------------------------------------------------------------------------
//
// commit - render the changed tree, write the file, and make it the configuration
//
static bool commit(Doc* docP, char* errBuf, int errLen)
{
  if (cfgWritable == false)
  {
    snprintf(errBuf, errLen, "%s", (cfgError[0] != 0) ? cfgError : "the configuration file is not written this session");
    return false;
  }

  char* text = docRender(docP);
  if (text == NULL)
  {
    snprintf(errBuf, errLen, "out of memory");
    return false;
  }

  if (fileWrite(text, errBuf, errLen) == false)
  {
    free(text);
    return false;
  }

  free(cfgText);
  cfgText        = text;
  cfgBrokerCount = brokersCount(docP->treeP);

  return true;
}



// -----------------------------------------------------------------------------
//
// commitIfChanged - commit, unless the tree renders as the configuration already is
//
static bool commitIfChanged(Doc* docP, char* errBuf, int errLen)
{
  char* text = docRender(docP);

  if ((text != NULL) && (cfgText != NULL) && (strcmp(text, cfgText) == 0))
  {
    free(text);
    return true;
  }

  free(text);
  return commit(docP, errBuf, errLen);
}



// -----------------------------------------------------------------------------
//
// bodyParse - a request body, as a JSON object, in the doc's allocator
//
static CorNode* bodyParse(Doc* docP, char* body, char* errBuf, int errLen)
{
  if ((body == NULL) || (body[0] == 0))
  {
    snprintf(errBuf, errLen, "a JSON object is expected as the body");
    return NULL;
  }

  CorJson  json;
  corJsonCreate(&json, &docP->alloc);

  CorNode* bodyP = corJsonParse(&json, corAllocStrdup(&docP->alloc, body));
  if ((bodyP == NULL) || (bodyP->type != CorObject))
  {
    snprintf(errBuf, errLen, "the body is not a JSON object");
    return NULL;
  }

  return bodyP;
}



// -----------------------------------------------------------------------------
//
// stringMember - a member of 'objectP' that must be a string, if present
//
static bool stringMember(CorNode* objectP, const char* name, bool required, int maxLen, const char** valueP, char* errBuf, int errLen)
{
  CorNode* nodeP = corTreeLookup(objectP, name);

  *valueP = NULL;

  if (nodeP == NULL)
  {
    if (required)
      snprintf(errBuf, errLen, "\"%s\" is missing", name);
    return !required;
  }

  if (nodeP->type != CorString)
  {
    snprintf(errBuf, errLen, "\"%s\" is not a string", name);
    return false;
  }

  if ((int) strlen(nodeP->value.s) > maxLen)
  {
    snprintf(errBuf, errLen, "\"%s\" is longer than %d characters", name, maxLen);
    return false;
  }

  *valueP = nodeP->value.s;
  return true;
}



// -----------------------------------------------------------------------------
//
// brokerFind - the broker with this url in the 'brokers' array
//
static CorNode* brokerFind(CorNode* brokersP, const char* url)
{
  for (CorNode* bP = brokersP->value.head; bP != NULL; bP = bP->next)
  {
    if (bP->type != CorObject)
      continue;

    CorNode* urlP = corTreeLookup(bP, "url");
    if ((urlP != NULL) && (urlP->type == CorString) && (strcmp(urlP->value.s, url) == 0))
      return bP;
  }

  return NULL;
}



// -----------------------------------------------------------------------------
//
// urlNormalise - an http(s) URL with no trailing slashes, copied to the doc's allocator
//
static char* urlNormalise(Doc* docP, const char* url, char* errBuf, int errLen)
{
  if ((strncmp(url, "http://", 7) != 0) && (strncmp(url, "https://", 8) != 0))
  {
    snprintf(errBuf, errLen, "the broker URL must start with http:// or https://");
    return NULL;
  }

  for (const char* p = url; *p != 0; ++p)
  {
    if ((*p <= ' ') || (*p == '"') || (*p == '\\') || (*p == '<') || (*p == '>'))
    {
      snprintf(errBuf, errLen, "the broker URL has a character a URL cannot have");
      return NULL;
    }
  }

  char* out = corAllocStrdup(&docP->alloc, url);
  int   len = strlen(out);

  while ((len > 0) && (out[len - 1] == '/'))
    out[--len] = 0;

  const char* host = strstr(out, "://") + 3;
  if (*host == 0)
  {
    snprintf(errBuf, errLen, "the broker URL has no host");
    return NULL;
  }

  return out;
}



// -----------------------------------------------------------------------------
//
// configBrokerTouch - POST /api/brokers {"url": "...", "name": "..."}
//
// The broker goes first in the list with "lastUsed" now; a name not given keeps the one it had, or is
// the URL's host:port for a new one. The list keeps the CONFIG_BROKERS_MAX most recent.
//
bool configBrokerTouch(char* body, char* errBuf, int errLen)
{
  Doc         doc;
  const char* url;
  const char* name;
  bool        ok = false;

  docInit(&doc);
  doc.treeP = docParse(&doc, cfgText);

  CorNode* bodyP = bodyParse(&doc, body, errBuf, errLen);
  if (bodyP == NULL)
    goto done;

  if (stringMember(bodyP, "url", true, 2048, &url, errBuf, errLen) == false)
    goto done;
  if (stringMember(bodyP, "name", false, 200, &name, errBuf, errLen) == false)
    goto done;

  char* urlN = urlNormalise(&doc, url, errBuf, errLen);
  if (urlN == NULL)
    goto done;

  CorNode* brokersP = corTreeLookup(doc.treeP, "brokers");
  CorNode* oldP     = brokerFind(brokersP, urlN);

  if (((name == NULL) || (name[0] == 0)) && (oldP != NULL))
  {
    CorNode* oldNameP = corTreeLookup(oldP, "name");
    if ((oldNameP != NULL) && (oldNameP->type == CorString))
      name = oldNameP->value.s;
  }

  if ((name == NULL) || (name[0] == 0))
    name = strstr(urlN, "://") + 3;

  char      now[32];
  time_t    t = time(NULL);
  struct tm tm;

  gmtime_r(&t, &tm);
  strftime(now, sizeof(now), "%Y-%m-%dT%H:%M:%SZ", &tm);

  //
  // A broker already in the list keeps its other members (its "connect" choices, members a later c3
  // wrote); only the name and lastUsed change
  //
  CorNode* brokerP = oldP;

  if (brokerP != NULL)
  {
    corTreeChildRemove(brokersP, brokerP);
    corTreeChildAddOrReplace(brokerP, "name",     corTreeString(&doc.alloc, "name",     name));
    corTreeChildAddOrReplace(brokerP, "lastUsed", corTreeString(&doc.alloc, "lastUsed", now));
  }
  else
  {
    brokerP = corTreeObject(&doc.alloc, NULL);
    corTreeChildAdd(brokerP, corTreeString(&doc.alloc, "url",      urlN));
    corTreeChildAdd(brokerP, corTreeString(&doc.alloc, "name",     name));
    corTreeChildAdd(brokerP, corTreeString(&doc.alloc, "lastUsed", now));
  }

  corTreeChildPrepend(brokersP, brokerP);

  //
  // Only the most recent CONFIG_BROKERS_MAX are kept
  //
  int n = 0;
  for (CorNode* bP = brokersP->value.head; bP != NULL; bP = bP->next)
  {
    if (++n == CONFIG_BROKERS_MAX)
    {
      bP->next              = NULL;
      brokersP->value.tail  = bP;
      break;
    }
  }

  ok = commit(&doc, errBuf, errLen);

 done:
  docRelease(&doc);
  return ok;
}



// -----------------------------------------------------------------------------
//
// configBrokerForget - DELETE /api/brokers {"url": "..."}
//
bool configBrokerForget(char* body, char* errBuf, int errLen)
{
  Doc         doc;
  const char* url;
  bool        ok = false;

  docInit(&doc);
  doc.treeP = docParse(&doc, cfgText);

  CorNode* bodyP = bodyParse(&doc, body, errBuf, errLen);
  if (bodyP == NULL)
    goto done;

  if (stringMember(bodyP, "url", true, 2048, &url, errBuf, errLen) == false)
    goto done;

  CorNode* brokersP = corTreeLookup(doc.treeP, "brokers");
  CorNode* oldP     = brokerFind(brokersP, url);

  if (oldP == NULL)
  {
    snprintf(errBuf, errLen, "no broker %s in the configuration", url);
    goto done;
  }

  corTreeChildRemove(brokersP, oldP);
  ok = commit(&doc, errBuf, errLen);

 done:
  docRelease(&doc);
  return ok;
}



// -----------------------------------------------------------------------------
//
// configUiSet - PUT /api/ui {"lastPage": "connect"}
//
bool configUiSet(char* body, char* errBuf, int errLen)
{
  Doc         doc;
  const char* lastPage;
  bool        ok = false;

  docInit(&doc);
  doc.treeP = docParse(&doc, cfgText);

  CorNode* bodyP = bodyParse(&doc, body, errBuf, errLen);
  if (bodyP == NULL)
    goto done;

  if (stringMember(bodyP, "lastPage", true, 64, &lastPage, errBuf, errLen) == false)
    goto done;

  CorNode* uiP   = corTreeLookup(doc.treeP, "ui");
  CorNode* oldP  = corTreeLookup(uiP, "lastPage");

  if ((oldP != NULL) && (oldP->type == CorString) && (strcmp(oldP->value.s, lastPage) == 0))
  {
    ok = true;                                   // unchanged: nothing to write
    goto done;
  }

  if (oldP != NULL)
    corTreeChildRemove(uiP, oldP);

  corTreeChildAdd(uiP, corTreeString(&doc.alloc, "lastPage", lastPage));
  ok = commit(&doc, errBuf, errLen);

 done:
  docRelease(&doc);
  return ok;
}



// -----------------------------------------------------------------------------
//
// configBrokerTypes - PUT /api/brokers/types {"url": "...", "types": ["Building", "Floor"]}
//
// The entity types Connect loads from this broker, kept as the broker's "connect": {"types": [...]}.
// An empty list is a choice too (nothing loaded); a broker that never had a choice has no "types".
// The broker must be in the list already (Connect adds it when the broker has answered).
//
bool configBrokerTypes(char* body, char* errBuf, int errLen)
{
  Doc         doc;
  const char* url;
  bool        ok = false;

  docInit(&doc);
  doc.treeP = docParse(&doc, cfgText);

  CorNode* bodyP = bodyParse(&doc, body, errBuf, errLen);
  if (bodyP == NULL)
    goto done;

  if (stringMember(bodyP, "url", true, 2048, &url, errBuf, errLen) == false)
    goto done;

  CorNode* typesP = corTreeLookup(bodyP, "types");
  if ((typesP == NULL) || (typesP->type != CorArray))
  {
    snprintf(errBuf, errLen, "\"types\" must be an array of type names");
    goto done;
  }

  int n = 0;
  for (CorNode* tP = typesP->value.head; tP != NULL; tP = tP->next)
  {
    if ((tP->type != CorString) || (tP->value.s[0] == 0) || (strlen(tP->value.s) > 2048))
    {
      snprintf(errBuf, errLen, "\"types\" must hold type names: non-empty strings of at most 2048 characters");
      goto done;
    }
    if (++n > CONFIG_TYPES_MAX)
    {
      snprintf(errBuf, errLen, "\"types\" holds more than %d names", CONFIG_TYPES_MAX);
      goto done;
    }
  }

  CorNode* brokersP = corTreeLookup(doc.treeP, "brokers");
  CorNode* brokerP  = brokerFind(brokersP, url);

  if (brokerP == NULL)
  {
    snprintf(errBuf, errLen, "no broker %s in the configuration", url);
    goto done;
  }

  CorNode* connectP = corTreeLookup(brokerP, "connect");
  if ((connectP == NULL) || (connectP->type != CorObject))
  {
    CorNode* newP = corTreeObject(&doc.alloc, "connect");
    corTreeChildAddOrReplace(brokerP, "connect", newP);
    connectP = corTreeLookup(brokerP, "connect");
  }

  CorNode* listP = corTreeArray(&doc.alloc, "types");
  for (CorNode* tP = typesP->value.head; tP != NULL; tP = tP->next)
    corTreeChildAdd(listP, corTreeString(&doc.alloc, NULL, tP->value.s));

  corTreeChildAddOrReplace(connectP, "types", listP);
  ok = commit(&doc, errBuf, errLen);

 done:
  docRelease(&doc);
  return ok;
}



// -----------------------------------------------------------------------------
//
// numberOf - a number member as a double
//
static bool numberOf(CorNode* nodeP, double* vP)
{
  if (nodeP == NULL)
    return false;
  if (nodeP->type == CorFloat)
    *vP = nodeP->value.f;
  else if (nodeP->type == CorInt)
    *vP = (double) nodeP->value.i;
  else
    return false;
  return true;
}



// -----------------------------------------------------------------------------
//
// configBrokerConnect - PUT /api/brokers/connect {"url", "view", "map", "colourBy"}
//
// Connect's view of a broker, kept in its "connect" object beside "types":
//
//   "view":     "graph" or "map" - the one shown
//   "map":      {"center": [lon, lat], "zoom": z, "bearing": b, "pitch": p} - the map's view
//   "colourBy": "type", or the name of a Relationship: the map's markers coloured by its target
//
// Each member is optional; the ones given replace the stored ones, the others stay.
//
bool configBrokerConnect(char* body, char* errBuf, int errLen)
{
  Doc         doc;
  const char* url;
  const char* view;
  const char* colourBy;
  bool        ok = false;

  docInit(&doc);
  doc.treeP = docParse(&doc, cfgText);

  CorNode* bodyP = bodyParse(&doc, body, errBuf, errLen);
  if (bodyP == NULL)
    goto done;

  if (stringMember(bodyP, "url", true, 2048, &url, errBuf, errLen) == false)
    goto done;
  if (stringMember(bodyP, "view", false, 16, &view, errBuf, errLen) == false)
    goto done;
  if (stringMember(bodyP, "colourBy", false, 2048, &colourBy, errBuf, errLen) == false)
    goto done;

  if ((view != NULL) && (strcmp(view, "graph") != 0) && (strcmp(view, "map") != 0))
  {
    snprintf(errBuf, errLen, "\"view\" is \"graph\" or \"map\"");
    goto done;
  }

  CorNode* mapP = corTreeLookup(bodyP, "map");
  CorNode* newMapP = NULL;
  if (mapP != NULL)
  {
    CorNode* centerP = (mapP->type == CorObject) ? corTreeLookup(mapP, "center") : NULL;
    double   lon, lat, zoom, bearing = 0, pitch = 0;

    if ((centerP == NULL) || (centerP->type != CorArray) || (centerP->value.head == NULL) || (centerP->value.head->next == NULL) ||
        !numberOf(centerP->value.head, &lon) || !numberOf(centerP->value.head->next, &lat) ||
        !numberOf(corTreeLookup(mapP, "zoom"), &zoom) ||
        (lon < -180) || (lon > 180) || (lat < -90) || (lat > 90) || (zoom < 0) || (zoom > 24))
    {
      snprintf(errBuf, errLen, "\"map\" must be {\"center\": [lon, lat], \"zoom\": z} (bearing and pitch optional)");
      goto done;
    }
    numberOf(corTreeLookup(mapP, "bearing"), &bearing);
    numberOf(corTreeLookup(mapP, "pitch"), &pitch);

    newMapP = corTreeObject(&doc.alloc, "map");
    CorNode* cP = corTreeArray(&doc.alloc, "center");
    corTreeChildAdd(cP, corTreeFloat(&doc.alloc, NULL, lon));
    corTreeChildAdd(cP, corTreeFloat(&doc.alloc, NULL, lat));
    corTreeChildAdd(newMapP, cP);
    corTreeChildAdd(newMapP, corTreeFloat(&doc.alloc, "zoom", zoom));
    if (bearing != 0)
      corTreeChildAdd(newMapP, corTreeFloat(&doc.alloc, "bearing", bearing));
    if (pitch != 0)
      corTreeChildAdd(newMapP, corTreeFloat(&doc.alloc, "pitch", pitch));
  }

  CorNode* brokersP = corTreeLookup(doc.treeP, "brokers");
  CorNode* brokerP  = brokerFind(brokersP, url);

  if (brokerP == NULL)
  {
    snprintf(errBuf, errLen, "no broker %s in the configuration", url);
    goto done;
  }

  CorNode* connectP = corTreeLookup(brokerP, "connect");
  if ((connectP == NULL) || (connectP->type != CorObject))
  {
    corTreeChildAddOrReplace(brokerP, "connect", corTreeObject(&doc.alloc, "connect"));
    connectP = corTreeLookup(brokerP, "connect");
  }

  if (view != NULL)
    corTreeChildAddOrReplace(connectP, "view", corTreeString(&doc.alloc, "view", view));
  if (colourBy != NULL)
    corTreeChildAddOrReplace(connectP, "colourBy", corTreeString(&doc.alloc, "colourBy", colourBy));
  if (newMapP != NULL)
    corTreeChildAddOrReplace(connectP, "map", newMapP);

  ok = commitIfChanged(&doc, errBuf, errLen);

 done:
  docRelease(&doc);
  return ok;
}



// -----------------------------------------------------------------------------
//
// areaNode - a downloaded map area as an object of the configuration
//
static CorNode* areaNode(CorAlloc* allocP, const MapsArea* aP)
{
  CorNode* objP  = corTreeObject(allocP, NULL);
  CorNode* bboxP = corTreeArray(allocP, "bbox");

  for (int i = 0; i < 4; i++)
    corTreeChildAdd(bboxP, corTreeFloat(allocP, NULL, aP->bbox[i]));

  corTreeChildAdd(objP, corTreeString(allocP, "id", aP->id));
  corTreeChildAdd(objP, corTreeString(allocP, "name", aP->name));
  corTreeChildAdd(objP, bboxP);
  corTreeChildAdd(objP, corTreeInteger(allocP, "maxzoom", aP->maxzoom));
  corTreeChildAdd(objP, corTreeInteger(allocP, "bytes", aP->bytes));
  corTreeChildAdd(objP, corTreeString(allocP, "created", aP->created));
  if (aP->build[0] != 0)
    corTreeChildAdd(objP, corTreeString(allocP, "build", aP->build));

  return objP;
}



// -----------------------------------------------------------------------------
//
// mapsAreas - the configuration's "maps": {"areas": [...]}, created if missing
//
static CorNode* mapsAreas(Doc* docP)
{
  CorNode* mapsP = corTreeLookup(docP->treeP, "maps");
  if ((mapsP == NULL) || (mapsP->type != CorObject))
  {
    corTreeChildAddOrReplace(docP->treeP, "maps", corTreeObject(&docP->alloc, "maps"));
    mapsP = corTreeLookup(docP->treeP, "maps");
  }

  CorNode* areasP = corTreeLookup(mapsP, "areas");
  if ((areasP == NULL) || (areasP->type != CorArray))
  {
    corTreeChildAddOrReplace(mapsP, "areas", corTreeArray(&docP->alloc, "areas"));
    areasP = corTreeLookup(mapsP, "areas");
  }

  return areasP;
}

static const char* areaId(CorNode* aP)
{
  CorNode* idP = (aP->type == CorObject) ? corTreeLookup(aP, "id") : NULL;
  return ((idP != NULL) && (idP->type == CorString)) ? idP->value.s : NULL;
}



// -----------------------------------------------------------------------------
//
// configMapsSync - the downloaded areas in the configuration made to match the map directory
//
// 'added' (a download just finished) goes in with its name; an area whose file is gone is dropped; a file
// with no entry gets one (named after its id); the sizes follow the files. Written only on a change.
//
bool configMapsSync(const MapsArea* disk, int n, const MapsArea* added, char* errBuf, int errLen)
{
  Doc  doc;
  bool ok;

  docInit(&doc);
  doc.treeP = docParse(&doc, cfgText);

  CorNode* areasP = mapsAreas(&doc);

  if (added != NULL)
  {
    for (CorNode* aP = areasP->value.head; aP != NULL; aP = aP->next)
    {
      const char* id = areaId(aP);
      if ((id != NULL) && (strcmp(id, added->id) == 0))
      {
        corTreeChildRemove(areasP, aP);
        break;
      }
    }
    corTreeChildAdd(areasP, areaNode(&doc.alloc, added));
  }

  //
  // Gone from the directory: dropped
  //
  CorNode* aP = areasP->value.head;
  while (aP != NULL)
  {
    CorNode*    next = aP->next;
    const char* id   = areaId(aP);
    bool        here = false;

    for (int i = 0; (id != NULL) && (i < n); i++)
      if (strcmp(disk[i].id, id) == 0)
        here = true;

    if (!here)
      corTreeChildRemove(areasP, aP);
    else
    {
      for (int i = 0; i < n; i++)
      {
        if (strcmp(disk[i].id, id) != 0)
          continue;
        CorNode* bytesP = corTreeLookup(aP, "bytes");
        if ((bytesP == NULL) || (bytesP->type != CorInt) || (bytesP->value.i != disk[i].bytes))
          corTreeChildAddOrReplace(aP, "bytes", corTreeInteger(&doc.alloc, "bytes", disk[i].bytes));
      }
    }
    aP = next;
  }

  //
  // In the directory and not in the configuration: added
  //
  for (int i = 0; i < n; i++)
  {
    bool known = false;
    for (CorNode* bP = areasP->value.head; bP != NULL; bP = bP->next)
    {
      const char* id = areaId(bP);
      if ((id != NULL) && (strcmp(id, disk[i].id) == 0))
        known = true;
    }
    if (!known)
      corTreeChildAdd(areasP, areaNode(&doc.alloc, &disk[i]));
  }

  ok = commitIfChanged(&doc, errBuf, errLen);
  docRelease(&doc);
  return ok;
}



// -----------------------------------------------------------------------------
//
// configMapsAreasText - the downloaded areas as a JSON array, allocated from 'allocP'
//
char* configMapsAreasText(CorAlloc* allocP)
{
  Doc   doc;
  char* out;

  docInit(&doc);
  doc.treeP = docParse(&doc, cfgText);

  CorNode* mapsP  = corTreeLookup(doc.treeP, "maps");
  CorNode* areasP = ((mapsP != NULL) && (mapsP->type == CorObject)) ? corTreeLookup(mapsP, "areas") : NULL;

  if ((areasP == NULL) || (areasP->type != CorArray))
    out = corAllocStrdup(allocP, "[]");
  else
  {
    areasP->name = NULL;
    int size = corJsonRenderSize(&doc.json, areasP) + 2;
    out = corAlloc(allocP, size);
    corJsonRender(&doc.json, areasP, out);
  }

  docRelease(&doc);
  return out;
}



// -----------------------------------------------------------------------------
//
// compileObject - the configuration's "compile": {...}, created if missing
//
static CorNode* compileObject(Doc* docP)
{
  CorNode* compileP = corTreeLookup(docP->treeP, "compile");

  if ((compileP == NULL) || (compileP->type != CorObject))
  {
    corTreeChildAddOrReplace(docP->treeP, "compile", corTreeObject(&docP->alloc, "compile"));
    compileP = corTreeLookup(docP->treeP, "compile");
  }

  return compileP;
}



// -----------------------------------------------------------------------------
//
// compileChoiceCheck - {"name"?, "mode", "features": {"NAME": bool}, "workload"?}: only these, of these types
//
static bool compileChoiceCheck(CorNode* bodyP, bool needName, char* errBuf, int errLen)
{
  const char* s;

  if (stringMember(bodyP, "name", needName, 64, &s, errBuf, errLen) == false)
    return false;
  if ((needName == true) && (s[0] == 0))
  {
    snprintf(errBuf, errLen, "\"name\" is empty");
    return false;
  }

  if (stringMember(bodyP, "mode", false, 16, &s, errBuf, errLen) == false)
    return false;
  if ((s != NULL) && (strcmp(s, "release") != 0) && (strcmp(s, "debug") != 0) && (strcmp(s, "pgo") != 0) && (strcmp(s, "tune") != 0))
  {
    snprintf(errBuf, errLen, "\"mode\" is release, debug, pgo or tune");
    return false;
  }

  if (stringMember(bodyP, "workload", false, 4096, &s, errBuf, errLen) == false)
    return false;

  CorNode* featuresP = corTreeLookup(bodyP, "features");
  if (featuresP != NULL)
  {
    if (featuresP->type != CorObject)
    {
      snprintf(errBuf, errLen, "\"features\" is not an object");
      return false;
    }
    for (CorNode* fP = featuresP->value.head; fP != NULL; fP = fP->next)
    {
      if (fP->type != CorBoolean)
      {
        snprintf(errBuf, errLen, "\"features\": %s is not true or false", fP->name);
        return false;
      }
    }
  }

  for (CorNode* mP = bodyP->value.head; mP != NULL; mP = mP->next)
  {
    if ((strcmp(mP->name, "name") != 0) && (strcmp(mP->name, "mode") != 0) && (strcmp(mP->name, "features") != 0) && (strcmp(mP->name, "workload") != 0))
    {
      snprintf(errBuf, errLen, "\"%s\" is not a member of a build's choice (name, mode, features, workload)", mP->name);
      return false;
    }
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// configCompileChoice - PUT /api/compile/choice {"mode", "features", "workload"}: Compile's choice as it is
//
bool configCompileChoice(char* body, char* errBuf, int errLen)
{
  Doc  doc;
  bool ok = false;

  docInit(&doc);
  doc.treeP = docParse(&doc, cfgText);

  CorNode* bodyP = bodyParse(&doc, body, errBuf, errLen);
  if ((bodyP == NULL) || (compileChoiceCheck(bodyP, false, errBuf, errLen) == false))
    goto done;

  bodyP->name = (char*) "choice";
  corTreeChildAddOrReplace(compileObject(&doc), "choice", bodyP);
  ok = commitIfChanged(&doc, errBuf, errLen);

 done:
  docRelease(&doc);
  return ok;
}



// -----------------------------------------------------------------------------
//
// presetsArray - "compile": {"presets": [...]}, created if missing
//
static CorNode* presetsArray(Doc* docP)
{
  CorNode* compileP = compileObject(docP);
  CorNode* presetsP = corTreeLookup(compileP, "presets");

  if ((presetsP == NULL) || (presetsP->type != CorArray))
  {
    corTreeChildAddOrReplace(compileP, "presets", corTreeArray(&docP->alloc, "presets"));
    presetsP = corTreeLookup(compileP, "presets");
  }

  return presetsP;
}

static CorNode* presetFind(CorNode* presetsP, const char* name)
{
  for (CorNode* pP = presetsP->value.head; pP != NULL; pP = pP->next)
  {
    CorNode* nameP = (pP->type == CorObject) ? corTreeLookup(pP, "name") : NULL;

    if ((nameP != NULL) && (nameP->type == CorString) && (strcmp(nameP->value.s, name) == 0))
      return pP;
  }

  return NULL;
}



// -----------------------------------------------------------------------------
//
// configCompilePreset - PUT /api/compile/presets {"name", "mode", "features", "workload"}: a preset saved
// under its name (one of that name is replaced, in its place)
//
bool configCompilePreset(char* body, char* errBuf, int errLen)
{
  Doc  doc;
  bool ok = false;

  docInit(&doc);
  doc.treeP = docParse(&doc, cfgText);

  CorNode* bodyP = bodyParse(&doc, body, errBuf, errLen);
  if ((bodyP == NULL) || (compileChoiceCheck(bodyP, true, errBuf, errLen) == false))
    goto done;

  CorNode*    presetsP = presetsArray(&doc);
  const char* name     = corTreeLookup(bodyP, "name")->value.s;
  CorNode*    oldP     = presetFind(presetsP, name);

  bodyP->name = NULL;

  if (oldP != NULL)
  {
    //
    // In its place: the list keeps its order
    //
    CorNode* prevP = NULL;
    for (CorNode* pP = presetsP->value.head; pP != oldP; pP = pP->next)
      prevP = pP;

    bodyP->next = oldP->next;
    if (prevP == NULL)
      presetsP->value.head = bodyP;
    else
      prevP->next = bodyP;
    if (presetsP->value.tail == oldP)
      presetsP->value.tail = bodyP;
  }
  else
  {
    int n = 0;
    for (CorNode* pP = presetsP->value.head; pP != NULL; pP = pP->next)
      ++n;
    if (n >= 100)
    {
      snprintf(errBuf, errLen, "100 presets at most");
      goto done;
    }
    corTreeChildAdd(presetsP, bodyP);
  }

  ok = commitIfChanged(&doc, errBuf, errLen);

 done:
  docRelease(&doc);
  return ok;
}



// -----------------------------------------------------------------------------
//
// configCompilePresetDelete - DELETE /api/compile/presets {"name"}
//
bool configCompilePresetDelete(char* body, char* errBuf, int errLen)
{
  Doc         doc;
  const char* name;
  bool        ok = false;

  docInit(&doc);
  doc.treeP = docParse(&doc, cfgText);

  CorNode* bodyP = bodyParse(&doc, body, errBuf, errLen);
  if ((bodyP == NULL) || (stringMember(bodyP, "name", true, 64, &name, errBuf, errLen) == false))
    goto done;

  CorNode* presetsP = presetsArray(&doc);
  CorNode* oldP     = presetFind(presetsP, name);

  if (oldP == NULL)
  {
    snprintf(errBuf, errLen, "no preset '%s'", name);
    goto done;
  }

  corTreeChildRemove(presetsP, oldP);
  ok = commit(&doc, errBuf, errLen);

 done:
  docRelease(&doc);
  return ok;
}
