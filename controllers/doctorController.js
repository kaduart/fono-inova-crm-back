// controllers/doctorController.js
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';
import Patient from '../models/Patient.js';
import Session from '../models/Session.js';
import TherapySession from '../models/TherapySession.js';
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
        return res.status(400).json({
          message: 'Campos obrigatórios faltando',
          missingFields
        });
      }

      // Verificação de existência em paralelo
      const [existingEmail, existingLicense] = await Promise.all([
        Doctor.findOne({ email }),
        Doctor.findOne({ licenseNumber })
      ]);

      if (existingEmail) {
        return res.status(409).json({
          error: 'Email já cadastrado',
          message: 'Já existe um médico com este e-mail'
        });
      }

      if (existingLicense) {
        return res.status(409).json({
          error: 'Registro profissional já cadastrado',
          message: 'Já existe um médico com este número de registro'
        });
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

        return res.status(400).json({
          message: 'Falha na validação dos dados',
          errors
        });
      }

      if (error.code === 11000) {
        const field = Object.keys(error.keyPattern)[0];
        return res.status(409).json({
          error: 'Dado duplicado',
          message: `Já existe um médico com este ${field === 'email' ? 'e-mail' : 'número de registro'}`
        });
      }

      res.status(500).json({
        error: 'Erro interno',
        details: error.message // Apenas para desenvolvimento
      });
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
        res.status(500).json({ error: 'Erro ao listar médicos.' });
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

      if (!doctor) return res.status(404).json({ message: 'Doctor not found' });
      return res.json(doctor);
    } catch (error) {
      if (error.name === 'ValidationError') {
        const errors = Object.fromEntries(
          Object.entries(error.errors).map(([k, v]) => [k, v.message])
        );
        return res.status(400).json({ message: 'Falha na validação dos dados', errors });
      }
      return res.status(500).json({ error: 'Erro interno' });
    }
  },

  delete: async (req, res) => {
    try {
      const doctor = await Doctor.findByIdAndDelete(req.params.id);
      if (!doctor) return res.status(404).json({ message: 'Doctor not found' });
      res.json({ message: 'Doctor deleted successfully' });
    } catch (error) {
      if (error.name === 'ValidationError') {
        // 💡 Extrai erros campo a campo
        const errors = Object.keys(error.errors).reduce((acc, key) => {
          acc[key] = error.errors[key].message;
          return acc;
        }, {});

        return res.status(400).json({
          message: 'Falha na validação dos dados',
          errors
        });
      }

      return res.status(500).json({ error: 'Erro interno' });
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
      
      if (!doctor) return res.status(404).json({ message: 'Doctor not found' });
      
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
      return res.status(500).json({ error: 'Erro interno ao inativar profissional' });
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
      
      if (!doctor) return res.status(404).json({ message: 'Doctor not found' });
      
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
      return res.status(500).json({ error: 'Erro interno ao reativar profissional' });
    }
  },

  // Lista apenas profissionais ativos
  getActive: async (req, res) => {
    try {
      const doctors = await Doctor.find({ active: true }).select('-password').lean();
      res.status(200).json(doctors);
    } catch (error) {
      res.status(500).json({ error: 'Erro ao listar médicos ativos.' });
    }
  },

  // Lista apenas profissionais inativos
  getInactive: async (req, res) => {
    try {
      const doctors = await Doctor.find({ active: false }).select('-password').lean();
      res.status(200).json(doctors);
    } catch (error) {
      res.status(500).json({ error: 'Erro ao listar médicos inativos.' });
    }
  }
};

// controllers/doctorController.js
export const getCalendarAppointments = async (req, res) => {
  try {
    const doctorId = req.user.id;

    // Validar se o ID do médico é válido
    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({
        error: 'ID inválido',
        message: 'O ID do médico fornecido é inválido'
      });
    }

    const { start, end } = req.query;
    const filter = {
      doctor: new mongoose.Types.ObjectId(doctorId)
    };

    // Adicionar filtro de período se fornecido
    if (start && end) {
      filter.date = {
        $gte: new Date(start).toISOString().split('T')[0], // Converter para formato YYYY-MM-DD
        $lte: new Date(end).toISOString().split('T')[0]
      };
    }

    // Buscar agendamentos
    const appointments = await Appointment.find(filter)
      .populate('patient', 'fullName phone email dateOfBirth gender')
      .populate('doctor', 'fullName specialty')
      .sort({ date: 1, time: 1 })
      .lean();

    // Formatar para o FullCalendar - CORREÇÃO CRÍTICA AQUI
    const events = appointments.map(appt => {
      try {
        // Combinar data (string YYYY-MM-DD) e hora (string HH:MM)
        const dateTimeString = `${appt.date}T${appt.time}`;
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
    res.status(500).json({
      error: 'Erro interno',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

export const getDoctorById = async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) return res.status(404).json({ message: 'Doctor not found' });
    res.json(doctor);
  } catch (error) {
    if (error.name === 'ValidationError') {
      // 💡 Extrai erros campo a campo
      const errors = Object.keys(error.errors).reduce((acc, key) => {
        acc[key] = error.errors[key].message;
        return acc;
      }, {});

      return res.status(400).json({
        message: 'Falha na validação dos dados',
        errors
      });
    }

    return res.status(500).json({ error: 'Erro interno' });
  }
};

export const getDoctorPatients = async (req, res) => {
  try {
    const doctorId = req.user?.id;

    if (!doctorId) {
      return res.status(400).json({ code: 'MISSING_ID', message: 'ID do médico não fornecido' });
    }
    if (!mongoose.isValidObjectId(doctorId)) {
      return res.status(400).json({
        code: 'INVALID_ID_FORMAT',
        message: 'Formato de ID inválido',
        receivedId: doctorId,
        expectedFormat: 'ObjectId hexadecimal de 24 caracteres'
      });
    }

    const doctorObjectId = new mongoose.Types.ObjectId(doctorId);

    // Passo 1: buscar os appointments do médico (ignora cancelados)
    const appointments = await Appointment.find({
      doctor: doctorObjectId,
      operationalStatus: { $ne: 'canceled' }
    }).select('patient date time operationalStatus').lean();

    if (!appointments.length) {
      return res.json([]);
    }

    // Passo 2: pegar IDs únicos dos pacientes
    const patientIds = [...new Set(appointments
      .filter(a => a.patient)  // Filtra appointments sem paciente
      .map(a => a.patient.toString()))];

    // Passo 3: buscar os pacientes
    const patients = await Patient.find({ _id: { $in: patientIds } })
      .select('fullName phone email imageAuthorization')
      .lean();

    // Passo 4: enriquecer pacientes com last/next appointment
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
        lastAppointment: past[0] || null
      };
    });

    return res.json(enriched);

  } catch (error) {
    console.error('Erro no getDoctorPatients:', error);
    return res.status(500).json({
      code: 'SERVER_ERROR',
      message: 'Erro interno no servidor',
      error: error.message
    });
  }
};

export const getTodaysAppointments = async (req, res) => {
  try {
    // ⚠️ garante que isso é MESMO o ObjectId do Doctor
    const doctorId = req.user.doctorId || req.user._id || req.user.id;

    // monta 'YYYY-MM-DD' igual está salvo no banco
    const todayStr = new Date().toISOString().slice(0, 10);
    // ex: '2025-11-22'

    console.log('[GET_TODAYS_APPOINTMENTS] doctorId:', doctorId);
    console.log('[GET_TODAYS_APPOINTMENTS] todayStr:', todayStr);

    const filter = {
      date: todayStr,
    };

    // se você quiser filtrar por médico:
    if (doctorId) {
      filter.doctor = doctorId;
    }

    const appointments = await Appointment.find(filter)
      .populate('patient', 'fullName') // no schema é 'patient'
      .select('_id date time operationalStatus clinicalStatus patient')
      .lean();

    console.log('[GET_TODAYS_APPOINTMENTS] encontrados:', appointments.length);

    res.status(200).json(appointments);
  } catch (error) {
    console.error('Erro ao buscar agendamentos de hoje:', error);
    res.status(500).json({ error: 'Erro interno no servidor' });
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
    res.status(500).json({ error: 'Erro interno no servidor' });
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

    // Formatar para frontend
    // 🔹 Formatar para frontend (versão atualizada com status em inglês)
    const formattedResult = {
      today: result.total,
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
    res.status(500).json({ error: 'Erro interno no servidor' });
  }
};

export const getFutureAppointments = async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Não autenticado' });
    }

    const doctor = new ObjectId(req.user.id);
    const now = new Date();

    // Pipeline corrigida
    const appointments = await Appointment.aggregate([
      {
        $match: {
          doctor: doctor,
          date: { $gt: now }
        }
      },
      {
        $lookup: {
          from: 'patients',
          localField: 'patientId',
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
      return res.status(400).json({ error: 'ID do médico inválido' });
    }

    res.status(500).json({
      error: 'Erro interno no servidor',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
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

/**
 * @route   GET /api/doctors/:doctorId/financial-report
 * @desc    Relatório completo: receita x despesa de um profissional
 * @query   ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * @access  Private (admin/próprio médico)
 */
export const getDoctorFinancialReport = async (req, res) => {
  try {
    const { doctorId } = req.params;
    let { startDate, endDate } = req.query;

    // Validar datas
    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'startDate e endDate são obrigatórios'
      });
    }
    
    // 🆕 CORREÇÃO: Converte strings para Date objects após migração
    startDate = new Date(startDate + 'T00:00:00-03:00');
    endDate = new Date(endDate + 'T23:59:59-03:00');

    // Buscar doctor
    const doctor = await Doctor.findById(doctorId).select('fullName specialty').lean();
    if (!doctor) {
      return res.status(404).json({ success: false, message: 'Profissional não encontrado' });
    }

    // Queries paralelas
    const [payments, expenses] = await Promise.all([
      // Receitas do profissional
      Payment.find({
        doctor: doctorId,
        status: 'paid',
        paymentDate: { $gte: startDate, $lte: endDate }
      })
        .populate('patient', 'fullName')
        .populate('appointment', 'date time')
        .select('amount paymentDate serviceType paymentMethod')
        .lean(),

      // Despesas do profissional
      mongoose.model('Expense').find({
        relatedDoctor: doctorId,
        status: 'paid',
        date: { $gte: startDate, $lte: endDate }
      })
        .select('amount date category subcategory')
        .lean()
    ]);

    // Cálculos
    const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);
    const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0);
    const profitMargin = totalRevenue - totalExpenses;
    const marginPercentage = totalRevenue > 0
      ? ((profitMargin / totalRevenue) * 100).toFixed(2)
      : 0;

    const sessionsCount = payments.length;
    const avgRevenuePerSession = sessionsCount > 0
      ? (totalRevenue / sessionsCount).toFixed(2)
      : 0;

    // Agrupamento de despesas por categoria
    const expensesByCategory = expenses.reduce((acc, e) => {
      const cat = e.category || 'other';
      if (!acc[cat]) acc[cat] = { amount: 0, count: 0 };
      acc[cat].amount += e.amount;
      acc[cat].count += 1;
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        doctor: {
          _id: doctor._id,
          fullName: doctor.fullName,
          specialty: doctor.specialty
        },
        period: { startDate, endDate },
        revenue: {
          total: totalRevenue,
          sessions: payments.map(p => ({
            date: p.paymentDate,
            patient: p.patient?.fullName || 'N/A',
            amount: p.amount,
            serviceType: p.serviceType,
            paymentMethod: p.paymentMethod
          }))
        },
        expenses: {
          total: totalExpenses,
          byCategory: expensesByCategory,
          breakdown: expenses.map(e => ({
            date: e.date,
            description: e.description,
            category: e.category,
            subcategory: e.subcategory,
            amount: e.amount
          }))
        },
        profitMargin,
        marginPercentage: `${marginPercentage}%`,
        sessionsCount,
        avgRevenuePerSession: Number(avgRevenuePerSession)
      }
    });

  } catch (error) {
    console.error('Erro ao gerar relatório financeiro:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao gerar relatório',
      error: error.message
    });
  }
};
