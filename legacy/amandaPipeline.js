// services/amandaPipeline.js

import { mapFlagsToBookingProduct } from '../utils/bookingProductMapper.js';
import { detectAllFlags } from '../utils/flagsDetector.js';
import { generateAmandaReply } from './aiAmandaService.js';
import { analyzeLeadMessage } from './intelligence/leadIntelligence.js';

export async function runAmandaPipeline({ text, lead, context }) {
    // 1. Detecta flags (única fonte da verdade)
    const flags = detectAllFlags(text, lead, context);

    // 2. Analisa lead (única fonte da verdade)
    const analysis = await analyzeLeadMessage({ text, lead, history: context.history });

    // 3. Mapeia produto
    const bookingProduct = mapFlagsToBookingProduct(flags, lead);

    // 4. Decide fluxo
    if (flags.wantsSchedule) {
        return await handleSchedulingFlow({ flags, analysis, bookingProduct });
    }

    if (flags.asksPrice) {
        return await handlePriceFlow({ flags, analysis });
    }

    // 5. Fluxo genérico
    return await generateAmandaReply({ userText: text, lead, context });
}