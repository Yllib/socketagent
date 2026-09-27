/** Narrow external objects before inspecting their fields. Arrays are separate values. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function errorMessage(value: unknown): string {
  return isRecord(value) && typeof value.message === "string" ? value.message : String(value);
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error("Expected a JSON object");
  return value;
}
