/**
 * Hire email: one managed inbox per seat. Addresses are derived, never
 * typed — a seat's email is unforgeable by construction and unique
 * per org by index.
 */

export const HIRES_DOMAIN = "hires.museaiteam.com";

/** `priya-a1b2c3@hires.museaiteam.com` from role + seat id. */
export function seatEmail(role: string, seatId: string): string {
  const clean = role
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${clean}-${seatId.replace(/[^a-z0-9]/gi, "").slice(0, 6)}@${HIRES_DOMAIN}`;
}

/** Pull the first hire address out of a To/Cc list, if any. */
export function parseHireAddress(addrs: string[]): string | null {
  const suffix = `@${HIRES_DOMAIN}`;
  for (const raw of addrs) {
    const match = /<([^<>]+)>/.exec(raw);
    const addr = (match ? match[1] : raw).trim().toLowerCase();
    if (addr.endsWith(suffix)) return addr;
  }
  return null;
}
