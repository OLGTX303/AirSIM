"""Direct Windows BLE diagnostic for AirSIM Air8000 provisioning."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from typing import Any

from bleak import BleakClient, BleakScanner

SERVICE = "7b9e8000-a8f0-4c4e-9a5b-4b80c8000001"
STATUS = "7b9e8000-a8f0-4c4e-9a5b-4b80c8000002"
CONFIG = "7b9e8000-a8f0-4c4e-9a5b-4b80c8000003"
IDENTITY = "7b9e8000-a8f0-4c4e-9a5b-4b80c8000004"
NETWORKS = "7b9e8000-a8f0-4c4e-9a5b-4b80c8000005"


def decode(raw: bytearray | bytes) -> Any:
    text = bytes(raw).decode("utf-8", errors="replace")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


async def find_device(seconds: float, name_fragment: str):
    print(f"[1/5] Scanning BLE for {seconds:.0f}s...")
    found = await BleakScanner.discover(timeout=seconds, return_adv=True)
    candidates = []
    for address, pair in found.items():
        device, advertisement = pair
        name = advertisement.local_name or device.name or ""
        uuids = [uuid.lower() for uuid in (advertisement.service_uuids or [])]
        print(f"  {name or '(unnamed)':20} {address:18} RSSI={advertisement.rssi}")
        if name_fragment.lower() in name.lower() or SERVICE in uuids:
            candidates.append(device)
    if not candidates:
        raise RuntimeError("No Air8000 candidate found; check Bluetooth and the device advertising log")
    return candidates[0]


async def test(args: argparse.Namespace) -> int:
    device = await find_device(args.scan_seconds, args.name)
    disconnected = asyncio.Event()

    def on_disconnect(_client: BleakClient) -> None:
        print("[BLE] GATT disconnected")
        disconnected.set()

    print(f"[2/5] Connecting to {device.name or device.address} ({device.address})...")
    async with BleakClient(device, disconnected_callback=on_disconnect, timeout=args.timeout) as client:
        if not client.is_connected:
            raise RuntimeError("GATT connection did not complete")
        print("[3/5] GATT connected")
        if client.services.get_service(SERVICE) is None:
            raise RuntimeError(f"Required service {SERVICE} was not found")
        print("      service: OK")
        identity = decode(await client.read_gatt_char(IDENTITY))
        print(f"      identity: {json.dumps(identity, ensure_ascii=False)}")
        notification_count = 0
        network_count = 0

        def on_notification(_sender: int, raw: bytearray) -> None:
            nonlocal notification_count, network_count
            notification_count += 1
            value = decode(raw)
            if isinstance(value, dict) and value.get("type") == "wifi_network":
                network_count += 1
                network = value.get("network", {})
                print(f"[BLE] Wi-Fi network: {network.get('ssid', '?')} RSSI={network.get('rssi', '?')}")
            else:
                print(f"[BLE] notification: {json.dumps(value, ensure_ascii=False)}")

        await client.start_notify(STATUS, on_notification)
        await client.start_notify(NETWORKS, on_notification)
        print("[4/5] Notifications enabled")
        request = {"pairing_code": args.pairing_code, "op": "scan"}
        await client.write_gatt_char(CONFIG, json.dumps(request, separators=(",", ":")).encode(), response=True)
        print("[5/5] Wi-Fi scan request sent; waiting for notifications...")
        await asyncio.sleep(args.wait_seconds)
        if disconnected.is_set() or not client.is_connected:
            print("RESULT: FAIL - GATT disconnected during Wi-Fi scan")
            return 2
        if network_count == 0:
            print("RESULT: FAIL - no Wi-Fi network notifications received")
            return 3
        print(f"RESULT: PASS - GATT stayed connected; {notification_count} notification(s) received")
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Test a real Air8000 BLE provisioning service")
    parser.add_argument("--name", default="A8-", help="BLE name fragment")
    parser.add_argument("--pairing-code", default="000000")
    parser.add_argument("--scan-seconds", type=float, default=8)
    parser.add_argument("--wait-seconds", type=float, default=12)
    parser.add_argument("--timeout", type=float, default=15)
    args = parser.parse_args()
    try:
        return asyncio.run(test(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:
        print(f"RESULT: FAIL - {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
