import { Queue } from 'bullmq';

const queue = new Queue('followupQueue', {
    connection: { host: 'localhost', port: 6379 }
});

// ⚠️ Use um ID qualquer só pra teste.
// (Depois substituímos por um real do Mongo)
await queue.add('test', { followupId: '66f1b23ea1c48bb5cecb9999' });

console.log('✅ Job de teste adicionado à fila!');
process.exit(0);
