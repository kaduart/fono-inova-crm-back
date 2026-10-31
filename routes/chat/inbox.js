import ChatProjection from '../../models/ChatProjection.js';
import Leads from '../../models/Leads.js';

// Contexto comercial de cada conversa (Lead ou Paciente, origem, etapa, interesse) para a tela
// de Conversas. Uma consulta só, com $in nos leadIds da página; só leitura.
async function attachLeadContext(chats) {
  const ids = chats.map(c => c.leadId).filter(Boolean);
  if (!ids.length) return chats;
  const leads = await Leads.find({ _id: { $in: ids } })
    .select('name origin stage status therapyArea convertedToPatient createdAt qualificationData.extractedInfo.age')
    .lean();
  const byId = new Map(leads.map(l => [String(l._id), l]));
  return chats.map(c => {
    const l = byId.get(String(c.leadId));
    if (!l) return c;
    return {
      ...c,
      lead: {
        origin: l.origin || null,
        stage: l.stage || null,
        status: l.status || null,
        therapyArea: l.therapyArea || null,
        createdAt: l.createdAt || null,
        age: l.qualificationData?.extractedInfo?.age ?? null,
      },
      patientId: l.convertedToPatient ? String(l.convertedToPatient) : null,
    };
  });
}
import { sendApiError } from '../../errors/buildErrorResponse.js';

export async function getChatInbox(req, res) {
  try {
    const { limit = 50, skip = 0, unreadOnly } = req.query;

    const filter = {};
    if (unreadOnly === 'true') {
      filter.unreadCount = { $gt: 0 };
    }

    const parsedLimit = Math.min(Number(limit), 200);
    const parsedSkip = Number(skip);

    const [chats, total] = await Promise.all([
      ChatProjection.find(filter)
        .sort({ lastMessageAt: -1 })
        .skip(parsedSkip)
        .limit(parsedLimit)
        .select('leadId contactId phone contactName lastMessage lastMessageAt lastDirection unreadCount assignedAgentId')
        .lean(),
      ChatProjection.countDocuments(filter),
    ]);

    let data = chats;
    try {
      data = await attachLeadContext(chats);
    } catch (e) {
      // Sem o contexto a caixa de entrada continua funcionando
      console.warn('[chat/inbox] contexto do lead indisponível:', e.message);
    }

    return res.json({
      success: true,
      data,
      pagination: {
        total,
        skip: parsedSkip,
        limit: parsedLimit,
        hasMore: parsedSkip + chats.length < total,
      },
    });
  } catch (err) {
    return sendApiError(res, err, req);
  }
}

export async function markAsRead(req, res) {
  try {
    const { leadId } = req.params;

    await ChatProjection.updateOne({ leadId }, { $set: { unreadCount: 0 } });

    return res.json({ success: true });
  } catch (err) {
    return sendApiError(res, err, req);
  }
}
