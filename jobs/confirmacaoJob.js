import cron from 'node-cron';
import moment from 'moment-timezone';
import Appointment from '../models/Appointment.js';

const TIMEZONE = 'America/Sao_Paulo';

/**
 * Job que roda às 9h e 18h todos os dias
 * Verifica agendamentos pendentes e toma ações automáticas
 */
export const iniciarJobConfirmacao = () => {
  // 9h da manhã - primeiro lembrete
  cron.schedule('0 9 * * *', async () => {
    console.log('🌅 [Job 9h] Verificando confirmações pendentes...');
    await processarConfirmacoesManha();
  }, {
    timezone: TIMEZONE
  });
  
  // 18h da tarde - decisão final
  cron.schedule('0 18 * * *', async () => {
    console.log('🌆 [Job 18h] Decisões finais de confirmação...');
    await processarDecisoesFinais();
  }, {
    timezone: TIMEZONE
  });
  
  console.log('✅ Jobs de confirmação agendados: 9h e 18h (America/Sao_Paulo)');
};

/**
 * Processa confirmações da manhã (9h)
 * Envia lembretes para agendamentos de amanhã
 */
async function processarConfirmacoesManha() {
  try {
    const amanha = moment().tz(TIMEZONE).add(1, 'day').format('YYYY-MM-DD');
    
    // Buscar pendentes para amanhã
    const pendentes = await Appointment.find({
      date: amanha,
      operationalStatus: 'pending'
    }).populate('patient doctor');
    
    if (pendentes.length === 0) {
      console.log('✅ Nenhum agendamento pendente para amanhã');
      return;
    }
    
    console.log(`📲 ${pendentes.length} agendamentos pendentes para amanhã (${amanha})`);
    
    for (const apt of pendentes) {
      // TODO: Integrar com serviço de WhatsApp/SMS
      console.log(`   📨 Lembrete: ${apt.patient?.fullName} - ${apt.time} - ${apt.specialty}`);
      
      // Marcar que o lembrete foi enviado (opcional)
      // await Appointment.findByIdAndUpdate(apt._id, { reminderSent: true });
    }
    
    console.log(`✅ ${pendentes.length} lembretes processados`);
  } catch (error) {
    console.error('❌ Erro no job de confirmação (manhã):', error.message);
  }
}

/**
 * Processa decisões finais (18h)
 * Libera vagas de agendamentos que não confirmaram até 18h
 */
async function processarDecisoesFinais() {
  try {
    const amanha = moment().tz(TIMEZONE).add(1, 'day').format('YYYY-MM-DD');
    
    // Agendamentos que continuam pendentes para amanhã
    const naoConfirmados = await Appointment.find({
      date: amanha,
      operationalStatus: 'pending'
    }).populate('patient');
    
    if (naoConfirmados.length === 0) {
      console.log('✅ Nenhum agendamento pendente para liberar');
      return;
    }
    
    console.log(`🔄 ${naoConfirmados.length} agendamentos não confirmados - liberando vagas...`);
    
    for (const apt of naoConfirmados) {
      // Liberar vaga (cancelar agendamento pendente)
      await Appointment.findByIdAndUpdate(apt._id, {
        operationalStatus: 'canceled',
        clinicalStatus: 'missed',
        canceledAt: new Date(),
        cancelReason: 'Não confirmou até 18h (automático)',
        $push: {
          history: {
            action: 'cancelado_automatico',
            newStatus: 'canceled',
            timestamp: new Date(),
            context: 'Job 18h - não confirmou até horário limite'
          }
        }
      });
      
      console.log(`   ❌ Vaga liberada: ${apt.patient?.fullName} - ${apt.time}`);
    }
    
    console.log(`✅ ${naoConfirmados.length} vagas liberadas automaticamente`);
  } catch (error) {
    console.error('❌ Erro no job de decisões finais:', error.message);
  }
}

export default { iniciarJobConfirmacao };
