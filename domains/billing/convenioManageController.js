// insurance/convenioManageController.js
/**
 * Controller para Gerenciamento de Convênios
 * 
 * CRUD completo para administrar convênios dinamicamente.
 * Permite adicionar, editar, ativar/desativar sem mexer no código.
 */

import mongoose from 'mongoose';
import Convenio from '../../models/Convenio.js';
import { sanitizeSpecialtyValues } from '../../utils/resolveConvenioSessionValue.js';
import { createContextLogger } from '../../utils/logger.js';
import { sendApiError } from '../../errors/buildErrorResponse.js';
import { AppError } from '../../errors/AppError.js';

const log = createContextLogger('convenio-manage', 'admin');

// ============================================
// VALIDAÇÃO
// ============================================

/**
 * Valida dados do convênio
 */
function validateConvenioData(data) {
    const errors = [];
    
    if (!data.code || data.code.trim().length < 3) {
        errors.push('Código do convênio deve ter pelo menos 3 caracteres');
    }
    
    if (!data.name || data.name.trim().length < 3) {
        errors.push('Nome do convênio deve ter pelo menos 3 caracteres');
    }
    
    if (data.sessionValue === undefined || data.sessionValue === null) {
        errors.push('Valor da sessão é obrigatório');
    } else {
        const value = Number(data.sessionValue);
        if (isNaN(value) || value < 0) {
            errors.push('Valor da sessão deve ser um número positivo');
        }
    }
    
    // Valida código (somente letras, números e hífen)
    if (data.code && !/^[a-z0-9-]+$/.test(data.code.toLowerCase())) {
        errors.push('Código deve conter apenas letras, números e hífen');
    }
    
    return {
        valid: errors.length === 0,
        errors
    };
}

// ============================================
// CRUD
// ============================================

/**
 * GET /api/insurance/admin/convenios
 * Lista todos os convênios (ativos e inativos)
 */
export async function listAllConveniosHandler(req, res) {
    try {
        const { includeInactive = 'false' } = req.query;
        
        const query = includeInactive === 'true' ? {} : { active: true };
        
        const convenios = await Convenio.find(query)
            .sort({ name: 1 })
            .lean();
        
        // Calcula estatísticas para cada convênio
        const conveniosWithStats = await Promise.all(
            convenios.map(async (conv) => {
                // Conta lotes do último mês
                const recentBatches = await mongoose.model('InsuranceBatch').countDocuments({
                    insuranceProvider: conv.code,
                    createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
                });
                
                // Conta sessões pendentes
                const pendingSessions = await mongoose.model('Session').countDocuments({
                    status: 'completed',
                    billingStatus: { $in: ['pending', null] },
                    'package.type': 'convenio',
                    'package.insuranceProvider': conv.code
                });
                
                return {
                    ...conv,
                    stats: {
                        recentBatches,
                        pendingSessions,
                        estimatedRevenue: pendingSessions * conv.sessionValue
                    }
                };
            })
        );
        
        res.json({
            success: true,
            data: conveniosWithStats,
            count: convenios.length
        });
        
    } catch (error) {
        log.error('list_error', 'Erro ao listar convênios', { error: error.message });
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao buscar convênios',
          }),
          req
        );
    }
}

/**
 * GET /api/insurance/admin/convenios/:code
 * Detalhes de um convênio
 */
export async function getConvenioDetailsHandler(req, res) {
    try {
        const { code } = req.params;
        
        const convenio = await Convenio.findOne({
            code: code.toLowerCase()
        }).lean();
        
        if (!convenio) {
            return sendApiError(res, new AppError('NOT_FOUND', 'Convênio não encontrado', { status: 404 }), req);
        }
        
        // Histórico de lotes
        const batchHistory = await mongoose.model('InsuranceBatch').aggregate([
            { $match: { insuranceProvider: code } },
            {
                $group: {
                    _id: {
                        year: { $year: '$createdAt' },
                        month: { $month: '$createdAt' }
                    },
                    count: { $sum: 1 },
                    totalSessions: { $sum: '$totalSessions' },
                    totalReceived: { $sum: '$receivedAmount' }
                }
            },
            { $sort: { '_id.year': -1, '_id.month': -1 } },
            { $limit: 12 }
        ]);
        
        res.json({
            success: true,
            data: {
                ...convenio,
                history: batchHistory
            }
        });
        
    } catch (error) {
        log.error('details_error', 'Erro ao buscar detalhes', { error: error.message });
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao buscar detalhes',
          }),
          req
        );
    }
}

/**
 * POST /api/insurance/admin/convenios
 * Cria novo convênio
 */
export async function createConvenioHandler(req, res) {
    try {
        const { code, name, sessionValue, notes = '', billingMode = 'per_month', defaultSessions, guidePolicy, legalName, taxId, issRate, specialtyValues, abaSurchargePercent } = req.body;

        const specialtyCheck = sanitizeSpecialtyValues(specialtyValues);
        if (specialtyCheck.error) {
            return sendApiError(res, new AppError('BAD_REQUEST', specialtyCheck.error, { status: 400 }), req);
        }

        // Validação
        const validation = validateConvenioData({ code, name, sessionValue });
        if (!validation.valid) {
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Dados inválidos', {
                status: 400,
                details: validation.errors,
              }),
              req
            );
        }
        
        const normalizedCode = code.toLowerCase().trim();
        
        // Verifica se já existe
        const existing = await Convenio.findOne({ code: normalizedCode });
        if (existing) {
            return sendApiError(
              res,
              new AppError('CONFLICT', `Já existe um convênio com o código '${normalizedCode}'`, {
                status: 409,
                legacyError: 'Convênio já existe',
              }),
              req
            );
        }
        
        // Valida guidePolicy se fornecido
        let validatedGuidePolicy = undefined;
        if (guidePolicy !== undefined && guidePolicy !== null) {
            const validRenewalTypes = ['end_of_month', 'until_consumed', 'fixed_date', 'authorization_validity', 'advance_authorization'];
            const validStrategies = ['eligible', 'manual', 'none'];
            if (guidePolicy.renewalType && !validRenewalTypes.includes(guidePolicy.renewalType)) {
                return sendApiError(
                  res,
                  new AppError('BAD_REQUEST', 'guidePolicy.renewalType inválido', {
                    status: 400,
                  }),
                  req
                );
            }
            if (guidePolicy.defaultMigrationStrategy && !validStrategies.includes(guidePolicy.defaultMigrationStrategy)) {
                return sendApiError(
                  res,
                  new AppError('BAD_REQUEST', 'guidePolicy.defaultMigrationStrategy inválido', {
                    status: 400,
                  }),
                  req
                );
            }
            if (guidePolicy.billingSubmissionDay != null && (guidePolicy.billingSubmissionDay < 1 || guidePolicy.billingSubmissionDay > 31)) {
                return sendApiError(
                  res,
                  new AppError('BAD_REQUEST', 'guidePolicy.billingSubmissionDay deve estar entre 1 e 31', {
                    status: 400,
                  }),
                  req
                );
            }
            validatedGuidePolicy = guidePolicy;
        }

        if (abaSurchargePercent !== undefined && abaSurchargePercent !== null) {
            const pct = Number(abaSurchargePercent);
            if (!Number.isFinite(pct) || pct < 0 || pct > 500) {
                return sendApiError(
                  res,
                  new AppError('BAD_REQUEST', 'abaSurchargePercent deve ser um número entre 0 e 500', {
                    status: 400,
                  }),
                  req
                );
            }
        }
        if (issRate !== undefined && issRate !== null) {
            const rate = Number(issRate);
            if (isNaN(rate) || rate < 0 || rate > 100) {
                return sendApiError(
                  res,
                  new AppError('BAD_REQUEST', 'issRate deve ser um número entre 0 e 100', {
                    status: 400,
                  }),
                  req
                );
            }
        }

        // Cria convênio
        const convenio = new Convenio({
            code: normalizedCode,
            name: name.trim(),
            sessionValue: Number(sessionValue),
            billingMode: ['per_month', 'per_guide'].includes(billingMode) ? billingMode : 'per_month',
            notes: notes.trim(),
            active: true,
            ...(defaultSessions !== undefined && { defaultSessions: defaultSessions === null ? null : Number(defaultSessions) || null }),
            ...(validatedGuidePolicy && { guidePolicy: validatedGuidePolicy }),
            ...(legalName !== undefined && { legalName: String(legalName).trim() }),
            ...(taxId !== undefined && { taxId: String(taxId).trim() }),
            ...(issRate !== undefined && issRate !== null && { issRate: Number(issRate) }),
            ...(abaSurchargePercent !== undefined && abaSurchargePercent !== null && { abaSurchargePercent: Number(abaSurchargePercent) }),
            ...(specialtyCheck.value !== undefined && { specialtyValues: specialtyCheck.value })
        });
        
        await convenio.save();
        
        log.info('created', 'Convênio criado', {
            code: normalizedCode,
            name: name.trim(),
            by: req.user?._id
        });
        
        res.status(201).json({
            success: true,
            message: 'Convênio criado com sucesso',
            data: convenio
        });
        
    } catch (error) {
        log.error('create_error', 'Erro ao criar convênio', { error: error.message });
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao criar convênio',
          }),
          req
        );
    }
}

/**
 * PUT /api/insurance/admin/convenios/:code
 * Atualiza convênio existente
 */
export async function updateConvenioHandler(req, res) {
    try {
        const { code } = req.params;
        const { name, sessionValue, notes, active, billingMode, defaultSessions, guidePolicy, legalName, taxId, issRate, specialtyValues, abaSurchargePercent } = req.body;

        const specialtyCheck = sanitizeSpecialtyValues(specialtyValues);
        if (specialtyCheck.error) {
            return sendApiError(res, new AppError('BAD_REQUEST', specialtyCheck.error, { status: 400 }), req);
        }

        const normalizedCode = code.toLowerCase().trim();
        
        // Busca convênio
        const convenio = await Convenio.findOne({ code: normalizedCode });
        
        if (!convenio) {
            return sendApiError(res, new AppError('NOT_FOUND', 'Convênio não encontrado', { status: 404 }), req);
        }
        
        // Prepara dados para atualização
        const updateData = {};
        
        if (name !== undefined) {
            if (name.trim().length < 3) {
                return sendApiError(
                  res,
                  new AppError('BAD_REQUEST', 'Nome deve ter pelo menos 3 caracteres', {
                    status: 400,
                  }),
                  req
                );
            }
            updateData.name = name.trim();
        }
        
        if (sessionValue !== undefined) {
            const value = Number(sessionValue);
            if (isNaN(value) || value < 0) {
                return sendApiError(
                  res,
                  new AppError('BAD_REQUEST', 'Valor da sessão deve ser um número positivo', {
                    status: 400,
                  }),
                  req
                );
            }
            updateData.sessionValue = value;
        }
        
        if (notes !== undefined) {
            updateData.notes = notes.trim();
        }

        // Tabela por especialidade: lista completa substitui a anterior (enviar [] limpa)
        if (specialtyCheck.value !== undefined) {
            updateData.specialtyValues = specialtyCheck.value;
        }

        if (active !== undefined) {
            updateData.active = Boolean(active);
        }

        if (billingMode !== undefined) {
            if (!['per_month', 'per_guide'].includes(billingMode)) {
                return sendApiError(res, new AppError('BAD_REQUEST', 'billingMode inválido', { status: 400 }), req);
            }
            updateData.billingMode = billingMode;
        }

        if (defaultSessions !== undefined) {
            updateData.defaultSessions = defaultSessions === null ? null : Number(defaultSessions) || null;
        }

        if (legalName !== undefined) {
            updateData.legalName = String(legalName).trim();
        }

        if (taxId !== undefined) {
            updateData.taxId = String(taxId).trim();
        }

        if (issRate !== undefined && issRate !== null) {
            const rate = Number(issRate);
            if (isNaN(rate) || rate < 0 || rate > 100) {
                return sendApiError(
                  res,
                  new AppError('BAD_REQUEST', 'issRate deve ser um número entre 0 e 100', {
                    status: 400,
                  }),
                  req
                );
            }
            updateData.issRate = rate;
        }
        if (abaSurchargePercent !== undefined && abaSurchargePercent !== null) {
            updateData.abaSurchargePercent = Number(abaSurchargePercent);
        }

        if (guidePolicy !== undefined && guidePolicy !== null) {
            const validRenewalTypes = ['end_of_month', 'until_consumed', 'fixed_date', 'authorization_validity', 'advance_authorization'];
            const validStrategies = ['eligible', 'manual', 'none'];
            if (guidePolicy.renewalType && !validRenewalTypes.includes(guidePolicy.renewalType)) {
                return sendApiError(
                  res,
                  new AppError('BAD_REQUEST', 'guidePolicy.renewalType inválido', {
                    status: 400,
                  }),
                  req
                );
            }
            if (guidePolicy.defaultMigrationStrategy && !validStrategies.includes(guidePolicy.defaultMigrationStrategy)) {
                return sendApiError(
                  res,
                  new AppError('BAD_REQUEST', 'guidePolicy.defaultMigrationStrategy inválido', {
                    status: 400,
                  }),
                  req
                );
            }
            if (guidePolicy.billingSubmissionDay != null && (guidePolicy.billingSubmissionDay < 1 || guidePolicy.billingSubmissionDay > 31)) {
                return sendApiError(
                  res,
                  new AppError('BAD_REQUEST', 'guidePolicy.billingSubmissionDay deve estar entre 1 e 31', {
                    status: 400,
                  }),
                  req
                );
            }
            // Merge parcial para não apagar campos não enviados
            updateData.guidePolicy = { ...convenio.guidePolicy?.toObject?.() ?? {}, ...guidePolicy };
        }

        // Atualiza
        const updated = await Convenio.findOneAndUpdate(
            { code: normalizedCode },
            updateData,
            { new: true }
        );
        
        log.info('updated', 'Convênio atualizado', {
            code: normalizedCode,
            updatedFields: Object.keys(updateData),
            by: req.user?._id
        });
        
        res.json({
            success: true,
            message: 'Convênio atualizado com sucesso',
            data: updated
        });
        
    } catch (error) {
        log.error('update_error', 'Erro ao atualizar convênio', { error: error.message });
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao atualizar convênio',
          }),
          req
        );
    }
}

/**
 * DELETE /api/insurance/admin/convenios/:code
 * Desativa convênio (soft delete)
 */
export async function deactivateConvenioHandler(req, res) {
    try {
        const { code } = req.params;
        const normalizedCode = code.toLowerCase().trim();
        
        const convenio = await Convenio.findOne({ code: normalizedCode });
        
        if (!convenio) {
            return sendApiError(res, new AppError('NOT_FOUND', 'Convênio não encontrado', { status: 404 }), req);
        }
        
        // Verifica se há lotes pendentes
        const pendingBatches = await mongoose.model('InsuranceBatch').countDocuments({
            insuranceProvider: normalizedCode,
            status: { $in: ['building', 'ready', 'sent', 'processing'] }
        });
        
        if (pendingBatches > 0) {
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', `Existem ${pendingBatches} lotes pendentes para este convênio. Finalize ou cancele-os primeiro.`, {
                status: 400,
                legacyError: 'Não é possível desativar',
              }),
              req
            );
        }
        
        // Desativa
        convenio.active = false;
        await convenio.save();
        
        log.info('deactivated', 'Convênio desativado', {
            code: normalizedCode,
            by: req.user?._id
        });
        
        res.json({
            success: true,
            message: 'Convênio desativado com sucesso',
            data: convenio
        });
        
    } catch (error) {
        log.error('deactivate_error', 'Erro ao desativar convênio', { error: error.message });
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao desativar convênio',
          }),
          req
        );
    }
}

/**
 * POST /api/insurance/admin/convenios/:code/ativar
 * Reativa convênio
 */
export async function activateConvenioHandler(req, res) {
    try {
        const { code } = req.params;
        const normalizedCode = code.toLowerCase().trim();
        
        const convenio = await Convenio.findOne({ code: normalizedCode });
        
        if (!convenio) {
            return sendApiError(res, new AppError('NOT_FOUND', 'Convênio não encontrado', { status: 404 }), req);
        }
        
        convenio.active = true;
        await convenio.save();
        
        log.info('activated', 'Convênio reativado', {
            code: normalizedCode,
            by: req.user?._id
        });
        
        res.json({
            success: true,
            message: 'Convênio ativado com sucesso',
            data: convenio
        });
        
    } catch (error) {
        log.error('activate_error', 'Erro ao ativar convênio', { error: error.message });
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro ao ativar convênio',
          }),
          req
        );
    }
}

// ============================================
// IMPORTAÇÃO EM MASSA
// ============================================

/**
 * POST /api/insurance/admin/convenios/importar
 * Importa múltiplos convênios de uma vez
 */
export async function importConveniosHandler(req, res) {
    try {
        const { convenios } = req.body;
        
        if (!Array.isArray(convenios) || convenios.length === 0) {
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Lista de convênios é obrigatória', {
                status: 400,
              }),
              req
            );
        }
        
        const results = {
            created: [],
            updated: [],
            errors: []
        };
        
        for (const data of convenios) {
            // Validação
            const validation = validateConvenioData(data);
            if (!validation.valid) {
                results.errors.push({
                    code: data.code,
                    errors: validation.errors
                });
                continue;
            }
            
            const normalizedCode = data.code.toLowerCase().trim();
            
            try {
                const existing = await Convenio.findOne({ code: normalizedCode });
                
                if (existing) {
                    // Atualiza existente
                    await Convenio.updateOne(
                        { code: normalizedCode },
                        {
                            name: data.name.trim(),
                            sessionValue: Number(data.sessionValue),
                            notes: (data.notes || '').trim(),
                            active: data.active !== false
                        }
                    );
                    results.updated.push(normalizedCode);
                } else {
                    // Cria novo
                    await Convenio.create({
                        code: normalizedCode,
                        name: data.name.trim(),
                        sessionValue: Number(data.sessionValue),
                        notes: (data.notes || '').trim(),
                        active: true
                    });
                    results.created.push(normalizedCode);
                }
            } catch (err) {
                results.errors.push({
                    code: normalizedCode,
                    errors: [err.message]
                });
            }
        }
        
        log.info('imported', 'Importação de convênios concluída', {
            created: results.created.length,
            updated: results.updated.length,
            errors: results.errors.length,
            by: req.user?._id
        });
        
        res.json({
            success: true,
            message: 'Importação concluída',
            data: results
        });
        
    } catch (error) {
        log.error('import_error', 'Erro na importação', { error: error.message });
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro na importação',
          }),
          req
        );
    }
}

// ============================================
// VALIDAÇÃO DE CÓDIGO
// ============================================

/**
 * GET /api/insurance/admin/convenios/validar-codigo/:code
 * Valida se código está disponível
 */
export async function validateCodeHandler(req, res) {
    try {
        const { code } = req.params;
        const normalizedCode = code.toLowerCase().trim();
        
        // Valida formato
        if (!/^[a-z0-9-]+$/.test(normalizedCode)) {
            return res.json({
                success: true,
                valid: false,
                error: 'Código deve conter apenas letras minúsculas, números e hífen'
            });
        }
        
        if (normalizedCode.length < 3) {
            return res.json({
                success: true,
                valid: false,
                error: 'Código deve ter pelo menos 3 caracteres'
            });
        }
        
        // Verifica se existe
        const existing = await Convenio.findOne({ code: normalizedCode });
        
        res.json({
            success: true,
            valid: !existing,
            available: !existing,
            message: existing ? 'Código já está em uso' : 'Código disponível'
        });
        
    } catch (error) {
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', error.message, {
            status: 500,
            legacyError: 'Erro na validação',
          }),
          req
        );
    }
}
