import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { mkdir, writeFile } from 'node:fs/promises';
dotenv.config({ path: new URL('../../.env', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), quiet: true });
const since = new Date('2026-09-07T03:00:00Z');
const future = new Date('2026-09-14T03:00:00Z');
try {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;
  const collections = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => /audit|event|outbox|log/i.test(n));
  const canceled = await db.collection('appointments').find({ date: { $gte: future }, operationalStatus: { $in: ['canceled', 'cancelled'] } }, { projection: { patient: 1, doctor: 1, date: 1, time: 1, duration: 1, specialty: 1, serviceType: 1, billingType: 1, insuranceGuide: 1, insurancePlan: 1, liminarContract: 1, package: 1, canceledAt: 1, canceledBy: 1, updatedAt: 1, cancelReason: 1, canceledReason: 1, cancelSource: 1, history: 1, session: 1, payment: 1, rescheduledFrom: 1 } }).sort({ updatedAt: -1 }).toArray();
  const patientIds = [...new Map(canceled.filter(a => a.patient).map(a => [String(a.patient), a.patient])).values()];
  const patients = await db.collection('patients').find({ _id: { $in: patientIds } }, { projection: { fullName: 1 } }).toArray();
  const names = new Map(patients.map(p => [String(p._id), p.fullName]));
  const active = await db.collection('appointments').find({ patient: { $in: patientIds }, date: { $gte: future }, operationalStatus: { $nin: ['canceled', 'cancelled', 'missed', 'discarded', 'suspended'] } }, { projection: { patient: 1, doctor: 1, date: 1, time: 1, serviceType: 1, insuranceGuide: 1, insurancePlan: 1, liminarContract: 1, package: 1, rescheduledFrom: 1, createdAt: 1, operationalStatus: 1 } }).toArray();
  const key = a => `${a.patient}|${new Date(a.date).toISOString().substring(0, 10)}|${a.time}`;
  const groups = {};
  const rows = canceled.map(a => {
    const replacements = active.filter(b => key(b) === key(a) || String(b.rescheduledFrom) === String(a._id));
    const reason = a.cancelReason || a.canceledReason || '(sem motivo)';
    const group = `${a.billingType || 'unknown'} / ${a.serviceType || 'unknown'} / ${reason}`;
    groups[group] ??= { count: 0, sameSlotReplacement: 0, noSameSlotReplacement: 0 };
    groups[group].count++;
    groups[group][replacements.length ? 'sameSlotReplacement' : 'noSameSlotReplacement']++;
    return { ...a, patientName: names.get(String(a.patient)), replacements };
  });
  const audit = await db.collection('auditlogs').find({ entityId: { $in: canceled.map(a => a._id) }, createdAt: { $gte: since } }, { projection: { action: 1, entityId: 1, source: 1, userId: 1, actorRole: 1, createdAt: 1, diff: 1, metadata: 1, correlationId: 1 } }).sort({ createdAt: -1 }).limit(1500).toArray();
  const sessionGroups = await db.collection('sessions').aggregate([{ $match: { date: { $gte: future }, status: { $in: ['canceled', 'cancelled'] }, updatedAt: { $gte: since } } }, { $group: { _id: { serviceType: '$serviceType', paymentMethod: '$paymentMethod' }, count: { $sum: 1 } } }]).toArray();
  const actors = await db.collection('users').find({ _id: { $in: [...canceled.map(a => a.canceledBy), ...audit.map(a => a.userId)].filter(Boolean) } }, { projection: { fullName: 1, name: 1, role: 1 } }).toArray();
  const sessionRows = await db.collection('sessions').find({ date: { $gte: future }, status: { $in: ['canceled', 'cancelled'] } }, { projection: { patient: 1, doctor: 1, date: 1, time: 1, status: 1, serviceType: 1, package: 1, appointmentId: 1, appointment: 1, createdAt: 1, updatedAt: 1, canceledAt: 1, canceledReason: 1, cancelReason: 1, notes: 1, statusHistory: 1 } }).toArray();
  const printSessions = sessionRows.filter(a => a.time === '18:20');
  const printPatients = await db.collection('patients').find({ _id: { $in: printSessions.map(a => a.patient).filter(Boolean) } }, { projection: { fullName: 1 } }).toArray();
  const report = { generatedAt: new Date(), database: db.databaseName, since, future, note: 'All future canceled appointments included; audit since 07/09. updatedAt is only a candidate cancellation time; use canceledAt and audit/history for attribution. Same-slot replacement is a candidate, not proof of linked replacement.', collections, totals: { candidates: rows.length, audit: audit.length, withSameSlotReplacement: rows.filter(a => a.replacements.length).length, futureCanceledSessions: sessionRows.length }, groups, sessionGroups, actors, audit, rows, sessionRows, printPatients };
  const folder = new URL('../../auditoria-output/', import.meta.url);
  await mkdir(folder, { recursive: true });
  await writeFile(new URL('future-cancellations-2026-09-14.json', folder), JSON.stringify(report, null, 2));
  const byPatient = {};
  for (const a of rows) { const name = a.patientName || String(a.patient); byPatient[name] ??= { count: 0, withoutReplacement: 0 }; byPatient[name].count++; if (!a.replacements.length) byPatient[name].withoutReplacement++; }
  const auditGroups = {};
  for (const a of audit) { const k = `${a.action}|${a.source}|${a.userId}`; auditGroups[k] = (auditGroups[k] || 0) + 1; }
  console.log(JSON.stringify({ totals: report.totals, groups, actors, auditGroups, byPatient, printSessions, printPatients, artifact: 'auditoria-output/future-cancellations-2026-09-14.json' }, null, 2));
} catch (error) { console.error(error.name, String(error.message).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/g, '[connection redacted]')); process.exitCode = 1; }
finally { await mongoose.disconnect(); }
