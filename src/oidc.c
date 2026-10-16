//
// FILE            oidc.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Log in to a broker's OpenID provider (Keycloak, Auth0, Entra ID, ...) - the access token c3 then sends to
// that broker (creds.c asks oidcToken first)
//
//   POST   /api/oidc/start     {"url", "issuer", "clientId", "scope"}: {"authorize": "<the provider's login page>"}
//   GET    /api/oidc/callback  ?code&state - where the provider sends the browser back: the code exchanged
//   GET    /api/oidc/sessions  {"<url>": {"user", "issuer", "expiresAt", "refreshUntil", "error"}}
//   DELETE /api/oidc/session   {"url"}: logged out - the tokens forgotten
//
// The authorization code flow with PKCE (RFC 7636, S256) - a public client, no secret: the provider's
// client must allow the redirect URI http://<c3's host>:<port>/api/oidc/callback. The tokens stay in this
// process - never in the page, never on disk: after a restart, log in again. A thread refreshes an access
// token before it expires (refresh_token grant); credsToken never waits for the network. A provider that
// refuses the refresh (the session ended there) ends the login here.
//
#include <openssl/evp.h>                         // EVP_Digest, EVP_sha256
#include <pthread.h>                             // pthread_*
#include <stdio.h>                               // snprintf
#include <stdlib.h>                              // malloc, free
#include <string.h>                              // strlen, strcmp, strncmp, memcpy
#include <sys/random.h>                          // getrandom
#include <time.h>                                // time
#include <unistd.h>                              // sleep

#include "corAlloc/corAlloc.h"                   // corAlloc
#include "corAlloc/corAllocBufferInit.h"         // corAllocBufferInit
#include "corAlloc/corAllocBufferReset.h"        // corAllocBufferReset
#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup
#include "corJson/CorJson.h"                     // CorJson
#include "corJson/corJsonCreate.h"               // corJsonCreate
#include "corJson/corJsonParse.h"                // corJsonParse
#include "corRest/CorRestVerb.h"                 // CorVerbGet, CorVerbPost
#include "corRest/corRestClient.h"               // corRestClient*
#include "corTree/corTreeLookup.h"               // corTreeLookup

#include "c3.h"



// -----------------------------------------------------------------------------
//
// Limits
//
#define LOGINS_MAX       50                      // as many as the brokers with a token of their own
#define PENDING_MAX      16                      // logins begun, not yet back from the provider
#define PENDING_TTL      600                     // seconds a begun login waits for the provider
#define REFRESH_BEFORE   60                      // seconds before an access token expires, it is refreshed
#define HTTP_TIMEOUT_MS  10000



// -----------------------------------------------------------------------------
//
// Login - a broker's session at its provider
//
typedef struct Login
{
  char       url[512];                           // the broker
  char       issuer[512];
  char       clientId[256];
  char       tokenEndpoint[1024];
  char       user[256];                          // preferred_username (or sub) of the access token - shown, never trusted
  char*      access;                             // malloc'ed
  char*      refresh;                            // malloc'ed, or NULL
  long long  accessExp;                          // when the access token expires
  long long  refreshExp;                         // when the refresh token does (0: not said)
  char       error[256];                         // why the last refresh failed ("": it did not)
  //
  // A Verifiable Credential login (vc.c): the login above is the consumer's (its refresh token renews the
  // credential); the access token is the verifier's, for the presented credential
  //
  bool       vcLogin;
  char       credType[128];                      // Keycloak's credential_configuration_id
  char       verifierToken[1024];                // the verifier's token endpoint
  char       vpScope[128];
  char*      vc;                                 // the credential (a JWT), malloc'ed
  long long  vcExp;                              // its exp (0: none said)
} Login;

typedef struct Pending
{
  char       state[64];
  char       verifier[64];
  char       url[512];
  char       issuer[512];
  char       clientId[256];
  char       tokenEndpoint[1024];
  char       redirect[600];
  time_t     at;
  bool       vcLogin;
  char       credType[128];
  char       verifierToken[1024];
  char       vpScope[128];
} Pending;

static Login            logins[LOGINS_MAX];
static int              loginN = 0;
static Pending          pendings[PENDING_MAX];
static pthread_mutex_t  oidcLock = PTHREAD_MUTEX_INITIALIZER;



// -----------------------------------------------------------------------------
//
// b64url - base64url without padding (RFC 4648 § 5), into out (room for len * 4 / 3 + 4)
//
static void b64url(const unsigned char* in, int len, char* out)
{
  static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  int o = 0;

  for (int ix = 0; ix < len; ix += 3)
  {
    unsigned int v = in[ix] << 16;
    if (ix + 1 < len) v |= in[ix + 1] << 8;
    if (ix + 2 < len) v |= in[ix + 2];

    out[o++] = alphabet[(v >> 18) & 63];
    out[o++] = alphabet[(v >> 12) & 63];
    if (ix + 1 < len) out[o++] = alphabet[(v >> 6) & 63];
    if (ix + 2 < len) out[o++] = alphabet[v & 63];
  }

  out[o] = 0;
}



// -----------------------------------------------------------------------------
//
// randomText - 32 random bytes, base64url: a state, a PKCE verifier (43 characters, RFC 7636 § 4.1)
//
static bool randomText(char* out)
{
  unsigned char bytes[32];

  if (getrandom(bytes, sizeof(bytes), 0) != (ssize_t) sizeof(bytes))
    return false;

  b64url(bytes, sizeof(bytes), out);
  return true;
}



// -----------------------------------------------------------------------------
//
// urlEncode - a query or form value (RFC 3986 unreserved kept)
//
static void urlEncode(Str* sP, const char* s)
{
  for (; *s != 0; ++s)
  {
    unsigned char c = (unsigned char) *s;

    if (((c >= 'A') && (c <= 'Z')) || ((c >= 'a') && (c <= 'z')) || ((c >= '0') && (c <= '9')) || (c == '-') || (c == '.') || (c == '_') || (c == '~'))
      strAddN(sP, (const char*) &c, 1);
    else
      strAddf(sP, "%%%02X", c);
  }
}



// -----------------------------------------------------------------------------
//
// queryParam - a parameter of a query string, decoded, into out; false: not there
//
static bool queryParam(const char* query, const char* name, char* out, int outLen)
{
  int nlen = strlen(name);

  for (const char* p = query; (p != NULL) && (*p != 0); )
  {
    const char* amp = strchr(p, '&');
    const char* end = (amp != NULL) ? amp : p + strlen(p);

    if ((end - p > nlen) && (strncmp(p, name, nlen) == 0) && (p[nlen] == '='))
    {
      int o = 0;

      for (const char* v = p + nlen + 1; (v < end) && (o < outLen - 1); ++v)
      {
        if ((*v == '%') && (v + 2 < end))
        {
          char hex[3] = { v[1], v[2], 0 };
          out[o++] = (char) strtol(hex, NULL, 16);
          v += 2;
        }
        else
          out[o++] = (*v == '+') ? ' ' : *v;
      }

      out[o] = 0;
      return true;
    }

    p = (amp != NULL) ? amp + 1 : NULL;
  }

  return false;
}



// -----------------------------------------------------------------------------
//
// httpJson - a GET (form NULL) or a form POST, its JSON answer parsed in allocP; NULL: no JSON - errBuf why.
// *statusP: the HTTP status (0: no answer).
//
static CorNode* httpJson(const char* url, const char* form, CorAlloc* allocP, int* statusP, char* errBuf, int errLen)
{
  CorRestClientRequest  req;
  CorRestClientResponse resp;

  memset(&resp, 0, sizeof(resp));
  corRestClientRequestInit(&req, (form != NULL) ? CorVerbPost : CorVerbGet, url, allocP);
  corRestClientRequestHeader(&req, "Accept", "application/json");
  if (form != NULL)
  {
    corRestClientRequestHeader(&req, "Content-Type", "application/x-www-form-urlencoded");
    corRestClientRequestBody(&req, form, strlen(form));
  }
  corRestClientRequestTimeout(&req, HTTP_TIMEOUT_MS / 2, HTTP_TIMEOUT_MS);

  CorNode* treeP = NULL;
  int      rc    = corRestClientSend(&req, &resp);

  *statusP = (rc == 0) ? resp.statusCode : 0;

  if (rc != 0)
    snprintf(errBuf, errLen, "%s: %s", url, (resp.errorDetail[0] != 0) ? resp.errorDetail : "no answer");
  else if ((resp.body == NULL) || (resp.bodyLen == 0))
    snprintf(errBuf, errLen, "%s: %d, no body", url, resp.statusCode);
  else
  {
    char* text = corAlloc(allocP, resp.bodyLen + 1);
    memcpy(text, resp.body, resp.bodyLen);
    text[resp.bodyLen] = 0;

    CorJson json;
    corJsonCreate(&json, allocP);
    treeP = corJsonParse(&json, text);

    if ((treeP == NULL) || (treeP->type != CorObject))
    {
      snprintf(errBuf, errLen, "%s: %d, not a JSON object", url, resp.statusCode);
      treeP = NULL;
    }
  }

  corRestClientResponseCleanup(&resp);
  corRestClientRequestCleanup(&req);
  return treeP;
}



// -----------------------------------------------------------------------------
//
// member - a string member, or NULL
//
static const char* member(CorNode* objectP, const char* name)
{
  CorNode* nodeP = (objectP != NULL) ? corTreeLookup(objectP, name) : NULL;
  return ((nodeP != NULL) && (nodeP->type == CorString)) ? nodeP->value.s : NULL;
}

static long long numberMember(CorNode* objectP, const char* name)
{
  CorNode* nodeP = (objectP != NULL) ? corTreeLookup(objectP, name) : NULL;

  if (nodeP == NULL)
    return 0;
  if (nodeP->type == CorInt)
    return nodeP->value.i;
  if (nodeP->type == CorFloat)
    return (long long) nodeP->value.f;
  return 0;
}



// -----------------------------------------------------------------------------
//
// tokenUser - who an access token names (preferred_username, else sub) - read, not verified: the broker
// verifies it, c3 only shows it
//
static void tokenRead(const char* token, char* out, int outLen, long long* expP)
{
  if (out != NULL)
    snprintf(out, outLen, "%s", "");
  if (expP != NULL)
    *expP = 0;

  const char* dot1 = strchr(token, '.');
  const char* dot2 = (dot1 != NULL) ? strchr(dot1 + 1, '.') : NULL;

  if (dot2 == NULL)
    return;

  int   len  = dot2 - dot1 - 1;
  char* b64  = malloc(len + 4);
  char* text = malloc(len + 4);

  if ((b64 == NULL) || (text == NULL))
  {
    free(b64);
    free(text);
    return;
  }

  //
  // base64url to base64, padded, for EVP_DecodeBlock
  //
  int n = 0;
  for (int ix = 0; ix < len; ix++)
    b64[n++] = (dot1[1 + ix] == '-') ? '+' : (dot1[1 + ix] == '_') ? '/' : dot1[1 + ix];
  while (n % 4 != 0)
    b64[n++] = '=';
  b64[n] = 0;

  int got = EVP_DecodeBlock((unsigned char*) text, (unsigned char*) b64, n);

  if (got > 0)
  {
    text[got] = 0;

    CorAlloc alloc;
    char     buf[8192];
    CorJson  json;

    corAllocBufferInit(&alloc, buf, sizeof(buf), 64 * 1024, NULL, "c3 token claims");
    corJsonCreate(&json, &alloc);

    CorNode*    claimsP = corJsonParse(&json, text);
    const char* who     = member(claimsP, "preferred_username");

    if (who == NULL)
      who = member(claimsP, "sub");
    if ((who != NULL) && (out != NULL))
      snprintf(out, outLen, "%s", who);
    if (expP != NULL)
      *expP = numberMember(claimsP, "exp");

    corAllocBufferReset(&alloc, false);
  }

  free(b64);
  free(text);
}



static void tokenUser(const char* token, char* out, int outLen)
{
  tokenRead(token, out, outLen, NULL);
}



// -----------------------------------------------------------------------------
//
// loginFind - the broker's login, or NULL (under oidcLock)
//
static Login* loginFind(const char* url)
{
  for (int ix = 0; ix < loginN; ix++)
  {
    if (strcmp(logins[ix].url, url) == 0)
      return &logins[ix];
  }
  return NULL;
}



// -----------------------------------------------------------------------------
//
// loginDrop - a login out of the list (under oidcLock)
//
static void loginDrop(Login* lP)
{
  free(lP->access);
  free(lP->refresh);
  free(lP->vc);
  *lP = logins[--loginN];                        // the last one in its place
  memset(&logins[loginN], 0, sizeof(Login));
}



// -----------------------------------------------------------------------------
//
// tokensTake - a token endpoint's answer into a login (under oidcLock); false: it holds no access token
//
static bool tokensTake(Login* lP, CorNode* answerP)
{
  const char* access  = member(answerP, "access_token");
  const char* refresh = member(answerP, "refresh_token");
  long long   now     = time(NULL);

  if (access == NULL)
    return false;

  free(lP->access);
  lP->access    = strdup(access);
  lP->accessExp = now + ((numberMember(answerP, "expires_in") > 0) ? numberMember(answerP, "expires_in") : 300);

  if (refresh != NULL)                           // a provider that rotates refresh tokens sends a new one; one that does not, none
  {
    free(lP->refresh);
    lP->refresh    = strdup(refresh);
    lP->refreshExp = (numberMember(answerP, "refresh_expires_in") > 0) ? now + numberMember(answerP, "refresh_expires_in") : 0;
  }

  tokenUser(access, lP->user, sizeof(lP->user));
  lP->error[0] = 0;
  return (lP->access != NULL);
}



// -----------------------------------------------------------------------------
//
// oidcToken - the broker's access token, malloc'ed (the caller frees it); NULL: no login, or one whose access
// token has expired. Never waits: the refresh thread keeps it fresh.
//
char* oidcToken(const char* broker, char* userOut, int userLen)
{
  char* token = NULL;

  pthread_mutex_lock(&oidcLock);

  Login* lP = (broker != NULL) ? loginFind(broker) : NULL;

  if ((lP != NULL) && (lP->access != NULL) && (time(NULL) < lP->accessExp))
  {
    token = strdup(lP->access);
    if (userOut != NULL)
      snprintf(userOut, userLen, "%s", lP->user);
  }

  pthread_mutex_unlock(&oidcLock);
  return token;
}



// -----------------------------------------------------------------------------
//
// refreshOne - the refresh_token grant for one login, its copy taken under the lock, the network outside it
//
static void refreshOne(const char* url)
{
  char  tokenEndpoint[1024];
  char  clientId[256];
  char* refresh = NULL;

  pthread_mutex_lock(&oidcLock);
  Login* lP = loginFind(url);
  if ((lP != NULL) && (lP->refresh != NULL))
  {
    snprintf(tokenEndpoint, sizeof(tokenEndpoint), "%s", lP->tokenEndpoint);
    snprintf(clientId, sizeof(clientId), "%s", lP->clientId);
    refresh = strdup(lP->refresh);
  }
  pthread_mutex_unlock(&oidcLock);

  if (refresh == NULL)
    return;

  Str form = { NULL, 0, 0 };
  strAdd(&form, "grant_type=refresh_token&client_id=");
  urlEncode(&form, clientId);
  strAdd(&form, "&refresh_token=");
  urlEncode(&form, refresh);
  free(refresh);

  CorAlloc alloc;
  char     buf[8192];
  char     err[512] = "";
  int      status   = 0;

  corAllocBufferInit(&alloc, buf, sizeof(buf), 1024 * 1024, NULL, "c3 oidc refresh");

  CorNode* answerP = httpJson(tokenEndpoint, form.s, &alloc, &status, err, sizeof(err));
  strFree(&form);

  pthread_mutex_lock(&oidcLock);
  lP = loginFind(url);

  if (lP != NULL)
  {
    if ((status == 200) && (answerP != NULL) && (tokensTake(lP, answerP) == true))
      ;
    else if ((status == 400) || (status == 401))
    {
      //
      // The provider refuses the refresh token (invalid_grant: the session ended there, or it expired): this
      // login is over - log in again
      //
      const char* why = member(answerP, "error_description");
      printf("c3: the login to %s ended at the provider%s%s\n", url, (why != NULL) ? ": " : "", (why != NULL) ? why : "");
      fflush(stdout);
      loginDrop(lP);
    }
    else
      snprintf(lP->error, sizeof(lP->error), "refresh failed (%s) - tried again", (err[0] != 0) ? err : "the provider's answer");
  }

  pthread_mutex_unlock(&oidcLock);
  corAllocBufferReset(&alloc, false);
}



// -----------------------------------------------------------------------------
//
// refreshVc - a credential login renewed: the credential presented again while it holds; once it expires (or
// within REFRESH_BEFORE of it), the consumer's login refreshed and a new credential obtained first
//
static void refreshVc(const char* url)
{
  char      verifierToken[1024], vpScope[128], issuer[512], clientId[256], tokenEndpoint[1024], credType[128];
  char*     vc      = NULL;
  char*     refresh = NULL;
  long long vcExp   = 0;
  long long now     = time(NULL);

  pthread_mutex_lock(&oidcLock);
  Login* lP = loginFind(url);
  if (lP != NULL)
  {
    snprintf(verifierToken, sizeof(verifierToken), "%s", lP->verifierToken);
    snprintf(vpScope, sizeof(vpScope), "%s", lP->vpScope);
    snprintf(issuer, sizeof(issuer), "%s", lP->issuer);
    snprintf(clientId, sizeof(clientId), "%s", lP->clientId);
    snprintf(tokenEndpoint, sizeof(tokenEndpoint), "%s", lP->tokenEndpoint);
    snprintf(credType, sizeof(credType), "%s", lP->credType);
    vc      = (lP->vc != NULL) ? strdup(lP->vc) : NULL;
    refresh = (lP->refresh != NULL) ? strdup(lP->refresh) : NULL;
    vcExp   = lP->vcExp;
  }
  pthread_mutex_unlock(&oidcLock);

  if (lP == NULL)
    return;

  char  err[512] = "";
  char* newVc    = NULL;
  char* newRefresh = NULL;
  bool  over     = false;

  if ((vc == NULL) || ((vcExp != 0) && (vcExp - now <= REFRESH_BEFORE)))
  {
    //
    // A new credential: the consumer's login refreshed, its access token for the issuance
    //
    if (refresh == NULL)
      over = true;
    else
    {
      Str form = { NULL, 0, 0 };
      strAdd(&form, "grant_type=refresh_token&client_id=");
      urlEncode(&form, clientId);
      strAdd(&form, "&refresh_token=");
      urlEncode(&form, refresh);

      CorAlloc alloc;
      char     buf[8192];
      int      status = 0;

      corAllocBufferInit(&alloc, buf, sizeof(buf), 1024 * 1024, NULL, "c3 vc refresh");
      CorNode*    answerP = httpJson(tokenEndpoint, form.s, &alloc, &status, err, sizeof(err));
      const char* access  = member(answerP, "access_token");
      const char* rt      = member(answerP, "refresh_token");
      strFree(&form);

      if ((status == 200) && (access != NULL))
      {
        newVc = vcObtain(issuer, access, credType, err, sizeof(err));
        if (rt != NULL)
          newRefresh = strdup(rt);
      }
      else if ((status == 400) || (status == 401))
        over = true;

      corAllocBufferReset(&alloc, false);
    }
  }

  long long expiresIn = 0;
  char*     access    = (over == false) ? vcPresent(verifierToken, (newVc != NULL) ? newVc : vc, vpScope, &expiresIn, err, sizeof(err)) : NULL;

  pthread_mutex_lock(&oidcLock);
  lP = loginFind(url);

  if (lP != NULL)
  {
    if (access != NULL)
    {
      free(lP->access);
      lP->access    = access;
      lP->accessExp = time(NULL) + ((expiresIn > 0) ? expiresIn : 300);
      lP->error[0]  = 0;
      access        = NULL;

      if (newVc != NULL)
      {
        free(lP->vc);
        lP->vc = newVc;
        tokenRead(newVc, NULL, 0, &lP->vcExp);
        newVc = NULL;
      }

      if (newRefresh != NULL)
      {
        free(lP->refresh);
        lP->refresh = newRefresh;
        newRefresh  = NULL;
      }
    }
    else if ((over == true) || (time(NULL) >= lP->accessExp))
    {
      printf("c3: the credential login to %s is over%s%s\n", url, (err[0] != 0) ? ": " : "", err);
      fflush(stdout);
      loginDrop(lP);
    }
    else
      snprintf(lP->error, sizeof(lP->error), "renewal failed (%s) - tried again", (err[0] != 0) ? err : "the verifier's answer");
  }

  pthread_mutex_unlock(&oidcLock);
  free(access);
  free(newVc);
  free(newRefresh);
  free(vc);
  free(refresh);
}



// -----------------------------------------------------------------------------
//
// refreshLoop - every 5 s: the access tokens that expire within REFRESH_BEFORE refreshed; a login whose access
// token expired and that cannot be refreshed is over
//
static void* refreshLoop(void* arg)
{
  (void) arg;

  while (true)
  {
    sleep(5);

    char      due[LOGINS_MAX][512];
    bool      dueVc[LOGINS_MAX];
    int       n   = 0;
    long long now = time(NULL);

    pthread_mutex_lock(&oidcLock);
    for (int ix = 0; ix < loginN; )
    {
      Login* lP = &logins[ix];

      if (lP->accessExp - now > REFRESH_BEFORE)
        ++ix;
      else if ((lP->vcLogin == true) || ((lP->refresh != NULL) && ((lP->refreshExp == 0) || (now < lP->refreshExp))))
      {
        dueVc[n] = lP->vcLogin;
        snprintf(due[n++], sizeof(due[0]), "%s", lP->url);
        ++ix;
      }
      else if (now >= lP->accessExp)
        loginDrop(lP);                           // nothing to refresh it with: over (ix now holds the one moved in)
      else
        ++ix;
    }
    pthread_mutex_unlock(&oidcLock);

    for (int ix = 0; ix < n; ix++)
    {
      if (dueVc[ix] == true)
        refreshVc(due[ix]);
      else
        refreshOne(due[ix]);
    }
  }

  return NULL;
}



// -----------------------------------------------------------------------------
//
// oidcInit - the refresh thread
//
void oidcInit(void)
{
  pthread_t      tid;
  pthread_attr_t attr;

  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  if (pthread_create(&tid, &attr, refreshLoop, NULL) != 0)
  {
    printf("c3: no thread to refresh login tokens - a login lasts as long as its first access token\n");
    fflush(stdout);
  }
  pthread_attr_destroy(&attr);
}



// -----------------------------------------------------------------------------
//
// OidcJob - a request answered by a thread of its own (the provider may be slow): the loop's connection suspended
//
typedef struct OidcJob
{
  CorHttpConn*  connP;
  char          url[512];
  char          issuer[512];
  char          clientId[256];
  char          scope[256];
  char          host[256];                       // the Host the page came to c3 by - the redirect URI's
  char          code[2048];
  char          state[64];
  bool          vcLogin;                         // a credential login: the fields below
  char          credType[128];
  char          verifierDiscovery[1024];
  char          vpScope[128];
} OidcJob;

static bool jobStart(OidcJob* jobP, void* (*fn)(void*))
{
  pthread_t      tid;
  pthread_attr_t attr;

  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  corHttpSuspend(jobP->connP);

  bool ok = (pthread_create(&tid, &attr, fn, jobP) == 0);

  pthread_attr_destroy(&attr);

  if (ok == false)
  {
    serveError(jobP->connP, 503, "Busy", "no thread for the request");
    corHttpResumeHere(jobP->connP);
    free(jobP);
  }

  return ok;
}



// -----------------------------------------------------------------------------
//
// startThread - the provider's discovery document read; a login begun: its state, its PKCE pair; the page
// gets the URL of the provider's login page
//
static void* startThread(void* arg)
{
  OidcJob*     jobP  = (OidcJob*) arg;
  CorHttpConn* connP = jobP->connP;
  CorAlloc     alloc;
  char         buf[16384];
  char         err[512] = "";
  int          status   = 0;
  char         discovery[700];

  corAllocBufferInit(&alloc, buf, sizeof(buf), 1024 * 1024, NULL, "c3 oidc discovery");

  int ilen = strlen(jobP->issuer);
  snprintf(discovery, sizeof(discovery), "%.*s/.well-known/openid-configuration", ((ilen > 0) && (jobP->issuer[ilen - 1] == '/')) ? ilen - 1 : ilen, jobP->issuer);

  CorNode*    docP      = httpJson(discovery, NULL, &alloc, &status, err, sizeof(err));
  const char* issuer    = member(docP, "issuer");
  const char* authorize = member(docP, "authorization_endpoint");
  const char* token     = member(docP, "token_endpoint");

  if ((docP == NULL) || (status != 200))
    serveError(connP, 502, "The provider did not answer", (err[0] != 0) ? err : discovery);
  else if ((issuer == NULL) || (strcmp(issuer, jobP->issuer) != 0))
    serveError(connP, 502, "Another issuer", "the provider's discovery document names another issuer than the one given - OpenID Connect Discovery § 4.3");
  else if ((authorize == NULL) || (token == NULL))
    serveError(connP, 502, "Not an OpenID provider", "its discovery document has no authorization_endpoint or token_endpoint");
  else
  {
    Pending p;
    memset(&p, 0, sizeof(p));

    //
    // A credential login: the verifier's token endpoint, from its discovery document - before the user logs in
    //
    if (jobP->vcLogin == true)
    {
      int         vstatus = 0;
      CorNode*    vdocP   = httpJson(jobP->verifierDiscovery, NULL, &alloc, &vstatus, err, sizeof(err));
      const char* vtoken  = member(vdocP, "token_endpoint");

      if ((vdocP == NULL) || (vstatus != 200) || (vtoken == NULL))
      {
        serveError(connP, 502, "The verifier did not answer", (err[0] != 0) ? err : "its discovery document has no token_endpoint");
        goto vcDone;
      }

      p.vcLogin = true;
      snprintf(p.credType, sizeof(p.credType), "%s", jobP->credType);
      snprintf(p.verifierToken, sizeof(p.verifierToken), "%s", vtoken);
      snprintf(p.vpScope, sizeof(p.vpScope), "%s", jobP->vpScope);
    }

    unsigned char digest[32];
    unsigned int  dlen = 0;
    char          challenge[64];

    if ((randomText(p.state) == false) || (randomText(p.verifier) == false) ||
        (EVP_Digest(p.verifier, strlen(p.verifier), digest, &dlen, EVP_sha256(), NULL) != 1))
      serveError(connP, 500, "No randomness", "the login could not be begun");
    else
    {
      b64url(digest, dlen, challenge);
      snprintf(p.url, sizeof(p.url), "%s", jobP->url);
      snprintf(p.issuer, sizeof(p.issuer), "%s", jobP->issuer);
      snprintf(p.clientId, sizeof(p.clientId), "%s", jobP->clientId);
      snprintf(p.tokenEndpoint, sizeof(p.tokenEndpoint), "%s", token);
      snprintf(p.redirect, sizeof(p.redirect), "http://%s/api/oidc/callback", jobP->host);
      p.at = time(NULL);

      //
      // The slot of an expired one, or the oldest
      //
      pthread_mutex_lock(&oidcLock);
      int slot = 0;
      for (int ix = 1; ix < PENDING_MAX; ix++)
      {
        if (pendings[ix].at < pendings[slot].at)
          slot = ix;
      }
      pendings[slot] = p;
      pthread_mutex_unlock(&oidcLock);

      Str s = { NULL, 0, 0 };
      Str u = { NULL, 0, 0 };

      strAdd(&u, authorize);
      strAdd(&u, (strchr(authorize, '?') != NULL) ? "&" : "?");
      strAdd(&u, "response_type=code&client_id=");
      urlEncode(&u, jobP->clientId);
      strAdd(&u, "&redirect_uri=");
      urlEncode(&u, p.redirect);
      strAdd(&u, "&scope=");
      urlEncode(&u, jobP->scope);
      strAdd(&u, "&state=");
      urlEncode(&u, p.state);
      strAdd(&u, "&code_challenge=");
      urlEncode(&u, challenge);
      strAdd(&u, "&code_challenge_method=S256");

      strAdd(&s, "{\"authorize\": ");
      strAddJson(&s, u.s);
      strAdd(&s, ", \"redirectUri\": ");
      strAddJson(&s, p.redirect);
      strAdd(&s, "}");
      strFree(&u);
      respondStr(connP, 200, &s);
    }
  }

 vcDone:
  corAllocBufferReset(&alloc, false);
  free(jobP);
  corHttpResume(connP);
  return NULL;
}



// -----------------------------------------------------------------------------
//
// pageAnswer - the page the provider's redirect lands on: what happened, and back to c3 (the window that
// opened the login hears of it and closes this one)
//
static void pageAnswer(CorHttpConn* connP, int status, const char* message, const char* broker)
{
  Str s = { NULL, 0, 0 };

  strAdd(&s, "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">"
             "<title>c3 login</title><style>body{font:15px system-ui,sans-serif;margin:40px;color:#222;background:#fff}"
             "@media (prefers-color-scheme: dark){body{color:#ddd;background:#16181c}}</style></head><body><p id=\"m\"></p><script>");
  strAdd(&s, "const m = ");
  strAddJson(&s, message);
  strAdd(&s, "; const b = ");
  strAddJson(&s, broker);
  strAddf(&s, "; const ok = %s;", (status == 200) ? "true" : "false");
  strAdd(&s, "document.getElementById('m').textContent = m;"
             "if (window.opener) { try { window.opener.postMessage({ c3: 'oidc', broker: b, ok }, location.origin); } catch (e) {} setTimeout(() => window.close(), ok ? 600 : 4000); }"
             "else setTimeout(() => { location.href = '/'; }, ok ? 800 : 4000);"
             "</script></body></html>");

  corHttpResponseStatus(connP, status);
  corHttpResponseHeader(connP, "Content-Type", "text/html; charset=utf-8");
  corHttpResponseHeader(connP, "Cache-Control", "no-store");

  char* body = corAlloc(&connP->alloc, s.len + 1);
  memcpy(body, s.s, s.len + 1);
  corHttpResponseBody(connP, body, s.len);
  strFree(&s);
}



// -----------------------------------------------------------------------------
//
// callbackThread - the code exchanged for the tokens (with the PKCE verifier), the login kept
//
static void* callbackThread(void* arg)
{
  OidcJob*     jobP  = (OidcJob*) arg;
  CorHttpConn* connP = jobP->connP;
  Pending      p;
  bool         found = false;

  pthread_mutex_lock(&oidcLock);
  for (int ix = 0; ix < PENDING_MAX; ix++)
  {
    if ((pendings[ix].state[0] != 0) && (strcmp(pendings[ix].state, jobP->state) == 0))
    {
      p     = pendings[ix];
      found = (time(NULL) - p.at <= PENDING_TTL);
      memset(&pendings[ix], 0, sizeof(Pending));          // a state is used once
      break;
    }
  }
  pthread_mutex_unlock(&oidcLock);

  if (found == false)
  {
    pageAnswer(connP, 400, "This login is not one c3 began, or it is older than 10 minutes - log in again from c3.", "");
    free(jobP);
    corHttpResume(connP);
    return NULL;
  }

  Str form = { NULL, 0, 0 };
  strAdd(&form, "grant_type=authorization_code&code=");
  urlEncode(&form, jobP->code);
  strAdd(&form, "&redirect_uri=");
  urlEncode(&form, p.redirect);
  strAdd(&form, "&client_id=");
  urlEncode(&form, p.clientId);
  strAdd(&form, "&code_verifier=");
  urlEncode(&form, p.verifier);

  CorAlloc alloc;
  char     buf[16384];
  char     err[512] = "";
  int      status   = 0;

  corAllocBufferInit(&alloc, buf, sizeof(buf), 1024 * 1024, NULL, "c3 oidc token");

  CorNode* answerP = httpJson(p.tokenEndpoint, form.s, &alloc, &status, err, sizeof(err));
  strFree(&form);

  char msg[1200];

  //
  // A credential login: the consumer's access token gets the credential, the credential the verifier's token
  // - the network outside the lock
  //
  char*     vc        = NULL;
  char*     vpAccess  = NULL;
  long long expiresIn = 0;

  if ((p.vcLogin == true) && (status == 200) && (member(answerP, "access_token") != NULL))
  {
    vc = vcObtain(p.issuer, member(answerP, "access_token"), p.credType, err, sizeof(err));
    if (vc != NULL)
      vpAccess = vcPresent(p.verifierToken, vc, p.vpScope, &expiresIn, err, sizeof(err));

    if (vpAccess == NULL)
    {
      snprintf(msg, sizeof(msg), "%s: %s", (vc == NULL) ? "No credential from the provider" : "The verifier did not take the credential", (err[0] != 0) ? err : "no answer");
      pageAnswer(connP, 502, msg, p.url);
      free(vc);
      corAllocBufferReset(&alloc, false);
      free(jobP);
      corHttpResume(connP);
      return NULL;
    }
  }

  if ((status != 200) || (answerP == NULL) || (member(answerP, "access_token") == NULL))
  {
    const char* why = member(answerP, "error_description");
    if (why == NULL)
      why = member(answerP, "error");
    snprintf(msg, sizeof(msg), "The provider did not give a token: %s", (why != NULL) ? why : (err[0] != 0) ? err : "no access_token in its answer");
    pageAnswer(connP, 502, msg, p.url);
  }
  else
  {
    pthread_mutex_lock(&oidcLock);

    Login* lP = loginFind(p.url);

    if ((lP == NULL) && (loginN < LOGINS_MAX))
    {
      lP = &logins[loginN++];
      memset(lP, 0, sizeof(Login));
    }

    if (lP == NULL)
    {
      pthread_mutex_unlock(&oidcLock);
      pageAnswer(connP, 507, "c3 keeps logins for 50 brokers at most - log out of one first.", p.url);
    }
    else
    {
      snprintf(lP->url, sizeof(lP->url), "%s", p.url);
      snprintf(lP->issuer, sizeof(lP->issuer), "%s", p.issuer);
      snprintf(lP->clientId, sizeof(lP->clientId), "%s", p.clientId);
      snprintf(lP->tokenEndpoint, sizeof(lP->tokenEndpoint), "%s", p.tokenEndpoint);
      free(lP->refresh);
      lP->refresh    = NULL;
      lP->refreshExp = 0;
      tokensTake(lP, answerP);

      lP->vcLogin = p.vcLogin;
      if (p.vcLogin == true)
      {
        //
        // The broker's token is the verifier's; the consumer's access token is done with (its refresh token
        // renews the credential)
        //
        snprintf(lP->credType, sizeof(lP->credType), "%s", p.credType);
        snprintf(lP->verifierToken, sizeof(lP->verifierToken), "%s", p.verifierToken);
        snprintf(lP->vpScope, sizeof(lP->vpScope), "%s", p.vpScope);
        free(lP->vc);
        lP->vc = vc;
        tokenRead(vc, NULL, 0, &lP->vcExp);
        vc = NULL;
        free(lP->access);
        lP->access    = vpAccess;
        lP->accessExp = time(NULL) + ((expiresIn > 0) ? expiresIn : 300);
        vpAccess      = NULL;
      }

      snprintf(msg, sizeof(msg), "Logged in to %s%s%s%s. Back to c3 ...", p.url, (lP->user[0] != 0) ? " as " : "", lP->user, (lP->vcLogin == true) ? ", with a Verifiable Credential" : "");
      pthread_mutex_unlock(&oidcLock);
      pageAnswer(connP, 200, msg, p.url);
    }
  }

  free(vc);
  free(vpAccess);
  corAllocBufferReset(&alloc, false);
  free(jobP);
  corHttpResume(connP);
  return NULL;
}



// -----------------------------------------------------------------------------
//
// sessionsList - GET /api/oidc/sessions
//
static void sessionsList(CorHttpConn* connP)
{
  Str s = { NULL, 0, 0 };

  strAdd(&s, "{");
  pthread_mutex_lock(&oidcLock);
  for (int ix = 0; ix < loginN; ix++)
  {
    Login* lP = &logins[ix];

    strAdd(&s, (ix > 0) ? ", " : "");
    strAddJson(&s, lP->url);
    strAdd(&s, ": {\"user\": ");
    strAddJson(&s, lP->user);
    strAdd(&s, ", \"issuer\": ");
    strAddJson(&s, lP->issuer);
    strAdd(&s, ", \"clientId\": ");
    strAddJson(&s, lP->clientId);
    strAddf(&s, ", \"expiresAt\": %lld, \"refreshUntil\": %lld, \"refreshes\": %s, \"error\": ", lP->accessExp, lP->refreshExp, (lP->refresh != NULL) ? "true" : "false");
    strAddJson(&s, (lP->error[0] != 0) ? lP->error : NULL);
    if (lP->vcLogin == true)
    {
      strAdd(&s, ", \"credential\": {\"type\": ");
      strAddJson(&s, lP->credType);
      strAddf(&s, ", \"expiresAt\": %lld, \"holder\": ", lP->vcExp);
      strAddJson(&s, vcHolderDid());
      strAdd(&s, "}");
    }
    strAdd(&s, "}");
  }
  pthread_mutex_unlock(&oidcLock);
  strAdd(&s, "}");

  respondStr(connP, 200, &s);
}



// -----------------------------------------------------------------------------
//
// bodyObject - the request's JSON object body, or NULL (400 answered)
//
static CorNode* bodyObject(CorHttpConn* connP)
{
  CorJson json;
  corJsonCreate(&json, &connP->alloc);

  char*    copy  = (connP->body.s != NULL) ? corAllocStrdup(&connP->alloc, connP->body.s) : NULL;
  CorNode* bodyP = (copy != NULL) ? corJsonParse(&json, copy) : NULL;

  if ((bodyP == NULL) || (bodyP->type != CorObject))
  {
    serveError(connP, 400, "Bad request", "a JSON object is expected as the body");
    return NULL;
  }

  return bodyP;
}

static bool httpUrl(const char* s)
{
  return (s != NULL) && ((strncmp(s, "http://", 7) == 0) || (strncmp(s, "https://", 8) == 0));
}



// -----------------------------------------------------------------------------
//
// oidcRequest - /api/oidc/...
//
void oidcRequest(CorHttpConn* connP, const char* path)
{
  const char* method = connP->method.s;

  if (strcmp(path, "/api/oidc/sessions") == 0)
  {
    if (strcmp(method, "GET") == 0)
      sessionsList(connP);
    else
      serveError(connP, 405, "Method not allowed", "GET");
    return;
  }

  if (strcmp(path, "/api/oidc/callback") == 0)
  {
    if (strcmp(method, "GET") != 0)
    {
      serveError(connP, 405, "Method not allowed", "GET");
      return;
    }

    const char* query = (connP->query.s != NULL) ? connP->query.s : "";
    char        error[256];
    char        detail[512];

    if (queryParam(query, "error", error, sizeof(error)) == true)
    {
      char msg[900];
      if (queryParam(query, "error_description", detail, sizeof(detail)) == false)
        detail[0] = 0;
      snprintf(msg, sizeof(msg), "The provider refused the login: %s%s%s", error, (detail[0] != 0) ? " - " : "", detail);
      pageAnswer(connP, 400, msg, "");
      return;
    }

    OidcJob* jobP = calloc(1, sizeof(OidcJob));

    if ((jobP == NULL) || (queryParam(query, "code", jobP->code, sizeof(jobP->code)) == false) ||
        (queryParam(query, "state", jobP->state, sizeof(jobP->state)) == false))
    {
      free(jobP);
      pageAnswer(connP, 400, "No code and state from the provider - log in again from c3.", "");
      return;
    }

    jobP->connP = connP;
    jobStart(jobP, callbackThread);
    return;
  }

  if ((strcmp(path, "/api/oidc/start") == 0) && (strcmp(method, "POST") == 0))
  {
    CorNode* bodyP = bodyObject(connP);
    if (bodyP == NULL)
      return;

    const char* url      = member(bodyP, "url");
    const char* issuer   = member(bodyP, "issuer");
    const char* clientId = member(bodyP, "clientId");
    const char* scope    = member(bodyP, "scope");
    const char* host     = corHttpHeader(connP, "Host");

    if ((httpUrl(url) == false) || (strlen(url) >= 512))
      serveError(connP, 400, "Bad request", "\"url\": the broker, http://host:port");
    else if ((httpUrl(issuer) == false) || (strlen(issuer) >= 512))
      serveError(connP, 400, "Bad request", "\"issuer\": the provider's issuer, an http(s) URL (https://keycloak.example.org/realms/city)");
    else if ((clientId == NULL) || (clientId[0] == 0) || (strlen(clientId) >= 256))
      serveError(connP, 400, "Bad request", "\"clientId\": the provider's client c3 logs in as - a public client");
    else if ((scope != NULL) && (strlen(scope) >= 256))
      serveError(connP, 400, "Bad request", "\"scope\": at most 255 characters");
    else if ((host == NULL) || (host[0] == 0) || (strlen(host) >= 256) || (strpbrk(host, "/\\ \"<>") != NULL))
      serveError(connP, 400, "Bad request", "no Host header to make the redirect URI of");
    else
    {
      OidcJob* jobP = calloc(1, sizeof(OidcJob));
      if (jobP == NULL)
      {
        serveError(connP, 503, "Busy", "out of memory");
        return;
      }

      jobP->connP = connP;
      snprintf(jobP->url, sizeof(jobP->url), "%s", url);
      snprintf(jobP->issuer, sizeof(jobP->issuer), "%s", issuer);
      snprintf(jobP->clientId, sizeof(jobP->clientId), "%s", clientId);
      snprintf(jobP->scope, sizeof(jobP->scope), "%s", ((scope != NULL) && (scope[0] != 0)) ? scope : "openid");
      snprintf(jobP->host, sizeof(jobP->host), "%s", host);

      //
      // "fdsc": {"credentialType", "verifier", "scope"} - a credential login (the Data Space Connector)
      //
      CorNode* fdscP = corTreeLookup(bodyP, "fdsc");
      if ((fdscP != NULL) && (fdscP->type == CorObject))
      {
        const char* credType = member(fdscP, "credentialType");
        const char* verifier = member(fdscP, "verifier");
        const char* vpScope  = member(fdscP, "scope");

        if ((credType == NULL) || (credType[0] == 0) || (strlen(credType) >= sizeof(jobP->credType)) ||
            (httpUrl(verifier) == false) || (strlen(verifier) >= sizeof(jobP->verifierDiscovery)) ||
            ((vpScope != NULL) && (strlen(vpScope) >= sizeof(jobP->vpScope))))
        {
          free(jobP);
          serveError(connP, 400, "Bad request", "\"fdsc\": {\"credentialType\": the credential's configuration id at the issuer, \"verifier\": the verifier's discovery document (an http(s) URL), \"scope\"}");
          return;
        }

        jobP->vcLogin = true;
        snprintf(jobP->credType, sizeof(jobP->credType), "%s", credType);
        snprintf(jobP->verifierDiscovery, sizeof(jobP->verifierDiscovery), "%s", verifier);
        snprintf(jobP->vpScope, sizeof(jobP->vpScope), "%s", ((vpScope != NULL) && (vpScope[0] != 0)) ? vpScope : "default");
      }

      jobStart(jobP, startThread);
    }
    return;
  }

  if ((strcmp(path, "/api/oidc/session") == 0) && (strcmp(method, "DELETE") == 0))
  {
    CorNode* bodyP = bodyObject(connP);
    if (bodyP == NULL)
      return;

    const char* url = member(bodyP, "url");
    if (url == NULL)
    {
      serveError(connP, 400, "Bad request", "\"url\": the broker");
      return;
    }

    pthread_mutex_lock(&oidcLock);
    Login* lP = loginFind(url);
    if (lP != NULL)
      loginDrop(lP);
    pthread_mutex_unlock(&oidcLock);

    sessionsList(connP);
    return;
  }

  serveError(connP, 404, "Not found", path);
}
