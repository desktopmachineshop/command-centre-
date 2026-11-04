/**
 * Everything the Accounts page can manage. A kind is one type of sign-in (Odoo, an email
 * mailbox, an Instagram account...). `multi` kinds have one entry per account; the others have
 * a single entry with id "default". The page renders straight from this list, and saves are
 * checked against `fields` before effective.ts turns entries into server config.
 */
export type Group = "runner" | "triage" | "voice" | "odoo" | "shipping" | "email" | "social" | "calendar" | "storage";
export const GROUPS: readonly Group[] = ["runner", "triage", "voice", "odoo", "shipping", "email", "social", "calendar", "storage"];

export type Section = "ai" | "business" | "google" | "social" | "apps" | "settings";

export type OAuthProvider = "google" | "youtube" | "instagram" | "threads" | "x" | "reddit" | "microsoft" | "gmail";

export interface Field {
  key: string;
  label: string;
  type: "text" | "secret" | "url" | "email" | "number" | "boolean" | "select" | "list" | "json";
  required?: boolean;
  options?: readonly string[];
  placeholder?: string;
  help?: string;
  default?: string | number | boolean;
  /** Filled in by the sign-in flow, not typed (shown read-only). */
  fromOAuth?: boolean;
}

export interface KindDef {
  kind: string;
  label: string;
  section: Section;
  description: string;
  /** One entry per account (with an id), or a single "default" entry. */
  multi: boolean;
  fields: readonly Field[];
  /** A "Connect" button signs in instead of typing the fromOAuth fields. */
  oauth?: OAuthProvider;
  /** A server-run sign-in other than OAuth ("claude": `claude setup-token` on the server). */
  connect?: "claude";
  /** Developer app kind whose keys the sign-in needs. */
  needsApp?: string;
  /** Config groups to reload when an entry of this kind changes. */
  affects: readonly Group[];
  /** Where to get the values. */
  helpUrl?: string;
}

export const DEFAULT_ID = "default";

const vertical: Field = { key: "vertical", label: "Business", type: "select", required: true, help: "Which business this account speaks for." };
const handle: Field = { key: "handle", label: "Handle", type: "text", placeholder: "@name" };
const displayName: Field = { key: "displayName", label: "Display name", type: "text" };
const inbound: Field = { key: "inbound", label: "Watch for comments, mentions and DMs", type: "boolean", default: true };
const options: Field = { key: "options", label: "Advanced options (JSON)", type: "json", help: "Platform settings, e.g. Discord channel ids or Reddit subreddits." };

export const CATALOG: readonly KindDef[] = [
  // --- AI ---
  {
    kind: "claude",
    label: "Claude (subscription)",
    section: "ai",
    description: "Runs every agent on your Claude subscription. Press Connect to sign in with your Claude account (or paste a token from `claude setup-token`).",
    multi: false,
    connect: "claude",
    fields: [
      { key: "runner", label: "Agents", type: "select", options: ["claude-code", "echo"], default: "claude-code", help: "echo = no AI calls (testing)." },
      { key: "oauthToken", label: "Subscription token", type: "secret", placeholder: "sk-ant-oat01-…" },
    ],
    affects: ["runner"],
    helpUrl: "https://docs.claude.com/en/docs/claude-code/setup",
  },
  {
    kind: "anthropic",
    label: "Anthropic API",
    section: "ai",
    description: "Optional pay-as-you-go keys: a fallback when the subscription hits its limit, and the cheap Haiku triage classifier.",
    multi: false,
    fields: [
      { key: "fallbackApiKey", label: "Fallback key (agents)", type: "secret", placeholder: "sk-ant-api03-…" },
      { key: "triageApiKey", label: "Triage key (Haiku)", type: "secret", placeholder: "sk-ant-api03-…" },
    ],
    affects: ["runner", "triage"],
    helpUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    kind: "jev",
    label: "Jev (TypeSafe)",
    section: "ai",
    description: "System One triage: decides cheaply what each incoming message is before any agent runs.",
    multi: false,
    fields: [
      { key: "apiKey", label: "API key", type: "secret", required: true },
      { key: "baseUrl", label: "Base URL", type: "url", placeholder: "https://api.typesafe.ai" },
      { key: "model", label: "Model", type: "text", placeholder: "jev-latest" },
    ],
    affects: ["triage"],
  },
  {
    kind: "openai",
    label: "OpenAI (voice)",
    section: "ai",
    description: "Server speech-to-text and voices for Drive mode and video narration.",
    multi: false,
    fields: [{ key: "apiKey", label: "API key", type: "secret", required: true, placeholder: "sk-…" }],
    affects: ["voice"],
    helpUrl: "https://platform.openai.com/api-keys",
  },
  {
    kind: "elevenlabs",
    label: "ElevenLabs (voice)",
    section: "ai",
    description: "Natural voices (and transcription) for Drive mode and video narration.",
    multi: false,
    fields: [{ key: "apiKey", label: "API key", type: "secret", required: true }],
    affects: ["voice"],
    helpUrl: "https://elevenlabs.io/app/settings/api-keys",
  },
  // --- Business ---
  {
    kind: "odoo",
    label: "Odoo",
    section: "business",
    description: "Products, orders, customers and chatter for Desktop Machine Shop and 3dpandme. Your Odoo plan must allow the external API.",
    multi: false,
    fields: [
      { key: "url", label: "Odoo URL", type: "url", required: true, placeholder: "https://yourcompany.odoo.com" },
      { key: "db", label: "Database", type: "text", required: true, help: "Usually the subdomain, e.g. yourcompany." },
      { key: "username", label: "Login email", type: "email", required: true },
      { key: "apiKey", label: "API key", type: "secret", required: true, help: "Odoo: your avatar → My Profile → Account Security → New API Key." },
      { key: "api", label: "API", type: "select", options: ["jsonrpc", "json2"], default: "jsonrpc", help: "json2 for Odoo 19+." },
    ],
    affects: ["odoo"],
  },
  {
    kind: "sendcloud",
    label: "Sendcloud",
    section: "business",
    description: "Parcel tracking: each day's digest lists what was delivered, what is in transit and anything stuck or failed, and agents can look up where an order is. Read-only.",
    multi: true,
    fields: [
      { ...vertical, default: "dms", help: "Which business ships with this Sendcloud account." },
      { key: "publicKey", label: "Public key", type: "text", required: true },
      { key: "secretKey", label: "Secret key", type: "secret", required: true, help: "Sendcloud: Settings → Integrations → Sendcloud API → Connect, then copy both keys." },
    ],
    affects: ["shipping"],
    helpUrl: "https://app.sendcloud.com/v2/settings/integrations/manage",
  },
  {
    kind: "email",
    label: "Other email inbox",
    section: "business",
    description: "Any other IMAP/SMTP mailbox (your host's email, iCloud, Yahoo...). Agents read it and draft replies, which always need your approval. For Gmail use Gmail inbox, for Outlook / Hotmail use Outlook / Hotmail inbox.",
    multi: true,
    fields: [
      vertical,
      { key: "address", label: "Address", type: "email", required: true },
      displayName,
      { key: "imapHost", label: "IMAP host", type: "text", required: true, placeholder: "imap.gmail.com" },
      { key: "imapPort", label: "IMAP port", type: "number", default: 993 },
      { key: "imapSecure", label: "IMAP TLS", type: "boolean", default: true },
      { key: "smtpHost", label: "SMTP host", type: "text", required: true, placeholder: "smtp.gmail.com" },
      { key: "smtpPort", label: "SMTP port", type: "number", default: 465 },
      { key: "smtpSecure", label: "SMTP TLS", type: "boolean", default: true },
      { key: "user", label: "Username", type: "text", help: "Defaults to the address." },
      { key: "password", label: "Password / app password", type: "secret", required: true },
      { key: "mailbox", label: "Folder", type: "text", default: "INBOX" },
      { key: "ignoreFrom", label: "Ignore senders", type: "list", help: "Addresses or @domain, one per line." },
      {
        key: "sendVia",
        label: "Send replies with",
        type: "select",
        options: ["auto", "smtp", "gmail"],
        default: "auto",
        help: "auto: the Gmail API when the same address is connected under Google (needed on hosts that block SMTP), else SMTP.",
      },
    ],
    affects: ["email"],
    helpUrl: "https://myaccount.google.com/apppasswords",
  },
  {
    kind: "gmail",
    label: "Gmail inbox",
    section: "business",
    description: "A Gmail or Google Workspace mailbox: press Connect and sign in, nothing to paste. Reads new mail and sends replies (always after your approval) through Google.",
    multi: true,
    oauth: "gmail",
    needsApp: "google-app",
    fields: [
      vertical,
      { key: "address", label: "Signed in as", type: "email", fromOAuth: true },
      displayName,
      { key: "refreshToken", label: "Refresh token", type: "secret", fromOAuth: true },
      { key: "mailbox", label: "Folder", type: "text", default: "INBOX" },
      { key: "ignoreFrom", label: "Ignore senders", type: "list", help: "Addresses or @domain, one per line." },
    ],
    affects: ["email"],
  },
  {
    kind: "outlook",
    label: "Outlook / Hotmail inbox",
    section: "business",
    description: "An Outlook.com, Hotmail, Live or Microsoft 365 mailbox. Microsoft only allows sign-in (no passwords), so press Connect. Replies always need your approval.",
    multi: true,
    oauth: "microsoft",
    needsApp: "microsoft-app",
    fields: [
      vertical,
      { key: "address", label: "Signed in as", type: "email", fromOAuth: true },
      displayName,
      { key: "refreshToken", label: "Refresh token", type: "secret", fromOAuth: true },
      { key: "mailbox", label: "Folder", type: "text", default: "INBOX" },
      { key: "ignoreFrom", label: "Ignore senders", type: "list", help: "Addresses or @domain, one per line." },
    ],
    affects: ["email"],
  },
  // --- Google ---
  {
    kind: "google",
    label: "Google account",
    section: "google",
    description: "Calendar and contacts for the personal assistant, and Drive for large files (only files the app creates).",
    multi: true,
    oauth: "google",
    needsApp: "google-app",
    fields: [
      { key: "email", label: "Signed in as", type: "email", fromOAuth: true },
      { key: "refreshToken", label: "Refresh token", type: "secret", fromOAuth: true },
      { ...vertical, default: "personal", help: "Whose agents may use this calendar." },
      { key: "calendars", label: "Calendars", type: "json", help: 'Picked after connecting, e.g. [{"id":"primary"}].', default: '[{"id":"primary"}]' },
      { key: "useForCalendar", label: "Use for Calendar", type: "boolean", default: true },
      { key: "sendMail", label: "Can send Gmail", type: "boolean", fromOAuth: true, help: "An email inbox with the same address sends its replies through this sign-in." },
    ],
    affects: ["calendar", "storage", "email"],
  },
  // --- Social ---
  {
    kind: "instagram",
    label: "Instagram",
    section: "social",
    description: "Post, and reply to comments and DMs (replies need your approval). Needs a professional (business/creator) account.",
    multi: true,
    oauth: "instagram",
    needsApp: "instagram-app",
    fields: [vertical, handle, displayName, inbound, { key: "accessToken", label: "Access token", type: "secret", fromOAuth: true }, { key: "igUserId", label: "Instagram user id", type: "text", fromOAuth: true }, options],
    affects: ["social"],
  },
  {
    kind: "threads",
    label: "Threads",
    section: "social",
    description: "Post, and reply to replies and mentions.",
    multi: true,
    oauth: "threads",
    needsApp: "threads-app",
    fields: [vertical, handle, displayName, inbound, { key: "accessToken", label: "Access token", type: "secret", fromOAuth: true }, { key: "threadsUserId", label: "Threads user id", type: "text", fromOAuth: true }, options],
    affects: ["social"],
  },
  {
    kind: "x",
    label: "X",
    section: "social",
    description: "Posting only. Each post costs money on X's pay-per-use API (about $0.015, $0.20 with a link).",
    multi: true,
    oauth: "x",
    needsApp: "x-app",
    fields: [vertical, handle, displayName, { key: "accessToken", label: "Access token", type: "secret", fromOAuth: true }, { key: "accessTokenSecret", label: "Access token secret", type: "secret", fromOAuth: true }, options],
    affects: ["social"],
  },
  {
    kind: "reddit",
    label: "Reddit",
    section: "social",
    description: "Post, and reply to comments and messages. Reddit must approve your API access first.",
    multi: true,
    oauth: "reddit",
    needsApp: "reddit-app",
    fields: [vertical, handle, displayName, inbound, { key: "refreshToken", label: "Refresh token", type: "secret", fromOAuth: true }, options],
    affects: ["social"],
  },
  {
    kind: "youtube",
    label: "YouTube",
    section: "social",
    description: "Upload videos, and reply to comments. Uses the Google app below.",
    multi: true,
    oauth: "youtube",
    needsApp: "google-app",
    fields: [vertical, handle, displayName, inbound, { key: "refreshToken", label: "Refresh token", type: "secret", fromOAuth: true }, { key: "channelId", label: "Channel id", type: "text", fromOAuth: true }, options],
    affects: ["social"],
  },
  {
    kind: "discord",
    label: "Discord",
    section: "social",
    description: "A bot in your server: posts announcements and answers questions (answers need your approval).",
    multi: true,
    fields: [vertical, handle, displayName, inbound, { key: "botToken", label: "Bot token", type: "secret", required: true }, { ...options, help: 'e.g. {"channels":["123…"]}' }],
    affects: ["social"],
    helpUrl: "https://discord.com/developers/applications",
  },
  // --- Developer apps: one-time keys the sign-ins use ---
  {
    kind: "google-app",
    label: "Google OAuth client",
    section: "apps",
    description: "A Web application OAuth client from Google Cloud Console. Used by Google and YouTube sign-in.",
    multi: false,
    fields: [
      { key: "clientId", label: "Client ID", type: "text", required: true, placeholder: "…apps.googleusercontent.com" },
      { key: "clientSecret", label: "Client secret", type: "secret", required: true },
    ],
    affects: ["calendar", "storage", "social"],
    helpUrl: "https://console.cloud.google.com/apis/credentials",
  },
  {
    kind: "instagram-app",
    label: "Instagram app (Meta)",
    section: "apps",
    description: "Meta app → Instagram → API setup with Instagram login: the Instagram app ID and secret.",
    multi: false,
    fields: [
      { key: "appId", label: "Instagram app ID", type: "text", required: true },
      { key: "appSecret", label: "Instagram app secret", type: "secret", required: true },
    ],
    affects: ["social"],
    helpUrl: "https://developers.facebook.com/apps/",
  },
  {
    kind: "threads-app",
    label: "Threads app (Meta)",
    section: "apps",
    description: "Meta app → Threads use case → Settings: the Threads app ID and secret.",
    multi: false,
    fields: [
      { key: "appId", label: "Threads app ID", type: "text", required: true },
      { key: "appSecret", label: "Threads app secret", type: "secret", required: true },
    ],
    affects: ["social"],
    helpUrl: "https://developers.facebook.com/apps/",
  },
  {
    kind: "x-app",
    label: "X app",
    section: "apps",
    description: "X developer portal → your app → Keys and tokens: the API key and secret (consumer keys). Set the app to Read and write.",
    multi: false,
    fields: [
      { key: "apiKey", label: "API key", type: "text", required: true },
      { key: "apiSecret", label: "API key secret", type: "secret", required: true },
    ],
    affects: ["social"],
    helpUrl: "https://developer.x.com/en/portal/dashboard",
  },
  {
    kind: "reddit-app",
    label: "Reddit app",
    section: "apps",
    description: "reddit.com/prefs/apps → a \"web app\": its client id and secret.",
    multi: false,
    fields: [
      { key: "clientId", label: "Client id", type: "text", required: true },
      { key: "clientSecret", label: "Secret", type: "secret", required: true },
      { key: "userAgent", label: "User agent", type: "text", placeholder: "web:command-centre:1.0 (by /u/yourname)" },
    ],
    affects: ["social"],
    helpUrl: "https://www.reddit.com/prefs/apps",
  },
  {
    kind: "microsoft-app",
    label: "Microsoft app",
    section: "apps",
    description: "An app registration in Microsoft Entra (Azure portal → App registrations → New registration, \"Personal Microsoft accounts and work accounts\", platform Web). Used by Outlook / Hotmail sign-in.",
    multi: false,
    fields: [
      { key: "clientId", label: "Application (client) ID", type: "text", required: true },
      { key: "clientSecret", label: "Client secret (value)", type: "secret", required: true },
      { key: "tenant", label: "Tenant", type: "text", default: "common", help: "\"common\" for Outlook.com/Hotmail and most work accounts." },
    ],
    affects: ["email"],
    helpUrl: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
  },
  // --- Settings (no secrets) ---
  {
    kind: "voice",
    label: "Voice settings",
    section: "settings",
    description: "Which server voice service to use. \"auto\" picks whichever key is set; \"off\" uses the phone's own speech.",
    multi: false,
    fields: [
      { key: "stt", label: "Speech to text", type: "select", options: ["auto", "openai", "elevenlabs", "off"], default: "auto" },
      { key: "tts", label: "Text to speech", type: "select", options: ["auto", "openai", "elevenlabs", "off"], default: "auto" },
      { key: "openaiVoice", label: "OpenAI voice", type: "text", placeholder: "fable" },
      { key: "elevenlabsVoice", label: "ElevenLabs voice id", type: "text" },
    ],
    affects: ["voice"],
  },
  {
    kind: "storage",
    label: "File storage",
    section: "settings",
    description: "Where large files go: the server's volume, or a connected Google account's Drive.",
    multi: false,
    fields: [
      { key: "backend", label: "Store files in", type: "select", options: ["local", "gdrive"], default: "local" },
      { key: "googleAccount", label: "Google account (for Drive)", type: "text", help: "The id of a connected Google account." },
    ],
    affects: ["storage"],
  },
];

export const KINDS: ReadonlyMap<string, KindDef> = new Map(CATALOG.map((k) => [k.kind, k]));

/** Bootstrap settings that stay in Railway (the server needs them before it can read the database). */
export const RAILWAY_ONLY = [
  { name: "DATABASE_URL", label: "Database" },
  { name: "ADMIN_TOKEN", label: "Admin token" },
  { name: "WORKER_TOKEN", label: "Worker token (optional: only for workers run by hand)" },
  { name: "WEBHOOK_SECRET", label: "Webhook secret" },
  { name: "PUBLIC_BASE_URL", label: "Public address" },
  { name: "VAPID_PUBLIC_KEY", label: "Push notification keys" },
  { name: "BRAIN_REMOTE_URL", label: "Brain git remote" },
  { name: "CREDENTIALS_KEY", label: "Credentials encryption key (optional)" },
] as const;
