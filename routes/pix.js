// routes/pix.js
import express from "express";
import {
  createDynamicPixHandler,
  getCobrancaHandler,
  handlePixWebhook,
  listPixHandler,
  registerWebhookHandler
} from "../controllers/sicoobController.js";
import { getWebhookInfo } from "../services/sicoobService.js";

const router = express.Router();

router.post("/register-webhook", registerWebhookHandler);
router.get("/received", listPixHandler);
router.get("/cobranca/:txid", getCobrancaHandler);
router.post("/webhook", handlePixWebhook);
router.post("/checkout", createDynamicPixHandler);

// 🔍 DEBUG: ver o webhook configurado no Sicoob
router.get("/debug-webhook", async (req, res) => {
  try {
    const data = await getWebhookInfo();
    return res.json({ success: true, data });
  } catch (e) {
    console.error("❌ Erro ao consultar webhook:", e.response?.data || e.message);
    return res.status(500).json({
      success: false,
      error: e.response?.data || e.message,
    });
  }
});

export default router;
