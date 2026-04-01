#!/usr/bin/env node
// back/scripts/debug-event.js
/**
 * CLI para debug de eventos
 * 
 * Uso:
 *   node debug-event.js <correlationId>
 *   node debug-event.js --last
 *   node debug-event.js --failed
 */

import mongoose from 'mongoose';
import { EventDebugger } from '../infra/observability/eventDebugger.js';
import EventStore from '../models/EventStore.js';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/crm';

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage:');
    console.log('  node debug-event.js <correlationId>     Debug specific correlationId');
    console.log('  node debug-event.js --last              Debug last event flow');
    console.log('  node debug-event.js --failed            List recent failed flows');
    console.log('  node debug-event.js --stats             Show event statistics');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log('🔌 Connected to database\n');

  const debugger = new EventDebugger(EventStore);

  try {
    if (args[0] === '--last') {
      // Pega o último correlationId
      const lastEvent = await EventStore.findOne().sort({ createdAt: -1 });
      if (lastEvent) {
        console.log(`Debugging last event: ${lastEvent.correlationId}\n`);
        await debugger.debugInteractive(lastEvent.correlationId);
      } else {
        console.log('No events found');
      }
    } 
    else if (args[0] === '--failed') {
      // Lista fluxos falhos recentes
      const failedEvents = await EventStore.find({
        $or: [
          { status: 'failed' },
          { status: 'error' },
          { eventType: 'DLQ_MESSAGE_ADDED' }
        ]
      }).sort({ createdAt: -1 }).limit(10);

      console.log('Recent failed flows:\n');
      const correlationIds = [...new Set(failedEvents.map(e => e.correlationId))];
      
      for (const cid of correlationIds) {
        const analysis = await debugger.debugCorrelationId(cid);
        console.log(`🔴 ${cid.substring(0, 30)}... - ${analysis.summary.status} - ${analysis.summary.totalEvents} events`);
      }
    }
    else if (args[0] === '--stats') {
      // Estatísticas gerais
      const stats = await EventStore.aggregate([
        {
          $group: {
            _id: '$eventType',
            count: { $sum: 1 },
            lastEvent: { $max: '$createdAt' }
          }
        },
        { $sort: { count: -1 } }
      ]);

      console.log('Event Statistics:\n');
      console.log('Event Type'.padEnd(40), 'Count'.padEnd(10), 'Last Event');
      console.log('-'.repeat(80));
      stats.forEach(s => {
        console.log(
          s._id.padEnd(40),
          String(s.count).padEnd(10),
          s.lastEvent.toISOString()
        );
      });
    }
    else {
      // Debug correlationId específico
      const correlationId = args[0];
      await debugger.debugInteractive(correlationId);
      
      // Gera diagrama Mermaid
      const analysis = await debugger.debugCorrelationId(correlationId);
      console.log('\n📊 MERMAID DIAGRAM:');
      console.log('```mermaid');
      console.log(debugger.generateMermaidDiagram(
        await EventStore.find({ correlationId }).sort({ createdAt: 1 })
      ));
      console.log('```');
    }
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await mongoose.disconnect();
  }
}

main();
