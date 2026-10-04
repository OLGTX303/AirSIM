import assert from "node:assert/strict";
import test from "node:test";
import { validateRegistration } from "../src/index.mjs";

test("Air8000 registration is device-authenticated and does not require APNs", () => {
  const device = {
    device_id: "air8000-test",
    device_secret: "per-device-secret-value",
    device_type: "air8000a",
    hardware_model: "Air8000A",
    serial_number: "AIR8000-SN-001",
    imei: "123456789012345",
    protocol_version: "airsim.air8000.v1",
    capabilities: { voice: true, sms: true, gnss: true },
  };
  assert.equal(validateRegistration(device, "com.example.airsim"), "");
  assert.match(validateRegistration({ ...device, hardware_model: "other" }, "com.example.airsim"), /Air8000/);
  assert.match(validateRegistration({ ...device, device_secret: "short" }, "com.example.airsim"), /identity/);
  assert.match(validateRegistration({ ...device, imei: "not-an-imei" }, "com.example.airsim"), /Air8000/);
});
