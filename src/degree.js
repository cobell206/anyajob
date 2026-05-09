// src/degree.js
//
// Hard-disqualifier filter: detects job listings that explicitly require a
// law degree (JD, Juris Doctor) or bar admission. The candidate doesn't have
// a law degree, so these are auto-ignored at the ingestion gate (src/daily.js)
// and retroactively (scripts/migrate-degree.js).
//
// Patterns are tuned to fire only when the credential is required of the
// applicant. "Works closely with attorneys" / "law firm" / "patent law
// experience" pass through. Bare "law" never matches.

const PATTERNS = [
  /J\.D\./,                                                  // J.D.
  /\bJD\s+(?:required|preferred|or\s+equivalent|degree)\b/i, // JD required / JD or equivalent
  /\bJuris\s+Doctor\b/i,
  /\blaw\s+degree\b/i,
  /\blicensed\s+attorney\b/i,
  /\blicensed\s+to\s+practice\s+law\b/i,
  /\badmitted\s+to\s+(?:the\s+)?(?:state\s+)?bar\b/i,
  /\bbar\s+admission\b/i,
  /\bbar\s+membership\b/i,
  /\bmember\s+(?:in\s+good\s+standing\s+)?of\s+(?:the|a|any)[^.;\n]{0,40}\bbar\b/i,
  /\battorney\s+at\s+law\b/i,
  /\bmust\s+be\s+(?:a|an)\s+(?:licensed\s+|practicing\s+)?attorney\b/i,
];

export function requiresLawDegree(listing) {
  if (!listing) return false;
  const haystack = `${listing.title || ''}\n${listing.description || ''}`;
  return PATTERNS.some((re) => re.test(haystack));
}
