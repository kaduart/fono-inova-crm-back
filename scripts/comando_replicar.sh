#!/bin/bash
# Comando direto para replicar test → crm_development

echo "🔄 Replicando banco test → crm_development"
echo ""

# 1. Criar diretório temporário
mkdir -p /tmp/mongodb_replica_$(date +%Y%m%d)
cd /tmp/mongodb_replica_$(date +%Y%m%d)

# 2. Exportar banco test (origem)
echo "📥 Exportando banco 'test'..."
mongodump --uri "mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test"

# 3. Dropar banco crm_development (destino)
echo "🗑️  Limpando banco 'crm_development'..."
mongosh "mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development" --eval "db.dropDatabase()"

# 4. Importar para crm_development
echo "📤 Importando para 'crm_development'..."
mongorestore --uri "mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/crm_development" --nsFrom "test.*" --nsTo "crm_development.*" ./test

# 5. Limpar
cd ..
rm -rf /tmp/mongodb_replica_$(date +%Y%m%d)

echo ""
echo "✅ Réplica concluída!"
echo "Banco 'crm_development' agora tem os mesmos dados de 'test'"
