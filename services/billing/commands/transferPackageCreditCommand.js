// back/services/billing/commands/transferPackageCreditCommand.js
/**
 * Transfer Package Credit Command
 *
 * Converte sessões CONTRATADAS E NÃO REALIZADAS de um pacote para outro,
 * levando junto a cobertura já paga.
 *
 * Caso de origem (2026-08-12): pacote de 8 sessões de fono, R$ 1.440 pagos
 * antecipadamente. Duas realizadas, duas mantidas, quatro redirecionadas para
 * psicologia por decisão da equipe. O dinheiro já entrou — o que muda é o que
 * será entregue.
 *
 * ══ INVARIANTES (quebrar qualquer um destes é bug grave) ═══════════════════
 *
 * 1. O pacote de ORIGEM preserva totalSessions e totalValue. A venda e o
 *    recebimento são fatos históricos: reduzir 8→4 ou 1.440→720 reescreveria
 *    o caixa de uma data que já fechou.
 * 2. ENTRADA NOVA EM CAIXA = ZERO. Nenhum Payment é criado, em nenhum dos dois
 *    pacotes. O pacote de destino nasce coberto via `fundedByTransfer`.
 * 3. Sessões REALIZADAS nunca são tocadas — nem status, nem valor, nem comissão.
 * 4. Não usa PatientBalance: crédito solto some da rastreabilidade origem→destino.
 * 5. Nenhuma sessão é transferida duas vezes (guard por `Appointment.transferId`).
 * 6. Idempotente por `idempotencyKey`: duplo clique não gera cobertura dobrada.
 * 7. Não recalcula comissão: sessões não realizadas nunca geraram comissão.
 * 8. Tudo ou nada — uma única transação MongoDB.
 */

import mongoose from 'mongoose';
import Package from '../../../models/Package.js';
import Appointment from '../../../models/Appointment.js';
import Session from '../../../models/Session.js';
import Doctor from '../../../models/Doctor.js';
import PackageCreditTransfer from '../../../models/PackageCreditTransfer.js';
import { runTransactionWithRetry } from '../../../utils/transactionRetry.js';
import { saveToOutbox } from '../../../infrastructure/outbox/outboxPattern.js';
import { EventTypes } from '../../../infrastructure/events/eventPublisher.js';
import { executeWithSession as cancelAppointmentWithSession } from '../../appointment/commands/cancelAppointmentCommand.js';
import { checkSlotOverlap } from '../../../middleware/conflictDetection.js';

function buildError(message, status = 400, code = 'TRANSFER_ERROR', extra = {}) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

const ACTIVE_STATUSES = ['pre_agendado', 'scheduled', 'confirmed'];

/**
 * Sessões que a cobertura paga do pacote de origem consegue bancar.
 * Usa o valor por sessão do próprio pacote — é assim que o contrato foi vendido.
 */
function paidSlots(pkg) {
  const unit = Number(pkg.sessionValue) || 0;
  if (unit <= 0) return 0;
  return Math.floor((Number(pkg.totalPaid) || 0) / unit + 1e-9);
}

const SESSION_DURATION_MIN = 40;

function normalizeDateOnly(value) {
  if (!value) return null;
  const str = String(value);
  const datePart = str.includes('T') ? str.split('T')[0] : str;
  return /^\d{4}-\d{2}-\d{2}$/.test(datePart) ? datePart : null;
}

/** Data + hora locais como Date, sem deslocar por fuso. */
function buildDateTime(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

/**
 * Valida a agenda das sessões DESTINO.
 *
 * Não presume que o profissional novo está livre no horário antigo — foi
 * justamente isso que motivou a data/hora serem editáveis por sessão.
 * Roda no preview e de novo dentro da transação: entre revisar e confirmar
 * alguém pode ter ocupado o horário.
 */
async function validateSchedule({ schedule, appointmentIds, doctorId, specialty, patientId, mongoSession = null }) {
  if (!Array.isArray(schedule) || schedule.length === 0) {
    throw buildError('Informe data e horário de cada sessão do novo pacote', 400, 'MISSING_SCHEDULE');
  }
  if (schedule.length !== appointmentIds.length) {
    throw buildError(
      `São ${appointmentIds.length} sessão(ões) selecionada(s), mas ${schedule.length} agendamento(s) informado(s).`,
      400, 'SCHEDULE_COUNT_MISMATCH'
    );
  }

  const selected = new Set(appointmentIds.map(String));
  const seenSources = new Set();
  const seenSlots = new Set();
  const normalized = [];
  const todayStr = new Date().toISOString().slice(0, 10);

  for (const [index, row] of schedule.entries()) {
    const position = index + 1;
    const sourceAppointmentId = String(row.sourceAppointmentId || '');

    if (!selected.has(sourceAppointmentId)) {
      throw buildError(
        `A sessão ${position} do agendamento não corresponde a nenhuma sessão selecionada.`,
        400, 'SCHEDULE_SOURCE_MISMATCH'
      );
    }
    if (seenSources.has(sourceAppointmentId)) {
      throw buildError(`A sessão de origem ${position} foi agendada duas vezes.`, 400, 'SCHEDULE_DUPLICATE_SOURCE');
    }
    seenSources.add(sourceAppointmentId);

    const date = normalizeDateOnly(row.date);
    const time = /^\d{2}:\d{2}$/.test(String(row.time || '')) ? String(row.time) : null;

    if (!date) throw buildError(`Informe a data da sessão ${position}.`, 400, 'MISSING_SCHEDULE_DATE', { position });
    if (!time) throw buildError(`Informe o horário da sessão ${position} (HH:MM).`, 400, 'MISSING_SCHEDULE_TIME', { position });
    if (date < todayStr) {
      throw buildError(
        `A sessão ${position} está marcada para ${date}, que já passou.`,
        422, 'SCHEDULE_DATE_IN_PAST', { position, date }
      );
    }

    const slotKey = `${date}|${time}`;
    if (seenSlots.has(slotKey)) {
      throw buildError(
        `Duas sessões novas foram marcadas para ${date} às ${time}.`,
        422, 'SCHEDULE_INTERNAL_CONFLICT', { position, date, time }
      );
    }
    seenSlots.add(slotKey);

    normalized.push({ sourceAppointmentId, date, time });
  }

  // Conflito de agenda do PROFISSIONAL (regra canônica de ocupação)
  for (const [index, row] of normalized.entries()) {
    const overlap = await checkSlotOverlap({
      doctorId,
      date: row.date,
      time: row.time,
      duration: SESSION_DURATION_MIN,
    });
    if (overlap) {
      throw buildError(
        `O profissional já tem compromisso em ${row.date} às ${row.time}.`,
        409, 'DOCTOR_SLOT_CONFLICT',
        { position: index + 1, date: row.date, time: row.time, conflictId: overlap._id?.toString?.() || null }
      );
    }
  }

  // Conflito de agenda do PACIENTE — não pode estar em dois atendimentos ao mesmo tempo
  for (const [index, row] of normalized.entries()) {
    const q = Appointment.findOne({
      patient: patientId,
      date: buildDateTime(row.date, row.time),
      time: row.time,
      operationalStatus: { $nin: ['canceled', 'suspended'] },
    });
    if (mongoSession) q.session(mongoSession);
    const clash = await q.lean();
    if (clash) {
      throw buildError(
        `O paciente já tem atendimento em ${row.date} às ${row.time}.`,
        409, 'PATIENT_SLOT_CONFLICT',
        { position: index + 1, date: row.date, time: row.time, conflictId: clash._id?.toString?.() || null }
      );
    }
  }

  return normalized;
}

/** O profissional precisa atender a especialidade de destino. */
async function assertDoctorHandlesSpecialty(doctorId, specialty) {
  const doctor = await Doctor.findById(doctorId).lean();
  if (!doctor) throw buildError('Profissional de destino não encontrado', 404, 'TARGET_DOCTOR_NOT_FOUND');

  const declared = [doctor.specialty, ...(doctor.specialties || [])]
    .filter(Boolean)
    .map(s => String(s).toLowerCase());

  if (declared.length > 0 && !declared.includes(String(specialty).toLowerCase())) {
    throw buildError(
      `${doctor.fullName || 'O profissional'} não atende ${specialty}.`,
      422, 'DOCTOR_SPECIALTY_MISMATCH', { doctorId: String(doctorId), specialty }
    );
  }
  return doctor;
}

/**
 * Valida os appointments escolhidos e separa o que precisa ser cancelado
 * do que já está cancelado (e só será recarimbado).
 */
function classifyAppointments(appointments, sourcePackageId, sourcePatientId) {
  const toCancel = [];
  const alreadyCanceled = [];

  for (const appt of appointments) {
    const belongs = String(appt.package || '') === String(sourcePackageId);
    if (!belongs) {
      throw buildError(
        `O agendamento ${appt._id} não pertence a este pacote.`,
        422, 'APPOINTMENT_NOT_IN_PACKAGE'
      );
    }

    // Cobertura é do paciente que pagou. Transferir entre pacientes seria
    // mover dinheiro de um para outro.
    if (sourcePatientId && String(appt.patient || '') !== String(sourcePatientId)) {
      throw buildError(
        'A sessão pertence a outro paciente.',
        422, 'PATIENT_MISMATCH', { appointmentId: appt._id.toString() }
      );
    }

    // Invariante 3: sessão realizada é intocável.
    if (appt.operationalStatus === 'completed' || appt.clinicalStatus === 'completed') {
      throw buildError(
        'Sessão já realizada não pode ser transferida. O atendimento aconteceu e a cobertura foi consumida.',
        422, 'SESSION_ALREADY_DELIVERED', { appointmentId: appt._id.toString() }
      );
    }

    // Invariante 5: nada de transferir a mesma sessão duas vezes.
    if (appt.transferId) {
      throw buildError(
        'Esta sessão já foi transferida para outro pacote.',
        409, 'SESSION_ALREADY_TRANSFERRED',
        { appointmentId: appt._id.toString(), transferId: appt.transferId.toString() }
      );
    }

    if (appt.operationalStatus === 'canceled') {
      alreadyCanceled.push(appt);
    } else if (ACTIVE_STATUSES.includes(appt.operationalStatus)) {
      toCancel.push(appt);
    } else {
      throw buildError(
        `Agendamento em estado "${appt.operationalStatus}" não pode ser transferido.`,
        422, 'APPOINTMENT_STATE_NOT_TRANSFERABLE', { appointmentId: appt._id.toString() }
      );
    }
  }

  return { toCancel, alreadyCanceled };
}

/**
 * @param {Object} input
 * @param {string} input.sourcePackageId
 * @param {string[]} input.appointmentIds  - sessões a converter (futuras, agendadas ou já canceladas)
 * @param {Object} input.target            - { specialty, doctorId, sessionValue?, modality? }
 * @param {string} input.reason
 * @param {string} input.idempotencyKey
 * @param {Object} user
 * @param {string} [correlationId]
 */
export async function execute(input, user, correlationId = null) {
  const {
    sourcePackageId,
    appointmentIds = [],
    target = {},
    reason,
    idempotencyKey,
  } = input || {};

  // ── Validação de entrada ────────────────────────────────────────────────
  if (!sourcePackageId || !mongoose.Types.ObjectId.isValid(sourcePackageId)) {
    throw buildError('ID do pacote de origem inválido', 400, 'INVALID_SOURCE_PACKAGE');
  }
  if (!Array.isArray(appointmentIds) || appointmentIds.length === 0) {
    throw buildError('Selecione ao menos uma sessão para transferir', 400, 'NO_SESSIONS_SELECTED');
  }
  if (appointmentIds.some(id => !mongoose.Types.ObjectId.isValid(id))) {
    throw buildError('Lista de sessões contém ID inválido', 400, 'INVALID_APPOINTMENT_ID');
  }
  if (new Set(appointmentIds.map(String)).size !== appointmentIds.length) {
    throw buildError('A mesma sessão foi enviada mais de uma vez', 400, 'DUPLICATE_APPOINTMENT_ID');
  }
  if (!target.specialty) {
    throw buildError('Informe a especialidade de destino', 400, 'MISSING_TARGET_SPECIALTY');
  }
  if (!target.doctorId || !mongoose.Types.ObjectId.isValid(target.doctorId)) {
    throw buildError('Informe o profissional de destino', 400, 'MISSING_TARGET_DOCTOR');
  }
  if (!reason || !String(reason).trim()) {
    throw buildError('Informe o motivo da transferência', 400, 'MISSING_REASON');
  }
  if (!idempotencyKey) {
    throw buildError('idempotencyKey é obrigatório', 400, 'MISSING_IDEMPOTENCY_KEY');
  }

  const cid = correlationId || `pkg_transfer_${Date.now()}`;

  // ── Invariante 6: idempotência antes de qualquer escrita ────────────────
  const existing = await PackageCreditTransfer.findOne({ idempotencyKey }).lean();
  if (existing) {
    // Devolve o MESMO resultado: transferência, pacote e agendamentos já
    // criados. Não recria nada — repetir a chave nunca duplica agenda.
    const [existingPackage, existingAppointments] = await Promise.all([
      Package.findById(existing.targetPackageId).lean(),
      Appointment.find({ package: existing.targetPackageId })
        .select('_id date time sourceAppointmentId')
        .lean(),
    ]);

    return {
      data: existing,
      targetPackage: existingPackage,
      newAppointments: existingAppointments || [],
      alreadyProcessed: true,
      correlationId: cid,
      message: 'Transferência já processada anteriormente.',
    };
  }

  const result = await runTransactionWithRetry(async (mongoSession) => {
    const source = await Package.findById(sourcePackageId).session(mongoSession).lean();
    if (!source) {
      throw buildError('Pacote de origem não encontrado', 404, 'SOURCE_PACKAGE_NOT_FOUND');
    }

    // Só pacote pré-pago tem cobertura para transferir. No per_session o
    // paciente paga na hora do atendimento: cancelar não deixa crédito nenhum.
    if (source.model !== 'prepaid') {
      throw buildError(
        'Só pacotes pré-pagos têm cobertura a transferir. Em pacotes por sessão o paciente paga no dia do atendimento, então cancelar não gera crédito.',
        422, 'SOURCE_NOT_PREPAID'
      );
    }

    const unitValue = Number(source.sessionValue) || 0;
    if (unitValue <= 0) {
      throw buildError('Pacote de origem sem valor por sessão definido', 422, 'SOURCE_WITHOUT_UNIT_VALUE');
    }
    if (!(Number(source.totalPaid) > 0)) {
      throw buildError('Pacote de origem não possui valor recebido para transferir', 422, 'SOURCE_WITHOUT_PAYMENT');
    }

    const appointments = await Appointment.find({ _id: { $in: appointmentIds } })
      .session(mongoSession)
      .lean();

    if (appointments.length !== appointmentIds.length) {
      throw buildError('Uma ou mais sessões selecionadas não foram encontradas', 404, 'APPOINTMENT_NOT_FOUND');
    }

    const { toCancel, alreadyCanceled } = classifyAppointments(appointments, source._id, source.patient);
    const sessionCount = appointments.length;
    const amount = Number((sessionCount * unitValue).toFixed(2));

    // Profissional precisa atender a especialidade antes de qualquer escrita
    await assertDoctorHandlesSpecialty(target.doctorId, target.specialty);

    // Normaliza/valida a agenda cedo: se um horário estiver ocupado, nada é criado
    const normalizedSchedule = await validateSchedule({
      schedule: target.schedule,
      appointmentIds,
      doctorId: target.doctorId,
      specialty: target.specialty,
      patientId: source.patient,
      mongoSession,
    });

    // ── Invariante 1 e 5: a cobertura paga precisa bancar tudo ────────────
    // realizadas + futuras que continuam + já transferidas + estas agora
    const selectedIds = new Set(appointmentIds.map(String));

    const [completedCount, remainingScheduled, previousTransfers] = await Promise.all([
      Appointment.countDocuments({ package: source._id, operationalStatus: 'completed' }).session(mongoSession),
      Appointment.countDocuments({
        package: source._id,
        operationalStatus: { $in: ACTIVE_STATUSES },
        _id: { $nin: appointmentIds },
      }).session(mongoSession),
      PackageCreditTransfer.aggregate([
        { $match: { sourcePackageId: source._id, status: 'completed' } },
        { $group: { _id: null, sessions: { $sum: '$sessionCount' } } },
      ]).session(mongoSession),
    ]);

    const alreadyTransferred = previousTransfers?.[0]?.sessions || 0;
    const committed = completedCount + remainingScheduled + alreadyTransferred + sessionCount;
    const available = paidSlots(source);

    if (committed > available) {
      throw buildError(
        `Cobertura insuficiente: o pacote pagou ${available} sessão(ões) e já tem ${committed - sessionCount} comprometida(s) ` +
        `(${completedCount} realizada(s), ${remainingScheduled} agendada(s), ${alreadyTransferred} transferida(s)). ` +
        `Não é possível transferir mais ${sessionCount}.`,
        422, 'INSUFFICIENT_COVERAGE',
        { available, committed, completedCount, remainingScheduled, alreadyTransferred, requested: sessionCount }
      );
    }

    // ── Pacote de destino ─────────────────────────────────────────────────
    const targetSessionValue = Number(target.sessionValue) > 0
      ? Number(target.sessionValue)
      : unitValue;
    const targetTotalValue = Number((sessionCount * targetSessionValue).toFixed(2));

    // Invariante 2: totalPaid vem da cobertura transferida, nunca de Payment.
    const coveredAmount = Math.min(amount, targetTotalValue);

    const [targetPackage] = await Package.create([{
      patient: source.patient,
      doctor: new mongoose.Types.ObjectId(target.doctorId),
      specialty: target.specialty,
      sessionType: target.specialty,
      type: 'therapy',
      model: 'prepaid',
      paymentType: 'full',
      // Sem paymentMethod de proposito: nao houve pagamento. Inventar um valor
      // (a) mente sobre o financeiro e (b) vaza para appointments criados
      // depois por outros fluxos via `pkg.paymentMethod`.
      sessionValue: targetSessionValue,
      totalSessions: sessionCount,
      totalValue: targetTotalValue,
      totalPaid: coveredAmount,
      fundedByTransfer: amount,
      // Campos obrigatórios herdados do contrato de origem
      date: new Date(),
      durationMonths: source.durationMonths || 1,
      sessionsPerWeek: source.sessionsPerWeek || 1,
      frequencyInterval: source.frequencyInterval || 'weekly',
      status: 'active',
      notes: `Financiado por transferência de ${sessionCount} sessão(ões) do pacote ${source._id.toString().slice(-6)} (${source.specialty}).`,
      // payments: [] de propósito — invariante 2
    }], { session: mongoSession });

    // ── Transferência (precisa do ID para carimbar as sessões) ────────────
    const [transfer] = await PackageCreditTransfer.create([{
      sourcePackageId: source._id,
      targetPackageId: targetPackage._id,
      patientId: source.patient,
      sessionCount,
      unitValue,
      amount,
      transferredAppointmentIds: appointments.map(a => a._id),
      transferredSessionIds: appointments.map(a => a.session).filter(Boolean),
      reason: String(reason).trim(),
      status: 'completed',
      createdBy: user?._id || null,
      idempotencyKey,
      correlationId: cid,
    }], { session: mongoSession });

    targetPackage.sourceTransferId = transfer._id;
    await targetPackage.save({ session: mongoSession });

    // ── Agenda do pacote destino ──────────────────────────────────────────
    // Revalidado DENTRO da transação: entre revisar e confirmar alguém pode
    // ter ocupado o horário.
    const confirmedSchedule = await validateSchedule({
      schedule: normalizedSchedule,
      appointmentIds,
      doctorId: target.doctorId,
      specialty: target.specialty,
      patientId: source.patient,
      mongoSession,
    });

    const newAppointments = [];
    for (const [index, row] of confirmedSchedule.entries()) {
      // Estado idêntico ao de sessão de pacote pré-pago criada pelo fluxo
      // normal: coberta, sem cobrança e sem Payment.
      const [appt] = await Appointment.create([{
        patient: source.patient,
        doctor: new mongoose.Types.ObjectId(target.doctorId),
        date: buildDateTime(row.date, row.time),
        time: row.time,
        duration: SESSION_DURATION_MIN,
        specialty: target.specialty,
        package: targetPackage._id,
        serviceType: 'package_session',
        operationalStatus: 'scheduled',
        clinicalStatus: 'pending',
        paymentStatus: 'package_paid',
        isPaid: true,
        visualFlag: 'ok',
        paymentOrigin: 'package_prepaid',
        paymentMethod: null,   // enum aceita null — nenhum pagamento envolvido
        billingType: 'particular',
        sessionValue: targetSessionValue,
        isFirstAppointment: index === 0,
        // Rastreabilidade bidirecional
        transferId: transfer._id,
        sourceAppointmentId: new mongoose.Types.ObjectId(row.sourceAppointmentId),
      }], { session: mongoSession, __fromFinancialGuard: true, __guardContext: 'FINANCIAL' });

      const [sess] = await Session.create([{
        date: appt.date,
        time: row.time,
        patient: source.patient,
        doctor: new mongoose.Types.ObjectId(target.doctorId),
        package: targetPackage._id,
        appointmentId: appt._id,
        sessionValue: targetSessionValue,
        sessionType: target.specialty,
        specialty: target.specialty,
        status: 'scheduled',
        isPaid: true,
        paymentStatus: 'package_paid',
        paymentOrigin: 'package_prepaid',
        visualFlag: 'ok',
        transferId: transfer._id,
      }], { session: mongoSession, __fromFinancialGuard: true, __guardContext: 'FINANCIAL' });

      await Appointment.updateOne(
        { _id: appt._id },
        { $set: { session: sess._id, packageId: targetPackage._id } },
        { session: mongoSession }
      );

      // Origem aponta para o destino (o inverso é feito acima)
      await Appointment.updateOne(
        { _id: row.sourceAppointmentId },
        { $set: { targetAppointmentId: appt._id } },
        { session: mongoSession }
      );

      newAppointments.push({
        _id: appt._id,
        sessionId: sess._id,
        sourceAppointmentId: row.sourceAppointmentId,
        date: row.date,
        time: row.time,
      });
    }

    targetPackage.appointments = newAppointments.map(a => a._id);
    targetPackage.sessions = newAppointments.map(a => a.sessionId);
    await targetPackage.save({ session: mongoSession });

    // ── Sessões ainda agendadas: cancelar pelo fluxo canônico ─────────────
    // Reusa o command para não duplicar regra (cancela Payment pendente,
    // limpa arrays do pacote, emite APPOINTMENT_CANCELLED com packageId).
    for (const appt of toCancel) {
      await cancelAppointmentWithSession(
        appt._id,
        {
          reason: `Convertida para ${target.specialty}: ${String(reason).trim()}`,
          confirmedAbsence: false,
          cancelSource: 'converted_to_package',
        },
        user,
        mongoSession
      );
    }

    // ── Carimbo final em TODAS as selecionadas ────────────────────────────
    //
    // ⚠️ `operationalStatus` é o status operacional canônico e permanece
    // 'canceled'. A sessão de fono NÃO é reativada, NÃO é cancelada de novo e
    // NÃO vira sessão de psicologia — o destino recebe sessões próprias.
    //
    // `clinicalStatus` NÃO é tocado aqui: transferência é decisão
    // administrativa/financeira, não muda o que aconteceu (ou não) na clínica.
    // A retirada da caracterização de falta é feita por `missed: false`.
    await Appointment.updateMany(
      { _id: { $in: appointmentIds } },
      {
        $set: {
          cancelSource: 'converted_to_package',
          missed: false,
          confirmedAbsence: false,
          transferId: transfer._id,
          transferredToPackage: targetPackage._id,
          updatedAt: new Date(),
        },
      },
      { session: mongoSession }
    );

    const sessionIds = appointments.map(a => a.session).filter(Boolean);
    if (sessionIds.length > 0) {
      await Session.updateMany(
        { _id: { $in: sessionIds } },
        {
          $set: {
            status: 'canceled',
            transferId: transfer._id,
            transferredToPackage: targetPackage._id,
            confirmedAbsence: false,
            updatedAt: new Date(),
          },
        },
        { session: mongoSession }
      );
    }

    // ── Eventos (com packageId — ver incidente 2026-08-12) ────────────────
    await saveToOutbox({
      eventType: EventTypes.PACKAGE_CREATED,
      aggregateType: 'package',
      aggregateId: targetPackage._id.toString(),
      payload: {
        packageId: targetPackage._id.toString(),
        patientId: source.patient?.toString() || null,
        doctorId: target.doctorId,
        fundedByTransfer: amount,
        transferId: transfer._id.toString(),
        cashEntry: 0,
      },
      correlationId: cid,
    }, mongoSession);

    await saveToOutbox({
      eventType: EventTypes.PACKAGE_UPDATED,
      aggregateType: 'package',
      aggregateId: source._id.toString(),
      payload: {
        packageId: source._id.toString(),
        patientId: source.patient?.toString() || null,
        updatedFields: ['sessions_transferred'],
        transferId: transfer._id.toString(),
        sessionCount,
      },
      correlationId: cid,
    }, mongoSession);

    return {
      transfer: transfer.toObject(),
      targetPackage: targetPackage.toObject(),
      newAppointments,
      canceledNow: toCancel.length,
      restamped: alreadyCanceled.length,
    };
  });

  // ── Projeções (fora da transação) ───────────────────────────────────────
  try {
    const { buildPackageView } = await import('../../../domains/billing/services/PackageProjectionService.js');
    await Promise.all([
      buildPackageView(sourcePackageId.toString(), { correlationId: cid, force: true }),
      buildPackageView(result.targetPackage._id.toString(), { correlationId: cid, force: true }),
    ]);
  } catch (err) {
    console.error('[transferPackageCredit] Falha ao reconstruir projeções (non-fatal):', err.message);
  }

  return {
    data: result.transfer,
    targetPackage: result.targetPackage,
    newAppointments: result.newAppointments,
    canceledNow: result.canceledNow,
    restamped: result.restamped,
    correlationId: cid,
    message: `${result.transfer.sessionCount} sessão(ões) transferida(s). Cobertura de R$ ${result.transfer.amount.toFixed(2)} aplicada ao novo pacote, sem entrada em caixa.`,
  };
}

/**
 * Preview: mesma validação, sem escrever nada.
 * A tela precisa mostrar o efeito antes de confirmar — a regra de negócio
 * mora no backend, então o preview também.
 */
export async function preview(input) {
  const { sourcePackageId, appointmentIds = [], target = {} } = input || {};

  if (!sourcePackageId || !mongoose.Types.ObjectId.isValid(sourcePackageId)) {
    throw buildError('ID do pacote de origem inválido', 400, 'INVALID_SOURCE_PACKAGE');
  }

  const source = await Package.findById(sourcePackageId).lean();
  if (!source) throw buildError('Pacote de origem não encontrado', 404, 'SOURCE_PACKAGE_NOT_FOUND');

  const appointments = await Appointment.find({ _id: { $in: appointmentIds } }).lean();
  const { toCancel, alreadyCanceled } = classifyAppointments(appointments, source._id, source.patient);

  // Mesmas validações da execução — o que a tela mostra é o que vai acontecer.
  // Nenhuma delas escreve: só leitura e cálculo.
  let scheduled = [];
  if (target.doctorId && target.specialty) {
    await assertDoctorHandlesSpecialty(target.doctorId, target.specialty);
    if (target.schedule) {
      const rows = await validateSchedule({
        schedule: target.schedule,
        appointmentIds,
        doctorId: target.doctorId,
        specialty: target.specialty,
        patientId: source.patient,
      });
      const byId = new Map(appointments.map(a => [String(a._id), a]));
      scheduled = rows.map(r => {
        const origin = byId.get(r.sourceAppointmentId);
        return {
          sourceAppointmentId: r.sourceAppointmentId,
          sourceDate: origin?.date || null,
          sourceTime: origin?.time || null,
          sourceStatus: origin?.operationalStatus || null,
          date: r.date,
          time: r.time,
          specialty: target.specialty,
          doctorId: String(target.doctorId),
        };
      });
    }
  }

  const unitValue = Number(source.sessionValue) || 0;
  const sessionCount = appointments.length;
  const amount = Number((sessionCount * unitValue).toFixed(2));
  const targetSessionValue = Number(target.sessionValue) > 0 ? Number(target.sessionValue) : unitValue;
  const targetTotalValue = Number((sessionCount * targetSessionValue).toFixed(2));

  const completedCount = await Appointment.countDocuments({
    package: source._id, operationalStatus: 'completed'
  });

  return {
    sessionCount,
    unitValue,
    amount,
    // Agenda que será criada no pacote destino
    newAppointments: scheduled,
    newAppointmentsCount: scheduled.length,
    targetPackagesToCreate: 1,
    targetSessionValue,
    targetTotalValue,
    shortfall: Number(Math.max(0, targetTotalValue - amount).toFixed(2)),
    surplus: Number(Math.max(0, amount - targetTotalValue).toFixed(2)),
    willCancelNow: toCancel.length,
    willRestamp: alreadyCanceled.length,
    completedUntouched: completedCount,
    cashEntry: 0,
    sourceKeeps: {
      totalSessions: source.totalSessions,
      totalValue: source.totalValue,
      totalPaid: source.totalPaid,
    },
  };
}

export default { execute, preview };
