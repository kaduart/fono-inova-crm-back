import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import https from 'https';
import { sicoobConfig } from '../config/sicoobConfig.js';
import Appointment from '../models/Appointment.js';

dotenv.config();

// Configuração base do Axios
let axiosConfig = { timeout: 30000 };

// Se estivermos em produção, configuramos o httpsAgent com PFX
if (process.env.SICOOB_ENVIRONMENT === 'production') {
  axiosConfig.httpsAgent = new https.Agent({
    pfx: process.env.SICOOB_PFX_PATH ? fs.readFileSync(process.env.SICOOB_PFX_PATH) : undefined,
    passphrase: process.env.SICOOB_PFX_PASSWORD,
    rejectUnauthorized: false // necessário se certificado estiver autoassinado
  });
}

const sicoobApi = axios.create(axiosConfig);

// Obter token de acesso
export const getSicoobAccessToken = async () => {
  if (process.env.SICOOB_ENVIRONMENT === 'sandbox') {
    console.log('🔑 Usando token fixo do sandbox');
    return process.env.SICOOB_ACCESS_TOKEN;
  }

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

    console.log('🔑 Obtendo token de acesso do Sicoob...');
    const resp = await axios.post(process.env.SICOOB_AUTH_URL, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      httpsAgent: axiosConfig.httpsAgent
    });

    console.log('✅ Token de acesso obtido com sucesso');
    return resp.data.access_token;

  } catch (err) {
    console.error('❌ Erro ao obter token Sicoob:', err.message);
    throw new Error('Falha na autenticação com o Sicoob');
  }
};

// Registrar webhook
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
    const response = await axios.post(`${process.env.SICOOB_API_BASE_URL}/webhooks`, webhookPayload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Client-Id': process.env.SICOOB_CLIENT_ID
      },
      validateStatus: status => status < 500
    });

    if (typeof response.data === 'string' && response.data.includes('<html>')) {
      console.warn('⚠️ Registro automático não suportado no sandbox.');
      return { success: false, message: 'Registro automático não suportado. Registrar manualmente.', manualRegistrationUrl: 'https://developers.sicoob.com.br' };
    }

    return response.data;

  } catch (error) {
    console.error('❌ Erro ao registrar webhook:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status, 'Data:', error.response.data);
    }
    return { success: false, error: error.message, message: 'Registrar manualmente no portal Sicoob.' };
  }
};

// Criar cobrança Pix
/* export const createPixCharge = async (appointmentId) => {
  try {
    const appointment = await Appointment.findById(appointmentId).populate('patient doctor').exec();
    if (!appointment) throw new Error('Agendamento não encontrado');
    if (!appointment.sessionValue) throw new Error('Valor não definido');

    const accessToken = await getSicoobAccessToken();

    const txid = `APPT-${appointment._id.toString().slice(-20)}`;
    const devedor = appointment.patient?.cpf?.length === 11
      ? { cpf: appointment.patient.cpf, nome: appointment.patient.fullName.substring(0, 25) }
      : appointment.patient?.cnpj?.length === 14
        ? { cnpj: appointment.patient.cnpj, nome: appointment.patient.fullName.substring(0, 25) }
        : { nome: appointment.patient?.fullName?.substring(0, 25) || `Paciente ${appointment._id}` };

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
    const response = await axios.put(`${process.env.SICOOB_API_BASE_URL}/cob/${txid}`, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Client-Id': process.env.SICOOB_CLIENT_ID
      },
      httpsAgent: axiosConfig.httpsAgent
    });

    const qrCode = response.data.location || response.data.loc?.location;

    appointment.pixTransaction = {
      txid,
      qrCode,
      qrCodeImage: response.data.qrcode || null,
      createdAt: new Date(),
      status: 'ATIVA'
    };
    await appointment.save();

    return { success: true, txid, qrCode, qrCodeImage: response.data.qrcode || null, expiration: response.data.calendario.expiracao };

  } catch (error) {
    console.error('❌ Erro ao criar cobrança Pix:', error.message);
    if (error.response) return { success: false, error: error.response.data };
    return { success: false, error: error.message };
  }
};
 */
// Consultar Pix recebidos
export const getReceivedPixes = async (filters = {}) => {
  try {
    const accessToken = await getSicoobAccessToken();
    const response = await axios.get(`${process.env.SICOOB_API_BASE_URL}/pix`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Client-Id': process.env.SICOOB_CLIENT_ID },
      params: filters,
      httpsAgent: axiosConfig.httpsAgent
    });
    return response.data;
  } catch (error) {
    console.error('❌ Erro ao consultar PIX recebidos:', error.message);
    throw error;
  }
};

export const processPixWebhook = (payload) => {
  if (!payload?.pix || !Array.isArray(payload.pix)) return [];
  return payload.pix.map(pix => ({
    id: pix.txid,
    amount: parseFloat(pix.valor),
    date: new Date(pix.horario),
    payer: pix.pagador || 'Não informado'
  }));
};
