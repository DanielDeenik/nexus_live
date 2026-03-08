# Nexus Live — Onboarding Feature Request Analysis
**Product Goal**: Minimise time-to-value for a freelancer — get them from zero to a live cash-flow forecast and first outreach target in one sitting, with no missed steps or lost progress.

**Method**: Opportunity Score = Importance × (1 − Satisfaction), 0–1 scale.

---

## 1. Feature Requests Identified (from current UI + first-principles audit)

| # | Request / Observed Pain | Source |
|---|------------------------|--------|
| R1 | Save & resume — onboarding resets if page is closed | UX audit |
| R2 | Skip individual steps without losing prior data | UX audit |
| R3 | Inline validation feedback before proceeding | UX audit |
| R4 | Show what Nexus will do with each input (transparency) | UX audit |
| R5 | Editable profile post-onboarding without re-running all steps | UX audit |
| R6 | Faster path for repeat users — skip to what's missing | UX audit |
| R7 | Mobile-friendly step layout | UX audit |
| R8 | Progress indicator that shows estimated time remaining | UX audit |
| R9 | Connect LinkedIn without leaving the page (popup broken) | Bug report |
| R10 | Import from past Notion contracts rather than re-uploading | Feature request |

---

## 2. Themes

### Theme A — Persistence & Resilience
R1 (save/resume), R6 (fast-path for repeat users)
> Users who close the tab mid-onboard lose all entered data. This is the highest-friction failure mode — a hard restart with zero progress recovery.

### Theme B — Progressive Disclosure
R2 (step skipping), R4 (transparency), R8 (time estimate)
> The 5-step linear flow forces document upload even when users want to enter numbers manually. Users don't know what to expect next, so they abandon early.

### Theme C — Post-Onboarding Editability
R5 (edit without re-running), R10 (import from Notion)
> Once onboarding completes, there's no obvious way to update individual profile sections. Users end up re-running the full flow to change a single field.

### Theme D — Inline Feedback & Validation
R3 (validation), R9 (LinkedIn popup)
> Fields have no live validation. LinkedIn OAuth pops a new window that breaks the flow state. Users don't know if their CV was parsed correctly until Step 2 loads.

### Theme E — Responsive / Accessibility
R7 (mobile layout)
> The modal is fixed at a desktop width. On narrower viewports it overflows and the PIN pad is misaligned.

---

## 3. Opportunity Scores

| Theme | Importance (0–1) | Satisfaction (0–1) | Opportunity Score |
|-------|-----------------|-------------------|-------------------|
| A — Persistence & Resilience | 0.95 | 0.05 | **0.903** |
| B — Progressive Disclosure | 0.85 | 0.15 | **0.723** |
| C — Post-Onboarding Editability | 0.80 | 0.20 | **0.640** |
| D — Inline Feedback & Validation | 0.70 | 0.25 | **0.525** |
| E — Responsive / Accessibility | 0.50 | 0.40 | **0.300** |

---

## 4. Top 3 Prioritised Opportunities

---

### 🥇 #1 — Persistent Onboarding State (Theme A)
**Opportunity Score: 0.903**

**The problem (not the feature)**: A freelancer's onboarding session ends abruptly — laptop closes, phone call arrives — and the next time they open Nexus, they're back at Step 0 with no data. This converts a motivated new user into a churned one.

**Rationale**:
- Highest importance: first-time completion is the only conversion that matters
- Lowest satisfaction: nothing is saved between sessions today
- Fits the zero-key architecture already in place (local `nexus-store.json`)

**Solution direction**:
Save every onboarding step's state to `nexus-store.json` in real time. On next boot, detect incomplete onboarding and resume at the last completed step — showing a "Continue where you left off" card on the login screen.

**Alternative solutions**:
- Auto-save to `localStorage` (simpler, no server round-trip, but survives tab close only)
- Email the user a "resume link" with encoded state (too heavyweight for a local app)

**High-risk assumptions**:
- Assumption: users who partially complete onboarding will return within 24h → test with session analytics
- Assumption: the auto-resume UI won't confuse users who want to start fresh → test with a "Start over" escape hatch

**Minimal test**:
Add one line: `localStorage.setItem('ob_step', S.obStep)` on every step advance, and read it on boot. If users reach Step 4 more often after the change, validate the hypothesis.

---

### 🥈 #2 — Progressive Disclosure (Skip + Time Estimate) (Theme B)
**Opportunity Score: 0.723**

**The problem**: The 5-step linear funnel treats "upload CV + SOW + configure rates + set seasonality" as equally mandatory. Users who just want a cash-flow number hit a document-upload wall and leave.

**Rationale**:
- The "Skip — I'll enter manually" button exists but is visually de-prioritised (ghost style)
- No indication of what each step unlocks ("why am I uploading this?")
- No time estimate ("this takes 4 minutes")

**Solution direction**:
1. Surface an estimated time (e.g. "~3 min") next to the step indicator
2. Make the skip path equally prominent — two equal-weight buttons, not primary/ghost
3. Add a one-liner value prop under each step title: "This lets Nexus predict which companies need you before they post a job"

**Alternative solutions**:
- Wizard-style branching: "Just the numbers? →" / "Full intelligence profile? →" as the very first question
- Remove Step 4 (seasonality) from first-run entirely; surface it later as a "Sharpen your forecast" prompt on the dashboard

**High-risk assumptions**:
- Assumption: users who skip document upload still complete the financial config steps
- Assumption: explaining the "why" increases upload completion rate

**Minimal test**:
A/B test Step 1 subtitle copy: current vs "Nexus reads your CV to find which €150k/day DORA contracts match your background — in seconds." Track upload completion rate.

---

### 🥉 #3 — Post-Onboarding Profile Editability (Theme C)
**Opportunity Score: 0.640**

**The problem**: After onboarding, if a freelancer starts a new contract, changes their rate, or learns a new skill, they have to re-run the entire 5-step flow to update their profile. The Settings page only exposes financial fields — not the skill/industry chips built in Step 2.

**Rationale**:
- A freelancer's profile changes constantly (new contract every 3–6 months)
- Re-running onboarding resets any manual edits made post-confirmation
- The chip UI built in Step 2 (skills, industries, certifications) is not accessible after onboarding

**Solution direction**:
Add a "Profile" tab or modal accessible from the sidebar that shows the Step 2 chip editor plus the Step 3 financial fields — without needing to re-parse documents. The underlying data already lives in `nexus-store.json`; this is purely a UI surface problem.

**Alternative solutions**:
- Add a "Re-run intelligence" button to Settings that only re-runs Steps 0–2, preserving financial config
- Inline edit on the Dashboard profile widget (clicking the availability badge opens a mini-editor)

**High-risk assumptions**:
- Assumption: users want to edit skills/industries frequently (not just rates)
- Assumption: a dedicated "Profile" page doesn't add navigation complexity

**Minimal test**:
Track how often users open Settings after initial onboarding. If > 30% of sessions include a Settings visit within the first week, there's clear demand for post-onboard editing.

---

## 5. What NOT to build now

| Request | Reason to defer |
|---------|----------------|
| R7 Mobile layout | Nexus is a desktop-first local app; mobile is not the use case |
| R10 Import from Notion | Backend complexity high; zero users have populated Notion contracts yet |
| R9 LinkedIn fix | OAuth popup is a config issue, not a UX redesign — fix as a bug ticket |

---

## 6. Recommended Build Sequence

```
Sprint 1 (now):
  [1] Persist obStep + form values to localStorage on every keypress / step advance
  [2] Resume prompt on login screen: "Continue your setup from Step 3 →"
  [3] Make skip buttons equal-weight with proceed buttons

Sprint 2:
  [4] Add step subtitle "why" copy to each step
  [5] Profile editor page (surfacing chip editor + financial fields outside onboarding)

Sprint 3:
  [6] Time estimate on step indicator
  [7] Inline field validation (rate > 0, date is valid, etc.)
```

---

*Generated: 2026-03-08 | Nexus Live Onboarding Analysis v1.0*
*Framework: Opportunity Score (Importance × (1 − Satisfaction))*
