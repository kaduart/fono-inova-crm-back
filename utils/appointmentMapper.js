import moment from 'moment-timezone';

/**
 * 🧩 Resolve visualFlag com base no estado real do agendamento
 */
export const resolveVisualFlag = (appt) => {
    if (appt === 'pre') return 'pending';
    // Retorno não gera cobrança — exibe como ok sem badge financeiro
    if (appt.paymentStatus === 'not_applicable') return 'ok';

    // Prioridade 1: Pagamento vinculado diretamente
    const pStatus = appt.payment?.status || appt.paymentStatus;
    if (pStatus === 'paid') return 'ok';
    if (pStatus === 'partial') return 'partial';
    if (pStatus === 'pending') return 'pending';

    // Prioridade 2: Status consolidado no Appointment
    if (['paid', 'package_paid', 'advanced', 'not_applicable'].includes(appt.paymentStatus)) return 'ok';
    if (['partial', 'pending_receipt'].includes(appt.paymentStatus)) return 'partial';

    // Prioridade 3: Se o visualFlag no banco for algo explícito e NÃO for o default 'pending'
    if (appt.visualFlag && appt.visualFlag !== 'pending') return appt.visualFlag;

    // Prioridade 4: Lógica de pacotes
    if (appt.package) {
        const pkg = appt.package;
        const sess = appt.session;
        const balance = pkg.balance ?? 0;
        if (sess?.isPaid || balance === 0) return 'ok';
        if (balance > 0 && (pkg.totalPaid || 0) > 0) return 'partial';
        return 'blocked';
    }

    return appt.visualFlag || 'pending';
};

/**
 * 🎨 Mapeia status técnico para status amigável do frontend
 */
export const getFriendlyStatus = (opStatus, isPre = false) => {
    if (isPre) return opStatus === 'novo' ? 'Pendente' : 'Pendente';
    switch (opStatus) {
        case 'completed': return 'Atendido';
        case 'confirmed':
        case 'paid': return 'Confirmado';
        case 'scheduled':
        case 'pending': return 'Pendente';
        case 'canceled':
        case 'missed': return 'Cancelado';
        default: return 'Pendente';
    }
};

/**
 * 🔹 Helper para extrair nomes de paciente de forma polimórfica
 */
export const getSafePatientName = (appt) => {
    const p = appt.patient;
    // 1. Objeto paciente populado (check _id ou id para garantir que é obj)
    if (p && typeof p === 'object') {
        if (p.fullName) return p.fullName;
        if (p.name) return p.name;
    }
    // 2. Campo patientInfo (comum em pré-agendamentos ou migrados)
    if (appt.patientInfo?.fullName) return appt.patientInfo.fullName;
    // 3. Campo patientName no nível raiz
    if (appt.patientName && typeof appt.patientName === 'string' && appt.patientName !== "Paciente Desconhecido") return appt.patientName;
    // 4. Caso o campo .patient seja uma string (agendamentos antigos)
    if (p && typeof p === 'string' && p.length > 5) return p;

    // 5. Notas ou Titulo (ultimo recurso)
    if (appt.title && !appt.title.includes("Consulta")) return appt.title;

    return "Paciente Desconhecido";
};

/**
 * 🔹 Helper para extrair nome de profissional de forma polimórfica
 */
export const getSafeProfessionalName = (appt) => {
    const d = appt.doctor;
    // 1. Objeto doctor populado
    if (d && typeof d === 'object') {
        if (d.fullName) return d.fullName;
        if (d.name) return d.name;
    }
    // 2. Campo professionalName direto (comum em pré-agendamentos)
    if (appt.professionalName) return appt.professionalName;
    // 3. Campo professional no nível raiz
    if (appt.professional && typeof appt.professional === 'string' && appt.professional !== "Profissional Desconhecido") return appt.professional;

    // 4. Fallback para campos de doutores importados
    if (appt.doctorName) return appt.doctorName;

    return "Profissional Desconhecido";
};

/**
 * Retorna true se o agendamento é de convênio, independente de edições manuais no billingType.
 * Usa 4 sinais: billingType, paymentMethod, insuranceProvider e insuranceGuide (vínculo com guia).
 */
export const isInsuranceAppointment = (appt) => {
    if (!appt) return false;
    if (appt.billingType === 'convenio') return true;
    if (appt.paymentMethod === 'convenio') return true;
    // insuranceProvider é sempre string — trim() previne whitespace acidental
    if (typeof appt.insuranceProvider === 'string') return appt.insuranceProvider.trim().length > 0;
    if (appt.insuranceProvider) return true;
    // insuranceGuide pode ser ObjectId (sem .trim) ou string — tratar separadamente
    if (typeof appt.insuranceGuide === 'string') return appt.insuranceGuide.trim().length > 0;
    if (appt.insuranceGuide) return true;
    return false;
};

/**
 * 🔹 Mapeia um agendamento REAL para o formato do Frontend/FullCalendar
 *
 * @param {Object} appt - documento Appointment (lean), populado com `payment`
 *   (que, sob sinal+saldo, é sempre o Payment de SALDO — nunca o sinal, ver
 *   domain/payment/depositBalance.js).
 * @param {Object} [extra]
 * @param {number} [extra.depositAmount] - valor do sinal já pago pra este
 *   appointment (0/undefined quando não há sinal). Calculado pelo CHAMADOR
 *   via lookup em lote (nunca aqui — este mapper não faz I/O), pra não virar
 *   N+1 numa lista de agendamentos.
 */
export const mapAppointmentToEvent = (appt, extra = {}) => {
    // appt.date pode ser Date object (Mongoose) ou ISO string — extraímos só YYYY-MM-DD
    const dateStr = appt.date ? new Date(appt.date).toISOString().substring(0, 10) : '';
    const startMoment = moment.tz(`${dateStr} ${appt.time}`, "YYYY-MM-DD HH:mm", "America/Sao_Paulo");
    const end = startMoment.isValid() ? startMoment.clone().add(appt.duration || 40, 'minutes').toISOString() : null;
    const start = startMoment.isValid() ? startMoment.toISOString() : null;

    const professionalName = getSafeProfessionalName(appt);
    const patientName = getSafePatientName(appt);

    // Preserva status consolidados no Appointment (ex: pending_receipt de convênio/liminar)
    // antes de cair no status genérico do Payment, que pode ser apenas 'pending'.
    const consolidatedStatus = ['pending_receipt', 'not_applicable', 'package_paid', 'paid', 'partial', 'advanced'].includes(appt.paymentStatus)
        ? appt.paymentStatus
        : null;
    const paymentStatus = consolidatedStatus ||
        appt.payment?.status || appt.paymentStatus || appt.session?.paymentStatus ||
        (appt.package?.financialStatus === 'paid' ? 'paid' : 'pending');

    const status = getFriendlyStatus(appt.operationalStatus);

    return {
        id: appt._id?.toString() || appt.id,
        title: `${appt.notes || appt.reason || 'Consulta'} - ${professionalName}`,
        start, end, date: appt.date, time: appt.time,
        status: status, // Mapeado: Penente/Confirmado/Cancelado
        operationalStatus: appt.operationalStatus, // Raw: scheduled, confirmed, etc.
        specialty: appt.specialty,
        professional: professionalName,
        patientName: patientName,
        observations: appt.notes || "",
        responsible: appt.responsible || "",
        phone: appt.patient?.phone || appt.patientInfo?.phone || "",
        paymentStatus,
        visualFlag: resolveVisualFlag({ ...appt, paymentStatus }),
        // 🆕 DADOS DE CONVÊNIO/PLANO
        billingType: appt.billingType || 'particular',
        insuranceProvider: appt.insuranceProvider || '',
        insuranceValue: appt.insuranceValue || 0,
        insuranceGuide: appt.insuranceGuide?._id?.toString() || appt.insuranceGuide?.toString() || null,
        insuranceGuideNumber: appt.insuranceGuide?.number || null,
        authorizationCode: appt.authorizationCode || '',
        // 📦 PACOTE (se houver)
        // 🚨 FIX (2026-09-04): Package.remainingSessions é virtual (totalSessions -
        // sessionsDone) — não sobrevive a .populate(...).lean() em appointmentReads.js,
        // então nunca chegava no front apesar de estar no `.select()`. Calculado aqui
        // (mesma fórmula do virtual, só que como valor real) pra o front só LER se o
        // pacote está esgotado, sem precisar reimplementar a regra (RN fica no back).
        package: appt.package
            ? {
                ...appt.package,
                remainingSessions: Math.max(0, (appt.package.totalSessions || 0) - (appt.package.sessionsDone || 0)),
              }
            : null,
        // ⚖️ CONTRATO LIMINAR (se houver) — necessário para o guard financeiro do front validar saldo
        liminarContract: appt.liminarContract || null,
        patient: {
            ...(typeof appt.patient === 'object' ? appt.patient : {}),
            fullName: patientName,
            phone: appt.patient?.phone || appt.patientInfo?.phone || "",
            dateOfBirth: appt.patient?.dateOfBirth || appt.patientInfo?.birthDate || "",
            email: appt.patient?.email || appt.patientInfo?.email || ""
        },
        doctor: {
            ...(typeof appt.doctor === 'object' ? appt.doctor : {}),
            fullName: professionalName
        },
        // 💰 Valor da sessão — SEMPRE o valor clínico total, nunca desconta o
        // sinal (Produção/valor da consulta é R$500 mesmo com R$50 de sinal já
        // pago). paymentAmount continua o valor cheio por compatibilidade com
        // quem já lê esse campo — quem precisa do valor a cobrar HOJE (saldo)
        // deve usar `remainingAmount` abaixo, nunca subtrair sessionValue no
        // frontend (ver back/docs/FINANCIAL_SOURCE_OF_TRUTH.md#payment-role).
        sessionValue: appt.sessionValue || appt.payment?.amount || 0,
        paymentAmount: appt.sessionValue || appt.payment?.amount || 0,
        // 🎯 SINAL + SALDO (2026-09-04): calculado no backend, o front só exibe.
        // depositAmount=0 preserva 100% o comportamento legado (sem sinal).
        depositAmount: extra.depositAmount || 0,
        remainingAmount: extra.depositAmount > 0
            ? Math.max((appt.sessionValue || appt.payment?.amount || 0) - (extra.paidTotal ?? extra.depositAmount), 0)
            : null,
        // 🔗 IDs de referência
        session: appt.session?._id?.toString() || appt.session?.toString() || null,
        payment: appt.payment?._id?.toString() || appt.payment?.toString() || null,
        metadata: appt.metadata || null,
        // Tipo de serviço — necessário para badges na agenda
        serviceType: appt.serviceType || null,
        crm: appt.crm || null,
        // 💳 Método de pagamento — para exibir na agenda
        paymentMethod: appt.paymentMethod || appt.payment?.paymentMethod || null,
    };
};
