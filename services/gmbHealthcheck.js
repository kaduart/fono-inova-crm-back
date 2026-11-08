/**
 * 🩺 Healthcheck do GMB — "o post de hoje saiu?"
 * Roda 1x/dia (meio-dia), depois que o post das 08:10 já deveria ter sido criado e enviado.
 * Se detectar falha, cria uma Notification de sistema (sininho do admin) — nunca mais parar em silêncio.
 *
 * Classificação (pura, testável) separada da consulta ao banco.
 */
import GmbPost from '../models/GmbPost.js';
import Notification from '../models/Notification.js';

// Status que significam "foi enviado ao Make" (saiu do back com sucesso)
const ENVIADOS = ['published', 'publishing_retry', 'unconfirmed'];

/**
 * Classifica a saúde do GMB a partir dos posts criados hoje. PURA (sem banco).
 * @param {{posts?: Array<{status:string}>, now?: Date, horaCorteEnvio?: number}} params
 */
export function classificarSaudeGmb({ posts = [], now = new Date(), horaCorteEnvio = 13 } = {}) {
  const criados = posts.length;
  const enviados = posts.filter((p) => ENVIADOS.includes(p.status)).length;
  const comImagemEsperando = posts.filter((p) => p.status === 'scheduled').length; // tem imagem, aguardando envio
  const needsReview = posts.filter((p) => p.status === 'needs_review').length;      // sem imagem
  const passouJanela = now.getHours() >= horaCorteEnvio;

  // 1) Nada criado hoje → cron não rodou
  if (criados === 0) {
    return {
      ok: false, nivel: 'critico', titulo: '⚠️ GMB: nenhum post criado hoje',
      detalhe: 'O cron das 08:10 não criou post — worker suspenso, erro na criação ou nenhuma especialidade elegível.',
    };
  }
  // 2) Pelo menos um saiu → tudo certo
  if (enviados > 0) {
    return { ok: true, nivel: 'ok', titulo: 'GMB: publicado', detalhe: `${enviados} enviado(s) hoje.` };
  }
  // 3) Nada enviado, mas ainda dentro da janela → não alarma cedo
  if (!passouJanela) {
    return { ok: true, nivel: 'pendente', titulo: 'GMB: aguardando envio', detalhe: `${criados} criado(s); envio ainda na janela.` };
  }
  // 4) Passou a janela e nada enviado:
  //    4a) tinha post COM imagem esperando → falha de envio (crítico)
  if (comImagemEsperando > 0) {
    return {
      ok: false, nivel: 'critico', titulo: '⚠️ GMB: post criado mas não publicado',
      detalhe: `${comImagemEsperando} post(s) com imagem não enviado(s) ao Make. Enviador travado ou GMB_AUTO_PUBLISH desligado.`,
    };
  }
  //    4b) só havia post SEM imagem → aviso (motivo conhecido: ImageBank)
  if (needsReview > 0) {
    return {
      ok: false, nivel: 'aviso', titulo: '⚠️ GMB: post sem imagem (needs_review)',
      detalhe: `${needsReview} post(s) sem imagem elegível — revisar ImageBank.`,
    };
  }
  //    4c) criado mas em estado inesperado
  return {
    ok: false, nivel: 'critico', titulo: '⚠️ GMB: post criado mas não publicado',
    detalhe: `${criados} post(s) criado(s) e 0 enviado(s), em estado inesperado.`,
  };
}

/** Consulta o banco (posts criados hoje) e classifica. */
export async function avaliarSaudeGmbHoje(now = new Date()) {
  const inicioDia = new Date(now);
  inicioDia.setHours(0, 0, 0, 0);
  const posts = await GmbPost.find({ createdAt: { $gte: inicioDia } }).select('status').lean();
  return classificarSaudeGmb({ posts, now });
}

/** Avalia e, se houver falha, notifica o admin (sininho). Retorna o resultado. */
export async function healthcheckGmb(now = new Date()) {
  const r = await avaliarSaudeGmbHoje(now);
  if (r.ok) {
    console.log(`✅ [GMB Healthcheck] ${r.titulo} — ${r.detalhe}`);
    return r;
  }
  console.error(`🚨 [GMB Healthcheck] ${r.titulo} — ${r.detalhe}`);
  try {
    await Notification.createSystemAlert({
      title: r.titulo,
      priority: r.nivel === 'critico' ? 'urgent' : 'high',
      dedupeKey: 'gmb-healthcheck',
    });
  } catch (e) {
    console.error('[GMB Healthcheck] falha ao criar notificação:', e.message);
  }
  return r;
}

export default { classificarSaudeGmb, avaliarSaudeGmbHoje, healthcheckGmb };
