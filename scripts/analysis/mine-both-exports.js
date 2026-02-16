#!/usr/bin/env node
/**
 * 🔍 ANALISA AMBOS EXPORTS - FASE 2
 *
 * Extrai padrões de PRICE e SCHEDULING de:
 * - whatsapp_export_2026-02-13.txt (37,494 linhas)
 * - whatsapp_export_2025-11-26.txt (37,514 linhas)
 * TOTAL: 75,008 linhas de dados reais
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🔍 ANÁLISE COMPLETA - AMBOS EXPORTS\n');
console.log('='.repeat(70));

// Lê ambos arquivos
const file1 = fs.readFileSync('/home/user/projetos/CRM-CLINICA/back/whatsapp_export_2026-02-13.txt', 'utf8');
const file2 = fs.readFileSync('/home/user/projetos/CRM-CLINICA/back/whatsapp_export_2025-11-26.txt', 'utf8');

const allLines = [...file1.split('\n'), ...file2.split('\n')];

console.log(`📊 Total de linhas analisadas: ${allLines.length.toLocaleString()}\n`);

// =========================================================================
// 💰 PADRÕES DE PREÇO
// =========================================================================
console.log('💰 PRICE PATTERNS\n' + '-'.repeat(70));

const pricePatterns = {
    // Insistência
    insistence: {
        patterns: [
            /\b(só|apenas|somente)\s*(o\s*)?(pre[çc]o|valor)/i,
            /\bfala\s*(o\s*|s[oó]\s*)?(pre[çc]o|valor)/i,
            /\bme\s+passa\s+(só\s+)?o\s+valor/i,
            /\bquanto\s+custa\s*$/i
        ],
        examples: []
    },

    // Objeção
    objection: {
        patterns: [
            /\b(muito|t[aá])\s+(caro|salgado|puxado)/i,
            /\bn[aã]o\s+cabe\s+no\s+bolso/i,
            /\b(encontrei|achei|vi)\s+(mais\s+)?(barato|em\s+conta)/i,
            /\boutra\s+cl[ií]nica\s+(é\s+)?mais\s+barato/i
        ],
        examples: []
    },

    // Negociação
    negotiation: {
        patterns: [
            /\b(tem|faz|d[aá])\s+(desconto|promo[çc][aã]o)/i,
            /\b(parcelar|dividir|parcela)/i,
            /\b(entrada|sinal)/i,
            /\bcondi[çc][aã]o\s+especial/i
        ],
        examples: []
    },

    // Comparação
    comparison: {
        patterns: [
            /\boutra\s+cl[ií]nica/i,
            /\bmais\s+(barato|em\s+conta|acess[ií]vel)/i,
            /\bpagar\s+menos/i
        ],
        examples: []
    },

    // Aceitação
    acceptance: {
        patterns: [
            /\b(ok|tudo\s+bem|perfeito)\b.*\b(valor|pre[çc]o)/i,
            /\baceito\s+o\s+valor/i,
            /\bpode\s+ser\s+esse\s+pre[çc]o/i
        ],
        examples: []
    }
};

// Analisa linhas
for (const line of allLines) {
    const lower = line.toLowerCase();

    // Insistência
    if (pricePatterns.insistence.patterns.some(p => p.test(lower))) {
        if (pricePatterns.insistence.examples.length < 10) {
            pricePatterns.insistence.examples.push(line.trim());
        }
    }

    // Objeção
    if (pricePatterns.objection.patterns.some(p => p.test(lower))) {
        if (pricePatterns.objection.examples.length < 10) {
            pricePatterns.objection.examples.push(line.trim());
        }
    }

    // Negociação
    if (pricePatterns.negotiation.patterns.some(p => p.test(lower))) {
        if (pricePatterns.negotiation.examples.length < 10) {
            pricePatterns.negotiation.examples.push(line.trim());
        }
    }

    // Comparação
    if (pricePatterns.comparison.patterns.some(p => p.test(lower))) {
        if (pricePatterns.comparison.examples.length < 10) {
            pricePatterns.comparison.examples.push(line.trim());
        }
    }

    // Aceitação
    if (pricePatterns.acceptance.patterns.some(p => p.test(lower))) {
        if (pricePatterns.acceptance.examples.length < 10) {
            pricePatterns.acceptance.examples.push(line.trim());
        }
    }
}

console.log('📊 Padrões encontrados:');
console.log(`   Insistência:   ${pricePatterns.insistence.examples.length} exemplos`);
console.log(`   Objeção:       ${pricePatterns.objection.examples.length} exemplos`);
console.log(`   Negociação:    ${pricePatterns.negotiation.examples.length} exemplos`);
console.log(`   Comparação:    ${pricePatterns.comparison.examples.length} exemplos`);
console.log(`   Aceitação:     ${pricePatterns.acceptance.examples.length} exemplos`);

if (pricePatterns.insistence.examples.length > 0) {
    console.log('\n📌 INSISTÊNCIA (exemplos):');
    pricePatterns.insistence.examples.slice(0, 5).forEach((ex, i) => {
        console.log(`   ${i + 1}. "${ex.substring(0, 80)}"`);
    });
}

if (pricePatterns.objection.examples.length > 0) {
    console.log('\n📌 OBJEÇÃO (exemplos):');
    pricePatterns.objection.examples.slice(0, 5).forEach((ex, i) => {
        console.log(`   ${i + 1}. "${ex.substring(0, 80)}"`);
    });
}

if (pricePatterns.negotiation.examples.length > 0) {
    console.log('\n📌 NEGOCIAÇÃO (exemplos):');
    pricePatterns.negotiation.examples.slice(0, 5).forEach((ex, i) => {
        console.log(`   ${i + 1}. "${ex.substring(0, 80)}"`);
    });
}

// =========================================================================
// 📅 PADRÕES DE SCHEDULING
// =========================================================================
console.log('\n\n📅 SCHEDULING PATTERNS\n' + '-'.repeat(70));

const schedulingPatterns = {
    // Urgência
    urgency: {
        patterns: [
            /\b(urgente|urg[êe]ncia)/i,
            /\b(logo|r[aá]pido|quanto\s+antes)/i,
            /\bhoje\b/i,
            /\bamanh[ãa]\b/i,
            /\bessa\s+semana\b/i
        ],
        examples: []
    },

    // Remarcação
    reschedule: {
        patterns: [
            /\b(remarcar|reagendar)/i,
            /\bmudar\s+(o\s+)?hor[aá]rio/i,
            /\btrocar\s+(o\s+)?hor[aá]rio/i,
            /\balterar\s+(a\s+)?data/i,
            /\bdesmarcar/i
        ],
        examples: []
    },

    // Período manhã
    periodMorning: {
        patterns: [
            /\bmanh[ãa]\b/i,
            /\b(cedo|cedinho)/i,
            /\bantes?\s+do\s+meio[-\s]*dia/i
        ],
        examples: []
    },

    // Período tarde
    periodAfternoon: {
        patterns: [
            /\btarde\b/i,
            /\bdepois\s+do\s+almo[cç]o/i,
            /\b(14|15|16|17)h/i
        ],
        examples: []
    },

    // Cancelamento
    cancellation: {
        patterns: [
            /\bcancelar/i,
            /\bn[aã]o\s+vou\s+poder/i,
            /\bimprevisto/i,
            /\bsurgiu\s+um\s+problema/i
        ],
        examples: []
    },

    // Flexibilidade
    flexibility: {
        patterns: [
            /\bqualquer\s+hor[aá]rio/i,
            /\btanto\s+faz/i,
            /\b(pode\s+ser\s+)?qualquer\s+dia/i
        ],
        examples: []
    }
};

// Analisa linhas
for (const line of allLines) {
    const lower = line.toLowerCase();

    // Urgência
    if (schedulingPatterns.urgency.patterns.some(p => p.test(lower))) {
        if (schedulingPatterns.urgency.examples.length < 10) {
            schedulingPatterns.urgency.examples.push(line.trim());
        }
    }

    // Remarcação
    if (schedulingPatterns.reschedule.patterns.some(p => p.test(lower))) {
        if (schedulingPatterns.reschedule.examples.length < 10) {
            schedulingPatterns.reschedule.examples.push(line.trim());
        }
    }

    // Período manhã
    if (schedulingPatterns.periodMorning.patterns.some(p => p.test(lower))) {
        if (schedulingPatterns.periodMorning.examples.length < 10) {
            schedulingPatterns.periodMorning.examples.push(line.trim());
        }
    }

    // Período tarde
    if (schedulingPatterns.periodAfternoon.patterns.some(p => p.test(lower))) {
        if (schedulingPatterns.periodAfternoon.examples.length < 10) {
            schedulingPatterns.periodAfternoon.examples.push(line.trim());
        }
    }

    // Cancelamento
    if (schedulingPatterns.cancellation.patterns.some(p => p.test(lower))) {
        if (schedulingPatterns.cancellation.examples.length < 10) {
            schedulingPatterns.cancellation.examples.push(line.trim());
        }
    }

    // Flexibilidade
    if (schedulingPatterns.flexibility.patterns.some(p => p.test(lower))) {
        if (schedulingPatterns.flexibility.examples.length < 10) {
            schedulingPatterns.flexibility.examples.push(line.trim());
        }
    }
}

console.log('📊 Padrões encontrados:');
console.log(`   Urgência:      ${schedulingPatterns.urgency.examples.length} exemplos`);
console.log(`   Remarcação:    ${schedulingPatterns.reschedule.examples.length} exemplos`);
console.log(`   Manhã:         ${schedulingPatterns.periodMorning.examples.length} exemplos`);
console.log(`   Tarde:         ${schedulingPatterns.periodAfternoon.examples.length} exemplos`);
console.log(`   Cancelamento:  ${schedulingPatterns.cancellation.examples.length} exemplos`);
console.log(`   Flexibilidade: ${schedulingPatterns.flexibility.examples.length} exemplos`);

if (schedulingPatterns.urgency.examples.length > 0) {
    console.log('\n📌 URGÊNCIA (exemplos):');
    schedulingPatterns.urgency.examples.slice(0, 5).forEach((ex, i) => {
        console.log(`   ${i + 1}. "${ex.substring(0, 80)}"`);
    });
}

if (schedulingPatterns.reschedule.examples.length > 0) {
    console.log('\n📌 REMARCAÇÃO (exemplos):');
    schedulingPatterns.reschedule.examples.slice(0, 5).forEach((ex, i) => {
        console.log(`   ${i + 1}. "${ex.substring(0, 80)}"`);
    });
}

if (schedulingPatterns.periodMorning.examples.length > 0) {
    console.log('\n📌 MANHÃ (exemplos):');
    schedulingPatterns.periodMorning.examples.slice(0, 5).forEach((ex, i) => {
        console.log(`   ${i + 1}. "${ex.substring(0, 80)}"`);
    });
}

// =========================================================================
// 💾 SALVA RESULTADOS
// =========================================================================
const outputPath = path.join(__dirname, '../../config/mined-patterns/fase2-both-exports.json');
const output = {
    metadata: {
        totalLines: allLines.length,
        files: [
            'whatsapp_export_2026-02-13.txt',
            'whatsapp_export_2025-11-26.txt'
        ],
        generatedAt: new Date().toISOString()
    },
    price: pricePatterns,
    scheduling: schedulingPatterns
};

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

console.log('\n' + '='.repeat(70));
console.log(`\n✅ Análise completa salva em: ${outputPath}`);
console.log('\n🚀 PADRÕES EXTRAÍDOS DE 75K LINHAS!\n');
