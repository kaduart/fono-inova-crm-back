// handlers/FallbackHandler.js
class FallbackHandler {
    async execute({ decisionContext }) {
        return {
            text: 'Desculpe, não entendi muito bem 😅 Pode me explicar de outra forma? 💚'
        };
    }
}

export default new FallbackHandler();
