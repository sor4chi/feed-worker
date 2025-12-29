/// <reference types="@cloudflare/workers-types" />
import { XMLParser } from "fast-xml-parser";
import * as nacl from "tweetnacl";
import { ulidFactory } from "ulid-workers";
const ulid = ulidFactory();

interface Env {
  FEED_KV: KVNamespace;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_BOT_TOKEN: string;
}

interface Subscription {
  id: string;
  guildId: string;
  channelId: string;
  url: string;
  createdAt: number;
  lastItemId?: string;
  lastItemDate?: number;
  feedTitle?: string;
  errorCount?: number;
  lastError?: string;
}

interface FeedItem {
  id: string;
  title: string;
  link?: string;
  date?: number;
  summary?: string;
}

interface ParsedFeed {
  items: FeedItem[];
  format: "rss" | "atom" | "rdf" | "unknown";
  title?: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const FEED_FETCH_TIMEOUT_MS = 2500;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  allowBooleanAttributes: true,
  parseTagValue: true,
  parseAttributeValue: true,
  trimValues: true,
});

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/interactions") {
      return new Response("Not Found", { status: 404 });
    }

    const signature = request.headers.get("X-Signature-Ed25519");
    const timestamp = request.headers.get("X-Signature-Timestamp");
    if (!signature || !timestamp) {
      return new Response("Bad Request", { status: 400 });
    }

    const bodyBuffer = await request.arrayBuffer();
    const bodyText = decoder.decode(bodyBuffer);

    if (
      !verifyDiscordRequest(
        signature,
        timestamp,
        bodyText,
        env.DISCORD_PUBLIC_KEY
      )
    ) {
      return new Response("Bad signature", { status: 401 });
    }

    let interaction: any;
    try {
      interaction = JSON.parse(bodyText);
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    if (interaction.type === 1) {
      return jsonResponse({ type: 1 });
    }

    if (interaction.type !== 2 || interaction.data?.name !== "feed") {
      return jsonResponse({
        type: 4,
        data: {
          content: "Unknown command.",
          flags: 64,
        },
      });
    }

    const guildId = interaction.guild_id as string | undefined;
    const channelId = interaction.channel_id as string | undefined;

    if (!guildId || !channelId) {
      return jsonResponse({
        type: 4,
        data: {
          content: "This command can only be used in a server channel.",
          flags: 64,
        },
      });
    }

    const subcommand = (interaction.data?.options ?? [])[0];
    const name = subcommand?.name as string | undefined;
    const options = subcommand?.options ?? [];

    switch (name) {
      case "subscribe":
        return await handleSubscribe(env, guildId, channelId, options);
      case "list":
        return await handleList(env, guildId);
      case "unsubscribe":
        return await handleUnsubscribe(env, guildId, options);
      default:
        return jsonResponse({
          type: 4,
          data: {
            content: "Unknown subcommand.",
            flags: 64,
          },
        });
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runFeedChecks(env));
  },
};

function jsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function verifyDiscordRequest(
  signature: string,
  timestamp: string,
  body: string,
  publicKey: string
): boolean {
  try {
    const message = encoder.encode(timestamp + body);
    const signatureBytes = hexToBytes(signature);
    const publicKeyBytes = hexToBytes(publicKey);
    return nacl.sign.detached.verify(message, signatureBytes, publicKeyBytes);
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string");
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

async function handleSubscribe(
  env: Env,
  guildId: string,
  channelId: string,
  options: any[]
): Promise<Response> {
  const urlValue = options.find((opt) => opt.name === "url")?.value as
    | string
    | undefined;
  if (!urlValue) {
    return jsonResponse({
      type: 4,
      data: {
        content:
          "URL を指定してください。例: /feed subscribe https://example.com/rss",
        flags: 64,
      },
    });
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlValue);
  } catch {
    return jsonResponse({
      type: 4,
      data: {
        content: "URL の形式が正しくありません。",
        flags: 64,
      },
    });
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return jsonResponse({
      type: 4,
      data: {
        content: "http/https の URL のみ対応しています。",
        flags: 64,
      },
    });
  }

  const existing = await getSubscriptionsForGuild(env, guildId);
  const duplicate = existing.find(
    (sub) => sub.channelId === channelId && sub.url === parsedUrl.toString()
  );
  if (duplicate) {
    return jsonResponse({
      type: 4,
      data: {
        embeds: [
          {
            title: "すでに購読済み",
            color: 0xf59e0b,
            fields: [
              { name: "チャンネル", value: `<#${channelId}>`, inline: true },
              { name: "ID", value: duplicate.id, inline: true },
              { name: "URL", value: duplicate.url },
            ],
          },
        ],
        flags: 64,
      },
    });
  }

  const probe = await probeFeed(parsedUrl.toString());
  if (!probe.ok) {
    return jsonResponse({
      type: 4,
      data: {
        embeds: [
          {
            title: "購読できませんでした",
            color: 0xef4444,
            description: probe.message,
            fields: [{ name: "URL", value: parsedUrl.toString() }],
          },
        ],
        flags: 64,
      },
    });
  }

  const normalizedTitle = normalizeFeedTitle(probe.title);
  const subscription: Subscription = {
    id: ulid(),
    guildId,
    channelId,
    url: parsedUrl.toString(),
    createdAt: Date.now(),
    feedTitle: normalizedTitle,
    errorCount: 0,
  };

  await env.FEED_KV.put(
    subscriptionKey(guildId, subscription.id),
    JSON.stringify(subscription)
  );
  await addToIndex(env, guildId, subscription.id);

  return jsonResponse({
    type: 4,
    data: {
      embeds: [
        {
          title: "購読を追加しました",
          color: 0x22c55e,
          fields: [
            { name: "チャンネル", value: `<#${channelId}>`, inline: true },
            { name: "ID", value: subscription.id, inline: true },
            { name: "URL", value: subscription.url },
          ],
          footer: normalizedTitle
            ? { text: `Feed: ${normalizedTitle}` }
            : undefined,
        },
      ],
      flags: 64,
    },
  });
}

async function handleList(env: Env, guildId: string): Promise<Response> {
  const subscriptions = await getSubscriptionsForGuild(env, guildId);

  if (subscriptions.length === 0) {
    return jsonResponse({
      type: 4,
      data: {
        content: "このサーバーには購読がありません。",
        flags: 64,
      },
    });
  }

  const embeds = buildListEmbeds(subscriptions);

  return jsonResponse({
    type: 4,
    data: {
      embeds,
      flags: 64,
    },
  });
}

async function handleUnsubscribe(
  env: Env,
  guildId: string,
  options: any[]
): Promise<Response> {
  const idValue = options.find((opt) => opt.name === "subscribed_id")?.value as
    | string
    | undefined;
  if (!idValue) {
    return jsonResponse({
      type: 4,
      data: {
        content: "subscribed_id を指定してください。例: /feed unsubscribe 123",
        flags: 64,
      },
    });
  }

  const key = subscriptionKey(guildId, idValue);
  const existing = await env.FEED_KV.get<Subscription>(key, "json");

  if (!existing) {
    return jsonResponse({
      type: 4,
      data: {
        content: "指定した ID が見つかりません。",
        flags: 64,
      },
    });
  }

  await env.FEED_KV.delete(key);
  await removeFromIndex(env, guildId, idValue);

  return jsonResponse({
    type: 4,
    data: {
      embeds: [
        {
          title: "購読を解除しました",
          color: 0xef4444,
          fields: [
            {
              name: "チャンネル",
              value: `<#${existing.channelId}>`,
              inline: true,
            },
            { name: "ID", value: existing.id, inline: true },
            { name: "URL", value: existing.url },
          ],
        },
      ],
      flags: 64,
    },
  });
}

async function runFeedChecks(env: Env): Promise<void> {
  const keys = await listAllKeys(env.FEED_KV, "sub:g:");
  if (keys.length === 0) return;

  const subscriptions = await Promise.all(
    keys.map(async (key) => env.FEED_KV.get<Subscription>(key, "json"))
  );

  const active = subscriptions.filter((sub): sub is Subscription =>
    Boolean(sub)
  );

  for (const subscription of active) {
    try {
      await processSubscription(env, subscription);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      subscription.errorCount = (subscription.errorCount ?? 0) + 1;
      subscription.lastError = message;
      await env.FEED_KV.put(
        subscriptionKey(subscription.guildId, subscription.id),
        JSON.stringify(subscription)
      );
    }
  }
}

async function processSubscription(
  env: Env,
  subscription: Subscription
): Promise<void> {
  const response = await fetch(subscription.url, {
    headers: {
      "User-Agent": "feed-worker/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Feed fetch failed (${response.status})`);
  }

  const xmlText = await response.text();
  const feed = parseFeed(xmlText);
  if (feed.format === "unknown") {
    throw new Error("Unsupported feed format");
  }
  const normalizedTitle = normalizeFeedTitle(feed.title);
  const titleChanged =
    normalizedTitle && normalizedTitle !== subscription.feedTitle;
  if (titleChanged) {
    subscription.feedTitle = normalizedTitle;
  }

  if (!feed.items.length) {
    if (titleChanged) {
      await env.FEED_KV.put(
        subscriptionKey(subscription.guildId, subscription.id),
        JSON.stringify(subscription)
      );
    }
    return;
  }

  const { newItems, latestItem } = diffItems(
    feed.items,
    subscription.lastItemId,
    subscription.lastItemDate
  );

  if (newItems.length === 0) {
    if (latestItem && latestItem.id !== subscription.lastItemId) {
      subscription.lastItemId = latestItem.id;
      subscription.lastItemDate = latestItem.date;
    }
    if (latestItem || titleChanged) {
      await env.FEED_KV.put(
        subscriptionKey(subscription.guildId, subscription.id),
        JSON.stringify(subscription)
      );
    }
    return;
  }

  for (const item of newItems) {
    const content = formatDiscordMessage(item);
    await sendDiscordMessage(env, subscription.channelId, content);
  }

  const lastPosted = newItems[newItems.length - 1];
  subscription.lastItemId = lastPosted.id;
  subscription.lastItemDate = lastPosted.date;
  subscription.errorCount = 0;
  subscription.lastError = undefined;
  await env.FEED_KV.put(
    subscriptionKey(subscription.guildId, subscription.id),
    JSON.stringify(subscription)
  );
}

function formatDiscordMessage(item: FeedItem): string {
  const title = item.title ? item.title.trim() : "(no title)";
  const link = item.link ? item.link.trim() : "";
  const base = link ? `${title}\n${link}` : title;
  return base.length > 1900 ? base.slice(0, 1897) + "..." : base;
}

async function sendDiscordMessage(
  env: Env,
  channelId: string,
  content: string
): Promise<void> {
  const response = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord post failed (${response.status}): ${text}`);
  }
}

function normalizeFeedTitle(value?: string): string | undefined {
  if (!value) return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
}

function parseFeed(xml: string): ParsedFeed {
  const parsed = xmlParser.parse(xml);

  if (parsed?.rss?.channel) {
    const channel = parsed.rss.channel;
    const items = ensureArray(channel.item)
      .map(normalizeRssItem)
      .filter(Boolean) as FeedItem[];
    return { items, format: "rss", title: pickText(channel.title) };
  }

  if (parsed?.feed) {
    const entries = ensureArray(parsed.feed.entry);
    const items = entries.map(normalizeAtomEntry).filter(Boolean) as FeedItem[];
    return { items, format: "atom", title: pickText(parsed.feed.title) };
  }

  if (parsed?.["rdf:RDF"]) {
    const items = ensureArray(parsed["rdf:RDF"].item)
      .map(normalizeRssItem)
      .filter(Boolean) as FeedItem[];
    return { items, format: "rdf", title: pickText(parsed["rdf:RDF"].title) };
  }

  return { items: [], format: "unknown" };
}

async function probeFeed(
  url: string
): Promise<
  | { ok: true; format: ParsedFeed["format"]; title?: string }
  | { ok: false; message: string }
> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FEED_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "feed-worker/1.0",
        Accept:
          "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        ok: false,
        message: `フィードの取得に失敗しました（HTTP ${response.status}）。`,
      };
    }

    const text = await response.text();
    let feed: ParsedFeed;
    try {
      feed = parseFeed(text);
    } catch {
      return { ok: false, message: "XML の解析に失敗しました。" };
    }

    if (feed.format === "unknown") {
      return {
        ok: false,
        message: "RSS/Atom 形式のフィードを検出できませんでした。",
      };
    }

    return { ok: true, format: feed.format, title: feed.title };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, message: "フィード取得がタイムアウトしました。" };
    }
    return { ok: false, message: "フィード取得中にエラーが発生しました。" };
  } finally {
    clearTimeout(timeoutId);
  }
}

function normalizeRssItem(item: any): FeedItem | null {
  if (!item) return null;
  const title = pickText(item.title) ?? "(no title)";
  const link = pickLink(item.link);
  const id = pickText(item.guid) ?? link ?? title;
  const date = parseDate(
    item.pubDate ?? item.date ?? item.published ?? item.updated
  );

  return {
    id,
    title,
    link,
    date,
    summary: pickText(item.description),
  };
}

function normalizeAtomEntry(entry: any): FeedItem | null {
  if (!entry) return null;
  const title = pickText(entry.title) ?? "(no title)";
  const link = pickLink(entry.link);
  const id = pickText(entry.id) ?? link ?? title;
  const date = parseDate(entry.updated ?? entry.published);

  return {
    id,
    title,
    link,
    date,
    summary: pickText(entry.summary ?? entry.content),
  };
}

function pickText(value: any): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (typeof value === "object") {
    if ("#text" in value) return String(value["#text"]);
    if ("text" in value) return String(value.text);
  }
  return undefined;
}

function pickLink(value: any): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    const preferred =
      value.find((link) => link?.rel === "alternate") ?? value[0];
    return pickLink(preferred);
  }

  if (typeof value === "object") {
    return value.href ?? value.url ?? value["@_href"] ?? value["#text"];
  }

  return undefined;
}

function parseDate(value: any): number | undefined {
  const text = pickText(value);
  if (!text) return undefined;
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function ensureArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function diffItems(
  items: FeedItem[],
  lastId?: string,
  lastDate?: number
): { newItems: FeedItem[]; latestItem?: FeedItem } {
  if (items.length === 0) return { newItems: [] };

  const withDate = items.some((item) => typeof item.date === "number");
  const sorted = withDate
    ? [...items].sort((a, b) => (a.date ?? 0) - (b.date ?? 0))
    : [...items];

  const latestItem = sorted[sorted.length - 1];

  if (!lastId && !lastDate) {
    return { newItems: [], latestItem };
  }

  let newItems: FeedItem[] = [];

  if (lastId) {
    const index = sorted.findIndex((item) => item.id === lastId);
    if (index >= 0) {
      newItems = sorted.slice(index + 1);
    }
  }

  if (newItems.length === 0 && lastDate) {
    newItems = sorted.filter((item) => item.date && item.date > lastDate);
  }

  if (newItems.length === 0 && latestItem && latestItem.id !== lastId) {
    newItems = [latestItem];
  }

  return { newItems, latestItem };
}

function subscriptionKey(guildId: string, subId: string): string {
  return `sub:g:${guildId}:${subId}`;
}

function buildListEmbeds(
  subscriptions: Subscription[]
): Array<Record<string, unknown>> {
  const grouped = new Map<string, Subscription[]>();
  for (const sub of subscriptions) {
    const list = grouped.get(sub.channelId) ?? [];
    list.push(sub);
    grouped.set(sub.channelId, list);
  }

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [];
  for (const [channelId, subs] of grouped.entries()) {
    const sorted = [...subs].sort((a, b) => a.createdAt - b.createdAt);
    const lines = sorted.map((sub) => {
      const title = normalizeFeedTitle(sub.feedTitle) ?? "(no title)";
      return `${title}\n${sub.url}\nID: \`${sub.id}\``;
    });
    fields.push({
      name: `<#${channelId}> (${subs.length})`,
      value: truncateField(lines.join("\n")),
    });
  }

  const embeds: Array<Record<string, unknown>> = [];
  const total = subscriptions.length;
  const maxFieldsPerEmbed = 25;
  for (let i = 0; i < fields.length; i += maxFieldsPerEmbed) {
    embeds.push({
      title: i === 0 ? `購読一覧 (${total})` : "購読一覧 (続き)",
      color: 0x3b82f6,
      fields: fields.slice(i, i + maxFieldsPerEmbed),
    });
  }

  return embeds;
}

function truncateField(value: string): string {
  if (value.length <= 1024) return value;
  return value.slice(0, 1021) + "...";
}

function guildIndexKey(guildId: string): string {
  return `subindex:g:${guildId}`;
}

async function getSubscriptionsForGuild(
  env: Env,
  guildId: string
): Promise<Subscription[]> {
  const indexKey = guildIndexKey(guildId);
  const index = await env.FEED_KV.get<string[]>(indexKey, "json");

  if (index && index.length > 0) {
    const subscriptions = await Promise.all(
      index.map((id) =>
        env.FEED_KV.get<Subscription>(subscriptionKey(guildId, id), "json")
      )
    );
    const valid = subscriptions.filter((sub): sub is Subscription =>
      Boolean(sub)
    );
    if (valid.length !== index.length) {
      await env.FEED_KV.put(
        indexKey,
        JSON.stringify(valid.map((sub) => sub.id))
      );
    }
    return valid;
  }

  const fallback = await listSubscriptionsByGuild(env, guildId);
  if (fallback.length > 0) {
    await env.FEED_KV.put(
      indexKey,
      JSON.stringify(fallback.map((sub) => sub.id))
    );
  }
  return fallback;
}

async function addToIndex(
  env: Env,
  guildId: string,
  subId: string
): Promise<void> {
  const indexKey = guildIndexKey(guildId);
  const index = (await env.FEED_KV.get<string[]>(indexKey, "json")) ?? [];
  if (!index.includes(subId)) {
    index.push(subId);
    await env.FEED_KV.put(indexKey, JSON.stringify(index));
  }
}

async function removeFromIndex(
  env: Env,
  guildId: string,
  subId: string
): Promise<void> {
  const indexKey = guildIndexKey(guildId);
  const index = (await env.FEED_KV.get<string[]>(indexKey, "json")) ?? [];
  const next = index.filter((id) => id !== subId);
  if (next.length !== index.length) {
    await env.FEED_KV.put(indexKey, JSON.stringify(next));
  }
}

async function listSubscriptionsByGuild(
  env: Env,
  guildId: string
): Promise<Subscription[]> {
  const keys = await listAllKeys(env.FEED_KV, `sub:g:${guildId}:`);
  const subscriptions = await Promise.all(
    keys.map((key) => env.FEED_KV.get<Subscription>(key, "json"))
  );
  return subscriptions.filter((sub): sub is Subscription => Boolean(sub));
}

async function listAllKeys(kv: KVNamespace, prefix: string): Promise<string[]> {
  let cursor: string | undefined = undefined;
  const keys: string[] = [];

  do {
    const response = await kv.list({ prefix, cursor });
    keys.push(...response.keys.map((key) => key.name));
    cursor = response.list_complete ? undefined : response.cursor;
  } while (cursor);

  return keys;
}
