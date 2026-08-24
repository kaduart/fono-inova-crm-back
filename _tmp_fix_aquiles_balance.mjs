// FIX script. Adds a corrective credit to zero out an orphaned/untraceable debit.
// Pre-checks exact expected prior state before writing; aborts otherwise.
import { fileURLToPath } from 'url';
import path from 'path';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import PatientBalance from './models/PatientBalance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '.env') });

const PATIENT_ID = '6a318cbaa16c83a1feaeb8d5';

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const balance = await PatientBalance.findOne({ patient: PATIENT_ID });

  if (!balance) throw new Error('ABORT: PatientBalance não encontrado');
  if (balance.currentBalance !== 800) throw new Error(`ABORT: currentBalance esperado 800, encontrado ${balance.currentBalance}`);
  if (balance.transactions.length !== 1) throw new Error(`ABORT: esperava 1 transação, encontrado ${balance.transactions.length}`);
  const tx = balance.transactions[0];
  if (tx.type !== 'debit' || tx.amount !== 800 || tx.appointmentId || tx.sessionId) {
    throw new Error('ABORT: transação existente não bate com o esperado (débito órfão de 800)');
  }

  console.log('[Fix] Estado confirmado. Corrigindo com updates diretos (evita validação de doc inteiro, que falha na transação legada sem description)...');

  // 1) Backfill da description ausente na transação legada (transactions.0), pra não travar validações futuras
  await PatientBalance.updateOne(
    { patient: PATIENT_ID },
    { $set: { 'transactions.0.description': '[Backfill] Débito sem descrição original (provável origem: balanceWorker.handleDebit gravando via updateOne sem validação de schema).' } }
  );

  // 2) Crédito de ajuste, via update direto (mesmo padrão usado para criar o registro original, sem disparar validação do doc)
  await PatientBalance.updateOne(
    { patient: PATIENT_ID },
    {
      $inc: { currentBalance: -800, totalCredited: 800 },
      $push: {
        transactions: {
          type: 'credit',
          amount: 800,
          description: 'Ajuste de correção: débito órfão de 28/07/2026 sem vínculo a appointment/session/package, sem lastro em débito real (todos os pacotes e sessões do período estão pagos integralmente).',
          transactionDate: new Date()
        }
      },
      $set: { lastTransactionAt: new Date() }
    }
  );

  const after = await PatientBalance.findOne({ patient: PATIENT_ID }).lean();
  console.log('[Fix] Novo currentBalance:', after.currentBalance);
  console.log('[Fix] Total de transações:', after.transactions.length);

  await mongoose.disconnect();
}

main().catch(err => { console.error('[Fix] ERRO:', err.message); process.exit(1); });
