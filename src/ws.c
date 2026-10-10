//
// FILE            ws.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// WebSocket (RFC 6455), both ends c3 needs: the client end, to a broker's WebSocket transport
// (GET /ngsi-ld/v1/ws), and the server end, for the page (GET /api/live, handed over by corHttpUpgrade).
//
// One thread reads a connection (blocking reads); any thread writes, one message at a time under the
// connection's write lock. Text messages only; a fragmented message is put together; a ping is answered,
// a close is answered and ends the reading.
//
#include <errno.h>                               // errno, EINTR, EINPROGRESS
#include <fcntl.h>                               // fcntl, O_NONBLOCK
#include <netdb.h>                               // getaddrinfo
#include <poll.h>                                // poll
#include <stdio.h>                               // snprintf
#include <stdlib.h>                              // malloc, realloc, free
#include <string.h>                              // memcpy, strncmp, strstr
#include <strings.h>                             // strncasecmp
#include <sys/random.h>                          // getrandom
#include <sys/socket.h>                          // send, recv, connect, setsockopt
#include <sys/time.h>                            // struct timeval
#include <unistd.h>                              // close

#include <openssl/evp.h>                         // EVP_Digest, EVP_sha1, EVP_EncodeBlock

#include "c3.h"



// -----------------------------------------------------------------------------
//
// wsInit - a connection on 'fd', whose handshake is done; 'extra' the bytes read behind it
//
void wsInit(WsConn* wP, int fd, bool client, const char* extra, int extraLen)
{
  wP->fd     = fd;
  wP->client = client;
  wP->preLen = 0;
  wP->preOff = 0;
  wP->closeSent = false;
  pthread_mutex_init(&wP->writeLock, NULL);

  if ((extra != NULL) && (extraLen > 0))
  {
    if (extraLen > (int) sizeof(wP->pre))
      extraLen = sizeof(wP->pre);
    memcpy(wP->pre, extra, extraLen);
    wP->preLen = extraLen;
  }

  //
  // Blocking, a write that cannot go on for 5 s fails (a peer that stopped reading holds no thread forever)
  //
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags != -1)
    fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);

  struct timeval tv = { 5, 0 };
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
}



// -----------------------------------------------------------------------------
//
// wsRelease - the write lock; the socket is closed by the caller
//
void wsRelease(WsConn* wP)
{
  pthread_mutex_destroy(&wP->writeLock);
}



// -----------------------------------------------------------------------------
//
// wsAcceptKey - Sec-WebSocket-Accept for a Sec-WebSocket-Key: base64(SHA-1(key + the GUID))
//
bool wsAcceptKey(const char* key, char* out, int outLen)
{
  char          in[256];
  unsigned char md[EVP_MAX_MD_SIZE];
  unsigned int  mdLen = 0;

  int n = snprintf(in, sizeof(in), "%s258EAFA5-E914-47DA-95CA-C5AB0DC85B11", key);
  if ((n <= 0) || (n >= (int) sizeof(in)) || (outLen < 32))
    return false;

  if (EVP_Digest(in, n, md, &mdLen, EVP_sha1(), NULL) != 1)
    return false;

  EVP_EncodeBlock((unsigned char*) out, md, mdLen);
  return true;
}



// -----------------------------------------------------------------------------
//
// writeAll -
//
static bool writeAll(int fd, const char* buf, int len)
{
  while (len > 0)
  {
    ssize_t n = send(fd, buf, len, MSG_NOSIGNAL);

    if (n == -1)
    {
      if (errno == EINTR)
        continue;
      return false;
    }

    buf += n;
    len -= n;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// readFull - 'len' bytes: what was read ahead first, then the socket
//
static bool readFull(WsConn* wP, char* buf, uint64_t len)
{
  while (len > 0)
  {
    if (wP->preOff < wP->preLen)
    {
      int n = wP->preLen - wP->preOff;
      if ((uint64_t) n > len)
        n = (int) len;
      memcpy(buf, &wP->pre[wP->preOff], n);
      wP->preOff += n;
      buf        += n;
      len        -= n;
      continue;
    }

    ssize_t n = recv(wP->fd, buf, len, 0);
    if (n == 0)
      return false;
    if (n == -1)
    {
      if (errno == EINTR)
        continue;
      return false;
    }

    buf += n;
    len -= n;
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// wsSend - one frame: a client masks it, a server does not
//
static bool wsSend(WsConn* wP, int opcode, const char* data, int len)
{
  char* frame = malloc(len + 14);
  int   o     = 0;

  if (frame == NULL)
    return false;

  frame[o++] = (char) (0x80 | opcode);

  unsigned char maskBit = wP->client ? 0x80 : 0;
  if (len < 126)
    frame[o++] = (char) (maskBit | len);
  else if (len < 65536)
  {
    frame[o++] = (char) (maskBit | 126);
    frame[o++] = (char) ((len >> 8) & 0xFF);
    frame[o++] = (char) (len & 0xFF);
  }
  else
  {
    frame[o++] = (char) (maskBit | 127);
    for (int i = 7; i >= 0; i--)
      frame[o++] = (char) ((((uint64_t) len) >> (8 * i)) & 0xFF);
  }

  if (wP->client)
  {
    unsigned char mask[4];
    if (getrandom(mask, 4, 0) != 4)
      memset(mask, 0x5A, 4);
    memcpy(&frame[o], mask, 4);
    o += 4;
    for (int i = 0; i < len; i++)
      frame[o + i] = data[i] ^ mask[i & 3];
  }
  else if (len > 0)
    memcpy(&frame[o], data, len);

  pthread_mutex_lock(&wP->writeLock);
  bool ok = (wP->closeSent == false) && writeAll(wP->fd, frame, o + len);
  if (opcode == 8)
    wP->closeSent = true;
  pthread_mutex_unlock(&wP->writeLock);

  free(frame);
  return ok;
}



// -----------------------------------------------------------------------------
//
// wsSendText / wsSendClose -
//
bool wsSendText(WsConn* wP, const char* text, int len)
{
  return wsSend(wP, 1, text, len);
}

bool wsSendClose(WsConn* wP, int code)
{
  char payload[2] = { (char) ((code >> 8) & 0xFF), (char) (code & 0xFF) };
  return wsSend(wP, 8, payload, 2);
}



// -----------------------------------------------------------------------------
//
// wsRead - the next message, whole: answers 1 (text, '*dataP' malloc'ed and zero-terminated - the
// caller frees it), 8 (the peer closed - answered) or -1 (the connection broke, a binary frame, a
// message over 'maxLen')
//
int wsRead(WsConn* wP, char** dataP, int* lenP, int maxLen)
{
  char*    msg    = NULL;
  uint64_t msgLen = 0;
  int      msgOp  = 0;

  *dataP = NULL;
  *lenP  = 0;

  for (;;)
  {
    unsigned char h[2];
    if (readFull(wP, (char*) h, 2) == false)
      goto broken;

    bool     fin    = (h[0] & 0x80) != 0;
    int      opcode = h[0] & 0x0F;
    bool     masked = (h[1] & 0x80) != 0;
    uint64_t len    = h[1] & 0x7F;

    if (len == 126)
    {
      unsigned char x[2];
      if (readFull(wP, (char*) x, 2) == false)
        goto broken;
      len = ((uint64_t) x[0] << 8) | x[1];
    }
    else if (len == 127)
    {
      unsigned char x[8];
      if (readFull(wP, (char*) x, 8) == false)
        goto broken;
      len = 0;
      for (int i = 0; i < 8; i++)
        len = (len << 8) | x[i];
    }

    unsigned char mask[4] = { 0, 0, 0, 0 };
    if (masked && (readFull(wP, (char*) mask, 4) == false))
      goto broken;

    if (opcode >= 8)                             // a control frame: at most 125 bytes, never fragmented
    {
      char payload[126];
      if ((len > 125) || (readFull(wP, payload, len) == false))
        goto broken;
      for (uint64_t i = 0; i < len; i++)
        payload[i] ^= mask[i & 3];

      if (opcode == 9)
        wsSend(wP, 10, payload, (int) len);       // ping -> pong
      else if (opcode == 8)
      {
        wsSend(wP, 8, payload, (len >= 2) ? 2 : 0);
        free(msg);
        return 8;
      }
      continue;                                  // a pong
    }

    if ((opcode == 2) || ((opcode == 0) && (msgOp == 0)) || ((opcode == 1) && (msgOp != 0)) || (opcode > 2))
      goto broken;                               // binary, or a continuation of nothing, or a new message inside one

    if (opcode == 1)
      msgOp = 1;

    if (msgLen + len > (uint64_t) maxLen)
      goto broken;

    char* bigger = realloc(msg, msgLen + len + 1);
    if (bigger == NULL)
      goto broken;
    msg = bigger;

    if (readFull(wP, &msg[msgLen], len) == false)
      goto broken;
    for (uint64_t i = 0; i < len; i++)
      msg[msgLen + i] ^= mask[i & 3];
    msgLen += len;

    if (fin)
    {
      msg[msgLen] = 0;
      *dataP = msg;
      *lenP  = (int) msgLen;
      return 1;
    }
  }

 broken:
  free(msg);
  return -1;
}



// -----------------------------------------------------------------------------
//
// urlSplit - http://host:port/... -> host, port (80 when none); false for anything else
//
bool urlSplit(const char* url, char* host, int hostLen, char* port, int portLen)
{
  if (strncmp(url, "http://", 7) != 0)
    return false;

  const char* h   = url + 7;
  const char* end = h + strcspn(h, "/?#");
  const char* colon;

  if (*h == '[')                                 // [::1]:1026
  {
    const char* close = memchr(h, ']', end - h);
    if (close == NULL)
      return false;
    snprintf(host, hostLen, "%.*s", (int) (close - h - 1), h + 1);
    colon = (close + 1 < end && close[1] == ':') ? close + 1 : NULL;
  }
  else
  {
    colon = memchr(h, ':', end - h);
    snprintf(host, hostLen, "%.*s", (int) ((colon != NULL ? colon : end) - h), h);
  }

  if (colon != NULL)
    snprintf(port, portLen, "%.*s", (int) (end - colon - 1), colon + 1);
  else
    snprintf(port, portLen, "80");

  return (host[0] != 0) && (port[0] != 0);
}



// -----------------------------------------------------------------------------
//
// tcpConnect - a connection to host:port within 'timeoutMs', blocking afterwards; -1 if none
//
static int tcpConnect(const char* host, const char* port, int timeoutMs)
{
  struct addrinfo  hints;
  struct addrinfo* res = NULL;

  memset(&hints, 0, sizeof(hints));
  hints.ai_family   = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;

  if (getaddrinfo(host, port, &hints, &res) != 0)
    return -1;

  int fd = -1;
  for (struct addrinfo* aP = res; aP != NULL; aP = aP->ai_next)
  {
    fd = socket(aP->ai_family, aP->ai_socktype | SOCK_NONBLOCK | SOCK_CLOEXEC, aP->ai_protocol);
    if (fd == -1)
      continue;

    if (connect(fd, aP->ai_addr, aP->ai_addrlen) == 0)
      break;

    if (errno == EINPROGRESS)
    {
      struct pollfd pfd = { fd, POLLOUT, 0 };
      int           err = 0;
      socklen_t     el  = sizeof(err);

      if ((poll(&pfd, 1, timeoutMs) == 1) && (getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &el) == 0) && (err == 0))
        break;
    }

    close(fd);
    fd = -1;
  }

  freeaddrinfo(res);
  return fd;
}



// -----------------------------------------------------------------------------
//
// wsConnect - the client handshake: GET 'path' with Upgrade: websocket, the ngsi-ld.json subprotocol
//
// Answers 0 with the connection in 'wP'; -1 when the broker was not reached or broke off; -2 when it
// answered with another status than 101 ('*statusP', the start of its body in 'errBuf').
//
int wsConnect(WsConn* wP, const char* url, const char* path, int timeoutMs, int* statusP, char* errBuf, int errLen)
{
  char host[256];
  char port[16];

  *statusP = 0;
  errBuf[0] = 0;

  if (urlSplit(url, host, sizeof(host), port, sizeof(port)) == false)
  {
    snprintf(errBuf, errLen, "only http:// brokers (no TLS for the WebSocket yet)");
    return -1;
  }

  int fd = tcpConnect(host, port, timeoutMs);
  if (fd == -1)
  {
    snprintf(errBuf, errLen, "not reachable");
    return -1;
  }

  unsigned char nonce[16];
  char          key[32];
  char          accept[64];

  if (getrandom(nonce, sizeof(nonce), 0) != sizeof(nonce))
    memset(nonce, 0x42, sizeof(nonce));
  EVP_EncodeBlock((unsigned char*) key, nonce, sizeof(nonce));
  wsAcceptKey(key, accept, sizeof(accept));

  char req[1024];
  int  reqLen = snprintf(req, sizeof(req),
                         "GET %s HTTP/1.1\r\n"
                         "Host: %s:%s\r\n"
                         "Upgrade: websocket\r\n"
                         "Connection: Upgrade\r\n"
                         "Sec-WebSocket-Key: %s\r\n"
                         "Sec-WebSocket-Version: 13\r\n"
                         "Sec-WebSocket-Protocol: ngsi-ld.json\r\n"
                         "User-Agent: c3/" C3_VERSION "\r\n"
                         "\r\n", path, host, port, key);

  int flags = fcntl(fd, F_GETFL, 0);
  fcntl(fd, F_SETFL, flags & ~O_NONBLOCK);

  struct timeval tv = { timeoutMs / 1000, (timeoutMs % 1000) * 1000 };
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));

  if (writeAll(fd, req, reqLen) == false)
  {
    close(fd);
    snprintf(errBuf, errLen, "the upgrade request could not be sent");
    return -1;
  }

  //
  // The answer's head, up to the empty line; what follows it is the first frames
  //
  char  buf[8192];
  int   got = 0;
  char* end = NULL;

  while ((end = (got > 0) ? strstr(buf, "\r\n\r\n") : NULL) == NULL)
  {
    if (got >= (int) sizeof(buf) - 1)
      break;
    ssize_t n = recv(fd, &buf[got], sizeof(buf) - 1 - got, 0);
    if ((n == -1) && (errno == EINTR))
      continue;
    if (n <= 0)
      break;
    got += n;
    buf[got] = 0;
  }

  if (end == NULL)
  {
    close(fd);
    snprintf(errBuf, errLen, got == 0 ? "no answer to the upgrade request" : "the answer to the upgrade request is not HTTP");
    return -1;
  }

  int status = 0;
  if (sscanf(buf, "HTTP/1.%*d %d", &status) != 1)
    status = 0;
  *statusP = status;

  if (status != 101)
  {
    //
    // The start of the body, for the report - a ProblemDetails, usually
    //
    snprintf(errBuf, errLen, "%.200s", end + 4);
    close(fd);
    return -2;
  }

  //
  // Sec-WebSocket-Accept must be the one for our key
  //
  bool  acceptOk = false;
  char* line     = strstr(buf, "\r\n");
  while ((line != NULL) && (line < end))
  {
    line += 2;
    if (strncasecmp(line, "Sec-WebSocket-Accept:", 21) == 0)
    {
      char* v = line + 21;
      while (*v == ' ')
        ++v;
      acceptOk = (strncmp(v, accept, strlen(accept)) == 0);
    }
    line = strstr(line, "\r\n");
  }

  if (acceptOk == false)
  {
    close(fd);
    snprintf(errBuf, errLen, "the broker's Sec-WebSocket-Accept does not match the key");
    return -1;
  }

  struct timeval none = { 0, 0 };
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &none, sizeof(none));

  char* rest    = end + 4;
  int   restLen = got - (rest - buf);
  wsInit(wP, fd, true, rest, restLen);

  return 0;
}
