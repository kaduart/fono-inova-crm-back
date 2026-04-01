#!/usr/bin/env node
// insurance/scripts/initConvenios.js
/**
 * Script de inicialização de convênios
 * 
 * Garante que os convênios padrão existam no banco de dados
 * e inicializa o sistema de insurance.
 */

import mongoose from 'mongoose';
import Convenio from '../../models/Convenio.js';
import { createContextLogger } from '../../utils/logger.js';

const log = createContextLogger('init-convenios', 'system');

// Convênios padrão do sistema
const DEFAULT_CONVENIOS = [
    { 
        code: 'unimed-anapolis', 
        name: 'Unimed Anápolis', 
        sessionValue: 80,
        notes: 'Convênio padrão - Unimed Anápolis'
    },
    { 
        code: 'unimed-campinas', 
        name: 'Unimed Campinas', 
        sessionValue: 140,
        notes: 'Convênio padrão - Unimed Campinas'
    },
    { 
        code: 'unimed-goiania', 
        name: 'Unimed Goiânia', 
        sessionValue: 80,
        notes: 'Convênio padrão - Unimed Goiânia'
    },
    { 
        code: 'bradesco-saude', 
        name: 'Bradesco Saúde', 
        sessionValue: 120,
        notes: 'Convênio padrão - Bradesco'
    },
    { 
        code: 'sulamerica', 
        name: 'SulAmérica', 
        sessionValue: 110,
        notes: 'Convênio padrão - SulAmérica'
    },
    { 
        code: 'amil', 
        name: 'Amil', 
        sessionValue: 100,
        notes: 'Convênio padrão - Amil'
    },
    { 
        code: 'cassi', 
        name: 'CASSI', 
        sessionValue: 130,
        notes: 'Convênio padrão - CASSI (Banco do Brasil)'
    }
];

/**
 * Inicializa convênios no banco
 */
async function initializeConvenios() {
    try {
        log.info('start', 'Iniciando inicialização de convênios');
        
        let created = 0;
        let updated = 0;
        
        for (const conv of DEFAULT_CONVENIOS) {
            const result = await Convenio.findOneAndUpdate(
                { code: conv.code },
                conv,
                { upsert: true, new: true }
            );
            
            // Se foi criado agora, não tem createdAt anterior
            const wasCreated = result.createdAt.getTime() === result.updatedAt.getTime();
            
            if (wasCreated) {
                created++;
                log.info('created', `Convênio criado: ${conv.name}`, { code: conv.code });
            } else {
                updated++;
                log.info('updated', `Convênio atualizado: ${conv.name}`, { code: conv.code });
            }
        }
        
        log.info('complete', 'Inicialização concluída', {
            created,
            updated,
            total: DEFAULT_CONVENIOS.length
        });
        
        return { created, updated, total: DEFAULT_CONVENIOS.length };
        
    } catch (error) {
        log.error('error', 'Erro na inicialização', { error: error.message });
        throw error;
    }
}

/**
 * Verifica se convênios estão ok
 */
async function checkConvenios() {
    const count = await Convenio.countDocuments({ active: true });
    const convenios = await Convenio.find({ active: true }).select('code name sessionValue');
    
    log.info('check', `Total de convênios ativos: ${count}`);
    
    return {
        count,
        convenios: convenios.map(c => ({
            code: c.code,
            name: c.name,
            sessionValue: c.sessionValue
        }))
    };
}

// ============================================
// MAIN
// ============================================

async function main() {
    try {
        // Conecta ao MongoDB
        const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/crm';
        await mongoose.connect(mongoUri);
        log.info('connected', 'Conectado ao MongoDB');
        
        // Inicializa convênios
        const result = await initializeConvenios();
        
        // Verifica estado
        const check = await checkConvenios();
        
        console.log('\n========================================');
        console.log('✅ CONVÊNIOS INICIALIZADOS');
        console.log('========================================');
        console.log(`Criados: ${result.created}`);
        console.log(`Atualizados: ${result.updated}`);
        console.log(`Total ativos: ${check.count}`);
        console.log('\nConvênios:');
        check.convenios.forEach(c => {
            console.log(`  - ${c.name}: R$ ${c.sessionValue}`);
        });
        console.log('========================================\n');
        
        await mongoose.disconnect();
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Erro:', error.message);
        process.exit(1);
    }
}

// Se executado diretamente
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}

export { initializeConvenios, checkConvenios };
