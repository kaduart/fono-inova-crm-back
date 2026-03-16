// COPIE TUDO ABAIXO e cole no MongoDB Shell da extensão
// Depois pressione Ctrl+Enter ou clique no botão de play

// Buscar paciente
const paciente = db.patients.findOne({ fullName: /Davi Felipe Araujo/i });
if (!paciente) {
    print("❌ Paciente não encontrado");
} else {
    print("✅ Paciente: " + paciente.fullName);
    print("📋 ID: " + paciente._id);
    
    // Listar agendamentos de pacote
    const agendamentos = db.appointments.find({ 
        patient: paciente._id,
        package: { $exists: true, $ne: null }
    }).toArray();
    
    print("\n📦 Agendamentos de PACOTE encontrados: " + agendamentos.length);
    agendamentos.forEach(a => {
        print("  - " + a.date + " " + a.time + " | ID: " + a._id);
    });
    
    // DELETAR
    if (agendamentos.length > 0) {
        const resultado = db.appointments.deleteMany({ 
            patient: paciente._id,
            package: { $exists: true, $ne: null }
        });
        print("\n✅ DELETADOS: " + resultado.deletedCount + " agendamentos de pacote");
    } else {
        print("\n⚠️ Nenhum agendamento de pacote para deletar");
    }
}
