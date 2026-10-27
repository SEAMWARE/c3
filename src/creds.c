//
// FILE            creds.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The access tokens c3 sends to brokers - Authorization: Bearer <token> on every request to the broker -
// and the headers of a broker's own: an API key, a Basic Authorization, whatever its gateway asks for
//
//   GET    /api/brokers/tokens   which brokers have one, and where it comes from - never the token
//   PUT    /api/brokers/token    {"url", "token", "remember"}: the broker's token
//   DELETE /api/brokers/token    {"url"}: the broker's token forgotten
//   GET    /api/brokers/headers  each broker's headers - a secret one's value never, its last characters
//   PUT    /api/brokers/headers  {"url", "headers": [{"name", "value", "secret"}], "remember"}: the broker's
//                                headers, all of them - a secret header given without "value" keeps its own;
//                                "remember" false or left out: in memory only, out of secrets.json if there
//   DELETE /api/brokers/headers  {"url"}: the broker's headers forgotten
//
// A broker's headers go with every request c3 sends it (credsHeaders): the proxy's reads and writes, live
// values, the WebSocket's upgrade and the metadata of each of its messages. An Authorization among them
// takes the place of the token. The headers c3 sets itself are refused (headerNameAllowed). Remembered,
// they are in secrets.json with the tokens - the secret and the plain ones alike.
//
// A broker's token, in this order:
//
//   0. a login to its OpenID provider (oidc.c) - the access token of it, kept fresh
//   1. its own - typed in Connect: kept in memory, and with "remember" in secrets.json beside the
//      configuration (mode 0600), so it is there at the next start
//   2. --token-file <file>: the default for every broker - read again whenever the file changes, so a
//      script outside c3 can keep a short-lived token fresh
//   3. $C3_TOKEN: the default when there is no --token-file
//
// A token is never on the command line (ps shows it), never in c3.json, never sent to the page.
//
#include <errno.h>                               // errno
#include <fcntl.h>                               // open, O_*
#include <pthread.h>                             // pthread_mutex_t
#include <stdio.h>                               // snprintf
#include <stdlib.h>                              // malloc, free, getenv
#include <string.h>                              // strcmp, strlen, strdup, strrchr
#include <strings.h>                             // strncasecmp
#include <sys/stat.h>                            // stat
#include <unistd.h>                              // write, close, fsync, unlink

#include "corAlloc/corAlloc.h"                   // corAlloc
#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup
#include "corJson/CorJson.h"                     // CorJson
#include "corJson/corJsonCreate.h"               // corJsonCreate
#include "corJson/corJsonParse.h"                // corJsonParse
#include "corTree/corTreeLookup.h"               // corTreeLookup

#include "c3.h"



// -----------------------------------------------------------------------------
//
// Limits
//
#define CREDS_MAX        50                      // brokers with a token of their own
#define CREDS_TOKEN_MAX  (16 * 1024)             // a JWT carrying a Verifiable Credential is several KB
#define HDRS_MAX         16                      // headers of a broker's own
#define HDR_NAME_MAX     64
#define HDR_VALUE_MAX    (8 * 1024)



// -----------------------------------------------------------------------------
//
// Cred - a broker's own token
//
typedef struct Cred
{
  char   url[512];
  char*  token;                                  // malloc'ed
  bool   remembered;                             // also in secrets.json
} Cred;

static Cred             creds[CREDS_MAX];
static int              credN = 0;



// -----------------------------------------------------------------------------
//
// Hdrs - a broker's own headers
//
typedef struct Hdr
{
  char   name[HDR_NAME_MAX + 1];
  char*  value;                                  // malloc'ed
  bool   secret;                                 // its value never sent to the page
} Hdr;

typedef struct Hdrs
{
  char   url[512];
  Hdr    h[HDRS_MAX];
  int    n;
  bool   remembered;                             // also in secrets.json
} Hdrs;

static Hdrs             hdrs[CREDS_MAX];
static int              hdrsN = 0;
static pthread_mutex_t  credsLock = PTHREAD_MUTEX_INITIALIZER;
static char             secretsPath[4200];

static const char*      tokenFile = NULL;        // --token-file
static char*            fileToken = NULL;        // its token, as last read (malloc'ed)
static struct timespec  fileMtime;
static off_t            fileSize  = -1;



// -----------------------------------------------------------------------------
//
// tokenValid - RFC 6750's b64token: what a header can carry, nothing that could end it (CR, LF)
//
static bool tokenValid(const char* t)
{
  int len = strlen(t);

  if ((len == 0) || (len > CREDS_TOKEN_MAX))
    return false;

  for (int ix = 0; ix < len; ix++)
  {
    char c = t[ix];
    if (((c >= 'A') && (c <= 'Z')) || ((c >= 'a') && (c <= 'z')) || ((c >= '0') && (c <= '9')))
      continue;
    if ((c == '-') || (c == '.') || (c == '_') || (c == '~') || (c == '+') || (c == '/'))
      continue;
    if (c == '=')                                // only at the end
    {
      for (int iy = ix; iy < len; iy++)
      {
        if (t[iy] != '=')
          return false;
      }
      return true;
    }
    return false;
  }
  return true;
}



// -----------------------------------------------------------------------------
//
// tokenClean - a token as given: blanks around it and a leading "Bearer " removed, in place
//
static char* tokenClean(char* t)
{
  while ((*t == ' ') || (*t == '\t') || (*t == '\n') || (*t == '\r'))
    ++t;
  if ((strncasecmp(t, "Bearer", 6) == 0) && ((t[6] == ' ') || (t[6] == '\t')))
  {
    t += 7;
    while ((*t == ' ') || (*t == '\t'))
      ++t;
  }

  int len = strlen(t);
  while ((len > 0) && ((t[len - 1] == ' ') || (t[len - 1] == '\t') || (t[len - 1] == '\n') || (t[len - 1] == '\r')))
    t[--len] = 0;

  return t;
}



// -----------------------------------------------------------------------------
//
// headerNameAllowed - a header name (RFC 9110 token, at most 64 characters) that c3 does not set itself
//
// Refused: what c3 sets, or what would change how the request is carried - Host, Content-Length,
// Content-Type, Transfer-Encoding, Connection, Upgrade, Accept, X-C3-Broker, NGSILD-Tenant (the tenant
// chosen in Connect), Sec-WebSocket-*. Authorization is allowed: it takes the place of the token.
//
static bool headerNameAllowed(const char* name, char* errBuf, int errLen)
{
  static const char* refused[] = { "Host", "Content-Length", "Content-Type", "Transfer-Encoding", "Connection", "Upgrade",
                                   "Accept", "X-C3-Broker", "NGSILD-Tenant", "Keep-Alive", "TE", "Trailer" };
  int len = strlen(name);

  if ((len == 0) || (len > HDR_NAME_MAX))
  {
    snprintf(errBuf, errLen, "a header name: 1-%d characters", HDR_NAME_MAX);
    return false;
  }

  for (int ix = 0; ix < len; ix++)
  {
    char c = name[ix];
    if (((c >= 'A') && (c <= 'Z')) || ((c >= 'a') && (c <= 'z')) || ((c >= '0') && (c <= '9')) || (strchr("!#$%&'*+-.^_`|~", c) != NULL))
      continue;
    snprintf(errBuf, errLen, "'%s': a header name is letters, digits and !#$%%&'*+-.^_`|~", name);
    return false;
  }

  for (unsigned int ix = 0; ix < sizeof(refused) / sizeof(refused[0]); ix++)
  {
    if (strcasecmp(name, refused[ix]) == 0)
    {
      snprintf(errBuf, errLen, "'%s' is set by c3 itself", refused[ix]);
      return false;
    }
  }

  if (strncasecmp(name, "Sec-WebSocket-", 14) == 0)
  {
    snprintf(errBuf, errLen, "'%s' is set by c3 itself", name);
    return false;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// headerValueValid - what a header's value can carry: visible characters, spaces and tabs - nothing that
// would end it (CR, LF), at most 8 KB
//
static bool headerValueValid(const char* value)
{
  int len = strlen(value);

  if (len > HDR_VALUE_MAX)
    return false;

  for (int ix = 0; ix < len; ix++)
  {
    unsigned char c = (unsigned char) value[ix];
    if ((c < 0x20) && (c != '\t'))
      return false;
    if (c == 0x7F)
      return false;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// hdrsFind - the broker's headers, or NULL (under credsLock)
//
static Hdrs* hdrsFind(const char* url)
{
  for (int ix = 0; ix < hdrsN; ix++)
  {
    if (strcmp(hdrs[ix].url, url) == 0)
      return &hdrs[ix];
  }
  return NULL;
}



// -----------------------------------------------------------------------------
//
// hdrsClear - a broker's headers freed (under credsLock)
//
static void hdrsClear(Hdrs* hP)
{
  for (int ix = 0; ix < hP->n; ix++)
  {
    free(hP->h[ix].value);
    hP->h[ix].value = NULL;
  }
  hP->n = 0;
}



// -----------------------------------------------------------------------------
//
// credFind - the broker's entry, or NULL (under credsLock)
//
static Cred* credFind(const char* url)
{
  for (int ix = 0; ix < credN; ix++)
  {
    if (strcmp(creds[ix].url, url) == 0)
      return &creds[ix];
  }
  return NULL;
}



// -----------------------------------------------------------------------------
//
// secretsWrite - the remembered tokens to secrets.json, via a temporary file and a rename (under credsLock)
//
static bool secretsWrite(char* errBuf, int errLen)
{
  Str s = { NULL, 0, 0 };
  int n = 0;

  strAdd(&s, "{\"version\": 1, \"tokens\": {");
  for (int ix = 0; ix < credN; ix++)
  {
    if (creds[ix].remembered == false)
      continue;
    strAdd(&s, (n++ > 0) ? ", " : "");
    strAddJson(&s, creds[ix].url);
    strAdd(&s, ": ");
    strAddJson(&s, creds[ix].token);
  }
  strAdd(&s, "}, \"headers\": {");
  n = 0;
  for (int ix = 0; ix < hdrsN; ix++)
  {
    if (hdrs[ix].remembered == false)
      continue;
    strAdd(&s, (n++ > 0) ? ", " : "");
    strAddJson(&s, hdrs[ix].url);
    strAdd(&s, ": [");
    for (int hx = 0; hx < hdrs[ix].n; hx++)
    {
      strAdd(&s, (hx > 0) ? ", {\"name\": " : "{\"name\": ");
      strAddJson(&s, hdrs[ix].h[hx].name);
      strAdd(&s, ", \"value\": ");
      strAddJson(&s, hdrs[ix].h[hx].value);
      strAddf(&s, ", \"secret\": %s}", hdrs[ix].h[hx].secret ? "true" : "false");
    }
    strAdd(&s, "]");
  }
  strAdd(&s, "}}\n");

  char tmp[4300];
  snprintf(tmp, sizeof(tmp), "%s.tmp", secretsPath);

  int fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd == -1)
  {
    snprintf(errBuf, errLen, "%s: %s", tmp, strerror(errno));
    strFree(&s);
    return false;
  }

  int  written = 0;
  bool ok      = true;

  while (written < s.len)
  {
    int w = write(fd, s.s + written, s.len - written);
    if (w <= 0)
    {
      if ((w == -1) && (errno == EINTR))
        continue;
      ok = false;
      break;
    }
    written += w;
  }

  if ((fsync(fd) == -1) || (close(fd) == -1))
    ok = false;
  strFree(&s);

  if ((ok == false) || (rename(tmp, secretsPath) == -1))
  {
    snprintf(errBuf, errLen, "%s: %s", secretsPath, strerror(errno));
    unlink(tmp);
    return false;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// secretsRead - the remembered tokens, at start
//
static void secretsRead(void)
{
  char* text = fileText(secretsPath);
  if (text == NULL)
    return;

  struct stat st;
  if ((stat(secretsPath, &st) == 0) && ((st.st_mode & 077) != 0))
  {
    printf("c3: %s can be read by others (mode %03o) - its tokens are not used; chmod 600 it\n", secretsPath, st.st_mode & 0777);
    fflush(stdout);
    free(text);
    return;
  }

  CorAlloc alloc;
  char     buf[16 * 1024];
  CorJson  json;

  corAllocBufferInit(&alloc, buf, sizeof(buf), 4 * 1024 * 1024, NULL, "c3 secrets");
  corJsonCreate(&json, &alloc);

  CorNode* treeP   = corJsonParse(&json, corAllocStrdup(&alloc, text));
  CorNode* tokensP = ((treeP != NULL) && (treeP->type == CorObject)) ? corTreeLookup(treeP, "tokens") : NULL;

  if ((tokensP != NULL) && (tokensP->type == CorObject))
  {
    for (CorNode* tP = tokensP->value.head; (tP != NULL) && (credN < CREDS_MAX); tP = tP->next)
    {
      if ((tP->type != CorString) || (tP->name == NULL) || (strlen(tP->name) >= sizeof(creds[0].url)) || (tokenValid(tP->value.s) == false))
        continue;
      snprintf(creds[credN].url, sizeof(creds[0].url), "%s", tP->name);
      creds[credN].token      = strdup(tP->value.s);
      creds[credN].remembered = true;
      ++credN;
    }
  }

  CorNode* headersP = ((treeP != NULL) && (treeP->type == CorObject)) ? corTreeLookup(treeP, "headers") : NULL;
  char     err[256];

  if ((headersP != NULL) && (headersP->type == CorObject))
  {
    for (CorNode* bP = headersP->value.head; (bP != NULL) && (hdrsN < CREDS_MAX); bP = bP->next)
    {
      if ((bP->type != CorArray) || (bP->name == NULL) || (strlen(bP->name) >= sizeof(hdrs[0].url)))
        continue;

      Hdrs* hP = &hdrs[hdrsN];
      snprintf(hP->url, sizeof(hP->url), "%s", bP->name);
      hP->n          = 0;
      hP->remembered = true;

      for (CorNode* iP = bP->value.head; (iP != NULL) && (hP->n < HDRS_MAX); iP = iP->next)
      {
        CorNode* nameP   = (iP->type == CorObject) ? corTreeLookup(iP, "name")   : NULL;
        CorNode* valueP  = (iP->type == CorObject) ? corTreeLookup(iP, "value")  : NULL;
        CorNode* secretP = (iP->type == CorObject) ? corTreeLookup(iP, "secret") : NULL;

        if ((nameP == NULL) || (nameP->type != CorString) || (valueP == NULL) || (valueP->type != CorString) ||
            (headerNameAllowed(nameP->value.s, err, sizeof(err)) == false) || (headerValueValid(valueP->value.s) == false))
          continue;

        snprintf(hP->h[hP->n].name, sizeof(hP->h[0].name), "%s", nameP->value.s);
        hP->h[hP->n].value  = strdup(valueP->value.s);
        hP->h[hP->n].secret = (secretP != NULL) && (secretP->type == CorBoolean) && secretP->value.b;
        ++hP->n;
      }

      if (hP->n > 0)
        ++hdrsN;
    }
  }

  if (treeP == NULL)
  {
    printf("c3: %s is not JSON - no remembered tokens\n", secretsPath);
    fflush(stdout);
  }

  corAllocBufferReset(&alloc, false);
  free(text);
}



// -----------------------------------------------------------------------------
//
// fileTokenGet - --token-file's token, read again when the file changed (under credsLock)
//
static const char* fileTokenGet(void)
{
  struct stat st;

  if (stat(tokenFile, &st) != 0)
  {
    free(fileToken);
    fileToken = NULL;
    fileSize  = -1;
    return NULL;
  }

  if ((fileToken != NULL) && (st.st_size == fileSize) && (st.st_mtim.tv_sec == fileMtime.tv_sec) && (st.st_mtim.tv_nsec == fileMtime.tv_nsec))
    return fileToken;

  free(fileToken);
  fileToken = NULL;
  fileSize  = st.st_size;
  fileMtime = st.st_mtim;

  char* text = fileText(tokenFile);
  if (text == NULL)
    return NULL;

  char* t = tokenClean(text);
  if (tokenValid(t))
    fileToken = strdup(t);
  else
  {
    printf("c3: %s holds no token (one line: the token, or \"Bearer <token>\")\n", tokenFile);
    fflush(stdout);
  }

  free(text);
  return fileToken;
}



// -----------------------------------------------------------------------------
//
// credsInit - after configPathResolve: secrets.json is beside the configuration
//
void credsInit(const char* tokenFileArg)
{
  snprintf(secretsPath, sizeof(secretsPath), "%s", c3ConfigPath);
  char* slash = strrchr(secretsPath, '/');
  if (slash != NULL)
    snprintf(slash + 1, sizeof(secretsPath) - (slash + 1 - secretsPath), "secrets.json");
  else
    snprintf(secretsPath, sizeof(secretsPath), "secrets.json");

  secretsRead();

  if ((tokenFileArg != NULL) && (tokenFileArg[0] != 0))
  {
    tokenFile = tokenFileArg;
    if (fileTokenGet() == NULL)
    {
      printf("c3: --token-file %s: no token in it yet - read again when it changes\n", tokenFile);
      fflush(stdout);
    }
  }
}



// -----------------------------------------------------------------------------
//
// credsToken - the broker's token (malloc'ed - the caller frees it), or NULL; 'sourceP': where it is from
//
char* credsToken(const char* broker, const char** sourceP)
{
  const char* source = NULL;
  char*       token  = (broker != NULL) ? oidcToken(broker, NULL, 0) : NULL;

  if (token != NULL)
  {
    if (sourceP != NULL)
      *sourceP = "login";
    return token;
  }

  pthread_mutex_lock(&credsLock);

  Cred* cP = (broker != NULL) ? credFind(broker) : NULL;
  if (cP != NULL)
  {
    token  = strdup(cP->token);
    source = cP->remembered ? "remembered" : "typed";
  }
  else if (tokenFile != NULL)
  {
    const char* t = fileTokenGet();
    if (t != NULL)
    {
      token  = strdup(t);
      source = "file";
    }
  }
  else
  {
    char* env = getenv("C3_TOKEN");
    if (env != NULL)
    {
      char* copy = strdup(env);
      char* t    = tokenClean(copy);
      if (tokenValid(t))
      {
        token  = strdup(t);
        source = "env";
      }
      free(copy);
    }
  }

  pthread_mutex_unlock(&credsLock);

  if (sourceP != NULL)
    *sourceP = source;
  return token;
}



// -----------------------------------------------------------------------------
//
// credsHeaders - the headers c3 adds to a request to 'broker', in 'kv' (at most 'max'): its own headers, then
// Authorization: Bearer <its token> unless an Authorization is among them. Keys and values malloc'ed - free
// them with credsHeadersFree. Returns how many.
//
int credsHeaders(const char* broker, CorRestKeyValue* kv, int max)
{
  int  n       = 0;
  bool ownAuth = false;

  pthread_mutex_lock(&credsLock);

  Hdrs* hP = (broker != NULL) ? hdrsFind(broker) : NULL;
  for (int ix = 0; (hP != NULL) && (ix < hP->n) && (n < max); ix++)
  {
    kv[n].key   = strdup(hP->h[ix].name);
    kv[n].value = strdup(hP->h[ix].value);
    if ((kv[n].key == NULL) || (kv[n].value == NULL))
    {
      free(kv[n].key);
      free(kv[n].value);
      continue;
    }
    if (strcasecmp(hP->h[ix].name, "Authorization") == 0)
      ownAuth = true;
    ++n;
  }

  pthread_mutex_unlock(&credsLock);

  if ((ownAuth == false) && (n < max))
  {
    char* token = credsToken(broker, NULL);
    if (token != NULL)
    {
      int   alen = strlen(token) + 8;
      char* auth = malloc(alen);
      if (auth != NULL)
      {
        snprintf(auth, alen, "Bearer %s", token);
        kv[n].key   = strdup("Authorization");
        kv[n].value = auth;
        if (kv[n].key != NULL)
          ++n;
        else
          free(auth);
      }
      free(token);
    }
  }

  return n;
}



// -----------------------------------------------------------------------------
//
// credsHeadersFree - what credsHeaders gave
//
void credsHeadersFree(CorRestKeyValue* kv, int n)
{
  for (int ix = 0; ix < n; ix++)
  {
    free(kv[ix].key);
    free(kv[ix].value);
    kv[ix].key   = NULL;
    kv[ix].value = NULL;
  }
}



// -----------------------------------------------------------------------------
//
// infoAdd - {"source", "tail"} of a token: the last 4 characters, enough to tell two tokens apart
//
static void infoAdd(Str* sP, const char* token, const char* source)
{
  int len = strlen(token);

  strAdd(sP, "{\"source\": ");
  strAddJson(sP, source);
  strAddf(sP, ", \"tail\": \"%s\", \"length\": %d}", (len > 12) ? &token[len - 4] : "", len);
}



// -----------------------------------------------------------------------------
//
// tokensList - GET /api/brokers/tokens: {"brokers": {"<url>": {"source", "tail"}}, "default": {...} | null}
//
static void tokensList(CorHttpConn* connP)
{
  Str s = { NULL, 0, 0 };
  int n = 0;

  strAdd(&s, "{\"brokers\": {");

  pthread_mutex_lock(&credsLock);
  for (int ix = 0; ix < credN; ix++)
  {
    strAdd(&s, (n++ > 0) ? ", " : "");
    strAddJson(&s, creds[ix].url);
    strAdd(&s, ": ");
    infoAdd(&s, creds[ix].token, creds[ix].remembered ? "remembered" : "typed");
  }
  pthread_mutex_unlock(&credsLock);

  strAdd(&s, "}, \"default\": ");

  const char* source;
  char*       token = credsToken(NULL, &source);
  if (token != NULL)
    infoAdd(&s, token, source);
  else
    strAdd(&s, "null");
  free(token);

  strAdd(&s, ", \"tokenFile\": ");
  strAddJson(&s, tokenFile);
  strAdd(&s, "}");

  respondStr(connP, 200, &s);
}



// -----------------------------------------------------------------------------
//
// tokenSet - PUT /api/brokers/token {"url", "token", "remember"}
//
static void tokenSet(CorHttpConn* connP, CorNode* bodyP)
{
  CorNode* urlP      = corTreeLookup(bodyP, "url");
  CorNode* tokenP    = corTreeLookup(bodyP, "token");
  CorNode* rememberP = corTreeLookup(bodyP, "remember");

  if ((urlP == NULL) || (urlP->type != CorString) || (strlen(urlP->value.s) >= sizeof(creds[0].url)) ||
      ((strncmp(urlP->value.s, "http://", 7) != 0) && (strncmp(urlP->value.s, "https://", 8) != 0)))
  {
    serveError(connP, 400, "Bad request", "\"url\": the broker, http://host:port");
    return;
  }

  if ((tokenP == NULL) || (tokenP->type != CorString))
  {
    serveError(connP, 400, "Bad request", "\"token\": a string");
    return;
  }

  if ((rememberP != NULL) && (rememberP->type != CorBoolean))
  {
    serveError(connP, 400, "Bad request", "\"remember\": true or false");
    return;
  }

  char* token = tokenClean(tokenP->value.s);
  if (tokenValid(token) == false)
  {
    serveError(connP, 400, "Bad request", "not a token: letters, digits and - . _ ~ + / (= at the end), at most 16 KB - a JWT is one");
    return;
  }

  bool remember = (rememberP != NULL) && rememberP->value.b;
  char err[512] = "";
  bool ok       = true;

  pthread_mutex_lock(&credsLock);

  Cred* cP          = credFind(urlP->value.s);
  bool  wasRemembered = (cP != NULL) && cP->remembered;

  if (cP == NULL)
  {
    if (credN == CREDS_MAX)
    {
      pthread_mutex_unlock(&credsLock);
      serveError(connP, 507, "Too many tokens", "c3 keeps tokens for 50 brokers at most - forget one first");
      return;
    }
    cP = &creds[credN++];
    snprintf(cP->url, sizeof(cP->url), "%s", urlP->value.s);
    cP->token = NULL;
  }

  free(cP->token);
  cP->token      = strdup(token);
  cP->remembered = remember;

  if (remember || wasRemembered)
    ok = secretsWrite(err, sizeof(err));

  pthread_mutex_unlock(&credsLock);

  if (ok == false)
  {
    serveError(connP, 500, "Not remembered", err);
    return;
  }

  tokensList(connP);
}



// -----------------------------------------------------------------------------
//
// tokenForget - DELETE /api/brokers/token {"url"}
//
static void tokenForget(CorHttpConn* connP, CorNode* bodyP)
{
  CorNode* urlP = corTreeLookup(bodyP, "url");

  if ((urlP == NULL) || (urlP->type != CorString))
  {
    serveError(connP, 400, "Bad request", "\"url\": the broker");
    return;
  }

  char err[512] = "";
  bool ok       = true;

  pthread_mutex_lock(&credsLock);

  Cred* cP = credFind(urlP->value.s);
  if (cP != NULL)
  {
    bool wasRemembered = cP->remembered;

    free(cP->token);
    *cP = creds[--credN];                        // the last one in its place
    creds[credN].token = NULL;

    if (wasRemembered)
      ok = secretsWrite(err, sizeof(err));
  }

  pthread_mutex_unlock(&credsLock);

  if (ok == false)
  {
    serveError(connP, 500, "Not forgotten on disk", err);
    return;
  }

  tokensList(connP);
}



// -----------------------------------------------------------------------------
//
// headersList - GET /api/brokers/headers: {"brokers": {"<url>": {"remembered", "headers": [{"name", "secret",
// "value" | "tail", "length"}]}}} - a secret header's value never, its last 4 characters when it is long enough
//
static void headersList(CorHttpConn* connP)
{
  Str s = { NULL, 0, 0 };

  strAdd(&s, "{\"brokers\": {");

  pthread_mutex_lock(&credsLock);
  for (int ix = 0; ix < hdrsN; ix++)
  {
    Hdrs* hP = &hdrs[ix];

    strAdd(&s, (ix > 0) ? ", " : "");
    strAddJson(&s, hP->url);
    strAddf(&s, ": {\"remembered\": %s, \"headers\": [", hP->remembered ? "true" : "false");
    for (int hx = 0; hx < hP->n; hx++)
    {
      Hdr* h   = &hP->h[hx];
      int  len = strlen(h->value);

      strAdd(&s, (hx > 0) ? ", {\"name\": " : "{\"name\": ");
      strAddJson(&s, h->name);
      if (h->secret)
        strAddf(&s, ", \"secret\": true, \"tail\": \"%s\", \"length\": %d}", (len > 12) ? &h->value[len - 4] : "", len);
      else
      {
        strAdd(&s, ", \"secret\": false, \"value\": ");
        strAddJson(&s, h->value);
        strAdd(&s, "}");
      }
    }
    strAdd(&s, "]}");
  }
  pthread_mutex_unlock(&credsLock);

  strAdd(&s, "}}");
  respondStr(connP, 200, &s);
}



// -----------------------------------------------------------------------------
//
// headersSet - PUT /api/brokers/headers {"url", "headers": [{"name", "value", "secret"}], "remember"}
//
// The broker's headers, all of them, in their order: the ones not given are gone. A secret header given
// without "value" keeps the value it has (the page never had it). An empty list forgets them.
//
static void headersSet(CorHttpConn* connP, CorNode* bodyP)
{
  CorNode* urlP      = corTreeLookup(bodyP, "url");
  CorNode* listP     = corTreeLookup(bodyP, "headers");
  CorNode* rememberP = corTreeLookup(bodyP, "remember");
  char     err[512]  = "";

  if ((urlP == NULL) || (urlP->type != CorString) || (strlen(urlP->value.s) >= sizeof(hdrs[0].url)) ||
      ((strncmp(urlP->value.s, "http://", 7) != 0) && (strncmp(urlP->value.s, "https://", 8) != 0)))
  {
    serveError(connP, 400, "Bad request", "\"url\": the broker, http://host:port");
    return;
  }

  if ((listP == NULL) || (listP->type != CorArray))
  {
    serveError(connP, 400, "Bad request", "\"headers\": an array of {\"name\", \"value\", \"secret\"}");
    return;
  }

  if ((rememberP != NULL) && (rememberP->type != CorBoolean))
  {
    serveError(connP, 400, "Bad request", "\"remember\": true or false");
    return;
  }

  //
  // Checked, all of them, before anything changes
  //
  int n = 0;
  for (CorNode* iP = listP->value.head; iP != NULL; iP = iP->next, ++n)
  {
    CorNode* nameP   = (iP->type == CorObject) ? corTreeLookup(iP, "name")   : NULL;
    CorNode* valueP  = (iP->type == CorObject) ? corTreeLookup(iP, "value")  : NULL;
    CorNode* secretP = (iP->type == CorObject) ? corTreeLookup(iP, "secret") : NULL;

    if (n == HDRS_MAX)
    {
      snprintf(err, sizeof(err), "at most %d headers", HDRS_MAX);
      break;
    }
    if ((nameP == NULL) || (nameP->type != CorString))
    {
      snprintf(err, sizeof(err), "header %d: \"name\", a string", n + 1);
      break;
    }
    if (headerNameAllowed(nameP->value.s, err, sizeof(err)) == false)
      break;
    if ((secretP != NULL) && (secretP->type != CorBoolean))
    {
      snprintf(err, sizeof(err), "%s: \"secret\", true or false", nameP->value.s);
      break;
    }
    if ((valueP != NULL) && ((valueP->type != CorString) || (headerValueValid(valueP->value.s) == false)))
    {
      snprintf(err, sizeof(err), "%s: the value is a string of at most 8 KB, with no line break nor other control character", nameP->value.s);
      break;
    }
    for (CorNode* pP = listP->value.head; pP != iP; pP = pP->next)
    {
      if (strcasecmp(corTreeLookup(pP, "name")->value.s, nameP->value.s) == 0)
      {
        snprintf(err, sizeof(err), "%s: given twice", nameP->value.s);
        break;
      }
    }
    if (err[0] != 0)
      break;
  }

  if (err[0] != 0)
  {
    serveError(connP, 400, "Bad request", err);
    return;
  }

  bool remember = (rememberP != NULL) && rememberP->value.b;
  bool ok       = true;

  pthread_mutex_lock(&credsLock);

  Hdrs* oldP          = hdrsFind(urlP->value.s);
  bool  wasRemembered = (oldP != NULL) && oldP->remembered;
  Hdrs  next;

  memset(&next, 0, sizeof(next));
  snprintf(next.url, sizeof(next.url), "%s", urlP->value.s);
  next.remembered = remember;

  for (CorNode* iP = listP->value.head; iP != NULL; iP = iP->next)
  {
    CorNode* nameP   = corTreeLookup(iP, "name");
    CorNode* valueP  = corTreeLookup(iP, "value");
    CorNode* secretP = corTreeLookup(iP, "secret");
    Hdr*     hP      = &next.h[next.n];

    snprintf(hP->name, sizeof(hP->name), "%s", nameP->value.s);
    hP->secret = (secretP != NULL) && secretP->value.b;

    if (valueP != NULL)
      hP->value = strdup(valueP->value.s);
    else
    {
      for (int ix = 0; (oldP != NULL) && (ix < oldP->n); ix++)        // a secret one, kept as it is
      {
        if ((strcasecmp(oldP->h[ix].name, hP->name) == 0) && oldP->h[ix].secret)
          hP->value = strdup(oldP->h[ix].value);
      }
      if (hP->value == NULL)
      {
        snprintf(err, sizeof(err), "%s: a value is needed - c3 has none for it", hP->name);
        break;
      }
    }
    ++next.n;
  }

  if (err[0] != 0)
  {
    hdrsClear(&next);
    pthread_mutex_unlock(&credsLock);
    serveError(connP, 400, "Bad request", err);
    return;
  }

  if (oldP != NULL)
  {
    hdrsClear(oldP);
    if (next.n > 0)
      *oldP = next;
    else
      *oldP = hdrs[--hdrsN];                     // the last one in its place
  }
  else if (next.n > 0)
  {
    if (hdrsN == CREDS_MAX)
    {
      hdrsClear(&next);
      pthread_mutex_unlock(&credsLock);
      serveError(connP, 507, "Too many brokers", "c3 keeps headers for 50 brokers at most - forget some first");
      return;
    }
    hdrs[hdrsN++] = next;
  }

  if (remember || wasRemembered)
    ok = secretsWrite(err, sizeof(err));

  pthread_mutex_unlock(&credsLock);

  if (ok == false)
  {
    serveError(connP, 500, "Not remembered", err);
    return;
  }

  headersList(connP);
}



// -----------------------------------------------------------------------------
//
// headersForget - DELETE /api/brokers/headers {"url"}
//
static void headersForget(CorHttpConn* connP, CorNode* bodyP)
{
  CorNode* urlP = corTreeLookup(bodyP, "url");

  if ((urlP == NULL) || (urlP->type != CorString))
  {
    serveError(connP, 400, "Bad request", "\"url\": the broker");
    return;
  }

  char err[512] = "";
  bool ok       = true;

  pthread_mutex_lock(&credsLock);

  Hdrs* hP = hdrsFind(urlP->value.s);
  if (hP != NULL)
  {
    bool wasRemembered = hP->remembered;

    hdrsClear(hP);
    *hP = hdrs[--hdrsN];                         // the last one in its place

    if (wasRemembered)
      ok = secretsWrite(err, sizeof(err));
  }

  pthread_mutex_unlock(&credsLock);

  if (ok == false)
  {
    serveError(connP, 500, "Not forgotten on disk", err);
    return;
  }

  headersList(connP);
}



// -----------------------------------------------------------------------------
//
// credsRequest - /api/brokers/token, /api/brokers/tokens, /api/brokers/headers
//
void credsRequest(CorHttpConn* connP, const char* path)
{
  const char* method = connP->method.s;

  bool headers = (strcmp(path, "/api/brokers/headers") == 0);

  if (headers && (strcmp(method, "GET") == 0))
  {
    headersList(connP);
    return;
  }

  if (strcmp(path, "/api/brokers/tokens") == 0)
  {
    if (strcmp(method, "GET") != 0)
      serveError(connP, 405, "Method not allowed", "GET");
    else
      tokensList(connP);
    return;
  }

  if ((strcmp(method, "PUT") != 0) && (strcmp(method, "DELETE") != 0))
  {
    serveError(connP, 405, "Method not allowed", "PUT or DELETE");
    return;
  }

  CorJson  json;
  corJsonCreate(&json, &connP->alloc);

  char*    copy  = (connP->body.s != NULL) ? corAllocStrdup(&connP->alloc, connP->body.s) : NULL;
  CorNode* bodyP = (copy != NULL) ? corJsonParse(&json, copy) : NULL;

  if ((bodyP == NULL) || (bodyP->type != CorObject))
  {
    serveError(connP, 400, "Bad request", "a JSON object is expected as the body");
    return;
  }

  if (headers && (strcmp(method, "PUT") == 0))
    headersSet(connP, bodyP);
  else if (headers)
    headersForget(connP, bodyP);
  else if (strcmp(method, "PUT") == 0)
    tokenSet(connP, bodyP);
  else
    tokenForget(connP, bodyP);
}
