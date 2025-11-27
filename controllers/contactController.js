// controllers/contactController.js
import Contact from "../models/Contact.js";
import { normalizeE164 } from "../utils/phone.js";

export const upsertContact = async (req, res) => {
    try {
        const { name, phone, tags = [], ...rest } = req.body; // 🔥 sem default "Contato"
        const phoneE164 = normalizeE164(phone);
        if (!phoneE164) {
            return res.status(400).json({ error: "Telefone inválido" });
        }

        // trata o nome que veio da pessoa (ou da integração)
        let safeName =
            typeof name === "string"
                ? name.trim()
                : "";

        // opcional: evita salvar "Contato", "Cliente", etc se vierem do front
        const blacklist = ["contato", "cliente", "lead"];
        if (safeName && blacklist.includes(safeName.toLowerCase())) {
            safeName = "";
        }

        // monta o $set sem sobrescrever o nome com vazio
        const setData = {
            phoneRaw: phone,
            phoneE164,
        };

        if (safeName) {
            setData.name = safeName; // só seta se tiver nome de verdade
        }

        
        const contact = await Contact.findOneAndUpdate(
            { phoneE164 },
            {
                $set: setData,
                $addToSet: { tags: { $each: tags } },
            },
            { new: true, upsert: true }
        );

        res.json({ success: true, data: contact });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};
