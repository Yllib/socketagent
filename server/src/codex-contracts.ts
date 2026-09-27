import { Ajv } from "ajv";
import { codexResponseSchemas, type CodexMethods } from "./generated/codex/methods";
import schema from "./generated/codex/protocol.schemas.json";

// Types and schemas come from the same CLI export. No assertion converts the
// wire value into a response: the generated schema must validate it first.
const validator = new Ajv({ strict: false, validateFormats: false });
validator.addSchema(schema, "socketagent-codex");

export function parseCodexResponse<M extends keyof CodexMethods>(method: M, value: unknown): CodexMethods[M]["response"] {
  const validate = validator.getSchema<CodexMethods[M]["response"]>(`socketagent-codex#/definitions/${codexResponseSchemas[method]}`);
  if (!validate) throw new Error(`Missing Codex contract for ${method}`);
  if ("$async" in validate) throw new Error(`Codex contract for ${method} must validate synchronously`);
  if (!validate(value)) {
    // Paths and keywords diagnose protocol drift without including user data.
    const detail = validate.errors?.map(error => `${error.instancePath || "/"}: ${error.keyword}`).join(", ");
    throw new Error(`Codex returned an invalid ${method} response (${detail || "schema mismatch"})`);
  }
  return value;
}
