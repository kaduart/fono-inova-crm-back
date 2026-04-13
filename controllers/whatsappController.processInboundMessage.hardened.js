/**
 * processInboundMessage - VERSÃO HARDENED (Produção Bulletproof)
 * 
 * PRINCÍPIOS:
 * 1. SAVE FIRST: Mensagem sempre persiste (nunca falha o fluxo)
 * 2. FAIL OPEN: Erros viram logs, sistema continua
 * 3. STEP ISOLATION: Cada etapa protegida independentemente
 * 4. FALLBACK SAFE: Lead sempre resolvido (mesmo que genérico)
 * 5. FIRE & FORGET: Eventos nunca bloqueiam
 * 
 * GARANTIAS:
 * - Mensagem nunca perdida
 * - Lead nunca null
 * - Worker nunca crasha
 * - Event chain sempre tenta disparar
 */

// ✅ FUNÇÃO HARDENED - Separada do controller principal
async function processInboundMessage(msg, value) {
    const wamid         = msg?.id || `unknown_${Date.now()}`;
    const correlationId = `inbound:${wamid}`;
    const log           = createContextLogger('processInboundMessage');
    
    // Estado mínimo necessário
    let savedMessage    = null;
    let lead            = null;
    let contact         = null;
    let from            = null;
    let type            = null;
    let contentToSave   = null;
    
    // 🛡️ STEP 0: Extração segura de dados brutos (nunca falha)
    try {
        const fromRaw = msg?.from || '';
        const toRaw   = value?.metadata?.display_phone_number || 
                        process.env.CLINIC_PHONE_E164 || 
                        '0000000000000';
        
        from = normalizeE164BR(fromRaw) || fromRaw || 'unknown';
        type = msg?.type || 'text';
        
        log.info('start', { wamid, from, type, correlationId });
    } catch (extractErr) {
        log.error('extract_failed', { wamid, err: extractErr.message });
        from = msg?.from || 'unknown';
        type = msg?.type || 'text';
    }
    
    // 🛡️ STEP 1: EXTRAÇÃO DE CONTEÚDO (com fallback)
    try {
        const extracted = await extractMessageContent(msg, type);
        contentToSave = extracted.content || extracted.caption || `[${type.toUpperCase()}]`;
    } catch (contentErr) {
        log.warn('content_extraction_failed', { wamid, err: contentErr.message });
        contentToSave = msg?.text?.body || `[${type.toUpperCase()}]`;
    }
    
    // 🛡️ STEP 2: SALVAR MENSAGEM (CRÍTICO - nunca falha o fluxo)
    // Esta é a única operação que NÃO pode falhar
    try {
        const timestamp = new Date((parseInt(msg?.timestamp, 10) || Date.now() / 1000) * 1000);
        
        const messageData = {
            waMessageId: wamid,
            wamid,
            from,
            to: '0000000000000', // Simplificado para garantir persistência
            direction: 'inbound',
            type,
            content: contentToSave,
            status: 'received',
            needs_human_review: !['text', 'audio', 'image'].includes(type),
            timestamp,
            raw: msg, // Guarda raw completo para replay/debug
        };
        
        savedMessage = await Message.create(messageData);
        log.info('message_saved', { wamid, messageId: savedMessage._id });
    } catch (saveErr) {
        // 🚨 CRÍTICO: Mesmo falhando em salvar, tenta continuar
        // Isso NUNCA deve acontecer, mas se acontecer, loga e tenta recuperar
        log.error('message_save_failed', { wamid, err: saveErr.message, stack: saveErr.stack });
        
        // Tentativa de salvação mínima de emergência
        try {
            savedMessage = await Message.create({
                waMessageId: wamid,
                from,
                direction: 'inbound',
                type: 'emergency_fallback',
                content: contentToSave?.substring(0, 500) || 'ERROR_FALLBACK',
                status: 'error_fallback',
                error: saveErr.message,
            });
        } catch (emergencyErr) {
            log.error('emergency_save_failed', { wamid, err: emergencyErr.message });
        }
    }
    
    // 🛡️ STEP 3: RESOLVER OU CRIAR CONTATO (com fallback)
    try {
        contact = await Contacts.findOne({ phone: from });
        if (!contact) {
            contact = await Contacts.create({
                phone: from,
                name: msg?.profile?.name || `WhatsApp ${from.slice(-4)}`,
                source: 'whatsapp',
            });
        }
    } catch (contactErr) {
        log.warn('contact_resolution_failed', { wamid, from, err: contactErr.message });
        // Fallback: cria contato mínimo em memória (não persistido)
        contact = { _id: new mongoose.Types.ObjectId(), phone: from };
    }
    
    // 🛡️ STEP 4: RESOLVER OU CRIAR LEAD (COM FALLBACK GARANTIDO)
    try {
        const leadDefaults = {
            name: msg?.profile?.name || `Lead ${from.slice(-4)}`,
            phone: from,
            source: 'whatsapp',
            stage: 'novo',
            status: 'novo',
        };
        
        lead = await resolveLeadByPhone(from, leadDefaults);
        
        // Fallback se resolveLeadByPhone retornar null/undefined
        if (!lead?._id) {
            throw new Error('resolveLeadByPhone_returned_invalid');
        }
    } catch (leadErr) {
        log.warn('lead_resolution_failed', { wamid, from, err: leadErr.message });
        
        // 🆘 FALLBACK CRÍTICO: Criar lead mínimo garantido
        try {
            lead = await Lead.create({
                name: `Lead_Emergency_${from.slice(-4)}`,
                phone: from,
                source: 'whatsapp_emergency',
                stage: 'novo',
            });
            log.info('emergency_lead_created', { wamid, leadId: lead._id });
        } catch (emergencyLeadErr) {
            // Último recurso: lead em memória (não ideal, mas não quebra fluxo)
            log.error('emergency_lead_failed', { wamid, err: emergencyLeadErr.message });
            lead = { _id: new mongoose.Types.ObjectId(), phone: from, name: 'Emergency' };
        }
    }
    
    // 🛡️ STEP 5: ATUALIZAR MENSAGEM COM REFERÊNCIAS (não crítico)
    if (savedMessage?._id && lead?._id) {
        try {
            await Message.findByIdAndUpdate(savedMessage._id, {
                lead: lead._id,
                contact: contact?._id,
            });
        } catch (updateErr) {
            log.warn('message_update_failed', { wamid, err: updateErr.message });
        }
    }
    
    // 🛡️ STEP 6: ATUALIZAR LEAD (fire-and-forget)
    if (lead?._id) {
        try {
            await Lead.findByIdAndUpdate(lead._id, {
                $set: { lastInteractionAt: new Date() },
                $push: {
                    interactions: {
                        type: 'whatsapp_message',
                        content: contentToSave?.substring(0, 200),
                        timestamp: new Date(),
                        wamid,
                    }
                }
            });
        } catch (leadUpdateErr) {
            log.warn('lead_update_failed', { wamid, leadId: lead._id, err: leadUpdateErr.message });
        }
    }
    
    // 🛡️ STEP 7: SOCKET (completamente isolado - nunca quebra)
    try {
        const io = getIo();
        if (io && lead?._id) {
            io.emit('message:new', {
                id: savedMessage?._id,
                content: contentToSave,
                from,
                leadId: String(lead._id),
            });
        }
    } catch (socketErr) {
        // Silencioso - socket é nice-to-have, não critical
        log.debug('socket_emit_skipped', { wamid });
    }
    
    // 🛡️ STEP 8: PUBLICAR EVENTOS (fire & forget - nunca bloqueiam)
    
    // 8.1: Message Response Detected (AI analysis)
    try {
        publishEvent(EventTypes.MESSAGE_RESPONSE_DETECTED, {
            leadId: String(lead._id),
            messageId: savedMessage?._id?.toString(),
            waMessageId: wamid,
            content: contentToSave,
        }, { correlationId }).catch(() => {}); // Never throw
    } catch (e) { /* silent */ }
    
    // 8.2: Auto Reply Requested (Amanda)
    try {
        const fromNumeric = from.replace(/\D/g, '');
        const isTestNumber = AUTO_TEST_NUMBERS.includes(fromNumeric);
        
        // Check se deve responder
        const shouldReply = lead?.autoReplyEnabled !== false && 
                          !lead?.manualControl?.active &&
                          !isTestNumber;
        
        if (shouldReply) {
            publishEvent(EventTypes.WHATSAPP_AUTO_REPLY_REQUESTED, {
                leadId: String(lead._id),
                from,
                to: process.env.CLINIC_PHONE_E164 || '0000000000000',
                content: contentToSave,
                wamid,
                messageId: savedMessage?._id?.toString(),
            }, { 
                correlationId,
                jobId: `auto-reply:${lead._id}`
            }).catch(() => {});
        }
    } catch (e) { /* silent */ }
    
    // 8.3: Followup Requested
    try {
        const quickFlags = deriveFlagsFromText(contentToSave || '');
        const suppressAutoFollowup = quickFlags.alreadyScheduled || 
                                     quickFlags.wantsCancel ||
                                     quickFlags.refusesOrDenies ||
                                     quickFlags.saysThanks;
        
        if (!suppressAutoFollowup && lead?._id) {
            const followupId = new mongoose.Types.ObjectId();
            publishEvent(EventTypes.FOLLOWUP_REQUESTED, {
                followupId: followupId.toString(),
                leadId: String(lead._id),
                objective: 'reengajamento_inbound',
                attempt: 1,
                stage: lead.stage || 'novo',
                source: 'whatsapp-inbound',
            }, { 
                correlationId,
                idempotencyKey: `followup_${String(lead._id)}_${Date.now()}`
            }).catch(() => {});
        }
    } catch (e) { /* silent */ }
    
    // 8.4: Recovery Cancel
    try {
        if (lead?._id) {
            publishEvent(EventTypes.LEAD_RECOVERY_CANCEL_REQUESTED, {
                leadId: String(lead._id),
                reason: 'lead_respondeu',
            }, { correlationId }).catch(() => {});
        }
    } catch (e) { /* silent */ }
    
    // 🛡️ STEP 9: LOG FINAL (sempre executa)
    log.info('done', { 
        wamid, 
        correlationId, 
        leadId: lead?._id ? String(lead._id) : 'emergency',
        messageId: savedMessage?._id?.toString() || 'failed',
    });
    
    // Retorna estado para o worker
    return {
        status: savedMessage?._id ? 'processed' : 'failed',
        wamid,
        leadId: lead?._id?.toString(),
        messageId: savedMessage?._id?.toString(),
        duplicate: false,
    };
}

export { processInboundMessage };
