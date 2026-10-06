// controllers/doctorController.js
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';
import Patient from '../models/Patient.js';
import Session from '../models/Session.js';
import TherapySession from '../models/TherapySession.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';
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
    const doctorId = req.user.id;

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

export const getDoctorPatients = async (req, res) => {
  try {
    const doctorId = req.user?.id;
    const { page = '1', limit = '50', search = '' } = req.query;

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

    // Passo 1: buscar os appointments do médico (ignora cancelados)
    const appointments = await Appointment.find({
      doctor: doctorObjectId,
      operationalStatus: { $ne: 'canceled' }
    }).select('patient date time operationalStatus').lean();

    if (!appointments.length) {
      return res.json({
        success: true,
        data: [],
        meta: { total: 0, page: pageNum, totalPages: 0, limit: limitNum }
      });
    }

    // Passo 2: pegar IDs únicos dos pacientes
    const patientIds = [...new Set(appointments
      .filter(a => a.patient)
      .map(a => a.patient.toString()))];

    // Passo 3: construir filtro de pacientes
    const patientFilter = { _id: { $in: patientIds } };
    if (search && search.trim()) {
      patientFilter.fullName = { $regex: search.trim(), $options: 'i' };
    }

    // Passo 4: buscar os pacientes (com paginação)
    const skip = (pageNum - 1) * limitNum;
    const [patients, total] = await Promise.all([
      Patient.find(patientFilter)
        .select('fullName phone email imageAuthorization')
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Patient.countDocuments(patientFilter)
    ]);

    // Passo 5: enriquecer pacientes com last/next appointment
    const today = new Date(); today.setHours(0, 0, 0, 0);

    const enriched = patients.map(p => {
      const apptsThisPatient = appointments.filter(a => a.patient && a.patient.toString() === p._id.toString());

      const future = apptsThisPatient.filter(a => new Date(a.date) >= today)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      const past = apptsThisPatient.filter(a => new Date(a.date) < today)
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      return {
        ...p,
        nextAppointment: future[0] || null,
        lastAppointment: past[0]?.date || null
      };
    });

    return res.json({
      success: true,
      data: enriched,
      meta: {
        total,
        page: pageNum,
        totalPages: Math.ceil(total / limitNum),
        limit: limitNum
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
    const doctorId = req.user.doctorId || req.user._id || req.user.id;
    
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

    const appointments = await Appointment.find(filter)
      .populate('patient', 'fullName')
      .populate('payment', 'status')
      .select('_id date time operationalStatus clinicalStatus patient payment')
      .lean();

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
    const doctor = new ObjectId(req.user.id);
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
    const doctor = new ObjectId(req.user.id);
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

    const [monthlyStats, activePatients] = await Promise.all([
      Appointment.aggregate([
        { $match: { doctor, date: { $gte: startOfMonth, $lte: endOfMonth } } },
        { $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $eq: ['$operationalStatus', 'completed'] }, 1, 0] } }
        }}
      ]),
      Appointment.distinct('patient', { doctor, date: { $gte: startOfMonth, $lte: endOfMonth } })
    ]);

    const monthly = monthlyStats[0] || { total: 0, completed: 0 };

    const formattedResult = {
      today: result.total,
      monthlyAppointments: monthly.total,
      monthlyCompleted: monthly.completed,
      activePatients: activePatients.length,
      attendanceRate: monthly.total > 0 ? Math.round((monthly.completed / monthly.total) * 100) : 0,
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

    const doctorId = req.user.id;
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
      {
        $project: {
          _id: 1,
          date: 1,
          time: 1,
          status: 1,
          clinicalStatus: 1,
          operationalStatus: 1,
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

// GET /api/doctors/:id/attendance-summary
export const getAtendencePatient = async (req, res) => {
  try {
    const doctorId = req.params.id;

    const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    const endOfMonth = new Date();

    // Busca todas as sessões do doutor com paciente populado
    const sessions = await Session.find({
      doctor: doctorId,
      createdAt: { $gte: startOfMonth, $lte: endOfMonth }
    })
      .populate('patient', 'fullName')
      .sort({ date: -1 });


    const summary = {};

    for (const s of sessions) {
      const pid = s.patient?._id?.toString();
      if (!pid) continue;

      if (!summary[pid]) {
        summary[pid] = {
          patient: s.patient,
          total: 0,
          attended: 0,   // compareceu
          missed: 0,     // faltou
          canceled: 0,   // cancelou sem falta
          pending: 0,    // pendente/agendado
          lastSession: s.date,
        };
      }

      summary[pid].total++;

      switch (s.status) {
        case 'completed':
          summary[pid].attended++;
          break;

        case 'canceled':
          if (s.confirmedAbsence === true) {
            summary[pid].missed++;
          } else {
            summary[pid].canceled++;
          }
          break;

        case 'pending':
        case 'scheduled':
          summary[pid].pending++;
          break;
      }

      if (new Date(s.date) > new Date(summary[pid].lastSession)) {
        summary[pid].lastSession = s.date;
      }
    }

    // Calcula frequência por paciente
    const result = Object.values(summary).map((s) => ({
      ...s,
      frequency: s.total > 0 ? Math.round((s.attended / s.total) * 100) : 0,
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('❌ Erro ao gerar resumo de frequência:', err);
    res
      .status(500)
      .json({ success: false, message: 'Erro ao gerar resumo de frequência.' });
  }
};

