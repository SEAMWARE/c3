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
// serve.c - the request callback: the API and the static pages
//
extern void  serveRequest(CorHttpConn* connP);
extern void  serveJson(CorHttpConn* connP, int status, const char* json);
extern void  serveError(CorHttpConn* connP, int status, const char* title, const char* detail);
extern void  serveFileRange(CorHttpConn* connP, const char* file, const char* contentType, int maxWhole);



// -----------------------------------------------------------------------------
//
// browser.c - open the application
//
extern void  browserOpen(const char* url, bool noBrowser);

#endif  // C3_C3_H_
