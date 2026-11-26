import { afterAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import {
  addReminder,
  changeReminder,
  deliverDueReminders,
  PA_MIGRATION_SQL,
  PA_PHONE_MIGRATION_SQL,
  PA_TODO_TREE_MIGRATION_SQL,
  PgPaStore,
  type ReminderPush,
  snoozeUntil,
} from "../src";
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

describe.skipIf(!DB_URL)("sections and reminders as to-dos (Postgres)", () => {
  let pool: pg.Pool;
  let store: PgPaStore;

  beforeEach(async () => {
    await pool?.end();
    ({ pool, store } = await freshStore());
  });
  afterAll(() => pool?.end());

  it("nests sections by path, unique among siblings, and deletes a section with everything under it", async () => {
    const vat = await store.ensureList("dms", "Accounting / VAT");
    expect(vat).toMatchObject({ name: "VAT", path: "Accounting / VAT" });
    const accounting = (await store.findList("dms", "accounting"))!;
    expect(vat.parentId).toBe(accounting.id);
    expect((await store.ensureList("dms", "accounting > vat")).id).toBe(vat.id);
    expect((await store.ensureList("dms", "vat", accounting.id)).id).toBe(vat.id);
    // The same name elsewhere in the tree is a different section.
    const salesVat = await store.ensureList("dms", "Sales / VAT");
    expect(salesVat.id).not.toBe(vat.id);
    await store.ensureList("dms", "Accounting / Payroll");
    expect((await store.listLists("dms")).map((l) => l.path)).toEqual(["Accounting", "Accounting / VAT", "Accounting / Payroll", "Sales", "Sales / VAT"]);

    const [item] = await store.addItems(vat.id, [{ text: "File Q3" }], "dave");
    expect(item).toMatchObject({ vertical: "dms", listId: vat.id, listName: "Accounting / VAT" });
    const [loose] = await store.addItems({ vertical: "dms", listId: null }, [{ text: "Loose" }], "dave");
    expect(loose).toMatchObject({ listId: null, listName: null });
    expect((await store.listItems(accounting.id, { descendants: true })).map((i) => i.text)).toEqual(["File Q3"]);
    expect((await store.listItems(null, { vertical: "dms" })).map((i) => i.text)).toEqual(["Loose"]);

    expect(await store.moveItem(loose!.id, salesVat.id)).toMatchObject({ listName: "Sales / VAT" });
    await expect(store.moveItem(loose!.id, (await store.ensureList("personal", "Home")).id)).rejects.toThrow(/no such section/);

    expect(await store.deleteList(accounting.id)).toBe(true);
    expect((await store.listLists("dms")).map((l) => l.path)).toEqual(["Sales", "Sales / VAT"]);
    expect(await store.getItem(item!.id)).toBeNull();
  });

  it("sets, snoozes and clears a reminder on an ordinary to-do", async () => {
    const [item] = await store.addItems({ vertical: "personal", listId: (await store.ensureList("personal", "Cleaning")).id }, [{ text: "Wash dishes" }], "dave");
    expect(item!.reminder).toBeNull();
    await expect(changeReminder(store, item!.id, { text: "x" }, { timeZone: TZ })).rejects.toThrow(/no reminder yet/);
    const r = await changeReminder(store, item!.id, { due: "2026-10-23T19:00", recurrence: "daily" }, { timeZone: TZ, now: new Date("2026-10-23T08:00:00Z") });
    expect(r).toMatchObject({ text: "Wash dishes", recurrence: "FREQ=DAILY", status: "pending", listName: "Cleaning", dueAt: "2026-10-23T18:00:00.000Z" });
    expect((await store.getItem(item!.id))!.reminder).toMatchObject({ id: item!.id, localTime: "19:00" });
    expect(await store.cancelReminder(item!.id)).toMatchObject({ status: "cancelled" });
    expect(await store.getItem(item!.id)).toMatchObject({ text: "Wash dishes", reminder: null });
    expect(await store.listReminders()).toEqual([]);
  });
});

describe.skipIf(!DB_URL)("migration 0031 (Postgres)", () => {
  it("moves reminders into to-dos keeping their ids, and keeps existing lists as sections", async () => {
    const admin = new pg.Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query(`drop schema if exists pa_mig_test cascade; create schema pa_mig_test`);
    await admin.end();
    const pool = new pg.Pool({ connectionString: DB_URL, options: "-c search_path=pa_mig_test", max: 2 });
    try {
      await pool.query(PA_MIGRATION_SQL);
      await pool.query(PA_PHONE_MIGRATION_SQL);
      const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
      await pool.query(
        `insert into reminders (id, text, due_at, recurrence, local_time, timezone, vertical, created_by, status, sent_count, version, phone, completed_at) values
          ($1, 'Bins', '2026-10-23T18:00Z', 'FREQ=WEEKLY;BYDAY=TH', '19:00', 'Europe/London', 'personal', 'dave', 'sent', 3, 7, null, null),
          ($2, 'Old', '2026-10-01T09:00Z', null, '10:00', 'Europe/London', 'dms', 'agent', 'done', 1, 2, '07700 900123', '2026-10-01T09:05Z'),
          ($3, 'Dropped', '2026-10-01T09:00Z', null, '10:00', 'Europe/London', 'dms', 'agent', 'cancelled', 0, 1, null, null)`,
        ids,
      );
      await pool.query(`insert into todo_lists (id, vertical, name, position) values ('44444444-4444-4444-8444-444444444444', 'personal', 'Shopping', 0)`);
      await pool.query(
        `insert into todo_items (id, list_id, text, position, created_by) values ('55555555-5555-4555-8555-555555555555', '44444444-4444-4444-8444-444444444444', 'Milk', 0, 'dave')`,
      );
      await pool.query(PA_TODO_TREE_MIGRATION_SQL);
      const store = new PgPaStore(pool);

      expect(await store.getReminder(ids[0]!)).toMatchObject({ text: "Bins", status: "sent", recurrence: "FREQ=WEEKLY;BYDAY=TH", sentCount: 3, version: 7, listId: null, vertical: "personal" });
      expect(await store.getReminder(ids[1]!)).toMatchObject({ text: "Old", status: "done", phone: "07700 900123", completedAt: "2026-10-01T09:05:00.000Z" });
      expect(await store.getItem(ids[2]!)).toBeNull();
      expect(await store.getItem("55555555-5555-4555-8555-555555555555")).toMatchObject({ text: "Milk", vertical: "personal", listName: "Shopping", reminder: null });
      expect((await store.listLists()).map((l) => [l.path, l.parentId])).toEqual([["Shopping", null]]);
    } finally {
      await pool.end();
    }
  });
});
