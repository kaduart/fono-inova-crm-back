/**
 * 🔗 Serviço de integração com Make (Integromat)
 *
 * Fluxo:
 *   1. Backend envia post via webhook → Make
 *   2. Make publica no Google Business Profile
 *   3. (Opcional) Make chama /gmb/webhook/make-callback para confirmar
 *
 * Configuração necessária no .env:
 *   MAKE_WEBHOOK_URL=https://hook.eu2.make.com/xxxxxxxxxxxxxx
 *
 * Payload enviado ao Make:
 *   {
 *     postId, title, content, mediaUrl,
 *     ctaUrl, ctaType, especialidade, scheduledAt
 *   }
 */

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const MAKE_TIMEOUT_MS = 15000; // 15s

/**
 * Verifica se o Make está configurado
 */
export function isMakeConfigured() {
  return Boolean(MAKE_WEBHOOK_URL);
}

/**
 * Envia um post ao Make via webhook
 * @param {object} post - Documento GmbPost
 * @returns {Promise<object>} Resposta do Make
 */
export async function sendPostToMake(post) {
  if (!MAKE_WEBHOOK_URL) {
    throw new Error('MAKE_WEBHOOK_URL não configurado no .env');
  }

  const payload = {
    postId: post._id.toString(),
    title: post.title || '',
    content: post.content || '',
    mediaUrl: post.mediaUrl || null,
    ctaUrl: post.ctaUrl || null,
    ctaType: post.ctaType || 'LEARN_MORE',
    especialidade: post.theme || null,
    scheduledAt: post.scheduledAt || null,
    // Texto formatado para copiar (se existir — do modo assistido)
    copyText: post.assistData?.copyText || post.content || '',
  };

  console.log(`🔗 [Make] Enviando post "${post.title?.substring(0, 40)}"...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MAKE_TIMEOUT_MS);

  try {
    const response = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`Make retornou HTTP ${response.status}: ${text.substring(0, 200)}`);
    }

    // Make pode retornar texto vazio ou JSON
    let result = {};
    const text = await response.text();
    if (text) {
      try { result = JSON.parse(text); } catch { /* resposta não é JSON — normal no Make */ }
    }

    console.log(`✅ [Make] Post enviado com sucesso!`);
    return { success: true, makeResponse: result };

  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Make não respondeu em ${MAKE_TIMEOUT_MS / 1000}s (timeout)`);
    }
    throw error;
  }
}

/**
 * Testa a conectividade com o webhook do Make
 * Envia um payload de teste sem salvar nada
 */
export async function testMakeConnection() {
  if (!MAKE_WEBHOOK_URL) {
    return { success: false, error: 'MAKE_WEBHOOK_URL não configurado' };
  }

  try {
    const response = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        postId: 'test',
        title: 'Teste de conexão - Fono Inova',
        content: 'Este é um teste de conectividade. Ignore.',
        mediaUrl: null,
        ctaUrl: null,
        _test: true,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    return { success: true, webhookUrl: MAKE_WEBHOOK_URL.substring(0, 50) + '...' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
