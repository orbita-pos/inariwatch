import { config } from "dotenv";
config({ path: ".env.local" });

/**
 * Cloudflare DNS helper for the Hetzner migration.
 *
 *   npx tsx scripts/cf-dns.ts list                               # list all records for inariwatch.com
 *   npx tsx scripts/cf-dns.ts list <name>                        # filter by name
 *   npx tsx scripts/cf-dns.ts set <name> <ip>                    # UPSERT A record (creates or updates)
 *   npx tsx scripts/cf-dns.ts plan <target_ip> <names...>        # dry-run UPSERT plan (print only)
 *   npx tsx scripts/cf-dns.ts cutover <target_ip> <names...>     # execute UPSERT for each name
 *
 * Requires in .env.local:
 *   CLOUDFLARE_API_TOKEN    — scoped token (Zone:DNS:Edit on inariwatch.com)
 *   CLOUDFLARE_ZONE_ID      — optional; looked up from CLOUDFLARE_ZONE_NAME if missing
 *   CLOUDFLARE_ZONE_NAME    — defaults to inariwatch.com
 *
 * Prints nothing sensitive — token never echoed, only record names + IDs + IPs.
 */

const ZONE_NAME = process.env.CLOUDFLARE_ZONE_NAME ?? "inariwatch.com";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
if (!TOKEN) {
  console.error("CLOUDFLARE_API_TOKEN missing from .env.local");
  process.exit(1);
}

const API = "https://api.cloudflare.com/client/v4";
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<{ success: boolean; result: T; errors?: Array<{ message: string }>; messages?: unknown[] }> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
  const body = (await res.json()) as {
    success: boolean;
    result: T;
    errors?: Array<{ message: string }>;
    messages?: unknown[];
  };
  if (!body.success) {
    const msg = body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
    throw new Error(`cf api ${path} failed: ${msg}`);
  }
  return body;
}

async function getZoneId(): Promise<string> {
  if (process.env.CLOUDFLARE_ZONE_ID) return process.env.CLOUDFLARE_ZONE_ID;
  const body = await api<Array<{ id: string; name: string }>>(`/zones?name=${ZONE_NAME}`);
  const zone = body.result.find((z) => z.name === ZONE_NAME);
  if (!zone) throw new Error(`zone ${ZONE_NAME} not found in this account`);
  return zone.id;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

async function listRecords(filter?: string): Promise<DnsRecord[]> {
  const zoneId = await getZoneId();
  const q = filter ? `&name=${filter}` : "";
  const body = await api<DnsRecord[]>(`/zones/${zoneId}/dns_records?per_page=500${q}`);
  return body.result;
}

async function upsertA(name: string, ip: string, proxied: boolean): Promise<DnsRecord> {
  const zoneId = await getZoneId();
  const existing = await listRecords(name);
  const aRecord = existing.find((r) => r.type === "A" && r.name === name);
  const cnameRecord = existing.find((r) => r.type === "CNAME" && r.name === name);

  // If a CNAME exists for this name, delete it first — a host can't have both A and CNAME.
  if (cnameRecord) {
    await api(`/zones/${zoneId}/dns_records/${cnameRecord.id}`, { method: "DELETE" });
    console.log(`  removed CNAME ${cnameRecord.name} -> ${cnameRecord.content}`);
  }

  const payload = JSON.stringify({
    type: "A",
    name,
    content: ip,
    ttl: 1, // 1 = "Auto" in Cloudflare (fast propagation)
    proxied,
    comment: "Hetzner migration 2026-04-19",
  });

  if (aRecord) {
    const body = await api<DnsRecord>(`/zones/${zoneId}/dns_records/${aRecord.id}`, {
      method: "PUT",
      body: payload,
    });
    return body.result;
  }
  const body = await api<DnsRecord>(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: payload,
  });
  return body.result;
}

async function deleteRecord(id: string): Promise<void> {
  const zoneId = await getZoneId();
  await api(`/zones/${zoneId}/dns_records/${id}`, { method: "DELETE" });
}

async function deleteByNameAndContent(
  name: string,
  type: string,
  contentSubstring?: string,
): Promise<Array<{ id: string; name: string; type: string; content: string }>> {
  const records = await listRecords(name);
  const matches = records.filter(
    (r) =>
      r.type === type &&
      r.name === name &&
      (!contentSubstring || r.content.includes(contentSubstring)),
  );
  const zoneId = await getZoneId();
  for (const r of matches) {
    await api(`/zones/${zoneId}/dns_records/${r.id}`, { method: "DELETE" });
  }
  return matches;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  if (cmd === "delete" && args.length === 1) {
    await deleteRecord(args[0]);
    console.log(`  deleted ${args[0]}`);
    return;
  }

  if (cmd === "delete-match" && args.length >= 2) {
    const [name, type, contentSubstring] = args;
    const deleted = await deleteByNameAndContent(name, type, contentSubstring);
    if (deleted.length === 0) {
      console.log(`  no records matched name=${name} type=${type}${contentSubstring ? ` content~=${contentSubstring}` : ""}`);
    } else {
      for (const r of deleted) {
        console.log(`  deleted ${r.type.padEnd(6)} ${r.name}  ->  ${r.content.slice(0, 80)}${r.content.length > 80 ? "..." : ""}  [${r.id}]`);
      }
    }
    return;
  }

  if (!cmd || cmd === "list") {
    const filter = args[0];
    const zoneId = await getZoneId();
    console.log(`zone: ${ZONE_NAME}  (id=${zoneId})`);
    const records = await listRecords(filter);
    for (const r of records.sort((a, b) => a.name.localeCompare(b.name))) {
      const proxy = r.proxied ? "proxied" : "dns-only";
      console.log(`  ${r.type.padEnd(6)} ${r.name.padEnd(40)} -> ${r.content.padEnd(25)} (${proxy}, ttl=${r.ttl})  [${r.id}]`);
    }
    return;
  }

  if (cmd === "set" && args.length === 2) {
    const [name, ip] = args;
    const proxied = process.env.CLOUDFLARE_PROXIED !== "false"; // default: proxied on
    const r = await upsertA(name, ip, proxied);
    console.log(`  OK ${r.name}  ${r.type} ${r.content}  proxied=${r.proxied}  id=${r.id}`);
    return;
  }

  if (cmd === "plan" && args.length >= 2) {
    const [targetIp, ...names] = args;
    console.log(`DRY RUN — would UPSERT A record ${targetIp} for:`);
    for (const n of names) {
      const existing = await listRecords(n);
      const a = existing.find((r) => r.type === "A" && r.name === n);
      const c = existing.find((r) => r.type === "CNAME" && r.name === n);
      if (a) console.log(`  UPDATE  ${n.padEnd(38)} A=${a.content} -> ${targetIp}  (proxied=${a.proxied})`);
      else if (c) console.log(`  REPLACE ${n.padEnd(38)} CNAME=${c.content} -> A=${targetIp}  (proxied=${c.proxied})`);
      else console.log(`  CREATE  ${n.padEnd(38)} (no existing) -> A=${targetIp}`);
    }
    return;
  }

  if (cmd === "cutover" && args.length >= 2) {
    const [targetIp, ...names] = args;
    const proxied = process.env.CLOUDFLARE_PROXIED !== "false";
    console.log(`Executing cutover → ${targetIp} (proxied=${proxied}) for ${names.length} hosts`);
    for (const n of names) {
      const r = await upsertA(n, targetIp, proxied);
      console.log(`  ${r.name.padEnd(40)} -> ${r.content}  proxied=${r.proxied}  id=${r.id}`);
    }
    console.log("Done.");
    return;
  }

  console.error(
    `Usage:
  npx tsx scripts/cf-dns.ts list [name]
  npx tsx scripts/cf-dns.ts set <name> <ip>
  npx tsx scripts/cf-dns.ts plan <target_ip> <name1> [name2] [...]
  npx tsx scripts/cf-dns.ts cutover <target_ip> <name1> [name2] [...]`,
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
