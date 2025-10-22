export function getMetaToken() {
    return (
        process.env.WHATSAPP_ACCESS_TOKEN ||
        process.env.META_WABA_TOKEN ||
        process.env.SHORT_TOKEN ||
        null
    );
}
