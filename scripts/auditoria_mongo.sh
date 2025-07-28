
# Configurações do MongoDB
DB_NAME="teste"
COLLECTION="appointments"

# 1. Verificar agendamentos para hoje (15/07/2025)
echo "=== AGENDAMENTOS PARA 15/07/2025 ==="
mongosh --quiet $DB_NAME --eval "
db.$COLLECTION.find({
    date: {
        \$gte: ISODate('2025-07-15T00:00:00.000Z'),
        \$lte: ISODate('2025-07-15T23:59:59.999Z')
    }
}).pretty()
"

# 2. Verificar agendamentos com o médico "teste"
echo -e "\n=== AGENDAMENTOS COM MÉDICO 'TESTE' ==="
mongosh --quiet $DB_NAME --eval "
db.$COLLECTION.find({
    'doctor.fullName': 'teste'
}).pretty()
"

# 3. Verificar se o ID do médico "teste" existe no sistema
echo -e "\n=== VERIFICAÇÃO DO MÉDICO 'TESTE' ==="
mongosh --quiet $DB_NAME --eval "
db.doctors.find({
    _id: ObjectId('686024fb74dcf94b84ade15a')
}).pretty()
"

# 4. Contagem consolidada
echo -e "\n=== RESUMO ==="
mongosh --quiet $DB_NAME --eval "
print('Agendamentos hoje: ' + 
    db.$COLLECTION.countDocuments({
        date: {
            \$gte: ISODate('2025-07-15T00:00:00.000Z'),
            \$lte: ISODate('2025-07-15T23:59:59.999Z')
        }
    })
);
print('Agendamentos médico teste: ' + 
    db.$COLLECTION.countDocuments({
        'doctor.fullName': 'teste'
    })
);
"