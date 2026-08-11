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

**On the hospital workstation:** copy the whole folder and open `index.html` in the browser.
Nothing to install; no administrator rights, npm, Node, or Python needed.

The six-step flow is: **Import → Map fields → Rules & codes → Validate → Results → Export**.

### Running the tests (development only)

```
node tests/run.js
```

No dependencies. The runner loads every script listed in `index.html`, in that order, so a
file that is added to the project but forgotten in the page fails the suite rather than the
workstation.

---

## First-run setup

The tool ships with the service codes (IP/OS/SB) and the eleven discharge codes from the
specification. Two reference tables start **empty** because the hospital had not supplied
them at design time:

- **Insurance / payer codes** — until these are mapped, every account is payer `Unknown`, and
  the Medicare-specific rules (IMM, MOON, two-midnight) produce nothing.
- **Admission sources** — until these are mapped, the admission-source summary reports
  `Unknown`.

On the *Rules & codes* step each tab offers to add every unmapped value found in the loaded
file, so setup is: load a month, click **Add them for editing**, fill in the categories,
then **Export configuration** to a JSON file and keep it somewhere backed up.

> Browser-local storage is offered as a convenience, but the JSON export is the canonical
> copy. `file://` storage behavior varies, and a workstation rebuild or an IT policy can
> clear it without warning.

---

## Design decisions worth knowing

**Wall-clock time, always.** CPSI timestamps are hospital-local wall-clock values. Every
datetime is carried on the UTC axis purely as a clock value and read back with `getUTC*`,
so elapsed time is exactly the difference of the written clock values and the workstation's
timezone and daylight-saving rules cannot shift a stay. See the header of `src/core/util.js`.

**Episodes, not accounts, for readmissions.** CPSI opens a new account whenever a patient
changes status, so one hospital course (`OS → IP → SB → IP`) arrives as four rows. The tool
rebuilds them into one Episode ID using the discharge code as the signal and timing only as
confirmation. Readmission logic runs on episodes, so an internal status change can never be
reported as a readmission.

**Nothing is linked on timing alone.** A same-day service change with no transition discharge
code is *reported* as a possible uncoded transition and left unlinked. Two plausible
successors are flagged Ambiguous and left unlinked. A missing expected successor is flagged.
The tool never guesses.

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

## Project layout

```
index.html                     page and script load order (the tests read this)
app.css                        styling; no web fonts, no remote assets
vendor/xlsx.full.min.js        SheetJS Community Edition, Apache-2.0, bundled locally
vendor/xlsx-LICENSE.txt

src/core/       ur.js               namespace, versions, enumerations, external references
                util.js             wall-clock datetime arithmetic, statistics, formatting
src/config/     defaultMappings.js  built-in reference data and thresholds (user-editable)
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
src/metrics/    scope.js            reporting period and qualifying-record filters
                inpatient.js observation.js swingBed.js census.js payer.js
src/quality/    validators.js codeInventory.js diagnostics.js
src/review/     reviewQueue.js      objective account-level review queue
src/export/     workbookBuilder.js  the 17-worksheet compiled workbook
                calculationReferenceSheet.js
                zipPatch.js         adds frozen header panes after the workbook is written
src/pipeline.js                     the deterministic processing pipeline
src/ui/app.js                       user interface controller
tests/                              runner, harness, synthetic fixtures, 181 tests
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
- No encounter row, name, MRN, account number, or date is written to `localStorage`,
  `IndexedDB`, cookies, logs, or any telemetry. Only reference mappings and thresholds are
  persisted, through one audited writer (`src/config/configSchema.js`), which filters against
  an explicit key whitelist.
- The exported workbook may contain patient identifiers because the authorized user creates
  it deliberately on the hospital workstation. Patient names can be excluded from the export
  with one checkbox; the Executive Summary never carries names, MRNs, or account numbers.
- There are no network calls of any kind. The test suite fails the build if `fetch`,
  `XMLHttpRequest`, `WebSocket`, `sendBeacon`, or a remote `src`/`href` appears in the source.

---

## Deferred by design (spec 17)

Automated InterQual or avoidable-day determination; automated Code 44 decisions; denial
adjudication or appeal recommendations; automated proof of IMM/MOON completion;
outpatient-in-a-bed detection; DRG/case-mix benchmarking; direct CPSI database or API
integration; multi-user server hosting; AI-generated clinical or payer decisions; the
official CMS risk-standardized readmission methodology; hard-coded payer authorization rules.
