// routes/pix.js
import express from "express";
import {
  createDynamicPixHandler,
  debugWebhookHandler,
  getCobrancaHandler,
  handlePixWebhook,
  listPixHandler,
  registerWebhookHandler
} from "../controllers/sicoobController.js";

const router = express.Router();

router.post("/register-webhook", registerWebhookHandler);
router.get("/received", listPixHandler);
router.get("/cobranca/:txid", getCobrancaHandler);
router.post("/webhook", handlePixWebhook);
router.post("/checkout", createDynamicPixHandler);

router.get("/debug-webhook", debugWebhookHandler);

export default router;
