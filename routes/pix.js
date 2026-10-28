// routes/pix.js
import express from "express";
import { auth, authorize } from "../middleware/auth.js";
import { requireWebhookSecret } from "../middleware/webhookAuth.js";
import {
  createDynamicPixHandler,
  debugWebhookHandler,
  getCobrancaHandler,
  handlePixWebhook,
  listPixHandler,
  registerWebhookHandler
} from "../controllers/sicoobController.js";

const router = express.Router();

// 🔒 Webhook Sicoob: o segredo vai no próprio path (o Sicoob não manda headers
// customizados). registerWebhook() já registra a URL com o segredo quando
// SICOOB_WEBHOOK_SECRET existe. O padrão Pix do BACEN acrescenta "/pix" ao final.
const pixWebhookAuth = requireWebhookSecret("SICOOB_WEBHOOK_SECRET", {
  allowWhenUnset: true, // legado: enquanto a env não existir, segue aceitando (com aviso)
  label: "pix/webhook",
});
router.post(["/webhook", "/webhook/pix"], pixWebhookAuth, handlePixWebhook);
router.post(["/webhook/:token", "/webhook/:token/pix"], pixWebhookAuth, handlePixWebhook);

// Administração / consulta (só equipe autenticada)
router.post("/register-webhook", auth, authorize(["admin"]), registerWebhookHandler);
router.get("/debug-webhook", auth, authorize(["admin"]), debugWebhookHandler);
router.get("/received", auth, listPixHandler);

// Mantidas sem auth: podem ser usadas pelo fluxo público de cobrança
router.get("/cobranca/:txid", getCobrancaHandler);
router.post("/checkout", createDynamicPixHandler);

export default router;
