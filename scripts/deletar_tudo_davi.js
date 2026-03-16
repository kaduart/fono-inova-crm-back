// DELETAR TUDO do paciente Davi Felipe Araujo
// MANTER apenas o cadastro do paciente

const paciente = db.patients.findOne({ fullName: /Davi Felipe Araujo/i });

if (!paciente) {
    print("❌ Paciente não encontrado");
} else {
    print("✅ Paciente encontrado: " + paciente.fullName);
    print("📋 ID: " + paciente._id);
    
    // 1. Buscar PACKAGES do paciente
    const packages = db.packages.find({ patient: paciente._id }).toArray();
    print("\n📦 Packages encontrados: " + packages.length);
    packages.forEach(p => print("  - " + p._id + " | Status: " + p.financialStatus));
    
    // 2. Buscar APPOINTMENTS
    const appointments = db.appointments.find({ patient: paciente._id }).toArray();
    print("\n📅 Appointments encontrados: " + appointments.length);
    appointments.forEach(a => print("  - " + a.date + " " + a.time + " | ID: " + a._id));
    
    // 3. Buscar SESSIONS
    const sessions = db.sessions.find({ patient: paciente._id }).toArray();
    print("\n🗓️ Sessions encontradas: " + sessions.length);
    sessions.forEach(s => print("  - " + s.date + " " + s.time + " | ID: " + s._id));
    
    // 4. Buscar PAYMENTS
    const payments = db.payments.find({ patient: paciente._id }).toArray();
    print("\n💰 Payments encontrados: " + payments.length);
    payments.forEach(p => print("  - R$" + p.amount + " | ID: " + p._id));
    
    // DELETAR TUDO
    print("\n" + "=".repeat(50));
    print("DELETANDO...");
    
    const delPackages = db.packages.deleteMany({ patient: paciente._id });
    const delAppointments = db.appointments.deleteMany({ patient: paciente._id });
    const delSessions = db.sessions.deleteMany({ patient: paciente._id });
    const delPayments = db.payments.deleteMany({ patient: paciente._id });
    
    print("\n✅ DELETADOS:");
    print("  📦 Packages: " + delPackages.deletedCount);
    print("  📅 Appointments: " + delAppointments.deletedCount);
    print("  🗓️ Sessions: " + delSessions.deletedCount);
    print("  💰 Payments: " + delPayments.deletedCount);
    
    print("\n📝 Cadastro do paciente MANTIDO: " + paciente.fullName);
}
