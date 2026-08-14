#!/usr/bin/env node
import http from "node:http";
import { performance } from "node:perf_hooks";
import { Server as SocketIOServer } from "socket.io";
import { io as createSocketClient } from "socket.io-client";

import SocketService from "../src/services/socket.service.js";

const clientsWanted = Math.max(1, Number(process.env.PERF_SOCKET_CLIENTS || 50));
const rounds = Math.max(1, Number(process.env.PERF_SOCKET_ROUNDS || 10));
const timeoutMs = Math.max(500, Number(process.env.PERF_SOCKET_TIMEOUT_MS || 5000));
const businessId = "perf-business";
const eventName = "perf:fanout";

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
};

const server = http.createServer();
const io = new SocketIOServer(server, { transports: ["websocket"] });
io.on("connection", (socket) => {
  socket.join(`business:${businessId}`);
  socket.emit("perf:ready");
});
SocketService.initialize(io);

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const target = `http://127.0.0.1:${server.address().port}`;
const clients = [];

const connectOne = (index) =>
  new Promise((resolve, reject) => {
    const started = performance.now();
    const client = createSocketClient(target, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    const timer = setTimeout(() => {
      client.close();
      reject(new Error(`Client ${index} connection timeout`));
    }, timeoutMs);
    client.once("perf:ready", () => {
      clearTimeout(timer);
      clients.push(client);
      resolve(performance.now() - started);
    });
    client.once("connect_error", (error) => {
      clearTimeout(timer);
      client.close();
      reject(error);
    });
  });

const waitForRound = (sequence) => {
  const started = performance.now();
  const arrivals = [];
  const waits = clients.map(
    (client, index) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          client.off(eventName, onEvent);
          reject(new Error(`Client ${index} missed fan-out round ${sequence}`));
        }, timeoutMs);
        const onEvent = (payload) => {
          if (payload?.sequence !== sequence) return;
          clearTimeout(timer);
          client.off(eventName, onEvent);
          const latency = performance.now() - started;
          arrivals.push(latency);
          resolve(latency);
        };
        client.on(eventName, onEvent);
      }),
  );
  return { started, arrivals, waits };
};

try {
  const connectLatencies = await Promise.all(
    Array.from({ length: clientsWanted }, (_, index) => connectOne(index)),
  );

  const fanoutLatencies = [];
  const roundDurations = [];
  for (let sequence = 1; sequence <= rounds; sequence += 1) {
    const round = waitForRound(sequence);
    const emitted = SocketService.emitToBusiness(businessId, eventName, {
      sequence,
      emittedAt: Date.now(),
    });
    if (!emitted) throw new Error("SocketService refused the fan-out emit");
    const latencies = await Promise.all(round.waits);
    fanoutLatencies.push(...latencies);
    roundDurations.push(performance.now() - round.started);
  }

  console.log(
    JSON.stringify(
      {
        mode: "in-process-local-socket-service-fanout",
        clients: clients.length,
        rounds,
        deliveries: fanoutLatencies.length,
        connectionLatencyMs: {
          p50: Number(percentile(connectLatencies, 0.5).toFixed(2)),
          p95: Number(percentile(connectLatencies, 0.95).toFixed(2)),
          p99: Number(percentile(connectLatencies, 0.99).toFixed(2)),
          max: Number(Math.max(...connectLatencies).toFixed(2)),
        },
        fanoutDeliveryLatencyMs: {
          p50: Number(percentile(fanoutLatencies, 0.5).toFixed(2)),
          p95: Number(percentile(fanoutLatencies, 0.95).toFixed(2)),
          p99: Number(percentile(fanoutLatencies, 0.99).toFixed(2)),
          max: Number(Math.max(...fanoutLatencies).toFixed(2)),
        },
        fullRoundLatencyMs: {
          p50: Number(percentile(roundDurations, 0.5).toFixed(2)),
          p95: Number(percentile(roundDurations, 0.95).toFixed(2)),
          p99: Number(percentile(roundDurations, 0.99).toFixed(2)),
          max: Number(Math.max(...roundDurations).toFixed(2)),
        },
      },
      null,
      2,
    ),
  );
} finally {
  for (const client of clients) client.close();
  SocketService.reset();
  await new Promise((resolve) => io.close(resolve));
  if (server.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
}
