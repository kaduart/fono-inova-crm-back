// routes/patients/duplicates.js
// Endpoints para gerenciamento de duplicados

import express from 'express';
import { auth, authorize } from '../../middleware/auth.js';
import Patient from '../../models/Patient.js';

const router = express.Router();

/**
 * Normaliza string para comparação
 */
function normalizar(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * @route   GET /api/patients/check-duplicate
 * @desc    Verifica se existe paciente similar antes de cadastrar
 * @query   fullName, dateOfBirth, cpf, email, phone
 * @access  Admin/Secretary
 */
router.get('/check-duplicate', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { fullName, dateOfBirth, cpf, email, phone } = req.query;

    if (!fullName || !dateOfBirth) {
      return res.status(400).json({
        success: false,
        message: 'Nome e data de nascimento são obrigatórios'
      });
    }

    const queries = [];

    // Busca por CPF
    if (cpf) {
      queries.push({ cpf: cpf.replace(/\D/g, '') });
    }

    // Busca por email
    if (email) {
      queries.push({ email: email.toLowerCase().trim() });
    }

    // Busca por nome + data
    const nomeNorm = normalizar(fullName);
    queries.push({
      fullName: { $regex: new RegExp(`^${nomeNorm}$`, 'i') },
      dateOfBirth: new Date(dateOfBirth)
    });

    // Busca por telefone + data
    if (phone) {
      const telLimpo = phone.replace(/\D/g, '');
      if (telLimpo.length >= 8) {
        queries.push({
          phone: { $regex: telLimpo },
          dateOfBirth: new Date(dateOfBirth)
        });
      }
    }

    // Executa busca
    const possiveisDuplicados = await Patient.find({
      $or: queries
    }).select('fullName dateOfBirth cpf email phone createdAt').limit(10);

    // Filtra e pontua resultados
    const resultados = possiveisDuplicados.map(p => {
      let score = 0;
      const razoes = [];

      // Mesmo CPF = 100 pontos
      if (cpf && p.cpf && p.cpf.replace(/\D/g, '') === cpf.replace(/\D/g, '')) {
        score += 100;
        razoes.push('CPF idêntico');
      }

      // Mesmo email = 90 pontos
      if (email && p.email && p.email.toLowerCase() === email.toLowerCase().trim()) {
        score += 90;
        razoes.push('Email idêntico');
      }

      // Nome similar + mesma data = 80 pontos
      const nomePacienteNorm = normalizar(p.fullName);
      if (nomePacienteNorm === nomeNorm && 
          new Date(p.dateOfBirth).toISOString().split('T')[0] === dateOfBirth) {
        score += 80;
        razoes.push('Nome e data de nascimento idênticos');
      }

      // Nome similar = 40 pontos
      if (nomePacienteNorm === nomeNorm) {
        score += 40;
        razoes.push('Nome idêntico');
      }

      // Telefone similar = 30 pontos
      if (phone && p.phone && p.phone.replace(/\D/g, '').includes(phone.replace(/\D/g, ''))) {
        score += 30;
        razoes.push('Telefone similar');
      }

      return {
        ...p.toObject(),
        score,
        razoes
      };
    }).filter(p => p.score > 0).sort((a, b) => b.score - a.score);

    const isDuplicate = resultados.some(p => p.score >= 80);

    res.json({
      success: true,
      isDuplicate,
      possiveisDuplicados: resultados,
      total: resultados.length
    });

  } catch (error) {
    console.error('[CheckDuplicate] Erro:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao verificar duplicados'
    });
  }
});

/**
 * @route   GET /api/patients/duplicates/report
 * @desc    Relatório de todos os duplicados no sistema
 * @access  Admin only
 */
router.get('/duplicates/report', auth, authorize(['admin']), async (req, res) => {
  try {
    console.log('[DuplicatesReport] Gerando relatório...');

    const pacientes = await Patient.find({}).select('fullName dateOfBirth cpf email phone').lean();
    const grupos = new Map();

    // Agrupa por diferentes critérios
    for (const p of pacientes) {
      const chaves = [];
      
      // Por CPF
      if (p.cpf) chaves.push(`cpf:${p.cpf.replace(/\D/g, '')}`);
      
      // Por email
      if (p.email) chaves.push(`email:${p.email.toLowerCase().trim()}`);
      
      // Por nome + data
      const nomeNorm = normalizar(p.fullName);
      const dataStr = new Date(p.dateOfBirth).toISOString().split('T')[0];
      chaves.push(`nome_data:${nomeNorm}_${dataStr}`);

      for (const chave of chaves) {
        if (!grupos.has(chave)) grupos.set(chave, []);
        grupos.get(chave).push(p);
      }
    }

    // Filtra apenas duplicados
    const duplicados = [];
    const processados = new Set();

    for (const [chave, grupo] of grupos) {
      if (grupo.length > 1) {
        const ids = grupo.map(p => p._id.toString()).sort().join(',');
        if (!processados.has(ids)) {
          processados.add(ids);
          duplicados.push({
            criterio: chave,
            quantidade: grupo.length,
            pacientes: grupo.map(p => ({
              id: p._id,
              nome: p.fullName,
              cpf: p.cpf,
              email: p.email,
              telefone: p.phone
            }))
          });
        }
      }
    }

    // Ordena por quantidade (mais críticos primeiro)
    duplicados.sort((a, b) => b.quantidade - a.quantidade);

    res.json({
      success: true,
      totalGrupos: duplicados.length,
      totalPacientesAfetados: duplicados.reduce((sum, d) => sum + d.quantidade, 0),
      duplicados: duplicados.slice(0, 50) // Limita a 50 primeiros
    });

  } catch (error) {
    console.error('[DuplicatesReport] Erro:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao gerar relatório'
    });
  }
});

export default router;
