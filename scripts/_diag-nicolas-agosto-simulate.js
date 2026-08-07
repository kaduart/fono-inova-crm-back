import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve('/home/user/projetos/crm/back/.env') });

import Session from '../models/Session.js';
import Appointment from '../models/Appointment.js';
import InsuranceGuide from '../models/InsuranceGuide.js';
import Payment from '../models/Payment.js';
import InsuranceBatch from '../models/InsuranceBatch.js';
import Package from '../models/Package.js';
import InsuranceResolverService from '../services/insuranceResolver.service.js';

const BILLING_MODEL = {
  LEGACY_MONTHLY_BATCH: 'LEGACY_MONTHLY_BATCH',
  CURRENT_GUIDE_BATCH: 'CURRENT_GUIDE_BATCH'
};

function resolveBillingModelForMonth(insuranceProvider, monthKey) {
  const provider = String(insuranceProvider || '').toLowerCase().trim();
  const [y, m] = String(monthKey).split('-').map(Number);
  if (!y || !m) return BILLING_MODEL.CURRENT_GUIDE_BATCH;

  if (!provider) {
    if (y > 2026 || (y === 2026 && m >= 3)) return BILLING_MODEL.CURRENT_GUIDE_BATCH;
    return BILLING_MODEL.LEGACY_MONTHLY_BATCH;
  }

  if (provider !== 'unimed-anapolis') return BILLING_MODEL.CURRENT_GUIDE_BATCH;
  if (y > 2026 || (y === 2026 && m >= 3)) return BILLING_MODEL.CURRENT_GUIDE_BATCH;
  return BILLING_MODEL.LEGACY_MONTHLY_BATCH;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const patientId = '69655746dcdf49e2c282800b';
  const month = '2026-08';
  const specialty = 'fonoaudiologia';
  const provider = 'unimed-anapolis';
  const status = 'pending_batch';

  const [y, m] = month.split('-').map(Number);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0, 23, 59, 59, 999);
  const patientOid = new mongoose.Types.ObjectId(patientId);

  const billingModelForRequest = resolveBillingModelForMonth(provider, month);
  console.log('billingModelForRequest:', billingModelForRequest);

  const sessionMatch = {
    patient: patientOid,
    status: 'completed',
    date: { $gte: start, $lte: end },
    $or: [
      { billingType: 'convenio' },
      { paymentMethod: 'convenio' },
      { insuranceGuide: { $exists: true, $ne: null } },
      { paymentOrigin: 'convenio' }
    ]
  };

  const [monthSessions, guideSessionsByCompetence, avulsoPayments, patientPackages] = await Promise.all([
    Session.find(sessionMatch)
      .populate('patient', 'fullName phone')
      .populate('doctor', 'fullName specialty')
      .populate('insuranceGuide', 'number insurance specialty totalSessions usedSessions issuedAt createdAt')
      .lean(),
    Session.find({
      patient: patientOid,
      status: 'completed',
      insuranceGuide: { $exists: true, $ne: null },
      $or: [
        { billingType: 'convenio' },
        { paymentMethod: 'convenio' },
        { paymentOrigin: 'convenio' }
      ]
    })
      .populate('patient', 'fullName phone')
      .populate('doctor', 'fullName specialty')
      .populate('insuranceGuide', 'number insurance specialty totalSessions usedSessions issuedAt createdAt')
      .lean(),
    Payment.find({
      patient: patientOid,
      billingType: 'convenio',
      package: null,
      serviceDate: { $gte: start, $lte: end },
      status: { $nin: ['cancelled', 'canceled'] }
    }).lean(),
    Package.find({ patient: patientOid, type: 'convenio' }).select('specialty insuranceBillingStatus').lean()
  ]);

  console.log(`monthSessions: ${monthSessions.length}`);
  console.log(`guideSessionsByCompetence: ${guideSessionsByCompetence.length}`);

  const sessionById = new Map();

  if (billingModelForRequest === BILLING_MODEL.CURRENT_GUIDE_BATCH) {
    const guideIdSet = new Set();

    const guidesByPatient = await InsuranceGuide.find({
      patientId: patientOid,
      $or: [
        { issuedAt: { $gte: start, $lte: end } },
        { issuedAt: { $exists: false }, createdAt: { $gte: start, $lte: end } },
        { issuedAt: null, createdAt: { $gte: start, $lte: end } }
      ]
    }).select('_id number createdAt issuedAt').lean();

    console.log(`guidesByPatient (Fonte 1, competência ${month}): ${guidesByPatient.length}`);
    for (const g of guidesByPatient) {
      console.log(`  guia ${g.number} _id=${g._id} createdAt=${g.createdAt} issuedAt=${g.issuedAt}`);
      guideIdSet.add(String(g._id));
    }

    for (const s of monthSessions) {
      if (s.insuranceGuide?._id) {
        console.log(`  Fonte 2: sessão de ${s.date} -> guia ${s.insuranceGuide.number} (${s.insuranceGuide._id})`);
        guideIdSet.add(String(s.insuranceGuide._id));
      }
    }

    const guideIds = [...guideIdSet];
    console.log(`guideIds encontrados: ${guideIds.length}`, guideIds);

    if (guideIds.length > 0) {
      const allGuideSessions = await Session.find({
        patient: patientOid,
        status: 'completed',
        insuranceGuide: { $in: guideIds.map(id => new mongoose.Types.ObjectId(id)) },
        $or: [
          { billingType: 'convenio' },
          { paymentMethod: 'convenio' },
          { paymentOrigin: 'convenio' }
        ]
      })
        .populate('patient', 'fullName phone')
        .populate('doctor', 'fullName specialty')
        .populate('insuranceGuide', 'number insurance specialty totalSessions usedSessions issuedAt createdAt')
        .lean();

      console.log(`allGuideSessions: ${allGuideSessions.length}`);
      for (const s of allGuideSessions) {
        console.log(`  ${s._id} ${s.date} guia=${s.insuranceGuide?.number} provider=${s.insuranceGuide?.insurance} specialty=${s.sessionType}/${s.insuranceGuide?.specialty}`);
        sessionById.set(String(s._id), s);
      }
    }

    for (const s of monthSessions) {
      if (!s.insuranceGuide) sessionById.set(String(s._id), s);
    }
  }

  const mergedSessions = [...sessionById.values()];
  console.log(`mergedSessions: ${mergedSessions.length}`);

  // Verifica se sessão de 26/05 está presente
  const targetMay = mergedSessions.find(s => {
    const d = new Date(s.date);
    return d.getUTCDate() === 26 && d.getUTCMonth() === 4 && d.getUTCFullYear() === 2026;
  });
  console.log('Sessão de 26/05 presente em mergedSessions?', targetMay ? `SIM: ${targetMay._id}` : 'NÃO');

  const packageSpecialtyById = Object.fromEntries(patientPackages.map(p => [p._id.toString(), p.specialty]));
  const packageStatusById = Object.fromEntries(patientPackages.map(p => [p._id.toString(), p.insuranceBillingStatus || 'pending_batch']));

  function matchesStatusFilter(billingStatus, packageId) {
    if (status === 'all') return true;
    if (billingStatus === status) return true;
    const packageStatus = packageId ? packageStatusById[packageId.toString()] : null;
    return packageStatus === status;
  }
  const specialtyFilter = specialty ? specialty.toLowerCase().trim() : null;
  function matchesSpecialtyFilter(candidates) {
    if (!specialtyFilter) return true;
    const list = Array.isArray(candidates) ? candidates : [candidates];
    return list.some(c => (c || '').toLowerCase().trim() === specialtyFilter);
  }
  function matchesProviderFilter(candidates) {
    if (!provider) return true;
    const target = provider.toLowerCase().trim();
    return candidates.some(c => (c || '').toLowerCase().trim() === target);
  }

  const sessionIds = mergedSessions.map(s => s._id);
  const appointmentIds = mergedSessions.map(s => s.appointmentId).filter(Boolean);
  const avulsoAppointmentIds = avulsoPayments.map(p => p.appointment).filter(Boolean);
  const allAppointmentIds = [...new Set([...appointmentIds, ...avulsoAppointmentIds])].map(id => id.toString());

  const [appointments, payments, batches] = await Promise.all([
    allAppointmentIds.length
      ? Appointment.find({ _id: { $in: allAppointmentIds } })
          .select('_id patient specialty insuranceProvider insuranceGuide date time patientInfo')
          .lean()
      : Promise.resolve([]),
    sessionIds.length || allAppointmentIds.length
      ? Payment.find({
          $or: [
            { session: { $in: sessionIds } },
            { appointment: { $in: allAppointmentIds } }
          ],
          status: { $nin: ['cancelled', 'canceled'] }
        }).lean()
      : Promise.resolve([]),
    sessionIds.length
      ? InsuranceBatch.find({ 'sessions.session': { $in: sessionIds } })
          .select('insuranceProvider status sessions.session sessions.status sessions.grossAmount sessions.appointment')
          .lean()
      : Promise.resolve([])
  ]);

  const apptById = Object.fromEntries(appointments.map(a => [a._id.toString(), a]));
  const paymentBySession = Object.fromEntries(payments.filter(p => p.session).map(p => [p.session.toString(), p]));
  const paymentByAppointment = Object.fromEntries(payments.filter(p => p.appointment).map(p => [p.appointment.toString(), p]));

  console.log(`appointments: ${appointments.length}, payments: ${payments.length}, batches: ${batches.length}`);

  const result = [];
  const resultSessionIds = new Set();

  function analyzeSession(session) {
    const sessionId = session._id.toString();
    const appt = apptById[session.appointmentId?.toString()];
    const payment = paymentBySession[sessionId] || paymentByAppointment[session.appointmentId?.toString()];
    const batch = batches.find(b => b.sessions.some(s => s.session?.toString() === sessionId));
    const batchSession = batch?.sessions.find(s => s.session?.toString() === sessionId);

    let billingStatus = 'pending_batch';
    if (payment?.insurance?.status === 'received' || batchSession?.status === 'paid' || batch?.status === 'received') {
      billingStatus = 'received';
    } else if (payment?.insurance?.status === 'billed' || batchSession?.status === 'sent' || ['sent', 'processing'].includes(batch?.status)) {
      billingStatus = 'billed';
    }

    const sessionProvider = InsuranceResolverService.resolveInsuranceProvider({
      payment,
      session,
      appointment: appt,
      batch
    });

    const packageSpecialty = session.package ? packageSpecialtyById[session.package.toString()] : null;
    const resolvedSpecialty = packageSpecialty || session.sessionType || appt?.specialty || session.insuranceGuide?.specialty || 'outros';

    const d = new Date(session.date);
    const isMay26 = d.getUTCDate() === 26 && d.getUTCMonth() === 4 && d.getUTCFullYear() === 2026;
    if (isMay26) {
      console.log('\n--- Debug sessão 26/05 ---');
      console.log('sessionId:', sessionId);
      console.log('sessionProvider:', sessionProvider);
      console.log('resolvedSpecialty:', resolvedSpecialty);
      console.log('billingStatus:', billingStatus);
      console.log('matchesProvider:', matchesProviderFilter([sessionProvider, batch?.insuranceProvider, appt?.insuranceProvider, session.insuranceGuide?.insurance, payment?.insurance?.provider]));
      console.log('matchesStatus:', matchesStatusFilter(billingStatus, session.package));
      console.log('matchesSpecialty:', matchesSpecialtyFilter([packageSpecialty, session.sessionType, appt?.specialty, session.insuranceGuide?.specialty]));
      console.log('batch:', batch ? batch._id : 'null');
      console.log('payment:', payment ? payment._id : 'null');
    }

    return {
      result: {
        sessionId,
        date: session.date,
        time: appt?.time || null,
        patient: session.patient,
        doctor: session.doctor,
        specialty: resolvedSpecialty,
        provider: sessionProvider,
        guideNumber: session.insuranceGuide?.number || payment?.insurance?.authorizationCode || null,
        value: payment?.insurance?.grossAmount || payment?.amount || session.sessionValue || 0,
        grossAmount: payment?.insurance?.grossAmount || payment?.amount || session.sessionValue || 0,
        billingStatus
      },
      providerCandidates: [sessionProvider, batch?.insuranceProvider, appt?.insuranceProvider, session.insuranceGuide?.insurance, payment?.insurance?.provider],
      specialtyCandidates: [packageSpecialty, session.sessionType, appt?.specialty, session.insuranceGuide?.specialty],
      packageRef: session.package
    };
  }

  if (billingModelForRequest === BILLING_MODEL.CURRENT_GUIDE_BATCH && status !== 'all') {
    const monthSessionIds = new Set(monthSessions.map(s => s._id.toString()));
    const candidates = [];

    for (const session of mergedSessions) {
      const analyzed = analyzeSession(session);
      if (!matchesProviderFilter(analyzed.providerCandidates)) continue;
      if (!matchesSpecialtyFilter(analyzed.specialtyCandidates)) continue;
      candidates.push({ session, analyzed, isMonthSession: monthSessionIds.has(analyzed.result.sessionId) });
    }

    const byGuide = new Map();
    const avulsos = [];
    for (const c of candidates) {
      const guideId = c.session.insuranceGuide?._id?.toString();
      if (guideId) {
        if (!byGuide.has(guideId)) byGuide.set(guideId, []);
        byGuide.get(guideId).push(c);
      } else {
        avulsos.push(c);
      }
    }

    for (const candidatesOfGuide of byGuide.values()) {
      const hasMatch = candidatesOfGuide.some(c => c.isMonthSession && matchesStatusFilter(c.analyzed.result.billingStatus, c.analyzed.packageRef));
      if (!hasMatch) continue;
      for (const c of candidatesOfGuide) {
        if (resultSessionIds.has(c.analyzed.result.sessionId)) continue;
        resultSessionIds.add(c.analyzed.result.sessionId);
        result.push(c.analyzed.result);
      }
    }

    for (const c of avulsos) {
      if (!c.isMonthSession) continue;
      if (!matchesStatusFilter(c.analyzed.result.billingStatus, c.analyzed.packageRef)) continue;
      if (resultSessionIds.has(c.analyzed.result.sessionId)) continue;
      resultSessionIds.add(c.analyzed.result.sessionId);
      result.push(c.analyzed.result);
    }
  } else {
    for (const session of mergedSessions) {
      const analyzed = analyzeSession(session);
      if (!matchesProviderFilter(analyzed.providerCandidates)) continue;
      if (!matchesStatusFilter(analyzed.result.billingStatus, analyzed.packageRef)) continue;
      if (!matchesSpecialtyFilter(analyzed.specialtyCandidates)) continue;
      result.push(analyzed.result);
    }
  }

  console.log(`\nResultado final: ${result.length} sessões`);
  for (const r of result) {
    const d = new Date(r.date);
    console.log(`  ${d.toISOString().slice(0,10)} ${r.guideNumber} ${r.specialty} ${r.provider} ${r.billingStatus}`);
  }

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
