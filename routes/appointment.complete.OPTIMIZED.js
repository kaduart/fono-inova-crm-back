/**
 * ROTA OTIMIZADA: PATCH /:id/complete
 * 
 * MUDANÇAS:
 * 1. Buscar dados FORA da transação (sem lock)
 * 2. Transação apenas para updates (mínima)
 * 3. Retorno IDÊNTICO ao original
 * 4. Removido snapshot + majority (overhead desnecessário)
 * 
 * RESULTADO ESPERADO: 76s → < 1s
 */

router.patch('/:id/complete', auth, async (req, res) => {
    let session = null;
    const startTime = Date.now();
    
    try {
        const { id } = req.params;
        const { addToBalance = false, balanceAmount = 0, balanceDescription = '' } = req.body;
        
        console.log(`[complete] Iniciando - addToBalance: ${addToBalance}, patientId: ${req.body.patientId || 'n/a'}`);

        // ============================================================
        // FASE 1: BUSCAR DADOS FORA DA TRANSAÇÃO (sem lock)
        // ============================================================
        console.log(`[complete] Fase 1: Buscando dados (${Date.now() - startTime}ms)`);
        
        const appointment = await Appointment.findById(id)
            .populate('session patient doctor payment')
            .populate({
                path: 'package',
                populate: { path: 'payments' }
            })
            .lean(); // <-- SEM .session()! Sem transação!

        if (!appointment) {
            return res.status(404).json({ error: 'Agendamento não encontrado' });
        }

        console.log(`[complete] Dados carregados (${Date.now() - startTime}ms)`);

        // Guardar IDs para usar na transação
        const sessionId = appointment.session?._id || appointment.session;
        const paymentId = appointment.payment?._id || appointment.payment;
        const packageId = appointment.package?._id || appointment.package;
        const patientId = appointment.patient?._id || appointment.patient;

        // ✅ Só incrementa pacote se ainda não estiver concluído
        const shouldIncrementPackage =
            appointment.package &&
            appointment.clinicalStatus !== 'completed';
        
        console.log(`[complete] shouldIncrementPackage: ${shouldIncrementPackage}, hasPackage: ${!!appointment.package}, clinicalStatus: ${appointment.clinicalStatus}`);

        // ============================================================
        // FASE 2: TRANSAÇÃO MÍNIMA (apenas updates)
        // ============================================================
        console.log(`[complete] Fase 2: Iniciando transação (${Date.now() - startTime}ms)`);
        
        session = await mongoose.startSession();
        
        // Transação simples, sem snapshot/majority (overhead desnecessário)
        session.startTransaction();

        // 1️⃣ ATUALIZAR SESSÃO (SEMPRE!)
        console.log(`[complete] Etapa 1: Atualizando sessão (${Date.now() - startTime}ms)`);
        
        const sessionUpdateData = addToBalance ? {
            status: 'completed',
            isPaid: false,
            paymentStatus: 'pending',
            addedToBalance: true,
            balanceAmount: balanceAmount || appointment.sessionValue || 0,
            visualFlag: 'pending',
            updatedAt: new Date()
        } : {
            status: 'completed',
            isPaid: true,
            paymentStatus: 'paid',
            visualFlag: 'ok',
            updatedAt: new Date()
        };
        
        if (sessionId) {
            await Session.findOneAndUpdate(
                { _id: sessionId },
                sessionUpdateData,
                { session } // <-- só o update está na transação
            );
            console.log(`[complete] Session atualizada (${Date.now() - startTime}ms)`);
        }

        // 2️⃣ ATUALIZAR PAYMENT (se não for saldo devedor)
        if (!addToBalance) {
            let finalPaymentId = paymentId;

            // ✅ FIX: Se não tem payment vinculado, busca pelo appointment ID
            if (!finalPaymentId && !packageId) {
                const orphanPayment = await Payment.findOne(
                    { appointment: appointment._id },
                    { _id: 1 }, // <-- só pega o ID, não o documento inteiro
                    { session }
                );

                if (orphanPayment) {
                    finalPaymentId = orphanPayment._id;

                    // Vincula de volta ao appointment
                    await Appointment.updateOne(
                        { _id: appointment._id },
                        { $set: { payment: finalPaymentId } },
                        { session }
                    );
                }
            }

            if (finalPaymentId) {
                // 🔒 TRAVA ANTI-DUPLICAÇÃO: Verificar status (só pega o campo necessário)
                const existingPayment = await Payment.findOne(
                    { _id: finalPaymentId },
                    { status: 1 }, // <-- só pega o status!
                    { session }
                );

                const updateData = existingPayment?.status === 'paid'
                    ? {
                        status: 'paid',
                        updatedAt: new Date()
                    }
                    : {
                        status: 'paid',
                        paymentDate: moment().tz("America/Sao_Paulo").format("YYYY-MM-DD"),
                        updatedAt: new Date()
                    };

                await Payment.updateOne(
                    { _id: finalPaymentId },
                    { $set: updateData },
                    { session }
                );
            }
        } else {
            console.log(`[complete] Pulando atualização de payment (saldo devedor)`);
        }

        // 3️⃣ ATUALIZAR PACOTE (SE NECESSÁRIO)
        console.log(`[complete] Etapa 3: Verificando pacote (${Date.now() - startTime}ms)`);
        
        let packageDoc = null;
        if (shouldIncrementPackage && packageId) {
            // Buscar só o tipo do pacote (para decidir paymentStatus)
            packageDoc = await Package.findOne(
                { _id: packageId },
                { type: 1, sessionsDone: 1, totalSessions: 1 },
                { session }
            );
            
            await Package.updateOne(
                {
                    _id: packageId,
                    $expr: { $lt: ["$sessionsDone", "$totalSessions"] }
                },
                {
                    $inc: { sessionsDone: 1 },
                    $set: { updatedAt: new Date() }
                },
                { session }
            );
        }

        console.log(`[complete] Etapa 4: Atualizando agendamento (${Date.now() - startTime}ms)`);
        
        // 4️⃣ ATUALIZAR AGENDAMENTO
        const historyEntry = {
            action: addToBalance ? 'confirmed_with_balance' : 'confirmed',
            newStatus: 'confirmed',
            changedBy: req.user._id,
            timestamp: new Date(),
            context: 'operacional',
            details: addToBalance ? { 
                addedToBalance: true, 
                amount: balanceAmount || appointment.sessionValue || 0 
            } : undefined
        };

        const updateData = {
            operationalStatus: 'confirmed',
            clinicalStatus: 'completed',
            completedAt: new Date(),
            updatedAt: new Date(),
            visualFlag: 'ok',
            $push: { history: historyEntry }
        };

        // 💰 Se for adicionar ao saldo devedor, não marca como pago
        if (addToBalance) {
            updateData.paymentStatus = 'pending';
            updateData.visualFlag = 'pending';
            updateData.addedToBalance = true;
            updateData.balanceAmount = balanceAmount || appointment.sessionValue || 0;
            updateData.balanceDescription = balanceDescription || 'Sessão utilizada - pagamento pendente';
        } else if (packageId) {
            // 🏥 Se for pacote de convênio, mantém pending_receipt
            if (packageDoc && packageDoc.type === 'convenio') {
                updateData.paymentStatus = 'pending_receipt';
                updateData.visualFlag = 'pending';
            } else {
                updateData.paymentStatus = 'package_paid';
            }
        } else {
            updateData.paymentStatus = 'paid';
        }

        console.log(`[complete] Executando Appointment.updateOne (${Date.now() - startTime}ms)`);
        
        await Appointment.updateOne(
            { _id: id },
            updateData,
            { session }
        );
        
        console.log(`[complete] Appointment.updateOne concluído (${Date.now() - startTime}ms)`);

        // 5️⃣ COMMIT
        console.log(`[complete] Commitando transação... (${Date.now() - startTime}ms)`);
        await session.commitTransaction();
        console.log(`[complete] ✅ Transação commitada (${Date.now() - startTime}ms)`);

        // ============================================================
        // FASE 3: OPERAÇÕES PÓS-COMMIT (não bloqueiam resposta)
        // ============================================================
        
        // 6️⃣ ATUALIZAR SALDO DEVEDOR (fora da transação)
        if (addToBalance && patientId) {
            console.log(`[complete] Atualizando saldo devedor... (${Date.now() - startTime}ms)`);
            try {
                const patientBalance = await PatientBalance.getOrCreate(patientId);
                
                // 🆕 MAPEAMENTO: Converte service types específicos para especialidades
                let normalizedSpecialty = appointment.specialty;
                const specialtyMap = {
                    'tongue_tie_test': 'fonoaudiologia',
                    'neuropsych_evaluation': 'psicologia',
                    'evaluation': appointment.specialty || 'fonoaudiologia'
                };
                
                if (appointment.serviceType && specialtyMap[appointment.serviceType]) {
                    normalizedSpecialty = specialtyMap[appointment.serviceType];
                }
                
                await patientBalance.addDebit(
                    balanceAmount || appointment.sessionValue || 0,
                    balanceDescription || `Sessão ${appointment.date} - pagamento pendente`,
                    sessionId,
                    appointment._id,
                    req.user?._id,
                    normalizedSpecialty,  // 🆕 ESPECIALIDADE MAPEADA
                    appointment.correlationId  // 🆕 V4: correlationId para idempotência
                );
                console.log(`[complete] ✅ Débito adicionado (${Date.now() - startTime}ms)`);
            } catch (err) {
                console.error(`[complete] ❌ Erro ao atualizar saldo (não crítico): ${err.message}`);
            }
        }

        // 7️⃣ BUSCAR DADOS FINAIS (retorno idêntico ao original)
        console.log(`[complete] Buscando dados finais... (${Date.now() - startTime}ms)`);
        
        const finalAppointment = await Appointment.findById(id)
            .populate('session package patient doctor payment');

        // 8️⃣ SINCRONIZAR (não bloqueia resposta)
        setImmediate(async () => {
            try {
                await syncEvent(finalAppointment, 'appointment');
                console.log(`[complete] Sync concluído`);
            } catch (syncError) {
                console.error('[complete] ⚠️ Erro no sync (não crítico):', syncError.message);
            }
        });

        console.log(`[complete] ✅ Respondendo em ${Date.now() - startTime}ms`);
        res.json(finalAppointment);

    } catch (error) {
        if (session) {
            try {
                await session.abortTransaction();
                console.log(`[complete] Transação abortada (${Date.now() - startTime}ms)`);
            } catch (abortErr) {
                console.error('[complete] Erro ao abortar transação:', abortErr.message);
            }
        }
        console.error(`[complete] ❌ Erro ao concluir (${Date.now() - startTime}ms):`, error);
        res.status(500).json({
            error: 'Erro interno no servidor',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    } finally {
        if (session) {
            try {
                session.endSession();
            } catch (e) {
                // Silenciar erro ao fechar sessão
            }
        }
    }
});
