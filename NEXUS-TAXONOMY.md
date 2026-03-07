# Nexus Live — Freelancer Data Taxonomy v1.0

> **First-principles design principle**: A freelancer's primary financial risk is the *bench gap* — the weeks between contracts where income is zero but expenses continue. Every data container in this taxonomy exists to eliminate, shorten, or price that gap.

---

## Core Philosophy: Containers + Tuples

The system models a freelancer as a graph of typed tuples. Each container is a **strongly-typed record** with identity, metadata, and relational edges. The network effect emerges when multiple freelancers' containers overlap in skills, verticals, and contact graphs — creating a referral mesh.

```
Profile (root)
├── IdentityTuple        — who you are
├── SkillNode[]          — what you can do, with proficiency
├── RateMatrix           — what you charge, by context
├── Engagement[]         — what you've done (contract history)
├── AvailabilityState    — when you're free
├── FinancialModel       — your cash reality
├── ContactNode[]        — your network graph
├── SignalFeed[]         — market intelligence
└── OutreachTarget[]     — ranked pipeline of opportunities
```

---

## 1. IdentityTuple

The root anchor of the entire profile. Immutable fields from CV extraction + user confirmation.

```typescript
IdentityTuple {
  // Primary key
  id:              string;         // UUID, generated on first confirm

  // Human identity
  name:            string;         // "Dan Deenik"
  headline:        string;         // "Freelance Financial PM | RegTech | DORA"
  email:           string;
  phone?:          string;
  location:        string;         // "Amsterdam, NL"

  // Professional positioning
  seniority:       Seniority;      // JUNIOR | MID | SENIOR | PRINCIPAL | C_LEVEL
  yearsExperience: number;
  industries:      string[];       // ["FinTech", "RegTech", "Asset Management"]
  services:        string[];       // Verb phrases from SOW: ["Lead DORA gap assessment"]
  certifications:  string[];       // ["PMP", "CSPO", "CFA L1"]

  // Availability (live pointer to AvailabilityState)
  availabilityRef: string;         // FK → AvailabilityState.id

  // Metadata
  sources:         ProfileSource[];// [{type: 'CV', confidence: 0.92}, {type: 'SOW', ...}]
  lastUpdated:     ISO8601;
  confidenceScore: number;         // 0–100 composite
}

type Seniority = 'JUNIOR' | 'MID' | 'SENIOR' | 'PRINCIPAL' | 'C_LEVEL';
type ProfileSource = { type: 'CV' | 'SOW' | 'LinkedIn' | 'Manual'; confidence: number };
```

---

## 2. SkillNode[]

Skills are NOT flat strings — they are weighted graph nodes. Each node has a proficiency level that affects signal scoring weights.

```typescript
SkillNode {
  id:            string;
  name:          string;           // "DORA", "Product Management", "Python"
  category:      SkillCategory;
  proficiency:   Proficiency;      // AWARE | PRACTITIONER | EXPERT | MASTER
  yearsActive:   number;           // derived from engagement history
  lastUsed?:     ISO8601;          // derived from most recent engagement using this skill
  evidencedBy:   string[];         // FKs → Engagement.id where skill appears
  signalWeight:  number;           // 0.5–2.0; MASTER=2.0, AWARE=0.5
}

type SkillCategory = 'Technical' | 'Domain' | 'Methodology' | 'Regulatory' | 'Leadership' | 'Tool';
type Proficiency   = 'AWARE' | 'PRACTITIONER' | 'EXPERT' | 'MASTER';

// Proficiency → signal scoring weight
const PROFICIENCY_WEIGHT = {
  AWARE:         0.5,   // I've heard of it
  PRACTITIONER:  1.0,   // I can use it
  EXPERT:        1.5,   // I lead with it
  MASTER:        2.0,   // I write the book on it
};
```

**Network effect**: When Contact.skills overlaps with your SkillNode[], referral probability increases. The overlap score determines outreach priority.

---

## 3. RateMatrix

Rate is not a single number — it is a function of context. First-principles: a day rate for a DORA compliance audit at a Dutch bank is different from the same hours doing backlog grooming at a startup.

```typescript
RateMatrix {
  // Base rates (from onboarding + SOW rateHint)
  dayRateBase:     number;         // €720
  hourlyRateBase:  number;         // €90
  currency:        'EUR' | 'GBP' | 'USD';

  // Context modifiers (multipliers)
  modifiers: RateModifier[];

  // Derived (calculated, not stored)
  effectiveRate(context: RateContext): number;  // base × product(applicable modifiers)

  // Market benchmarks (refreshed monthly via signals)
  benchmarks: RateBenchmark[];
}

RateModifier {
  label:      string;              // "Regulatory urgency", "Remote penalty", "Volume discount"
  multiplier: number;              // 1.2 = +20%, 0.9 = −10%
  condition:  string;              // Human-readable: "When engagement is regulatory-driven"
}

RateBenchmark {
  skill:       string;
  seniority:   Seniority;
  location:    string;
  p25:         number;             // 25th percentile day rate
  p50:         number;             // median
  p75:         number;             // 75th percentile
  source:      string;
  refreshedAt: ISO8601;
}

RateContext {
  clientType:    string;           // "Hedge Fund", "FinTech", "Government"
  urgencySignal: string | null;    // "Regulatory", "Transformation", null
  remote:        boolean;
  durationMonths: number;
}
```

---

## 4. Engagement[]

The ground truth of your career. Every contract / SOW becomes an Engagement tuple. This is the primary source for skills evidence, rate history, and network contacts.

```typescript
Engagement {
  id:             string;
  status:         EngagementStatus;

  // Contract data
  clientName:     string;
  clientType:     string;          // from sowParser clientType
  verticals:      string[];        // ["Asset Management", "RegTech"]
  role:           string;          // "Interim Risk PM"
  description:    string;          // from SOW scope section

  // Timeline
  startDate:      ISO8601;
  endDate?:       ISO8601;         // null = ongoing
  durationMonths: number;

  // Financial
  dayRate?:       number;
  hourlyRate?:    number;
  currency:       'EUR' | 'GBP' | 'USD';
  totalRevenue?:  number;          // derived: rate × working days

  // Skills used — links to SkillNode[]
  skillsUsed:     string[];        // SkillNode.id[]

  // Deliverables from SOW
  deliverables:   string[];
  urgencySignals: string[];        // ["Regulatory", "System migration"]

  // Network — contacts from this engagement
  contactsRef:    string[];        // ContactNode.id[]

  // Source
  sowFilename?:   string;
  notionPageId?:  string;

  // Metadata
  confidence:     number;          // 0–100 from sowParser
}

type EngagementStatus = 'ACTIVE' | 'UPCOMING' | 'ENDED' | 'PROJECTED';
```

**Cash flow integration**: `totalRevenue` × `durationMonths` feeds directly into `FinancialModel.cashTimeline`.

---

## 5. AvailabilityState

This is the most operationally critical container. It drives the bench banner, nudge system, outreach urgency, and network broadcast.

```typescript
AvailabilityState {
  id:            string;
  status:        AvailabilityStatus;

  // Key dates
  availableFrom: ISO8601;          // When free — computed from last Engagement.endDate
  noticePeriod:  number;           // Days — contractual notice required
  bookingHorizon: number;          // Days in advance typically booked (learned from history)

  // Urgency score (0–100)
  // 0 = booked 12 months out; 100 = bench today, no prospects
  urgencyScore:  number;

  // Computed flags
  isOnBench:     boolean;          // availableFrom <= today
  daysUntilFree: number;           // negative = already free
  benchDays:     number;           // days already spent on bench this cycle

  // State machine transitions
  previousStatus: AvailabilityStatus;
  statusChangedAt: ISO8601;
}

type AvailabilityStatus =
  | 'ACTIVE'           // On a contract, > 60 days remaining
  | 'NOTICE_PERIOD'    // On contract, < 30 days remaining — start outreach NOW
  | 'AVAILABLE_NOW'    // Free, actively searching
  | 'INTERVIEWING'     // Free, in active conversations
  | 'STARTING_SOON';   // Contract signed, starting within 30 days

// State machine transitions
const TRANSITIONS = {
  ACTIVE:         ['NOTICE_PERIOD'],
  NOTICE_PERIOD:  ['ACTIVE', 'AVAILABLE_NOW'],
  AVAILABLE_NOW:  ['INTERVIEWING', 'STARTING_SOON'],
  INTERVIEWING:   ['AVAILABLE_NOW', 'STARTING_SOON'],
  STARTING_SOON:  ['ACTIVE'],
};
```

**Signal amplification**: When `urgencyScore > 70`, the OutreachQueue auto-prioritizes HOT signals. When `isOnBench` for > 14 days, the system sends progressively stronger nudges and increases signal refresh frequency.

---

## 6. FinancialModel

The cash reality. Not estimates — actual computed projections from confirmed engagements + configured rates.

```typescript
FinancialModel {
  // Config (from onboarding)
  monthlyBurn:     number;         // Fixed costs
  vatRate:         number;         // 0.21
  taxReserveRate:  number;         // 0.35
  savingsBuffer:   number;         // Target safety net
  utilisationRate: number;         // 0.75

  // Computed timeline (12 months rolling)
  cashTimeline:    CashMonth[];

  // Aggregates
  annualGross?:    number;
  annualNet?:      number;
  runwayMonths:    number;         // months of burn coverable by current savings
  breakEvenRate:   number;         // minimum hourly rate to cover burn
}

CashMonth {
  year:          number;
  month:         number;           // 1–12
  label:         string;           // "Mar 2026"
  type:          MonthType;

  // Revenue
  grossRevenue:  number;
  vatCollected:  number;
  taxReserve:    number;
  netRevenue:    number;           // gross − vat − tax

  // Costs
  burn:          number;

  // Outcome
  netCashflow:   number;           // netRevenue − burn
  cumulativeCash: number;          // running total
  status:        'SURPLUS' | 'DEFICIT' | 'BREAKEVEN';

  // Source
  engagementRef?: string;          // FK → Engagement.id if from confirmed contract
  isProjected:   boolean;         // true = based on rate × hours assumption
  isBench:       boolean;         // true = no revenue, only burn
}

type MonthType = 'CONFIRMED' | 'PROJECTED' | 'BENCH' | 'PARTIAL';
```

---

## 7. ContactNode[]

The network graph. Every person encountered through engagements + outreach.

```typescript
ContactNode {
  id:            string;
  name:          string;
  title?:        string;
  company?:      string;
  email?:        string;
  linkedInUrl?:  string;

  // Relationship
  relationshipType: RelationshipType;
  strength:      RelationshipStrength;

  // Skills overlap with YOUR profile (drives referral probability)
  skillOverlap:  string[];         // SkillNode.name[]
  overlapScore:  number;           // 0–100 Jaccard similarity

  // Engagement history
  metAt:         string[];         // Engagement.id[] — contracts worked together
  lastContact:   ISO8601;
  contactCount:  number;

  // Network intelligence
  companySignals: string[];        // SignalFeed.id[] — signals from their company
  isDecisionMaker: boolean;        // CxO, VP, Director = true
  hiringPower:   boolean;          // Known to hire contractors
}

type RelationshipType = 'CLIENT' | 'COLLEAGUE' | 'RECRUITER' | 'REFERRER' | 'PROSPECT';
type RelationshipStrength = 'STRONG' | 'MEDIUM' | 'WEAK' | 'COLD';
```

**Network effect flywheel**: As Engagements grow, ContactNode[] grows. As ContactNode[] grows, the overlap calculation improves. When you share availability with contacts who have `hiringPower`, referral conversion rates increase non-linearly.

---

## 8. SignalFeed[]

Market intelligence events scored against your profile. The scoring function is the core IP of the system.

```typescript
SignalFeed {
  id:            string;
  type:          SignalType;
  tier:          SignalTier;        // HOT | WARM | MONITOR | COLD

  // Content
  title:         string;
  summary:       string;
  source:        string;
  link?:         string;
  publishedAt:   ISO8601;

  // Scoring
  score:         number;           // 0–100 composite
  scoreBreakdown: ScoreComponent[];

  // Relevance links
  matchedSkills:    string[];       // SkillNode.id[] that triggered this signal
  matchedIndustries: string[];
  matchedCompany?:  string;
  urgencySignal?:   string;

  // Freshness
  discoveredAt:  ISO8601;
  expiresAt:     ISO8601;          // HOT = 72h, WARM = 7d, MONITOR = 30d
}

ScoreComponent {
  dimension: 'skill_match' | 'industry_match' | 'seniority_match'
           | 'urgency_indicator' | 'company_size' | 'network_proximity';
  weight:    number;               // relative weight in composite
  score:     number;               // 0–100 for this dimension
}

type SignalType = 'Leadership change' | 'Funding round' | 'Tech/vendor purchase'
               | 'Regulatory deadline' | 'Ad spend spike' | 'Job posting' | 'Company news';
type SignalTier = 'HOT' | 'WARM' | 'MONITOR' | 'COLD';

// Tier thresholds
const TIER_THRESHOLDS = { HOT: 70, WARM: 40, MONITOR: 20, COLD: 0 };
```

---

## 9. OutreachTarget[]

The actionable pipeline — companies + contacts ranked by signal × profile match. This is the output of the entire system: "who should I contact, why, and what should I say?"

```typescript
OutreachTarget {
  id:            string;
  company:       string;
  contactRef?:   string;           // FK → ContactNode.id if known contact exists
  signalRefs:    string[];         // FK → SignalFeed.id[] that triggered this target

  // Composite priority score
  priorityScore: number;           // 0–100
  scoreFactors: {
    signalStrength:    number;     // avg signal score × count
    profileMatch:      number;     // skill + industry overlap
    networkProximity:  number;     // 0 = cold, 100 = worked with hiring manager
    availabilityUrgency: number;   // urgencyScore from AvailabilityState
    recency:           number;     // how fresh the trigger signal is
  };

  // AI-drafted outreach context
  outreachContext: {
    why:        string;            // "DORA deadline + your RegTech PM background"
    hook:       string;            // "You led DORA gap assessments at Rabobank..."
    cta:        string;            // "15-min call to discuss your Q2 compliance roadmap"
    channel:    'LinkedIn' | 'Email' | 'Referral' | 'Phone';
  };

  // Status tracking
  status:        OutreachStatus;
  lastAction?:   OutreachAction;
  nextAction?:   OutreachAction;

  // Timeline
  createdAt:     ISO8601;
  updatedAt:     ISO8601;
}

type OutreachStatus = 'NEW' | 'DRAFTED' | 'SENT' | 'REPLIED' | 'MEETING' | 'PROPOSAL' | 'WON' | 'LOST' | 'SNOOZED';

OutreachAction {
  type:  'Email sent' | 'LinkedIn connected' | 'Call booked' | 'Proposal sent' | 'Follow-up';
  date:  ISO8601;
  notes: string;
}
```

---

## Network Effect Flywheel

```
         ┌─────────────────────────────────────────────────┐
         │                                                 │
    IdentityTuple                                    OutreachTarget
    + SkillNodes                                          │
         │                                          Win contract
         ▼                                                 │
    SignalFeed ──(score)──► OutreachTarget           New Engagement
    (market intel)                │                       │
         ▲                   Contact Made            New SkillNode
         │                        │                  (evidenced)
    Better signals           ContactNode                  │
    (more skill nodes        (grows network)         Rate increases
     = better filters)             │                 (market data)
         │                   Referral loop                 │
         └───────────────── Shared availability ◄──────────┘
                            (friend-of-friend
                             referrals multiply)
```

The flywheel accelerates because:
1. More engagements → more evidence for SkillNodes → MASTER-level signals hit harder
2. More contacts → more network proximity scores → outreach warms up faster
3. More rate data → better benchmark calibration → you charge correctly
4. Shorter bench gaps → higher lifetime earnings → higher buffer → less panic pricing

---

## Storage Architecture

```
Zero-key store (nexus-store.json)       Notion (async sync, optional)
─────────────────────────────────       ──────────────────────────────
S.cfg           → IdentityTuple         DB_PROFILE   → IdentityTuple rows
S.contracts     → Engagement[]          DB_PIPELINE  → Engagement rows
S.profile       → SearchProfile         DB_CONTACTS  → ContactNode rows
S.signals       → SignalFeed[]          (signals are ephemeral — not synced)
S.outreach      → OutreachTarget[]
S.availability  → AvailabilityState
```

All reads are from local store (fast, offline-capable). Notion writes are fire-and-forget async.

---

## Scoring Formula Reference

### Signal Score
```
score = Σ(dimension_weight × dimension_score) / Σ(weights)

Weights:
  skill_match:        0.35
  industry_match:     0.25
  urgency_indicator:  0.20
  seniority_match:    0.10
  network_proximity:  0.10

Skill match bonus: × PROFICIENCY_WEIGHT[skill.proficiency]
```

### Outreach Priority Score
```
priorityScore = (
  0.30 × signalStrength +
  0.25 × profileMatch +
  0.20 × networkProximity +
  0.15 × availabilityUrgency +
  0.10 × recency
)
```

### Availability Urgency Score
```
urgencyScore = clamp(
  (bench_days × 3) +          // 3 pts per bench day
  (60 - daysUntilFree) × 0.5  // increases as contract end approaches
, 0, 100)
```

---

*Generated: 2026-03-07 | Version: 1.0 | Nexus Live*
