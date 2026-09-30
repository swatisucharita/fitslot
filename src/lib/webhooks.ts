/**
 * Inbound webhooks. Pattern: verify signature, store raw event, process.
 * A WhatsApp inbound-message webhook would follow the same pattern.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export function validSignature(body: string, signature: string, secret: string): boolean {
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
