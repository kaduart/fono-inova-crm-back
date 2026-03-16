// Script para deletar agendamentos de PACOTE do paciente Davi Felipe Araujo
// Executar na extensão MongoDB for VS Code ou com mongosh

const db = db || database; // compatibilidade

// 1. Busca o paciente
const patient = db.patients.findOne({ 
    fullName: { $regex: 'Davi Felipe Araujo', $options: 'i' } 
});

if (!patient) {
    print('❌ Paciente não encontrado');
    quit(1);
}

print('✅ Paciente encontrado:');
print('  ID:', patient._id.toString());
print('  Nome:', patient.fullName);
print('  Phone:', patient.phone);

const patientId = patient._id;

// 2. Busca agendamentos de PACOTE
const appointments = db.appointments.find({ 
    patient: patientId,
    package: { $exists: true, $ne: null }
}).toArray();

print('\n📋 Agendamentos de PACOTE encontrados:', appointments.length);

appointments.forEach(appt => {
    print('\n  - ID:', appt._id.toString());
    print('    Data:', appt.date, '| Hora:', appt.time);
    print('    Package ID:', appt.package?.toString() || 'N/A');
    print('    Status:', appt.operationalStatus);
});

if (appointments.length === 0) {
    print('\n⚠️ Nenhum agendamento de pacote encontrado');
    quit(0);
}

// 3. Confirmação (comentar para executar realmente)
print('\n⚠️ Para DELETAR esses agendamentos, descomente as linhas abaixo:');
print('// const result = db.appointments.deleteMany({');
print('//     patient: patientId,');
print('//     package: { $exists: true, $ne: null }');
print('// });');
print('// print("✅ Deletados:", result.deletedCount, "agendamentos");');

// DESCOMENTAR ABAIXO PARA EXECUTAR A DELEÇÃO:
/*
const result = db.appointments.deleteMany({
    patient: patientId,
    package: { $exists: true, $ne: null }
});
print('\n✅ Agendamentos deletados:', result.deletedCount);
*/

print('\n📝 Script concluído. Verifique os agendamentos acima.');
print('   Para deletar, descomente o bloco de código na linha 47-52.');
