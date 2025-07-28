// migratePackagesToPatients-viaPayments.js

print("Iniciando migração de pacotes para pacientes via pagamentos...");

// 1. Coletar todos os pagamentos com pacotes
print("\nColetando pagamentos com pacotes...");
var paymentsWithPackages = db.payments.find({
    package: { $exists: true, $ne: null }
}).toArray();

print(`🔍 ${paymentsWithPackages.length} pagamentos com pacotes encontrados`);

// Se não encontrou, tentar campo alternativo
if (paymentsWithPackages.length === 0) {
    print("⚠️  Tentando campo alternativo 'packages'...");
    paymentsWithPackages = db.payments.find({
        packages: { $exists: true, $ne: null }
    }).toArray();
    print(`🔍 ${paymentsWithPackages.length} pagamentos com 'packages' encontrados`);
}

// 2. Criar mapa de pacotes por paciente
print("\nCriando mapa paciente->pacotes...");
var patientPackagesMap = {};

paymentsWithPackages.forEach(function(payment) {
    try {
        // Verificar campos obrigatórios
        if (!payment.patient) {
            print(`❌ Pagamento ${payment._id} sem paciente associado`);
            return;
        }
        
        if (!payment.package && !payment.packages) {
            print(`❌ Pagamento ${payment._id} sem pacote associado`);
            return;
        }
        
        const patientId = payment.patient.toString();
        const packageIds = payment.package 
            ? [payment.package.toString()] 
            : payment.packages.map(p => p.toString());
        
        if (!patientPackagesMap[patientId]) {
            patientPackagesMap[patientId] = new Set();
        }
        
        packageIds.forEach(packageId => {
            patientPackagesMap[patientId].add(packageId);
            print(`⚡ Paciente ${patientId} + pacote ${packageId}`);
        });
    } catch (e) {
        print(`🔥 ERRO no pagamento ${payment._id}: ${e}`);
    }
});

// 3. Atualizar pacientes com seus pacotes
print("\nAtualizando pacientes...");
var updatedCount = 0;
var patientsWithErrors = 0;

for (var patientId in patientPackagesMap) {
    if (patientPackagesMap.hasOwnProperty(patientId)) {
        const packageIds = Array.from(patientPackagesMap[patientId]).map(id => ObjectId(id));
        
        try {
            const result = db.patients.updateOne(
                { _id: ObjectId(patientId) },
                { $addToSet: { packages: { $each: packageIds } } }
            );
            
            if (result.modifiedCount > 0) {
                print(`✅ Paciente ${patientId} atualizado com ${packageIds.length} pacote(s)`);
                updatedCount++;
            } else {
                // Verificar se já tinha os pacotes
                const patient = db.patients.findOne({ _id: ObjectId(patientId) });
                const hasAll = packageIds.every(id => 
                    patient.packages && 
                    patient.packages.some(p => p.toString() === id.toString())
                );
                
                if (hasAll) {
                    print(`⏩ Paciente ${patientId} já tinha todos os pacotes`);
                } else {
                    print(`⚠️  Falha ao atualizar paciente ${patientId}: ${JSON.stringify(result)}`);
                    patientsWithErrors++;
                }
            }
        } catch (e) {
            print(`🔥 ERRO CRÍTICO no paciente ${patientId}: ${e}`);
            patientsWithErrors++;
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
print(`- ${patientsWithErrors} pacientes com erros na atualização`);

// 5. Estatísticas adicionais
print("\n📊 Estatísticas de pagamentos processados:");
print(`- Total de pagamentos com pacotes: ${paymentsWithPackages.length}`);
print(`- Pagamentos vinculados a pacientes: ${Object.keys(patientPackagesMap).length}`);