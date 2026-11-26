import { resolveReminder } from "./reminders";
import type { CreatedBy, PgPaStore, TodoItem, TodoList } from "./store";
import { isDate } from "./time";

/** A to-do to add: its text, optionally a due date and a reminder time. */
export interface NewTodo {
  text: string;
  /** Due date, YYYY-MM-DD (shown on the list; no alert). */
  due?: string | null;
  /** Reminder time, UK local YYYY-MM-DDTHH:MM: the to-do then also pushes an alert. */
  remind?: string | null;
  /** With remind: daily, weekdays, weekly:mon,thu, monthly:15. */
  recurrence?: string | null;
  /** With remind: a number to call. */
  phone?: string | null;
}

/** Throws a readable error for a bad to-do, so a proposal fails when it is made rather than on approval. */
export function checkTodos(items: NewTodo[], timeZone: string, now: Date): void {
  for (const i of items) {
    if (i.due && !isDate(i.due)) throw new Error(`due must be YYYY-MM-DD, got "${i.due}"`);
    if (i.remind) resolveReminder({ text: i.text, due: i.remind, recurrence: i.recurrence, phone: i.phone }, timeZone, now);
    else if (i.recurrence || i.phone) throw new Error(`"${i.text}": recurrence and phone need a reminder time (remind)`);
  }
}

/**
 * Adds to-dos to a business's list: in the section at `list` ("Accounting / Invoices",
 * created if missing) or at the top when `list` is empty. Those with `remind` get a reminder.
 */
export async function addTodos(
  store: PgPaStore,
  input: { vertical: string; list?: string | null; items: NewTodo[] },
  ctx: { createdBy: CreatedBy; taskId?: string | null; timeZone: string; now?: Date },
): Promise<{ section: TodoList | null; items: TodoItem[] }> {
  const now = ctx.now ?? new Date();
  checkTodos(input.items, ctx.timeZone, now);
  const section = input.list?.trim() ? await store.ensureList(input.vertical, input.list) : null;
  const added = await store.addItems({ vertical: input.vertical, listId: section?.id ?? null }, input.items.map((i) => ({ text: i.text, dueDate: i.due ?? null })), ctx.createdBy);
  const out: TodoItem[] = [];
  for (const [n, item] of added.entries()) {
    const want = input.items[n]!;
    if (want.remind) {
      const r = resolveReminder({ text: item.text, due: want.remind, recurrence: want.recurrence, phone: want.phone }, ctx.timeZone, now);
      await store.updateReminder(item.id, { text: item.text, phone: r.phone, schedule: r });
      out.push((await store.getItem(item.id))!);
    } else out.push(item);
  }
  return { section, items: out };
}
