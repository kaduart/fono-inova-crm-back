import express from 'express';
import { auth } from '../middleware/auth.js';
import validateId from '../middleware/validateId.js';
import Appointment from '../models/Appointment.js';
import { mapAppointmentDTO } from '../utils/appointmentDto.js';
import Package from '../models/Package.js';
import Patient from '../models/Patient.js';
import PatientBalance from '../models/PatientBalance.js';
import Session from '../models/Session.js';
import { flexibleAuth } from '../middleware/amandaAuth.js';
import PatientsView from '../models/PatientsView.js';

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

    // Duplicata apenas por CPF (telefone/email/nome NÃO são únicos: mãe com vários filhos, homônimos)
    let existing = null;
    if (cpf) {
      existing = await Patient.findOne({ cpf });
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
      data: newPatient,
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
    const appointments = await Appointment.find({ patient: patientId, operationalStatus: { $ne: 'pre_agendado' }, appointmentId: { $exists: false } })
      .populate('doctor', 'fullName specialty')
      .sort({ date: -1 });
    
    res.json({ success: true, data: appointments.map(mapAppointmentDTO) });
  } catch (err) {
    console.error('[APPOINTMENTS SUMMARY] Erro:', err);
    res.status(500).json({ error: 'Erro ao buscar agendamentos' });
  }
});

// Obter sessões do paciente
// Busca sessões avulsas pendentes (sem pacote) — para absorção ao criar pacote
router.get('/:patientId/sessions/pending', auth, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { specialty } = req.query;

    console.log(`[SESSIONS PENDING] Buscando sessões para patientId: ${patientId}, specialty: ${specialty}`);

    const filter = {
      patient: patientId,
      paymentStatus: { $in: ['pending', 'unpaid', 'pending_balance'] },
      status: { $in: ['completed', 'missed'] }
    };

    if (specialty) {
      // Normaliza: remove underscores, espaços extras, lowercase
      // 'terapia_ocupacional' → 'terapia ocupacional'
      // 'Fonoaudiologia' → 'fonoaudiologia'
      const normalized = specialty.toString().toLowerCase().trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
      filter.sessionType = normalized;
      console.log(`[SESSIONS PENDING] Filtro exato - sessionType: ${normalized}`);
    } else {
      console.log(`[SESSIONS PENDING] Nenhuma especialidade informada`);
    }

    console.log(`[SESSIONS PENDING] Query filter:`, JSON.stringify(filter, null, 2));

    const sessions = await Session.find(filter)
      .populate('doctor', 'fullName')
      .sort({ date: -1 })
      .lean();

    console.log(`[SESSIONS PENDING] Total de sessões encontradas: ${sessions.length}`);
    console.log(`[SESSIONS PENDING] Sessões:`, sessions.map(s => ({ 
      _id: s._id, 
      date: s.date, 
      sessionType: s.sessionType 
    })));

    const data = sessions.map(s => ({
      _id: s._id,
      date: s.date,
      time: s.time,
      sessionValue: s.sessionValue,
      specialty: s.sessionType, // sessionType é o campo correto no modelo
      doctorName: s.doctor?.fullName || null
    }));

    res.json({ success: true, data });
  } catch (err) {
    console.error('[SESSIONS PENDING] Erro:', err);
    res.status(500).json({ error: 'Erro ao buscar sessões pendentes' });
  }
});

// 🔍 DEBUG: Verificar origem do débito
router.get('/:patientId/debug-debito', auth, async (req, res) => {
  try {
    const { patientId } = req.params;
    
    console.log(`[DEBUG DEBITO] Analisando paciente: ${patientId}`);
    
    // 1. Todas sessões pendentes (sem filtro de especialidade)
    const allPendingSessions = await Session.find({
      patient: patientId,
      paymentStatus: { $in: ['pending', 'unpaid', 'pending_balance'] },
      status: { $in: ['completed', 'missed'] }
    }).lean();
    
    console.log(`[DEBUG DEBITO] Total sessões pendentes: ${allPendingSessions.length}`);
    
    // Agrupar por sessionType
    const porTipo = {};
    let totalValor = 0;
    allPendingSessions.forEach(s => {
      const tipo = s.sessionType || 'SEM_TIPO';
      if (!porTipo[tipo]) porTipo[tipo] = { count: 0, valor: 0, ids: [] };
      porTipo[tipo].count++;
      porTipo[tipo].valor += (s.sessionValue || 0);
      porTipo[tipo].ids.push(s._id.toString().slice(-6));
      totalValor += (s.sessionValue || 0);
    });
    
    console.log(`[DEBUG DEBITO] Por tipo:`, porTipo);
    
    // 2. Verificar appointments completed sem pagamento
    const appointments = await Appointment.find({
      patient: patientId,
      operationalStatus: 'completed',
      $or: [
        { isPaid: false },
        { paymentStatus: { $in: ['pending', 'unpaid'] } }
      ]
    }).select('date specialty isPaid paymentStatus sessionValue').lean();
    
    console.log(`[DEBUG DEBITO] Appointments completed não pagos: ${appointments.length}`);
    
    // 3. Sessões SEM sessionType
    const semTipo = allPendingSessions.filter(s => !s.sessionType);
    
    res.json({
      success: true,
      debug: {
        patientId,
        totalSessoesPendentes: allPendingSessions.length,
        totalValorPendente: totalValor,
        porTipo,
        appointmentsNaoPagos: appointments.length,
        appointmentsDetalhes: appointments.slice(0, 5),
        sessoesSemTipo: semTipo.length,
        sessoesSemTipoDetalhes: semTipo.slice(0, 5).map(s => ({
          _id: s._id,
          date: s.date,
          paymentStatus: s.paymentStatus,
          sessionValue: s.sessionValue
        }))
      }
    });
  } catch (err) {
    console.error('[DEBUG DEBITO] Erro:', err);
    res.status(500).json({ error: 'Erro ao debugar débito' });
  }
});

// 🆕 NOVO ENDPOINT: Débitos do balance por especialidade (FONTE CORRETA)
router.get('/:patientId/balance/details', auth, async (req, res) => {
  try {
    const { patientId } = req.params;
    const { specialty } = req.query;

    console.log(`[BALANCE DETAILS] Buscando débitos para patientId: ${patientId}, specialty: ${specialty || 'TODAS'}`);

    // Busca o balance do paciente
    const balance = await PatientBalance.findOne({ patient: patientId });

    if (!balance) {
      console.log(`[BALANCE DETAILS] Nenhum balance encontrado`);
      return res.json({ success: true, data: [] });
    }

    // Filtra apenas transações de débito NÃO quitados
    let transactions = balance.transactions.filter(t => 
      t.type === 'debit' && 
      !t.isDeleted &&
      !t.isPaid &&  // só mostra débitos não pagos
      !t.settledByPackageId  // 🆕 não mostra débitos já quitados por pacote
    );

    console.log(`[BALANCE DETAILS] Total débitos não pagos: ${transactions.length}`);

    // Se informou especialidade, filtra
    if (specialty) {
      const normalizedSpecialty = specialty.toString().toLowerCase().trim().replace(/_/g, ' ').replace(/\s+/g, ' ');
      transactions = transactions.filter(t => t.specialty === normalizedSpecialty);
      console.log(`[BALANCE DETAILS] Após filtro "${normalizedSpecialty}": ${transactions.length}`);
    }

    // Formata resposta
    const data = transactions.map(t => ({
      _id: t._id,
      amount: t.amount,
      specialty: t.specialty,
      description: t.description,
      appointmentId: t.appointmentId,
      sessionId: t.sessionId,
      transactionDate: t.transactionDate,
      paidAmount: t.paidAmount || 0,
      isPaid: t.isPaid || false
    }));

    console.log(`[BALANCE DETAILS] Retornando ${data.length} débitos`);

    res.json({ 
      success: true, 
      data,
      summary: {
        totalAmount: data.reduce((sum, t) => sum + t.amount, 0),
        count: data.length
      }
    });

  } catch (err) {
    console.error('[BALANCE DETAILS] Erro:', err);
    res.status(500).json({ error: 'Erro ao buscar débitos' });
  }
});

router.get('/:patientId/sessions', auth, async (req, res) => {
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
    await PatientsView.findOneAndDelete({ patientId: deleted._id });
    res.json({ message: 'Patient deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
