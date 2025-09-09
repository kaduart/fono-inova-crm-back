import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import https from 'https';
import { sicoobConfig } from '../config/sicoobConfig.js';
import Appointment from '../models/Appointment.js';

dotenv.config();

// Configuração para sandbox - não precisa de certificados
let axiosConfig = {
  timeout: 30000
};

// Apenas em produção usamos certificados
if (process.env.SICOOB_ENVIRONMENT === 'production') {
  const httpsAgent = new https.Agent({
    pfx: fs.readFileSync(process.env.SICOOB_PFX_PATH),
    passphrase: process.env.SICOOB_PFX_PASSWORD,
    rejectUnauthorized: false
  });
  axiosConfig.httpsAgent = httpsAgent;
}

const sicoobApi = axios.create(axiosConfig);

export const getSicoobAccessToken = async () => {
  // No sandbox, usamos o token fixo
  if (process.env.SICOOB_ENVIRONMENT === 'sandbox') {
    console.log('🔑 Usando token fixo do sandbox');
    return process.env.SICOOB_ACCESS_TOKEN;
  }

  // Em produção, obtemos token normalmente
  try {
    const scopes = [
      'cob.write', 'cob.read', 'pix.write', 'pix.read',
      'webhook.write', 'webhook.read'
    ].join(' ');

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', process.env.SICOOB_CLIENT_ID);
    params.append('scope', scopes);

    console.log('🔑 Obtendo token de acesso do Sicoob...');
    const resp = await axios.post(
      process.env.SICOOB_AUTH_URL,
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        httpsAgent: axiosConfig.httpsAgent
      }
    );

    console.log('✅ Token de acesso obtido com sucesso');
    return resp.data.access_token;
  } catch (err) {
    console.error('❌ Erro ao obter token Sicoob:', err.message);
    throw new Error('Falha na autenticação com o Sicoob');
  }
};

export const registerWebhook = async (webhookUrl) => {
  try {
    const accessToken = await getSicoobAccessToken();

    const webhookPayload = {
      url: webhookUrl,
      codigoTipoMovimento: 7,
      codigoPeriodoMovimento: 1,
      email: process.env.ADMIN_EMAIL || 'admin@clinicafonoinova.com.br'
    };

    console.log('📤 Registrando webhook no Sicoob...');

    const response = await axios.post(
      `${process.env.SICOOB_API_BASE_URL}/webhooks`,
      webhookPayload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Client-Id': process.env.SICOOB_CLIENT_ID
        },
        httpsAgent: axiosConfig.httpsAgent
      }
    );

    console.log('✅ Webhook registrado com sucesso');
    return response.data;
  } catch (error) {
    console.error('❌ Erro ao registrar webhook:', error.message);

    // Verificar se é um erro de sandbox não suportado
    if (error.response && typeof error.response.data === 'string' &&
      error.response.data.includes('<html>')) {
      return {
        success: false,
        message: 'Registro automático não suportado no sandbox'
      };
    }

    throw error;
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
      chave: process.env.SICOOB_PIX_KEY || sicoobConfig.pixKey,
      solicitacaoPagador: `Pagamento consulta ${appointment.type || ''}`,
      infoAdicionais: [
        { nome: 'Agendamento', valor: appointment._id.toString() },
        { nome: 'Paciente', valor: appointment.patient?.fullName || 'Desconhecido' }
      ]
    };

    console.log('💳 Criando cobrança PIX...');
    const response = await sicoobApi.put(
      `${process.env.SICOOB_API_BASE_URL}/cob/${txid}`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Client-Id': process.env.SICOOB_CLIENT_ID
        }
      }
    );

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
    console.error('❌ Erro ao criar cobrança Pix:', error.message);
    if (error.response) return { success: false, error: error.response.data };
    return { success: false, error: error.message };
  }
};

// Consultar Pix recebidos
export const getReceivedPixes = async (filters = {}) => {
  try {
    const accessToken = await getSicoobAccessToken();
    const response = await sicoobApi.get(
      `${process.env.SICOOB_API_BASE_URL}/pix`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Client-Id': process.env.SICOOB_CLIENT_ID
        },
        params: filters
      }
    );
    return response.data;
  } catch (error) {
    console.error('❌ Erro ao consultar PIX recebidos:', error.message);
    throw error;
  }
};