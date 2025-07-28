import Session from '../models/Session.js';

export const validateSessionPayment = async (req, res, next) => {
    try {
        const sessionId = req.params.id;

        if (!sessionId || !mongoose.Types.ObjectId.isValid(sessionId)) {
            return res.status(400).json({
                error: "ID de sessão inválido",
                message: "O ID fornecido não é válido"
            });
        }

        const session = await Session.findById(sessionId);

        if (!session) {
            return res.status(404).json({
                error: "Sessão não encontrada",
                message: `Nenhuma sessão encontrada com o ID: ${sessionId}`
            });
        }

        if (session.status !== 'paid') {
            return res.status(403).json({
                error: "Sessão não paga",
                message: "Efetue o pagamento para utilizar esta sessão",
                sessionId: sessionId,
                currentStatus: session.status
            });
        }

        next();

    } catch (error) {
        console.error("Erro na validação de pagamento:", error);
        res.status(500).json({
            error: "Erro interno no servidor",
            message: "Não foi possível verificar o status da sessão"
        });
    }
};

export default validateSessionPayment;