// domain/invoice/createInvoice.js
import Invoice from '../../models/Invoice.js';
import Appointment from '../../models/Appointment.js';
import Package from '../../models/Package.js';
import { publishEvent, EventTypes } from '../../infrastructure/events/eventPublisher.js';
import { createContextLogger } from '../../utils/logger.js';
import { generateInvoiceNumber } from './generateInvoiceNumber.js';

/**
 * Cria fatura a partir de agendamentos/sessões
 * 
 * REGRAS DE NEGÓCIO:
 * - type: quem paga (patient/insurance)
 * - origin: de onde vem (session/package/batch)
 * - LIMINAR NÃO É FATURA (é reconhecimento de receita direto em Payment)
 * 
 * @param {Object} data - Dados da fatura
 * @returns {Object} Fatura criada
 */
export async function createInvoice(data) {
  const {
    patientId,
    type,              // 'patient' ou 'insurance'
    origin = 'session', // 'session', 'package' ou 'batch'
    appointments = [],
    packageId = null,
    startDate,
    endDate,
    dueDate,
    discount = 0,
    tax = 0,
    notes = '',
    createdBy = null,
    correlationId = null
  } = data;

  const log = createContextLogger(correlationId, 'invoice');

  log.info('create_start', 'Iniciando criação de fatura', {
    patientId,
    type,
    origin,
    appointmentsCount: appointments.length
  });

  try {
    // 🛡️ Validações
    if (!patientId) {
      throw new Error('PATIENT_REQUIRED');
    }

    if (!type || !['patient', 'insurance'].includes(type)) {
      throw new Error('INVALID_TYPE');
    }

    if (!origin || !['session', 'package', 'batch'].includes(origin)) {
      throw new Error('INVALID_ORIGIN');
    }

    // 🛡️ Regra de negócio: convênio só via batch
    if (type === 'insurance' && origin !== 'batch') {
      throw new Error('INSURANCE_INVOICE_MUST_BE_BATCH');
    }

    if (!appointments.length && !packageId) {
      throw new Error('APPOINTMENTS_OR_PACKAGE_REQUIRED');
    }

    // Busca dados dos agendamentos
    let appointmentDocs = [];
    let doctorId = null;
    
    if (appointments.length > 0) {
      appointmentDocs = await Appointment.find({
        _id: { $in: appointments }
      }).populate('session doctor package');

      if (appointmentDocs.length !== appointments.length) {
        throw new Error('SOME_APPOINTMENTS_NOT_FOUND');
      }

      doctorId = appointmentDocs[0].doctor?._id;
    }

    // Se tem packageId, busca dados
    let packageDoc = null;
    if (packageId) {
      packageDoc = await Package.findById(packageId);
      if (!packageDoc) {
        throw new Error('PACKAGE_NOT_FOUND');
      }
      doctorId = packageDoc.doctor;
    }

    // Gera número da fatura
    const invoiceNumber = await generateInvoiceNumber(type);

    // Monta itens da fatura
    const items = buildInvoiceItems(appointmentDocs, packageDoc, origin);

    if (items.length === 0) {
      throw new Error('NO_ITEMS_TO_INVOICE');
    }

    // Calcula totais
    const subtotal = items.reduce((sum, item) => sum + item.totalValue, 0);
    const total = Math.max(0, subtotal - discount + tax);

    // Cria a fatura
    const invoice = new Invoice({
      invoiceNumber,
      type,
      origin,
      patient: patientId,
      doctor: doctorId,
      appointment: appointments.length === 1 ? appointments[0] : undefined,
      package: packageId,
      startDate: startDate || appointmentDocs[0]?.date || new Date(),
      endDate: endDate || appointmentDocs[appointmentDocs.length - 1]?.date || new Date(),
      dueDate: dueDate || calculateDueDate(type),
      items,
      subtotal,
      discount,
      tax,
      total,
      balance: total, // Inicialmente tudo em aberto
      notes,
      createdBy,
      correlationId,
      version: 2
    });

    await invoice.save();

    // Atualiza agendamentos com referência da fatura
    if (appointments.length > 0) {
      await Appointment.updateMany(
        { _id: { $in: appointments } },
        { 
          $set: { 
            invoice: invoice._id,
            invoicedAt: new Date()
          }
        }
      );
    }

    // Publica evento
    await publishEvent(
      EventTypes.INVOICE_CREATED,
      {
        invoiceId: invoice._id.toString(),
        invoiceNumber: invoice.invoiceNumber,
        patientId: patientId.toString(),
        type,
        origin,
        total: invoice.total,
        itemCount: items.length
      },
      { correlationId }
    );

    log.info('create_success', 'Fatura criada com sucesso', {
      invoiceId: invoice._id,
      invoiceNumber,
      type,
      origin,
      total: invoice.total
    });

    return {
      success: true,
      invoice,
      items: items.length,
      total: invoice.total
    };

  } catch (error) {
    log.error('create_error', 'Erro ao criar fatura', {
      error: error.message,
      patientId,
      type,
      origin
    });
    throw error;
  }
}

/**
 * Cria fatura per-session (particular)
 * Chamado quando uma sessão é completada e o paciente precisa pagar
 */
export async function createPerSessionInvoice(data) {
  const {
    patientId,
    appointmentId,
    sessionValue,
    correlationId = null
  } = data;

  const log = createContextLogger(correlationId, 'invoice_per_session');

  log.info('per_session_start', 'Criando fatura per-session', {
    patientId,
    appointmentId,
    sessionValue
  });

  try {
    const result = await createInvoice({
      patientId,
      type: 'patient',
      origin: 'session',
      appointments: [appointmentId],
      dueDate: calculateDueDate('patient'),
      notes: 'Pagamento por sessão realizada',
      correlationId
    });

    log.info('per_session_success', 'Fatura per-session criada', {
      invoiceId: result.invoice._id,
      total: result.total
    });

    return result;

  } catch (error) {
    log.error('per_session_error', 'Erro ao criar fatura per-session', {
      error: error.message
    });
    throw error;
  }
}

/**
 * Cria fatura mensal consolidada para um paciente
 * Agrupa todas as sessões do mês
 */
export async function createMonthlyInvoice(data) {
  const {
    patientId,
    year,
    month,
    correlationId = null
  } = data;

  const log = createContextLogger(correlationId, 'invoice_monthly');

  log.info('monthly_start', 'Criando fatura mensal', {
    patientId,
    year,
    month
  });

  try {
    // Busca primeiro e último dia do mês
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0);
    
    // Busca agendamentos completados não faturados
    const appointments = await Appointment.find({
      patient: patientId,
      clinicalStatus: 'completed',
      date: { $gte: startDate, $lte: endDate },
      invoice: { $exists: false },
      paymentOrigin: { $in: ['auto_per_session', 'manual_balance'] }
    });

    if (appointments.length === 0) {
      return {
        success: false,
        reason: 'NO_APPOINTMENTS_TO_INVOICE'
      };
    }

    const result = await createInvoice({
      patientId,
      type: 'patient',
      origin: 'session',
      appointments: appointments.map(a => a._id),
      startDate,
      endDate,
      dueDate: new Date(endDate.getTime() + 7 * 24 * 60 * 60 * 1000),
      notes: `Fatura referente a ${month}/${year}`,
      correlationId
    });

    log.info('monthly_success', 'Fatura mensal criada', {
      invoiceId: result.invoice._id,
      appointmentsCount: appointments.length
    });

    return result;

  } catch (error) {
    log.error('monthly_error', 'Erro ao criar fatura mensal', {
      error: error.message
    });
    throw error;
  }
}

// ============ HELPERS ============

function buildInvoiceItems(appointments, packageDoc, origin) {
  const items = [];

  if (origin === 'session') {
    for (const apt of appointments) {
      const session = apt.session;
      const value = getAppointmentValue(apt);
      
      items.push({
        description: buildItemDescription(apt, session),
        quantity: 1,
        unitValue: value,
        totalValue: value,
        appointment: apt._id,
        session: session?._id,
        serviceDate: apt.date,
        specialty: apt.specialty || session?.specialty,
        doctor: apt.doctor?._id
      });
    }
  }

  if (origin === 'package' && packageDoc) {
    items.push({
      description: `Pacote ${packageDoc.specialty} - ${packageDoc.totalSessions} sessões`,
      quantity: 1,
      unitValue: packageDoc.totalValue,
      totalValue: packageDoc.totalValue,
      package: packageDoc._id,
      serviceDate: packageDoc.date
    });
  }

  return items;
}

function buildItemDescription(appointment, session) {
  const date = new Date(appointment.date).toLocaleDateString('pt-BR');
  const specialty = appointment.specialty || session?.specialty || 'Consulta';
  return `${specialty} - ${date}`;
}

function getAppointmentValue(appointment) {
  if (appointment.session?.sessionValue) {
    return appointment.session.sessionValue;
  }
  if (appointment.package?.sessionValue) {
    return appointment.package.sessionValue;
  }
  return appointment.sessionValue || 0;
}

function calculateDueDate(type) {
  const date = new Date();
  // Convênio tem prazo maior
  const days = type === 'insurance' ? 30 : 7;
  date.setDate(date.getDate() + days);
  return date;
}
