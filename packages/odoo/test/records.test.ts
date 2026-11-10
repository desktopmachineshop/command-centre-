import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { checkValue, closeFields, createOdooExecutors, createOdooMcpServer, deniedField, deniedMethod, deniedModel, GENERIC_WRITE_DENYLIST, OdooClient } from "../src";
import { FakeOdoo, recordModels } from "../src/testing";

describe("generic write policy", () => {
  it("refuses the models that control access, run code, hold secrets or move money", () => {
    const denied = [
      "res.users", "res.users.apikeys", "res.groups", "ir.rule", "ir.model.access", "ir.config_parameter", "ir.cron", "ir.actions.server", "ir.attachment", "ir.ui.view",
      "base.automation", "payment.provider", "payment.token", "payment.transaction", "account.move", "account.move.line", "account.payment", "account.payment.register",
      "account.bank.statement.line", "res.partner.bank", "mail.mail", "mail.message", "mail.template", "mail.compose.message", "mailing.mailing", "res.company",
      "res.config.settings", "change.password.user", "auth_totp.device", "website.page",
    ];
    for (const model of denied) expect(deniedModel(model), model).toBeDefined();
    const allowed = [
      "res.partner", "product.product", "product.template", "product.pricelist.item", "stock.warehouse.orderpoint", "crm.lead", "helpdesk.ticket", "blog.post", "sale.order",
      "stock.picking", "account.payment.term", "account.tax", "mail.activity", "res.partner.category", "product.category", "payment_term.x",
    ];
    for (const model of allowed) expect(deniedModel(model), model).toBeUndefined();
    // Every rule says what it protects, and has a unique id for the refusal.
    expect(new Set(GENERIC_WRITE_DENYLIST.map((r) => r.rule)).size).toBe(GENERIC_WRITE_DENYLIST.length);
    for (const r of GENERIC_WRITE_DENYLIST) expect(r.why.length).toBeGreaterThan(5);
  });

  it("refuses secret and access fields on any model", () => {
    for (const f of ["password", "new_password", "api_key", "api_key_ids", "openai_api_key", "x_apikey", "client_secret", "totp_secret", "groups_id", "group_ids", "signup_token", "access_token"]) expect(deniedField(f), f).toBeDefined();
    for (const f of ["name", "email", "company_id", "user_id", "keyword", "token_count"]) expect(deniedField(f), f).toBeUndefined();
    expect(deniedField("x_groups", "res.groups")?.rule).toBe("protected-relations");
    expect(deniedField("partner_bank_id", "res.partner.bank")?.rule).toBe("protected-relations");
    expect(deniedField("user_id", "res.users")).toBeUndefined(); // assigning a salesperson is ordinary data
  });

  it("only lets workflow buttons be pressed, and nothing that deletes", () => {
    for (const m of ["action_confirm", "button_validate", "action_set_won", "action_archive"]) expect(deniedMethod(m), m).toBeUndefined();
    for (const m of ["write", "unlink", "create", "_action_done", "action_Confirm", "message_post", "action_", "sudo", "action_unlink", "button_immediate_uninstall", "action_confirm; drop"]) expect(deniedMethod(m), m).toBeDefined();
  });
});

describe("checkValue", () => {
  const ok = (type: string, v: unknown, more = {}) => checkValue("f", { type, ...more }, v);
  it("accepts values of the field's type and converts what Odoo wants differently", () => {
    expect(ok("char", "x")).toEqual({ value: "x" });
    expect(ok("char", null)).toEqual({ value: false });
    expect(ok("float", 1.5)).toEqual({ value: 1.5 });
    expect(ok("monetary", 2)).toEqual({ value: 2 });
    expect(ok("integer", 3)).toEqual({ value: 3 });
    expect(ok("boolean", false)).toEqual({ value: false });
    expect(ok("many2one", 7)).toEqual({ value: 7 });
    expect(ok("many2one", false)).toEqual({ value: false });
    expect(ok("date", "2026-11-30")).toEqual({ value: "2026-11-30" });
    expect(ok("datetime", "2026-11-30T09:00:00Z")).toEqual({ value: "2026-11-30 09:00:00" });
    expect(ok("datetime", "2026-11-30 09:00:00")).toEqual({ value: "2026-11-30 09:00:00" });
    expect(ok("selection", "b", { selection: [["a", "A"], ["b", "B"]] })).toEqual({ value: "b" });
    expect(ok("many2many", [3, 4, 3])).toEqual({ value: [[6, 0, [3, 4]]] });
    expect(ok("one2many", [])).toEqual({ value: [[6, 0, []]] });
    expect(ok("many2many", false)).toEqual({ value: [[6, 0, []]] });
    expect(ok("many2many", [[4, 9], [0, 0, { name: "x" }]])).toEqual({ value: [[4, 9], [0, 0, { name: "x" }]] });
    expect(ok("properties", { a: 1 })).toEqual({ value: { a: 1 } });
  });

  it("says what is wrong otherwise", () => {
    const err = (type: string, v: unknown, more = {}) => (ok(type, v, more) as { error: string }).error;
    expect(err("char", 5)).toMatch(/takes text/);
    expect(err("char", "x", { readonly: true })).toMatch(/read-only/);
    expect(err("char", false, { required: true })).toMatch(/required/);
    expect(err("char", "  ", { required: true })).toMatch(/required/);
    expect(err("float", "9.99")).toMatch(/a number/);
    expect(err("integer", 1.5)).toMatch(/whole number/);
    expect(err("boolean", "true")).toMatch(/true or false/);
    expect(err("many2one", "Acme", { relation: "res.partner" })).toMatch(/id of a res.partner/);
    expect(err("many2one", [10, "Jane"])).toMatch(/id of a/);
    expect(err("date", "30/11/2026")).toMatch(/YYYY-MM-DD/);
    expect(err("date", "2026-02-30")).toMatch(/YYYY-MM-DD/);
    expect(err("datetime", "2026-11-30")).toMatch(/HH:MM:SS/);
    expect(err("selection", "c", { selection: [["a", "A"], ["b", "B"]] })).toMatch(/one of "a" \(A\), "b" \(B\)/);
    expect(err("many2many", "1,2")).toMatch(/list of/);
    expect(err("one2many", [[2, 5]])).toMatch(/deleting is done in Odoo/);
    expect(err("one2many", [[5]])).toMatch(/deleting is done in Odoo/);
    expect(err("many2many", [1, "x"])).toMatch(/list of ids/);
  });

  it("suggests close field names", () => {
    const defs = { phone: { type: "char", string: "Phone" }, email: { type: "char", string: "Email" }, parent_id: { type: "many2one", string: "Related Company" }, list_price: { type: "float", string: "Sales Price" } };
    expect(closeFields(defs, "phon")).toEqual(["phone"]);
    expect(closeFields(defs, "mail")).toEqual(["email"]);
    expect(closeFields(defs, "related_company")).toEqual(["parent_id"]);
    expect(closeFields(defs, "price")).toEqual(["list_price"]);
    expect(closeFields(defs, "zzz")).toEqual([]);
  });
});

describe.each(["jsonrpc", "json2"] as const)("generic records (%s)", (api) => {
  let odoo: FakeOdoo;
  let executors: ReturnType<typeof createOdooExecutors>;
  let call: (name: string, args?: Record<string, unknown>) => Promise<{ isError: boolean; text: string; json: any }>;

  beforeEach(async () => {
    await odoo?.stop();
    odoo = new FakeOdoo({ models: recordModels() });
    await odoo.start();
    const client = new OdooClient({ url: odoo.url, db: "testdb", username: "bot@example.com", apiKey: "test-api-key", api });
    executors = createOdooExecutors(client);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await createOdooMcpServer(client).connect(serverT);
    const mcp = new Client({ name: "test", version: "0" });
    await mcp.connect(clientT);
    call = async (name, args = {}) => {
      const res = (await mcp.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      const text = res.content[0]!.text;
      return { isError: !!res.isError, text, json: res.isError ? null : JSON.parse(text) };
    };
  });
  afterAll(() => odoo.stop());

  const run = (type: string, payload: Record<string, unknown>) => executors[type]!.execute(payload) as Promise<any>;
  const prepare = (type: string, payload: Record<string, unknown>) => executors[type]!.prepare!(payload) as Promise<{ payload: any; note: string }>;
  const record = (model: string, id: number) => odoo.models[model]!.records.find((r) => r.id === id)!;
  const writes = () => odoo.calls.filter((c) => !["search_read", "read", "search_count", "fields_get", "search"].includes(c.method));

  describe("read tools", () => {
    it("describes a model's fields, filtered and compact", async () => {
      const d = (await call("describe_model", { model: "product.pricelist.item" })).json;
      expect(d).toMatchObject({ model: "product.pricelist.item", archivable: false });
      // Required first.
      expect(d.fields.slice(0, 2).map((f: any) => f.name)).toEqual(["applied_on", "pricelist_id"]);
      expect(d.fields.find((f: any) => f.name === "pricelist_id")).toEqual({ name: "pricelist_id", label: "Pricelist", type: "many2one", required: true, relation: "product.pricelist" });
      expect(d.fields.find((f: any) => f.name === "compute_price").selection).toEqual(["fixed: Fixed Price", "percentage: Discount", "formula: Formula"]);
      expect(d.fields.find((f: any) => f.name === "price")).toMatchObject({ readonly: true });

      const q = (await call("describe_model", { model: "res.partner", query: "company" })).json;
      expect(q.fields.map((f: any) => f.name).sort()).toEqual(["is_company", "parent_id"]);
      const w = (await call("describe_model", { model: "res.partner", types: ["many2one"], writable_only: true })).json;
      expect(w.fields.map((f: any) => [f.name, f.protected ?? false])).toEqual([["country_id", false], ["parent_id", false], ["x_bank_id", true]]);
      expect((await call("describe_model", { model: "res.partner", fields: ["signup_token", "nope"] })).json).toMatchObject({ fields: [{ name: "signup_token", protected: true }], unknown_fields: ["nope"] });
      expect((await call("describe_model", { model: "res.users" })).json.write_protected).toMatch(/user accounts/);
      expect((await call("describe_model", { model: "no.such" })).text).toMatch(/no no\.such model/);
      expect(writes()).toEqual([]);
    });

    it("gets one record with default or chosen fields, archived too", async () => {
      const r = (await call("get_record", { model: "res.partner", id: 10 })).json;
      expect(r.record).toMatchObject({ display_name: "Jane Doe", name: "Jane Doe", email: "jane@example.com", country_id: { id: 233, name: "United Kingdom" }, parent_id: null, active: true });
      expect(r.record).not.toHaveProperty("signup_token");
      expect(r.record).not.toHaveProperty("category_id");
      const chosen = (await call("get_record", { model: "res.partner", id: 31, fields: ["name", "active", "nope", "signup_token"] })).json;
      expect(chosen).toEqual({ model: "res.partner", id: 31, record: { name: "Old Supplier Co", active: false }, unknown_fields: ["nope"], withheld_fields: ["signup_token"] });
      expect((await call("get_record", { model: "res.partner", id: 999 })).text).toMatch(/No res\.partner with id 999/);
    });

    it("lists models and leaves archived records out of search_records unless asked", async () => {
      expect((await call("list_models", { query: "pricelist" })).json).toEqual([{ model: "product.pricelist", label: "Pricelist" }, { model: "product.pricelist.item", label: "Pricelist Rule" }]);
      expect((await call("list_models", { query: "cancel" })).json).toEqual([{ model: "sale.order.cancel", label: "Sales Order Cancel", wizard: true }]);
      expect((await call("list_models", { query: "res.users" })).json[0].write_protected).toMatch(/user accounts/);
      const active = (await call("search_records", { model: "res.partner", domain: [["is_company", "=", true]], fields: ["name"] })).json;
      expect(active.records.map((r: any) => r.name)).not.toContain("Old Supplier Co");
      const all = (await call("search_records", { model: "res.partner", domain: [["is_company", "=", true]], fields: ["name", "active"], include_archived: true })).json;
      expect(all.count).toBe(active.count + 1);
      expect(all.records.find((r: any) => r.name === "Old Supplier Co").active).toBeNull();
    });
  });

  describe("odoo.record.create", () => {
    it("checks the values, shows them by name with duplicates, and creates", async () => {
      const payload = { model: "res.partner", values: { name: "Jane Doe", email: "new@example.com", is_company: false, parent_id: 11, category_id: [1, 2], type: "delivery" }, recordPreview: { duplicates: "None found" } };
      const prepared = await prepare("odoo.record.create", payload);
      expect(prepared.payload.recordPreview).toEqual({
        model: "res.partner",
        label: "Contact",
        values: { Name: "Jane Doe", Email: "new@example.com", "Is a Company": "no", "Related Company": "Acme Robotics", Tags: "2 linked (Trade, School)", "Address Type": "Delivery Address" },
        duplicates: [{ id: 10, name: "Jane Doe", same: "Name" }],
      });
      expect(prepared.note).toBe('[New Contact "Jane Doe" (Email: new@example.com, Is a Company: no, Related Company: Acme Robotics, Tags: 2 linked (Trade, School)). Already in Odoo: Jane Doe #10, same Name.]');
      expect(writes()).toEqual([]);

      const result = await run("odoo.record.create", prepared.payload);
      expect(result).toEqual({ model: "res.partner", id: 32, name: "Jane Doe" });
      expect(record("res.partner", 32)).toMatchObject({ name: "Jane Doe", parent_id: 11, category_id: [1, 2], type: "delivery" });
    });

    it("finds an archived duplicate and says when there is none", async () => {
      const dup = await prepare("odoo.record.create", { model: "res.partner", values: { name: "Someone New", email: "OLD@supplier.example" } });
      expect(dup.payload.recordPreview.duplicates).toEqual([{ id: 31, name: "Old Supplier Co", same: "Email", archived: true }]);
      expect(dup.note).toContain("Old Supplier Co #31 (archived), same Email");
      const none = await prepare("odoo.record.create", { model: "product.pricelist.item", values: { pricelist_id: 1, applied_on: "1_product", product_tmpl_id: 12, compute_price: "fixed", fixed_price: 75, min_quantity: 10, date_start: "2026-12-01T00:00:00Z" } });
      expect(none.payload.recordPreview).toMatchObject({ label: "Pricelist Rule", duplicates: "None found", values: { Pricelist: "Trade (GBP)", Product: "300W spindle", "Apply On": "Product", "Fixed Price": "75", "Start Date": "2026-12-01 00:00:00" } });
      const { id } = await run("odoo.record.create", none.payload);
      expect(record("product.pricelist.item", id)).toMatchObject({ pricelist_id: 1, fixed_price: 75, date_start: "2026-12-01 00:00:00" });
    });

    it("refuses unknown, read-only, mistyped and protected values, all at once", async () => {
      await expect(prepare("odoo.record.create", { model: "res.partner", values: { name: "X", phon: "1", commercial_partner_id: 3, credit_limit: "lots", type: "home", parent_id: 999, signup_token: "t", bank_ids: [[0, 0, { acc_number: "GB00" }]] } })).rejects.toThrow(
        /7 problems: res\.partner has no field "phon" \(did you mean phone, phone_sanitized\?\); commercial_partner_id is read-only.*credit_limit \(float\) takes a number.*type \(selection\) takes one of "contact".*parent_id: no res\.partner with id 999.*signup_token can't be changed.*rule "secret-fields".*bank_ids can't be changed.*rule "protected-relations"/s,
      );
      await expect(run("odoo.record.create", { model: "res.partner", values: { name: "X", phon: "1" } })).rejects.toThrow(/no field "phon"/);
      await expect(prepare("odoo.record.create", { model: "res.partner", values: {} })).rejects.toThrow(/has no fields/);
      await expect(prepare("odoo.record.create", { model: "no.such", values: { name: "x" } })).rejects.toThrow(/Odoo has no no\.such model/);
      await expect(prepare("odoo.record.create", { model: "res.partner", values: { name: "X", child_ids: [[0, 0, { name: "Kid", password: "x" }]] } })).rejects.toThrow(/inside res\.partner\.child_ids.*secret-fields/);
      expect(writes()).toEqual([]);
    });
  });

  describe("odoo.record.update", () => {
    it("shows before → after for one record and writes it", async () => {
      const prepared = await prepare("odoo.record.update", { model: "res.partner", ids: [10], values: { city: "York", parent_id: 11, comment: "<p>Prefers email.</p>", phone: "+44 7700 900123" }, recordPreview: "agent says fine" });
      expect(prepared.payload.recordPreview).toEqual({
        model: "res.partner",
        label: "Contact",
        count: 1,
        records: [{ id: 10, name: "Jane Doe" }],
        changes: [
          { field: "city", label: "City", from: "Leeds", to: "York", changes: 1 },
          { field: "parent_id", label: "Related Company", from: "empty", to: "Acme Robotics", changes: 1 },
          { field: "comment", label: "Notes", from: "empty", to: "Prefers email.", changes: 1 },
          { field: "phone", label: "Phone", from: "+44 7700 900123", to: "+44 7700 900123", changes: 0 },
        ],
      });
      expect(prepared.note).toBe("[Contact Jane Doe: City: Leeds → York; Related Company: empty → Acme Robotics; Notes: empty → Prefers email..]");
      expect(writes()).toEqual([]);

      const result = await run("odoo.record.update", prepared.payload);
      expect(result).toEqual({ model: "res.partner", id: 10, name: "Jane Doe", from: { city: "Leeds", parent_id: false, comment: false, phone: "+44 7700 900123" }, to: { city: "York", parent_id: 11, comment: "<p>Prefers email.</p>", phone: "+44 7700 900123" } });
      expect(record("res.partner", 10)).toMatchObject({ city: "York", parent_id: 11 });
    });

    it("summarises many records in one approval", async () => {
      const prepared = await prepare("odoo.record.update", { model: "product.pricelist.item", ids: [1, 2, 3, 2], values: { min_quantity: 5, fixed_price: 79 } });
      expect(prepared.payload.recordPreview).toMatchObject({
        count: 3,
        records: [{ id: 1, name: "300W spindle: 79.00" }, { id: 2, name: "ER11 collet set (7 pcs): 21.00" }, { id: 3, name: "Milo v2 CNC kit: 1150.00" }],
        changes: [
          { field: "min_quantity", from: "1", to: "5", changes: 3 },
          { field: "fixed_price", from: [{ value: "79", records: 1 }, { value: "21", records: 1 }, { value: "1150", records: 1 }], to: "79", changes: 2 },
        ],
      });
      expect(prepared.note).toBe("[3 Pricelist Rule records (300W spindle: 79.00, ER11 collet set (7 pcs): 21.00, Milo v2 CNC kit: 1150.00): Min. Quantity: 1 → 5; Fixed Price: 3+ different values → 79.]");
      const result = await run("odoo.record.update", prepared.payload);
      expect(result).toMatchObject({ model: "product.pricelist.item", ids: [1, 2, 3], count: 3, to: { min_quantity: 5, fixed_price: 79 } });
      expect(result.records[1]).toEqual({ id: 2, name: "ER11 collet set (7 pcs): 21.00", from: { min_quantity: 1, fixed_price: 21 } });
      expect(odoo.callsTo("write")).toHaveLength(1);
      expect([1, 2, 3].map((id) => record("product.pricelist.item", id).fixed_price)).toEqual([79, 79, 79]);
    });

    it("says when nothing would change, and keeps brackets out of the note", async () => {
      const same = await prepare("odoo.record.update", { model: "res.partner", ids: [10], values: { city: "Leeds" } });
      expect(same.note).toBe("[Contact Jane Doe: no change, already set.]");
      odoo.update("res.partner", 10, { display_name: "[VIP] Jane Doe" });
      expect((await prepare("odoo.record.update", { model: "res.partner", ids: [10], values: { city: "York" } })).note).toBe("[Contact (VIP) Jane Doe: City: Leeds → York.]");
    });

    it("refuses missing records, bad values and too many ids", async () => {
      await expect(prepare("odoo.record.update", { model: "res.partner", ids: [10, 998, 999], values: { city: "York" } })).rejects.toThrow(/No res\.partner with id 998, 999/);
      await expect(run("odoo.record.update", { model: "res.partner", ids: [10], values: { name: false } })).rejects.toThrow(/name is required/);
      await expect(prepare("odoo.record.update", { model: "res.partner", ids: Array.from({ length: 201 }, (_, i) => i + 1), values: { city: "York" } })).rejects.toThrow(/Invalid payload/);
      await expect(prepare("odoo.record.update", { model: "res.partner", ids: [], values: { city: "York" } })).rejects.toThrow(/Invalid payload/);
      await expect(prepare("odoo.record.update", { model: "res.partner; drop", ids: [1], values: { city: "York" } })).rejects.toThrow(/Invalid payload/);
      expect(writes()).toEqual([]);
    });

    it("leaves an Odoo user's contact email and archiving alone, and never reads files back", async () => {
      await expect(prepare("odoo.record.update", { model: "res.partner", ids: [10, 7], values: { email: "someone@else.example" } })).rejects.toThrow(/email of Command Centre, who is an Odoo user, can't be changed.*rule "user-contacts".*password resets/);
      await expect(run("odoo.record.update", { model: "res.partner", ids: [7], values: { email: "someone@else.example" } })).rejects.toThrow(/user-contacts/);
      await expect(prepare("odoo.record.archive", { model: "res.partner", ids: [7] })).rejects.toThrow(/user-contacts/);
      await expect(run("odoo.record.archive", { model: "res.partner", ids: [7] })).rejects.toThrow(/user-contacts/);
      // Other fields of that contact, and the email of anyone who isn't a user, are ordinary data.
      expect((await prepare("odoo.record.update", { model: "res.partner", ids: [7], values: { city: "Leeds" } })).note).toBe("[Contact Command Centre: City: empty → Leeds.]");
      expect((await prepare("odoo.record.update", { model: "res.partner", ids: [10], values: { email: "jane@new.example" } })).note).toMatch(/Email: jane@example.com → jane@new.example/);
      await expect(prepare("odoo.record.update", { model: "res.partner", ids: [10], values: { x_bank_id: 1 } })).rejects.toThrow(/x_bank_id can't be changed.*rule "protected-relations"/);
      await expect(prepare("odoo.record.update", { model: "res.partner", ids: [10], values: { user_ids: [7] } })).rejects.toThrow(/user_ids \(a list of res\.users\).*rule "users"/);

      const picture = await prepare("odoo.record.update", { model: "res.partner", ids: [10], values: { image_1920: "aGVsbG8=" } });
      expect(picture.payload.recordPreview.changes).toEqual([{ field: "image_1920", label: "Image", from: "(the current file)", to: "(new file)", changes: 1 }]);
      expect(odoo.callsTo("search_read").at(-1)!.params.fields).not.toContain("image_1920");
      expect(await run("odoo.record.update", picture.payload)).toMatchObject({ id: 10, from: {}, to: { image_1920: "(file)" } });
      expect(record("res.partner", 10).image_1920).toBe("aGVsbG8=");
    });

    it("edits only a draft invoice, and only its simple fields", async () => {
      const draft = await prepare("odoo.record.update", { model: "account.move", ids: [11], values: { ref: "PO 4471", invoice_date_due: "2026-12-15" } });
      expect(draft.note).toMatch(/Reference: empty → PO 4471; Due Date: empty → 2026-12-15/);
      await run("odoo.record.update", draft.payload);
      expect(record("account.move", 11)).toMatchObject({ ref: "PO 4471", invoice_date_due: "2026-12-15", state: "draft" });

      await expect(prepare("odoo.record.update", { model: "account.move", ids: [9], values: { ref: "x" } })).rejects.toThrow(/INV\/2026\/00009 is posted: only a draft invoice can be edited \(rule "accounting-entries"\)/);
      await expect(run("odoo.record.update", { model: "account.move", ids: [11, 9], values: { ref: "x" } })).rejects.toThrow(/only a draft invoice/);
      await expect(prepare("odoo.record.update", { model: "account.move", ids: [11], values: { amount_total: 1 } })).rejects.toThrow(/amount_total of an invoice can't be changed here/);
      await expect(prepare("odoo.record.update", { model: "account.move", ids: [11], values: { state: "posted" } })).rejects.toThrow(/state of an invoice can't be changed here/);
      odoo.update("account.move", 11, { move_type: "entry" });
      await expect(prepare("odoo.record.update", { model: "account.move", ids: [11], values: { ref: "x" } })).rejects.toThrow(/journal entry/);
      expect(record("account.move", 9).ref).toBeUndefined();
    });
  });

  describe("denylist", () => {
    it("refuses protected models on every generic action, naming the rule, before touching Odoo", async () => {
      odoo.calls.length = 0;
      const cases: [string, Record<string, unknown>, RegExp][] = [
        ["odoo.record.create", { model: "res.users", values: { name: "x", login: "x" } }, /res\.users can't be changed with the generic record actions \(rule "users"/],
        ["odoo.record.update", { model: "res.users", ids: [7], values: { name: "Admin" } }, /rule "users"/],
        ["odoo.record.update", { model: "res.groups", ids: [1], values: { name: "x" } }, /rule "groups"/],
        ["odoo.record.create", { model: "ir.config_parameter", values: { key: "k", value: "v" } }, /rule "system"/],
        ["odoo.record.create", { model: "ir.attachment", values: { name: "x" } }, /rule "system"/],
        ["odoo.record.create", { model: "base.automation", values: { name: "x" } }, /rule "automation"/],
        ["odoo.record.update", { model: "payment.provider", ids: [1], values: { state: "enabled" } }, /rule "payments"/],
        ["odoo.record.create", { model: "account.move", values: { ref: "x" } }, /rule "accounting-entries"/],
        ["odoo.record.update", { model: "account.move.line", ids: [1], values: { price_unit: 1 } }, /rule "accounting-entries"/],
        ["odoo.record.create", { model: "account.payment", values: { amount: 5 } }, /rule "accounting-money"/],
        ["odoo.record.update", { model: "res.partner.bank", ids: [1], values: { acc_number: "x" } }, /rule "bank-accounts"/],
        ["odoo.record.create", { model: "mail.mail", values: { subject: "x" } }, /rule "mail".*odoo\.message\.post/],
        ["odoo.record.create", { model: "mail.message", values: { body: "x" } }, /rule "mail"/],
        ["odoo.record.update", { model: "res.company", ids: [1], values: { name: "x" } }, /rule "company-settings"/],
        ["odoo.record.create", { model: "res.config.settings", values: { x: true } }, /rule "company-settings"/],
        ["odoo.record.archive", { model: "res.users", ids: [7] }, /rule "users"/],
        ["odoo.record.unarchive", { model: "ir.cron", ids: [1] }, /rule "system"/],
        ["odoo.record.action", { model: "account.move", ids: [11], method: "action_post" }, /rule "accounting-entries"/],
        ["odoo.record.action", { model: "ir.module.module", ids: [1], method: "button_immediate_install" }, /rule "system"/],
      ];
      for (const [type, payload, message] of cases) {
        await expect(prepare(type, payload), `${type} ${String(payload.model)} prepare`).rejects.toThrow(message);
        await expect(run(type, payload), `${type} ${String(payload.model)} execute`).rejects.toThrow(message);
      }
      expect(odoo.calls).toEqual([]);
    });

    it("refuses wizards, which are not data", async () => {
      await expect(prepare("odoo.record.create", { model: "sale.order.cancel", values: { display_name: "x" } })).rejects.toThrow(/sale\.order\.cancel is a wizard/);
      await expect(run("odoo.record.action", { model: "sale.order.cancel", ids: [1], method: "action_cancel" })).rejects.toThrow(/is a wizard/);
    });

    it("has no delete action", () => {
      expect(Object.keys(executors).filter((k) => k.startsWith("odoo.record.")).sort()).toEqual(["odoo.record.action", "odoo.record.archive", "odoo.record.create", "odoo.record.unarchive", "odoo.record.update"]);
      expect(Object.keys(executors).filter((k) => /delete|unlink/.test(k))).toEqual([]);
    });
  });

  describe("odoo.record.archive / unarchive", () => {
    it("archives by name, skips what is already archived, and restores", async () => {
      const prepared = await prepare("odoo.record.archive", { model: "res.partner", ids: [30, 31] });
      expect(prepared.payload.recordPreview).toEqual({ model: "res.partner", label: "Contact", count: 2, records: [{ id: 30, name: "Spindle Supplies Ltd" }, { id: 31, name: "Old Supplier Co" }] });
      expect(prepared.note).toBe("[Archive 2 Contact records (Spindle Supplies Ltd, Old Supplier Co); 1 already archived.]");
      expect(await run("odoo.record.archive", prepared.payload)).toMatchObject({ model: "res.partner", archived: 1, already: 1 });
      expect(record("res.partner", 30).active).toBe(false);
      expect(odoo.callsTo("write")[0]!.params).toMatchObject({ ids: [30], vals: { active: false } });

      const back = await prepare("odoo.record.unarchive", { model: "res.partner", ids: [30] });
      expect(back.note).toBe("[Restore Contact Spindle Supplies Ltd.]");
      expect(await run("odoo.record.unarchive", back.payload)).toMatchObject({ restored: 1, already: 0 });
      expect(record("res.partner", 30).active).toBe(true);
    });

    it("says so when a model can't be archived", async () => {
      await expect(prepare("odoo.record.archive", { model: "crm.stage", ids: [1] })).rejects.toThrow(/crm\.stage records can't be archived: the model has no "active" field/);
      await expect(prepare("odoo.record.archive", { model: "res.partner", ids: [999] })).rejects.toThrow(/No res\.partner with id 999/);
    });
  });

  describe("odoo.record.action", () => {
    it("presses a workflow button and reports the state change", async () => {
      const prepared = await prepare("odoo.record.action", { model: "sale.order", ids: [41], method: "action_confirm" });
      expect(prepared.payload.recordPreview).toEqual({ model: "sale.order", label: "Sales Order", count: 1, records: [{ id: 41, name: "S00041", state: "draft" }], method: "action_confirm" });
      expect(prepared.note).toBe("[action_confirm on Sales Order S00041, now Quotation.]");
      expect(writes()).toEqual([]);
      expect(await run("odoo.record.action", prepared.payload)).toEqual({ model: "sale.order", method: "action_confirm", ids: [41], records: [{ id: 41, name: "S00041", from: "Quotation", to: "Sales Order" }] });
      expect(record("sale.order", 41).state).toBe("sale");
    });

    it("stops at a wizard instead of guessing, and passes Odoo's own refusals on", async () => {
      await expect(run("odoo.record.action", { model: "sale.order", ids: [41], method: "action_cancel" })).rejects.toThrow(/opened the wizard sale\.order\.cancel.*Nothing was changed/);
      expect(record("sale.order", 41).state).toBe("draft");
      expect(odoo.callsTo("create")).toEqual([]);
      await expect(run("odoo.record.action", { model: "sale.order", ids: [42], method: "action_confirm" })).rejects.toThrow(/Only quotations can be confirmed/);
      await expect(run("odoo.record.action", { model: "sale.order", ids: [41], method: "action_nope" })).rejects.toThrow(/does not exist/);
    });

    it("refuses anything that is not a no-argument button", async () => {
      for (const method of ["write", "unlink", "message_post", "_compute_x", "action_unlink"]) {
        await expect(prepare("odoo.record.action", { model: "sale.order", ids: [41], method }), method).rejects.toThrow(/not a workflow button|deletes or uninstalls/);
        await expect(run("odoo.record.action", { model: "sale.order", ids: [41], method }), method).rejects.toThrow(/not a workflow button|deletes or uninstalls/);
      }
      expect(writes()).toEqual([]);
    });
  });
});
