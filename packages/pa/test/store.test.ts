import type pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { addReminder, deliverDueReminders, type PgPaStore, type ReminderPush, snoozeUntil } from "../src";
import { DB_URL, freshStore } from "./db";

const TZ = "Europe/London";
const ctx = { vertical: "personal", createdBy: "dave" as const, timeZone: TZ };

describe.skipIf(!DB_URL)("reminders (Postgres)", () => {
  let pool: pg.Pool;
  let store: PgPaStore;
  let pushes: ReminderPush[];
  const push = async (p: ReminderPush) => {
    pushes.push(p);
  };

  beforeEach(async () => {
    await pool?.end();
    ({ pool, store } = await freshStore());
    pushes = [];
  });
  afterAll(() => pool?.end());

  it("delivers a due one-off reminder once and marks it sent", async () => {
    const now = new Date("2026-10-23T08:00:00Z");
    const r = await addReminder(store, { text: "Call the garage", due: "2026-10-23T09:00" }, { ...ctx, now });
    expect(r.dueAt).toBe("2026-10-23T08:00:00.000Z"); // 09:00 BST

    expect(await deliverDueReminders(store, push, new Date("2026-10-23T07:59:00Z"))).toEqual([]);
    const sent = await deliverDueReminders(store, push, new Date("2026-10-23T08:00:30Z"));
    expect(sent.map((s) => s.id)).toEqual([r.id]);
    expect(pushes).toEqual([{ reminder: expect.objectContaining({ id: r.id }), dueAt: new Date(r.dueAt), title: "Reminder", body: "Call the garage" }]);
    expect(await store.getReminder(r.id)).toMatchObject({ status: "sent", sentCount: 1, lastSentAt: "2026-10-23T08:00:30.000Z" });

    expect(await deliverDueReminders(store, push, new Date("2026-10-23T08:05:00Z"))).toEqual([]);
    expect(pushes).toHaveLength(1);
    // Sent but not done: still open.
    expect((await store.listReminders()).map((x) => x.id)).toEqual([r.id]);
    expect(await store.completeReminder(r.id)).toMatchObject({ status: "done" });
    expect(await store.listReminders()).toEqual([]);
  });

  it("says when a late reminder was due", async () => {
    await addReminder(store, { text: "Pay the window cleaner", due: "2026-10-23T09:00" }, ctx);
    await deliverDueReminders(store, push, new Date("2026-10-23T11:00:00Z"));
    expect(pushes[0]!.body).toBe("Pay the window cleaner (was due Fri 23 Oct, 09:00)");
  });

  it("advances a daily reminder across the autumn DST change, keeping 08:00 local", async () => {
    const r = await addReminder(store, { text: "Vitamins for Noah", due: "2026-10-24T08:00", recurrence: "daily" }, { ...ctx, now: new Date("2026-10-23T12:00:00Z") });
    expect(r.recurrence).toBe("FREQ=DAILY");
    expect(r.dueAt).toBe("2026-10-24T07:00:00.000Z"); // Sat 08:00 BST

    await deliverDueReminders(store, push, new Date("2026-10-24T07:00:10Z"));
    expect(await store.getReminder(r.id)).toMatchObject({ status: "pending", dueAt: "2026-10-25T08:00:00.000Z" }); // Sun 08:00 GMT
    await deliverDueReminders(store, push, new Date("2026-10-25T08:00:10Z"));
    expect((await store.getReminder(r.id))!.dueAt).toBe("2026-10-26T08:00:00.000Z");
    expect(pushes).toHaveLength(2);
  });

  it("advances across the spring DST change too", async () => {
    const r = await addReminder(store, { text: "Bins", due: "2026-03-28T19:00", recurrence: "weekly:sat,sun" }, { ...ctx, now: new Date("2026-03-27T12:00:00Z") });
    expect(r.dueAt).toBe("2026-03-28T19:00:00.000Z"); // Sat 19:00 GMT
    await deliverDueReminders(store, push, new Date("2026-03-28T19:00:00Z"));
    expect((await store.getReminder(r.id))!.dueAt).toBe("2026-03-29T18:00:00.000Z"); // Sun 19:00 BST
  });

  it("sends one alert, not a backlog, after downtime", async () => {
    const r = await addReminder(store, { text: "Stand-up", due: "2026-10-19T09:00", recurrence: "weekdays" }, { ...ctx, now: new Date("2026-10-19T07:00:00Z") });
    await deliverDueReminders(store, push, new Date("2026-10-23T10:00:00Z")); // Friday, four occurrences missed
    expect(pushes).toHaveLength(1);
    expect((await store.getReminder(r.id))!.dueAt).toBe("2026-10-26T09:00:00.000Z"); // next Monday, GMT
  });

  it("snoozes a one-off by moving it, and a recurring one with a re-alert that leaves the series alone", async () => {
    const one = await addReminder(store, { text: "Ring mum", due: "2026-10-23T09:00" }, ctx);
    await deliverDueReminders(store, push, new Date("2026-10-23T08:00:00Z"));
    const snoozed = await store.snoozeReminder(one.id, snoozeUntil("1h", new Date("2026-10-23T08:01:00Z"), TZ));
    expect(snoozed).toMatchObject({ status: "pending", dueAt: "2026-10-23T09:01:00.000Z", snoozedUntil: null });
    await deliverDueReminders(store, push, new Date("2026-10-23T09:01:00Z"));
    expect(pushes.map((p) => p.reminder.id)).toEqual([one.id, one.id]);

    const daily = await addReminder(store, { text: "Water plants", due: "2026-10-23T18:00", recurrence: "daily" }, { ...ctx, now: new Date("2026-10-23T12:00:00Z") });
    await deliverDueReminders(store, push, new Date("2026-10-23T17:00:00Z"));
    expect((await store.getReminder(daily.id))!.dueAt).toBe("2026-10-24T17:00:00.000Z");
    const s = await store.snoozeReminder(daily.id, new Date("2026-10-23T17:30:00Z"));
    expect(s).toMatchObject({ dueAt: "2026-10-24T17:00:00.000Z", snoozedUntil: "2026-10-23T17:30:00.000Z", status: "pending" });
    await deliverDueReminders(store, push, new Date("2026-10-23T17:30:00Z"));
    expect(await store.getReminder(daily.id)).toMatchObject({ dueAt: "2026-10-24T17:00:00.000Z", snoozedUntil: null, sentCount: 2 });
    expect(pushes.at(-1)!.reminder.id).toBe(daily.id);
  });

  it("snooze presets", () => {
    const now = new Date("2026-10-23T08:00:00Z");
    expect(snoozeUntil(10, now, TZ).toISOString()).toBe("2026-10-23T08:10:00.000Z");
    expect(snoozeUntil("2h", now, TZ).toISOString()).toBe("2026-10-23T10:00:00.000Z");
    expect(snoozeUntil("tomorrow", now, TZ).toISOString()).toBe("2026-10-24T08:00:00.000Z"); // 09:00 BST
  });

  it("never sends twice when two deliveries race", async () => {
    for (let i = 0; i < 5; i++) await addReminder(store, { text: `r${i}`, due: "2026-10-23T09:00" }, ctx);
    const now = new Date("2026-10-23T08:00:00Z");
    const results = await Promise.all([deliverDueReminders(store, push, now), deliverDueReminders(store, push, now), deliverDueReminders(store, push, now)]);
    expect(results.flat()).toHaveLength(5);
    expect(new Set(pushes.map((p) => p.reminder.id)).size).toBe(5);
    expect(pushes).toHaveLength(5);
  });

  it("scopes reminders to a vertical", async () => {
    const dms = await addReminder(store, { text: "Restock spindles", due: "2026-10-23T09:00" }, { ...ctx, vertical: "dms", createdBy: "agent" });
    await addReminder(store, { text: "Swimming", due: "2026-10-23T17:00" }, ctx);
    expect((await store.listReminders({ vertical: "dms" })).map((r) => r.text)).toEqual(["Restock spindles"]);
    expect(await store.completeReminder(dms.id, "personal")).toBeNull();
    expect(await store.getReminder("not-a-uuid")).toBeNull();
    expect((await store.listReminders()).map((r) => r.text)).toEqual(["Restock spindles", "Swimming"]);
  });
});

describe.skipIf(!DB_URL)("lists (Postgres)", () => {
  let pool: pg.Pool;
  let store: PgPaStore;

  beforeEach(async () => {
    await pool?.end();
    ({ pool, store } = await freshStore());
  });
  afterAll(() => pool?.end());

  it("creates lists by name case-insensitively and keeps items in order", async () => {
    const shopping = await store.ensureList("personal", "Shopping");
    expect((await store.ensureList("personal", "shopping")).id).toBe(shopping.id);
    expect((await store.ensureList("dms", "shopping")).id).not.toBe(shopping.id);

    await store.addItems(shopping.id, [{ text: "Milk" }, { text: "Bread" }], "dave");
    const [eggs] = await store.addItems(shopping.id, [{ text: " Eggs " }], "agent");
    expect(eggs).toMatchObject({ text: "Eggs", listName: "Shopping", vertical: "personal", createdBy: "agent", done: false });
    const items = await store.listItems(shopping.id);
    expect(items.map((i) => i.text)).toEqual(["Milk", "Bread", "Eggs"]);

    await store.reorderItems(shopping.id, [items[2]!.id, items[0]!.id, items[1]!.id]);
    expect((await store.listItems(shopping.id)).map((i) => i.text)).toEqual(["Eggs", "Milk", "Bread"]);

    await store.setItemDone(items[0]!.id, true);
    expect((await store.listItems(shopping.id)).map((i) => i.text)).toEqual(["Eggs", "Bread"]);
    expect((await store.listItems(shopping.id, { includeDone: true })).map((i) => `${i.text}:${i.done}`)).toEqual(["Eggs:false", "Bread:false", "Milk:true"]);
    expect(await store.getList(shopping.id)).toMatchObject({ openCount: 2, doneCount: 1 });
    await store.setItemDone(items[0]!.id, false);
    expect((await store.getItem(items[0]!.id))!.doneAt).toBeNull();
  });

  it("orders top items: overdue and due today, then the today list", async () => {
    const today = await store.ensureList("personal", "today");
    const home = await store.ensureList("personal", "home");
    const noah = await store.ensureList("personal", "Noah");
    await store.addItems(home.id, [{ text: "Fix the gate" }, { text: "Boiler service", dueDate: "2026-10-20" }], "dave");
    await store.addItems(noah.id, [{ text: "Book swimming", dueDate: "2026-10-23" }, { text: "Party present", dueDate: "2026-11-02" }], "dave");
    await store.addItems(today.id, [{ text: "Post the parcel" }], "dave");
    const top = await store.topItems({ today: "2026-10-23", limit: 4 });
    expect(top.map((i) => i.text)).toEqual(["Boiler service", "Book swimming", "Party present", "Post the parcel"]);
    expect(top[1]!.dueDate).toBe("2026-10-23");
  });

  it("renames, reorders, edits and deletes", async () => {
    const a = await store.ensureList("personal", "a");
    const b = await store.ensureList("personal", "b");
    await store.reorderLists([b.id, a.id]);
    expect((await store.listLists("personal")).map((l) => l.name)).toEqual(["b", "a"]);
    expect((await store.renameList(a.id, "Garden"))!.name).toBe("Garden");
    const [item] = await store.addItems(a.id, [{ text: "Mow" }], "dave");
    expect(await store.updateItem(item!.id, { text: "Mow the lawn", dueDate: "2026-10-25" })).toMatchObject({ text: "Mow the lawn", dueDate: "2026-10-25" });
    expect(await store.updateItem(item!.id, { dueDate: null })).toMatchObject({ dueDate: null });
    expect(await store.deleteItem(item!.id, "dms")).toBe(false);
    expect(await store.deleteItem(item!.id)).toBe(true);
    expect(await store.deleteList(a.id)).toBe(true);
    expect((await store.listLists()).map((l) => l.name)).toEqual(["b"]);
  });
});
