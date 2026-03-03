/**
 * Teste isolado - Extração de Nome
 * Verifica se o nome está sendo extraído corretamente
 */

import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../orchestrators/AmandaOrchestrator.js';

const testCases = [
    { input: "Ele se chama Pedro Henrique", expected: "Pedro Henrique" },
    { input: "O nome dela é Ana Clara", expected: "Ana Clara" },
    { input: "E o nome é Pedro Henrique Souza", expected: "Pedro Henrique Souza" },
    { input: "Maria tem 7 anos", expected: "Maria" },
    { input: "Meu filho se chama João Pedro", expected: "João Pedro" },
    { input: "Sou o Carlos Eduardo", expected: "Carlos Eduardo" },
    { input: "nome: Juliana Martins", expected: "Juliana Martins" },
    { input: "pra minha filha Julia", expected: "Julia" },
    { input: "minha filha se chama Beatriz Lima", expected: "Beatriz Lima" }
];

async function test() {
    console.log('🧪 Teste de Extração de Nome\n');
    
    for (const test of testCases) {
        const lead = {
            _id: new mongoose.Types.ObjectId(),
            name: 'Teste',
            contact: { phone: '5561999999999' },
            therapyArea: 'psicologia',
            patientInfo: { fullName: null, age: null },
            qualificationData: { extractedInfo: {} }
        };
        
        try {
            const response = await getOptimizedAmandaResponse({
                content: test.input,
                userText: test.input,
                lead,
                context: {}
            });
            
            // Verifica se o nome aparece na resposta
            const hasName = response && (
                response.includes(test.expected) || 
                response.includes(test.expected.split(' ')[0])
            );
            
            console.log(`📨 "${test.input}"`);
            console.log(`   Esperado: "${test.expected}"`);
            console.log(`   Resposta inclui: ${hasName ? '✅ SIM' : '❌ NÃO'}`);
            console.log(`   Resposta: "${response?.substring(0, 60)}..."`);
            console.log();
            
        } catch (err) {
            console.error(`❌ Erro: ${err.message}`);
        }
    }
}

test().catch(console.error);
