/**
 * ⏰ Pre-Agendamento Expiration Cron
 *
 * Roda periodicamente (a cada 1 hora) e fecha automaticamente
 * pré-agendamentos (pre_agendado) cujo horário já passou.
 *
 * Regras:
 * - operationalStatus: 'pre_agendado' → 'missed'
 * - clinicalStatus: 'missed'
 * - Adiciona histórico de expiração automática
 * - NÃO afeta pré-agendamentos já convertidos (têm appointmentId)
 * - NÃO afeta liminar/convênio (só atua em operationalStatus)
 */

import cron from 'node-cron';
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import { createContextLogger } from '../utils/logger.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

const log = createContextLogger('cron', 'PreAgendamentoExpiration');
const TIMEZONE = 'America/Sao_Paulo';

/**
 * Constrói o datetime completo a partir de date + time do appointment
 */
function buildDateTime(date, time) {
  if (!date) return null;
  const d = moment(date).tz(TIMEZONE).startOf('day');
  if (time && typeof time === 'string') {
    const [hours, minutes] = time.split(':').map(Number);
    if (!isNaN(hours)) d.hours(hours);
    if (!isNaN(minutes)) d.minutes(minutes);
  }
  return d.toDate();
}

const MARGIN_MINUTES = 15; // Margem de tolerância após o horário do appointment

async function expirePreAgendamentos() {
  const startTime = Date.now();
  const correlationId = `preag_exp_${Date.now()}`;
  const now = moment().tz(TIMEZONE);

  log.info(`[${correlationId}] ⏰ Iniciando expiração de pré-agendamentos vencidos (margem: ${MARGIN_MINUTES}min)`);

  try {
    // Busca pré-agendamentos que ainda não foram convertidos (sem appointmentId)
    // e cujo horário já passou com margem de tolerância
    const candidates = await Appointment.find({
      operationalStatus: 'pre_agendado',
      appointmentId: { $exists: false } // ainda não convertido
    }).lean();

    const expired = [];

    for (const apt of candidates) {
      const aptDateTime = buildDateTime(apt.date, apt.time);
      if (!aptDateTime) continue;

      // Só expira se o horário do appointment + margem já passou
      const expirationThreshold = moment(aptDateTime).add(MARGIN_MINUTES, 'minutes');
      if (now.isAfter(expirationThreshold)) {
        expired.push(apt);
      }
    }

    if (expired.length === 0) {
      log.info(`[${correlationId}] ✅ Nenhum pré-agendamento vencido encontrado`);
      return { processed: 0, expired: 0 };
    }

    log.info(`[${correlationId}] 🔔 ${expired.length} pré-agendamento(s) vencido(s) encontrado(s)`);

    let processed = 0;
    for (const apt of expired) {
      try {
        // 🔒 IDEMPOTÊNCIA ATÔMICA: só expira se ainda estiver pre_agendado
        // Evita race condition quando múltiplas instâncias do cron rodam simultaneamente
        const updated = await Appointment.findOneAndUpdate(
          { _id: apt._id, operationalStatus: 'pre_agendado' },
          {
            operationalStatus: 'missed',
            clinicalStatus: 'missed',
            $push: {
              history: {
                action: 'auto_expired',
                previousStatus: apt.operationalStatus,
                newStatus: 'missed',
                timestamp: new Date(),
                context: `Pré-agendamento expirado automaticamente — horário não convertido (margem: ${MARGIN_MINUTES}min)`,
                correlationId
              }
            }
          },
          { new: true }
        );

        if (!updated) {
          log.warn(`[${correlationId}] ⏭️ Appointment ${apt._id} já foi processado por outra instância`);
          continue;
        }

        // Se houver Session vinculada, atualiza também
        if (apt.session) {
          await Session.findByIdAndUpdate(apt.session, {
            status: 'missed',
            $push: {
              history: {
                action: 'auto_expired',
                newStatus: 'missed',
                timestamp: new Date(),
                context: 'Session vinculada a pré-agendamento expirado',
                correlationId
              }
            }
          });
        }

        // Publica evento (opcional, para dashboards/analytics)
        await publishEvent(EventTypes.APPOINTMENT_STATUS_CHANGED, {
          appointmentId: apt._id,
          patientId: apt.patient,
          doctorId: apt.doctor,
          previousStatus: apt.operationalStatus,
          newStatus: 'missed',
          reason: 'auto_expired',
          correlationId
        });

        processed++;
        log.info(`[${correlationId}] ✅ Expirado: appointment ${apt._id} (${apt.date} ${apt.time || ''})`);
      } catch (err) {
        log.error(`[${correlationId}] ❌ Erro ao expirar appointment ${apt._id}: ${err.message}`);
      }
    }

    const duration = Date.now() - startTime;
    log.info(`[${correlationId}] 🏁 Concluído: ${processed}/${expired.length} processados em ${duration}ms`);

    return { processed, expired: expired.length };
  } catch (error) {
    log.error(`[${correlationId}] ❌ Erro fatal no cron: ${error.message}`);
    throw error;
  }
}

// Roda a cada 1 hora (minuto 30 de cada hora — evita picada de hora cheia)
const CRON_SCHEDULE = '30 * * * *';

export function schedulePreAgendamentoExpiration() {
  log.info(`[Cron] Agendando expiração de pré-agendamentos: ${CRON_SCHEDULE}`);

  const task = cron.schedule(CRON_SCHEDULE, async () => {
    await expirePreAgendamentos();
  }, {
    scheduled: true,
    timezone: TIMEZONE
  });

  return task;
}

// Também exporta a função de execução manual (para endpoints de emergência)
export { expirePreAgendamentos };
