// controllers/contactController.js
import Contact from "../models/Contacts.js";
import mongoose from "mongoose";

export const updateContactById = async (req, res) => {
  try {
    const { id } = req.params;
    const { leadId } = req.body;

    const setData = {};

    if (leadId !== undefined) {
      if (leadId === null || leadId === "") setData.leadId = null;
      else if (mongoose.Types.ObjectId.isValid(leadId)) setData.leadId = leadId;
      else return res.status(400).json({ error: "leadId inválido" });
    }

    const updated = await Contact.findByIdAndUpdate(
      id,
      { $set: setData },
      { new: true }
    );

    if (!updated) return res.status(404).json({ error: "Contato não encontrado" });

    return res.json({ success: true, data: updated });
  } catch (e) {
    console.error("updateContactById erro:", e);
    return res.status(500).json({ error: e.message });
  }
};
