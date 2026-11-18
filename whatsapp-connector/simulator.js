// whatsapp-connector/simulator.js
//
// Simulador do conector: a MESMA API HTTP (app.js, idempotência e outbox reais), com um WhatsApp falso
// no lugar do Chrome. Serve para os testes e para ensaiar o CRM em modo externo sem tocar na sessão real.
//
//   node whatsapp-connector/simulator.js          → sobe na porta 8787 (WA_CONNECTOR_SECRET e CRM_EVENTS_URL)
//
// Controle do cenário (só no simulador): engine.setReady(bool), engine.failNext('timeout'|'hang'|'network'|
// 'not_connected'|'no_whatsapp'), engine.emitInbound({...}) gera um evento message.inbound pelo sink.

import { buildEvent } from '../services/whatsappConnector/contract.js';

export function createFakeEngine({ ready = true, latencyMs = 5, now = () => Date.now() } = {}) {
  const state = { ready, sent: [], failQueue: [], seq: 0, sink: null, reconnects: 0, hangs: [] };
  const status = () => ({
    status: state.ready ? 'ready' : 'disconnected', ready: state.ready, authenticated: state.ready,
    qrCode: null, lastDisconnectReason: state.ready ? null : 'simulado', updatedAt: new Date(now()).toISOString(),
  });
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const engine = {
    state,
    setReady(v) { state.ready = Boolean(v); },
    failNext(kind) { state.failQueue.push(kind); },
    setSink(fn) { state.sink = fn; },
    emit(type, data) { state.sink?.(type, data); },
    emitInbound(data) { engine.emit('message.inbound', { source: 'live', ...data }); },

    async getStatus() { return status(); },
    async sendMessage(phone, text, opts = {}) {
      if (!state.ready) throw new Error('WhatsApp não está conectado');
      if (!/^\d{10,13}$/.test(String(phone))) throw new Error(`Número inválido: ${phone}`);
      const fail = state.failQueue.shift();
      if (fail === 'not_connected') throw new Error('WhatsApp não está conectado');
      if (fail === 'no_whatsapp') throw new Error(`Número ${phone} não possui WhatsApp`);
      if (fail === 'network') { state.sent.push({ phone, text, opts, ghost: true }); throw new Error('Protocol error (Runtime.callFunctionOn): Target closed'); }
      if (fail === 'hang') {
        // Fica pendurado até o teste liberar: simula o Chrome travado no meio do envio.
        return new Promise((resolve) => state.hangs.push(() => {
          const messageId = `true_${phone}@c.us_SIM${++state.seq}`;
          state.sent.push({ phone, text, opts, messageId });
          resolve({ success: true, messageId });
        }));
      }
      await delay(latencyMs);
      const messageId = `true_${phone}@c.us_SIM${++state.seq}`;
      state.sent.push({ phone, text, opts, messageId });
      return { success: true, messageId };
    },
    async getChatActivity() { if (!state.ready) throw new Error('WhatsApp não está conectado'); return { exists: true, clinicAt: null, contactAt: new Date(now() - 3600_000) }; },
    async readChatActivity() { if (!state.ready) throw new Error('WhatsApp não está conectado'); return { chats: 1, unresolved: 0, rows: [{ phone: '5562999990000', clinicAt: null, contactAt: new Date(now()) }] }; },
    async readDeepScanBatch({ startIndex = 0, batchSize = 20 }) {
      if (!state.ready) throw new Error('WhatsApp não está conectado');
      const total = 3;
      const rows = startIndex === 0 ? [{ phone: '5562999990000', convenio: 'geap', fromMe: false, body: 'tenho geap', t: Math.floor(now() / 1000), name: 'Teste' }] : [];
      return { total, nextIndex: Math.min(startIndex + batchSize, total), rows, unresolved: 0, loadErrors: 0, oldest: null };
    },
    async resolveLidsToPhones(lids) { return lids.map((lid) => ({ lid, phone: null })); },
    async readPollVotes(ids) { return ids.map((id) => ({ pollMessageId: id, votes: [] })); },
    async reconnect() { state.reconnects++; return { success: true }; },
    async clearSession() { state.ready = false; return { success: true }; },
  };
  return engine;
}

// Execução direta: simulador ouvindo de verdade (para ensaiar o crm-worker em modo externo).
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = await import('path');
  const os = await import('os');
  const { createConnectorApp, listen } = await import('./app.js');
  const { IdempotencyStore } = await import('./idempotencyStore.js');
  const { EventOutbox } = await import('./eventOutbox.js');
  const { secretsFromEnv } = await import('../services/whatsappConnector/contract.js');
  const secret = secretsFromEnv(process.env.WA_CONNECTOR_SECRET || 'simulador');
  const dir = process.env.WA_CONNECTOR_DATA_DIR || path.join(os.tmpdir(), 'wa-connector-sim');
  const engine = createFakeEngine();
  const store = new IdempotencyStore({ file: path.join(dir, 'sends.json') });
  const outbox = process.env.CRM_EVENTS_URL ? new EventOutbox({ file: path.join(dir, 'outbox.json'), url: process.env.CRM_EVENTS_URL, secret }) : null;
  engine.setSink((type, data) => outbox?.enqueue(buildEvent(type, data)));
  const { port } = await listen(createConnectorApp({ engine, store, outbox, secret }), { port: Number(process.env.PORT || 8787) });
  console.log(`[Simulador] conector falso na porta ${port} (dados em ${dir})`);
}

export default { createFakeEngine };
