# 🗄️ Migração MongoDB: test → fono_inova_prod

## ⚠️ IMPORTANTE: NÃO MUDE O URI ANTES DE MIGRAR OS DADOS

Se você apenas trocar o nome no URI sem migrar os dados, o sistema vai conectar em um banco VAZIO.

---

## 🚀 Passo 1: Fazer backup do banco atual (segurança)

Abra o terminal e rode:

```bash
mongodump --uri="mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test?retryWrites=true&w=majority&appName=Cluster0" --out=./backup_mongo_test_$(date +%Y%m%d)
```

Isso cria uma pasta `backup_mongo_test_20260414` com todos os dados.

---

## 🚀 Passo 2: Restaurar os dados no novo banco `fono_inova_prod`

```bash
mongorestore --uri="mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0" --dir=./backup_mongo_test_$(date +%Y%m%d)/test --nsInclude='test.*' --nsFrom='test.*' --nsTo='fono_inova_prod.*'
```

> 💡 Se `mongorestore` não estiver instalado, use o MongoDB Compass ou o Atlas Data Explorer para importar as collections.

---

## 🚀 Passo 3: Verificar se a migração deu certo

Acesse o MongoDB Atlas → Database → Cluster0 → Collections

Você deve ver:
- ❌ `test` (antigo, com dados ainda lá)
- ✅ `fono_inova_prod` (novo, com os mesmos dados)

---

## 🚀 Passo 4: Atualizar o `MONGODB_URI` no Render

### Web Service (`fono-inova-crm-back`)
Vá em Environment e atualize:
```
MONGODB_URI=mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/fono_inova_prod?retryWrites=true&w=majority&appName=Cluster0
```

### Worker (`crm-worker`)
Vá em Environment e atualize para o mesmo valor acima.

---

## 🚀 Passo 5: Deploy

Clique em **Manual Deploy** em ambos os serviços.

---

## 🗑️ Passo 6: (Opcional, depois de confirmar tudo ok)

Apague o banco `test` do Atlas para não pagar storage desnecessário.
