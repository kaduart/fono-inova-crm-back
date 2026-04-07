/**
 * 🔄 Server-Sent Events (SSE) para Dashboard Financeiro
 * 
 * Envia atualizações em tempo real para o frontend quando:
 * - Pipeline de convênios muda
 * - Novo pagamento recebido
 * - Cache é invalidado
 */

import express from 'express';
import { auth } from '../../middleware/auth.js';

const router = express.Router();

// Clientes conectados por clinicId
const clients = new Map();

/**
 * GET /api/financial/sse/dashboard
 * Conexão SSE para receber atualizações do dashboard
 */
router.get('/dashboard', auth, (req, res) => {
  const clinicId = req.user?.clinicId || 'default';
  const clientId = `${clinicId}_${Date.now()}`;

  // Configura headers SSE com CORS
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Desabilita buffering do nginx se houver
    'Access-Control-Allow-Origin': req.headers.origin || '*',
    'Access-Control-Allow-Credentials': 'true'
  });

  // Envia evento inicial de conexão
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

  // Registra cliente
  if (!clients.has(clinicId)) {
    clients.set(clinicId, new Set());
  }
  clients.get(clinicId).add(res);

  console.log(`[SSE] Cliente conectado: ${clientId}. Total: ${clients.get(clinicId).size}`);

  // Remove cliente quando desconectar
  req.on('close', () => {
    clients.get(clinicId)?.delete(res);
    console.log(`[SSE] Cliente desconectado: ${clientId}`);
  });

  // Keep-alive a cada 30s
  const keepAlive = setInterval(() => {
    res.write(`:ping\n\n`);
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});

/**
 * Notifica todos os clientes de uma clínica sobre mudança no dashboard
 */
export function notifyDashboardUpdate(clinicId, updateType, data) {
  const clinicClients = clients.get(clinicId);
  if (!clinicClients || clinicClients.size === 0) {
    return;
  }

  const message = {
    type: updateType, // 'INSURANCE_PIPELINE_CHANGED', 'PAYMENT_RECEIVED', etc
    timestamp: new Date().toISOString(),
    data
  };

  const sseData = `data: ${JSON.stringify(message)}\n\n`;

  clinicClients.forEach(client => {
    try {
      client.write(sseData);
    } catch (err) {
      console.error('[SSE] Erro ao enviar:', err.message);
      clinicClients.delete(client);
    }
  });

  console.log(`[SSE] Notificação enviada para ${clinicClients.size} clientes: ${updateType}`);
}

/**
 * Notifica múltiplas clínicas (quando não sabemos qual foi afetada)
 */
export function broadcastDashboardUpdate(updateType, data) {
  clients.forEach((clinicClients, clinicId) => {
    notifyDashboardUpdate(clinicId, updateType, data);
  });
}

export default router;
