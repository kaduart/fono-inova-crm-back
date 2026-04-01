// insurance/convenioManageController.js
/**
 * Controller para Gerenciamento de Convênios
 * 
 * CRUD completo para administrar convênios dinamicamente.
 * Permite adicionar, editar, ativar/desativar sem mexer no código.
 */

import mongoose from 'mongoose';
import Convenio from '../../models/Convenio.js';
import { createContextLogger } from '../../utils/logger.js';

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
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar convênios',
            message: error.message
        });
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
            return res.status(404).json({
                success: false,
                error: 'Convênio não encontrado'
            });
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
        res.status(500).json({
            success: false,
            error: 'Erro ao buscar detalhes',
            message: error.message
        });
    }
}

/**
 * POST /api/insurance/admin/convenios
 * Cria novo convênio
 */
export async function createConvenioHandler(req, res) {
    try {
        const { code, name, sessionValue, notes = '' } = req.body;
        
        // Validação
        const validation = validateConvenioData({ code, name, sessionValue });
        if (!validation.valid) {
            return res.status(400).json({
                success: false,
                error: 'Dados inválidos',
                details: validation.errors
            });
        }
        
        const normalizedCode = code.toLowerCase().trim();
        
        // Verifica se já existe
        const existing = await Convenio.findOne({ code: normalizedCode });
        if (existing) {
            return res.status(409).json({
                success: false,
                error: 'Convênio já existe',
                message: `Já existe um convênio com o código '${normalizedCode}'`
            });
        }
        
        // Cria convênio
        const convenio = new Convenio({
            code: normalizedCode,
            name: name.trim(),
            sessionValue: Number(sessionValue),
            notes: notes.trim(),
            active: true
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
        res.status(500).json({
            success: false,
            error: 'Erro ao criar convênio',
            message: error.message
        });
    }
}

/**
 * PUT /api/insurance/admin/convenios/:code
 * Atualiza convênio existente
 */
export async function updateConvenioHandler(req, res) {
    try {
        const { code } = req.params;
        const { name, sessionValue, notes, active } = req.body;
        
        const normalizedCode = code.toLowerCase().trim();
        
        // Busca convênio
        const convenio = await Convenio.findOne({ code: normalizedCode });
        
        if (!convenio) {
            return res.status(404).json({
                success: false,
                error: 'Convênio não encontrado'
            });
        }
        
        // Prepara dados para atualização
        const updateData = {};
        
        if (name !== undefined) {
            if (name.trim().length < 3) {
                return res.status(400).json({
                    success: false,
                    error: 'Nome deve ter pelo menos 3 caracteres'
                });
            }
            updateData.name = name.trim();
        }
        
        if (sessionValue !== undefined) {
            const value = Number(sessionValue);
            if (isNaN(value) || value < 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Valor da sessão deve ser um número positivo'
                });
            }
            updateData.sessionValue = value;
        }
        
        if (notes !== undefined) {
            updateData.notes = notes.trim();
        }
        
        if (active !== undefined) {
            updateData.active = Boolean(active);
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
        res.status(500).json({
            success: false,
            error: 'Erro ao atualizar convênio',
            message: error.message
        });
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
            return res.status(404).json({
                success: false,
                error: 'Convênio não encontrado'
            });
        }
        
        // Verifica se há lotes pendentes
        const pendingBatches = await mongoose.model('InsuranceBatch').countDocuments({
            insuranceProvider: normalizedCode,
            status: { $in: ['building', 'ready', 'sent', 'processing'] }
        });
        
        if (pendingBatches > 0) {
            return res.status(400).json({
                success: false,
                error: 'Não é possível desativar',
                message: `Existem ${pendingBatches} lotes pendentes para este convênio. Finalize ou cancele-os primeiro.`
            });
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
        res.status(500).json({
            success: false,
            error: 'Erro ao desativar convênio',
            message: error.message
        });
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
            return res.status(404).json({
                success: false,
                error: 'Convênio não encontrado'
            });
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
        res.status(500).json({
            success: false,
            error: 'Erro ao ativar convênio',
            message: error.message
        });
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
            return res.status(400).json({
                success: false,
                error: 'Lista de convênios é obrigatória'
            });
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
        res.status(500).json({
            success: false,
            error: 'Erro na importação',
            message: error.message
        });
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
        res.status(500).json({
            success: false,
            error: 'Erro na validação',
            message: error.message
        });
    }
}
