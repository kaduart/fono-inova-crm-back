import { createHash } from 'crypto';
import Appointment from '../models/Appointment';
import { sendPushNotification } from '../services/notificationService';
import { getIo } from '../socket'; // Importe sua instância do Socket.io
import { formatCurrency } from '../utils/format';

export const pixWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-signature'];
    const payload = req.body;

    // 1. Validar assinatura
    const hash = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');

    if (hash !== signature) {
      console.warn('Tentativa de webhook com assinatura inválida:', signature);
      return res.status(401).send('Assinatura inválida');
    }

    // 2. Verificar tipo de evento
    if (payload.evento !== 'pix_recebido') {
      console.log(`Evento não tratado: ${payload.evento}`);
      return res.status(200).send('Evento não tratado');
    }

    // 3. Processar cada Pix recebido
    for (const pix of payload.pix) {
      const txid = pix.txid;
      const valor = parseFloat(pix.valor);
      const horario = new Date(pix.horario);

      console.log(`Processando pagamento para txid: ${txid}, Valor: ${valor}`);

      // Atualizar agendamento
      const appointment = await Appointment.findOneAndUpdate(
        { 'pixTransaction.txid': txid },
        {
          paymentStatus: 'paid',
          paymentDate: horario,
          paymentMethod: 'pix',
          'pixTransaction.status': 'completed'
        },
        { new: true } // Retorna o documento atualizado
      ).populate('patient doctor');

      if (!appointment) {
        console.warn(`Agendamento não encontrado para txid: ${txid}`);
        continue;
      }

      console.log(`Pagamento confirmado para txid: ${txid}, Agendamento: ${appointment._id}`);

      // 4. Enviar notificação em tempo real
      try {
        // Enviar via Socket.io para todos os clientes conectados
        const io = getIo();
        io.emit('payment-confirmed', {
          appointmentId: appointment._id,
          amount: valor,
          date: horario,
          patientName: appointment.patient.fullName,
          doctorName: appointment.doctor.fullName
        });

        // Enviar notificação push para o paciente específico
        if (appointment.patient.notificationToken) {
          await sendPushNotification({
            token: appointment.patient.notificationToken,
            title: 'Pagamento Confirmado!',
            body: `Seu pagamento de ${formatCurrency(valor)} foi recebido`,
            data: {
              type: 'payment-confirmed',
              appointmentId: appointment._id.toString()
            }
          });
        }

        console.log(`Notificações enviadas para agendamento: ${appointment._id}`);
      } catch (notifyError) {
        console.error('Erro ao enviar notificações:', notifyError);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Erro no webhook Pix:', error);
    res.status(500).send('Erro interno no servidor');
  }
};