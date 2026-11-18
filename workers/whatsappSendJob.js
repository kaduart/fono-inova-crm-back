// workers/whatsappSendJob.js
//
// Processamento de um job da fila "whatsapp-send" (envios do ERP pelo número da clínica).
// 18/11/2026: tirado de workers/entrypoints/whatsapp-child.js para rodar igual nos dois modos:
//   - local: deps.sendMessage usa o whatsappWebJsService (Chrome no próprio crm-worker);
//   - externo: deps.sendMessage chama o conector (Chrome em outro host), com requestId estável e deliveryGuard.
// Regras (pular quem a clínica acabou de falar, quem já agendou etc.) não mudaram.

/**
 * @param {import('bullmq').Job} job
 * @param {{ sendMessage: (job, phone, message, opts) => Promise<{messageId?:string|null, uncertain?:boolean}>,
 *           getChatActivity: (phone) => Promise<{clinicAt:Date|null, contactAt:Date|null}>, tag?: string }} deps
 */
export async function processWhatsappSendJob(job, deps) {
        const tag = deps.tag || 'CHILD WORKER';
        const { phone, message, appointmentId, purpose } = job.data;
        // Envio em massa da lista de convênio: confere a conversa AGORA. Se a clínica falou com a pessoa
        // nos últimos `recentDays` dias (inclusive na mão, depois da prévia), não manda nada.
        const reengageIds = job.data.reengageEvaluationIds || [];
        if (job.data.recentDays && (job.data.waitlistIds?.length || reengageIds.length)) {
            let activity = null;
            try {
                activity = await deps.getChatActivity(phone);
            } catch (err) {
                console.warn(`[${tag}] ⚠️ Job ${job.id} — não consegui conferir a conversa (segue o envio):`, err.message);
            }
            const { isRecentClinicChat, markOfferSkipped } = await import('../services/convenioWaitlistOffer.js');
            if (activity && isRecentClinicChat(activity, job.data.recentDays)) {
                const skip = {
                    purpose,
                    reason: `Conversa com a clínica em ${activity.clinicAt.toISOString().slice(0, 10)} — não enviado`,
                    lastClinicAt: activity.clinicAt,
                };
                if (reengageIds.length) {
                    const { markReengageSkipped } = await import('../services/commercial/evaluationReengagement.js');
                    await markReengageSkipped(reengageIds, skip);
                } else {
                    await markOfferSkipped(job.data.waitlistIds, skip);
                }
                console.log(`[${tag}] ⏭️ Job ${job.id} — pulado: clínica conversou com ...${String(phone).slice(-4)} há menos de ${job.data.recentDays} dias`);
                return { skipped: true };
            }
            // Lista de convênio (particular): agendou entre a prévia e o envio (o lote é espalhado
            // por dias úteis)? Não manda mensagem comercial para quem já tem sessão marcada (12/11/2026).
            // O "Retomar contato" tem trava própria logo abaixo; "Agora atendemos" segue a regra do tipo.
            if (purpose === 'convenio_offer') {
                let nextAt = null;
                try {
                    const { patientMatchesByPhone } = await import('../services/convenioWaitlistWhatsapp.js');
                    nextAt = (await patientMatchesByPhone([phone])).get(phone)?.nextAppointmentAt || null;
                } catch (err) {
                    console.warn(`[${tag}] ⚠️ Job ${job.id} — não consegui conferir a agenda (segue o envio):`, err.message);
                }
                if (nextAt) {
                    await markOfferSkipped(job.data.waitlistIds, { purpose, reason: `Já tem sessão marcada em ${new Date(nextAt).toISOString().slice(0, 10)} — não enviado` });
                    console.log(`[${tag}] ⏭️ Job ${job.id} — pulado: ...${String(phone).slice(-4)} já tem sessão marcada`);
                    return { skipped: true };
                }
            }
        }
        // Retomar contato: se o paciente agendou ou voltou depois do clique, não manda.
        if (purpose === 'evaluation_reengage' && reengageIds.length) {
            const { hasContinuedSince, markReengageSkipped } = await import('../services/commercial/evaluationReengagement.js');
            if (await hasContinuedSince(reengageIds)) {
                await markReengageSkipped(reengageIds, { reason: 'Agendou ou voltou depois do envio ser agendado — não enviado' });
                console.log(`[${tag}] ⏭️ Job ${job.id} — pulado: paciente ...${String(phone).slice(-4)} já agendou`);
                return { skipped: true };
            }
        }
        console.log(`[${tag}] 📤 Job ${job.id} — enviando para ${phone}`);
        console.log(`[${tag}] 📤 Conteúdo: ${message.substring(0, 80)}...`);
        const result = await deps.sendMessage(job, phone, message, {
            attendanceConfirmation: purpose === 'attendance_confirmation',
            appointmentId,
        });
        // Modo externo: o conector não sabe dizer se saiu. Não marca como enviado nem como falha —
        // fica "unknown" em outbound_deliveries para conferência humana, e nada é reenviado sozinho.
        if (result?.uncertain) {
            console.warn(`[${tag}] ❓ Job ${job.id} — envio INCERTO (${result.reason || 'sem confirmação'}); não marcado como enviado`);
            return result;
        }
        // Guarda de entregas: incerto ou outra execução enviando → não envia de novo e não marca nada.
        if (result?.skipped) {
            console.warn(`[${tag}] ⏭️ Job ${job.id} — não enviado agora (${result.delivery}); sem reenvio automático`);
            return result;
        }
        if (result?.alreadySent) console.warn(`[${tag}] ⏭️ Job ${job.id} — já enviado antes; só refazendo as marcações`);
        if ((purpose === 'convenio_offer' || purpose === 'convenio_announce') && job.data.waitlistIds?.length) {
            const { markOfferSent } = await import('../services/convenioWaitlistOffer.js');
            await markOfferSent(job.data.waitlistIds, { purpose, messageId: result?.messageId || null });
        }
        if (purpose === 'evaluation_reengage' && reengageIds.length) {
            const { markReengageSent } = await import('../services/commercial/evaluationReengagement.js');
            await markReengageSent(reengageIds, { messageId: result?.messageId || null });
        }
        if (purpose === 'attendance_confirmation' && appointmentId) {
            const { markAttendanceConfirmationSent } = await import('../services/appointment/attendanceConfirmation.service.js');
            await markAttendanceConfirmationSent(appointmentId, { messageId: result?.messageId || null });
        }
        console.log(`[${tag}] ✅ Job ${job.id} — enviado com sucesso`);
        return result;
}

/** Último erro de um job: marca a oferta / retomada como falha (igual ao handler 'failed' do child). */
export function onWhatsappSendJobFailed(job, err) {
    const lastTry = job && job.attemptsMade >= (job.opts?.attempts || 1);
    if (lastTry && ['convenio_offer', 'convenio_announce'].includes(job.data?.purpose) && job.data.waitlistIds?.length) {
        import('../services/convenioWaitlistOffer.js')
            .then(({ markOfferFailed }) => markOfferFailed(job.data.waitlistIds, err.message, job.data.purpose))
            .catch(() => {});
    }
    if (lastTry && job.data?.purpose === 'evaluation_reengage' && job.data.reengageEvaluationIds?.length) {
        import('../services/commercial/evaluationReengagement.js')
            .then(({ markReengageFailed }) => markReengageFailed(job.data.reengageEvaluationIds, err.message))
            .catch(() => {});
    }
}

export default { processWhatsappSendJob, onWhatsappSendJobFailed };
