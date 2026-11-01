// Ambiente do backend local: não transportar credenciais do shell ou do .env.
export function buildMirrorEnvironment(parent, mongoUri) {
  const mongo = new URL(mongoUri);
  if (mongo.protocol !== 'mongodb:' || mongo.hostname !== '127.0.0.1' ||
      mongo.pathname !== '/fono_espelho' || mongo.username || mongo.password ||
      !/^\d+$/.test(mongo.port)) throw new Error('Destino Mongo do espelho inválido');
  const env = {};
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA']) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  return Object.assign(env, {
    NODE_ENV: 'development', ESPELHO: 'true', TZ: 'America/Sao_Paulo',
    MONGO_URI: mongoUri, ESPELHO_MONGO_PORT: mongo.port,
    REDIS_URL: 'redis://127.0.0.1:6381/0', REDIS_HOST: '127.0.0.1', REDIS_PORT: '6381', REDIS_PASSWORD: '',
    ENABLE_WORKERS: 'false', ENABLE_CRONS: 'false', ENABLE_PROJECTIONS: 'false',
    ENABLE_WHATSAPP_REALTIME: 'false', ENABLE_ADS_CONVERSION: 'false',
    PORT: '5000', FRONTEND_URL: 'http://localhost:5173',
    INTERNAL_BASE_URL: 'http://127.0.0.1:5000',
    JWT_SECRET: 'espelho-local-sem-validade-em-producao',
    SESSION_SECRET: 'sessao-local-sem-validade-em-producao',
    // SDKs instanciados durante imports exigem uma string; nunca usar credencial real.
    OPENAI_API_KEY: 'sk-espelho-invalida-sem-acesso',
    RESEND_API_KEY: 're_espelho_invalida_sem_acesso',
    GOOGLE_ADS_CLIENT_ID: 'espelho-invalido', GOOGLE_ADS_CLIENT_SECRET: 'espelho-invalido',
    GOOGLE_ADS_REFRESH_TOKEN: 'espelho-invalido', GOOGLE_ADS_DEVELOPER_TOKEN: 'espelho-invalido',
    GOOGLE_ADS_CUSTOMER_ID: '0000000000',
    ADS_CONVERSION_DRY_RUN: 'true',
  });
}
