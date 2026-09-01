#!/usr/bin/env node
/**
 * 🔧 CORREÇÃO: valor da avaliação inicial da guia 202603348787 (Daiane Felix
 * Bezerra) estava R$250, usuário confirmou em 2026-08-28 que o correto é
 * R$180 (mesmo valor das demais sessões da guia).
 *
 * A sessão já tinha sido completada quando o erro foi percebido, então já
 * existe: Appointment.sessionValue/insuranceValue=250, Session.sessionValue=250,
 * Payment.amount/insurance.grossAmount=250, guide.evaluationAmount=250, e um
 * lançamento FinancialLedger type=revenue_recognition credit=250.
 *
 * Escopo: corrige os 4 registros mutáveis (Appointment, Session, Payment,
 * InsuranceGuide) para 180. O FinancialLedger é imutável — não edita o
 * lançamento de 250, estorna ele (reversal) e lança um novo
 * revenue_recognition de 180 (mesmo padrão usado no resto desta sessão).
 *
 * Modo padrão: DRY-RUN (só relatório, zero escrita).
 * Uso:
 *   node scripts/maintenance/fix-evaluation-amount-guia-202603348787-2026-08-28.js
 *   node scripts/maintenance/fix-evaluation-amount-guia-202603348787-2026-08-28.js --apply
 */

import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Appointment from '../../models/Appointment.js';
import Session from '../../models/Session.js';
import Payment from '../../models/Payment.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import FinancialLedger from '../../models/FinancialLedger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');

const APPOINTMENT_ID = '6a91cad71f1f753453acac4b';
const SESSION_ID = '6a91cad71f1f753453acac55';
const PAYMENT_ID = '6a91cad91f1f753453acac6e';
const GUIDE_ID = '6a8f38e8318bdaab4c7dae2a';
const LEDGER_ENTRY_ID = '6a91cada1f1f753453acacb8';

const OLD_AMOUNT = 250;
const NEW_AMOUNT = 180;

class AbortedError extends Error {
  constructor(message) { super(message); this.name = 'AbortedError'; }
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  console.log(`[fix-evaluation-amount] Modo: ${APPLY ? 'APPLY (vai escrever)' : 'DRY-RUN (somente leitura)'}`);

  const appointment = await Appointment.findById(APPOINTMENT_ID);
  const session = await Session.findById(SESSION_ID);
  const payment = await Payment.findById(PAYMENT_ID);
  const guide = await InsuranceGuide.findById(GUIDE_ID);
  const ledgerEntry = await FinancialLedger.findById(LEDGER_ENTRY_ID).lean();

  if (!appointment || !session || !payment || !guide || !ledgerEntry) {
    throw new AbortedError('Um ou mais registros não encontrados — abortando.');
  }
  if (appointment.sessionValue !== OLD_AMOUNT && appointment.sessionValue === NEW_AMOUNT) {
    console.log('[fix-evaluation-amount] Já corrigido — idempotente, nada a fazer.');
    await mongoose.disconnect();
    return;
  }
  if (appointment.sessionValue !== OLD_AMOUNT) {
    throw new AbortedError(`Appointment.sessionValue=${appointment.sessionValue}, esperado ${OLD_AMOUNT} — universo mudou, abortando.`);
  }
  if (ledgerEntry.amount !== OLD_AMOUNT || ledgerEntry.type !== 'revenue_recognition') {
    throw new AbortedError('Lançamento do ledger não bate com o esperado — abortando.');
  }
  const alreadyReversed = await FinancialLedger.findOne({ reversalOfEntryId: LEDGER_ENTRY_ID }).lean();
  if (alreadyReversed) {
    throw new AbortedError('Esse lançamento já foi estornado antes — abortando (evita estorno duplicado).');
  }

  console.log('--- PLANEJADO ---');
  console.log(JSON.stringify({
    appointment: { sessionValue: `${appointment.sessionValue} -> ${NEW_AMOUNT}`, insuranceValue: `${appointment.insuranceValue} -> ${NEW_AMOUNT}` },
    session: { sessionValue: `${session.sessionValue} -> ${NEW_AMOUNT}` },
    payment: { amount: `${payment.amount} -> ${NEW_AMOUNT}`, grossAmount: `${payment.insurance?.grossAmount} -> ${NEW_AMOUNT}` },
    guide: { evaluationAmount: `${guide.evaluationAmount} -> ${NEW_AMOUNT}` },
    ledger: { reverseEntryId: LEDGER_ENTRY_ID, amount: OLD_AMOUNT, thenNewCredit: NEW_AMOUNT },
  }, null, 2));

  if (!APPLY) {
    console.log('\n[DRY-RUN] Nenhuma escrita realizada. Rode novamente com --apply para aplicar.');
    await mongoose.disconnect();
    return;
  }

  const mongoSession = await mongoose.startSession();
  try {
    await mongoSession.withTransaction(async () => {
      await FinancialLedger.debit({
        type: 'reversal',
        amount: OLD_AMOUNT,
        billingType: 'convenio',
        patient: ledgerEntry.patient,
        appointment: ledgerEntry.appointment,
        session: ledgerEntry.session,
        reversalOfEntryId: LEDGER_ENTRY_ID,
        correlationId: `fix_eval_amount_${LEDGER_ENTRY_ID}`,
        description: 'Estorno — valor da avaliação corrigido de R$250 para R$180 (erro de cadastro)',
        occurredAt: new Date(),
        createdBy: null,
        createdByName: 'fix-evaluation-amount-script',
        metadata: { source: 'evaluation_amount_correction', originalEntryId: LEDGER_ENTRY_ID },
      }, mongoSession);

      await FinancialLedger.credit({
        type: 'revenue_recognition',
        amount: NEW_AMOUNT,
        billingType: 'convenio',
        patient: ledgerEntry.patient,
        appointment: ledgerEntry.appointment,
        session: ledgerEntry.session,
        correlationId: `fix_eval_amount_new_${LEDGER_ENTRY_ID}`,
        description: 'Receita reconhecida - convenio (valor corrigido)',
        occurredAt: new Date(),
        createdBy: null,
        createdByName: 'fix-evaluation-amount-script',
        metadata: { source: 'evaluation_amount_correction', correctedFrom: OLD_AMOUNT },
      }, mongoSession);

      appointment.sessionValue = NEW_AMOUNT;
      appointment.insuranceValue = NEW_AMOUNT;
      await appointment.save({ session: mongoSession });

      session.sessionValue = NEW_AMOUNT;
      await session.save({ session: mongoSession });

      payment.amount = NEW_AMOUNT;
      payment.insurance.grossAmount = NEW_AMOUNT;
      await payment.save({ session: mongoSession });

      guide.evaluationAmount = NEW_AMOUNT;
      await guide.save({ session: mongoSession });
    });
    console.log('[APPLY] Corrigido: Appointment, Session, Payment, InsuranceGuide -> 180; ledger estornado + novo lançamento de 180.');
  } finally {
    await mongoSession.endSession();
  }

  const finalAppointment = await Appointment.findById(APPOINTMENT_ID).select('sessionValue insuranceValue').lean();
  const finalSession = await Session.findById(SESSION_ID).select('sessionValue').lean();
  const finalPayment = await Payment.findById(PAYMENT_ID).select('amount insurance').lean();
  const finalGuide = await InsuranceGuide.findById(GUIDE_ID).select('evaluationAmount').lean();
  const ledgerNet = await FinancialLedger.find({ appointment: APPOINTMENT_ID }).select('type direction amount').lean();
  console.log('--- VALIDAÇÃO ---');
  console.log(JSON.stringify({ finalAppointment, finalSession, finalPayment, finalGuide, ledgerNet }, null, 2));

  await mongoose.disconnect();
}

main().catch(err => {
  console.error(`[fix-evaluation-amount] ABORTADO: ${err.message}`);
  process.exitCode = 1;
});
