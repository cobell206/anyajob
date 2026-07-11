// src/atomic.js
// Back-compat facade over the storage seam (src/store.js). Historically this
// held the tmp+fsync+rename atomic-write logic; that now lives in store.js's
// fs backend so writes can be re-pointed at S3 without touching callers.
//
// writeJsonAtomic(path, value) keeps its original signature — callers pass an
// absolute data/ path and store.js keys on the basename. readJsonSafe /
// readJsonStrict likewise accept a path.

import { writeJson, readJsonSafe, readJsonStrict } from './store.js';

// Preserve the historical name/signature: writeJsonAtomic(path, value, opts).
export const writeJsonAtomic = writeJson;

export { readJsonSafe, readJsonStrict };
