# CPSI Utilization Review Data Compiler

A standalone, browser-only utility that turns CPSI/Evident Ad Hoc encounter exports into
utilization-review metrics, objective account-level review queues, data-quality diagnostics,
and a compiled Excel workbook.

It runs from a local folder on an authorized hospital workstation. There is no server, no
database, no cloud service, no AI model, and no connection to the EHR. It makes no network
requests at all.

Built to `CPSI_UR_Data_Compiler_Design_Specification.docx` v1.0 (25-bed Critical Access Hospital).

---

## What it does, and what it deliberately does not do

**It does** compute deterministic metrics from raw encounter rows, reconstruct continuous
hospital episodes across CPSI's status-change accounts, and produce a list of accounts that
should be individually reviewed by a person.

**It does not** decide whether a case is medically necessary, correctly statused, avoidable,
denied, compliant, or clinically appropriate. It cannot verify that an IMM or MOON was
delivered or signed, because CPSI cannot export that. Regulatory figures are *surveillance
aids* and must be validated against hospital policy and current payer/CMS requirements before
being treated as official compliance reporting.

---

## Running it

**On the hospital workstation**, either of:

- **Single file:** copy `dist/ur-compiler.html` anywhere and open it in the browser. It is
  the entire application - styles, code, and the bundled spreadsheet engine inlined - and
  behaves identically to the folder distribution.
- **Folder:** copy the whole folder and open `index.html`.

Nothing to install; no administrator rights, npm, Node, or Python needed.

The routine monthly flow is two actions: **drop the export file, read the Overview.** Files
whose columns are recognized process immediately; the Field Mapping screen appears only when
the mapper actually needs a decision (a required column missing, or two columns equally
plausible).

The **Overview** leads with an attention digest — the short list of things that genuinely
need a person, each line carrying a count and a button that jumps to the screen where it is
fixed. A clean run says so in one line. The full detail is never removed: diagnostics, the
code inventory, the transition log, and the reporting-period controls sit in collapsed
sections on the same page.

From there the working pages are **Metrics**, **Review Queue** (one row per account with
every trigger reason attached — selecting a row opens the full patient course), **Accounts**,
**Graphs**, and **Export**. The navigation keeps them separate from the **Setup** screens
(Import, Field Mapping, Rules & Codes, Calculation Reference), which only need attention when
something changes.

### Running the tests (development only)

```
node tests/run.js
```

No dependencies. The runner loads every script listed in `index.html`, in that order, so a
file that is added to the project but forgotten in the page fails the suite rather than the
workstation. A green suite also rebuilds `dist/ur-compiler.html` automatically, so the
single-file distribution can never drift from the sources; the build is deterministic
(content-hash stamped, no timestamps), so an unchanged rebuild never dirties the file.

To make the rebuild unconditional — covering even a commit made without running the tests —
enable the bundled pre-commit hook once per clone:

```
git config core.hooksPath .githooks
```

It rebuilds and stages `dist/ur-compiler.html` on every commit (a no-op when nothing changed).

---

## First-run setup

The hospital's own reference tables ship with the application:

| Table | Contents |
|---|---|
| Service codes | IP, OS, SB |
| Discharge codes | all 23, with the UB-04 patient discharge status in each label |
| Origin (admission source) codes | all 7, read from the `ipv1_origin` column (`origin_code` also accepted) |
| Insurance codes | all 736, with the hospital's own payer categories |

Codes, names, and payer categories all come from the hospital's own mapping, so a category in
this tool is a statement by the hospital rather than a guess. Two consequences are worth
knowing, because both decide who lands on the Medicare review lists:

- **Only 20 codes are Medicare fee-for-service** (Medicare itself, plus Palmetto GBA) and 103
  are Medicare Advantage. Everything else is outside `RQ_IMM`, `RQ_MOON`, `RQ_SHORT_MCR`, and
  `IP_2MN_001`.
- **Medicare supplement plans are Commercial/Managed Care, not Medicare.** A Medigap account
  is therefore not an IMM or MOON candidate. That is the hospital's classification and the
  test suite asserts it, so it will survive a future tidy-up of the payer table.

The 163 codes the hospital marks "Do Not Use / Inactive" ship **disabled** — the one
deliberate departure from the source file. A retired code on a current account is then
reported as a retired code rather than absorbed into Other, where a coding problem would be
invisible. Each row keeps the hospital's category, so re-enabling one in the Rules screen
restores the source mapping exactly.

The insurance tab defaults to showing only the codes that actually appear in the loaded file —
usually a dozen or two out of 736 — with a search box and a "Only Medicare rows" filter.

After any local change, **Export configuration** to a JSON file and keep it somewhere backed up.

> Browser-local storage is offered as a convenience, but the JSON export is the canonical
> copy. `file://` storage behavior varies, and a workstation rebuild or an IT policy can
> clear it without warning.

### Codes are case-sensitive

The insurance table contains 21 pairs that differ only in case and mean different payers —
`DCg` is Humana Women's Clinic, `DCG` is Lake Village Rehab Family Clinic. Lookup therefore
matches the code exactly first. If there is no exact match it will accept a single
case-only or leading-zero-only match (spreadsheets do mangle both) and report that it did;
if more than one row could match, it refuses and says so rather than picking a payer.

---

## Design decisions worth knowing

**Wall-clock time, always.** CPSI timestamps are hospital-local wall-clock values. Every
datetime is carried on the UTC axis purely as a clock value and read back with `getUTC*`,
so elapsed time is exactly the difference of the written clock values and the workstation's
timezone and daylight-saving rules cannot shift a stay. See the header of `src/core/util.js`.

**Patient identity is derived, and says so.** The export carries no medical
record number: the tool assigns a Patient ID (`P001`, `P002`, ...) to each
distinct (patient name, age) pair from the `visit_name` and `ipv1_age_years`
columns, and that ID drives transition linkage, episodes, and readmissions.
Name matching forgives case and spacing noise, nothing more. The two inherent
limitations are handled openly rather than guessed away: two different people
sharing a name and age become one patient (undetectable in this data), and one
person whose birthday falls between two stays shows two ages — same-name
records whose ages sit within one year are therefore MERGED into one patient
(a birthday inside the range is far likelier than two same-name patients born
a year apart), and every merge is noted on the review queue (`DQ_PID_MERGED`,
Info) with the ages and accounts involved so the assumption stays checkable.
A row whose name or age is missing or unusable gets no Patient ID, links to
nothing, and is reported (`DQ_PID_MISSING`).

**Episodes, not accounts, for readmissions.** CPSI opens a new account whenever a patient
changes status, so one hospital course (`OS → IP → SB → IP`) arrives as four rows. The tool
rebuilds them into one Episode ID using the discharge code as the signal and timing only as
confirmation. Readmission logic runs on episodes, so an internal status change can never be
reported as a readmission.

**Nothing is linked on timing alone.** A same-day service change with no transition discharge
code is *reported* as a possible uncoded transition and left unlinked. Two plausible
successors are flagged Ambiguous and left unlinked. A missing expected successor is flagged.
The tool never guesses. An accepted link whose service pair no named metric models (say
SB -> OS) keeps its episode but raises a warning and puts the account on the review queue,
so an unexpected pattern is a work item rather than a silently uncounted link.

**Contradictory registration times are tolerated up to a point, and named past it.** Live
data showed registration entering the IP admission ~45 minutes *before* the SB discharge on a
genuine SB → IP transition, so the overlap tolerance defaults to 120 minutes (raised from the
spec's 15 per its own B.1 directive to 60 at `TRANS_001` v1.1, then to 120 at the hospital's
direction, v1.4): such a pair links as Probable and is
flagged for verification. Beyond the tolerance the link is *refused* — but the finding names
both accounts and says exactly what to do (fix the times in CPSI, or raise the tolerance),
instead of a "missing successor" beside an unrelated "unexplained overlap".

**The reporting period comes from where the data actually is.** A one-month
export from a hospital with swing beds contains admissions from earlier months,
because long stays discharge inside the reported month. Taking the earliest
admission as the period start would report a one-month export as a quarter, so
the default period is inferred from where activity concentrates: the busiest
calendar month, extended only through adjacent months carrying at least
`processing.periodInferenceShare` (20%) of it. Months left out are kept as
context for episode and readmission logic and reported as an Info diagnostic.
The full data span is always displayed beside the period, and the date controls
(or the one-click presets — inferred, full span, or any single month) override
the inference entirely.

**A stay that only partly overlaps the period still counts.** A patient
admitted before the period start whose stay reaches into it participates in
unique-patient, occupancy, review-list (IMM/MOON/observation-threshold), and
conversion-denominator figures; internal transitions are counted in the period
their transition *moment* falls in, so an observation stay that began in the
prior month still counts as a conversion when the status change happened inside
the period. Only *event* counts stay event-anchored: an admission counts in the
period it happened, a discharged stay in the period chosen by the period basis.
Records with no overlap at all are kept purely as episode/readmission context
and reported as such.

**Two patient-day methods, on purpose.** The inherited workbook's definition is uncertain and
patient-day conventions differ, so both a time-weighted method (`PD_EQ_001`) and a midnight
census method (`PD_MN_001`) are calculated and exported. Neither is labelled the official
hospital measure. Validate both against existing reporting before choosing.

**No silent unknowns.** Every distinct service, discharge, insurance, and admission-source
value encountered appears in the Code Inventory with a count and a status of
recognized/used, recognized/ignored, or unrecognized — visible before export.

**The rule registry is the source of truth.** Every metric, review trigger, and data-quality
check has a stable Rule ID and full metadata in `src/config/`. The in-app Calculation
Reference page and the exported Calculation Reference worksheet are *generated* from it;
they are never a separately maintained copy. Thresholds are rendered from the configuration
actually used for the run, so the exported reference always matches the numbers beside it.

---

## Accounts: checking the interpretation against the chart

The Accounts tab lists **every** account that was imported — including the ones the metrics
excluded, because "why is this account missing from the count" is exactly the question a
verification pass needs to answer. Search by account, patient ID, patient name, or episode; filter by
service, by whether the record counted, by open encounters, or by review status.

Selecting an account opens the whole **patient course**, not just that one CPSI account, and
for every visit it shows three things side by side:

| | |
|---|---|
| **Source column** | the header the value came from, e.g. `ipv1_ad_time` |
| **Value as imported** | the cell exactly as it arrived, e.g. `1015` |
| **Interpreted as** | what the engine made of it, e.g. `08/03/2026 10:15` |

So an Excel serial of `46236` appears beside `08/03/2026`, a blank time appears beside
"midnight assumed", and an unmapped payer code appears beside `Unknown` rather than silently
becoming a category. Below that sit the derived values (elapsed duration, midnights crossed,
episode membership, whether the record counted and why not), every diagnostic raised against
the visit, and every review-queue reason it triggered.

The dossier also shows **every transition attempt for that patient, accepted or refused, with
the reason**. A refusal is the answer to "why are these two accounts separate episodes when
the chart clearly shows one stay" — a missing successor, two ambiguous candidates, a gap
outside tolerance. That is usually a source-data or mapping finding, not a tool finding.

This is the view to have open beside the charting system during the pilot.

---

## Graphs

The Graphs tab draws fourteen charts from the same calculated metrics as the
Metrics page and the workbook, each labelled with the Rule IDs behind it: daily
midnight census, admissions by service and month, service accounts against
episodes, acute LOS against the 96-hour line, LOS distribution, observation
duration bands, transitions, readmissions, payer mix, disposition, admission
source, day of week, review queue, and diagnostics by severity.

- **Export PNG** on any chart, or **Export all graphs as PNG** for the set. Images
  render at 2x on a light background with the title and subtitle baked in, so
  they drop straight into a document whatever theme the screen is using.
- Hover any chart for values; **Show data table** gives the same numbers as text.
- Charts are drawn on a canvas rather than SVG, so the exported PNG is produced
  by the same drawing code as the screen and nothing has to be serialized.

A note on the observation chart: the `OS_24/36/48` metrics are cumulative (a
50-hour stay counts in all three), while a distribution has to be exclusive, so
the chart cuts non-overlapping bands from the same thresholds. It will not match
the metric counts, and says so in its subtitle.

Colour is assigned by identity in a fixed slot order and validated for
colour-vision separation and contrast against both the light and dark chart
surfaces. A chart with one measure uses one colour, because there is no identity
to encode; severity uses the reserved status colours and never a series slot.

Time charts follow the reporting period: a single-month period plots the
midnight census day by day, while a period spanning more than one month shows
the average midnight census per month (the ADC) instead - one point per month,
from the same underlying daily data - so a quarter never renders as an
unreadable comb of ninety daily points.

---

## The exported workbook

Eighteen worksheets — nineteen with the **Graphs** sheet, where every populated
graph from the Graphs view is embedded as an image with a caption naming its
Rule IDs — opening on a **Contents** page where every sheet name is a link and
each sheet has a one-line description.

**The workbook is also a save file.** Every export embeds a session snapshot
(source tables, field mapping, configuration, period choice, and manual
observation entries) as an inert part inside the file. Importing an exported
workbook back into the tool restores the session exactly as it was — and more
data files can then be added on top of the restored state. Two limits: the
snapshot is omitted when patient names were excluded from the export (it would
smuggle them back in), and Excel may strip the part if someone edits and
re-saves the workbook, so restore from the file as exported.

**Manual observation segments.** CPSI sometimes exports a stay that began in
observation as a single IP account. Every IP account's dossier offers *Add
observation segment*: the operator enters the observation admit/discharge, a
synthetic `<account>-MANUAL` observation account carries it (linked as a normal
OS → IP conversion), the IP admission moves forward to the observation
discharge so the hours are not double-counted, and everything reprocesses.
Entries are session-only, noted on the account and the review queue
(`DQ_MANUAL_OS`), listed in Run Metadata, and removable with one click. The **Executive Summary** reads
month by month - one column per calendar month of the reporting period, left to
right, then a Total column for the whole period - and deliberately carries no
Rule ID column: it is written for a reader, and every line's rule is documented
in the Calculation Reference worksheet. Sheet tabs are color-grouped —
blue summaries, orange review work, slate account detail, amber data quality,
green reference — and every table ships with a frozen, filterable header row
and zebra banding so a row can be read across thirty columns.

Severity cells on the Data Quality sheet and Unrecognized codes in the Code
Inventory are tinted with the same status colors the application uses on
screen. All of this is applied by `src/export/zipPatch.js` *after* the workbook
bytes are written (the bundled spreadsheet library cannot write fonts or
fills); if the patcher meets anything unexpected it returns the unstyled
workbook rather than risking a corrupted one, so an export can never fail on
cosmetics.

---

## Project layout

```
index.html                     page and script load order (the tests read this)
app.css                        styling; no web fonts, no remote assets
vendor/xlsx.full.min.js        SheetJS Community Edition, Apache-2.0, bundled locally
vendor/xlsx-LICENSE.txt

src/core/       ur.js               namespace, versions, enumerations, external references
                util.js             wall-clock datetime arithmetic, statistics, formatting
src/config/     defaultMappings.js  built-in reference data and thresholds (user-editable)
                insuranceCodes.js   the hospital's 736-code insurance table
                calculationRules.js THE CALCULATION RULE REGISTRY - build/read this first
                reviewRules.js      review-queue trigger registry
                dataQualityRules.js data-quality check registry with default severities
                configSchema.js     validation, versioning, JSON export/import, persistence
src/import/     parsers.js          tolerant date/time/identifier parsing
                headerMapper.js     canonical fields, aliases, ambiguity refusal
                spreadsheetReader.js xlsx/xls/csv reading, header-row detection
src/domain/     normalizeEncounter.js raw rows -> canonical encounters + diagnostics
                transitionLinker.js   internal status-transition reconstruction
                episodeBuilder.js     continuous episode assembly
                readmissionDetector.js internal readmission indicators
                accountDetail.js      account browser list and patient dossier
src/metrics/    scope.js            reporting period, month windows, qualifying-record filters
                inpatient.js observation.js swingBed.js census.js payer.js
                chartData.js        metric -> chart specifications (no drawing code)
src/quality/    validators.js codeInventory.js diagnostics.js
                attention.js        the Overview digest: what needs a person, with actions
src/review/     reviewQueue.js      objective account-level review queue
src/export/     workbookBuilder.js  the 18-worksheet compiled workbook
                calculationReferenceSheet.js
                zipPatch.js         post-write patcher: styling, tab colors, frozen panes
src/pipeline.js                     the deterministic processing pipeline
build/standalone.js                 builds dist/ur-compiler.html (runs after a green suite)
dist/ur-compiler.html               the single-file distribution - generated, do not edit
src/ui/app.js                       user interface controller
src/ui/charts.js                    canvas chart renderer and PNG export
tests/                              runner, harness, synthetic fixtures, 287 tests
docs/VALIDATION.md                  pilot validation checklist
```

Every source file is a plain browser script that hangs its exports off a single `UR` global.
There is no module loader and no build step, so the distribution works when `index.html` is
double-clicked from a `file://` path.

---

## Changing a calculation

1. Edit the metric module **and** its record in `src/config/calculationRules.js` in the same change.
2. Increment that rule's `version`.
3. Add or update a unit test in `tests/`.
4. Run `node tests/run.js`.

Do not put an unexplained literal (`96`, `24`, `36`, `48`, `"B"`, `"Q"`, `"V"`) anywhere
outside the centralized rule and configuration modules.

---

## Privacy model

- Imported patient data lives in the browser tab's memory for the current run only.
- No encounter row, name, age, patient ID, account number, or date is written to `localStorage`,
  `IndexedDB`, cookies, logs, or any telemetry. Only reference mappings and thresholds are
  persisted, through one audited writer (`src/config/configSchema.js`), which filters against
  an explicit key whitelist.
- The exported workbook may contain patient identifiers because the authorized user creates
  it deliberately on the hospital workstation. Patient names can be excluded from the export
  with one checkbox; the Executive Summary never carries names, patient IDs, or account numbers.
- There are no network calls of any kind. The test suite fails the build if `fetch`,
  `XMLHttpRequest`, `WebSocket`, `sendBeacon`, or a remote `src`/`href` appears in the source.

---

## Deferred by design (spec 17)

Automated InterQual or avoidable-day determination; automated Code 44 decisions; denial
adjudication or appeal recommendations; automated proof of IMM/MOON completion;
outpatient-in-a-bed detection; DRG/case-mix benchmarking; direct CPSI database or API
integration; multi-user server hosting; AI-generated clinical or payer decisions; the
official CMS risk-standardized readmission methodology; hard-coded payer authorization rules.
