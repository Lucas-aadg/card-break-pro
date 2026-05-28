# PostHog Dashboard Setup — Card Break Pro

## Prerequisites
1. Sign up at posthog.com and create a project
2. Copy your project API key into `config.js` → `POSTHOG_CONFIG.apiKey`
3. Deploy to Vercel — events will start flowing on first user logins

---

## Dashboard 1: Onboarding Funnel

**Type:** Funnel  
**Name:** Owner Onboarding Funnel

**Steps (in order):**
1. `owner_first_login`
2. `owner_channel_created`
3. `owner_product_added`
4. `owner_team_member_invited`
5. `owner_payroll_configured`

**How to read it:**  
Drop-off at each step = where owners stall. If 80% create a channel but only 20% invite a team member, the invite flow needs attention or owners don't understand they need it.

**Action threshold:** If step 3 → step 4 drop-off > 50%, add an in-app nudge after product creation.

---

**Type:** Funnel  
**Name:** Breaker Onboarding Funnel

**Steps:**
1. `breaker_first_login`
2. `breaker_first_break_submitted`
3. `breaker_onboarding_complete`

**How to read it:**  
Breakers who see the guide but never submit a break haven't worked a real stream yet. High gap between login and first break = new hire who hasn't been assigned a shift.

---

**Type:** Funnel  
**Name:** Sorter Onboarding Funnel

**Steps:**
1. `sorter_first_login`
2. `sorter_first_sort_started`
3. `sorter_onboarding_complete`

---

## Dashboard 2: Trial Conversion

**Type:** Funnel  
**Name:** Trial → Active Conversion

**Steps:**
1. `owner_first_login`
2. `break_logged` (any, within 14 days)
3. `stream_closed` (any, within 14 days)

**How to read it:**  
Owners who log a break AND close a stream within the trial have experienced the core value. These are your highest-converting cohort. Owners who only log breaks but never close a stream are partially activated.

**Supporting chart — Line chart:**  
- Event: `break_logged`
- Breakdown: `subscription_tier`
- Date range: Last 30 days

**Action threshold:** If trial owners (tier = starter/pro) have < 3 `break_logged` events in first 7 days, the Day 7 email is correctly targeting the right group.

---

## Dashboard 3: Feature Adoption

**Type:** Bar chart  
**Name:** Feature Adoption by Event Volume

**Events to track (one bar each):**
- `break_logged`
- `stream_closed`
- `ai_insights_viewed`
- `empire_dashboard_viewed`
- `owner_payroll_configured`
- `owner_team_member_invited`

**Date range:** Last 30 days  
**Breakdown:** `subscription_tier`

**How to read it:**  
`ai_insights_viewed` with low count = owners don't know it exists or don't see value. `empire_dashboard_viewed` should be near zero for non-empire tiers (sanity check that the tier gate works).

**Action threshold:**  
- `ai_insights_viewed` < 10% of `break_logged` → add a nudge or highlight on the AI tab
- `owner_team_member_invited` low relative to `owner_first_login` → checklist isn't driving the action

---

## Dashboard 4: Retention

**Type:** Retention table  
**Name:** Owner Weekly Retention

**Defining event (did action):** `break_logged`  
**Return event:** `break_logged`  
**Time interval:** Weekly  
**Cohort window:** 8 weeks

**How to read it:**  
Week 0 = first time an owner logged a break. Each subsequent week shows what % came back and logged another break. Healthy SaaS targets 40%+ retention at Week 4.

**Action threshold:**  
- Week 1 retention < 30% → Day 7 email not landing or product not sticky enough
- Week 4 retention < 20% → owners are churning before getting value; investigate with session recordings

---

## People Properties (set via `cbpIdentify`)

These auto-attach to every user profile and filter every chart:
- `organization_id` — group by org
- `organization_name` — readable name
- `subscription_tier` — starter / pro / empire / legacy / exempt
- `role` — owner / breaker / sorter
- `days_since_signup` — track at first login

Use the **Persons** tab to look up individual owners by `organization_name` and see their full event timeline.

---

## Super Properties (auto-attached to every event)

Set via `posthog.register()` in `analytics.js`:
- `organization_id`
- `organization_name`  
- `subscription_tier`
- `role`

This means every funnel and chart can be filtered by `subscription_tier` without extra instrumentation.

---

## Quick Sanity Checks After Deploy

1. Log in as an owner → PostHog **Live Events** should show `owner_first_login` within 30 seconds
2. Create a channel → should see `owner_channel_created`
3. Check **Persons** → owner user should have `subscription_tier`, `role`, `organization_name` attached
4. Log in as a new breaker → should see `breaker_first_login` and guide modal
5. After 7 days of production data, check trial funnel for first real conversion data
