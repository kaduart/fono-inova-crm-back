import { v4 as uuidv4 } from 'uuid';
import { sicoobApi } from '../config/sicoobConfig';
import Appointment from '../models/Appointment';
import { getSicoobAccessToken } from './authService';

export const createPixCharge = async (appointmentId: string): Promise<any> => {
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
        expiracao: 86400 // 24 horas
      },
      devedor: {
        cpf: appointment.patient.cpf,
        nome: appointment.patient.fullName
      },
      valor: {
        original: appointment.paymentAmount.toFixed(2)
      },
      chave: sicoobConfig.pixKey,
      solicitacaoPagador: `Consulta ${appointment.type} - ${appointment.doctor.specialty}`
    };

    const response = await sicoobApi.put(`/pix/api/v2/cob/${txid}`, payload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });

    // Atualizar agendamento com dados do Pix
    appointment.pixTransaction = {
      txid,
      qrCode: response.data.pixCopiaECola,
      createdAt: new Date(),
      status: 'pending'
    };

    await appointment.save();

    return {
      qrCode: response.data.pixCopiaECola,
      txid,
      expiration: response.data.calendario.expiracao
    };
  } catch (error) {
    console.error('Erro ao criar cobrança Pix:', error.response?.data || error.message);
    throw new Error('Falha ao gerar cobrança Pix');
  }
};

export const getPixChargeStatus = async (txid: string): Promise<any> => {
  try {
    const accessToken = await getSicoobAccessToken();
    const response = await sicoobApi.get(`/pix/api/v2/cob/${txid}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    return response.data;
  } catch (error) {
    console.error('Erro ao consultar status Pix:', error.response?.data || error.message);
    throw new Error('Falha ao consultar status da cobrança');
  }
};