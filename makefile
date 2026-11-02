#
# FILE            makefile
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
# c3 - the coraine Control Center
#
#   make                 the c3 binary (in this directory)
#   make run             build, and start c3 on this checkout's pages (ARGS="--port 7901 --no-browser")
#   make install         $(PREFIX)/bin/c3 and $(PREFIX)/share/c3/www (PREFIX=/usr/local; DESTDIR for packaging)
#   make uninstall
#   make site            the documentation as a website, in $(SITE) (build/site): the Documentation page on its own,
#                        VERSION=<release> (latest) - what seamware.github.io/docs publishes
#   make clean
#
# The backend is built on the cor-libs, as coraine is: SIBLING checkouts (../corHttp, ../corRest, ...)
# built there, `-I..` and the archives linked by path. COR_LIBS=<dir> for checkouts elsewhere.
#
CC          = gcc
COR_LIBS   ?= ..
PREFIX     ?= /usr/local
DESTDIR    ?=
BUILD      ?= release

ifeq ($(BUILD),debug)
  OPT       = -g -O0
else
  OPT       = -O2
endif

#
# C3_CLONES: the directory of clones Compile builds from when coraine-dev is not installed - by default
# the one the cor-libs are taken from here (coraine beside them). A package build sets it empty
#
C3_CLONES  ?= $(abspath $(COR_LIBS))

CFLAGS      = $(OPT) -Wall -Werror -Wundef -Wno-format-truncation -fstack-protector-all -I$(COR_LIBS) -DC3_CLONES='"$(C3_CLONES)"' -MMD -MP $(EXTRA_CFLAGS)

SOURCES     = src/c3.c src/config.c src/serve.c src/proxy.c src/creds.c src/oidc.c src/vc.c src/browser.c src/maps.c src/live.c src/demo.c src/ws.c src/util.c src/compile.c src/run.c src/window.c src/repos.c
OBJDIR      = obj/$(BUILD)
OBJECTS     = $(SOURCES:src/%.c=$(OBJDIR)/%.o)
DEPS        = $(OBJECTS:.o=.d)

#
# Link order: a library before the ones it uses
#
COR_ARCHIVES = $(COR_LIBS)/corHttp/libcorHttp.a   \
               $(COR_LIBS)/corRest/libcorRest.a   \
               $(COR_LIBS)/corJson/libcorJson.a   \
               $(COR_LIBS)/corTree/libcorTree.a   \
               $(COR_LIBS)/corArgs/libcorArgs.a   \
               $(COR_LIBS)/corLog/libcorLog.a     \
               $(COR_LIBS)/corAlloc/libcorAlloc.a \
               $(COR_LIBS)/corBase/libcorBase.a

LIBS        = $(COR_ARCHIVES) -lssl -lcrypto -lz -lpthread -lm

all: c3

c3: $(OBJECTS) $(COR_ARCHIVES)
	$(CC) -o $@ $(OBJECTS) $(LIBS)

$(OBJDIR)/%.o: src/%.c
	@mkdir -p $(OBJDIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(COR_ARCHIVES):
	@echo "missing $@ - c3 builds against sibling checkouts of the cor-libs, built there (make in each), or COR_LIBS=<dir>"
	@false

run: c3
	./c3 $(ARGS)

#
# The menu's and the dock's c³: desktop/com.seamware.c3.desktop, Exec the installed c3 by its full path (a
# desktop session's PATH may not hold $(PREFIX)/bin, ~/.local/bin), and its icon in the hicolor theme, 256 and
# 512 pixels. DESKTOP_EXEC: what the entry runs instead - a launcher of one's own around c3 (environment, a
# log file), its full path.
#
# A c3 still running from the file the install replaced is stopped (tools/stopReplaced.sh): started again,
# it would only be opened again, the earlier build. Not with DESTDIR - a package is built there.
#
APPS          = $(DESTDIR)$(PREFIX)/share/applications
ICONS         = $(DESTDIR)$(PREFIX)/share/icons/hicolor
DESKTOP_EXEC ?= $(PREFIX)/bin/c3

install: c3
	install -d $(DESTDIR)$(PREFIX)/bin $(DESTDIR)$(PREFIX)/share/c3 $(APPS) $(ICONS)/256x256/apps $(ICONS)/512x512/apps
	install -m 755 c3 $(DESTDIR)$(PREFIX)/bin/c3
	rm -rf $(DESTDIR)$(PREFIX)/share/c3/www
	cp -r www $(DESTDIR)$(PREFIX)/share/c3/www
	sed 's|@EXEC@|$(DESKTOP_EXEC)|' desktop/com.seamware.c3.desktop > $(APPS)/com.seamware.c3.desktop
	chmod 644 $(APPS)/com.seamware.c3.desktop
	install -m 644 desktop/com.seamware.c3-256.png $(ICONS)/256x256/apps/com.seamware.c3.png
	install -m 644 desktop/com.seamware.c3-512.png $(ICONS)/512x512/apps/com.seamware.c3.png
	@[ -n "$(DESTDIR)" ] || tools/stopReplaced.sh $(abspath $(PREFIX))/bin/c3

#
# install-launcher - c3 with desktop/c3-launch around it: the menu's and the dock's c³ run the NEWEST installed
# c3, wherever it is installed, and log to ~/.local/state/c3/c3.log. For a machine with several c3 installs (a
# developer's); a package installs plain c3.
#
install-launcher:
	$(MAKE) install DESKTOP_EXEC=$(abspath $(PREFIX))/bin/c3-launch
	install -m 755 desktop/c3-launch $(DESTDIR)$(PREFIX)/bin/c3-launch

uninstall:
	rm -f $(DESTDIR)$(PREFIX)/bin/c3 $(DESTDIR)$(PREFIX)/bin/c3-launch
	rm -rf $(DESTDIR)$(PREFIX)/share/c3
	rm -f $(APPS)/com.seamware.c3.desktop $(ICONS)/256x256/apps/com.seamware.c3.png $(ICONS)/512x512/apps/com.seamware.c3.png

#
# The website: site/index.html around the Documentation page's own files - docs.js, the guides, the styles
#
SITE       ?= build/site
VERSION    ?= latest

site:
	rm -rf $(SITE)
	mkdir -p $(SITE)/css $(SITE)/js $(SITE)/img $(SITE)/fonts $(SITE)/docs
	cp site/index.html $(SITE)/
	cp www/css/c3.css www/css/compile.css site/site.css $(SITE)/css/
	cp www/js/docs.js site/site.js $(SITE)/js/
	cp www/img/coraine-mark.png www/img/seamware.svg $(SITE)/img/
	cp www/fonts/* $(SITE)/fonts/
	cp www/docs/* $(SITE)/docs/
	printf '{ "version": "%s", "commit": "%s" }\n' '$(VERSION)' "$$(git rev-parse --short HEAD 2>/dev/null)" > $(SITE)/version.json

clean:
	rm -rf obj c3 build

.PHONY: all run install install-launcher uninstall clean site

-include $(DEPS)
