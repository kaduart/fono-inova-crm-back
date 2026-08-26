#!/usr/bin/env node
/**
 * 🔍 AUDITORIA (read-only): Payments de convênio com isFromPackage=true
 *
 * Contexto: `POST /v2/insurance-batches/:id/receive` falha com
 * PACKAGE_PAYMENT_CANNOT_HAVE_FINANCIAL_DATE porque alguns Payments de
 * convênio faturados em NF carregam isFromPackage=true — flag que o model
 * (Payment.js) trata como "nunca entra em caixa". Rastreado até
 * scripts/corrigir-backfill-abril.js (19/04/2026): aplicava isFromPackage=true
 * em TODO consumo de sessão vinculada a Package, sem diferenciar pacote
 * particular pré-pago (correto) de pacote/guia de convênio (incorreto — não
 * existe "recebimento adiantado" em convênio, o dinheiro só entra quando a
 * operadora paga a NF).
 *
 * Este script SÓ audita e classifica. Nenhuma escrita.
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Payment from '../../models/Payment.js';
import Session from '../../models/Session.js';
import Appointment from '../../models/Appointment.js';
import Package from '../../models/Package.js';
import InsuranceBatch from '../../models/InsuranceBatch.js';
import InsuranceGuide from '../../models/InsuranceGuide.js';
import Patient from '../../models/Patient.js';
import PackageCreditTransfer from '../../models/PackageCreditTransfer.js';
import LiminarContract from '../../models/LiminarContract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

async function findBatchForPayment(paymentId) {
  // Um Payment pode aparecer em mais de um InsuranceBatch ao longo do tempo:
  // um lote antigo 'superseded' (sem invoiceNumber, reconciliação legada
  // substituída) e o lote VIGENTE que carrega a NF real. Preferir sempre o
  // vigente (status != 'superseded'); só cair no superseded se não houver outro.
  const all = await InsuranceBatch.find({ 'sessions.payment': paymentId })
    .select('invoiceNumber status receivedAt insuranceProvider origin batchNumber sessions')
    .lean();
  if (all.length === 0) return null;
  const active = all.find(b => b.status !== 'superseded');
  return active || all[0];
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);

  const universe = await Payment.find({ billingType: 'convenio', isFromPackage: true }).lean();
  console.log(`Universo: ${universe.length} Payments (billingType=convenio, isFromPackage=true)`);

  // ─── Prova de exclusão do liminar (modelo 3 — nunca deve ser tocado) ──────
  const liminarSameShape = await Payment.countDocuments({ billingType: 'liminar', isFromPackage: true });
  console.log(`\n[VERIFICAÇÃO LIMINAR] Payments billingType='liminar' + isFromPackage=true: ${liminarSameShape} (FORA do universo desta auditoria, filtro exige billingType='convenio' — liminar não é afetado por construção da query).`);
  // LiminarContract não tem vínculo com Package (é ligado a Patient) — não é
  // um "pacote" no sentido usado aqui. A única forma de um registro deste
  // universo (billingType='convenio') pertencer na verdade ao modelo liminar
  // é o Package subjacente estar rotulado model='liminar' (checado por
  // registro abaixo, via pkg.model). Confirmamos apenas informativamente
  // quantos pacientes do universo têm LiminarContract ativo (não é anomalia
  // por si só — paciente pode ter guia de convênio E liminar em paralelo).
  const patientIdsInUniverse = [...new Set(universe.map(p => p.patient).filter(Boolean).map(String))];
  const liminarContractsForThesePatients = await LiminarContract.find({ patient: { $in: patientIdsInUniverse } }).select('patient status').lean();
  console.log(`[INFO LIMINAR] ${liminarContractsForThesePatients.length} LiminarContract(s) encontrados entre os ${patientIdsInUniverse.length} pacientes do universo (informativo — não implica anomalia; liminar é isolado por pkg.model='liminar' por registro).`);
  const liminarPackageIds = new Set();

  const results = [];

  for (const p of universe) {
    const session = p.session ? await Session.findById(p.session).lean() : null;
    const appointment = p.appointment ? await Appointment.findById(p.appointment).lean() : (session?.appointmentId ? await Appointment.findById(session.appointmentId).lean() : null);
    const guideId = appointment?.insuranceGuide || session?.insuranceGuide || null;
    const guide = guideId ? await InsuranceGuide.findById(guideId).select('number insurance specialty status').lean() : null;
    const batch = await findBatchForPayment(p._id);
    const patient = p.patient ? await Patient.findById(p.patient).select('fullName').lean() : null;

    let aggregatePayment = null;
    let pkg = null;
    let transfersIn = [];
    if (p.package) {
      pkg = await Package.findById(p.package).select('model type paymentType status financialStatus totalValue totalPaid sessionValue fundedByTransfer').lean();
      // Procura um Payment "agregado" (package_receipt) do MESMO pacote que já
      // teria contabilizado esse valor como caixa recebido.
      aggregatePayment = await Payment.findOne({
        package: p.package,
        kind: 'package_receipt'
      }).select('status amount financialDate paidAt kind').lean();
      // Procura transferências de crédito de OUTRO pacote para este — origem de
      // financiamento que não é caixa novo (Package.fundedByTransfer aponta pra isso).
      transfersIn = await PackageCreditTransfer.find({ targetPackageId: p.package })
        .select('sourcePackageId targetPackageId amount createdAt').lean();
    }

    const hasBackfillNote = /CORREÇÃO BACKFILL/.test(p.notes || '');
    const hasFinancialTrace = !!(p.financialDate || p.paidAt || p.insurance?.receivedAt);
    const aggregatePaymentIsRealCash = !!(aggregatePayment && aggregatePayment.status === 'paid' && (aggregatePayment.financialDate || aggregatePayment.paidAt));
    const fundedByTransferReal = !!((pkg?.fundedByTransfer > 0) || transfersIn.length > 0);
    const isLiminarAnomaly = (p.billingType === 'liminar') || (pkg?.model === 'liminar') || (p.package && liminarPackageIds.has(String(p.package)));

    // ─── Classificação ───────────────────────────────────────────────
    // Regra geral (adendo do usuário): NUNCA decidir só por billingType, existência
    // de package, kind ou nota do backfill. A origem financeira real é determinada
    // por: aggregatePayment pago, fundedByTransfer/PackageCreditTransfer, e o
    // modelo de pacote (prepaid particular / per_session particular / convenio
    // legado / liminar) — cada um com regra financeira própria (4 modelos).
    let categoria;
    let motivo;
    let modeloFinanceiro;

    if (isLiminarAnomaly) {
      // Liminar NUNCA pode ser tocado por este reparo (regra 3 do adendo).
      // Se aparecer aqui é uma anomalia de dados que precisa de revisão humana,
      // não uma correção automática.
      categoria = 'AMBIGUO';
      modeloFinanceiro = 'LIMINAR_ANOMALIA';
      motivo = `ANOMALIA: billingType='${p.billingType}' / package.model='${pkg?.model}' indica liminar, mas está no universo billingType=convenio. Liminar NUNCA deve ser alterado por este reparo — precisa revisão manual isolada, fora do escopo de convênio.`;
    } else if (p.status === 'canceled' || p.status === 'cancelled') {
      categoria = 'CANCELADO';
      modeloFinanceiro = 'N/A';
      motivo = 'Payment já cancelado — sem ação, não deve ser reaberto.';
    } else if (hasFinancialTrace) {
      // Já tem algum rastro de caixa registrado — mexer aqui é terreno perigoso,
      // trata como ambíguo por padrão (bloqueia apply) até prova em contrário.
      categoria = 'AMBIGUO';
      modeloFinanceiro = 'INDETERMINADO';
      motivo = `Já possui rastro financeiro (financialDate=${p.financialDate || 'null'}, paidAt=${p.paidAt || 'null'}, insurance.receivedAt=${p.insurance?.receivedAt || 'null'}) — precisa revisão manual antes de qualquer correção.`;
    } else if (aggregatePaymentIsRealCash) {
      // Existe um Payment agregado do MESMO pacote, já pago, com rastro de caixa —
      // isFromPackage está correto aqui: o dinheiro já entrou via esse agregado
      // (modelo 1: particular pré-pago, mesmo que billingType tenha sido rotulado
      // errado como convenio em algum momento da reclassificação histórica).
      categoria = 'AGREGADO_REAL_CONFIRMADO';
      modeloFinanceiro = 'PARTICULAR_PREPAGO_REAL';
      motivo = `Package ${p.package} tem Payment agregado (package_receipt) ${aggregatePayment._id} já pago (financialDate=${aggregatePayment.financialDate}, paidAt=${aggregatePayment.paidAt}) cobrindo este valor — isFromPackage correto, NÃO deve ser alterado.`;
    } else if (fundedByTransferReal) {
      // Financiado via PackageCreditTransfer (crédito movido de outro pacote) —
      // não é caixa novo, mas já é contabilizado alhures; tocar aqui duplicaria
      // ou removeria cobertura já reconhecida. Trata como agregado real.
      categoria = 'AGREGADO_REAL_CONFIRMADO';
      modeloFinanceiro = 'FINANCIADO_POR_TRANSFERENCIA';
      motivo = `Package ${p.package} tem fundedByTransfer=${pkg?.fundedByTransfer || 0} e/ou ${transfersIn.length} PackageCreditTransfer(s) de entrada (${transfersIn.map(t => `${t.sourcePackageId}→${t.amount}`).join(', ') || 'n/a'}) — cobertura já reconhecida via crédito transferido, não é erro de backfill. isFromPackage correto, NÃO deve ser alterado.`;
    } else if (pkg && pkg.model === 'prepaid') {
      // Package real modelo particular pré-pago mas SEM agregado pago encontrado
      // e SEM transferência — contradição (modelo 1 exige agregado). Não assumir,
      // bloquear para revisão manual.
      categoria = 'AMBIGUO';
      modeloFinanceiro = 'CONTRADICAO_PREPAGO_SEM_AGREGADO';
      motivo = `Package ${p.package} é model='prepaid' (particular pré-pago) mas billingType do Payment é 'convenio' e não há Payment agregado pago nem transferência cobrindo o valor — contradição entre modelo do pacote e billingType. Precisa revisão manual.`;
    } else if (pkg && pkg.model === 'per_session') {
      // Modelo 2 (particular pago por sessão): cada sessão é seu próprio Payment.
      // Se este Payment tem billingType=convenio, é sessão faturada por NF que foi
      // incorretamente tratada como consumo de pacote pré-pago pelo backfill —
      // motivo distinto do modelo 'convenio legado', mesma ação (remover isFromPackage).
      categoria = 'ERRO_BACKFILL_CONFIRMADO';
      modeloFinanceiro = 'PARTICULAR_POR_SESSAO_MAL_CLASSIFICADO';
      motivo = `Package ${p.package} é model='per_session' — cada sessão é paga individualmente, não há adiantamento agregado. Este Payment é billingType='convenio' (faturado por NF), então isFromPackage=true está incorreto por natureza do modelo (não por falta de agregado): deve poder receber financialDate na liquidação da NF, igual a qualquer sessão avulsa de convênio.`;
    } else if (pkg && pkg.model === 'convenio' && !aggregatePayment && !fundedByTransferReal) {
      // Pacote-modelo-convênio (legado, pré-InsuranceGuide) SEM nenhum agregado
      // pago e SEM transferência — mesma classe de erro do backfill: não existe
      // dinheiro já contabilizado em outro lugar, isFromPackage está incorreto.
      categoria = 'ERRO_BACKFILL_CONFIRMADO';
      modeloFinanceiro = 'CONVENIO_LEGADO_SEM_AGREGADO';
      motivo = `Package ${p.package} é model='convenio' (legado, rótulo pré-InsuranceGuide) e NÃO há Payment agregado pago nem transferência cobrindo este valor. Sessão de convênio fatura por NF — dinheiro só entra quando a NF é recebida (modelo 4). isFromPackage=true está incorreto.`;
    } else if (!pkg && hasBackfillNote) {
      categoria = 'ERRO_BACKFILL_CONFIRMADO';
      modeloFinanceiro = 'ORFAO_SEM_PACOTE_COM_NOTA_BACKFILL';
      motivo = `Sem Package vinculado (package=null) e carrega a nota do backfill de abril — mesma assinatura de erro confirmado, sessão de convênio deve poder receber financialDate na liquidação da NF.`;
    } else if (!pkg) {
      categoria = 'AMBIGUO';
      modeloFinanceiro = 'ORFAO_SEM_PACOTE_SEM_NOTA';
      motivo = `Sem Package vinculado e sem nota de backfill — órfão inconsistente, precisa revisão manual (ver se há guia/batch para confirmar origem).`;
    } else {
      categoria = 'AMBIGUO';
      modeloFinanceiro = 'INDETERMINADO';
      motivo = `Package ${p.package} model='${pkg?.model}' não se encaixou em nenhuma regra de classificação com confiança suficiente — precisa revisão manual.`;
    }

    results.push({
      paymentId: p._id.toString(),
      patientId: p.patient?.toString() || null,
      patientName: patient?.fullName || null,
      amount: p.amount,
      kind: p.kind,
      status: p.status,
      billingType: p.billingType || null,
      package: p.package?.toString() || null,
      packageModel: pkg?.model || null,
      packagePaymentType: pkg?.paymentType || null,
      packageFundedByTransfer: pkg?.fundedByTransfer || 0,
      transfersInCount: transfersIn.length,
      transfersInTotal: transfersIn.reduce((s, t) => s + (t.amount || 0), 0),
      hasAggregatePayment: !!aggregatePayment,
      aggregatePaymentId: aggregatePayment?._id?.toString() || null,
      aggregatePaymentStatus: aggregatePayment?.status || null,
      aggregatePaymentHasFinancialTrace: aggregatePaymentIsRealCash,
      modeloFinanceiro,
      guideId: guideId?.toString() || null,
      guideNumber: guide?.number || null,
      insuranceProvider: guide?.insurance || null,
      batchId: batch?._id?.toString() || null,
      batchInvoiceNumber: batch?.invoiceNumber || null,
      batchStatus: batch?.status || null,
      batchReceivedAt: batch?.receivedAt || null,
      financialDate: p.financialDate || null,
      paidAt: p.paidAt || null,
      insuranceReceivedAt: p.insurance?.receivedAt || null,
      insuranceStatus: p.insurance?.status || null,
      hasBackfillNote,
      createdAt: p.createdAt,
      categoria,
      motivo,
    });
  }

  // ─── Relatório ───────────────────────────────────────────────────
  const byCategoria = {};
  for (const r of results) {
    if (!byCategoria[r.categoria]) byCategoria[r.categoria] = [];
    byCategoria[r.categoria].push(r);
  }

  console.log('\n=== CONTAGEM POR CATEGORIA ===');
  for (const [cat, items] of Object.entries(byCategoria)) {
    const total = items.reduce((s, i) => s + (i.amount || 0), 0);
    console.log(`${cat}: ${items.length} registros, R$${total}`);
  }

  console.log('\n=== NFs (InsuranceBatch) AFETADAS ===');
  const batchIds = [...new Set(results.map(r => r.batchId).filter(Boolean))];
  for (const bid of batchIds) {
    const itemsInBatch = results.filter(r => r.batchId === bid);
    console.log(`Batch ${bid} (NF ${itemsInBatch[0].batchInvoiceNumber}, status=${itemsInBatch[0].batchStatus}): ${itemsInBatch.length} payments, categorias: ${[...new Set(itemsInBatch.map(i=>i.categoria))].join(', ')}`);
  }

  console.log('\n=== DETALHE COMPLETO (todos os 37) ===');
  results.forEach(r => console.log(JSON.stringify(r, null, 2)));

  fs.writeFileSync(
    path.join(__dirname, 'audit-convenio-isfrompackage-2026-08-26-results.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), total: results.length, byCategoria: Object.fromEntries(Object.entries(byCategoria).map(([k,v])=>[k,v.length])), results }, null, 2)
  );
  console.log('\n📄 Relatório salvo em audit-convenio-isfrompackage-2026-08-26-results.json');

  await mongoose.disconnect();
}
main().catch(err => { console.error('❌ ERRO:', err); process.exit(1); });
