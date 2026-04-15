import Message from '../../models/Message.js';

export async function getChatMessages(req, res) {
  try {
    const { leadId } = req.params;
    const { cursor, limit = 30 } = req.query;

    if (!leadId) {
      return res.status(400).json({ success: false, error: 'leadId required' });
    }

    const query = { lead: leadId };

    // Cursor-based pagination: busca mensagens anteriores ao cursor (_id decrescente)
    if (cursor) {
      query._id = { $lt: cursor };
    }

    const messages = await Message.find(query)
      .sort({ _id: -1 })
      .limit(Math.min(Number(limit), 100))
      .select('waMessageId from to direction type content mediaUrl caption status timestamp createdAt')
      .lean();

    const ordered = messages.reverse(); // ordem cronológica para o chat

    return res.json({
      success: true,
      data: ordered,
      nextCursor: messages.length === Number(limit)
        ? messages[messages.length - 1]._id  // já revertido: messages (desc) o último é o mais antigo
        : null,
      hasMore: messages.length === Number(limit),
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
