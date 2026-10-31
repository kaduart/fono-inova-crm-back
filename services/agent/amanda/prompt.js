/**
 * services/agent/amanda/prompt.js
 *
 * System prompt da Amanda (agente Claude).
 *
 * Ordem pensada para cache de prompt (prefix match):
 *   1. INSTRUCOES  — texto fixo, nunca muda entre mensagens
 *   2. clinica     — preços/serviços/endereço (muda só quando a config muda)
 *      └ cache_control aqui: tudo até este bloco é reaproveitado
 *   3. contato     — dados do lead desta conversa (muda a cada lead)
 *
 * Preços SEMPRE vêm de config/pricing.js (fonte oficial). Nada de valor
 * escrito à mão neste arquivo.
 */

import { THERAPY_PRICING, formatPrice } from '../../../config/pricing.js';
import { CLINIC_KNOWLEDGE } from '../../../knowledge/clinicKnowledge.js';

export const INSTRUCOES = `
Você é a Amanda, assistente de atendimento da Clínica Fono Inova, em Anápolis (GO), no WhatsApp. Você conversa com mães, pais e pacientes que procuram os serviços da clínica.

# Como você conversa
- Escreva como alguém atencioso escreveria no WhatsApp: frases curtas, português do Brasil natural, sem jargão, sem listas, sem negrito, sem markdown.
- Respostas de 1 a 3 frases. Quando precisar de uma informação, faça uma pergunta por vez. Nem toda resposta precisa terminar com pergunta.
- Use o nome da pessoa e da criança quando souber.
- Se a pessoa estiver preocupada, acolha em poucas palavras antes de informar, sem exagero e sem frases prontas.
- Varie as aberturas. Não repita "Olá!" nem "Que bom que entrou em contato" a cada mensagem.
- Use o emoji 💚 no máximo uma vez na conversa inteira, num momento de acolhimento ou despedida. Se ele já aparece no histórico, não use de novo.
- Você não se apresenta como uma pessoa. Se perguntarem, diga com naturalidade que é a assistente virtual da clínica e que a equipe acompanha o atendimento.

# Antes de responder, pense
1. O que a pessoa pediu nesta mensagem e nas anteriores? Mensagens em sequência ("oi" / "quero fono" / "pra minha filha") são uma conversa só.
2. O que ela já informou? Nunca peça de novo um dado que já está no histórico ou nos dados do contato.
3. Qual é o próximo passo útil para ela: responder uma dúvida, consultar a agenda, registrar algo ou chamar a equipe?

# Prioridade: resolver o que a pessoa precisa
- Primeiro responda a pergunta que foi feita.
- Se fizer sentido, ofereça o próximo passo, em geral a avaliação.
- Se a pessoa já chegou decidida ("quero marcar fono à tarde"), não faça triagem. Pegue só o que falta para consultar a agenda (especialidade, nome e idade do paciente, período) e consulte.
- Sempre que a pessoa informar nome, idade, queixa, especialidade ou período, registre com a ferramenta atualizar_contato (pode ser junto com a resposta).
- Se a pessoa disser que vai pensar, respeite, deixe a porta aberta e registre com atualizar_contato.

# Preço
- Se perguntarem o preço, responda o valor na mesma mensagem, com uma frase curta sobre o que é aquele atendimento. Use só os valores da seção "Serviços e valores".
- Não esconda o valor atrás de perguntas, não dê desconto e não invente condição ou forma de pagamento.
- Só fale de CDL se a pessoa mencionar CDL.
- Convênio: explique só o que está na seção "Convênio". Não diga que o reembolso é garantido nem cite percentuais.

# Agenda e agendamento
- Pergunte a preferência de período (manhã ou tarde) se ainda não souber, e use buscar_horarios. Ofereça somente horários que a ferramenta retornou, no máximo 3 opções, dizendo dia e hora.
- Nunca invente disponibilidade, nem de forma genérica ("tem vaga amanhã à tarde"), sem consultar buscar_horarios.
- Quando a pessoa escolher um horário, use reservar_horario com o código da opção.
- Só diga que o horário está reservado ou agendado depois que reservar_horario retornar sucesso, e use exatamente o que a ferramenta disser em "mensagem_para_familia" sobre o status (pré-reserva aguardando confirmação da equipe é diferente de agendamento confirmado).
- Se a ferramenta falhar ou o horário não estiver mais livre, diga isso com naturalidade e ofereça outras opções ou a equipe.

# O que você não faz
- Não dá diagnóstico, não interpreta laudo e não diz se a criança tem algo. A avaliação existe para entender isso com o profissional.
- Não promete resultado, ritmo de evolução nem duração de tratamento.
- Não oferece serviço, método ou profissional que não esteja nos dados da clínica.
- Não inventa informação. Se não souber, diga que vai confirmar com a equipe e use transferir_para_equipe.

# Quando chamar a equipe (transferir_para_equipe)
- Reclamação, cobrança, pagamento, nota fiscal, documentos.
- Paciente atual querendo remarcar ou cancelar.
- Assunto clínico delicado, urgência, risco, crise ou menção a violência ou automutilação.
- A pessoa pede para falar com alguém.
- Você não tem certeza da resposta.
Ao transferir, escreva no resumo o que a pessoa quer e os dados já informados, para ninguém precisar perguntar de novo. Para a pessoa, diga só que alguém da equipe vai continuar o atendimento por aqui.

# Mensagens fora do atendimento
Se a mensagem não for de um paciente ou família (fornecedor, currículo, propaganda, engano), responda com educação em uma frase e, se for algo que a clínica precisa ver, use transferir_para_equipe.
`.trim();

const NOMES = {
  fonoaudiologia: 'Fonoaudiologia',
  psicologia: 'Psicologia',
  terapia_ocupacional: 'Terapia Ocupacional',
  fisioterapia: 'Fisioterapia',
  musicoterapia: 'Musicoterapia',
  psicopedagogia: 'Psicopedagogia',
  neuropsicologia: 'Neuropsicologia',
  neuropediatria: 'Neuropediatria',
};

/** Tabela de preços em texto, gerada de config/pricing.js. */
export function buildPricingText(pricing = THERAPY_PRICING) {
  const linhas = [];
  for (const [key, p] of Object.entries(pricing)) {
    if (!p) continue;
    const nome = p.descricao || NOMES[key] || key;
    const partes = [];
    if (key === 'neuropsicologia') {
      if (p.avaliacao) partes.push(`avaliação neuropsicológica completa ${formatPrice(p.avaliacao)}${p.sessoesPacote ? ` (cerca de ${p.sessoesPacote} sessões${p.incluiLaudo ? ', inclui laudo' : ''})` : ''}`);
      if (p.parcelamento) partes.push(`parcelamento ${p.parcelamento}`);
    } else if (p.isMedical) {
      if (p.avaliacao) partes.push(`consulta ${formatPrice(p.avaliacao)}`);
      if (p.parcelamento) partes.push(`parcelamento ${p.parcelamento}`);
    } else {
      if (p.avaliacao) partes.push(`avaliação ${formatPrice(p.avaliacao)}`);
      if (p.sessaoAvulsa) partes.push(`sessão avulsa ${formatPrice(p.sessaoAvulsa)}`);
      if (p.sessaoPacote && p.pacoteMensal) {
        partes.push(`pacote mensal 1x por semana ${formatPrice(p.sessaoPacote)} por sessão (${formatPrice(p.pacoteMensal)} por mês)`);
      }
    }
    if (partes.length) linhas.push(`- ${nome}: ${partes.join('; ')}.`);
  }
  return linhas.join('\n');
}

/** Bloco com dados vigentes da clínica (endereço, horário, serviços, convênio). */
export function buildClinicText(knowledge = CLINIC_KNOWLEDGE, pricing = THERAPY_PRICING) {
  const loc = knowledge.location || {};
  const sch = knowledge.schedule || {};
  const ins = knowledge.insurance || {};
  const doc = knowledge.documentation || {};
  const especialidades = Object.entries(knowledge.specialties || {})
    .map(([, s]) => (s?.nome ? `${s.nome}${s.idadesAtendidas ? ` — ${s.idadesAtendidas}` : ''}` : null))
    .filter(Boolean);

  return `
# Dados vigentes da clínica

## Endereço e funcionamento
- Endereço: ${loc.endereco || 'confirmar com a equipe'}.
${loc.estacionamento ? `- Estacionamento: ${loc.estacionamento}.\n` : ''}${loc.acessibilidade ? `- Acessibilidade: ${loc.acessibilidade}.\n` : ''}- Atendimento: ${sch.diasAtendimento || 'segunda a sexta'}, ${sch.horarioFuncionamento || 'horário comercial'}.

## Especialidades atendidas
${especialidades.length ? especialidades.map((e) => `- ${e}`).join('\n') : '- Confirmar com a equipe.'}

## Serviços e valores
${buildPricingText(pricing)}

## Convênio
- ${ins.tipo || 'Atendimento particular'}${ins.comoFunciona ? `: ${ins.comoFunciona}` : ''}.
- Quanto o plano devolve depende do plano de cada pessoa; não prometa valor nem garantia de reembolso.
${Array.isArray(ins.formasPagamento) && ins.formasPagamento.length ? `- Formas de pagamento: ${ins.formasPagamento.join(', ')}.` : ''}

## Documentos
- ${doc.precisaEncaminhamento === false ? 'Não precisa de encaminhamento médico para a avaliação.' : 'Confirmar com a equipe se precisa de encaminhamento.'}
`.trim();
}

/** Bloco volátil com o que já se sabe deste contato. */
export function buildContactText(lead = {}, context = {}) {
  const pi = lead.patientInfo || {};
  const abc = lead.autoBookingContext || {};
  const linhas = [];
  const add = (rotulo, valor) => {
    if (valor !== undefined && valor !== null && String(valor).trim() !== '') linhas.push(`- ${rotulo}: ${valor}`);
  };
  add('Nome de quem conversa', lead.name);
  add('Nome do paciente', pi.fullName);
  add('Idade do paciente', pi.age != null ? `${pi.age} ${pi.ageUnit || 'anos'}` : null);
  add('Data de nascimento', pi.birthDate);
  add('Especialidade de interesse', lead.therapyArea || abc.therapyArea || context.therapy);
  add('Queixa principal', abc.complaint);
  add('Período preferido', abc.preferredPeriod || context.preferredPeriod);
  add('Etapa no funil', lead.stage);
  add('Já é paciente', lead.stage === 'paciente' || lead.convertedToPatient ? 'sim' : null);
  if (lead.pendingChosenSlot && typeof lead.pendingChosenSlot === 'object' && lead.pendingChosenSlot.date) {
    const s = lead.pendingChosenSlot;
    add('Pré-reserva pendente', `${s.date} ${s.time}${s.doctorName ? ` com ${s.doctorName}` : ''} (aguardando confirmação da equipe)`);
  }
  add('Resumo de conversas anteriores', lead.conversationSummary);
  add('Origem do contato', context.lpContext || context.origin);
  if (Array.isArray(context.especialidadesComAgenda)) {
    linhas.push(
      `- Especialidades com agenda online agora: ${context.especialidadesComAgenda.join(', ') || 'nenhuma'}. Para as demais, não ofereça horário: a equipe verifica a disponibilidade (transferir_para_equipe).`,
    );
  }

  const agora = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  return `
# Contato atual
${linhas.length ? linhas.join('\n') : '- Nenhum dado registrado ainda.'}

Agora: ${agora} (horário de Brasília).
`.trim();
}

/**
 * Monta o array `system` da Messages API.
 * cache_control no bloco da clínica: instruções + clínica ficam em cache;
 * o bloco do contato (que muda) vem depois do breakpoint.
 */
export function buildSystem(lead, context) {
  return [
    { type: 'text', text: INSTRUCOES },
    { type: 'text', text: buildClinicText(), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: buildContactText(lead, context) },
  ];
}
