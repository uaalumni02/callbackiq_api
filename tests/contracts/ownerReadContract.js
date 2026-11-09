import Ajv2020 from 'ajv/dist/2020.js';
import contract from '../../contracts/owner-reads.v1.openapi.json';

const root = 'https://www.meekcall.com/contracts/owner-reads.v1';
const ajv = new Ajv2020({ allErrors: true, strictSchema: false });
ajv.addSchema({ ...contract, $id: root }, root);

const validators = new Map();
const schemaId = (path) => `#/paths/${path.replaceAll('~', '~0').replaceAll('/', '~1')}/get/responses/200/content/application~1json/schema`;

function bodyValidator(path) {
  const key = schemaId(path);
  if (!validators.has(key)) validators.set(key, ajv.getSchema(root + key));
  const validate = validators.get(key);
  if (!validate) throw new Error(`Missing owner read contract for ${path}`);
  return validate;
}

export function assertOwnerReadContract(path, response) {
  const validate = bodyValidator(path);
  if (!validate(response.body)) {
    throw new Error(`${path} response violates its contract: ${ajv.errorsText(validate.errors)}`);
  }

  const headers = contract.paths[path].get.responses['200'].headers || {};
  for (const [name, header] of Object.entries(headers)) {
    const value = response.headers?.[name.toLowerCase()];
    if (value === undefined && !header.required) continue;
    const validateHeader = ajv.compile(header.schema);
    if (!validateHeader(value)) throw new Error(`${path} invalid ${name} response header`);
  }
  if (headers['X-Has-More'] && response.headers['x-has-more'] === 'true' && !response.headers['x-next-cursor']) {
    throw new Error(`${path} pagination is missing X-Next-Cursor`);
  }
}
