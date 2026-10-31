// routes/analytics/funnel.logic.js
// Lógica PURA (sem DB) da aba Inteligência de Conversão. Testável sem servidor.
// Dois blocos independentes:
//   (1) Funil comercial por CANAL DE MARKETING (vem da ATRIBUIÇÃO, nunca da origem
//       técnica do agendamento como insurance_plan/reschedule).
//   (2) Resumo de ENTREGA às plataformas (lido do AdConversion = fila real do pixel).

// ── (1) Funil por canal ───────────────────────────────────────────────────────
// contacts: [{ phone (normalizado), channel|null }] JÁ deduplicado por telefone
//           (1 contato por pessoa; channel=null => "nao_identificado").
// apptStatusByPhone: Map/obj phone -> { booked:boolean, pre:boolean } JÁ colapsado
//           por telefone (remarcação/sessões recorrentes contam 1 vez).
// Unidade contada = CONTATO (telefone distinto). Taxa = agendamentos/contatos do
// MESMO grupo (contatos do canal), nunca cruzando grupos diferentes.
export function buildChannelFunnel({ contacts = [], apptStatusByPhone = {} } = {}) {
  const get = (p) => (apptStatusByPhone instanceof Map ? apptStatusByPhone.get(p) : apptStatusByPhone[p]) || null;
  const byChannel = new Map();
  for (const c of contacts) {
    const ch = c.channel || 'nao_identificado';
    const st = get(c.phone) || {};
    const booked = !!st.booked;
    const prePending = !!st.pre && !booked; // pré-agendamento PENDENTE = ainda não virou real
    const row = byChannel.get(ch) || { channel: ch, contatos: 0, preAgendamentos: 0, agendamentos: 0 };
    row.contatos += 1;
    if (prePending) row.preAgendamentos += 1;
    if (booked) row.agendamentos += 1;
    byChannel.set(ch, row);
  }
  const rows = [...byChannel.values()]
    .map((r) => ({ ...r, conversao: r.contatos ? +(r.agendamentos / r.contatos).toFixed(4) : null }))
    .sort((a, b) => b.agendamentos - a.agendamentos || b.contatos - a.contatos);
  const totals = rows.reduce((t, r) => ({
    contatos: t.contatos + r.contatos,
    preAgendamentos: t.preAgendamentos + r.preAgendamentos,
    agendamentos: t.agendamentos + r.agendamentos,
  }), { contatos: 0, preAgendamentos: 0, agendamentos: 0 });
  totals.conversao = totals.contatos ? +(totals.agendamentos / totals.contatos).toFixed(4) : null;
  return { rows, totals };
}

// Contatos recebidos vêm da FONTE que registra contatos (Leads) — INCLUI os sem atribuição.
// LeadAttribution serve só para IDENTIFICAR o canal, nunca para contar os contatos.
// Dedup por telefone; canal = atribuição quando houver, senão null (-> "nao_identificado").
// A coorte do período é definida por estes contatos (leads que entraram na janela); a
// conversão acompanha ESTE mesmo grupo.
export function mergeContacts({ attributed = [], leads = [] } = {}) {
  const channelByPhone = new Map();
  for (const a of attributed) { if (a.phone && a.channel) channelByPhone.set(a.phone, a.channel); }
  const seen = new Set();
  const out = [];
  for (const l of leads) {
    if (!l.phone || seen.has(l.phone)) continue; // dedup por telefone
    seen.add(l.phone);
    out.push({ phone: l.phone, channel: channelByPhone.get(l.phone) || null });
  }
  return out;
}

// ── (2) Entrega às plataformas ────────────────────────────────────────────────
export const PLATFORMS = ['meta', 'google', 'tiktok'];
// docs: AdConversion[] com subdocs meta/google/tiktok { status, reason, sentAt }.
// Aceita = status 'sent' (a API ACEITOU o recebimento). ATENÇÃO: aceita != atribuída
// ao anúncio nem usada na otimização — o front deve deixar isso explícito.
// "Aceita (resposta da API)" exige PROVA DOCUMENTADA na resposta: Meta events_received>=1;
// TikTok code:0 (request_id isolado não comprova); Google confirma o upload no sucesso. Um 'sent' sem essa prova é
// "Enviado (histórico)" — gravações antigas marcadas sent sem resposta comprovada.
function hasApiProof(platform, pf) {
  if (platform === 'meta') return Number(pf.eventsReceived) >= 1;       // resposta: events_received>=1
  if (platform === 'tiktok') return Number(pf.code) === 0;              // resposta documentada: code:0 (request_id sozinho NÃO comprova)
  if (platform === 'google') return true;                              // sucesso do upload confirmado pela API do Google
  return false;
}
export function summarizeDelivery(docs = []) {
  const base = () => ({ pending: 0, accepted: 0, sentLegacy: 0, ignored: 0, failed: 0, lastSentAt: null, reasons: {} });
  const out = { meta: base(), google: base(), tiktok: base() };
  for (const d of docs) {
    for (const p of PLATFORMS) {
      const pf = d && d[p];
      if (!pf || !pf.status) continue;
      const o = out[p];
      if (pf.status === 'pending') o.pending += 1;
      else if (pf.status === 'sent') {
        if (hasApiProof(p, pf)) o.accepted += 1; else o.sentLegacy += 1; // comprovada vs histórico
        const ts = pf.sentAt ? new Date(pf.sentAt).getTime() : null;
        if (ts && (!o.lastSentAt || ts > o.lastSentAt)) o.lastSentAt = ts;
      } else if (pf.status === 'skipped') {
        o.ignored += 1; const r = pf.reason || 'sem_motivo'; o.reasons[r] = (o.reasons[r] || 0) + 1;
      } else if (pf.status === 'failed') {
        o.failed += 1; const r = pf.reason || 'sem_motivo'; o.reasons[r] = (o.reasons[r] || 0) + 1;
      }
    }
  }
  for (const p of PLATFORMS) out[p].lastSentAt = out[p].lastSentAt ? new Date(out[p].lastSentAt).toISOString() : null;
  return out;
}
