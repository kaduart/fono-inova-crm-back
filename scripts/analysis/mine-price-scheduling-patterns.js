#!/usr/bin/env node
/**
 * 🔍 EXTRATOR DE PADRÕES - PRICE & SCHEDULING (FASE 2)
 *
 * Analisa dados reais para extrair padrões específicos:
 * - PRICE: Insistência, objeção, urgência
 * - SCHEDULING: Urgência, remarcação, período preferido
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Lê dados já minerados
const analysisPath = path.join(__dirname, '../../config/mined-patterns/analysis-complete.json');
const analysis = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));

console.log('🔍 ANÁLISE FASE 2 - PRICE & SCHEDULING\n');
console.log('='.repeat(60));

// =========================================================================
// 📊 ANÁLISE DE PRICE (234 ocorrências)
// =========================================================================
console.log('\n💰 PRICE PATTERNS (234 ocorrências)\n' + '-'.repeat(60));

const priceContexts = analysis.intents.price.contexts;
const priceAnalysis = {
    insistence: [],      // "só o preço", "apenas o valor"
    objection: [],       // "tá caro", "muito caro"
    urgency: [],         // "preciso saber logo"
    negotiation: [],     // "desconto", "condição"
    acceptance: []       // "ok com o valor", "tudo bem"
};

// Analisa contextos de preço
for (const [idx, context] of Object.entries(priceContexts)) {
    const text = (context.current || '').toLowerCase();
    const before = (context.before || '').toLowerCase();
    const after = (context.after || '').toLowerCase();
    const combined = `${before} ${text} ${after}`;

    // Insistência em preço
    if (/(só|apenas|somente)\s*(o\s*)?(preço|valor)/i.test(combined)) {
        priceAnalysis.insistence.push({ text, before, after });
    }

    // Objeção de preço
    if (/(caro|barato|puxado|salgado|n[aã]o\s+cabe\s+no\s+bolso)/i.test(combined)) {
        priceAnalysis.objection.push({ text, before, after });
    }

    // Urgência
    if (/(urgente|logo|r[aá]pido|quanto\s+antes)/i.test(combined)) {
        priceAnalysis.urgency.push({ text, before, after });
    }

    // Negociação
    if (/(desconto|condi[çc][aã]o|parcelar|dividir|entrada)/i.test(combined)) {
        priceAnalysis.negotiation.push({ text, before, after });
    }

    // Aceitação
    if (/(ok|tudo\s+bem|perfeito|pode\s+ser|aceito).*((valor|pre[çc]o)|r\$)/i.test(combined)) {
        priceAnalysis.acceptance.push({ text, before, after });
    }
}

console.log('📊 Padrões detectados:');
console.log(`   Insistência:  ${priceAnalysis.insistence.length}x`);
console.log(`   Objeção:      ${priceAnalysis.objection.length}x`);
console.log(`   Urgência:     ${priceAnalysis.urgency.length}x`);
console.log(`   Negociação:   ${priceAnalysis.negotiation.length}x`);
console.log(`   Aceitação:    ${priceAnalysis.acceptance.length}x`);

// Mostra exemplos
if (priceAnalysis.insistence.length > 0) {
    console.log('\n📌 Exemplos de INSISTÊNCIA:');
    priceAnalysis.insistence.slice(0, 3).forEach((item, i) => {
        console.log(`   ${i + 1}. "${item.text}"`);
    });
}

if (priceAnalysis.objection.length > 0) {
    console.log('\n📌 Exemplos de OBJEÇÃO:');
    priceAnalysis.objection.slice(0, 3).forEach((item, i) => {
        console.log(`   ${i + 1}. "${item.text}"`);
    });
}

if (priceAnalysis.negotiation.length > 0) {
    console.log('\n📌 Exemplos de NEGOCIAÇÃO:');
    priceAnalysis.negotiation.slice(0, 3).forEach((item, i) => {
        console.log(`   ${i + 1}. "${item.text}"`);
    });
}

// =========================================================================
// 📅 ANÁLISE DE SCHEDULING (306 ocorrências)
// =========================================================================
console.log('\n\n📅 SCHEDULING PATTERNS (306 ocorrências)\n' + '-'.repeat(60));

const schedulingContexts = analysis.intents.scheduling.contexts;
const schedulingAnalysis = {
    urgency: [],         // "urgente", "logo", "hoje"
    reschedule: [],      // "remarcar", "mudar horário"
    newBooking: [],      // "agendar", "marcar"
    periodMorning: [],   // "manhã"
    periodAfternoon: [], // "tarde"
    periodFlexible: [],  // "qualquer horário"
    cancellation: []     // "cancelar", "desmarcar"
};

// Analisa contextos de agendamento
for (const [idx, context] of Object.entries(schedulingContexts)) {
    const text = (context.current || '').toLowerCase();
    const before = (context.before || '').toLowerCase();
    const after = (context.after || '').toLowerCase();
    const combined = `${before} ${text} ${after}`;

    // Urgência
    if (/(urgente|logo|r[aá]pido|quanto\s+antes|hoje|amanhã)/i.test(combined)) {
        schedulingAnalysis.urgency.push({ text, before, after });
    }

    // Remarcação
    if (/(remarcar|reagendar|mudar\s+hor[aá]rio|trocar\s+hor[aá]rio|alterar\s+data)/i.test(combined)) {
        schedulingAnalysis.reschedule.push({ text, before, after });
    }

    // Novo agendamento
    if (/(agendar|marcar|quero\s+agendar|gostaria\s+de\s+agendar)(?!.*remarcar)/i.test(combined)) {
        schedulingAnalysis.newBooking.push({ text, before, after });
    }

    // Período manhã
    if (/\bmanh[ãa]\b/i.test(combined)) {
        schedulingAnalysis.periodMorning.push({ text, before, after });
    }

    // Período tarde
    if (/\btarde\b/i.test(combined)) {
        schedulingAnalysis.periodAfternoon.push({ text, before, after });
    }

    // Flexível
    if (/(qualquer\s+hor[aá]rio|tanto\s+faz|pode\s+ser\s+qualquer)/i.test(combined)) {
        schedulingAnalysis.periodFlexible.push({ text, before, after });
    }

    // Cancelamento
    if (/(cancelar|desmarcar|n[aã]o\s+vou\s+poder)/i.test(combined)) {
        schedulingAnalysis.cancellation.push({ text, before, after });
    }
}

console.log('📊 Padrões detectados:');
console.log(`   Urgência:     ${schedulingAnalysis.urgency.length}x`);
console.log(`   Remarcação:   ${schedulingAnalysis.reschedule.length}x`);
console.log(`   Novo:         ${schedulingAnalysis.newBooking.length}x`);
console.log(`   Manhã:        ${schedulingAnalysis.periodMorning.length}x`);
console.log(`   Tarde:        ${schedulingAnalysis.periodAfternoon.length}x`);
console.log(`   Flexível:     ${schedulingAnalysis.periodFlexible.length}x`);
console.log(`   Cancelamento: ${schedulingAnalysis.cancellation.length}x`);

// Mostra exemplos
if (schedulingAnalysis.urgency.length > 0) {
    console.log('\n📌 Exemplos de URGÊNCIA:');
    schedulingAnalysis.urgency.slice(0, 3).forEach((item, i) => {
        console.log(`   ${i + 1}. "${item.text}"`);
    });
}

if (schedulingAnalysis.reschedule.length > 0) {
    console.log('\n📌 Exemplos de REMARCAÇÃO:');
    schedulingAnalysis.reschedule.slice(0, 3).forEach((item, i) => {
        console.log(`   ${i + 1}. "${item.text}"`);
    });
}

if (schedulingAnalysis.periodMorning.length > 0) {
    console.log('\n📌 Exemplos de PERÍODO MANHÃ:');
    schedulingAnalysis.periodMorning.slice(0, 3).forEach((item, i) => {
        console.log(`   ${i + 1}. "${item.text}"`);
    });
}

// =========================================================================
// 💾 SALVA RESULTADOS
// =========================================================================
const outputPath = path.join(__dirname, '../../config/mined-patterns/fase2-price-scheduling.json');
const fase2Data = {
    price: {
        total: 234,
        patterns: priceAnalysis,
        distribution: {
            insistence: ((priceAnalysis.insistence.length / 234) * 100).toFixed(1) + '%',
            objection: ((priceAnalysis.objection.length / 234) * 100).toFixed(1) + '%',
            urgency: ((priceAnalysis.urgency.length / 234) * 100).toFixed(1) + '%',
            negotiation: ((priceAnalysis.negotiation.length / 234) * 100).toFixed(1) + '%'
        }
    },
    scheduling: {
        total: 306,
        patterns: schedulingAnalysis,
        distribution: {
            urgency: ((schedulingAnalysis.urgency.length / 306) * 100).toFixed(1) + '%',
            reschedule: ((schedulingAnalysis.reschedule.length / 306) * 100).toFixed(1) + '%',
            periodMorning: ((schedulingAnalysis.periodMorning.length / 306) * 100).toFixed(1) + '%',
            periodAfternoon: ((schedulingAnalysis.periodAfternoon.length / 306) * 100).toFixed(1) + '%'
        }
    },
    generatedAt: new Date().toISOString()
};

fs.writeFileSync(outputPath, JSON.stringify(fase2Data, null, 2));

console.log('\n' + '='.repeat(60));
console.log(`\n✅ Análise salva em: ${outputPath}`);
console.log('\n🚀 DADOS PRONTOS PARA CRIAR DETECTORES FASE 2!\n');
