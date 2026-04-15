/**
 * Backfill ChatProjection
 *
 * Popula o read model ChatProjection com dados históricos de Message + Lead.
 * Roda uma única vez (ou quando quiser re-sincronizar).
 *
 * POST /api/v2/chat/backfill   (requer auth)
 */

import Lead from '../../models/Leads.js';
import Message from '../../models/Message.js';
import ChatProjection from '../../models/ChatProjection.js';
import logger from '../../utils/logger.js';

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

export async function backfillChatProjection(req, res) {
  try {
    const leadsWithMessages = await Message.distinct('lead');

    logger.info(`[Backfill] ${leadsWithMessages.length} leads com mensagens encontrados`);

    let updated = 0;
    let skipped = 0;

    for (const leadId of leadsWithMessages) {
      if (!leadId) { skipped++; continue; }

      const lastMsg = await Message.findOne({ lead: leadId })
        .sort({ _id: -1 })
        .select('content type direction timestamp createdAt from to')
        .lean();

      if (!lastMsg) { skipped++; continue; }

      // Lead tem contact como subdocumento embutido { phone, name }
      const lead = await Lead.findById(leadId)
        .select('contact')
        .lean();

      const phone = lead?.contact?.phone || lastMsg.from || lastMsg.to || '';
      const contactName = lead?.contact?.name || '';

      const unreadCount = await Message.countDocuments({
        lead: leadId,
        direction: 'inbound',
      });

      await ChatProjection.updateOne(
        { leadId: leadId.toString() },
        {
          $set: {
            leadId: leadId.toString(),
            phone,
            contactName,
            lastMessage: truncate(lastMsg.content || '', 200),
            lastMessageAt: new Date(lastMsg.timestamp || lastMsg.createdAt || Date.now()),
            lastDirection: lastMsg.direction || 'inbound',
            lastMessageType: lastMsg.type || 'text',
            unreadCount,
            updatedAt: new Date(),
          },
        },
        { upsert: true }
      );

      updated++;
    }

    logger.info(`[Backfill] Concluído: ${updated} atualizados, ${skipped} ignorados`);

    return res.json({
      success: true,
      updated,
      skipped,
      total: leadsWithMessages.length,
    });
  } catch (err) {
    logger.error('[Backfill] Erro:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
