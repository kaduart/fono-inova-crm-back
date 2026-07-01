/**
 * 🔥 APPOINTMENT DTO — Única Fonte de Verdade
 *
 * Regra absoluta: qualquer endpoint V2 que retorne appointment
 * deve passar por este mapper. Nunca mais construir DTO inline.
 *
 * Compat layer: patientInfo é preenchido automaticamente a partir
 * do patient populado, garantindo que consumidores antigos não quebrem.
 */

import Appointment from '../models/Appointment.js';

/**
 * Versão async do mapper: auto-popula doctor/patient quando não vieram populados.
 * Use em qualquer PUT/PATCH que faz save() sem requery.
 * Aceita Mongoose doc ou ObjectId/string.
 */
export async function resolveAndMapAppointmentDTO(doc) {
    if (!doc) return null;
    // Se só temos um ID, busca o appointment completo
    const id = doc._id || doc;
    if (typeof id === 'string' || id._bsontype === 'ObjectID' || id._bsontype === 'ObjectId') {
        const appointment = await Appointment.findById(id)
            .populate('doctor', 'fullName specialty email phoneNumber')
            .populate('patient', 'fullName phone dateOfBirth email')
            .populate('session', 'isPaid paymentStatus partialAmount status')
            .populate('payment', 'status amount paymentMethod')
            .lean();
        return mapAppointmentDTO(appointment);
    }
    // Se é um doc Mongoose, popula apenas os campos que faltam
    const needsDoctorPopulate = doc.doctor && typeof doc.doctor === 'object' && !doc.doctor.fullName && !doc.doctor.name;
    const needsPatientPopulate = doc.patient && typeof doc.patient === 'object' && !doc.patient.fullName && !doc.patient.name;
    if (needsDoctorPopulate || needsPatientPopulate) {
        const paths = [];
        if (needsDoctorPopulate) paths.push({ path: 'doctor', select: 'fullName specialty email phoneNumber' });
        if (needsPatientPopulate) paths.push({ path: 'patient', select: 'fullName phone dateOfBirth email' });
        try { await doc.populate(paths); } catch (_) {}
    }
    return mapAppointmentDTO(doc);
}

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
        sessionValue: (() => {
            // 🎯 Fonte de verdade: package populado > appointment hardcoded
            const pkg = appointment.package && typeof appointment.package === 'object' ? appointment.package : null;
            if (pkg) {
                // Convênio usa insuranceGrossAmount se disponível, senão sessionValue do package
                if (pkg.type === 'convenio' && pkg.insuranceGrossAmount) {
                    return pkg.insuranceGrossAmount;
                }
                return pkg.sessionValue ?? appointment.sessionValue ?? 0;
            }
            return appointment.sessionValue ?? 0;
        })(),
        serviceTypeLabel: (() => {
            const map = {
                evaluation: 'Avaliação',
                session: 'Sessão',
                individual_session: 'Sessão Individual',
                package_session: 'Sessão de Pacote',
                tongue_tie_test: 'Teste da Linguinha',
                neuropsych_evaluation: 'Avaliação Neuropsicológica',
                return: 'Retorno',
                meet: 'Meet',
                alignment: 'Alinhamento'
            };
            return map[appointment.serviceType] || appointment.serviceType || 'Sessão';
        })(),

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
        liminarContract: appointment.liminarContract && typeof appointment.liminarContract === 'object'
            ? {
                  _id: appointment.liminarContract._id?.toString?.(),
                  processNumber: appointment.liminarContract.processNumber || null,
                  court: appointment.liminarContract.court || null,
                  totalCredit: appointment.liminarContract.totalCredit ?? null,
                  creditBalance: appointment.liminarContract.creditBalance ?? null,
                  usedCredit: appointment.liminarContract.usedCredit ?? null,
                  status: appointment.liminarContract.status || null,
              }
            : null,

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
        sessionStatusMismatch: (() => {
            const sessStatus = appointment.session?.status;
            const apptStatus = appointment.operationalStatus;
            if (!sessStatus || apptStatus === 'completed' || apptStatus === 'cancelled') return false;
            return sessStatus === 'completed';
        })(),

        // Pós-atendimento WhatsApp
        postAppointmentSentAt: appointment.postAppointmentSentAt || null,
        reviewRequestSentAt: appointment.reviewRequestSentAt || null,
    };
}

export function mapAppointmentListDTO(appointments = []) {
    return appointments.map(mapAppointmentDTO);
}
