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

#include "corHttp/CorHttp.h"                     // CorHttpConn



// -----------------------------------------------------------------------------
//
// C3_VERSION -
//
#define C3_VERSION "0.1.0"



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
extern bool         configMapsSync(const MapsArea* disk, int n, const MapsArea* added, char* errBuf, int errLen);
extern char*        configMapsAreasText(CorAlloc* allocP);                   // "maps": {"areas": [...]}, rendered
extern bool         configCompileChoice(char* body, char* errBuf, int errLen);       // PUT /api/compile/choice
extern bool         configCompilePreset(char* body, char* errBuf, int errLen);       // PUT /api/compile/presets
extern bool         configCompilePresetDelete(char* body, char* errBuf, int errLen); // DELETE /api/compile/presets



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
extern int   wsConnect(WsConn* wP, const char* url, const char* path, int timeoutMs, int* statusP, char* errBuf, int errLen);
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
extern void  liveShutdown(void);                                 // the backend stops: every subscription deleted



// -----------------------------------------------------------------------------
//
// browser.c - open the application
//
extern void  browserOpen(const char* url, bool noBrowser);

#endif  // C3_C3_H_
