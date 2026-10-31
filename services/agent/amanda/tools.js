/**
 * services/agent/amanda/tools.js
 *
 * Ferramentas que o Claude pode pedir. Só elas escrevem no banco, e cada uma
 * valida no backend. A IA nunca grava direto.
 *
 *   buscar_horarios       → agenda real (findAvailableSlots), filtrada pela especialidade do profissional
 *   reservar_horario      → revalida o slot e cria pré-reserva (padrão) ou agendamento (AMANDA_AGENT_AUTOBOOK=true)
 *   atualizar_contato     → grava dados informados pela família no lead
 *   transferir_para_equipe→ pausa a IA (manualControl) e avisa a recepção com resumo
 *
 * dryRun=true (modo sombra): nenhuma escrita; leituras de agenda continuam reais.
 */

const ESPECIALIDADES = [
  'fonoaudiologia',
  'psicologia',
  'terapia_ocupacional',
  'fisioterapia',
  'musicoterapia',
  'psicopedagogia',
  'neuropsicologia',
  'neuropediatria',
];

// valor do enum Doctor.specialty quando difere da chave de preço
const DOCTOR_SPECIALTY = { neuropediatria: 'neuroped' };

const MOTIVOS_HANDOFF = [
  'pedido_da_pessoa',
  'reclamacao_ou_cobranca',
  'remarcar_ou_cancelar',
  'assunto_clinico_ou_urgencia',
  'duvida_sem_resposta',
  'fora_do_atendimento',
  'outro',
];

const CODIGOS = ['A', 'B', 'C'];

export const TOOL_DEFINITIONS = [
  {
    name: 'buscar_horarios',
    description:
      'Consulta a agenda real da clínica e retorna até 3 horários livres para avaliação na especialidade pedida. Use antes de oferecer qualquer horário. Os horários retornados ficam guardados com códigos (A, B, C) para usar em reservar_horario.',
    input_schema: {
      type: 'object',
      properties: {
        especialidade: { type: 'string', enum: ESPECIALIDADES },
        periodo: { type: 'string', enum: ['manha', 'tarde', 'qualquer'], description: 'Período preferido pela família.' },
        dia_preferido: {
          type: 'string',
          description: 'Opcional. Dia da semana em português (ex.: "segunda") ou data AAAA-MM-DD, se a pessoa pediu.',
        },
      },
      required: ['especialidade', 'periodo'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'reservar_horario',
    description:
      'Reserva um dos horários retornados por buscar_horarios nesta conversa. Use somente depois que a pessoa escolheu um horário. Retorna o status real (pré-reserva ou agendado) e a frase que deve ser usada para a família.',
    input_schema: {
      type: 'object',
      properties: {
        codigo: { type: 'string', enum: CODIGOS, description: 'Código do horário escolhido (A, B ou C).' },
        nome_paciente: { type: 'string', description: 'Nome completo do paciente, se já informado.' },
      },
      required: ['codigo'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'atualizar_contato',
    description:
      'Registra no CRM dados que a pessoa informou. Envie só os campos que mudaram. Use sempre que a pessoa disser nome, idade, queixa, especialidade, período ou que vai pensar.',
    input_schema: {
      type: 'object',
      properties: {
        nome_contato: { type: 'string', description: 'Nome de quem está conversando.' },
        nome_paciente: { type: 'string' },
        idade: { type: 'integer' },
        unidade_idade: { type: 'string', enum: ['anos', 'meses'] },
        data_nascimento: { type: 'string', description: 'AAAA-MM-DD' },
        especialidade: { type: 'string', enum: ESPECIALIDADES },
        queixa: { type: 'string', description: 'Queixa principal em poucas palavras.' },
        periodo: { type: 'string', enum: ['manha', 'tarde'] },
        etapa: { type: 'string', enum: ['pesquisando_preco', 'engajado', 'interessado_agendamento'] },
        observacao: { type: 'string', description: 'Ex.: "vai conversar com o marido e retorna".' },
      },
      required: [],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'transferir_para_equipe',
    description:
      'Passa a conversa para a equipe da recepção e pausa a assistente para este contato. Use nos casos listados nas instruções. O resumo vai para a recepção.',
    input_schema: {
      type: 'object',
      properties: {
        motivo: { type: 'string', enum: MOTIVOS_HANDOFF },
        resumo: {
          type: 'string',
          description: 'O que a pessoa quer e os dados já informados (paciente, idade, especialidade, período), em 1 a 3 frases.',
        },
      },
      required: ['motivo', 'resumo'],
      additionalProperties: false,
    },
    strict: true,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Dependências (carregadas sob demanda para manter os testes leves)
// ─────────────────────────────────────────────────────────────────────────────

let _deps = null;
async function loadDeps() {
  if (_deps) return _deps;
  const [{ default: Leads }, { default: Doctor }, booking, socket] = await Promise.all([
    import('../../../models/Leads.js'),
    import('../../../models/Doctor.js'),
    import('../../amandaBookingService.js'),
    import('../../../config/socket.js'),
  ]);
  _deps = {
    Leads,
    Doctor,
    findAvailableSlots: booking.findAvailableSlots,
    validateSlotStillAvailable: booking.validateSlotStillAvailable,
    autoBookAppointment: booking.autoBookAppointment,
    emitSocketEvent: socket.emitSocketEvent,
  };
  return _deps;
}

const DIAS = {
  domingo: 'domingo', segunda: 'segunda-feira', terca: 'terça-feira', 'terça': 'terça-feira',
  quarta: 'quarta-feira', quinta: 'quinta-feira', sexta: 'sexta-feira', sabado: 'sábado', 'sábado': 'sábado',
};

export function formatSlotPtBr(slot) {
  if (!slot?.date) return '';
  const [y, m, d] = String(slot.date).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const dia = dt.toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  return `${dia} às ${String(slot.time).slice(0, 5)}`;
}

function sameSlot(a, b) {
  return a && b && String(a.doctorId) === String(b.doctorId) && a.date === b.date && String(a.time).slice(0, 5) === String(b.time).slice(0, 5);
}

/** Achata o retorno de findAvailableSlots, mantendo só profissionais da especialidade. */
export async function pickOptions(result, especialidade, deps) {
  if (!result) return [];
  const all = [result.primary, ...(result.alternativesSamePeriod || []), ...(result.alternativesOtherPeriod || [])].filter(Boolean);
  if (!all.length) return [];

  // findAvailableSlots tem um fallback que usa QUALQUER profissional ativo quando
  // não acha a especialidade. Aqui garantimos que só sai horário de quem atende a área.
  const want = DOCTOR_SPECIALTY[especialidade] || especialidade;
  const ids = [...new Set(all.map((s) => String(s.doctorId)))];
  const doctors = await deps.Doctor.find({ _id: { $in: ids } }).select('specialty specialties fullName').lean();
  const ok = new Set(
    doctors
      .filter((d) => d.specialty === want || (Array.isArray(d.specialties) && d.specialties.includes(want)))
      .map((d) => String(d._id)),
  );

  const seen = new Set();
  const out = [];
  for (const s of all) {
    const key = `${s.doctorId}|${s.date}|${s.time}`;
    if (!ok.has(String(s.doctorId)) || seen.has(key)) continue;
    seen.add(key);
    out.push({ doctorId: String(s.doctorId), doctorName: s.doctorName, date: s.date, time: String(s.time).slice(0, 5), specialty: especialidade });
    if (out.length >= CODIGOS.length) break;
  }
  return out.map((s, i) => ({ codigo: CODIGOS[i], ...s }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Executores
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} name
 * @param {object} input
 * @param {{ lead: object, dryRun: boolean, state: object, log: Function, deps?: object }} ctx
 *   state é compartilhado entre chamadas do mesmo turno (ex.: opções no modo sombra).
 * @returns {Promise<object>} resultado serializável para o tool_result
 */
export async function executeTool(name, input, ctx) {
  const deps = ctx.deps || (await loadDeps());
  const leadId = ctx.lead?._id;
  const autobook = String(process.env.AMANDA_AGENT_AUTOBOOK || '').toLowerCase() === 'true';

  switch (name) {
    case 'buscar_horarios': {
      if (!ESPECIALIDADES.includes(input?.especialidade)) return { erro: 'especialidade inválida' };
      const periodo = input.periodo === 'qualquer' ? null : input.periodo;
      let preferredDay = null;
      let preferredDate = null;
      if (input.dia_preferido) {
        const d = String(input.dia_preferido).trim().toLowerCase();
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) preferredDate = d;
        else preferredDay = DIAS[d.split(/[\s-]/)[0]] || null;
      }
      const result = await deps.findAvailableSlots({
        therapyArea: input.especialidade,
        preferredPeriod: periodo,
        preferredDay,
        preferredDate,
        daysAhead: 21,
        maxOptions: 3,
      });
      const opcoes = await pickOptions(result, input.especialidade, deps);
      ctx.state.opcoes = opcoes;

      if (!ctx.dryRun && leadId) {
        await deps.Leads.updateOne(
          { _id: leadId },
          { $set: { pendingSchedulingSlots: { source: 'amanda-agent', options: opcoes, createdAt: new Date() } } },
        );
      }
      if (!opcoes.length) {
        return { horarios: [], observacao: 'Nenhum horário livre encontrado nas próximas 3 semanas para esse filtro. Ofereça outro período ou a equipe.' };
      }
      return {
        horarios: opcoes.map((o) => ({ codigo: o.codigo, quando: formatSlotPtBr(o), profissional: o.doctorName || null })),
      };
    }

    case 'reservar_horario': {
      const opcoes =
        ctx.state.opcoes ||
        (ctx.lead?.pendingSchedulingSlots?.source === 'amanda-agent' ? ctx.lead.pendingSchedulingSlots.options : null) ||
        [];
      const slot = opcoes.find((o) => o.codigo === input?.codigo);
      if (!slot) {
        return { sucesso: false, erro: 'codigo_invalido', observacao: 'Esse código não corresponde a um horário consultado. Use buscar_horarios de novo.' };
      }
      const quando = formatSlotPtBr(slot);

      // Idempotência: mesma escolha repetida não gera nova reserva nem novo aviso.
      if (sameSlot(ctx.lead?.pendingChosenSlot, slot) || sameSlot(ctx.lead?.amandaAgent?.lastBooking, slot)) {
        const status = ctx.lead?.amandaAgent?.lastBooking && sameSlot(ctx.lead.amandaAgent.lastBooking, slot) ? 'agendado' : 'pre_reserva';
        return {
          sucesso: true,
          status,
          quando,
          mensagem_para_familia:
            status === 'agendado'
              ? `A avaliação já está agendada para ${quando}.`
              : `O horário de ${quando} já está pré-reservado, e a equipe confirma com vocês por aqui.`,
        };
      }

      const check = await deps.validateSlotStillAvailable(slot);
      if (!check?.isValid) {
        return { sucesso: false, erro: 'horario_indisponivel', observacao: 'Esse horário acabou de ser ocupado. Use buscar_horarios para oferecer outras opções.' };
      }

      if (ctx.dryRun) {
        return { sucesso: true, status: autobook ? 'agendado' : 'pre_reserva', quando, simulado: true, mensagem_para_familia: `(simulação) ${quando}` };
      }

      const nomePaciente = input.nome_paciente || ctx.lead?.patientInfo?.fullName || null;

      if (autobook && nomePaciente) {
        const r = await deps.autoBookAppointment({
          lead: ctx.lead,
          chosenSlot: slot,
          patientInfo: {
            fullName: nomePaciente,
            birthDate: ctx.lead?.patientInfo?.birthDate || null,
            phone: ctx.lead?.contact?.phone || '',
            email: ctx.lead?.contact?.email || undefined,
          },
        });
        if (r?.success) {
          await deps.Leads.updateOne(
            { _id: leadId },
            { $set: { currentState: 'BOOKED', 'amandaAgent.lastBooking': { ...slot, at: new Date() }, pendingChosenSlot: null } },
          );
          ctx.log('booking_ok', { leadId, slot });
          return { sucesso: true, status: 'agendado', quando, mensagem_para_familia: `A avaliação está agendada para ${quando}.` };
        }
        if (r?.code === 'TIME_CONFLICT') {
          return { sucesso: false, erro: 'horario_indisponivel', observacao: 'Esse horário acabou de ser ocupado. Ofereça outras opções.' };
        }
        ctx.log('booking_error', { leadId, err: r?.error });
        // cai para pré-reserva: a família não fica sem resposta e a equipe resolve
      }

      await deps.Leads.updateOne(
        { _id: leadId },
        { $set: { pendingChosenSlot: { ...slot, at: new Date(), source: 'amanda-agent' }, stage: 'interessado_agendamento' } },
      );
      await safeEmit(deps, 'system:alert', {
        type: 'amanda_pre_reserva',
        leadId: String(leadId),
        title: 'Pré-reserva feita pela Amanda',
        message: `${nomePaciente || ctx.lead?.name || 'Contato'} escolheu ${quando}${slot.doctorName ? ` com ${slot.doctorName}` : ''} (${slot.specialty}). Confirmar com a família.`,
        slot,
        timestamp: new Date(),
      }, ctx.log);
      ctx.log('pre_reserva_ok', { leadId, slot });
      return {
        sucesso: true,
        status: 'pre_reserva',
        quando,
        mensagem_para_familia: `O horário de ${quando} ficou pré-reservado, e a equipe confirma com vocês por aqui.`,
      };
    }

    case 'atualizar_contato': {
      const set = {};
      const i = input || {};
      if (i.nome_contato) set.name = String(i.nome_contato).slice(0, 80);
      if (i.nome_paciente) set['patientInfo.fullName'] = String(i.nome_paciente).slice(0, 120);
      if (Number.isInteger(i.idade) && i.idade >= 0 && i.idade <= 120) {
        set['patientInfo.age'] = i.idade;
        set['patientInfo.ageUnit'] = i.unidade_idade || 'anos';
      }
      if (i.data_nascimento && /^\d{4}-\d{2}-\d{2}$/.test(i.data_nascimento)) set['patientInfo.birthDate'] = i.data_nascimento;
      if (i.especialidade && ESPECIALIDADES.includes(i.especialidade)) set.therapyArea = i.especialidade;
      if (i.queixa) set['autoBookingContext.complaint'] = String(i.queixa).slice(0, 300);
      if (i.periodo === 'manha' || i.periodo === 'tarde') set['autoBookingContext.preferredPeriod'] = i.periodo;
      if (i.etapa && ['pesquisando_preco', 'engajado', 'interessado_agendamento'].includes(i.etapa)) {
        // não rebaixa quem já é paciente
        if (ctx.lead?.stage !== 'paciente') set.stage = i.etapa;
      }
      if (i.observacao) set['amandaAgent.lastNote'] = String(i.observacao).slice(0, 300);

      if (!Object.keys(set).length) return { ok: true, alterado: [] };
      if (!ctx.dryRun && leadId) await deps.Leads.updateOne({ _id: leadId }, { $set: set });
      return { ok: true, alterado: Object.keys(set), simulado: ctx.dryRun || undefined };
    }

    case 'transferir_para_equipe': {
      const motivo = MOTIVOS_HANDOFF.includes(input?.motivo) ? input.motivo : 'outro';
      const resumo = String(input?.resumo || '').slice(0, 600);
      ctx.state.handoff = { motivo, resumo };
      if (ctx.dryRun) return { ok: true, simulado: true };

      await deps.Leads.updateOne(
        { _id: leadId },
        {
          $set: {
            'manualControl.active': true,
            'manualControl.takenOverAt': new Date(),
            'manualControl.takenOverBy': null,
            'manualControl.autoResumeAfter': null,
            currentState: 'HANDOFF',
            'amandaAgent.handoff': { motivo, resumo, at: new Date() },
          },
        },
      );
      await safeEmit(deps, 'lead:manualControl', {
        leadId: String(leadId),
        manualActive: true,
        phone: ctx.lead?.contact?.phone || null,
        reason: 'amanda_handoff',
        motivo,
        resumo,
        timestamp: new Date(),
      }, ctx.log);
      await safeEmit(deps, 'system:alert', {
        type: 'amanda_handoff',
        leadId: String(leadId),
        title: 'Amanda passou uma conversa para a equipe',
        message: `${ctx.lead?.name || 'Contato'}: ${resumo}`,
        motivo,
        timestamp: new Date(),
      }, ctx.log);
      ctx.log('handoff', { leadId, motivo });
      return { ok: true };
    }

    default:
      return { erro: `ferramenta desconhecida: ${name}` };
  }
}

async function safeEmit(deps, event, payload, log) {
  try {
    await deps.emitSocketEvent(event, payload);
  } catch (err) {
    log('emit_error', { event, err: err.message });
  }
}
