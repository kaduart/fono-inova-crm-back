// Código ANTIGO (antes da posse), copiado do commit 12bd210 para os testes de
// versões mistas. Só o comportamento que importa aqui; não usar em produção.
//   - processWithGuarantees: marca 'processing' sem token, executa, marca
//     'processed' sem condição (event.markProcessed → save).
//   - reapStuckEvents: devolve para 'pending' TODO 'processing' criado há mais
//     de 15 min, sem olhar posse nem prazo.
import EventStore from '../../../models/EventStore.js';

export async function legacyProcessWithGuarantees(event, processor, workerName) {
  const { eventId } = event;
  await EventStore.updateOne({ eventId }, { $set: { status: 'processing' } });
  const result = await processor(event);
  const doc = await EventStore.findOne({ eventId });
  await doc.markProcessed(workerName);
  return { success: true, result };
}

export async function legacyReapStuckEvents({ now = new Date() } = {}) {
  const threshold = new Date(now.getTime() - 15 * 60 * 1000);
  const stuck = await EventStore.find({ status: 'processing', createdAt: { $lt: threshold } }).limit(100).lean();
  for (const e of stuck) {
    await EventStore.updateOne({ eventId: e.eventId }, {
      $set: { status: e.attempts < 3 ? 'pending' : 'failed', error: { message: 'Auto-recovered from stuck processing after 15min', recoveredBy: 'eventReaper' } }
    });
  }
  return { total: stuck.length };
}
