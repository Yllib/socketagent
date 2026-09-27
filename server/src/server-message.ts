import { Ajv, type ErrorObject } from "ajv";
import type { ServerMessage } from "./protocol";
import schema from "./generated/server-protocol.schema.json";
import { isRecord, unknownArray } from "./value-guards";

const validator = new Ajv({ strict: false, validateFormats: false });
validator.addSchema(schema, "socketagent-server");
// Select a packet contract by its type rather than checking every variant.
const definitions: Record<string, unknown> = schema.definitions;
function discriminant(definition: unknown): string {
  if (!isRecord(definition)) throw new Error("Invalid server protocol definition");
  if (isRecord(definition.properties) && isRecord(definition.properties.type)
    && typeof definition.properties.type.const === "string") return definition.properties.type.const;
  const variants = unknownArray(definition.anyOf).map(discriminant);
  if (variants.length && variants.every(type => type === variants[0])) return variants[0];
  throw new Error("Server protocol variant requires one message type");
}
const contracts = new Map(schema.definitions.ServerMessage.anyOf.map((variant, index) => {
  const validate = validator.getSchema<ServerMessage>(`socketagent-server#/definitions/ServerMessage/anyOf/${index}`);
  if (!validate || "$async" in validate) throw new Error("Invalid server protocol schema");
  const definition = variant.$ref ? definitions[variant.$ref.split("/").at(-1)!] : variant;
  return [discriminant(definition), validate] as const;
}));

export function parseServerMessage(value: unknown): ServerMessage {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Server message requires a type");
  const validate = contracts.get(value.type);
  if (!validate) throw new Error("Unsupported server message type");
  if (!validate(value)) {
    const detail = validate.errors?.map((error: ErrorObject<string, Record<string, unknown>>) => `${error.instancePath || "/"}: ${error.keyword}`).join(", ");
    throw new Error(`Invalid server message (${detail || "schema mismatch"})`);
  }
  return value;
}
