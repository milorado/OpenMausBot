import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runHourly, SWEEP_AFTER_MS } from "./app-events";
import { DAY_MS } from "./common";
import { brokerHarness, message, type Installation } from "./test-harness";

let h: ReturnType<typeof brokerHarness>;

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function harness(migrations?: number) {
  h = brokerHarness(migrations === undefined ? {} : { migrations });
  vi.stubGlobal("fetch", h.composio.fetchImpl);
  return h;
}

const post = (owner: Installation, path: string, body: unknown) => h.call(owner, path, { method: "POST", body: JSON.stringify(body) });
const me = async (owner: Installation) => (await h.call(owner, "/v1/me")).json() as Promise<{ installationId: string; user: string; shared: boolean }>;
async function share(from: Installation, to: Installation) {
  const response = await post(from, "/v1/installation/share", { for: to.id });
  expect(response.status).toBe(201);
  return ((await response.json()) as { code: string }).code;
}
async function mcpCall(owner: Installation) {
  const response = await h.call(owner, "/v1/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "GMAIL_SEND_EMAIL", arguments: {} } }) });
  const body = await response.json() as { result: { content: Array<{ text: string }> } };
  return JSON.parse(body.result.content[0]!.text) as { user: string; accounts: string[] };
}

describe("a desktop shares its connected apps with the person's own Cloud", () => {
  it("lets only the installation the code names act as the desktop's Composio user, once", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install(), stranger = await h.install();
    const gmail = h.account(desktop, "gmail");
    const work = h.account(desktop, "gmail");
    expect((await me(cloud)).user).not.toBe((await me(desktop)).user);

    const code = await share(desktop, cloud);
    expect((await post(stranger, "/v1/installation/adopt", { code })).status).toBe(404);
    const adopted = await post(cloud, "/v1/installation/adopt", { code });
    expect(adopted.status).toBe(200);
    await expect(adopted.json()).resolves.toEqual({ shared: true, user: (await me(desktop)).user });
    expect((await post(cloud, "/v1/installation/adopt", { code })).status).toBe(404);
    expect(await me(cloud)).toEqual({ installationId: cloud.id, user: (await me(desktop)).user, shared: true });

    const connected = await (await h.call(cloud, "/v1/connectors/connected")).json() as { services: Record<string, { connected: boolean; accounts: Array<{ id: string }> }> };
    expect(connected.services.gmail?.connected).toBe(true);
    expect(connected.services.gmail?.accounts.map((account) => account.id).sort()).toEqual([gmail, work].sort());
    // Tools run as the desktop's user: the Cloud's Session is that user's, and reaches its accounts.
    expect(await mcpCall(cloud)).toEqual({ tool: "GMAIL_SEND_EMAIL", user: desktop.userId, accounts: [gmail, work] });
    expect([...h.composio.sessions.values()].filter((session) => session.user_id === cloud.userId)).toEqual([]);
    // The stranger never reached it.
    expect((await me(stranger)).shared).toBe(false);
    expect(await mcpCall(stranger)).toMatchObject({ user: stranger.userId, accounts: [] });
  });

  it("an app connected on either side afterwards is there on both", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install();
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(desktop, cloud) })).status).toBe(200);
    const link = await h.call(cloud, "/v1/connectors/notion/authorize", { method: "POST" });
    expect(link.status).toBe(200);
    h.account({ ...cloud, userId: desktop.userId }, "notion");
    const status = await (await h.call(desktop, "/v1/connectors?services=notion")).json() as { services: Record<string, { connected: boolean }> };
    expect(status.services.notion?.connected).toBe(true);
  });

  it("keeps a Cloud's own connected apps: it does not adopt while it has any, and the code is spent", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install();
    h.account(desktop, "gmail");
    const slack = h.account(cloud, "slack");
    h.account(cloud, "notion", "INITIATED");
    const code = await share(desktop, cloud);
    const refused = await post(cloud, "/v1/installation/adopt", { code });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({ code: "has_connections", toolkits: ["slack"] });
    expect((await post(cloud, "/v1/installation/adopt", { code })).status).toBe(404);
    expect(await me(cloud)).toMatchObject({ shared: false, user: expect.not.stringMatching((await me(desktop)).user) });
    expect(await mcpCall(cloud)).toEqual({ tool: "GMAIL_SEND_EMAIL", user: cloud.userId, accounts: [slack] });
  });

  it("refuses an expired code, a code for itself, an unknown installation and malformed bodies", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install();
    const code = await share(desktop, cloud);
    h.d1.db.prepare("UPDATE user_shares SET expires_at = 0").run();
    expect((await post(cloud, "/v1/installation/adopt", { code })).status).toBe(404);
    expect((await post(desktop, "/v1/installation/share", { for: desktop.id })).status).toBe(400);
    expect((await post(desktop, "/v1/installation/share", { for: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await post(desktop, "/v1/installation/share", { for: "not-an-installation" })).status).toBe(400);
    expect((await post(cloud, "/v1/installation/adopt", { code: "nope" })).status).toBe(400);
    expect(h.d1.rows("SELECT code_hash FROM user_shares")).toEqual([]);
    expect(h.d1.rows<{ code_hash: string }>("SELECT code_hash FROM user_shares").some((row) => row.code_hash === code)).toBe(false);
  });

  it("stores only the code's hash", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install();
    const code = await share(desktop, cloud);
    expect(JSON.stringify(h.d1.rows("SELECT * FROM user_shares"))).not.toContain(code);
  });

  it("two installations acting as one user keep each other's triggers and both get their events", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install();
    const gmail = h.account(desktop, "gmail");
    const { body: created } = await h.createTrigger(desktop, gmail);
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(desktop, cloud) })).status).toBe(200);

    const listed = await (await h.call(cloud, "/v1/triggers")).json() as { unbound: Array<{ triggerId: string }> };
    expect(listed.unbound).toEqual([]);
    await expect((await h.call(cloud, `/v1/triggers/${created.triggerId}`, { method: "DELETE" })).json()).resolves.toEqual({ removed: 0 });
    expect(h.composio.instances.has(created.triggerId)).toBe(true);

    const { body: same } = await h.createTrigger(cloud, gmail);
    expect(same.triggerId).toBe(created.triggerId);
    expect((await h.deliver(message(created.triggerId, desktop.userId))).status).toBe(200);
    expect(h.queued(desktop.id)).toHaveLength(1);
    expect(h.queued(cloud.id)).toHaveLength(1);
  });

  it("keeps a shared trigger for an active peer, pauses it when both are idle and resumes it on repoll", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install();
    const gmail = h.account(desktop);
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(desktop, cloud) })).status).toBe(200);
    const { body: { triggerId } } = await h.createTrigger(desktop, gmail);
    expect((await h.createTrigger(cloud, gmail)).body.triggerId).toBe(triggerId);
    const now = Date.now();
    await h.poll(cloud);
    h.d1.db.prepare("UPDATE trigger_bindings SET created_at = ?").run(now - SWEEP_AFTER_MS - DAY_MS);
    await runHourly(h.env as never, now);
    const instance = h.composio.instances.get(triggerId)!;
    expect(instance.disabled_at).toBeNull();
    await runHourly(h.env as never, now + SWEEP_AFTER_MS + DAY_MS);
    expect(instance.disabled_at).not.toBeNull();
    await h.poll(desktop);
    await Promise.all(h.background);
    expect(instance.disabled_at).toBeNull();
  });

  it("repairs previously swept shared triggers across hourly batches and resumes them over two polls", async () => {
    harness(5);
    const desktop = await h.install(), cloud = await h.install();
    const gmail = h.account(desktop);
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(desktop, cloud) })).status).toBe(200);
    for (let i = 0; i < 41; i += 1) {
      const config = { query: `subject:order-${i}` };
      const first = await h.createTrigger(desktop, gmail, config);
      expect((await h.createTrigger(cloud, gmail, config)).body.triggerId).toBe(first.body.triggerId);
    }
    h.d1.db.exec("UPDATE trigger_bindings SET swept_at = 1; UPDATE installations SET triggers_swept_at = 1");
    h.d1.db.exec(readFileSync(new URL("../migrations/0006_shared_idle_triggers.sql", import.meta.url), "utf8"));
    const now = Date.now() + SWEEP_AFTER_MS + DAY_MS;
    const paused = () => [...h.composio.instances.values()].filter((instance) => instance.disabled_at !== null);
    await runHourly(h.env as never, now);
    expect(paused()).toHaveLength(40);
    await runHourly(h.env as never, now + DAY_MS);
    expect(paused()).toHaveLength(41);
    expect(h.composio.callsTo("/trigger_instances/manage/")).toHaveLength(41);
    await h.poll(cloud);
    await Promise.all(h.background);
    expect(paused()).toHaveLength(1);
    await h.poll(cloud);
    await Promise.all(h.background);
    expect(paused()).toEqual([]);
  });

  it("retries failed disables behind untouched instances and failed resumes on the next poll", async () => {
    harness();
    const desktop = await h.install();
    const gmail = h.account(desktop);
    for (let i = 0; i < 41; i += 1) await h.createTrigger(desktop, gmail, { query: `subject:order-${i}` });
    for (let i = 0; i < 40; i += 1) h.composio.fail(503, (call) => call.body?.status === "disable");
    const now = Date.now() + SWEEP_AFTER_MS + DAY_MS;
    await runHourly(h.env as never, now);
    const attempts = () => h.composio.callsTo("/trigger_instances/manage/").map((call) => call.path);
    const first = new Set(attempts());
    expect(first.size).toBe(40);
    await runHourly(h.env as never, now + DAY_MS);
    expect(first.has(attempts()[40])).toBe(false);
    await runHourly(h.env as never, now + 2 * DAY_MS);
    const disabled = () => [...h.composio.instances.values()].filter((instance) => instance.disabled_at !== null);
    expect(disabled()).toHaveLength(41);
    h.composio.fail(503, (call) => call.body?.status === "enable");
    await h.poll(desktop);
    await Promise.all(h.background);
    expect(disabled()).toHaveLength(2);
    await h.poll(desktop);
    await Promise.all(h.background);
    expect(disabled()).toEqual([]);
  });

  it("restores a shared trigger when a peer polls during Composio's disable request", async () => {
    harness();
    vi.useFakeTimers({ toFake: ["Date"] });
    const desktop = await h.install(), cloud = await h.install();
    const gmail = h.account(desktop);
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(desktop, cloud) })).status).toBe(200);
    const { body: { triggerId } } = await h.createTrigger(desktop, gmail);
    await h.createTrigger(cloud, gmail);
    vi.setSystemTime(Date.now() + SWEEP_AFTER_MS + DAY_MS);
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PATCH" && JSON.parse(String(init.body)).status === "disable") {
        await h.poll(cloud);
        await Promise.all(h.background);
      }
      return h.composio.fetchImpl(input, init);
    });
    await runHourly(h.env as never, Date.now());
    expect(h.composio.callsTo("/trigger_instances/manage/").map((call) => call.body?.status)).toEqual(["enable", "disable", "enable"]);
    expect(h.composio.instances.get(triggerId)?.disabled_at).toBeNull();
  });

  it("an event naming another user is still refused for a sharing installation", async () => {
    harness();
    const desktop = await h.install(), cloud = await h.install();
    const gmail = h.account(desktop, "gmail");
    expect((await post(cloud, "/v1/installation/adopt", { code: await share(desktop, cloud) })).status).toBe(200);
    const { body: created } = await h.createTrigger(cloud, gmail);
    expect((await h.deliver(message(created.triggerId, cloud.userId))).status).toBe(200);
    expect(h.queued(cloud.id)).toEqual([]);
  });

  it("keeps working on a database that has not run migration 0004", async () => {
    harness(3);
    const desktop = await h.install(), cloud = await h.install();
    h.account(desktop, "gmail");
    // No user to share, so a desktop never tries.
    expect(await me(desktop)).toEqual({ installationId: desktop.id });
    expect((await h.call(desktop, "/v1/connectors/connected")).status).toBe(200);
    expect((await post(desktop, "/v1/installation/share", { for: cloud.id })).status).toBe(503);
  });
});
