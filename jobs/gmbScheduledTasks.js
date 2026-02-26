// jobs/gmbScheduledTasks.js
import cron from 'node-cron';
import * as gmbService from '../services/gmbService.js';
import * as makeService from '../services/makeService.js';
import GmbPost from '../models/GmbPost.js';

/**
 * 🕐 Agenda tarefas do GMB no servidor principal
 * Geração diária + envio automático via Make
 */
export const scheduleGmbCron = () => {
    // Gerar post do dia — todo dia 8h da manhã
    cron.schedule('0 8 * * *', async () => {
        try {
            console.log('🚀 [GMB] Gerando post do dia...');

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const tomorrow = new Date(today);
            tomorrow.setDate(tomorrow.getDate() + 1);

            const existing = await GmbPost.countDocuments({
                createdAt: { $gte: today, $lt: tomorrow },
                status: { $in: ['ready', 'scheduled', 'published'] }
            });

            if (existing > 0) {
                console.log('ℹ️ [GMB] Post do dia já existe');
                return;
            }

            const result = await gmbService.createDailyPost({ generateImage: true });

            if (result.success) {
                console.log(`✅ [GMB] Post gerado: ${result.especialidade.nome}`);
            }
        } catch (error) {
            console.error('❌ [GMB] Erro ao gerar post:', error.message);
        }
    }, { scheduled: true, timezone: 'America/Sao_Paulo' });

    // Enviar posts agendados ao Make — várias vezes ao dia
    cron.schedule('5 8,12,15,19 * * *', async () => {
        try {
            if (!makeService.isMakeConfigured()) return;

            console.log('🔗 [GMB] Enviando posts agendados ao Make...');

            const posts = await GmbPost.findScheduledForPublish(5);
            if (posts.length === 0) return;

            for (const post of posts) {
                try {
                    await makeService.sendPostToMake(post);
                    post.status = 'published';
                    post.publishedAt = new Date();
                    post.publishedBy = 'cron';
                    await post.save();
                    console.log(`✅ [GMB] Enviado ao Make: ${post.title?.substring(0, 40)}`);
                } catch (err) {
                    await post.markFailed(err.message);
                    console.error(`❌ [GMB] Falha Make: ${err.message}`);
                }
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (error) {
            console.error('❌ [GMB] Erro ao enviar ao Make:', error.message);
        }
    }, { scheduled: true, timezone: 'America/Sao_Paulo' });

    console.log('✅ Cron do GMB agendado: gerar 8h + enviar Make 8h05/12h05/15h05/19h05');
};
