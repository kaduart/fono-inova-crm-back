// insurance/integrations/tiss/tissGenerator.js
/**
 * TISS XML Generator
 * 
 * Gera XML no padrão TISS (Troca de Informações em Saúde Suplementar)
 * para envio de lotes de faturamento.
 * 
 * Versão: TISS 3.05.00
 */

// ============================================
// XML GENERATION
// ============================================

/**
 * Gera XML TISS completo para um lote
 */
export async function generateTissXml(data) {
    const {
        batchNumber,
        insuranceProvider,
        insuranceProviderCode,
        startDate,
        endDate,
        items,
        providerInfo = {}
    } = data;
    
    // Cabeçalho do XML
    const xmlHeader = `<?xml version="1.0" encoding="UTF-8"?>
<ans:mensagemTISS xmlns:ans="http://www.ans.gov.br/padroes/tiss/schemas">
    <ans:cabecalho>
        <ans:identificacaoTransacao>
            <ans:tipoTransacao>ENVIO_LOTE_GUIAS</ans:tipoTransacao>
            <ans:sequencialTransacao>1</ans:sequencialTransacao>
            <ans:dataRegistroTransacao>${formatDate(new Date())}</ans:dataRegistroTransacao>
            <ans:horaRegistroTransacao>${formatTime(new Date())}</ans:horaRegistroTransacao>
        </ans:identificacaoTransacao>
        <ans:origem>
            <ans:identificacaoPrestador>
                <ans:CNPJ>${providerInfo.cnpj || '00000000000000'}</ans:CNPJ>
            </ans:identificacaoPrestador>
        </ans:origem>
        <ans:destino>
            <ans:registroANS>${insuranceProviderCode || '000000'}</ans:registroANS>
        </ans:destino>
        <ans:versaoPadrao>3.05.00</ans:versaoPadrao>
    </ans:cabecalho>
    <ans:prestadorParaOperadora>
        <ans:loteGuias>
            <ans:numeroLote>${batchNumber}</ans:numeroLote>
            <ans:guias>
${items.map((item, index) => generateGuiaTISS(item, index + 1)).join('')}
            </ans:guias>
        </ans:loteGuias>
    </ans:prestadorParaOperadora>
    <ans:epilogo>
        <ans:hash>${generateHash(batchNumber)}</ans:hash>
    </ans:epilogo>
</ans:mensagemTISS>`;

    return xmlHeader;
}

/**
 * Gera uma guia TISS individual
 */
function generateGuiaTISS(item, sequence) {
    const dataAtendimento = item.sessionDate ? formatDate(new Date(item.sessionDate)) : formatDate(new Date());
    
    return `                <ans:guiaSP-SADT>
                    <ans:cabecalhoGuia>
                        <ans:registroANS>${item.providerCode || '000000'}</ans:registroANS>
                        <ans:numeroGuiaPrestador>${item.guideNumber || `G${sequence}`}</ans:numeroGuiaPrestador>
                    </ans:cabecalhoGuia>
                    <ans:dadosBeneficiario>
                        <ans:numeroCarteira>${item.patientCardNumber || ''}</ans:numeroCarteira>
                        <ans:nomeBeneficiario>${escapeXml(item.patientName || '')}</ans:nomeBeneficiario>
                    </ans:dadosBeneficiario>
                    <ans:dadosSolicitante>
                        <ans:contratadoSolicitante>
                            <ans:cnpjContratado>${item.contractorCnpj || '00000000000000'}</ans:cnpjContratado>
                        </ans:contratadoSolicitante>
                        <ans:profissionalSolicitante>
                            <ans:nomeProfissional>${escapeXml(item.professionalName || '')}</ans:nomeProfissional>
                            <ans:conselhoProfissional>06</ans:conselhoProfissional>
                            <ans:numeroConselhoProfissional>${item.professionalRegistry || ''}</ans:numeroConselhoProfissional>
                            <ans:UF>GO</ans:UF>
                            <ans:CBOS>${item.professionalCbos || ''}</ans:CBOS>
                        </ans:profissionalSolicitante>
                    </ans:dadosSolicitante>
                    <ans:dadosSolicitacao>
                        <ans:dataSolicitacao>${dataAtendimento}</ans:dataSolicitacao>
                        <ans:caraterAtendimento>1</ans:caraterAtendimento>
                    </ans:dadosSolicitacao>
                    <ans:dadosExecutante>
                        <ans:contratadoExecutante>
                            <ans:cnpjContratado>${item.contractorCnpj || '00000000000000'}</ans:cnpjContratado>
                        </ans:contratadoExecutante>
                        <ans:profissionalExecutante>
                            <ans:nomeProfissional>${escapeXml(item.professionalName || '')}</ans:nomeProfissional>
                            <ans:conselhoProfissional>06</ans:conselhoProfissional>
                            <ans:numeroConselhoProfissional>${item.professionalRegistry || ''}</ans:numeroConselhoProfissional>
                            <ans:UF>GO</ans:UF>
                            <ans:CBOS>${item.professionalCbos || ''}</ans:CBOS>
                        </ans:profissionalExecutante>
                    </ans:dadosExecutante>
                    <ans:dadosAtendimento>
                        <ans:tipoAtendimento>4</ans:tipoAtendimento>
                        <ans:indicacaoAcidente>0</ans:indicacaoAcidente>
                    </ans:dadosAtendimento>
                    <ans:procedimentosExecutados>
                        <ans:procedimentoExecutado>
                            <ans:dataExecucao>${dataAtendimento}</ans:dataExecucao>
                            <ans:horaInicial>${item.startTime || '0800'}</ans:horaInicial>
                            <ans:horaFinal>${item.endTime || '0900'}</ans:horaFinal>
                            <ans:procedimento>
                                <ans:codigoTabela>22</ans:codigoTabela>
                                <ans:codigoProcedimento>${item.procedureCode}</ans:codigoProcedimento>
                                <ans:descricaoProcedimento>${escapeXml(item.procedureName || '')}</ans:descricaoProcedimento>
                            </ans:procedimento>
                            <ans:quantidadeExecutada>1</ans:quantidadeExecutada>
                            <ans:viaAcesso>1</ans:viaAcesso>
                            <ans:tecnicaUtilizada>1</ans:tecnicaUtilizada>
                            <ans:valorUnitario>${formatCurrency(item.grossAmount)}</ans:valorUnitario>
                            <ans:valorTotal>${formatCurrency(item.grossAmount)}</ans:valorTotal>
                        </ans:procedimentoExecutado>
                    </ans:procedimentosExecutados>
                    <ans:valorTotal>
                        <ans:valorProcedimentos>${formatCurrency(item.grossAmount)}</ans:valorProcedimentos>
                        <ans:valorTotalGeral>${formatCurrency(item.grossAmount)}</ans:valorTotalGeral>
                    </ans:valorTotal>
                </ans:guiaSP-SADT>
`;
}

// ============================================
// GATEWAY / PROVIDER INTEGRATION
// ============================================

/**
 * Envia lote para operadora de saúde
 * 
 * Em produção: integração real com API da operadora
 * Em desenvolvimento: simula resposta
 */
export async function sendToInsuranceProvider(data) {
    const {
        provider,
        providerCode,
        batchNumber,
        xmlContent,
        correlationId
    } = data;
    
    console.log(`[TISS Gateway] Enviando lote ${batchNumber} para ${provider}`);
    
    // Simula delay de rede
    await simulateDelay(500, 1500);
    
    // Simula validação do XML
    const validation = validateTissXml(xmlContent);
    if (!validation.valid) {
        return {
            success: false,
            error: 'XML_VALIDATION_FAILED',
            details: validation.errors
        };
    }
    
    // Gera protocolo de retorno
    const protocol = generateProtocol(provider, batchNumber);
    
    // Simula probabilidade de erro (5%)
    if (Math.random() < 0.05) {
        return {
            success: false,
            error: 'PROVIDER_UNAVAILABLE',
            details: 'Operadora temporariamente indisponível'
        };
    }
    
    console.log(`[TISS Gateway] Lote enviado com sucesso. Protocolo: ${protocol}`);
    
    return {
        success: true,
        protocol,
        providerResponse: {
            status: 'ACKNOWLEDGED',
            expectedProcessingTime: '24h',
            correlationId
        }
    };
}

/**
 * Simula retorno da operadora (para testes)
 */
export async function simulateProviderResponse(batchId, items) {
    // Simula delay de processamento (1-5 segundos)
    await simulateDelay(1000, 5000);
    
    const results = items.map(item => {
        // Simula resultado aleatório
        const rand = Math.random();
        
        if (rand > 0.2) {
            // 80% aprovado
            return {
                itemId: item._id || item.id,
                status: 'approved',
                netAmount: item.grossAmount,
                returnCode: '00',
                returnMessage: 'Procedimento aprovado'
            };
        } else if (rand > 0.05) {
            // 15% glosa recuperável
            return {
                itemId: item._id || item.id,
                status: 'rejected',
                glosaAmount: item.grossAmount * 0.3,
                glosa: {
                    code: '2010',
                    reason: 'Dados incompletos',
                    detail: 'Número da carteira não informado',
                    isRecoverable: true,
                    suggestedAction: 'retry'
                },
                returnCode: '2010',
                returnMessage: 'Dados incompletos - reenviar'
            };
        } else {
            // 5% glosa não recuperável
            return {
                itemId: item._id || item.id,
                status: 'rejected',
                glosaAmount: item.grossAmount,
                glosa: {
                    code: '5010',
                    reason: 'Procedimento não coberto',
                    detail: 'Procedimento não consta na tabela do plano',
                    isRecoverable: false,
                    suggestedAction: 'write_off'
                },
                returnCode: '5010',
                returnMessage: 'Procedimento não coberto'
            };
        }
    });
    
    return {
        batchId,
        processedAt: new Date(),
        results,
        summary: {
            total: items.length,
            approved: results.filter(r => r.status === 'approved').length,
            rejected: results.filter(r => r.status === 'rejected').length
        }
    };
}

// ============================================
// HELPERS
// ============================================

/**
 * Valida estrutura básica do XML TISS
 */
function validateTissXml(xmlContent) {
    const errors = [];
    
    // Verifica tags obrigatórias
    const requiredTags = [
        'ans:mensagemTISS',
        'ans:cabecalho',
        'ans:prestadorParaOperadora',
        'ans:loteGuias'
    ];
    
    for (const tag of requiredTags) {
        if (!xmlContent.includes(tag)) {
            errors.push(`Tag obrigatória ausente: ${tag}`);
        }
    }
    
    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * Formata data para padrão TISS (YYYY-MM-DD)
 */
function formatDate(date) {
    return date.toISOString().split('T')[0];
}

/**
 * Formata hora para padrão TISS (HHMM)
 */
function formatTime(date) {
    return date.toTimeString().slice(0, 5).replace(':', '');
}

/**
 * Formata valor monetário (2 decimais)
 */
function formatCurrency(value) {
    return Number(value || 0).toFixed(2);
}

/**
 * Escapa caracteres XML
 */
function escapeXml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Gera hash simples para o lote
 */
function generateHash(input) {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        const char = input.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(16).toUpperCase().padStart(8, '0');
}

/**
 * Gera número de protocolo
 */
function generateProtocol(provider, batchNumber) {
    const timestamp = Date.now().toString(36).toUpperCase();
    const providerCode = provider.substring(0, 3).toUpperCase();
    return `${providerCode}-${timestamp}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
}

/**
 * Simula delay aleatório
 */
function simulateDelay(min, max) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, delay));
}

// ============================================
// EXPORTS
// ============================================

export default {
    generateTissXml,
    sendToInsuranceProvider,
    simulateProviderResponse,
    validateTissXml
};
