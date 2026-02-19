import express from 'express';
import { auth } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import Appointment from '../models/Appointment.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';

const router = express.Router();

// Add new patient
router.post('/add', flexibleAuth, async (req, res) => {
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
      gender,
      phone,
      email,
      address,
      healthPlan,
      cpf,
      responsible
    } = req.body;

    if (!fullName || !dateOfBirth) {
      return res.status(400).json({
        success: false,
        message: 'Nome completo e data de nascimento são obrigatórios!'
      });
    }

    // Check for duplicate
    const normalizedName = fullName.trim().toLowerCase();
    let existing = null;
    
    const query = [{ fullName: { $regex: new RegExp(`^${normalizedName}$`, 'i') } }];
    if (cpf) query.push({ cpf });
    if (phone) query.push({ phone: phone.replace(/\D/g, '') });
    
    if (query.length > 0) {
      existing = await Patient.findOne({ $or: query });
    }

    if (existing) {
      return res.status(409).json({
        success: false,
        message: 'Paciente já existe no sistema!',
        existingName: existing.fullName,
        existingId: existing._id
      });
    }

    const newPatient = new Patient({
      fullName: fullName.trim(),
      dateOfBirth,
      gender,
      phone: phone ? phone.replace(/\D/g, '') : undefined,
      email,
      address,
      healthPlan,
      cpf,
      responsible
    });

    await newPatient.save();

    return res.status(201).json({
      success: true,
      message: 'Paciente adicionado com sucesso!',
      patient: newPatient
    });
  } catch (err) {
    console.error('Erro ao adicionar paciente:', err);
    return res.status(500).json({
      success: false,
      message: 'Erro ao adicionar paciente',
      error: err.message
    });
  }
});

// 🔥 List all patients - OTIMIZADO
router.get('/', auth, async (req, res) => {
  try {
    const { search } = req.query;
    const limit = parseInt(req.query.limit) || (search ? 100 : 50);
    const skip = parseInt(req.query.skip) || 0;

    let query = {};
    
    // 🔹 Filtro de busca (nome, CPF ou telefone)
    if (search) {
      const searchRegex = new RegExp(search, 'i');
      const searchNumber = search.replace(/\D/g, '');
      
      query = {
        $or: [
          { fullName: searchRegex },
          { cpf: searchRegex },
          ...(searchNumber ? [{ phone: { $regex: searchNumber } }] : [])
        ]
      };
    }

    // 🔹 Busca otimizada
    const patients = await Patient.find(query)
      .select('_id fullName cpf phone email dateOfBirth address healthPlan')
      .sort({ fullName: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json(patients);
  } catch (err) {
    console.error('[PATIENTS LIST] Erro:', err);
    res.status(500).json({ error: 'Erro ao buscar pacientes', details: err.message });
  }
});

// Obter aniversariantes do mês
router.get('/aniversariantes', auth, async (req, res) => {
  try {
    const today = new Date();
    const currentMonth = today.getMonth() + 1;
    
    const patients = await Patient.find({
      $expr: {
        $eq: [{ $month: '$dateOfBirth' }, currentMonth]
      }
    }).select('fullName dateOfBirth phone email').sort({ dateOfBirth: 1 });
    
    res.json({ success: true, data: patients });
  } catch (err) {
    console.error('[ANIVERSARIANTES] Erro:', err);
    res.status(500).json({ error: 'Erro ao buscar aniversariantes' });
  }
});

// Obter paciente por ID
router.get('/:id', validateId, auth, async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
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

// Delete a patient
router.delete('/:id', validateId, auth, async (req, res) => {
  try {
    const deleted = await Patient.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Patient not found' });
    res.json({ message: 'Patient deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
