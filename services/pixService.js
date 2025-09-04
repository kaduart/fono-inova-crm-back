import { v4 as uuidv4 } from 'uuid';
import { sicoobApi, sicoobConfig } from '../config/sicoobConfig.js';
import Appointment from '../models/Appointment.js';
import { getSicoobAccessToken } from './authService.js';

export const createPixCharge = async (appointmentId) => {
  try {
    const appointment = await Appointment.findById(appointmentId)
      .populate('patient doctor')
      .exec();

    if (!appointment) throw new Error('Agendamento não encontrado');
    if (!appointment.paymentAmount) throw new Error('Valor não definido');

    const accessToken = await getSicoobAccessToken();
    const txid = uuidv4().replace(/-/g, '').substring(0, 35);

    const payload = {
      calendario: {
        expiracao: 3600 // 1 hora
      },
      devedor: {
        cpf: appointment.patient.cpf.replace(/\D/g, ''),
        nome: appointment.patient.fullName.substring(0, 25)
      },
      valor: {
        original: appointment.paymentAmount.toFixed(2)
      },
      chave: sicoobConfig.pixKey,
      solicitacaoPagador: `Consulta ${appointment.type}`
    };

    const response = await sicoobApi.put(`/cob/${txid}`, payload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Client_id': sicoobConfig.clientId
      }
    });

    // Buscar a imagem do QRCode
    const qrCodeResponse = await sicoobApi.get(`/cob/${txid}/imagem`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client_id': sicoobConfig.clientId
      }
    });

    // Atualizar agendamento com dados do Pix
    appointment.pixTransaction = {
      txid,
      qrCode: response.data.pixCopiaECola,
      qrCodeImage: qrCodeResponse.data.imagemQrcode,
      createdAt: new Date(),
      status: 'ATIVA'
    };

    await appointment.save();

    return {
      qrCode: response.data.pixCopiaECola,
      qrCodeImage: qrCodeResponse.data.imagemQrcode,
      txid,
      expiration: response.data.calendario.expiracao
    };
  } catch (error) {
    console.error('Erro ao criar cobrança Pix:', error.response?.data || error.message);
    throw new Error('Falha ao gerar cobrança Pix');
  }
};

// Consultar PIX recebidos
export const getReceivedPixes = async (filters = {}) => {
  try {
    const accessToken = await getSicoobAccessToken();

    const response = await sicoobApi.get('/pix', {
      params: filters,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client_id': sicoobConfig.clientId
      }
    });

    return response.data;
  } catch (error) {
    console.error('Erro ao consultar PIX recebidos:', error.response?.data || error.message);
    throw new Error('Falha ao consultar PIX recebidos');
  }
};

// Configurar webhook
export const configureWebhook = async (webhookUrl) => {
  try {
    const accessToken = await getSicoobAccessToken();

    const response = await sicoobApi.put(
      `/webhook/${sicoobConfig.pixKey}`,
      {
        webhookUrl: webhookUrl
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Client_id': sicoobConfig.clientId
        }
      }
    );

    return response.data;
  } catch (error) {
    console.error('Erro ao configurar webhook:', error.response?.data || error.message);
    throw new Error('Falha ao configurar webhook');
  }
};

// Consultar Pix por E2EID
export const getPixByE2eId = async (e2eid) => {
  try {
    const accessToken = await getSicoobAccessToken();

    const response = await sicoobApi.get(`/pix/${e2eid}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client_id': sicoobConfig.clientId
      }
    });

    return response.data;
  } catch (error) {
    console.error('Erro ao consultar Pix por e2eid:', error.response?.data || error.message);
    throw new Error('Falha ao consultar Pix por e2eid');
  }
};

// Consultar informações do webhook
export const getWebhookInfo = async () => {
  try {
    const accessToken = await getSicoobAccessToken();

    const response = await sicoobApi.get(`/webhook/${sicoobConfig.pixKey}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Client_id': sicoobConfig.clientId
      }
    });

    return response.data;
  } catch (error) {
    console.error('Erro ao consultar webhook:', error.response?.data || error.message);
    throw new Error('Falha ao consultar informações do webhook');
  }
};