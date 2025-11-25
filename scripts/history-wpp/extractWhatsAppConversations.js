// scripts/extractWhatsAppConversations.js - EXTRAÇÃO AUTOMÁTICA

import fs from 'fs';
import puppeteer from 'puppeteer';

// Cada card de conversa na sua conta está em <div role="row" ...>
const CHAT_ITEM_SELECTOR = 'div[role="row"]';

async function getPhoneForCurrentChat(page) {
    try {
        // 1) Tentar clicar no header para abrir dados do contato
        const headerButton =
            (await page.$('header [data-testid="conversation-info-header"]')) ||
            (await page.$('header [data-testid="chat-header"]')) ||
            (await page.$('header'));

        if (headerButton) {
            await headerButton.click();
            await page.waitForTimeout(1000);

            await page
                .waitForSelector(
                    '[data-testid="contact-info"], [data-testid="chat-subtitle"], [role="dialog"]',
                    { timeout: 5000 }
                )
                .catch(() => {});
        }

        // 2) Dentro do painel, procurar um texto com formato de telefone
        const phone = await page.evaluate(() => {
            const phoneRegex = /\+\d{1,3}\s?\d{2}\s?\d{4,5}-?\d{4}/; // ex: +55 62 9287-8419

            const containers = [
                document.querySelector('[data-testid="contact-info"]'),
                document.querySelector('[role="dialog"]'),
                document
            ].filter(Boolean);

            for (const root of containers) {
                const els = Array.from(root.querySelectorAll('span, div'));
                for (const el of els) {
                    const text = (el.textContent || '').trim();
                    const match = text.match(phoneRegex);
                    if (match) {
                        return match[0];
                    }
                }
            }
            return null;
        });

        // 3) Fecha painel com ESC
        try {
            await page.keyboard.press('Escape');
        } catch (e) {}

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

                    // 1) Nome no topo (pode ser nome salvo ou o próprio número)
                    const contactName = await page.$eval(
                        'header h1, header span[title], header span[dir="auto"]',
                        el => el.textContent || el.getAttribute('title')
                    ).catch(() => title);

                    // 2) Tenta pegar o telefone cru no painel de info
                    const phoneNumber = await getPhoneForCurrentChat(page);
                    console.log(`   ☎️ Telefone detectado: ${phoneNumber || 'não encontrado'}`);

                    // 3) Extrai mensagens
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

                    // 👉 AGORA SÓ UM PUSH, COM phone
                    allChats.push({
                        contact: contactName,
                        phone: phoneNumber || null,
                        messages: messages.filter(m => m.text)
                    });

                    if (totalProcessed >= MAX_CONVERSATIONS) break;
                } catch (err) {
                    console.error(`   ❌ Erro ao processar conversa ${i + 1}:`, err.message);
                }
            }

            if (totalProcessed >= MAX_CONVERSATIONS) {
                console.log('⚠️ Atingiu o limite de conversas configurado (MAX_CONVERSASIONS).');
                break;
            }

            // 4. ROLA A LISTA UM POUCO PARA BAIXO (incremental)
            const pane =
                (await page.$('#pane-side')) ||
                (await page.$('[aria-label="Lista de conversas"]'));

            if (pane) {
                const reachedBottom = await pane.evaluate(el => {
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

            await new Promise(resolve => setTimeout(resolve, 1500));
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
        // se achou telefone, ele vira o “nome” do lead
        const inboundSender = chat.phone || chat.contact;

        chat.messages.forEach(msg => {
            const sender =
                msg.direction === 'outbound'
                    ? 'Clínica Fono Inova'
                    : inboundSender;

            output += `[${msg.time}] ${sender}: ${msg.text}\n`;
        });

        // separador de conversa
        output += '\n\n\n';
    });

    return output;
}

// EXECUTAR
extractConversations().catch(console.error);
