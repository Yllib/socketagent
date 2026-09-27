/** Narrow external objects before inspecting their fields. Arrays are separate values. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
