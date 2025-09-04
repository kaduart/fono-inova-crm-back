import {
  configureWebhook,
  createPixCharge,
  getPixChargeStatus,
  getReceivedPixes
} from '../services/pixService.js';
import { handlePixWebhook } from '../services/webhookService.js';

export const generatePixCharge = async (req, res) => {
  try {
    const { appointmentId } = req.body;
    const result = await createPixCharge(appointmentId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const checkPixStatus = async (req, res) => {
  try {
    const { txid } = req.params;
    const result = await getPixChargeStatus(txid);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const configureSicoobWebhook = async (req, res) => {
  try {
    const { webhookUrl } = req.body;
    const result = await configureWebhook(webhookUrl);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const getPixReceived = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const result = await getReceivedPixes(startDate, endDate);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const pixWebhook = async (req, res) => {
  try {
    await handlePixWebhook(req, res);
  } catch (error) {
    console.error('Erro no webhook Pix:', error);
    res.status(500).send('Erro interno no servidor');
  }
};