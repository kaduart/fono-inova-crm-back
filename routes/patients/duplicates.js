// routes/patients/duplicates.js
// Endpoints para gerenciamento de duplicados.
//
// 03/11/2026: as duas rotas passaram a usar a trava única de utils/patientDuplicateCheck.js
// (mesma regra usada na criação de paciente em todos os fluxos). Antes:
//   - check-duplicate exigia data de nascimento e comparava nome com acento/caixa exatos
//     (pela regex) — "BENJAMIN MARCAL BALDEZ" x "Benjamin Marçal Baldez" não batia;
//   - o relatório quebrava com data de nascimento inválida (ex.: ano 20196) e não agrupava
//     só por nome.

import express from 'express';
import { auth, authorize } from '../../middleware/auth.js';
import Patient from '../../models/Patient.js';
import Appointment from '../../models/Appointment.js';
import mongoose from 'mongoose';
import { execute as mergePatientsCommand } from '../../domains/patient/commands/mergePatientsCommand.js';
import { sendApiError } from '../../errors/buildErrorResponse.js';
import { AppError } from '../../errors/AppError.js';
import {
  birthKey,
  findPossibleDuplicates,
  normalizeName,
  onlyDigits,
  toDuplicateCandidateDTO,
} from '../../utils/patientDuplicateCheck.js';

const router = express.Router();

/**
 * @route   GET /api/patients/check-duplicate
 * @desc    Verifica, enquanto o usuário digita, se já existe cadastro parecido.
 * @query   fullName (obrigatório, 3+ letras), dateOfBirth, phone, cpf, excludeId
 * @returns { success, isDuplicate, hasStrongMatch, possiveisDuplicados[], total }
 * @access  Admin/Secretary
 */
router.get('/check-duplicate', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { fullName, dateOfBirth, cpf, phone, excludeId } = req.query;

    if (!fullName || normalizeName(fullName).replace(/\s/g, '').length < 3) {
      return sendApiError(
        res,
        new AppError('BAD_REQUEST', 'Informe pelo menos 3 letras do nome', { status: 400 }),
        req
      );
    }

    const duplicates = await findPossibleDuplicates(
      Patient,
      { fullName, dateOfBirth, phone, cpf },
      { excludeId: excludeId || null, limit: 5 }
    );

    res.json({
      success: true,
      isDuplicate: duplicates.length > 0,
      hasStrongMatch: duplicates.some((d) => d.level === 'forte'),
      possiveisDuplicados: duplicates.map(toDuplicateCandidateDTO),
      total: duplicates.length,
    });
  } catch (error) {
    console.error('[CheckDuplicate] Erro:', error);
    sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro ao verificar duplicados', { status: 500 }), req);
  }
});

/**
 * @route   GET /api/patients/duplicates/report
 * @desc    Grupos de cadastros que provavelmente são a mesma pessoa.
 *          Critérios: mesmo nome (sem acento/caixa), mesmo CPF, ou marcados na criação
 *          (possibleDuplicateOf). Grupos em que o usuário já confirmou "é outra pessoa"
 *          vêm com confirmedDistinct=true (não somem — a decisão pode ser revista).
 * @access  Admin
 */
router.get('/duplicates/report', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const pacientes = await Patient.find({})
      .select('fullName dateOfBirth cpf email phone healthPlan source createdAt possibleDuplicateOf duplicateReview')
      .lean();

    // union-find: junta cadastros ligados por qualquer critério num grupo só
    const parent = new Map();
    const find = (x) => {
      while (parent.get(x) !== x) {
        parent.set(x, parent.get(parent.get(x)));
        x = parent.get(x);
      }
      return x;
    };
    const union = (a, b) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };
    const byId = new Map();
    const criteriosPorId = new Map();
    const addCriterio = (id, c) => {
      if (!criteriosPorId.has(id)) criteriosPorId.set(id, new Set());
      criteriosPorId.get(id).add(c);
    };

    const chaves = new Map();
    for (const p of pacientes) {
      const id = p._id.toString();
      byId.set(id, p);
      parent.set(id, id);
      const nome = normalizeName(p.fullName);
      if (nome) chaves.set(`nome:${nome}`, [...(chaves.get(`nome:${nome}`) || []), id]);
      const cpf = onlyDigits(p.cpf);
      if (cpf.length === 11) chaves.set(`cpf:${cpf}`, [...(chaves.get(`cpf:${cpf}`) || []), id]);
    }
    for (const [chave, ids] of chaves) {
      if (ids.length < 2) continue;
      const criterio = chave.startsWith('cpf:') ? 'mesmo CPF' : 'mesmo nome';
      for (const id of ids) {
        union(ids[0], id);
        addCriterio(id, criterio);
      }
    }
    for (const p of pacientes) {
      const id = p._id.toString();
      for (const other of p.possibleDuplicateOf || []) {
        const oid = other.toString();
        if (!byId.has(oid)) continue;
        union(id, oid);
        addCriterio(id, 'marcado na criação');
        addCriterio(oid, 'marcado na criação');
      }
    }

    const grupos = new Map();
    for (const id of byId.keys()) {
      const root = find(id);
      if (!grupos.has(root)) grupos.set(root, []);
      grupos.get(root).push(id);
    }
    const gruposDup = [...grupos.values()].filter((ids) => ids.length > 1);

    // quantidade de agendamentos ajuda a escolher o cadastro principal
    const todosIds = gruposDup.flat();
    const contagem = todosIds.length
      ? await Appointment.aggregate([
          { $match: { patient: { $in: todosIds.map((id) => byId.get(id)._id) } } },
          { $group: { _id: '$patient', n: { $sum: 1 } } },
        ])
      : [];
    const apptsPorId = new Map(contagem.map((c) => [c._id.toString(), c.n]));

    const duplicados = gruposDup.map((ids) => {
      const pessoas = ids.map((id) => {
        const p = byId.get(id);
        return {
          id,
          nome: p.fullName,
          nascimento: birthKey(p.dateOfBirth),
          cpf: p.cpf || null,
          email: p.email || null,
          telefone: p.phone || null,
          convenio: p.healthPlan?.name || null,
          origem: p.source || null,
          criadoEm: p.createdAt || null,
          agendamentos: apptsPorId.get(id) || 0,
          confirmadoOutraPessoa: !!p.duplicateReview?.confirmedDistinct,
        };
      });
      pessoas.sort((a, b) => b.agendamentos - a.agendamentos || new Date(a.criadoEm) - new Date(b.criadoEm));
      const criterios = [...new Set(ids.flatMap((id) => [...(criteriosPorId.get(id) || [])]))];
      return {
        criterios,
        quantidade: pessoas.length,
        confirmedDistinct: pessoas.slice(1).every((p) => p.confirmadoOutraPessoa),
        sugestaoPrincipal: pessoas[0].id,
        pacientes: pessoas,
      };
    });

    duplicados.sort((a, b) => Number(a.confirmedDistinct) - Number(b.confirmedDistinct) || b.quantidade - a.quantidade);

    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
    res.json({
      success: true,
      totalPacientes: pacientes.length,
      totalGrupos: duplicados.length,
      totalPendentes: duplicados.filter((d) => !d.confirmedDistinct).length,
      totalPacientesAfetados: duplicados.reduce((sum, d) => sum + d.quantidade, 0),
      duplicados: duplicados.slice(0, limit),
    });
  } catch (error) {
    console.error('[DuplicatesReport] Erro:', error);
    sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro ao gerar relatório', { status: 500 }), req);
  }
});

/**
 * @route   POST /api/patients/duplicates/confirm-distinct
 * @desc    "São pessoas diferentes": marca os cadastros para o relatório não insistir.
 * @body    { ids: string[] }  (2+ ids do mesmo grupo)
 * @access  Admin/Secretary
 */
router.post('/duplicates/confirm-distinct', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const ids = (req.body?.ids || []).filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (ids.length < 2) {
      return sendApiError(res, new AppError('BAD_REQUEST', 'Informe pelo menos dois cadastros', { status: 400 }), req);
    }
    const r = await Patient.updateMany(
      { _id: { $in: ids } },
      {
        $set: {
          'duplicateReview.confirmedDistinct': true,
          'duplicateReview.confirmedBy': req.user?._id || req.user?.id || null,
          'duplicateReview.confirmedAt': new Date(),
        },
      }
    );
    console.log('[Duplicates] confirm-distinct', { ids, by: req.user?._id || req.user?.id });
    res.json({ success: true, updated: r.modifiedCount });
  } catch (error) {
    console.error('[Duplicates] confirm-distinct erro:', error);
    sendApiError(res, new AppError('INTERNAL_ERROR', 'Erro ao registrar', { status: 500 }), req);
  }
});

/**
 * @route   POST /api/patients/duplicates/merge
 * @desc    Mescla o cadastro duplicado no principal. dryRun=true (padrão) só mostra a prévia.
 *          Execução real exige PATIENT_MERGE_ENABLED=true no ambiente e confirm="MESCLAR".
 * @body    { primaryId, duplicateId, dryRun?: boolean, confirm?: "MESCLAR" }
 * @access  Admin
 */
router.post('/duplicates/merge', auth, authorize(['admin', 'secretary']), async (req, res) => {
  try {
    const { primaryId, duplicateId } = req.body || {};
    const dryRun = req.body?.dryRun !== false;
    if (!dryRun && req.body?.confirm !== 'MESCLAR') {
      return sendApiError(res, new AppError('BAD_REQUEST', 'Confirme digitando MESCLAR', { status: 400 }), req);
    }
    const result = await mergePatientsCommand({ primaryId, duplicateId, user: req.user, dryRun });
    res.json({ success: true, data: result });
  } catch (error) {
    console.error('[Duplicates] merge erro:', error);
    const status = error.statusCode || 500;
    sendApiError(res, new AppError(error.code || 'INTERNAL_ERROR', status === 500 ? 'Erro ao mesclar cadastros' : error.message, { status }), req);
  }
});

export default router;
