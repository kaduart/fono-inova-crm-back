import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import https from 'https';
import { sicoobConfig } from '../config/sicoobConfig.js';
import Appointment from '../models/Appointment.js';

dotenv.config();

// HTTPS Agent usando PFX ou PEM
const httpsAgent = new https.Agent({
  pfx: process.env.SICOOB_PFX_PATH ? fs.readFileSync(process.env.SICOOB_PFX_PATH) : undefined,
  cert: process.env.SICOOB_CERT_PATH ? fs.readFileSync(process.env.SICOOB_CERT_PATH) : undefined,
  key: process.env.SICOOB_KEY_PATH ? fs.readFileSync(process.env.SICOOB_KEY_PATH) : undefined,
  passphrase: process.env.SICOOB_PFX_PASSWORD || process.env.SICOOB_CERT_PASSWORD,
  rejectUnauthorized: true
});

const sicoobApi = axios.create({
  baseURL: process.env.SICOOB_API_BASE_URL,
  httpsAgent
});

export const getSicoobAccessToken = async () => {
  try {
    const scopes = [
      'cob.write',
      'cob.read',
      'pix.write',
      'pix.read',
      'webhook.write',
      'webhook.read'
    ].join(' ');

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', process.env.SICOOB_CLIENT_ID);
    params.append('scope', scopes);

    const resp = await axios.post(
      process.env.SICOOB_AUTH_URL,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent }
    );

    return resp.data.access_token;
  } catch (err) {
    console.error('❌ Erro ao obter token Sicoob:', err.response?.data || err.message);
    throw new Error('Falha na autenticação com o Sicoob');
  }
};

// Criar cobrança Pix
export const createPixCharge = async (appointmentId) => {
  try {
    const appointment = await Appointment.findById(appointmentId)
      .populate('patient doctor')
      .exec();

    if (!appointment) throw new Error('Agendamento não encontrado');
    if (!appointment.sessionValue) throw new Error('Valor não definido');

    const accessToken = await getSicoobAccessToken();

    // Gerar txid único (máx 35 caracteres)
    const txid = `APPT-${appointment._id.toString().slice(-20)}`;

    // Montar devedor
    let devedor = {};
    if (appointment.patient?.cpf?.length === 11) {
      devedor = { cpf: appointment.patient.cpf, nome: appointment.patient.fullName.substring(0, 25) };
    } else if (appointment.patient?.cnpj?.length === 14) {
      devedor = { cnpj: appointment.patient.cnpj, nome: appointment.patient.fullName.substring(0, 25) };
    } else {
      devedor = { nome: appointment.patient?.fullName?.substring(0, 25) || `Paciente ${appointment._id}` };
    }

    const payload = {
      calendario: { expiracao: 3600 },
      devedor,
      valor: { original: appointment.sessionValue.toFixed(2), modalidadeAlteracao: 1 },
      chave: sicoobConfig.pixKey,
      solicitacaoPagador: `Pagamento consulta ${appointment.type || ''}`,
      infoAdicionais: [
        { nome: 'Agendamento', valor: appointment._id.toString() },
        { nome: 'Paciente', valor: appointment.patient?.fullName || 'Desconhecido' }
      ]
    };

    // ⚡ PUT para Sicoob
    const response = await sicoobApi.put(`/cob/${txid}`, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        ClientId: sicoobConfig.clientId
      }
    });

    const qrCode = response.data.location || response.data.loc?.location;

    // Atualizar agendamento
    appointment.pixTransaction = {
      txid,
      qrCode,
      qrCodeImage: response.data.qrcode || null,
      createdAt: new Date(),
      status: 'ATIVA'
    };
    await appointment.save();

    return {
      success: true,
      txid,
      qrCode,
      qrCodeImage: response.data.qrcode || null,
      expiration: response.data.calendario.expiracao
    };
  } catch (error) {
    console.error('❌ Erro ao criar cobrança Pix:', error);
    if (error.response) return { success: false, error: error.response.data };
    return { success: false, error: error.message };
  }
};


// Consultar Pix recebidos
export const getReceivedPixes = async (filters = {}) => {
  const accessToken = await getSicoobAccessToken();
  const resp = await sicoobApi.get('/pix', {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Client_id': process.env.SICOOB_CLIENT_ID },
    params: filters
  });
  return resp.data;
};

// Consultar Pix por E2EID
export const getPixByE2eId = async (e2eid) => {
  const accessToken = await getSicoobAccessToken();
  const resp = await sicoobApi.get(`/pix/${e2eid}`, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Client_id': process.env.SICOOB_CLIENT_ID }
  });
  return resp.data;
};

// Configurar webhook
export const configureWebhook = async (webhookUrl) => {
  const accessToken = await getSicoobAccessToken();
  const resp = await sicoobApi.put(`/webhook/${process.env.SICOOB_PIX_KEY}`, { webhookUrl }, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Client_id': process.env.SICOOB_CLIENT_ID, 'Content-Type': 'application/json' }
  });
  return resp.data;
};

// Consultar webhook
export const getWebhookInfo = async () => {
  const accessToken = await getSicoobAccessToken();
  const resp = await sicoobApi.get(`/webhook/${process.env.SICOOB_PIX_KEY}`, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Client_id': process.env.SICOOB_CLIENT_ID }
  });
  return resp.data;
};
