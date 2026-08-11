/*
 * ur.js - root namespace, version constants, and shared enumerations.
 *
 * Every source file in this project is a plain browser script (IIFE) that hangs
 * its exports off the single global `UR` object. There is no module loader and
 * no build step, so the distribution works when index.html is double-clicked
 * from a file:// path on a hospital workstation (spec 15.4).
 */
(function (global) {
  'use strict';

  var UR = global.UR = global.UR || {};

  /* Application version. Reported in the exported Run Metadata worksheet. */
  UR.APP_VERSION = '1.0.0';

  /* Version of the bundled calculation rule registry as a whole. Individual
   * rules also carry their own version (spec 15.3). */
  UR.RULESET_VERSION = '1.0';

  /* Schema version of the exported/imported configuration JSON (spec 14). */
  UR.CONFIG_SCHEMA_VERSION = 1;

  /* Service classification assigned to each encounter after the service code is
   * looked up in the editable service-code reference table (spec 7.1). */
  UR.SERVICE = {
    IP: 'IP',            /* acute inpatient */
    OS: 'OS',            /* observation */
    SB: 'SB',            /* swing bed */
    IGNORED: 'IGNORED',  /* recognized code, deliberately excluded */
    UNKNOWN: 'UNKNOWN'   /* code not present in the reference table */
  };

  UR.INCLUDED_SERVICES = [UR.SERVICE.IP, UR.SERVICE.OS, UR.SERVICE.SB];

  /* Diagnostic severity ladder (spec 11.1). */
  UR.SEVERITY = {
    BLOCKING: 'Blocking',
    ERROR: 'Error',
    WARNING: 'Warning',
    INFO: 'Info'
  };

  UR.SEVERITY_ORDER = ['Blocking', 'Error', 'Warning', 'Info'];

  /* Rule classification shown in the Calculation Reference (spec 15.3). */
  UR.CLASSIFICATION = {
    REGULATORY: 'Regulatory surveillance',
    OPERATIONAL: 'Operational',
    HOSPITAL: 'Hospital-specific mapping',
    DATA_QUALITY: 'Data quality'
  };

  /* Payer categories used by every payer-sensitive rule (spec 7.1). */
  UR.PAYER_CATEGORY = {
    MEDICARE_FFS: 'Medicare FFS',
    MEDICARE_ADVANTAGE: 'Medicare Advantage',
    MEDICAID: 'Medicaid',
    COMMERCIAL: 'Commercial/Managed Care',
    SELF_PAY: 'Self-pay',
    OTHER: 'Other',
    UNKNOWN: 'Unknown'
  };

  UR.PAYER_CATEGORY_LIST = [
    UR.PAYER_CATEGORY.MEDICARE_FFS,
    UR.PAYER_CATEGORY.MEDICARE_ADVANTAGE,
    UR.PAYER_CATEGORY.MEDICAID,
    UR.PAYER_CATEGORY.COMMERCIAL,
    UR.PAYER_CATEGORY.SELF_PAY,
    UR.PAYER_CATEGORY.OTHER,
    UR.PAYER_CATEGORY.UNKNOWN
  ];

  /* Payer categories that make an account a Medicare notice / two-midnight
   * review candidate (spec 9.2 IP_2MN_001, spec 10 RQ_IMM / RQ_MOON). */
  UR.MEDICARE_CATEGORIES = [
    UR.PAYER_CATEGORY.MEDICARE_FFS,
    UR.PAYER_CATEGORY.MEDICARE_ADVANTAGE
  ];

  /* Linkage confidence assigned by the transition linker (spec 8.3). */
  UR.LINK_CONFIDENCE = {
    CONFIRMED: 'Confirmed',
    PROBABLE: 'Probable',
    AMBIGUOUS: 'Ambiguous',
    MISSING: 'Missing successor',
    UNLINKED: 'Unlinked'
  };

  /* External references cited by the rule registry (spec 18). */
  UR.REFERENCES = [
    {
      id: 'R1',
      title: 'CMS - Critical Access Hospitals',
      note: 'CAH requirements include no more than 25 beds used for acute/swing services and an annual average acute inpatient LOS of 96 hours or less, excluding swing-bed services and distinct-part units.',
      url: 'https://www.cms.gov/medicare/health-safety-standards/certification-compliance/critical-access-hospitals'
    },
    {
      id: 'R2',
      title: 'CMS MLN006400 - Information for Critical Access Hospitals',
      note: 'Educational summary of CAH requirements, including the 96-hour annual average acute-care inpatient length of stay.',
      url: 'https://www.cms.gov/files/document/mln006400-information-critical-access-hospitals.pdf'
    },
    {
      id: 'R3',
      title: 'CMS - Medicare Outpatient Observation Notice (MOON)',
      note: 'MOON framework for Medicare beneficiaries receiving observation services. Used here only to build manual-review candidate lists; CPSI cannot export proof of notice completion.',
      url: 'https://www.cms.gov/newsroom/fact-sheets/medicare-outpatient-observation-notice-moon'
    },
    {
      id: 'R4',
      title: 'CMS - FFS & MA IM/DND',
      note: 'The Important Message from Medicare applies to Medicare fee-for-service and Medicare Advantage hospital inpatients.',
      url: 'https://www.cms.gov/medicare/forms-notices/beneficiary-notices-initiative/ffs-ma-im'
    },
    {
      id: 'R5',
      title: 'CMS - Two-Midnight Rule fact sheet',
      note: 'Supports treating short Medicare/MA inpatient stays as review candidates rather than automatically labeling them inappropriate.',
      url: 'https://www.cms.gov/newsroom/fact-sheets/fact-sheet-two-midnight-rule-0'
    },
    {
      id: 'R6',
      title: 'Arkansas Department of Health - Rules for Hospitals and Related Institutions',
      note: 'Arkansas hospital licensure and operation rules. Observation-service language should be rechecked when thresholds are revised.',
      url: 'https://healthy.arkansas.gov/wp-content/uploads/Hospital_Rules.pdf'
    },
    {
      id: 'R7',
      title: 'Arkansas Code of Rules - Hospital Discharge Data System',
      note: 'Official Arkansas rules governing hospital discharge-data reporting.',
      url: 'https://codeofarrules.arkansas.gov/Rules/Rule?chapterID=32&levelType=part&partID=479&sectionID=null&subChapterID=44&subPartID=null&titleID=20'
    },
    {
      id: 'R8',
      title: 'UnitedHealthcare Provider - Advance Notification and Prior Authorization Requirements',
      note: 'Plan- and member-specific requirements must be verified through current provider tools rather than hard-coded.',
      url: 'https://www.uhcprovider.com/en/prior-auth-advance-notification/adv-notification-plan-reqs.html'
    },
    {
      id: 'R9',
      title: 'Humana Provider - Prior Authorization and Notification Lists',
      note: 'Humana requirements vary by line of business and service and are updated regularly; verify rather than hard-code.',
      url: 'https://provider.humana.com/coverage-claims/prior-authorizations/prior-authorization-lists'
    },
    {
      id: 'HOSP',
      title: 'Hospital-specific operational rule',
      note: 'Local policy or local CPSI usage supplied by the hospital. Not derived from an external regulatory source.',
      url: ''
    }
  ];

  UR.referenceById = function (id) {
    for (var i = 0; i < UR.REFERENCES.length; i++) {
      if (UR.REFERENCES[i].id === id) { return UR.REFERENCES[i]; }
    }
    return null;
  };

})(typeof globalThis !== 'undefined' ? globalThis : this);
