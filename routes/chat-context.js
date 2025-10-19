import ChatContext from "../models/ChatContext.js";
router.get("/chat-context/:leadId", async (req, res) => {
    try {
        const context = await ChatContext.findOne({ lead: req.params.leadId });
        res.json({ success: true, context });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});
