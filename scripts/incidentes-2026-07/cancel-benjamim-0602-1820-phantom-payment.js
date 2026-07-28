// scripts/cancel-benjamim-0602-1820-phantom-payment.js
// Cancela o Payment fantasma da sessão de 02/06/2026 18:20 (Benjamim Rocha Simão,
// guia expirada 15924845) — sessão "criada via factory" sem lastro em nenhum
// protocolo físico assinado (nem da guia 15924845 nem da 16145509/16145508).
// Não apaga Session/Appointment (histórico clínico preservado).
//
// Uso: node scripts/cancel-benjamim-0602-1820-phantom-payment.js          (dry-run)
//      node scripts/cancel-benjamim-0602-1820-phantom-payment.js --apply  (executa)

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
const APPLY = process.argv.includes('--apply');

const PAYMENT_ID = new mongoose.Types.ObjectId('6a0c540480cc438aa0b67d36');
const SESSION_ID = new mongoose.Types.ObjectId('6a0c540580cc438aa0b67d3c');

async function main() {
  await mongoose.connect(MONGO_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 30000 });
  const Payment = mongoose.connection.collection('payments');
  const Session = mongoose.connection.collection('sessions');

  const payment = await Payment.findOne({ _id: PAYMENT_ID });
  if (!payment) throw new Error('Payment não encontrado');
  console.log(`Payment ${payment._id}: status=${payment.status} insurance.status=${payment.insurance?.status} -> canceled / (insurance.status removido)`);

  const session = await Session.findOne({ _id: SESSION_ID });
  console.log(`Session ${session._id}: insuranceGuide=${session.insuranceGuide} -> mantém-se (sem faturamento, guideConsumed já é false)`);

  if (!APPLY) {
    console.log('\n[DRY-RUN] Nenhuma escrita realizada. Rode com --apply para executar.');
    await mongoose.disconnect();
    return;
  }

  await Payment.updateOne(
    { _id: PAYMENT_ID },
    {
      $set: {
        status: 'canceled',
        canceledAt: new Date(),
        canceledReason: 'Sessão sem lastro em protocolo físico assinado (guia 15924845 expirada / 16145508 inexistente) — duplicidade de agendamento na transição de guia, confirmado com o operador em 2026-07-27'
      },
      $unset: { 'insurance.status': '' }
    }
  );

  // Session permanece vinculada à guia antiga apenas como registro clínico —
  // não deve mais aparecer como pendente de faturamento (billingBatchId
  // continua null, mas o Payment cancelado já tira do fluxo de faturamento).

  console.log('\n[APPLY] Payment cancelado.');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error('Erro:', err);
  process.exit(1);
});
