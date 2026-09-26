/**
 * The name this machine answers to, put into /etc/hosts when the server
 * starts.
 *
 * On Umbrel the app runs in a container behind the host's reverse proxy, and
 * the host is reachable under a name the container has never heard of: on a
 * tailnet, `<host>.<tailnet>.ts.net`. Docker gives a container its own name
 * and localhost and nothing else, so the agent opening the app at its own
 * address -- to look at the panel it is running in, to check a page it just
 * changed -- got a DNS failure, and the fix had to be typed into /etc/hosts
 * by hand after every container recreation.
 *
 * The address is not hardcoded. Tailscale on the host is asked, over its
 * local socket, what this node is called and which address it answers on, and
 * that name is added to the container's own /etc/hosts. A container that
 * cannot see the socket -- no Tailscale, some other way in -- changes nothing
 * and says nothing: this is a convenience, never a reason not to start.
 */
import fs from "node:fs";
import http from "node:http";

/** Where tailscaled's socket has been seen, the host's mount first: on Umbrel
    the container has the host filesystem at /host, which is where the socket
    is actually found. */
const SOCKETS = [
  "/host/run/tailscale/tailscaled.sock",
  "/run/tailscale/tailscaled.sock",
  "/var/run/tailscale/tailscaled.sock",
];

interface LocalStatus {
  Self?: { DNSName?: string; HostName?: string; TailscaleIPs?: string[] };
  TailscaleIPs?: string[];
}

/** The names a machine is reached by, and the address behind them. */
export interface NamedSelf {
  names: string[];
  ip: string;
}

/** tailscaled's own API, over its socket. Null for anything but a clean answer. */
function localStatus(socket: string): Promise<LocalStatus | null> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: socket,
        path: "/localapi/v0/status",
        method: "GET",
        // tailscaled refuses a request that is not addressed the way its own
        // client addresses it: without this it answers 403 "invalid localapi
        // request" and the name is never found.
        headers: { Host: "local-tailscaled.sock" },
        timeout: 3000,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(res.statusCode === 200 ? (JSON.parse(body) as LocalStatus) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

/** The names this host answers to on its tailnet, and the address for them. */
export async function tailnetNames(): Promise<NamedSelf | null> {
  for (const socket of SOCKETS) {
    if (!fs.existsSync(socket)) continue;
    const status = await localStatus(socket);
    const self = status?.Self;
    const fqdn = String(self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
    const ip = [...(self?.TailscaleIPs ?? []), ...(status?.TailscaleIPs ?? [])].find((a) => !a.includes(":"));
    if (!fqdn || !ip) continue;
    const short = fqdn.split(".")[0];
    return { names: short && short !== fqdn ? [fqdn, short] : [fqdn], ip };
  }
  return null;
}

/**
 * A hosts file with this machine's name pointing at its address, or null when
 * there is nothing to do. Pure, so what it does to the file can be read and
 * tested without touching the real one.
 */
export function withHostNames(text: string, self: NamedSelf): string | null {
  const rows = text.split("\n");
  const fields = (row: string) => row.split(/\s+/).filter(Boolean);

  // Already there, pointing at this address: leave the file alone. It is the
  // container's own /etc/hosts and something else may have lines in it.
  const already = rows.some((row) => {
    const [addr, ...names] = fields(row);
    return addr === self.ip && self.names.every((n) => names.includes(n));
  });
  if (already) return null;

  // A line for one of these names pointing somewhere else -- the address
  // changed, or Docker wrote it last time -- is dropped rather than left to
  // win by coming first.
  const wanted = new Set(self.names);
  const kept = rows.filter((row) => {
    const names = fields(row).slice(1);
    return names.length === 0 || !names.some((n) => wanted.has(n));
  });
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  return `${kept.join("\n")}\n${self.ip}\t${self.names.join(" ")}\n`;
}

/**
 * Make sure the container can reach the host under its own name, at start.
 * Returns the names added, which is empty when there was nothing to do.
 */
export async function ensureHostNames(
  log: (line: string) => void = () => undefined,
  hostsPath = "/etc/hosts",
): Promise<string[]> {
  const self = await tailnetNames();
  if (!self) return [];

  let text: string;
  try {
    text = fs.readFileSync(hostsPath, "utf8");
  } catch {
    return [];
  }

  const next = withHostNames(text, self);
  if (next === null) return [];

  try {
    fs.writeFileSync(hostsPath, next);
  } catch (err: unknown) {
    log(`Could not write ${hostsPath}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  log(`${self.names.join(", ")} -> ${self.ip} added to ${hostsPath}.`);
  return self.names;
}
