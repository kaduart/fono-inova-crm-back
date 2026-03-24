// orchestrators/WhatsAppOrchestrator.js
// FSM Determinística + Context Stack + Handlers preservados do V7
// IA = APENAS NLU (interpretar texto). Caminho = 100% determinístico.

import { getTherapyPricing, getPriceText, buildValueFirstResponse, getPriceComparison } from '../config/pricing.js';
import { determinePricingStrategy } from '../services/intelligence/pricingStrategy.js';
import { leadRepository } from '../infrastructure/persistence/LeadRepository.js';
import Leads from '../models/Leads.js';
import Message from '../models/Message.js';
import { perceptionService } from '../perception/PerceptionService.js';
import { findAvailableSlots, autoBookAppointment, buildSlotOptions } from '../services/amandaBookingService.js';
import { getLatestInsights } from '../services/amandaLearningService.js';
import { enrichLeadContext } from '../services/leadContext.js';
import {
  STATES,
  advanceState,
  jumpToState,
  detectGlobalIntent,
  suspendState,
  resumeState,
  incrementRetry,
  getResumeHint,
  isAutoResume,
} from '../services/StateMachine.js';

// Helper: extrai número inteiro de um objeto de idade { age: N, unit: 'anos' } ou número direto
function resolveAgeNumber(age) {
  if (age === null || age === undefined) return null;
  if (typeof age === 'object' && age.age !== undefined) return age.age;
  return typeof age === 'number' ? age : parseInt(age, 10) || null;
}

// Helper: formata idade para exibição
function formatAge(age) {
  if (age === null || age === undefined) return null;
  if (typeof age === 'object' && age.age !== undefined) {
    return `${age.age} ${age.unit || 'anos'}`;
  }
  return `${age} anos`;
}
import Logger from '../services/utils/Logger.js';
import {
  THERAPY_DATA,
  detectAllTherapies,
  detectTherapyBySymptoms,
  normalizeTherapyTerms,
  detectNegativeScopes,
  pickPrimaryTherapy,
  isAskingAboutEquivalence,
  getTDAHResponse,
} from '../utils/therapyDetector.js';
import { extractName, extractBirth, extractAgeFromText, extractPeriodFromText, extractPreferredDate } from '../utils/patientDataExtractor.js';
import {
  deriveFlagsFromText,
  detectMedicalSpecialty,
  validateServiceAvailability,
  MEDICAL_SPECIALTIES_MAP,
  resolveTopicFromFlags,
} from '../utils/flagsDetector.js';
import { getSpecialHoursResponse, buildSystemPrompt, buildUserPrompt } from '../utils/amandaPrompt.js';
import { callAI } from '../services/IA/Aiproviderservice.js';
import { buildMessageContext } from '../services/messageContextBuilder.js';
import { parseIncomingMessage } from '../services/whatsappLinkService.js';
import { extractLPContext } from '../utils/lpContextParser.js';
import { enforce } from '../services/EnforcementLayer.js';

const logger = new Logger('WhatsAppOrchestrator');

export default class WhatsAppOrchestrator {
  constructor() {
    this.logger = new Logger('WhatsAppOrchestrator');
    this.insightsCache = null;
    this.cacheTime = 0;
  }

  // ═══════════════════════════════════════════
  // PONTO DE ENTRADA PRINCIPAL
  // ═══════════════════════════════════════════

  async process({ lead, message, context: providedContext = null, services = {} }) {
    try {
      const leadId = lead?._id;
      const text = (message?.content || message?.text || '').trim();

      if (!leadId) {
        this.logger.warn('PROCESS_MISSING_LEAD_ID', { from: message?.from });
        return { command: 'NO_REPLY' };
      }

      // ══ CIRCUIT BREAKERS (antes de tudo) ══
      if (this._isHardStopMessage(text)) {
        return { command: 'NO_REPLY' };
      }

      if (this._isCancellation(text)) {
        await this._clearState(leadId);
        return this._reply('Entendido! Cancelado aqui pra você 😊');
      }

      // ══ CARREGA ESTADO ATUAL DO LEAD (fonte única de verdade) ══
      const freshLead = await Leads.findById(leadId).lean();
      if (!freshLead) return { command: 'NO_REPLY' };

      const currentState = freshLead.currentState || STATES.IDLE;
      const stateData = freshLead.stateData || {};

      // ══ RESET DE retryCount POR SESSÃO ══
      // Se o lead ficou sem interagir por mais de 4 horas, zera o retryCount.
      // Isso evita que um retryCount acumulado de ontem cause HANDOFF imediato
      // quando o lead retorna com "Oi" no dia seguinte.
      if ((freshLead.retryCount || 0) > 0 && freshLead.lastInteractionAt) {
        const hoursSinceLastInteraction = (Date.now() - new Date(freshLead.lastInteractionAt).getTime()) / (1000 * 60 * 60);
        if (hoursSinceLastInteraction > 4) {
          this.logger.info('V8_RETRY_RESET_SESSION', { leadId, retryCount: freshLead.retryCount, hoursSince: hoursSinceLastInteraction.toFixed(1) });
          await Leads.updateOne({ _id: leadId }, { $set: { retryCount: 0 } });
          freshLead.retryCount = 0;
        }
      }

      this.logger.info('V8_PROCESS', { leadId, currentState, text: text.substring(0, 80), phone: freshLead.contact?.phone || freshLead.phone || freshLead.whatsapp });

      // ══ INSIGHTS DE CONVERSAS REAIS (cache 1h) ══
      const insights = await this._getInsights();

      // ══ PIPELINE DE INTELIGÊNCIA (roda para toda mensagem) ══
      // Todos os detectores são chamados aqui, antes de qualquer decisão de estado.
      // O FSM decide com contexto rico, não no escuro.
      const ctx = await buildMessageContext(text, freshLead, currentState, stateData, insights);
      const { flags, globalIntent, manualIntent } = ctx;
      
      // 🆕 Parse de mensagem para detectar origem (WhatsApp link, GMB, etc)
      const parsedMessage = parseIncomingMessage(text, freshLead.contact?.phone);
      if (parsedMessage?.detectedSpecialty || parsedMessage?.extractedData?.source) {
        this.logger.info('V8_MESSAGE_ORIGIN_DETECTED', { 
          leadId, 
          specialty: parsedMessage.detectedSpecialty,
          source: parsedMessage.extractedData?.source 
        });
        
        // Salvar origem detectada no lead se ainda não estiver definida
        if (!freshLead.therapyArea && parsedMessage.detectedSpecialty) {
          await Leads.findByIdAndUpdate(leadId, {
            $set: { 
              therapyArea: parsedMessage.detectedSpecialty,
              'metaTracking.source': parsedMessage.extractedData?.source || 'website'
            }
          });
        }
      }
      
      // Armazena ctx completo: leadData, canOfferScheduling, promptMode, flags, etc.
      this.currentContext = { ...ctx, lead: freshLead, state: currentState, stateData, insights, parsedMessage };

      // ══ PRÉ-ROUTING: intenções que cortam qualquer estado ══

      // Pedido de humano — a detecção existia no flagsDetector mas nunca roteava
      if (flags.wantsHumanAgent && currentState !== STATES.HANDOFF) {
        this.logger.info('V8_HUMAN_REQUESTED', { leadId, state: currentState });
        await jumpToState(leadId, STATES.HANDOFF);
        return this._reply(
          'Claro! 💚 Vou chamar um(a) atendente pra te ajudar pessoalmente.\n\nAguarda só um minutinho...',
          { skipEnrichment: true }
        );
      }

      // Lead desistindo — resposta empática antes de escalar
      if (flags.givingUp && currentState !== STATES.HANDOFF) {
        this.logger.info('V8_GIVING_UP', { leadId, state: currentState });
        await jumpToState(leadId, STATES.HANDOFF);
        return this._reply(
          'Entendo você 💚\n\nSe quiser, posso pedir pra alguém da nossa equipe te chamar pra conversar com mais calma.',
          { skipEnrichment: true }
        );
      }

      // Lead que já agendou retornando — encerra o fluxo sem perguntar de novo
      if (flags.alreadyScheduled && currentState !== STATES.BOOKED) {
        this.logger.info('V8_ALREADY_SCHEDULED', { leadId, state: currentState });
        await jumpToState(leadId, STATES.BOOKED);
        return this._reply('Ótimo! Seu agendamento já está confirmado 💚\n\nQualquer dúvida antes do dia, pode me chamar!');
      }

      // Currículo/parceria — não é lead, não iniciar triagem
      if (flags.wantsPartnershipOrResume) {
        this.logger.info('V8_NOT_A_LEAD_JOB', { leadId });
        return this._reply(
          'Que legal seu interesse! 😊\n\nPara parcerias e oportunidades, o melhor caminho é enviar diretamente para o nosso e-mail ou falar com nossa equipe administrativa. Eles vão te orientar melhor! 💚'
        );
      }

      // Agradecimento — responde e permanece no estado atual
      if (flags.saysThanks && ![STATES.HANDOFF, STATES.BOOKED].includes(currentState)) {
        this.logger.info('V8_THANKS', { leadId, state: currentState });
        return this._reply('De nada! 😊 Qualquer coisa é só chamar 💚', { skipEnrichment: true });
      }

      // Despedida — responde e permanece (lead pode voltar)
      if (flags.saysBye && ![STATES.HANDOFF, STATES.BOOKED].includes(currentState)) {
        this.logger.info('V8_BYE', { leadId, state: currentState });
        return this._reply('Até logo! 😊 Quando precisar, estarei por aqui 💚', { skipEnrichment: true });
      }

      // Horário especial — já existe getSpecialHoursResponse() mas nunca era chamada
      if (flags.asksAboutAfterHours && !globalIntent) {
        this.logger.info('V8_AFTER_HOURS', { leadId });
        return this._reply(getSpecialHoursResponse(), { skipEnrichment: true });
      }

      // Reagendamento/cancelamento — precisa de humano (não temos sistema de cancelamento via bot)
      if ((flags.wantsReschedule || flags.wantsCancel) && currentState !== STATES.HANDOFF) {
        this.logger.info('V8_RESCHEDULE_OR_CANCEL', { leadId, wantsReschedule: flags.wantsReschedule, wantsCancel: flags.wantsCancel });
        await jumpToState(leadId, STATES.HANDOFF);
        return this._reply(
          'Claro! Para reagendamentos e cancelamentos preciso chamar um(a) atendente para te ajudar direitinho 💚\n\nAguarda só um momento...',
          { skipEnrichment: true }
        );
      }

      // Paciente adulto — clínica é especializada em infantil/adolescente
      // Critério conservador: "para mim" + sem menção a filho/criança, ou declaração explícita de adulto
      const isAdultPatient =
        !flags.mentionsChild &&
        !flags.mentionsBaby &&
        (
          /\b(é\s+para\s+mim|pra\s+mim\s+mesmo[a]?|sou\s+eu\s+(mesmo[a]?|que\s+preciso|que\s+quero)|eu\s+que\s+(preciso|quero|busco)|sou\s+adulto[a]?)\b/i.test(text) ||
          (flags.mentionsAdult && flags.ageGroup === 'adulto')
        );

      if (isAdultPatient && ![STATES.HANDOFF, STATES.BOOKED].includes(currentState)) {
        this.logger.info('V8_ADULT_PATIENT', { leadId });

        // Exceção: Neuropsicologia atende todas as idades (incluindo adultos)
        const isNeuroContext =
          /neuropsico|avalia[çc][aã]o\s*neuropsicol/i.test(text) ||
          lead?.therapyArea === 'neuropsicologia' ||
          lead?.therapyArea === 'neuropsychological';

        if (isNeuroContext) {
          // Neuropsicologia atende adultos — direciona diretamente para coleta de objetivo
          this.logger.info('V8_ADULT_NEURO_EXCEPTION', { leadId });
          await this._saveTherapy(leadId, { id: 'neuropsychological', name: 'Neuropsicologia' });
          await jumpToState(leadId, STATES.COLLECT_NEURO_TYPE, { therapy: 'neuropsychological', isAdult: true });
          return this._reply(
            'Sim, realizamos **Avaliação Neuropsicológica para todas as idades**, incluindo adultos 💚\n\n' +
            'Para te ajudar melhor: você está buscando um *laudo neuropsicológico* (avaliação completa com relatório) ou *acompanhamento terapêutico* (sessões regulares)?',
            { skipEnrichment: true }
          );
        } else {
          // Para as demais especialidades, menciona que neuro atende adultos antes de redirecionar
          await jumpToState(leadId, STATES.HANDOFF);
          return this._reply(
            'Oi! 😊\n\nAqui na Fono Inova somos especializados em atendimento **infantil e adolescentes**.\n\n💡 Porém, realizamos **Avaliação Neuropsicológica para todas as idades**, incluindo adultos!\n\nSe for para avaliação neuropsicológica (laudo de TDAH, autismo, dificuldades cognitivas etc.), posso te ajudar agora 💚\n\nPara outras especialidades em adulto, vou chamar alguém da equipe!',
            { skipEnrichment: true }
          );
        }
      }

      // ══ 1. DETECÇÃO DE INTERRUPÇÃO GLOBAL ══
      // Verifica se o lead fez uma pergunta que precisa ser respondida ANTES de continuar
      const isInFlow = ![STATES.IDLE, STATES.GREETING, STATES.BOOKED, STATES.HANDOFF].includes(currentState);

      // 🔥 CORREÇÃO: Interrupção funciona em QUALQUER estado (incluindo IDLE)
      // exceto quando já está interrompido
      if (globalIntent && currentState !== STATES.INTERRUPTED) {
        this.logger.info('V8_GLOBAL_INTERRUPT', { leadId, intent: globalIntent, suspendedState: currentState, wasInFlow: isInFlow });
        
        // Se está em fluxo, suspende. Se está em IDLE/GREETING, apenas responde e continua de onde estava
        if (isInFlow) {
          await suspendState(leadId, currentState, stateData, globalIntent);
        }
        
        const interruptResponse = await this._handleGlobalIntent(globalIntent, freshLead);
        
        // Se está em fluxo, dá hint de retomada. Se não, apenas responde
        if (isInFlow) {
          const resumeHint = getResumeHint(currentState);
          return this._reply(`${interruptResponse}\n\n${resumeHint}`);
        } else {
          // Em IDLE/GREETING: responde a pergunta e continua o processamento normal
          return this._reply(interruptResponse);
        }
      }

      // ══ 1b. MANUAL INTENT (fallback quando globalIntent não detectou) ══
      // detectManualIntent cobre padrões mais simples: endereço, planos, saudação, despedida
      if (!globalIntent && manualIntent && currentState !== STATES.INTERRUPTED) {
        const { intent } = manualIntent;
        if (intent === 'address') {
          this.logger.info('V8_MANUAL_INTENT_ADDRESS', { leadId });
          const resp = await this._handleGlobalIntent('LOCATION_QUERY', freshLead);
          if (isInFlow) {
            await suspendState(leadId, currentState, stateData, 'LOCATION_QUERY');
            return this._reply(`${resp}\n\n${getResumeHint(currentState)}`);
          }
          return this._reply(resp);
        }
        if (intent === 'plans') {
          this.logger.info('V8_MANUAL_INTENT_PLANS', { leadId });
          const resp = await this._handleGlobalIntent('INSURANCE_QUERY', freshLead);
          if (isInFlow) {
            await suspendState(leadId, currentState, stateData, 'INSURANCE_QUERY');
            return this._reply(`${resp}\n\n${getResumeHint(currentState)}`);
          }
          return this._reply(resp);
        }
        if (intent === 'price_generic') {
          this.logger.info('V8_MANUAL_INTENT_PRICE_GENERIC', { leadId });
          const resp = await this._handleGlobalIntent('PRICE_QUERY', freshLead);
          if (isInFlow) {
            await suspendState(leadId, currentState, stateData, 'PRICE_QUERY');
            return this._reply(`${resp}\n\n${getResumeHint(currentState)}`);
          }
          return this._reply(resp);
        }
        // 'greeting' e 'goodbye' já são tratados por flags.saysThanks/saysBye acima
      }

      // ══ 2. RETOMADA PÓS-INTERRUPÇÃO ══
      if (currentState === STATES.INTERRUPTED) {
        const stack = freshLead.stateStack || [];
        const lastSuspended = stack.length > 0 ? stack[stack.length - 1] : null;

        if (lastSuspended) {
          // Verifica se o lead perguntou OUTRA coisa lateral (interrupção em cima de interrupção)
          const anotherGlobal = detectGlobalIntent(text);
          if (anotherGlobal) {
            const interruptResponse = await this._handleGlobalIntent(anotherGlobal, freshLead);
            const resumeHint = getResumeHint(lastSuspended.state);
            return this._reply(`${interruptResponse}\n\n${resumeHint}`);
          }

          // Tenta retomada automática (ex: mandou um nome quando estava em COLLECT_NAME)
          if (isAutoResume(text, lastSuspended.state)) {
            const resumed = await resumeState(leadId);
            if (resumed) {
              // Processa a mensagem no estado restaurado
              return this._processState(resumed.state, text, resumed.lead, resumed.data, services);
            }
          }

          // Se não é intent lateral nem resposta direta, tenta retomar mesmo assim
          // (provavelmente o lead respondeu "ok" ou "entendi")
          if (/^(ok|entendi|sim|voltando|e sobre|agendamento|horário|beleza|tá|ta)/i.test(text.trim())) {
            const resumed = await resumeState(leadId);
            if (resumed) {
              const hint = getResumeHint(resumed.state);
              return this._reply(hint);
            }
          }

          // Fallback: repete o gancho de retomada
          const hint = getResumeHint(lastSuspended.state);
          return this._reply(`Pra tirar qualquer dúvida, tô aqui! 💚\n\n${hint}`);
        }

        // Stack vazia = volta pro IDLE
        await jumpToState(leadId, STATES.IDLE);
        return this._processState(STATES.IDLE, text, freshLead, {}, services);
      }

      // ══ 3. FSM DETERMINÍSTICA ══
      return this._processState(currentState, text, freshLead, stateData, services, ctx);

    } catch (error) {
      this.logger.error('V8_CRITICAL_ERROR', { error: error.message, stack: error.stack });
      return this._reply('Ops, deu um probleminha técnico aqui! 😅 Pode repetir sua mensagem?');
    }
  }

  // ═══════════════════════════════════════════
  // FSM: SWITCH DETERMINÍSTICO
  // ═══════════════════════════════════════════

  async _processState(state, text, lead, stateData, services = {}, ctx = null) {
    const leadId = lead._id;
    const flags = ctx?.flags || {};

    this.logger.info('V8_STATE_ENTRY', { leadId, state, textLen: text.length, text: text.substring(0, 60) });

    switch (state) {
      // ── ESTADO INICIAL ──
      case STATES.IDLE:
      case STATES.GREETING: {
        // 🆕 TRACKING: Detectar origem GMB (se veio de post do Google)
        if (text.includes('Vi o post sobre') || text.includes('Vi sobre')) {
          await Leads.updateOne({ _id: leadId }, { 
            $set: { 
              source: 'gmb', 
              utmSource: 'google_business_profile',
              gmbDetectedAt: new Date()
            } 
          });
          this.logger.info('V8_GMB_SOURCE_DETECTED', { leadId, text: text.substring(0, 60) });
        }
        
        // Usa ctx.leadData como fonte única — resolve fragmentação entre patientInfo, stateData, qualificationData
        const hasExistingTherapy = ctx.leadData?.therapy;
        const hasExistingName = ctx.leadData?.name;
        const hasExistingComplaint = ctx.leadData?.complaint;

        if (hasExistingTherapy) {
          this.logger.info('V8_RETURNING_LEAD_HAS_DATA', { leadId, therapyArea: hasExistingTherapy, hasName: !!hasExistingName, hasComplaint: !!hasExistingComplaint });

          // ── WARM RECALL: enriquece contexto apenas se lead ficou afastado ────
          // Evita chamar enrichLeadContext em toda mensagem — só quando voltou depois de ≥1 dia
          const quickHoursSince = lead.lastInteractionAt
            ? (Date.now() - new Date(lead.lastInteractionAt).getTime()) / (1000 * 60 * 60)
            : 0;
          const isReturningAfterGap = quickHoursSince >= 24;

          if (isReturningAfterGap) {
            let leadCtx = null;
            try {
              leadCtx = await enrichLeadContext(leadId);
            } catch (e) {
              this.logger.warn('V8_ENRICH_CTX_FAILED', { leadId, error: e.message });
            }

            if (leadCtx?.shouldGreet) {
              const lastTopics = leadCtx.lastTopics ?? [];
              const days = leadCtx.daysSinceLastContact ?? 1;
              const childNameTopic = lastTopics.find(t => t.type === 'child_name');
              const complaintTopic = lastTopics.find(t => t.type === 'complaint');

              const childRef = childNameTopic?.value ? `o ${childNameTopic.value}` : null;
              const complaintRef = complaintTopic?.value ? `*${complaintTopic.value}*` : null;
              const timeRef = days >= 7 ? 'semana passada' : days >= 2 ? 'há alguns dias' : 'ontem';

              // Monta a referência contextual (só se tiver algo real para mencionar)
              let contextLine = '';
              if (childRef && complaintRef) {
                contextLine = `Da última vez conversamos sobre ${complaintRef} ${childRef ? `para ${childRef}` : ''}.\n\n`;
              } else if (complaintRef) {
                contextLine = `Da última vez você mencionou ${complaintRef}.\n\n`;
              } else if (childRef) {
                contextLine = `Da última vez conversamos sobre ${childRef}.\n\n`;
              }

              this.logger.info('V8_WARM_RECALL', { leadId, days, hasChildRef: !!childRef, hasComplaintRef: !!complaintRef });

              if (hasExistingName) {
                // Tem tudo — confirma retomada sem jogar slots direto (lead estava longe)
                // Próxima mensagem do lead → IDLE → hasExistingName → SHOW_SLOTS
                return this._reply(
                  `Que bom que voltou${childRef ? `, ${childRef} por aqui` : ''}! 😊💚\n\n` +
                  `${contextLine}` +
                  `Já tenho as informações aqui. Quer que eu verifique os horários disponíveis para *${hasExistingTherapy}*? 💚`
                );
              }

              if (hasExistingComplaint) {
                const resumeData = { ...stateData, therapy: hasExistingTherapy, complaint: hasExistingComplaint };
                await jumpToState(leadId, STATES.COLLECT_PERIOD, resumeData);
                return this._reply(
                  `Que bom que voltou! 😊💚\n\n` +
                  `${contextLine}` +
                  `Estávamos quase lá! Que período funciona melhor: *manhã ou tarde*? ☀️🌙`
                );
              }

              // Tem terapia mas não tem queixa — retoma com contexto
              const resumeData = { ...stateData, therapy: hasExistingTherapy };
              await jumpToState(leadId, STATES.COLLECT_COMPLAINT, resumeData);
              return this._reply(
                `${contextLine}` +
                `Me conta um pouco mais sobre a situação para eu poder ajudar melhor 💚`
              );
            }
          }

          // ── MESMA SESSÃO (< 24h) — retoma silenciosamente sem warm recall ───
          if (hasExistingName) {
            // canOfferScheduling: falso se bookingOffersCount >= 1 (já recebeu slots)
            if (!ctx.canOfferScheduling) {
              this.logger.info('V8_SLOT_SKIP_ALREADY_OFFERED', { leadId, bookingOffersCount: lead.bookingOffersCount });
              return this._reply('Você já recebeu os horários disponíveis 😊 Conseguiu verificar? Se precisar de outros dias ou turnos é só me contar 💚');
            }
            const resumeData = { ...stateData, therapy: hasExistingTherapy, patientName: hasExistingName };
            await jumpToState(leadId, STATES.SHOW_SLOTS, resumeData);
            return this._handleOfferBooking(resumeData, lead, services);
          }
          if (hasExistingComplaint) {
            const resumeData = { ...stateData, therapy: hasExistingTherapy, complaint: hasExistingComplaint };
            await jumpToState(leadId, STATES.COLLECT_PERIOD, resumeData);
            return await this._replyWithAI(ctx, 'Lead retornou na mesma sessão com terapia e queixa já registradas. Retome naturalmente e pergunte qual período funciona melhor: manhã ou tarde.');
          }
          const resumeData = { ...stateData, therapy: hasExistingTherapy };
          await jumpToState(leadId, STATES.COLLECT_COMPLAINT, resumeData);
          return await this._replyWithAI(ctx, 'Lead retornou na mesma sessão com terapia já registrada mas sem queixa. Retome de forma calorosa SEM repetir saudações iniciais (Olá/Oi/Que bom que entrou em contato) e pergunte sobre a situação que está preocupando.');
        }

        // ── LP CONTEXT: detectar LP de origem pelo texto do CTA pré-preenchido ──
        if (!lead.lpContextApplied) {
          const lpContext = extractLPContext(text);
          if (lpContext) {
            const { therapy, complaint, slug, lpData } = lpContext;
            this.logger.info('V8_LP_CONTEXT_DETECTED', { leadId, slug, therapy });
            await this._saveTherapy(leadId, { id: therapy, name: therapy });
            await Leads.updateOne({ _id: leadId }, {
              $set: {
                lpContextApplied: true,
                'autoBookingContext.complaint': complaint,
                utmSource: 'landing_page',
                utmMedium: slug,
                'metaTracking.firstMessage': text,
              },
            });
            await jumpToState(leadId, STATES.COLLECT_PERIOD, { therapy, complaint });
            return this._reply(this._buildLPGreeting(lpData));
          }
        }

        // Usar ctx (já computado pelo buildMessageContext — sem chamar detectors de novo)
        const medicalSpecialty = ctx.medicalSpecialty;
        if (medicalSpecialty) {
          this.logger.info('V8_MEDICAL_SPECIALTY_IDLE', { leadId, specialty: medicalSpecialty.specialty });
          await jumpToState(leadId, STATES.COLLECT_THERAPY);
          return this._reply(`${medicalSpecialty.message}\n\nPosso te ajudar com *${medicalSpecialty.redirectTo}* ou outra especialidade que oferecemos? 💚\n\n💚 Fonoaudiologia\n💚 Psicologia\n💚 Fisioterapia\n💚 Terapia Ocupacional\n💚 Neuropsicologia\n💚 Psicopedagogia\n💚 Musicoterapia`);
        }

        if (ctx.negativeScope?.mentionsOrelhinha) {
          this.logger.info('V8_OUT_OF_SCOPE_IDLE', { leadId, scope: 'orelhinha' });
          await jumpToState(leadId, STATES.COLLECT_THERAPY);
          return this._reply(`Não realizamos teste da orelhinha/triagem auditiva aqui na Fono Inova 🤔\n\nEsse é um exame médico que geralmente é feito em hospitais ou clínicas de fonoaudiologia especializadas em audiologia.\n\nSe você busca Fonoaudiologia para *desenvolvimento da fala* (criança que não fala, troca letras, gagueira), aí sim podemos ajudar! 💚\n\nQual especialidade você procura?`);
        }

        // Usar therapies já detectadas pelo ctx
        let therapies = ctx.therapies?.length > 0 ? ctx.therapies : [];
        
        // Fallback por sintoma (ctx.symptomTherapies já computado)
        if (therapies.length === 0 && ctx.symptomTherapies?.length > 0) {
          const primaryId = ctx.symptomTherapies[0];
          therapies = [{ id: primaryId, name: this._getTherapyDisplayName(primaryId) }];
          this.logger.info('V8_THERAPY_DETECTED_BY_SYMPTOM_IDLE', { leadId, therapyId: primaryId });
        }
        
        const therapy = therapies.length > 0 ? therapies[0] : null;
        const therapyName = therapy?.name || therapy?.id || null;

        if (therapy) {
          this.logger.info('V8_THERAPY_DETECTED_ON_IDLE', { leadId, therapyId: therapy?.id, therapyName });
          await this._saveTherapy(leadId, therapy);

          const isAvailQuestion = this._isAvailabilityQuestion(text);

          // Neuropsicologia tem dois caminhos: laudo ou acompanhamento terapêutico
          if (therapy.id === 'neuropsychological') {
            await jumpToState(leadId, STATES.COLLECT_NEURO_TYPE, { therapy: therapy.id });
            const neuroIntro = isAvailQuestion
              ? `Sim, atendemos com Neuropsicologia! 😊\n\n`
              : `Que bom que entrou em contato! 😊\n\nAqui atendemos neuropsicologia 💚\n\n`;
            return this._reply(`${neuroIntro}Para te ajudar melhor: você está buscando um *laudo neuropsicológico* (avaliação completa com relatório) ou *acompanhamento terapêutico* (sessões regulares)?`);
          }

          // Queixa embutida na mesma mensagem que a terapia?
          // Ex: "quero psicologia meu filho tem ansiedade" → não perguntar de novo
          const isReferral = /\b(pediatra|neuropediatra|neurologista|m[eé]dic[oa]|escola|terapeuta)\b/i.test(text) &&
            /\b(pediu|indicou|recomendou|solicitou|mandou|disse\s+que|orientou)\b/i.test(text);

          const hasEmbeddedComplaint = text.length > 30 && (
            flags.isEmotional ||
            ctx.symptomTherapies?.length > 0 ||
            isReferral ||
            /\b(meu\s+filho|minha\s+filha|meu\s+beb[eê]|minha\s+beb[eê]|ele\s+(não|tá|está)|ela\s+(não|tá|está)|queixa|dificuldade|não\s+(fala|para|consegue|anda|aprende)|ansios|agitado|agressiv|atraso|escola\s+(pediu|disse|indicou)|m[eé]dic[ao]\s+(pediu|disse|indicou|recomendou))\b/i.test(text)
          );

          if (hasEmbeddedComplaint && !isAvailQuestion) {
            const complaint = text.substring(0, 200);
            await this._saveComplaint(leadId, complaint);
            await jumpToState(leadId, STATES.COLLECT_BIRTH, { therapy: therapy?.id || therapy, complaint });
            const isAskingHow = /\b(como\s+(funciona|é|acontece|é\s+feita?|seria)|pode\s+me\s+explicar|me\s+explica|quero\s+entender|como\s+é\s+o\s+processo|como\s+funciona\s+a\s+avalia[cç][aã]o)\b/i.test(text);
            const instruction = isAskingHow
              ? `Lead veio de uma LP e perguntou como funciona a avaliação de ${therapyName}, além de descrever a queixa. Explique brevemente como funciona (avaliação inicial, sessões, o que esperar), acolha a situação descrita e, ao final, peça a data de nascimento do paciente para verificar os horários.`
              : isReferral
                ? `Lead veio com indicação de profissional de saúde para ${therapyName}. Acolha reconhecendo a indicação, NÃO pergunte novamente "qual a situação" pois ela já foi descrita. Peça o nome e data de nascimento do paciente para verificar os horários.`
                : `Lead já descreveu a queixa junto com a terapia (${therapyName}). Confirme que entendeu a situação e peça a data de nascimento do paciente.`;
            return await this._replyWithAI(ctx, instruction);
          }

          await jumpToState(leadId, STATES.COLLECT_COMPLAINT, { therapy: therapy?.id || therapy });
          if (isAvailQuestion) {
            return await this._replyWithAI(ctx, `Lead perguntou se a clínica atende ${therapyName}. Confirme positivamente SEM repetir saudações iniciais (Olá/Oi/Que bom que entrou em contato) e pergunte qual é a principal queixa ou dificuldade.`);
          }
          return await this._replyWithAI(ctx, `Lead demonstrou interesse em ${therapyName}. Acolha e pergunte sobre a situação — o que está preocupando.`);
        }

        this.logger.info('V8_NO_THERAPY_ON_IDLE', { leadId, text: text.substring(0, 60) });

        // ── Detecta o tipo de abertura para responder de forma adequada ──────

        // 1. Abridor vago: "oi", "olá", "quero mais informações", "preciso de ajuda"
        const isVagueOpener = /^(oi|olá|ola|hey|bom\s+dia|boa\s+tarde|boa\s+noite|tudo\s+bem|tudo\s+bom|quero\s+(mais\s+)?info|preciso\s+de\s+ajuda|me\s+ajuda|pode\s+me\s+ajudar|gostaria\s+de\s+saber|vim\s+saber|quero\s+saber|boa)/i.test(text.trim());

        // 2. Queixa/dor/relato sem terapia mapeada: "meu filho tem dor", "tô preocupada"
        const mentionsComplaint = flags.isEmotional
          || /\b(dor|dific[ui]ldade|preocup|sofr|chora|medo|ansios|problem|recla|escola\s+(disse|pediu|falou)|médico\s+(disse|pediu|falou)|não\s+(consegue|faz|fala|anda|aprende|para)|atras[ao]|atraso|comportamento)\b/i.test(text);

        await jumpToState(leadId, STATES.COLLECT_THERAPY);

        if (isVagueOpener || mentionsComplaint) {
          const hour = new Date().getHours();
          const saudacao = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
          return await this._replyWithAI(ctx, `${saudacao}! Primeiro contato. Apresente-se como Amanda da Fono Inova e pergunte se o atendimento é para a própria pessoa ou para alguém da família.`);
        }

        // Mensagem mista ou sem contexto claro
        return await this._replyWithAI(ctx, 'Primeiro contato sem contexto claro. Apresente-se como Amanda da Fono Inova e peça para contar o que está procurando ou qual situação está preocupando.');
      }

      // ── COLETA DE TERAPIA ──
      case STATES.COLLECT_THERAPY: {
        // Lead retornou com terapia já salva mas FSM em COLLECT_THERAPY (ex: voltou no dia seguinte)
        if (ctx.leadData?.therapy && detectAllTherapies(text).length === 0) {
          const restoredTherapy = ctx.leadData.therapy;
          this.logger.info('V8_THERAPY_RESTORED_FROM_DB', { leadId, therapyArea: restoredTherapy });
          const resumeData = { ...stateData, therapy: restoredTherapy };
          await jumpToState(leadId, STATES.COLLECT_COMPLAINT, resumeData);
          return await this._replyWithAI(ctx, `Lead voltou com terapia ${restoredTherapy} já registrada. Dê boas-vindas de volta e retome perguntando sobre a situação que está preocupando.`);
        }

        const therapies = detectAllTherapies(text);
        if (therapies.length > 0) {
          const therapy = therapies[0];
          const therapyName = therapy?.name || therapy?.id || therapy;
          this.logger.info('V8_THERAPY_COLLECTED', { leadId, therapyId: therapy?.id, therapyName });
          await this._saveTherapy(leadId, therapy);

          const isAvailQuestion = this._isAvailabilityQuestion(text);

          // Neuropsicologia: pergunta laudo vs acompanhamento antes de continuar
          if (therapy.id === 'neuropsychological') {
            await jumpToState(leadId, STATES.COLLECT_NEURO_TYPE, { therapy: therapy.id });
            const neuroIntro = isAvailQuestion
              ? `Sim, atendemos com Neuropsicologia! 😊\n\n`
              : `Neuropsicologia 💚, ótima escolha!\n\n`;
            return this._reply(`${neuroIntro}Para te ajudar melhor: você está buscando um *laudo neuropsicológico* (avaliação completa com relatório) ou *acompanhamento terapêutico* (sessões regulares)?`);
          }

          await jumpToState(leadId, STATES.COLLECT_COMPLAINT, { therapy: therapy?.id || therapy });
          if (isAvailQuestion) {
            return this._reply(`Sim, atendemos com *${therapyName}*! 😊\n\nMe conta: qual é a principal queixa ou dificuldade?`);
          }
          return this._reply(`*${therapyName}* 💚, ótima escolha!\n\nMe conta um pouco da situação que tá preocupando?`);
        }

        // 🔧 FIX: Detectar terapia por sintomas quando não detectou por nome
        const therapiesBySymptom = detectTherapyBySymptoms(text);
        if (therapiesBySymptom.length > 0) {
          const primaryId = therapiesBySymptom[0];
          const therapyFromSymptom = { id: primaryId, name: this._getTherapyDisplayName(primaryId) };
          this.logger.info('V8_THERAPY_COLLECTED_BY_SYMPTOM', { leadId, therapyId: primaryId });
          await this._saveTherapy(leadId, therapyFromSymptom);
          
          const isAvailQuestion = this._isAvailabilityQuestion(text);
          await jumpToState(leadId, STATES.COLLECT_COMPLAINT, { therapy: primaryId });
          
          const therapyName = therapyFromSymptom.name;
          if (isAvailQuestion) {
            return this._reply(`Sim, atendemos com *${therapyName}*! 😊\n\nMe conta: qual é a principal queixa ou dificuldade?`);
          }
          return this._reply(`*${therapyName}* 💚, ótima escolha!\n\nMe conta um pouco da situação que tá preocupando?`);
        }

        // ── "Psicologia é o mesmo que psicopedagogia?" ────────────────────
        if (isAskingAboutEquivalence(text)) {
          this.logger.info('V8_EQUIVALENCE_QUESTION', { leadId, text: text.substring(0, 60) });
          return this._reply(
            `Boa pergunta! 😊\n\n` +
            `*Psicologia* trabalha emoções, comportamento e saúde mental — ansiedade, medos, desenvolvimento emocional.\n\n` +
            `*Psicopedagogia* foca especificamente em como a criança aprende — dificuldades escolares, dislexia, TDAH, ritmo de aprendizagem.\n\n` +
            `Me conta mais sobre o que está acontecendo com a criança? Assim consigo indicar o caminho certo 💚`
          );
        }

        // ── TDAH com resposta específica ──────────────────────────────────
        if (ctx.isTDAH) {
          const leadName = ctx.leadData?.name;
          const tdahResponse = getTDAHResponse(leadName);
          if (tdahResponse) {
            this.logger.info('V8_TDAH_QUESTION', { leadId });
            // Terapia mais provável: neuropsicologia ou psicologia
            await this._saveTherapy(leadId, { id: 'neuropsychological', name: 'Neuropsicologia' });
            await jumpToState(leadId, STATES.COLLECT_NEURO_TYPE, { therapy: 'neuropsychological' });
            return this._reply(tdahResponse);
          }
        }

        // ── Fallback por flags quando nenhuma terapia foi detectada ───────
        // resolveTopicFromFlags mapeia flags → área terapêutica mesmo sem keyword explícita
        const topicFromFlags = resolveTopicFromFlags(flags, text);
        if (topicFromFlags) {
          this.logger.info('V8_THERAPY_FROM_FLAGS', { leadId, topic: topicFromFlags });
          const topicTherapy = { id: topicFromFlags, name: this._getTherapyDisplayName(topicFromFlags) };
          await this._saveTherapy(leadId, topicTherapy);
          await jumpToState(leadId, STATES.COLLECT_COMPLAINT, { therapy: topicFromFlags });
          return await this._replyWithAI(ctx, `Lead demonstrou interesse relacionado a ${topicFromFlags}. Confirme que entendeu e pergunte mais sobre a situação.`);
        }

        // ── Especialidades médicas (neuropediatra, pediatra, psiquiatra) ──
        const medicalSpecialty = ctx.medicalSpecialty || detectMedicalSpecialty(text);
        if (medicalSpecialty) {
          this.logger.info('V8_MEDICAL_SPECIALTY_DETECTED', { leadId, specialty: medicalSpecialty.specialty });
          const { handoff } = await incrementRetry(leadId);
          if (handoff) { this.logger.warn('V8_HANDOFF', { leadId, state }); return this._handoffReply(); }
          return this._reply(`${medicalSpecialty.message}\n\nPosso te ajudar com *${medicalSpecialty.redirectTo}* ou outra especialidade que oferecemos? 💚\n\n💚 Fonoaudiologia\n💚 Psicologia\n💚 Fisioterapia\n💚 Terapia Ocupacional\n💚 Psicopedagogia`);
        }

        // ── Queixa descrita mas sem terapia detectada ─────────────────────
        // Mãe contou a situação mas não usou nome de especialidade nem sintoma mapeado.
        // Em vez de pedir "qual terapia?", acolhe e salva a queixa — terapia será
        // inferida no próximo turno ou na triagem humana.
        const looksLikeComplaint =
          flags.isEmotional ||
          /\b(meu\s+filho|minha\s+filha|ele\s+(não|tá|está)|ela\s+(não|tá|está)|criança|bebê|escola\s+(pediu|falou|disse)|médico\s+(pediu|disse|indicou)|dor|preocup|dificuldade|problem|sofr|chora|não\s+(para|consegue|faz|fala|anda|aprende))\b/i.test(text);

        if (looksLikeComplaint && text.length > 15) {
          this.logger.info('V8_COMPLAINT_WITHOUT_THERAPY', { leadId, text: text.substring(0, 80) });
          // Salva queixa e avança pra entender mais — não força escolha de terapia
          await Leads.updateOne({ _id: leadId }, {
            $set: { 'autoBookingContext.complaint': text.trim() }
          });
          await jumpToState(leadId, STATES.COLLECT_COMPLAINT, { ...stateData, complaint: text.trim() });
          return await this._replyWithAI(ctx, 'Lead descreveu uma queixa mas não mencionou especialidade. Acolha o relato SEM repetir saudações iniciais (Olá/Oi/Que bom que entrou em contato) e pergunte se é com uma criança e com que idade.');
        }

        // Verifica se tem dado de idade/contexto para resposta mais natural
        const age = extractAgeFromText(text);
        const { handoff, retryCount } = await incrementRetry(leadId);
        this.logger.warn('V8_RETRY', { leadId, state, retryCount, reason: 'therapy_not_detected', text: text.substring(0, 60) });
        if (handoff) { this.logger.warn('V8_HANDOFF', { leadId, state }); return this._handoffReply(); }
        if (age) {
          const ageNum = resolveAgeNumber(age);
          await Leads.updateOne({ _id: leadId }, { $set: { 'patientInfo.age': ageNum } });
          const ageStr = formatAge(age);
          return this._reply(`Entendi, ${ageStr}! 💚\n\n${this._retryMessage(STATES.COLLECT_THERAPY, retryCount)}`);
        }
        return this._reply(this._retryMessage(STATES.COLLECT_THERAPY, retryCount));
      }

      // ── LAUDO VS ACOMPANHAMENTO (apenas neuropsicologia) ──
      case STATES.COLLECT_NEURO_TYPE: {
        const tl = text.toLowerCase();

        // ── Detecção explícita ─────────────────────────────────────────────
        const isLaudo = /\b(laudo|relat[oó]rio|diagn[oó]stico|avalia[cç][aã]o\s+completa|fechar\s+diagn)/i.test(tl);
        const isAcomp = /\b(acompanhamento|terapia|sess[oõ]es?|terapêutico|terapeutico|s[oó]\s+terap)/i.test(tl);

        // ── Sinais implícitos de LAUDO ─────────────────────────────────────
        // Mãe não sabe o nome "laudo" mas claramente quer investigar/descobrir
        const impliesLaudo =
          /\b(suspeita|n[aã]o\s+sei\s+(o\s+que|se)|quero\s+(saber|entender|descobrir)|investiga|fechar|o\s+que\s+(ele|ela)\s+tem|o\s+que\s+est[aá]\s+(acontecendo|errado)|m[eé]dico\s+(pediu|indicou|recomendou)|escola\s+(pediu|indicou|sugeriu)|avali[ao]r|primeira\s+vez|nunca\s+fiz)/i.test(tl)
          || (ctx?.flags?.mentionsInvestigation)
          || (ctx?.flags?.mentionsDoubtTEA)
          || ctx?.teaStatus === 'suspeita'; // computeTeaStatus: TEA+suspeita detectados

        // ── Sinais implícitos de ACOMPANHAMENTO ───────────────────────────
        // Mãe já tem diagnóstico, quer continuar ou iniciar tratamento
        const impliesAcomp =
          /\b(j[aá]\s+tem\s+(diagn[oó]stico|laudo|o\s+laudo)|j[aá]\s+foi\s+(diagnosticad|avaliado)|j[aá]\s+sab(e|emos)|tem\s+(tea|tdah|autismo)\s+confirmado|diagnosticad[oa]\s+com|continuar\s+(o\s+)?tratamento|continuar\s+(as\s+)?sess[oõ]es|quero\s+(come[cç]ar|iniciar)\s+(as\s+)?sess[oõ]es)/i.test(tl)
          || ctx?.teaStatus === 'laudo_confirmado'; // computeTeaStatus: TEA+laudo confirmados

        // Resolve implícito como se fosse explícito
        const resolvedLaudo = isLaudo || impliesLaudo;
        const resolvedAcomp = isAcomp || impliesAcomp;

        if (resolvedLaudo && !resolvedAcomp) {
          this.logger.info('V8_NEURO_TYPE_COLLECTED', { leadId, neuroType: 'laudo', implicit: !isLaudo });
          await jumpToState(leadId, STATES.COLLECT_COMPLAINT, { ...stateData, neuroType: 'laudo' });
          await Leads.updateOne({ _id: leadId }, [
            { $set: { autoBookingContext: { $ifNull: ['$autoBookingContext', {}] } } },
            { $set: { 'autoBookingContext.neuroType': 'laudo' } },
          ]);
          return await this._replyWithAI(ctx, 'Lead escolheu laudo neuropsicológico. Explique brevemente o que é (avaliação completa + relatório), mencione o investimento e pergunte a principal dificuldade.', `Investimento laudo neuropsicológico: ${getPriceText('neuropsicologia')}`);
        }

        if (resolvedAcomp && !resolvedLaudo) {
          this.logger.info('V8_NEURO_TYPE_COLLECTED', { leadId, neuroType: 'acompanhamento', implicit: !isAcomp });
          await jumpToState(leadId, STATES.COLLECT_COMPLAINT, { ...stateData, neuroType: 'acompanhamento' });
          await Leads.updateOne({ _id: leadId }, [
            { $set: { autoBookingContext: { $ifNull: ['$autoBookingContext', {}] } } },
            { $set: { 'autoBookingContext.neuroType': 'acompanhamento' } },
          ]);
          return await this._replyWithAI(ctx, 'Lead escolheu acompanhamento terapêutico em neuropsicologia. Confirme a escolha SEM repetir saudações iniciais (Olá/Oi/Que bom que entrou em contato), mencione o investimento e pergunte a principal dificuldade.', `Investimento acompanhamento: ${getPriceText('psicopedagogia')}`);
        }

        // ── Genuinamente não sabe — explica a diferença de forma natural ──
        const { handoff, retryCount } = await incrementRetry(leadId);
        this.logger.warn('V8_RETRY', { leadId, state, retryCount, reason: 'neuro_type_not_detected', text: text.substring(0, 60) });
        if (handoff) { this.logger.warn('V8_HANDOFF', { leadId, state }); return this._handoffReply(); }

        const isAdultContext = stateData?.isAdult || ctx?.flags?.ageGroup === 'adulto';
        const pacienteRef = isAdultContext ? 'do paciente' : 'da criança';
        const investigarRef = isAdultContext
          ? 'Ainda não sei o que tenho / o que está acontecendo — quero investigar'
          : 'Ainda não sei o que meu filho(a) tem — quero investigar';
        const tratarRef = isAdultContext
          ? 'Já tenho diagnóstico — quero iniciar o acompanhamento'
          : 'Já sei o que ele(a) tem — quero iniciar o tratamento';

        if (retryCount === 1) {
          return this._reply(
            `Deixa eu te explicar a diferença pra ficar mais fácil 💚\n\n` +
            `*Laudo neuropsicológico* — para quem quer *entender* o que está acontecendo. ` +
            `São ~10 sessões de avaliação e ao final você recebe um relatório completo com o perfil ${pacienteRef}. ` +
            `Muito usado quando há suspeita de TEA, TDAH ou dificuldades de aprendizado.\n\n` +
            `*Acompanhamento terapêutico* — para quem já tem diagnóstico e quer *trabalhar* as dificuldades em sessões regulares.\n\n` +
            `Qual das duas situações é mais parecida com a de vocês?`
          );
        }

        // retryCount >= 2: oferece escolha direta A ou B
        return this._reply(
          `Sem problemas, vou simplificar 😊\n\n` +
          `*A)* ${investigarRef}\n` +
          `*B)* ${tratarRef}\n\n` +
          `Qual é a situação?`
        );
      }

      // ── COLETA DE QUEIXA ──
      case STATES.COLLECT_COMPLAINT: {
        // 🔥 CAMADA DE SEGURANÇA: Detecta se o texto é uma pergunta não mapeada
        // Se termina com ? ou começa com palavras interrogativas, não é uma queixa
        const looksLikeQuestion = 
          text.trim().endsWith('?') ||
          /^(qual|quais|quanto|quantos|como|onde|quando|por que|porquê|vocês?|tem|faz|atende)/i.test(text.trim());
        
        if (looksLikeQuestion) {
          this.logger.info('V8_COMPLAINT_QUESTION_DETECTED', { leadId, text: text.substring(0, 60) });
          
          // ✅ Se é uma pergunta já mapeada, responde normalmente
          const globalIntent = detectGlobalIntent(text);
          if (globalIntent) {
            const answer = await this._handleGlobalIntent(globalIntent, freshLead);
            const resumeHint = getResumeHint(state);
            return this._reply(`${answer}\n\n${resumeHint}`);
          }
          
          // Se é pergunta NÃO mapeada, redireciona SEM parecer falha
          return await this._replyWithAI(ctx, 'Lead fez uma pergunta fora do escopo direto. Responda brevemente que vai verificar e redirecione para a queixa principal — o que está observando na criança.');
        }

        if (text.length > 5) {
          const complaint = text.substring(0, 200);
          const age = extractAgeFromText(text);
          const newData = { ...stateData, complaint, ...(age ? { age } : {}) };

          // Sempre vai para COLLECT_BIRTH — precisamos da data de nascimento para os slots
          if (age) {
            this.logger.info('V8_COMPLAINT_WITH_AGE', { leadId, age, complaint: complaint.substring(0, 60) });
            await jumpToState(leadId, STATES.COLLECT_BIRTH, newData);
            await this._saveComplaintAndAge(leadId, complaint, resolveAgeNumber(age));
            return await this._replyWithAI(ctx, 'Lead descreveu a queixa e já mencionou a idade. Confirme que entendeu e peça a data de nascimento no formato dd/mm/aaaa.');
          }

          this.logger.info('V8_COMPLAINT_NO_AGE', { leadId, complaint: complaint.substring(0, 60) });
          await jumpToState(leadId, STATES.COLLECT_BIRTH, newData);
          await this._saveComplaint(leadId, complaint);
          return await this._replyWithAI(ctx, 'Lead descreveu a queixa. Confirme que entendeu de forma acolhedora SEM repetir saudações iniciais (Olá/Oi/Que bom que entrou em contato) e peça a data de nascimento do paciente (dd/mm/aaaa).');
        }

        const { handoff, retryCount } = await incrementRetry(leadId);
        this.logger.warn('V8_RETRY', { leadId, state, retryCount, reason: 'complaint_too_short', textLen: text.length });
        if (handoff) { this.logger.warn('V8_HANDOFF', { leadId, state }); return this._handoffReply(); }
        return this._reply(this._retryMessage(STATES.COLLECT_COMPLAINT, retryCount));
      }

      // ── COLETA DE IDADE/NASCIMENTO ──
      case STATES.COLLECT_BIRTH: {
        const age = extractAgeFromText(text);
        const birth = extractBirth(text);

        // BUG 8 FIX: detecta se o texto parece um nome próprio (sem dígitos, 2+ palavras iniciando com maiúscula)
        // Ocorre quando lead envia nome do paciente enquanto FSM aguarda data de nascimento
        if (!age && !birth) {
          const words = text.trim().split(/\s+/);
          const looksLikeName = words.length >= 2 &&
            words.every(w => /^[A-ZÀ-ÚÃÕ]/u.test(w)) &&
            !/\d/.test(text);
          if (looksLikeName) {
            this.logger.info('V8_BIRTH_GOT_NAME_INSTEAD', { leadId, name: text.trim() });
            await this._savePatientName(leadId, text.trim());
            return this._reply(`Anotado, *${text.trim()}*! 📝\n\nAgora preciso da *data de nascimento* do paciente (dd/mm/aaaa):`);
          }
        }

        if (age || birth) {
          this.logger.info('V8_BIRTH_COLLECTED', { leadId, age, birth });
          const ageNum = resolveAgeNumber(age);
          const newData = { ...stateData, age: ageNum || null, birthDate: birth || null };
          await jumpToState(leadId, STATES.COLLECT_PERIOD, newData);
          await this._saveAge(leadId, ageNum, birth);
          return await this._replyWithAI(ctx, `Lead informou idade/nascimento${ageNum ? ` (${formatAge(age)})` : ''}. Confirme o dado e pergunte qual período funciona melhor: manhã ou tarde.`);
        }

        const { handoff, retryCount } = await incrementRetry(leadId);
        this.logger.warn('V8_RETRY', { leadId, state, retryCount, reason: 'birth_not_extracted', text: text.substring(0, 60) });
        if (handoff) { this.logger.warn('V8_HANDOFF', { leadId, state }); return this._handoffReply(); }
        return this._reply('Preciso só da idade ou data de nascimento pra buscar os horários certinhos 💚');
      }

      // ── COLETA DE PERÍODO ──
      case STATES.COLLECT_PERIOD: {
        // ── Age interceptor: captura idade quando vinda de LP greeting ──────
        // _buildLPGreeting pergunta "quantos anos?" antes de pedir período
        // Só captura se ainda não temos idade registrada
        {
          const existingAge = lead.patientInfo?.age || lead.patientInfo?.ageInMonths;
          if (!existingAge) {
            const ageResult = extractAgeFromText(text);
            const ageNum = resolveAgeNumber(ageResult);
            if (ageNum !== null && ageNum > 0) {
              const unit = ageResult?.unit || 'anos';
              const isMonths = unit === 'meses' || unit === 'dias';
              const maxAge = isMonths ? 216 : 18; // 18 anos ou 216 meses
              if (ageNum <= maxAge) {
                const ageField = isMonths ? 'patientInfo.ageInMonths' : 'patientInfo.age';
                await Leads.updateOne({ _id: leadId }, { $set: { [ageField]: ageNum } });
                this.logger.info('V8_LP_AGE_INTERCEPTED', { leadId, ageNum, unit });
                return this._reply(`Perfeito, *${ageNum} ${unit}* 💚\n\nPrefere atendimento pela manhã ☀️ ou à tarde 🌙?`);
              }
            }
          }
        }

        const period = extractPeriodFromText(text);
        const preferredDate = extractPreferredDate(text);
        
        if (period) {
          this.logger.info('V8_PERIOD_COLLECTED', { leadId, period, preferredDate });
          await this._savePeriod(leadId, period);

          // Se lead já tem nome (ctx.leadData resolve de qualquer fonte), pular COLLECT_NAME
          const existingName = ctx.leadData?.name;
          if (existingName) {
            this.logger.info('V8_NAME_ALREADY_EXISTS_SKIP_COLLECT', { leadId, existingName });
            const newData = { ...stateData, period, preferredDate, patientName: existingName };
            await jumpToState(leadId, STATES.SHOW_SLOTS, newData);
            return this._handleOfferBooking(newData, lead, services);
          }

          const newData = { ...stateData, period, preferredDate };
          await jumpToState(leadId, STATES.COLLECT_NAME, newData);
          return this._reply(`Perfeito! ☀️\n\nQual o *nome completo do paciente*?`);
        }
        
        // Se não detectou período mas detectou data, ainda assim avança com a data
        if (preferredDate) {
          this.logger.info('V8_DATE_COLLECTED', { leadId, preferredDate });
          const newData = { ...stateData, preferredDate };
          await jumpToState(leadId, STATES.COLLECT_PERIOD, newData);
          return this._reply(`Anotado! E prefere **manhã** ou **tarde**? ☀️🌙`);
        }

        const { handoff, retryCount } = await incrementRetry(leadId);
        this.logger.warn('V8_RETRY', { leadId, state, retryCount, reason: 'period_not_detected', text: text.substring(0, 60) });
        if (handoff) { this.logger.warn('V8_HANDOFF', { leadId, state }); return this._handoffReply(); }
        return this._reply(this._retryMessage(STATES.COLLECT_PERIOD, retryCount));
      }

      // ── COLETA DE NOME DO PACIENTE ──
      case STATES.COLLECT_NAME: {
        // ctx.leadData resolve nome de qualquer fonte (patientInfo, stateData, qualificationData)
        const existingName = ctx.leadData?.name;
        if (existingName) {
          this.logger.info('V8_NAME_ALREADY_IN_DB_SKIP', { leadId, existingName });
          const newData = { ...stateData, patientName: existingName };
          await jumpToState(leadId, STATES.SHOW_SLOTS, newData);
          return this._handleOfferBooking(newData, lead, services);
        }

        const name = extractName(text);
        if (name && name.length >= 2) {
          this.logger.info('V8_PATIENT_NAME_COLLECTED', { leadId, name });

          // ctx.leadData.therapy resolve de qualquer fonte (therapyArea, stateData, qualificationData)
          const therapyArea = ctx.leadData?.therapy || stateData.therapy?.id || stateData.therapy;
          if (!therapyArea) {
            this.logger.warn('V8_NO_THERAPY_AREA', { leadId, name, leadTherapyArea: lead.therapyArea, stateDataTherapy: stateData.therapy });
            await jumpToState(leadId, STATES.COLLECT_THERAPY, { ...stateData, patientName: name });
            return this._reply(`Perfeito, *${name}*! 📝\n\nSó preciso confirmar: qual especialidade você precisa?\n\n💚 Fonoaudiologia\n💚 Psicologia  \n💚 Fisioterapia\n💚 Terapia Ocupacional\n💚 Neuropsicologia`);
          }
          
          const newData = { ...stateData, patientName: name };
          await jumpToState(leadId, STATES.SHOW_SLOTS, newData);
          await this._savePatientName(leadId, name);
          return this._handleOfferBooking(newData, lead, services);
        }

        const { handoff, retryCount } = await incrementRetry(leadId);
        this.logger.warn('V8_RETRY', { leadId, state, retryCount, reason: 'name_not_extracted', text: text.substring(0, 60) });
        if (handoff) { this.logger.warn('V8_HANDOFF', { leadId, state }); return this._handoffReply(); }
        return this._reply(this._retryMessage(STATES.COLLECT_NAME, retryCount));
      }

      // ── MOSTRANDO SLOTS ──
      case STATES.SHOW_SLOTS: {
        const choice = text.trim().charAt(0).toUpperCase();
        if (/^[A-F]$/.test(choice)) {
          this.logger.info('V8_SLOT_CHOSEN', { leadId, choice, patientName: stateData.patientName });
          const newData = { ...stateData, chosenSlot: choice };
          await jumpToState(leadId, STATES.CONFIRM_BOOKING, newData);
          return this._reply(`Ótima escolha! Opção ${choice} 💚\n\n📋 Paciente: *${stateData.patientName}*\n🕐 Horário: Opção ${choice}\n\nPosso confirmar? (Sim/Não) ✅`);
        }

        const { handoff, retryCount } = await incrementRetry(leadId);
        this.logger.warn('V8_RETRY', { leadId, state, retryCount, reason: 'invalid_slot_choice', text: text.substring(0, 30) });
        if (handoff) { this.logger.warn('V8_HANDOFF', { leadId, state }); return this._handoffReply(); }
        return this._reply('Pra continuar, é só escolher uma das opções (A, B, C...) 💚');
      }

      // ── CONFIRMAÇÃO ──
      case STATES.CONFIRM_BOOKING: {
        const isYes = /^(sim|confirma|pode|bora|isso|ok|yes|claro)/i.test(text.trim());
        if (isYes) {
          const savedSlots = lead.pendingSchedulingSlots;
          const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
          const slotIndex = letters.indexOf(stateData.chosenSlot);
          const allSlots = [
            savedSlots?.primary,
            ...(savedSlots?.alternativesSamePeriod || []),
            ...(savedSlots?.alternativesOtherPeriod || []),
          ].filter(Boolean);
          const actualSlot = allSlots[slotIndex] || null;

          this.logger.info('V8_BOOKING_CONFIRMED', { leadId, patientName: stateData.patientName, chosenSlot: stateData.chosenSlot, slotFound: !!actualSlot });
          await jumpToState(leadId, STATES.BOOKED, stateData);

          if (actualSlot) {
            autoBookAppointment({
              lead,
              chosenSlot: actualSlot,
              patientInfo: {
                fullName: stateData.patientName,
                birthDate: lead.patientInfo?.birthDate || null,
                phone: lead.phone || lead.whatsapp || '',
                email: lead.email || undefined,
              },
            }).catch(err => this.logger.error('V8_AUTOBOOKING_ERROR', { error: err.message, leadId, patientName: stateData.patientName }));
          } else {
            this.logger.warn('V8_SLOT_NOT_FOUND_ON_CONFIRM', { leadId, chosenSlot: stateData.chosenSlot, totalSlots: allSlots.length });
          }

          return this._reply(`✅ Agendamento confirmado!\n\n📋 Paciente: ${stateData.patientName}\n🕐 Horário: Opção ${stateData.chosenSlot}\n\nVou enviar a confirmação com todos os detalhes! Até lá 💚`);
        }

        const isNo = /^(não|nao|cancela|desist)/i.test(text.trim());
        if (isNo) {
          this.logger.info('V8_BOOKING_CANCELLED', { leadId });
          await this._clearState(leadId);
          return this._reply('Sem problema! Se mudar de ideia, é só chamar 💚');
        }

        this.logger.info('V8_CONFIRM_AMBIGUOUS', { leadId, text: text.substring(0, 40) });
        return this._reply('Posso confirmar esse agendamento? Só dizer **Sim** ou **Não** 😊');
      }

      // ── AGENDADO ──
      case STATES.BOOKED: {
        // Verifica se lead quer marcar NOVO agendamento (caso Hanna)
        const wantsNew = /novo|outr[ao]|filh[ao]|mais um|segunda consulta|remarc|agend/i.test(text);
        if (wantsNew) {
          this.logger.info('V8_BOOKED_NEW_REQUEST', { leadId, text: text.substring(0, 80) });
          await this._clearState(leadId);
          return this._processState(STATES.IDLE, text, lead, {}, services);
        }
        this.logger.info('V8_BOOKED_RETURN_MSG', { leadId, text: text.substring(0, 60) });
        return this._reply('Seu agendamento já foi confirmado! 💚\n\nSe quiser marcar para outra criança ou nova consulta, é só me dizer! 😊');
      }

      // ── HANDOFF HUMANO ──
      // Estado terminal — não responde. A mensagem de handoff já foi enviada
      // quando a transição ocorreu via _handoffReply(). Silenciar aqui evita
      // o loop de "Vou te transferir..." em toda mensagem subsequente.
      case STATES.HANDOFF: {
        return { command: 'NO_REPLY' };
      }

      default: {
        this.logger.warn('V8_UNKNOWN_STATE', { state });
        await jumpToState(leadId, STATES.IDLE);
        return this._processState(STATES.IDLE, text, lead, {}, services);
      }
    }
  }

  // ═══════════════════════════════════════════
  // HANDLERS DE INTERRUPÇÃO GLOBAL
  // ═══════════════════════════════════════════

  async _handleGlobalIntent(intentType, lead) {
    switch (intentType) {
      case 'PRICE_QUERY':
        return await this._handlePriceInquiry(lead);

      case 'LOCATION_QUERY':
        return '📍 Ficamos na Av. Brasil, 1234 - Centro de Anápolis/GO.\n\nTem estacionamento fácil na rua! 🚗';

      case 'INSURANCE_QUERY':
        return 'Trabalhamos com reembolso de todos os planos! Você paga e solicita o ressarcimento (geralmente 80-100%).\n\nTambém aceitamos Pix, cartão de crédito e débito! 😊';

      case 'CONTACT_QUERY':
        return '📞 Nosso WhatsApp é esse mesmo! Pode mandar mensagem a qualquer hora 😊';

      case 'HOURS_QUERY':
        return '🕐 Funcionamos de Segunda a Sexta, das 8h às 18h!\n\nSábados com agendamento prévio 😊';

      case 'LAUDO_QUERY':
        return this._handleLaudoInquiry(lead);

      // 🆕 NOVO: Detector de origem GMB
      case 'GMB_ORIGIN':
        return this._handleGMBOrigin(lead);

      default:
        return 'Claro, posso ajudar com isso! 💚';
    }
  }

  _handleLaudoInquiry(lead) {
    const therapy = lead.therapyArea || lead.stateData?.therapy;
    const isNeuro = therapy === 'neuropsychological' || therapy === 'neuropsicologia';
    
    if (isNeuro) {
      return '📝 A **avaliação neuropsicológica** é realizada pela nossa neuropsicóloga e inclui a **emissão do laudo completo** ao final das aproximadamente 10 sessões de avaliação.\n\nO laudo neuropsicológico documenta todos os achados sobre atenção, memória, comportamento, aprendizagem e outras habilidades cognitivas. 💚';
    }
    
    // Se não é neuropsicologia ou não tem terapia definida, explica geral
    return '📝 Na **Neuropsicologia** emitimos laudo completo após a avaliação (aprox. 10 sessões).\n\nNas outras especialidades (Psicologia, Fonoaudiologia, Terapia Ocupacional), os profissionais fazem relatórios de acompanhamento, mas *não* emitimos laudos médicos — esses são emitidos apenas por médicos (neuropediatra, psiquiatra, etc.).\n\nVocê está buscando avaliação com laudo? 💚';
  }

  /**
   * 🆕 Handler para leads vindos do GMB (Google Meu Negócio)
   * Detectado quando lead diz "vi o post sobre..."
   */
  _handleGMBOrigin(lead) {
    // Registrar origem no lead
    this._trackGMBOrigin(lead);
    
    return `💚 Oi! Que bom que você viu nosso post no Google!

Sou a Amanda, assistente virtual da Fono Inova. Vou te ajudar a encontrar o melhor atendimento para você.

**Como posso te ajudar hoje?**
• Agendar uma avaliação
• Tirar dúvidas sobre nossos serviços
• Informações sobre valores

Me conta um pouco sobre o que você precisa! 😊`;
  }

  /**
   * Registra origem GMB no lead para analytics
   */
  async _trackGMBOrigin(lead) {
    try {
      await Leads.findByIdAndUpdate(lead._id, {
        $set: { 
          'metaTracking.source': 'google_gmb',
          'metaTracking.detectedAt': new Date()
        },
        $push: {
          interactions: {
            date: new Date(),
            channel: 'whatsapp',
            direction: 'inbound',
            message: '[DETECTADO: Origem GMB]',
            note: 'Lead mencionou ter visto post no Google Meu Negócio'
          }
        }
      });
    } catch (error) {
      this.logger.warn('GMB_TRACKING_ERROR', { leadId: lead._id, error: error.message });
    }
  }

  async _handlePriceInquiry(lead) {
    const ctx = this.currentContext;
    const flags = ctx?.flags || {};
    const intentScore = ctx?.promptMode?.intentScore ?? 20;

    // Terapia conhecida: resposta estratégica personalizada
    const therapy = lead.therapyArea || lead.stateData?.therapy || ctx?.leadData?.therapy;
    if (therapy) {
      const strategy = determinePricingStrategy(intentScore, flags);
      const pricing = getTherapyPricing(therapy);

      if (strategy === 'package_first' && pricing && !pricing.incluiLaudo) {
        // Lead quente: valor primeiro, depois preço, CTA direto
        const childAge = ctx?.leadData?.age;
        return buildValueFirstResponse(therapy, { childAge, includeUrgency: !!childAge && childAge <= 6 });
      }

      const priceComparison = getPriceComparison(therapy);
      const mainPrice = getPriceText(therapy);
      const base = `💰 ${mainPrice}`;
      const comparison = priceComparison ? `\n\n${priceComparison}` : '';
      return `${base}${comparison}\n\nTrabalhamos com reembolso de plano! 💚\n\nQuer verificar horários disponíveis?`;
    }

    // Sem terapia definida: detectar nas últimas mensagens
    try {
      const messages = await Message.find({ lead: lead._id, direction: 'inbound' })
        .sort({ timestamp: -1 }).limit(10).lean();

      const allText = messages.map(m => m.content || '').join(' ');
      const detectedTherapies = detectAllTherapies(allText);

      if (detectedTherapies.length > 0 && detectedTherapies.length <= 3) {
        const EMOJI = {
          fonoaudiologia: '💬', speech: '💬',
          psicologia: '🧠', psychology: '🧠',
          terapia_ocupacional: '🤲', occupational: '🤲',
          fisioterapia: '🏃', physiotherapy: '🏃',
          psicopedagogia: '📚', psychopedagogy: '📚',
          musicoterapia: '🎵', music: '🎵',
          neuropsicologia: '🧩', neuropsychological: '🧩',
        };

        let priceText = 'Claro! Aqui os valores:\n\n';
        for (const t of detectedTherapies) {
          const key = (typeof t === 'object' ? t.id : t)?.toLowerCase();
          const pricing = getTherapyPricing(key);
          if (!pricing) continue;
          const emoji = EMOJI[key] || '💚';
          priceText += `${emoji} ${pricing.descricao}: ${getPriceText(key)}\n`;
        }
        priceText += '\nTrabalhamos com reembolso de plano! 💚\n\nQuer que eu verifique horários?';
        return priceText;
      }
    } catch (e) {
      this.logger.warn('Erro ao buscar terapias para preço:', e.message);
    }

    // Sem terapia detectada: perguntar qual
    return `Claro! Pra te passar o valor certinho, qual especialidade você precisa?\n\n💬 Fonoaudiologia\n🧠 Psicologia\n🏃 Fisioterapia\n📚 Psicopedagogia\n🎵 Musicoterapia\n🧩 Neuropsicologia\n\nA avaliação inicial é o primeiro passo pra entender como podemos ajudar 💚`;
  }

  // ═══════════════════════════════════════════
  // BUSCA E OFERTA DE SLOTS
  // ═══════════════════════════════════════════

  async _handleOfferBooking(stateData, lead, services) {
    const leadId = lead._id;
    try {
      const ctx = this.currentContext;
      // Normaliza therapyArea garantindo nome em português para busca de slots
      const rawTherapy = ctx?.leadData?.therapy || lead.therapyArea || stateData.therapy?.id || stateData.therapy;
      const areaMap = {
        // Fonoaudiologia
        "speech": "fonoaudiologia",
        "tongue_tie": "fonoaudiologia",
        "fono": "fonoaudiologia",
        "fonoaudiologia": "fonoaudiologia",
        // Psicologia
        "psychology": "psicologia",
        "psico": "psicologia",
        "psicologia": "psicologia",
        // Terapia Ocupacional
        "occupational": "terapia_ocupacional",
        "to": "terapia_ocupacional",
        "terapia_ocupacional": "terapia_ocupacional",
        // Fisioterapia
        "physiotherapy": "fisioterapia",
        "fisio": "fisioterapia",
        "fisioterapia": "fisioterapia",
        // Musicoterapia
        "music": "musicoterapia",
        "musicoterapia": "musicoterapia",
        // Neuropsicologia
        "neuropsychological": "neuropsicologia",
        "neuro": "neuropsicologia",
        "neuropsicologia": "neuropsicologia",
        // Psicopedagogia
        "psychopedagogy": "psicopedagogia",
        "psicoped": "psicopedagogia",
        "psicopedagogia": "psicopedagogia",
        "neuropsychopedagogy": "neuropsicologia",
      };
      const therapyArea = areaMap[rawTherapy] || rawTherapy;
      const patientName = stateData.patientName || ctx?.leadData?.name;
      const birthDate = stateData.birthDate;
      const age = stateData.age || ctx?.leadData?.age;
      
      // ✅ VALIDAÇÃO: Todos os campos obrigatórios devem estar presentes
      this.logger.info('V8_SLOT_SEARCH_START', { 
        leadId, 
        therapyArea, 
        period: stateData.period, 
        age,
        patientName,
        birthDate,
        hasTherapyArea: !!therapyArea,
        hasPatientName: !!patientName,
        hasBirthOrAge: !!(birthDate || age)
      });
      
      if (!therapyArea) {
        this.logger.error('V8_SLOT_SEARCH_MISSING_THERAPY', { leadId, stateData, leadTherapyArea: lead.therapyArea });
        await jumpToState(leadId, STATES.COLLECT_THERAPY, stateData);
        return this._reply(`Ops! Preciso confirmar a especialidade primeiro 💚\n\nQual área você precisa?\n\n💚 Fonoaudiologia\n💚 Psicologia  \n💚 Fisioterapia\n💚 Terapia Ocupacional\n💚 Neuropsicologia`);
      }
      
      if (!patientName) {
        this.logger.error('V8_SLOT_SEARCH_MISSING_NAME', { leadId, stateData });
        await jumpToState(leadId, STATES.COLLECT_NAME, stateData);
        return this._reply('Qual o nome completo do paciente? 💚');
      }
      
      if (!birthDate && !age) {
        this.logger.error('V8_SLOT_SEARCH_MISSING_BIRTH', { leadId, stateData });
        await jumpToState(leadId, STATES.COLLECT_BIRTH, stateData);
        return this._reply('Qual a data de nascimento ou idade do paciente? (dd/mm/aaaa) 💚');
      }

      // 🔍 BUSCA 1: Tenta com data preferida (se houver)
      let slots = null;
      const preferredDate = stateData.preferredDate;
      
      if (preferredDate) {
        this.logger.info('V8_SLOT_SEARCH_PREFERRED_DATE', { leadId, preferredDate });
        slots = await Promise.race([
          findAvailableSlots({
            therapyArea,
            preferredPeriod: stateData.period,
            preferredDate: preferredDate.toISOString(),
            patientAge: stateData.age,
            maxDoctors: 2,
            maxDays: 7, // Busca em mais dias se tem data preferida
            timeoutMs: 5000,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('SLOT_SEARCH_TIMEOUT')), 5000)
          )
        ]);
      }
      
      // 🔍 BUSCA 2: Se não encontrou com data preferida, busca sem restrição de data
      if (!slots?.primary) {
        this.logger.info('V8_SLOT_SEARCH_FALLBACK', { leadId, preferredDate, reason: preferredDate ? 'no_slots_on_preferred' : 'no_preferred_date' });
        slots = await Promise.race([
          findAvailableSlots({
            therapyArea,
            preferredPeriod: stateData.period,
            patientAge: stateData.age,
            maxDoctors: 2,
            maxDays: 14, // Busca em até 14 dias à frente
            timeoutMs: 5000,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('SLOT_SEARCH_TIMEOUT')), 5000)
          )
        ]);
      }

      if (slots?.primary) {
        const options = buildSlotOptions(slots);
        const totalSlots = options.length;
        const datePrefix = preferredDate ? 'nas próximas datas disponíveis' : 'para você';
        this.logger.info('V8_SLOTS_FOUND', { leadId, totalSlots, primaryDoctor: slots.primary?.doctor, primaryDate: slots.primary?.date, hadPreferredDate: !!preferredDate });
        await leadRepository.persistSchedulingSlots(lead._id, slots);
        const optionsText = options.map(o => o.text).join('\n');
        return this._reply(`Encontrei essas opções ${datePrefix} 💚\n\n${optionsText}\n\nQual funciona melhor? (A, B, C...)`);
      }

      // ❌ NÃO ENCONTROU SLOTS - Handoff para equipe
      this.logger.warn('V8_NO_SLOTS_FOUND_COMPLETE', { leadId, therapyArea, period: stateData.period, preferredDate });
      await jumpToState(leadId, STATES.HANDOFF, stateData);
      return this._reply(`Hmm, não encontrei horários disponíveis para ${stateData.period || 'esse período'} nos próximos dias 😕\n\nVou transferir para nossa equipe que vai verificar a agenda completa e te retornar com as melhores opções! 💚\n\nAguarda só um minutinho...`);

    } catch (error) {
      this.logger.error('V8_SLOT_SEARCH_ERROR', { error: error.message, leadId, therapyArea: lead.therapyArea, isTimeout: error.message === 'SLOT_SEARCH_TIMEOUT' });
      return this._reply(`Estou verificando a agenda... Pode ser que eu precise de mais um instante! 💚\n\nEnquanto isso, prefere atendimento presencial ou online?`);
    }
  }

  // ═══════════════════════════════════════════
  // PERSISTÊNCIA ATÔMICA
  // ═══════════════════════════════════════════

  async _saveTherapy(leadId, therapy) {
    // 🔧 Normaliza therapy para string (pode vir como objeto de detectAllTherapies)
    let therapyString = therapy;
    if (typeof therapy === 'object' && therapy?.id) {
      const areaMap = {
        "neuropsychological": "neuropsicologia",
        "speech": "fonoaudiologia",
        "tongue_tie": "fonoaudiologia",
        "psychology": "psicologia",
        "occupational": "terapia_ocupacional",
        "physiotherapy": "fisioterapia",
        "music": "musicoterapia",
        "neuropsychopedagogy": "neuropsicologia",
        "psychopedagogy": "psicopedagogia",
        "occupational_therapy": "terapia_ocupacional",
      };
      therapyString = areaMap[therapy.id] || therapy.name || therapy;
    }
    await Leads.updateOne({ _id: leadId }, { $set: { therapyArea: therapyString } });
  }

  async _saveComplaint(leadId, complaint) {
    // BUG 1 FIX: autoBookingContext pode ser null no MongoDB — usar pipeline para inicializar antes de settar subcampo
    await Leads.updateOne({ _id: leadId }, [
      { $set: { autoBookingContext: { $ifNull: ['$autoBookingContext', {}] } } },
      { $set: { 'autoBookingContext.complaint': complaint } },
    ]);
  }

  async _saveComplaintAndAge(leadId, complaint, age) {
    // age já deve vir resolvido como número (use resolveAgeNumber antes de chamar)
    // BUG 1 FIX: usar pipeline para não falhar quando autoBookingContext é null
    await Leads.updateOne({ _id: leadId }, [
      { $set: { autoBookingContext: { $ifNull: ['$autoBookingContext', {}] } } },
      { $set: { 'autoBookingContext.complaint': complaint } },
    ]);
    if (age !== null && age !== undefined) {
      await Leads.updateOne({ _id: leadId }, { $set: { 'patientInfo.age': age } });
    }
  }

  async _saveAge(leadId, age, birth) {
    // age já deve vir resolvido como número (use resolveAgeNumber antes de chamar)
    const update = {};
    if (age !== null && age !== undefined) update['patientInfo.age'] = age;
    if (birth) update['patientInfo.birthDate'] = birth;
    await Leads.updateOne({ _id: leadId }, { $set: update });
  }

  async _savePeriod(leadId, period) {
    // BUG 1 FIX: usar pipeline para não falhar quando autoBookingContext é null
    await Leads.updateOne({ _id: leadId }, [
      { $set: { autoBookingContext: { $ifNull: ['$autoBookingContext', {}] } } },
      { $set: { 'autoBookingContext.preferredPeriod': period } },
    ]);
  }

  async _savePatientName(leadId, name) {
    await Leads.updateOne({ _id: leadId }, { $set: { 'patientInfo.fullName': name } });
  }

  async _clearState(leadId) {
    await Leads.updateOne({ _id: leadId }, {
      $set: {
        currentState: STATES.IDLE,
        stateData: {},
        stateStack: [],
        retryCount: 0,
        pendingSchedulingSlots: null,
        pendingChosenSlot: null,
        pendingPatientInfoStep: null,
      }
    });
  }

  // ═══════════════════════════════════════════
  // CIRCUIT BREAKERS (preservados do V7)
  // ═══════════════════════════════════════════

  _isHardStopMessage(text = '') {
    const lower = text.toLowerCase().trim();
    const isClosingStart = /^(obg|obrigad[oa]|valeu|tchau|at[ée] logo|boa (tarde|noite|dia))(\s|!|☺️|🙏|👍|$)/i.test(lower);
    if (isClosingStart) {
      const hasQuestion = /\b(quero|qual|como|onde|quando|vou agendar|marca)\b/i.test(lower);
      if (!hasQuestion) return true;
    }
    return /^[\u{1F44D}\u{1F64F}\u{263A}\u{2764}\u{1F49A}\u{2705}]+$/u.test(lower);
  }

  _isCancellation(text = '') {
    return /^(cancela|cancelar|desist|não quero mais|não vou agendar)/i.test(text.toLowerCase());
  }

  // ═══════════════════════════════════════════
  // NLU HELPER
  // ═══════════════════════════════════════════

  async _analyze(text, lead) {
    try {
      return await perceptionService.analyze(text, lead, {});
    } catch (e) {
      this.logger.warn('PERCEPTION_ERROR', { error: e.message });
      return null;
    }
  }

  // ═══════════════════════════════════════════
  // UTIL
  // ═══════════════════════════════════════════

  // Retorna true quando o lead está PERGUNTANDO se a clínica oferece determinada área
  // Ex: "Vocês têm fisio?", "possuem terapeuta ocupacional?", "tem fono aí?"
  _isAvailabilityQuestion(text = '') {
    const t = text.trim();
    
    // Método 1: Verificação básica (pergunta + palavras de disponibilidade)
    const basicCheck = t.endsWith('?') &&
      /\b(t[eê]m|possu[ei]m?|ofere[cç]e[mn]?|atend[ei]m?|h[aá]|existe[m]?|voc[eê]s?\s+tem|voc[eê]s?\s+possu)\b/i.test(t);
    
    if (basicCheck) return true;
    
    // Método 2: Usar flagsDetector para detecção mais robusta
    const flags = deriveFlagsFromText(text);
    if (flags.asksSpecialtyAvailability) return true;
    
    // Método 3: Padrões de pergunta de disponibilidade mais amplos
    const availabilityPatterns = [
      /gostaria\s+de\s+saber\s+se\s+(voc[eê]s?\s+)?(atende|tem)/i,
      /(voc[eê]s?|a\s+cl[ií]nica)\s+(atende|trabalha)\s+com/i,
      /preciso\s+de\s+\w+.*voc[eê]s?\s+t[eê]m/i,
      /tem\s+\w+\s+a[ií]/i,
      /(faz|fazem)\s+\w+\s+(aqui|na\s+cl[ií]nica)/i,
    ];
    
    return availabilityPatterns.some(p => p.test(t));
  }

  // Helper para converter ID de terapia em nome amigável
  _getTherapyDisplayName(therapyId) {
    const names = {
      neuropsychological: 'Neuropsicologia',
      speech: 'Fonoaudiologia',
      psychology: 'Psicologia',
      occupational: 'Terapia Ocupacional',
      physiotherapy: 'Fisioterapia',
      music: 'Musicoterapia',
      psychopedagogy: 'Psicopedagogia',
      neuropsychopedagogy: 'Neuropsicopedagogia',
      tongue_tie: 'Avaliação da Linguinha'
    };
    return names[therapyId] || therapyId;
  }

  // ═══════════════════════════════════════════
  // INSIGHTS: carrega do banco com cache de 1h
  // ═══════════════════════════════════════════

  async _getInsights() {
    const ONE_HOUR = 60 * 60 * 1000;
    if (this.insightsCache && (Date.now() - this.cacheTime) < ONE_HOUR) {
      return this.insightsCache;
    }
    try {
      const insights = await getLatestInsights();
      this.insightsCache = insights;
      this.cacheTime = Date.now();
      if (insights) {
        this.logger.info('V8_INSIGHTS_LOADED', {
          openings: insights.data?.bestOpeningLines?.length || 0,
          priceResponses: insights.data?.effectivePriceResponses?.length || 0,
          closingQuestions: insights.data?.successfulClosingQuestions?.length || 0,
        });
      }
      return insights;
    } catch (e) {
      this.logger.warn('V8_INSIGHTS_LOAD_FAILED', { error: e.message });
      return null;
    }
  }

  // ═══════════════════════════════════════════
  // REPLY: enriquece texto com flags + insights
  // ═══════════════════════════════════════════

  _reply(text, options = {}) {
    if (this.currentContext && !options.skipEnrichment) {
      const { flags, lead, state, insights } = this.currentContext;
      let enrichedText = text;

      // ── URGÊNCIA: prefixo de priorização ──────────────────────────────────
      if (flags.mentionsUrgency && !enrichedText.toLowerCase().includes('priorid') && !enrichedText.toLowerCase().includes('r[aá]pido')) {
        enrichedText = `Entendo a urgência 💚 Vou priorizar sua situação!\n\n${enrichedText}`;
      }

      // ── EMOCIONAL: acolhimento antes de qualquer informação ───────────────
      else if (flags.isEmotional && !enrichedText.includes('preocupad') && !enrichedText.includes('Entendo')) {
        enrichedText = `Entendo como você deve estar se sentindo 💚\n\n${enrichedText}`;
      }

      // ── TEA/TDAH: validação específica ────────────────────────────────────
      if (flags.mentionsTEA_TDAH && !enrichedText.includes('passo')) {
        enrichedText = enrichedText + '\n\n💚 Buscar ajuda especializada é um passo muito importante para o desenvolvimento do seu filho.';
      }

      // ── DÚVIDA DE TEA: reformula pergunta aberta ──────────────────────────
      if (flags.mentionsDoubtTEA && !enrichedText.includes('tempo')) {
        enrichedText = enrichedText.replace(
          /me conta um pouco da situação/i,
          'cada criança tem seu tempo, e é normal ter dúvidas. Me conta o que você tem observado'
        );
      }

      // ── OBJEÇÃO DE PREÇO: contextualiza antes de informar ────────────────
      if (flags.mentionsPriceObjection && !enrichedText.includes('investimento')) {
        enrichedText = enrichedText + '\n\n💚 Também temos opções de parcelamento que facilitam bastante.';
      }

      // ── HOT LEAD + insights reais de fechamento ───────────────────────────
      if (flags.isHotLead && insights?.data?.successfulClosingQuestions?.length > 0 && state !== STATES.SHOW_SLOTS && state !== STATES.CONFIRM_BOOKING) {
        const closingQ = insights.data.successfulClosingQuestions[0];
        if (closingQ?.question && !enrichedText.includes(closingQ.question.substring(0, 20))) {
          enrichedText = enrichedText + `\n\n${closingQ.question}`;
        }
      }

      // ── SÓ PESQUISANDO: tom educativo, sem pressão ────────────────────────
      if (flags.isJustBrowsing && enrichedText.toLowerCase().includes('agendar')) {
        enrichedText = enrichedText.replace(/agendar/gi, 'saber mais');
      }

      // ── OBJEÇÃO DE CONVÊNIO: bridge para particular ───────────────────────
      if (flags.mentionsInsuranceObjection && !enrichedText.includes('reembolso')) {
        enrichedText = enrichedText + '\n\n💡 Muitas famílias optam pelo particular e solicitam reembolso ao plano — posso te explicar como funciona se quiser!';
      }

      return { command: 'SEND_MESSAGE', payload: { text: enrichedText } };
    }

    return { command: 'SEND_MESSAGE', payload: { text } };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LLM RESPONSE — FSM decide o caminho, LLM formula a resposta
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Gera resposta via LLM (Groq → OpenAI fallback).
   * buildSystemPrompt: todas as RNs da clínica + modo emocional + aprendizados reais
   * buildUserPrompt: histórico da conversa + contexto do lead + mensagem atual
   *
   * @param {object} ctx        - Contexto da mensagem (this.currentContext)
   * @param {string} instruction- Estado FSM atual: o que a Amanda precisa coletar/fazer agora
   * @param {string} [clinicData]- Dados concretos para incluir na resposta (preço, horários, etc.)
   */
  async _replyWithAI(ctx, instruction = null, clinicData = null) {
    const promptMode = ctx?.promptMode || {};
    const userText = ctx?.text || '';
    const lead = ctx?.lead || {};

    const systemPrompt = buildSystemPrompt({
      ...promptMode,
      instruction,
      clinicContext: clinicData,
    });

    const userPrompt = buildUserPrompt(userText, {
      therapyArea: promptMode.therapyArea,
      patientAge: promptMode.patientAge,
      patientName: promptMode.patientName,
      complaint: promptMode.complaint,
      preferredPeriod: promptMode.preferredPeriod,
      emotionalContext: promptMode.emotionalContext,
      conversationHistory: lead.recentMessages || lead.interactions?.slice(-8).map(i => ({
        direction: i.direction,
        content: i.message || i.note || '',
      })) || [],
    });

    const aiText = await callAI({
      systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 350,
      temperature: 0.7,
    });

    // 🛡️ Enforcement: valida estrutura da resposta (preço, plano, agendamento, etc.)
    const { response: enforcedText, wasEnforced, validation } = enforce(
      aiText,
      { flags: ctx?.flags || {}, lead, userText },
      { strictMode: false, logViolations: true }
    );
    if (wasEnforced) {
      this.logger.warn('V8_ENFORCEMENT_FALLBACK', { violations: validation.violations.map(v => v.rule) });
    }

    // LLM já aplica tom/empatia/RNs — skipEnrichment evita duplicação
    return this._reply(enforcedText, { skipEnrichment: true });
  }

  _buildLPGreeting(lpData) {
    // Usa campos do lpData para montar saudação dinâmica — sem texto hardcoded por LP
    const intro = lpData.content?.quandoProcurar || lpData.subheadline || lpData.headline || '';
    const firstPain = lpData.sinaisAlerta?.[0]?.text;
    const painLine = firstPain ? `\n\n_(${firstPain})_` : '';
    return `Que bom que você entrou em contato! 💚\n\n${intro}${painLine}\n\nMe conta: quantos anos tem seu filho ou filha? 😊`;
  }

  _handoffReply() {
    return this._reply('Hmm, acho que seria melhor um(a) atendente conversar com você pessoalmente! 💚\n\nVou transferir sua conversa. Aguarda só um minutinho...');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RETRY INTELIGENTE: reformula a pergunta a cada tentativa
  // retryCount=1 → pergunta direta com exemplos
  // retryCount=2 → oferece opções concretas para escolher
  // ─────────────────────────────────────────────────────────────────────────

  _retryMessage(state, retryCount) {
    const messages = {
      [STATES.COLLECT_THERAPY]: [
        'Qual especialidade você busca? Pode ser fono, psico, fisio, TO, neuropsico ou psicopedagogia 💚',
        'Me ajuda a entender: é mais sobre *fala*, *comportamento*, *aprendizado* ou *desenvolvimento motor*? Assim consigo indicar o caminho certo 💚',
        'Pode escolher uma das opções abaixo?\n\n• Fono (fala, linguagem)\n• Psico (comportamento, emoção)\n• Fisio (motor)\n• TO (integração sensorial)\n• Neuropsico (laudo/diagnóstico)\n• Psicopedagogia (escola, leitura)',
      ],
      [STATES.COLLECT_COMPLAINT]: [
        'Me conta um pouco mais — o que chamou atenção no dia a dia que trouxe você até aqui? 💚',
        'O que você tem observado? Pode ser comportamento, fala, aprendizado, qualquer coisa que te preocupou 💚',
      ],
      [STATES.COLLECT_BIRTH]: [
        'Preciso da idade ou data de nascimento para buscar os horários certinhos 💚 Pode ser só a idade mesmo!',
        'Pode ser direto: "5 anos" ou "12/03/2020" — qualquer formato serve 💚',
      ],
      [STATES.COLLECT_PERIOD]: [
        'Qual horário funciona melhor: **manhã** (8h-12h) ou **tarde** (13h-18h)? ☀️🌙',
        'Prefere de manhã ou à tarde? Se tiver preferência de horário específico pode falar também 💚',
      ],
      [STATES.COLLECT_NAME]: [
        'Qual o nome completo do paciente? 💚',
        'Pode me passar o nome completo? É para confirmar o agendamento 💚',
      ],
    };

    const options = messages[state];
    if (!options) return null;

    // retryCount começa em 1 após o primeiro incremento
    const idx = Math.min(retryCount - 1, options.length - 1);
    return options[idx];
  }
}