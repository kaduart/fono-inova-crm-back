// controllers/doctorController.js
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
// Pacote e guia: populate da agenda de hoje; anamnese: selo na lista "Meus pacientes".
import Package from '../models/Package.js';
import '../models/InsuranceGuide.js';
import AnamnesisReport from '../models/AnamnesisReport.js';
import Doctor from '../models/Doctor.js';
import Patient from '../models/Patient.js';
import Session from '../models/Session.js';
import TherapySession from '../models/TherapySession.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

// Profissional alvo do painel: terapeuta sempre o próprio; admin/secretária
// podem escolher com ?doctorId= (seletor "Ver painel de", decisão do Kadu 01/11/2026).
const resolveDoctorId = (req) => {
  const q = req.query?.doctorId;
  if (['admin', 'secretary'].includes(req.user?.role) && q && mongoose.Types.ObjectId.isValid(q)) return String(q);
  return String(req.user?.doctorId || req.user?._id || req.user?.id);
};

const ObjectId = mongoose.Types.ObjectId;

const toObjectId = (id) => {
  try {
    return new mongoose.Types.ObjectId(id);
  } catch (error) {
    console.error(`Erro ao converter ID: ${id}`, error);
    return null;
  }
};

export const doctorOperations = {
  create: async (req, res) => {
    const mongoSession = await mongoose.startSession();
    await mongoSession.startTransaction();
    try {
      const {
        fullName,
        email,
        password,
        specialty,
        licenseNumber,
        phoneNumber,
        weeklyAvailability,
        active
      } = req.body;

      // Validação melhorada
      const requiredFields = ['fullName', 'email', 'specialty', 'licenseNumber', 'phoneNumber'];
      const missingFields = requiredFields.filter(field => !req.body[field]);

      if (missingFields.length > 0) {
        return sendApiError(
          res,
          new AppError('BAD_REQUEST', 'Campos obrigatórios faltando', {
            status: 400,
            extra: { missingFields },
          }),
          req
        );
      }

      // Verificação de existência em paralelo
      const [existingEmail, existingLicense] = await Promise.all([
        Doctor.findOne({ email }),
        Doctor.findOne({ licenseNumber })
      ]);

      if (existingEmail) {
        return sendApiError(
          res,
          new AppError('CONFLICT', 'Já existe um médico com este e-mail', {
            status: 409,
            legacyError: 'Email já cadastrado',
          }),
          req
        );
      }

      if (existingLicense) {
        return sendApiError(
          res,
          new AppError('CONFLICT', 'Já existe um médico com este número de registro', {
            status: 409,
            legacyError: 'Registro profissional já cadastrado',
          }),
          req
        );
      }

      const newDoctor = new Doctor({
        fullName,
        email,
        password,
        specialty,
        licenseNumber,
        phoneNumber,
        active: active !== undefined ? active : true,
        weeklyAvailability: weeklyAvailability || [],
        active: active !== undefined ? active : true
      });

      const savedDoctor = await newDoctor.save({ session: mongoSession });
      await mongoSession.commitTransaction();

      res.status(201).json({
        message: 'Médico criado com sucesso',
        doctor: {
          _id: savedDoctor._id,
          fullName: savedDoctor.fullName,
          email: savedDoctor.email,
          specialty: savedDoctor.specialty,
          licenseNumber: savedDoctor.licenseNumber,
          phoneNumber: savedDoctor.phoneNumber,
          active: savedDoctor.active,
          role: savedDoctor.role,
          weeklyAvailability: savedDoctor.weeklyAvailability,
        }
      });
    } catch (error) {
      await mongoSession.abortTransaction();

      console.error('Erro na criação do médico:', error);

      if (error.name === 'ValidationError') {
        const errors = Object.keys(error.errors).reduce((acc, key) => {
          acc[key] = error.errors[key].message;
          return acc;
        }, {});

        return sendApiError(
          res,
          new AppError('BAD_REQUEST', 'Falha na validação dos dados', {
            status: 400,
            extra: { errors },
          }),
          req
        );
      }

      if (error.code === 11000) {
        const field = Object.keys(error.keyPattern)[0];
        return sendApiError(
          res,
          new AppError('CONFLICT', `Já existe um médico com este ${field === 'email' ? 'e-mail' : 'número de registro'}`, {
            status: 409,
            legacyError: 'Dado duplicado',
          }),
          req
        );
      }

      sendApiError(
        res,
        new AppError('INTERNAL_ERROR', 'Erro interno', {
          status: 500,
          details: error.message,
        }),
        req
      );
    } finally {
      await mongoSession.endSession();
    }
  },

  get: {
    all: async (req, res) => {
      try {
        const doctors = await Doctor.find({ active: true }).select('-password').lean();
        res.status(200).json(doctors);
      } catch (error) {
        sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro ao listar médicos.', { status: 500 }), req);
      }
    }
  },

  update: async (req, res) => {
    try {
      const update = { ...req.body };

      // 1) NUNCA envie/salve senha vazia
      if ('password' in update && !update.password) delete update.password;

      // 2) Corrige boolean vindo como string
      if (typeof update.active === 'string') update.active = update.active === 'true';

      // 3) (Opcional) normaliza specialty se vier “humana”
      const mapSpec = {
        'terapeuta ocupacional': 'terapia_ocupacional',
        'fono': 'fonoaudiologia',
        'fonoaudiologia': 'fonoaudiologia',
        'psico': 'psicologia'
      };
      if (update.specialty) update.specialty = mapSpec[update.specialty] || update.specialty;

      const doctor = await Doctor.findByIdAndUpdate(req.params.id, update, {
        new: true,
        runValidators: true
      });

      if (!doctor) return sendApiError(res, new AppError('NOT_FOUND', 'Doctor not found', { status: 404 }), req);
      return res.json(doctor);
    } catch (error) {
      if (error.name === 'ValidationError') {
        const errors = Object.fromEntries(
          Object.entries(error.errors).map(([k, v]) => [k, v.message])
        );
        return sendApiError(
          res,
          new AppError('BAD_REQUEST', 'Falha na validação dos dados', {
            status: 400,
            extra: { errors },
          }),
          req
        );
      }
      return sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro interno', { status: 500 }), req);
    }
  },

  delete: async (req, res) => {
    try {
      const doctor = await Doctor.findByIdAndDelete(req.params.id);
      if (!doctor) return sendApiError(res, new AppError('NOT_FOUND', 'Doctor not found', { status: 404 }), req);
      res.json({ message: 'Doctor deleted successfully' });
    } catch (error) {
      if (error.name === 'ValidationError') {
        // 💡 Extrai erros campo a campo
        const errors = Object.keys(error.errors).reduce((acc, key) => {
          acc[key] = error.errors[key].message;
          return acc;
        }, {});

        return sendApiError(
          res,
          new AppError('BAD_REQUEST', 'Falha na validação dos dados', {
            status: 400,
            extra: { errors },
          }),
          req
        );
      }

      return sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro interno', { status: 500 }), req);
    }
  },

  // Soft delete - inativa o profissional ao invés de deletar
  deactivate: async (req, res) => {
    try {
      const doctor = await Doctor.findByIdAndUpdate(
        req.params.id,
        { active: false, deactivatedAt: new Date() },
        { new: true, runValidators: true }
      );
      
      if (!doctor) return sendApiError(res, new AppError('NOT_FOUND', 'Doctor not found', { status: 404 }), req);
      
      res.json({ 
        message: 'Profissional inativado com sucesso',
        doctor: {
          _id: doctor._id,
          fullName: doctor.fullName,
          active: doctor.active,
          deactivatedAt: doctor.deactivatedAt
        }
      });
    } catch (error) {
      console.error('Erro ao inativar profissional:', error);
      return sendApiError(
        res,
        new AppError('INTERNAL_ERROR', 'Erro interno ao inativar profissional', {
          status: 500,
        }),
        req
      );
    }
  },

  // Reativa um profissional inativado
  reactivate: async (req, res) => {
    try {
      const doctor = await Doctor.findByIdAndUpdate(
        req.params.id,
        { active: true, $unset: { deactivatedAt: 1 } },
        { new: true, runValidators: true }
      );
      
      if (!doctor) return sendApiError(res, new AppError('NOT_FOUND', 'Doctor not found', { status: 404 }), req);
      
      res.json({ 
        message: 'Profissional reativado com sucesso',
        doctor: {
          _id: doctor._id,
          fullName: doctor.fullName,
          active: doctor.active
        }
      });
    } catch (error) {
      console.error('Erro ao reativar profissional:', error);
      return sendApiError(
        res,
        new AppError('INTERNAL_ERROR', 'Erro interno ao reativar profissional', {
          status: 500,
        }),
        req
      );
    }
  },

  // Lista apenas profissionais ativos
  getActive: async (req, res) => {
    try {
      const doctors = await Doctor.find({ active: true }).select('-password').lean();
      res.status(200).json(doctors);
    } catch (error) {
      sendApiError(
        res,
        new AppError('INTERNAL_ERROR', 'Erro ao listar médicos ativos.', {
          status: 500,
        }),
        req
      );
    }
  },

  // Lista apenas profissionais inativos
  getInactive: async (req, res) => {
    try {
      const doctors = await Doctor.find({ active: false }).select('-password').lean();
      res.status(200).json(doctors);
    } catch (error) {
      sendApiError(
        res,
        new AppError('INTERNAL_ERROR', 'Erro ao listar médicos inativos.', {
          status: 500,
        }),
        req
      );
    }
  }
};

// controllers/doctorController.js
export const getCalendarAppointments = async (req, res) => {
  try {
    const doctorId = resolveDoctorId(req);

    // Validar se o ID do médico é válido
    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'O ID do médico fornecido é inválido', {
          status: 400,
          legacyError: 'ID inválido',
        }),
        req
      );
    }

    const { start, end } = req.query;

    // Adicionar filtro de período se fornecido
    let startDate, endDate;
    if (start && end) {
      startDate = new Date(start);
      endDate = new Date(end);
      endDate.setHours(23, 59, 59, 999);
    } else {
      startDate = new Date();
      endDate = new Date();
      endDate.setMonth(endDate.getMonth() + 1);
    }
    
    console.log('[CALENDAR] Buscando de', startDate.toISOString(), 'até', endDate.toISOString());

    // Buscar agendamentos do período do profissional logado APENAS
    const appointments = await Appointment.find({
      date: { $gte: startDate, $lte: endDate },
      doctor: new mongoose.Types.ObjectId(doctorId)
    })
      .populate('patient', 'fullName phone email dateOfBirth gender')
      .populate('doctor', 'fullName specialty')
      .populate('payment', 'status amount paymentMethod')
      .sort({ date: 1, time: 1 })
      .lean();
    
    console.log('[CALENDAR] Agendamentos encontrados:', appointments.length);

    // Formatar para o FullCalendar - CORREÇÃO CRÍTICA AQUI
    const events = appointments.map(appt => {
      try {
        // Combinar data e hora
        // appt.date pode ser Date ou string
        let dateStr;
        if (appt.date instanceof Date) {
          dateStr = appt.date.toISOString().split('T')[0];
        } else if (typeof appt.date === 'string') {
          dateStr = appt.date.split('T')[0];
        } else {
          // Se for outro formato, tenta converter
          dateStr = new Date(appt.date).toISOString().split('T')[0];
        }
        
        const dateTimeString = `${dateStr}T${appt.time}`;
        const startDateTime = new Date(dateTimeString);

        // Verificar se a data é válida
        if (isNaN(startDateTime.getTime())) {
          console.warn('Invalid date/time:', dateTimeString, 'for appointment:', appt._id);
          return null;
        }

        const endDateTime = new Date(startDateTime);
        endDateTime.setMinutes(endDateTime.getMinutes() + (appt.duration || 40));

        return {
          id: appt._id.toString(),
          title: `${appt.patient?.fullName || 'Paciente'} - ${appt.specialty || 'Consulta'}`,
          start: startDateTime.toISOString(),
          end: endDateTime.toISOString(),
          extendedProps: {
            status: appt.operationalStatus,
            clinicalStatus: appt.clinicalStatus,
            operationalStatus: appt.operationalStatus,
            specialty: appt.specialty,
            reason: appt.notes || 'Consulta',
            patient: appt.patient || null,
            doctor: appt.doctor || null,
            time: appt.time,
            date: appt.date
          }
        };
      } catch (error) {
        console.error('Error processing appointment:', appt._id, error);
        return null;
      }
    }).filter(event => event !== null);

    res.json(events);
  } catch (error) {
    console.error('Erro ao buscar agendamentos para calendário:', error);
    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', 'Erro interno', {
        status: 500,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      }),
      req
    );
  }
};

export const getDoctorById = async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) return sendApiError(res, new AppError('NOT_FOUND', 'Doctor not found', { status: 404 }), req);
    res.json(doctor);
  } catch (error) {
    if (error.name === 'ValidationError') {
      // 💡 Extrai erros campo a campo
      const errors = Object.keys(error.errors).reduce((acc, key) => {
        acc[key] = error.errors[key].message;
        return acc;
      }, {});

      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'Falha na validação dos dados', {
          status: 400,
          extra: { errors },
        }),
        req
      );
    }

    return sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro interno', { status: 500 }), req);
  }
};

// Lista "Meus pacientes" do painel do terapeuta (somente leitura).
// pre_agendado conta como sessão futura (DOMAIN_INVARIANTS: entra em todo filtro ativo).
const PATIENT_LIST_CANCELED = ['canceled', 'force_cancelled'];
const PATIENT_LIST_OPEN = ['pre_agendado', 'scheduled', 'confirmed', 'pending'];
const INACTIVE_AFTER_DAYS = 60;

export const getDoctorPatients = async (req, res) => {
  try {
    const doctorId = resolveDoctorId(req);
    const { page = '1', limit = '50', search = '', care = '', sort = 'next', ids = '' } = req.query;

    if (!doctorId) {
      return sendApiError(res, new AppError('MISSING_ID', 'ID do médico não fornecido', { status: 400 }), req);
    }
    if (!mongoose.isValidObjectId(doctorId)) {
      return sendApiError(
        res,
        new AppError('INVALID_ID_FORMAT', 'Formato de ID inválido', {
          status: 400,
          extra: { receivedId: doctorId, expectedFormat: 'ObjectId hexadecimal de 24 caracteres' },
        }),
        req
      );
    }

    const doctorObjectId = new mongoose.Types.ObjectId(doctorId);
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));

    // Passo 1: appointments do médico (ignora cancelados) — base da lista e do status de atendimento
    const appointments = await Appointment.find({
      doctor: doctorObjectId,
      operationalStatus: { $nin: PATIENT_LIST_CANCELED }
    }).select('patient date time operationalStatus billingType insuranceProvider liminarContract').lean();

    const summaryEmpty = { total: 0, active: 0, no_next: 0, inactive: 0, birthday: 0 };
    if (!appointments.length) {
      return res.json({
        success: true,
        data: [],
        meta: { total: 0, page: pageNum, totalPages: 0, limit: limitNum, summary: summaryEmpty }
      });
    }

    // Passo 2: agrupar por paciente
    const byPatient = new Map();
    for (const a of appointments) {
      if (!a.patient) continue;
      const k = a.patient.toString();
      if (!byPatient.has(k)) byPatient.set(k, []);
      byPatient.get(k).push(a);
    }

    // Passo 3: dados do paciente (lista do terapeuta é pequena; filtro/ordenação/paginação em memória)
    const patientFilter = { _id: { $in: [...byPatient.keys()] } };
    if (search && search.trim()) {
      const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const digits = search.replace(/\D/g, '');
      patientFilter.$or = [
        { fullName: { $regex: term, $options: 'i' } },
        { legalGuardian: { $regex: term, $options: 'i' } },
        ...(digits.length >= 4 ? [{ phone: { $regex: digits.split('').join('\\D*') } }] : []),
      ];
    }
    const patients = await Patient.find(patientFilter)
      .select('fullName phone email imageAuthorization dateOfBirth healthPlan mainComplaint legalGuardian')
      .lean();

    // Passo 4: enriquecer com última/próxima sessão e status de atendimento
    // careStatus: active = tem sessão futura; no_next = atendido nos últimos 60 dias sem agendamento; inactive = resto
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const recentLimit = new Date(today); recentLimit.setDate(recentLimit.getDate() - INACTIVE_AFTER_DAYS);
    const month = today.getMonth();
    const byTime = (a, b) => new Date(a.date) - new Date(b.date) || String(a.time || '').localeCompare(String(b.time || ''));

    const enrichedAll = patients.map(p => {
      const appts = byPatient.get(p._id.toString()) || [];
      const future = appts.filter(a => new Date(a.date) >= today && PATIENT_LIST_OPEN.includes(a.operationalStatus)).sort(byTime);
      const past = appts.filter(a => new Date(a.date) < today).sort((a, b) => byTime(b, a));
      const ref = future[0] || past[0] || null; // forma de cobrança vigente: a da próxima sessão, senão a da última
      const last = past[0] || null;
      const careStatus = future.length ? 'active' : (last && new Date(last.date) >= recentLimit ? 'no_next' : 'inactive');
      const birthdayThisMonth = !!p.dateOfBirth && new Date(p.dateOfBirth).getUTCMonth() === month;
      return {
        ...p,
        nextAppointment: future[0] || null,
        lastAppointment: last?.date || null,
        completedSessions: appts.filter(a => a.operationalStatus === 'completed').length,
        billingType: ref?.billingType || null,
        insuranceProvider: ref?.insuranceProvider || p.healthPlan?.name || null,
        hasLiminar: appts.some(a => a.liminarContract),
        careStatus,
        birthdayThisMonth,
      };
    });

    const summary = {
      total: enrichedAll.length,
      active: enrichedAll.filter(p => p.careStatus === 'active').length,
      no_next: enrichedAll.filter(p => p.careStatus === 'no_next').length,
      inactive: enrichedAll.filter(p => p.careStatus === 'inactive').length,
      birthday: enrichedAll.filter(p => p.birthdayThisMonth).length,
    };

    // Passo 5: filtro rápido, ordenação e paginação
    const idList = ids ? String(ids).split(',').filter(Boolean) : null;
    let list = enrichedAll;
    if (care === 'birthday') list = list.filter(p => p.birthdayThisMonth);
    else if (['active', 'no_next', 'inactive'].includes(care)) list = list.filter(p => p.careStatus === care);
    if (idList) list = list.filter(p => idList.includes(p._id.toString()));

    if (sort === 'name') list.sort((a, b) => a.fullName.localeCompare(b.fullName, 'pt-BR'));
    else if (sort === 'last') list.sort((a, b) => new Date(b.lastAppointment || 0) - new Date(a.lastAppointment || 0));
    else {
      // padrão: quem tem próxima sessão primeiro (mais cedo antes); depois os sem agendamento, mais recentes antes
      const nextKey = p => (p.nextAppointment ? new Date(p.nextAppointment.date).getTime() : Infinity);
      list.sort((a, b) => (nextKey(a) - nextKey(b))
        || String(a.nextAppointment?.time || '').localeCompare(String(b.nextAppointment?.time || ''))
        || (new Date(b.lastAppointment || 0) - new Date(a.lastAppointment || 0)));
    }

    const total = list.length;
    const skip = (pageNum - 1) * limitNum;
    const enriched = list.slice(skip, skip + limitNum);

    // Só da página atual (até 20): tem anamnese? pacote ativo deste profissional (ex.: 7/12)?
    try {
      const pageIds = enriched.map(p => p._id).filter(Boolean);
      if (pageIds.length) {
        const [withAnamnesis, pkgs] = await Promise.all([
          AnamnesisReport.distinct('patientId', { patientId: { $in: pageIds } }),
          Package.find({ patient: { $in: pageIds }, doctor: new ObjectId(doctorId), status: { $in: ['active', 'in-progress'] } })
            .select('patient totalSessions sessionsDone createdAt').sort({ createdAt: -1 }).lean(),
        ]);
        const hasAnamnesis = new Set(withAnamnesis.map(String));
        const pkgByPatient = new Map();
        for (const pk of pkgs) if (!pkgByPatient.has(String(pk.patient))) pkgByPatient.set(String(pk.patient), pk);
        for (const p of enriched) {
          p.hasAnamnesis = hasAnamnesis.has(String(p._id));
          const pk = pkgByPatient.get(String(p._id));
          if (pk) p.activePackage = { totalSessions: pk.totalSessions, sessionsDone: pk.sessionsDone || 0 };
        }
      }
    } catch (sigErr) {
      console.warn('[getDoctorPatients] anamnese/pacote indisponíveis:', sigErr.message);
    }

    return res.json({
      success: true,
      data: enriched,
      meta: {
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum),
        limit: limitNum,
        summary
      }
    });

  } catch (error) {
    console.error('Erro no getDoctorPatients:', error);
    return sendApiError(
      res,
      new AppError('SERVER_ERROR', 'Erro interno no servidor', {
        status: 500,
        legacyError: error.message,
      }),
      req
    );
  }
};

export const getTodaysAppointments = async (req, res) => {
  try {
    const doctorId = resolveDoctorId(req);
    
    // Criar range para o dia de HOJE (início e fim do dia)
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);

    console.log('[GET_TODAYS_APPOINTMENTS] doctorId:', doctorId);
    console.log('[GET_TODAYS_APPOINTMENTS] range:', startOfDay, 'até', endOfDay);

    // Apenas agendamentos do profissional logado
    const filter = {
      date: { $gte: startOfDay, $lte: endOfDay },
      doctor: new ObjectId(doctorId)
    };

    // Campos extras (telefone, cobrança, jornada) alimentam a linha da agenda do painel
    // do terapeuta: WhatsApp do responsável, convênio/particular, Liminar, Novo paciente.
    const appointments = await Appointment.find(filter)
      .populate('patient', 'fullName phone dateOfBirth')
      .populate('payment', 'status')
      // Sinais da linha da agenda (só leitura): "última sessão do pacote", "guia vence em N dias".
      .populate('package', 'totalSessions sessionsDone status')
      .populate('insuranceGuide', 'expiresAt totalSessions usedSessions status')
      .select('_id date time duration operationalStatus clinicalStatus patient payment billingType insuranceProvider serviceType sessionType specialty patientJourneyType liminarContract package insuranceGuide reason')
      .sort({ time: 1 })
      .lean();

    // Sinal "faltou na última": status da sessão anterior de cada paciente com este profissional.
    try {
      const patientIds = [...new Set(appointments.map(a => a.patient?._id).filter(Boolean).map(String))];
      if (patientIds.length) {
        const last = await Appointment.aggregate([
          { $match: { doctor: new ObjectId(doctorId), patient: { $in: patientIds.map(id => new ObjectId(id)) }, date: { $lt: startOfDay } } },
          { $sort: { date: -1, time: -1 } },
          { $group: { _id: '$patient', status: { $first: '$operationalStatus' }, date: { $first: '$date' } } },
        ]);
        const byPatient = new Map(last.map(l => [String(l._id), l]));
        for (const a of appointments) {
          const l = a.patient?._id && byPatient.get(String(a.patient._id));
          if (l) a.previousSession = { status: l.status, date: l.date };
        }
      }
    } catch (sigErr) {
      console.warn('[GET_TODAYS_APPOINTMENTS] sinais da sessão anterior indisponíveis:', sigErr.message);
    }

    console.log('[GET_TODAYS_APPOINTMENTS] encontrados:', appointments.length);

    res.status(200).json(appointments);
  } catch (error) {
    console.error('Erro ao buscar agendamentos de hoje:', error);
    sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro interno no servidor', { status: 500 }), req);
  }
};


// backend/controllers/doctorController.js
export const getDoctorTherapySessions = async (req, res) => {
  try {
    const doctor = new ObjectId(resolveDoctorId(req));
    const sessions = await TherapySession.find({ doctor: doctor })
      .populate('patient', 'fullName')
      .populate('appointment', 'date time')
      .sort({ date: -1 })
      .lean();

    res.status(200).json(sessions);
  } catch (error) {
    console.error('Erro ao buscar sessões de terapia:', error);
    sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro interno no servidor', { status: 500 }), req);
  }
};

export const getDoctorStats = async (req, res) => {
  try {
    const doctor = new ObjectId(resolveDoctorId(req));
    const today = new Date();
    const startOfToday = new Date(today.setHours(0, 0, 0, 0));
    const endOfToday = new Date(today.setHours(23, 59, 59, 999));

    const stats = await Appointment.aggregate([
      {
        $match: {
          doctor: doctor,
          date: { $gte: startOfToday, $lte: endOfToday }
        }
      },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          clinicalStatus: {
            $push: {
              status: "$clinicalStatus",
              count: 1
            }
          },
          operationalStatus: {
            $push: {
              status: "$operationalStatus",
              count: 1
            }
          }
        }
      },
      {
        $project: {
          _id: 0,
          total: 1,
          clinicalStatus: {
            $arrayToObject: {
              $map: {
                input: "$clinicalStatus",
                as: "cs",
                in: {
                  k: "$$cs.status",
                  v: "$$cs.count"
                }
              }
            }
          },
          operationalStatus: {
            $arrayToObject: {
              $map: {
                input: "$operationalStatus",
                as: "os",
                in: {
                  k: "$$os.status",
                  v: "$$os.count"
                }
              }
            }
          }
        }
      }
    ]);

    const result = stats[0] || {
      total: 0,
      clinicalStatus: {},
      operationalStatus: {}
    };

    // Stats mensais
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    // Comparecimento = concluídos ÷ atendimentos previstos ATÉ AGORA no mês (exclui futuros,
    // cancelados e suspensos). Antes o divisor incluía o mês inteiro, então no começo do mês
    // ou com sessões futuras o índice despencava (ex.: 0% com 10 consultas agendadas).
    const CANCELED_LIKE = ['canceled', 'force_cancelled', 'suspended'];
    const [monthlyStats, activePatients] = await Promise.all([
      Appointment.aggregate([
        { $match: { doctor, date: { $gte: startOfMonth, $lte: endOfMonth } } },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$operationalStatus', 'completed'] }, 1, 0] } },
          missed: { $sum: { $cond: [{ $eq: ['$operationalStatus', 'missed'] }, 1, 0] } },
          canceled: { $sum: { $cond: [{ $in: ['$operationalStatus', CANCELED_LIKE] }, 1, 0] } },
          expectedSoFar: { $sum: { $cond: [{ $and: [
            { $lte: ['$date', now] },
            { $not: [{ $in: ['$operationalStatus', CANCELED_LIKE] }] }
          ] }, 1, 0] } }
        }}
      ]),
      Appointment.distinct('patient', { doctor, date: { $gte: startOfMonth, $lte: endOfMonth } })
    ]);

    const monthly = monthlyStats[0] || { total: 0, completed: 0, missed: 0, canceled: 0, expectedSoFar: 0 };

    const formattedResult = {
      today: result.total,
      monthlyAppointments: monthly.total,
      monthlyCompleted: monthly.completed,
      monthlyMissed: monthly.missed,
      monthlyCanceled: monthly.canceled,
      monthlyExpectedSoFar: monthly.expectedSoFar,
      activePatients: activePatients.length,
      // null = sem atendimentos previstos até agora (o front mostra "—", não 0%)
      attendanceRate: monthly.expectedSoFar > 0 ? Math.round((monthly.completed / monthly.expectedSoFar) * 100) : null,
      clinical: {
        pending: result.clinicalStatus.pending || 0,
        inProgress: result.clinicalStatus.in_progress || 0,
        completed: result.clinicalStatus.completed || 0,
        noShow: result.clinicalStatus.missed || 0
      },
      operational: {
        scheduled: result.operationalStatus.scheduled || 0,
        confirmed: result.operationalStatus.confirmed || 0,
        canceled: result.operationalStatus.canceled || 0,
        paid: result.operationalStatus.paid || 0
      }
    };

    res.status(200).json(formattedResult);
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro interno no servidor', { status: 500 }), req);
  }
};

export const getFutureAppointments = async (req, res) => {
  try {
    if (!req.user) {
      return sendApiError(res, new AppError('UNAUTHORIZED', 'Não autenticado', { status: 401 }), req);
    }

    const doctorId = resolveDoctorId(req);
    const now = new Date();
    
    console.log('[GET_FUTURE_APPOINTMENTS] doctorId:', doctorId);

    // Buscar agendamentos futuros do médico logado APENAS
    const matchStage = {
      date: { $gt: now },
      doctor: new ObjectId(doctorId)
    };

    const appointments = await Appointment.aggregate([
      {
        $match: matchStage
      },
      {
        $lookup: {
          from: 'patients',
          localField: 'patient',
          foreignField: '_id',
          as: 'patient'
        }
      },
      {
        $unwind: {
          path: '$patient',
          preserveNullAndEmptyArrays: true
        }
      },
      // Pacote (só contagem de sessões) para "Renovações à vista" no painel do terapeuta.
      {
        $lookup: {
          from: 'packages',
          localField: 'package',
          foreignField: '_id',
          as: 'package'
        }
      },
      {
        $project: {
          _id: 1,
          date: 1,
          time: 1,
          status: 1,
          clinicalStatus: 1,
          operationalStatus: 1,
          package: {
            $cond: {
              if: { $gt: [{ $size: '$package' }, 0] },
              then: {
                _id: { $arrayElemAt: ['$package._id', 0] },
                totalSessions: { $arrayElemAt: ['$package.totalSessions', 0] },
                sessionsDone: { $arrayElemAt: ['$package.sessionsDone', 0] },
                status: { $arrayElemAt: ['$package.status', 0] },
              },
              else: null
            }
          },
          patient: {
            $cond: {
              if: { $eq: ["$patient", null] },
              then: null,
              else: {
                doctor: "$patient.doctor",
                fullName: "$patient.fullName",
                _id: "$patient._id",
                phone: "$patient.phone",
                email: "$patient.email",
                dateOfBirth: "$patient.dateOfBirth",
                gender: "$patient.gender",
                address: "$patient.address",
                healthPlan: "$patient.healthPlan",
                clinicalHistory: "$patient.clinicalHistory",
                medications: "$patient.medications",
                allergies: "$patient.allergies",
                familyHistory: "$patient.familyHistory",
                imageAuthorization: "$patient.imageAuthorization",
                emergencyContact: "$patient.emergencyContact"
              }
            }
          }
        }
      },
      {
        $sort: { date: 1 }
      }
    ]);

    res.json(appointments);
  } catch (error) {
    console.error('Erro ao buscar agendamentos futuros:', error);

    if (error.name === 'CastError') {
      return sendApiError(res, new AppError('BAD_REQUEST', 'ID do médico inválido', { status: 400 }), req);
    }

    sendApiError(
      res,
      new AppError('INTERNAL_ERROR', 'Erro interno no servidor', {
        status: 500,
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      }),
      req
    );
  }
};

// GET /api/doctors/:id/attendance-summary?range=month|last_month|30d|90d|6m
// Frequência por paciente na janela pedida, lida dos AGENDAMENTOS (mesma base e mesma conta do
// /doctors/appointments/stats do Dashboard). Antes lia a coleção Session pelo createdAt, sempre no
// mês atual, e contava falta como "cancelado com falta confirmada" — o DOMAIN_INVARIANTS define
// falta = operationalStatus 'missed'. Campos antigos mantidos (patient, total, attended, missed,
// canceled, pending, frequency, lastSession); novos: expected, nextAppointment, cancelRequester.
const ATTENDANCE_RANGES = ['month', 'last_month', '7d', '30d', '90d', '6m'];
const ATTENDANCE_CANCELED = ['canceled', 'force_cancelled', 'suspended'];
const ATTENDANCE_OPEN = ['pre_agendado', 'scheduled', 'confirmed', 'pending'];

export function attendanceWindows(range = 'month', now = new Date()) {
  const r = ATTENDANCE_RANGES.includes(range) ? range : 'month';
  const y = now.getFullYear(), m = now.getMonth();
  if (r === 'month') {
    const start = new Date(y, m, 1);
    const prevStart = new Date(y, m - 1, 1);
    // mesmo trecho do mês anterior (1 → hoje), para comparar parecido com parecido
    const prevEnd = new Date(Math.min(new Date(y, m - 1, now.getDate(), 23, 59, 59, 999), new Date(y, m, 0, 23, 59, 59, 999)));
    return { range: r, start, end: now, prevStart, prevEnd };
  }
  if (r === 'last_month') {
    return {
      range: r,
      start: new Date(y, m - 1, 1), end: new Date(y, m, 0, 23, 59, 59, 999),
      prevStart: new Date(y, m - 2, 1), prevEnd: new Date(y, m - 1, 0, 23, 59, 59, 999),
    };
  }
  const days = { '7d': 7, '30d': 30, '90d': 90, '6m': 182 }[r];
  const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - (days - 1));
  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - days);
  return { range: r, start, end: now, prevStart, prevEnd };
}

function emptyTotals() {
  return { total: 0, attended: 0, missed: 0, canceled: 0, pending: 0, expected: 0,
    canceledBy: { patient: 0, professional: 0, clinic: 0, unknown: 0 } };
}

function addToTotals(t, a, now) {
  const st = a.operationalStatus;
  t.total++;
  if (st === 'completed') t.attended++;
  else if (st === 'missed') t.missed++;
  else if (ATTENDANCE_CANCELED.includes(st)) {
    t.canceled++;
    const who = ['patient', 'professional', 'clinic'].includes(a.cancelRequester) ? a.cancelRequester : 'unknown';
    t.canceledBy[who]++;
  } else if (ATTENDANCE_OPEN.includes(st)) t.pending++;
  if (new Date(a.date) <= now && !ATTENDANCE_CANCELED.includes(st)) t.expected++;
}

const rate = (t) => (t.expected > 0 ? Math.round((t.attended / t.expected) * 100) : null);

export const getAtendencePatient = async (req, res) => {
  try {
    const doctorId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ success: false, message: 'Profissional inválido.' });
    }
    const doctor = new mongoose.Types.ObjectId(doctorId);
    const now = new Date();
    const w = attendanceWindows(req.query.range, now);

    const fields = 'patient date time operationalStatus cancelRequester';
    const [inWindow, inPrev] = await Promise.all([
      Appointment.find({ doctor, patient: { $ne: null }, date: { $gte: w.start, $lte: w.end } }).select(fields).lean(),
      Appointment.find({ doctor, patient: { $ne: null }, date: { $gte: w.prevStart, $lte: w.prevEnd } }).select('date operationalStatus cancelRequester').lean(),
    ]);

    const summary = emptyTotals();
    const previous = emptyTotals();
    inPrev.forEach(a => addToTotals(previous, a, now));

    const byPatient = new Map();
    for (const a of inWindow) {
      addToTotals(summary, a, now);
      const k = a.patient.toString();
      if (!byPatient.has(k)) byPatient.set(k, emptyTotals());
      addToTotals(byPatient.get(k), a, now);
    }
    const ids = [...byPatient.keys()].map(id => new mongoose.Types.ObjectId(id));

    // Última sessão realizada e próxima sessão em aberto, fora da janela (o que importa para agir)
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const [patients, lastDone, nextOpen] = ids.length ? await Promise.all([
      Patient.find({ _id: { $in: ids } }).select('fullName phone legalGuardian').lean(),
      Appointment.aggregate([
        { $match: { doctor, patient: { $in: ids }, operationalStatus: 'completed', date: { $lte: now } } },
        { $group: { _id: '$patient', date: { $max: '$date' } } },
      ]),
      Appointment.aggregate([
        { $match: { doctor, patient: { $in: ids }, operationalStatus: { $in: ATTENDANCE_OPEN }, date: { $gte: today } } },
        { $sort: { date: 1, time: 1 } },
        { $group: { _id: '$patient', date: { $first: '$date' }, time: { $first: '$time' } } },
      ]),
    ]) : [[], [], []];

    const patientById = new Map(patients.map(p => [p._id.toString(), p]));
    const lastById = new Map(lastDone.map(x => [x._id.toString(), x.date]));
    const nextById = new Map(nextOpen.map(x => [x._id.toString(), { date: x.date, time: x.time || null }]));

    const data = [...byPatient.entries()]
      .filter(([id]) => patientById.has(id))
      .map(([id, t]) => {
        const p = patientById.get(id);
        return {
          patient: { _id: p._id, fullName: p.fullName, phone: p.phone || null, legalGuardian: p.legalGuardian || null },
          total: t.total,
          attended: t.attended,
          missed: t.missed,
          canceled: t.canceled,
          pending: t.pending,
          expected: t.expected,
          frequency: rate(t),
          lastSession: lastById.get(id) || null,
          nextAppointment: nextById.get(id) || null,
        };
      });

    res.json({
      success: true,
      data,
      meta: {
        range: w.range,
        start: w.start, end: w.end, prevStart: w.prevStart, prevEnd: w.prevEnd,
        summary: { ...summary, attendanceRate: rate(summary), patients: data.length },
        previous: { ...previous, attendanceRate: rate(previous) },
      },
    });
  } catch (err) {
    console.error('❌ Erro ao gerar resumo de frequência:', err);
    res
      .status(500)
      .json({ success: false, message: 'Erro ao gerar resumo de frequência.' });
  }
};

