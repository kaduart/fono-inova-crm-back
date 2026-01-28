// scripts/test-all-flows.js
console.log('>>> INICIO DO SCRIPT');

try {
    const dotenv = await import('dotenv');
    console.log('>>> dotenv importado');

    const { fileURLToPath } = await import('url');
    const { dirname, join } = await import('path');

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    dotenv.default.config({ path: join(__dirname, '../.env') });
    console.log('>>> ENV carregado, OPENAI existe:', !!process.env.OPENAI_API_KEY);

    console.log('>>> Importando mongoose...');
    const mongooseModule = await import('mongoose');
    const mongoose = mongooseModule.default;

    console.log('>>> Conectando Mongo...');
    await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
    console.log('>>> Mongo conectado!');

    process.exit(0);

} catch (err) {
    console.error('>>> ERRO:', err.message);
    process.exit(1);
}