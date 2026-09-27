import { Ajv } from "ajv";
import type { StoredDataContracts } from "./stored-data-contracts";
import schema from "./generated/stored-data.schema.json";

const validator = new Ajv({ strict: false, validateFormats: false });
validator.addSchema(schema, "socketagent-stored-data");

/** Validate external records using schemas generated from their writer types. */
export function parseStoredData<K extends keyof StoredDataContracts>(kind: K, value: unknown): StoredDataContracts[K] {
  const validate = validator.getSchema<StoredDataContracts[K]>(
    `socketagent-stored-data#/definitions/StoredDataContracts/properties/${kind}`,
  );
  if (!validate || "$async" in validate) throw new Error(`Missing stored data contract: ${kind}`);
  if (!validate(value)) {
    const detail = validate.errors?.map(error => `${error.instancePath || "/"}: ${error.keyword}`).join(", ");
    throw new Error(`Invalid ${kind} record (${detail || "schema mismatch"})`);
  }
  return value;
}
