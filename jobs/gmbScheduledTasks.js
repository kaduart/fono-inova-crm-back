// jobs/gmbScheduledTasks.js
import cron from 'node-cron';
import * as gmbService from '../services/gmbService.js';
import * as makeService from '../services/makeService.js';
import GmbPost from '../models/GmbPost.js';
import { gmbPublishRetryQueue } from '../config/bullConfigGmbRetry.js';

/**
 * 🕐 Agenda tarefas do GMB no servidor principal
 * Geração automática em múltiplos horários + envio via Make
 * 
 * Horários de criação de posts:
 * - 07:30 - Post das 8h (top of funnel - awareness)
 * - 11:30 - Post das 12h (middle - consideração)  
 * - 14:30 - Post das 15h (middle - educação)
 * - 18:30 - Post das 19h (bottom - conversão)
 * 
 * Envios ao Make: logo após cada criação + checks periódicos
 */

// Helper: verifica se já existe post próximo deste horário
async function jaExistePostHoje(horarioStr) {
    const [hora] = horarioStr.split(':').map(Number);
    const hoje = new Date();
    hoje.setHours(0, 0, 0, 0);
    const amanha = new Date(hoje);
    amanha.setDate(amanha.getDate() + 1);
    
    // Busca posts criados hoje com scheduledAt próximo deste horário (±1h)
    const posts = await GmbPost.find({
        createdAt: { $gte: hoje, $lt: amanha },
        status: { $in: ['ready', 'scheduled', 'published', 'processing'] }
    }).select('scheduledAt');
    
    return posts.some(post => {
        if (!post.scheduledAt) return false;
        const postHora = new Date(post.scheduledAt).getHours();
        return Math.abs(postHora - hora) <= 1; // Dentro de 1h
    });
}

// Helper: cria post para um horário específico
async function criarPostParaHorario(horario, funil) {
    try {
        if (await jaExistePostHoje(horario)) {
            console.log(`ℹ️ [GMB] Já existe post para ${horario}, pulando`);
            return null;
        }
        
        const [hora, minuto] = horario.split(':').map(Number);
        const scheduledAt = new Date();
        scheduledAt.setHours(hora, minuto, 0, 0);
        
        // Se horário já passou, agenda para amanhã
        if (scheduledAt < new Date()) {
            scheduledAt.setDate(scheduledAt.getDate() + 1);
        }
        
        console.log(`🚀 [GMB] Criando post ${horario} (funil: ${funil})...`);
        
        const result = await gmbService.createDailyPost({ 
            generateImage: true,
            scheduledAt,
            funnelStage: funil
        });
        
        if (result.success) {
            console.log(`✅ [GMB] Post ${horario} criado: ${result.especialidade.nome}`);
            return result.post;
        }
    } catch (error) {
        console.error(`❌ [GMB] Erro ao criar post ${horario}:`, error.message);
    }
    return null;
}

export const scheduleGmbCron = () => {
    // ═══════════════════════════════════════════════════════════════
    // CRIAÇÃO DE POSTS PARA TODAS AS ESPECIALIDADES (uma vez por dia)
    // ═══════════════════════════════════════════════════════════════
    
    // 06:00 → Cria posts para todas as especialidades que faltam
    cron.schedule('0 6 * * *', async () => {
        try {
            console.log('🚀 [GMB] Verificando especialidades sem post...');
            await gmbService.createPostsForAllEspecialidades();
        } catch (error) {
            console.error('❌ [GMB] Erro ao criar posts para especialidades:', error.message);
        }
    }, { scheduled: true, timezone: 'America/Sao_Paulo' });
    
    // ═══════════════════════════════════════════════════════════════
    // CRIAÇÃO DE POSTS EM HORÁRIOS ESTRATÉGICOS (backup/extras)
    // ═══════════════════════════════════════════════════════════════
    
    // 07:30 → Post extra das 8h (TOP - Awareness)
    cron.schedule('30 7 * * *', async () => {
        await criarPostParaHorario('08:00', 'top');
    }, { scheduled: true, timezone: 'America/Sao_Paulo' });
    
    // 11:30 → Post extra das 12h (MIDDLE - Consideração)
    cron.schedule('30 11 * * *', async () => {
        await criarPostParaHorario('12:00', 'middle');
    }, { scheduled: true, timezone: 'America/Sao_Paulo' });
    
    // 14:30 → Post extra das 15h (MIDDLE - Educação)
    cron.schedule('30 14 * * *', async () => {
        await criarPostParaHorario('15:00', 'middle');
    }, { scheduled: true, timezone: 'America/Sao_Paulo' });
    
    // 18:30 → Post extra das 19h (BOTTOM - Conversão)
    cron.schedule('30 18 * * *', async () => {
        await criarPostParaHorario('19:00', 'bottom');
    }, { scheduled: true, timezone: 'America/Sao_Paulo' });

    // ═══════════════════════════════════════════════════════════════
    // ENVIO AO MAKE - Checks frequentes para publicação imediata
    // ═══════════════════════════════════════════════════════════════
    
    // Enviar posts agendados ao Make — a cada 30 min durante horário comercial
    cron.schedule('*/30 8-22 * * *', async () => {
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
                    const isQueueFull = err.message?.toLowerCase().includes('queue') && err.message?.toLowerCase().includes('full');
                    
                    if (isQueueFull) {
                        // 🔄 Fila cheia - adiciona à fila de retry local
                        console.log(`🔄 [GMB] Fila Make cheia, adicionando à retry queue: ${post.title?.substring(0, 40)}`);
                        await gmbPublishRetryQueue.add('publish', {
                            postId: post._id.toString(),
                            channel: 'gmb'
                        }, {
                            delay: 60000 * (post.retryCount || 1), // Espera aumenta a cada tentativa
                            attempts: 5,
                            backoff: { type: 'exponential', delay: 60000 }
                        });
                        post.status = 'publishing_retry';
                        await post.save();
                    } else {
                        // Outro erro - marca como falho
                        await post.markFailed(err.message);
                        console.error(`❌ [GMB] Falha Make: ${err.message}`);
                    }
                }
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (error) {
            console.error('❌ [GMB] Erro ao enviar ao Make:', error.message);
        }
    }, { scheduled: true, timezone: 'America/Sao_Paulo' });

    console.log('✅ Cron do GMB agendado:');
    console.log('   🏥 Especialidades: 06:00 (cria post para cada área que falta)');
    console.log('   📝 Extras: 07:30(8h) / 11:30(12h) / 14:30(15h) / 18:30(19h)');
    console.log('   🚀 Envio Make: a cada 30min das 8h às 22h');
};
