/**
 * 📲 Meta Publisher — publicação real via Graph API
 * Instagram Feed + Facebook Page Feed
 *
 * Variáveis de ambiente necessárias:
 *   META_PAGE_ID                    — ID da Página do Facebook
 *   META_PAGE_ACCESS_TOKEN          — Token de acesso da Página (longa duração)
 *   META_INSTAGRAM_BUSINESS_ID      — ID da conta Instagram Business vinculada à Página
 */

import fetch from 'node-fetch';
import logger from '../../utils/logger.js';

const GRAPH = 'https://graph.facebook.com/v20.0';

function getPageToken() {
  const token = process.env.META_PAGE_ACCESS_TOKEN;
  if (!token) throw new Error('META_PAGE_ACCESS_TOKEN não configurado no .env');
  return token;
}

function getPageId() {
  const id = process.env.META_PAGE_ID;
  if (!id) throw new Error('META_PAGE_ID não configurado no .env');
  return id;
}

function getInstagramId() {
  const id = process.env.META_INSTAGRAM_BUSINESS_ID;
  if (!id) throw new Error('META_INSTAGRAM_BUSINESS_ID não configurado no .env');
  return id;
}

// ─────────────────────────────────────────────
// INSTAGRAM
// ─────────────────────────────────────────────

/**
 * Publica imagem no Instagram Business feed.
 * @param {object} params
 * @param {string} params.imageUrl  URL pública da imagem (HTTPS, acessível pela Meta)
 * @param {string} params.caption   Legenda completa
 * @returns {Promise<string>}       ID do post publicado no Instagram
 */
export async function publishToInstagram({ imageUrl, caption }) {
  const igId = getInstagramId();
  const token = getPageToken();

  // 1️⃣ Cria container de mídia
  logger.info('[META PUBLISHER] Criando container Instagram...');
  const containerRes = await fetch(`${GRAPH}/${igId}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url: imageUrl,
      caption,
      access_token: token
    })
  });

  const containerData = await containerRes.json();

  if (!containerRes.ok || !containerData.id) {
    const msg = containerData.error?.message || JSON.stringify(containerData);
    throw new Error(`Erro ao criar container Instagram: ${msg}`);
  }

  const creationId = containerData.id;
  logger.info(`[META PUBLISHER] Container criado: ${creationId}`);

  // 2️⃣ Publica o container
  const publishRes = await fetch(`${GRAPH}/${igId}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creation_id: creationId,
      access_token: token
    })
  });

  const publishData = await publishRes.json();

  if (!publishRes.ok || !publishData.id) {
    const msg = publishData.error?.message || JSON.stringify(publishData);
    throw new Error(`Erro ao publicar no Instagram: ${msg}`);
  }

  logger.info(`[META PUBLISHER] ✅ Post Instagram publicado: ${publishData.id}`);
  return publishData.id;
}

// ─────────────────────────────────────────────
// FACEBOOK
// ─────────────────────────────────────────────

/**
 * Publica post com imagem na Página do Facebook.
 * @param {object} params
 * @param {string} params.imageUrl  URL pública da imagem (ou null para post de texto)
 * @param {string} params.message   Texto/legenda do post
 * @returns {Promise<string>}       ID do post publicado no Facebook
 */
export async function publishToFacebook({ imageUrl, message }) {
  const pageId = getPageId();
  const token = getPageToken();

  let endpoint;
  let body;

  if (imageUrl) {
    // Post com imagem
    endpoint = `${GRAPH}/${pageId}/photos`;
    body = { url: imageUrl, caption: message, access_token: token };
  } else {
    // Post de texto puro
    endpoint = `${GRAPH}/${pageId}/feed`;
    body = { message, access_token: token };
  }

  logger.info(`[META PUBLISHER] Publicando no Facebook (${imageUrl ? 'imagem' : 'texto'})...`);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();

  if (!res.ok || (!data.id && !data.post_id)) {
    const msg = data.error?.message || JSON.stringify(data);
    throw new Error(`Erro ao publicar no Facebook: ${msg}`);
  }

  const postId = data.id || data.post_id;
  logger.info(`[META PUBLISHER] ✅ Post Facebook publicado: ${postId}`);
  return postId;
}

// ─────────────────────────────────────────────
// MÉTRICAS (fase 4 — busca dados de volta)
// ─────────────────────────────────────────────

/**
 * Busca métricas básicas de um post do Instagram.
 * @param {string} igPostId   ID retornado pela publicação
 * @returns {Promise<object>}
 */
export async function getInstagramPostInsights(igPostId) {
  const token = getPageToken();
  const fields = 'like_count,comments_count,impressions,reach,saved';

  const res = await fetch(
    `${GRAPH}/${igPostId}?fields=${fields}&access_token=${token}`
  );
  const data = await res.json();

  if (!res.ok) {
    const msg = data.error?.message || JSON.stringify(data);
    throw new Error(`Erro ao buscar insights Instagram: ${msg}`);
  }

  return {
    likes: data.like_count ?? 0,
    comments: data.comments_count ?? 0,
    impressions: data.impressions ?? 0,
    reach: data.reach ?? 0,
    saved: data.saved ?? 0
  };
}

/**
 * Busca métricas básicas de um post do Facebook.
 * @param {string} fbPostId   ID retornado pela publicação
 * @returns {Promise<object>}
 */
export async function getFacebookPostInsights(fbPostId) {
  const token = getPageToken();
  const fields = 'likes.summary(true),comments.summary(true),shares';

  const res = await fetch(
    `${GRAPH}/${fbPostId}?fields=${fields}&access_token=${token}`
  );
  const data = await res.json();

  if (!res.ok) {
    const msg = data.error?.message || JSON.stringify(data);
    throw new Error(`Erro ao buscar insights Facebook: ${msg}`);
  }

  return {
    likes: data.likes?.summary?.total_count ?? 0,
    comments: data.comments?.summary?.total_count ?? 0,
    shares: data.shares?.count ?? 0
  };
}
