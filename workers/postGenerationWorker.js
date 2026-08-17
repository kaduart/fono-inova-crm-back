/**
 * 📝 Post Generation Worker
 *
 * Consumidor da fila "post-generation" — nunca teve um Worker registrado em
 * lugar nenhum do repo (confirmado: grep por "new Worker" ligado a essa fila
 * não retorna nada, git log também não mostra remoção). Todo post criado via
 * trigger manual (GMB/Instagram/Facebook) ficava com status 'processing' pra
 * sempre — o job entrava na fila e nunca era consumido.
 *
 * Só GMB está implementado por enquanto. Instagram/Facebook marcam o post
 * como failed com uma mensagem clara em vez de ficar "Processando..." pra
 * sempre — não são pra ficar silenciosos, mas a geração deles em si (ligada
 * a instagramPostService/facebookController) ainda não foi auditada.
 */

import { Worker } from 'bullmq';
import { redisConnection } from '../infrastructure/queue/queueConfig.js';
import GmbPost from '../models/GmbPost.js';
import * as gmbService from '../services/gmbService.js';

async function processGmbJob(job) {
  const { postId, especialidadeId, customTheme, funnelStage = 'top', tone = 'emotional', scheduledAt, generateImage } = job.data;

  const post = await GmbPost.findById(postId);
  if (!post) {
    console.warn(`[PostGenerationWorker] Post ${postId} não encontrado — pulando`);
    return { status: 'skipped', reason: 'POST_NOT_FOUND' };
  }

  let especialidade = gmbService.ESPECIALIDADES.find(e => e.id === especialidadeId);
  if (!especialidade) especialidade = gmbService.ESPECIALIDADES[0];

  const postData = await gmbService.generatePostForEspecialidade(especialidade, customTheme, funnelStage, tone);

  let mediaUrl = null;
  let mediaType = null;
  if (generateImage !== false) {
    const imgResult = await gmbService.generateImageForEspecialidade(especialidade, postData.content, false, job.data.provider || 'auto', { postId: post._id });
    mediaUrl = imgResult?.url || null;
    mediaType = mediaUrl ? 'image' : null;
  }

  post.title = postData.title;
  post.content = postData.content;
  post.mediaUrl = mediaUrl;
  post.mediaType = mediaType;
  post.status = scheduledAt ? 'scheduled' : 'ready';
  post.processingStatus = 'completed';
  await post.save();

  console.log(`[PostGenerationWorker] ✅ Post ${postId} gerado (${especialidade.id}, status=${post.status})`);
  return { status: 'completed', postId };
}

async function markFailed(postId, message) {
  if (!postId) return;
  await GmbPost.findByIdAndUpdate(postId, {
    $set: { status: 'failed', processingStatus: 'failed', errorMessage: message, lastErrorAt: new Date() },
  }).catch(() => {});
}

export function startPostGenerationWorker() {
  const worker = new Worker('post-generation', async (job) => {
    const { postId, channel } = job.data;

    try {
      if (channel === 'gmb') {
        return await processGmbJob(job);
      }

      // Instagram/Facebook: ainda sem implementação auditada — falha explícito
      // em vez de deixar o post preso em "Processando..." pra sempre.
      const message = `Geração automática para canal "${channel}" ainda não implementada neste worker`;
      console.warn(`[PostGenerationWorker] ⚠️ ${message} (post ${postId})`);
      await markFailed(postId, message);
      return { status: 'failed', reason: 'CHANNEL_NOT_IMPLEMENTED', channel };
    } catch (error) {
      console.error(`[PostGenerationWorker] ❌ Job ${job.id} (post ${postId}) falhou:`, error.message);
      await markFailed(postId, error.message?.slice(0, 500));
      throw error;
    }
  }, {
    connection: redisConnection,
    concurrency: 2,
  });

  worker.on('completed', (job) => {
    console.log(`[PostGenerationWorker] ✅ Job ${job.id} concluído`);
  });

  worker.on('failed', (job, err) => {
    console.error(`[PostGenerationWorker] ❌ Job ${job?.id} falhou definitivamente:`, err.message);
  });

  console.log('[PostGenerationWorker] 🚀 Worker iniciado (fila: post-generation)');
  return worker;
}
