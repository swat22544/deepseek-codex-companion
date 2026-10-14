// Duplicate detection for finite, acyclic JSON values. Callers normalize each
// item once before this pass. Sorted object keys ignore insertion order; type
// tags and JSON string escaping keep arrays, strings and other values distinct.
// This module performs no IO, mutates no input and invokes no accessors/toJSON.

/**
 * Reads an own data property without running user code.
 * Accessors and missing properties yield undefined, which canonicalizes to `u:`.
 */
const ownDataValue = (holder, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(holder, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
};

// A primitive string, so no `toJSON` or accessor can be consulted and the
// escaping is injective (distinct strings produce distinct encodings).
const encodeString = value => `s:${JSON.stringify(value)}`;

const canonicalizeArray = value => {
  const parts = [];
  for (let index = 0; index < value.length; index += 1) {
    parts.push(canonicalize(ownDataValue(value, index)));
  }
  return `a:[${parts.join(',')}]`;
};

const canonicalizeObject = value => {
  // Sorting makes insertion order irrelevant, matching equalJson.  Keys only ever
  // appear inside the emitted string: nothing is assigned onto an object and no
  // key-indexed lookup is performed, so an own "__proto__" key can never reach
  // Object.prototype's setter and "constructor" can never shadow a prototype
  // member.  Object.getOwnPropertyDescriptor is own-only, so a JSON.parse-produced
  // own "__proto__" data property is serialized verbatim instead of the prototype.
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const key of keys) {
    parts.push(`${encodeString(key)}:${canonicalize(ownDataValue(value, key))}`);
  }
  return `o:{${parts.join(',')}}`;
};

const canonicalize = value => {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'b:true' : 'b:false';
    case 'number':
      // Only finite numbers are in contract.  `${value}` (ToString) is injective
      // over finite doubles and maps -0 to "0", exactly like the JSON round trip
      // in equalJson.  equalJson serializes non-finite numbers as null, so mirror
      // that rather than inventing a different equivalence.
      return Number.isFinite(value) ? `n:${value}` : 'null';
    case 'string':
      return encodeString(value);
    case 'object':
      return Array.isArray(value) ? canonicalizeArray(value) : canonicalizeObject(value);
    default:
      // undefined, function, symbol, bigint: outside the validated JSON domain.
      return 'u:';
  }
};

/**
 * Returns true when `values` contains two JSON-equal items.
 *
 * Precondition: every item already satisfies the finite, acyclic JSON value
 * contract; this function does not re-validate and does not modify the array or
 * its items.  Each item is canonicalized at most once and compared through a Set,
 * avoiding pairwise comparison; object keys are sorted once per object.
 */
export function hasDuplicateJsonItems(values) {
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const key = canonicalize(ownDataValue(values, index));
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}
