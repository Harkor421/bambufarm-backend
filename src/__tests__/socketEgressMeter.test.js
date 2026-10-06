/**
 * Socket-level egress meter: real sockets through the wrapped net.connect,
 * bytes attributed by remote port, inbound connections counted separately.
 */
const net = require("net");
const egressMeter = require("../services/egressMeter");

egressMeter.installSocketMeter();

function once(emitter, ev) {
  return new Promise((r) => emitter.once(ev, r));
}

describe("socket egress meter", () => {
  beforeEach(() => egressMeter._reset());

  it("counts bytes written/read per destination and inbound", async () => {
    const server = net.createServer((s) => {
      s.on("data", () => s.end("x".repeat(500))); // reply 500 bytes, then close
    });
    egressMeter.meterServer(server);
    server.listen(0);
    await once(server, "listening");
    const port = server.address().port;

    const client = net.connect(port, "127.0.0.1");
    await once(client, "connect");
    client.write("y".repeat(1200));
    client.resume();
    await once(client, "close");
    await new Promise((r) => setTimeout(r, 20));
    server.close();

    const snap = egressMeter.socketSnapshot();
    const out = snap.categories.find((c) => c.category === `sock:out:${port}`);
    const inbound = snap.categories.find((c) => c.category.startsWith("sock:inbound"));
    expect(out).toMatchObject({ writtenBytes: 1200, readBytes: 500, opened: 1, closed: 1 });
    expect(inbound).toMatchObject({ writtenBytes: 500, readBytes: 1200, opened: 1, closed: 1 });
  });

  it("wrapping is idempotent and keeps net.connect working", () => {
    egressMeter.installSocketMeter();
    expect(net.connect.__egressWrapped).toBe(true);
  });
});
