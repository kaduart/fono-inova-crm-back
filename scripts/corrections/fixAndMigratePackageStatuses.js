// scripts/corrections/fixAndMigratePackageStatuses.js
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

// ==========================
// __dirname para ES Modules
// ==========================
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ==========================
// Env
// ==========================
dotenv.config({ path: join(__dirname, '../../.env') });

// ==========================
// Models
// (ajuste os caminhos se seus models estiverem em outro local)
// ==========================
const Package = (await import('../../models/Package.js')).default;
const Session = (await import('../../models/Session.js')).default;

// ==========================
// Helpers
// ==========================
function maskMongoUri(uri) {
    if (!uri) return '';
    return uri.replace(/\/\/.*@/, '//***:***@');
}

/**
 * Define o novo status do pacote com base nas sessões.
 * Regra:
 *  - 'finished'  => todas as sessões não-canceladas estão concluídas E não há agendadas/pending
 *  - 'active'    => caso contrário (não fazemos auto-'canceled' aqui)
 */
function computeNewStatusFromStats(stats) {
    const {
        total,
        activeCount,      // não-canceladas
        completedCount,   // status === 'completed'
        scheduledCount,   // status === 'scheduled' | 'pending'
        canceledCount     // status === 'canceled'
    } = stats;

    // terminou tudo que não está cancelado e não há nada pendente/agendado
    if (activeCount > 0 && completedCount >= activeCount && scheduledCount === 0) {
        return 'finished';
    }
    return 'active';
}

/**
 * Coleta estatísticas das sessões de um pacote (a partir de pkg.sessions já populado)
 */
function buildSessionStats(pkg) {
    const all = Array.isArray(pkg.sessions) ? pkg.sessions : [];

    const completed = all.filter(s => s?.status === 'completed').length;
    const scheduled = all.filter(s => s?.status === 'scheduled' || s?.status === 'pending').length;
    const canceled = all.filter(s => s?.status === 'canceled').length;
    const active = all.length - canceled; // não-canceladas

    return {
        total: all.length,
        activeCount: active,
        completedCount: completed,
        scheduledCount: scheduled,
        canceledCount: canceled,
    };
}

/**
 * Imprime estatísticas formatadas do pacote
 */
function logPackageStats(pkgId, stats) {
    const { total, activeCount, completedCount, scheduledCount, canceledCount } = stats;
    console.log(`📋 Pacote ${pkgId}:`);
    console.log(`   Total: ${total} | Ativas: ${activeCount} | Concluídas: ${completedCount} | Agendadas: ${scheduledCount} | Canceladas: ${canceledCount}`);
}

// ==========================
// Main
// ==========================
const fixAndMigratePackageStatuses = async () => {
    try {
        console.log('🔄 Iniciando correção e migração de status dos pacotes...\n');

        const mongoUri = process.env.MONGODB_URI || process.env.MONGO_URI;
        const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1';

        if (!mongoUri) {
            console.error('❌ ERRO: Variável MONGODB_URI (ou MONGO_URI) não encontrada no .env');
            console.log('\n💡 Ex.:');
            console.log('   MONGODB_URI=mongodb://localhost:27017/seu-database');
            console.log('   # ou');
            console.log('   MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/database\n');
            process.exit(1);
        }

        console.log('📡 Conectando ao MongoDB...');
        console.log(`   URI: ${maskMongoUri(mongoUri)}\n`);
        await mongoose.connect(mongoUri);
        console.log('✅ Conectado ao MongoDB\n');

        // ==========================
        // FASE 1: completed -> finished
        // ==========================
        console.log('📝 FASE 1: Migrando status "completed" para "finished"...\n');

        const completedPackages = await Package.find({ status: 'completed' }).select('_id');
        if (completedPackages.length > 0) {
            if (DRY_RUN) {
                console.log(`🧪 DRY-RUN: migraria ${completedPackages.length} pacote(s) de "completed" -> "finished".`);
            } else {
                await Package.updateMany(
                    { status: 'completed' },
                    { $set: { status: 'finished' } },
                    { runValidators: false }
                );
                console.log(`✅ ${completedPackages.length} pacote(s) migrado(s) de "completed" para "finished"\n`);
            }
        } else {
            console.log('ℹ️  Nenhum pacote com status "completed" encontrado\n');
        }

        // ==========================
        // FASE 2: Corrigir pacotes ativos / in-progress
        // ==========================
        console.log('📝 FASE 2: Corrigindo status dos pacotes ativos...\n');

        // buscamos pacotes que potencialmente precisam de ajuste
        const candidates = await Package.find({
            status: { $in: ['active', 'in-progress', 'finished'] } // incluí 'finished' para confirmar consistência (sem rebaixar)
        }).populate('sessions');

        console.log(`📦 Encontrados ${candidates.length} pacotes para analisar\n`);

        let updatedCount = 0;
        let alreadyCorrect = 0;
        let errors = 0;

        for (const pkg of candidates) {
            try {
                const stats = buildSessionStats(pkg);
                logPackageStats(pkg._id, stats);

                const newStatus = computeNewStatusFromStats(stats);

                // Não "rebaixa" finished para active
                if (pkg.status === 'finished') {
                    if (newStatus === 'finished') {
                        console.log(`   ℹ️  Já está correto (finished)\n`);
                        alreadyCorrect++;
                    } else {
                        // apenas logamos inconsistência (se quiser, mude a regra)
                        console.log(`   ⚠️  Inconsistência detectada (mantido 'finished'): cálculo indicou '${newStatus}'\n`);
                        alreadyCorrect++;
                    }
                    continue;
                }

                // Se já está correto, só loga
                if (pkg.status === newStatus) {
                    console.log(`   ℹ️  Status correto (${pkg.status})${newStatus === 'active' ? ` - ainda há ${stats.scheduledCount} sessão(ões) pendente(s)` : ''}\n`);
                    alreadyCorrect++;
                    continue;
                }

                // Atualizar: apenas active/in-progress -> finished (ou manter active se regra devolver 'active')
                if (!DRY_RUN) {
                    await Package.updateOne(
                        { _id: pkg._id },
                        { $set: { status: newStatus } },
                        { runValidators: false }
                    );
                }

                console.log(`   ✅ Status atualizado: ${pkg.status} → ${newStatus}${DRY_RUN ? ' (DRY-RUN)' : ''}\n`);
                updatedCount++;

            } catch (err) {
                errors++;
                console.error(`   ❌ Erro ao processar pacote ${pkg._id}:`, err?.message ?? err, '\n');
            }
        }

        // ==========================
        // RESUMO FINAL
        // ==========================
        console.log('\n' + '='.repeat(60));
        console.log('📊 RESUMO DA EXECUÇÃO');
        console.log('='.repeat(60));
        console.log(`Migrados (completed→finished): ${completedPackages.length}`);
        console.log(`Total analisados:              ${candidates.length}`);
        console.log(`✅ Atualizados:                 ${updatedCount}${DRY_RUN ? ' (DRY-RUN)' : ''}`);
        console.log(`ℹ️  Já corretos:                 ${alreadyCorrect}`);
        console.log(`❌ Erros:                       ${errors}`);
        console.log('='.repeat(60) + '\n');

        // ==========================
        // Verificação final
        // ==========================
        console.log('🔍 Verificação final dos status...\n');
        const statusCounts = await Package.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]);

        console.log('📊 Distribuição de status:');
        statusCounts.forEach(({ _id, count }) => {
            console.log(`   ${_id}: ${count} pacote(s)`);
        });
        console.log();

    } catch (error) {
        console.error('❌ Erro fatal:', error);
    } finally {
        await mongoose.disconnect();
        console.log('👋 Desconectado do MongoDB');
    }
};

// ==========================
// Run
// ==========================
fixAndMigratePackageStatuses()
    .then(() => {
        console.log('\n✅ Script finalizado com sucesso!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Script falhou:', error);
        process.exit(1);
    });

export default fixAndMigratePackageStatuses;
