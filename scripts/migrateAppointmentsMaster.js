import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Appointment from '../models/Appointment.js';

dotenv.config();

async function runMigration() {
    try {
        mongoose.connect(process.env.MONGO_URI)
            .then(() => console.log('Connected to MongoDB'))
            .catch((err) => console.error('Could not connect to MongoDB', err));


        // Etapa 1: Fix missing specialties
        const specialtyFix = await Appointment.updateMany(
            { specialty: { $exists: false } },
            { $set: { specialty: 'fonoaudiologia' } }
        );

        // Etapa 2: Migrar status clínicos/operacionais
        const appointments = await Appointment.find({});

        let migratedCount = 0;
        let skippedCount = 0;
        const errors = [];

        for (const appointment of appointments) {
            try {
                // Registrar estado original
                const originalStatus = appointment.status;

                // Mapear para novos status
                let operationalStatus, clinicalStatus;

                if (appointment.status === 'concluído') {
                    operationalStatus = 'pago';
                    clinicalStatus = 'concluído';
                } else if (appointment.status === 'cancelado') {
                    operationalStatus = 'cancelado';
                    clinicalStatus = 'pendente';
                } else if (appointment.status === 'confirmado') {
                    operationalStatus = 'confirmado';
                    clinicalStatus = 'pendente';
                } else {
                    operationalStatus = 'agendado';
                    clinicalStatus = 'pendente';
                }

                // Atualizar diretamente no banco
                await Appointment.updateOne(
                    { _id: appointment._id },
                    {
                        $set: {
                            operationalStatus,
                            clinicalStatus,
                            meta: {
                                originalStatus,
                                migratedAt: new Date(),
                                isPastDate: appointment.date < new Date()
                            }
                        }
                    }
                );

                migratedCount++;
            } catch (error) {
                skippedCount++;
                errors.push({
                    _id: appointment._id,
                    error: error.message
                });
                console.warn(`⚠️ Erro no agendamento ${appointment._id}: ${error.message}`);
            }
        }

        if (errors.length > 0) {
            console.table(errors);
        }

    } catch (error) {
        console.error('❌ Erro fatal:', error);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

runMigration();