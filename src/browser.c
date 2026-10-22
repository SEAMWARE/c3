//
// FILE            browser.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// Open the application
//
// - Chrome or Chromium: an application window of its own (--app=<url>, no tabs, no address bar),
//   full-screen (--start-fullscreen), the DevTools protocol on a pipe (--remote-debugging-pipe) for the page's
//   minimise and close buttons (window.c). With a profile of its own (--user-data-dir under
//   $XDG_STATE_HOME/c3, else ~/.local/state/c3): a Chrome that is already running would take the
//   request over and open a normal window, ignoring both flags.
// - Otherwise the default browser: xdg-open, or open on macOS.
// - No screen (no $DISPLAY, no $WAYLAND_DISPLAY, on Linux): the URL is printed, to open from another
//   machine through ssh -L.
//
#define _GNU_SOURCE                              // close_range

#include <errno.h>                               // errno
#include <fcntl.h>                               // open
#include <stdio.h>                               // printf, snprintf
#include <stdlib.h>                              // getenv
#include <string.h>                              // strchr, strlen
#include <sys/stat.h>                            // mkdir
#include <sys/wait.h>                            // waitpid
#include <unistd.h>                              // fork, execv, setsid, access, dup2, close_range

#include "c3.h"



// -----------------------------------------------------------------------------
//
// chromeFind -
//
static const char* chromeFind(char* out, int outLen)
{
  static const char* names[] = { "google-chrome", "google-chrome-stable", "chromium", "chromium-browser" };

  for (unsigned int ix = 0; ix < sizeof(names) / sizeof(names[0]); ix++)
  {
    if (inPath(names[ix], out, outLen))
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
// devtools: Chrome's --remote-debugging-pipe - it reads the DevTools protocol on its fd 3 and writes on its
// fd 4; c3 keeps the other ends (window.c)
//
static bool spawn(const char* prog, char* const argV[], bool devtools)
{
  int toChrome[2]   = { -1, -1 };
  int fromChrome[2] = { -1, -1 };

  if (devtools && ((pipe(toChrome) == -1) || (pipe(fromChrome) == -1)))
  {
    if (toChrome[0] != -1) { close(toChrome[0]); close(toChrome[1]); }
    devtools = false;
  }

  pid_t pid = fork();

  if (pid == -1)
  {
    if (devtools) { close(toChrome[0]); close(toChrome[1]); close(fromChrome[0]); close(fromChrome[1]); }
    return false;
  }

  if (pid == 0)
  {
    //
    // A grandchild runs the browser, and this child exits at once: the browser is init's to reap, not
    // c3's - and SIGCHLD stays as it is, so c3's own children (Compile's builds) can be waited for
    //
    if (fork() != 0)
      _exit(0);

    setsid();

    int fd = open("/dev/null", O_RDWR);
    if (fd != -1)
    {
      dup2(fd, 0);
      dup2(fd, 1);
      dup2(fd, 2);
    }

    if (devtools)
    {
      //
      // Chrome's ends to 3 and 4 - by way of fds above both, as one of them may be 3 or 4 already
      //
      int in  = fcntl(toChrome[0],   F_DUPFD, 10);
      int out = fcntl(fromChrome[1], F_DUPFD, 10);

      dup2(in,  3);
      dup2(out, 4);
      close_range(5, ~0U, 0);                    // c3's listening socket is not the browser's to keep
    }
    else
      close_range(3, ~0U, 0);

    execv(prog, argV);
    _exit(127);
  }

  while ((waitpid(pid, NULL, 0) == -1) && (errno == EINTR))
    ;

  if (devtools)
  {
    close(toChrome[0]);
    close(fromChrome[1]);
    windowPipesSet(toChrome[1], fromChrome[0]);
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

    char* argV[] = { prog, appArg, (char*) "--start-fullscreen", profileArg, (char*) "--no-first-run", (char*) "--no-default-browser-check", (char*) "--remote-debugging-pipe", NULL };

    if (spawn(prog, argV, true))
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

  if (inPath(opener, prog, sizeof(prog)))
  {
    char* argV[] = { prog, (char*) url, NULL };

    if (spawn(prog, argV, false))
    {
      printf("c3: %s - opened with %s\n", url, opener);
      fflush(stdout);
      return;
    }
  }

  printf("c3: open %s\n", url);
  fflush(stdout);
}
