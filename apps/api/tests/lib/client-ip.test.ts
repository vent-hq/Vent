import assert from "node:assert/strict";
import { after, test } from "node:test";
import Fastify from "fastify";
import { getClientIp } from "../../src/lib/client-ip.js";
import { agentAuthRoutes } from "../../src/routes/agent-auth.js";

const previousApp = process.env["FLY_APP_NAME"];
after(() => {
  if (previousApp === undefined) delete process.env["FLY_APP_NAME"];
  else process.env["FLY_APP_NAME"] = previousApp;
});

test("Fly ingress uses Fly's client address instead of caller-supplied forwarding chains", async () => {
  process.env["FLY_APP_NAME"] = "vent-api";
  const app = Fastify({ trustProxy: false });
  app.get("/ip", async request => ({ ip: getClientIp(request) }));
  try {
    for (const remoteAddress of ["172.16.1.1", "::ffff:172.16.1.1"]) {
      const response = await app.inject({ url: "/ip", remoteAddress, headers: {
        "fly-client-ip": "203.0.113.7", "x-forwarded-for": "192.0.2.99, 192.0.2.100",
      } });
      assert.equal(response.json().ip, "203.0.113.7");
    }
  } finally { await app.close(); }
});

test("private IPv6 requests cannot impersonate Fly Proxy", async () => {
  process.env["FLY_APP_NAME"] = "vent-api";
  const app = Fastify({ trustProxy: false });
  app.get("/ip", async request => ({ ip: getClientIp(request) }));
  try {
    const response = await app.inject({ url: "/ip", remoteAddress: "fdaa:1:2:3::4", headers: {
      "fly-client-ip": "203.0.113.7", "x-forwarded-for": "192.0.2.99",
    } });
    assert.equal(response.json().ip, "fdaa:1:2:3::4");
  } finally { await app.close(); }
});

test("non-Fly traffic ignores forwarded headers", async () => {
  delete process.env["FLY_APP_NAME"];
  const app = Fastify({ trustProxy: false });
  app.get("/ip", async request => ({ ip: getClientIp(request) }));
  try {
    const response = await app.inject({ url: "/ip", remoteAddress: "192.0.2.1", headers: {
      "fly-client-ip": "203.0.113.7", "x-forwarded-for": "192.0.2.99",
    } });
    assert.equal(response.json().ip, "192.0.2.1");
  } finally { await app.close(); }
});

test("plain and IPv4-mapped addresses use the same client identity", async () => {
  const app = Fastify({ trustProxy: false });
  app.get("/ip", async request => ({ ip: getClientIp(request) }));
  try {
    delete process.env["FLY_APP_NAME"];
    for (const remoteAddress of ["192.0.2.1", "::ffff:192.0.2.1"]) {
      assert.equal((await app.inject({ url: "/ip", remoteAddress })).json().ip, "192.0.2.1");
    }
    process.env["FLY_APP_NAME"] = "vent-api";
    for (const claimed of ["192.0.2.1", "::FFFF:192.0.2.1"]) {
      assert.equal((await app.inject({ url: "/ip", remoteAddress: "172.16.1.1",
        headers: { "fly-client-ip": claimed },
      })).json().ip, "192.0.2.1");
    }
  } finally { await app.close(); }
});

test("missing or malformed Fly headers and loopback peers use the socket address", async () => {
  process.env["FLY_APP_NAME"] = "vent-api";
  const app = Fastify({ trustProxy: false });
  app.get("/ip", async request => ({ ip: getClientIp(request) }));
  try {
    for (const claimed of [undefined, "not-an-ip", "192.0.2.1, 192.0.2.2", ["192.0.2.1", "192.0.2.2"]]) {
      const response = await app.inject({ url: "/ip", remoteAddress: "172.16.1.1",
        headers: claimed === undefined ? {} : { "fly-client-ip": claimed },
      });
      assert.equal(response.json().ip, "172.16.1.1");
    }
    const response = await app.inject({ url: "/ip", remoteAddress: "127.0.0.1", headers: {
      "fly-client-ip": "203.0.113.7",
    } });
    assert.equal(response.json().ip, "127.0.0.1");
  } finally { await app.close(); }
});

test("GitHub bootstrap's separate limit uses the same verified client identity", async () => {
  process.env["FLY_APP_NAME"] = "vent-api";
  const app = Fastify({ trustProxy: false });
  await app.register(agentAuthRoutes);
  try {
    for (let i = 0; i < 5; i++) {
      assert.equal((await app.inject({ method: "POST", url: "/auth/github", payload: {},
        remoteAddress: "172.16.1.1", headers: { "fly-client-ip": "203.0.113.81" },
      })).statusCode, 400);
    }
    assert.equal((await app.inject({ method: "POST", url: "/auth/github", payload: {},
      remoteAddress: "172.16.1.1", headers: { "fly-client-ip": "203.0.113.81" },
    })).statusCode, 429);
    assert.equal((await app.inject({ method: "POST", url: "/auth/github", payload: {},
      remoteAddress: "172.16.1.1", headers: { "fly-client-ip": "203.0.113.82" },
    })).statusCode, 400);
  } finally { await app.close(); }
});
