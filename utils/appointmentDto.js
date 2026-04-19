/**
 * 🔥 APPOINTMENT DTO — Única Fonte de Verdade
 *
 * Regra absoluta: qualquer endpoint V2 que retorne appointment
 * deve passar por este mapper. Nunca mais construir DTO inline.
 *
 * Compat layer: patientInfo é preenchido automaticamente a partir
 * do patient populado, garantindo que consumidores antigos não quebrem.
 */

export function mapAppointmentDTO(appointment) {
    if (!appointment) return null;

    const patientPopulated = appointment.patient && typeof appointment.patient === 'object'
        ? appointment.patient
        : null;

    const doctorPopulated = appointment.doctor && typeof appointment.doctor === 'object'
        ? appointment.doctor
        : null;

    // 🔥 Fonte única de verdade
    const patientName = patientPopulated?.fullName ||
                        patientPopulated?.name ||
                        appointment.patientName ||
                        appointment.patientInfo?.fullName ||
                        null;

    const doctorName = doctorPopulated?.fullName ||
                       doctorPopulated?.name ||
                       appointment.professionalName ||
                       null;

    const patientId = patientPopulated?._id?.toString?.() ||
                      (typeof appointment.patient === 'string' ? appointment.patient : null) ||
                      appointment.patientId ||
                      null;

    const doctorId = doctorPopulated?._id?.toString?.() ||
                     (typeof appointment.doctor === 'string' ? appointment.doctor : null) ||
                     appointment.doctorId ||
                     null;

    // 🛡️ Compat layer: patientInfo sempre reflete o patient populado
    const patientInfo = patientPopulated
        ? {
              fullName: patientPopulated.fullName || patientPopulated.name || '',
              phone: patientPopulated.phone || '',
              email: patientPopulated.email || null,
              birthDate: patientPopulated.dateOfBirth || patientPopulated.birthDate || null,
          }
        : (appointment.patientInfo || null);

    return {
        // Identidade
        id: appointment._id?.toString?.() || appointment.id,
        _id: appointment._id?.toString?.() || appointment.id,

        // Status
        // 🔥 converted é estado transitório interno — nunca expõe no contrato público
        operationalStatus: appointment.operationalStatus === 'converted' ? 'scheduled' : (appointment.operationalStatus || 'scheduled'),
        clinicalStatus: appointment.clinicalStatus || 'pending',
        status: appointment.operationalStatus === 'converted' ? 'Agendado' : (appointment.status || appointment.operationalStatus || 'scheduled'),

        // Data / hora
        date: appointment.date,
        time: appointment.time,
        duration: appointment.duration || 40,

        // Paciente (única fonte de verdade)
        patient: patientPopulated
            ? {
                  _id: patientPopulated._id,
                  fullName: patientPopulated.fullName || patientPopulated.name || null,
                  phone: patientPopulated.phone || null,
                  email: patientPopulated.email || null,
                  birthDate: patientPopulated.dateOfBirth || patientPopulated.birthDate || null,
              }
            : null,
        patientId,
        patientName,
        patientInfo,

        // Profissional
        doctor: doctorPopulated
            ? {
                  _id: doctorPopulated._id,
                  fullName: doctorPopulated.fullName || doctorPopulated.name || null,
                  specialty: doctorPopulated.specialty || null,
              }
            : null,
        doctorId,
        doctorName,
        professionalName: doctorName,

        // Serviço
        specialty: appointment.specialty || appointment.sessionType || '',
        serviceType: appointment.serviceType || null,
        sessionType: appointment.sessionType || null,
        sessionValue: appointment.sessionValue ?? 0,

        // Pagamento
        paymentStatus: appointment.paymentStatus || 'pending',
        paymentMethod: appointment.paymentMethod || null,
        billingType: appointment.billingType || 'particular',
        insuranceProvider: appointment.insuranceProvider || null,
        insuranceValue: appointment.insuranceValue ?? 0,
        authorizationCode: appointment.authorizationCode || null,

        // Relacionamentos
        package: appointment.package || null,
        payment: appointment.payment || null,
        session: appointment.session || null,
        appointmentId: appointment.appointmentId || null,

        // Textos
        notes: appointment.notes || appointment.observations || '',
        observations: appointment.notes || appointment.observations || '',
        responsible: appointment.responsible || '',

        // Metadados
        metadata: appointment.metadata || null,
        visualFlag: appointment.visualFlag || null,
        createdAt: appointment.createdAt || null,
        updatedAt: appointment.updatedAt || null,
        importedAt: appointment.importedAt || null,
        source: appointment.metadata?.origin?.source || 'crm',

        // Flags extras (se presentes)
        isFirstVisit: appointment.isFirstVisit ?? null,
        isReturningAfter45Days: appointment.isReturningAfter45Days ?? null,
    };
}

export function mapAppointmentListDTO(appointments = []) {
    return appointments.map(mapAppointmentDTO);
}
