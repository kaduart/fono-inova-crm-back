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

      console.log('reqauisicaooooo', req.body)
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

// controllers/doctorController.js
// backend/controllers/doctorController.js
export const getDoctorPatients = async (req, res) => {
  try {
    const doctor = new ObjectId(req.user.id);

    const patients = await Patient.find({ doctor: doctor });
    const collectionPatients = await mongoose.connection.db.collection('patients').find({
      doctor: doctor
    }).toArray();

    const allPatients = await Patient.find();
    const otherDoctorId = new ObjectId(); // ID de outro médico
    const otherDoctorPatients = await Patient.find({ doctor: otherDoctorId });

    res.json(patients);
  } catch (error) {
    console.error('Erro ao buscar pacientes:', error);
    res.status(500).json({ error: 'Erro interno no servidor' });
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