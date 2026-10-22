#!/usr/bin/env node
/**
 * 🧪 Traz UM paciente de produção para o banco de dev, com os mesmos _id,
 * para reproduzir um problema real sem tocar em produção.
 *
 * Lê de produção com o usuário SOMENTE LEITURA (PROD_URI_READONLY) e grava só no
 * banco de dev (MONGO_URI do .env local). Recusa rodar se o destino parecer produção.
 *
 * Dado de saúde (LGPD): por padrão MASCARA nome, CPF/RG, telefone, e-mail,
 * endereço, responsável e textos clínicos livres. --sem-mascara só para quem
 * já tem acesso legítimo ao dado e só em máquina própria.
 *
 * Uso:
 *   PROD_URI_READONLY="mongodb+srv://leitura:...@.../fono_inova_prod_rec1021" \
 *   node scripts/trazer-paciente-pra-dev.mjs --patient <id|telefone|nome> [--seco] [--sem-mascara] [--com-clinico]
 */

import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { normalizeE164BR } from '../utils/phone.js';

dotenv.config();

const args = process.argv.slice(2);
const arg = (k) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : undefined);
const PATIENT = arg('patient');
const DRY = args.includes('--seco');
const MASK = !args.includes('--sem-mascara');
const PROD_URI = process.env.PROD_URI_READONLY;
const DEV_URI = process.env.DEV_URI || process.env.MONGO_URI;
const TAG = '[trazer-paciente]';

if (!PATIENT || !PROD_URI || !DEV_URI) {
  console.error(`${TAG} uso: PROD_URI_READONLY=... node scripts/trazer-paciente-pra-dev.mjs --patient <id|telefone|nome> [--seco] [--sem-mascara]`);
  process.exit(1);
}
const dbName = (uri) => (uri.match(/mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/) || [])[1] || '';
const host = (uri) => uri.replace(/^mongodb(\+srv)?:\/\//, '').replace(/^[^@/]*@/, '').split(/[/?]/)[0].toLowerCase();
if (/prod/i.test(dbName(DEV_URI)) || host(DEV_URI) === host(PROD_URI)) {
  console.error(`${TAG} ❌ destino "${dbName(DEV_URI)}" @ ${host(DEV_URI)} parece produção — abortando.`);
  process.exit(1);
}

// Coleções com referência ao paciente (campo patient/patientId)
const RELATED = ['appointments', 'sessions', 'payments', 'packages', 'insuranceguides', 'liminarcontracts',
  'therapeuticplans', 'patientbalances', 'evolutions', 'medicalevents', 'prescriptions', 'invoices', 'reminders'];

const tail = (id) => String(id).slice(-4);
function maskPatient(p) {
  const fake = `Paciente ${tail(p._id)}`;
  const out = { ...p, fullName: fake, cpf: null, rg: null, cnpj: null, email: null, phone: '5500000000000',
    birthCertificate: null, address: null, legalGuardian: p.legalGuardian ? `Responsável ${tail(p._id)}` : p.legalGuardian,
    emergencyContact: p.emergencyContact ? { name: 'Contato', phone: '5500000000000', relationship: p.emergencyContact.relationship } : p.emergencyContact,
    clinicalHistory: p.clinicalHistory ? '[mascarado]' : p.clinicalHistory, familyHistory: p.familyHistory ? '[mascarado]' : p.familyHistory };
  if (p.dateOfBirth) { const d = new Date(p.dateOfBirth); out.dateOfBirth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); } // mantém idade aproximada
  return out;
}
function maskDependent(d, p) {
  const out = { ...d };
  if (out.patientInfo) {
    const firstOfMonth = (v) => { if (!v) return v; const d = new Date(v); return isNaN(d) ? null : new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };
    out.patientInfo = { ...out.patientInfo, fullName: `Paciente ${tail(p._id)}`, phone: '5500000000000', email: null, cpf: null,
      birthDate: firstOfMonth(out.patientInfo.birthDate), dateOfBirth: firstOfMonth(out.patientInfo.dateOfBirth) };
  }
  if (out.patientName) out.patientName = `Paciente ${tail(p._id)}`;
  if (out.responsible) out.responsible = `Responsável ${tail(p._id)}`;
  return out;
}

const prod = await mongoose.createConnection(PROD_URI, { readPreference: 'secondaryPreferred', maxPoolSize: 2 }).asPromise();
const dev = await mongoose.createConnection(DEV_URI, { maxPoolSize: 2 }).asPromise();
try {
  const P = prod.db, D = dev.db;
  let patient = /^[0-9a-f]{24}$/i.test(PATIENT) ? await P.collection('patients').findOne({ _id: new mongoose.Types.ObjectId(PATIENT) }) : null;
  if (!patient && /\d{8,}/.test(PATIENT)) { const phone = normalizeE164BR(PATIENT); patient = phone ? await P.collection('patients').findOne({ phone: { $in: [phone, PATIENT] } }) : null; }
  if (!patient) {
    // Nome: só aceita resultado único — nome sozinho não identifica pessoa
    const esc = PATIENT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = await P.collection('patients').find({ fullName: { $regex: esc, $options: 'i' } }, { projection: { fullName: 1, dateOfBirth: 1 } }).limit(10).toArray();
    if (found.length > 1) {
      console.error(`${TAG} ⚠️ ${found.length} pacientes com esse nome — rode de novo com o ID:`);
      for (const f of found) console.error(`   ${f._id}  ${f.fullName}  nasc ${f.dateOfBirth ? new Date(f.dateOfBirth).toISOString().slice(0, 10) : '-'}`);
      process.exit(1);
    }
    patient = found[0] ? await P.collection('patients').findOne({ _id: found[0]._id }) : null;
  }
  if (!patient) { console.error(`${TAG} ❌ paciente não encontrado em produção: ${PATIENT}`); process.exit(1); }
  console.log(`${TAG} paciente ${patient._id} (${MASK ? 'mascarado' : 'SEM máscara'}) — origem ${dbName(PROD_URI)} → destino ${dbName(DEV_URI)}${DRY ? ' [SECO]' : ''}`);

  const plan = [['patients', [MASK ? maskPatient(patient) : patient]]];
  // Evoluções e eventos clínicos são texto clínico livre: só vêm com --com-clinico (e sem máscara não se aplica)
  const CLINICAL = new Set(['evolutions', 'medicalevents', 'prescriptions']);
  for (const col of RELATED) {
    if (MASK && CLINICAL.has(col) && !args.includes('--com-clinico')) continue;
    const docs = await P.collection(col).find({ $or: [{ patient: patient._id }, { patientId: patient._id }, { patientId: String(patient._id) }] }).toArray();
    if (docs.length) plan.push([col, MASK ? docs.map((d) => maskDependent(d, patient)) : docs]);
  }
  // Profissionais referenciados (sem senha) para a agenda abrir em dev
  const doctorIds = [...new Set(plan.flatMap(([, docs]) => docs.map((d) => d.doctor && String(d.doctor._id || d.doctor))).filter(Boolean))];
  if (doctorIds.length) plan.push(['doctors', (await P.collection('doctors').find({ _id: { $in: doctorIds.map((i) => new mongoose.Types.ObjectId(i)) } }, { projection: { password: 0, passwordResetToken: 0, passwordResetExpires: 0 } }).toArray())]);

  for (const [col, docs] of plan) {
    if (!DRY) for (const d of docs) await D.collection(col).replaceOne({ _id: d._id }, d, { upsert: true });
    console.log(`${TAG} ${col.padEnd(18)} ${docs.length}`);
  }
  console.log(`${TAG} ✅ ${DRY ? 'simulação concluída (nada gravado)' : 'copiado para dev'}`);
} finally {
  await prod.close(); await dev.close();
}
