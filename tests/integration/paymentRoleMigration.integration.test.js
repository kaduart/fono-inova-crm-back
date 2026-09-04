/**
 * 🔧 Migração Payment.paymentRole — execução real contra banco descartável
 *
 * Roda o script de verdade (scripts/migrations/2026-09-04-payment-role-deposit-balance.js)
 * como SUBPROCESSO (node <script> [flags]) contra um mongod real e descartável
 * (MongoMemoryServer — binário mongod real gerenciado pelo pacote, não mock),
 * exatamente como um operador rodaria em produção. Isola a conexão do teste
 * (MongoClient bruto) da conexão do script (a dele própria, via MONGO_URI).
 *
 * Cobre: legado sem paymentRole, duplicidade pré-existente (aborta antes de
 * tocar índice), dry-run sem mutação, execução, execução repetida idempotente,
 * índice efetivamente criado (listIndexes), rollback.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId } from 'mongodb';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACK_DIR = path.join(__dirname, '..', '..');
const SCRIPT_PATH = path.join(BACK_DIR, 'scripts', 'migrations', '2026-09-04-payment-role-deposit-balance.js');

let mongoServer;
let client;
let db;

const OLD_INDEX_NAME = 'unique_active_payment_per_appt_billingtype';
const NEW_INDEX_NAME = 'unique_active_payment_per_appt_billingtype_role';

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const uri = mongoServer.getUri();
    // 🛡️ Nunca rodar isto contra outra coisa que não seja o mongod descartável
    // que acabamos de criar — assert explícito antes de qualquer spawn.
    if (!uri.includes('127.0.0.1') && !uri.includes('localhost')) {
        throw new Error(`URI inesperada para o mongod descartável: ${uri}`);
    }
    client = new MongoClient(uri);
    await client.connect();
    db = client.db('migration_test');
}, 60000);

afterAll(async () => {
    await client.close();
    await mongoServer.stop();
});

beforeEach(async () => {
    await db.collection('payments').deleteMany({});
});

function runScript(args, uri) {
    try {
        const stdout = execFileSync('node', [SCRIPT_PATH, ...args], {
            cwd: BACK_DIR,
            env: { ...process.env, MONGO_URI: uri },
            encoding: 'utf8',
            timeout: 30000,
        });
        return { stdout, exitCode: 0 };
    } catch (err) {
        // execFileSync joga em exit != 0 — captura stdout/stderr/status mesmo assim
        return { stdout: err.stdout || '', stderr: err.stderr || '', exitCode: err.status ?? 1, error: err };
    }
}

async function uriForDb() {
    // O client de teste conecta em 'migration_test' explicitamente; o script
    // conecta usando o banco default da URI — usamos a mesma URI+dbName pra
    // garantir que os dois falem com o MESMO banco.
    return `${mongoServer.getUri()}migration_test`;
}

async function listIndexNames() {
    const indexes = await db.collection('payments').listIndexes().toArray();
    return indexes.map((ix) => ix.name);
}

function fakePaymentDoc(overrides = {}) {
    return {
        patient: new ObjectId(),
        appointment: new ObjectId(),
        billingType: 'particular',
        amount: 100,
        paymentDate: new Date(),
        paymentMethod: 'pix',
        status: 'paid',
        kind: 'session_payment',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
    };
}

describe('Migração Payment.paymentRole — execução real', () => {
    it('legado sem paymentRole: dry-run NÃO muta nada (nenhum documento, nenhum índice)', async () => {
        const uri = await uriForDb();
        const legacy = fakePaymentDoc();
        await db.collection('payments').insertOne(legacy);

        const before = await db.collection('payments').findOne({ _id: legacy._id });
        expect(before.paymentRole).toBeUndefined();

        const { stdout, exitCode } = runScript([], uri); // sem --execute = dry-run
        expect(exitCode).toBe(0);
        expect(stdout).toMatch(/DRY-RUN/);

        const after = await db.collection('payments').findOne({ _id: legacy._id });
        expect(after.paymentRole).toBeUndefined(); // continua sem — dry-run não escreveu nada

        const indexNames = await listIndexNames();
        expect(indexNames).not.toContain(NEW_INDEX_NAME);
    });

    it('duplicidade pré-existente: --execute detecta e ABORTA antes de tocar em qualquer índice', async () => {
        const uri = await uriForDb();
        const apptId = new ObjectId();
        // Dois Payments ATIVOS pro mesmo appointment+billingType+role implícito
        // (ambos sem paymentRole → viram 'standard' no backfill → colidiriam).
        await db.collection('payments').insertMany([
            fakePaymentDoc({ appointment: apptId, status: 'paid' }),
            fakePaymentDoc({ appointment: apptId, status: 'pending' }),
        ]);

        const { stdout, stderr, exitCode } = runScript(['--execute'], uri);
        expect(exitCode).not.toBe(0);
        // Mensagem de conflito vai pro stderr (console.error), mesmo padrão do
        // script de referência (2026-08-26-financial-ledger-reversal-index.js).
        expect(stderr).toMatch(/CONFLITOS ENCONTRADOS/);
        expect(stderr).toMatch(/ABORTADO/);

        const indexNames = await listIndexNames();
        expect(indexNames).not.toContain(NEW_INDEX_NAME);
        // Backfill (não-destrutivo, sem constraint pra violar nesse momento) já
        // rodou antes da checagem de duplicidade — é o que permite o relatório
        // de conflito listar os dois Payments do MESMO grupo (mesmo paymentRole
        // resultante). O que a migração garante é não criar o índice inválido.
        const docs = await db.collection('payments').find({ appointment: apptId }).toArray();
        expect(docs.every((d) => d.paymentRole === 'standard')).toBe(true);
        expect(stdout).toMatch(/Backfill aplicado: 2/);
    });

    it('execução real: backfill aplica paymentRole=standard, índice novo criado, índice antigo removido', async () => {
        const uri = await uriForDb();
        const legacy1 = fakePaymentDoc();
        const legacy2 = fakePaymentDoc({ billingType: 'convenio', status: 'billed' });
        await db.collection('payments').insertMany([legacy1, legacy2]);
        // Cria o índice antigo manualmente pra provar que a migração o remove de verdade
        await db.collection('payments').createIndex(
            { appointment: 1, billingType: 1 },
            { name: OLD_INDEX_NAME, unique: true, partialFilterExpression: { appointment: { $type: 'objectId' }, status: { $in: ['paid'] } } }
        );

        const { stdout, exitCode } = runScript(['--execute'], uri);
        expect(exitCode).toBe(0);
        expect(stdout).toMatch(/Backfill aplicado/);
        expect(stdout).toMatch(/Índice novo criado e confirmado/);

        const doc1 = await db.collection('payments').findOne({ _id: legacy1._id });
        const doc2 = await db.collection('payments').findOne({ _id: legacy2._id });
        expect(doc1.paymentRole).toBe('standard');
        expect(doc2.paymentRole).toBe('standard');

        const indexNames = await listIndexNames();
        expect(indexNames).toContain(NEW_INDEX_NAME);
        expect(indexNames).not.toContain(OLD_INDEX_NAME);

        const newIndex = (await db.collection('payments').listIndexes().toArray()).find((ix) => ix.name === NEW_INDEX_NAME);
        expect(newIndex.unique).toBe(true);
        expect(newIndex.key).toEqual({ appointment: 1, billingType: 1, paymentRole: 1 });
    });

    it('execução repetida (idempotente): rodar --execute de novo não falha e não duplica nada', async () => {
        const uri = await uriForDb();
        const legacy = fakePaymentDoc();
        await db.collection('payments').insertOne(legacy);

        const first = runScript(['--execute'], uri);
        expect(first.exitCode).toBe(0);

        const second = runScript(['--execute'], uri);
        expect(second.exitCode).toBe(0);
        expect(second.stdout).toMatch(/já existe — pulando criação/);

        const indexNames = await listIndexNames();
        const occurrences = indexNames.filter((n) => n === NEW_INDEX_NAME).length;
        expect(occurrences).toBe(1); // não duplicou o índice

        const doc = await db.collection('payments').findOne({ _id: legacy._id });
        expect(doc.paymentRole).toBe('standard');
    });

    it('rollback: recria o índice antigo e remove o novo', async () => {
        const uri = await uriForDb();
        await db.collection('payments').insertOne(fakePaymentDoc());

        const applied = runScript(['--execute'], uri);
        expect(applied.exitCode).toBe(0);
        expect(await listIndexNames()).toContain(NEW_INDEX_NAME);

        const rolledBack = runScript(['--rollback'], uri);
        expect(rolledBack.exitCode).toBe(0);
        expect(rolledBack.stdout).toMatch(/ROLLBACK/);

        const indexNames = await listIndexNames();
        expect(indexNames).toContain(OLD_INDEX_NAME);
        expect(indexNames).not.toContain(NEW_INDEX_NAME);
    });
}, 60000);
