/**
 * ⏰ Worker de publicação agendada — Instagram + Facebook
 * Roda a cada 1 minuto via setInterval (inicializado no server.js).
 * Publica posts com status='scheduled' cujo scheduledAt <= agora.
 */

import InstagramPost from '../models/InstagramPost.js';
import FacebookPost from '../models/FacebookPost.js';
import { publishToInstagram, publishToFacebook } from '../services/meta/metaPublisher.js';
import logger from '../utils/logger.js';

async function processInstagram() {
  const posts = await InstagramPost.findScheduledForPublish(5);
  for (const post of posts) {
    try {
      if (!post.mediaUrl) {
        await post.markFailed('Post sem imagem — não foi possível publicar');
        continue;
      }
      const caption = post.caption || `${post.headline}\n\n${post.content}`;
      const igPostId = await publishToInstagram({ imageUrl: post.mediaUrl, caption });
      await post.markPublished(igPostId);
      logger.info(`[SCHEDULER] ✅ Instagram post ${post._id} publicado: ${igPostId}`);
    } catch (err) {
      logger.error(`[SCHEDULER] ❌ Falha Instagram post ${post._id}: ${err.message}`);
      await post.markFailed(err.message);
    }
  }
}

async function processFacebook() {
  const posts = await FacebookPost.findScheduledForPublish(5);
  for (const post of posts) {
    try {
      const fbPostId = await publishToFacebook({ imageUrl: post.mediaUrl || null, message: post.content });
      await post.markPublished(fbPostId);
      logger.info(`[SCHEDULER] ✅ Facebook post ${post._id} publicado: ${fbPostId}`);
    } catch (err) {
      logger.error(`[SCHEDULER] ❌ Falha Facebook post ${post._id}: ${err.message}`);
      await post.markFailed(err.message);
    }
  }
}

export async function runScheduledPublisher() {
  try {
    await Promise.all([processInstagram(), processFacebook()]);
  } catch (err) {
    logger.error('[SCHEDULER] Erro geral:', err.message);
  }
}

/**
 * Inicia o worker com intervalo de 60 segundos.
 * Chamar uma vez no server.js após conectar ao MongoDB.
 */
export function startScheduledPublisher() {
  logger.info('[SCHEDULER] Worker de publicação agendada iniciado (intervalo: 60s)');
  setInterval(runScheduledPublisher, 60_000);
}
