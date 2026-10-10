//
// api.js - the c3 backend's API
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//

async function json(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { title: 'Not JSON', detail: text.slice(0, 300) }; }
}

async function call(method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await fetch(path, init);
  const data = await json(response);
  if (!response.ok) {
    const error = new Error((data && (data.detail || data.title)) || ('HTTP ' + response.status));
    error.status = response.status;
    throw error;
  }
  return data;
}

export const status       = () => call('GET', '/api/status');
export const config       = () => call('GET', '/api/config');
export const brokerTouch  = (url, name) => call('POST', '/api/brokers', name ? { url, name } : { url });
export const brokerForget = (url) => call('DELETE', '/api/brokers', { url });
export const uiSet        = (ui) => call('PUT', '/api/ui', ui);
export const brokerTypes  = (url, types) => call('PUT', '/api/brokers/types', { url, types });
export const brokerConnect = (url, patch) => call('PUT', '/api/brokers/connect', { url, ...patch });

//
// The map's downloaded areas
//
export const maps         = () => call('GET', '/api/maps');
export const mapsEstimate = (bbox, maxzoom) => call('POST', '/api/maps/estimate', { bbox, maxzoom });
export const mapsDownload = (name, bbox, maxzoom) => call('POST', '/api/maps/download', { name, bbox, maxzoom });
export const mapsProgress = () => call('GET', '/api/maps/download');
export const mapsCancel   = () => call('DELETE', '/api/maps/download');
export const mapsDelete   = (id) => call('DELETE', '/api/maps/areas', { id });

//
// Compile: what this machine can do, the feature switches, the builds (compile.c); the choice and the
// presets (c3.json)
//
export const capabilities        = () => call('GET', '/api/capabilities');
export const compileFeatures     = () => call('GET', '/api/compile/features');
export const compileChoice       = (choice) => call('PUT', '/api/compile/choice', choice);
export const compilePresetSave   = (preset) => call('PUT', '/api/compile/presets', preset);
export const compilePresetDelete = (name) => call('DELETE', '/api/compile/presets', { name });
export const buildCommand        = (body) => call('POST', '/api/builds/command', body);
export const buildStart          = (body) => call('POST', '/api/builds', body);
export const builds              = () => call('GET', '/api/builds');
export const build               = (name) => call('GET', '/api/builds/' + encodeURIComponent(name));
export const buildDelete         = (name) => call('DELETE', '/api/builds/' + encodeURIComponent(name));

//
// brokerGet - a GET to the broker, through the backend's proxy
//
// pathAndQuery starts with /ngsi-ld/ or is /version. The answer:
//   { ok, status, headers, body, reached }
// reached is false when the backend could not reach the broker at all (the proxy's own 502); body is
// the parsed JSON, or null.
//
export async function brokerGet(broker, pathAndQuery) {
  let response;
  try {
    response = await fetch('/api/proxy' + pathAndQuery, { headers: { 'X-C3-Broker': broker } });
  } catch (e) {
    return { ok: false, status: 0, headers: new Headers(), body: { title: 'c3 backend not reachable', detail: String(e.message || e) }, reached: false };
  }
  const body = await json(response);
  const reached = !(body && body.broker === false);
  return { ok: response.ok, status: response.status, headers: response.headers, body, reached };
}
