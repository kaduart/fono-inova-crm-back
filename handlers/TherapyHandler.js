// handlers/TherapyHandler.js
class TherapyHandler {
    async execute({ decisionContext }) {
        const { memory, analysis } = decisionContext;
        const therapy = memory.therapyArea || analysis.detectedTherapy;

        return {
            text: `A terapia de ${therapy} funciona com acompanhamento individualizado para ajudar no desenvolvimento da criança 💚\n\nSe quiser, posso te explicar valores ou já verificar horários disponíveis.`
        };
    }
}

export default new TherapyHandler();
