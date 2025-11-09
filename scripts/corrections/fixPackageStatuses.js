import mongoose from 'mongoose';
import Package from '../../models/Package.js';

/**
 * Script para corrigir status dos pacotes
 * Marca como 'finished' os pacotes onde todas as sessões ativas foram concluídas
 */

const fixPackageStatuses = async () => {
    try {
        console.log('🔄 Iniciando correção de status dos pacotes...\n');

        // Conectar ao MongoDB (sem opções depreciadas)
        await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/seu-db');

        console.log('✅ Conectado ao MongoDB\n');

        // Buscar todos os pacotes ativos ou in-progress
        const packages = await Package.find({
            status: { $in: ['active', 'in-progress'] }
        }).populate('sessions');

        console.log(`📦 Encontrados ${packages.length} pacotes para analisar\n`);

        let updatedCount = 0;
        let alreadyCorrect = 0;
        let errors = 0;

        for (const pkg of packages) {
            try {
                // Contar sessões
                const allSessions = pkg.sessions || [];
                const activeSessions = allSessions.filter(s => s.status !== 'canceled');
                const completedSessions = allSessions.filter(s => s.status === 'completed');
                const scheduledSessions = allSessions.filter(s => 
                    s.status === 'scheduled' || s.status === 'pending'
                );

                console.log(`📋 Pacote ${pkg._id}:`);
                console.log(`   Total: ${allSessions.length} | Ativas: ${activeSessions.length} | Concluídas: ${completedSessions.length} | Agendadas: ${scheduledSessions.length} | Canceladas: ${allSessions.length - activeSessions.length}`);

                // Verificar se TODAS as sessões ativas foram concluídas
                const shouldBeFinished = activeSessions.length > 0 && 
                                        completedSessions.length >= activeSessions.length;

                if (shouldBeFinished && pkg.status !== 'finished') {
                    // Atualizar para finished
                    pkg.status = 'finished';
                    await pkg.save();
                    
                    updatedCount++;
                    console.log(`   ✅ ATUALIZADO para 'finished'\n`);
                } else if (shouldBeFinished && pkg.status === 'finished') {
                    alreadyCorrect++;
                    console.log(`   ℹ️  Já está correto (finished)\n`);
                } else {
                    alreadyCorrect++;
                    console.log(`   ℹ️  Status correto (${pkg.status}) - ainda há ${scheduledSessions.length} sessão(ões) pendente(s)\n`);
                }

            } catch (err) {
                errors++;
                console.error(`   ❌ Erro ao processar pacote ${pkg._id}:`, err.message, '\n');
            }
        }

        // Resumo
        console.log('\n' + '='.repeat(60));
        console.log('📊 RESUMO DA EXECUÇÃO');
        console.log('='.repeat(60));
        console.log(`Total analisados:     ${packages.length}`);
        console.log(`✅ Atualizados:        ${updatedCount}`);
        console.log(`ℹ️  Já corretos:        ${alreadyCorrect}`);
        console.log(`❌ Erros:              ${errors}`);
        console.log('='.repeat(60) + '\n');

    } catch (error) {
        console.error('❌ Erro fatal:', error);
    } finally {
        await mongoose.disconnect();
        console.log('👋 Desconectado do MongoDB');
    }
};

// Executar script
fixPackageStatuses()
    .then(() => {
        console.log('\n✅ Script finalizado com sucesso!');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Script falhou:', error);
        process.exit(1);
    });

// Exportar para uso em outros módulos
export default fixPackageStatuses;