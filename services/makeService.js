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
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000; // 2s inicial

// Erro especial para fila cheia — permite tratamento diferenciado no caller
export class MakeQueueFullError extends Error {
  constructor() {
    super('Make queue full');
    this.name = 'MakeQueueFullError';
  }
}

// Hashtags por especialidade
function gerarHashtags(tema) {
  const base = '#fonoinova #fonoaudiologia #desenvolvimentoinfantil #terapiainfantil #criançassaudaveis #anapolisgo';
  const extras = {
    fonoaudiologia:       '#atrasodafala #fala #linguagem #autismo #tdah #fonoaudióloga',
    psicologia:           '#psicologiainfantil #saudeemocional #comportamento #ansiedadeinfantil',
    terapia_ocupacional:  '#terapiaocupacional #integracaosensorial #autonomia #motricidade',
    fisioterapia:         '#fisioterapiainfantil #motricidade #postura #hipotonia',
    psicomotricidade:     '#psicomotricidade #coordenacao #alfabetizacao #escolainfantil',
    freio_lingual:        '#freiolingual #amamentacao #linguapresa #bebê',
    neuropsicologia:      '#neuropsicologia #tdah #dislexia #avaliacaoneuropsicologica',
    psicopedagogia_clinica: '#psicopedagogia #dislexia #dificuldadedeaprendizagem #leitura',
    psicopedagogia:       '#psicopedagogia #aprendizagem #escola #desenvolvimento',
    musicoterapia:        '#musicoterapia #autismo #expressao #musicaeterapia',
  };
  return `${base} ${extras[tema] || ''}`.trim();
}

/**
 * Verifica se o Make está configurado
 */
export function isMakeConfigured() {
  return Boolean(MAKE_WEBHOOK_URL);
}

/**
 * Envia um post ao Make via webhook (com retry automático)
 * @param {object} post - Documento GmbPost
 * @param {number} attempt - Tentativa atual (para retry)
 * @returns {Promise<object>} Resposta do Make
 */
// Valida se uma URL de imagem é acessível antes de enviar ao Make
async function validateMediaUrl(url) {
  if (!url) {
    console.log('[Make] URL da imagem é null/undefined');
    return null;
  }
  // Rejeita URLs locais, relativas ou claramente inválidas
  if (!url.startsWith('http')) {
    console.log(`[Make] URL inválida (não começa com http): ${url.substring(0, 50)}`);
    return null;
  }
  
  // Verifica se é URL do Cloudinary (geralmente confiável)
  const isCloudinary = url.includes('cloudinary.com') || url.includes('res.cloudinary');
  
  try {
    const res = await fetch(url, { 
      method: 'HEAD', 
      signal: AbortSignal.timeout(5000),
      // Cloudinary às vezes bloqueia HEAD, então aceitamos se for URL conhecida
      ...(isCloudinary && { headers: { 'User-Agent': 'Mozilla/5.0' } })
    });
    
    if (res.ok) {
      console.log(`[Make] ✅ URL validada: ${url.substring(0, 60)}...`);
      return url;
    } else {
      console.log(`[Make] ⚠️ URL retornou status ${res.status}: ${url.substring(0, 60)}`);
      // Se for Cloudinary e der erro, ainda tenta usar (pode ser restrição de HEAD)
      return isCloudinary ? url : null;
    }
  } catch (err) {
    console.log(`[Make] ⚠️ Erro ao validar URL: ${err.message}`);
    // Se for Cloudinary, tenta usar mesmo assim
    return isCloudinary ? url : null;
  }
}

export async function sendPostToMake(post, attempt = 1) {
  if (!MAKE_WEBHOOK_URL) {
    throw new Error('MAKE_WEBHOOK_URL não configurado no .env');
  }

  // ── Legendas por canal ───────────────────────────────────────────────
  const textoBase = post.content || '';
  const ctaUrl    = post.ctaUrl || 'https://www.clinicafonoinova.com.br/';

  // Valida imagem antes de enviar — URL inválida derruba o cenário no Make
  const safeMediaUrl = await validateMediaUrl(post.mediaUrlBranded || post.mediaUrl);

  // Instagram: texto curto (até 150 chars) + hashtags + link na bio
  const textoShort = textoBase.split('\n').filter(Boolean).slice(0, 2).join('\n');
  const hashtags = gerarHashtags(post.theme);
  const instagramCaption =
    `${textoShort.substring(0, 220)}\n\n` +
    `🔗 Agende uma avaliação gratuita — link na bio!\n` +
    `📍 Fono Inova · Anápolis-GO\n` +
    `📲 (62) 99337-7726\n\n` +
    `${hashtags}`;

  // Facebook: texto completo + link explícito + WhatsApp
  const facebookCaption =
    `${textoBase.substring(0, 900)}\n\n` +
    `👉 Saiba mais ou agende: ${ctaUrl}\n` +
    `📲 WhatsApp: (62) 99337-7726\n` +
    `📍 Fono Inova · Centro de Desenvolvimento Infantil · Anápolis-GO`;

  const payload = {
    postId: post._id.toString(),
    title: post.title || '',
    content: post.content || '',          // GMB summary (até 1500 chars)
    mediaUrl: safeMediaUrl,                // validado — null se inacessível
    mediaUrlBranded: safeMediaUrl,         // alias
    ctaUrl,
    ctaType: post.ctaType || 'LEARN_MORE',
    especialidade: post.theme || null,
    scheduledAt: post.scheduledAt || null,
    // Legendas por canal
    instagramCaption,                      // para o módulo Instagram no Make
    facebookCaption,                       // para o módulo Facebook no Make
    copyText: post.assistData?.copyText || post.content || '',
  };

  console.log(`🔗 [Make] Enviando post "${post.title?.substring(0, 40)}"... (tentativa ${attempt}/${MAX_RETRIES})`);

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

    // 🔄 Se fila cheia (HTTP 400) e ainda tem tentativas, faz retry
    if (response.status === 400) {
      const text = await response.text().catch(() => response.statusText);
      const isQueueFull = text.toLowerCase().includes('queue') && text.toLowerCase().includes('full');
      
      if (isQueueFull) {
        // Não retenta — joga erro especial para o caller deferir o post
        throw new MakeQueueFullError();
      }

      // Outro erro 400
      throw new Error(`Make retornou HTTP ${response.status}: ${text.substring(0, 200)}`);
    }

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

    console.log(`✅ [Make] Post enviado com sucesso! (tentativa ${attempt})`);
    return { success: true, makeResponse: result, attempts: attempt };

  } catch (error) {
    clearTimeout(timeoutId);
    
    // 🔄 Retry em caso de timeout ou erro de rede
    if ((error.name === 'AbortError' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') && attempt < MAX_RETRIES) {
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`⚠️ [Make] Timeout/rede, tentando novamente em ${delay/1000}s... (${attempt}/${MAX_RETRIES})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      return sendPostToMake(post, attempt + 1);
    }
    
    if (error.name === 'AbortError') {
      throw new Error(`Make não respondeu em ${MAKE_TIMEOUT_MS / 1000}s (timeout após ${attempt} tentativas)`);
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
