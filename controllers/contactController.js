// controllers/contactController.js
import Contact from "../models/Contacts.js";
import mongoose from "mongoose";
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

export const updateContactById = async (req, res) => {
  try {
    const { id } = req.params;
    const { leadId } = req.body;

    const setData = {};

    if (leadId !== undefined) {
      if (leadId === null || leadId === "") setData.leadId = null;
      else if (mongoose.Types.ObjectId.isValid(leadId)) setData.leadId = leadId;
      else return sendApiError(res, new AppError('BAD_REQUEST', "leadId inválido", { status: 400 }), req);
    }

    const updated = await Contact.findByIdAndUpdate(
      id,
      { $set: setData },
      { new: true }
    );

    if (!updated) return sendApiError(res, new AppError('NOT_FOUND', "Contato não encontrado", { status: 404 }), req);

    return res.json({ success: true, data: updated });
  } catch (e) {
    console.error("updateContactById erro:", e);
    return sendApiError(res, e, req);
  }
};
