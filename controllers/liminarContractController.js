import mongoose from 'mongoose';
import LiminarContract from '../models/LiminarContract.js';
import Payment from '../models/Payment.js';
import TherapeuticPlan from '../models/TherapeuticPlan.js';
import Appointment from '../models/Appointment.js';
import Session from '../models/Session.js';
import { generateLiminarSessions } from '../services/schedule/generateLiminarSessions.js';
import { computeExhaustionProjection } from '../services/liminar/liminarProjectionService.js';
import { createContextLogger } from '../utils/logger.js';
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';

const logger = createContextLogger('LiminarContract');

// ──────────────────────────────────────────────────────────────
// POST /api/v2/liminar-contracts
// ──────────────────────────────────────────────────────────────
export async function createLiminarContract(req, res) {
  const {
    patientId,
    doctorId,
    totalCredit,
    processNumber,
    court,
    expirationDate,
    mode = 'hybrid',
    idempotencyKey,
    receivedAt   // data real do recebimento financeiro (PIX/TED/depósito)
  } = req.body;

  if (!patientId || !doctorId || !totalCredit) {
    return res.status(400).json({ error: 'patientId, doctorId e totalCredit são obrigatórios' });
  }

  if (totalCredit <= 0) {
    return res.status(400).json({ error: 'totalCredit deve ser maior que zero' });
  }

  let session;
  try {
    // Idempotência
    if (idempotencyKey) {
      const existing = await LiminarContract.findOne({ idempotencyKey });
      if (existing) {
        logger.info('Contrato liminar retornado por idempotência', { idempotencyKey, contractId: existing._id.toString() });
        return res.status(200).json({ contract: existing, idempotent: true });
      }
    }

    session = await mongoose.startSession();
    let contract;
    let payment;

    await session.withTransaction(async () => {
      const contractData = {
        patient:       patientId,
        doctor:        doctorId,
        totalCredit,
        creditBalance: totalCredit,
        usedCredit:    0,
        processNumber: processNumber || null,
        court:         court || null,
        expirationDate: expirationDate || null,
        mode,
        creditHistory: [{
          amount:    totalCredit,
          type:      'initial',
          reason:    'contract_created',
          createdAt: new Date()
        }],
      };

      // Só inclui idempotencyKey se foi fornecido — evita null no índice sparse/unique
      if (idempotencyKey) contractData.idempotencyKey = idempotencyKey;
      if (receivedAt)    contractData.receivedAt = new Date(receivedAt);

      [contract] = await LiminarContract.create([contractData], { session });

      // Hierarquia de verdade financeira para o caixa:
      // 1. receivedAt informado pelo usuário (data real do PIX/TED)
      // 2. creditHistory[0] com type='initial' (proxy da migração)
      // 3. createdAt (evento técnico — último recurso)
      const financialDate =
          contract.receivedAt ||
          contract.creditHistory?.find(h => h.type === 'initial')?.createdAt ||
          contract.createdAt;

      [payment] = await Payment.create([{
          patient:         new mongoose.Types.ObjectId(patientId),
          doctor:          new mongoose.Types.ObjectId(doctorId),
          amount:          totalCredit,
          status:          'paid',
          paidAt:          financialDate,
          kind:            'liminar_contract_receipt',
          billingType:     'liminar',
          paymentMethod:   'liminar_credit',
          paymentDate:     financialDate,
          financialDate:   financialDate,
          liminarContract: contract._id,
          isFromPackage:   false,
          notes:           processNumber ? `Processo: ${processNumber}` : null,
      }], { session });

      await saveToOutbox({
        eventType: 'LIMINAR_CONTRACT_CREATED',
        aggregateType: 'liminarContract',
        aggregateId: contract._id.toString(),
        payload: {
          contractId: contract._id.toString(),
          patientId,
          doctorId,
          totalCredit,
          processNumber: processNumber || null,
          court: court || null,
          mode,
          paymentId: payment._id.toString(),
          createdAt: new Date().toISOString()
        },
        correlationId: idempotencyKey || `liminar_create_${contract._id.toString()}_${Date.now()}`
      }, session);
    });

    logger.info('Contrato liminar criado', { contractId: contract._id.toString(), patientId, totalCredit });

    return res.status(201).json({ contract });
  } catch (err) {
    logger.error('Erro ao criar contrato liminar', {
      err: err.message,
      code: err.code,
      patientId,
      doctorId,
      totalCredit
    });

    if (err.code === 11000) {
      return res.status(409).json({ error: 'Contrato com este idempotencyKey já existe' });
    }

    return res.status(500).json({ error: err.message });
  } finally {
    if (session) {
      await session.endSession();
    }
  }
}

// ──────────────────────────────────────────────────────────────
// GET /api/v2/liminar-contracts/:id
// ──────────────────────────────────────────────────────────────
export async function getLiminarContract(req, res) {
  const contract = await LiminarContract.findById(req.params.id)
    .populate('plans')
    .lean();

  if (!contract) {
    return res.status(404).json({ error: 'Contrato não encontrado' });
  }

  return res.json({ contract });
}

// ──────────────────────────────────────────────────────────────
// GET /api/v2/liminar-contracts?patientId=
// ──────────────────────────────────────────────────────────────
export async function listLiminarContracts(req, res) {
  const { patientId, status } = req.query;
  const filter = {};

  if (patientId) filter.patient = patientId;
  if (status)    filter.status  = status;

  const contracts = await LiminarContract.find(filter)
    .sort({ createdAt: -1 })
    .lean();

  return res.json({ contracts });
}

// ──────────────────────────────────────────────────────────────
// PATCH /api/v2/liminar-contracts/:id/recharge
// Adiciona crédito ao contrato (ex: nova decisão judicial)
// ──────────────────────────────────────────────────────────────
export async function rechargeContract(req, res) {
  const { amount, reason = 'judicial_recharge', receivedAt } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount deve ser maior que zero' });
  }

  const result = await LiminarContract.findByIdAndUpdate(
    req.params.id,
    {
      $inc: {
        totalCredit:   amount,
        creditBalance: amount
      },
      $push: {
        creditHistory: {
          amount,
          type:      'recharge',
          reason,
          createdAt: new Date(),
          createdBy: req.user?._id || null
        }
      },
      $set: { status: 'active', updatedAt: new Date() }
    },
    { new: true }
  );

  if (!result) {
    return res.status(404).json({ error: 'Contrato não encontrado' });
  }

  const rechargeDate = receivedAt ? new Date(receivedAt) : new Date();
  await Payment.create({
      patient:         result.patient,
      doctor:          result.doctor,
      amount:          amount,
      status:          'paid',
      kind:            'liminar_contract_receipt',
      billingType:     'liminar',
      paymentMethod:   'liminar_credit',
      paymentDate:     rechargeDate,
      financialDate:   rechargeDate,
      liminarContract: result._id,
      isFromPackage:   false,
      notes:           `Recarga: ${reason}`,
  });

  return res.json({ contract: result });
}

// ──────────────────────────────────────────────────────────────
// POST /api/v2/liminar-contracts/:id/plans
// Cria nova versão do plano terapêutico
// ──────────────────────────────────────────────────────────────
export async function createTherapeuticPlan(req, res) {
  const { therapies, notes, startDate } = req.body;
  const contractId = req.params.id;

  if (!therapies || Object.keys(therapies).length === 0) {
    return res.status(400).json({ error: 'therapies é obrigatório' });
  }

  const session = await mongoose.startSession();

  try {
    await session.startTransaction();

    const contract = await LiminarContract.findById(contractId).session(session);
    if (!contract) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Contrato não encontrado' });
    }

    // Encerra plano ativo atual
    const today = startDate ? new Date(startDate) : new Date();
    await TherapeuticPlan.updateMany(
      { liminarContract: contractId, status: 'active' },
      { $set: { status: 'superseded', endDate: today } },
      { session }
    );

    // Determina próxima versão
    const lastPlan = await TherapeuticPlan.findOne({ liminarContract: contractId })
      .sort({ version: -1 })
      .session(session)
      .lean();

    const nextVersion = (lastPlan?.version || 0) + 1;

    const plan = await TherapeuticPlan.create([{
      patient:         contract.patient,
      liminarContract: contractId,
      version:         nextVersion,
      startDate:       today,
      endDate:         null,
      status:          'active',
      therapies:       new Map(Object.entries(therapies)),
      notes:           notes || null,
      createdBy:       req.user?._id || null
    }], { session });

    await LiminarContract.findByIdAndUpdate(
      contractId,
      { $push: { plans: plan[0]._id } },
      { session }
    );

    await session.commitTransaction();

    logger.info('Plano terapêutico criado', {
      contractId,
      planId: plan[0]._id.toString(),
      version: nextVersion
    });

    return res.status(201).json({ plan: plan[0] });

  } catch (err) {
    await session.abortTransaction();
    logger.error('Erro ao criar plano', { err: err.message });
    return res.status(500).json({ error: err.message });
  } finally {
    session.endSession();
  }
}

// ──────────────────────────────────────────────────────────────
// GET /api/v2/liminar-contracts/:id/plans
// ──────────────────────────────────────────────────────────────
export async function listTherapeuticPlans(req, res) {
  const plans = await TherapeuticPlan.find({ liminarContract: req.params.id })
    .sort({ version: -1 })
    .lean();

  return res.json({ plans });
}

// ──────────────────────────────────────────────────────────────
// GET /api/v2/liminar-contracts/:id/plans/active
// ──────────────────────────────────────────────────────────────
export async function getActivePlan(req, res) {
  const plan = await TherapeuticPlan.findOne({
    liminarContract: req.params.id,
    status: 'active'
  }).lean();

  if (!plan) {
    return res.status(404).json({ error: 'Nenhum plano ativo para este contrato' });
  }

  return res.json({ plan });
}

// ──────────────────────────────────────────────────────────────
// POST /api/v2/liminar-contracts/:id/plans/:planId/generate-sessions
// Gera appointments dentro de uma janela de datas (idempotente)
//
// Body: { startDate, endDate, defaultTime?, skipHolidays? }
// ──────────────────────────────────────────────────────────────
export async function generateSessions(req, res) {
  const { planId } = req.params;
  const {
    mode         = 'append',
    weeks        = 4,
    startDate,
    endDate,
    skipHolidays = true,
    specialties,
  } = req.body;

  if (mode === 'reset' && (!startDate || !endDate)) {
    return res.status(400).json({ error: 'startDate e endDate são obrigatórios no modo reset' });
  }

  if (mode === 'append' && (!weeks || weeks < 1 || weeks > 12)) {
    return res.status(400).json({ error: 'weeks deve estar entre 1 e 12 no modo append' });
  }

  const result = await generateLiminarSessions({
    planId,
    mode,
    weeks,
    startDate,
    endDate,
    skipHolidays,
    specialties: Array.isArray(specialties) && specialties.length ? specialties : undefined,
  });

  logger.info('Sessões geradas', { planId, mode, ...result });

  return res.status(201).json(result);
}

// ──────────────────────────────────────────────────────────────
// GET /api/v2/liminar-contracts/:id/committed-balance
// Retorna saldo comprometido por sessões agendadas/confirmadas
// ──────────────────────────────────────────────────────────────
export async function getCommittedBalance(req, res) {
  const { id } = req.params;

  const contract = await LiminarContract.findById(id).lean();
  if (!contract) {
    return res.status(404).json({ error: 'Contrato não encontrado' });
  }

  const agg = await Appointment.aggregate([
    {
      $match: {
        liminarContract: new mongoose.Types.ObjectId(id),
        operationalStatus: { $in: ['scheduled', 'confirmed', 'pre_agendado'] }
      }
    },
    {
      $group: {
        _id: null,
        committed: { $sum: '$sessionValue' }
      }
    }
  ]);

  const committed = agg[0]?.committed || 0;
  const available = contract.creditBalance - committed;
  const projection = await computeExhaustionProjection(contract);

  return res.json({
    creditBalance: contract.creditBalance,
    usedCredit:    contract.usedCredit,
    committed,
    available,
    projection
  });
}

// ──────────────────────────────────────────────────────────────
// PATCH /api/v2/liminar-contracts/:id/plans/:planId/therapies/:specialty
// Troca o terapeuta de uma especialidade no plano ativo e atualiza
// os appointments ainda pendentes (pre_agendado/scheduled) da especialidade.
// Appointments confirmed/completed NÃO são alterados.
// ──────────────────────────────────────────────────────────────
// Statuses que bloqueiam o slot (mesmo conjunto do índice unique_appointment_slot)
const SLOT_BLOCKING_STATUSES = [
  'pre_agendado', 'scheduled', 'confirmed', 'pending', 'paid',
  'missed', 'processing_create', 'processing_complete', 'processing_cancel', 'force_cancelled'
];

export async function updateTherapy(req, res) {
  const { id: contractId, planId, specialty } = req.params;
  const { doctorId, sessionValue, sessionDurationMinutes, slots, notes } = req.body;

  const session = await mongoose.startSession();

  try {
    await session.startTransaction();

    const plan = await TherapeuticPlan.findOne({
      _id: planId,
      liminarContract: contractId,
      status: 'active'
    }).session(session);

    if (!plan) {
      await session.abortTransaction();
      return res.status(404).json({ error: 'Plano ativo não encontrado' });
    }

    const therapy = plan.therapies.get(specialty);
    if (!therapy) {
      await session.abortTransaction();
      return res.status(404).json({ error: `Especialidade "${specialty}" não encontrada no plano` });
    }

    // Appointments pendentes que seriam reatribuídos ao trocar o profissional
    const affected = await Appointment.find({
      liminarContract: new mongoose.Types.ObjectId(contractId),
      specialty,
      operationalStatus: { $in: ['pre_agendado', 'scheduled'] }
    }).select('_id date time').session(session).lean();

    // 🔄 Sincronização de horário: se o slot mudou, todo appointment pendente cujo dia da
    // semana ainda existe nos NOVOS slots é atualizado pro horário daquele dia.
    // Não depende do slot antigo salvo no plano — esse dado pode estar dessincronizado
    // de bugs/edições anteriores (o appointment é a fonte real do horário atual).
    // Se o dia da semana foi REMOVIDO do plano, o appointment fica órfão (nenhum slot novo
    // o reivindica) e é cancelado abaixo — ele nunca seria gerado de novo nesse dia, e se
    // ficasse "scheduled" mascararia o gap-check do generateLiminarSessions (mesmo specialty
    // + mesmo time de um slot novo → o algoritmo acha que já existe sessão futura pro slot
    // novo e ancora a próxima geração na sessão mais distante da especialidade, pulando meses).
    const timeSyncMap = new Map(); // appointmentId (string) -> novo time
    const toCancelIds = [];        // appointments cujo dia da semana saiu do plano
    if (slots !== undefined) {
      const newDayToTime = new Map((slots || []).map(s => [s.dayOfWeek, s.time]));

      for (const a of affected) {
        const dow = new Date(a.date).getDay();
        const newTime = newDayToTime.get(dow);
        if (newTime) {
          if (newTime !== a.time) timeSyncMap.set(String(a._id), newTime);
        } else {
          toCancelIds.push(a._id);
        }
      }

      if (timeSyncMap.size > 0) {
        logger.info('Sincronizando horário de appointments pendentes (slot alterado)', {
          contractId, planId, specialty,
          changes: Array.from(timeSyncMap.entries())
        });
      }
      if (toCancelIds.length > 0) {
        logger.info('Cancelando appointments órfãos (dia da semana removido do plano)', {
          contractId, planId, specialty,
          appointmentIds: toCancelIds.map(String)
        });
      }
    }

    // 🚨 Pré-checagem: o novo profissional já tem algum desses slots ocupados com outro paciente?
    // Usa o horário JÁ SINCRONIZADO (se houver) — é pra onde o appointment vai, não de onde ele vem.
    // Evita o E11000 (unique_appointment_slot) e atualização parcial — só escreve se não houver conflito.
    if (doctorId && affected.length > 0) {
      const newDoctorObjId = new mongoose.Types.ObjectId(doctorId);
      const movingIds = affected.map(a => a._id);

      const conflicts = await Appointment.find({
        _id: { $nin: movingIds },
        doctor: newDoctorObjId,
        isJointSession: false,
        operationalStatus: { $in: SLOT_BLOCKING_STATUSES },
        $or: affected.map(a => ({
          date: a.date,
          time: timeSyncMap.get(String(a._id)) || a.time
        }))
      }).select('date time patient').populate('patient', 'fullName').session(session).lean();

      if (conflicts.length > 0) {
        await session.abortTransaction();

        const detalhes = conflicts.map(c => {
          const dataFmt = new Date(c.date).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
          const nomePaciente = c.patient?.fullName || 'paciente não identificado';
          return `${dataFmt} às ${c.time} (já ocupado com ${nomePaciente})`;
        });

        return res.status(409).json({
          error: `O profissional selecionado já tem agendamento em: ${detalhes.join('; ')}. Ajuste o horário ou escolha outro profissional antes de salvar.`,
          code: 'CONFLITO_AGENDA',
          conflicts: conflicts.map(c => ({
            date: c.date,
            time: c.time,
            patientName: c.patient?.fullName || null
          }))
        });
      }
    }

    if (doctorId !== undefined) therapy.doctor = doctorId ? new mongoose.Types.ObjectId(doctorId) : null;
    if (sessionValue !== undefined) therapy.sessionValue = sessionValue;
    if (sessionDurationMinutes !== undefined) therapy.sessionDurationMinutes = sessionDurationMinutes;
    if (slots !== undefined) therapy.slots = slots;
    if (notes !== undefined) therapy.notes = notes || null;

    await plan.save({ session });

    // Atualiza appointments pendentes (pre_agendado/scheduled) com os campos alterados.
    // bulkWrite (não updateMany) porque o time pode variar por appointment (timeSyncMap).
    const baseSet = {};
    if (doctorId !== undefined) baseSet.doctor = doctorId ? new mongoose.Types.ObjectId(doctorId) : null;
    if (sessionValue !== undefined) baseSet.sessionValue = sessionValue;

    let appointmentsUpdated = 0;
    if (affected.length > 0 && (Object.keys(baseSet).length > 0 || timeSyncMap.size > 0)) {
      const bulkOps = affected
        .map(a => {
          const set = { ...baseSet };
          const newTime = timeSyncMap.get(String(a._id));
          if (newTime) set.time = newTime;
          return Object.keys(set).length > 0
            ? { updateOne: { filter: { _id: a._id }, update: { $set: set } } }
            : null;
        })
        .filter(Boolean);

      if (bulkOps.length > 0) {
        const result = await Appointment.bulkWrite(bulkOps, { session });
        appointmentsUpdated = result.modifiedCount;
      }
    }

    // 🧹 Cancela appointments cujo dia da semana saiu do plano (órfãos).
    // Sessão liminar não tem Payment no provisioning (nasce só no settlement/completed),
    // então não há reversão financeira a fazer aqui — só liberar o slot e tirar do "comprometido".
    let appointmentsCanceled = 0;
    if (toCancelIds.length > 0) {
      const cancelRes = await Appointment.updateMany(
        { _id: { $in: toCancelIds } },
        {
          $set: {
            operationalStatus: 'canceled',
            clinicalStatus: 'canceled',
            paymentStatus: 'canceled',
            canceledAt: new Date(),
            cancelReason: `Dia da semana removido da terapia "${specialty}" (plano atualizado)`,
            updatedAt: new Date()
          }
        },
        { session }
      );
      appointmentsCanceled = cancelRes.modifiedCount;

      await Session.updateMany(
        { appointmentId: { $in: toCancelIds }, status: { $ne: 'completed' } },
        { $set: { status: 'canceled', updatedAt: new Date() } },
        { session }
      );
    }

    await session.commitTransaction();

    logger.info('Terapia atualizada no plano liminar', {
      contractId, planId, specialty, appointmentsUpdated, appointmentsCanceled
    });

    return res.json({ plan, appointmentsUpdated, appointmentsCanceled });

  } catch (err) {
    await session.abortTransaction();

    // Defesa extra: condição de corrida rara (slot ocupado entre o pré-check e o write)
    if (err.code === 11000) {
      logger.warn('Conflito de slot ao trocar profissional da terapia (race condition)', {
        contractId, planId, specialty, err: err.message
      });
      return res.status(409).json({
        error: 'O horário ficou indisponível durante a operação. Tente novamente.',
        code: 'CONFLITO_AGENDA'
      });
    }

    logger.error('Erro ao atualizar terapia do plano liminar', { contractId, planId, specialty, err: err.message });
    return res.status(500).json({ error: err.message });
  } finally {
    session.endSession();
  }
}

// ──────────────────────────────────────────────────────────────
// GET /api/v2/liminar-contracts/:id/sessions
// Lista appointments do contrato, opcionalmente filtradas por specialty
// ──────────────────────────────────────────────────────────────
export async function getContractSessions(req, res) {
  const { id } = req.params;
  const { specialty, status, from, to } = req.query;

  const contract = await LiminarContract.findById(id).lean();
  if (!contract) {
    return res.status(404).json({ error: 'Contrato não encontrado' });
  }

  const filter = {
    liminarContract: new mongoose.Types.ObjectId(id)
  };

  if (specialty) filter.specialty = specialty;
  if (status) {
    // 'scheduled' inclui pre_agendado (migração 2026-05-07: novos appointments nascem como pre_agendado)
    filter.operationalStatus = status === 'scheduled'
      ? { $in: ['scheduled', 'pre_agendado'] }
      : status;
  }
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = new Date(from);
    if (to)   filter.date.$lte = new Date(to);
  }

  const sessions = await Appointment.find(filter)
    .populate('doctor', 'fullName specialty')
    .populate('patient', 'fullName')
    .sort({ date: 1 })
    .lean();

  return res.json({ sessions });
}

// ──────────────────────────────────────────────────────────────
// GET /api/v2/liminar-contracts/:id/integrity
// Projeção sem nova coleção: compara TherapeuticPlan (esperado)
// vs Appointments (gerado) vs Sessions completed (executado).
// ──────────────────────────────────────────────────────────────
export async function getContractIntegrity(req, res) {
  const { id } = req.params;

  const contract = await LiminarContract.findById(id).lean();
  if (!contract) return res.status(404).json({ error: 'CONTRACT_NOT_FOUND' });

  const plan = await TherapeuticPlan.findOne({ liminarContract: contract._id, status: 'active' }).lean();
  if (!plan) return res.status(404).json({ error: 'NO_ACTIVE_PLAN' });

  const therapies = plan.therapies instanceof Map
    ? Object.fromEntries(plan.therapies)
    : (plan.therapies || {});

  // Todos appointments não-cancelados do contrato
  const appts = await Appointment.find({
    liminarContract: contract._id,
    operationalStatus: { $ne: 'canceled' }
  }).select('date specialty operationalStatus sessionValue').sort({ date: 1 }).lean();

  if (appts.length === 0) {
    return res.json({
      contractId: id, planVersion: plan.version,
      window: null, specialties: {},
      summary: { expected: 0, generated: 0, completed: 0, pending: 0, missing: 0 }
    });
  }

  // Janela: do primeiro ao último appointment
  const firstDate = new Date(appts[0].date); firstDate.setHours(0, 0, 0, 0);
  const lastDate  = new Date(appts[appts.length - 1].date); lastDate.setHours(23, 59, 59, 999);

  // Agrega appointments por especialidade
  const bySpecialty = {};
  for (const a of appts) {
    const sp = a.specialty;
    if (!bySpecialty[sp]) bySpecialty[sp] = { generated: 0, completed: 0, pending: 0 };
    bySpecialty[sp].generated++;
    if (a.operationalStatus === 'completed') bySpecialty[sp].completed++;
    else bySpecialty[sp].pending++;
  }

  // Calcula esperado por especialidade: percorre cada dia da janela
  function getWeekSunday(date) {
    const d = new Date(date); const dow = d.getDay();
    d.setDate(d.getDate() - dow); d.setHours(0, 0, 0, 0);
    return d;
  }

  const planStart = new Date(plan.startDate); planStart.setHours(0, 0, 0, 0);
  const windowStart = getWeekSunday(firstDate);
  const specialtyResults = {};
  let [totExp, totGen, totComp, totPend] = [0, 0, 0, 0];

  for (const [specialty, config] of Object.entries(therapies)) {
    const slots = Array.isArray(config.slots) ? config.slots : [];
    let expected = 0;
    const walker = new Date(windowStart);
    while (walker <= lastDate) {
      const dow = walker.getDay();
      for (const slot of slots) {
        if (slot.dayOfWeek === dow && walker >= planStart) expected++;
      }
      walker.setDate(walker.getDate() + 1);
    }

    const c = bySpecialty[specialty] || { generated: 0, completed: 0, pending: 0 };
    const missing = Math.max(0, expected - c.generated);
    specialtyResults[specialty] = {
      slotsPerWeek: slots.length,
      sessionValue: config.sessionValue ?? 0,
      expected, generated: c.generated,
      completed: c.completed, pending: c.pending, missing,
    };
    totExp += expected; totGen += c.generated;
    totComp += c.completed; totPend += c.pending;
  }

  const totalMissing = Math.max(0, totExp - totGen);
  const integrityPercent = totExp > 0 ? Math.round((totGen / totExp) * 100) : 100;

  return res.json({
    contractId: id,
    planVersion: plan.version,
    window: { from: firstDate.toISOString().split('T')[0], to: lastDate.toISOString().split('T')[0] },
    specialties: specialtyResults,
    summary: {
      expected: totExp, generated: totGen,
      completed: totComp, pending: totPend,
      missing: totalMissing,
      integrityPercent,
    }
  });
}
