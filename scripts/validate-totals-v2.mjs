#!/usr/bin/env node
/**
 * Script de Validação - Totals V2
 * 
 * Testa via API HTTP (não precisa de imports internos)
 */

import { v4 as uuidv4 } from 'uuid';

const API_BASE = process.env.API_URL || 'http://localhost:5000/api';

class TotalsV2Validator {
    constructor() {
        this.results = [];
        this.correlationId = uuidv4();
    }

    log(test, status, message, details = {}) {
        const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⏳';
        console.log(`${icon} [${test}] ${message}`);
        if (Object.keys(details).length > 0) {
            console.log('   ', JSON.stringify(details, null, 2));
        }
        this.results.push({ test, status, message, details });
    }

    async request(endpoint, options = {}) {
        const url = `${API_BASE}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            'x-correlation-id': this.correlationId,
            ...options.headers
        };
        
        const response = await fetch(url, {
            ...options,
            headers
        });
        
        const data = await response.json().catch(() => null);
        return { status: response.status, data };
    }

    // ======================================================
    // TESTE 1: GET /v2/totals (fallback síncrono)
    // ======================================================
    async testGetTotals() {
        console.log('\n📋 TESTE 1: GET /v2/totals\n');
        
        try {
            const startTime = Date.now();
            const { status, data } = await this.request('/v2/totals?date=2026-03-30&period=month');
            const duration = Date.now() - startTime;
            
            if (status === 200 && data?.success) {
                this.log('GET_TOTALS', 'PASS', `Endpoint respondeu em ${duration}ms`, {
                    source: data.data?.source,
                    totals: data.data?.totals,
                    correlationId: data.correlationId
                });
                return data;
            } else {
                this.log('GET_TOTALS', 'FAIL', `Status ${status}`, { data });
            }
        } catch (error) {
            this.log('GET_TOTALS', 'FAIL', error.message);
        }
    }

    // ======================================================
    // TESTE 2: POST /v2/totals/recalculate (async)
    // ======================================================
    async testRecalculate() {
        console.log('\n📋 TESTE 2: POST /v2/totals/recalculate\n');
        
        try {
            const { status, data } = await this.request('/v2/totals/recalculate', {
                method: 'POST',
                body: JSON.stringify({
                    date: '2026-03-30',
                    period: 'month'
                })
            });
            
            if (status === 202 && data?.success) {
                this.log('RECALCULATE', 'PASS', 'Recálculo solicitado (202 Accepted)', {
                    eventId: data.data?.eventId,
                    checkStatusUrl: data.data?.checkStatusUrl
                });
                return data.data?.eventId;
            } else {
                this.log('RECALCULATE', 'FAIL', `Status ${status}`, { data });
            }
        } catch (error) {
            this.log('RECALCULATE', 'FAIL', error.message);
        }
    }

    // ======================================================
    // TESTE 3: GET /v2/totals/status/:date
    // ======================================================
    async testGetStatus() {
        console.log('\n📋 TESTE 3: GET /v2/totals/status/:date\n');
        
        try {
            const { status, data } = await this.request('/v2/totals/status/2026-03-30?period=month');
            
            if (status === 200 && data?.success) {
                this.log('GET_STATUS', 'PASS', 'Status obtido', {
                    status: data.data?.status,
                    calculatedAt: data.data?.calculatedAt
                });
            } else {
                this.log('GET_STATUS', 'FAIL', `Status ${status}`, { data });
            }
        } catch (error) {
            this.log('GET_STATUS', 'FAIL', error.message);
        }
    }

    // ======================================================
    // TESTE 4: Verificar se snapshot foi criado (polling)
    // ======================================================
    async testSnapshotCreated() {
        console.log('\n📋 TESTE 4: Snapshot Creation (com polling)\n');
        
        // Primeiro solicita recálculo
        await this.testRecalculate();
        
        console.log('   Aguardando processamento (5s)...');
        await new Promise(r => setTimeout(r, 5000));
        
        // Verifica se agora temos snapshot
        try {
            const { status, data } = await this.request('/v2/totals?date=2026-03-30&period=month');
            
            if (status === 200 && data?.data?.source === 'snapshot') {
                this.log('SNAPSHOT', 'PASS', 'Snapshot criado e sendo usado!', {
                    calculatedAt: data.data?.calculatedAt
                });
            } else if (data?.data?.source === 'sync_fallback') {
                this.log('SNAPSHOT', 'WARN', 'Ainda usando fallback (worker pode estar processando)', {
                    source: data.data?.source
                });
            } else {
                this.log('SNAPSHOT', 'FAIL', 'Resposta inesperada', { data });
            }
        } catch (error) {
            this.log('SNAPSHOT', 'FAIL', error.message);
        }
    }

    // ======================================================
    // RELATÓRIO FINAL
    // ======================================================
    printReport() {
        console.log('\n' + '='.repeat(60));
        console.log('📊 RELATÓRIO DE VALIDAÇÃO - Totals V2');
        console.log('='.repeat(60));
        
        const passed = this.results.filter(r => r.status === 'PASS').length;
        const failed = this.results.filter(r => r.status === 'FAIL').length;
        const warnings = this.results.filter(r => r.status === 'WARN').length;
        
        console.log(`\n✅ Passaram: ${passed}`);
        console.log(`⚠️  Avisos: ${warnings}`);
        console.log(`❌ Falharam: ${failed}`);
        console.log(`📋 Total: ${this.results.length}`);
        
        if (failed === 0) {
            console.log('\n🎉 TODOS OS TESTES PASSARAM!');
            if (warnings > 0) {
                console.log('⚠️  Verifique os avisos antes de prosseguir');
            } else {
                console.log('👉 Backend pronto para uso em produção');
            }
        } else {
            console.log('\n⚠️  EXISTEM FALHAS - Corrija antes de migrar o frontend');
        }
        
        console.log('\n' + '='.repeat(60));
    }

    async run() {
        console.log('\n🚀 INICIANDO VALIDAÇÃO - Totals V2');
        console.log(`   API: ${API_BASE}\n`);
        
        await this.testGetTotals();
        await this.testGetStatus();
        await this.testSnapshotCreated();
        
        this.printReport();
    }
}

// Executa
const validator = new TotalsV2Validator();
validator.run().catch(console.error);
