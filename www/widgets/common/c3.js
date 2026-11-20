//
// c3.js - what c³'s widgets share: c³ found, the brokers read through it, an attribute's value, the texts
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The widgets run in WireCloud, which c³ started (its Dashboard page). They read the brokers through c³'s
// proxy, as Explore does - c³ adds each broker's token, headers and tenant. c³ answers them from WireCloud's
// origin, for GET only (src/serve.c). c³'s port is in the cookie c3_port, which c³ sets on the host the
// Dashboard was loaded from when it logs WireCloud in - a cookie is per host, not per port, so it is here too.
//
/* exported C3 */
var C3 = (function () {
  "use strict";

  //
  // The texts the widgets show, in WireCloud's language - English is the key
  //
  var TEXTS = {
    es: {
      "Broker": "Broker", "Tenant": "Tenant", "default": "predeterminado", "Type": "Tipo", "Query (q)": "Consulta (q)",
      "Attributes (attrs)": "Atributos (attrs)", "every": "cada", "seconds": "segundos", "Save": "Guardar", "Edit": "Editar",
      "Refresh": "Actualizar", "Cancel": "Cancelar",
      "c³ is not reachable - open this dashboard from c³'s Dashboard page": "c³ no responde - abre este panel desde la página Panel de c³",
      "No broker in c³ yet - connect to one in Explore": "Aún no hay ningún broker en c³ - conéctate a uno en Explorar",
      "{n} entities": "{n} entidades", "updated {time}": "actualizado {time}", "Not configured": "Sin configurar",
      "Waiting for entities - wire an NGSI-LD source to this widget": "Esperando entidades - conecta una fuente NGSI-LD a este widget",
      "Attribute": "Atributo", "Entity": "Entidad", "the first": "la primera", "No such attribute": "No existe ese atributo",
      "all": "todos", "any type": "cualquier tipo", "no value": "sin valor",
      "Hours": "Horas", "last {h} h": "últimas {h} h", "No history at the broker - it keeps none (TRoE), or not for this attribute": "El broker no tiene historial - no lo guarda (TRoE), o no para este atributo", "No entity has a location": "Ninguna entidad tiene ubicación", "history: {why}": "historial: {why}",
      "Rules tenant": "Tenant de las reglas", "Alarm type": "Tipo de alarma", "{n} rules": "{n} reglas", "{n} alarms": "{n} alarmas", "{n} new": "{n} nuevas", "never": "nunca", "disabled": "desactivada", "No rule in this tenant - corCep reads them from the rules tenant (cep)": "Ninguna regla en este tenant - corCep las lee del tenant de las reglas (cep)", "No alarm": "Ninguna alarma", "{n} s ago": "hace {n} s", "{n} min ago": "hace {n} min", "{n} h ago": "hace {n} h", "{n} d ago": "hace {n} d", "fired": "disparada", "last error": "último error"
    },
    fr: {
      "Broker": "Broker", "Tenant": "Tenant", "default": "par défaut", "Type": "Type", "Query (q)": "Requête (q)",
      "Attributes (attrs)": "Attributs (attrs)", "every": "toutes les", "seconds": "secondes", "Save": "Enregistrer", "Edit": "Modifier",
      "Refresh": "Actualiser", "Cancel": "Annuler",
      "c³ is not reachable - open this dashboard from c³'s Dashboard page": "c³ ne répond pas - ouvrez ce tableau de bord depuis la page Tableau de bord de c³",
      "No broker in c³ yet - connect to one in Explore": "Pas encore de broker dans c³ - connectez-vous à un broker dans Explorer",
      "{n} entities": "{n} entités", "updated {time}": "mis à jour {time}", "Not configured": "Non configuré",
      "Waiting for entities - wire an NGSI-LD source to this widget": "En attente d'entités - reliez une source NGSI-LD à ce widget",
      "Attribute": "Attribut", "Entity": "Entité", "the first": "la première", "No such attribute": "Attribut introuvable",
      "all": "tous", "any type": "tout type", "no value": "pas de valeur",
      "Hours": "Heures", "last {h} h": "dernières {h} h", "No history at the broker - it keeps none (TRoE), or not for this attribute": "Pas d'historique dans le broker - il n'en garde pas (TRoE), ou pas pour cet attribut", "No entity has a location": "Aucune entité n'a de position", "history: {why}": "historique : {why}",
      "Rules tenant": "Tenant des règles", "Alarm type": "Type d'alarme", "{n} rules": "{n} règles", "{n} alarms": "{n} alarmes", "{n} new": "{n} nouvelles", "never": "jamais", "disabled": "désactivée", "No rule in this tenant - corCep reads them from the rules tenant (cep)": "Aucune règle dans ce tenant - corCep les lit dans le tenant des règles (cep)", "No alarm": "Aucune alarme", "{n} s ago": "il y a {n} s", "{n} min ago": "il y a {n} min", "{n} h ago": "il y a {n} h", "{n} d ago": "il y a {n} j", "fired": "déclenchée", "last error": "dernière erreur"
    },
    de: {
      "Broker": "Broker", "Tenant": "Tenant", "default": "Standard", "Type": "Typ", "Query (q)": "Abfrage (q)",
      "Attributes (attrs)": "Attribute (attrs)", "every": "alle", "seconds": "Sekunden", "Save": "Speichern", "Edit": "Bearbeiten",
      "Refresh": "Aktualisieren", "Cancel": "Abbrechen",
      "c³ is not reachable - open this dashboard from c³'s Dashboard page": "c³ antwortet nicht - öffnen Sie dieses Dashboard über die Dashboard-Seite von c³",
      "No broker in c³ yet - connect to one in Explore": "Noch kein Broker in c³ - verbinden Sie sich in Erkunden mit einem",
      "{n} entities": "{n} Entitäten", "updated {time}": "aktualisiert {time}", "Not configured": "Nicht konfiguriert",
      "Waiting for entities - wire an NGSI-LD source to this widget": "Warte auf Entitäten - verbinden Sie eine NGSI-LD-Quelle mit diesem Widget",
      "Attribute": "Attribut", "Entity": "Entität", "the first": "die erste", "No such attribute": "Kein solches Attribut",
      "all": "alle", "any type": "jeder Typ", "no value": "kein Wert",
      "Hours": "Stunden", "last {h} h": "letzte {h} h", "No history at the broker - it keeps none (TRoE), or not for this attribute": "Keine Historie im Broker - er speichert keine (TRoE), oder nicht für dieses Attribut", "No entity has a location": "Keine Entität hat einen Ort", "history: {why}": "Historie: {why}",
      "Rules tenant": "Tenant der Regeln", "Alarm type": "Alarmtyp", "{n} rules": "{n} Regeln", "{n} alarms": "{n} Alarme", "{n} new": "{n} neu", "never": "nie", "disabled": "deaktiviert", "No rule in this tenant - corCep reads them from the rules tenant (cep)": "Keine Regel in diesem Tenant - corCep liest sie aus dem Tenant der Regeln (cep)", "No alarm": "Kein Alarm", "{n} s ago": "vor {n} s", "{n} min ago": "vor {n} min", "{n} h ago": "vor {n} h", "{n} d ago": "vor {n} T", "fired": "ausgelöst", "last error": "letzter Fehler"
    }
  };

  function language() {
    try { return String(MashupPlatform.context.get("language") || "en").slice(0, 2); } catch (e) { return "en"; }
  }

  function t(text, args) {
    var table = TEXTS[language()] || {};
    var out = table[text] || text;
    Object.keys(args || {}).forEach(function (k) { out = out.split("{" + k + "}").join(String(args[k])); });
    return out;
  }

  //
  // base - c³'s address: the page's own host, c³'s port from its cookie; null when there is none
  //
  function base() {
    var m = /(?:^|;\s*)c3_port=(\d+)/.exec(document.cookie);
    if (!m) return null;
    return location.protocol + "//" + location.hostname + ":" + m[1];
  }

  function request(path, headers) {
    var b = base();
    if (!b) return Promise.reject(new Error(t("c³ is not reachable - open this dashboard from c³'s Dashboard page")));
    return fetch(b + path, { headers: headers || {}, credentials: "omit" }).then(function (r) {
      return r.text().then(function (text) {
        var body = null;
        try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
        if (!r.ok) {
          var why = (body && (body.detail || body.title)) || ("HTTP " + r.status);
          throw new Error(why);
        }
        return { body: body, count: r.headers.get("NGSILD-Results-Count") };
      });
    }, function () {
      throw new Error(t("c³ is not reachable - open this dashboard from c³'s Dashboard page"));
    });
  }

  //
  // brokers - the brokers c³ knows: [{url, name, tenant, tenants}]
  //
  function brokers() {
    return request("/api/run/dashboard/brokers").then(function (r) { return r.body || []; });
  }

  //
  // get - a GET of the NGSI-LD API at a broker, through c³: {body, count}
  //
  function get(broker, tenant, pathAndQuery) {
    var headers = { "X-C3-Broker": broker, "Accept": "application/json" };
    if (tenant) headers["NGSILD-Tenant"] = tenant;
    return request("/api/proxy" + pathAndQuery, headers);
  }

  //
  // value - an attribute's value, normalized or keyValues: {value, observedAt, unitCode} or null
  //
  function value(entity, attr) {
    if (!entity || !(attr in entity)) return null;
    var a = entity[attr];
    if (Array.isArray(a)) a = a[0];                         // multi-attribute: the first instance
    if (a === null || typeof a !== "object" || !("type" in a)) return { value: a };
    var v = ("value" in a) ? a.value : ("object" in a) ? a.object : ("languageMap" in a) ? a.languageMap :
            ("vocab" in a) ? a.vocab : ("json" in a) ? a.json : ("valueList" in a) ? a.valueList : a;
    return { value: v, observedAt: a.observedAt, unitCode: a.unitCode };
  }

  //
  // show - a value as text: numbers with at most 'decimals' decimals, objects as JSON
  //
  function show(v, decimals) {
    if (v === null || v === undefined) return "-";
    if (typeof v === "number") return (decimals >= 0 && !Number.isInteger(v)) ? v.toFixed(decimals) : String(v);
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  //
  // attributesOf - every attribute name in the entities (not id, type, @context), sorted
  //
  function attributesOf(entities) {
    var seen = {};
    (entities || []).forEach(function (e) {
      Object.keys(e || {}).forEach(function (k) { if (k !== "id" && k !== "type" && k !== "@context") seen[k] = true; });
    });
    return Object.keys(seen).sort();
  }

  //
  // entitiesIn - the entities of an event from a source: {entities: [...]}, an array, or the JSON of either
  //
  function entitiesIn(data) {
    if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { return []; } }
    if (Array.isArray(data)) return data;
    return (data && Array.isArray(data.entities)) ? data.entities : [];
  }

  //
  // fromOf - where an event's entities come from: {broker, tenant, type}, as a source sends them ({} if unknown)
  // withEntities - an event of other entities from the same place
  //
  function fromOf(data) {
    if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { return {}; } }
    if (!data || Array.isArray(data) || typeof data !== "object") return {};
    return { broker: data.broker, tenant: data.tenant, type: data.type };
  }

  function withEntities(from, entities) {
    return { broker: from.broker, tenant: from.tenant, type: from.type, entities: entities };
  }

  //
  // ago - how long ago a time (ms) was, short
  //
  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return t("{n} s ago", { n: s });
    if (s < 3600) return t("{n} min ago", { n: Math.floor(s / 60) });
    if (s < 86400) return t("{n} h ago", { n: Math.floor(s / 3600) });
    return t("{n} d ago", { n: Math.floor(s / 86400) });
  }

  //
  // brokerPicker - a broker select (the brokers c³ knows) and a tenant select (the broker's tenants, the
  // default one, and 'extra' - the rules tenant cep, say); 'current' {broker, tenant}. Resolves when filled.
  //
  function brokerPicker(brokerSel, tenantSel, current, extra) {
    var known = [];
    function option(sel, value, label, selected) {
      var o = el("option", "", label);
      o.value = value;
      if (selected) o.selected = true;
      sel.append(o);
    }
    function tenants() {
      tenantSel.replaceChildren();
      var b = known.filter(function (x) { return x.url === brokerSel.value; })[0];
      var names = (b ? (b.tenants || []).slice() : []).concat(b && b.tenant ? [b.tenant] : [], extra || [], current.tenant ? [current.tenant] : []);
      option(tenantSel, "", t("default"), !current.tenant);
      names.filter(function (n, i) { return n && names.indexOf(n) === i; }).forEach(function (n) { option(tenantSel, n, n, n === current.tenant); });
    }
    brokerSel.addEventListener("change", tenants);
    return brokers().then(function (list) {
      known = list;
      list.forEach(function (b) { option(brokerSel, b.url, b.name, b.url === current.broker); });
      if (current.broker && !list.some(function (b) { return b.url === current.broker; })) option(brokerSel, current.broker, current.broker, true);
      tenants();
      return list;
    });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  return { t: t, base: base, request: request, brokers: brokers, get: get, value: value, show: show, attributesOf: attributesOf, entitiesIn: entitiesIn, fromOf: fromOf, withEntities: withEntities, ago: ago, brokerPicker: brokerPicker, el: el };
})();
