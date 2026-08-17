#!/usr/bin/env node
/**
 * Correção do reparo anterior (repair-guide-16411088.mjs).
 *
 * O que estava errado:
 *  1. O reparo anterior CRIOU 2 appointments novos (18/08 10:00 e 25/08 10:00)
 *     em vez de reaproveitar os 2 appointments fantasma originais (21/07 10:00
 *     e 28/07 10:00, já estornados) — pedido explícito era só mudar status e
 *     data DOS MESMOS registros, não criar registros paralelos.
 *  2. Como só 1 dos 2 slots semanais (10:00) foi preenchido em cada semana
 *     nova, a reconciliação de agenda do próprio InsurancePlan (slots exige
 *     09:20 + 10:00 toda terça) reposicionou sozinha um dos 2 appointments
 *     novos (25/08 10:00 → 18/08 09:20) pra fechar o padrão semanal — por
 *     isso 25/08 sumiu do calendário.
 *
 * Correção:
 *  1. Apaga os 2 appointments criados por engano (e Session/MedicalEvent
 *     associados) — nunca foram reais, não precisam de estorno formal.
 *  2. Reaproveita os 2 appointments ORIGINAIS (mesmo _id, já estornados):
 *     - 21/07 10:00 (…81e) → 18/08 10:00, pre_agendado
 *     - 28/07 10:00 (…bb3) → 18/08 09:20, pre_agendado
 *     Colocando as duas reposições NA MESMA semana (preenchendo os 2 slots
 *     do plano) em vez de espalhadas — assim bate com o padrão que já existe
 *     (09:20 + 10:00 toda terça) e não sofre nova reposição automática.
 *
 * USO:
 *   node scripts/maintenance/fix-guide-16411088-reuse-same-appointments.mjs             (dry-run)
 *   node scripts/maintenance/fix-guide-16411088-reuse-same-appointments.mjs --apply
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config();

import '../../models/index.js';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import MedicalEvent from '../../models/MedicalEvent.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import { syncEvent } from '../../services/syncService.js';

const argv = process.argv;
const APPLY = argv.includes('--apply');
const TZ = 'America/Sao_Paulo';

const GUIDE_ID = '6a5a2dc5ce43485b2af4c307';
const PLAN_ID = '6a5a2df0ce43485b2af4c333';

// Criados por engano no reparo anterior — apagar.
const ERRADOS = ['6a8347f844300abd58ae91d6', '6a8347f844300abd58ae91e6'];

// Originais (fantasma, já estornados) — reaproveitar.
const REUSE = [
  { apptId: '6a5a2df393897a6b591bf81e', sessionId: '6a5a2df4ce43485b2af4c363', newDate: '2026-08-18', newTime: '10:00' },
  { apptId: '6a833ed7b2f7af06da492bb3', sessionId: '6a833ed7b2f7af06da492bb5', newDate: '2026-08-18', newTime: '09:20' },
];

const d10 = (d) => moment.tz(d, TZ).format('YYYY-MM-DD (ddd)');
const MOTIVO = 'Reabertura: appointment estornado reaproveitado como reposição pre_agendado no fim da agenda (correção do reparo de 2026-08-17, guia 16411088)';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  console.log(`\n${APPLY ? '🔧 MODO APPLY (grava)' : '🔍 DRY-RUN (não grava nada)'}\n`);

  // ── 1. Apagar os 2 criados por engano ──
  console.log('── 1. APAGAR APPOINTMENTS CRIADOS POR ENGANO ──');
  for (const id of ERRADOS) {
    const appt = await Appointment.findById(id).lean();
    if (!appt) { console.log(`  ${id}: já não existe (no-op)`); continue; }
    if (appt.operationalStatus === 'completed') {
      throw new Error(`ABORTADO: ${id} está 'completed' — não é seguro apagar, precisa de estorno formal.`);
    }
    console.log(`  ${d10(appt.date)} ${appt.time} (${id}) status=${appt.operationalStatus} → será apagado`);
    if (APPLY) {
      await Session.deleteMany({ $or: [{ appointmentId: appt._id }, { appointment: appt._id }] });
      await MedicalEvent.deleteMany({ originalId: appt._id, type: 'appointment' });
      await Appointment.deleteOne({ _id: appt._id });
      console.log(`    ✅ apagado (appointment + session + medicalEvent)`);
    }
  }

  // ── 2. Checar conflito de slot antes de reativar ──
  console.log('\n── 2. VERIFICAR CONFLITO DE HORÁRIO ──');
  const doctor = (await Appointment.findById(REUSE[0].apptId).lean())?.doctor;
  for (const r of REUSE) {
    const target = moment.tz(`${r.newDate} 00:00`, 'YYYY-MM-DD HH:mm', TZ).toDate();
    const conflito = await Appointment.findOne({
      _id: { $nin: [...REUSE.map(x => x.apptId), ...ERRADOS] },
      doctor,
      date: target,
      time: r.newTime,
      operationalStatus: { $nin: ['canceled'] },
    }).lean();
    if (conflito) {
      throw new Error(`ABORTADO: já existe appointment ${conflito._id} em ${r.newDate} ${r.newTime} pro mesmo profissional.`);
    }
    console.log(`  ${r.newDate} ${r.newTime}: ✅ livre`);
  }

  // ── 3. Reativar os 2 originais ──
  console.log('\n── 3. REATIVAR APPOINTMENTS ORIGINAIS (mesmo _id) ──');
  for (const r of REUSE) {
    const appt = await Appointment.findById(r.apptId).lean();
    if (!appt) throw new Error(`ABORTADO: appointment original ${r.apptId} não encontrado.`);
    if (appt.operationalStatus !== 'canceled') {
      console.log(`  ${r.apptId}: status atual '${appt.operationalStatus}' (esperado 'canceled') — pulando, possível no-op de execução anterior`);
      continue;
    }

    const target = moment.tz(`${r.newDate} 00:00`, 'YYYY-MM-DD HH:mm', TZ).toDate();
    console.log(`  ${d10(appt.date)} ${appt.time} → ${r.newDate} ${r.newTime}  (pre_agendado)`);

    if (APPLY) {
      await Appointment.updateOne({ _id: r.apptId }, {
        $set: {
          date: target,
          time: r.newTime,
          operationalStatus: 'pre_agendado',
          clinicalStatus: 'pending',
          paymentStatus: 'pending',
          visualFlag: null,
          cancelReason: '',
          cancelSource: null,
          canceledAt: null,
          missed: false,
          updatedAt: new Date(),
        },
        $push: {
          history: {
            action: 'reabertura_reposicao_pre_agendado',
            newStatus: 'pre_agendado',
            timestamp: new Date(),
            context: 'reparo_dados',
            details: { script: 'fix-guide-16411088-reuse-same-appointments', motivo: MOTIVO, newDate: r.newDate, newTime: r.newTime }
          }
        }
      });

      await Session.updateOne({ _id: r.sessionId }, {
        $set: {
          date: target,
          time: r.newTime,
          status: 'scheduled',
          canceledAt: null,
          cancelReason: null,
          visualFlag: 'pending',
          updatedAt: new Date(),
        }
      });

      const updated = await Appointment.findById(r.apptId).lean();
      await syncEvent(updated, 'appointment');
      console.log(`    ✅ reativado e sincronizado no calendário`);
    }
  }

  // ── 4. Reconciliação final ──
  if (APPLY) {
    console.log('\n── RECONCILIAÇÃO ──');
    const guide = await InsuranceGuide.findById(GUIDE_ID).lean();
    console.log(`  guia.usedSessions = ${guide.usedSessions} (esperado 6) ${guide.usedSessions === 6 ? '✅' : '🚫'}`);

    const semanaFinal = await Appointment.find({ insurancePlan: PLAN_ID, date: moment.tz('2026-08-18 00:00', 'YYYY-MM-DD HH:mm', TZ).toDate() }).lean();
    console.log(`  2026-08-18: ${semanaFinal.length} appointment(s)`);
    semanaFinal.forEach(a => console.log(`    ${a.time} ${a.operationalStatus} (${a._id})`));

    for (const id of ERRADOS) {
      const stillExists = await Appointment.exists({ _id: id });
      console.log(`  ${id} apagado: ${!stillExists ? '✅' : '🚫 ainda existe'}`);
    }
  } else {
    console.log('\nNada foi gravado. Para aplicar: --apply\n');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error('\n🚫', err.message); process.exit(1); });
