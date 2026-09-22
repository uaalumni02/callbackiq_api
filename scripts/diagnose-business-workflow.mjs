#!/usr/bin/env node
// Read-only diagnostics. Never print a MongoDB URI, password, cookie, or token.
import 'dotenv/config';
import mongoose from 'mongoose';
const base = (process.argv.find(value => value.startsWith('--api='))?.slice(6) || 'http://localhost:3000').replace(/\/$/, '');
const report = { checkedAt: new Date().toISOString(), api: {}, database: {} };
for (const path of ['/api/health/live', '/api/health/ready']) {
  const started = Date.now();
  try {
    const response = await fetch(base + path, { signal: AbortSignal.timeout(6000) });
    report.api[path] = { status: response.status, durationMs: Date.now() - started };
  } catch (error) { report.api[path] = { error: error.name, durationMs: Date.now() - started }; }
}
const uri = process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL;
const started = Date.now();
try {
  if (!uri) report.database = { status: 'not_configured' };
  else {
    await mongoose.connect(uri, { autoIndex: false, serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, socketTimeoutMS: 5000 });
    await mongoose.connection.db.admin().command({ ping: 1 }, { maxTimeMS: 3000 });
    report.database = { status: 'reachable', durationMs: Date.now() - started };
  }
} catch (error) { report.database = { status: 'unavailable', error: error.name, durationMs: Date.now() - started }; }
finally { await mongoose.disconnect(); }
console.log(JSON.stringify(report, null, 2));
if (report.database.status !== 'reachable' || Object.values(report.api).some(result => result.status !== 200)) process.exitCode = 1;
