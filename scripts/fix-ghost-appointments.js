// fix-ghost-appointments.js
const conn = new Mongo("mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test");
const db = conn.getDB("test");

// Data alvo: 15/07/2025
const TARGET_DATE = new Date("2025-07-15T00:00:00.000Z");
const END_DATE = new Date("2025-07-15T23:59:59.999Z");
const GHOST_DOCTOR_ID = "686024fb74dcf94b84ade15a";

print("🔍 Buscando agendamentos fantasmas para 15/07/2025...");

// Encontrar todos os agendamentos do médico "teste" no dia 15/07
const ghostAppointments = db.appointments.find({
    date: {
        $gte: TARGET_DATE,
        $lte: END_DATE
    },
    "doctor._id": GHOST_DOCTOR_ID
}).toArray();

print(`⚠️ Encontrados ${ghostAppointments.length} agendamentos fantasmas`);

// Remover agendamentos e atualizar pacientes
ghostAppointments.forEach(appointment => {
    print(`\nProcessando agendamento: ${appointment._id}`);
    
    try {
        // 1. Remover dos registros do paciente
        const patientUpdate = {
            $pull: { allAppointments: appointment._id },
            $unset: {}
        };
        
        // Verificar nextAppointment
        if (appointment.patient.nextAppointment?.id === appointment._id) {
            patientUpdate.$unset.nextAppointment = "";
        }
        
        // Verificar lastAppointment
        if (appointment.patient.lastAppointment?.id === appointment._id) {
            patientUpdate.$unset.lastAppointment = "";
        }
        
        db.patients.updateOne(
            { _id: appointment.patient._id },
            patientUpdate
        );
        
        // 2. Remover o agendamento
        db.appointments.deleteOne({ _id: appointment._id });
        
        print(`✅ Agendamento removido e paciente atualizado`);
        
    } catch (error) {
        print(`❌ Erro ao processar ${appointment._id}: ${error}`);
    }
});

// Atualizar relatório de auditoria
print("\n🔄 Atualizando relatório de auditoria...");
const reportUpdate = db.audit_reports.updateOne(
    {
        "date": "15/07/2025",
        "byProfessional.doctorId": GHOST_DOCTOR_ID
    },
    {
        $set: {
            "totals.scheduled.count": 0,
            "totals.scheduled.value": 0,
            "byProfessional.$.scheduled": 0,
            "byProfessional.$.scheduledValue": 0
        }
    }
);

if (reportUpdate.modifiedCount > 0) {
    print("✅ Relatório de auditoria atualizado");
} else {
    print("ℹ️ Nenhum relatório encontrado para atualização");
}

print("\n✅ Correção concluída com sucesso!");