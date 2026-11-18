#!/usr/bin/env node
/**
 * Preflight e índices da idempotência de pagamentos (payment_operations).
 *
 * A garantia de idempotência NÃO depende deste script: ela usa o _id de
 * payment_operations, que o MongoDB indexa como único em qualquer coleção.
 * Este script serve para a implantação futura:
 *   1. Relatório SÓ DE LEITURA de dados existentes que os bugs antigos podem
 *      ter produzido (duplicatas e sinais trocados). Nada é corrigido aqui:
 *      cada caso precisa de decisão humana.
 *   2. Com --apply: cria a coleção e os índices secundários (consulta por
 *      paciente e por efeitos pendentes), já que autoIndex é desligado em
 *      produção (server.js).
 *
 * Uso (o URI é explícito de propósito; não lê .env):
 *   MIGRATION_MONGO_URI='mongodb://127.0.0.1:27017/crm_teste?directConnection=true' \
 *     node scripts/migrations/2026-11-18-payment-operations-preflight.js [--apply] [--json]
 *
 * Saída: só ids, contagens, valores e datas. Nenhum nome ou dado clínico.
 */

import mongoose from 'mongoose';

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const AS_JSON = ARGS.includes('--json');
const WINDOW_MS = 10 * 60 * 1000;

const INDEXES = [
    { key: { patient: 1, appliedAt: -1 }, name: 'patient_1_appliedAt_-1' },
    { key: { sideEffectsAt: 1, appliedAt: 1 }, name: 'side_effects_pending' }
];

function clusters(rows, keyOf, timeOf) {
    const byKey = new Map();
    for (const r of rows) {
        const k = keyOf(r);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(r);
    }
    const out = [];
    for (const [k, list] of byKey) {
        list.sort((a, b) => timeOf(a) - timeOf(b));
        let group = [list[0]];
        for (let i = 1; i < list.length; i++) {
            if (timeOf(list[i]) - timeOf(group[group.length - 1]) <= WINDOW_MS) group.push(list[i]);
            else { if (group.length > 1) out.push({ key: k, items: group }); group = [list[i]]; }
        }
        if (group.length > 1) out.push({ key: k, items: group });
    }
    return out;
}

export async function buildReport(db) {
    const payments = db.collection('payments');
    const balances = db.collection('patientbalances');

    // A) Pagamentos avulsos (standalone) repetidos: mesmo paciente e valor em 10 min.
    const standalone = await payments.find(
        { source: 'manual', status: 'paid', appointment: null, description: { $not: /^Pagamento múltiplo/ } },
        { projection: { patient: 1, amount: 1, createdAt: 1, paymentDate: 1, operationKey: 1 } }
    ).toArray();
    const standaloneDup = clusters(
        standalone.filter(p => !p.operationKey),
        p => `${p.patient}|${p.amount}`,
        p => new Date(p.createdAt || p.paymentDate).getTime()
    );

    // B) Créditos repetidos no saldo (standalone/balance_credit legados).
    // C) balance_credit legado: somava ao saldo devedor (sinal trocado, B-1).
    // D) Débitos com mais de um pagamento múltiplo apontando para eles.
    const creditDup = [];
    const legacyBalanceCredit = [];
    let balancesScanned = 0;
    for await (const b of balances.find({}, { projection: { patient: 1, transactions: 1, currentBalance: 1 } })) {
        balancesScanned++;
        const tx = b.transactions || [];
        const credits = tx.filter(t => t.type === 'credit' && !t.operationKey && !t.isDeleted);
        for (const c of clusters(credits, t => `${t.amount}|${t.description}`, t => new Date(t.transactionDate || t.createdAt || 0).getTime())) {
            creditDup.push({ balanceId: String(b._id), patient: String(b.patient), amount: c.items[0].amount, count: c.items.length, txIds: c.items.map(t => String(t._id)) });
        }
        for (const t of tx) {
            if (t.type === 'credit' && !t.operationKey && t.description === 'Crédito em conta' && t.paymentMethod) {
                legacyBalanceCredit.push({ balanceId: String(b._id), patient: String(b.patient), txId: String(t._id), amount: t.amount });
            }
        }
    }

    const multiPayments = await payments.countDocuments({ description: /^Pagamento múltiplo/ });

    return {
        generatedAt: new Date().toISOString(),
        windowMinutes: WINDOW_MS / 60000,
        standaloneDuplicateGroups: standaloneDup.map(g => ({
            patient: g.key.split('|')[0], amount: Number(g.key.split('|')[1]),
            count: g.items.length, paymentIds: g.items.map(p => String(p._id))
        })),
        balanceCreditDuplicateGroups: creditDup,
        legacyBalanceCreditSignSuspects: legacyBalanceCredit,
        multiPaymentPaymentsFound: multiPayments,
        balancesScanned
    };
}

export async function ensureIndexes(db) {
    const exists = (await db.listCollections({ name: 'payment_operations' }).toArray()).length > 0;
    if (!exists) await db.createCollection('payment_operations');
    const coll = db.collection('payment_operations');
    for (const ix of INDEXES) await coll.createIndex(ix.key, { name: ix.name });
    const names = (await coll.listIndexes().toArray()).map(i => i.name);
    const missing = INDEXES.map(i => i.name).filter(n => !names.includes(n));
    if (missing.length) throw new Error(`Índices ausentes após criação: ${missing.join(', ')}`);
    return names;
}

async function main() {
    const uri = process.env.MIGRATION_MONGO_URI;
    if (!uri) {
        console.error('Defina MIGRATION_MONGO_URI (o script não lê .env de propósito).');
        process.exit(2);
    }
    await mongoose.connect(uri);
    const db = mongoose.connection.db;
    try {
        const report = await buildReport(db);
        if (AS_JSON) console.log(JSON.stringify(report, null, 2));
        else {
            console.log(`Banco: ${db.databaseName}`);
            console.log(`Saldos lidos: ${report.balancesScanned}`);
            console.log(`A) Grupos de pagamento avulso repetido (10 min): ${report.standaloneDuplicateGroups.length}`);
            console.log(`B) Grupos de crédito repetido no saldo (10 min): ${report.balanceCreditDuplicateGroups.length}`);
            console.log(`C) Créditos em conta legados com sinal suspeito: ${report.legacyBalanceCreditSignSuspects.length}`);
            console.log(`D) Payments de pagamento múltiplo existentes: ${report.multiPaymentPaymentsFound}`);
            console.log('Use --json para os ids. Nada foi alterado.');
        }
        if (APPLY) {
            const names = await ensureIndexes(db);
            console.log(`--apply: payment_operations com índices ${names.join(', ')}`);
        }
    } finally {
        await mongoose.disconnect();
    }
}

if (process.argv[1] && process.argv[1].endsWith('2026-11-18-payment-operations-preflight.js')) {
    main().catch((err) => { console.error(err); process.exit(1); });
}
