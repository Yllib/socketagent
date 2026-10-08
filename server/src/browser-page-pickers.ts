import { z } from "zod";
import type { BrowserPrompt } from "./protocol";

/**
 * Dropdowns and date, time, and color inputs open popups Chrome draws outside
 * the page, which the live view never shows. This script, run in an isolated
 * world so pages cannot see or tamper with it, claims the press that would
 * open one and reports the control instead, so the phone can answer natively.
 */
export const PICKER_WORLD = "socketagent-pickers";
export const PICKER_BINDING = "__socketAgentPicker";

const PICKER_INPUT_TYPES = ["date", "time", "datetime-local", "month", "week", "color"] as const;

export const PICKER_SCRIPT = `(() => {
  if (window.__socketAgentPickers) return;
  const pickers = new Map();
  window.__socketAgentPickers = pickers;
  let next = 0;
  const inputTypes = new Set(${JSON.stringify(PICKER_INPUT_TYPES)});
  const control = (event) => {
    const el = event.composedPath()[0];
    if (el instanceof HTMLSelectElement) return !el.multiple && el.size <= 1 && !el.disabled ? el : null;
    if (el instanceof HTMLInputElement) return inputTypes.has(el.type) && !el.disabled && !el.readOnly ? el : null;
    return null;
  };
  const describe = (el) => {
    if (el instanceof HTMLSelectElement) {
      return {
        kind: "select",
        options: Array.from(el.options, (option) => {
          const group = option.parentElement instanceof HTMLOptGroupElement ? option.parentElement : null;
          return {
            label: option.label || option.text,
            value: option.value,
            selected: option.selected,
            disabled: option.disabled || Boolean(group && group.disabled),
            ...(group ? { group: group.label } : {}),
          };
        }),
      };
    }
    return {
      kind: "picker",
      inputType: el.type,
      value: el.value,
      ...(el.min ? { min: el.min } : {}),
      ...(el.max ? { max: el.max } : {}),
    };
  };
  // Chrome opens these popups on the press, so claim it before the page's own handlers run.
  window.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    const el = control(event);
    if (!el) return;
    event.preventDefault();
    el.focus();
    const id = String(++next);
    pickers.clear();
    pickers.set(id, el);
    window.${PICKER_BINDING}(JSON.stringify({ id, prompt: describe(el) }));
  }, true);
  // Color and date inputs also open on the click that follows.
  window.addEventListener("click", (event) => {
    if (control(event)) event.preventDefault();
  }, true);
})()`;

const pickerReportSchema = z.object({
  id: z.string(),
  prompt: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("select"),
      options: z.array(z.object({
        label: z.string(),
        value: z.string(),
        selected: z.boolean(),
        disabled: z.boolean(),
        group: z.string().optional(),
      })),
    }),
    z.object({
      kind: z.literal("picker"),
      inputType: z.enum(PICKER_INPUT_TYPES),
      value: z.string(),
      min: z.string().optional(),
      max: z.string().optional(),
    }),
  ]),
});

/** Reads what the picker script reported. Returns undefined for anything malformed. */
export function parsePickerReport(payload: string): { id: string; prompt: BrowserPrompt } | undefined {
  try {
    const parsed = pickerReportSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sets the reported control to [value] the way a person choosing it would,
 * firing input and change so frameworks see it. Setting the value from the
 * isolated world uses the native setter, which React's value tracking needs.
 * Evaluates to whether the control was still there.
 */
export function applyPickerExpression(id: string, value: string): string {
  return `((id, value) => {
    const el = window.__socketAgentPickers && window.__socketAgentPickers.get(id);
    if (!el || !el.isConnected) return false;
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })(${JSON.stringify(id)}, ${JSON.stringify(value)})`;
}
