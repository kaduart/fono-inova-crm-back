import dotenv from 'dotenv';
import mongoose from 'mongoose';
import path from 'path';
import { fileURLToPath } from 'url';
import Appointment from '../../models/Appointment.js';

// Configurar caminhos absolutos
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carregar variáveis de ambiente
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function fixMigrationMetadata() {
  try {
    mongoose.connect(process.env.MONGO_URI)
      .then(() => console.log('Connected to MongoDB'))
      .catch((err) => console.error('Could not connect to MongoDB', err));


    // 2. Encontrar documentos sem metadados
    const filter = {
      clinicalStatus: { $exists: true }, // Documentos migrados
      meta: { $exists: false }           // Mas sem metadados
    };

    const appointments = await Appointment.find(filter);

    // 3. Processar cada documento
    let updatedCount = 0;
    const errors = [];

    for (const app of appointments) {
      try {
        // Calcular se a data é passada
        const now = new Date();
        const isPastDate = app.date < now;

        // Criar objeto de metadados
        const meta = {
          originalStatus: app.status,
          migratedAt: new Date(),
          isPastDate,
          isInvalidDate: app.date < new Date('1900-01-01') // Verificar datas absurdas
        };

        // 4. Atualizar documento
        await Appointment.updateOne(
          { _id: app._id },
          { $set: { meta } }
        );

        updatedCount++;
      } catch (error) {
        errors.push({
          _id: app._id,
          error: error.message
        });
        console.error(`❌ Erro no documento ${app._id}:`, error.message);
      }
    }

    // 5. Relatório final

    if (errors.length > 0) {
      console.table(errors);
    }

  } catch (error) {
    console.error('❌ Erro fatal:', error);
  } finally {
    // 6. Desconectar
    await mongoose.disconnect();
    process.exit(0);
  }
}

fixMigrationMetadata();