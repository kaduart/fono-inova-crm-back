#!/usr/bin/env node
/**
 * Auditoria READ-ONLY: para as guias per_month faturadas em múltiplos lotes
 * (achado por audit-guide-partial-billing-pattern.js), verifica se, entre o
 * PRIMEIRO lote e o(s) lote(s) seguinte(s), existiam appointments que na
 * época do primeiro lote estavam scheduled/pre_agendado/confirmed (portanto
 * seriam CANCELADOS por closeGuideBillingPeriod se ele já existisse) e que
 * DEPOIS foram completed e entraram num lote posterior.
 *
 * Isso responde diretamente: "faturamento parcial no meio do mês teria
 * cancelado sessão que a secretária ainda ia usar?" — com dado real, não
 * suposição.
 *
 * Não escreve nada no banco.
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config();

import '../../models/index.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Session from '../../models/Session.js';
import Appointment from '../../models/Appointment.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';

const GUIDE_NUMBERS = ['2325', '2321', '2525', '6644', '5588', '2324'];

async function main() {
  const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
  await mongoose.connect(mongoUri);
  console.log('Conectado.\n');

  for (const number of GUIDE_NUMBERS) {
    const guide = await InsuranceGuide.findOne({ number }).lean();
    if (!guide) { console.log(`Guia ${number} não encontrada, pulando.`); continue; }

    const sessions = await Session.find({ insuranceGuide: guide._id, billingBatchId: { $ne: null } })
      .select('date billingBatchId appointmentId createdAt updatedAt')
      .sort({ date: 1 })
      .lean();

    const batchIds = [...new Set(sessions.map(s => String(s.billingBatchId)))];
    const batches = await InsuranceBatch.find({ _id: { $in: batchIds } }).select('batchNumber createdAt').sort({ createdAt: 1 }).lean();
    if (batches.length < 2) continue;

    const firstBatchDate = batches[0].createdAt;
    const laterBatchIds = new Set(batches.slice(1).map(b => b._id.toString()));

    // Sessões que foram faturadas em lotes POSTERIORES ao primeiro
    const sessionsInLaterBatches = sessions.filter(s => laterBatchIds.has(String(s.billingBatchId)));

    console.log(`\n=== Guia ${number} (${guide.insurance}) ===`);
    console.log(`Primeiro lote criado em: ${firstBatchDate?.toISOString?.().slice(0,10)}`);
    console.log(`Sessões faturadas em lotes POSTERIORES ao primeiro: ${sessionsInLaterBatches.length}`);

    for (const s of sessionsInLaterBatches) {
      if (!s.appointmentId) continue;
      const appt = await Appointment.findById(s.appointmentId).select('date operationalStatus history createdAt').lean();
      if (!appt) continue;

      // Estava scheduled/pre_agendado/confirmed ANTES do primeiro lote (criado antes, e só virou completed depois)?
      const wasCreatedBeforeFirstBatch = appt.createdAt && appt.createdAt < firstBatchDate;
      const completedHistoryEntry = (appt.history || []).find(h => h.newStatus === 'completed');
      const completedAt = completedHistoryEntry?.timestamp;
      const completedAfterFirstBatch = completedAt && completedAt > firstBatchDate;

      console.log(
        `  session.date=${s.date?.toISOString?.().slice(0,10)} appt.createdAt=${appt.createdAt?.toISOString?.().slice(0,10)} ` +
        `completedAt=${completedAt ? completedAt.toISOString().slice(0,10) : '—'} ` +
        `>>> ${wasCreatedBeforeFirstBatch && completedAfterFirstBatch ? 'CRIADO ANTES DO 1º LOTE E COMPLETADO DEPOIS — teria sido CANCELADO incorretamente' : (wasCreatedBeforeFirstBatch ? 'criado antes do 1º lote (completedAt indisponível p/ confirmar)' : 'criado depois do 1º lote (nunca existia pra cancelar)')}`
      );
    }
  }

  await mongoose.disconnect();
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect(); process.exit(1); });
