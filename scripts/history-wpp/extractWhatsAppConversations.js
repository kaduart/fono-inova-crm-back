// scripts/extractWhatsAppConversations.js - EXTRAÇÃO AUTOMÁTICA

import puppeteer from 'puppeteer';
import fs from 'fs';

// Cada card de conversa na sua conta está em <div role="row" ...>
const CHAT_ITEM_SELECTOR = 'div[role="row"]';

/**
 * 🤖 EXTRAI CONVERSAS DO WHATSAPP WEB
 */
async function extractConversations() {
    console.log('🤖 [EXTRACT] Iniciando extração...\n');

    const browser = await puppeteer.launch({
        headless: false, // Ver o navegador
        defaultViewport: null,
        args: ['--start-maximized']
    });

    const page = await browser.newPage();

    try {
        // 1. ABRIR WHATSAPP WEB
        console.log('📱 Abrindo WhatsApp Web...');
        await page.goto('https://web.whatsapp.com');

        // 2. AGUARDAR LOGIN (QR CODE)
        console.log('📷 Escaneie o QR Code no celular...\n');

        await page
            .waitForSelector('[aria-label="Lista de conversas"]', {
                timeout: 120000 // 2 minutos
            })
            .catch(() =>
                page.waitForSelector('div[role="grid"]', { timeout: 60000 })
            )
            .catch(() =>
                page.waitForSelector('#pane-side', { timeout: 60000 })
            );

        console.log('✅ Login realizado!\n');

        // 3. BUSCAR CONVERSAS COM SCROLL
        console.log('🔍 Buscando conversas...');
        await new Promise(resolve => setTimeout(resolve, 4000)); // Aguarda carregar melhor

        const allChats = [];
        const visited = new Set(); // títulos já processados

        let totalProcessed = 0;
        let scrollRounds = 0;

        const MAX_SCROLL_ROUNDS = 500;   // segurança
        const MAX_CONVERSATIONS = 2000;  // limite máximo

        while (scrollRounds < MAX_SCROLL_ROUNDS && totalProcessed < MAX_CONVERSATIONS) {
            scrollRounds++;

            // 👉 Pega os cards visíveis neste momento
            let items = await page.$$(CHAT_ITEM_SELECTOR);

            console.log(`🔍 Lote ${scrollRounds}: ${items.length} cards visíveis`);

            if (!items || items.length === 0) {
                console.log('⚠️ Nenhum card encontrado neste lote com div[role="row"].');
                break;
            }

            for (let i = 0; i < items.length; i++) {
                try {
                    // pega o título/nome da conversa
                    const title = await items[i].$eval(
                        'span[title], [data-testid="conversation-info-header"] span[dir="auto"], div[aria-label]',
                        el => el.textContent || el.getAttribute('title')
                    ).catch(() => null);

                    if (!title) continue;

                    // ignora coisas claramente técnicas
                    if (
                        title.includes('disappearing-messages-refreshed') ||
                        title.includes('forward-refreshed')
                    ) {
                        continue;
                    }

                    // já foi processada antes?
                    if (visited.has(title)) {
                        continue;
                    }

                    visited.add(title);
                    totalProcessed++;

                    console.log(`📝 Processando ${totalProcessed} - ${title}...`);

                    // clica na conversa
                    await items[i].click();
                    await new Promise(resolve => setTimeout(resolve, 2000));

                    // Extrai nome do contato pelo header (fallback para o título)
                    const contactName = await page.$eval(
                        'header h1, header span[title], header span[dir="auto"]',
                        el => el.textContent || el.getAttribute('title')
                    ).catch(() => title);

                    // Extrai mensagens da conversa
                    const messages = await page.$$eval(
                        'div[data-id], div.message-in, div.message-out',
                        (msgs) => msgs.map(msg => {
                            const time =
                                msg.querySelector('div[data-pre-plain-text], span[class*="time"]')
                                    ?.textContent || '';
                            const text =
                                msg.querySelector('span.selectable-text, div[class*="copyable-text"]')
                                    ?.textContent || '';
                            const isOut =
                                msg.className?.includes('message-out') ||
                                (msg.closest && msg.closest('.message-out'));

                            return {
                                time,
                                text,
                                direction: isOut ? 'outbound' : 'inbound'
                            };
                        })
                    ).catch(() => []);

                    console.log(`   ✅ ${messages.length} mensagens extraídas`);

                    allChats.push({
                        contact: contactName,
                        messages: messages.filter(m => m.text) // remove vazias
                    });

                    if (totalProcessed >= MAX_CONVERSATIONS) break;
                } catch (err) {
                    console.error(`   ❌ Erro ao processar conversa ${i + 1}:`, err.message);
                }
            }

            if (totalProcessed >= MAX_CONVERSATIONS) {
                console.log('⚠️ Atingiu o limite de conversas configurado (MAX_CONVERSATIONS).');
                break;
            }

            // 4. ROLA A LISTA UM POUCO PARA BAIXO (incremental)
            const pane =
                (await page.$('#pane-side')) ||
                (await page.$('[aria-label="Lista de conversas"]'));

            if (pane) {
                const reachedBottom = await pane.evaluate(el => {
                    const before = el.scrollTop;
                    el.scrollBy(0, 600); // rola 600px pra baixo
                    const after = el.scrollTop;
                    return after === before; // se não mudou, chegou no fim
                });

                if (reachedBottom) {
                    console.log('✅ Chegou ao final da lista de conversas.');
                    break;
                }
            } else {
                // fallback: rola a página inteira
                const reachedBottom = await page.evaluate(() => {
                    const before = window.scrollY;
                    window.scrollBy(0, 600);
                    const after = window.scrollY;
                    return after === before;
                });

                if (reachedBottom) {
                    console.log('✅ Chegou ao final (fallback scroll).');
                    break;
                }
            }

            await new Promise(resolve => setTimeout(resolve, 1500)); // espera carregar mais
        }

        console.log(`📊 Total de conversas processadas: ${allChats.length}\n`);

        // 5. SALVAR EM ARQUIVO
        const output = formatChatsToTxt(allChats);
        const filename = `whatsapp_export_${new Date().toISOString().split('T')[0]}.txt`;

        fs.writeFileSync(filename, output, 'utf-8');

        console.log('\n✅ EXTRAÇÃO CONCLUÍDA!');
        console.log(`📄 Arquivo salvo: ${filename}`);
        console.log(`📊 Total de conversas: ${allChats.length}`);
        console.log(
            `📝 Total de mensagens: ${allChats.reduce(
                (sum, c) => sum + c.messages.length,
                0
            )}\n`
        );

    } catch (error) {
        console.error('❌ Erro:', error);
    } finally {
        await browser.close();
    }
}

/**
 * 📝 FORMATA CONVERSAS NO FORMATO DO WHATSAPP
 */
function formatChatsToTxt(chats) {
    let output = '';

    chats.forEach(chat => {
        chat.messages.forEach(msg => {
            const sender =
                msg.direction === 'outbound'
                    ? 'Clínica Fono Inova'
                    : chat.contact;

            output += `[${msg.time}] ${sender}: ${msg.text}\n`;
        });

        // Separador entre conversas
        output += '\n\n\n';
    });

    return output;
}

/**
 * 🔄 ROLA ATÉ O TOPO (OPCIONAL - NÃO USADO NO FLUXO ATUAL)
 */
async function scrollToTop(page) {
    let previousHeight = 0;
    let currentHeight = await page.$eval(
        'div[data-tab], div[role="application"]',
        el => el.scrollHeight
    ).catch(() => 0);

    if (!currentHeight) return;

    while (currentHeight > previousHeight) {
        await page.$eval(
            'div[data-tab], div[role="application"]',
            el => el.scrollTo(0, 0)
        ).catch(() => {});

        await new Promise(resolve => setTimeout(resolve, 1000));

        previousHeight = currentHeight;
        currentHeight = await page.$eval(
            'div[data-tab], div[role="application"]',
            el => el.scrollHeight
        ).catch(() => previousHeight);
    }
}

// EXECUTAR
extractConversations().catch(console.error);
