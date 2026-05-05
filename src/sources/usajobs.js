// src/sources/usajobs.js
// USAJobs.gov public API. Free key from developer.usajobs.gov.
// Great for federal legal/policy roles in NYC area.

import fetch from 'node-fetch';
import { createLogger } from '../log.js';

const log = createLogger('usajobs');

const KEYWORDS = ['paralegal', 'legal assistant', 'attorney advisor', 'policy analyst', 'investigator'];
const LOCATIONS = ['New York, New York', 'Manhattan, New York'];

export async function fetchUSAJobs() {
  const apiKey = process.env.USAJOBS_API_KEY;
  const email = process.env.USAJOBS_EMAIL;
  if (!apiKey || !email) {
    log.warn('USAJOBS_API_KEY or USAJOBS_EMAIL not set, skipping');
    return [];
  }

  const all = [];
  for (const keyword of KEYWORDS) {
    for (const location of LOCATIONS) {
      const url = `https://data.usajobs.gov/api/search?Keyword=${encodeURIComponent(keyword)}&LocationName=${encodeURIComponent(location)}&ResultsPerPage=25`;
      try {
        const res = await fetch(url, {
          timeout: 15000,
          headers: {
            'Host': 'data.usajobs.gov',
            'User-Agent': email,
            'Authorization-Key': apiKey,
          },
        });
        if (!res.ok) {
          log.warn({ status: res.status, keyword, location }, 'fetch failed');
          continue;
        }
        const data = await res.json();
        const items = data.SearchResult?.SearchResultItems || [];
        for (const item of items) {
          const d = item.MatchedObjectDescriptor;
          all.push({
            source: 'usajobs',
            company: d.OrganizationName || 'Federal Government',
            title: d.PositionTitle,
            location: (d.PositionLocationDisplay || '').toString(),
            url: d.PositionURI,
            description: [
              d.QualificationSummary,
              ...(d.UserArea?.Details?.MajorDuties || []),
            ]
              .filter(Boolean)
              .join('\n\n'),
            postedAt: d.PublicationStartDate,
            externalId: d.PositionID,
          });
        }
      } catch (err) {
        log.error({ err, keyword, location }, 'fetch error');
      }
    }
  }
  return all;
}
