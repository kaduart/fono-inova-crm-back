import express from "express";
import {
  getCobrancaHandler,
  listPixHandler,
  registerWebhookHandler,
  webhookPixHandler, // ✅ Corrigido: antes estava "webhookPi fxHandler"
} from "../controllers/sicoobController.js";

const router = express.Router();

// 📌 Rota para registrar o webhook PIX (chave e URL)
router.post("/register-webhook", registerWebhookHandler);

// 📊 Rota para listar PIX recebidos (GET)
router.get("/received", listPixHandler);

// 📥 Endpoint que o Sicoob chamará quando cair um PIX (notificação real)
router.post("/webhook", webhookPixHandler);

// 💰 Consultar uma cobrança específica (pelo TXID)
router.get("/cobranca/:txid", getCobrancaHandler);

export default router;
