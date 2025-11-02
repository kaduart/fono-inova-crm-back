// controllers/contactController.js
import Contact from "../models/Contact.js";
import { normalizeE164 } from "../utils/phone.js";

export const upsertContact = async (req, res) => {
    try {
        const { name = "Contato", phone, tags = [] } = req.body;
        const phoneE164 = normalizeE164(phone);
        if (!phoneE164) return res.status(400).json({ error: "Telefone inválido" });

        const contact = await Contact.findOneAndUpdate(
            { phoneE164 },
            { $set: { name, phoneRaw: phone, phoneE164 }, $addToSet: { tags: { $each: tags } } },
            { new: true, upsert: true }
        );

        res.json({ success: true, data: contact });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};
