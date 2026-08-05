// scripts/rebuild-missing-package-views.js
// ============================================================
// Backfill da PackagesView (CQRS) para Packages que nunca tiveram
// projeção construída — dívida da migração CQRS iniciada em
// ~08/05/2026 sem backfill retroativo do histórico.
//
// buildPackageView é idempotente (FULL REBUILD sempre, upsert por
// packageId) — seguro rodar em lote e re-rodar em caso de falha
// parcial. Não escreve em Package/Session/Appointment/Payment,
// só faz upsert em PackagesView. Desde 2026-08-05 também normaliza
// status legado ('completed'->'finished') e deriva 'type' ausente
// a partir de 'model' (ver PackageProjectionService.js).
//
// Casos sem normalização confiável (status 'closed', ou sem status
// nenhum) são reportados à parte e NUNCA entram no lote automático —
// exigem decisão manual.
//
// Uso: node scripts/rebuild-missing-package-views.js [dry-run] [--limit=N]
// ============================================================

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Package from '../models/Package.js';
import PackagesView from '../models/PackagesView.js';
import { buildPackageView } from '../domains/billing/services/PackageProjectionService.js';

dotenv.config();

const DRY_RUN = process.argv.includes('dry-run');
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : null;

const LEGACY_STATUS_MAP = { completed: 'finished' };
const MODEL_TO_TYPE = { liminar: 'liminar', convenio: 'convenio', prepaid: 'therapy', per_session: 'therapy' };
const VALID_STATUS = new Set(['active', 'finished', 'canceled', 'canceling', 'superseded']);

function previewStatus(status) {
    return LEGACY_STATUS_MAP[status] || status;
}

function previewType(pkg) {
    return pkg.type || MODEL_TO_TYPE[pkg.model] || pkg.type;
}

async function main() {
    console.log(`[Rebuild Missing PackagesView] Iniciando... ${DRY_RUN ? '(DRY-RUN)' : '(EXECUÇÃO REAL)'}`);

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
    if (!mongoUri) throw new Error('MONGO_URI não encontrado no .env');
    await mongoose.connect(mongoUri);
    console.log('Conectado ao MongoDB');

    // 1. Descobrir quais packageIds já têm view
    const existingViewPackageIds = new Set(
        (await PackagesView.find({}).select('packageId').lean()).map(v => v.packageId?.toString())
    );

    // 2. Buscar todos os Packages (+ campo raw 'model', fora do schema Mongoose) e filtrar os sem view
    const allPackages = await Package.find({})
        .select('_id patient status type createdAt sessionsDone totalPaid')
        .populate('patient', 'fullName')
        .lean();

    const rawCollection = mongoose.connection.db.collection('packages');
    const modelById = new Map(
        (await rawCollection.find({}).project({ _id: 1, model: 1 }).toArray())
            .map(d => [d._id.toString(), d.model])
    );

    let missing = allPackages.filter(p => !existingViewPackageIds.has(p._id.toString()));
    missing.forEach(p => { p.model = modelById.get(p._id.toString()); });

    if (LIMIT) missing = missing.slice(0, LIMIT);

    console.log(`\nTotal de Packages: ${allPackages.length}`);
    console.log(`Total de PackagesView existentes: ${existingViewPackageIds.size}`);
    console.log(`Packages sem view: ${missing.length}${LIMIT ? ` (limitado a ${LIMIT})` : ''}`);

    // 3. Separar em 3 grupos: órfãos (patient deletado), revisão manual (status/type
    //    não normalizáveis com confiança), válidos (entram no backfill automático)
    const orphans = missing.filter(p => !p.patient);
    const withPatient = missing.filter(p => p.patient);

    const manualReview = withPatient.filter(p => {
        const st = previewStatus(p.status);
        return !VALID_STATUS.has(st);
    });
    const valid = withPatient.filter(p => {
        const st = previewStatus(p.status);
        return VALID_STATUS.has(st);
    });

    if (orphans.length > 0) {
        console.log(`\n⚠️  ${orphans.length} pacotes com patient inexistente (órfãos) — PULADOS:`);
        for (const o of orphans) console.log(`  - ${o._id} (status=${o.status}, type=${o.type})`);
    }

    if (manualReview.length > 0) {
        console.log(`\n🛑 ${manualReview.length} pacotes com status sem normalização confiável — PRECISAM DECISÃO MANUAL, não entram no backfill automático:`);
        for (const p of manualReview) {
            console.log(`  - ${p._id} paciente=${p.patient.fullName} status=${p.status} sessionsDone=${p.sessionsDone} totalPaid=${p.totalPaid}`);
        }
    }

    console.log(`\n📋 Relatório dos ${valid.length} pacotes válidos (packageId | paciente | status antigo -> gerado | type antigo -> gerado | sessionsDone | totalPaid):`);
    for (const p of valid) {
        const statusGerado = previewStatus(p.status);
        const typeGerado = previewType(p);
        console.log(`  ${p._id} | ${p.patient.fullName} | status: ${p.status} -> ${statusGerado} | type: ${p.type || '(ausente)'} -> ${typeGerado || '⚠️ INDEFINIDO'} | sessionsDone=${p.sessionsDone} | totalPaid=${p.totalPaid}`);
    }

    const semTypeDerivavel = valid.filter(p => !previewType(p));
    if (semTypeDerivavel.length > 0) {
        console.log(`\n🛑 ${semTypeDerivavel.length} pacotes sem type E sem model para derivar — removidos do lote automático:`);
        for (const p of semTypeDerivavel) console.log(`  - ${p._id} paciente=${p.patient.fullName}`);
    }
    const toRun = valid.filter(p => previewType(p));

    console.log(`\n✅ Pacotes que serão reconstruídos nesta execução: ${toRun.length}`);

    if (DRY_RUN) {
        console.log('\n[DRY-RUN] Nada foi reconstruído.');
        await mongoose.disconnect();
        process.exit(0);
    }

    // 4. Rebuild em lote, um por um, com log de sucesso/erro
    console.log('\n🏗️ Reconstruindo views...');
    const results = { success: 0, error: 0, errors: [] };

    for (const p of toRun) {
        try {
            await buildPackageView(p._id, { correlationId: `backfill_${p._id}` });
            results.success++;
        } catch (err) {
            results.error++;
            results.errors.push({ packageId: p._id.toString(), error: err.message });
            console.log(`  ❌ ${p._id}: ${err.message}`);
        }
    }

    console.log(`\n✅ Concluído: ${results.success} sucesso, ${results.error} erro(s) de ${toRun.length}.`);
    if (results.errors.length > 0) {
        console.log('\nErros:');
        for (const e of results.errors) console.log(`  - ${e.packageId}: ${e.error}`);
    }

    await mongoose.disconnect();
    process.exit(0);
}

main().catch(err => {
    console.error('[Rebuild Missing PackagesView] Erro fatal:', err);
    process.exit(1);
});
