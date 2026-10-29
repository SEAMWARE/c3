#ifndef C3_C3_H_
#define C3_C3_H_

//
// FILE            c3.h
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// c3 - the coraine Control Center: the backend's shared declarations
//
#include <stdbool.h>                             // bool
#include <stdint.h>                              // int64_t
#include <pthread.h>                             // pthread_mutex_t
#include <sys/types.h>                           // pid_t
#include <time.h>                                // time_t

#include "corHttp/CorHttp.h"                     // CorHttpConn
#include "corRest/CorRestKeyValue.h"              // CorRestKeyValue



// -----------------------------------------------------------------------------
//
// C3_VERSION -
//
#define C3_VERSION "0.6.2"



// -----------------------------------------------------------------------------
//
// Globals - set once in main, before the server starts, read-only afterwards
//
extern unsigned short  c3Port;
extern char            c3WwwDir[4096];
extern char            c3ConfigPath[4096];
extern char            c3MapsDir[4096];          // the downloaded map areas: $XDG_DATA_HOME/c3/maps
extern char*           c3Planet;                 // --planet: the Protomaps planet to extract from (NULL: the newest build)



// -----------------------------------------------------------------------------
//
// A corHttp without streamed responses (before corHttpResponseStream): no page follows a log live - it
// reads the log file instead, by Range - and these keep the rest unchanged
//
#ifndef COR_HTTP_STREAM_PENDING_MAX
typedef struct CorHttpStream CorHttpStream;
static inline bool corHttpStreamWrite(CorHttpStream* sP, const char* data, int len) { (void) sP; (void) data; (void) len; return false; }
static inline void corHttpStreamEnd(CorHttpStream* sP)                              { (void) sP; }
#endif



// -----------------------------------------------------------------------------
//
// util.c - what Compile and Run share
//
typedef struct Str                               // a growing string, malloc'ed; { NULL, 0, 0 } is empty
{
  char*  s;
  int    len;
  int    size;
} Str;

extern void  strAddN(Str* sP, const char* s, int len);
extern void  strAdd(Str* sP, const char* s);
extern void  strAddf(Str* sP, const char* fmt, ...) __attribute__((format(printf, 2, 3)));
extern void  strAddJson(Str* sP, const char* s);   // a JSON string, quotes included; NULL: null
extern void  strFree(Str* sP);
extern void  shellQuote(Str* sP, const char* arg);

extern void  isoTime(time_t t, char* out, int outLen);
extern char* fileText(const char* path);          // a whole (small) file, malloc'ed; NULL if it cannot be read
extern bool  dirsMake(const char* dir);           // mkdir -p, mode 700
extern bool  removeAll(const char* path);         // rm -rf, not following links
extern bool  dataHome(const char* sub, char* out, int outLen);   // $XDG_DATA_HOME/c3/<sub>, else ~/.local/share/c3/<sub>

extern int   runCapture(char* const argv[], char* out, int outSize, int timeoutS);   // the exit status (waitpid's), -1: not run
extern bool  inPath(const char* name, char* out, int outLen);
extern bool  tenantValid(const char* t);          // 1-255 printable ASCII characters, no blank - an NGSILD-Tenant
extern void  groupStop(pid_t pgid);               // SIGTERM to what is left of a process group, SIGKILL 3 s later

typedef struct ProcSpawn
{
  char* const*  argv;                            // argv[0] is a path
  char* const*  envp;                            // NULL: c3's environment
  int           outFd;                           // stdout and stderr (-1: /dev/null)
  const char*   cwd;                             // NULL: c3's
  bool          group;                           // a process group of its own
  bool          session;                         // a session of its own (setsid): outlives c3
  int           deathSig;                        // sent when c3 dies (0: none)
} ProcSpawn;

extern pid_t      procSpawn(const ProcSpawn* sP);
extern long long  procStartTime(pid_t pid);      // /proc/<pid>/stat's start time; 0: no such process (or a zombie)

#define SSE_SUBS_MAX     32
#define SSE_BACKLOG_MAX  (4 * 1024 * 1024)       // the most of a log sent to a page that starts following it

typedef struct SseSubs
{
  CorHttpStream*  v[SSE_SUBS_MAX];
  int             n;
} SseSubs;

extern bool  sseSubsAdd(SseSubs* subsP, CorHttpStream* streamP);
extern void  sseSubsSend(SseSubs* subsP, const char* text, int len);
extern void  sseSubsEnd(SseSubs* subsP);
extern void  sseLines(Str* sP, const char* data, int len, int64_t endOffset);
extern void  sseFromFile(Str* sP, int fd, int64_t from, int64_t end);
extern void  respondStr(CorHttpConn* connP, int status, Str* sP);   // a JSON answer from a Str (the Str freed)



// -----------------------------------------------------------------------------
//
// MapsArea - a downloaded map area, as the configuration keeps it
//
typedef struct MapsArea
{
  char     id[64];                               // the file: <c3MapsDir>/<id>.pmtiles
  char     name[201];
  double   bbox[4];                              // west, south, east, north
  int      maxzoom;
  int64_t  bytes;
  char     created[32];
  char     build[64];                            // the planet build it was extracted from
} MapsArea;



// -----------------------------------------------------------------------------
//
// config.c - the configuration file (~/.config/c3/c3.json)
//
// The configuration is kept as its rendered text; every change parses it, changes the tree, renders
// it and writes the file (temporary file + rename) before the new text replaces the old. All of it
// runs on the HTTP loop's thread, so no lock.
//
extern bool         configPathResolve(const char* given, char* out, int outLen);
extern void         configLoad(void);
extern const char*  configText(void);           // the current configuration, rendered
extern const char*  configError(void);          // NULL, or why the file could not be read / written
extern int          configBrokers(void);        // how many brokers it holds
extern bool         configBrokerTouch(char* body, char* errBuf, int errLen);   // POST /api/brokers
extern bool         configBrokerForget(char* body, char* errBuf, int errLen);  // DELETE /api/brokers
extern bool         configUiSet(char* body, char* errBuf, int errLen);         // PUT /api/ui
extern bool         configBrokerTypes(char* body, char* errBuf, int errLen);   // PUT /api/brokers/types
extern bool         configBrokerConnect(char* body, char* errBuf, int errLen); // PUT /api/brokers/connect
extern bool         configBrokerLogin(char* body, char* errBuf, int errLen);   // PUT /api/brokers/login
extern bool         configDemo(const char* name, char* urlOut, int urlLen, char* hintOut, int hintLen);  // a demo's descriptor URL
extern bool         configMapsSync(const MapsArea* disk, int n, const MapsArea* added, char* errBuf, int errLen);
extern char*        configMapsAreasText(CorAlloc* allocP);                   // "maps": {"areas": [...]}, rendered
extern bool         configCompileChoice(char* body, char* errBuf, int errLen);       // PUT /api/compile/choice
extern bool         configCompilePreset(char* body, char* errBuf, int errLen);       // PUT /api/compile/presets
extern bool         configCompilePresetDelete(char* body, char* errBuf, int errLen); // DELETE /api/compile/presets



// -----------------------------------------------------------------------------
//
// creds.c - the access tokens and the headers sent to brokers
//
extern void   credsInit(const char* tokenFile);                           // after configPathResolve
extern char*  credsToken(const char* broker, const char** sourceP);       // malloc'ed, or NULL
extern int    credsHeaders(const char* broker, CorRestKeyValue* kv, int max);  // the broker's own + Authorization
extern void   credsHeadersFree(CorRestKeyValue* kv, int n);
extern void   credsRequest(CorHttpConn* connP, const char* path);         // /api/brokers/token(s), /headers



//
// oidc.c - logging in to a broker's OpenID provider: the access token credsToken sends
//
extern void   oidcInit(void);                                             // after proxyInit: the refresh thread
extern char*  oidcToken(const char* broker, char* userOut, int userLen);  // malloc'ed, or NULL - never waits
extern void   oidcRequest(CorHttpConn* connP, const char* path);          // /api/oidc/...



//
// vc.c - a Verifiable Credential login (the Data Space Connector): the credential, its presentation
//
extern char*        vcObtain(const char* issuer, const char* access, const char* type, char* errBuf, int errLen);
extern char*        vcPresent(const char* tokenEndpoint, const char* vc, const char* scope, long long* expiresInP, char* errBuf, int errLen);
extern char*        vcPresentation(const char* vc, char* errBuf, int errLen);   // the presentation's JWT, malloc'ed
extern const char*  vcHolderDid(void);
extern bool         configRunBrokerPut(const char* defJson, char* errBuf, int errLen);  // a broker of Run, added or replaced (by name)
extern bool         configRunBrokerDelete(const char* name, char* errBuf, int errLen);  // and forgotten



// -----------------------------------------------------------------------------
//
// proxy.c - GET /api/proxy/<path>: a request to a broker, run on a thread of its own
//
extern void  proxyInit(void);
extern void  proxyRequest(CorHttpConn* connP, const char* path);



// -----------------------------------------------------------------------------
//
// maps.c - the map's downloaded areas (/api/maps/...)
//
extern bool  mapsInit(void);
extern void  mapsSync(void);
extern void  mapsRequest(CorHttpConn* connP, const char* path);



// -----------------------------------------------------------------------------
//
// compile.c - Compile: builds of the broker by coraine-build (/api/capabilities, /api/compile/..., /api/builds...)
//
extern char* c3CoraineBuild;                     // --coraine-build: coraine-build's path (NULL: found in $PATH)
extern char* c3Source;                           // --source: the source tarball (NULL: coraine-build's default)

extern bool  compileInit(void);
extern void  compileRequest(CorHttpConn* connP, const char* path);
extern void  compileShutdown(void);



// -----------------------------------------------------------------------------
//
// run.c - Run: brokers started and stopped, natively or in a container, and the services they use
//
extern bool  runInit(void);                       // after configLoad: the brokers kept, re-attached when they still run
extern void  runRequest(CorHttpConn* connP, const char* path);
extern void  runCapabilities(Str* sP);            // "run": {...} of GET /api/capabilities
extern void  runShutdown(void);                   // c3 stops: the brokers keep running; c3's own helpers stop



// -----------------------------------------------------------------------------
//
// serve.c - the request callback: the API and the static pages
//
extern void  serveRequest(CorHttpConn* connP);
extern void  serveJson(CorHttpConn* connP, int status, const char* json);
extern void  serveError(CorHttpConn* connP, int status, const char* title, const char* detail);
extern void  serveFileRange(CorHttpConn* connP, const char* file, const char* contentType, int maxWhole);



// -----------------------------------------------------------------------------
//
// ws.c - WebSocket (RFC 6455): the client end to a broker's WebSocket transport, the server end for the page
//
typedef struct WsConn
{
  int              fd;
  bool             client;                       // a client masks its frames
  bool             closeSent;
  char             pre[8192];                    // bytes read behind the handshake, read before the socket
  int              preLen;
  int              preOff;
  pthread_mutex_t  writeLock;                    // one message at a time, from any thread
} WsConn;

extern void  wsInit(WsConn* wP, int fd, bool client, const char* extra, int extraLen);
extern void  wsRelease(WsConn* wP);
extern bool  wsAcceptKey(const char* key, char* out, int outLen);
extern int   wsConnect(WsConn* wP, const char* url, const char* path, const CorRestKeyValue* hdrs, int hdrN, int timeoutMs, int* statusP, char* errBuf, int errLen);
extern bool  wsSendText(WsConn* wP, const char* text, int len);
extern bool  wsSendClose(WsConn* wP, int code);
extern int   wsRead(WsConn* wP, char** dataP, int* lenP, int maxLen);
extern bool  urlSplit(const char* url, char* host, int hostLen, char* port, int portLen);



// -----------------------------------------------------------------------------
//
// live.c - live values: a subscription per page on the broker it shows, the notifications to the page
//
extern void  liveInit(void);                                     // before the server starts: old subscriptions swept
extern void  liveUpgrade(CorHttpConn* connP);                    // GET /api/live - the page's WebSocket
extern void  liveNotify(CorHttpConn* connP, const char* session); // POST /api/notify/<session> - a broker's notification
extern void  demoRequest(CorHttpConn* connP, const char* name);  // GET /api/demos/<name> - a named demo's descriptor
extern void  liveShutdown(void);                                 // the backend stops: every subscription deleted



// -----------------------------------------------------------------------------
//
// browser.c - open the application
//
extern bool  browserOpen(const char* url, bool noBrowser, bool control, const char* token);
extern const char* activationToken(const char* token);
extern const char* startToken(void);

// repos.c
extern void  reposRequest(CorHttpConn* connP, const char* path);

// window.c
extern void  windowPipesSet(int toFd, int fromFd);
extern void  windowRequest(CorHttpConn* connP, const char* path);

#endif  // C3_C3_H_
