'use strict';
/**
 * tests/profileSynthesizer.test.js
 * Unit tests for lib/profileSynthesizer.js
 *
 * Covers:
 *  - synthesize()             : identity merge, skills dedup, work history, confidence
 *  - LinkedIn export path     : positions → workHistory, years-of-experience, skills merge
 *  - generateSearchFilters()  : keyword generation, geo expansion
 *  - scoreSignal()            : keyword/industry/type scoring, recency bonus
 *  - scoreTier()              : HOT / WARM / MONITOR / COLD thresholds
 */

const {
  synthesize,
  generateSearchFilters,
  scoreSignal,
  scoreTier,
  SIGNAL_TYPES,
} = require('../lib/profileSynthesizer');

// ─── Fixtures ────────────────────────────────────────────────────────────────

const mockCV = {
  name:            'Jane Smith',
  headline:        'Senior Data Engineer',
  email:           'jane@example.com',
  location:        'Amsterdam, Netherlands',
  skills:          ['Python', 'SQL', 'dbt', 'Spark'],
  industries:      ['Asset Management', 'FinTech'],
  yearsExperience: 9,
  workHistory:     [
    { company: 'Acme AM', title: 'Data Engineer', startYear: 2017, endYear: 2021, isCurrent: false, durationMonths: 48 },
    { company: 'Beta Capital', title: 'Senior Data Engineer', startYear: 2021, endYear: null, isCurrent: true, durationMonths: null },
  ],
};

const mockLinkedIn = {
  name:    'Jane Smith',
  headline:'Senior Data Engineer @ Beta Capital',
  email:   'jane@linkedin.example.com',
  country: 'NL',
  picture: 'https://example.com/pic.jpg',
};

const mockLinkedInExport = {
  _fromExport: true,
  name:        'Jane Smith',
  headline:    'Senior Data Engineer',
  location:    'Amsterdam',
  skills:      ['Python', 'Airflow', 'Kafka'],    // Airflow + Kafka are new
  positions:   [
    { title: 'Data Engineer',        company: 'Acme AM',       started: 'Jan 2017', finished: 'Dec 2020' },
    { title: 'Senior Data Engineer', company: 'Beta Capital',  started: 'Feb 2021', finished: 'Present' },
  ],
};

const mockSOW = {
  verticals:      ['Asset Management'],
  keywords:       ['data pipeline', 'ETL', 'dbt', 'cloud migration'],
  services:       ['Data pipeline design', 'ETL automation'],
  deliverables:   ['Data model', 'Runbook'],
  urgencySignals: ['go-live Q2'],
  rateHint:       700,
  durationHint:   6,
};

// ─── synthesize() ────────────────────────────────────────────────────────────

describe('synthesize() — identity', () => {
  test('picks LinkedIn name over CV name', () => {
    const p = synthesize(mockLinkedIn, mockCV, []);
    expect(p.name).toBe('Jane Smith');
  });

  test('falls back to CV name when LinkedIn has no name', () => {
    const p = synthesize({ headline: 'x' }, mockCV, []);
    expect(p.name).toBe('Jane Smith');
  });

  test('LinkedIn OAuth: uses li.country as location fallback', () => {
    const p = synthesize({ name: 'X', country: 'DE' }, null, []);
    expect(p.location).toBe('DE');
  });

  test('picture comes from LinkedIn OAuth', () => {
    const p = synthesize(mockLinkedIn, mockCV, []);
    expect(p.picture).toBe('https://example.com/pic.jpg');
  });

  test('email prefers LinkedIn OAuth email', () => {
    const p = synthesize(mockLinkedIn, mockCV, []);
    expect(p.email).toBe('jane@linkedin.example.com');
  });
});

describe('synthesize() — skills', () => {
  test('deduplicates skills case-insensitively', () => {
    const cv = { ...mockCV, skills: ['Python', 'SQL'] };
    const li = { ...mockLinkedInExport, skills: ['python', 'Airflow'] };
    const p  = synthesize(li, cv, []);
    const lower = p.skills.map(s => s.toLowerCase());
    // python should appear only once
    expect(lower.filter(s => s === 'python').length).toBe(1);
    // airflow should be present
    expect(lower).toContain('airflow');
  });

  test('merges LinkedIn export skills with CV skills (CV first)', () => {
    const p = synthesize(mockLinkedInExport, mockCV, []);
    // CV skills come first
    expect(p.skills[0]).toBe('Python');
    // New export skills are appended
    expect(p.skills).toContain('Airflow');
    expect(p.skills).toContain('Kafka');
  });

  test('OAuth LinkedIn (not export) does not add extra skills', () => {
    const p = synthesize(mockLinkedIn, mockCV, []);
    // mockLinkedIn has no skills array → only CV skills
    expect(p.skills).toEqual(mockCV.skills);
  });
});

describe('synthesize() — LinkedIn export work history', () => {
  test('uses CV workHistory when available, ignores export positions', () => {
    const p = synthesize(mockLinkedInExport, mockCV, []);
    expect(p.workHistory).toEqual(mockCV.workHistory);
  });

  test('falls back to export positions when CV has no workHistory', () => {
    const cvNoHistory = { ...mockCV, workHistory: [] };
    const p = synthesize(mockLinkedInExport, cvNoHistory, []);
    expect(p.workHistory.length).toBe(2);
    expect(p.workHistory[0].company).toBe('Acme AM');
    expect(p.workHistory[1].company).toBe('Beta Capital');
    expect(p.workHistory[1].isCurrent).toBe(true);
  });

  test('export position with "Present" end sets isCurrent=true and endYear=this year', () => {
    const cvNoHistory = { ...mockCV, workHistory: [] };
    const p = synthesize(mockLinkedInExport, cvNoHistory, []);
    const current = p.workHistory.find(w => w.isCurrent);
    expect(current).toBeDefined();
    expect(current.endYear).toBe(new Date().getFullYear());
  });

  test('derives yearsExperience from export positions when CV has none', () => {
    const cvNoExp = { ...mockCV, workHistory: [], yearsExperience: null };
    const p = synthesize(mockLinkedInExport, cvNoExp, []);
    // Earliest start = 2017, so ~(currentYear - 2017)
    const expected = new Date().getFullYear() - 2017;
    expect(p.yearsExperience).toBeGreaterThanOrEqual(expected - 1);
    expect(p.yearsExperience).toBeLessThanOrEqual(expected + 1);
  });

  test('CV yearsExperience wins over export derivation', () => {
    const p = synthesize(mockLinkedInExport, mockCV, []);
    expect(p.yearsExperience).toBe(9);
  });
});

describe('synthesize() — seniority inference', () => {
  test('Senior from headline keyword', () => {
    const p = synthesize(null, mockCV, []);
    expect(p.seniority).toBe('Senior');
  });

  test('Executive from "CTO" in headline', () => {
    const p = synthesize({ headline: 'CTO at FinTech Corp' }, null, []);
    expect(p.seniority).toBe('Executive');
  });

  test('Director from "Head of" in headline', () => {
    const p = synthesize({ headline: 'Head of Engineering' }, null, []);
    expect(p.seniority).toBe('Director');
  });

  test('Junior from years < 3', () => {
    const p = synthesize(null, { ...mockCV, headline: null, yearsExperience: 1 }, []);
    expect(p.seniority).toBe('Junior');
  });

  test('Senior from years >= 15 when headline neutral', () => {
    const p = synthesize(null, { ...mockCV, headline: 'Consultant', yearsExperience: 16 }, []);
    expect(p.seniority).toBe('Senior');
  });
});

describe('synthesize() — industries & SOW merge', () => {
  test('merges CV industries and SOW verticals without duplicates', () => {
    const p = synthesize(null, mockCV, [mockSOW]);
    // 'Asset Management' appears in both CV and SOW — should appear once
    expect(p.industries.filter(i => i === 'Asset Management').length).toBe(1);
  });

  test('SOW synonyms are canonicalized (Fund Operations → Asset Management)', () => {
    const sowWithSynonym = { ...mockSOW, verticals: ['Fund Operations'] };
    const p = synthesize(null, mockCV, [sowWithSynonym]);
    expect(p.industries).toContain('Asset Management');
    expect(p.industries).not.toContain('Fund Operations');
  });

  test('SOW rateHints and durationHints are collected', () => {
    const p = synthesize(null, mockCV, [mockSOW]);
    expect(p.rateHints).toContain(700);
    expect(p.avgContractDuration).toBe(6);
  });
});

describe('synthesize() — confidence score', () => {
  test('full profile (all 8 fields present) = 100%', () => {
    const p = synthesize(mockLinkedIn, mockCV, [mockSOW]);
    expect(p.confidence).toBe(100);
  });

  test('empty inputs = 0%', () => {
    const p = synthesize(null, null, []);
    expect(p.confidence).toBe(0);
  });

  test('partial profile scales correctly', () => {
    // only name + email from LinkedIn, no CV
    const p = synthesize({ name: 'X', email: 'x@y.com' }, null, []);
    // fields: name✓, headline✗, email✓, location✗, skills✗, industries✗, services✗, keywords✗  → 2/8 = 25
    expect(p.confidence).toBe(25);
  });
});

describe('synthesize() — sources label', () => {
  test('OAuth LinkedIn → "LinkedIn" label', () => {
    const p = synthesize(mockLinkedIn, null, []);
    expect(p.sources).toContain('LinkedIn');
    expect(p.sources).not.toContain('LinkedIn Export');
  });

  test('CSV export → "LinkedIn Export" label', () => {
    const p = synthesize(mockLinkedInExport, null, []);
    expect(p.sources).toContain('LinkedIn Export');
  });

  test('multiple SOWs reflected in source count', () => {
    const p = synthesize(null, mockCV, [mockSOW, mockSOW]);
    expect(p.sources).toContain('2 contracts');
  });
});

// ─── generateSearchFilters() ─────────────────────────────────────────────────

describe('generateSearchFilters()', () => {
  let profile;
  beforeAll(() => {
    profile = synthesize(mockLinkedIn, mockCV, [mockSOW]);
  });

  test('returns keywords array', () => {
    const f = generateSearchFilters(profile);
    expect(Array.isArray(f.keywords)).toBe(true);
    expect(f.keywords.length).toBeGreaterThan(0);
  });

  test('includes top skills in keywords', () => {
    const f = generateSearchFilters(profile);
    const lower = f.keywords.map(k => k.toLowerCase());
    // At least one of the core skills should appear
    expect(lower.some(k => ['python', 'sql', 'dbt', 'spark'].includes(k))).toBe(true);
  });

  test('adds Netherlands + Remote by default', () => {
    const f = generateSearchFilters(profile);
    expect(f.geographies).toContain('Netherlands');
    expect(f.geographies).toContain('Remote');
  });

  test('expands geographies when location is UK', () => {
    const ukProfile = synthesize({ name: 'X', country: 'UK' }, { ...mockCV, location: 'London, UK' }, []);
    const f = generateSearchFilters(ukProfile);
    expect(f.geographies).toContain('United Kingdom');
  });

  test('generates news queries', () => {
    const f = generateSearchFilters(profile);
    expect(Array.isArray(f.newsQueries)).toBe(true);
    expect(f.newsQueries.length).toBeGreaterThan(0);
  });

  test('always includes regulatory news query', () => {
    const f = generateSearchFilters(profile);
    const types = f.newsQueries.map(q => q.type);
    expect(types).toContain(SIGNAL_TYPES.REGULATORY);
  });

  test('reflects profile confidence', () => {
    const f = generateSearchFilters(profile);
    expect(f.profileConfidence).toBe(profile.confidence);
  });
});

// ─── scoreSignal() ────────────────────────────────────────────────────────────

describe('scoreSignal()', () => {
  let profile;
  beforeAll(() => {
    profile = synthesize(mockLinkedIn, mockCV, [mockSOW]);
  });

  test('returns 0 for null inputs', () => {
    expect(scoreSignal(null, profile)).toBe(0);
    expect(scoreSignal({}, null)).toBe(0);
  });

  test('keyword-rich signal scores higher than generic signal', () => {
    const rich = {
      title:       'Leading Asset Management firm deploys dbt and Python for data pipeline',
      description: 'SQL migration underway',
      type:        SIGNAL_TYPES.NEWS,
      publishedAt: new Date().toISOString(),
    };
    const generic = {
      title:       'Company announces rebranding',
      description: '',
      type:        SIGNAL_TYPES.NEWS,
      publishedAt: new Date().toISOString(),
    };
    expect(scoreSignal(rich, profile)).toBeGreaterThan(scoreSignal(generic, profile));
  });

  test('leadership change signal type adds bonus points', () => {
    const base = {
      title: 'Generic announcement',
      description: '',
      type: SIGNAL_TYPES.NEWS,
      publishedAt: new Date().toISOString(),
    };
    const leadership = { ...base, type: SIGNAL_TYPES.LEADERSHIP_CHANGE };
    expect(scoreSignal(leadership, profile)).toBeGreaterThan(scoreSignal(base, profile));
  });

  test('very recent signal (< 2 days) gets max recency bonus', () => {
    const recent = {
      title:       'dbt summit',
      description: 'Python data pipelines',
      type:        SIGNAL_TYPES.NEWS,
      publishedAt: new Date().toISOString(),   // now
    };
    const old = {
      ...recent,
      publishedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 days ago
    };
    expect(scoreSignal(recent, profile)).toBeGreaterThan(scoreSignal(old, profile));
  });

  test('score is capped at 100', () => {
    // Maximally matching signal
    const perfect = {
      title:       'Asset Management fintech python dbt sql spark data pipeline ETL cloud migration',
      description: 'New CIO appointed, raises series B, deploys dbt DORA compliance 2025',
      type:        SIGNAL_TYPES.LEADERSHIP_CHANGE,
      publishedAt: new Date().toISOString(),
    };
    expect(scoreSignal(perfect, profile)).toBeLessThanOrEqual(100);
  });

  test('score is non-negative', () => {
    const signal = { title: 'unrelated news about cats', type: SIGNAL_TYPES.NEWS };
    expect(scoreSignal(signal, profile)).toBeGreaterThanOrEqual(0);
  });
});

// ─── scoreTier() ─────────────────────────────────────────────────────────────

describe('scoreTier()', () => {
  test('75+ → HOT',     () => expect(scoreTier(75)).toBe('HOT'));
  test('100 → HOT',     () => expect(scoreTier(100)).toBe('HOT'));
  test('74 → WARM',     () => expect(scoreTier(74)).toBe('WARM'));
  test('50 → WARM',     () => expect(scoreTier(50)).toBe('WARM'));
  test('49 → MONITOR',  () => expect(scoreTier(49)).toBe('MONITOR'));
  test('25 → MONITOR',  () => expect(scoreTier(25)).toBe('MONITOR'));
  test('24 → COLD',     () => expect(scoreTier(24)).toBe('COLD'));
  test('0 → COLD',      () => expect(scoreTier(0)).toBe('COLD'));
});
