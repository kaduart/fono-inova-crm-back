import moment from 'moment-timezone';

/**
 * 🧩 Resolve visualFlag com base no estado real do agendamento
 */
export const resolveVisualFlag = (appt) => {
    if (appt === 'pre') return 'pending';
    // Prioridade 1: Pagamento vinculado diretamente
    const pStatus = appt.payment?.status || appt.paymentStatus;
    if (pStatus === 'paid') return 'ok';
    if (pStatus === 'partial') return 'partial';
    if (pStatus === 'pending') return 'pending';

    // Prioridade 2: Status consolidado no Appointment
    if (['paid', 'package_paid', 'advanced'].includes(appt.paymentStatus)) return 'ok';
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
        case 'confirmed':
        case 'paid': return 'Confirmado';
        case 'scheduled': // Mapeando scheduled para Pendente conforme solicitado pelo usuário
        case 'canceled': return 'Cancelado';
        case 'pending':
        case 'missed':
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
 * 🔹 Mapeia um agendamento REAL para o formato do Frontend/FullCalendar
 */
export const mapAppointmentToEvent = (appt) => {
    const startMoment = moment.tz(`${appt.date} ${appt.time}`, "YYYY-MM-DD HH:mm", "America/Sao_Paulo");
    const end = startMoment.clone().add(appt.duration || 40, 'minutes').toISOString();
    const start = startMoment.toISOString();

    const professionalName = getSafeProfessionalName(appt);
    const patientName = getSafePatientName(appt);

    const paymentStatus =
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
        patient: {
            ...(typeof appt.patient === 'object' ? appt.patient : {}),
            fullName: patientName
        },
        doctor: {
            ...(typeof appt.doctor === 'object' ? appt.doctor : {}),
            fullName: professionalName
        },
        metadata: appt.metadata || null
    };
};

/**
 * 🔹 Mapeia um PRÉ-AGENDAMENTO (INTERESSE) para o formato do Frontend
 */
export const mapPreAgendamentoToEvent = (pre) => {
    const startMoment = moment.tz(`${pre.preferredDate} ${pre.preferredTime || "08:00"}`, "YYYY-MM-DD HH:mm", "America/Sao_Paulo");
    const end = startMoment.clone().add(40, 'minutes').toISOString();
    const pName = getSafePatientName(pre);
    const dName = getSafeProfessionalName(pre);

    return {
        id: pre._id?.toString() || pre.id,
        title: `[INTERESSE] ${pName} - ${dName}`,
        start: startMoment.toISOString(),
        end,
        date: pre.preferredDate,
        time: pre.preferredTime || "08:00",
        status: getFriendlyStatus(pre.status, true),
        specialty: pre.specialty,
        professional: dName,
        patientName: pName,
        observations: pre.notes || pre.secretaryNotes || "",
        responsible: "",
        phone: pre.patientInfo?.phone || "",
        visualFlag: 'pending',
        __isPreAgendamento: true,
        patient: { fullName: pName },
        doctor: { fullName: dName },
        originalData: pre
    };
};
