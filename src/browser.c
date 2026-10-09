//
// FILE            browser.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Open the application
//
// - Chrome or Chromium: an application window of its own (--app=<url>, no tabs, no address bar),
//   full-screen (--start-fullscreen). With a profile of its own (--user-data-dir under
//   $XDG_STATE_HOME/c3, else ~/.local/state/c3): a Chrome that is already running would take the
//   request over and open a normal window, ignoring both flags.
// - Otherwise the default browser: xdg-open, or open on macOS.
// - No screen (no $DISPLAY, no $WAYLAND_DISPLAY, on Linux): the URL is printed, to open from another
//   machine through ssh -L.
//
#include <fcntl.h>                               // open
#include <signal.h>                              // signal, SIGCHLD
#include <stdio.h>                               // printf, snprintf
#include <stdlib.h>                              // getenv
#include <string.h>                              // strchr, strlen
#include <sys/stat.h>                            // mkdir
#include <unistd.h>                              // fork, execv, setsid, access, dup2

#include "c3.h"



// -----------------------------------------------------------------------------
//
// inPath - the full path of 'name' in $PATH, or NULL
//
static const char* inPath(const char* name, char* out, int outLen)
{
  const char* path = getenv("PATH");

  if (path == NULL)
    path = "/usr/local/bin:/usr/bin:/bin";

  while (*path != 0)
  {
    const char* colon = strchr(path, ':');
    int         len   = (colon != NULL) ? (int) (colon - path) : (int) strlen(path);

    if (len > 0)
    {
      snprintf(out, outLen, "%.*s/%s", len, path, name);
      if (access(out, X_OK) == 0)
        return out;
    }

    if (colon == NULL)
      break;
    path = colon + 1;
  }

  return NULL;
}



// -----------------------------------------------------------------------------
//
// chromeFind -
//
static const char* chromeFind(char* out, int outLen)
{
  static const char* names[] = { "google-chrome", "google-chrome-stable", "chromium", "chromium-browser" };

  for (unsigned int ix = 0; ix < sizeof(names) / sizeof(names[0]); ix++)
  {
    if (inPath(names[ix], out, outLen) != NULL)
      return out;
  }

#ifdef __APPLE__
  static const char* apps[] =
  {
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  };

  for (unsigned int ix = 0; ix < sizeof(apps) / sizeof(apps[0]); ix++)
  {
    if (access(apps[ix], X_OK) == 0)
    {
      snprintf(out, outLen, "%s", apps[ix]);
      return out;
    }
  }
#endif

  return NULL;
}



// -----------------------------------------------------------------------------
//
// headless - no screen to open a window on
//
static bool headless(void)
{
#ifdef __APPLE__
  return (getenv("SSH_CONNECTION") != NULL);
#else
  const char* display = getenv("DISPLAY");
  const char* wayland = getenv("WAYLAND_DISPLAY");

  return ((display == NULL) || (display[0] == 0)) && ((wayland == NULL) || (wayland[0] == 0));
#endif
}



// -----------------------------------------------------------------------------
//
// spawn - start a program, detached, its output gone; true if the fork worked
//
static bool spawn(const char* prog, char* const argV[])
{
  pid_t pid = fork();

  if (pid == -1)
    return false;

  if (pid == 0)
  {
    setsid();

    int fd = open("/dev/null", O_RDWR);
    if (fd != -1)
    {
      dup2(fd, 0);
      dup2(fd, 1);
      dup2(fd, 2);
    }

    execv(prog, argV);
    _exit(127);
  }

  return true;
}



// -----------------------------------------------------------------------------
//
// profileDir - Chrome's profile for c3, created
//
static void profileDir(char* out, int outLen)
{
  const char* state = getenv("XDG_STATE_HOME");
  const char* home  = getenv("HOME");
  char        base[4096];

  if ((state != NULL) && (state[0] == '/'))
    snprintf(base, sizeof(base), "%s", state);
  else
    snprintf(base, sizeof(base), "%s/.local/state", (home != NULL) ? home : "/tmp");

  mkdir(base, 0700);
  snprintf(out, outLen, "%s/c3", base);
  mkdir(out, 0700);
  snprintf(out, outLen, "%s/c3/chrome", base);
}



// -----------------------------------------------------------------------------
//
// browserOpen -
//
void browserOpen(const char* url, bool noBrowser)
{
  char prog[4096];

  signal(SIGCHLD, SIG_IGN);                      // the browser is not waited for

  if (noBrowser)
  {
    printf("c3: open %s\n", url);
    fflush(stdout);
    return;
  }

  if (headless())
  {
    printf("c3: no screen here - open %s\n"
           "    from another machine: ssh -L %d:localhost:%d <this host>, then the same URL there\n", url, c3Port, c3Port);
    fflush(stdout);
    return;
  }

  if (chromeFind(prog, sizeof(prog)) != NULL)
  {
    char appArg[4200];
    char profileArg[4200];
    char profile[4096];

    profileDir(profile, sizeof(profile));
    snprintf(appArg,     sizeof(appArg),     "--app=%s", url);
    snprintf(profileArg, sizeof(profileArg), "--user-data-dir=%s", profile);

    char* argV[] = { prog, appArg, (char*) "--start-fullscreen", profileArg, (char*) "--no-first-run", (char*) "--no-default-browser-check", NULL };

    if (spawn(prog, argV))
    {
      printf("c3: %s - opened in %s\n", url, prog);
      fflush(stdout);
      return;
    }
  }

#ifdef __APPLE__
  const char* opener = "open";
#else
  const char* opener = "xdg-open";
#endif

  if (inPath(opener, prog, sizeof(prog)) != NULL)
  {
    char* argV[] = { prog, (char*) url, NULL };

    if (spawn(prog, argV))
    {
      printf("c3: %s - opened with %s\n", url, opener);
      fflush(stdout);
      return;
    }
  }

  printf("c3: open %s\n", url);
  fflush(stdout);
}
