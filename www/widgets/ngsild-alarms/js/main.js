//
// main.js - NGSI-LD alarms: the entities of a type at a broker c³ knows, newest first, by severity
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// An alarm is an entity - a corCep rule's create makes one (no id: one each time). The widget reads the alarms of
// a type through c³ every 'refresh' seconds, with the broker's createdAt (options=sysAttrs: corCep stamps no time
// of its own), and shows the newest first: their severity as a colour, their text, how long ago. An alarm that came
// after the widget's first read is marked new for a minute. One clicked is sent on "selected".
//
// Writing (c³'s Dashboard switch "Widgets may write" on): Acknowledge PATCHes the alarm's acknowledged (true),
// acknowledgedAt and acknowledgedBy (WireCloud's user); an acknowledged one is grey, or left out ("Hide
// acknowledged"). × deletes the alarm, once asked.
//
/* globals MashupPlatform, C3 */
(function () {
  "use strict";

  var t = C3.t;
  var el = C3.el;
  var view = document.getElementById("view");
  var NEW_MS = 60 * 1000;
  var timer = null;
  var alarms = null;
  var count = null;
  var error = null;
  var firstSeen = {};                            // id -> when this widget first saw it; null: before the first read
  var selected = null;
  var formOpen = false;                          // the settings form is shown: the reads do not redraw

  var pref = C3.pref;
  function configured() { return !!(pref("broker") && pref("type")); }
  function from() { return { broker: pref("broker"), tenant: pref("tenant"), type: pref("type") }; }

  function textOf(e) {
    var names = pref("text") ? [pref("text")] : ["message", "description", "name"].concat(C3.attributesOf([e]));
    for (var i = 0; i < names.length; i++) {
      var v = C3.value(e, names[i]);
      if (v && typeof v.value === "string") return v.value;
    }
    return e.id;
  }

  //
  // level - a severity as high, mid, low or none (the colour)
  //
  function level(s) {
    s = String(s || "").toLowerCase();
    if (/^(critical|fatal|high|major|error|alarm|emergency)$/.test(s)) return "high";
    if (/^(warning|warn|medium|moderate|minor)$/.test(s)) return "mid";
    if (/^(low|info|informational|notice|ok)$/.test(s)) return "low";
    return "";
  }

  //
  // timeOf - when the alarm was made: the broker's createdAt, else its newest observedAt
  //
  function timeOf(e) {
    var c = e.createdAt && Date.parse(e.createdAt["@value"] || e.createdAt);
    if (isFinite(c) && c) return c;
    var best = 0;
    C3.attributesOf([e]).forEach(function (a) {
      var v = C3.value(e, a);
      var o = v && v.observedAt ? Date.parse(v.observedAt) : NaN;
      if (isFinite(o) && o > best) best = o;
    });
    return best || null;
  }

  function read() {
    if (!configured()) return;
    var qs = ["type=" + encodeURIComponent(pref("type")), "options=sysAttrs", "limit=1000", "count=true"];
    if (pref("q")) qs.push("q=" + encodeURIComponent(pref("q")));
    C3.get(pref("broker"), pref("tenant"), "/ngsi-ld/v1/entities?" + qs.join("&")).then(function (r) {
      var list = Array.isArray(r.body) ? r.body : [];
      var first = alarms === null;
      var now = Date.now();
      alarms = list.map(function (e) {
        if (!(e.id in firstSeen)) firstSeen[e.id] = first ? null : now;
        var sev = C3.value(e, pref("severity"));
        var ack = C3.value(e, "acknowledged");
        var ackAt = C3.value(e, "acknowledgedAt");
        var ackBy = C3.value(e, "acknowledgedBy");
        return {
          entity: e, id: e.id, text: textOf(e), severity: sev ? String(C3.show(sev.value)) : "", at: timeOf(e),
          acked: !!(ack && ack.value === true),
          ackAt: ackAt ? Date.parse(ackAt.value && ackAt.value["@value"] ? ackAt.value["@value"] : ackAt.value) : null,
          ackBy: ackBy ? String(ackBy.value) : "",
        };
      });
      alarms.sort(function (a, b) { return (b.at || 0) - (a.at || 0) || (a.id < b.id ? 1 : -1); });
      count = r.count !== null ? Number(r.count) : list.length;
      error = null;
      render();
    }, function (e) {
      error = e.message;
      render();
    });
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    var s = Number(pref("refresh"));
    if (configured() && s > 0) timer = setInterval(read, Math.max(1, s) * 1000);
  }

  function isNew(a) { var s = firstSeen[a.id]; return s !== null && s !== undefined && Date.now() - s < NEW_MS; }

  function render() {
    if (formOpen) return;
    var head = el("div", "head");
    var fresh = alarms ? alarms.filter(isNew).length : 0;
    head.append(el("span", "what", alarms ? t("{n} alarms", { n: count }) + (fresh ? "  ·  " + t("{n} new", { n: fresh }) : "") : "…"));
    head.append(el("span", "meta", pref("type") + (pref("q") ? " [" + pref("q") + "]" : "") + "  ·  " + pref("broker") + (pref("tenant") ? "  ·  " + pref("tenant") : "")));
    var hide = el("label", "hide");
    var hideBox = el("input");
    hideBox.type = "checkbox";
    hideBox.checked = pref("hideAcknowledged") === true;
    hideBox.addEventListener("change", function () { C3.setPrefs({ hideAcknowledged: hideBox.checked }); });
    hide.append(hideBox, document.createTextNode(t("Hide acknowledged")));
    var edit = el("button", "", t("Edit"));
    edit.addEventListener("click", showForm);
    head.append(hide, edit);
    view.replaceChildren(head);
    if (writeError) view.append(el("div", "err", writeError));

    if (error) { view.append(el("div", "err", error)); return; }
    if (!alarms) return;
    if (!alarms.length) { view.append(el("div", "wait", t("No alarm"))); return; }

    var table = el("table");
    var tbody = el("tbody");
    var max = Math.max(1, Number(pref("rows")) || 50);
    alarms.filter(function (a) { return !(a.acked && pref("hideAcknowledged") === true); }).slice(0, max).forEach(function (a) {
      var tr = el("tr", [isNew(a) ? "new" : "", a.acked ? "acked" : "", a.id === selected ? "sel" : ""].join(" ").trim());
      var sev = el("td");
      if (a.severity) sev.append(el("span", "sev " + level(a.severity), a.severity));
      var main = el("td");
      main.append(el("div", "name", a.text), el("div", "sub", a.id));
      if (a.acked) main.append(el("div", "sub", t("acknowledged") + (a.ackBy ? " · " + a.ackBy : "") + (a.ackAt ? " · " + C3.ago(a.ackAt) : "")));
      var when = el("td", "when", a.at ? C3.ago(a.at) : "");
      if (a.at) when.title = new Date(a.at).toLocaleString();
      var acts = el("td", "acts");
      if (!a.acked) {
        var ack = el("button", "", t("Acknowledge"));
        ack.addEventListener("click", function (ev) { ev.stopPropagation(); acknowledge(a); });
        acts.append(ack);
      }
      var del = el("button", "x", "×");
      del.title = t("Delete");
      del.addEventListener("click", function (ev) {
        ev.stopPropagation();
        C3.confirm(t("Delete this alarm?")).then(function (yes) { if (yes) remove(a); });
      });
      acts.append(del);
      tr.append(sev, main, when, acts);
      tr.addEventListener("click", function () {
        selected = a.id;
        MashupPlatform.wiring.pushEvent("selected", C3.withEntities(from(), [a.entity]));
        render();
      });
      tbody.append(tr);
    });
    table.append(tbody);
    view.append(table);
  }

  //
  // Writing - through c³ (its Dashboard switch "Widgets may write"); the alarms read again after each
  //
  var writeError = null;

  function done(p) {
    p.then(function () { writeError = null; read(); }, function (e) { writeError = e.message; render(); });
  }

  function alarmUrl(id) { return "/ngsi-ld/v1/entities/" + encodeURIComponent(id); }

  function acknowledge(a) {
    var attrs = {
      acknowledged: C3.property(true),
      acknowledgedAt: { type: "Property", value: { "@type": "DateTime", "@value": new Date().toISOString() } },
    };
    if (C3.username()) attrs.acknowledgedBy = C3.property(C3.username());
    done(C3.write("PATCH", pref("broker"), pref("tenant"), alarmUrl(a.id) + "/attrs", attrs));
  }

  function remove(a) {
    done(C3.write("DELETE", pref("broker"), pref("tenant"), alarmUrl(a.id)));
  }

  function showForm() {
    formOpen = true;
    var form = el("div", "form");
    var broker = el("select");
    var tenant = el("select");
    var type = el("input");
    var q = el("input");
    var every = el("input");
    type.value = pref("type");
    q.value = pref("q");
    every.type = "number";
    every.min = "0";
    every.value = pref("refresh");
    var err = el("div", "err");
    form.append(el("label", "", t("Broker")), broker, el("label", "", t("Tenant")), tenant, el("label", "", t("Alarm type")), type,
                el("label", "", t("Query (q)")), q, el("label", "", t("Refresh")), every);
    var acts = el("div", "acts");
    var save = el("button", "", t("Save"));
    var cancel = el("button", "", t("Cancel"));
    acts.append(save, cancel);
    form.append(acts);
    view.replaceChildren(form, err);

    C3.brokerPicker(broker, tenant, { broker: pref("broker"), tenant: pref("tenant") }).then(function (list) {
      if (!list.length) err.textContent = t("No broker in c³ yet - connect to one in Explore");
    }, function (e) { err.textContent = e.message; });

    save.addEventListener("click", function () {
      formOpen = false;
      C3.setPrefs({ broker: broker.value, tenant: tenant.value, type: type.value.trim(), q: q.value.trim(), refresh: Number(every.value) || 0 });
    });
    cancel.addEventListener("click", function () { if (configured()) { formOpen = false; render(); } });
  }

  C3.onPrefs(function () {
    alarms = null;
    firstSeen = {};
    render();
    schedule();
    read();
  });

  if (configured()) { render(); schedule(); read(); } else showForm();
})();
