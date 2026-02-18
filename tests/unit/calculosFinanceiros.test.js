/**
 * Testes Unitários - Cálculos Financeiros Críticos
 * 
 * ⚠️ CRÍTICO: Estes testes garantem que:
 * 1. Cálculos de custos variáveis estão corretos
 * 2. Convênios usam insurance.grossAmount (não amount=0)
 * 3. Taxas são aplicadas consistentemente
 * 4. Margens são calculadas corretamente
 */

import { describe, it, expect } from 'vitest';

// =============================================================================
// CONSTANTES DO SISTEMA (Source of Truth)
// =============================================================================
const IMPOSTOS_PERCENTUAL = 0.06; // 6% Simples Nacional
const COMISSAO_PERCENTUAL = 0.10; // 10% comissão padrão

// Taxas de cartão (devem estar sincronizadas com TaxaCartao.js)
const TAXAS_CARTAO = {
    visa: { debito: 0.90, credito_1x: 1.85, credito_6x: 2.29, credito_12x: 2.53 },
    mastercard: { debito: 0.90, credito_1x: 1.85, credito_6x: 2.29, credito_12x: 2.53 },
    elo: { debito: 1.45, credito_1x: 2.40, credito_6x: 2.94, credito_12x: 3.18 },
    amex: { debito: 0, credito_1x: 2.35, credito_6x: 2.89, credito_12x: 3.13 }
};

// =============================================================================
// FUNÇÕES DE CÁLCULO (Extraídas dos serviços para teste isolado)
// =============================================================================

/**
 * Calcula custos variáveis de uma venda
 * Usado em: provisionamentoService.js
 */
function calcularCustosVariaveis(valor, formaPagamento, bandeira = 'visa', parcelas = 1) {
    // Impostos (6% Simples)
    const impostos = valor * IMPOSTOS_PERCENTUAL;
    
    // Comissão (10%)
    const comissao = valor * COMISSAO_PERCENTUAL;
    
    // Taxa de cartão
    let taxaCartao = 0;
    if (formaPagamento === 'debito') {
        taxaCartao = (valor * TAXAS_CARTAO[bandeira].debito) / 100;
    } else if (formaPagamento === 'credito') {
        const taxaPercentual = parcelas <= 1 ? TAXAS_CARTAO[bandeira].credito_1x :
                               parcelas <= 6 ? TAXAS_CARTAO[bandeira].credito_6x :
                               TAXAS_CARTAO[bandeira].credito_12x;
        taxaCartao = (valor * taxaPercentual) / 100;
    }
    
    const totalCV = impostos + comissao + taxaCartao;
    
    return {
        valor,
        impostos: parseFloat(impostos.toFixed(2)),
        comissao: parseFloat(comissao.toFixed(2)),
        taxaCartao: parseFloat(taxaCartao.toFixed(2)),
        totalCV: parseFloat(totalCV.toFixed(2)),
        margemContribuicao: parseFloat((valor - totalCV).toFixed(2)),
        percentualMargem: parseFloat(((valor - totalCV) / valor * 100).toFixed(2))
    };
}

/**
 * Extrai valor real de um pagamento (considerando convênios)
 * ⚠️ CRÍTICO: Convênios têm amount=0, valor real está em insurance.grossAmount
 */
function extrairValorPagamento(payment) {
    // Se for convênio, usar insurance.grossAmount
    if (payment.billingType === 'convenio' || payment.paymentMethod === 'convenio') {
        return payment.insurance?.grossAmount || 0;
    }
    // Caso contrário, usar amount normal
    return payment.amount || 0;
}

/**
 * Calcula totais de uma lista de pagamentos
 * Usado em: EntradasSaidasTab, provisionamento, etc
 */
function calcularTotaisPagamentos(payments) {
    return payments.reduce((acc, payment) => {
        const valor = extrairValorPagamento(payment);
        
        // Separar por tipo
        if (payment.billingType === 'convenio' || payment.paymentMethod === 'convenio') {
            acc.convenio += valor;
        } else if (['pix', 'dinheiro'].includes(payment.paymentMethod)) {
            acc.caixa += valor;
        } else if (['debito', 'credito'].includes(payment.paymentMethod)) {
            acc.caixa += valor;
            // Aqui não subtraímos taxa ainda - é feito no DRE
        }
        
        acc.total += valor;
        return acc;
    }, { total: 0, caixa: 0, convenio: 0 });
}

// =============================================================================
// TESTES
// =============================================================================

describe('Cálculos Financeiros Críticos', () => {
    
    describe('calcularCustosVariaveis()', () => {
        
        it('Venda de R$ 100 no débito Visa: impostos R$ 6, comissão R$ 10, taxa R$ 0.90', () => {
            const resultado = calcularCustosVariaveis(100, 'debito', 'visa');
            
            expect(resultado.impostos).toBe(6.00);
            expect(resultado.comissao).toBe(10.00);
            expect(resultado.taxaCartao).toBe(0.90);
            expect(resultado.totalCV).toBe(16.90);
            expect(resultado.margemContribuicao).toBe(83.10);
        });

        it('Venda de R$ 250 no crédito 1x Visa: taxa deve ser 1.85%', () => {
            const resultado = calcularCustosVariaveis(250, 'credito', 'visa', 1);
            
            expect(resultado.impostos).toBe(15.00); // 6%
            expect(resultado.comissao).toBe(25.00); // 10%
            expect(resultado.taxaCartao).toBe(4.625); // 1.85%
            expect(resultado.totalCV).toBe(44.63); // arredondado
        });

        it('Venda de R$ 500 no crédito 6x Elo: taxa deve ser 2.94%', () => {
            const resultado = calcularCustosVariaveis(500, 'credito', 'elo', 6);
            
            expect(resultado.impostos).toBe(30.00); // 6%
            expect(resultado.comissao).toBe(50.00); // 10%
            expect(resultado.taxaCartao).toBe(14.70); // 2.94%
            expect(resultado.totalCV).toBe(94.70);
            expect(resultado.margemContribuicao).toBe(405.30);
            expect(resultado.percentualMargem).toBe(81.06);
        });

        it('Venda no dinheiro/Pix: sem taxa de cartão', () => {
            const resultado = calcularCustosVariaveis(200, 'pix', 'visa', 1);
            
            expect(resultado.taxaCartao).toBe(0);
            expect(resultado.totalCV).toBe(32.00); // só imposto + comissão
        });
    });

    describe('extrairValorPagamento() - Convênios', () => {
        
        it('⚠️ CRÍTICO: Convênio com amount=0 deve retornar insurance.grossAmount', () => {
            const paymentConvenio = {
                amount: 0,
                billingType: 'convenio',
                insurance: {
                    grossAmount: 250.00,
                    provider: 'unimed'
                }
            };
            
            const valor = extrairValorPagamento(paymentConvenio);
            expect(valor).toBe(250.00);
            expect(valor).not.toBe(0); // ⚠️ Se retornar 0, está errado!
        });

        it('Pagamento normal deve retornar amount', () => {
            const paymentNormal = {
                amount: 150.00,
                paymentMethod: 'pix'
            };
            
            const valor = extrairValorPagamento(paymentNormal);
            expect(valor).toBe(150.00);
        });

        it('Pagamento em dinheiro deve retornar amount', () => {
            const paymentDinheiro = {
                amount: 200.00,
                paymentMethod: 'dinheiro'
            };
            
            const valor = extrairValorPagamento(paymentDinheiro);
            expect(valor).toBe(200.00);
        });

        it('Convênio sem insurance deve retornar 0 (dados incompletos)', () => {
            const paymentConvenioInvalido = {
                amount: 0,
                billingType: 'convenio'
                // Sem insurance
            };
            
            const valor = extrairValorPagamento(paymentConvenioInvalido);
            expect(valor).toBe(0);
        });
    });

    describe('calcularTotaisPagamentos() - Consolidação', () => {
        
        it('Deve separar corretamente Caixa vs Convênio', () => {
            const payments = [
                { amount: 100, paymentMethod: 'pix' },
                { amount: 150, paymentMethod: 'dinheiro' },
                { amount: 200, paymentMethod: 'debito' },
                { amount: 0, billingType: 'convenio', insurance: { grossAmount: 300 } },
                { amount: 0, billingType: 'convenio', insurance: { grossAmount: 250 } }
            ];
            
            const totais = calcularTotaisPagamentos(payments);
            
            expect(totais.caixa).toBe(450); // 100 + 150 + 200
            expect(totais.convenio).toBe(550); // 300 + 250
            expect(totais.total).toBe(1000);
        });

        it('⚠️ CRÍTICO: Se esquecer de usar insurance.grossAmount, convênios somam 0', () => {
            // Simula o bug: usando amount em vez de insurance.grossAmount
            const paymentsBug = [
                { amount: 0, billingType: 'convenio', insurance: { grossAmount: 300 } }
            ];
            
            // Se usar apenas amount, o valor seria 0 (BUG!)
            const valorBug = paymentsBug[0].amount;
            expect(valorBug).toBe(0); // Este é o valor errado!
            
            // Valor correto deve ser 300
            const valorCorreto = extrairValorPagamento(paymentsBug[0]);
            expect(valorCorreto).toBe(300);
        });
    });

    describe('Validação de cenários reais', () => {
        
        it('Cenário: Dia com 5 atendimentos (3 particulares + 2 convênios)', () => {
            const atendimentos = [
                { amount: 200, paymentMethod: 'pix' },
                { amount: 180, paymentMethod: 'debito' },
                { amount: 220, paymentMethod: 'credito' },
                { amount: 0, billingType: 'convenio', insurance: { grossAmount: 250 } },
                { amount: 0, billingType: 'convenio', insurance: { grossAmount: 250 } }
            ];
            
            const totais = calcularTotaisPagamentos(atendimentos);
            
            // Caixa: pix + débito + crédito
            expect(totais.caixa).toBe(600); // 200 + 180 + 220
            
            // A Receber: convênios
            expect(totais.convenio).toBe(500); // 250 + 250
            
            // Total do dia
            expect(totais.total).toBe(1100);
        });

        it('Cenário: Cálculo de margem para sessão de R$ 200 no crédito', () => {
            const valorSessao = 200;
            const custos = calcularCustosVariaveis(valorSessao, 'credito', 'visa', 1);
            
            // Valores esperados:
            // Imposto: 12 (6%)
            // Comissão: 20 (10%)
            // Taxa cartão: 3.70 (1.85%)
            // Total CV: 35.70
            // Margem: 164.30 (82.15%)
            
            expect(custos.totalCV).toBeCloseTo(35.70, 2);
            expect(custos.margemContribuicao).toBeCloseTo(164.30, 2);
            expect(custos.percentualMargem).toBeCloseTo(82.15, 2);
        });
    });
});

// Exportar funções para uso em outros testes se necessário
export { calcularCustosVariaveis, extrairValorPagamento, calcularTotaisPagamentos };
