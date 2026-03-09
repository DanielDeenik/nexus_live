# Nexus Live — Customer Journey Map
**Date:** March 2026 | **Source:** Meeting transcript (Dan Deenik × Joseph Massaud, Mar 7 2026) + Brainstormer session + product build context
**Skill:** Customer Journey Map

---

## PERSONA

### "The Financially Stressed Senior Freelancer"

> *"I'm good at my work. I'm bad at knowing whether I can afford to take a holiday."*

| Attribute | Detail |
|-----------|--------|
| **Name** | Daniel / Joseph (composite — both are the ICP) |
| **Role** | Senior independent consultant — SimCorp, FinTech, Data Architecture, Product |
| **Location** | Netherlands / Denmark / Belgium |
| **Billing** | €800–€1,100/day; waiting 30–60 days for first paycheck |
| **Tools** | Notion, LinkedIn, Claude, GPT, Excel (reluctantly) |
| **Life context** | Considering international relocation (Mallorca, Spain); thinking about sabbaticals; having children; building passive income on the side |
| **Financial behaviour** | "Aware but reactive" — knows the numbers matter, checks them irregularly |
| **Current workaround** | Spreadsheets that get stale; mental math; accountant who tells them last year's news |

**Primary JTBD:**
> *"I need to know whether I can afford to make a major life decision (take leave, move abroad, say no to a bad contract) without risking my financial safety net."*

**Secondary JTBDs:**
- Know when to push hard for new contracts vs. take it easy
- Reserve exactly the right amount for Dutch VAT + income tax (avoid shock Q1 bill)
- Bypass recruiter gatekeeping to find who is actually hiring and has budget
- Stop spending mental energy on financial anxiety

---

## JOURNEY OVERVIEW

```
TRIGGER → AWARENESS → CONSIDERATION → ONBOARDING → ENGAGEMENT → HABIT → ADVOCACY
 Pain       Discover    Evaluate        First value   Weekly use   AI-guided  Refers peers
                                       in <90 sec    & alerts     decisions
```

---

## STAGE 1 — TRIGGER (The Moment Before Awareness)

> *The emotional context that makes someone receptive to a solution*

### What just happened to them?

| Trigger Event | Emotional State | Quote |
|--------------|----------------|-------|
| **Received a shock tax bill in March/April** | 😰 Anxiety, regret | "I should have set more aside. I do this every year." |
| **Missed a contract window because they didn't know it was coming** | 😤 Frustration | "If I'd known that client was hiring in January I wouldn't have taken that December short-term job." |
| **Considering a life decision (sabbatical, baby, relocation)** | 😕 Uncertainty | "I want to move to Mallorca but I genuinely don't know if I can afford it." |
| **Finished a project, now anxious about pipeline** | 😟 Fear | "I'm waiting for my first paycheck mid-March. I hate this feeling every year." |
| **A recruiter gives them incomplete or misleading market intel** | 😠 Distrust | "Recruiters hold all the information and use it as leverage. I'm sick of it." |

**Insight from meeting (Daniel, 00:02:21):**
> *"I'm currently awaiting my first paycheck for the year in mid-March — this is a stress point that repeats every year."*

---

## STAGE 2 — AWARENESS

> *How do they first discover Nexus Live?*

### Touchpoints

| Channel | How | Likelihood |
|---------|-----|-----------|
| **LinkedIn content (founder-led)** | Dan posts about building Nexus as a ZZP'er financial OS — "building in public" | ⭐⭐⭐ High |
| **Word of mouth from peer freelancers** | Joseph tells a peer; they try it during testing | ⭐⭐⭐ High |
| **Notion template gallery** | "Cashflow template for ZZP'ers" indexed in gallery | ⭐⭐ Medium |
| **SEO: "cashflow overzicht zzp"** | Long-tail Dutch search intent | ⭐⭐ Medium |
| **Dutch freelancer communities (Slack, forums)** | Someone shares the tool after a discussion about tax surprises | ⭐⭐ Medium |
| **ProductHunt** | Launch moment | ⭐ Low (niche audience) |

### User Actions
- Sees a LinkedIn post about a freelancer avoiding a tax surprise using Nexus
- Clicks through to the landing page / GitHub / direct app URL
- Skims the homepage in < 10 seconds

### Thoughts & Questions
- *"Is this actually different from a spreadsheet?"*
- *"Will this require me to manually enter everything?"*
- *"Does this work with Notion? I already have my contracts there."*
- *"How much does this cost?"*

### Emotions
😐 Curious but sceptical — they've been burned by "financial tools" before

### Pain Points
- **No clear landing page** articulating the value in < 5 words (current: GitHub README / localhost URL)
- **"Financial OS" positioning is abstract** — doesn't answer "what will I see in 60 seconds?"
- **No social proof** — no testimonials, no user count, no "used by X freelancers"

### Opportunities
- ✅ Lead with the outcome, not the feature: *"See your runway in 60 seconds"*
- ✅ Show a screenshot of the dashboard as the hero image — let them see the output before signing up
- ✅ Use the meeting transcript insight: *"The Swiss contract I nearly took — Nexus showed me it was a bad deal before I signed"* as a testimonial hook

---

## STAGE 3 — CONSIDERATION

> *What do they evaluate? What would make them leave?*

### Touchpoints
- App homepage / demo
- Comparison with alternatives: Moneybird, YNAB, their existing spreadsheet
- Checking if Notion integration is real (or marketing)
- LinkedIn profile of the founder (trust check)

### User Actions
- Reads the top of the page quickly (< 15 seconds)
- Asks: "Do I need Notion for this?"
- Checks if there's a free tier
- Looks for privacy policy (GDPR awareness)

### Thoughts & Questions
- *"I already use Moneybird for invoicing. Do I need another tool?"*
- *"I'd have to set up a Notion workspace just for this?"*
- *"Is my financial data going to some server I don't control?"*
- *"If the founder stops maintaining this, do I lose all my data?"*

### Emotions
🤔 Evaluating carefully — high mental model overhead for anything financial

### Pain Points
- **Notion dependency as a barrier**: Non-Notion users bounce immediately
- **No comparison page**: Users can't see how Nexus differs from Moneybird, YNAB, or a spreadsheet
- **GDPR concern**: No visible data handling statement in onboarding
- **Pricing uncertainty**: "Is this free? For how long?"

### Opportunities
- ✅ Add a "Do I need Notion?" FAQ — answer: "Yes, but a free account takes 2 minutes to set up and you already own your data"
- ✅ Show a simple comparison: *"Moneybird tells you what happened. Nexus tells you what's coming."*
- ✅ State clearly: *"Your data lives in YOUR Notion workspace. We never store it."* — this is a genuine differentiator

---

## STAGE 4 — ONBOARDING (Aha Moment)

> *First experience — the most critical 3 minutes*
> **Target: User sees their runway number in < 90 seconds**

### Current Flow (post-rebuild)
```
Step 0: LinkedIn connect  →  Step 1: Name + Rate + Burn  →  Step 2: Seasonality  →  Dashboard
```

### Touchpoints
- LinkedIn OAuth popup
- Onboarding wizard (3 steps)
- Live forecast preview panel (right side of wizard)
- Dashboard first load

### User Actions
- Clicks "Continue with LinkedIn" or "Skip — I'll enter manually"
- Types in their hourly rate (first meaningful interaction)
- Watches the right panel update live as they type
- Sees their runway number and monthly surplus breakdown
- Clicks "See your forecast →"
- Lands on Dashboard with AI nudge

### Thoughts & Questions
- *"Oh — it's showing me a number as I type. That's clever."*
- *"4.7 months runway... is that good? What does that mean?"*
- *"It's telling me July is historically slow — how does it know that?"*
- *"What do I do now?"*

### 🌟 Aha Moment
> **User types their rate and sees "∞ months runway" or a specific number update in real-time — before they've finished setup.**
> This is the moment the product stops being a form and starts being a tool.

**From meeting (Daniel, 00:03:25):**
> *"The app is designed to forecast payments based on the statement of work and current holdings, allowing users to make financial decisions, such as saving for future contracts."*

### Emotions
😮 Surprise → 😀 Delight (if the number makes sense)
😕 Confusion (if they don't understand what "VAT provision" means)

### Pain Points
- **Financial terminology barrier**: "VAT provision", "tax reserve", "utilisation" — jargon that non-accountants don't parse immediately
- **Rate confusion**: Day rate vs. hourly rate — some freelancers think in projects, not hours
- **Carry-over bug**: Hours/week field value not persisting correctly from step 1 → step 3 (known bug)
- **Empty state after onboarding**: If Notion databases aren't shared, all cards show "—" and €0 — feels broken
- **No "what do I do next?" prompt**: User lands on dashboard but doesn't know how to use it

### Opportunities
- ✅ Add tooltip: "How is this calculated?" → shows rate × hours × utilisation formula in plain English
- ✅ Fix carry-over bug (hours field)
- ✅ Add an onboarding completion checklist: "Connect Notion → Enter rate ✓ → Add your first contract → Invite a peer"
- ✅ Show an "empty state" nudge: "Your Notion databases aren't shared yet. [Follow these 3 steps →]"

---

## STAGE 5 — ENGAGEMENT (Week 1–4)

> *Building the habit of checking Nexus weekly*

### Core Engagement Loop (from product logic)
```
Profile updated → applyProfileToForecast() fires → AI nudge generated → User acts (outreach, save, adjust rate)
```

### Touchpoints
- Dashboard (weekly check-in)
- Forecast page (deep dive before a big decision)
- Pipeline (adding a new contract)
- Settings (adjusting rate after contract negotiation)
- Email alert (future: "Weekly Financial Briefing")

### User Actions
- Checks runway number weekly
- Updates burn rate when a big expense lands
- Adds a new contract to Notion → sees forecast update
- Uses "What If?" comparator before accepting a rate

### Thoughts & Questions
- *"My contract ends in 6 weeks. Should I start outreach now or is it too early?"*
- *"I want to take a week off in August. Can I afford it?"*
- *"This rate offer is lower than my usual. Is it still worth it?"*

### 🌟 Critical Engagement Moment
> **User uses the What-If comparator (Rate A vs Rate B) and makes a real contract decision based on it.**
> This is when Nexus becomes a trusted advisor, not just a dashboard.

**From meeting (Daniel, 00:08:11):**
> *"By importing the contract and simulating the suggested pathway and cash flow, Daniel Deenik realised the offer was less favourable than they had initially thought."*
> (The Swiss contract scenario — Nexus prevented a bad financial decision)

### Emotions
😌 Relief when runway looks healthy
😟 Anxiety when a slow month is flagged
💡 Confidence when the What-If comparison gives a clear answer

### Pain Points
- **No push mechanism**: Users forget to check without prompts
- **No "life event" overlay** yet: Can't ask "Can I afford a 2-month sabbatical starting in August?" directly
- **Contract pipeline not connected to forecast**: Forecast is profile-based, not contract-based
- **No benchmarking**: "Is my €110/hr rate competitive right now?" — no answer

### Opportunities
- ✅ **Weekly email briefing**: "This week: runway 6.2 months, Jul looks tight, one action for this week"
- ✅ **Life Event Overlay** (from Brainstormer session): "Can I...?" → Traffic light answer (Green/Yellow/Red)
- ✅ **Contract-to-forecast sync**: When active contracts exist in Notion, replace profile estimate with contract income
- ✅ **Seasonal alert**: "July is 6 weeks away — start outreach now to avoid a cashflow dip"

---

## STAGE 6 — RETENTION (Month 2–6)

> *What brings them back? What causes churn?*

### Retention Drivers
| Driver | Mechanism |
|--------|-----------|
| **Life event planning** | User has a real decision coming (sabbatical, relocation, contract renewal) — Nexus is the tool they use to model it |
| **Seasonal anchoring** | The app reminds them in advance of their known slow periods — creates a "pre-season ritual" |
| **Tax reserve tracker** | As Q1 (NL tax payment) approaches, Nexus becomes essential — high urgency, high retention |
| **Habit of weekly check-in** | If the weekly briefing email is opened 3+ times, it becomes a routine |

### Churn Triggers
| Trigger | Root Cause | Mitigation |
|---------|-----------|------------|
| **"The numbers are wrong"** | Profile-based forecast diverges from actuals (no real contract data) | Contract-to-forecast sync (Priority 3 feature) |
| **"I stopped using Notion"** | Notion dependency is a single point of failure | Fallback to local config that persists without Notion |
| **"I haven't checked in 3 weeks"** | No push mechanism → habit breaks | Weekly briefing email |
| **"My accountant does this"** | Value not differentiated from reactive accountant tools | Lead with "forward-looking" positioning — accountants tell you the past; Nexus tells you the future |
| **"I got a new contract and don't need to worry"** | Engaged only during anxiety; disengages during prosperity | Reframe for prosperous users: "You have surplus — here's how to deploy it" |

---

## STAGE 7 — ADVOCACY

> *When and why do they refer others?*

### Trigger for Referral (from meeting transcript)
**Joseph Massaud is literally the first beta tester — recruited organically from Dan's professional network.**
> *"Joseph Massaud agreed to test the system."*
> *"Daniel Deenik plans to share the code so Joseph Massaud can begin their own forecasting and testing."*

This is the natural advocacy pattern: **a peer freelancer sees another managing their finances with confidence and asks "how are you doing that?"**

### Referral Moments
| Moment | Mechanic |
|--------|----------|
| **After avoiding a bad contract** | "I was going to take that role in Switzerland. Nexus showed me it wasn't worth it. Happy to show you." |
| **After a tax payment that wasn't a surprise** | "I had exactly the right amount set aside. My accountant was amazed." |
| **After making a life decision with confidence** | "I used it to plan my move to Mallorca. You should try it." |
| **When discussing recruiter frustration in a community** | "I bypass recruiters now — this tool shows me who's hiring before they post a JD." (future: Market Intelligence feature) |

### Opportunities
- ✅ **"Share your dashboard"** feature: anonymised runway + seasonal chart shareable as a screenshot
- ✅ **Give-to-Get intel model** (Brainstormer session): Users contribute market data (rate pins, budget status) in exchange for seeing aggregated community data — creates advocacy through participation
- ✅ **Referral mechanic**: "Invite a fellow freelancer → they get 1 month Pro free, you get 1 month Pro free"
- ✅ **"Joseph onboarding" user test**: Use Joseph's testing as a formal usability session — document the friction points for non-tech-savvy users (Dan's ex-wife archetype)

---

## CRITICAL MOMENTS SUMMARY

| Moment | Stage | Description | Current State |
|--------|-------|-------------|--------------|
| ⭐ **Aha Moment** | Onboarding | Typing rate → seeing runway number update live | ✅ Built |
| ⚡ **Moment of Truth 1** | Consideration | "Does this work without a Notion account?" | ❌ No clear answer on landing |
| ⚡ **Moment of Truth 2** | Onboarding Step 2 | "Do the numbers make sense?" (terminology) | ⚠️ Partial — needs tooltips |
| ⚡ **Moment of Truth 3** | Week 2 | "Is this more accurate than my spreadsheet?" | ❌ Not yet — needs contract sync |
| 🔥 **Churn Trigger** | Month 2 | Forecast diverges from actuals → distrust | ⚠️ Risk — contract sync needed |
| 🚀 **Advocacy Trigger** | Month 3+ | Made a real financial decision using Nexus | ✅ Swiss contract story = proof |

---

## FUTURE JOURNEY EXTENSION: "WAZE FOR FREELANCERS"

*From the meeting and Brainstormer session — the full product vision beyond cashflow*

### The Extended Journey (V2+)

```
CASHFLOW CLARITY  →  MARKET INTELLIGENCE  →  AUTONOMOUS OUTREACH  →  NETWORK EFFECT
(Current build)       (Independent AI         (Ghost Agent —          (Give-to-Get
                       research engine)         with human approval)    Heatmap)
```

### New Journey Stage: Market Intelligence Engagement

| Stage | User Action | Emotion | Nexus Action |
|-------|------------|---------|--------------|
| **Slow period approaching** | Checks forecast, sees July dip | 😟 Anxious | Fires "start outreach now" alert + shows market signals |
| **AI finds a signal** | Views "DORA compliance deadline: banks need data architects" | 😮 Surprised | AI flags 3 companies matching user's profile as warm targets |
| **Bypasses recruiter** | AI drafts a direct-to-hiring-manager outreach | 😀 Empowered | User reviews and approves with one click |
| **Contract secured** | Updates Nexus with new contract | 😌 Relief | Forecast auto-updates; runway extends |

**Key insight from meeting (Daniel, 00:09:15):**
> *"If freelancers did not have this stress, they would need fewer consultancies. The app offers a dynamic approach to market conditions, which consultancies typically leverage to maintain their competitive advantage."*

This is the product's real long-term disruption: **making the recruiter's information asymmetry advantage obsolete.**

### Leading Indicators to Track (before job postings appear)

From the Brainstormer session — data points the AI research engine should monitor:

| Signal | Leading Indicator | Time Before Posting |
|--------|-----------------|-------------------|
| Ad spend spike | 400%+ increase on Google/Meta → backend scaling needed | 30–60 days |
| Enterprise software purchase | Company adopts SimCorp/Snowflake → implementation needed immediately | 0–30 days |
| New C-suite hire | New CTO/Head of Data starts → 90-day new vision initiative | 0–14 days |
| Regulatory deadline | DORA, ESG reporting mandates approaching for banks | 60–180 days |
| Funding announcement | Series B/C closed → headcount expansion incoming | 14–45 days |

---

## RECOMMENDED IMPROVEMENTS (Prioritised)

### 🔴 P0 — Fix Now (Onboarding drop-off risk)
1. **Add "How is this calculated?" tooltips** on VAT provision, tax reserve, runway number
2. **Fix hours carry-over bug** (Step 2 → Step 3 in wizard)
3. **Add empty state guidance**: "Your Notion databases aren't connected yet. Here's how →"
4. **Clarify "Day Rate vs Hourly Rate"** with a single inline example

### 🟡 P1 — High Impact (Engagement + Retention)
5. **Weekly Financial Briefing email**: Plain-text, 5 sentences, one action item — sent Monday morning
6. **"Can I afford to...?" Life Event Tester**: Traffic light (Green/Yellow/Red) for sabbatical, relocation, leave decisions (Brainstormer idea 3)
7. **Seasonal Outreach Alert**: "July is 6 weeks away — start outreach now" fired automatically
8. **Contract-to-Forecast sync**: Replace profile estimate with actual Notion contract data for active months

### 🟢 P2 — Growth (Advocacy + Network Effect)
9. **Give-to-Get Market Heatmap MVP**: Allow users to pin 3 data types (rate, payment speed, budget status) on a company; unlock community data in exchange
10. **Independent AI Research Engine**: Monitor ad spend changes, tech stack adoption, leadership changes at target companies
11. **Referral mechanic**: "Invite a freelancer → both get 1 month Pro free"
12. **Joseph onboarding test**: Formal usability session with a non-tech-savvy user to validate Step 2 terminology

---

## VISUAL MAP SUGGESTION

*For Miro / FigJam implementation:*

Use 7 swim lanes:
1. **Journey Stage** (top row, coloured headers)
2. **User Actions** (what they do)
3. **Thoughts & Questions** (speech bubbles)
4. **Emotions** (emoji + line graph showing emotional arc)
5. **Touchpoints** (app screens, email, community)
6. **Pain Points** (red sticky notes)
7. **Opportunities** (green sticky notes)

Emotional arc shape: Starts anxious (Trigger) → curious (Awareness) → evaluating (Consideration) → delighted (Aha Moment at Step 1 of wizard) → confident (Week 2 What-If decision) → routine (Month 2+) → advocacy (post-Swiss-contract-story)

---

*Generated using: Customer Journey Map skill | Source: Meeting transcript Dan × Joseph (Mar 7, 2026) + Brainstormer session + Nexus Live v5.2.x product context*
