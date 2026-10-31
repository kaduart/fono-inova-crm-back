// crons/adsConversion.logic.js
// Lógica PURA (sem Mongoose, sem axios, sem rede) do cron de conversões de anúncio.
// Isolada aqui para ser testável com `node` sem DB nem credenciais.
// O cron (adsConversion.cron.js) importa e apenas orquestra I/O; aqui ficam
// as decisões determinísticas (elegibilidade, telefone, destino de plataforma,
// interpretação das respostas das APIs).

import { validateE164 } from '../utils/phone.js';

// Status operacionais que representam AGENDAMENTO REAL (aceito/confirmado).
// 'pre_agendado' ("Interesse registrado, aguarda confirmação") é PROJEÇÃO / pré-agendamento
// SEM aceite — nasce assim (inclusive sessões de convênio geradas por plano) e só vira
// agendamento quando confirmado (confirmPreAgendamentoCommand: pre_agendado -> scheduled).
// Isto NÃO exclui convênio por origem: uma sessão de convênio CONFIRMADA (scheduled) é elegível.
export const BOOKED_STATUSES = ['scheduled', 'confirmed', 'paid', 'completed'];

export function isEligibleStatus(status) {
  return BOOKED_STATUSES.includes(status);
}

// fbc no formato exigido pela Meta: fb.1.<ms do clique>.<fbclid>
export function buildFbc(attr) {
  if (!attr?.fbclid) return null;
  const ms = new Date(attr.firstMessageAt || Date.now()).getTime();
  return `fb.1.${ms}.${attr.fbclid}`;
}

// #1 Telefone: escolhe o contato PRINCIPAL do atendimento.
// Ordem de prioridade: (1) contato capturado NO atendimento (appt.patientInfo.phone),
// (2) telefone cadastrado do paciente (Patient.phone). Cada candidato é normalizado e
// validado em E.164 BR; o PRIMEIRO válido vence. NUNCA usa contato de emergência.
// Dois números diferentes NÃO bloqueiam — apenas seguem a ordem de prioridade.
export function resolveMainPhone({ patientInfoPhone, patientPhone } = {}) {
  for (const candidate of [patientInfoPhone, patientPhone]) {
    if (!candidate) continue;
    const v = validateE164(candidate);
    if (v.valid) return v.normalized;
  }
  return null;
}

// #4 Interpreta a resposta da Meta CAPI. NUNCA marca events_received:0 como sucesso.
//   r == null            -> não configurado (skipped)
//   r.events_received >=1 -> aceito pela API (sent)
//   r.events_received ==0 -> recusado/ inválido (failed, não-retryable)
export function interpretMetaResponse(r, { pixel, event, actionSource } = {}) {
  const base = { pixel: pixel || null, event: event || null, actionSource: actionSource || null };
  if (r == null) {
    return { ...base, status: 'skipped', reason: 'meta_capi_nao_configurado', eventsReceived: null, trace: null };
  }
  const received = Number(r.events_received);
  const trace = r.fbtrace_id || null;
  if (Number.isFinite(received) && received >= 1) {
    return { ...base, status: 'sent', eventsReceived: received, trace, reason: null };
  }
  let reason = 'meta_events_received_0';
  if (Array.isArray(r.messages) && r.messages.length) reason = String(r.messages.join('; ')).slice(0, 300);
  return { ...base, status: 'failed', eventsReceived: Number.isFinite(received) ? received : 0, trace, reason, retryable: false };
}

// #4/#5 Interpreta a resposta da TikTok Events API.
//   r == null    -> não configurado / sem identificador (skipped)
//   r.code === 0 -> aceito (sent)   [o service lança erro quando code != 0]
export function interpretTiktokResponse(r, { pixel } = {}) {
  const base = { pixel: pixel || null };
  if (r == null) return { ...base, status: 'skipped', reason: 'tiktok_events_nao_configurado', trace: null };
  if (Number(r.code) === 0) return { ...base, status: 'sent', code: 0, trace: r.request_id || null, reason: null };
  return { ...base, status: 'failed', code: Number(r.code), trace: r.request_id || null, reason: `tiktok_code_${r.code}`, retryable: true };
}

// Decide os destinos de plataforma no enqueue (puro, idempotente).
//   first        : é a 1ª vez do paciente (aquisição)
//   phone        : telefone principal já resolvido/validado (ou null)
//   attr         : atribuição capturada (gclid/fbclid/ttclid/...)
//   createdAtMs  : createdAt do agendamento em ms (janelas de atribuição)
export function decidePlatforms({ first, phone, attr = {}, eventTimeMs, now = Date.now() }) {
  if (!first) {
    const skip = { status: 'skipped', reason: 'nao_e_primeiro_agendamento' };
    return {
      isAcquisition: false,
      done: true,
      meta: { ...skip }, google: { ...skip }, tiktok: { ...skip },
      gclid: null, fbc: null, ttclid: null,
    };
  }

  const ageMs = now - Number(eventTimeMs);
  const withinMetaWindow = ageMs < 6.5 * 864e5;    // Meta: ~7 dias
  const withinTikTokWindow = ageMs < 6.5 * 864e5;  // TikTok: ~7 dias

  const meta = !phone ? { status: 'skipped', reason: 'sem_telefone' }
    : !withinMetaWindow ? { status: 'skipped', reason: 'fora_janela_7d_meta' }
    : { status: 'pending' };

  const gclid = attr?.gclid || null;
  const google = gclid ? { status: 'pending' } : { status: 'skipped', reason: 'sem_gclid' };

  // #5 TikTok aceita telefone OU ttclid (o service monta user{phone|ttclid}).
  const ttclid = attr?.ttclid || null;
  const hasTikTokId = Boolean(phone) || Boolean(ttclid);
  const tiktok = !hasTikTokId ? { status: 'skipped', reason: 'sem_identificador' }
    : !withinTikTokWindow ? { status: 'skipped', reason: 'fora_janela_7d_tiktok' }
    : { status: 'pending' };

  const done = meta.status !== 'pending' && google.status !== 'pending' && tiktok.status !== 'pending';

  return { isAcquisition: true, done, meta, google, tiktok, gclid, fbc: buildFbc(attr), ttclid };
}

// #2 Data COMPROVADA em que o agendamento virou conversão.
// Lê a transição registrada no histórico para um status de agendamento real (booked).
// Usa o timestamp da PRIMEIRA transição comprovada; se não houver evidência no histórico
// (ex.: agendamento criado já em status booked), cai para createdAt (a criação é a
// evidência). NUNCA usa updatedAt genérico nem inventa data para histórico sem evidência.
export function resolveConversionTime(appt) {
  const hist = Array.isArray(appt?.history) ? appt.history : [];
  let earliest = null;
  for (const h of hist) {
    const to = h?.details?.to || h?.newStatus || null;
    if (to && BOOKED_STATUSES.includes(to) && h?.timestamp) {
      const ts = new Date(h.timestamp).getTime();
      if (!Number.isNaN(ts) && (earliest === null || ts < earliest)) earliest = ts;
    }
  }
  return earliest !== null ? new Date(earliest) : new Date(appt?.createdAt);
}

// #1 Regra PURA de aquisição (os booleans vêm de queries no cron).
// A aquisição NÃO depende de o agendamento original continuar elegível: se os anteriores
// são inelegíveis e nenhum gerou conversão, o agendamento atual (válido) é a aquisição.
export function shouldAcquire({ hasPatient, alreadyAcquired, earlierConverted, earlierEligibleExists }) {
  if (!hasPatient) return true;          // pré-cadastro sem paciente
  if (alreadyAcquired) return false;     // já há aquisição registrada para o paciente
  if (earlierConverted) return false;    // um agendamento anterior já tem conversão (legado)
  if (earlierEligibleExists) return false; // um anterior elegível será a âncora; este defere
  return true;
}

// #3 event_id ESTÁVEL por agendamento: mesmo id em retries e em execuções concorrentes,
// garantindo dedupe na plataforma (Meta/TikTok) mesmo se dois POSTs escaparem.
export const eventIdFor = (appointmentId) => `appt_${appointmentId}`;

// #3 Reserva ATÔMICA do próximo pendente: findOneAndUpdate que empurra nextAttemptAt
// para frente (lease). Dois workers nunca pegam o mesmo doc — o 2º já não casa o filtro.
// Se o worker cair após a reserva, o lease expira e outro reprocessa (recuperação).
export function buildPendingClaim(now = Date.now(), leaseMs = 5 * 60 * 1000) {
  return {
    filter: { done: false, nextAttemptAt: { $lte: new Date(now) } },
    update: { $set: { nextAttemptAt: new Date(now + leaseMs) } },
    options: { sort: { createdAt: 1 }, new: true },
  };
}
