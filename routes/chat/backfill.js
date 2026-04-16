/**
 * Backfill ChatProjection
 *
 * Popula o read model ChatProjection com dados históricos de Message + Lead.
 * Roda uma única vez (ou quando quiser re-sincronizar).
 *
 * POST /api/v2/chat/backfill         → processa tudo, responde ao final
 * POST /api/v2/chat/backfill?async=true → responde imediatamente, roda em background
 */

import Lead from '../../models/Leads.js';
import Message from '../../models/Message.js';
import ChatProjection from '../../models/ChatProjection.js';
import logger from '../../utils/logger.js';

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// Estado global simples para acompanhar progresso do backfill em background
const backfillState = { running: false, updated: 0, total: 0, startedAt: null, doneAt: null, error: null };

async function runBackfill() {
  backfillState.running = true;
  backfillState.updated = 0;
  backfillState.startedAt = new Date();
  backfillState.doneAt = null;
  backfillState.error = null;

  try {
    // 1) Última mensagem por lead — UMA aggregation para todos os leads
    const lastMsgPerLead = await Message.aggregate([
      { $sort: { _id: -1 } },
      {
        $group: {
          _id: '$lead',
          content:   { $first: '$content' },
          type:      { $first: '$type' },
          direction: { $first: '$direction' },
          timestamp: { $first: '$timestamp' },
          createdAt: { $first: '$createdAt' },
          from:      { $first: '$from' },
          to:        { $first: '$to' },
        },
      },
      { $match: { _id: { $ne: null } } },
    ]);

    backfillState.total = lastMsgPerLead.length;

    if (lastMsgPerLead.length === 0) {
      backfillState.doneAt = new Date();
      backfillState.running = false;
      return { updated: 0, total: 0 };
    }

    const leadIds = lastMsgPerLead.map((r) => r._id);

    // 2) Contagem inbound por lead — UMA aggregation
    const unreadAgg = await Message.aggregate([
      { $match: { lead: { $in: leadIds }, direction: 'inbound', readAt: null } },
      { $group: { _id: '$lead', count: { $sum: 1 } } },
    ]);
    const unreadMap = new Map(unreadAgg.map((r) => [String(r._id), r.count]));

    // 3) Dados de contato de todos os leads — UMA query
    const leads = await Lead.find({ _id: { $in: leadIds } })
      .select('contact')
      .lean();
    const leadMap = new Map(leads.map((l) => [String(l._id), l]));

    // 4) BulkWrite em lotes de 1000 para não sobrecarregar memória
    const BULK_SIZE = 1000;
    let totalUpdated = 0;

    for (let i = 0; i < lastMsgPerLead.length; i += BULK_SIZE) {
      const batch = lastMsgPerLead.slice(i, i + BULK_SIZE);

      const ops = batch.map((msg) => {
        const leadId = msg._id;
        const lead   = leadMap.get(String(leadId));
        const phone  = lead?.contact?.phone || msg.from || msg.to || '';
        const contactName = lead?.contact?.name || '';
        const unreadCount = unreadMap.get(String(leadId)) ?? 0;

        return {
          updateOne: {
            filter: { leadId },
            update: {
              $set: {
                leadId,
                phone,
                contactName,
                lastMessage:     truncate(msg.content || '', 200),
                lastMessageAt:   new Date(msg.timestamp || msg.createdAt || Date.now()),
                lastDirection:   msg.direction || 'inbound',
                lastMessageType: msg.type || 'text',
                unreadCount,
                updatedAt:       new Date(),
              },
            },
            upsert: true,
          },
        };
      });

      const result = await ChatProjection.bulkWrite(ops, { ordered: false });
      totalUpdated += (result.upsertedCount ?? 0) + (result.modifiedCount ?? 0);
      backfillState.updated = totalUpdated;

      logger.info(`[Backfill] lote ${i + batch.length}/${lastMsgPerLead.length} — ${totalUpdated} gravados`);
    }

    backfillState.doneAt = new Date();
    backfillState.running = false;
    return { updated: totalUpdated, total: lastMsgPerLead.length };

  } catch (err) {
    backfillState.error = err.message;
    backfillState.running = false;
    throw err;
  }
}

export async function backfillChatProjection(req, res) {
  // GET de status
  if (req.method === 'GET' || req.query.status === 'true') {
    return res.json({ success: true, ...backfillState });
  }

  // Modo background: responde imediatamente e roda em segundo plano
  if (req.query.async === 'true') {
    if (backfillState.running) {
      return res.json({ success: false, error: 'Backfill já está rodando', ...backfillState });
    }
    runBackfill().catch((err) => logger.error('[Backfill] Erro em background:', err.message));
    return res.json({ success: true, message: 'Backfill iniciado em background. Consulte GET ?status=true para acompanhar.' });
  }

  // Modo síncrono: processa tudo e responde ao final
  if (backfillState.running) {
    return res.json({ success: false, error: 'Backfill já está rodando', ...backfillState });
  }

  try {
    const { updated, total } = await runBackfill();
    return res.json({ success: true, updated, total, done: true });
  } catch (err) {
    logger.error('[Backfill] Erro:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
