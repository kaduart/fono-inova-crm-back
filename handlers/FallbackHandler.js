export class FallbackHandler {
    async execute() {
        return {
            data: {
                fallback: true
            }
        };
    }
}