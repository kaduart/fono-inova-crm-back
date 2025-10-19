import dotenv from 'dotenv';
import express from 'express';
dotenv.config();

const router = express.Router();

router.post("/draft", async (req, res) => {
    const { leadId, reason, campaign } = req.body;
    const lead = await Lead.findById(leadId);
    if (!lead) return res.status(404).json({ success: false, message: "Lead não encontrado" });

    const text = await generateFollowupMessage({ ...lead.toObject(), reason });
    return res.json({ success: true, draft: text, meta: { reason, campaign } });
});

// Confirmar e enfileirar
router.post("/send", async (req, res) => {
    const { leadId, message, reason, campaign, therapist } = req.body;
    // Reaproveite createFollowup/followupQueue existentes
    const followup = await Followup.create({
        lead: leadId, message,
        scheduledAt: new Date(),
        status: "scheduled",
        reason, campaign, therapist
    });
    // (opcional) enfileire imediatamente
    res.json({ success: true, data: followup });
});

export default router;
