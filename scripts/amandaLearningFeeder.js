#!/usr/bin/env node
/**
 * 🧠 AMANDA LEARNING FEEDER
 * 
 * Sistema de alimentação de aprendizado da Amanda:
 * 1. Extrai padrões de conversas reais (logs, mensagens)
 * 2. Cria cenários de teste baseados em erros/falhas
 * 3. Alimenta o AmandaLearningService com insights
 * 4. Gera relatório de melhorias sugeridas
 * 
 * Uso: node scripts/amandaLearningFeeder.js [opções]
 *   --from-logs       Analisa arquivo de logs
 *   --from-messages   Analisa mensagens do MongoDB
 *   --dry-run         Apenas simula, não salva
 *   --auto-fix        Tenta criar correções automaticamente
 */

import 'dotenv/config';
import mongoose from 'mongoose';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Message from '../models/Message.js';
import Leads from '../models/Leads.js';
import LearningInsight from '../models/LearningInsight.js';
import { deriveFlagsFromText } from '../utils/flagsDetector.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

// Configurações
const CONFIG = {
    MIN_MESSAGE_LENGTH: 3,
    MAX_PATTERN_LENGTH: 200,
    CONFIDENCE_THRESHOLD: 0.7,
    MIN_OCCURRENCES: 2,
};

// Categorias de padrões para extrair
const PATTERN_CATEGORIES = {
    SCHEDULING_REQUESTS: {
        name: 'Solicitações de Agendamento',
        patterns: [
            /\btem vaga\b/i,
            /\bquais os dias\b/i,
            /\bquando tem\b/i,
            /\bagendar\b/i,
            /\bmarcar\b/i,
            /\bconsulta\b/i,
            /\bdisponibilidade\b/i,
        ]
    },
    MORE_OPTIONS: {
        name: 'Pedidos de Mais Opções',
        patterns: [
            /\bmais cedo\b/i,
            /\boutro hor[áa]rio\b/i,
            /\boutro dia\b/i,
            /\bnenhum desses\b/i,
            /\bn[ãa]o serve\b/i,
            /\bmais tarde\b/i,
            /\boutra data\b/i,
            /\boutra op[çc][ãa]o\b/i,
        ]
    },
    PARTNERSHIP: {
        name: 'Parceria/Currículo',
        patterns: [
            /\bcurr[ií]culo\b/i,
            /\bcurriculo\b/i,
            /\bparceria\b/i,
            /\bvaga de trabalho\b/i,
            /\bvaga de emprego\b/i,
            /\btrabalhar com voc[êe]s\b/i,
            /\bcredenciamento\b/i,
        ]
    },
    CONFIRMATION: {
        name: 'Confirmação de Dados',
        patterns: [
            /\bconfirmo\b/i,
            /\bpode ser\b/i,
            /\best[áa] bom\b/i,
            /\bok\b/i,
            /\bfechado\b/i,
        ]
    },
    OBJECTION: {
        name: 'Objeções',
        patterns: [
            /\bcaro\b/i,
            /\bsair mais barato\b/i,
            /\bfora do or[çc]amento\b/i,
            /\bmuito longe\b/i,
            /\bn[ãa]o posso pagar\b/i,
        ]
    }
};

/**
 * 🧹 Limpa e normaliza texto
 */
function cleanText(text) {
    if (!text) return '';
    return String(text)
        .replace(/\d{1,2}:\d{2}(:\d{2})?/g, '')
        .replace(/\d{1,2}\/\d{1,2}\/\d{2,4}/g, '')
        .replace(/wa-wordmark-refreshed:/gi, '')
        .replace(/\[.*?\]/g, '')
        .replace(/Clínica Fono Inova:/gi, '')
        .replace(/\+55\s?\d{2}\s?\d{4,5}-?\d{4}/g, '')
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 🔍 Extrai padrões de um arquivo de logs
 */
async function extractPatternsFromLogs(logPath) {
    console.log(`📁 Analisando logs: ${logPath}`);
    
    if (!existsSync(logPath)) {
        console.error(`❌ Arquivo não encontrado: ${logPath}`);
        return [];
    }

    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');
    
    const patterns = {
        scheduling: [],
        moreOptions: [],
        partnership: [],
        misclassified: []
    };

    let currentContext = {};

    for (const line of lines) {
        // Extrai mensagens do cliente
        const contentMatch = line.match(/content: '(.+?)'/);
        if (contentMatch) {
            const text = cleanText(contentMatch[1]);
            if (text.length < CONFIG.MIN_MESSAGE_LENGTH) continue;

            const flags = deriveFlagsFromText(text);
            
            // Detecta possíveis erros de classificação
            const hasVaga = /\btem vaga\b/i.test(text);
            const hasTrabalho = /\btrabalho|emprego|curr[ií]culo\b/i.test(text);
            const hasAgendamento = /\bdia|hor[áa]rio|agendar|marcar|consulta\b/i.test(text);

            // Caso P1: "tem vaga" sem contexto de trabalho → deveria ser agendamento
            if (hasVaga && !hasTrabalho && flags.wantsPartnershipOrResume && !hasAgendamento) {
                patterns.misclassified.push({
                    text,
                    expectedIntent: 'scheduling',
                    detectedIntent: 'partnership',
                    reason: 'vaga sem contexto de trabalho'
                });
            }

            // Caso P2: Detecta wantsMoreOptions
            if (flags.wantsMoreOptions) {
                patterns.moreOptions.push({
                    text,
                    flags,
                    context: { ...currentContext }
                });
            }

            // Salva contexto atual
            currentContext.lastMessage = text;
            currentContext.lastFlags = flags;
        }

        // Extrai flags detectadas
        const flagsMatch = line.match(/wantsPartnershipOrResume: (true|false)/);
        if (flagsMatch) {
            currentContext.wantsPartnership = flagsMatch[1] === 'true';
        }
    }

    console.log(`  📊 Padrões encontrados:`);
    console.log(`     - Mal classificados (P1): ${patterns.misclassified.length}`);
    console.log(`     - Mais opções (P2): ${patterns.moreOptions.length}`);

    return patterns;
}

/**
 * 📊 Extrai padrões das mensagens do MongoDB
 */
async function extractPatternsFromDB(options = {}) {
    console.log('🗄️  Analisando mensagens do MongoDB...');

    const query = {
        type: 'text',
        direction: 'inbound',
        ...(options.since && { timestamp: { $gte: new Date(options.since) } })
    };

    const messages = await Message.find(query)
        .sort({ timestamp: -1 })
        .limit(options.limit || 1000)
        .lean();

    console.log(`  📨 ${messages.length} mensagens analisadas`);

    const patterns = {
        byCategory: {},
        flagDistribution: {},
        commonPhrases: {},
        misclassified: []
    };

    // Inicializa categorias
    for (const [key, cat] of Object.entries(PATTERN_CATEGORIES)) {
        patterns.byCategory[key] = [];
    }

    for (const msg of messages) {
        const text = cleanText(msg.content || msg.text);
        if (text.length < CONFIG.MIN_MESSAGE_LENGTH) continue;

        const flags = deriveFlagsFromText(text);

        // Conta distribuição de flags
        for (const [flag, value] of Object.entries(flags)) {
            if (value === true) {
                patterns.flagDistribution[flag] = (patterns.flagDistribution[flag] || 0) + 1;
            }
        }

        // Categoriza por padrões
        for (const [catKey, cat] of Object.entries(PATTERN_CATEGORIES)) {
            const matches = cat.patterns.filter(p => p.test(text));
            if (matches.length > 0) {
                patterns.byCategory[catKey].push({
                    text,
                    flags,
                    timestamp: msg.timestamp,
                    leadId: msg.lead?.toString()
                });
            }
        }

        // Detecta casos P1 (falso positivo de parceria)
        if (flags.wantsPartnershipOrResume && flags.wantsSchedule) {
            const hasJobContext = /\btrabalho|emprego|curr[ií]culo|vaga de\b/i.test(text);
            const hasSchedulingContext = /\bdia|hor[áa]rio|agendar|marcar|disponibilidade\b/i.test(text);
            
            if (!hasJobContext && hasSchedulingContext) {
                patterns.misclassified.push({
                    text,
                    type: 'P1_false_partnership',
                    confidence: 'high'
                });
            }
        }
    }

    return patterns;
}

/**
 * 🎯 Gera insights de aprendizado
 */
function generateInsights(patterns) {
    const insights = [];

    // Insight P1: Desambiguação de vaga
    if (patterns.misclassified?.length > 0) {
        const p1Cases = patterns.misclassified.filter(m => m.type === 'P1_false_partnership');
        if (p1Cases.length > 0) {
            insights.push({
                category: 'FLAG_DETECTION',
                issue: 'Falso positivo em wantsPartnershipOrResume',
                solution: 'Adicionar verificação de contexto de trabalho antes de ativar flag',
                affectedCases: p1Cases.length,
                examples: p1Cases.slice(0, 3).map(c => c.text),
                priority: 'high'
            });
        }
    }

    // Insight P2: Mais opções
    const moreOptionsCount = patterns.byCategory?.MORE_OPTIONS?.length || 0;
    if (moreOptionsCount > 0) {
        insights.push({
            category: 'SCHEDULING_FLOW',
            issue: 'Pedidos de alternativas de horário',
            solution: 'Implementar busca de slots alternativos quando wantsMoreOptions=true',
            affectedCases: moreOptionsCount,
            examples: patterns.byCategory.MORE_OPTIONS.slice(0, 3).map(c => c.text),
            priority: 'high'
        });
    }

    // Distribuição de flags
    const topFlags = Object.entries(patterns.flagDistribution || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

    insights.push({
        category: 'FLAG_DISTRIBUTION',
        distribution: topFlags,
        priority: 'info'
    });

    return insights;
}

/**
 * 💾 Salva insights no banco
 */
async function saveInsights(insights, dryRun = false) {
    console.log(`\n💾 Salvando ${insights.length} insights...`);

    if (dryRun) {
        console.log('  ⚠️  MODO DRY-RUN: Não salvando no banco');
        return;
    }

    for (const insight of insights) {
        if (insight.priority === 'info') continue;

        await LearningInsight.create({
            category: insight.category,
            pattern: insight.issue,
            solution: insight.solution,
            frequency: insight.affectedCases || 1,
            examples: insight.examples || [],
            createdAt: new Date()
        });
    }

    console.log('  ✅ Insights salvos');
}

/**
 * 📝 Gera cenários de teste baseados nos padrões
 */
function generateTestScenarios(patterns) {
    const scenarios = [];

    // Cenários P1
    const p1Cases = patterns.misclassified?.filter(m => m.type === 'P1_false_partnership') || [];
    for (const c of p1Cases.slice(0, 5)) {
        scenarios.push({
            id: `AUTO-P1-${scenarios.length + 1}`,
            category: 'DESAMBIGUACAO',
            leadMessage: c.text,
            idealResponse: 'Deve oferecer agendamento, não parceria',
            checks: [
                { type: 'notContains', patterns: ['parceria', 'currículo', 'trabalho'] },
                { type: 'contains', patterns: ['dia', 'horário', 'disponível'], matchAny: true }
            ],
            source: 'auto-generated-from-logs'
        });
    }

    // Cenários P2
    const p2Cases = patterns.byCategory?.MORE_OPTIONS || [];
    for (const c of p2Cases.slice(0, 5)) {
        scenarios.push({
            id: `AUTO-P2-${scenarios.length + 1}`,
            category: 'MAIS_OPCOES',
            leadMessage: c.text,
            idealResponse: 'Deve oferecer alternativas de horário',
            checks: [
                { type: 'contains', patterns: ['opção', 'alternativa', 'horário', 'dia'], matchAny: true }
            ],
            source: 'auto-generated-from-logs'
        });
    }

    return scenarios;
}

/**
 * 📄 Main
 */
async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const fromLogs = args.includes('--from-logs');
    const fromMessages = args.includes('--from-messages');
    const autoFix = args.includes('--auto-fix');

    console.log(`
╔════════════════════════════════════════════════════════════════╗
║  🧠 AMANDA LEARNING FEEDER                                     ║
╠════════════════════════════════════════════════════════════════╣
║  Modo: ${dryRun ? 'DRY-RUN (simulação)' : 'PRODUÇÃO'}                                    ║
║  Fontes: ${fromLogs ? 'LOGS ' : ''}${fromMessages ? 'MONGODB ' : 'AMBOS'}                                    ║
╚════════════════════════════════════════════════════════════════╝
`);

    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB conectado\n');

    let allPatterns = {
        misclassified: [],
        byCategory: {},
        flagDistribution: {}
    };

    // Extrai de logs
    if (fromLogs || (!fromLogs && !fromMessages)) {
        const logPath = join(PROJECT_ROOT, 'analises');
        const logPatterns = await extractPatternsFromLogs(logPath);
        allPatterns.misclassified.push(...(logPatterns.misclassified || []));
        allPatterns.byCategory = { ...allPatterns.byCategory, ...logPatterns };
    }

    // Extrai do MongoDB
    if (fromMessages || (!fromLogs && !fromMessages)) {
        const dbPatterns = await extractPatternsFromDB({ limit: 2000 });
        allPatterns.misclassified.push(...(dbPatterns.misclassified || []));
        allPatterns.byCategory = { ...allPatterns.byCategory, ...dbPatterns.byCategory };
        allPatterns.flagDistribution = dbPatterns.flagDistribution;
    }

    // Gera insights
    console.log('\n🎯 Gerando insights...');
    const insights = generateInsights(allPatterns);
    
    console.log(`\n📊 ${insights.length} insights gerados:`);
    for (const insight of insights) {
        const icon = insight.priority === 'high' ? '🔴' : insight.priority === 'medium' ? '🟡' : '🔵';
        console.log(`\n  ${icon} [${insight.category}]`);
        if (insight.issue) {
            console.log(`     Problema: ${insight.issue}`);
            console.log(`     Solução: ${insight.solution}`);
            console.log(`     Casos: ${insight.affectedCases || 'N/A'}`);
        }
        if (insight.distribution) {
            console.log('     Top flags:');
            insight.distribution.slice(0, 5).forEach(([flag, count]) => {
                console.log(`       - ${flag}: ${count}`);
            });
        }
    }

    // Gera cenários de teste
    console.log('\n📝 Gerando cenários de teste...');
    const testScenarios = generateTestScenarios(allPatterns);
    console.log(`  ${testScenarios.length} cenários gerados`);

    if (testScenarios.length > 0) {
        const outputPath = join(PROJECT_ROOT, 'tests', 'fixtures', 'autoScenarios.json');
        writeFileSync(outputPath, JSON.stringify({
            generatedAt: new Date().toISOString(),
            count: testScenarios.length,
            scenarios: testScenarios
        }, null, 2));
        console.log(`  💾 Salvos em: ${outputPath}`);
    }

    // Salva insights
    await saveInsights(insights, dryRun);

    // Auto-fix (se solicitado)
    if (autoFix && !dryRun) {
        console.log('\n🔧 Aplicando correções automáticas...');
        // Aqui poderia aplicar correções nos arquivos de código
        console.log('  ⚠️  Auto-fix não implementado nesta versão');
    }

    await mongoose.disconnect();
    console.log('\n✅ Feeder finalizado');
}

main().catch(err => {
    console.error('💥 Erro:', err);
    process.exit(1);
});
