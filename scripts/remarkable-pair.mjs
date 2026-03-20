#!/usr/bin/env node
import { randomUUID } from "node:crypto";

const webappHost = process.env.REMARKABLE_WEBAPP_HOST ?? "https://webapp-prod.cloud.remarkable.engineering";
const oneTimeCode = process.env.REMARKABLE_ONE_TIME_CODE;
const deviceID = process.env.REMARKABLE_DEVICE_ID ?? randomUUID();
const deviceDesc = process.env.REMARKABLE_DEVICE_DESC ?? "desktop-linux";

if (!oneTimeCode) {
  console.error("Missing REMARKABLE_ONE_TIME_CODE environment variable.");
  process.exit(1);
}

const response = await fetch(`${webappHost}/token/json/2/device/new`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    code: oneTimeCode,
    deviceID,
    deviceDesc
  })
});

if (!response.ok) {
  console.error(`Pairing failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}

const token = (await response.text()).trim();
console.log("Device ID:", deviceID);
console.log("Device Desc:", deviceDesc);
console.log("REMARKABLE_DEVICE_TOKEN=");
console.log(token);
