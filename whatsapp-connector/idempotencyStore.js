// whatsapp-connector/idempotencyStore.js
//
// Guarda o resultado de cada envio por requestId, em disco, para que uma repetição do CRM (retry, timeout,
// reinício de qualquer um dos lados) NUNCA mande a mesma mensagem duas vezes.
//   - mesmo requestId, mesmo conteúdo  → devolve o resultado guardado (não envia de novo);
//   - mesmo requestId, conteúdo diferente → conflito (erro do chamador);
//   - envio que estava "in_progress" quando o processo caiu → vira "unknown" ao subir (pode ter saído).
// Gravação atômica (arquivo temporário + rename). Expira em `ttlMs` (padrão 7 dias).

import fs from 'fs';
import path from 'path';
import { SendState, sha256hex } from '../services/whatsappConnector/contract.js';

export function payloadFingerprint(payload) {
  return sha256hex(JSON.stringify(payload ?? null));
}

export class IdempotencyStore {
  constructor({ file, ttlMs = 7 * 24 * 3600 * 1000, now = () => Date.now(), logger = console } = {}) {
    this.file = file || null;
    this.ttlMs = ttlMs;
    this.now = now;
    this.log = logger;
    this.map = new Map();
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      let recovered = 0;
      for (const r of rows || []) {
        if (r.state === SendState.IN_PROGRESS) {
          // Caiu no meio: não dá para saber se o WhatsApp aceitou. Nunca repetir sozinho.
          r.state = SendState.UNKNOWN;
          r.error = 'conector reiniciou durante o envio';
          r.updatedAt = this.now();
          recovered++;
        }
        this.map.set(r.requestId, r);
      }
      if (recovered) this.persist();
      this.log.info?.(`[Connector] 🗂️ idempotência: ${this.map.size} envios carregados (${recovered} incertos por reinício)`);
    } catch (err) {
      // Arquivo corrompido: guarda uma cópia e segue vazio (melhor que travar o conector).
      try { fs.copyFileSync(this.file, `${this.file}.corrupt-${this.now()}`); } catch { /* segue */ }
      this.log.error?.('[Connector] ❌ idempotência ilegível, começando vazio:', err.message);
    }
  }

  persist() {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify([...this.map.values()]));
    fs.renameSync(tmp, this.file);
  }

  prune() {
    const limit = this.now() - this.ttlMs;
    let n = 0;
    for (const [id, r] of this.map) {
      if (r.state !== SendState.IN_PROGRESS && (r.updatedAt || 0) < limit) { this.map.delete(id); n++; }
    }
    if (n) this.persist();
    return n;
  }

  get(requestId) {
    return this.map.get(requestId) || null;
  }

  /**
   * Reserva o requestId. { reserved: true } quando é a primeira vez (o chamador envia);
   * senão { reserved: false, record } com o que já existe, ou { conflict: true }.
   */
  begin(requestId, fingerprint) {
    const existing = this.map.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { reserved: false, conflict: true, record: existing };
      return { reserved: false, record: existing };
    }
    const rec = { requestId, fingerprint, state: SendState.IN_PROGRESS, createdAt: this.now(), updatedAt: this.now() };
    this.map.set(requestId, rec);
    this.persist();
    return { reserved: true, record: rec };
  }

  finish(requestId, state, fields = {}) {
    const rec = this.map.get(requestId);
    if (!rec) return null;
    Object.assign(rec, fields, { state, updatedAt: this.now() });
    this.persist();
    return rec;
  }

  /** Libera o requestId depois de uma falha que PROVA que nada saiu: o CRM pode tentar de novo depois. */
  release(requestId) {
    if (this.map.delete(requestId)) this.persist();
  }
}

export default IdempotencyStore;
