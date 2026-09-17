#!/usr/bin/env node
/**
 * Extensão da NF 123 (Kauana Queiroz Gomes Naves, Unimed Anápolis).
 *
 * ══ O QUE ACONTECEU ═══════════════════════════════════════════════════════
 *
 * O lote legado da NF 123 (InsuranceBatch 6a7b79207c2cc16eff9633d1,
 * batchNumber LEGACY-KAUANA_QUEIROZ-MARCO_2026) só capturou 4 das 20 sessões
 * reais da nota física (02/03 e 06/03, guias 2027-fono e 2028-TO). A NF
 * física (09/02 a 06/03/2026) cobre:
 *   - guia 2027 (fonoaudiologia): 8 sessões
 *   - guia 2028 (terapia_ocupacional): 9 sessões no banco (a nota lista 8 —
 *     a 9ª, 13/02 16:00, tem Payment já 'billed' desde 07/08/2026 sem lote
 *     nenhum vinculado; confirmado pelo usuário 2026-09-16 que ela também
 *     faz parte desta NF, fechando o total em R$1.600,00/20 sessões)
 *   - guia 2029 (psicologia): 3 sessões (a "4ª" que a nota lista em 20/02
 *     15:20 é o mesmo horário da sessão de TO daquele dia — duplicação de
 *     transcrição na nota física, não uma sessão real a mais; confirmado
 *     pelo usuário)
 * Total real: 8+9+3 = 20 sessões × R$80 = R$1.600,00 bruto, ISS 2,01%
 * (R$32,16) = R$1.567,84 líquido — bate exato com os valores impressos na
 * NF física.
 *
 * Todas as 16 sessões faltantes já têm Payment com insurance.status='billed'
 * (nenhuma está em pending_billing) — não precisou criar Payment novo, só
 * agrupar no lote e promover pra 'received' (a NF inteira já foi paga em
 * 22/04/2026, mesma data que os 4 itens originais do lote já tinham).
 *
 * ══ O QUE ESTE SCRIPT FAZ ═════════════════════════════════════════════════
 *   1. Acrescenta os 16 itens faltantes ao array `sessions` do lote
 *      existente (nunca cria um lote novo — é extensão, não duplicata).
 *   2. Atualiza totalGross/totalSessions/issRate/issAmount/totalNet/
 *      reconciliation do lote pro total real de 20 sessões.
 *   3. Seta Session.billingBatchId nas 16 sessões novas.
 *   4. Muda batch.status de 'received' pra 'partial' (tem itens novos ainda
 *      não recebidos) e chama receiveInsuranceBatch (serviço canônico —
 *      mesmo do botão "Baixar saldo da NF") com a data histórica real
 *      (22/04/2026) pra promover os 16 Payments novos a 'received' — os 4
 *      antigos já 'received' são ignorados automaticamente pelo serviço.
 *
 * dryRun por padrão. Idempotente: sessão já no lote é pulada.
 *
 * ══ USO ═══════════════════════════════════════════════════════════════════
 *   node scripts/maintenance/fix-kauana-nf123-2026-09-16.mjs            (dry-run)
 *   node scripts/maintenance/fix-kauana-nf123-2026-09-16.mjs --apply
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config();

import '../../models/index.js';
import Session from '../../models/Session.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import { receiveInsuranceBatch } from '../../services/insuranceBatch/InsuranceBatchReceiptService.js';

const APPLY = process.argv.includes('--apply');
const USER_ID = '6a2806fbd330bd5bec8e8d37'; // Ricardo Maia Santos (admin)
const BATCH_ID = '6a7b79207c2cc16eff9633d1';
const RECEIVED_DATE = '2026-04-22';

const GUIDE_FONO = '69986a657c92d32c1fd4446f';
const GUIDE_TO = '69986a4c7c92d32c1fd44464';
const GUIDE_PSICO = '69986cc37c92d32c1fd44de9';

// [sessionId, appointmentId, guideId, activePaymentId, dateISO]
const MISSING = [
  ['69986c7d7c92d32c1fd44beb', '69986c7d7c92d32c1fd44c0c', GUIDE_FONO, '6999199c4191970789aacd4a', '2026-02-09'],
  ['69986c7d7c92d32c1fd44bec', '69986c7d7c92d32c1fd44c0d', GUIDE_FONO, '699cd1a9d6de140f6f209717', '2026-02-13'],
  ['69986c7d7c92d32c1fd44bed', '69986c7d7c92d32c1fd44c0e', GUIDE_FONO, '699cd1a9d6de140f6f209720', '2026-02-16'],
  ['69986c7d7c92d32c1fd44bee', '69986c7d7c92d32c1fd44c0f', GUIDE_FONO, '6999199d4191970789aacd55', '2026-02-20'],
  ['699c6a74353c11d3c7775dbc', '699c6a75353c11d3c7775dc4', GUIDE_FONO, '6a3da8379c02f146eb876b66', '2026-02-23'],
  ['69986c7d7c92d32c1fd44bf0', '69986c7d7c92d32c1fd44c11', GUIDE_FONO, '69c3ec3e64bc8f5c1df65ed5', '2026-02-27'],
  ['69986c057c92d32c1fd44a22', '69986c067c92d32c1fd44a45', GUIDE_TO, '6a3da6bc1302c61f20c958a0', '2026-02-09'],
  ['69986c057c92d32c1fd44a23', '69986c067c92d32c1fd44a46', GUIDE_TO, '699cd1a8d6de140f6f209705', '2026-02-13'],
  ['69986c057c92d32c1fd44a2a', '69986c067c92d32c1fd44a4d', GUIDE_TO, '6a3da6be1302c61f20c958c5', '2026-02-13'],
  ['69986c057c92d32c1fd44a24', '69986c067c92d32c1fd44a47', GUIDE_TO, '699cd1a8d6de140f6f20970e', '2026-02-16'],
  ['69986c057c92d32c1fd44a25', '69986c067c92d32c1fd44a48', GUIDE_TO, '69af0891381a1dc2998ab091', '2026-02-20'],
  ['69986c057c92d32c1fd44a26', '699de6374152216f7913f18d', GUIDE_TO, '699de6364152216f7913f188', '2026-02-23'],
  ['69986c057c92d32c1fd44a27', '69986c067c92d32c1fd44a4a', GUIDE_TO, '69c3eb63fdbe7cd5b7b25060', '2026-02-27'],
  ['69986d557c92d32c1fd44f17', '69986d567c92d32c1fd44f38', GUIDE_PSICO, '699cd1a9d6de140f6f209736', '2026-02-09'],
  ['69986d557c92d32c1fd44f18', '69986d567c92d32c1fd44f39', GUIDE_PSICO, '699cd1a9d6de140f6f20973f', '2026-02-13'],
  ['69986d557c92d32c1fd44f19', '69986d567c92d32c1fd44f3a', GUIDE_PSICO, '699cd1aad6de140f6f209748', '2026-02-16'],
];

const TOTAL_GROSS = 1600;
const ISS_RATE = 2.01;
const ISS_AMOUNT = 32.16;
const TOTAL_NET = 1567.84;

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\n${APPLY ? '🔧 MODO APPLY (grava)' : '🔍 DRY-RUN (não grava nada)'}\n`);

  const batch = await InsuranceBatch.findById(BATCH_ID).lean();
  if (!batch) { console.error('Lote NF 123 não encontrado'); await mongoose.disconnect(); process.exit(2); }
  console.log(`Lote atual: ${batch.batchNumber} · status=${batch.status} · ${batch.sessions.length} sessões · bruto R$${batch.totalGross}`);

  const existingSessionIds = new Set(batch.sessions.map(s => String(s.session)));
  const toAdd = MISSING.filter(([sid]) => !existingSessionIds.has(sid));
  console.log(`${toAdd.length} de ${MISSING.length} sessões faltantes ainda precisam ser adicionadas (revalidado agora)`);

  if (toAdd.length === 0) {
    console.log('Nada a adicionar — lote já completo. Verificando recebimento...');
  } else {
    console.log('\nSessões a adicionar:');
    for (const [sid, , guideId, paymentId, dateISO] of toAdd) {
      const label = guideId === GUIDE_FONO ? 'fono' : guideId === GUIDE_TO ? 'TO' : 'psico';
      console.log(`  ${dateISO} | ${label} | session=${sid.slice(-6)} payment=${paymentId.slice(-6)}`);
    }
  }

  console.log(`\nNovo total esperado: 20 sessões, bruto R$${TOTAL_GROSS}, ISS ${ISS_RATE}% (R$${ISS_AMOUNT}), líquido R$${TOTAL_NET}`);

  if (!APPLY) {
    console.log('\nNada gravado. Rode com --apply.');
    await mongoose.disconnect();
    return;
  }

  if (toAdd.length > 0) {
    const newItems = toAdd.map(([sid, apptId, guideId, paymentId, dateISO]) => ({
      session: new mongoose.Types.ObjectId(sid),
      appointment: new mongoose.Types.ObjectId(apptId),
      guide: new mongoose.Types.ObjectId(guideId),
      payment: new mongoose.Types.ObjectId(paymentId),
      grossAmount: 80,
      netAmount: Math.round((80 * (TOTAL_NET / TOTAL_GROSS)) * 100) / 100,
      status: 'sent',
      sessionDate: new Date(`${dateISO}T12:00:00.000Z`),
      sentAt: new Date(RECEIVED_DATE),
      valueSource: 'canonical_payment',
    }));

    await InsuranceBatch.updateOne(
      { _id: BATCH_ID },
      {
        $push: { sessions: { $each: newItems } },
        $set: {
          totalGross: TOTAL_GROSS,
          totalSessions: 20,
          issRate: ISS_RATE,
          issAmount: ISS_AMOUNT,
          totalNet: TOTAL_NET,
          status: 'partial',
          reconciliation: {
            status: 'matched',
            reason: null,
            expectedGross: TOTAL_GROSS,
            documentedGross: TOTAL_GROSS,
            documentedNet: TOTAL_NET,
            difference: 0,
            documentReference: 'NF 123 física (Prefeitura de Anápolis, 06/04/2026) — 20 sessões confirmadas pelo usuário (Ricardo, 2026-09-16): 8 fono + 9 TO (inclui 13/02 16:00, já billed sem lote) + 3 psicologia (4ª linha da nota é duplicata do horário de TO em 20/02)',
          },
          reconciledBy: new mongoose.Types.ObjectId(USER_ID),
          reconciledAt: new Date(),
        },
      }
    );
    console.log(`✅ ${newItems.length} sessões adicionadas ao lote, totais atualizados.`);

    const sessionIds = toAdd.map(([sid]) => sid);
    const r = await Session.updateMany(
      { _id: { $in: sessionIds } },
      { $set: { billingBatchId: BATCH_ID, updatedAt: new Date() } }
    );
    console.log(`✅ ${r.modifiedCount} Sessions atualizadas com billingBatchId.`);
  }

  console.log('\n── Baixa como recebido ──');
  const receiveResult = await receiveInsuranceBatch(BATCH_ID, { receivedDate: RECEIVED_DATE, userId: USER_ID });
  console.log(`${receiveResult.idempotent ? '⏭️  já estava recebido' : '✅ recebido'} · status=${receiveResult.status}`);
  if (!receiveResult.idempotent) {
    console.log(`paymentsReceived=${receiveResult.paymentsReceived} · receivedAmount=R$${receiveResult.receivedAmount}`);
  }

  const final = await InsuranceBatch.findById(BATCH_ID).lean();
  console.log('\n' + '═'.repeat(70));
  console.log('RECONCILIAÇÃO FINAL');
  console.log('═'.repeat(70));
  console.log(`  sessões no lote: ${final.sessions.length} (esperado 20)`);
  console.log(`  totalGross: R$${final.totalGross} (esperado ${TOTAL_GROSS})`);
  console.log(`  totalNet: R$${final.totalNet} (esperado ${TOTAL_NET})`);
  console.log(`  receivedAmount: R$${final.receivedAmount}`);
  console.log(`  status: ${final.status} (esperado received)`);
  console.log('═'.repeat(70));

  await mongoose.disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
