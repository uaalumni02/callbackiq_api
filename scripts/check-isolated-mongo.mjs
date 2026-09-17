import { MongoMemoryReplSet } from 'mongodb-memory-server';
let server;
try {
 server = new MongoMemoryReplSet({ replSet: { count: 1, storageEngine: 'wiredTiger' }, instanceOpts: [{ launchTimeout: 15000 }] });
 await server.start();
 console.log('Isolated MongoDB replica-set startup passed. No external database used.');
} catch (error) {
 console.error(`Isolated MongoDB unavailable: ${error.message}. Use the offline-scale CI workflow or a host that supports MongoDB. No database test was certified.`);
 process.exitCode = 1;
} finally { await server?.stop(); }
