
// tests/verify-orchestrator-fix.js
import WhatsAppOrchestratorV7 from '../orchestrators/WhatsAppOrchestrator.js';

async function test() {
    const orchestrator = new WhatsAppOrchestratorV7();

    // Mock de um Mongoose Document (simplificado)
    const mockLeadDoc = {
        _id: "698cc907b1f7de4a3dd31174",
        pendingSchedulingSlots: "NÃO",
        pendingChosenSlot: "NÃO",
        toObject: function () {
            // O toObject do Mongoose retorna as propriedades enumeráveis
            return {
                pendingSchedulingSlots: this.pendingSchedulingSlots,
                pendingChosenSlot: this.pendingChosenSlot
            };
        }
    };

    // Simula o comportamento onde _id não é enumerável no spread
    // (Embora no JS puro ele seja, no Mongoose Document real ele se comporta diferente)
    const leadSpread = { ...mockLeadDoc };
    console.log('Teste do spread direto:', leadSpread._id ? 'Tem _id' : 'NÃO TEM _id');

    console.log('\n--- Testando _normalizeLeadState ---');
    const normalized = orchestrator._normalizeLeadState(mockLeadDoc);
    console.log('ID preservado:', normalized._id === "698cc907b1f7de4a3dd31174" ? '✅ SIM' : '❌ NÃO');
    console.log('pendingSchedulingSlots resetado:', normalized.pendingSchedulingSlots === null ? '✅ SIM' : '❌ NÃO');
    console.log('pendingChosenSlot resetado:', normalized.pendingChosenSlot === null ? '✅ SIM' : '❌ NÃO');

    console.log('\n--- Testando preservation no process() ---');
    // Mock do ContextManager.loadContext para não bater no DB
    // Nota: No ambiente real, precisaríamos dar mock no import, mas aqui vamos testar a lógica do normalize

    if (normalized._id === "698cc907b1f7de4a3dd31174" && normalized.pendingSchedulingSlots === null) {
        console.log('CONCORRÊNCIA: Lógica de normalização validada com sucesso! 🚀');
    } else {
        console.error('FALHA: Lógica de normalização incorreta.');
        process.exit(1);
    }
}

test().catch(console.error);
