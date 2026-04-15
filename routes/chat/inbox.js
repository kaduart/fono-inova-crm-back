import ChatProjection from '../../models/ChatProjection.js';

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

    return res.json({
      success: true,
      data: chats,
      pagination: {
        total,
        skip: parsedSkip,
        limit: parsedLimit,
        hasMore: parsedSkip + chats.length < total,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}

export async function markAsRead(req, res) {
  try {
    const { leadId } = req.params;

    await ChatProjection.updateOne({ leadId }, { $set: { unreadCount: 0 } });

    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
