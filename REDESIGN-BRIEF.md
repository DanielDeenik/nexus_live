# Nexus Live — Redesign Brief
**Framework: First Principles + Feature Request Analysis + Assumption Identification**
*Generated March 2026*

---

## 1. The Single Question This App Must Answer

> **"Will I have enough money next month — and what should I do about it today?"**

Every feature that doesn't directly answer that question is noise. This is the North Star for the redesign.

---

## 2. Feature Request Analysis (Dan Olsen — Opportunity Score Framework)

### Current Navigation Inventory (11 pages + 5 wizard steps + 3 sub-navs)

| Feature | User Job-to-be-Done | Importance (1–5) | Satisfaction (1–5) | Opportunity Score |
|---|---|---|---|---|
| Command Center | "Show me where I stand right now" | 5 | 3 | **0.40** ← High |
| Forecast (cashflow chart) | "Will I have money next quarter?" | 5 | 2 | **0.60** ← Highest |
| Seasonality overlay | "When should I push for work?" | 4 | 2 | **0.53** ← High |
| Scenario Planner | "Should I take this contract?" | 4 | 3 | **0.32** ← Medium |
| Contracts | "What am I committed to?" | 4 | 3 | **0.32** ← Medium |
| Onboarding Wizard | "Get me set up fast" | 5 | 1 | **0.67** ← Highest |
| Profile & Rates | "Update my numbers" | 3 | 4 | **0.15** ← Low |
| Market Radar | "What's happening in my market?" | 3 | 2 | **0.40** ← Medium |
| Live Feed | "Show me live jobs" | 2 | 2 | **0.40** ← Low priority |
| Role Simulator | "Compare two rate options" | 3 | 3 | **0.30** ← Low |
| Wet DBA | "Am I legally compliant?" | 2 | 3 | **0.27** ← Niche |
| AI Advisor | "Tell me what to do" | 4 | 2 | **0.53** ← High |
| DB Status | "Is my Notion connected?" | 1 | 1 | **0.50** ← Technical debt |

### Top 3 Opportunities (by score × reach)

**#1 — Onboarding (Score: 0.67)**
The wizard is 5 steps but users are dropping before they get value. Every step without a visible payoff is a lost user.
- *Root problem*: No preview of what they'll get — users don't know why they're entering their rate
- *Alternative*: Show the forecast chart (even with dummy data) before they enter anything. "This is what your dashboard will look like" motivates completion.
- *Key assumption to test*: Will users complete setup if they see the output first?

**#2 — Cashflow Forecast (Score: 0.60)**
The most important feature is buried 2 clicks in, behind a sidebar item, with 3 sub-tabs, and no clear entry-point explanation.
- *Root problem*: Too much UI around the chart obscures the signal
- *Alternative*: Make the forecast the homepage. One number: projected runway. One chart: 6-month outlook. One action: "Add a contract."
- *Key assumption to test*: Does a single runway number + chart cause users to take action?

**#3 — AI Advisor (Score: 0.53)**
Users want guidance, not just data. The AI Advisor is a separate page — but advice is most valuable in context, not in isolation.
- *Root problem*: Advice is separated from the data it refers to
- *Alternative*: Inline AI nudges on the forecast page. "Your August looks thin — here's why and what to do."
- *Key assumption to test*: Do contextual tips increase engagement vs. a dedicated AI page?

---

## 3. Assumption Identification — 8 Risk Categories

### Product: Nexus Live — Freelancer Financial OS

#### VALUE RISKS
| Assumption | Confidence | Test |
|---|---|---|
| Freelancers check their financial position regularly enough to return to an app | Low | Track D7/D30 retention in beta |
| A cashflow forecast is more useful than a simple "months of runway" counter | Medium | A/B test simple runway number vs. full chart |
| LinkedIn profile data is accurate enough to seed a useful forecast | Medium | Measure % of users who correct auto-filled data |
| Industry seasonality data is relevant to individual freelancers | Low | Ask 5 users: "Does this match your experience?" |

#### USABILITY RISKS
| Assumption | Confidence | Test |
|---|---|---|
| Non-technical users understand what "net cashflow" means | Low | Usability test with 3 non-finance freelancers |
| 5-step wizard doesn't cause drop-off before first value moment | Low | Instrument each step, measure completion rate |
| Users can connect Notion without IT help | Medium | Observe 3 users doing setup unassisted |
| The forecast chart communicates urgency without explanation | Low | Show chart with no labels, ask "what does this tell you?" |

#### VIABILITY RISKS
| Assumption | Confidence | Test |
|---|---|---|
| Freelancers will pay for financial clarity (vs. using a spreadsheet) | Low | Pre-sell 10 subscriptions before building more |
| Notion as a backend is not a dealbreaker for users who don't use Notion | Low | Survey: "Would you use this if it required a free Notion account?" |
| Monthly burn is high enough to justify premium pricing | Unknown | Build cost model: Notion API + server + support |

#### FEASIBILITY RISKS
| Assumption | Confidence | Test |
|---|---|---|
| LinkedIn OAuth returns enough data to meaningfully pre-fill forecast | Medium | Test with 20 profiles: what % have rate/industry data? |
| CV parsing is accurate enough across professions to be useful | Low | Test with 20 diverse CVs, measure accuracy |
| Notion API is fast enough for real-time dashboard use | Medium | Measure P95 load time under real conditions |

#### ETHICS RISKS
| Assumption | Confidence | Test |
|---|---|---|
| Users understand what data is sent to LinkedIn / stored in Notion | Low | Show data flow diagram in onboarding and measure trust |
| Financial projections don't create false confidence that harms users | Medium | Add confidence intervals + "this is an estimate" labels |
| CV/LinkedIn data isn't used beyond the stated purpose | High | Privacy policy + no server-side storage of OAuth tokens |

#### GO-TO-MARKET RISKS
| Assumption | Confidence | Test |
|---|---|---|
| Freelancers discover financial tools via LinkedIn/ProductHunt | Low | Run 3 different acquisition channel tests |
| "Freelancer OS" messaging resonates vs. "cashflow app" | Unknown | Test 3 landing page headlines, measure conversion |
| Word-of-mouth is a viable acquisition channel (freelancers refer peers) | Low | Add referral tracking from day 1 |
| Netherlands/EU is the right beachhead market | Medium | Check where sign-ups come from without targeting |

#### STRATEGY RISKS
| Assumption | Confidence | Test |
|---|---|---|
| Notion as a backend is a moat, not a liability | Low | Monitor % of target users who already use Notion |
| The app's value doesn't erode as Notion adds native forecasting | Low | Check Notion's roadmap quarterly |
| A single-person freelancer OS is more defensible than a team tool | Unknown | Define ICP and stick to it for 6 months |

#### TEAM RISKS
| Assumption | Confidence | Test |
|---|---|---|
| A solopreneur can build + maintain + support this product | Low | Define ruthless scope boundaries before expanding |
| Daniel can get to first paying customer without additional engineering help | Medium | Set 30-day milestone: 1 paid user via self-service |

---

## 4. First Principles Redesign

### The Problem with the Current Design

Applying **Hick's Law** (decision time doubles per option) and **Miller's Law** (7±2 working memory slots):

- **11 nav items** = user doesn't know where to start
- **162 interactive elements** across pages = cognitive overload
- **3 sub-navs within Forecast alone** = key page is too complex
- **DB Status as a nav item** = exposes infrastructure to users who just want financial answers

### Simplified Information Architecture

```
BEFORE (11 pages):
├── 🎯 Command Center
├── 📊 Forecast
├── ⚖️ Wet DBA
├── 🌐 Market Radar
├── 🤖 AI Advisor
├── 📄 Contracts
├── ⚙️ Profile & Rates
├── 🔍 Live Feed
├── 🧮 Simulate
├── 📐 Scenarios
└── 🔌 DB Status

AFTER (4 pages + settings):
├── 📊 Dashboard     → Runway + 6-month forecast (the answer to the core question)
├── 🎯 Pipeline      → Contracts + Scenarios + Market signals (what's coming)
├── 🔮 Forecast      → Full 12-month view + seasonality + AI nudges (deep dive)
└── ⚙️ Settings      → Profile, rates, Notion connection, Wet DBA status badge
```

### Page-by-Page Simplification

#### Dashboard (New Homepage)
**One screen, three numbers:**
1. **Runway** — months of cash at current burn (large, prominent)
2. **This month's outlook** — projected income vs burn, surplus/deficit
3. **Next action** — one AI-generated recommendation ("Contract ends in 6 weeks — start outreach")

Remove: KPI grid, multiple chart types, seasonal overlay toggle, sub-navs

#### Pipeline (Merge: Market Radar + Scenarios + Live Feed)
**The "what's coming" page:**
- Active + upcoming contracts (simple list)
- One scenario comparison (A vs B) — not a full simulator
- Top 3 market signals (curated, not a feed)

Remove: Role Simulator (fold into scenario), full Live Feed (show 3 top results)

#### Forecast (Deep Dive)
**For users who want the full picture:**
- 12-month chart with seasonality overlay
- AI advisor as inline commentary on the chart, not a separate page
- Quarterly VAT/tax reserve summary

Remove: 3 sub-tabs (collapse Intelligence + Pipeline into the main chart as toggleable overlays)

#### Settings
**Everything non-operational:**
- Profile & rates
- Notion connection + DB Status (as a simple ✅/❌ badge, not a full page)
- Wet DBA risk score (as a badge, not a full page — only show if high risk)
- LinkedIn connection

---

## 5. Onboarding Redesign — The "Value First" Principle

**Current flow (5 steps before seeing any value):**
Step 0: LinkedIn → Step 1: Identity → Step 2: Rates → Step 3: Skills → Step 4: Seasonality → Dashboard

**Proposed flow (show value at Step 1):**
Step 0: LinkedIn connect → **Instant forecast preview with their LinkedIn data** → Step 1: "Does this look right? Adjust your rate" → Done

The forecast should render immediately after LinkedIn OAuth with:
- Name + headline from LinkedIn (auto-filled)
- Industry seasonality applied
- A placeholder rate they can confirm or correct
- 12-month outlook visible immediately

**Result**: User sees the output before finishing setup → dramatically higher completion rate.

---

## 6. Prioritized Redesign Roadmap

| Priority | Change | Effort | Impact |
|---|---|---|---|
| 🔴 P0 | Reduce nav from 11 → 4 items | Low (CSS/JS hide) | High — reduces overwhelm immediately |
| 🔴 P0 | Show forecast preview during onboarding | Medium | High — increases wizard completion |
| 🟡 P1 | Move AI Advisor inline to Forecast page | Low | High — advice in context |
| 🟡 P1 | Collapse Forecast 3 sub-tabs → 1 chart + toggles | Medium | Medium — simplifies the key page |
| 🟡 P1 | Merge Simulate + Scenarios → single "What if?" card | Medium | Medium — removes duplication |
| 🟢 P2 | Move Wet DBA → Settings badge | Low | Low risk, removes clutter |
| 🟢 P2 | Remove DB Status from nav → Settings badge | Low | Removes infrastructure noise |
| 🟢 P2 | Rename "Command Center" → "Dashboard" | Trivial | Reduces jargon |

---

## 7. Key Design Principles for the Rebuild

1. **One question per screen** — every page answers exactly one user question
2. **Numbers before charts** — show the answer, then let users explore the data
3. **Progressive disclosure** — advanced features (Wet DBA, DB Status, full scenarios) are available but not in the default path
4. **Contextual AI** — recommendations appear where the data lives, not on a separate page
5. **Mobile-first thinking** — even on desktop, design for a viewport that shows the key number first

---

*Sources: [Dashboard Design Principles — DesignRush](https://www.designrush.com/agency/ui-ux-design/dashboard/trends/dashboard-design-principles) · [Dashboard UI/UX Design Principles 2025 — Medium](https://medium.com/@allclonescript/20-best-dashboard-ui-ux-design-principles-you-need-in-2025-30b661f2f795) · [Effective Dashboard Design — UXPin](https://www.uxpin.com/studio/blog/dashboard-design-principles/) · Assumption framework: Teresa Torres, Continuous Discovery Habits · Opportunity scoring: Dan Olsen, The Lean Product Playbook*
