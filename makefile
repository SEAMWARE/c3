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

CFLAGS      = $(OPT) -Wall -Werror -Wundef -Wno-format-truncation -fstack-protector-all -I$(COR_LIBS) -MMD -MP $(EXTRA_CFLAGS)

SOURCES     = src/c3.c src/config.c src/serve.c src/proxy.c src/creds.c src/oidc.c src/vc.c src/browser.c src/maps.c src/live.c src/demo.c src/ws.c src/util.c src/compile.c src/run.c
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

install: c3
	install -d $(DESTDIR)$(PREFIX)/bin $(DESTDIR)$(PREFIX)/share/c3
	install -m 755 c3 $(DESTDIR)$(PREFIX)/bin/c3
	rm -rf $(DESTDIR)$(PREFIX)/share/c3/www
	cp -r www $(DESTDIR)$(PREFIX)/share/c3/www

uninstall:
	rm -f $(DESTDIR)$(PREFIX)/bin/c3
	rm -rf $(DESTDIR)$(PREFIX)/share/c3

clean:
	rm -rf obj c3

.PHONY: all run install uninstall clean

-include $(DEPS)
