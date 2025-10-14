import express from "express";
import {
  registerWebhookHandler,
  listPixHandler,
  getCobrancaHandler,
  handlePixWebhook
} from "../controllers/sicoobController.js";

const router = express.Router();

router.post("/register-webhook", registerWebhookHandler);
router.get("/received", listPixHandler);
router.get("/cobranca/:txid", getCobrancaHandler);
router.post("/webhook", handlePixWebhook);

export default router;
