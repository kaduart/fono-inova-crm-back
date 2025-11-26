import { analyzeLeadMessage } from "./leadIntelligence.js";

/**
 * Deriva um "tipo de follow-up" a partir do histórico e do último texto do lead.
 * A ideia é ter poucos cenários claros e fáceis de mapear para mensagem.
 */
export function deriveFollowUpScenario({ lastUserText, lead, history, daysSinceLastContact }) {
    const { extracted, intent, segment } = analyzeLeadMessage({
        text: lastUserText,
        lead,
        history,
    });

    // Se for reclamação ou sentimento negativo -> melhor humano
    if (intent.needsHumanReview) {
        return { type: 'precisa_atendente_humana', extracted, intent, segment };
    }

    // HOT lead sumido depois de falar de agendar/preço
    if (segment.label === 'hot') {
        if (extracted.bloqueioDecisao === 'consultar_terceiro') {
            return { type: 'aguardando_decisao_terceiro', extracted, intent, segment };
        }
        if (extracted.bloqueioDecisao === 'avaliar_preco') {
            return { type: 'aguardando_analise_preco', extracted, intent, segment };
        }
        if (extracted.bloqueioDecisao === 'ajustar_rotina') {
            return { type: 'aguardando_ajuste_rotina', extracted, intent, segment };
        }
        // Se não tem bloqueio explícito, mas é hot e parou depois de falar de preço/agendar
        if (intent.primary === 'informacao_preco' || intent.primary === 'agendar_avaliacao') {
            return { type: 'hot_sumiu_apos_orcamento', extracted, intent, segment };
        }
    }

    // Warm: manter aquecido, convidando pra visita leve
    if (segment.label === 'warm') {
        return { type: 'manter_aquecido', extracted, intent, segment };
    }

    // Cold: lembrar de forma bem leve
    return { type: 'lembrar_bem_leve', extracted, intent, segment };
}
