import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

export type SchemaKind =
  | "task-spec"
  | "agent-result"
  | "final-gate"
  | "worker-proposal-request"
  | "change-set";

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult<T> =
  | {
      valid: true;
      value: T;
    }
  | {
      valid: false;
      issues: ValidationIssue[];
    };

type SchemaContract = {
  file: string;
  title: string;
  requiredFields: string[];
  schemaVersion: string;
};

const schemaContracts: Record<SchemaKind, SchemaContract> = {
  "task-spec": {
    file: "task-spec.schema.json",
    title: "AgentPlatform TaskSpec",
    schemaVersion: "2.0",
    requiredFields: [
      "schema_version",
      "task_id",
      "title",
      "goal",
      "base_sha",
      "context_paths",
      "scope",
      "acceptance_criteria",
      "test_commands",
      "execution_policy",
      "limits"
    ]
  },
  "agent-result": {
    file: "agent-result.schema.json",
    title: "AgentPlatform WorkerResult",
    schemaVersion: "1.0",
    requiredFields: [
      "schema_version",
      "task_id",
      "status",
      "summary",
      "changed_files",
      "acceptance_notes",
      "risks",
      "blocker"
    ]
  },
  "final-gate": {
    file: "final-gate.schema.json",
    title: "AgentPlatform FinalGateResult",
    schemaVersion: "1.0",
    requiredFields: [
      "schema_version",
      "task_id",
      "verdict",
      "summary",
      "criteria",
      "findings",
      "test_assessment",
      "scope_assessment",
      "rework_instructions"
    ]
  },
  "worker-proposal-request": {
    file: "worker-proposal-request.schema.json",
    title: "AgentPlatform WorkerProposalRequest",
    schemaVersion: "1.0",
    requiredFields: [
      "schema_version",
      "task_id",
      "base_sha",
      "task_spec_sha256",
      "goal",
      "scope",
      "acceptance_criteria",
      "context_files",
      "limits"
    ]
  },
  "change-set": {
    file: "change-set.schema.json",
    title: "AgentPlatform ChangeSet",
    schemaVersion: "1.0",
    requiredFields: [
      "schema_version",
      "task_id",
      "base_sha",
      "task_spec_sha256",
      "status",
      "summary",
      "operations",
      "acceptance_notes",
      "risks",
      "blocker"
    ]
  }
};

const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  strictSchema: false,
  coerceTypes: false,
  useDefaults: false,
  removeAdditional: false,
  validateSchema: true
});

const schemaCache: Partial<Record<SchemaKind, Record<string, unknown>>> = {};
const schemaSourceRoot: Partial<Record<SchemaKind, string>> = {};
const schemaValidatorCache: Partial<
  Record<SchemaKind, ValidateFunction<Record<string, unknown>>>
> = {};
let explicitSchemaRoot: string | undefined;


const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeSchema = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const issuePath = (error: ErrorObject): string => {
  const base = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  if (error.keyword === "required" && "missingProperty" in error.params) {
    const missingProperty = typeof error.params.missingProperty === "string" ? error.params.missingProperty : "";
    if (missingProperty.length > 0) {
      return base.length > 0 ? `${base}.${missingProperty}` : missingProperty;
    }
  }
  if (error.keyword === "additionalProperties" && "additionalProperty" in error.params) {
    const additionalProperty =
      typeof error.params.additionalProperty === "string" ? error.params.additionalProperty : "";
    return additionalProperty.length > 0
      ? base.length > 0
        ? `${base}.${additionalProperty}`
        : additionalProperty
      : base;
  }
  return base.length > 0 ? base : "$";
};

const mapAjvIssues = (errors: ErrorObject[] | null | undefined): ValidationIssue[] =>
  (errors ?? []).map((error) => ({
    path: issuePath(error),
    message: error.message ?? "Invalid schema value"
  }));

const addIssue = (issues: ValidationIssue[], pathLabel: string, message: string): void => {
  issues.push({ path: pathLabel, message });
};

const isRecordLike = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasPropertyMap = (value: unknown): value is Record<string, unknown> =>
  isRecordLike(value) && isRecordLike(value.properties);

/**
 * Validate the deliberately small JSON Schema subset accepted by Codex
 * Structured Outputs. The actual path and cross-field safety rules remain in
 * the TypeScript semantic validators after this structural check.
 */
export const validateStructuredOutputCompatibility = (
  schema: unknown
): ValidationResult<Record<string, unknown>> => {
  const issues: ValidationIssue[] = [];
  const visitSchema = (value: unknown, location: string): void => {
    if (!isRecordLike(value)) return;

    // A $ref is a complete schema node by itself. Every other schema node
    // must declare its type explicitly, including const/enum-only nodes.
    if (!("$ref" in value) && !("type" in value)) {
      addIssue(issues, `${location}.type`, "schema nodes must declare an explicit type");
    }

    const properties = value.properties;
    if (value.type === "object" && !isRecordLike(properties)) {
      addIssue(issues, `${location}.properties`, "object schemas must declare a properties map");
    }
    if (isRecordLike(properties)) {
      if (value.additionalProperties !== false) {
        addIssue(issues, `${location}.additionalProperties`, "object schemas must set additionalProperties to false");
      }
      const required = Array.isArray(value.required) ? value.required : [];
      const requiredNames = new Set(required.filter((entry): entry is string => typeof entry === "string"));
      for (const propertyName of Object.keys(properties)) {
        if (!requiredNames.has(propertyName)) {
          addIssue(issues, `${location}.required`, `object property ${propertyName} must be required`);
        }
      }
      for (const requiredName of requiredNames) {
        if (!(requiredName in properties)) {
          addIssue(issues, `${location}.required`, `required property ${requiredName} is not declared`);
        }
      }
    }

    // Only values in schema-bearing keywords are visited as schemas. In
    // particular, `properties` and `$defs` are maps of schemas, not schemas
    // themselves; required/enum/type arrays contain data, not schema nodes.
    if (isRecordLike(properties)) {
      Object.entries(properties).forEach(([key, child]) => visitSchema(child, `${location}.properties.${key}`));
    }
    const definitions = value.$defs;
    if (isRecordLike(definitions)) {
      Object.entries(definitions).forEach(([key, child]) => visitSchema(child, `${location}.$defs.${key}`));
    }
    if ("items" in value) {
      visitSchema(value.items, `${location}.items`);
    }
    if (Array.isArray(value.prefixItems)) {
      value.prefixItems.forEach((child, index) => visitSchema(child, `${location}.prefixItems[${index}]`));
    }
    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      if (Array.isArray(value[key])) {
        value[key].forEach((child, index) => visitSchema(child, `${location}.${key}[${index}]`));
      }
    }
  };

  visitSchema(schema, "$" );
  return issues.length > 0
    ? { valid: false, issues }
    : { valid: true, value: normalizeSchema(schema) };
};

export const validateSchemaAuthority = (
  schema: unknown,
  kind: SchemaKind
): ValidationResult<Record<string, unknown>> => {
  const issues: ValidationIssue[] = [];
  const contract = schemaContracts[kind];

  if (!isRecordLike(schema)) {
    return { valid: false, issues: [{ path: "$", message: "schema must be an object" }] };
  }

  if (schema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    addIssue(issues, "$schema", "schema must be draft 2020-12");
  }

  const expectedId = `https://agentplatform.local/schemas/${kind}.schema.json`;
  if (schema.$id !== expectedId) {
    addIssue(issues, "$id", `${kind} schema has unexpected $id`);
  }

  if (schema.title !== contract.title) {
    addIssue(issues, "title", `${kind} schema title must be ${contract.title}`);
  }

  if (schema.additionalProperties !== false) {
    addIssue(issues, "additionalProperties", `${kind} schema must set additionalProperties to false`);
  }

  const required = Array.isArray(schema.required) ? schema.required : [];
  const requiredFields = required.map((value) => String(value));
  const properties = (hasPropertyMap(schema) ? schema.properties : {}) as Record<string, unknown>;
  if (schema.schema_version !== contract.schemaVersion) {
    addIssue(issues, "schema_version", `${kind} schema_version must be ${contract.schemaVersion}`);
  }

  const missing = contract.requiredFields.filter((field) => !requiredFields.includes(field));
  if (missing.length > 0) {
    addIssue(issues, "required", `${kind} schema missing required keys: ${missing.join(", ")}`);
  }

  const missingProperties = contract.requiredFields.filter((field) => !(field in properties));
  if (missingProperties.length > 0) {
    addIssue(
      issues,
      "properties",
      `${kind} schema missing required properties: ${missingProperties.join(", ")}`
    );
  }

  const compatibility = validateStructuredOutputCompatibility(schema);
  if (!compatibility.valid) {
    issues.push(...compatibility.issues);
  }

  return issues.length > 0
    ? { valid: false, issues }
    : { valid: true, value: normalizeSchema(schema) };
};

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const getModuleRoots = (): string[] => {
  const roots: string[] = [];
  let current = moduleDir;

  while (true) {
    roots.push(current);
    const next = path.dirname(current);
    if (next === current) {
      break;
    }
    current = next;
  }

  return roots;
};

const getCandidateSchemaRoots = (): string[] => {
  const candidates: string[] = [];
  const add = (value: string): void => {
    const normalized = path.resolve(value);
    if (!candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  const resourcesPath = (process as typeof process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    const resourcesRoot = path.resolve(resourcesPath);
    add(path.join(resourcesRoot, "schemas"));
    add(path.join(resourcesRoot, "app.asar.unpacked", "schemas"));
    add(path.join(resourcesRoot, "app.asar", "schemas"));
  }

  getModuleRoots().forEach((root) => add(path.join(root, "schemas")));

  return candidates;
};

const resolveSchemaRoot = (kind: SchemaKind, schemaRoot?: string): ValidationResult<string> => {
  const explicitRoot = schemaRoot?.trim();
  const configuredRoot = explicitSchemaRoot?.trim();
  const candidateRoots = explicitRoot
    ? [explicitRoot]
    : configuredRoot
      ? [configuredRoot]
      : getCandidateSchemaRoots();
  const schemaFileName = schemaContracts[kind].file;

  for (const root of candidateRoots) {
    const schemaPath = path.join(path.resolve(root), schemaFileName);
    if (fs.existsSync(schemaPath)) {
      return { valid: true, value: path.dirname(schemaPath) };
    }
  }

  return {
    valid: false,
    issues: [{ path: "schemaRoot", message: `Unable to locate ${schemaFileName}` }]
  };
};

export const setSchemaRoot = (schemaRoot: string): void => {
  const root = path.resolve(schemaRoot);
  explicitSchemaRoot = root;

  (Object.keys(schemaContracts) as SchemaKind[]).forEach((kind) => {
    delete schemaCache[kind];
    delete schemaSourceRoot[kind];
    delete schemaValidatorCache[kind];
  });
};

export const loadAndValidateSchema = (
  kind: SchemaKind,
  options: { schemaRoot?: string } = {}
): ValidationResult<Record<string, unknown>> => {
  const cached = schemaCache[kind];
  const cachedRoot = schemaSourceRoot[kind];
  const requestedRoot = options.schemaRoot ? path.resolve(options.schemaRoot) : undefined;
  if (cached !== undefined && (requestedRoot === undefined || cachedRoot === requestedRoot)) {
    return { valid: true, value: cached };
  }

  const rootResult = resolveSchemaRoot(kind, options.schemaRoot);
  if (!rootResult.valid) {
    return rootResult;
  }

  const schemaPath = path.join(rootResult.value, schemaContracts[kind].file);
  try {
    const raw = fs.readFileSync(schemaPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    const result = validateSchemaAuthority(parsed, kind);
    if (result.valid) {
      schemaCache[kind] = result.value;
      schemaSourceRoot[kind] = rootResult.value;
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { valid: false, issues: [{ path: schemaPath, message: `Unable to load schema: ${message}` }] };
  }
};

const getSchemaValidator = (kind: SchemaKind): ValidationResult<ValidateFunction<Record<string, unknown>>> => {
  const cachedValidator = schemaValidatorCache[kind];
  if (cachedValidator !== undefined) {
    return { valid: true, value: cachedValidator };
  }

  const schemaResult = loadAndValidateSchema(kind);
  if (!schemaResult.valid) {
    return schemaResult;
  }

  const validate = ajv.compile<Record<string, unknown>>(schemaResult.value);
  schemaValidatorCache[kind] = validate;
  return { valid: true, value: validate };
};

export const validateAgainstSchema = (
  kind: SchemaKind,
  value: unknown
): ValidationResult<Record<string, unknown>> => {
  const schemaResult = getSchemaValidator(kind);
  if (!schemaResult.valid) {
    return schemaResult;
  }

  const validator = schemaResult.value;
  if (validator(value)) {
    return { valid: true, value: normalizeSchema(value) };
  }

  return { valid: false, issues: mapAjvIssues(validator.errors) };
};

export const validateTaskSpecSchema = (schema: unknown): ValidationResult<Record<string, unknown>> =>
  validateSchemaAuthority(schema, "task-spec");

export const validateAgentResultSchema = (schema: unknown): ValidationResult<Record<string, unknown>> =>
  validateSchemaAuthority(schema, "agent-result");

export const validateFinalGateSchema = (schema: unknown): ValidationResult<Record<string, unknown>> =>
  validateSchemaAuthority(schema, "final-gate");

export const loadTaskSpecSchema = (
  options: { schemaRoot?: string } = {}
): ValidationResult<Record<string, unknown>> => loadAndValidateSchema("task-spec", options);

export const loadAgentResultSchema = (
  options: { schemaRoot?: string } = {}
): ValidationResult<Record<string, unknown>> => loadAndValidateSchema("agent-result", options);

export const loadFinalGateSchema = (
  options: { schemaRoot?: string } = {}
): ValidationResult<Record<string, unknown>> => loadAndValidateSchema("final-gate", options);

export const validateWorkerProposalRequestSchema = (schema: unknown): ValidationResult<Record<string, unknown>> =>
  validateSchemaAuthority(schema, "worker-proposal-request");

export const validateChangeSetSchema = (schema: unknown): ValidationResult<Record<string, unknown>> =>
  validateSchemaAuthority(schema, "change-set");

export const loadWorkerProposalRequestSchema = (
  options: { schemaRoot?: string } = {}
): ValidationResult<Record<string, unknown>> => loadAndValidateSchema("worker-proposal-request", options);

export const loadChangeSetSchema = (
  options: { schemaRoot?: string } = {}
): ValidationResult<Record<string, unknown>> => loadAndValidateSchema("change-set", options);

export const validateTaskSpecInstance = (value: unknown): ValidationResult<Record<string, unknown>> =>
  validateAgainstSchema("task-spec", value);

export const validateLegacyTaskSpecInstance = (value: unknown): ValidationResult<Record<string, unknown>> => {
  const schemaPath = path.join(resolveSchemaRootForLegacy(), "task-spec.v1.schema.json");
  try {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as Record<string, unknown>;
    const validator = ajv.compile<Record<string, unknown>>(schema);
    if (validator(value)) return { valid: true, value: normalizeSchema(value) };
    return { valid: false, issues: mapAjvIssues(validator.errors) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { valid: false, issues: [{ path: schemaPath, message: `Unable to load legacy schema: ${message}` }] };
  }
};

const resolveSchemaRootForLegacy = (): string => {
  const root = resolveSchemaRoot("task-spec");
  return root.valid ? root.value : path.join(moduleDir, "schemas");
};

export const validateWorkerResultInstance = (value: unknown): ValidationResult<Record<string, unknown>> =>
  validateAgainstSchema("agent-result", value);

export const validateFinalGateInstance = (value: unknown): ValidationResult<Record<string, unknown>> =>
  validateAgainstSchema("final-gate", value);

export const validateWorkerProposalRequestInstance = (
  value: unknown
): ValidationResult<Record<string, unknown>> => validateAgainstSchema("worker-proposal-request", value);

export const validateChangeSetInstance = (value: unknown): ValidationResult<Record<string, unknown>> =>
  validateAgainstSchema("change-set", value);
