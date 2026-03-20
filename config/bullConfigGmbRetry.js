/**
 * 🔄 Fila de retry para publicações GMB/Instagram/Facebook
 * Quando o Make falha (fila cheia), salvamos aqui e tentamos depois
 */

import { Queue, QueueEvents, Worker } from 'bullmq';
import { redisConnection } from './redisConnection.js';
import * as makeService from '../services/makeService.js';
import GmbPost from '../models/GmbPost.js';

// 🔄 Fila de retry para publicações
export const gmbPublishRetryQueue = new Queue('gmb-publish-retry', { 
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 5,           // Tenta 5 vezes
        backoff: {
            type: 'exponential',
            delay: 60000       // Começa com 1min, depois 2min, 4min, 8min...
        },
        removeOnComplete: 50,
        removeOnFail: 10
    }
});

export const gmbPublishRetryEvents = new QueueEvents('gmb-publish-retry', { 
    connection: redisConnection 
});

// 🏭 Worker que processa a fila de retry
export function initGmbRetryWorker() {
    const worker = new Worker('gmb-publish-retry', async (job) => {
        const { postId, channel = 'gmb' } = job.data;
        
        console.log(`🔄 [GMB Retry] Tentando publicar ${channel}/${postId} (tentativa ${job.attemptsMade + 1}/${job.opts.attempts})`);
        
        try {
            // Buscar post no MongoDB
            let PostModel;
            if (channel === 'gmb') PostModel = (await import('../models/GmbPost.js')).default;
            else if (channel === 'instagram') PostModel = (await import('../models/InstagramPost.js')).default;
            else if (channel === 'facebook') PostModel = (await import('../models/FacebookPost.js')).default;
            else throw new Error(`Canal desconhecido: ${channel}`);
            
            const post = await PostModel.findById(postId);
            if (!post) {
                throw new Error('Post não encontrado');
            }
            
            // Tentar enviar ao Make
            await makeService.sendPostToMake(post);
            
            // Sucesso! Atualizar post
            post.status = 'published';
            post.publishedAt = new Date();
            post.publishedBy = 'api-retry';
            await post.save();
            
            console.log(`✅ [GMB Retry] Publicado com sucesso: ${postId}`);
            
            return { success: true, postId, channel };
            
        } catch (error) {
            console.error(`❌ [GMB Retry] Falhou: ${error.message}`);
            
            // Se ainda tem tentativas, deixa o BullMQ retry
            throw error;
        }
    }, {
        connection: redisConnection,
        concurrency: 1,  // Um por vez pra não sobrecarregar o Make
        limiter: {
            max: 10,
            duration: 60000  // 10 por minuto
        }
    });
    
    worker.on('completed', (job, result) => {
        console.log(`✅ [GMB Retry Worker] Job ${job.id} completado: ${result?.postId}`);
    });
    
    worker.on('failed', (job, err) => {
        console.error(`❌ [GMB Retry Worker] Job ${job?.id} falhou após ${job?.attemptsMade} tentativas: ${err.message}`);
    });
    
    console.log('🔄 [GMB Retry Worker] Inicializado');
    return worker;
}

export default gmbPublishRetryQueue;
