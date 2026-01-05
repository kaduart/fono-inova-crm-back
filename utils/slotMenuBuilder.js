// utils/slotMenuBuilder.js - VERSÃO COMPLETA
import { formatSlot } from "../services/amandaBookingService.js";

// ============================================================================
// 🔧 HELPERS
// ============================================================================

/**
 * Retorna período baseado na hora (string "HH:MM")
 */
function getTimePeriod(time) {
    if (!time) return null;
    const hour = parseInt(String(time).slice(0, 2), 10);
    if (isNaN(hour)) return null;
    if (hour < 12) return "manhã";
    if (hour < 18) return "tarde";
    return "noite";
}

/**
 * Monta array de opções A/B/C/D/E/F a partir do slotsCtx
 */
function buildSlotOptions(slotsCtx) {
    if (!slotsCtx) return [];

    const allSlots = [
        slotsCtx.primary,
        ...(slotsCtx.alternativesSamePeriod || []),
        ...(slotsCtx.alternativesOtherPeriod || []),
    ].filter(Boolean);

    const letters = "ABCDEF".split("");

    return allSlots.slice(0, 6).map((slot, i) => ({
        letter: letters[i],
        slot,
        text: `**${letters[i]})** ${formatSlot(slot)}`,
        period: getTimePeriod(slot?.time),
    }));
}

// ============================================================================
// 🎰 EXPORTS
// ============================================================================

export function buildSlotMenuMessage(
    slotsCtx,
    {
        title = "Tenho esses horários no momento:",
        question = null,
        max = null,
    } = {}
) {
    const effectiveMax = max ?? slotsCtx?.maxOptions ?? 2;
    const opts = buildSlotOptions(slotsCtx).slice(0, effectiveMax);
    if (!opts.length) return { message: null, optionsText: "", ordered: [], letters: [] };

    const letters = opts.map(o => o.letter);
    const ordered = opts.map(o => o.slot);
    const optionsText = opts.map(o => o.text).join("\n");

    const effectiveQuestion = question ?? (
        letters.length === 2
            ? "Qual você prefere? (A ou B)"
            : `Qual você prefere? (${letters.join(", ")})`
    );

    const message = `${title}\n\n${optionsText}\n\n${effectiveQuestion} 💚`;

    return { message, optionsText, ordered, letters };
}

export function buildSlotMenuMessageForPeriod(
    slotsCtx,
    period,
    {
        title = "Tenho esses horários no momento:",
        question = "Qual você prefere? (responda com a letra)",
        max = 2,
    } = {}
) {
    if (!slotsCtx) return { message: null, optionsText: "", ordered: [], letters: [] };

    const desired = String(period || "").toLowerCase();
    const opts = buildSlotOptions(slotsCtx)
        .filter((o) => getTimePeriod(o.slot?.time) === desired)
        .slice(0, max);

    if (!opts.length) return { message: null, optionsText: "", ordered: [], letters: [] };

    const letters = opts.map(o => o.letter);
    const ordered = opts.map(o => o.slot);
    const optionsText = opts.map(o => o.text).join("\n");

    const message = `${title}\n\n${optionsText}\n\n${question} 💚`;

    return { message, optionsText, ordered, letters };
}