// migratePackagesToPatients.js

print("Iniciando migração de pacotes para pacientes...");

// 1. Buscar todos os agendamentos com pacote
print("\nColetando agendamentos com pacotes associados...");
var appointmentsWithPackages = db.appointments.find({
    package: { $exists: true, $ne: null }
}).toArray();

print(`🔍 ${appointmentsWithPackages.length} agendamentos com pacotes encontrados`);

// 2. Criar mapa de pacotes por paciente
print("\nCriando mapa paciente->pacotes...");
var patientPackagesMap = {};

appointmentsWithPackages.forEach(function(appointment) {
    var patientId = appointment.patient.toString();
    var packageId = appointment.package.toString();
    
    if (!patientPackagesMap[patientId]) {
        patientPackagesMap[patientId] = new Set();
    }
    
    patientPackagesMap[patientId].add(packageId);
    print(`⚡ Paciente ${patientId} + pacote ${packageId}`);
});

// 3. Atualizar pacientes com seus pacotes
print("\nAtualizando pacientes...");
var updatedCount = 0;

for (var patientId in patientPackagesMap) {
    if (patientPackagesMap.hasOwnProperty(patientId)) {
        var packageIds = Array.from(patientPackagesMap[patientId]).map(id => ObjectId(id));
        
        var result = db.patients.updateOne(
            { _id: ObjectId(patientId) },
            { $addToSet: { packages: { $each: packageIds } } }
        );
        
        if (result.modifiedCount > 0) {
            print(`✅ Paciente ${patientId} atualizado com ${packageIds.length} pacote(s)`);
            updatedCount++;
        } else {
            print(`⚠️  Paciente ${patientId} não modificado (já tinha os pacotes?)`);
        }
    }
}

// 4. Verificação final
print("\nVerificando pacientes atualizados...");
var patientsWithPackages = db.patients.countDocuments({
    packages: { $exists: true, $not: { $size: 0 } }
});

print(`\n🎉 Migração concluída!`);
print(`- ${updatedCount} pacientes atualizados`);
print(`- ${patientsWithPackages} pacientes com pacotes no total`);
print(`- ${Object.keys(patientPackagesMap).length} pacientes tinham pacotes associados`);