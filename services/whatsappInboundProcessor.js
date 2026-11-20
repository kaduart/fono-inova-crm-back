// services/whatsappInboundProcessor.js
//
// Regras de negócio sobre o que chega do WhatsApp (18/11/2026, separação do conector).
// Recebe EVENTOS NORMALIZADOS (objetos simples, sem o `msg` do whatsapp-web.js), então roda igual:
//   - no modo local: o próprio whatsappWebJsService normaliza a mensagem e chama daqui;
//   - no modo externo: o conector (outro host, com o Chrome) manda o evento por HTTP e o CRM chama daqui.
// Nada aqui toca no navegador. Cada efeito é idempotente do lado do banco (first-touch, upsert por telefone,
// lembrete casado por messageId), então reprocessar o mesmo evento não duplica nada.
//
// Formatos (ver docs/WHATSAPP_CONECTOR_EXTERNO.md §3):
//   message.inbound  { waMessageId, chatId, phone|null, body, timestamp(seg), notifyName, selectedButtonId,
//                      ctwa|null, externalAdReply|null, source: 'live'|'catchup' }
//   message.outbound { waMessageId, chatId, phone|null, timestamp(seg), body?, type? }
//   (inbound também traz type? desde 20/11; campos novos são opcionais: conector antigo continua válido)
//   poll.vote        { voterPhone|null, pollMessageId|null, optionName, respondedAtMs|null }

const isOn = (name) => process.env[name] !== 'false';

function atDate(timestampSec) {
  const n = Number(timestampSec);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : new Date();
}

/** Origem (site/anúncio). Devolve o resultado da gravação, ou null quando não há origem/telefone. */
export async function processInboundAttribution(ev) {
  if (!isOn('WA_ATTRIBUTION_CAPTURE')) return null;
  const { parseAttribution } = await import('../utils/attributionParser.js');
  const { extractCtwa } = await import('../utils/ctwaContext.js');
  const ctwa = extractCtwa(ev.ctwa || null, ev.externalAdReply ? { externalAdReply: ev.externalAdReply } : null);
  if (!parseAttribution(ev.body || '', ctwa)) return null;
  if (!ev.phone) {
    console.warn('[WhatsAppInbound] ⚠️ origem detectada mas telefone real não resolvido (@lid) — não gravo para não perder o vínculo com o agendamento');
    return null;
  }
  const { captureInboundAttribution } = await import('./leadAttributionService.js');
  return captureInboundAttribution({
    phone: ev.phone,
    text: ev.body || '',
    ctwa,
    capturedBy: ev.source === 'catchup' ? 'whatsapp_web_catchup' : 'whatsapp_web',
  });
}

/** Resposta ao lembrete de presença (texto ou botão). */
export async function processInboundAppointmentConfirmation(ev) {
  if (!ev.phone) return null;
  const { recordAttendanceConfirmationResponse } = await import('./appointment/attendanceConfirmation.service.js');
  return recordAttendanceConfirmationResponse({
    phone: ev.phone,
    text: ev.body || '',
    buttonId: ev.selectedButtonId || null,
    messageId: ev.waMessageId || null,
    respondedAt: atDate(ev.timestamp),
  });
}

/** Contato citou convênio da lista de interesse (GEAP/IPASGO/...). */
export async function processInboundConvenioInterest(ev) {
  if (!isOn('WA_CONVENIO_INTEREST_CAPTURE')) return null;
  const { matchWaitlistConvenios } = await import('../constants/convenioWaitlist.js');
  const convenios = matchWaitlistConvenios(ev.body || '');
  if (!convenios.length || !ev.phone) return null;
  const { recordWhatsappInterest } = await import('./convenioWaitlistWhatsapp.js');
  const at = atDate(ev.timestamp);
  for (const convenio of convenios) {
    await recordWhatsappInterest({
      phone: ev.phone, convenio, name: ev.notifyName || null,
      firstAt: at, lastAt: at, snippet: ev.body, snippetFromContact: true,
      mentionedBy: ['contato'], capturedBy: 'live',
    });
  }
  return convenios;
}

/** Texto da mensagem na tela Conversas (WA_WEB_CHAT_MIRROR=on). Catch-up também grava: cobre o worker suspenso. */
export async function processInboundChatMirror(ev) {
  if (!ev?.phone) return null;
  const { mirrorWebMessage } = await import('./whatsappWebChatMirror.js');
  return mirrorWebMessage({ ...ev, direction: 'inbound' });
}

/**
 * Mensagem recebida: roda as três regras de forma independente (uma falhar não impede as outras).
 * Catch-up (mensagens relidas depois de o WhatsApp ficar fora) só refaz a origem, como antes.
 */
export async function processInboundMessage(ev) {
  if (!ev) return {};
  const steps = ev.source === 'catchup'
    ? [['attribution', processInboundAttribution], ['chat', processInboundChatMirror]]
    : [
      ['attribution', processInboundAttribution],
      ['confirmation', processInboundAppointmentConfirmation],
      ['convenio', processInboundConvenioInterest],
      ['chat', processInboundChatMirror],
    ];
  const out = {};
  for (const [name, fn] of steps) {
    try {
      out[name] = await fn(ev);
    } catch (err) {
      out[name] = { error: err?.message || String(err) };
      console.warn(`[WhatsAppInbound] ⚠️ ${name} falhou (ignorado):`, err?.message);
    }
  }
  return out;
}

/** Mensagem que a CLÍNICA mandou (pelo ERP ou na mão): data na lista de interesse, para o envio em massa não repetir. */
export async function processOutboundClinicMessage(ev) {
  if (!ev?.phone) return null;
  try {
    const { scheduleOutboundMirror } = await import('./whatsappWebChatMirror.js');
    scheduleOutboundMirror(ev); // não espera: a cópia sai depois que o ERP gravou a dele
  } catch (err) {
    console.warn('[WhatsAppInbound] ⚠️ cópia da mensagem enviada não agendada (ignorado):', err?.message);
  }
  const { recordChatActivity } = await import('./convenioWaitlistWhatsapp.js');
  return recordChatActivity([{ phone: ev.phone, clinicAt: atDate(ev.timestamp) }]);
}

/** Voto na enquete do lembrete de presença. */
export async function processPollVote(ev) {
  if (!ev?.optionName) return null;
  if (!ev.voterPhone) {
    console.warn('[WhatsAppInbound] ⚠️ voto de confirmação ignorado: telefone do paciente não resolvido');
    return null;
  }
  const { recordAttendanceConfirmationPollVote } = await import('./appointment/attendanceConfirmation.service.js');
  const result = await recordAttendanceConfirmationPollVote({
    phone: ev.voterPhone,
    pollMessageId: ev.pollMessageId || null,
    optionName: ev.optionName,
    respondedAt: ev.respondedAtMs ? new Date(Number(ev.respondedAtMs)) : new Date(),
  });
  if (!result?.matched) {
    console.warn('[WhatsAppInbound] ⚠️ voto recebido, mas nenhum lembrete pendente foi vinculado:', result?.reason || 'desconhecido');
  }
  return result;
}

/** Despacha um evento do conector pelo tipo. Tipo desconhecido é ignorado (versões diferentes convivem). */
export async function processConnectorEvent(evt) {
  const data = evt?.data || {};
  // Modo externo: o log 📣 do anúncio (antes no whatsappWebJsService) sai daqui, com o mesmo formato.
  if (evt?.connectorId && evt.type === 'message.inbound' && data.ctwa && data.source !== 'catchup') {
    try {
      const { extractCtwa, clidLogInfo } = await import('../utils/ctwaContext.js');
      const ctwa = extractCtwa(data.ctwa, data.externalAdReply ? { externalAdReply: data.externalAdReply } : null);
      console.log('[WhatsAppInbound] 📣 ctwaContext recebido (conector) — chaves:', Object.keys(data.ctwa).join(','),
        `| anúncio=${ctwa?.sourceId ? 'sim' : 'não'} clid=${ctwa?.ctwaClid ? `sim (${ctwa.clidFrom}; ${clidLogInfo(ctwa.ctwaClid)})` : 'não'}`);
    } catch { /* log é diagnóstico */ }
  }
  switch (evt?.type) {
    case 'message.inbound': return processInboundMessage(data);
    case 'message.outbound': return processOutboundClinicMessage(data);
    case 'poll.vote': return processPollVote(data);
    default: return { ignored: true };
  }
}

export default {
  processInboundMessage,
  processInboundAttribution,
  processInboundAppointmentConfirmation,
  processInboundConvenioInterest,
  processInboundChatMirror,
  processOutboundClinicMessage,
  processPollVote,
  processConnectorEvent,
};
