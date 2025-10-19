import express from "express";
import {
  registerWebhookHandler,
  listPixHandler,
  getCobrancaHandler,
  handlePixWebhook,
  createDynamicPixHandler
} from "../controllers/sicoobController.js";

const router = express.Router();

router.post("/register-webhook", registerWebhookHandler);
router.get("/received", listPixHandler);
router.get("/cobranca/:txid", getCobrancaHandler);
router.post("/webhook", handlePixWebhook);
router.get("/checkout", createDynamicPixHandler);

export default router;
