// scripts/history-wpp/extractWhatsAppConversations.js

import fs from 'fs';
import puppeteer from 'puppeteer';
import moment from 'moment';

const CHAT_ITEM_SELECTOR = 'div[role="row"]';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPhoneForCurrentChat(page) {
    try {
        // Abre o painel de informações do contato
        const headerButton =
            (await page.$('header [data-testid="conversation-info-header"]')) ||
            (await page.$('header [data-testid="chat-header"]')) ||
            (await page.$('header'));

        if (headerButton) {
            await headerButton.click();
            await delay(800);
        }

        // Espera algum container de info aparecer (se não aparecer, segue com fallback)
        await page
            .waitForSelector(
                '[data-testid="contact-info"], [role="dialog"], [data-testid="chat-subtitle"]',
                { timeout: 5000 }
            )
            .catch(() => { });

        const phone = await page.evaluate(() => {
            const phoneRegex = /\+\d{1,3}\s?\d{2}\s?\d{4,5}-?\d{4}/; // ex: +55 62 9287-8419

            const containers = [
                document.querySelector('[data-testid="contact-info"]'),
                document.querySelector('[role="dialog"]'),
                document, // fallback
            ].filter(Boolean);

            for (const root of containers) {
                const els = Array.from(root.querySelectorAll('span, div'));
                for (const el of els) {
                    const text = (el.textContent || '').trim();
                    const match = text.match(phoneRegex);
                    if (match) return match[0];
                }
            }
            return null;
        });

        // Fecha painel
        try {
            await page.keyboard.press('Escape');
        } catch (e) { }

        return phone;
    } catch (err) {
        console.warn('⚠️ Erro ao buscar telefone do contato:', err.message);
        return null;
    }
}

/**
 * 🤖 EXTRAI CONVERSAS DO WHATSAPP WEB
 */
async function extractConversations() {
    console.log('🤖 [EXTRACT] Iniciando extração...\n');

    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ['--start-maximized'],
    });

    const page = await browser.newPage();

    try {
        console.log('📱 Abrindo WhatsApp Web...');
        await page.goto('https://web.whatsapp.com');

        console.log('📷 Escaneie o QR Code no celular...\n');

        await page
            .waitForSelector('[aria-label="Lista de conversas"]', {
                timeout: 120000,
            })
            .catch(() =>
                page.waitForSelector('div[role="grid"]', { timeout: 60000 })
            )
            .catch(() =>
                page.waitForSelector('#pane-side', { timeout: 60000 })
            );

        console.log('✅ Login realizado!\n');

        console.log('🔍 Buscando conversas...');
        await delay(4000);

        const allChats = [];
        const visited = new Set();

        let totalProcessed = 0;
        let scrollRounds = 0;

        const MAX_SCROLL_ROUNDS = 500;
        const MAX_CONVERSATIONS = 2000;

        while (scrollRounds < MAX_SCROLL_ROUNDS && totalProcessed < MAX_CONVERSATIONS) {
            scrollRounds++;

            let items = await page.$$(CHAT_ITEM_SELECTOR);
            console.log(`🔍 Lote ${scrollRounds}: ${items.length} cards visíveis`);

            if (!items || items.length === 0) {
                console.log('⚠️ Nenhum card encontrado neste lote com div[role="row"].');
                break;
            }

            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (!item) continue;

                try {
                    // pega o título/nome da conversa na lista
                    const title = await item
                        .$eval(
                            'span[title], [data-testid="conversation-info-header"] span[dir="auto"], div[aria-label]',
                            (el) => el.textContent || el.getAttribute('title')
                        )
                        .catch(() => null);

                    if (!title) continue;

                    if (
                        title.includes('disappearing-messages-refreshed') ||
                        title.includes('forward-refreshed')
                    ) {
                        continue;
                    }

                    if (visited.has(title)) {
                        continue;
                    }

                    visited.add(title);
                    totalProcessed++;

                    console.log(`📝 Processando ${totalProcessed} - ${title}...`);

                    // Clica na conversa
                    await item.click();
                    await delay(1500);

                    // 1) EXTRAI AS MENSAGENS PRIMEIRO
                    const rawMessages = await page
                        .$$eval(
                            'div[data-id], div.message-in, div.message-out',
                            (msgs) =>
                                msgs.map((msg) => {
                                    const timeEl =
                                        msg.querySelector(
                                            'div[data-pre-plain-text]'
                                        ) ||
                                        msg.querySelector(
                                            'span[class*="time"]'
                                        );

                                    const textEl =
                                        msg.querySelector(
                                            'span.selectable-text'
                                        ) ||
                                        msg.querySelector(
                                            'div[class*="copyable-text"]'
                                        );

                                    const time = timeEl?.textContent || '';
                                    const text = textEl?.textContent || '';

                                    const isOut =
                                        msg.className?.includes('message-out') ||
                                        (msg.closest &&
                                            msg.closest('.message-out'));

                                    return {
                                        time,
                                        text,
                                        direction: isOut ? 'outbound' : 'inbound',
                                    };
                                })
                        )
                        .catch(() => []);

                    const validMessages = rawMessages.filter((m) => m.text && m.text.trim() !== '');

                    console.log(`   ✅ ${validMessages.length} mensagens extraídas`);

                    if (validMessages.length === 0) {
                        console.log('   ⚠️ Nenhuma mensagem válida, pulando conversa.');
                        if (totalProcessed >= MAX_CONVERSATIONS) break;
                        continue;
                    }

                    // 2) Nome do contato no header
                    const contactName = await page
                        .$eval(
                            'header h1, header span[title], header span[dir="auto"]',
                            (el) => el.textContent || el.getAttribute('title')
                        )
                        .catch(() => title);

                    // 3) Tenta pegar o telefone pelo painel de info
                    const phoneNumber = await getPhoneForCurrentChat(page);
                    console.log(
                        `   ☎️ Telefone detectado: ${phoneNumber || 'não encontrado'}`
                    );

                    allChats.push({
                        contact: contactName,
                        phone: phoneNumber || contactName,
                        messages: validMessages,
                    });

                    if (totalProcessed >= MAX_CONVERSATIONS) break;
                } catch (err) {
                    console.error(
                        `   ❌ Erro ao processar conversa ${i + 1}:`,
                        err.message
                    );
                }
            }

            if (totalProcessed >= MAX_CONVERSATIONS) {
                console.log(
                    '⚠️ Atingiu o limite de conversas configurado (MAX_CONVERSATIONS).'
                );
                break;
            }

            // SCROLL NA LISTA
            const pane =
                (await page.$('#pane-side')) ||
                (await page.$('[aria-label="Lista de conversas"]'));

            if (pane) {
                const reachedBottom = await pane.evaluate((el) => {
                    const before = el.scrollTop;
                    el.scrollBy(0, 600);
                    const after = el.scrollTop;
                    return after === before;
                });

                if (reachedBottom) {
                    console.log('✅ Chegou ao final da lista de conversas.');
                    break;
                }
            } else {
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

            await delay(1500);
        }

        console.log(`📊 Total de conversas processadas: ${allChats.length}\n`);

        const output = formatChatsToTxt(allChats);
       const filename = `whatsapp_export_${moment().format('YYYY-MM-DD')}.txt`;
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

    chats.forEach((chat) => {
        const inboundSender = chat.phone || chat.contact;

        chat.messages.forEach((msg) => {
            const sender =
                msg.direction === 'outbound'
                    ? 'Clínica Fono Inova'
                    : inboundSender;

            output += `[${msg.time}] ${sender}: ${msg.text}\n`;
        });

        output += '\n\n\n';
    });

    return output;
}

// EXECUTAR
extractConversations().catch(console.error);
