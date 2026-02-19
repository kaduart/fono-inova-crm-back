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
router.get('/', flexibleAuth, async (req, res) => {
  try {
    const { search } = req.query;
    const limit = parseInt(req.query.limit) || (search ? 100 : 50);
    const skip = parseInt(req.query.skip) || 0;

    console.log(`[PATIENTS LIST] Search: "${search}", Limit: ${limit}`);

    let query = {};
    
    // 🔹 Filtro de busca (nome, CPF ou telefone)
    if (search && search.trim()) {
      const searchTerm = search.trim();
      const searchNumber = searchTerm.replace(/\D/g, '');
      
      // Normaliza removendo acentos para busca accent-insensitive
      const normalizedTerm = searchTerm.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      
      // Cria regex que casa com ou sem acento (ex: "theo" casa com "théo", "thêo", etc)
      const accentChars = {
        'a': '[aàáâãäå]', 'e': '[eèéêë]', 'i': '[iìíîï]', 
        'o': '[oòóôõö]', 'u': '[uùúûü]', 'c': '[cç]',
        'A': '[AÀÁÂÃÄÅ]', 'E': '[EÈÉÊË]', 'I': '[IÌÍÎÏ]', 
        'O': '[OÒÓÔÕÖ]', 'U': '[UÙÚÛÜ]', 'C': '[CÇ]'
      };
      
      let regexPattern = normalizedTerm.split('').map(char => {
        return accentChars[char] || accentChars[char.toLowerCase()] || char;
      }).join('');
      
      const searchRegex = new RegExp(regexPattern, 'i');
      
      const orConditions = [{ fullName: searchRegex }];
      
      // Só busca CPF/telefone se o termo tiver números
      if (searchNumber) {
        orConditions.push({ cpf: { $regex: searchNumber } });
        orConditions.push({ phone: { $regex: searchNumber } });
      }
      
      query = { $or: orConditions };
      
      console.log(`[PATIENTS LIST] Search: "${searchTerm}", Regex: "${regexPattern}"`);
    }

    // 🔹 Busca otimizada
    const patients = await Patient.find(query)
      .select('_id fullName cpf phone email dateOfBirth address healthPlan')
      .sort({ fullName: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    console.log(`[PATIENTS LIST] Encontrados: ${patients.length} pacientes`);
    
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
    const currentMonth = String(today.getMonth() + 1).padStart(2, '0');
    
    console.log(`[ANIVERSARIANTES] Buscando mês: ${currentMonth}`);
    
    // Busca todos os pacientes
    const allPatients = await Patient.find({
      dateOfBirth: { $exists: true, $ne: null, $ne: '' }
    }).select('fullName dateOfBirth phone email').lean();
    
    console.log(`[ANIVERSARIANTES] Total pacientes com dateOfBirth: ${allPatients.length}`);
    
    // Filtra os que fazem aniversário no mês atual
    const aniversariantes = allPatients.filter(p => {
      if (!p.dateOfBirth) return false;
      const dateStr = String(p.dateOfBirth);
      // Tenta extrair mês de diferentes formatos
      let birthMonth = '';
      if (dateStr.includes('-')) {
        // Formato: 1990-05-15 ou 05-15-1990
        const parts = dateStr.split('-');
        if (parts[0].length === 4) {
          birthMonth = parts[1]; // YYYY-MM-DD
        } else {
          birthMonth = parts[0]; // MM-DD-YYYY
        }
      } else if (dateStr.includes('/')) {
        const parts = dateStr.split('/');
        if (parts[2].length === 4) {
          birthMonth = parts[1]; // DD/MM/YYYY
        }
      }
      return birthMonth === currentMonth;
    });
    
    console.log(`[ANIVERSARIANTES] Encontrados: ${aniversariantes.length}`);
    
    res.json({ success: true, data: aniversariantes });
  } catch (err) {
    console.error('[ANIVERSARIANTES] Erro:', err);
    res.status(500).json({ error: 'Erro ao buscar aniversariantes', details: err.message });
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

// Obter resumo de agendamentos do paciente
router.get('/:id/appointments-summary', validateId, auth, async (req, res) => {
  try {
    const patientId = req.params.id;
    
    // Busca agendamentos do paciente
    const appointments = await Appointment.find({ patient: patientId })
      .populate('doctor', 'fullName specialty')
      .sort({ date: -1 });
    
    res.json({ success: true, data: appointments });
  } catch (err) {
    console.error('[APPOINTMENTS SUMMARY] Erro:', err);
    res.status(500).json({ error: 'Erro ao buscar agendamentos' });
  }
});

// Obter sessões do paciente
router.get('/patients/:patientId/sessions', auth, async (req, res) => {
  try {
    const { patientId } = req.params;
    
    // Busca pacotes/sessões do paciente
    const packages = await Package.find({ patient: patientId })
      .populate('sessions')
      .populate('doctor', 'fullName specialty');
    
    res.json({ success: true, data: packages });
  } catch (err) {
    console.error('[SESSIONS] Erro:', err);
    res.status(500).json({ error: 'Erro ao buscar sessões' });
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
