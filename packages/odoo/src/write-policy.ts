/**
 * What the generic record actions (`odoo.record.*`) refuse, whoever approves. They let an agent
 * propose a change to any model, so the models that decide who can do what, run code, hold
 * secrets, send messages or move money are fenced off here; those are changed in Odoo itself
 * (or through the dedicated action named in the rule). Everything else waits for Dave's approval
 * like any `odoo.*` action. One list, so a rule is lifted or added in one place.
 */

export interface WriteDenyRule {
  /** Short id, quoted in the refusal so it is clear which rule applied. */
  rule: string;
  /** Models the rule covers. */
  models?: RegExp;
  /** Field names the rule covers, on any model. */
  fields?: RegExp;
  /** Field relations the rule covers: a field pointing at these models can't be written. */
  relations?: RegExp;
  /** What it protects, ending the sentence "… is changed in Odoo itself: <why>". */
  why: string;
}

export const GENERIC_WRITE_DENYLIST: readonly WriteDenyRule[] = [
  // Logins, passwords, API keys, 2FA and which companies/groups a user is in: an edit here is a privilege escalation.
  { rule: "users", models: /^(res\.users(\..+)?|change\.password\..+|auth[._].+)$/, why: "user accounts, passwords, API keys and sign-in settings" },
  // Access groups decide what every user (and the bot) may do.
  { rule: "groups", models: /^res\.groups(\..+)?$/, why: "access groups" },
  // ir.*: record rules, model access, system parameters (which hold secrets), scheduled and server
  // actions (which run code), views, attachments, sequences, mail servers, modules. Attachments are
  // included on purpose: an upload path needs its own action with size and type checks.
  { rule: "system", models: /^ir\./, why: "Odoo's technical settings (access rules, system parameters, scheduled and server actions, views, attachments, modules)" },
  // Automation rules and other base.* tools run server code on triggers, or change the database itself.
  { rule: "automation", models: /^base\./, why: "automation rules and database tools, which run code" },
  // Payment providers hold gateway credentials; tokens are stored cards; transactions are money.
  { rule: "payments", models: /^payment\./, why: "payment providers, tokens and transactions" },
  // Journal entries and their lines: invoices are created, posted, sent and paid through the odoo.invoice.* and
  // odoo.purchase.bill actions. The one exception (in code, see DRAFT_INVOICE_FIELDS): simple fields of a draft invoice.
  { rule: "accounting-entries", models: /^account\.move(\.line)?$/, why: "journal entries and invoices (use the odoo.invoice.* actions; only a draft invoice's reference, dates, terms and notes can be edited here)" },
  // Payments, bank statements and reconciliation move or match money.
  { rule: "accounting-money", models: /^account\.(payment|payment\.register|bank\.statement(\..+)?|partial\.reconcile|full\.reconcile|reconcile\..+)$/, why: "payments, bank statements and reconciliation (use odoo.invoice.register_payment)" },
  // A vendor's bank account is where payments go: the classic invoice-fraud edit.
  { rule: "bank-accounts", models: /^res\.(partner\.bank|bank)$/, why: "bank accounts, where payments are sent" },
  // Emails and chatter go out through odoo.message.post / email actions, which show Dave the text; templates render code.
  { rule: "mail", models: /^(mail\.(mail|message|compose\.message|template|alias(\..+)?)|sms\.(sms|composer|template)|mailing\..+)$/, why: "emails, chatter messages, templates and mass mailings (use odoo.message.post)" },
  // The company record and the settings screens change how every app behaves.
  { rule: "company-settings", models: /^(res\.company|res\.config(\..+)?)$/, why: "the company and Odoo's settings" },
  // Website pages are QWeb views (code); blog posts and products are fine.
  { rule: "website-pages", models: /^(website\.page|website\.controller\.page|theme\..+)$/, why: "website pages and themes, which are templates" },
  // Secrets and access on any model, whatever it is.
  { rule: "secret-fields", fields: /^(password|new_password|passwd|new_passwd|totp_secret|signup_token|access_token|.*api_?key.*|.*secret.*|groups_id|group_ids|implied_ids)$/, why: "passwords, keys, tokens and group membership" },
  // A field that points at users' groups, or creates records in a protected model through an x2many.
  { rule: "protected-relations", relations: /^res\.groups$/, why: "access groups" },
];

/**
 * The fields of a DRAFT customer invoice or vendor bill the generic update may change: its
 * references, dates, payment terms and notes. Lines, amounts, partner and state are not here:
 * those go through the invoice actions or Odoo.
 */
export const DRAFT_INVOICE_FIELDS: readonly string[] = ["ref", "payment_reference", "invoice_date", "invoice_date_due", "invoice_payment_term_id", "narration", "invoice_origin", "invoice_user_id", "partner_shipping_id"];

/** Methods `odoo.record.action` may press: workflow buttons, never anything that deletes. */
export const ACTION_METHOD = /^(action_|button_)[a-z0-9_]+$/;
const DELETING_METHOD = /unlink|delete|uninstall/;

export const deniedModel = (model: string): WriteDenyRule | undefined => GENERIC_WRITE_DENYLIST.find((r) => r.models?.test(model));

export const deniedField = (field: string, relation?: string): WriteDenyRule | undefined =>
  GENERIC_WRITE_DENYLIST.find((r) => r.fields?.test(field) || (relation !== undefined && r.relations?.test(relation)));

/** Why a button method can't be pressed through the generic action, or undefined when it can. */
export function deniedMethod(method: string): string | undefined {
  if (!ACTION_METHOD.test(method)) return `"${method}" is not a workflow button: only methods named action_… or button_… can be pressed, without arguments`;
  if (DELETING_METHOD.test(method)) return `"${method}" deletes or uninstalls, which is done in Odoo itself (rule no-delete)`;
  return undefined;
}

/** The refusal for a rule, naming it. */
export const denial = (what: string, rule: WriteDenyRule) =>
  `${what} can't be changed with the generic record actions (rule "${rule.rule}": ${rule.why}). Do it in Odoo itself`;
