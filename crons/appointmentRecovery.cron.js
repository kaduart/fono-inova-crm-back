// crons/appointmentRecovery.cron.js
// Cron job para recuperar agendamentos travados em processing_complete
// Roda a cada 5 minutos para garantir que nada fica preso

import Appointment from '../models/Appointment.js';

let isRunning = false;
let intervalId = null;

/**
 * Recupera agendamentos travados em processing_complete
 * Reset para 'scheduled' se estiverem travados há mais de 5 minutos
 */
async function recoverStuckAppointments() {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  // Busca agendamentos travados há mais de 5 minutos
  const stuckAppointments = await Appointment.find({
    operationalStatus: { $in: ['processing_complete', 'processing_cancel', 'processing_create'] },
    updatedAt: { $lt: fiveMinutesAgo }
  }).select('_id operationalStatus patient date time updatedAt').limit(1000);

  if (stuckAppointments.length === 0) {
    return { reset: 0, total: 0 };
  }

  console.log(`[AppointmentRecovery] ⚠️ Encontrados ${stuckAppointments.length} agendamento(s) travados`);

  let resetCount = 0;
  const results = [];

  for (const apt of stuckAppointments) {
    try {
      // Determina o status anterior apropriado
      let newStatus = 'scheduled';
      if (apt.operationalStatus === 'processing_create') {
        newStatus = 'pending'; // Se travou no create, volta para pending
      }

      await Appointment.findByIdAndUpdate(apt._id, {
        $set: {
          operationalStatus: newStatus,
          updatedAt: new Date()
        },
        $push: {
          history: {
            action: 'auto_recovery',
            previousStatus: apt.operationalStatus,
            newStatus: newStatus,
            timestamp: new Date(),
            context: `Recuperação automática - travado há ${Math.round((Date.now() - apt.updatedAt) / 60000)} minutos`
          }
        }
      });

      console.log(`[AppointmentRecovery] ✅ Resetado: ${apt._id} (${apt.operationalStatus} → ${newStatus})`);
      resetCount++;
      results.push({ id: apt._id, success: true, from: apt.operationalStatus, to: newStatus });

    } catch (error) {
      console.error(`[AppointmentRecovery] ❌ Erro ao resetar ${apt._id}:`, error.message);
      results.push({ id: apt._id, success: false, error: error.message });
    }
  }

  return { reset: resetCount, total: stuckAppointments.length, details: results };
}

async function runOnce() {
  if (isRunning) {
    console.log('[AppointmentRecovery] ⏭️ Já está rodando, pulando...');
    return;
  }

  isRunning = true;
  const startedAt = Date.now();
  console.log(`[AppointmentRecovery] 🔁 [${new Date().toISOString()}] Verificando agendamentos travados...`);

  try {
    const result = await recoverStuckAppointments();

    if (result.reset > 0) {
      console.log(`[AppointmentRecovery] ✅ ${result.reset}/${result.total} agendamento(s) recuperado(s) em ${Date.now() - startedAt}ms`);
    } else if (result.total > 0) {
      console.log(`[AppointmentRecovery] ⏳ ${result.total} agendamento(s) travados (aguardando timeout de 5min) em ${Date.now() - startedAt}ms`);
    } else {
      console.log(`[AppointmentRecovery] ✅ nada a recuperar em ${Date.now() - startedAt}ms`);
    }
  } catch (error) {
    console.error('[AppointmentRecovery] ❌ Erro:', error.message);
  } finally {
    isRunning = false;
  }
}

/**
 * Inicializa o cron de recuperação de agendamentos
 * Deve ser chamado no startup do servidor
 */
export function initAppointmentRecoveryCron() {
  if (intervalId) {
    console.log('[AppointmentRecovery] ⚠️ Já inicializado, ignorando');
    return { stop: () => clearInterval(intervalId) };
  }

  console.log('🔄 Inicializando Appointment Recovery Cron...');

  // Roda a cada 5 minutos usando setInterval — evita overhead do node-cron/timezone
  intervalId = setInterval(runOnce, 5 * 60 * 1000);

  // Primeira execução após 1 minuto do startup
  setTimeout(() => {
    console.log('[AppointmentRecovery] 🚀 Primeira execução (warmup)...');
    runOnce().catch(e => console.error('[AppointmentRecovery] Erro no warmup:', e.message));
  }, 60 * 1000);

  console.log('✅ Appointment Recovery Cron inicializado (a cada 5 min)');

  return {
    stop: () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }
  };
}

export default { initAppointmentRecoveryCron };
