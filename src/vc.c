//
// FILE            vc.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// A Verifiable Credential login - the Data Space Connector's (coraine's fdsc.so, or the connector itself):
// the broker takes the access tokens its verifier (VCVerifier) issues for a presented credential
//
//   vcObtain  - the credential, from the consumer's Keycloak (OID4VCI, pre-authorized code): with the access
//               token of a login there (oidc.c), Keycloak's create-credential-offer for the credential type,
//               the offer, its pre-authorized code exchanged for a credential access token, the credential
//   vcPresent - a Verifiable Presentation of it, signed by c3's holder key (ES256, did:key), exchanged at the
//               verifier's token endpoint (grant_type vp_token) for the access token the broker takes
//
// The holder key is c3's own - made at the first use, in memory only: a did:key (P-256), as the connector's
// DID Helper makes for a holder. The verifier does not bind the credential to it; it checks the credential's
// issuer, and the presentation's signature against its holder.
//
#include <openssl/bn.h>                          // BN_*
#include <openssl/core_names.h>                  // OSSL_PKEY_PARAM_*
#include <openssl/ecdsa.h>                       // ECDSA_SIG
#include <openssl/evp.h>                         // EVP_*
#include <pthread.h>                             // pthread_mutex_*
#include <stdio.h>                               // snprintf
#include <stdlib.h>                              // malloc, free
#include <string.h>                              // strlen, memcpy

#include "corAlloc/corAlloc.h"                   // corAlloc
#include "corAlloc/corAllocBufferInit.h"         // corAllocBufferInit
#include "corAlloc/corAllocBufferReset.h"        // corAllocBufferReset
#include "corJson/CorJson.h"                     // CorJson
#include "corJson/corJsonCreate.h"               // corJsonCreate
#include "corJson/corJsonParse.h"                // corJsonParse
#include "corRest/CorRestVerb.h"                 // CorVerbGet, CorVerbPost
#include "corRest/corRestClient.h"               // corRestClient*
#include "corTree/corTreeLookup.h"               // corTreeLookup

#include "c3.h"



#define HTTP_TIMEOUT_MS  10000



// -----------------------------------------------------------------------------
//
// The holder: its key and its did:key
//
static EVP_PKEY*        holderKey = NULL;
static char             holderDid[128];
static pthread_mutex_t  holderLock = PTHREAD_MUTEX_INITIALIZER;



// -----------------------------------------------------------------------------
//
// b64url - base64url without padding, into out (room for len * 4 / 3 + 4)
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
// base58btc - the Bitcoin alphabet, into out (room for len * 138 / 100 + 2)
//
static void base58btc(const unsigned char* in, int len, char* out)
{
  static const char alphabet[] = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  unsigned char     digits[128];
  int               n     = 0;
  int               zeros = 0;

  while ((zeros < len) && (in[zeros] == 0))
    ++zeros;

  for (int ix = zeros; ix < len; ix++)
  {
    int carry = in[ix];

    for (int j = 0; j < n; j++)
    {
      carry    += digits[j] << 8;
      digits[j] = carry % 58;
      carry    /= 58;
    }

    while (carry > 0)
    {
      digits[n++] = carry % 58;
      carry      /= 58;
    }
  }

  int o = 0;
  for (int ix = 0; ix < zeros; ix++)
    out[o++] = '1';
  for (int ix = n - 1; ix >= 0; ix--)
    out[o++] = alphabet[digits[ix]];
  out[o] = 0;
}



// -----------------------------------------------------------------------------
//
// holderEnsure - the holder key and its did:key, made at the first use: did:key:z + base58btc(0x80 0x24 -
// the multicodec p256-pub, varint - and the compressed point)
//
static bool holderEnsure(char* errBuf, int errLen)
{
  pthread_mutex_lock(&holderLock);

  if (holderKey != NULL)
  {
    pthread_mutex_unlock(&holderLock);
    return true;
  }

  EVP_PKEY* keyP = EVP_PKEY_Q_keygen(NULL, NULL, "EC", "P-256");
  unsigned char point[33];
  size_t        plen = 0;

  if ((keyP == NULL) ||
      (EVP_PKEY_set_utf8_string_param(keyP, OSSL_PKEY_PARAM_EC_POINT_CONVERSION_FORMAT, OSSL_PKEY_EC_POINT_CONVERSION_FORMAT_COMPRESSED) != 1) ||
      (EVP_PKEY_get_octet_string_param(keyP, OSSL_PKEY_PARAM_PUB_KEY, point, sizeof(point), &plen) != 1) || (plen != 33))
  {
    EVP_PKEY_free(keyP);
    pthread_mutex_unlock(&holderLock);
    snprintf(errBuf, errLen, "no holder key: OpenSSL could not make a P-256 key");
    return false;
  }

  unsigned char mc[35] = { 0x80, 0x24 };
  char          b58[64];

  memcpy(&mc[2], point, 33);
  base58btc(mc, sizeof(mc), b58);
  snprintf(holderDid, sizeof(holderDid), "did:key:z%s", b58);
  holderKey = keyP;

  pthread_mutex_unlock(&holderLock);
  return true;
}



// -----------------------------------------------------------------------------
//
// vcHolderDid - the holder's did:key ("" before the first use)
//
const char* vcHolderDid(void)
{
  return holderDid;
}



// -----------------------------------------------------------------------------
//
// es256 - the JWS signature of 'input' (RFC 7518 § 3.4: the raw r|s, 64 bytes), base64url into out
//
static bool es256(const char* input, char* out)
{
  EVP_MD_CTX*    ctxP   = EVP_MD_CTX_new();
  unsigned char  der[80];
  size_t         derLen = sizeof(der);
  bool           ok     = false;

  if ((ctxP != NULL) && (EVP_DigestSignInit(ctxP, NULL, EVP_sha256(), NULL, holderKey) == 1) &&
      (EVP_DigestSign(ctxP, der, &derLen, (const unsigned char*) input, strlen(input)) == 1))
  {
    const unsigned char* p   = der;
    ECDSA_SIG*           sig = d2i_ECDSA_SIG(NULL, &p, derLen);

    if (sig != NULL)
    {
      unsigned char raw[64];
      const BIGNUM* r;
      const BIGNUM* s;

      ECDSA_SIG_get0(sig, &r, &s);
      if ((BN_bn2binpad(r, raw, 32) == 32) && (BN_bn2binpad(s, &raw[32], 32) == 32))
      {
        b64url(raw, 64, out);
        ok = true;
      }
      ECDSA_SIG_free(sig);
    }
  }

  EVP_MD_CTX_free(ctxP);
  return ok;
}



// -----------------------------------------------------------------------------
//
// http - a request, its JSON answer parsed in allocP; NULL: none - errBuf why. bearer: an Authorization, or
// NULL; form / json: the body (one or none)
//
static CorNode* http(CorRestVerb verb, const char* url, const char* bearer, const char* form, const char* json, CorAlloc* allocP, int* statusP, char* errBuf, int errLen)
{
  CorRestClientRequest  req;
  CorRestClientResponse resp;
  char                  auth[16 * 1024 + 16];

  memset(&resp, 0, sizeof(resp));
  corRestClientRequestInit(&req, verb, url, allocP);
  corRestClientRequestHeader(&req, "Accept", "application/json");

  if (bearer != NULL)
  {
    snprintf(auth, sizeof(auth), "Bearer %s", bearer);
    corRestClientRequestHeader(&req, "Authorization", auth);
  }

  if (form != NULL)
  {
    corRestClientRequestHeader(&req, "Content-Type", "application/x-www-form-urlencoded");
    corRestClientRequestBody(&req, form, strlen(form));
  }
  else if (json != NULL)
  {
    corRestClientRequestHeader(&req, "Content-Type", "application/json");
    corRestClientRequestBody(&req, json, strlen(json));
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

    CorJson cj;
    corJsonCreate(&cj, allocP);
    treeP = corJsonParse(&cj, text);

    if ((treeP == NULL) || (treeP->type != CorObject))
    {
      snprintf(errBuf, errLen, "%s: %d, not a JSON object", url, resp.statusCode);
      treeP = NULL;
    }
    else if ((resp.statusCode < 200) || (resp.statusCode > 299))
    {
      CorNode* dP = corTreeLookup(treeP, "error_description");
      CorNode* eP = corTreeLookup(treeP, "error");
      snprintf(errBuf, errLen, "%s: %d%s%s", url, resp.statusCode,
               ((dP != NULL) && (dP->type == CorString)) ? " - " : ((eP != NULL) && (eP->type == CorString)) ? " - " : "",
               ((dP != NULL) && (dP->type == CorString)) ? dP->value.s : ((eP != NULL) && (eP->type == CorString)) ? eP->value.s : "");
    }
  }

  corRestClientResponseCleanup(&resp);
  corRestClientRequestCleanup(&req);
  return treeP;
}

static const char* str(CorNode* objectP, const char* name)
{
  CorNode* nP = (objectP != NULL) ? corTreeLookup(objectP, name) : NULL;
  return ((nP != NULL) && (nP->type == CorString)) ? nP->value.s : NULL;
}

static void formAdd(Str* sP, const char* name, const char* value)
{
  if (sP->len > 0)
    strAdd(sP, "&");
  strAdd(sP, name);
  strAdd(sP, "=");

  for (const unsigned char* c = (const unsigned char*) value; *c != 0; c++)
  {
    if (((*c >= 'A') && (*c <= 'Z')) || ((*c >= 'a') && (*c <= 'z')) || ((*c >= '0') && (*c <= '9')) || (*c == '-') || (*c == '.') || (*c == '_') || (*c == '~'))
      strAddN(sP, (const char*) c, 1);
    else
      strAddf(sP, "%%%02X", *c);
  }
}



// -----------------------------------------------------------------------------
//
// vcObtain - the credential (a JWT, malloc'ed) of 'type', issued by the Keycloak realm 'issuer' to the user
// whose access token 'access' is; NULL: errBuf says why
//
char* vcObtain(const char* issuer, const char* access, const char* type, char* errBuf, int errLen)
{
  CorAlloc alloc;
  char     buf[16384];
  char     url[2048];
  int      status = 0;
  char*    vc     = NULL;
  Str      s      = { NULL, 0, 0 };

  corAllocBufferInit(&alloc, buf, sizeof(buf), 4 * 1024 * 1024, NULL, "c3 vc");

  //
  // 1. An offer of the credential, for the user (Keycloak's own endpoint - OID4VCI leaves how a wallet asks
  //    for an offer to the issuer)
  //
  strAdd(&s, issuer);
  strAdd(&s, "/protocol/oid4vc/create-credential-offer?pre_authorized=true&credential_configuration_id=");
  Str enc = { NULL, 0, 0 };
  formAdd(&enc, "x", type);
  strAdd(&s, &enc.s[2]);
  strFree(&enc);

  CorNode*    offerRefP = http(CorVerbGet, s.s, access, NULL, NULL, &alloc, &status, errBuf, errLen);
  const char* offerIss  = str(offerRefP, "issuer");
  const char* nonce     = str(offerRefP, "nonce");
  strFree(&s);

  if ((offerRefP == NULL) || (status != 200) || (offerIss == NULL) || (nonce == NULL))
  {
    if ((offerRefP != NULL) && (status == 200))
      snprintf(errBuf, errLen, "Keycloak's credential offer has no issuer and nonce");
    goto done;
  }

  //
  // 2. The offer, its pre-authorized code
  //
  snprintf(url, sizeof(url), "%s/%s", offerIss, nonce);

  CorNode* offerP  = http(CorVerbGet, url, access, NULL, NULL, &alloc, &status, errBuf, errLen);
  CorNode* grantsP = (offerP != NULL) ? corTreeLookup(offerP, "grants") : NULL;
  CorNode* preP    = (grantsP != NULL) ? corTreeLookup(grantsP, "urn:ietf:params:oauth:grant-type:pre-authorized_code") : NULL;
  const char* code = str(preP, "pre-authorized_code");

  if ((offerP == NULL) || (status != 200) || (code == NULL))
  {
    if ((offerP != NULL) && (status == 200))
      snprintf(errBuf, errLen, "the credential offer has no pre-authorized code");
    goto done;
  }

  //
  // 3. The code exchanged for a credential access token (and, with Keycloak 26.7, the credential's identifier)
  //
  snprintf(url, sizeof(url), "%s/protocol/openid-connect/token", issuer);
  formAdd(&s, "grant_type", "urn:ietf:params:oauth:grant-type:pre-authorized_code");
  formAdd(&s, "pre-authorized_code", code);

  CorNode*    tokP    = http(CorVerbPost, url, NULL, s.s, NULL, &alloc, &status, errBuf, errLen);
  const char* cAccess = str(tokP, "access_token");
  strFree(&s);

  if ((tokP == NULL) || (status != 200) || (cAccess == NULL))
  {
    if ((tokP != NULL) && (status == 200))
      snprintf(errBuf, errLen, "no credential access token for the pre-authorized code");
    goto done;
  }

  const char* identifier = NULL;
  CorNode*    detailsP   = corTreeLookup(tokP, "authorization_details");

  if ((detailsP != NULL) && (detailsP->type == CorArray))
  {
    for (CorNode* dP = detailsP->value.head; (dP != NULL) && (identifier == NULL); dP = dP->next)
    {
      CorNode* idsP = corTreeLookup(dP, "credential_identifiers");
      if ((idsP != NULL) && (idsP->type == CorArray) && (idsP->value.head != NULL) && (idsP->value.head->type == CorString))
        identifier = idsP->value.head->value.s;
    }
  }

  //
  // 4. The credential
  //
  snprintf(url, sizeof(url), "%s/protocol/oid4vc/credential", issuer);
  strAdd(&s, (identifier != NULL) ? "{\"credential_identifier\": " : "{\"credential_configuration_id\": ");
  strAddJson(&s, (identifier != NULL) ? identifier : type);
  strAdd(&s, "}");

  CorNode* credP  = http(CorVerbPost, url, cAccess, NULL, s.s, &alloc, &status, errBuf, errLen);
  CorNode* listP  = (credP != NULL) ? corTreeLookup(credP, "credentials") : NULL;
  CorNode* firstP = ((listP != NULL) && (listP->type == CorArray)) ? listP->value.head : NULL;
  const char* jwt = str(firstP, "credential");
  strFree(&s);

  if (jwt == NULL)
    jwt = str(credP, "credential");               // an older answer: the credential as a member

  if ((credP == NULL) || (status != 200) || (jwt == NULL))
  {
    if ((credP != NULL) && (status == 200))
      snprintf(errBuf, errLen, "the credential endpoint's answer holds no credential");
    goto done;
  }

  vc = strdup(jwt);

 done:
  corAllocBufferReset(&alloc, false);
  return vc;
}



// -----------------------------------------------------------------------------
//
// vcPresent - the credential presented at the verifier's token endpoint: the access token (malloc'ed), its
// lifetime in *expiresInP; NULL: errBuf says why. The vp_token is the presentation's JWT, as the connector's
// get_access_token_oid4vp.sh sends it.
//
char* vcPresent(const char* tokenEndpoint, const char* vc, const char* scope, long long* expiresInP, char* errBuf, int errLen)
{
  if (holderEnsure(errBuf, errLen) == false)
    return NULL;

  //
  // The presentation, its JWT: header, payload, ES256 signature
  //
  Str p = { NULL, 0, 0 };

  strAdd(&p, "{\"iss\": ");
  strAddJson(&p, holderDid);
  strAdd(&p, ", \"sub\": ");
  strAddJson(&p, holderDid);
  strAdd(&p, ", \"vp\": {\"@context\": [\"https://www.w3.org/2018/credentials/v1\"], \"type\": [\"VerifiablePresentation\"], \"verifiableCredential\": [");
  strAddJson(&p, vc);
  strAdd(&p, "], \"holder\": ");
  strAddJson(&p, holderDid);
  strAdd(&p, "}}");

  char header[256];
  snprintf(header, sizeof(header), "{\"alg\":\"ES256\",\"typ\":\"JWT\",\"kid\":\"%s\"}", holderDid);

  char* hB64 = malloc(strlen(header) * 4 / 3 + 8);
  char* pB64 = malloc(p.len * 4 / 3 + 8);
  char* jwt  = malloc(strlen(header) * 4 / 3 + p.len * 4 / 3 + 128);
  char  sig[100];
  char* token = NULL;

  if ((hB64 == NULL) || (pB64 == NULL) || (jwt == NULL))
  {
    snprintf(errBuf, errLen, "out of memory");
    goto done;
  }

  b64url((const unsigned char*) header, strlen(header), hB64);
  b64url((const unsigned char*) p.s, p.len, pB64);
  sprintf(jwt, "%s.%s", hB64, pB64);

  pthread_mutex_lock(&holderLock);
  bool signedOk = es256(jwt, sig);
  pthread_mutex_unlock(&holderLock);

  if (signedOk == false)
  {
    snprintf(errBuf, errLen, "the presentation could not be signed");
    goto done;
  }

  strcat(jwt, ".");
  strcat(jwt, sig);

  //
  // Exchanged at the verifier
  //
  Str      form = { NULL, 0, 0 };
  CorAlloc alloc;
  char     buf[8192];
  int      status = 0;

  formAdd(&form, "grant_type", "vp_token");
  formAdd(&form, "vp_token", jwt);
  formAdd(&form, "scope", ((scope != NULL) && (scope[0] != 0)) ? scope : "default");

  corAllocBufferInit(&alloc, buf, sizeof(buf), 1024 * 1024, NULL, "c3 vp");

  CorNode*    answerP = http(CorVerbPost, tokenEndpoint, NULL, form.s, NULL, &alloc, &status, errBuf, errLen);
  const char* access  = str(answerP, "access_token");
  strFree(&form);

  if ((answerP != NULL) && (status == 200) && (access != NULL))
  {
    CorNode* eP = corTreeLookup(answerP, "expires_in");
    *expiresInP = ((eP != NULL) && (eP->type == CorInt)) ? eP->value.i : ((eP != NULL) && (eP->type == CorFloat)) ? (long long) eP->value.f : 300;
    token       = strdup(access);
  }
  else if ((answerP != NULL) && (status == 200))
    snprintf(errBuf, errLen, "the verifier's answer holds no access_token");

  corAllocBufferReset(&alloc, false);

 done:
  strFree(&p);
  free(hB64);
  free(pB64);
  free(jwt);
  return token;
}
