/* // sicoobController.js
import { createPixCharge, getReceivedPixes } from '../services/sicoobService.js';
import { handlePixWebhook as handleWebhookService } from '../services/webhookService.js';

export const createPix = async (req, res) => {
  try {
    const { appointmentId } = req.params;
    const result = await createPixCharge(appointmentId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || err });
  }
};

export const getReceived = async (req, res) => {
  try {
    const data = await getReceivedPixes(req.query);
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || err });
  }
};

export const handlePixWebhook = async (req, res) => {
  await handleWebhookService(req, res); // delega para o service
};
 */