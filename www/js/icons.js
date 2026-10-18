//
// icons.js - a marker per kind of entity, and a colour for its state
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The kind comes from the type's name (the last part of an expanded IRI), by the rules below - the Smart
// Data Models' names and the obvious others; a type no rule knows stays a dot. The state colours a marker
// over its type's colour: a status that says it is broken red, a powerState "on" warm yellow, an
// airQualityLevel on its scale.
//
// The images are drawn here, on a canvas, the first time the map draws one: one per (glyph, colour), named
// c3i-<glyph>-<colour>.
//
const RULES = [
  [/^(bus|coach|tram|trolleybus)$/i, 'bus'],
  [/(bus|tram|transit)?stop$|^(busstop|stoppoint|platform)$/i, 'stop'],
  [/street ?light|street ?lamp|^lamp(post)?$|luminaire/i, 'light'],
  [/air ?quality/i, 'air'],
  [/weather/i, 'weather'],
  [/traffic/i, 'traffic'],
  [/^(person|driver|user|employee)$/i, 'person'],
  [/vehicle|car$|^truck$/i, 'bus'],
];

const BROKEN = /^(broken|faulty|fault|failure|failed|outoforder|out[-_ ]?of[-_ ]?order|defective|error)$/i;
const AIR = { good: '#6FDCA0', moderate: '#F2B84B', poor: '#F59E6B', unhealthy: '#F59E6B', verypoor: '#FF5A6E', bad: '#FF5A6E', hazardous: '#C04BFF' };

export const RED = '#FF5A6E';
export const WARM = '#FFD36B';

const typeName = (t) => {
  const m = String(t).match(/[#/]([^#/]+)$/);
  return m && /^https?:/.test(t) ? m[1] : String(t);
};

const valueOf = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? ('value' in v ? v.value : v.vocab) : v);

//
// glyphOf - the glyph of an entity's type, null: a dot
//
export function glyphOf(e) {
  const types = Array.isArray(e.type) ? e.type : [e.type];
  for (const t of types) {
    const name = typeName(t);
    for (const [re, glyph] of RULES) if (re.test(name)) return glyph;
  }
  return null;
}

//
// stateColor - the colour an entity's state gives its marker, null: its type's
//
export function stateColor(e) {
  const status = valueOf(e.status);
  if (typeof status === 'string' && BROKEN.test(status)) return RED;
  const level = valueOf(e.airQualityLevel);
  if (typeof level === 'string' && AIR[level.toLowerCase()]) return AIR[level.toLowerCase()];
  if (valueOf(e.congested) === true) return RED;
  const power = valueOf(e.powerState);
  if (typeof power === 'string' && power.toLowerCase() === 'on') return WARM;
  return null;
}

//
// imageName - the map image of a glyph in a colour
//
export const imageName = (glyph, color) => `c3i-${glyph}-${color.replace('#', '')}`;

//
// draw - the image: a disc in the colour, the glyph on it in dark ink
//
const S = 48;                                    // drawn at pixelRatio 2: 24 px on the map

function glyph(g, kind) {
  g.fillStyle = '#0E1014';
  g.strokeStyle = '#0E1014';
  g.lineWidth = 3;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const rr = (x, y, w, h, r) => { g.beginPath(); g.roundRect(x, y, w, h, r); };
  switch (kind) {
    case 'bus':
      rr(14, 11, 20, 24, 4); g.fill();
      g.fillStyle = '#F3F4F6';
      rr(17, 14, 14, 8, 1.5); g.fill();
      g.fillStyle = '#0E1014';
      g.fillRect(15, 34, 5, 4); g.fillRect(28, 34, 5, 4);
      g.fillStyle = '#F3F4F6';
      g.beginPath(); g.arc(18.5, 29, 1.8, 0, 7); g.arc(29.5, 29, 1.8, 0, 7); g.fill();
      break;
    case 'stop':
      g.fillRect(22.5, 20, 3, 18);
      rr(14, 9, 20, 13, 3); g.fill();
      g.fillStyle = '#F3F4F6';
      g.font = 'bold 10px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('H', 24, 16);
      break;
    case 'light':
      g.beginPath(); g.moveTo(24, 38); g.lineTo(24, 18); g.quadraticCurveTo(24, 11, 31, 11); g.stroke();
      g.beginPath(); g.moveTo(27, 13); g.lineTo(36, 13); g.lineTo(34, 18); g.lineTo(29, 18); g.closePath(); g.fill();
      g.fillRect(19, 37, 10, 2.5);
      break;
    case 'air':
      for (const y of [16, 24, 32]) {
        g.beginPath(); g.moveTo(12, y);
        g.bezierCurveTo(17, y - 4, 21, y + 4, 26, y);
        g.bezierCurveTo(30, y - 3, 33, y - 1, 36, y - 2);
        g.stroke();
      }
      break;
    case 'weather':
      g.beginPath(); g.arc(20, 19, 6, 0, 7); g.fill();
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        g.beginPath(); g.moveTo(20 + Math.cos(a) * 9, 19 + Math.sin(a) * 9); g.lineTo(20 + Math.cos(a) * 11.5, 19 + Math.sin(a) * 11.5); g.lineWidth = 2; g.stroke();
      }
      g.fillStyle = '#F3F4F6';
      g.beginPath(); g.arc(26, 30, 6, 0, 7); g.arc(32, 27, 6, 0, 7); g.arc(36, 32, 4.5, 0, 7); g.rect(24, 30, 13, 6.5); g.fill();
      g.lineWidth = 1.6; g.strokeStyle = '#0E1014';
      g.beginPath(); g.arc(26, 30, 6, Math.PI * 0.5, Math.PI * 1.4); g.stroke();
      break;
    case 'traffic':
      rr(17, 8, 14, 32, 4); g.fill();
      for (const [y, c] of [[14.5, '#FF5A6E'], [24, '#F2B84B'], [33.5, '#6FDCA0']]) { g.fillStyle = c; g.beginPath(); g.arc(24, y, 3.4, 0, 7); g.fill(); }
      break;
    case 'person':
      g.beginPath(); g.arc(24, 17, 6, 0, 7); g.fill();
      g.beginPath(); g.moveTo(13, 37); g.quadraticCurveTo(13, 26, 24, 26); g.quadraticCurveTo(35, 26, 35, 37); g.closePath(); g.fill();
      break;
  }
}

export function drawImage(kind, color) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.fillStyle = color;
  g.strokeStyle = '#0E1014';
  g.lineWidth = 2.5;
  g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 2, 0, 7); g.fill(); g.stroke();
  g.save();
  glyph(g, kind);
  g.restore();
  return g.getImageData(0, 0, S, S);
}

//
// parseImageName - c3i-bus-5FB4E8 -> {glyph: 'bus', color: '#5FB4E8'}; null: not one of these
//
export function parseImageName(name) {
  const m = /^c3i-([a-z]+)-([0-9A-Fa-f]{6})$/.exec(name);
  return m ? { glyph: m[1], color: '#' + m[2] } : null;
}
