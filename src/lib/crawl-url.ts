import { createHash } from "crypto";

export function normalizeInputToUrl(input: string): URL {
  const trimmed = input.trim();
  const asUrl = trimmed.match(/^https?:\/\//i) ? trimmed : `https://${trimmed}`;
  return new URL(asUrl);
}

export function sha1Hex(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

