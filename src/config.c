//
// FILE            config.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The configuration file - ~/.config/c3/c3.json ($XDG_CONFIG_HOME, or --config <file>)
//
// Milestone 1 holds the brokers connected to and the last page:
//
//   {
//     "version": 1,
//     "brokers": [ { "url": "http://localhost:1026", "name": "localhost:1026", "lastUsed": "2026-10-09T17:30:00Z" } ],
//     "ui":      { "lastPage": "connect" }
//   }
//
// The most recently used broker is first. Members this version does not know are kept as they are.
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

  CorNode* brokerP = corTreeObject(&doc.alloc, NULL);
  corTreeChildAdd(brokerP, corTreeString(&doc.alloc, "url",      urlN));
  corTreeChildAdd(brokerP, corTreeString(&doc.alloc, "name",     name));
  corTreeChildAdd(brokerP, corTreeString(&doc.alloc, "lastUsed", now));

  if (oldP != NULL)
    corTreeChildRemove(brokersP, oldP);

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
