/**
 * Mesclar cadastros duplicados de paciente (03/11/2026)
 *
 * Caso real: "BENJAMIN MARCAL BALDEZ" (sem telefone, Particular) e "Benjamin Marçal Baldez"
 * (com telefone, Unimed Campinas) — a mesma criança em dois cadastros, com histórico dividido.
 *
 * O que faz, numa transação só:
 *   1. Todo documento que aponta para o cadastro DUPLICADO passa a apontar para o PRINCIPAL.
 *      As coleções são descobertas pelo schema (campo com ref 'Patient' ou chamado
 *      patient/patientId), então um model novo entra sozinho. Usa a collection crua
 *      (sem hooks), como o deletePatientCommand.
 *   2. PatientBalance (único por paciente): junta as transações e soma os totais.
 *   3. Campos vazios do principal são completados com os do duplicado (telefone, CPF,
 *      e-mail, RG, endereço, convênio...). Nada que já está preenchido é sobrescrito.
 *   4. O duplicado é apagado pelo deletePatientCommand — que grava a cópia integral em
 *      deletedpatientarchives (reason "merged_into:<principal>") antes de apagar.
 *
 * NÃO mexe em FinancialLedger: é imutável por design (ver DELETE_CASCADE_CONTRACT.md).
 * Os lançamentos continuam com o id antigo, que fica rastreável pelo arquivo.
 *
 * Segurança:
 *   - dryRun (padrão) só conta o que seria movido.
 *   - Execução real exige PATIENT_MERGE_ENABLED=true no ambiente. Em produção fica
 *     desligado até o Kadu autorizar ("pode aplicar"), depois de ensaiado no espelho.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import Patient from '../../../models/Patient.js';
import { runTransactionWithRetry } from '../../../utils/transactionRetry.js';
import { execute as deletePatientCommand } from './deletePatientCommand.js';

const MODELS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../models');

// tratados à parte (ou que não devem ser tocados)
const SKIP_MODELS = new Set(['Patient', 'PatientBalance', 'PatientsView', 'FinancialLedger', 'DeletedPatientArchive']);
const PATIENT_FIELD_NAME = /^(patient|patientId)$/;
// campos do Patient que podem ser completados a partir do duplicado (só se vazios no principal)
const FILL_FIELDS = ['phone', 'email', 'cpf', 'cnpj', 'rg', 'gender', 'maritalStatus', 'profession', 'placeOfBirth',
  'address', 'mainComplaint', 'clinicalHistory', 'medications', 'allergies', 'familyHistory', 'legalGuardian',
  'emergencyContact', 'healthPlan'];

let modelsLoaded = false;
async function loadAllModels() {
  if (modelsLoaded) return;
  const files = fs.readdirSync(MODELS_DIR).filter((f) => f.endsWith('.js') && f !== 'index.js');
  for (const f of files) {
    try {
      await import(path.join(MODELS_DIR, f));
    } catch {
      // arquivo que não é model (ou falhou ao carregar): ignorado
    }
  }
  modelsLoaded = true;
}

function isPatientRef(schemaType) {
  const ref = schemaType?.options?.ref || schemaType?.caster?.options?.ref;
  return ref === 'Patient';
}

/**
 * Lista { model, collection, kind, path, sub, idType } de cada campo que referencia paciente.
 * kind: 'scalar' | 'array' (array de ids) | 'docArray' (subdocumento dentro de array).
 */
export async function discoverPatientRefs() {
  await loadAllModels();
  const refs = [];
  for (const name of mongoose.modelNames()) {
    if (SKIP_MODELS.has(name)) continue;
    const model = mongoose.model(name);
    const seen = new Set();
    model.schema.eachPath((p, st) => {
      const leaf = p.split('.').pop();
      if (st.instance === 'Array' && st.schema) {
        // array de subdocumentos: procura campos de paciente dentro
        st.schema.eachPath((sp, sst) => {
          const sleaf = sp.split('.').pop();
          if (isPatientRef(sst) || (PATIENT_FIELD_NAME.test(sleaf) && ['ObjectId', 'String'].includes(sst.instance))) {
            refs.push({ model: name, collection: model.collection.name, kind: 'docArray', path: p, sub: sp, idType: sst.instance });
          }
        });
        return;
      }
      if (st.instance === 'Array' && isPatientRef(st)) {
        refs.push({ model: name, collection: model.collection.name, kind: 'array', path: p, idType: 'ObjectId' });
        return;
      }
      if (isPatientRef(st) || (PATIENT_FIELD_NAME.test(leaf) && ['ObjectId', 'String'].includes(st.instance))) {
        const key = `${p}`;
        if (seen.has(key)) return;
        seen.add(key);
        refs.push({ model: name, collection: model.collection.name, kind: 'scalar', path: p, idType: st.instance });
      }
    });
  }
  return refs;
}

const idValue = (idType, oid) => (idType === 'String' ? oid.toString() : oid);

function filterFor(ref, dupOid) {
  const v = idValue(ref.idType, dupOid);
  if (ref.kind === 'docArray') return { [`${ref.path}.${ref.sub}`]: v };
  return { [ref.path]: v };
}

async function moveRef(db, ref, dupOid, primOid, session) {
  const coll = db.collection(ref.collection);
  const from = idValue(ref.idType, dupOid);
  const to = idValue(ref.idType, primOid);
  if (ref.kind === 'scalar') {
    return coll.updateMany({ [ref.path]: from }, { $set: { [ref.path]: to } }, { session });
  }
  if (ref.kind === 'array') {
    return coll.updateMany(
      { [ref.path]: from },
      { $set: { [`${ref.path}.$[e]`]: to } },
      { session, arrayFilters: [{ e: from }] }
    );
  }
  return coll.updateMany(
    { [`${ref.path}.${ref.sub}`]: from },
    { $set: { [`${ref.path}.$[e].${ref.sub}`]: to } },
    { session, arrayFilters: [{ [`e.${ref.sub}`]: from }] }
  );
}

function isEmpty(v) {
  if (v === null || v === undefined || v === '') return true;
  if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
    return Object.values(v).every(isEmpty);
  }
  return false;
}

function fieldsToFill(primary, duplicate) {
  const set = {};
  for (const f of FILL_FIELDS) {
    if (isEmpty(primary[f]) && !isEmpty(duplicate[f])) set[f] = duplicate[f];
  }
  // convênio: "Particular" no principal e convênio real no duplicado → fica o convênio
  const pPlan = (primary.healthPlan?.name || '').trim().toLowerCase();
  const dPlan = (duplicate.healthPlan?.name || '').trim();
  if ((pPlan === '' || pPlan === 'particular') && dPlan && dPlan.toLowerCase() !== 'particular') {
    set.healthPlan = duplicate.healthPlan;
  }
  if (!primary.dateOfBirth && duplicate.dateOfBirth) set.dateOfBirth = duplicate.dateOfBirth;
  return set;
}

/**
 * @param {{primaryId:string, duplicateId:string, user?:any, dryRun?:boolean}} params
 */
export async function execute({ primaryId, duplicateId, user = null, dryRun = true }) {
  if (!mongoose.Types.ObjectId.isValid(primaryId) || !mongoose.Types.ObjectId.isValid(duplicateId)) {
    throw Object.assign(new Error('IDs inválidos'), { statusCode: 400, code: 'BAD_REQUEST' });
  }
  if (String(primaryId) === String(duplicateId)) {
    throw Object.assign(new Error('Escolha dois cadastros diferentes'), { statusCode: 400, code: 'BAD_REQUEST' });
  }
  const primOid = new mongoose.Types.ObjectId(primaryId);
  const dupOid = new mongoose.Types.ObjectId(duplicateId);

  const [primary, duplicate] = await Promise.all([
    Patient.findById(primOid).lean(),
    Patient.findById(dupOid).lean(),
  ]);
  if (!primary || !duplicate) {
    throw Object.assign(new Error('Paciente não encontrado'), { statusCode: 404, code: 'PATIENT_NOT_FOUND' });
  }

  const refs = await discoverPatientRefs();
  const db = mongoose.connection.db;

  // prévia: quantos documentos de cada coleção seriam movidos
  const preview = [];
  for (const ref of refs) {
    const n = await db.collection(ref.collection).countDocuments(filterFor(ref, dupOid));
    if (n > 0) preview.push({ collection: ref.collection, campo: ref.kind === 'docArray' ? `${ref.path}.${ref.sub}` : ref.path, documentos: n });
  }
  const balances = await db.collection('patientbalances').find({ patient: { $in: [primOid, dupOid] } }).toArray();
  const ledgerCount = await db.collection('financial_ledger').countDocuments({ patient: dupOid }).catch(() => 0);
  const fill = fieldsToFill(primary, duplicate);

  const summary = {
    principal: { id: primaryId, nome: primary.fullName },
    duplicado: { id: duplicateId, nome: duplicate.fullName },
    mover: preview,
    saldo: balances.find((b) => b.patient.equals(dupOid))
      ? (balances.find((b) => b.patient.equals(primOid)) ? 'juntar os dois saldos' : 'passar o saldo para o principal')
      : 'sem saldo no duplicado',
    camposCompletados: Object.keys(fill),
    lancamentosContabeisMantidos: ledgerCount,
  };

  if (dryRun) return { dryRun: true, ...summary };

  if (process.env.PATIENT_MERGE_ENABLED !== 'true') {
    throw Object.assign(
      new Error('Mesclar está desligado neste ambiente (PATIENT_MERGE_ENABLED). Use a prévia.'),
      { statusCode: 403, code: 'MERGE_DISABLED' }
    );
  }

  const moved = await runTransactionWithRetry(async (session) => {
    const counts = {};
    for (const ref of refs) {
      const r = await moveRef(db, ref, dupOid, primOid, session);
      if (r.modifiedCount) counts[`${ref.collection}.${ref.kind === 'docArray' ? `${ref.path}.${ref.sub}` : ref.path}`] = r.modifiedCount;
    }

    // saldo: um registro por paciente
    const bColl = db.collection('patientbalances');
    const dupBal = await bColl.findOne({ patient: dupOid }, { session });
    if (dupBal) {
      const primBal = await bColl.findOne({ patient: primOid }, { session });
      if (!primBal) {
        await bColl.updateOne({ _id: dupBal._id }, { $set: { patient: primOid } }, { session });
      } else {
        await bColl.updateOne(
          { _id: primBal._id },
          {
            $push: { transactions: { $each: dupBal.transactions || [] } },
            $inc: {
              currentBalance: dupBal.currentBalance || 0,
              totalDebited: dupBal.totalDebited || 0,
              totalCredited: dupBal.totalCredited || 0,
            },
            $max: { lastTransactionAt: dupBal.lastTransactionAt || new Date(0) },
          },
          { session }
        );
        // o duplicado sai pelo arquivo do deletePatientCommand (que guarda o saldo)
      }
    }

    // principal: completa vazios, junta arrays-sombra e limpa a marca de duplicado
    await db.collection('patients').updateOne(
      { _id: primOid },
      {
        ...(Object.keys(fill).length ? { $set: fill } : {}),
        $addToSet: {
          appointments: { $each: duplicate.appointments || [] },
          packages: { $each: duplicate.packages || [] },
        },
        $pull: { possibleDuplicateOf: dupOid },
      },
      { session }
    );

    // duplicado: arquivo integral + exclusão (agora sem nada vinculado)
    await deletePatientCommand(duplicateId, {
      mongoSession: session,
      user,
      reason: `merged_into:${primaryId}`,
    });
    return counts;
  });

  // view do principal reconstruída fora da transação
  try {
    const { buildPatientView } = await import('../../clinical/services/patientProjectionService.js');
    await buildPatientView(primaryId, { force: true, correlationId: `merge_${duplicateId}` });
  } catch (e) {
    console.error('[MergePatients] view do principal não reconstruída:', e.message);
  }

  console.log('[MergePatients] ✅ mesclado', { primaryId, duplicateId, moved, by: user?._id || user?.id || null });
  return { dryRun: false, ...summary, movidos: moved };
}

export default { execute, discoverPatientRefs };
