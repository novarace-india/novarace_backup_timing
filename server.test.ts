import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { test } from "node:test";
import { createTimingServer } from "./server.js";

test("SES upload, shared timing point, volunteer permissions and retry-safe undo", async () => {
  const directory = mkdtempSync(join(tmpdir(), "backup-timing-test-"));
  const password = "testing-passphrase";
  const server = createTimingServer({ directory, adminPassword: password });
  function request(method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; value: any }> {
    const request = Object.assign(Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]), {
      method, url, headers: { authorization: token ? "Bearer " + token : undefined }, socket: { remoteAddress: "127.0.0.1" },
    });
    return new Promise((resolve) => {
      let status: number;
      server.emit("request", request, {
        writeHead(code: number) { status = code; },
        end(data: Buffer | string) { resolve({ status, value: url.startsWith("/api/") ? JSON.parse(data.toString()) : data.toString() }); },
      });
    });
  }

  try {
    assert.match((await request("GET", "/")).value, /NovaRace Backup Timing/);
    const admin = (await request("POST", "/api/login", { name: "admin", password })).value.token;
    assert.equal((await request("POST", "/api/volunteers", { name: "checkpoint-1", password }, admin)).status, 201);
    const volunteer = (await request("POST", "/api/login", { name: "checkpoint-1", password })).value.token;
    assert.equal((await request("POST", "/api/events?filename=sample.ses", Buffer.alloc(0), volunteer)).status, 403);
    assert.equal((await request("POST", "/api/events?filename=sample.ses", Buffer.alloc(0), admin)).status, 422);

    const file = join(directory, "sample.ses");
    const fixture = new DatabaseSync(file);
    fixture.exec(`
      CREATE TABLE settings (Name TEXT, Value TEXT, ForeignID INTEGER);
      CREATE TABLE contests (ID INTEGER, Name TEXT, OrderPos INTEGER);
      INSERT INTO contests VALUES (1, '10K', 1);
      CREATE TABLE splits (ID INTEGER, Contest INTEGER, OrderPos INTEGER, Label TEXT, TimingPoint TEXT, Distance INTEGER);
      INSERT INTO splits VALUES (1, 1, 1, 'Outbound', 'Turnaround', 4000), (2, 1, 2, 'Return', 'Turnaround', 6000);
      CREATE TABLE participants (ID INTEGER, Bib INTEGER, Firstname TEXT, Lastname TEXT, Sex TEXT, DateOfBirth TEXT,
        Contest INTEGER, Club TEXT, City TEXT, Nation TEXT, Status INTEGER, Transponder1 TEXT, AgeGroup1 INTEGER);
      INSERT INTO participants (ID, Bib, Sex, Contest, Status) VALUES (1, 101, 'M', 1, 0), (2, 102, 'F', 1, 0);
    `);
    fixture.close();

    const url = "/api/events?filename=sample.ses";
    const upload = await request("POST", url, readFileSync(file), admin);
    assert.equal(upload.status, 201);
    const event = upload.value;
    assert.deepEqual(event.roster.map((runner: { sex: string }) => runner.sex), ["m", "f"]);
    assert.equal((await request("POST", url, readFileSync(file), admin)).value.id, event.id);
    const opened = await request("GET", `/api/events/${event.id}`, undefined, volunteer);
    assert.equal(opened.status, 200, JSON.stringify(opened.value));
    assert.equal(opened.value.id, event.id);
    const point = event.timingPoints.find((item: { name: string }) => item.name === "Turnaround");
    assert.equal(point.passes.length, 2);
    const [first, second] = point.passes.map((pass: { splits: { id: number }[] }) => pass.splits[0].id);
    assert.notEqual(first, second);

    const path = `/api/events/${event.id}/captures`;
    const runner = event.roster.find((runner: { status: number }) => runner.status === 0);
    const entry = { id: randomUUID(), participantId: runner.id, contestId: runner.contestId, splitId: first, point: point.name, at: 1795075200123, voided: false };
    const returnLeg = { ...entry, id: randomUUID(), splitId: second, at: entry.at + 900_000 };
    const badSplit = { ...entry, id: randomUUID(), splitId: -999 };
    const send = async (...entries: typeof entry[]) => (await request("POST", path, { entries }, volunteer)).value;
    assert.deepEqual(await send(entry, returnLeg, badSplit), { accepted: [entry.id, returnLeg.id], rejected: [badSplit.id] });
    assert.deepEqual((await send(entry)).accepted, [entry.id]);
    assert.deepEqual((await send({ ...entry, voided: true })).accepted, [entry.id]);
    assert.deepEqual((await send(entry)).accepted, [entry.id]);
    assert.equal((await request("GET", path, undefined, volunteer)).status, 403);
    const report = (await request("GET", path, undefined, admin)).value;
    assert.deepEqual(report.map(({ splitId, at, voided }: { splitId: number; at: number; voided: number }) => [splitId, at, voided]), [
      [first, entry.at, 1], [second, returnLeg.at, 0],
    ]);
  } finally {
    server.emit("close");
    rmSync(directory, { recursive: true, force: true });
  }
});
