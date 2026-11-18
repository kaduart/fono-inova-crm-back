// whatsapp-connector/eventOutbox.js
//
// Fila em disco dos eventos conector → CRM. Um evento só sai da fila quando o CRM responde 2xx.
//   - CRM fora do ar / 5xx / rede: tenta de novo com espera crescente (1 s … 5 min) e jitter;
//   - 4xx (exceto 408/429): o lote é recusado de vez → vai para o arquivo de descarte (dead letter), com log;
//   - eventId repetido na fila é ignorado (o mesmo evento relido no catch-up não duplica);
//   - reinício do conector: a fila volta do disco.
// O CRM também deduplica por eventId, então reentregar após um timeout é seguro.

import fs from 'fs';
import path from 'path';
import { signRequest, SIGNATURE_HEADER } from './contract.js';

export class EventOutbox {
  constructor({
    file = null,
    deadLetterFile = null,
    url,
    secret,
    fetchImpl = globalThis.fetch,
    maxQueue = 20_000,
    batchSize = 50,
    timeoutMs = 15_000,
    minBackoffMs = 1_000,
    maxBackoffMs = 5 * 60_000,
    now = () => Date.now(),
    logger = console,
    random = Math.random,
  } = {}) {
    Object.assign(this, { file, deadLetterFile, url, secret, fetchImpl, maxQueue, batchSize, timeoutMs, minBackoffMs, maxBackoffMs, now, log: logger, random });
    this.queue = [];
    this.ids = new Set();
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.timer = null;
    this.flushing = null;
    this.stats = { delivered: 0, deadLettered: 0, dropped: 0, lastError: null, lastDeliveredAt: null };
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8')) || [];
      for (const e of rows) if (e?.eventId && !this.ids.has(e.eventId)) { this.queue.push(e); this.ids.add(e.eventId); }
      if (this.queue.length) this.log.info?.(`[Connector] 📬 outbox: ${this.queue.length} eventos pendentes recuperados do disco`);
    } catch (err) {
      try { fs.copyFileSync(this.file, `${this.file}.corrupt-${this.now()}`); } catch { /* segue */ }
      this.log.error?.('[Connector] ❌ outbox ilegível, começando vazio:', err.message);
    }
  }

  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.queue));
    fs.renameSync(tmp, this.file);
  }

  get size() { return this.queue.length; }

  /** Põe o evento na fila (idempotente por eventId) e agenda a entrega. */
  enqueue(evt) {
    if (!evt?.eventId || this.ids.has(evt.eventId)) return false;
    if (this.queue.length >= this.maxQueue) {
      const old = this.queue.shift();
      this.ids.delete(old.eventId);
      this.stats.dropped++;
      this.log.error?.(`[Connector] ⚠️ outbox cheia (${this.maxQueue}): descartado o evento mais antigo ${old.eventId}`);
    }
    this.queue.push(evt);
    this.ids.add(evt.eventId);
    this.persist();
    this.schedule(0);
    return true;
  }

  backoffMs() {
    const base = Math.min(this.maxBackoffMs, this.minBackoffMs * 2 ** Math.max(0, this.failures - 1));
    return Math.round(base * (0.8 + 0.4 * this.random()));
  }

  schedule(delayMs) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const wait = Math.max(delayMs, this.nextAttemptAt - this.now(), 0);
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => {}); }, wait);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  deadLetter(batch, reason) {
    this.stats.deadLettered += batch.length;
    this.log.error?.(`[Connector] ☠️ CRM recusou ${batch.length} evento(s) (${reason}) — guardados no descarte`);
    if (!this.deadLetterFile) return;
    try {
      fs.mkdirSync(path.dirname(this.deadLetterFile), { recursive: true });
      fs.appendFileSync(this.deadLetterFile, batch.map((e) => JSON.stringify({ reason, at: new Date(this.now()).toISOString(), event: e })).join('\n') + '\n');
    } catch (err) {
      this.log.error?.('[Connector] ❌ não consegui gravar o descarte:', err.message);
    }
  }

  removeDelivered(batch) {
    const done = new Set(batch.map((e) => e.eventId));
    this.queue = this.queue.filter((e) => !done.has(e.eventId));
    for (const id of done) this.ids.delete(id);
    this.persist();
  }

  /** Entrega um lote. Devolve 'empty' | 'delivered' | 'retry' | 'dead'. Uma entrega por vez. */
  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      if (!this.queue.length) return 'empty';
      if (this.now() < this.nextAttemptAt) { this.schedule(0); return 'retry'; }
      const batch = this.queue.slice(0, this.batchSize);
      const body = JSON.stringify({ events: batch });
      const u = new URL(this.url);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
      let status = 0;
      try {
        const res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SIGNATURE_HEADER]: signRequest(this.secret, { method: 'POST', path: u.pathname + u.search, body, now: this.now() }) },
          body,
          signal: ctrl.signal,
        });
        status = res.status;
      } catch (err) {
        this.stats.lastError = err?.name === 'AbortError' ? 'timeout' : (err?.code || err?.message || String(err));
      } finally {
        clearTimeout(t);
      }

      if (status >= 200 && status < 300) {
        this.removeDelivered(batch);
        this.failures = 0;
        this.nextAttemptAt = 0;
        this.stats.delivered += batch.length;
        this.stats.lastDeliveredAt = new Date(this.now()).toISOString();
        this.stats.lastError = null;
        if (this.queue.length) this.schedule(0);
        return 'delivered';
      }
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        this.removeDelivered(batch);
        this.deadLetter(batch, `HTTP ${status}`);
        if (this.queue.length) this.schedule(0);
        return 'dead';
      }
      if (status) this.stats.lastError = `HTTP ${status}`;
      this.failures++;
      const wait = this.backoffMs();
      this.nextAttemptAt = this.now() + wait;
      if (this.failures === 1 || this.failures % 10 === 0) {
        this.log.warn?.(`[Connector] 📭 CRM indisponível (${this.stats.lastError}); ${this.queue.length} evento(s) na fila, nova tentativa em ${Math.round(wait / 1000)}s`);
      }
      this.schedule(wait);
      return 'retry';
    })();
    try { return await this.flushing; } finally { this.flushing = null; }
  }
}

export default EventOutbox;
