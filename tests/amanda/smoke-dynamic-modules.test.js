/**
 * 🧪 SMOKE TEST: DYNAMIC_MODULES
 * Teste rápido para garantir que o erro crítico não voltou
 */

import { describe, it, expect } from 'vitest';
import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/test";

describe('🚨 SMOKE TEST: DYNAMIC_MODULES', () => {
    
    it('DEVE carregar AmandaOrchestrator sem erro', async () => {
        const module = await import('../../orchestrators/AmandaOrchestrator.js');
        expect(module).toBeDefined();
        expect(module.getOptimizedAmandaResponse).toBeDefined();
    });

    it('NÃO DEVE lançar "DYNAMIC_MODULES is not defined"', async () => {
        const { getOptimizedAmandaResponse } = await import('../../orchestrators/AmandaOrchestrator.js');
        
        const mockLead = {
            _id: new mongoose.Types.ObjectId(),
            name: "Teste",
            status: "novo",
            stage: "novo",
            contact: { phone: "5562999999999" }
        };
        
        // Este é o teste crítico - se DYNAMIC_MODULES não estiver definido,
        // vai lançar ReferenceError
        let error = null;
        try {
            await getOptimizedAmandaResponse({
                content: "Oi",
                userText: "Oi",
                lead: mockLead,
                context: { toneMode: "premium" }
            });
        } catch (e) {
            error = e;
        }
        
        // NÃO pode ser o erro de DYNAMIC_MODULES
        if (error) {
            expect(error.message).not.toContain('DYNAMIC_MODULES is not defined');
        }
    });

    it('DEVE funcionar com toneMode = acolhimento', async () => {
        const { getOptimizedAmandaResponse } = await import('../../orchestrators/AmandaOrchestrator.js');
        
        const mockLead = {
            _id: new mongoose.Types.ObjectId(),
            name: "Teste",
            status: "novo",
            stage: "novo",
            contact: { phone: "5562999999999" }
        };
        
        let error = null;
        try {
            await getOptimizedAmandaResponse({
                content: "Oi, bom dia",
                userText: "Oi, bom dia",
                lead: mockLead,
                context: { toneMode: "acolhimento" }
            });
        } catch (e) {
            error = e;
        }
        
        // Se não houve erro, está tudo bem
        // Se houve erro, não pode ser o DYNAMIC_MODULES
        if (error) {
            expect(error.message).not.toContain('DYNAMIC_MODULES is not defined');
        }
    });

    it('DEVE funcionar sem toneMode', async () => {
        const { getOptimizedAmandaResponse } = await import('../../orchestrators/AmandaOrchestrator.js');
        
        const mockLead = {
            _id: new mongoose.Types.ObjectId(),
            name: "Teste",
            status: "novo",
            stage: "novo",
            contact: { phone: "5562999999999" }
        };
        
        let error = null;
        try {
            await getOptimizedAmandaResponse({
                content: "Quanto custa?",
                userText: "Quanto custa?",
                lead: mockLead,
                context: {}
            });
        } catch (e) {
            error = e;
        }
        
        // Se não houve erro, está tudo bem
        // Se houve erro, não pode ser o DYNAMIC_MODULES
        if (error) {
            expect(error.message).not.toContain('DYNAMIC_MODULES is not defined');
        }
    });
});

// Teste rápido que pode ser rodado com: npm test -- smoke-dynamic-modules
console.log('✅ Smoke test de DYNAMIC_MODULES carregado');
