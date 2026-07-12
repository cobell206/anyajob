// src/io.js
// Back-compat facade over the storage seam (src/store.js). Kept so the many
// modules importing { readJson, writeJson, fbKey, ROOT, DATA } from here don't
// all need touching. New code can import from store.js directly.
//
// writeJson here takes a bare name ("listings.json"); readJson accepts a name
// or an absolute path. Both funnel through store.js.

export {
  ROOT,
  DATA,
  readJson,
  writeJson,
  updateJson,
  readJsonSafe,
  readJsonStrict,
  readRaw,
  writeRaw,
  exists,
  removeFile,
  fbKey,
} from './store.js';
