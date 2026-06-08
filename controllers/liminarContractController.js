import mongoose from 'mongoose';
import LiminarContract from '../models/LiminarContract.js';
import TherapeuticPlan from '../models/TherapeuticPlan.js';
import Appointment from '../models/Appointment.js';
import { generateLiminarSessions } from '../services/schedule/generateLiminarSessions.js';
import { createContextLogger } from '../utils/logger.js';

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
    idempotencyKey
  } = req.body;

  if (!patientId || !doctorId || !totalCredit) {
    return res.status(400).json({ error: 'patientId, doctorId e totalCredit são obrigatórios' });
  }

  if (totalCredit <= 0) {
    return res.status(400).json({ error: 'totalCredit deve ser maior que zero' });
  }

  try {
    // Idempotência
    if (idempotencyKey) {
      const existing = await LiminarContract.findOne({ idempotencyKey });
      if (existing) {
        logger.info('Contrato liminar retornado por idempotência', { idempotencyKey, contractId: existing._id.toString() });
        return res.status(200).json({ contract: existing, idempotent: true });
      }
    }

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

    const contract = await LiminarContract.create(contractData);

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
  const { amount, reason = 'judicial_recharge' } = req.body;

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
    skipHolidays = true
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
    skipHolidays
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

  return res.json({
    creditBalance: contract.creditBalance,
    usedCredit:    contract.usedCredit,
    committed,
    available
  });
}

// ──────────────────────────────────────────────────────────────
// PATCH /api/v2/liminar-contracts/:id/plans/:planId/therapies/:specialty
// Troca o terapeuta de uma especialidade no plano ativo e atualiza
// os appointments ainda pendentes (pre_agendado/scheduled) da especialidade.
// Appointments confirmed/completed NÃO são alterados.
// ──────────────────────────────────────────────────────────────
export async function updateTherapy(req, res) {
  const { id: contractId, planId, specialty } = req.params;
  const { doctorId, sessionValue, sessionDurationMinutes, slots } = req.body;

  const plan = await TherapeuticPlan.findOne({
    _id: planId,
    liminarContract: contractId,
    status: 'active'
  });

  if (!plan) {
    return res.status(404).json({ error: 'Plano ativo não encontrado' });
  }

  const therapy = plan.therapies.get(specialty);
  if (!therapy) {
    return res.status(404).json({ error: `Especialidade "${specialty}" não encontrada no plano` });
  }

  if (doctorId !== undefined) therapy.doctor = doctorId ? new mongoose.Types.ObjectId(doctorId) : null;
  if (sessionValue !== undefined) therapy.sessionValue = sessionValue;
  if (sessionDurationMinutes !== undefined) therapy.sessionDurationMinutes = sessionDurationMinutes;
  if (slots !== undefined) therapy.slots = slots;

  await plan.save();

  // Atualiza appointments pendentes (pre_agendado/scheduled) com os campos alterados
  const appointmentPatch = {};
  if (doctorId !== undefined) appointmentPatch.doctor = doctorId ? new mongoose.Types.ObjectId(doctorId) : null;
  if (sessionValue !== undefined) appointmentPatch.sessionValue = sessionValue;

  let appointmentsUpdated = 0;
  if (Object.keys(appointmentPatch).length > 0) {
    const result = await Appointment.updateMany(
      {
        liminarContract: new mongoose.Types.ObjectId(contractId),
        specialty,
        operationalStatus: { $in: ['pre_agendado', 'scheduled'] }
      },
      { $set: appointmentPatch }
    );
    appointmentsUpdated = result.modifiedCount;
  }

  logger.info('Terapia atualizada no plano liminar', {
    contractId, planId, specialty, appointmentsUpdated
  });

  return res.json({ plan, appointmentsUpdated });
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
