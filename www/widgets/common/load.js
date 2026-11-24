//
// load.js - a widget's code and style, loaded from c³ - the code of the c³ running, also in a widget placed before
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// WireCloud runs a placed widget from the files of the version it was placed with; a new version reaches it only
// through the widget's Upgrade. So a widget's page loads its scripts and its style from c³ (its port in the cookie
// c3_port), from www/widgets/ - c³ serves them uncached: a change in them reaches every placed widget at its next
// load, no new version. The .wgt's own copies are the fallback, when c³ is not reachable. A change in config.xml
// (settings, wiring, size), in index.html or in this file still needs a new version.
//
//   <head>  <script src="js/common/load.js"></script> <script>C3load.css("ngsild-value", ["css/style.css"])</script>
//   <body>  ... <script>C3load.js("ngsild-value", ["js/common/c3.js", "js/main.js"])</script> <script>C3load.rest()</script>
//
// document.write: the scripts load in order and run before the page's load, as the page's own <script>s do.
//
(function () {
  "use strict";

  var m = /(?:^|;\s*)c3_port=(\d+)/.exec(document.cookie);
  var root = m ? location.protocol + "//" + location.hostname + ":" + m[1] + "/widgets/" : null;
  var scripts = [];                              // the scripts asked for, in order: their paths in the .wgt
  var failed = -1;                               // the first script c³ could not give; -1: none

  // at - a path of the .wgt as c³ serves it: js/common/ is www/widgets/common/, the rest the widget's directory
  function at(widget, path) {
    return root + (path.indexOf("js/common/") === 0 ? "common/" + path.slice(10) : widget + "/" + path);
  }

  function attr(s) { return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;"); }

  window.C3load = {
    css: function (widget, paths) {
      paths.forEach(function (p) {
        var local = "this.onerror=null;this.href='" + attr(p) + "'";
        document.write(root ? '<link rel="stylesheet" href="' + attr(at(widget, p)) + '" onerror="' + local + '">'
                            : '<link rel="stylesheet" href="' + attr(p) + '">');
      });
    },
    js: function (widget, paths) {
      paths.forEach(function (p) {
        var i = scripts.push(p) - 1;
        document.write(root ? '<script src="' + attr(at(widget, p)) + '" onerror="C3load.failed(' + i + ')"><\/script>'
                            : '<script src="' + attr(p) + '"><\/script>');
      });
    },
    failed: function (i) { if (failed < 0 || i < failed) failed = i; },
    // rest - the .wgt's own copies of the scripts from the first one c³ did not give (a later one ran without it)
    rest: function () {
      if (failed < 0) return;
      scripts.slice(failed).forEach(function (p) { document.write('<script src="' + attr(p) + '"><\/script>'); });
    },
  };
})();
