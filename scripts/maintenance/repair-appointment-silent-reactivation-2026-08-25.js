#!/usr/bin/env node
/**
 * 🔧 REPARO: Appointments cancelados reativados silenciosamente
 *
 * Contexto (auditoria 2026-08-25): 157 Appointments com o último evento de
 * `history` igual a `cancelamento`, mas `operationalStatus` ativo hoje — ou
 * seja, foram reativados por algum write path sem nenhuma ação humana
 * correspondente (nenhuma entrada nova em history). Reclassificação
 * bidirecional (Session/Payment por _id OU appointment OU appointmentId,
 * não só Appointment.session/.payment) separou os 157 em:
 *   - 101 "reparável, alta confiança": canceledAt e/ou Session+Payment
 *     concordam que foi cancelado de verdade.
 *   - 53 "indeterminado": irmão encontrado mas em estado ativo (a trinca
 *     inteira foi reativada, não só o Appointment) — fora deste reparo.
 *   - 3 "contradição clínica/financeira": Session completed ou Payment
 *     paid — fora deste reparo, exigem revisão individual.
 *
 * Este script trata SOMENTE os 101. Não toca nos 53 nem nos 3.
 *
 * Modo padrão: DRY-RUN (só relatório, zero escrita).
 * Uso:
 *   node scripts/maintenance/repair-appointment-silent-reactivation-2026-08-25.js
 *   node scripts/maintenance/repair-appointment-silent-reactivation-2026-08-25.js --apply
 *   node scripts/maintenance/repair-appointment-silent-reactivation-2026-08-25.js --apply --expected-count=101
 *
 * Garantias:
 *   - Idempotente: o manifesto é recomputado do zero a cada execução com os
 *     mesmos critérios; depois do reparo, os registros deixam de casar
 *     (operationalStatus já não é mais 'ativo', último history já não é mais
 *     'cancelamento') — uma segunda execução encontra 0 candidatos.
 *   - --expected-count=N aborta ANTES de qualquer escrita se o manifesto
 *     recomputado não tiver exatamente N itens (protege contra rodar em
 *     cima de um estado que já mudou desde a auditoria).
 *   - Pré-condição revalidada por Appointment, individualmente, imediatamente
 *     antes do write: se o estado daquele registro específico mudou desde o
 *     snapshot, ELE é pulado (não aborta o lote inteiro).
 *   - Só altera Appointment.operationalStatus (-> 'canceled') e adiciona uma
 *     entrada de history com action='integrity_repair'. Nunca toca
 *     Session/Payment. clinicalStatus e canceledAt são preservados como já
 *     estavam.
 *   - Autorização via _fromWriteGateway (flag já documentada em
 *     services/appointment/AppointmentWriteGuard.js — não é uma flag nova).
 *   - Snapshot completo (antes/depois) salvo em JSON.
 *   - Ao final do --apply, reconstrói PatientsView só dos pacientes
 *     efetivamente reparados (buildPatientView com force:true).
 */

import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import { buildPatientView } from '../../domains/clinical/services/patientProjectionService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const expectedCountArg = ARGS.find(a => a.startsWith('--expected-count='));
const EXPECTED_COUNT = expectedCountArg ? parseInt(expectedCountArg.split('=')[1], 10) : null;

const ATIVO = ['pre_agendado', 'scheduled', 'confirmed', 'pending', 'suspended', 'paid', 'missed', 'processing_create', 'processing_complete', 'processing_cancel'];
const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const REASON = 'Reparo de integridade (auditoria 2026-08-25): operationalStatus havia sido revertido para um estado ativo após cancelamento real (canceledAt e/ou Session+Payment vinculados confirmam), sem nenhuma ação humana correspondente registrada em history. Session e Payment não foram alterados.';

async function findSiblings(appointmentId, apptSessionField, apptPaymentField) {
  const sessionCandidates = await Session.find({
    $or: [
      ...(apptSessionField ? [{ _id: apptSessionField }] : []),
      { appointment: appointmentId },
      { appointmentId: appointmentId },
    ]
  }).select('status appointment appointmentId').lean();

  const paymentCandidates = await Payment.find({
    $or: [
      ...(apptPaymentField ? [{ _id: apptPaymentField }] : []),
      { appointment: appointmentId },
      { appointmentId: appointmentId },
    ]
  }).select('status appointment appointmentId').lean();

  return {
    sessions: [...new Map(sessionCandidates.map(s => [s._id.toString(), s])).values()],
    payments: [...new Map(paymentCandidates.map(p => [p._id.toString(), p])).values()],
  };
}

/**
 * Recomputa o manifesto do zero. Mesma lógica da auditoria de 2026-08-25
 * (Fase 1 + Fase 2), restrita à categoria REPARAVEL_ALTA_CONFIANCA.
 */
async function buildManifest() {
  const candidates = await Appointment.find({
    'history.0': { $exists: true },
    operationalStatus: { $in: ATIVO },
  }).select('patient date operationalStatus clinicalStatus history canceledAt cancelReason session payment updatedAt').lean();

  const realConflicts = candidates.filter(a => a.history[a.history.length - 1]?.action === 'cancelamento');

  const manifest = [];
  for (const a of realConflicts) {
    const { sessions, payments } = await findSiblings(a._id, a.session, a.payment);

    const anySessionCompleted = sessions.some(s => s.status === 'completed');
    const anyPaymentPaid = payments.some(p => p.status === 'paid');
    if (anySessionCompleted || anyPaymentPaid) continue; // contradição — nunca entra neste reparo

    const sessionDuplicity = sessions.length > 1;
    const paymentDuplicity = payments.length > 1;
    if (sessionDuplicity || paymentDuplicity) continue; // duplicidade — fora do escopo deste reparo

    const allSessionsCanceled = sessions.length > 0 && sessions.every(s => s.status === 'canceled');
    const allPaymentsCanceled = payments.length > 0 && payments.every(p => p.status === 'canceled');
    const hasCanceledAt = !!a.canceledAt;

    const isReparavel =
      (hasCanceledAt && allSessionsCanceled && allPaymentsCanceled) ||
      (allSessionsCanceled && allPaymentsCanceled); // sem canceledAt, mas ambos os irmãos concordam

    if (!isReparavel) continue; // indeterminado — fora do escopo deste reparo

    manifest.push({
      appointmentId: a._id.toString(),
      patientId: a.patient?.toString() || null,
      date: a.date?.toISOString().slice(0, 10),
      expectedCurrentOperationalStatus: a.operationalStatus,
      expectedClinicalStatus: a.clinicalStatus,
      expectedCanceledAt: a.canceledAt,
      expectedLastHistoryAction: 'cancelamento',
      sessionIds: sessions.map(s => s._id.toString()),
      paymentIds: payments.map(p => p._id.toString()),
    });
  }
  return manifest;
}

async function snapshotFullDocs(manifest) {
  const out = [];
  for (const item of manifest) {
    const appt = await Appointment.findById(item.appointmentId).lean();
    const sessions = await Session.find({ _id: { $in: item.sessionIds } }).lean();
    const payments = await Payment.find({ _id: { $in: item.paymentIds } }).lean();
    out.push({ appointment: appt, sessions, payments });
  }
  return out;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  console.log(`\n=== REPARO: reativação silenciosa de Appointments cancelados ===`);
  console.log(`Modo: ${APPLY ? '⚠️  APPLY (vai escrever)' : 'DRY-RUN (só leitura)'}`);
  if (EXPECTED_COUNT !== null) console.log(`Contagem esperada: ${EXPECTED_COUNT}`);

  const manifest = await buildManifest();
  const distinctPatients = new Set(manifest.map(m => m.patientId));

  console.log(`\nManifesto recomputado agora: ${manifest.length} Appointments, ${distinctPatients.size} pacientes distintos`);

  if (EXPECTED_COUNT !== null && manifest.length !== EXPECTED_COUNT) {
    console.error(`\n❌ ABORTADO: esperado ${EXPECTED_COUNT}, encontrado ${manifest.length}. O estado do banco mudou desde a auditoria — não prosseguindo sem revisão.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  if (manifest.length === 0) {
    console.log('\n✅ Nada a fazer — nenhum candidato encontrado (já reparado, ou nunca existiu neste ambiente).');
    await mongoose.disconnect();
    return;
  }

  // Snapshot "antes" — sempre, dry-run ou apply
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const beforeSnapshot = await snapshotFullDocs(manifest);
  const beforePath = path.join(SNAPSHOT_DIR, `${RUN_ID}-before.json`);
  fs.writeFileSync(beforePath, JSON.stringify({ manifest, snapshot: beforeSnapshot }, null, 2));
  console.log(`\n📸 Snapshot "antes" salvo em: ${beforePath}`);

  console.log(`\n=== RESUMO DO MANIFESTO ===`);
  console.log(`Total de Appointments: ${manifest.length}`);
  console.log(`Pacientes distintos: ${distinctPatients.size}`);
  console.log(`Sessions completed encontradas: 0 (excluídas na construção do manifesto)`);
  console.log(`Payments paid encontrados: 0 (excluídos na construção do manifesto)`);
  console.log(`Mudança prevista em produção/caixa: nenhuma (nenhum Session completed, nenhum Payment paid neste lote)`);

  if (!APPLY) {
    console.log(`\n=== AMOSTRA (5 de ${manifest.length}) ===`);
    manifest.slice(0, 5).forEach(m => console.log(JSON.stringify(m, null, 2)));
    console.log(`\nℹ️  DRY-RUN — nada foi escrito. Rode com --apply --expected-count=${manifest.length} para aplicar.`);
    await mongoose.disconnect();
    return;
  }

  // ─── APPLY ───────────────────────────────────────────────────────────
  const repaired = [];
  const skipped = [];

  for (const item of manifest) {
    // Revalidação individual imediatamente antes do write — se o estado
    // deste registro específico mudou desde o snapshot, pula (não aborta o lote).
    const current = await Appointment.findById(item.appointmentId).lean();
    if (!current) {
      skipped.push({ appointmentId: item.appointmentId, reason: 'NOT_FOUND' });
      continue;
    }
    const lastHistory = current.history?.[current.history.length - 1];
    const stateMatchesSnapshot =
      current.operationalStatus === item.expectedCurrentOperationalStatus &&
      lastHistory?.action === 'cancelamento';

    if (!stateMatchesSnapshot) {
      skipped.push({
        appointmentId: item.appointmentId,
        reason: 'STATE_CHANGED_SINCE_SNAPSHOT',
        currentOperationalStatus: current.operationalStatus,
        currentLastHistoryAction: lastHistory?.action,
      });
      continue;
    }

    const updated = await Appointment.findOneAndUpdate(
      {
        _id: item.appointmentId,
        operationalStatus: item.expectedCurrentOperationalStatus, // CAS — mesmo filtro revalidado acima
      },
      {
        $set: {
          operationalStatus: 'canceled',
          _fromWriteGateway: true,
        },
        $push: {
          history: {
            action: 'integrity_repair',
            newStatus: 'canceled',
            timestamp: new Date(),
            context: REASON,
          },
        },
      },
      { new: true }
    );

    if (!updated) {
      skipped.push({ appointmentId: item.appointmentId, reason: 'CAS_MISS_AT_WRITE_TIME' });
      continue;
    }

    repaired.push({ appointmentId: item.appointmentId, patientId: item.patientId });
    console.log(`  ✅ Reparado: ${item.appointmentId} (paciente ${item.patientId})`);
  }

  console.log(`\n=== RESULTADO DO REPARO ===`);
  console.log(`Reparados: ${repaired.length}`);
  console.log(`Pulados: ${skipped.length}`);
  if (skipped.length > 0) {
    console.log('Motivos:', JSON.stringify(skipped, null, 2));
  }

  // Rebuild da PatientsView SÓ dos pacientes efetivamente reparados
  const patientsToRebuild = [...new Set(repaired.map(r => r.patientId).filter(Boolean))];
  console.log(`\n=== REBUILD DE PatientsView (${patientsToRebuild.length} pacientes) ===`);
  const rebuildResults = [];
  for (const patientId of patientsToRebuild) {
    try {
      await buildPatientView(patientId, { correlationId: `integrity_repair_${RUN_ID}`, force: true });
      rebuildResults.push({ patientId, status: 'ok' });
      console.log(`  🔄 PatientsView reconstruída: ${patientId}`);
    } catch (err) {
      rebuildResults.push({ patientId, status: 'error', error: err.message });
      console.error(`  ❌ Falha ao reconstruir PatientsView de ${patientId}:`, err.message);
    }
  }

  // Snapshot "depois"
  const afterSnapshot = await snapshotFullDocs(manifest);
  const afterPath = path.join(SNAPSHOT_DIR, `${RUN_ID}-after.json`);
  fs.writeFileSync(afterPath, JSON.stringify({ repaired, skipped, rebuildResults, snapshot: afterSnapshot }, null, 2));
  console.log(`\n📸 Snapshot "depois" salvo em: ${afterPath}`);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('❌ ERRO FATAL:', err);
  process.exit(1);
});
