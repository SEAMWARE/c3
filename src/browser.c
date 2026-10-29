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
//   Chrome exits when the other end of its pipe closes: only a c3 that keeps running opens the window with
//   the pipe (control). A c3 that finds another on its port asks that one to open it (window.c, POST
//   /api/window/open), and opens it itself without the pipe only when that one cannot.
//   The profile is c3's alone: a Chrome on it that no c3 holds the pipe to - a window opened without it, or
//   one whose c3 was stopped - would take every new window over, and none of them could be shown again or
//   minimised. Before c3 opens the window it keeps the pipe to, that Chrome is stopped (orphanStop).
// - Otherwise the default browser: xdg-open, or open on macOS.
// - No screen (no $DISPLAY, no $WAYLAND_DISPLAY, on Linux): the URL is printed, to open from another
//   machine through ssh -L.
//
#define _GNU_SOURCE                              // close_range

#include <errno.h>                               // errno
#include <fcntl.h>                               // open
#include <signal.h>                              // kill, SIGTERM
#include <stdio.h>                               // printf, snprintf
#include <stdlib.h>                              // getenv, atoi
#include <string.h>                              // strchr, strrchr, strlen, strcmp, memmem
#include <sys/stat.h>                            // mkdir
#include <sys/wait.h>                            // waitpid
#include <unistd.h>                              // fork, execv, setsid, access, dup2, close_range, readlink, gethostname, usleep

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
// orphanStop - the Chrome on c3's profile, when there is one: stopped (SIGTERM, up to 5 s)
//
// Called before c3 starts the Chrome it keeps the pipe to - a c3 holding one does not get here (window.c).
// Chrome names itself in the profile: SingletonLock, a symbolic link to "<host>-<pid>". Only a Chrome of this
// host, alive, its command line naming this very profile (not a pid used again since), is stopped.
// Linux only (/proc).
//
static void orphanStop(const char* profile)
{
  char lockPath[4200];
  char lock[256];
  char host[256];

  snprintf(lockPath, sizeof(lockPath), "%s/SingletonLock", profile);

  ssize_t len = readlink(lockPath, lock, sizeof(lock) - 1);
  if (len <= 0)
    return;
  lock[len] = 0;

  char* dash = strrchr(lock, '-');
  if ((dash == NULL) || (gethostname(host, sizeof(host)) != 0))
    return;
  *dash = 0;
  host[sizeof(host) - 1] = 0;

  int pid = atoi(&dash[1]);
  if ((pid <= 0) || (strcmp(lock, host) != 0) || (kill(pid, 0) != 0))
    return;

  //
  // Its command line: --user-data-dir=<profile> one of the words. Chrome rewrites it into one string, the
  // words separated by spaces, not by NULs: either separates
  //
  char cmdPath[64];
  char cmd[16 * 1024];
  char want[4200];

  snprintf(cmdPath, sizeof(cmdPath), "/proc/%d/cmdline", pid);
  snprintf(want, sizeof(want), "--user-data-dir=%s", profile);

  int fd = open(cmdPath, O_RDONLY);
  if (fd == -1)
    return;
  ssize_t n = read(fd, cmd, sizeof(cmd) - 1);
  close(fd);
  if (n <= 0)
    return;
  cmd[n] = 0;

  for (ssize_t ix = 0; ix < n; ix++)
  {
    if (cmd[ix] == 0)
      cmd[ix] = ' ';
  }

  size_t wantLen = strlen(want);
  bool   ours    = false;

  for (char* hitP = strstr(cmd, want); hitP != NULL; hitP = strstr(&hitP[1], want))
  {
    if (((hitP == cmd) || (hitP[-1] == ' ')) && ((hitP[wantLen] == ' ') || (hitP[wantLen] == 0)))
      ours = true;
  }

  if (ours == false)
    return;

  printf("c3: a Chrome on c3's profile no c3 controls (pid %d) - stopped, the window opened again by this c3\n", pid);
  fflush(stdout);
  kill(pid, SIGTERM);

  for (int waited = 0; (waited < 50) && (kill(pid, 0) == 0); waited++)
    usleep(100 * 1000);
}



// -----------------------------------------------------------------------------
//
// browserOpen - true: a browser was started; false: the URL was printed only
//
// control: Chrome with the DevTools pipe, kept by this c3 (window.c) - only for a c3 that keeps running
//
bool browserOpen(const char* url, bool noBrowser, bool control)
{
  char prog[4096];

  if (noBrowser)
  {
    printf("c3: open %s\n", url);
    fflush(stdout);
    return false;
  }

  if (headless())
  {
    printf("c3: no screen here - open %s\n"
           "    from another machine: ssh -L %d:localhost:%d <this host>, then the same URL there\n", url, c3Port, c3Port);
    fflush(stdout);
    return false;
  }

  if (chromeFind(prog, sizeof(prog)) != NULL)
  {
    char appArg[4200];
    char profileArg[4200];
    char profile[4096];

    profileDir(profile, sizeof(profile));
    if (control)
      orphanStop(profile);

    snprintf(appArg,     sizeof(appArg),     "--app=%s", url);
    snprintf(profileArg, sizeof(profileArg), "--user-data-dir=%s", profile);

    char* argV[] = { prog, appArg, (char*) "--start-fullscreen", profileArg, (char*) "--no-first-run", (char*) "--no-default-browser-check", control ? (char*) "--remote-debugging-pipe" : NULL, NULL };

    if (spawn(prog, argV, control))
    {
      printf("c3: %s - opened in %s\n", url, prog);
      fflush(stdout);
      return true;
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
      return true;
    }
  }

  printf("c3: open %s\n", url);
  fflush(stdout);
  return false;
}
