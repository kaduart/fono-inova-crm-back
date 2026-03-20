/**
 * 🟢 Serviço WhatsApp VPS
 * 
 * Integração com VPS externo rodando whatsapp-web.js
 * Usa API REST para enviar mensagens
 * 
 * Suporta:
 * - IP direto: http://123.456.789.0:3000
 * - Cloudflare: https://whatsapp.seudominio.com
 */

import fetch from 'node-fetch';

const VPS_URL = process.env.VPS_WHATSAPP_URL;  // Ex: https://whatsapp.seudominio.com
const VPS_TOKEN = process.env.VPS_WHATSAPP_TOKEN;

/**
 * Envia mensagem via VPS
 */
export async function sendViaVPS(phone, message) {
  if (!VPS_URL || !VPS_TOKEN) {
    throw new Error('VPS_WHATSAPP_URL ou VPS_WHATSAPP_TOKEN não configurados');
  }

  const response = await fetch(`${VPS_URL}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VPS_TOKEN}`
    },
    body: JSON.stringify({ number: phone, message })
  });

  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.error || 'Erro ao enviar mensagem');
  }

  return data;
}

/**
 * Verifica status do VPS
 */
export async function checkVPSStatus() {
  if (!VPS_URL) {
    return { connected: false, error: 'VPS não configurado' };
  }

  try {
    const response = await fetch(`${VPS_URL}/health`, { timeout: 5000 });
    const data = await response.json();
    return { connected: true, ...data };
  } catch (err) {
    return { connected: false, error: err.message };
  }
}
