/**
 * 🎯 Handler do Webhook - VERSÃO CORRIGIDA
 */
export async function processInboundMessage(messageData) {
    const { from, type, wamid, timestamp } = messageData;

    console.log(`\n🔔 Mensagem ${type} de ${from}`);

    try {
        let userText = '';
        let mediaInfo = null;

        // ========================================
        // 🎙️ ÁUDIO - AGORA FUNCIONA!
        // ========================================
        if (type === 'audio') {
            const mediaId = messageData.audio?.id;

            if (!mediaId) {
                console.error('❌ Audio sem mediaId');
                userText = '[Áudio inválido]';
            } else {
                console.log(`🎙️ Processando áudio: ${mediaId}`);

                // TRANSCREVE O ÁUDIO
                userText = await transcribeWaAudio(mediaId, `audio_${wamid}.ogg`);

                if (!userText || userText.length < 3) {
                    userText = '[Áudio não pôde ser transcrito]';
                }

                mediaInfo = {
                    type: 'audio',
                    mediaId,
                    transcription: userText
                };
            }
        }

        // ========================================
        // 🖼️ IMAGEM
        // ========================================
        else if (type === 'image') {
            const mediaId = messageData.image?.id;
            const caption = messageData.image?.caption || '';

            if (!mediaId) {
                console.error('❌ Imagem sem mediaId');
                userText = caption || '[Imagem inválida]';
            } else {
                console.log(`🖼️ Processando imagem: ${mediaId}`);

                const description = await describeWaImage(mediaId, caption);

                userText = caption
                    ? `${caption}\n[Imagem: ${description}]`
                    : `[Imagem: ${description}]`;

                mediaInfo = {
                    type: 'image',
                    mediaId,
                    description,
                    caption
                };
            }
        }

        // ========================================
        // 💬 TEXTO
        // ========================================
        else if (type === 'text') {
            userText = messageData.text?.body || '';
        }

        // ========================================
        // ❓ OUTROS TIPOS
        // ========================================
        else {
            console.log(`⚠️ Tipo não suportado: ${type}`);
            userText = `[${type.toUpperCase()}]`;
        }

        // ========================================
        // 💾 SALVAR NO CRM
        // ========================================
        console.log(`💾 Salvando mensagem: "${userText.substring(0, 50)}..."`);

        await saveMessageToCRM({
            wamid,
            from,
            type,
            content: userText,
            mediaInfo,
            timestamp
        });

        // ========================================
        // 🤖 GERAR RESPOSTA DA AMANDA
        // ========================================
        if (userText && !userText.startsWith('[') && userText.length > 2) {
            console.log('🤖 Gerando resposta da Amanda...');

            const reply = await generateAmandaReply({
                userText,
                lead: { /* dados do lead */ },
                context: {
                    messageType: type,
                    hasMedia: !!mediaInfo,
                    transcription: mediaInfo?.transcription
                }
            });

            if (reply) {
                await sendWhatsAppMessage(from, reply);
                console.log(`✅ Resposta enviada: "${reply.substring(0, 50)}..."`);
            }
        }

        console.log('✅ Mensagem processada com sucesso\n');

    } catch (err) {
        console.error('❌ Erro ao processar mensagem:', err);
        throw err;
    }
}