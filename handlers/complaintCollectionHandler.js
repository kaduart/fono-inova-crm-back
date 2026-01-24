// handlers/complaintCollectionHandler.js

export const complaintCollectionHandler = {
    async execute({ decisionContext }) {
        const { memory, analysis } = decisionContext;
        const therapy = memory.therapyArea;

        // Mensagem empática baseada na terapia detectada
        let message = "";

        if (therapy === 'fonoaudiologia') {
            message = `Entendi que você busca fonoaudiologia 💚

Para eu indicar o melhor profissional e preparar a avaliação, me conta: qual a principal dificuldade que você notou? 

Pode ser sobre fala, mastigação, troca de letras... o que você observa no dia a dia?`;
        } else if (therapy === 'psicologia') {
            message = `Obrigada por confiar em nós 💚

Para encaminhar você para o psicólogo certo, pode me contar brevemente o que tem motivado essa busca agora? 

(Não precisa ser detalhado, só o contexto principal para eu preparar o atendimento)`;
        } else {
            message = `Perfeito! 💚

Para organizarmos o melhor atendimento, me conta rapidamente: qual é a situação principal que você gostaria de trabalhar na ${therapy || 'terapia'}?`;
        }

        return {
            text: message,
            extractedInfo: {
                awaitingComplaint: true,
                lastQuestion: 'primary_complaint'
            }
        };
    }
};