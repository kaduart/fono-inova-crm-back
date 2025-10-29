import express from 'express';
import { auth } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';


const router = express.Router();

router.post('/add', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Você não está autorizado a adicionar paciente!'
      });
    }

    const {
      fullName,
      dateOfBirth,
      birthCertificate,
      gender,
      maritalStatus,
      profession,
      placeOfBirth,
      address,
      phone,
      email,
      cpf,
      rg,
      specialties,
      mainComplaint,
      clinicalHistory,
      medications,
      allergies,
      familyHistory,
      healthPlan,
      legalGuardian,
      emergencyContact,
      imageAuthorization,
    } = req.body;

    // 🔹 Campos obrigatórios para o pré-cadastro
    if (!fullName || !dateOfBirth) {
      return res.status(400).json({
        success: false,
        message: 'Nome completo e data de nascimento são obrigatórios para o cadastro inicial.'
      });
    }

    // 🔹 Normaliza strings (remove espaços extras e ajusta caixa)
    const normalizedName = fullName.trim().toLowerCase();
    const normalizedDate = new Date(dateOfBirth).toISOString().split('T')[0]; // só yyyy-mm-dd

    // 🔹 Monta array de filtros únicos
    const query = [];
    if (email && email.trim() !== '') query.push({ email });
    if (cpf && cpf.trim() !== '') query.push({ cpf });
    if (rg && rg.trim() !== '') query.push({ rg });

    // 🔹 Busca duplicado por CPF/RG/email (campos únicos)
    let existing = null;
    if (query.length > 0) {
      existing = await Patient.findOne({ $or: query });
    }

    // 🔹 Se não achou por documento, tenta achar por nome + data
    let sameNameAndBirth = null;
    if (!existing) {
      sameNameAndBirth = await Patient.findOne({
        fullName: { $regex: new RegExp(`^${normalizedName}$`, 'i') },
        dateOfBirth: new Date(normalizedDate),
      });
    }

    // 🔹 Se achou duplicado
    if (existing || sameNameAndBirth) {
      const duplicated = existing || sameNameAndBirth;

      let duplicatedBy = 'dados semelhantes';
      if (existing) {
        if (cpf && duplicated.cpf === cpf) duplicatedBy = 'CPF';
        else if (rg && duplicated.rg === rg) duplicatedBy = 'RG';
        else if (email && duplicated.email === email) duplicatedBy = 'Email';
      } else {
        duplicatedBy = 'Nome e Data de Nascimento';
      }

      return res.status(409).json({
        success: false,
        message: `Já existe um paciente cadastrado com o mesmo ${duplicatedBy}.`,
        existingId: duplicated._id,
        existingName: duplicated.fullName,
        existingDateOfBirth: duplicated.dateOfBirth,
      });
    }

    // 🔹 Cria novo paciente
    const patient = new Patient({
      fullName,
      dateOfBirth,
      birthCertificate,
      gender,
      maritalStatus,
      profession,
      placeOfBirth,
      address,
      phone,
      email,
      cpf,
      rg,
      specialties,
      mainComplaint,
      clinicalHistory,
      medications,
      allergies,
      familyHistory,
      healthPlan,
      legalGuardian,
      emergencyContact,
      imageAuthorization,
    });

    await patient.save();

    return res.status(201).json({
      success: true,
      message: 'Paciente adicionado com sucesso!',
      data: patient,
    });
  } catch (error) {
    console.error('Erro ao adicionar paciente:', error);

    if (error.code === 11000) {
      const duplicatedField = Object.keys(error.keyValue || {})[0];
      return res.status(400).json({
        success: false,
        message: `Valor duplicado encontrado${duplicatedField ? ` no campo ${duplicatedField}` : ''}.`
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Erro interno ao adicionar paciente.',
      error: error.message,
    });
  }
});

// Obter paciente por ID
router.get('/:id', validateId, auth, async (req, res) => {
  console.log(`Buscando paciente com ID: ${req.params.id}`);
  try {
    const patient = await Patient.findById(req.params.id);
    console.log('Paciente encontrado:', patient);
    if (!patient) return res.status(404).json({ error: 'Paciente não encontrado' });
    res.json(patient);
  } catch (err) {
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

// Atualizar paciente por ID
router.put('/:id', validateId, auth, async (req, res) => {
  try {
    const patient = await Patient.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!patient) return res.status(404).json({ error: 'Paciente não encontrado' });
    res.json(patient);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// List all patients
router.get('/', auth, async (req, res) => {
  try {
    // Configurações de população
    const basePopulate = [
      {
        path: 'packages',
        populate: [
          { path: 'doctor', select: 'fullName specialty' },
          { path: 'patient', select: 'fullName' },
          { path: 'sessions', select: 'date status' }
        ]
      },
      { path: 'doctor', select: 'fullName specialty' },
      {
        path: 'lastAppointment',
        populate: [
          { path: 'doctor', select: 'fullName specialty' },
          { path: 'payment', select: 'status amount paymentMethod' }
        ]
      },
      {
        path: 'nextAppointment',
        populate: [
          { path: 'doctor', select: 'fullName specialty' },
          { path: 'payment', select: 'status amount paymentMethod' }
        ]
      }
    ];

    // População de agendamentos com pacotes
    const appointmentsPopulate = {
      path: 'appointments',
      options: { sort: { date: 1 } },
      populate: [
        { path: 'doctor', select: 'fullName specialty' },
        {
          path: 'payment',
          select: 'status amount paymentMethod',
          populate: {
            path: 'package',
            select: 'sessionType sessionsPerWeek durationMonths totalSessions',
            populate: {
              path: 'sessions',
              select: 'date status'
            }
          }
        },
        {
          path: 'package',  // Nova população direta de pacotes
          select: 'sessionType sessionsPerWeek durationMonths totalSessions sessionsDone',
          populate: {
            path: 'sessions',
            select: 'date status'
          }
        }
      ]
    };

    let patients;

    try {
      // Consulta principal
      patients = await Patient.find()
        .populate(basePopulate)
        .populate(appointmentsPopulate)
        .sort({ fullName: 1 })  // Ordenação segura no banco
        .lean();  // Usar lean para melhor performance

    } catch (error) {
      console.error('Erro na consulta principal:', error);

      // Fallback simplificado
      patients = await Patient.find()
        .populate(basePopulate)
        .populate({
          path: 'appointments',
          populate: [
            { path: 'doctor', select: 'fullName specialty' },
            {
              path: 'package',
              select: 'sessionType sessionsPerWeek durationMonths totalSessions',
              populate: {
                path: 'sessions',
                select: 'date status'
              }
            }
          ]
        })
        .lean();

      // Ordenação em memória
      patients.sort((a, b) =>
        a.fullName.localeCompare(b.fullName, 'pt', { sensitivity: 'base' })
      );
    }

    // Pós-processamento para garantir pacotes recentes
    patients = patients.map(patient => {
      // Coletar pacotes de múltiplas fontes
      const appointmentPackages = patient.appointments
        ?.filter(a => a.package)
        .map(a => a.package) || [];

      const directPackages = patient.packages || [];

      // Combinar e remover duplicatas
      const allPackages = [
        ...directPackages,
        ...appointmentPackages
      ].filter((pkg, index, self) =>
        index === self.findIndex(p => p._id.toString() === pkg._id.toString())
      );

      return {
        ...patient,
        packages: allPackages
      };
    });

    res.json(patients);
  } catch (err) {
    console.error('Erro ao buscar pacientes:', err);
    res.status(500).json({
      error: 'Erro no servidor',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Delete a patient
router.delete('/:id', validateId, auth, async (req, res) => {
  try {
    const deleted = await Patient.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Patient not found' });
    res.json({ message: 'Patient deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Retorna resumo das consultas (última e próxima)
router.get('/:id/appointments-summary', validateId, auth, async (req, res) => {
  try {
    const { id } = req.params;

    // Buscar o paciente e verificar se existe
    const patient = await Patient.findById(id);

    if (!patient) {
      return res.status(404).json({ message: 'Paciente não encontrado' });
    }

    // Buscar agendamentos do paciente com as referências populadas
    const appointments = await Appointment.find({ patient: id })
      .populate('patient')  // Popula os dados do paciente (se necessário)
      .populate('doctor')   // Popula os dados do médico (se necessário)
      .sort({ date: 1 });

    const now = new Date();

    // Filtrar as consultas passadas e futuras
    const pastAppointments = appointments.filter(a => new Date(a.date) < now);
    const futureAppointments = appointments.filter(a => new Date(a.date) >= now);

    // Obter o último agendamento passado e o próximo futuro
    const lastAppointment = pastAppointments.at(-1) || null;
    const nextAppointment = futureAppointments.at(0) || null;
    // Responder com as informações do último e próximo agendamento
    res.json({ lastAppointment, nextAppointment });

  } catch (err) {
    console.error('[ERRO] Detalhes do erro:', err);
    res.status(500).json({ message: 'Erro ao buscar consultas', error: err.message });
  }
});


// Substituir o uso de Session por TherapyPackage
router.get('/patients/:patientId/sessions', auth, async (req, res) => {
  try {
    const packages = await Package.find({ patient: req.params.patientId });

    const allSessions = packages.flatMap(pkg =>
      pkg.sessions.map(session => ({
        ...session.toObject(),
        packageId: pkg._id
      }))
    ).sort((a, b) => new Date(b.date) - new Date(a.date)); // Ordena por data desc

    res.json(allSessions);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar sessões do paciente' });
  }
});



export default router;
