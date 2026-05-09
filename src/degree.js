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

// Title-only patterns: if the role name itself says attorney/counsel, the
// position is for a lawyer. We don't apply these to the body because mentions
// like "works with our attorneys" or "lead counsel said" are common and
// benign. \bcounsel\b excludes "counselor" via word boundary, so "guidance
// counselor" / "mental health counselor" don't trigger; "counselor at law"
// is caught by its own pattern.
const TITLE_PATTERNS = [
  /\battorney\b/i,
  /\bcounsel\b/i,
  /\bcounselor\s+at\s+law\b/i,
];

// Body patterns: applied to title + description. Phrasing here is chosen to
// fire only when the credential is required of the applicant.
const BODY_PATTERNS = [
  /J\.D\./,                                                  // J.D.
  /\bJD\s+(?:required|preferred|or\s+equivalent|degree)\b/i, // JD required / JD or equivalent
  /\bJuris\s+Doctor\b/i,
  /\blaw\s+degree\b/i,
  /\blicensed\s+attorney\b/i,
  /\blicensed\s+to\s+practice(?:\s+law)?\b/i,
  /\badmitted\s+to\s+(?:the\s+)?(?:state\s+)?bar\b/i,
  /\bbar\s+admission\b/i,
  /\bbar\s+membership\b/i,
  /\bmember\s+(?:in\s+good\s+standing\s+)?of\s+(?:the|a|any)[^.;\n]{0,40}\bbar\b/i,
  /\battorney\s+at\s+law\b/i,
  /\bmust\s+be\s+(?:a|an)\s+(?:licensed\s+|practicing\s+)?attorney\b/i,
  /\bmust\s+be\s+licensed\b/i,
  /\bmust\s+hold\s+a\s+law\s+license\b/i,
  /\bEsq\b\.?/,
  /\besquire\b/i,
];

export function requiresLawDegree(listing) {
  if (!listing) return false;
  const title = listing.title || '';
  const body = `${title}\n${listing.description || ''}`;
  if (TITLE_PATTERNS.some((re) => re.test(title))) return true;
  return BODY_PATTERNS.some((re) => re.test(body));
}
