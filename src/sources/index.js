// src/sources/index.js
// Thin wrapper around the source registry. The registry handles user-managed
// sources; this is the entry point the daily cron uses.

export { fetchAll } from './registry.js';
export { runOne, loadSources, getDueBookmarks, markBookmarkBriefed } from './registry.js';
