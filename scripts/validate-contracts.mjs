import { readFile, readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const contractsDirectory = resolve('docs/contracts');
const examplesDirectory = resolve(contractsDirectory, 'examples');
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const schemaFiles = (await readdir(contractsDirectory))
  .filter(file => file.endsWith('.schema.json'))
  .sort();

for (const schemaFile of schemaFiles) {
  const schema = JSON.parse(
    await readFile(resolve(contractsDirectory, schemaFile), 'utf8'),
  );
  const validSchema = ajv.validateSchema(schema);
  if (!validSchema) {
    throw new Error(
      `Invalid schema ${schemaFile}: ${ajv.errorsText(ajv.errors, { separator: '\n' })}`,
    );
  }
  const validate = ajv.compile(schema);
  const exampleFile = schemaFile.replace('.schema.json', '.valid.json');
  const example = JSON.parse(
    await readFile(resolve(examplesDirectory, exampleFile), 'utf8'),
  );
  if (!validate(example)) {
    throw new Error(
      `Invalid example ${exampleFile}: ${ajv.errorsText(validate.errors, { separator: '\n' })}`,
    );
  }
  if (basename(schemaFile) === 'tool.schema.json') {
    validateStrictToolSchemas(example);
  }
}

process.stdout.write(
  `Validated ${schemaFiles.length} contract schemas and examples.\n`,
);

function validateStrictToolSchemas(value) {
  if (!isObject(value)) {
    throw new Error('Tool example must be an object.');
  }
  for (const key of ['inputSchema', 'outputSchema']) {
    const schema = value[key];
    if (!isObject(schema) || !isObject(schema.properties)) {
      throw new Error(`${key} must contain properties.`);
    }
    const required = schema.required;
    if (!Array.isArray(required) || !required.every(item => typeof item === 'string')) {
      throw new Error(`${key}.required must be a string array.`);
    }
    const properties = Object.keys(schema.properties);
    if (
      properties.length !== required.length ||
      properties.some(property => !required.includes(property))
    ) {
      throw new Error(`${key} must require every property exactly once.`);
    }
    verifyNestedObjects(schema, key);
  }
}

function verifyNestedObjects(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => verifyNestedObjects(item, `${path}[${index}]`));
    return;
  }
  if (!isObject(value)) return;
  if (value.type === 'object' && value.additionalProperties !== false) {
    throw new Error(`${path} must set additionalProperties to false.`);
  }
  for (const [key, nested] of Object.entries(value)) {
    verifyNestedObjects(nested, `${path}.${key}`);
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
