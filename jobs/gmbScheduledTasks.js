// jobs/gmbScheduledTasks.js
import cron from 'node-cron';
import * as gmbService from '../services/gmbService.js';
import GmbPost from '../models/GmbPost.js';

/**
 * 🕐 Agenda a publicação automática de posts do GMB
 * Executa a cada 5 minutos para verificar posts agendados
 */
export const scheduleGmbCron = () => {
    // Publicar posts agendados - a cada 5 minutos
    cron.schedule('*/5 * * * *', async () => {
        try {
            const results = await gmbService.publishScheduledPosts(3);
            
            if (results.published > 0) {
                console.log(`✅ [GMB] ${results.published} post(s) publicado(s)`);
            }
            if (results.failed > 0) {
                console.warn(`⚠️ [GMB] ${results.failed} post(s) falharam`);
            }
        } catch (error) {
            console.error('❌ [GMB] Erro ao publicar agendados:', error.message);
        }
    }, {
        scheduled: true,
        timezone: 'America/Sao_Paulo'
    });

    // Gerar post do dia automaticamente - todo dia 8h da manhã
    cron.schedule('0 8 * * *', async () => {
        try {
            console.log('🚀 [GMB] Gerando post do dia...');
            
            const result = await gmbService.createDailyPost({
                generateImage: true,
                publishImmediately: false
            });
            
            if (result.success) {
                console.log(`✅ [GMB] Post gerado: ${result.especialidade.nome}`);
            }
        } catch (error) {
            console.error('❌ [GMB] Erro ao gerar post diário:', error.message);
        }
    }, {
        scheduled: true,
        timezone: 'America/Sao_Paulo'
    });

    console.log('✅ Cron jobs do GMB agendados:');
    console.log('   • Publicar agendados: a cada 5 minutos');
    console.log('   • Gerar post diário: todo dia 8h');
};

/**
 * 🔄 Publica manualmente posts agendados (para o botão no dashboard)
 */
export const manualPublishTrigger = async (req, res) => {
    try {
        const results = await gmbService.publishScheduledPosts(5);
        
        res.json({
            success: true,
            message: `${results.published} posts publicados, ${results.failed} falhas`,
            data: results
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Erro ao publicar posts',
            error: error.message
        });
    }
};
