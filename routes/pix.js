import express from "express";
import {
  getCobrancaHandler,
  listPixHandler,
  registerWebhookHandler,
  webhookPixHandler,
} from "../controllers/sicoobController.js";

const router = express.Router();

// 📌 Registra o webhook PIX no Sicoob
router.post("/register-webhook", registerWebhookHandler);

// 📊 Lista PIX recebidos
router.get("/received", listPixHandler);

// 📥 Endpoint que o Sicoob chama quando cai um PIX (notificação real)
router.post("/webhook", webhookPixHandler);

// 💰 Consulta cobrança específica por TXID
router.get("/cobranca/:txid", getCobrancaHandler);

export default router;
