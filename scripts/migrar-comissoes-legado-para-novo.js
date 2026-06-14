#!/usr/bin/env node
/**
 * 🔄 Migração: campos legados de comissão → motor de regras novo
 *
 * Converte:
 *   - commissionRules.standardSession  → regras para particular, package e liminar (sessão)
 *   - commissionRules.evaluationSession → regras para particular, package e liminar (avaliação)
 *   - commissionRules.byInsurance      → regras por convênio (sessão)
 *
 * Após a migração, zera os campos legados (mantém neuropsychEvaluation separado
 * porque o motor novo ainda não tem regra equivalente para pacote neuropsicológico completo).
 *
 * Uso:
 *   node back/scripts/migrar-comissoes-legado-para-novo.js --dry-run   (padrão)
 *   node back/scripts/migrar-comissoes-legado-para-novo.js --apply
 */

import mongoose from 'mongoose';
import Doctor from '../models/Doctor.js';

const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0';

const APPLY = process.argv.includes('--apply');

function ruleExists(rules, billingType, serviceType, value, insurance = null) {
  return rules.some(r =>
    r.billingType === billingType &&
    r.serviceType === serviceType &&
    r.commissionType === 'fixed' &&
    r.value === value &&
    (insurance ? r.insurance === insurance : !r.insurance)
  );
}

function createRule(billingType, serviceType, value, insurance = null, note = '') {
  return {
    _id: new mongoose.Types.ObjectId(),
    serviceType,
    billingType,
    insurance,
    commissionType: 'fixed',
    value,
    minValue: null,
    maxValue: null,
    priority: 0,
    startDate: null,
    endDate: null,
    effectiveDate: null,
    active: true,
    notes: note
  };
}

const DEFAULTS = {
  standardSession: 60,
  evaluationSession: 0,
  neuropsychEvaluation: 1200
};

function hasActiveLegacy(comm) {
  if (!comm) return false;
  if (comm.standardSession !== undefined && comm.standardSession !== null && comm.standardSession !== DEFAULTS.standardSession) return true;
  if (comm.evaluationSession !== undefined && comm.evaluationSession !== null && comm.evaluationSession !== DEFAULTS.evaluationSession) return true;
  if (comm.byInsurance && Object.keys(comm.byInsurance).length > 0) return true;
  if (comm.customRules && comm.customRules.length > 0) return true;
  return false;
}

function buildNewRules(doctor) {
  const comm = doctor.commissionRules || {};
  if (!hasActiveLegacy(comm)) return [];

  const existingRules = comm.rules || [];
  const newRules = [];

  const standard = comm.standardSession;
  if (standard !== undefined && standard !== null && standard > 0 && standard !== DEFAULTS.standardSession) {
    for (const billingType of ['particular', 'package', 'liminar']) {
      if (!ruleExists(existingRules, billingType, 'session', standard)) {
        newRules.push(createRule(billingType, 'session', standard, null, `Migrado de standardSession (${standard})`));
      }
    }
  }

  const evaluation = comm.evaluationSession;
  if (evaluation !== undefined && evaluation !== null && evaluation > 0 && evaluation !== DEFAULTS.evaluationSession) {
    for (const billingType of ['particular', 'package', 'liminar']) {
      if (!ruleExists(existingRules, billingType, 'evaluation', evaluation)) {
        newRules.push(createRule(billingType, 'evaluation', evaluation, null, `Migrado de evaluationSession (${evaluation})`));
      }
    }
  }

  const byInsurance = comm.byInsurance || {};
  for (const [insurance, value] of Object.entries(byInsurance)) {
    if (value === undefined || value === null || value <= 0) continue;
    if (!ruleExists(existingRules, 'convenio', 'session', value, insurance)) {
      newRules.push(createRule('convenio', 'session', value, insurance, `Migrado de byInsurance.${insurance}`));
    }
  }

  return newRules;
}

async function run() {
  await mongoose.connect(MONGO_URI);
  console.log('Conectado ao MongoDB:', mongoose.connection.db.databaseName);
  console.log(`Modo: ${APPLY ? 'APLICAÇÃO' : 'DRY-RUN (nada será salvo)'}`);

  const doctors = await Doctor.find({}).sort('fullName').lean();
  let totalMigrated = 0;
  let totalDoctors = 0;

  for (const doctor of doctors) {
    const newRules = buildNewRules(doctor);
    if (newRules.length === 0) continue;

    totalDoctors++;
    totalMigrated += newRules.length;

    console.log(`\n${doctor.fullName} (${doctor.specialty})`);
    for (const r of newRules) {
      console.log(`  + ${r.serviceType}/${r.billingType}${r.insurance ? `/${r.insurance}` : ''} = R$ ${r.value}`);
    }

    if (APPLY) {
      const comm = doctor.commissionRules || {};
      const updatedRules = [...(comm.rules || []), ...newRules];
      await Doctor.updateOne(
        { _id: doctor._id },
        {
          $set: {
            'commissionRules.rules': updatedRules,
            commissionRuleVersion: (doctor.commissionRuleVersion || 1) + 1
          },
          $unset: {
            'commissionRules.standardSession': '',
            'commissionRules.evaluationSession': '',
            'commissionRules.byInsurance': '',
            'commissionRules.customRules': ''
          }
        }
      );
      console.log('  ✅ salvo');
    }
  }

  console.log(`\n═══════════════════════════════════════════════════════════════════`);
  console.log(`Profissionais afetados: ${totalDoctors}`);
  console.log(`Regras a criar: ${totalMigrated}`);
  console.log(`Modo: ${APPLY ? 'APLICADO' : 'DRY-RUN'}`);
  console.log(`═══════════════════════════════════════════════════════════════════`);

  await mongoose.disconnect();
}

run().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
