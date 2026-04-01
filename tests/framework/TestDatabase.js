// tests/framework/TestDatabase.js
// Gerenciamento de banco de dados para testes E2E

import mongoose from 'mongoose';

// Importa todos os modelos para garantir registro
import '../../models/Patient.js';
import '../../models/Doctor.js';
import '../../models/Package.js';
import '../../models/Appointment.js';
import '../../models/Session.js';
import '../../models/Invoice.js';
import '../../models/Payment.js';

export class TestDatabase {
  constructor() {
    this.connection = null;
    this.originalUri = process.env.MONGO_URI;
  }

  /**
   * Conecta ao banco de teste (isola do desenvolvimento)
   */
  async connect() {
    // Usa banco 'crm_test_e2e' isolado
    const testUri = this.originalUri.replace(/\/[^/]*$/, '/crm_test_e2e');
    
    console.log('🗄️  Conectando ao banco de teste:', testUri);
    
    this.connection = await mongoose.connect(testUri, {
      readPreference: 'primary',
      retryWrites: true,
      w: 'majority',
      writeConcern: { w: 'majority', j: true },
      maxPoolSize: 50,
      minPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000
    });
    
    // Limpa TUDO antes de começar (garante determinismo)
    await this.cleanAll();
    
    return this.connection;
  }

  /**
   * Limpa todas as coleções (determinismo garantido)
   */
  async cleanAll() {
    console.log('🧹 Limpando banco de teste...');
    
    const collections = await this.connection.connection.db.listCollections().toArray();
    
    for (const collection of collections) {
      // Pula system indexes
      if (collection.name.startsWith('system.')) continue;
      
      await this.connection.connection.db.collection(collection.name).deleteMany({});
    }
    
    console.log('✅ Banco limpo');
  }

  /**
   * Reseta para estado inicial (entre testes)
   */
  async reset() {
    await this.cleanAll();
    
    // Limpa também outbox e eventos
    await this.connection.connection.db.collection('outboxevents').deleteMany({});
  }

  /**
   * Fecha conexão
   */
  async disconnect() {
    if (this.connection) {
      await this.connection.connection.close();
      console.log('🔌 Desconectado do banco de teste');
    }
  }

  /**
   * Verifica se está usando banco de teste (segurança)
   */
  validateTestDatabase() {
    const dbName = this.connection?.connection?.db?.databaseName;
    
    if (!dbName?.includes('test')) {
      throw new Error(`
        ❌ SEGURANÇA: Tentando usar banco não-teste: ${dbName}
        
        O framework só pode rodar em bancos com 'test' no nome.
        Verifique sua variável MONGO_URI.
      `);
    }
    
    return true;
  }
}
