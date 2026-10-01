#!/usr/bin/env node
/**
 * 🔑 Garante o índice único parcial de Expense para despesas fixas.
 *
 *   { fixedExpenseId: 1, competenceMonth: 1 }  unique
 *   partialFilterExpression: { fixedExpenseId: { $type: 'objectId' } }
 *
 * Por quê: em produção `autoIndex` é desligado (server.js), então o índice declarado
 * no schema NÃO é criado sozinho. Sem ele, duas gerações concorrentes poderiam criar a
 * mesma fixa duas vezes no mesmo mês (a checagem do serviço cobre o caso sequencial,
 * o índice cobre a corrida).
 *
 * Idempotente: rodar N vezes é seguro.
 *   - índice já existe com a mesma definição  → não faz nada
 *   - índice existe com definição DIFERENTE   → aborta (não derruba nem recria sozinho)
 *   - há duplicatas (fixedExpenseId+mês)      → aborta e lista (criar o índice falharia)
 *
 * Uso:
 *   node scripts/ensureFixedExpenseIndex.js --dry-run   # só diagnostica, não escreve
 *   node scripts/ensureFixedExpenseIndex.js             # cria se faltar
 *
 * Usa MONGO_URI do ambiente (.env).
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const INDEX_NAME = 'fixedExpenseId_1_competenceMonth_1';
const KEY = { fixedExpenseId: 1, competenceMonth: 1 };
const PARTIAL = { fixedExpenseId: { $type: 'objectId' } };
const dryRun = process.argv.includes('--dry-run');

const sameDefinition = (idx) =>
    idx.unique === true &&
    JSON.stringify(idx.key) === JSON.stringify(KEY) &&
    JSON.stringify(idx.partialFilterExpression) === JSON.stringify(PARTIAL);

async function main() {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI não definido');
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    const col = mongoose.connection.db.collection('expenses');
    console.log(`🔌 Conectado a "${mongoose.connection.name}"${dryRun ? ' (DRY-RUN: nada será escrito)' : ''}`);

    // Coleção ainda inexistente (banco novo) → sem índices; createIndex abaixo a cria.
    const indexes = await col.indexes().catch((e) => (e.codeName === 'NamespaceNotFound' ? [] : Promise.reject(e)));
    const existing = indexes.find(i => i.name === INDEX_NAME || JSON.stringify(i.key) === JSON.stringify(KEY));
    if (existing) {
        if (sameDefinition(existing)) {
            console.log(`✅ Índice "${existing.name}" já existe com a definição correta. Nada a fazer.`);
            return;
        }
        throw new Error(
            `Índice "${existing.name}" existe com definição DIFERENTE (${JSON.stringify(existing)}). ` +
            'Resolva manualmente (dropIndex) antes de rodar de novo — este script não derruba índices.'
        );
    }

    // Criar o índice falharia (E11000) se já houver duplicata — melhor diagnosticar antes.
    const dups = await col.aggregate([
        { $match: { fixedExpenseId: { $type: 'objectId' } } },
        { $group: { _id: { f: '$fixedExpenseId', m: '$competenceMonth' }, n: { $sum: 1 }, ids: { $push: '$_id' } } },
        { $match: { n: { $gt: 1 } } }
    ]).toArray();
    if (dups.length > 0) {
        console.error(`❌ ${dups.length} grupo(s) duplicado(s) (fixedExpenseId + competenceMonth). Corrija antes de criar o índice:`);
        dups.forEach(d => console.error(`   modelo ${d._id.f} / ${d._id.m}: ${d.ids.join(', ')}`));
        process.exitCode = 1;
        return;
    }

    if (dryRun) {
        console.log(`ℹ️  [dry-run] O índice "${INDEX_NAME}" NÃO existe e não há duplicatas — seria criado.`);
        return;
    }

    await col.createIndex(KEY, { name: INDEX_NAME, unique: true, partialFilterExpression: PARTIAL });
    console.log(`✅ Índice "${INDEX_NAME}" criado.`);
}

main()
    .catch((err) => {
        console.error('❌ Falha:', err.message);
        process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
