import { Socket } from "node:net";
import { afterAll, afterEach, expect } from "vitest";

// The copied tests inject fake RPC clients and email transports. Fail closed if
// any test accidentally reaches the real global fetch or a TCP/TLS connection.
const attempts: string[] = [];
const originalFetch = globalThis.fetch;
const originalConnect = Socket.prototype.connect;
function deny(kind: string): never {
  attempts.push(kind);
  throw new Error(`Network access is forbidden in Backend unit tests (${kind})`);
}

globalThis.fetch = async () => deny("fetch");
Socket.prototype.connect = function () { return deny("socket.connect"); };

afterEach(() => {
  const observed = attempts.splice(0);
  expect(observed, "No unit test may attempt real network access").toEqual([]);
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  Socket.prototype.connect = originalConnect;
});
