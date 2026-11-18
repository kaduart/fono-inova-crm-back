// services/whatsappDeepScan.js
//
// Parte de BANCO da varredura profunda de interesse em convênio (lista de interesse do ERP).
// A leitura do WhatsApp vem de `readBatch` — no modo local, readDeepScanBatch do whatsappWebJsService;
// no modo externo, o conector (POST /v1/scans/deep-batch). Mesmas contas e gravações nos dois casos.
// 18/11/2026: separado de whatsappWebJsService.scanConvenioInterestDeep (sem mudança de regra).

/**
 * @param {{ readBatch: (p: {startIndex:number,batchSize:number,since:Date,maxLoadsPerChat:number}) => Promise<{
 *            total:number, nextIndex:number, rows:Array, unresolved:number, loadErrors:number, oldest:number|null }>,
 *           startIndex?: number, since?: Date, batchSize?: number, maxLoadsPerChat?: number,
 *           onBatch?: (p: object) => Promise<void>, pauseMs?: number }} opts
 */
export async function runDeepConvenioScan({
  readBatch,
  startIndex = 0,
  since = new Date(Date.now() - 3 * 365 * 24 * 3600 * 1000),
  batchSize = 20,
  maxLoadsPerChat = 80,
  onBatch,
  pauseMs = 500,
} = {}) {
  if (typeof readBatch !== 'function') throw new Error('readBatch é obrigatório');
  const { groupHitsByContact, recordWhatsappInterest } = await import('./convenioWaitlistWhatsapp.js');

  let stats = null;
  let i = startIndex;
  for (;;) {
    const res = await readBatch({ startIndex: i, batchSize, since, maxLoadsPerChat });
    if (!stats) {
      stats = { total: res.total, done: Math.min(startIndex, res.total), messages: 0, contacts: 0, created: 0, updated: 0, closed: 0, invalid: 0, unresolved: 0, loadErrors: 0, oldest: null, byConvenio: {} };
      console.log(`[WhatsAppWeb] 🔎 varredura profunda: ${res.total} conversas (começando em ${startIndex})`);
    }
    if (i >= res.total) break;

    stats.unresolved += res.unresolved || 0;
    stats.loadErrors += res.loadErrors || 0;
    if (res.oldest && (!stats.oldest || res.oldest * 1000 < new Date(stats.oldest).getTime())) stats.oldest = new Date(res.oldest * 1000).toISOString();
    const hits = (res.rows || []).map((r) => ({ phone: r.phone, convenio: r.convenio, fromMe: r.fromMe, body: r.body, at: new Date(r.t * 1000), name: r.name }));
    stats.messages += hits.length;
    for (const c of groupHitsByContact(hits)) {
      stats.contacts++;
      stats.byConvenio[c.convenio] = (stats.byConvenio[c.convenio] || 0) + 1;
      try {
        const r = await recordWhatsappInterest({ ...c, capturedBy: 'scan' });
        stats[r.result] = (stats[r.result] || 0) + 1;
      } catch (err) {
        stats.invalid++;
        console.warn('[WhatsAppWeb] ⚠️ falha ao gravar interessado (segue):', err?.message);
      }
    }
    stats.done = Math.min(res.nextIndex, res.total);
    if (onBatch) await onBatch({ nextIndex: stats.done, stats: { ...stats } });
    if (stats.done % 200 < batchSize) console.log('[WhatsAppWeb] 🔎 varredura profunda:', JSON.stringify(stats));
    i = res.nextIndex;
    if (i >= res.total) break;
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs)); // folga para os envios da fila whatsapp-send
  }
  console.log('[WhatsAppWeb] 🔎 varredura profunda concluída:', JSON.stringify(stats));
  return stats;
}

export default { runDeepConvenioScan };
