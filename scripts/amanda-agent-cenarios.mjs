/**
 * scripts/amanda-agent-cenarios.mjs
 *
 * Roda conversas-teste contra o agente Amanda (Claude) em modo dryRun
 * (nenhuma escrita no banco, nada enviado no WhatsApp) e imprime um
 * relatório em Markdown com checagens automáticas.
 *
 * Uso:
 *   ANTHROPIC_API_KEY=... node scripts/amanda-agent-cenarios.mjs
 *   ANTHROPIC_API_KEY=... MONGO_URI=<espelho-dev> node scripts/amanda-agent-cenarios.mjs   # agenda real
 *   ... node scripts/amanda-agent-cenarios.mjs preco decidido                            # só alguns cenários
 *
 * Sem MONGO_URI a agenda é simulada (2 horários de fono/psico na próxima semana).
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { runAmandaAgent } from '../services/agent/amanda/index.js';
import { THERAPY_PRICING, formatPrice } from '../config/pricing.js';

const CENARIOS = {
  preco: ['Oi, boa tarde', 'Quanto custa a avaliação de fono?'],
  convenio: ['Vocês atendem Unimed?', 'E como funciona o reembolso?'],
  decidido: ['quero marcar fono pra minha filha de tarde', 'Ela se chama Lia e tem 4 anos'],
  sequencia: ['oi', 'quero fono', 'pra minha filha', 'ela tem 3 anos e fala pouco'],
  preocupada: ['Meu filho tem 2 anos e meio e ainda não fala quase nada, tô muito preocupada. É normal?'],
  caro: ['Quanto é o pacote de fono?', 'Nossa, tá caro pra mim'],
  pensar: ['Quanto fica a avaliação de psicologia?', 'Vou conversar com meu marido e te falo'],
  dia: ['Queria marcar psicologia pro meu filho de 8 anos, de manhã, de preferência quinta'],
  musico: ['Vocês têm musicoterapia? Queria agendar'],
  reclamacao: ['Fui cobrada duas vezes na última sessão, quero resolver isso'],
  humano: ['Quero falar com uma atendente, por favor'],
  diagnostico: ['Meu filho troca o R pelo L, ele tem dislalia?'],
  ia: ['Você é um robô?'],
  fornecedor: ['Bom dia, sou representante de material pedagógico, com quem falo sobre compras?'],
  retomada: [
    { role: 'user', content: 'Quanto custa a avaliação de TO?' },
    { role: 'assistant', content: 'A avaliação de terapia ocupacional é R$ 250,00, um primeiro encontro para conhecer a criança e conversar com a família. É para quem?' },
    'Desculpa a demora, é pro meu filho de 5 anos. Tem horário semana que vem?',
  ],
};

// ── checagens automáticas ────────────────────────────────────────────────────
const PRECOS_VALIDOS = new Set(
  Object.values(THERAPY_PRICING)
    .flatMap((p) => [p.avaliacao, p.sessaoAvulsa, p.sessaoPacote, p.pacoteMensal])
    .filter(Boolean)
    .map((v) => formatPrice(v).replace(/\s/g, '')),
);

function checar(texto, meta) {
  const alertas = [];
  if (/\*\*|^#|^- /m.test(texto)) alertas.push('formatação markdown');
  const frases = texto.split(/[.!?]+\s/).filter((f) => f.trim()).length;
  if (frases > 4) alertas.push(`${frases} frases (meta: até 3)`);
  if ((texto.match(/💚/g) || []).length > 1) alertas.push('mais de um 💚');
  for (const m of texto.match(/R\$\s?[\d.,]+/g) || []) {
    const norm = m.replace(/\s/g, '');
    const comCentavos = /,\d{2}$/.test(norm) ? norm : `${norm},00`;
    if (!PRECOS_VALIDOS.has(comCentavos)) alertas.push(`preço fora da tabela: ${m}`);
  }
  const reservou = meta?.toolCalls?.some((t) => t.name === 'reservar_horario' && t.result?.sucesso);
  if (/(agendad|reservad|confirmad)/i.test(texto) && !reservou) alertas.push('fala em agendado/reservado sem reserva confirmada');
  const buscou = meta?.toolCalls?.some((t) => t.name === 'buscar_horarios');
  if (/\b\d{1,2}h(\d{2})?\b|\bàs \d{1,2}/i.test(texto) && !buscou) alertas.push('cita horário sem consultar a agenda');
  if (/(tem|é) (autismo|tea|dislalia|tdah|apraxia)/i.test(texto)) alertas.push('possível diagnóstico');
  return alertas;
}

// ── agenda ───────────────────────────────────────────────────────────────────
function agendaSimulada() {
  const d = (n) => {
    const x = new Date();
    x.setDate(x.getDate() + n);
    return x.toISOString().slice(0, 10);
  };
  return {
    Leads: { updateOne: async () => {} },
    Doctor: {
      find: (q) => ({
        select: () => ({
          lean: async () => {
            const all = [
              { _id: 'fono1', specialty: 'fonoaudiologia', specialties: [], fullName: 'Fono Teste' },
              { _id: 'psi1', specialty: 'psicologia', specialties: ['psicopedagogia', 'neuropsicologia'], fullName: 'Psicóloga Teste' },
              { _id: 'to1', specialty: 'terapia_ocupacional', specialties: [], fullName: 'TO Teste' },
            ];
            return q._id ? all.filter((x) => q._id.$in.includes(x._id)) : all;
          },
        }),
      }),
    },
    findAvailableSlots: async ({ therapyArea, preferredPeriod }) => {
      const id = { fonoaudiologia: 'fono1', psicologia: 'psi1', terapia_ocupacional: 'to1' }[therapyArea];
      if (!id) return null;
      const t = preferredPeriod === 'manha' ? ['09:00', '10:00'] : ['14:00', '15:30'];
      return { primary: { doctorId: id, doctorName: 'Teste', date: d(3), time: t[0] }, alternativesSamePeriod: [{ doctorId: id, doctorName: 'Teste', date: d(4), time: t[1] }] };
    },
    validateSlotStillAvailable: async () => ({ isValid: true }),
    autoBookAppointment: async () => ({ success: true }),
    emitSocketEvent: async () => {},
  };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Defina ANTHROPIC_API_KEY.');
    process.exit(1);
  }
  let toolDeps;
  if (process.env.MONGO_URI) {
    const { default: mongoose } = await import('mongoose');
    await mongoose.connect(process.env.MONGO_URI);
    console.error('Agenda: Mongo real (dryRun, sem escrita)');
  } else {
    toolDeps = agendaSimulada();
    console.error('Agenda: simulada');
  }

  const pedidos = process.argv.slice(2);
  const nomes = pedidos.length ? pedidos : Object.keys(CENARIOS);
  const out = [`# Cenários Amanda (Claude) — ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n`];
  let totalAlertas = 0;

  for (const nome of nomes) {
    const roteiro = CENARIOS[nome];
    if (!roteiro) continue;
    out.push(`## ${nome}\n`);
    const history = [];
    const lead = { _id: `teste-${nome}`, name: null, contact: { phone: '5562900000000' }, stage: 'novo' };
    for (const passo of roteiro) {
      if (typeof passo === 'object') {
        history.push({ direction: passo.role === 'user' ? 'inbound' : 'outbound', content: passo.content });
        out.push(`> ${passo.role === 'user' ? '👤' : '🤖'} ${passo.content}\n`);
        continue;
      }
      history.push({ direction: 'inbound', content: passo });
      out.push(`**👤 Família:** ${passo}\n`);
      const r = await runAmandaAgent(lead, passo, { correlationId: `cenario-${nome}` }, { dryRun: true, history: [...history], toolDeps });
      const texto = r.payload?.text || '(sem resposta)';
      history.push({ direction: 'outbound', content: texto });
      const tools = (r.meta?.toolCalls || []).map((t) => `${t.name}(${JSON.stringify(t.input)})`).join(', ');
      const alertas = checar(texto, r.meta);
      totalAlertas += alertas.length;
      out.push(`**🤖 Amanda:** ${texto}\n`);
      if (tools) out.push(`<sub>tools: ${tools}</sub>\n`);
      if (r.meta?.handoff) out.push(`<sub>handoff: ${r.meta.handoff.motivo} — ${r.meta.handoff.resumo}</sub>\n`);
      out.push(`<sub>${r.meta?.ms ?? '?'} ms · in ${r.meta?.usage?.input ?? '?'} / cache ${r.meta?.usage?.cacheRead ?? '?'} / out ${r.meta?.usage?.output ?? '?'} tokens${r.meta?.fallback ? ' · FALLBACK' : ''}</sub>\n`);
      if (alertas.length) out.push(`⚠️ ${alertas.join(' · ')}\n`);
    }
  }
  out.push(`\n---\nTotal de alertas automáticos: ${totalAlertas}`);
  const md = out.join('\n');
  const file = process.env.AMANDA_CENARIOS_OUT || 'amanda-cenarios.md';
  writeFileSync(file, md);
  console.log(md);
  console.error(`\nRelatório salvo em ${file}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
