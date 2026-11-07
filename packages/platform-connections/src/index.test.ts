import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { PlatformConfig } from "@vent/shared";
import {
  decryptPlatformConfig,
  encryptPlatformConfig,
  type EncryptedPlatformConfig,
} from "./index.js";

const masterKey = "12".repeat(32);
const previousKey = process.env["PLATFORM_CONNECTIONS_MASTER_KEY"];
process.env["PLATFORM_CONNECTIONS_MASTER_KEY"] = masterKey;
after(() => {
  if (previousKey === undefined) delete process.env["PLATFORM_CONNECTIONS_MASTER_KEY"];
  else process.env["PLATFORM_CONNECTIONS_MASTER_KEY"] = previousKey;
});

const bland: PlatformConfig = {
  provider: "bland",
  bland_api_key: "FAKE_BLAND_KEY",
  task: "Test an appointment booking agent",
  tools: [{ headers: { Authorization: "Bearer FAKE_NESTED_KEY" } }],
  request_data: { arbitrary_name: "FAKE_OTHER_SECRET", nested: [{ password: "FAKE_PASSWORD" }] },
  wait_for_greeting: false,
  temperature: 0,
};
const platforms: PlatformConfig[] = [
  bland,
  { provider: "vapi", vapi_api_key: "FAKE_VAPI_KEY", vapi_assistant_id: "assistant" },
  { provider: "retell", retell_api_key: "FAKE_RETELL_KEY", retell_agent_id: "agent" },
  { provider: "elevenlabs", elevenlabs_api_key: "FAKE_ELEVEN_KEY", elevenlabs_agent_id: "agent" },
  {
    provider: "livekit",
    livekit_api_key: "FAKE_LIVEKIT_KEY",
    livekit_api_secret: "FAKE_LIVEKIT_SECRET",
    livekit_url: "wss://user:FAKE_URL_PASSWORD@example.com?token=FAKE_URL_TOKEN",
  },
];

for (const platform of platforms) {
  test(`${platform.provider}: the full configuration round-trips without plaintext storage`, () => {
    const encrypted = encryptPlatformConfig(platform);
    assert.deepEqual(decryptPlatformConfig(encrypted), platform);
    assert.equal(JSON.stringify(encrypted).includes("FAKE_"), false);
    assert.equal(Buffer.from(encrypted.tag, "base64").length, 16);
  });
}

test("encrypting the same config produces different ciphertext", () => {
  const first = encryptPlatformConfig(bland);
  const second = encryptPlatformConfig(bland);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("tampered ciphertext, IV, or authentication tag cannot decrypt", () => {
  const encrypted = encryptPlatformConfig(bland);
  for (const field of ["ciphertext", "iv", "tag"] as const) {
    const bytes = Buffer.from(encrypted[field], "base64");
    bytes[0] = bytes[0]! ^ 1;
    assert.throws(() => decryptPlatformConfig({ ...encrypted, [field]: bytes.toString("base64") }));
  }
  assert.throws(() => decryptPlatformConfig({
    ...encrypted, tag: Buffer.from(encrypted.tag, "base64").subarray(0, 4).toString("base64"),
  }));
});

test("wrong, missing, and invalid master keys fail without echoing credentials", () => {
  const encrypted = encryptPlatformConfig(bland);
  try {
    process.env["PLATFORM_CONNECTIONS_MASTER_KEY"] = "34".repeat(32);
    assert.throws(() => decryptPlatformConfig(encrypted));
    delete process.env["PLATFORM_CONNECTIONS_MASTER_KEY"];
    assert.throws(() => decryptPlatformConfig(encrypted), /is required/);
    process.env["PLATFORM_CONNECTIONS_MASTER_KEY"] = "FAKE_INVALID_MASTER_KEY";
    assert.throws(() => decryptPlatformConfig(encrypted), (error: Error) => {
      assert.equal(error.message.includes("FAKE_INVALID_MASTER_KEY"), false);
      return true;
    });
  } finally {
    process.env["PLATFORM_CONNECTIONS_MASTER_KEY"] = masterKey;
  }
});

test("unsupported encryption algorithms are rejected", () => {
  const encrypted = encryptPlatformConfig(bland);
  const unsupported = { ...encrypted, alg: "unsupported" } as unknown as EncryptedPlatformConfig;
  assert.throws(() => decryptPlatformConfig(unsupported), /Unsupported.*algorithm/);
});
