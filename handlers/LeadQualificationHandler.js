// handlers/LeadQualificationHandler.js

import callAI from '../services/IA/Aiproviderservice.js';
import { DYNAMIC_MODULES } from '../utils/amandaPrompt.js';
import Logger from '../services/utils/Logger.js';
import ensureSingleHeart from '../utils/helpers.js';

class LeadQualificationHandler {
    constructor() {
        this.logger = new Logger('LeadQualificationHandler');
    }

    async execute({ decisionContext, services }) {
        try {
            const { memory, analysis, missing, message } = decisionContext;

            // ===========================
            // 1️⃣ MONTA CONTEXTO
            // ===========================
            const leadName = memory?.name?.split(' ')[0] || null;
            const patientAge = memory?.patientAge || analysis?.extractedInfo?.age || null;
            const therapyArea = memory?.therapyArea || analysis?.therapyArea || null;
            const isFirstContact = memory?.isFirstContact || false;
            const history = memory?.conversationHistory || [];

            // ===========================
            // 2️⃣ SELECIONA MÓDULOS
            // ===========================
            const modules = [
                DYNAMIC_MODULES.acolhimentoModeContext,
                DYNAMIC_MODULES.valueProposition,
                DYNAMIC_MODULES.clinicalStrategyContext,
            ];

            // Perfil por idade
            if (patientAge) {
                if (patientAge < 13) modules.push(DYNAMIC_MODULES.childProfile);
                else if (patientAge < 18) modules.push(DYNAMIC_MODULES.teenProfile);
                else modules.push(DYNAMIC_MODULES.adultProfile);
            }

            // Módulo da especialidade
            const therapyModules = {
                'fonoaudiologia': DYNAMIC_MODULES.speechContext,
                'fono': DYNAMIC_MODULES.speechContext,
                'psicologia': DYNAMIC_MODULES.psycoContext,
                'terapia ocupacional': DYNAMIC_MODULES.occupationalContext,
                'fisioterapia': DYNAMIC_MODULES.physioContext,
                'neuropsicologia': DYNAMIC_MODULES.neuroPsychContext,
                'musicoterapia': DYNAMIC_MODULES.musicTherapyContext,
                'psicopedagogia': DYNAMIC_MODULES.psychopedContext,
            };
            const therapyMod = therapyModules[therapyArea?.toLowerCase()];
            if (therapyMod) modules.push(therapyMod);

            // ===========================
            // 3️⃣ DEFINE OBJETIVO
            // ===========================
            let objetivo = '';
            if (missing.needsTherapy) {
                objetivo = 'Descobrir qual área de terapia o lead procura (fono, psicologia, TO, fisio, etc).';
            } else if (missing.needsAge) {
                objetivo = 'Descobrir a idade do paciente de forma natural e acolhedora.';
            } else if (missing.needsPeriod) {
                objetivo = 'Descobrir qual período prefere (manhã ou tarde) para o atendimento.';
            } else {
                objetivo = 'Todas as informações foram coletadas. Agradecer e informar que vai verificar horários.';
            }

            // ===========================
            // 4️⃣ MONTA HISTÓRICO
            // ===========================
            const historyText = history.slice(-6).map(h =>
                `${h.role === 'user' ? 'Lead' : 'Amanda'}: ${h.content}`
            ).join('\n');

            // ===========================
            // 5️⃣ MONTA PROMPT
            // ===========================
            const systemPrompt = `Você é a Amanda, assistente virtual da Clínica Fono Inova.

${modules.join('\n\n')}

REGRAS DE ESTILO:
- Seja acolhedora, humana, nunca robótica
- Use no MÁXIMO 2-3 frases curtas
- Exatamente 1 💚 no final
- Pode usar 1 emoji leve (😊, ✨) se fizer sentido
- NUNCA repita perguntas já feitas no histórico
- Se o lead já informou algo, reconheça e avance
`.trim();

            const userPrompt = `
CONTEXTO DO LEAD:
- Nome: ${leadName || 'não informado'}
- Idade do paciente: ${patientAge || 'não informada'}
- Área de interesse: ${therapyArea || 'não informada'}
- Primeiro contato: ${isFirstContact ? 'SIM' : 'NÃO'}

HISTÓRICO RECENTE:
${historyText || '(primeira mensagem)'}

ÚLTIMA MENSAGEM DO LEAD:
"${message.text}"

SEU OBJETIVO AGORA:
${objetivo}

Gere APENAS o texto da resposta (sem explicações, sem "Amanda:").
`.trim();

            // ===========================
            // 6️⃣ CHAMA A LLM
            // ===========================
            const response = await callAI({
                systemPrompt,
                messages: [{ role: 'user', content: userPrompt }],
                maxTokens: 150,
                temperature: 0.7
            });

            const finalText = ensureSingleHeart(response || 'Posso te ajudar com mais alguma informação? 💚');

            return {
                text: finalText,
                extractedInfo: {}
            };

        } catch (error) {
            this.logger.error('Erro no LeadQualificationHandler', error);
            return {
                text: 'Me conta um pouquinho mais sobre o que você precisa? Estou aqui pra te ajudar 💚'
            };
        }
    }
}

export default new LeadQualificationHandler();