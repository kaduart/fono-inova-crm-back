// controllers/contactController.js
import Contact from "../models/Contacts.js";
import { normalizeE164 } from "../utils/phone.js";

export const upsertContact = async (req, res) => {
  try {
    // sem default "Contato"
    const { name, phone, tags = [] } = req.body;
    const phoneE164 = normalizeE164(phone);
    if (!phoneE164) {
      return res.status(400).json({ error: "Telefone inválido" });
    }

    // limpa e valida nome recebido
    let safeName = typeof name === "string" ? name.trim() : "";
    const blacklist = ["contato", "cliente", "lead", "teste"];
    if (safeName && blacklist.includes(safeName.toLowerCase())) safeName = "";

    // monta $set sem sobrescrever nome com vazio
    const setData = {
      phoneRaw: phone,
      phoneE164,
    };
    if (safeName) setData.name = safeName;

    const contact = await Contact.findOneAndUpdate(
      { phoneE164 },
      {
        $set: setData,
        $addToSet: { tags: { $each: tags } },
      },
      { new: true, upsert: true }
    );

    return res.json({ success: true, data: contact });
  } catch (e) {
    console.error("upsertContact erro:", e);
    return res.status(500).json({ error: e.message });
  }
};
