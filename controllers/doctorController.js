// controllers/doctorController.js
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';
import Doctor from '../models/Doctor.js';
import Patient from '../models/Patient.js';
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
      const requiredFields = ['fullName', 'email', 'password', 'specialty', 'licenseNumber', 'phoneNumber'];
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
        const doctors = await Doctor.find().select('-password').lean();
        res.status(200).json(doctors);
      } catch (error) {
        res.status(500).json({ error: 'Erro ao listar médicos.' });
      }
    }
  },

  update: async (req, res) => {
    try {

      const doctor = await Doctor.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true
      });

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
  }
};

// controllers/doctorController.js
export const getCalendarAppointments = async (req, res) => {
  try {
    const doctorId = req.user.id;
    console.log('Doctor ID from token:', doctorId);

    // Validar se o ID do médico é válido
    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({
        error: 'ID inválido',
        message: 'O ID do médico fornecido é inválido'
      });
    }

    const { start, end } = req.query;
    const filter = { 
      doctor: new mongoose.Types.ObjectId(doctorId),
      status: { $ne: 'cancelado' } // Excluir agendamentos cancelados
    };

    // Adicionar filtro de período se fornecido
    if (start && end) {
      filter.date = {
        $gte: new Date(start).toISOString().split('T')[0], // Converter para formato YYYY-MM-DD
        $lte: new Date(end).toISOString().split('T')[0]
      };
    } else {
      // Buscar agendamentos futuros
      const today = new Date().toISOString().split('T')[0];
      filter.date = { $gte: today };
    }

    console.log('Filter being applied:', JSON.stringify(filter, null, 2));

    // Buscar agendamentos
    const appointments = await Appointment.find(filter)
      .populate('patient', 'fullName phone email dateOfBirth gender')
      .populate('doctor', 'fullName specialty')
      .sort({ date: 1, time: 1 })
      .lean();

    console.log(`Found ${appointments.length} appointments`);

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

    console.log(`Generated ${events.length} calendar events`);
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
    const doctorId = req.user.id;

    // Verificação detalhada do ID
    if (!doctorId) {
      return res.status(400).json({
        code: 'MISSING_ID',
        message: 'ID do médico não fornecido'
      });
    }

    const isValid = mongoose.isValidObjectId(doctorId);

    if (!isValid) {
      return res.status(400).json({
        code: 'INVALID_ID_FORMAT',
        message: 'Formato de ID inválido',
        receivedId: doctorId,
        expectedFormat: 'ObjectId hexadecimal de 24 caracteres'
      });
    }

    // Tentar consulta de duas formas diferentes
    const patientsAsString = await Patient.find({ doctor: doctorId });
    const patientsAsObjectId = await Patient.find({
      doctor: new mongoose.Types.ObjectId(doctorId)
    });

    // Verificar qual formato funciona
    const patients = patientsAsObjectId.length > 0
      ? patientsAsObjectId
      : patientsAsString;

    if (patients.length === 0) {
      return res.status(404).json({
        code: 'NO_PATIENTS_FOUND',
        message: 'Nenhum paciente encontrado para este médico',
        doctorId
      });
    }

    res.json(patients);

  } catch (error) {

    // Tratamento específico para erros de cast
    if (error.name === 'CastError') {
      console.error('Detalhes do CastError:', error.message);
      return res.status(400).json({
        code: 'CAST_ERROR',
        message: 'Erro de conversão de tipo',
        path: error.path,
        value: error.value
      });
    }

    res.status(500).json({
      code: 'SERVER_ERROR',
      message: 'Erro interno no servidor',
      error: error.message
    });
  }
};

export const getTodaysAppointments = async (req, res) => {
  try {
    const doctor = req.user.id;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const appointments = await Appointment.find({
      date: {
        $gte: todayStart,
        $lte: todayEnd
      }
    })
      .populate('patientId', 'fullName')
      .select('_id date time status patientId')
      .lean();

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
    const formattedResult = {
      today: result.total,
      clinical: {
        pending: result.clinicalStatus.pendente || 0,
        inProgress: result.clinicalStatus.em_andamento || 0,
        completed: result.clinicalStatus.concluído || 0,
        noShow: result.clinicalStatus.faltou || 0
      },
      operational: {
        scheduled: result.operationalStatus.agendado || 0,
        confirmed: result.operationalStatus.confirmado || 0,
        cancelled: result.operationalStatus.cancelado || 0,
        paid: result.operationalStatus.pago || 0
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