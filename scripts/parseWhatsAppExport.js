#!/usr/bin/env node
/**
 * 📊 PARSER DE CONVERSAS REAIS DO WHATSAPP
 * 
 * Parseia exports do WhatsApp (.txt), extrai pares pergunta→resposta ideal,
 * e gera cenários de teste categorizados.
 * 
 * USO:
 *   node scripts/parseWhatsAppExport.js                    # parseia todos
 *   node scripts/parseWhatsAppExport.js --stats            # só estatísticas
 *   node scripts/parseWhatsAppExport.js --category PRECO   # filtra categoria
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.resolve(ROOT, '..', 'tests', 'fixtures');

// ============================================
// CONFIG
// ============================================
const FILES = [
    path.join(ROOT, 'whatsapp_export_2026-02-10.txt'),
    path.join(ROOT, 'whatsapp_export_2025-11-26.txt'),
];

const STATS_ONLY = process.argv.includes('--stats');
const FILTER_CAT = process.argv.includes('--category')
    ? process.argv[process.argv.indexOf('--category') + 1]
    : null;

const c = {
    reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m',
    yellow: '\x1b[33m', blue: '\x1b[34m', magenta: '\x1b[35m',
    cyan: '\x1b[36m', dim: '\x1b[2m', bold: '\x1b[1m'
};
const log = (color, ...args) => console.log(color, ...args, c.reset);

// ============================================
// CONTATOS INTERNOS (ignorar)
// ============================================
const INTERNAL_PATTERNS = [
    /vivian/i, /vivi$/i, /ricardo/i, /maia/i,
    /tallys/i, /eduardo/i, /maicon/i, /gerente/i,
    /contabilidade/i, /filipe/i,
];

const INTERNAL_CONTENT_PATTERNS = [
    /pagamentos? de hoje/i,
    /pix R?\$?\s*\d/i,
    /relatório/i,
    /crm/i,
    /nota\s*fiscal/i,
    /receita\s*saúde/i,
    /processo\s*administrativo/i,
    /cancelamento/i,
    /prefeitura/i,
    /contabilidade/i,
    /atendimentos? de hoje/i,
    /sistema$/i,
    /duplicando a mensagem/i,
    /dando erro/i,
    /confirmei na agenda/i,
    /está ocupado/i,
];

// ============================================
// CATEGORIAS
// ============================================
function categorize(leadMsg, clinicaResp) {
    const txt = (leadMsg + ' ' + clinicaResp).toLowerCase();

    // PRECO
    if (/quanto\s*(custa|é|fica|cobra)|valor|preço|R\$/i.test(leadMsg)) return 'PRECO';
    if (/R\$\s*\d|200|640|160|180|2\.?000/i.test(clinicaResp) && /valor|preço|quanto/i.test(leadMsg)) return 'PRECO';

    // CONVENIO
    if (/convênio|plano|unimed|hapvida|particular|reembolso/i.test(txt)) return 'CONVENIO';

    // AGENDAMENTO
    if (/agendar|marcar|horário|vaga|disponível|agenda/i.test(leadMsg)) return 'AGENDAMENTO';
    if (/avaliação.*agendada|agendamento.*realizado/i.test(clinicaResp)) return 'AGENDAMENTO';

    // CONFIRMACAO
    if (/confirmar|presença|lembrar|amanhã|hoje.*atendimento/i.test(clinicaResp)) return 'CONFIRMACAO';
    if (/^(sim|pode|confirmo|ok)$/i.test(leadMsg.trim())) return 'CONFIRMACAO';

    // TERAPIA
    if (/fono|psico|TO|terapia\s*ocupacional|neuropsic|bobath|psicomotri/i.test(txt)) return 'TERAPIA';

    // TEA/TDAH
    if (/tea|tdah|autismo|atenção|agitado|impulso|laudo/i.test(txt)) return 'TEA_TDAH';

    // PRIMEIRO CONTATO
    if (/^(oi|olá|bom dia|boa tarde|boa noite|hey|eae|oie)[\s!?.]*$/i.test(leadMsg.trim())) return 'PRIMEIRO_CONTATO';
    if (/amanda.*fono\s*inova|interesse.*atendimento/i.test(clinicaResp)) return 'PRIMEIRO_CONTATO';

    // FICHA_CADASTRO
    if (/ficha.*cadastro|nome da criança|data de nascimento|queixa do paciente/i.test(clinicaResp)) return 'FICHA_CADASTRO';

    // COLETA (queixa, idade, período)
    if (/idade|anos|manhã|tarde|período|especialidade/i.test(clinicaResp)) return 'COLETA';

    // OBJECAO
    if (/caro|não consigo|pra ver se.*pago|mínimo que.*consegue/i.test(leadMsg)) return 'OBJECAO';

    // LOCALIZACAO
    if (/onde fica|endereço|localização|como chego/i.test(leadMsg)) return 'LOCALIZACAO';

    return 'OUTROS';
}

// ============================================
// PARSER
// ============================================
function parseLine(line) {
    // Formato: [conteúdo HH:MM] remetente: conteúdo
    // Ou: [conteúdo HH:MM] +55 62 XXXX-XXXX: conteúdo

    // Tenta extrair remetente
    const clinicaMatch = line.match(/\] Clínica Fono Inova: (.+)$/s);
    if (clinicaMatch) {
        return { sender: 'clinica', content: clinicaMatch[1].trim() };
    }

    const phoneMatch = line.match(/\] \+55 \d{2} \d{4}-\d{4}: (.+)$/s);
    if (phoneMatch) {
        return { sender: 'lead', content: phoneMatch[1].trim() };
    }

    // Formato alternativo sem +55
    const altPhoneMatch = line.match(/\] (\d{10,13}): (.+)$/s);
    if (altPhoneMatch) {
        return { sender: 'lead', content: altPhoneMatch[2].trim() };
    }

    return null;
}

function isInternalMessage(content) {
    return INTERNAL_CONTENT_PATTERNS.some(p => p.test(content));
}

function cleanContent(content) {
    // Remove timestamps colados no final (ex: "texto13:48")
    let cleaned = content.replace(/\d{1,2}:\d{2}$/, '').trim();
    // Remove "You" prefix (formato do export)
    cleaned = cleaned.replace(/^You\s*/i, '');
    // Remove prefixos de quote do WhatsApp
    cleaned = cleaned.replace(/^[^:]+:[^:]+:\s*/g, '');
    // Remove "media-cancel", "msg-dblcheck", etc.
    cleaned = cleaned.replace(/media-cancel|msg-dblcheck|image-refreshed|Photo/gi, '').trim();
    // Remove "Edited" suffix
    cleaned = cleaned.replace(/\s*Edited$/i, '').trim();
    return cleaned;
}

function parseFile(filepath) {
    log(c.cyan, `\n📂 Parseando: ${path.basename(filepath)}`);

    const rawContent = fs.readFileSync(filepath, 'utf-8');
    const lines = rawContent.split('\n');

    log(c.dim, `   ${lines.length} linhas`);

    const conversations = []; // Array de pares {leadMsg, clinicaResp, category}
    let currentLeadMsg = null;
    let lastSender = null;
    let skipConversation = false;

    // Agrupa linhas em blocos (uma msg pode ter múltiplas linhas)
    const messages = [];
    let currentBlock = '';

    for (const line of lines) {
        if (line.startsWith('[')) {
            // Nova mensagem
            if (currentBlock) {
                const parsed = parseLine(currentBlock);
                if (parsed) messages.push(parsed);
            }
            currentBlock = line;
        } else if (line.trim() === '') {
            // Separador de conversa
            if (currentBlock) {
                const parsed = parseLine(currentBlock);
                if (parsed) messages.push(parsed);
                currentBlock = '';
            }
            // Marca fim de conversa
            if (currentLeadMsg && lastSender === 'clinica') {
                // Não tinha resposta da clínica, ignora
            }
            currentLeadMsg = null;
            lastSender = null;
            skipConversation = false;
        } else {
            // Continuação de mensagem multiline
            currentBlock += '\n' + line;
        }
    }

    // Processa último bloco
    if (currentBlock) {
        const parsed = parseLine(currentBlock);
        if (parsed) messages.push(parsed);
    }

    log(c.dim, `   ${messages.length} mensagens parseadas`);

    // Deduplica (o export duplica cada mensagem)
    const deduped = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        // Pula se é idêntica à anterior
        if (i > 0 && messages[i - 1].content === msg.content && messages[i - 1].sender === msg.sender) {
            continue;
        }
        deduped.push(msg);
    }

    log(c.dim, `   ${deduped.length} mensagens após dedup`);

    // Extrai pares lead→clinica
    for (let i = 0; i < deduped.length; i++) {
        const msg = deduped[i];
        const content = cleanContent(msg.content);

        // Ignora mensagens internas
        if (isInternalMessage(content)) continue;
        // Ignora mensagens muito curtas ou vazias
        if (content.length < 2) continue;
        // Ignora mensagens automáticas repetitivas
        if (/Olá! No momento ainda não estamos/i.test(content)) continue;
        if (/Olá!\s*Muito obrigada pelo seu contato/i.test(content)) continue;

        if (msg.sender === 'lead') {
            currentLeadMsg = content;
            lastSender = 'lead';
        } else if (msg.sender === 'clinica' && currentLeadMsg) {
            // Par encontrado!
            const category = categorize(currentLeadMsg, content);
            conversations.push({
                leadMsg: currentLeadMsg,
                clinicaResp: content,
                category,
            });
            currentLeadMsg = null; // Reset
            lastSender = 'clinica';
        }
    }

    log(c.green, `   ✅ ${conversations.length} pares extraídos`);
    return conversations;
}

// ============================================
// GERAÇÃO DE CENÁRIOS DE TESTE
// ============================================
function generateTestScenarios(allConversations) {
    // Agrupa por categoria
    const byCategory = {};
    for (const conv of allConversations) {
        if (!byCategory[conv.category]) byCategory[conv.category] = [];
        byCategory[conv.category].push(conv);
    }

    // Para cada categoria, pega os melhores exemplos (max 10)
    const scenarios = [];
    let id = 1;

    for (const [category, convs] of Object.entries(byCategory)) {
        // Filtra respostas muito curtas da clínica (provavelmente não são exemplos bons)
        const good = convs.filter(c =>
            c.clinicaResp.length > 15 &&
            c.leadMsg.length > 2 &&
            !/^(sim|não|ok|obrigad)/i.test(c.clinicaResp)
        );

        // Deduplica por conteúdo similar (evita 50x "Quanto custa?")
        const unique = [];
        const seen = new Set();
        for (const c of good) {
            const key = c.leadMsg.toLowerCase().replace(/[^\w]/g, '').slice(0, 30);
            if (!seen.has(key)) {
                seen.add(key);
                unique.push(c);
            }
        }

        // Pega até 10 melhores
        const selected = unique.slice(0, 10);

        for (const conv of selected) {
            scenarios.push({
                id: id++,
                category,
                leadMessage: conv.leadMsg,
                idealResponse: conv.clinicaResp,
                // Gera checks automáticos baseados na resposta humana
                checks: generateChecks(conv),
            });
        }
    }

    return { scenarios, stats: byCategory };
}

function generateChecks(conv) {
    const checks = [];
    const resp = conv.clinicaResp;

    // Check: resposta não deve ser vazia
    checks.push({
        name: 'Resposta não vazia',
        type: 'notEmpty',
    });

    // Check: se mencionou preço, Amanda deve mencionar preço
    if (/R\$\s*\d|200|640|160|180/i.test(resp)) {
        checks.push({
            name: 'Deve mencionar preço (R$)',
            type: 'contains',
            patterns: ['R$', '200', '640', '160', '180'],
            matchAny: true,
        });
    }

    // Check: se mencionou terapia específica
    if (/fonoaudiolog/i.test(resp)) {
        checks.push({ name: 'Deve mencionar fono', type: 'contains', patterns: ['fono'], matchAny: true });
    }
    if (/psicolog/i.test(resp)) {
        checks.push({ name: 'Deve mencionar psicologia', type: 'contains', patterns: ['psico'], matchAny: true });
    }
    if (/terapia ocupacional/i.test(resp)) {
        checks.push({ name: 'Deve mencionar TO', type: 'contains', patterns: ['terapia ocupacional', 'TO'], matchAny: true });
    }

    // Check: se mencionou particular
    if (/particular/i.test(resp)) {
        checks.push({ name: 'Deve mencionar particular', type: 'contains', patterns: ['particular'], matchAny: true });
    }

    // Check: se é acolhimento
    if (/tudo bem|bom dia|boa tarde/i.test(resp.slice(0, 30))) {
        checks.push({ name: 'Deve acolher', type: 'regex', pattern: '(tudo bem|bom dia|boa tarde|oi|olá)', flags: 'i' });
    }

    // Check: se mencionou horário
    if (/\d{1,2}:\d{2}/i.test(resp)) {
        checks.push({ name: 'Deve mencionar horário', type: 'regex', pattern: '\\d{1,2}:\\d{2}', flags: '' });
    }

    // Check: se ofereceu agendamento
    if (/agendar|marcar|disponível/i.test(resp)) {
        checks.push({ name: 'Deve oferecer agendamento', type: 'contains', patterns: ['agendar', 'marcar', 'disponível', 'horário'], matchAny: true });
    }

    // Check: se é anti-loop (coisas que NÃO devem aparecer)
    if (conv.category === 'PRECO') {
        checks.push({
            name: 'NÃO deve pedir idade antes de dar preço',
            type: 'notContains',
            patterns: ['qual a idade', 'quantos anos'],
        });
    }

    return checks;
}

// ============================================
// MAIN
// ============================================
function main() {
    log(c.cyan, '\n╔══════════════════════════════════════════════╗');
    log(c.cyan, '║  📊 PARSER DE CONVERSAS REAIS DO WHATSAPP    ║');
    log(c.cyan, '╚══════════════════════════════════════════════╝');

    const allConversations = [];

    for (const filepath of FILES) {
        if (!fs.existsSync(filepath)) {
            log(c.yellow, `⚠️ Arquivo não encontrado: ${path.basename(filepath)}`);
            continue;
        }
        const convs = parseFile(filepath);
        allConversations.push(...convs);
    }

    log(c.bold, `\n📊 Total: ${allConversations.length} pares extraídos`);

    // Gera cenários
    const { scenarios, stats } = generateTestScenarios(allConversations);

    // Estatísticas
    log(c.cyan, '\n═══════════════════════════════════════════════');
    log(c.bold, '  📈 ESTATÍSTICAS POR CATEGORIA');
    log(c.cyan, '═══════════════════════════════════════════════');

    const categories = Object.entries(stats).sort((a, b) => b[1].length - a[1].length);
    for (const [cat, convs] of categories) {
        const icon = {
            PRECO: '💰', CONVENIO: '🏥', AGENDAMENTO: '📅',
            CONFIRMACAO: '✅', TERAPIA: '🎯', TEA_TDAH: '🧩',
            PRIMEIRO_CONTATO: '👋', FICHA_CADASTRO: '📝',
            COLETA: '📋', OBJECAO: '⚠️', LOCALIZACAO: '📍',
            OUTROS: '📦',
        }[cat] || '📦';
        const scenariosInCat = scenarios.filter(s => s.category === cat).length;
        log(c.green, `  ${icon} ${cat}: ${convs.length} pares → ${scenariosInCat} cenários de teste`);
    }

    log(c.bold, `\n  🧪 Total cenários de teste: ${scenarios.length}`);

    if (STATS_ONLY) {
        log(c.dim, '\n  (--stats: mostrando apenas estatísticas)');

        // Mostra 3 exemplos por categoria
        for (const [cat, convs] of categories) {
            if (FILTER_CAT && cat !== FILTER_CAT.toUpperCase()) continue;
            log(c.magenta, `\n  ── ${cat} (amostra) ──`);
            const sample = convs.slice(0, 3);
            for (const s of sample) {
                log(c.dim, `    👤 "${s.leadMsg.slice(0, 60)}"`);
                log(c.dim, `    🏥 "${s.clinicaResp.slice(0, 80)}"`);
                log(c.dim, '');
            }
        }
    } else {
        // Salva JSON
        const output = {
            generatedAt: new Date().toISOString(),
            sourceFiles: FILES.map(f => path.basename(f)),
            totalPairsExtracted: allConversations.length,
            totalTestScenarios: scenarios.length,
            categories: Object.fromEntries(categories.map(([k, v]) => [k, v.length])),
            scenarios: FILTER_CAT
                ? scenarios.filter(s => s.category === FILTER_CAT.toUpperCase())
                : scenarios,
        };

        // Garante que o diretório existe
        if (!fs.existsSync(FIXTURES_DIR)) {
            fs.mkdirSync(FIXTURES_DIR, { recursive: true });
        }

        const outputPath = path.join(FIXTURES_DIR, 'conversasReaisExtraidas.json');
        fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');

        log(c.green, `\n  ✅ Salvo em: ${outputPath}`);
        log(c.green, `     ${scenarios.length} cenários de teste prontos!`);
    }

    // Mostra exemplos do gabarito
    log(c.cyan, '\n═══════════════════════════════════════════════');
    log(c.bold, '  📝 EXEMPLOS DO GABARITO (resposta humana ideal)');
    log(c.cyan, '═══════════════════════════════════════════════');

    const sampleCategories = ['PRECO', 'PRIMEIRO_CONTATO', 'TERAPIA', 'CONVENIO', 'AGENDAMENTO'];
    for (const cat of sampleCategories) {
        const sample = scenarios.find(s => s.category === cat);
        if (!sample) continue;
        log(c.magenta, `\n  ── ${cat} ──`);
        log(c.dim, `  👤 Lead: "${sample.leadMessage.slice(0, 80)}"`);
        log(c.dim, `  🏥 Ideal: "${sample.idealResponse.slice(0, 120)}"`);
        log(c.dim, `  🧪 Checks: ${sample.checks.map(c => c.name).join(', ')}`);
    }

    log(c.green, '\n  🎉 Parser concluído!\n');
}

main();
