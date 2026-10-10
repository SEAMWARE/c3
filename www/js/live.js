//
// live.js - live values: the backend's WebSocket (GET /api/live) and the broker's notifications on it,
// handed on in batches
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// The page says what it shows - watch(broker, types) - and the backend keeps one subscription for it on
// the broker: over the broker's WebSocket transport when it has one, else an HTTP subscription that
// notifies the backend. Either way the notifications arrive here, as {"op": "notify", "broker",
// "message": {"body": <Notification>}}.
//
// Nothing is drawn per notification: the entities that changed are gathered - several notifications of
// one entity merged into one change - and handed to onBatch every INTERVAL ms at most.
//
const INTERVAL = 250;
const NULL_URN = 'urn:ngsi-ld:null';

//
// isNullAttr - an attribute a notification reports deleted (TS 104 175 clause 10.5.7)
//
export function isNullAttr(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const k of ['value', 'object', 'objectList', 'valueList', 'vocab', 'json']) if (v[k] === NULL_URN) return true;
  return !!(v.languageMap && v.languageMap['@none'] === NULL_URN);
}

//
// merge - two notified states of one entity, the later one 'b' winning: a deletion replaces, attributes add up
//
function merge(a, b) {
  if (!a || b.deletedAt || a.deletedAt) return b;
  return { ...a, ...b };
}

export class Live {
  constructor({ onBatch, onStatus }) {
    this.onBatch = onBatch;                      // ([entity]) - each the entity as notified; deletedAt set when deleted
    this.onStatus = onStatus;                    // ({mode, broker, subscription, types, why, detail})
    this.want = null;                            // {broker, types}
    this.ws = null;
    this.ready = false;
    this.pending = new Map();
    this.timer = null;
    this.retry = 1000;
    this.open();

    //
    // Leaving the page closes the socket - the backend then deletes the subscription. Without it a page
    // kept in the back/forward cache keeps its socket, and the subscription, open.
    //
    window.addEventListener('pagehide', () => this.close());
    window.addEventListener('pageshow', (e) => { if (e.persisted && !this.ws) this.open(); });
  }

  close() {
    clearTimeout(this.reopenTimer);
    clearTimeout(this.lostTimer);
    clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws) ws.close(1000);
  }

  open() {
    let ws;
    try {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live`);
    } catch {
      this.reopen();
      return;
    }
    this.ws = ws;
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.op === 'hello') {
        this.ready = true;
        this.retry = 1000;
        this.send();
      } else if (m.op === 'status') {
        if (!this.want || m.broker !== this.want.broker) return;
        //
        // No subscription for types to watch: the broker refused it or is gone - asked again in a while
        //
        if (!m.subscription && (m.types || []).length) {
          m.retrying = true;
          clearTimeout(this.lostTimer);
          this.lostTimer = setTimeout(() => this.send(), 5000);
        }
        this.onStatus(m);
      } else if (m.op === 'notify') {
        if (!this.want || m.broker !== this.want.broker) return;
        const data = m.message && m.message.body && m.message.body.data;
        if (!Array.isArray(data)) return;
        for (const d of data) if (d && typeof d.id === 'string') this.pending.set(d.id, merge(this.pending.get(d.id), d));
        if (!this.timer) this.timer = setTimeout(() => this.flush(), INTERVAL);
      } else if (m.op === 'lost') {
        //
        // The broker closed its WebSocket (stopped, restarted): watch again in a while
        //
        if (this.want && m.broker === this.want.broker) {
          this.onStatus({ mode: 'off', broker: m.broker, detail: m.detail, retrying: true });
          clearTimeout(this.lostTimer);
          this.lostTimer = setTimeout(() => this.send(), 3000);
        }
      } else if (m.op === 'error') console.warn('c3 live:', m.detail);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ready = false;
      this.ws = null;
      if (this.want) this.onStatus({ mode: 'off', broker: this.want.broker, detail: 'the connection to the c³ backend is closed', retrying: true });
      this.reopen();
    };
  }

  reopen() {
    clearTimeout(this.reopenTimer);
    this.reopenTimer = setTimeout(() => this.open(), this.retry);
    this.retry = Math.min(this.retry * 2, 10000);
  }

  send() {
    if (!this.ready || !this.ws) return;
    const msg = this.want ? { op: 'watch', broker: this.want.broker, types: this.want.types } : { op: 'unwatch' };
    this.ws.send(JSON.stringify(msg));
  }

  //
  // watch - the entities of 'types' on 'broker'; the same again is not sent again
  //
  watch(broker, types) {
    const t = [...types].sort();
    if (this.want && this.want.broker === broker && JSON.stringify(this.want.types) === JSON.stringify(t)) return;
    this.want = { broker, types: t };
    clearTimeout(this.lostTimer);
    this.pending.clear();
    this.send();
  }

  unwatch() {
    if (!this.want) return;
    this.want = null;
    clearTimeout(this.lostTimer);
    this.pending.clear();
    this.send();
  }

  flush() {
    this.timer = null;
    if (!this.pending.size) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    this.onBatch(batch);
  }
}
