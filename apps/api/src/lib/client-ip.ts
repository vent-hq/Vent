import { isIP, isIPv4 } from "node:net";
import type { FastifyRequest } from "fastify";

function normalizeIp(address: string): string {
  const mapped = address.toLowerCase().startsWith("::ffff:") ? address.slice(7) : address;
  return isIPv4(mapped) ? mapped : address;
}

export function getClientIp(request: FastifyRequest): string {
  const peer = normalizeIp(request.raw.socket.remoteAddress ?? request.ip);
  const claimed = request.headers["fly-client-ip"];

  // Fly Proxy uses IPv4; direct private-network connections use IPv6.
  if (
    process.env["FLY_APP_NAME"] &&
    isIPv4(peer) && !peer.startsWith("127.") &&
    typeof claimed === "string" && isIP(claimed)
  ) {
    return normalizeIp(claimed);
  }
  return peer;
}
