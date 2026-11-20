//
// views.js - what the graph and the map widgets share: the entities wired to them, gathered from every source,
// and the colours of their types - the same as in c³'s Explore
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// An ES module, beside c3.js (js/common/ in a widget's .wgt); it imports c³'s entity.js, which those two widgets
// pack (their c3-include). C3 (c3.js) is loaded before, as a plain script.
//
/* globals C3 */
import { typesOf, typeColors, PALETTE } from '../entity.js';

//
// Gathered - the entities of the events on an input, kept per place they come from ({broker, tenant, type}):
// an event replaces the entities of its own place only, so two sources wired to one widget (Robots, Docks)
// are shown together. An entity in two places: the one of the event that came last.
//
export class Gathered {
  constructor() {
    this.places = new Map();                     // "broker|tenant|type" -> {from, entities, n}
    this.n = 0;
  }

  add(data) {
    const from = C3.fromOf(data);
    const key = [from.broker || '', from.tenant || '', from.type || ''].join('|');
    //
    // The entities copied into this frame: the wiring hands over WireCloud's own objects (another window), and
    // maplibre's worker transfer refuses an object whose class is not this window's Object
    //
    const entities = JSON.parse(JSON.stringify(C3.entitiesIn(data)));
    this.places.set(key, { from, entities, n: ++this.n });
  }

  //
  // all - the entities, by id: [{entity, from}], sorted by id
  //
  all() {
    const byId = new Map();
    [...this.places.values()].sort((a, b) => a.n - b.n).forEach((p) => {
      p.entities.forEach((e) => { if (e && typeof e.id === 'string') byId.set(e.id, { entity: e, from: p.from }); });
    });
    return [...byId.values()].sort((a, b) => (a.entity.id < b.entity.id ? -1 : a.entity.id > b.entity.id ? 1 : 0));
  }

  //
  // brokers - the {broker, tenant} the entities come from, once each
  //
  brokers() {
    const seen = new Map();
    this.places.forEach((p) => {
      if (p.from.broker) seen.set(p.from.broker + '|' + (p.from.tenant || ''), { broker: p.from.broker, tenant: p.from.tenant || '' });
    });
    return [...seen.values()];
  }
}

//
// Type colours: a type's place in the sorted list of its broker's types (GET /ngsi-ld/v1/types, read once per
// broker and tenant), unless the type has a colour of its own, given in Explore (c³'s brokers list:
// typeColours). Without a broker, or without /types: the types of the entities shown.
//
const typeLists = new Map();                     // "broker|tenant" -> Promise of [type]
let own = null;                                  // Promise of Map broker -> {type: colour}

function typesAt(b) {
  const key = b.broker + '|' + b.tenant;
  if (!typeLists.has(key)) {
    typeLists.set(key, C3.get(b.broker, b.tenant, '/ngsi-ld/v1/types').then((r) => {
      const body = r.body;
      const list = (body && (body.typeList || (Array.isArray(body) ? body.map((x) => x && (x.typeName || x.id)) : null))) || [];
      return list.filter((x) => typeof x === 'string');
    }, () => []));
  }
  return typeLists.get(key);
}

function ownColours() {
  if (!own) {
    own = C3.brokers().then((list) => new Map(list.map((b) => [b.url, b.typeColours || {}])), () => new Map());
  }
  return own;
}

//
// colorer - (type) -> '#rrggbb' for the entities shown ([{entity, from}]) and the brokers they come from
//
export async function colorer(shown, brokers) {
  const lists = await Promise.all(brokers.map(typesAt));
  const types = lists.flat();
  const colours = typeColors(types.length ? types : shown.flatMap((x) => typesOf(x.entity)));
  const mine = new Map();
  const owned = await ownColours();
  brokers.forEach((b) => Object.entries(owned.get(b.broker) || {}).forEach(([t, c]) => mine.set(t, c)));
  return (type) => mine.get(type) || colours.get(type) || PALETTE[0];
}

//
// forget - the brokers' type lists and own colours read again (a refresh)
//
export function forget() {
  typeLists.clear();
  own = null;
}
