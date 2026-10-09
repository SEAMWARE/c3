//
// FILE            maps.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The map's downloaded areas - "Download this area": an extract of the Protomaps planet as one PMTiles
// file per area in c3's data directory ($XDG_DATA_HOME/c3/maps, else ~/.local/share/c3/maps), and the
// fonts the offline map labels are drawn with.
//
//   GET    /api/maps                      the data directory, the areas (from the configuration), whether
//                                         the fonts are here, the download in progress
//   POST   /api/maps/estimate             {"bbox": [w, s, e, n], "maxzoom": z}: the tiles and bytes an area
//                                         would take - read from the planet's directories, nothing guessed
//   POST   /api/maps/download             {"name", "bbox", "maxzoom"}: start the download (one at a time)
//   DELETE /api/maps/download             cancel it
//   DELETE /api/maps/areas                {"id"}: delete an area (the file and its entry)
//   GET    /api/maps/areas/<id>.pmtiles   the file, with Range (the page reads it with the pmtiles library)
//   GET    /api/maps/fonts/<fontstack>/<range>.pbf   a glyph range
//
// How an extract is made, the way `pmtiles extract` does it, in C:
//
//   1. The planet: the newest daily build listed at build-metadata.protomaps.dev/builds.json, on
//      build.protomaps.com (or --planet <url>). Read with HTTP Range requests, never downloaded whole.
//   2. Its header and root directory (the first 16 KiB), then the leaf directories that hold the tiles of
//      the area: every tile of the bounding box, zoom 0 to maxzoom, by its Hilbert TileID.
//   3. The size: the sum of the tiles' lengths (tiles shared by several TileIDs counted once) - exact,
//      before anything is downloaded.
//   4. The tiles, in the planet's order, in ranges of up to 4 MiB (neighbours less than 32 KiB apart in
//      one request), 6 requests at a time; written to <id>.pmtiles.part with the new directories, the
//      planet's metadata, and a header with the area's bounds and zooms; renamed to <id>.pmtiles when
//      complete. Cancelled or failed: the part file is deleted.
//   5. The fonts, once for all areas: the three Noto Sans font stacks the style uses, 256 glyph ranges each,
//      from protomaps.github.io/basemaps-assets.
//
// The job runs on a thread of its own; the configuration (the list of areas) is written on the HTTP loop's
// thread only - by mapsSync, called by every /api/maps request: the page polls while it downloads.
//
// The PMTiles format: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
//
#include <dirent.h>                              // opendir, readdir
#include <errno.h>                               // errno
#include <fcntl.h>                               // open
#include <inttypes.h>                            // PRId64
#include <math.h>                                // log, tan, cos, M_PI
#include <pthread.h>                             // pthread_*
#include <stdint.h>                              // uint64_t
#include <stdio.h>                               // snprintf
#include <stdlib.h>                              // malloc, free, qsort, getenv
#include <string.h>                              // strcmp, memcpy
#include <sys/stat.h>                            // stat, mkdir
#include <time.h>                                // time, gmtime_r
#include <unistd.h>                              // read, write, close, unlink

#include <zlib.h>                                // inflate, deflate

#include "corAlloc/corAlloc.h"                   // corAlloc
#include "corAlloc/corAllocStrdup.h"             // corAllocStrdup
#include "corAlloc/corAllocBufferInit.h"         // corAllocBufferInit
#include "corAlloc/corAllocBufferReset.h"        // corAllocBufferReset
#include "corJson/CorJson.h"                     // CorJson
#include "corJson/corJsonCreate.h"               // corJsonCreate
#include "corJson/corJsonParse.h"                // corJsonParse
#include "corTree/CorNode.h"                     // CorNode
#include "corTree/corTreeLookup.h"               // corTreeLookup
#include "corRest/corRestClient.h"               // corRestClient*

#include "c3.h"



// -----------------------------------------------------------------------------
//
// Where things come from, and the limits
//
#define BUILDS_URL          "https://build-metadata.protomaps.dev/builds.json"
#define BUILD_BASE          "https://build.protomaps.com/"
#define FONTS_URL           "https://protomaps.github.io/basemaps-assets/fonts/"
#define TILES_MAX           1000000              // TileIDs in one area
#define ZOOM_MAX            15                   // the planet's deepest level
#define GROUP_MAX           (4 * 1024 * 1024)    // one range request
#define GROUP_GAP           (32 * 1024)          // tiles closer than this share a request
#define PARALLEL            6                    // range requests at a time
#define TIMEOUT_MS          60000

static const char* fontStacks[] = { "Noto Sans Regular", "Noto Sans Medium", "Noto Sans Italic" };
#define FONT_STACKS  ((int) (sizeof(fontStacks) / sizeof(fontStacks[0])))



// -----------------------------------------------------------------------------
//
// Globals
//
char                   c3MapsDir[4096];          // ~/.local/share/c3/maps
char*                  c3Planet = NULL;          // --planet: a .pmtiles URL instead of the newest build

static pthread_mutex_t jobMutex = PTHREAD_MUTEX_INITIALIZER;



// -----------------------------------------------------------------------------
//
// Job - the download: one at a time; its fields under jobMutex
//
typedef enum JobState { JobIdle, JobPlanning, JobTiles, JobFonts, JobDone, JobFailed, JobCancelled } JobState;

typedef struct Job
{
  JobState  state;
  MapsArea  area;
  int64_t   bytesTotal;                          // the tiles' bytes to fetch (with the gaps of a range)
  int64_t   bytesDone;
  int       tiles;
  int       fontsDone;
  int       fontsTotal;
  bool      cancel;
  bool      recorded;                            // in the configuration (mapsSync)
  char      error[512];
} Job;

static Job job;



// -----------------------------------------------------------------------------
//
// Header - a PMTiles v3 header (127 bytes on disk)
//
typedef struct Header
{
  uint64_t  rootOff, rootLen, metaOff, metaLen, leafOff, leafLen, dataOff, dataLen;
  uint64_t  addressed, entries, contents;
  uint8_t   clustered, internalComp, tileComp, tileType, minZ, maxZ;
  int32_t   minLon, minLat, maxLon, maxLat;
  uint8_t   centerZ;
  int32_t   centerLon, centerLat;
} Header;

typedef struct Entry
{
  uint64_t  tileId;
  uint64_t  offset;
  uint32_t  length;
  uint32_t  runLength;                           // 0: a leaf directory
} Entry;

typedef struct Dir
{
  Entry*    entries;
  int       n;
} Dir;

typedef struct TileRef
{
  uint64_t  tileId;
  uint64_t  offset;                              // in the planet's tile data
  uint32_t  length;
  uint64_t  newOffset;                           // in the extract's tile data
} TileRef;

//
// Plan - an area resolved against the planet
//
typedef struct Plan
{
  char      url[1024];                           // the planet
  char      build[64];                           // its name: 20261009
  Header    h;
  TileRef*  refs;                                // sorted by TileID, the tiles that have data
  int       nRefs;
  int64_t   bytes;                               // the unique tiles' bytes
  int       contents;                            // unique tiles
  int64_t   fetchBytes;                          // what the range requests read
  char*     meta;                                // the planet's metadata, as stored (compressed)
  int       metaLen;
} Plan;



// -----------------------------------------------------------------------------
//
// le64 / le32 - little-endian reads
//
static uint64_t le64(const unsigned char* p)
{
  uint64_t v = 0;
  for (int i = 7; i >= 0; i--)
    v = (v << 8) | p[i];
  return v;
}

static int32_t le32(const unsigned char* p)
{
  return (int32_t) ((uint32_t) p[0] | ((uint32_t) p[1] << 8) | ((uint32_t) p[2] << 16) | ((uint32_t) p[3] << 24));
}

static void put64(unsigned char* p, uint64_t v) { for (int i = 0; i < 8; i++) { p[i] = v & 0xFF; v >>= 8; } }
static void put32(unsigned char* p, int32_t s)  { uint32_t v = (uint32_t) s; for (int i = 0; i < 4; i++) { p[i] = v & 0xFF; v >>= 8; } }



// -----------------------------------------------------------------------------
//
// headerParse / headerWrite -
//
static bool headerParse(const unsigned char* b, int len, Header* hP)
{
  if ((len < 127) || (memcmp(b, "PMTiles", 7) != 0) || (b[7] != 3))
    return false;

  hP->rootOff      = le64(&b[8]);
  hP->rootLen      = le64(&b[16]);
  hP->metaOff      = le64(&b[24]);
  hP->metaLen      = le64(&b[32]);
  hP->leafOff      = le64(&b[40]);
  hP->leafLen      = le64(&b[48]);
  hP->dataOff      = le64(&b[56]);
  hP->dataLen      = le64(&b[64]);
  hP->addressed    = le64(&b[72]);
  hP->entries      = le64(&b[80]);
  hP->contents     = le64(&b[88]);
  hP->clustered    = b[96];
  hP->internalComp = b[97];
  hP->tileComp     = b[98];
  hP->tileType     = b[99];
  hP->minZ         = b[100];
  hP->maxZ         = b[101];
  hP->minLon       = le32(&b[102]);
  hP->minLat       = le32(&b[106]);
  hP->maxLon       = le32(&b[110]);
  hP->maxLat       = le32(&b[114]);
  hP->centerZ      = b[118];
  hP->centerLon    = le32(&b[119]);
  hP->centerLat    = le32(&b[123]);

  return true;
}

static void headerWrite(unsigned char* b, const Header* hP)
{
  memset(b, 0, 127);
  memcpy(b, "PMTiles", 7);
  b[7] = 3;
  put64(&b[8],  hP->rootOff);
  put64(&b[16], hP->rootLen);
  put64(&b[24], hP->metaOff);
  put64(&b[32], hP->metaLen);
  put64(&b[40], hP->leafOff);
  put64(&b[48], hP->leafLen);
  put64(&b[56], hP->dataOff);
  put64(&b[64], hP->dataLen);
  put64(&b[72], hP->addressed);
  put64(&b[80], hP->entries);
  put64(&b[88], hP->contents);
  b[96]  = hP->clustered;
  b[97]  = hP->internalComp;
  b[98]  = hP->tileComp;
  b[99]  = hP->tileType;
  b[100] = hP->minZ;
  b[101] = hP->maxZ;
  put32(&b[102], hP->minLon);
  put32(&b[106], hP->minLat);
  put32(&b[110], hP->maxLon);
  put32(&b[114], hP->maxLat);
  b[118] = hP->centerZ;
  put32(&b[119], hP->centerLon);
  put32(&b[123], hP->centerLat);
}



// -----------------------------------------------------------------------------
//
// zxyToTileId - the Hilbert TileID of a tile (as the PMTiles reference implementation computes it)
//
static uint64_t zxyToTileId(int z, int64_t x, int64_t y)
{
  uint64_t acc = (((uint64_t) 1 << z) * ((uint64_t) 1 << z) - 1) / 3;
  int      a   = z - 1;
  int64_t  tx  = x;
  int64_t  ty  = y;

  for (int64_t s = (z > 0) ? ((int64_t) 1 << a) : 0; s > 0; s >>= 1)
  {
    int64_t rx = tx & s;
    int64_t ry = ty & s;

    acc += (uint64_t) ((3 * rx) ^ ry) * ((uint64_t) 1 << a);

    if (ry == 0)
    {
      int64_t t;
      if (rx != 0)
      {
        t  = s - 1 - ty;
        ty = s - 1 - tx;
        tx = t;
      }
      else
      {
        t  = ty;
        ty = tx;
        tx = t;
      }
    }
    a--;
  }

  return acc;
}



// -----------------------------------------------------------------------------
//
// lonToX / latToY - the tile column / row a longitude / latitude is in, at zoom z
//
static int64_t lonToX(double lon, int z)
{
  int64_t n = (int64_t) 1 << z;
  int64_t x = (int64_t) floor((lon + 180.0) / 360.0 * n);
  return (x < 0) ? 0 : (x >= n) ? n - 1 : x;
}

static int64_t latToY(double lat, int z)
{
  int64_t n = (int64_t) 1 << z;

  if (lat > 85.05112878)  lat = 85.05112878;
  if (lat < -85.05112878) lat = -85.05112878;

  double  r = lat * M_PI / 180.0;
  int64_t y = (int64_t) floor((1.0 - log(tan(r) + 1.0 / cos(r)) / M_PI) / 2.0 * n);
  return (y < 0) ? 0 : (y >= n) ? n - 1 : y;
}



// -----------------------------------------------------------------------------
//
// gunzip - 'in' inflated (gzip or zlib), malloc'ed; NULL on a broken stream
//
static unsigned char* gunzip(const unsigned char* in, int inLen, int* outLenP)
{
  z_stream zs;
  memset(&zs, 0, sizeof(zs));

  if (inflateInit2(&zs, 15 + 32) != Z_OK)        // 32: gzip or zlib, by the header
    return NULL;

  int            size = inLen * 4 + 1024;
  unsigned char* out  = malloc(size);
  int            rc;

  zs.next_in  = (unsigned char*) in;
  zs.avail_in = inLen;

  do
  {
    if ((int) zs.total_out == size)
    {
      size *= 2;
      unsigned char* bigger = realloc(out, size);
      if (bigger == NULL)
      {
        free(out);
        inflateEnd(&zs);
        return NULL;
      }
      out = bigger;
    }

    zs.next_out  = out + zs.total_out;
    zs.avail_out = size - zs.total_out;
    rc = inflate(&zs, Z_NO_FLUSH);
  } while (rc == Z_OK);

  if (rc != Z_STREAM_END)
  {
    free(out);
    inflateEnd(&zs);
    return NULL;
  }

  *outLenP = zs.total_out;
  inflateEnd(&zs);
  return out;
}



// -----------------------------------------------------------------------------
//
// gzipBuf - 'in' gzip-compressed, malloc'ed
//
static unsigned char* gzipBuf(const unsigned char* in, int inLen, int* outLenP)
{
  z_stream zs;
  memset(&zs, 0, sizeof(zs));

  if (deflateInit2(&zs, Z_BEST_COMPRESSION, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY) != Z_OK)
    return NULL;

  int            size = deflateBound(&zs, inLen) + 64;
  unsigned char* out  = malloc(size);

  zs.next_in   = (unsigned char*) in;
  zs.avail_in  = inLen;
  zs.next_out  = out;
  zs.avail_out = size;

  if (deflate(&zs, Z_FINISH) != Z_STREAM_END)
  {
    free(out);
    deflateEnd(&zs);
    return NULL;
  }

  *outLenP = zs.total_out;
  deflateEnd(&zs);
  return out;
}



// -----------------------------------------------------------------------------
//
// varint read / write -
//
static bool varintRead(const unsigned char** pP, const unsigned char* end, uint64_t* vP)
{
  uint64_t v     = 0;
  int      shift = 0;

  while (*pP < end)
  {
    unsigned char b = *(*pP)++;
    v |= (uint64_t) (b & 0x7F) << shift;
    if ((b & 0x80) == 0)
    {
      *vP = v;
      return true;
    }
    shift += 7;
    if (shift > 63)
      return false;
  }

  return false;
}

static int varintWrite(unsigned char* p, uint64_t v)
{
  int n = 0;

  while (v >= 0x80)
  {
    p[n++] = (v & 0x7F) | 0x80;
    v >>= 7;
  }
  p[n++] = v;

  return n;
}



// -----------------------------------------------------------------------------
//
// dirParse - a directory (already decompressed)
//
static bool dirParse(const unsigned char* b, int len, Dir* dirP)
{
  const unsigned char* p   = b;
  const unsigned char* end = b + len;
  uint64_t             n;

  dirP->entries = NULL;
  dirP->n       = 0;

  if ((varintRead(&p, end, &n) == false) || (n > 50000000))
    return false;

  Entry* e = calloc((n > 0) ? n : 1, sizeof(Entry));
  if (e == NULL)
    return false;

  uint64_t v;
  uint64_t last = 0;

  for (uint64_t i = 0; i < n; i++)
  {
    if (varintRead(&p, end, &v) == false) goto broken;
    last += v;
    e[i].tileId = last;
  }

  for (uint64_t i = 0; i < n; i++)
  {
    if (varintRead(&p, end, &v) == false) goto broken;
    e[i].runLength = v;
  }

  for (uint64_t i = 0; i < n; i++)
  {
    if (varintRead(&p, end, &v) == false) goto broken;
    e[i].length = v;
  }

  for (uint64_t i = 0; i < n; i++)
  {
    if (varintRead(&p, end, &v) == false) goto broken;
    if ((v == 0) && (i > 0))
      e[i].offset = e[i - 1].offset + e[i - 1].length;
    else
      e[i].offset = v - 1;
  }

  dirP->entries = e;
  dirP->n       = n;
  return true;

 broken:
  free(e);
  return false;
}



// -----------------------------------------------------------------------------
//
// dirSerialize - entries as a directory, uncompressed, malloc'ed
//
static unsigned char* dirSerialize(const Entry* e, int n, int* lenP)
{
  unsigned char* b = malloc((size_t) n * 4 * 10 + 16);
  int            o = 0;

  if (b == NULL)
    return NULL;

  o += varintWrite(&b[o], n);

  uint64_t last = 0;
  for (int i = 0; i < n; i++)
  {
    o += varintWrite(&b[o], e[i].tileId - last);
    last = e[i].tileId;
  }

  for (int i = 0; i < n; i++)
    o += varintWrite(&b[o], e[i].runLength);

  for (int i = 0; i < n; i++)
    o += varintWrite(&b[o], e[i].length);

  for (int i = 0; i < n; i++)
  {
    if ((i > 0) && (e[i].offset == e[i - 1].offset + e[i - 1].length))
      o += varintWrite(&b[o], 0);
    else
      o += varintWrite(&b[o], e[i].offset + 1);
  }

  *lenP = o;
  return b;
}



// -----------------------------------------------------------------------------
//
// dirFind - the entry for tileId: a tile (runLength > 0) or the leaf directory that holds it; NULL if none
//
static const Entry* dirFind(const Dir* dirP, uint64_t tileId)
{
  int lo = 0;
  int hi = dirP->n - 1;
  int at = -1;

  while (lo <= hi)                               // the last entry with tileId <= the one asked for
  {
    int mid = (lo + hi) / 2;
    if (dirP->entries[mid].tileId <= tileId)
    {
      at = mid;
      lo = mid + 1;
    }
    else
      hi = mid - 1;
  }

  if (at == -1)
    return NULL;

  const Entry* e = &dirP->entries[at];
  if (e->runLength == 0)
    return e;
  if (tileId < e->tileId + e->runLength)
    return e;

  return NULL;
}



// -----------------------------------------------------------------------------
//
// Fetch - HTTP GETs, several at a time, with the multi engine
//
typedef struct Fetch
{
  char      url[1024];
  char      range[64];                           // "bytes=a-b", or empty
  int64_t   expect;                              // the bytes a range must give, -1: any
  char*     body;                                // malloc'ed
  int       len;
  int       status;
  char      error[256];
} Fetch;

static void fetchMany(Fetch* fV, int n)
{
  CorRestClientMulti* multiP = corRestClientMultiCreate(n);

  if (multiP == NULL)
  {
    for (int i = 0; i < n; i++)
      snprintf(fV[i].error, sizeof(fV[i].error), "out of memory");
    return;
  }

  corRestClientMultiMaxResponse(multiP, GROUP_MAX + 1024 * 1024);

  CorRestKeyValue headers[64];                   // the engine keeps pointers to them until it is done
  int             added[64];

  for (int i = 0; i < n; i++)
  {
    fV[i].body     = NULL;
    fV[i].len      = 0;
    fV[i].status   = 0;
    fV[i].error[0] = 0;

    headers[i].key   = (char*) "Range";
    headers[i].value = fV[i].range;

    added[i] = corRestClientMultiAdd(multiP, CorVerbGet, fV[i].url, (fV[i].range[0] != 0) ? &headers[i] : NULL,
                                     (fV[i].range[0] != 0) ? 1 : 0, NULL, 0, NULL, NULL);
  }

  corRestClientMultiPerform(multiP, TIMEOUT_MS);
  for (int i = 0; i < n; i++)
  {
    CorRestClientResponse* rP = (added[i] >= 0) ? corRestClientMultiResponse(multiP, added[i]) : NULL;

    if ((rP == NULL) || (rP->error != CORR_OK) || (rP->statusCode == 0))
    {
      snprintf(fV[i].error, sizeof(fV[i].error), "%s: %s", fV[i].url,
               (rP == NULL) ? "not sent" : (rP->errorDetail[0] != 0) ? rP->errorDetail : (rP->error == CORR_OK) ? "no answer in time" : "failed");
      continue;
    }

    fV[i].status = rP->statusCode;

    if ((rP->statusCode != 200) && (rP->statusCode != 206))
    {
      snprintf(fV[i].error, sizeof(fV[i].error), "%s: HTTP %d", fV[i].url, rP->statusCode);
      continue;
    }

    if ((fV[i].range[0] != 0) && (rP->statusCode != 206))
    {
      snprintf(fV[i].error, sizeof(fV[i].error), "%s: the server ignored the Range request (HTTP %d)", fV[i].url, rP->statusCode);
      continue;
    }

    if ((fV[i].expect >= 0) && (rP->bodyLen != fV[i].expect))
    {
      snprintf(fV[i].error, sizeof(fV[i].error), "%s: %d bytes, %" PRId64 " expected", fV[i].url, rP->bodyLen, fV[i].expect);
      continue;
    }

    fV[i].body = malloc(rP->bodyLen + 1);
    if (fV[i].body == NULL)
    {
      snprintf(fV[i].error, sizeof(fV[i].error), "out of memory");
      continue;
    }

    memcpy(fV[i].body, rP->body, rP->bodyLen);
    fV[i].body[rP->bodyLen] = 0;
    fV[i].len = rP->bodyLen;
  }

  corRestClientMultiDestroy(multiP);
}

//
// fetchRange - one range, retried twice; false with 'err' set
//
static bool fetchRange(const char* url, uint64_t off, uint64_t len, Fetch* fP, char* err, int errLen)
{
  for (int attempt = 0; attempt < 3; attempt++)
  {
    snprintf(fP->url, sizeof(fP->url), "%s", url);
    snprintf(fP->range, sizeof(fP->range), "bytes=%" PRIu64 "-%" PRIu64, off, off + len - 1);
    fP->expect = len;
    fetchMany(fP, 1);
    if (fP->body != NULL)
      return true;
  }

  snprintf(err, errLen, "%s", fP->error);
  return false;
}



// -----------------------------------------------------------------------------
//
// planetResolve - the planet's URL: --planet, else the newest build of builds.json (asked again after an hour)
//
static pthread_mutex_t planetMutex = PTHREAD_MUTEX_INITIALIZER;
static char            planetUrl[1024];
static char            planetBuild[64];
static time_t          planetAt = 0;

static bool planetResolve(char* url, int urlLen, char* build, int buildLen, char* err, int errLen)
{
  if ((c3Planet != NULL) && (c3Planet[0] != 0))
  {
    snprintf(url, urlLen, "%s", c3Planet);
    const char* slash = strrchr(c3Planet, '/');
    snprintf(build, buildLen, "%s", (slash != NULL) ? slash + 1 : c3Planet);
    char* dot = strstr(build, ".pmtiles");
    if (dot != NULL)
      *dot = 0;
    return true;
  }

  pthread_mutex_lock(&planetMutex);
  if ((planetAt != 0) && (time(NULL) - planetAt < 3600))
  {
    snprintf(url, urlLen, "%s", planetUrl);
    snprintf(build, buildLen, "%s", planetBuild);
    pthread_mutex_unlock(&planetMutex);
    return true;
  }
  pthread_mutex_unlock(&planetMutex);

  Fetch f;
  memset(&f, 0, sizeof(f));
  snprintf(f.url, sizeof(f.url), "%s", BUILDS_URL);
  f.expect = -1;
  fetchMany(&f, 1);

  if (f.body == NULL)
  {
    snprintf(err, errLen, "the list of planet builds could not be read - %s", f.error);
    return false;
  }

  //
  // [{"key": "20261009.pmtiles", ...}, ...] - the newest key
  //
  CorAlloc alloc;
  char     allocBuf[8192];
  CorJson  json;
  char     newest[64] = { 0 };

  corAllocBufferInit(&alloc, allocBuf, sizeof(allocBuf), 256 * 1024, NULL, "c3 builds");
  corJsonCreate(&json, &alloc);

  CorNode* listP = corJsonParse(&json, f.body);
  if ((listP != NULL) && (listP->type == CorArray))
  {
    for (CorNode* bP = listP->value.head; bP != NULL; bP = bP->next)
    {
      CorNode* keyP = (bP->type == CorObject) ? corTreeLookup(bP, "key") : NULL;
      if ((keyP == NULL) || (keyP->type != CorString) || (strlen(keyP->value.s) >= sizeof(newest)))
        continue;
      if (strstr(keyP->value.s, ".pmtiles") == NULL)
        continue;
      if (strcmp(keyP->value.s, newest) > 0)
        snprintf(newest, sizeof(newest), "%s", keyP->value.s);
    }
  }

  corAllocBufferReset(&alloc, false);
  free(f.body);

  if (newest[0] == 0)
  {
    snprintf(err, errLen, "the list of planet builds (%s) names no build", BUILDS_URL);
    return false;
  }

  snprintf(url, urlLen, "%s%s", BUILD_BASE, newest);
  snprintf(build, buildLen, "%s", newest);
  char* dot = strstr(build, ".pmtiles");
  if (dot != NULL)
    *dot = 0;

  pthread_mutex_lock(&planetMutex);
  snprintf(planetUrl, sizeof(planetUrl), "%s", url);
  snprintf(planetBuild, sizeof(planetBuild), "%s", build);
  planetAt = time(NULL);
  pthread_mutex_unlock(&planetMutex);

  return true;
}



// -----------------------------------------------------------------------------
//
// dirRead - a directory of the planet: fetched, decompressed, parsed
//
static bool dirRead(const char* url, const Header* hP, uint64_t off, uint64_t len, Dir* dirP, char* err, int errLen)
{
  Fetch f;
  memset(&f, 0, sizeof(f));

  if (fetchRange(url, off, len, &f, err, errLen) == false)
    return false;

  unsigned char* raw    = (unsigned char*) f.body;
  int            rawLen = f.len;
  unsigned char* plain  = raw;
  int            plainLen = rawLen;

  if (hP->internalComp == 2)
  {
    plain = gunzip(raw, rawLen, &plainLen);
    free(raw);
    if (plain == NULL)
    {
      snprintf(err, errLen, "a directory of the planet could not be decompressed");
      return false;
    }
  }
  else if (hP->internalComp != 1)
  {
    free(raw);
    snprintf(err, errLen, "the planet's directories are compressed with a method c3 does not read (%d)", hP->internalComp);
    return false;
  }

  bool ok = dirParse(plain, plainLen, dirP);
  free(plain);

  if (!ok)
    snprintf(err, errLen, "a directory of the planet could not be read");
  return ok;
}



// -----------------------------------------------------------------------------
//
// Leaf - a leaf directory of the planet, by its place in the leaf section
//
typedef struct Leaf
{
  uint64_t  offset;
  uint32_t  length;
  Dir       dir;
  bool      read;
} Leaf;

static int u64cmp(const void* a, const void* b)
{
  uint64_t x = *(const uint64_t*) a;
  uint64_t y = *(const uint64_t*) b;
  return (x < y) ? -1 : (x > y) ? 1 : 0;
}

static int leafCmp(const void* a, const void* b)
{
  const Leaf* x = (const Leaf*) a;
  const Leaf* y = (const Leaf*) b;
  return (x->offset < y->offset) ? -1 : (x->offset > y->offset) ? 1 : 0;
}

static int refOffsetCmp(const void* a, const void* b)
{
  const TileRef* x = *(TileRef* const*) a;
  const TileRef* y = *(TileRef* const*) b;
  return (x->offset < y->offset) ? -1 : (x->offset > y->offset) ? 1 : 0;
}

static Leaf* leafFind(Leaf* leaves, int n, uint64_t offset)
{
  int lo = 0, hi = n - 1;
  while (lo <= hi)
  {
    int mid = (lo + hi) / 2;
    if (leaves[mid].offset == offset) return &leaves[mid];
    if (leaves[mid].offset < offset)  lo = mid + 1;
    else                              hi = mid - 1;
  }
  return NULL;
}



// -----------------------------------------------------------------------------
//
// tileIdsOf - every TileID of the bounding box from zoom 0 to maxzoom, sorted; the count, -1 past TILES_MAX
//
static int64_t tileCount(const double bbox[4], int maxzoom)
{
  int64_t n = 0;

  for (int z = 0; z <= maxzoom; z++)
  {
    int64_t x0 = lonToX(bbox[0], z), x1 = lonToX(bbox[2], z);
    int64_t y0 = latToY(bbox[3], z), y1 = latToY(bbox[1], z);
    n += (x1 - x0 + 1) * (y1 - y0 + 1);
  }

  return n;
}

static uint64_t* tileIdsOf(const double bbox[4], int maxzoom, int* nP)
{
  int64_t   n   = tileCount(bbox, maxzoom);
  uint64_t* ids = (n <= TILES_MAX) ? malloc(n * sizeof(uint64_t)) : NULL;
  int       i   = 0;

  if (ids == NULL)
    return NULL;

  for (int z = 0; z <= maxzoom; z++)
  {
    int64_t x0 = lonToX(bbox[0], z), x1 = lonToX(bbox[2], z);
    int64_t y0 = latToY(bbox[3], z), y1 = latToY(bbox[1], z);

    for (int64_t x = x0; x <= x1; x++)
      for (int64_t y = y0; y <= y1; y++)
        ids[i++] = zxyToTileId(z, x, y);
  }

  qsort(ids, i, sizeof(uint64_t), u64cmp);
  *nP = i;
  return ids;
}



// -----------------------------------------------------------------------------
//
// planFree -
//
static void planFree(Plan* pP)
{
  free(pP->refs);
  free(pP->meta);
  pP->refs = NULL;
  pP->meta = NULL;
}



// -----------------------------------------------------------------------------
//
// planMake - an area resolved against the planet: which tiles, where, how many bytes
//
// 'withMeta' also reads the planet's metadata (for the download).
//
static bool planMake(const double bbox[4], int maxzoom, bool withMeta, Plan* pP, char* err, int errLen)
{
  memset(pP, 0, sizeof(*pP));

  if (tileCount(bbox, maxzoom) > TILES_MAX)
  {
    snprintf(err, errLen, "more than %d tiles: a smaller area, or a lower level of detail", TILES_MAX);
    return false;
  }

  if (planetResolve(pP->url, sizeof(pP->url), pP->build, sizeof(pP->build), err, errLen) == false)
    return false;

  //
  // The header and the root directory: the first 16 KiB
  //
  Fetch f;
  memset(&f, 0, sizeof(f));
  if (fetchRange(pP->url, 0, 16384, &f, err, errLen) == false)
    return false;

  if (headerParse((unsigned char*) f.body, f.len, &pP->h) == false)
  {
    free(f.body);
    snprintf(err, errLen, "%s is not a PMTiles v3 archive", pP->url);
    return false;
  }

  Header* hP = &pP->h;
  if (hP->tileType != 1)
  {
    free(f.body);
    snprintf(err, errLen, "%s does not hold vector tiles", pP->url);
    return false;
  }

  Dir root;
  if ((hP->rootOff + hP->rootLen <= (uint64_t) f.len))
  {
    unsigned char* plain    = (unsigned char*) f.body + hP->rootOff;
    int            plainLen = hP->rootLen;
    unsigned char* inflated = NULL;

    if (hP->internalComp == 2)
    {
      inflated = gunzip(plain, plainLen, &plainLen);
      plain    = inflated;
    }

    bool ok = (plain != NULL) && dirParse(plain, plainLen, &root);
    free(inflated);
    free(f.body);
    if (!ok)
    {
      snprintf(err, errLen, "the planet's root directory could not be read");
      return false;
    }
  }
  else
  {
    free(f.body);
    if (dirRead(pP->url, hP, hP->rootOff, hP->rootLen, &root, err, errLen) == false)
      return false;
  }

  if (maxzoom > hP->maxZ)
    maxzoom = hP->maxZ;

  int       nIds = 0;
  uint64_t* ids  = tileIdsOf(bbox, maxzoom, &nIds);

  if (ids == NULL)
  {
    free(root.entries);
    snprintf(err, errLen, "out of memory");
    return false;
  }

  //
  // Every TileID to its entry - through the leaf directories, read as needed (a leaf may point to another
  // leaf: up to four levels)
  //
  const Entry** where  = calloc(nIds, sizeof(Entry*));
  Leaf*         leaves = NULL;
  int           nLeaves = 0;
  bool          ok      = (where != NULL);

  for (int i = 0; ok && (i < nIds); i++)
    where[i] = dirFind(&root, ids[i]);

  for (int depth = 0; ok && (depth < 4); depth++)
  {
    //
    // The leaves still needed, unique, by offset
    //
    int    nNeed = 0;
    Leaf*  need  = NULL;

    for (int i = 0; i < nIds; i++)
    {
      if ((where[i] == NULL) || (where[i]->runLength != 0))
        continue;
      if ((nNeed > 0) && (need[nNeed - 1].offset == where[i]->offset))
        continue;
      if (leafFind(leaves, nLeaves, where[i]->offset) != NULL)
        continue;
      Leaf* bigger = realloc(need, (nNeed + 1) * sizeof(Leaf));
      if (bigger == NULL) { ok = false; break; }
      need = bigger;
      memset(&need[nNeed], 0, sizeof(Leaf));
      need[nNeed].offset = where[i]->offset;
      need[nNeed].length = where[i]->length;
      ++nNeed;
    }

    if (nNeed == 0)
    {
      free(need);
      break;
    }

    qsort(need, nNeed, sizeof(Leaf), leafCmp);
    int u = 0;
    for (int i = 0; i < nNeed; i++)              // unique
      if ((u == 0) || (need[u - 1].offset != need[i].offset))
        need[u++] = need[i];
    nNeed = u;

    //
    // Read them, PARALLEL at a time
    //
    for (int i = 0; ok && (i < nNeed); i += PARALLEL)
    {
      int   n = (nNeed - i < PARALLEL) ? nNeed - i : PARALLEL;
      Fetch fV[PARALLEL];

      memset(fV, 0, sizeof(fV));
      for (int k = 0; k < n; k++)
      {
        snprintf(fV[k].url, sizeof(fV[k].url), "%s", pP->url);
        snprintf(fV[k].range, sizeof(fV[k].range), "bytes=%" PRIu64 "-%" PRIu64, hP->leafOff + need[i + k].offset, hP->leafOff + need[i + k].offset + need[i + k].length - 1);
        fV[k].expect = need[i + k].length;
      }
      fetchMany(fV, n);

      for (int k = 0; k < n; k++)
      {
        Fetch* fP = &fV[k];
        if (fP->body == NULL)                    // once more, alone
          ok = ok && dirRead(pP->url, hP, hP->leafOff + need[i + k].offset, need[i + k].length, &need[i + k].dir, err, errLen);
        else
        {
          unsigned char* plain    = (unsigned char*) fP->body;
          int            plainLen = fP->len;
          unsigned char* inflated = NULL;

          if (hP->internalComp == 2)
          {
            inflated = gunzip(plain, plainLen, &plainLen);
            plain    = inflated;
          }
          if ((plain == NULL) || (dirParse(plain, plainLen, &need[i + k].dir) == false))
          {
            snprintf(err, errLen, "a leaf directory of the planet could not be read");
            ok = false;
          }
          free(inflated);
          free(fP->body);
        }
        need[i + k].read = ok;
      }
    }

    if (!ok)
    {
      for (int i = 0; i < nNeed; i++)
        free(need[i].dir.entries);
      free(need);
      break;
    }

    Leaf* all = realloc(leaves, (nLeaves + nNeed) * sizeof(Leaf));
    if (all == NULL)
    {
      for (int i = 0; i < nNeed; i++)
        free(need[i].dir.entries);
      free(need);
      ok = false;
      break;
    }
    leaves = all;
    memcpy(&leaves[nLeaves], need, nNeed * sizeof(Leaf));
    nLeaves += nNeed;
    free(need);
    qsort(leaves, nLeaves, sizeof(Leaf), leafCmp);

    for (int i = 0; i < nIds; i++)
    {
      if ((where[i] == NULL) || (where[i]->runLength != 0))
        continue;
      Leaf* lP = leafFind(leaves, nLeaves, where[i]->offset);
      where[i] = (lP != NULL) ? dirFind(&lP->dir, ids[i]) : NULL;
    }
  }

  //
  // The tiles that have data
  //
  if (ok)
  {
    pP->refs = malloc((nIds > 0 ? nIds : 1) * sizeof(TileRef));
    ok = (pP->refs != NULL);
  }

  for (int i = 0; ok && (i < nIds); i++)
  {
    if ((where[i] == NULL) || (where[i]->runLength == 0))
      continue;
    TileRef* rP = &pP->refs[pP->nRefs++];
    rP->tileId    = ids[i];
    rP->offset    = where[i]->offset;
    rP->length    = where[i]->length;
    rP->newOffset = 0;
  }

  //
  // The unique tiles, in the planet's order: their new offsets, the bytes, and what the grouped range
  // requests read
  //
  if (ok && (pP->nRefs > 0))
  {
    TileRef** byOff = malloc(pP->nRefs * sizeof(TileRef*));
    ok = (byOff != NULL);
    if (ok)
    {
      for (int i = 0; i < pP->nRefs; i++)
        byOff[i] = &pP->refs[i];
      qsort(byOff, pP->nRefs, sizeof(TileRef*), refOffsetCmp);

      uint64_t next      = 0;
      uint64_t lastOff   = UINT64_MAX;
      uint64_t lastNew   = 0;
      uint64_t groupFrom = 0, groupTo = 0;
      bool     inGroup   = false;

      for (int i = 0; i < pP->nRefs; i++)
      {
        TileRef* rP = byOff[i];
        if (rP->offset == lastOff)
        {
          rP->newOffset = lastNew;
          continue;
        }
        rP->newOffset = next;
        lastOff       = rP->offset;
        lastNew       = next;
        next         += rP->length;
        pP->bytes    += rP->length;
        pP->contents += 1;

        if (inGroup && (rP->offset <= groupTo + GROUP_GAP) && (rP->offset + rP->length - groupFrom <= GROUP_MAX))
          groupTo = rP->offset + rP->length;
        else
        {
          if (inGroup)
            pP->fetchBytes += groupTo - groupFrom;
          groupFrom = rP->offset;
          groupTo   = rP->offset + rP->length;
          inGroup   = true;
        }
      }
      if (inGroup)
        pP->fetchBytes += groupTo - groupFrom;
      free(byOff);
    }
  }

  //
  // The planet's metadata, as stored
  //
  if (ok && withMeta && (hP->metaLen > 0))
  {
    Fetch m;
    memset(&m, 0, sizeof(m));
    ok = fetchRange(pP->url, hP->metaOff, hP->metaLen, &m, err, errLen);
    if (ok)
    {
      pP->meta    = m.body;
      pP->metaLen = m.len;
    }
  }

  for (int i = 0; i < nLeaves; i++)
    free(leaves[i].dir.entries);
  free(leaves);
  free(where);
  free(ids);
  free(root.entries);

  if (!ok)
  {
    if (err[0] == 0)
      snprintf(err, errLen, "out of memory");
    planFree(pP);
  }

  return ok;
}



// -----------------------------------------------------------------------------
//
// writeAll - all of 'len' bytes
//
static bool writeAll(int fd, const void* buf, size_t len)
{
  const char* p = buf;

  while (len > 0)
  {
    ssize_t n = write(fd, p, len);
    if (n < 0)
    {
      if (errno == EINTR)
        continue;
      return false;
    }
    p   += n;
    len -= n;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// jobSet - change the job under the mutex
//
#define JOB(stmt) do { pthread_mutex_lock(&jobMutex); stmt; pthread_mutex_unlock(&jobMutex); } while (0)

static bool jobCancelled(void)
{
  bool c;
  JOB(c = job.cancel);
  return c;
}



// -----------------------------------------------------------------------------
//
// directories - the extract's root directory and leaves, both gzip-compressed, malloc'ed
//
// The entries are the tiles by TileID, runs of the same tile merged. They go in the root while it fits in
// the first 16 KiB with the header; else in leaves of 4096 entries (8192, ... until the root fits).
//
static bool directories(Plan* pP, unsigned char** rootP, int* rootLenP, unsigned char** leavesP, int* leavesLenP, uint64_t* entriesP, char* err, int errLen)
{
  Entry* e = malloc((pP->nRefs > 0 ? pP->nRefs : 1) * sizeof(Entry));
  int    n = 0;

  if (e == NULL)
  {
    snprintf(err, errLen, "out of memory");
    return false;
  }

  for (int i = 0; i < pP->nRefs; i++)
  {
    TileRef* rP = &pP->refs[i];
    if ((n > 0) && (e[n - 1].tileId + e[n - 1].runLength == rP->tileId) && (e[n - 1].offset == rP->newOffset))
    {
      e[n - 1].runLength++;
      continue;
    }
    e[n].tileId    = rP->tileId;
    e[n].offset    = rP->newOffset;
    e[n].length    = rP->length;
    e[n].runLength = 1;
    ++n;
  }
  *entriesP = n;

  int            plainLen;
  unsigned char* plain = dirSerialize(e, n, &plainLen);
  unsigned char* gz    = (plain != NULL) ? gzipBuf(plain, plainLen, rootLenP) : NULL;
  free(plain);

  if (gz == NULL)
  {
    free(e);
    snprintf(err, errLen, "out of memory");
    return false;
  }

  if (*rootLenP <= 16384 - 127)
  {
    *rootP      = gz;
    *leavesP    = NULL;
    *leavesLenP = 0;
    free(e);
    return true;
  }
  free(gz);

  for (int per = 4096; ; per *= 2)
  {
    int            nLeaves  = (n + per - 1) / per;
    Entry*         rootE    = calloc(nLeaves, sizeof(Entry));
    unsigned char* leaves   = NULL;
    int            leavesLen = 0;
    bool           ok        = (rootE != NULL);

    for (int l = 0; ok && (l < nLeaves); l++)
    {
      int            from = l * per;
      int            cnt  = (n - from < per) ? n - from : per;
      int            pl, gl;
      unsigned char* p = dirSerialize(&e[from], cnt, &pl);
      unsigned char* g = (p != NULL) ? gzipBuf(p, pl, &gl) : NULL;
      free(p);

      unsigned char* bigger = (g != NULL) ? realloc(leaves, leavesLen + gl) : NULL;
      if (bigger == NULL)
      {
        free(g);
        ok = false;
        break;
      }
      leaves = bigger;
      memcpy(leaves + leavesLen, g, gl);
      free(g);

      rootE[l].tileId    = e[from].tileId;
      rootE[l].offset    = leavesLen;
      rootE[l].length    = gl;
      rootE[l].runLength = 0;
      leavesLen += gl;
    }

    if (ok)
    {
      int            rl;
      unsigned char* rp = dirSerialize(rootE, nLeaves, &rl);
      unsigned char* rg = (rp != NULL) ? gzipBuf(rp, rl, rootLenP) : NULL;
      free(rp);
      free(rootE);

      if ((rg != NULL) && (*rootLenP <= 16384 - 127))
      {
        *rootP      = rg;
        *leavesP    = leaves;
        *leavesLenP = leavesLen;
        free(e);
        return true;
      }
      free(rg);
      free(leaves);
      if (rg == NULL)
        break;
      continue;
    }

    free(rootE);
    free(leaves);
    break;
  }

  free(e);
  snprintf(err, errLen, "out of memory");
  return false;
}



// -----------------------------------------------------------------------------
//
// tilesWrite - the tiles of the plan, fetched from the planet in grouped ranges and appended to 'fd'
//
static bool tilesWrite(Plan* pP, int fd, char* err, int errLen)
{
  //
  // The unique tiles by planet offset
  //
  TileRef** u  = malloc((pP->nRefs > 0 ? pP->nRefs : 1) * sizeof(TileRef*));
  int       nU = 0;

  if (u == NULL)
  {
    snprintf(err, errLen, "out of memory");
    return false;
  }

  for (int i = 0; i < pP->nRefs; i++)
    u[i] = &pP->refs[i];
  qsort(u, pP->nRefs, sizeof(TileRef*), refOffsetCmp);
  for (int i = 0; i < pP->nRefs; i++)
    if ((nU == 0) || (u[nU - 1]->offset != u[i]->offset))
      u[nU++] = u[i];

  //
  // The groups: [first, last] indexes in u, one range request each
  //
  typedef struct Group { int first, last; uint64_t from, to; } Group;
  Group* g  = malloc((nU > 0 ? nU : 1) * sizeof(Group));
  int    nG = 0;

  for (int i = 0; (g != NULL) && (i < nU); i++)
  {
    uint64_t off = u[i]->offset, end = off + u[i]->length;
    if ((nG > 0) && (off <= g[nG - 1].to + GROUP_GAP) && (end - g[nG - 1].from <= GROUP_MAX))
    {
      g[nG - 1].last = i;
      g[nG - 1].to   = end;
    }
    else
    {
      g[nG].first = g[nG].last = i;
      g[nG].from  = off;
      g[nG].to    = end;
      ++nG;
    }
  }

  bool ok = (g != NULL);
  if (!ok)
    snprintf(err, errLen, "out of memory");

  for (int i = 0; ok && (i < nG); i += PARALLEL)
  {
    if (jobCancelled())
    {
      snprintf(err, errLen, "cancelled");
      ok = false;
      break;
    }

    int   n = (nG - i < PARALLEL) ? nG - i : PARALLEL;
    Fetch fV[PARALLEL];

    memset(fV, 0, sizeof(fV));
    for (int k = 0; k < n; k++)
    {
      Group* gP = &g[i + k];
      snprintf(fV[k].url, sizeof(fV[k].url), "%s", pP->url);
      snprintf(fV[k].range, sizeof(fV[k].range), "bytes=%" PRIu64 "-%" PRIu64, pP->h.dataOff + gP->from, pP->h.dataOff + gP->to - 1);
      fV[k].expect = gP->to - gP->from;
    }
    fetchMany(fV, n);

    for (int k = 0; k < n; k++)
    {
      Group* gP = &g[i + k];
      Fetch* fP = &fV[k];

      if (ok && (fP->body == NULL))              // once more, then give up
      {
        char e2[256] = { 0 };
        if (fetchRange(pP->url, pP->h.dataOff + gP->from, gP->to - gP->from, fP, e2, sizeof(e2)) == false)
        {
          snprintf(err, errLen, "%s", e2);
          ok = false;
        }
      }

      for (int t = gP->first; ok && (t <= gP->last); t++)
      {
        if (writeAll(fd, fP->body + (u[t]->offset - gP->from), u[t]->length) == false)
        {
          snprintf(err, errLen, "writing the map file: %s", strerror(errno));
          ok = false;
        }
      }

      free(fP->body);
      fP->body = NULL;
      if (ok)
        JOB(job.bytesDone += gP->to - gP->from);
    }
  }

  free(g);
  free(u);
  return ok;
}



// -----------------------------------------------------------------------------
//
// fontsPresent - the glyphs of every font stack are here
//
static bool fontsPresent(void)
{
  char        path[4300];
  struct stat st;

  snprintf(path, sizeof(path), "%s/fonts/complete", c3MapsDir);
  return stat(path, &st) == 0;
}



// -----------------------------------------------------------------------------
//
// mkdirs - mkdir -p, mode 700
//
static void mkdirsAll(const char* dir)
{
  char d[4300];

  snprintf(d, sizeof(d), "%s", dir);
  for (char* p = d + 1; *p != 0; ++p)
  {
    if (*p == '/')
    {
      *p = 0;
      mkdir(d, 0700);
      *p = '/';
    }
  }
  mkdir(d, 0700);
}



// -----------------------------------------------------------------------------
//
// fontsDownload - 256 glyph ranges per font stack, into <maps>/fonts/<stack>/<range>.pbf
//
static bool fontsDownload(char* err, int errLen)
{
  int total = FONT_STACKS * 256;

  JOB(job.fontsTotal = total; job.fontsDone = 0);

  for (int s = 0; s < FONT_STACKS; s++)
  {
    char dir[4300];
    snprintf(dir, sizeof(dir), "%s/fonts/%s", c3MapsDir, fontStacks[s]);
    mkdirsAll(dir);
  }

  for (int i = 0; i < total; i += 16)
  {
    if (jobCancelled())
    {
      snprintf(err, errLen, "cancelled");
      return false;
    }

    int   n = (total - i < 16) ? total - i : 16;
    Fetch fV[16];

    memset(fV, 0, sizeof(fV));
    for (int k = 0; k < n; k++)
    {
      int  s     = (i + k) / 256;
      int  r     = (i + k) % 256;
      char stack[64];
      int  o = 0;

      for (const char* c = fontStacks[s]; *c != 0; ++c)    // the space as %20
        o += (*c == ' ') ? snprintf(&stack[o], sizeof(stack) - o, "%%20") : snprintf(&stack[o], sizeof(stack) - o, "%c", *c);

      snprintf(fV[k].url, sizeof(fV[k].url), "%s%s/%d-%d.pbf", FONTS_URL, stack, r * 256, r * 256 + 255);
      fV[k].expect = -1;
    }
    fetchMany(fV, n);

    for (int k = 0; k < n; k++)
    {
      int  s = (i + k) / 256;
      int  r = (i + k) % 256;
      char path[4400], tmp[4410];

      for (int attempt = 0; (fV[k].body == NULL) && (attempt < 2); attempt++)   // once or twice more, alone
        fetchMany(&fV[k], 1);

      if (fV[k].body == NULL)
      {
        snprintf(err, errLen, "fonts: %s", fV[k].error);
        for (int j = k; j < n; j++)
          free(fV[j].body);
        return false;
      }

      snprintf(path, sizeof(path), "%s/fonts/%s/%d-%d.pbf", c3MapsDir, fontStacks[s], r * 256, r * 256 + 255);
      snprintf(tmp, sizeof(tmp), "%s.tmp", path);

      int  fd = open(tmp, O_WRONLY | O_CREAT | O_TRUNC, 0600);
      bool ok = (fd != -1) && writeAll(fd, fV[k].body, fV[k].len);
      if (fd != -1)
        close(fd);
      ok = ok && (rename(tmp, path) == 0);
      free(fV[k].body);

      if (!ok)
      {
        snprintf(err, errLen, "fonts: %s: %s", path, strerror(errno));
        for (int j = k + 1; j < n; j++)
          free(fV[j].body);
        return false;
      }
    }

    JOB(job.fontsDone = i + n);
  }

  char marker[4300];
  snprintf(marker, sizeof(marker), "%s/fonts/complete", c3MapsDir);
  int fd = open(marker, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd != -1)
    close(fd);

  return true;
}



// -----------------------------------------------------------------------------
//
// jobThread - the download
//
static void* jobThread(void* vP)
{
  (void) vP;

  MapsArea area;
  char     err[512] = { 0 };
  Plan     plan;
  char     part[4400], final[4400];
  int      fd = -1;
  bool     ok;

  JOB(area = job.area);
  snprintf(final, sizeof(final), "%s/%s.pmtiles", c3MapsDir, area.id);
  snprintf(part,  sizeof(part),  "%s.part", final);

  ok = planMake(area.bbox, area.maxzoom, true, &plan, err, sizeof(err));
  if (ok && (plan.nRefs == 0))
  {
    snprintf(err, sizeof(err), "the planet has no tiles in this area");
    planFree(&plan);
    ok = false;
  }

  if (ok)
  {
    JOB(job.state = JobTiles; job.bytesTotal = plan.fetchBytes; job.tiles = plan.contents;
        snprintf(job.area.build, sizeof(job.area.build), "%s", plan.build));

    unsigned char* root   = NULL;
    unsigned char* leaves = NULL;
    int            rootLen = 0, leavesLen = 0;
    uint64_t       entries = 0;

    ok = directories(&plan, &root, &rootLen, &leaves, &leavesLen, &entries, err, sizeof(err));

    if (ok)
    {
      mkdirsAll(c3MapsDir);
      fd = open(part, O_WRONLY | O_CREAT | O_TRUNC, 0600);
      if (fd == -1)
      {
        snprintf(err, sizeof(err), "%s: %s", part, strerror(errno));
        ok = false;
      }
    }

    if (ok)
    {
      Header h;
      memset(&h, 0, sizeof(h));

      int maxz = (area.maxzoom > plan.h.maxZ) ? plan.h.maxZ : area.maxzoom;

      h.rootOff      = 127;
      h.rootLen      = rootLen;
      h.metaOff      = h.rootOff + rootLen;
      h.metaLen      = plan.metaLen;
      h.leafOff      = h.metaOff + plan.metaLen;
      h.leafLen      = leavesLen;
      h.dataOff      = h.leafOff + leavesLen;
      h.dataLen      = plan.bytes;
      h.addressed    = plan.nRefs;
      h.entries      = entries;
      h.contents     = plan.contents;
      h.clustered    = 1;
      h.internalComp = plan.h.internalComp;      // the metadata is copied as stored
      h.tileComp     = plan.h.tileComp;
      h.tileType     = plan.h.tileType;
      h.minZ         = 0;
      h.maxZ         = maxz;
      h.minLon       = (int32_t) lround(area.bbox[0] * 1e7);
      h.minLat       = (int32_t) lround(area.bbox[1] * 1e7);
      h.maxLon       = (int32_t) lround(area.bbox[2] * 1e7);
      h.maxLat       = (int32_t) lround(area.bbox[3] * 1e7);
      h.centerZ      = (maxz > 12) ? 12 : maxz;
      h.centerLon    = (int32_t) lround((area.bbox[0] + area.bbox[2]) / 2 * 1e7);
      h.centerLat    = (int32_t) lround((area.bbox[1] + area.bbox[3]) / 2 * 1e7);

      if (plan.h.internalComp != 2)              // the directories are gzip: so must the metadata be
      {
        snprintf(err, sizeof(err), "the planet's internal compression (%d) is not gzip", plan.h.internalComp);
        ok = false;
      }

      unsigned char hb[127];
      headerWrite(hb, &h);

      ok = ok && writeAll(fd, hb, 127) && writeAll(fd, root, rootLen) &&
           ((plan.metaLen == 0) || writeAll(fd, plan.meta, plan.metaLen)) &&
           ((leavesLen == 0) || writeAll(fd, leaves, leavesLen));
      if (!ok && (err[0] == 0))
        snprintf(err, sizeof(err), "writing %s: %s", part, strerror(errno));

      ok = ok && tilesWrite(&plan, fd, err, sizeof(err));
      if (ok && ((fsync(fd) == -1) || (close(fd) == -1)))
      {
        snprintf(err, sizeof(err), "writing %s: %s", part, strerror(errno));
        ok = false;
      }
      else if (ok)
        fd = -1;

      area.maxzoom = maxz;
      area.bytes   = h.dataOff + h.dataLen;
    }

    free(root);
    free(leaves);
    snprintf(area.build, sizeof(area.build), "%s", plan.build);
    planFree(&plan);
  }

  if (fd != -1)
    close(fd);

  if (ok && (rename(part, final) == -1))
  {
    snprintf(err, sizeof(err), "rename %s: %s", final, strerror(errno));
    ok = false;
  }

  if (!ok)
    unlink(part);

  //
  // The fonts, once
  //
  if (ok && !fontsPresent())
  {
    JOB(job.state = JobFonts);
    char ferr[512] = { 0 };
    if (fontsDownload(ferr, sizeof(ferr)) == false)
      snprintf(err, sizeof(err), "the area is downloaded, its labels' fonts are not: %s", ferr);
  }

  bool cancelled = jobCancelled();

  pthread_mutex_lock(&jobMutex);
  if (ok)
  {
    job.area     = area;
    job.state    = JobDone;
    job.recorded = false;
    snprintf(job.error, sizeof(job.error), "%s", err);       // a fonts problem, if any
  }
  else
  {
    job.state = cancelled ? JobCancelled : JobFailed;
    snprintf(job.error, sizeof(job.error), "%s", err);
  }
  pthread_mutex_unlock(&jobMutex);

  return NULL;
}



// -----------------------------------------------------------------------------
//
// areaFromFile - an area as its file tells it (header: bounds, maxzoom; the size)
//
static bool areaFromFile(const char* id, MapsArea* aP)
{
  char path[4400];
  snprintf(path, sizeof(path), "%s/%s.pmtiles", c3MapsDir, id);

  int fd = open(path, O_RDONLY);
  if (fd == -1)
    return false;

  unsigned char b[127];
  struct stat   st;
  Header        h;
  bool          ok = (read(fd, b, 127) == 127) && headerParse(b, 127, &h) && (fstat(fd, &st) == 0);
  close(fd);

  if (!ok)
    return false;

  memset(aP, 0, sizeof(*aP));
  snprintf(aP->id, sizeof(aP->id), "%s", id);
  snprintf(aP->name, sizeof(aP->name), "%s", id);
  aP->bbox[0] = h.minLon / 1e7;
  aP->bbox[1] = h.minLat / 1e7;
  aP->bbox[2] = h.maxLon / 1e7;
  aP->bbox[3] = h.maxLat / 1e7;
  aP->maxzoom = h.maxZ;
  aP->bytes   = st.st_size;

  struct tm tm;
  gmtime_r(&st.st_mtime, &tm);
  strftime(aP->created, sizeof(aP->created), "%Y-%m-%dT%H:%M:%SZ", &tm);

  return true;
}



// -----------------------------------------------------------------------------
//
// idValid - an area id: letters, digits, '-' and '_'
//
static bool idValid(const char* id)
{
  if ((id == NULL) || (id[0] == 0) || (strlen(id) > 60))
    return false;

  for (const char* p = id; *p != 0; ++p)
  {
    if (!(((*p >= 'a') && (*p <= 'z')) || ((*p >= 'A') && (*p <= 'Z')) || ((*p >= '0') && (*p <= '9')) || (*p == '-') || (*p == '_')))
      return false;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// mapsSync - the configuration's areas made to match the directory: a finished download recorded with its
// name, a file that is gone dropped, a file with no entry added. On the loop's thread.
//
void mapsSync(void)
{
  MapsArea  added;
  bool      haveAdded = false;

  pthread_mutex_lock(&jobMutex);
  if ((job.state == JobDone) && (job.recorded == false))
  {
    added        = job.area;
    haveAdded    = true;
    job.recorded = true;
  }
  pthread_mutex_unlock(&jobMutex);

  MapsArea* disk = NULL;
  int       n    = 0;
  DIR*      dP   = opendir(c3MapsDir);

  if (dP != NULL)
  {
    struct dirent* eP;
    while ((eP = readdir(dP)) != NULL)
    {
      int len = strlen(eP->d_name);
      if ((len <= 8) || (strcmp(&eP->d_name[len - 8], ".pmtiles") != 0))
        continue;

      char id[64];
      if (len - 8 >= (int) sizeof(id))
        continue;
      memcpy(id, eP->d_name, len - 8);
      id[len - 8] = 0;
      if (!idValid(id))
        continue;

      MapsArea* bigger = realloc(disk, (n + 1) * sizeof(MapsArea));
      if (bigger == NULL)
        break;
      disk = bigger;
      if (areaFromFile(id, &disk[n]))
        ++n;
    }
    closedir(dP);
  }

  char err[512];
  if (configMapsSync(disk, n, haveAdded ? &added : NULL, err, sizeof(err)) == false)
    fprintf(stderr, "c3: the map areas were not saved: %s\n", err);

  free(disk);
}



// -----------------------------------------------------------------------------
//
// mapsInit - the data directory; the configuration matched to it
//
bool mapsInit(void)
{
  const char* xdg  = getenv("XDG_DATA_HOME");
  const char* home = getenv("HOME");

  corRestClientTlsInit();                        // the multi engine does not initialise TLS by itself

  if ((xdg != NULL) && (xdg[0] == '/'))
    snprintf(c3MapsDir, sizeof(c3MapsDir), "%s/c3/maps", xdg);
  else if ((home != NULL) && (home[0] != 0))
    snprintf(c3MapsDir, sizeof(c3MapsDir), "%s/.local/share/c3/maps", home);
  else
    return false;

  //
  // A download that was running when c3 stopped: its part file is no use
  //
  DIR* dP = opendir(c3MapsDir);
  if (dP != NULL)
  {
    struct dirent* eP;
    while ((eP = readdir(dP)) != NULL)
    {
      int len = strlen(eP->d_name);
      if ((len > 13) && (strcmp(&eP->d_name[len - 13], ".pmtiles.part") == 0))
      {
        char path[4400];
        snprintf(path, sizeof(path), "%s/%s", c3MapsDir, eP->d_name);
        unlink(path);
      }
    }
    closedir(dP);
  }

  mapsSync();
  return true;
}



// -----------------------------------------------------------------------------
//
// jsonStr - 's' as a JSON string (quoted), allocated from the connection
//
static char* jsonStr(CorHttpConn* connP, const char* s)
{
  int   len = strlen(s);
  char* out = corAlloc(&connP->alloc, len * 6 + 3);
  int   o   = 0;

  out[o++] = '"';
  for (; *s != 0; ++s)
  {
    unsigned char c = (unsigned char) *s;
    if ((c == '"') || (c == '\\'))
    {
      out[o++] = '\\';
      out[o++] = c;
    }
    else if (c < 0x20)
      o += sprintf(&out[o], "\\u%04x", c);
    else
      out[o++] = c;
  }
  out[o++] = '"';
  out[o]   = 0;

  return out;
}



// -----------------------------------------------------------------------------
//
// jobJson - the download, as JSON (null when there has been none)
//
static char* jobJson(CorHttpConn* connP)
{
  Job j;
  JOB(j = job);

  if (j.state == JobIdle)
    return (char*) "null";

  static const char* stateName[] = { "idle", "planning", "tiles", "fonts", "done", "failed", "cancelled" };
  char* name  = jsonStr(connP, j.area.name);
  char* error = jsonStr(connP, j.error);
  int   size  = strlen(name) + strlen(error) + 512;
  char* out   = corAlloc(&connP->alloc, size);

  snprintf(out, size, "{\"state\": \"%s\", \"id\": \"%s\", \"name\": %s, \"maxzoom\": %d, \"bytesTotal\": %" PRId64 ", \"bytesDone\": %" PRId64 ", "
           "\"tiles\": %d, \"fontsDone\": %d, \"fontsTotal\": %d, \"error\": %s}",
           stateName[j.state], j.area.id, name, j.area.maxzoom, j.bytesTotal, j.bytesDone, j.tiles, j.fontsDone, j.fontsTotal, error);

  return out;
}



// -----------------------------------------------------------------------------
//
// mapsStatus - GET /api/maps
//
static void mapsStatus(CorHttpConn* connP)
{
  mapsSync();

  char*       dir   = jsonStr(connP, c3MapsDir);
  const char* areas = configMapsAreasText(&connP->alloc);
  char*       jobJ  = jobJson(connP);
  char*       pl    = jsonStr(connP, (c3Planet != NULL) ? c3Planet : "");
  int         size  = strlen(dir) + strlen(areas) + strlen(jobJ) + strlen(pl) + 256;
  char*       body  = corAlloc(&connP->alloc, size);

  snprintf(body, size, "{\"dir\": %s, \"areas\": %s, \"fonts\": %s, \"fontStacks\": [\"%s\", \"%s\", \"%s\"], \"job\": %s, \"planet\": %s}",
           dir, areas, fontsPresent() ? "true" : "false", fontStacks[0], fontStacks[1], fontStacks[2], jobJ, pl);

  serveJson(connP, 200, body);
}



// -----------------------------------------------------------------------------
//
// bodyArea - {"bbox": [w, s, e, n], "maxzoom": z, "name": "..."} from a request body
//
static bool bodyArea(CorHttpConn* connP, MapsArea* aP, bool needName, char* err, int errLen)
{
  CorJson json;

  memset(aP, 0, sizeof(*aP));

  if ((connP->body.s == NULL) || (connP->body.s[0] == 0))
  {
    snprintf(err, errLen, "a JSON object is expected as the body");
    return false;
  }

  corJsonCreate(&json, &connP->alloc);
  CorNode* bodyP = corJsonParse(&json, corAllocStrdup(&connP->alloc, connP->body.s));
  if ((bodyP == NULL) || (bodyP->type != CorObject))
  {
    snprintf(err, errLen, "the body is not a JSON object");
    return false;
  }

  CorNode* bboxP = corTreeLookup(bodyP, "bbox");
  int      i     = 0;

  if ((bboxP == NULL) || (bboxP->type != CorArray))
  {
    snprintf(err, errLen, "\"bbox\" must be [west, south, east, north]");
    return false;
  }

  for (CorNode* cP = bboxP->value.head; cP != NULL; cP = cP->next)
  {
    if ((i == 4) || ((cP->type != CorFloat) && (cP->type != CorInt)))
    {
      snprintf(err, errLen, "\"bbox\" must be [west, south, east, north]: four numbers");
      return false;
    }
    aP->bbox[i++] = (cP->type == CorFloat) ? cP->value.f : (double) cP->value.i;
  }

  if ((i != 4) || (aP->bbox[0] < -180) || (aP->bbox[2] > 180) || (aP->bbox[1] < -85.06) || (aP->bbox[3] > 85.06) ||
      (aP->bbox[0] >= aP->bbox[2]) || (aP->bbox[1] >= aP->bbox[3]))
  {
    snprintf(err, errLen, "\"bbox\" must be [west, south, east, north], west < east, south < north, within the world");
    return false;
  }

  CorNode* zP = corTreeLookup(bodyP, "maxzoom");
  if ((zP == NULL) || (zP->type != CorInt) || (zP->value.i < 0) || (zP->value.i > ZOOM_MAX))
  {
    snprintf(err, errLen, "\"maxzoom\" must be an integer, 0 to %d", ZOOM_MAX);
    return false;
  }
  aP->maxzoom = zP->value.i;

  CorNode* nP = corTreeLookup(bodyP, "name");
  if (nP != NULL)
  {
    if ((nP->type != CorString) || (strlen(nP->value.s) > 200))
    {
      snprintf(err, errLen, "\"name\" must be a string of at most 200 characters");
      return false;
    }
    snprintf(aP->name, sizeof(aP->name), "%s", nP->value.s);
  }
  else if (needName)
  {
    snprintf(err, errLen, "\"name\" is missing");
    return false;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// Estimate - POST /api/maps/estimate, on a thread of its own (the planet is read)
//
typedef struct Estimate
{
  CorHttpConn*  connP;
  MapsArea      area;
} Estimate;

static void* estimateThread(void* vP)
{
  Estimate*    eP    = (Estimate*) vP;
  CorHttpConn* connP = eP->connP;
  Plan         plan;
  char         err[512] = { 0 };

  if (planMake(eP->area.bbox, eP->area.maxzoom, false, &plan, err, sizeof(err)) == false)
  {
    int64_t n = tileCount(eP->area.bbox, eP->area.maxzoom);
    char*   e = jsonStr(connP, err);
    int     size = strlen(e) + 256;
    char*   body = corAlloc(&connP->alloc, size);

    snprintf(body, size, "{\"title\": \"No estimate\", \"detail\": %s, \"tileIds\": %" PRId64 "}", e, n);
    serveJson(connP, (n > TILES_MAX) ? 422 : 502, body);
  }
  else
  {
    int   size = 2048 + strlen(plan.url);
    char* body = corAlloc(&connP->alloc, size);
    char* url  = jsonStr(connP, plan.url);

    snprintf(body, size, "{\"tileIds\": %" PRId64 ", \"tiles\": %d, \"bytes\": %" PRId64 ", \"fetchBytes\": %" PRId64 ", "
             "\"maxzoom\": %d, \"planet\": %s, \"build\": \"%s\", \"fonts\": %s}",
             tileCount(eP->area.bbox, eP->area.maxzoom), plan.contents, plan.bytes + 16384, plan.fetchBytes,
             (eP->area.maxzoom > plan.h.maxZ) ? plan.h.maxZ : eP->area.maxzoom, url, plan.build, fontsPresent() ? "true" : "false");
    serveJson(connP, 200, body);
    planFree(&plan);
  }

  free(eP);
  corHttpResume(connP);
  return NULL;
}

static void threadRun(CorHttpConn* connP, void* (*fn)(void*), void* arg)
{
  pthread_t      tid;
  pthread_attr_t attr;

  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

  if (connP != NULL)
    corHttpSuspend(connP);

  if (pthread_create(&tid, &attr, fn, arg) != 0)
  {
    free(arg);
    if (connP != NULL)
    {
      serveError(connP, 503, "Busy", "no thread for the request");
      corHttpResumeHere(connP);
    }
  }

  pthread_attr_destroy(&attr);
}

static void mapsEstimate(CorHttpConn* connP)
{
  char     err[512];
  Estimate e;

  if (bodyArea(connP, &e.area, false, err, sizeof(err)) == false)
  {
    serveError(connP, 400, "Bad request", err);
    return;
  }

  Estimate* eP = malloc(sizeof(Estimate));
  if (eP == NULL)
  {
    serveError(connP, 500, "Internal error", "out of memory");
    return;
  }

  *eP       = e;
  eP->connP = connP;
  threadRun(connP, estimateThread, eP);
}



// -----------------------------------------------------------------------------
//
// mapsDownload - POST /api/maps/download: the job started (202), or 409 while another runs
//
static void mapsDownload(CorHttpConn* connP)
{
  char     err[512];
  MapsArea a;

  if (bodyArea(connP, &a, true, err, sizeof(err)) == false)
  {
    serveError(connP, 400, "Bad request", err);
    return;
  }

  if (a.name[0] == 0)
    snprintf(a.name, sizeof(a.name), "Area");

  time_t    t = time(NULL);
  struct tm tm;
  gmtime_r(&t, &tm);
  strftime(a.id, sizeof(a.id), "area-%Y%m%d-%H%M%S", &tm);
  strftime(a.created, sizeof(a.created), "%Y-%m-%dT%H:%M:%SZ", &tm);

  pthread_mutex_lock(&jobMutex);
  if ((job.state == JobPlanning) || (job.state == JobTiles) || (job.state == JobFonts))
  {
    pthread_mutex_unlock(&jobMutex);
    serveError(connP, 409, "Conflict", "a download is running - one at a time");
    return;
  }

  memset(&job, 0, sizeof(job));
  job.area  = a;
  job.state = JobPlanning;
  pthread_mutex_unlock(&jobMutex);

  pthread_t      tid;
  pthread_attr_t attr;
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
  if (pthread_create(&tid, &attr, jobThread, NULL) != 0)
  {
    JOB(job.state = JobFailed; snprintf(job.error, sizeof(job.error), "no thread for the download"));
  }
  pthread_attr_destroy(&attr);

  serveJson(connP, 202, jobJson(connP));
}



// -----------------------------------------------------------------------------
//
// mapsCancel - DELETE /api/maps/download
//
static void mapsCancel(CorHttpConn* connP)
{
  JOB(job.cancel = true);
  serveJson(connP, 200, jobJson(connP));
}



// -----------------------------------------------------------------------------
//
// mapsAreaDelete - DELETE /api/maps/areas {"id"}
//
static void mapsAreaDelete(CorHttpConn* connP)
{
  CorJson json;
  corJsonCreate(&json, &connP->alloc);

  CorNode* bodyP = ((connP->body.s != NULL) && (connP->body.s[0] != 0)) ? corJsonParse(&json, corAllocStrdup(&connP->alloc, connP->body.s)) : NULL;
  CorNode* idP   = ((bodyP != NULL) && (bodyP->type == CorObject)) ? corTreeLookup(bodyP, "id") : NULL;

  if ((idP == NULL) || (idP->type != CorString) || !idValid(idP->value.s))
  {
    serveError(connP, 400, "Bad request", "{\"id\": \"<area id>\"} is expected");
    return;
  }

  char path[4400];
  snprintf(path, sizeof(path), "%s/%s.pmtiles", c3MapsDir, idP->value.s);
  if ((unlink(path) == -1) && (errno != ENOENT))
  {
    serveError(connP, 500, "Not deleted", strerror(errno));
    return;
  }

  mapsStatus(connP);                             // synced: the entry is gone with the file
}



// -----------------------------------------------------------------------------
//
// percentDecode - in place
//
static void percentDecode(char* s)
{
  char* o = s;

  for (char* p = s; *p != 0; ++p)
  {
    if ((p[0] == '%') && (p[1] != 0) && (p[2] != 0))
    {
      char hex[3] = { p[1], p[2], 0 };
      char* end;
      long  v = strtol(hex, &end, 16);
      if ((*end == 0) && (v > 0))
      {
        *o++ = (char) v;
        p += 2;
        continue;
      }
    }
    *o++ = *p;
  }

  *o = 0;
}



// -----------------------------------------------------------------------------
//
// mapsRequest - every /api/maps request
//
void mapsRequest(CorHttpConn* connP, const char* path)
{
  const char* method = connP->method.s;
  bool        get    = (strcmp(method, "GET") == 0) || (strcmp(method, "HEAD") == 0);

  if ((strcmp(path, "/api/maps") == 0) && get)
    mapsStatus(connP);
  else if ((strcmp(path, "/api/maps/estimate") == 0) && (strcmp(method, "POST") == 0))
    mapsEstimate(connP);
  else if ((strcmp(path, "/api/maps/download") == 0) && (strcmp(method, "POST") == 0))
    mapsDownload(connP);
  else if ((strcmp(path, "/api/maps/download") == 0) && (strcmp(method, "DELETE") == 0))
    mapsCancel(connP);
  else if ((strcmp(path, "/api/maps/download") == 0) && get)
  {
    mapsSync();
    serveJson(connP, 200, jobJson(connP));
  }
  else if ((strcmp(path, "/api/maps/areas") == 0) && (strcmp(method, "DELETE") == 0))
    mapsAreaDelete(connP);
  else if ((strncmp(path, "/api/maps/areas/", 16) == 0) && get)
  {
    char id[128];
    snprintf(id, sizeof(id), "%s", &path[16]);
    int len = strlen(id);
    if ((len <= 8) || (strcmp(&id[len - 8], ".pmtiles") != 0))
    {
      serveError(connP, 404, "Not found", path);
      return;
    }
    id[len - 8] = 0;
    if (!idValid(id))
    {
      serveError(connP, 404, "Not found", path);
      return;
    }

    char file[4400];
    snprintf(file, sizeof(file), "%s/%s.pmtiles", c3MapsDir, id);
    serveFileRange(connP, file, "application/vnd.pmtiles", 0);
  }
  else if ((strncmp(path, "/api/maps/fonts/", 16) == 0) && get)
  {
    //
    // <fontstack>/<from>-<to>.pbf - one of the font stacks c3 downloads
    //
    char rest[512];
    snprintf(rest, sizeof(rest), "%s", &path[16]);
    percentDecode(rest);

    char* slash = strchr(rest, '/');
    int   from, to;
    char  tail[8];
    bool  ok = (slash != NULL);

    if (ok)
    {
      *slash = 0;
      ok = (sscanf(slash + 1, "%d-%d.%4s", &from, &to, tail) == 3) && (strcmp(tail, "pbf") == 0) && (from % 256 == 0) && (to == from + 255) && (from >= 0) && (from < 65536);
    }

    int s = 0;
    for (; ok && (s < FONT_STACKS); s++)
      if (strcmp(rest, fontStacks[s]) == 0)
        break;

    if (!ok || (s == FONT_STACKS))
    {
      serveError(connP, 404, "Not found", path);
      return;
    }

    char file[4400];
    snprintf(file, sizeof(file), "%s/fonts/%s/%d-%d.pbf", c3MapsDir, fontStacks[s], from, to);
    serveFileRange(connP, file, "application/x-protobuf", 0);
  }
  else
    serveError(connP, 404, "Not found", path);
}
