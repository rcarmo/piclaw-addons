import { test, expect } from "bun:test";
import { EventEmitter } from "node:events";
import { PeerDiscovery } from "./discovery.js";
function fixture() {
  let calls = 0,
    closed = 0;
  const service = Object.assign(new EventEmitter(), {
    records: () => [
      { type: "A", data: "192.168.1.2", ttl: 4500 },
      { type: "A", data: "10.0.0.1", ttl: 4500 },
    ],
    stop: (cb: any) => cb(),
  });
  const browser = Object.assign(new EventEmitter(), { stop: () => {} });
  const bonjour = {
    publish: () => service,
    find: () => browser,
    unpublishAll: (cb: any) => cb(),
    destroy: (cb: any) => {
      closed++;
      cb();
    },
  };
  let options: any;
  const factory = async (value: any) => {
    calls++;
    options = value;
    return bonjour;
  };
  const discovery = new PeerDiscovery({
    instanceId: "11".repeat(32),
    endpointId: "11".repeat(32),
    name: "test",
    port: 1234,
    interfaceAddress: "192.168.1.2",
    factory,
  });
  return {
    discovery,
    service,
    browser,
    calls: () => calls,
    closed: () => closed,
    options: () => options,
  };
}
const candidate = (id = "22".repeat(32)) => ({
  txt: { v: "1", endpoint: id, instance: id },
  name: "other",
  fqdn: "other._piclaw-peer._udp.local",
  addresses: ["192.168.1.3"],
  port: 4567,
  ttl: 1,
});
test("discovery construction does not import Bonjour, open sockets or timers; lifecycle releases", async () => {
  const f = fixture();
  expect(f.calls()).toBe(0);
  expect(f.discovery.status().active).toBe(false);
  await f.discovery.stop();
  expect(f.closed()).toBe(0);
  await f.discovery.start();
  expect(f.calls()).toBe(1);
  expect(f.options()).toEqual({
    interface: "192.168.1.2",
    bind: "0.0.0.0",
    ip: "224.0.0.251",
    port: 5353,
  });
  expect(f.service.records()).toEqual([
    { type: "A", data: "192.168.1.2", ttl: 120 },
  ]);
  await f.discovery.stop();
  expect(f.closed()).toBe(1);
  expect(f.browser.listenerCount("up")).toBe(0);
});
test("self/spoofed/invalid hints ignored; candidates bounded, deduplicated and expired", async () => {
  const f = fixture();
  await f.discovery.start();
  try {
    f.browser.emit("up", candidate("11".repeat(32)));
    f.browser.emit("up", { ...candidate(), txt: { v: "1", endpoint: "bad" } });
    expect(f.discovery.candidates()).toEqual([]);
    f.browser.emit("up", candidate());
    f.browser.emit("up", candidate());
    expect(f.discovery.candidates().length).toBe(1);
    f.browser.emit("down", candidate());
    expect(f.discovery.candidates()).toEqual([]);
    for (let i = 1; i < 90; i++) {
      const c = candidate(i.toString(16).padStart(64, "0"));
      c.fqdn = "peer" + i;
      f.browser.emit("up", c);
    }
    expect(f.discovery.candidates().length).toBe(64);
    await Bun.sleep(1100);
    expect(f.discovery.candidates()).toEqual([]);
  } finally {
    await f.discovery.stop();
  }
});
