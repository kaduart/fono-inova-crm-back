// Decisão de modo do crm-worker (18/11/2026). Fica isolada para ser testada sem subir o processo.
// external → nunca há processo filho com Chrome (nem no boot, nem em respawn); o WhatsApp vai pela ponte.
export const isExternalMode = (env = process.env) => env.WHATSAPP_CONNECTOR_MODE === 'external';
export const shouldSpawnChromeChild = (env = process.env) => !isExternalMode(env);
export default { isExternalMode, shouldSpawnChromeChild };
