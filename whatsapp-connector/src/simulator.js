// whatsapp-connector/src/simulator.js
//
// WhatsApp FALSO no lugar do motor (sem Chrome, sem sessão). Com ele, a API HTTP, a idempotência e o outbox
// são os reais. Serve para os testes e para ensaiar o CRM em modo externo: WA_CONNECTOR_ENGINE=simulator.
//
// Controle do cenário (só no simulador): engine.setReady(bool), engine.failNext('timeout'|'hang'|'network'|
// 'not_connected'|'no_whatsapp'), engine.emitInbound({...}) gera um evento message.inbound pelo sink.

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

export default { createFakeEngine };
