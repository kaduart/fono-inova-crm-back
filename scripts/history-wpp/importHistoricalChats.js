// scripts/importHistoricalChats.js - IMPORTADOR DE HISTÓRICO

import 'dotenv/config';
import fs from 'fs';
import mongoose from 'mongoose';
import Contact from '../../models/Contact.js';
import Lead from '../../models/Leads.js';
import Message from '../../models/Message.js';

/**
 * 🔄 IMPORTA CONVERSAS DO ARQUIVO TXT
 */
async function importHistoricalChats(filePath) {
    console.log('🔄 [IMPORT] Iniciando importação do histórico...\n');

    try {
        // 1. LÊ ARQUIVO
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        console.log(`📄 Arquivo carregado: ${lines.length} linhas\n`);
        console.log('linesssssssssssssssssss', lines)
        // 2. PARSEIA MENSAGENS
        const conversations = parseConversations(lines);

        console.log(`💬 ${conversations.length} conversas detectadas\n`);

        // 3. IMPORTA PARA O BANCO
        let imported = 0;
        let skipped = 0;
        let errors = 0;

        for (const conv of conversations) {
            try {
                await importConversation(conv);
                imported++;

                if (imported % 10 === 0) {
                    console.log(`✅ Progresso: ${imported}/${conversations.length}`);
                }
            } catch (error) {
                console.error(`❌ Erro ao importar ${conv.phone}:`, error.message);
                errors++;
            }
        }

        console.log('\n🎉 IMPORTAÇÃO CONCLUÍDA!\n');
        console.log(`✅ Importadas: ${imported}`);
        console.log(`⏭️  Ignoradas: ${skipped}`);
        console.log(`❌ Erros: ${errors}\n`);

        return { imported, skipped, errors };

    } catch (error) {
        console.error('❌ [IMPORT] Erro crítico:', error);
        throw error;
    }
}

/**
 * 📝 PARSEIA ARQUIVO EM CONVERSAS
 * Formato atual do TXT gerado pelo Puppeteer:
 * [qualquer-coisa] REMETENTE: mensagem
 *
 * Ex:
 * [Olá13:03] wa-wordmark-refreshed: Olá13:03
 * [Olá! ... 13:03] Clínica Fono Inova: Olá! Muito obrigada...
 */
function parseConversations(lines) {
    const conversations = [];
    let currentConv = null;
    let lastMsg = null;

    const msgRegex = /^\[(.+?)\]\s*([^:]+):\s*(.*)$/;

    // helper pra saber se um texto parece número de telefone
    const looksLikePhone = (sender) => {
        const digits = (sender || "").replace(/\D/g, "");
        return digits.length >= 10; // DDD + número
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();

        // 🔹 linha em branco → fim da conversa
        if (!line) {
            if (currentConv && currentConv.messages.length > 0 && currentConv.phone) {
                conversations.push(currentConv);
            }
            currentConv = null;
            lastMsg = null;
            continue;
        }

        const match = line.match(msgRegex);

        if (match) {
            const [, meta, senderRaw, contentRaw] = match;
            const sender = senderRaw.trim();
            const content = contentRaw.trim();

            const isClinic = sender.includes("Clínica Fono Inova");
            const direction = isClinic ? "outbound" : "inbound";

            // cria conversa se ainda não existe
            if (!currentConv) {
                currentConv = {
                    phone: null,   // vamos descobrir
                    messages: []
                };
            }

            // se é mensagem inbound e ainda não temos phone, tenta extrair
            if (!isClinic && !currentConv.phone && looksLikePhone(sender)) {
                currentConv.phone = sender; // ex: "+55 62 9373-6302" ou "62 9373-6302"
            }

            const timestamp = new Date(); // por enquanto qualquer data

            lastMsg = {
                phone: currentConv.phone,
                direction,
                content,
                timestamp
            };

            currentConv.messages.push(lastMsg);
        } else if (lastMsg) {
            // continuação de mensagem anterior
            lastMsg.content += "\n" + line;
        }
    }

    // garante última conversa
    if (currentConv && currentConv.messages.length > 0 && currentConv.phone) {
        conversations.push(currentConv);
    }

    return conversations;
}




/**
 * 💾 IMPORTA UMA CONVERSA COMPLETA
 * ⚠️ AQUI É ONDE A GENTE BURLA A VALIDAÇÃO DO MONGOOSE
 */
async function importConversation(conv) {
    let { phone, messages } = conv;

    if (!messages || messages.length === 0 || !phone) {
        return;
    }

    // 🔥 Normaliza UMA vez só aqui
    const phoneKey = normalizePhone(phone);

    // 1. CRIA/ATUALIZA CONTACT
    let contact = await Contact.findOne({ phone: phoneKey });
    if (!contact) {
        contact = new Contact({
            phone: phoneKey,
            name: 'Lead Histórico',
            tags: ['importado']
        });

        await contact.save({ validateBeforeSave: false });
    }

    // 2. CRIA/ATUALIZA LEAD
    let lead = await Lead.findOne({ 'contact.phone': phoneKey });

    if (!lead) {
        const status = inferStatus(messages);
        const conversionScore = calculateScore(messages, status);

        lead = new Lead({
            name: contact.name || 'Lead Histórico',
            contact: {
                phone: phoneKey,
                email: null
            },
            origin: 'WhatsApp',
            status,
            conversionScore,
            interactions: messages.map(m => ({
                date: m.timestamp,
                channel: 'WhatsApp',
                direction: m.direction,
                message: m.content.substring(0, 200),
                status: 'completed'
            })),
            tags: ['historico_importado'],
            lastInteractionAt: messages[messages.length - 1].timestamp,
            createdAt: messages[0].timestamp
        });

        await lead.save({ validateBeforeSave: false });
    }

    // 3. MESSAGES
    for (const msg of messages) {
        const existing = await Message.findOne({
            lead: lead._id,
            timestamp: msg.timestamp,
            content: msg.content
        });

        if (!existing) {
            const doc = new Message({
                lead: lead._id,
                contact: contact._id,
                from: msg.direction === 'inbound'
                    ? phoneKey
                    : process.env.WHATSAPP_BUSINESS_PHONE,
                to: msg.direction === 'inbound'
                    ? process.env.WHATSAPP_BUSINESS_PHONE
                    : phoneKey,
                direction: msg.direction,
                type: 'text',
                content: msg.content,
                timestamp: msg.timestamp,
                status: 'delivered',
                needs_human_review: false
            });

            await doc.save({ validateBeforeSave: false });
        }
    }
}



/**
 * 🎯 INFERE STATUS DO LEAD
 */
function inferStatus(messages) {
    const allText = messages.map(m => m.content.toLowerCase()).join(' ');

    // Detecta conversão
    if (/agend|marc(ou|ar)|hor[aá]rio|confirm/.test(allText)) {
        return 'virou_paciente'; // Agendou = converteu
    }

    // Detecta engajamento
    if (messages.length >= 5) {
        return 'engajado';
    }

    // Detecta interesse em preço
    if (/pre[cç]o|valor|quanto|r\$/.test(allText)) {
        return 'pesquisando_preco';
    }

    // Primeiro contato
    if (messages.length <= 2) {
        return 'primeiro_contato';
    }

    return 'novo';
}

/**
 * 📊 CALCULA SCORE
 */
function calculateScore(messages, status) {
    let score = 20; // Base

    // Por quantidade de mensagens
    score += Math.min(messages.length * 5, 30);

    // Por status
    const statusScores = {
        'novo': 20,
        'primeiro_contato': 30,
        'pesquisando_preco': 50,
        'engajado': 70,
        'virou_paciente': 100
    };
    score += statusScores[status] || 0;

    return Math.min(score, 100);
}

/**
 * 📞 NORMALIZA TELEFONE (E164)
 */
function normalizePhone(phone) {
    // Remove tudo exceto dígitos
    let cleaned = phone.replace(/\D/g, '');

    // Se não começa com 55, adiciona
    if (!cleaned.startsWith('55')) {
        cleaned = '55' + cleaned;
    }

    // Adiciona +
    return '+' + cleaned;
}


/**
 * 🚀 EXECUÇÃO PRINCIPAL
 */
async function main() {
    if (!process.env.MONGO_URI) {
        console.error('❌ MONGO_URI não definida no .env');
        process.exit(1);
    }

    // Conecta ao MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ MongoDB conectado\n');

    // Caminho do arquivo
    const filePath = process.argv[2] || './historico_de_leads.txt';

    if (!fs.existsSync(filePath)) {
        console.error(`❌ Arquivo não encontrado: ${filePath}`);
        process.exit(1);
    }

    // Importa
    const result = await importHistoricalChats(filePath);

    // Roda análise de aprendizado (mantido do seu script original)
    console.log('\n🧠 Rodando análise de aprendizado...\n');
    try {
        const { analyzeHistoricalConversations } = await import('../../services/amandaLearningService.js');
        const insights = await analyzeHistoricalConversations();

        if (insights) {
            console.log('✅ Insights gerados:', insights._id);
            console.log(`📊 ${insights.leadsAnalyzed} leads analisados\n`);
        }
    } catch (err) {
        console.warn('⚠️ Não foi possível rodar análise de aprendizado:', err.message);
    }

    try {
        await mongoose.disconnect();
        console.log('✅ Importação finalizada! (Mongo desconectado)\n');
    } catch (err) {
        console.warn('⚠️ Erro ao desconectar do MongoDB (pode ignorar neste script):', err.message);
        console.log('✅ Importação finalizada mesmo assim!\n');
        process.exit(0);
    }

}

// Executa se chamado diretamente
if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(error => {
        console.error('❌ Erro fatal:', error);
        process.exit(1);
    });
}

export default importHistoricalChats;
