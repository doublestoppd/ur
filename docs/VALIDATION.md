# Pilot validation checklist

This tool is a surveillance and work-list aid. Before any figure it produces is used for
reporting — and before any threshold in it is treated as authoritative — work through this
checklist with the Clinical IT / application owner and the UR staff member.

The specification is explicit that the inherited UR workbook's formulas and metric
definitions **should not be treated as authoritative without validation**. That cuts both
ways: where this tool and the old workbook disagree, the disagreement is the finding.

---

## 1. Reference mappings (do this first)

The hospital's service codes, all 24 discharge codes, all 7 origin codes, and all 736
insurance codes — **with the hospital's own payer categories** — ship with the application.
Nothing in the payer mapping is inferred, so this step is confirmation rather than repair:
check that the shipped tables still match current practice, and that the handful of local
decisions below are the ones you want.

| Check | Where | Done |
|---|---|---|
| Every service code in a real export appears in the Code Inventory with a deliberate status | Overview → Code inventory | |
| Codes marked *Unrecognized* are either mapped or explicitly set to Ignore | Rules & codes → Service codes | |
| All 24 discharge codes match current hospital usage | Rules & codes → Discharge codes | |
| Code `V` still means SB → IP locally (the published meaning of 66 is transfer to another CAH) | Rules & codes → Discharge codes | |
| Code `Z` (10 ADMIT TO OBSERVATION) really is used as an internal status change; disable the row if not | Rules & codes → Discharge codes | |
| Every insurance code appearing in the data still carries the right payer category — tick "Only codes found in the loaded data" | Rules & codes → Insurance / payer codes | |
| The 20 Medicare FFS and 103 Medicare Advantage codes are still current: these alone decide the two-midnight list and the Medicare readmission subset | Rules & codes → "Only Medicare rows" | |
| **Medicare supplement / Medigap is classified as Commercial**, so a Medigap account is *not* a two-midnight review candidate. Confirm that is still intended | same filter | |
| Any account reported with a *retired* insurance code is investigated — the hospital marks 163 codes "Do Not Use / Inactive" and they ship disabled so their use is visible | Overview → attention digest / Diagnostics | |
| `ipv1_origin` is the right column (`origin_code` is still accepted), and origin values resolve (note that OBSERVATION is published as `6`, not `06`) | Field Mapping + Overview → Code inventory | |
| Patient identity spot-check: pick a patient with several accounts and confirm all carry ONE Patient ID (identity = name + age from `ipv1_age_years`) | Accounts → dossier | |
| Every `DQ_PID_MERGED` note (same name, ages within one year, merged as one patient on the birthday assumption) is spot-checked against the chart; if the records are really two patients, correct the source data | Overview → Diagnostics / Review queue | |
| Configuration exported to JSON and stored somewhere backed up | Rules & codes → Export configuration | |

An unmapped or wrongly categorized payer code is not cosmetic: it silently adds or removes
accounts from the two-midnight review list and the Medicare readmission subset. The tool reports unmapped and
retired codes as warnings rather than guessing — resolve them before relying on those lists.

**Codes are case-sensitive.** The insurance table contains 21 pairs differing only in case
that mean different payers (`DCg` Humana Women's Clinic vs `DCG` Lake Village Rehab). If a
code arrives in the wrong case the tool will match it only when there is exactly one
candidate, and will say that it did; when two rows could match it refuses and reports an
ambiguous code rather than picking a payer.

---

## 2. Reconcile against the existing UR workbook

Run one month that the hospital has already compiled by hand, and compare:

| Metric | Rule ID | Expected relationship to the old workbook |
|---|---|---|
| Inpatient admissions | `IP_ADM_001` vs `EPISODE_CNT_001` | The old figure may match either one. Find out which, and record the answer. |
| Acute ALOS | `IP_ALOS_001` | May differ if the old workbook used midnights or whole days rather than elapsed hours. |
| Observation ALOS | `OS_ALOS_001` | Hour-precise here; the old figure may be day-based. |
| Patient days | `PD_EQ_001` **and** `PD_MN_001` | One of the two should be close. Whichever matches is the hospital's convention — record it before naming a headline metric. |
| ADC | `ADC_EQ_001` / `ADC_MN_001` | Must be consistent with whichever patient-day method was chosen. |
| OBS → IP conversions | `OSIP_001` | Discrepancies usually mean a transition the tool refused to link; check the Transitions worksheet. |
| One-day stays | `IP_SHORT_001` | Elapsed-hours based. The old figure may have been midnight-based; `RQ_SHORT_MCR` is the midnight companion. |
| Deaths | `DEATH_001` | Should match exactly. If not, the discharge-code mapping is wrong. |
| LOS > 4 days | `IP_GT4_001` | Strictly greater than 96 hours. A stay of exactly 96.0 hours is excluded. |

**Use the Accounts tab to run the disagreement down.** It lists every imported account,
including the excluded ones, and shows each source cell beside the value the tool derived from
it. When a count differs by three, find the three accounts there rather than guessing at the
formula.

**Where they disagree, check these first:**

1. **The reporting period itself.** The Overview's Reporting period section
   shows the period, where it came from, and the full span of the imported
   records. If the tool inferred a period, it also reports which months it
   treated as prior context — long stays that began before the reported month.
   Set the dates explicitly (or use the presets — inferred, full data span, or
   any single month) if the inference does not match how the export was pulled.
   Note that a stay admitted before the period whose stay reaches into it still
   counts in patient, occupancy, and review figures; only the admission *event*
   is excluded from admission counts. The old workbook may have done either.
2. **Period basis.** *Rules & codes → Processing options → Discharged-stay period basis.*
   `discharge` counts a stay in the month it ended; `admission` counts it in the month it
   began. The old workbook may use the other one.
3. **Internal transitions.** A course of `OS → IP` is two service accounts and one episode.
   `ADM_SVC_001` counts the accounts; `EPISODE_CNT_001` counts the episode.
4. **Open encounters.** Excluded from discharged-stay ALOS always; included in occupancy only
   through the as-of datetime, and only when that option is on.
5. **Rows the tool excluded.** The Data Quality worksheet lists every one with a reason.

---

## 3. Transition and episode reconstruction

Open the **Accounts** tab and select a patient with a known status change. The dossier shows
every transition attempt for that patient — accepted or refused, with the reason and the gap
in minutes — so a disagreement with the chart can be traced to the rule that caused it.

| Check | Where |
|---|---|
| Every `Ambiguous` and `Missing successor` row is understood | Transitions worksheet, or the Accounts tab per patient |
| `Possible uncoded transition` rows are taken back to coding as a source-data fix | Transitions worksheet |
| Accepted links flagged for suspicious timing are spot-checked against the chart | Transitions worksheet, `Gap minutes` |
| A known real `OS → IP → SB → IP` course appears as one episode with the right sequence | Episodes worksheet |
| A patient who genuinely returned the same day appears as **two** episodes | Episodes worksheet |

**Contradictory registration times.** Live data has shown registration entering the successor
admission *before* the prior discharge on a genuine transition (IP admitted 08:10, SB
discharged 08:55). The overlap tolerance therefore defaults to 120 minutes: such a pair links
as **Probable**, joins the episode, and is flagged for verification. An overlap *beyond* the
tolerance is refused as **Refused (timing)** with both accounts named — the finding tells you
to either correct the times in CPSI or raise the tolerance and reprocess. Note that on an
accepted overlap link the overlapping minutes remain in both segments' durations and
occupancy until the source times are fixed; correcting registration is the real repair.

If the 120-minute maximum gap, the 120-minute overlap tolerance, or the same-calendar-date
requirement is rejecting real transitions, adjust them in *Rules & codes → Transition
settings* and reprocess. Widening them also widens the chance of a wrong link, so change one
setting at a time and re-check the Transitions worksheet.

---

## 4. Regulatory figures — read the limits

| Figure | Rule ID | The limit |
|---|---|---|
| 4-day (96-hour) target variance | `IP_TARGET_001` | A **surveillance estimate over the selected period**. The CAH requirement is an *annual* average across the cost-reporting year, excluding swing-bed and distinct-part-unit services. Do not treat the monthly figure as a certification calculation until it has been reconciled with the cost report methodology. (v1.1 absorbs the retired `CAH96_001`, which computed the same variance in hours.) |
| Two-midnight review list | `IP_2MN_001` / `RQ_SHORT_MCR` | Identifies **candidates only**. It cannot see the physician's expectation at admission, case-by-case exceptions, or inpatient-only procedures. Nothing on this list is "inappropriate" by virtue of being on it. |
| Readmission indicators | `READMIT_*` | **Internal operational indicators.** No risk standardization, no planned-readmission algorithm, no condition cohorts, and no visibility of admissions at other facilities. Never present these as a CMS readmission rate. |

Recheck references R1–R9 (listed in the Calculation Reference) whenever calculation rules or
payer workflows are revised.

---

## 5. Readmission lookback

Readmission counts near the start of the imported date range are **understated**: a qualifying
prior stay may sit before the first imported row. The tool reports this as a
`DQ_LOOKBACK` warning naming the affected cut-off date and episode count.

To close the gap, import the 30 days preceding the month being reported. Extra rows that lie
wholly outside the reporting period do not affect any count — they only supply history. (A stay
from that earlier window that *reaches into* the period is different: it genuinely belongs in
patient, occupancy, and review figures, and the tool counts it there deliberately.)

---

## 6. Privacy and handling

| Check | Done |
|---|---|
| The exported workbook is stored per hospital policy for files containing PHI | |
| Patient names are excluded from the export where the recipient does not need them (Export step checkbox) | |
| The Executive Summary — which carries no names, patient IDs, or account numbers — is used for anything circulated more widely | |
| Staff understand that browser storage holds settings only, never patient data | |

---

## 7. Spot-check the interpretation, account by account

Pick a handful of accounts and verify them against the chart in the Accounts tab. Cover at
least one of each:

| Case | What to confirm |
|---|---|
| An ordinary inpatient stay | Admit and discharge datetimes match the chart to the minute, and the LOS follows from them |
| A status change (OS → IP, IP → SB, SB → IP) | One episode, the right service sequence, and a transition gap that matches the chart |
| A refused transition | The reason given is a real data or coding issue, not a tool misreading |
| An excluded account | The stated reason is correct — an unrecognized service code, a bad date, a duplicate |
| A record with no time on a timestamp | "Midnight assumed" is acceptable for that account, or the export needs the time column |
| A Medicare account | The insurance code maps to the right category; this drives the two-midnight list and the Medicare readmission subset |
| An open encounter | It really was still in house when the export was pulled |

Anything that does not match is a finding: record it, and fix it in the reference mappings or
the source export rather than working around it downstream.

---

## 8. Sign-off

| Item | Owner | Date |
|---|---|---|
| Reference mappings reviewed and exported | Clinical IT | |
| One month reconciled against the existing UR workbook | UR staff | |
| Patient-day method chosen and recorded | UR staff + Finance | |
| Regulatory limitations understood by everyone using the output | UR staff | |
| Discrepancies found during the pilot logged, with the rule versions changed to resolve them | Clinical IT | |
