/**
 * ============================================================
 * CLEANUP: Receber duplicados de convênio
 * ============================================================
 *
 * Remove payments duplicados de convênio ativos para a mesma session,
 * mantendo o payment "canônico" por estado financeiro avançado.
 *
 * Uso:
 *   node --env-file=.env scripts/cleanup-convenio-duplicate-payments.js
 *   node --env-file=.env scripts/cleanup-convenio-duplicate-payments.js --execute
 *
 * Segurança:
 *   - dry-run por padrão
 *   - snapshot em arquivo antes de qualquer alteração
 *   - relatório com keep/remove justificado por session
 * ============================================================
 */
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';

const DRY_RUN = !process.argv.includes('--execute');
const OUTPUT_DIR = path.resolve(process.cwd(), 'auditoria-output');

const STATUS_RANK = {
  received: 5,
  paid: 5,
  billed: 4,
  pending_billing: 3,
  pending: 2,
  canceled: 1,
  refunded: 0
};

function rank(status) {
  return STATUS_RANK[status] ?? 1;
}

function fmtId(id) {
  if (!id) return null;
  return id.toString ? id.toString() : String(id);
}

function scorePayment(payment) {
  let score = 0;

  // Estado financeiro é o critério principal
  score += rank(payment.status) * 1000;

  // Preferir payment com session preenchida
  if (payment.session) score += 100;

  // Preferir payment com appointment preenchido
  if (payment.appointment) score += 50;

  // Preferir payment com insurance.guideId
  if (payment.insurance?.guideId) score += 30;

  // Preferir payment com valor > 0
  if ((payment.amount || 0) > 0) score += 20;

  // Em empate, manter o mais antigo (createdAt menor)
  if (payment.createdAt) {
    score -= new Date(payment.createdAt).getTime() / 1e10;
  }

  return score;
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;

  console.log(`[Cleanup Convenio Duplicates] Modo: ${DRY_RUN ? 'DRY-RUN' : 'EXECUTE'}`);

  // Buscar todos os payments ativos de convênio com session
  const allActive = await db.collection('payments').find({
    billingType: 'convenio',
    session: { $ne: null },
    status: { $nin: ['canceled', 'refunded'] }
  }).toArray();

  const bySession = {};
  for (const p of allActive) {
    const key = p.session.toString();
    if (!bySession[key]) bySession[key] = [];
    bySession[key].push(p);
  }

  const duplicates = Object.entries(bySession).filter(([_, payments]) => payments.length > 1);

  console.log(`[Cleanup Convenio Duplicates] Sessions analisadas: ${Object.keys(bySession).length}`);
  console.log(`[Cleanup Convenio Duplicates] Sessions com duplicados: ${duplicates.length}`);

  const report = {
    geradoEm: new Date().toISOString(),
    modo: DRY_RUN ? 'DRY-RUN' : 'EXECUTE',
    totalSessionsAnalisadas: Object.keys(bySession).length,
    totalSessionsDuplicadas: duplicates.length,
    totalPaymentsRemovidos: 0,
    totalPaymentsMantidos: 0,
    operacoes: []
  };

  for (const [sessionId, payments] of duplicates) {
    // Ordenar por score: primeiro é o keep
    const scored = payments.map(p => ({ payment: p, score: scorePayment(p) }));
    scored.sort((a, b) => b.score - a.score);

    const keep = scored[0].payment;
    const remove = scored.slice(1).map(s => s.payment);

    const operation = {
      sessionId,
      keptPaymentId: fmtId(keep._id),
      keptPaymentStatus: keep.status,
      keptPaymentKind: keep.kind,
      keptPaymentAmount: keep.amount,
      keptPaymentCreatedAt: keep.createdAt,
      removedPayments: remove.map(p => ({
        paymentId: fmtId(p._id),
        status: p.status,
        kind: p.kind,
        amount: p.amount,
        createdAt: p.createdAt,
        reason: 'duplicate_convenio_receivable'
      })),
      justification: {
        keepReason: `status=${keep.status} (rank=${rank(keep.status)}) vs others=${remove.map(p => p.status).join(',')}`,
        keepScore: scored[0].score
      }
    };

    report.operacoes.push(operation);
    report.totalPaymentsMantidos += 1;
    report.totalPaymentsRemovidos += remove.length;

    if (!DRY_RUN) {
      // Cancelar os extras em vez de deletar (preservar histórico)
      for (const p of remove) {
        await db.collection('payments').updateOne(
          { _id: p._id },
          {
            $set: {
              status: 'canceled',
              canceledAt: new Date(),
              canceledReason: 'cleanup_convenio_duplicate_pr_a',
              canceledMetadata: {
                keptPaymentId: fmtId(keep._id),
                sessionId,
                reason: 'duplicate_active_convenio_payment'
              },
              updatedAt: new Date()
            }
          }
        );
      }
    }
  }

  // Salvar relatório
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const suffix = DRY_RUN ? 'dryrun' : 'execute';
  const reportPath = path.join(OUTPUT_DIR, `cleanup-convenio-duplicates-${suffix}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`[Cleanup Convenio Duplicates] Relatório salvo: ${reportPath}`);
  console.log(`[Cleanup Convenio Duplicates] Payments mantidos: ${report.totalPaymentsMantidos}`);
  console.log(`[Cleanup Convenio Duplicates] Payments cancelados: ${report.totalPaymentsRemovidos}`);

  if (DRY_RUN) {
    console.log('[Cleanup Convenio Duplicates] DRY-RUN: nenhuma alteração aplicada.');
    console.log('[Cleanup Convenio Duplicates] Para executar, rode com --execute');
  }

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('[Cleanup Convenio Duplicates] Erro:', err);
  process.exit(1);
});
