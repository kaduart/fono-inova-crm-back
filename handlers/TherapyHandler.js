// handlers/TherapyHandler.js
export class TherapyHandler {
    async execute({ message, context }) {
        const therapy = context.therapy;

        return {
            data: {
                therapy,
                confidence: context.intentConfidence ?? 0.8
            }
        };
    }
}
