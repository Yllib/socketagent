import { Ajv, type ErrorObject } from "ajv";
import type { JsonClientMessage } from "./protocol";
import schema from "./generated/client-protocol.schema.json";
import { isRecord } from "./value-guards";

const validator = new Ajv({ strict: false, validateFormats: false });
validator.addSchema(schema, "socketagent-client");
// Select the discriminant first: a malformed prompt should not evaluate every
// unrelated command schema or produce hundreds of irrelevant validation errors.
const contracts = new Map(schema.definitions.JsonClientMessage.anyOf.map((variant, index) => {
  const validate = validator.getSchema<JsonClientMessage>(`socketagent-client#/definitions/JsonClientMessage/anyOf/${index}`);
  if (!validate || "$async" in validate) throw new Error("Invalid client protocol schema");
  return [variant.properties.type.const, validate];
}));

export function parseClientMessage(value: unknown): JsonClientMessage {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Client message requires a type");
  const validate = contracts.get(value.type);
  if (!validate) throw new Error("Unsupported client message type");
  if (!validate(value)) {
    const detail = validate.errors?.map((error: ErrorObject<string, Record<string, unknown>>) => `${error.instancePath || "/"}: ${error.keyword}`).join(", ");
    throw new Error(`Invalid client message (${detail || "schema mismatch"})`);
  }
  return value;
}

/**
 * The error text a client gets back for a message the server could not use.
 * Only unparseable text is "Invalid JSON"; a schema rejection names the field,
 * so a client bug is not mistaken for corrupt data.
 */
export function rejectedMessageText(err: unknown): string {
  if (err instanceof SyntaxError) return "Invalid JSON";
  return err instanceof Error ? err.message : "Invalid message";
}
