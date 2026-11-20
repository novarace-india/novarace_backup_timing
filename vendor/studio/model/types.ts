/**
 * Canonical race model — the single, source-agnostic representation of a
 * RACE RESULT event that every other module (interpretation, blueprint,
 * compiler, simulator, packager) works from. Values are in natural units:
 * seconds and metres. The .ses importer is responsible for converting RR's
 * ×10000 fixed-point storage into these units.
 */

export type TimingMode = "gun" | "chip";

export interface SourceInfo {
  fileName: string;
  fingerprint: string; // sha256 of the imported file
  parserVersion: string;
  importedAt: string;
  rrMinVersion?: string;
}

export interface EventInfo {
  name: string;
  date?: string;
  dateUntil?: string;
  eventType?: number;
  location?: string;
  timezone?: string;
  attributes: Record<string, unknown>;
}

export interface Contest {
  id: number;
  name: string;
  nameShort: string;
  startSec: number; // T0 as time of day, seconds
  lengthM: number;
  laps: number;
  timeFormat: string;
  timeRounding: number;
  timingMode: TimingMode;
  startResult: number; // -1 = first split / automatic
  finishResult: number; // -1 = last split / automatic
  sort: { expr: string; desc: boolean }[];
  inactive: boolean;
  color?: string;
  attributes: Record<string, unknown>;
  participantCount: number;
}

export type SplitKind = "split" | "internal" | "leg";

export interface Split {
  id: number;
  contestId: number;
  kind: SplitKind;
  name: string;
  label: string;
  timingPoint: string;
  backup: string;
  backupOffset: number;
  sportCode: number;
  sport: string; // human label for sportCode
  isStart: boolean;
  isPreStart: boolean;
  /** Cumulative distance from the start, metres (0 for legs/start). */
  distanceM: number;
  distanceFromCode: number; // 0 start, -1 previous split, n = split id
  timeModeCode: number;
  timeMode: string; // human label for timeModeCode
  /** Validity window in natural units of timeMode (seconds, or km/h for speed modes). */
  min: number;
  max: number;
  order: number;
  sectorFrom: number;
  sectorTo: number;
  speedOrPace: string;
}

export type ResultKind = "rawdata" | "formula" | "static" | "separator";

export interface ResultDef {
  id: number;
  name: string;
  formula: string;
  kind: ResultKind;
  location: string;
  timeFormat: string;
  /** Result ids this formula depends on (parsed from Tn/TRn/T(n)/TSum(a;b) etc.). */
  dependsOn: number[];
}

export interface RankingDef {
  id: number;
  name: string;
  group: string[];
  sort: { expr: string; desc: boolean }[];
  filter: string;
  ties: boolean;
}

export interface AgeGroup {
  id: number;
  set: number;
  contestId: number; // 0 = applies to every contest
  name: string;
  short: string;
  sex: string; // "m" | "f" | "" (both)
  ageFrom: number;
  ageTo: number;
  dobFrom?: string;
  dobTo?: string;
  order: number;
}

export interface UserDefinedField {
  name: string; // without params
  params: string[];
  expression: string;
  note: string;
}

export interface AdditionalField {
  name: string;
  label: string;
  type: number;
  typeName: string;
  group: string;
  values: string[];
}

export interface TeamScoreDef {
  id: number;
  name: string;
  minTotal: number;
  maxTotal: number;
  grouping: string;
  assigning: string;
  filter: string;
  resultIds: number[];
}

export interface TimingPointDef {
  name: string;
  order: number;
  lat?: number;
  lng?: number;
}

export interface ExistingList {
  name: string; // Folder|Name
  folder: string;
  title: string;
  format: "json" | "xml";
  definition?: unknown;
}

export interface SampleParticipant {
  id: number;
  bib: number;
  firstName: string;
  lastName: string;
  sex: string;
  dateOfBirth: string;
  contestId: number;
  club: string;
  city: string;
  nation: string;
  status: number;
  transponder1: string;
  ageGroupId: number;
  extra: Record<string, string>;
}

export interface EventModel {
  source: SourceInfo;
  event: EventInfo;
  contests: Contest[];
  timingPoints: TimingPointDef[];
  splits: Split[];
  results: ResultDef[];
  rankings: RankingDef[];
  ageGroups: AgeGroup[];
  udfs: UserDefinedField[];
  additionalFields: AdditionalField[];
  teamScores: TeamScoreDef[];
  lists: ExistingList[];
  participants: SampleParticipant[];
  stats: { participants: number; rawData: number; statistics: number; certificates: number };
  settings: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/*  Output specification (the editable blueprint unit)                 */
/* ------------------------------------------------------------------ */

export type Phase =
  | "event_control"
  | "pre_race"
  | "start"
  | "live"
  | "finish"
  | "classification"
  | "director"
  | "announcer"
  | "led"
  | "podium"
  | "post_race"
  | "validation"
  | "broadcast";

export type Audience =
  | "timer"
  | "race_director"
  | "announcer"
  | "led"
  | "broadcast"
  | "spectator"
  | "results_controller"
  | "organiser";

export type Grouping = "none" | "header" | "filter" | "filterIgnore";

export interface ColumnSpec {
  label: string;
  expr: string;
  align?: "left" | "center" | "right";
  bold?: boolean;
  italic?: boolean;
  color?: string;
  dynFmt?: string;
  line?: number;
  responsiveHide?: number;
  previewOnly?: boolean;
  link?: string;
}

export interface OrderSpec {
  expr: string;
  desc?: boolean;
  grouping?: Grouping;
  filterLabel?: string;
  filterDefault?: number;
  pageBreak?: number;
  spacing?: number;
  bold?: boolean;
  color?: string;
  background?: string;
}

export interface FilterSpec {
  a: string;
  op: string;
  b: string;
  or?: boolean;
}

export interface ValidationCase {
  id: string;
  description: string;
  scenario: string; // simulation scenario id
  atClock?: "pre" | "mid" | "end";
  /** Clock relative to this contest's own start/finish instead of the whole event. */
  contestId?: number;
  expect:
    | { type: "maxRows"; value: number }
    | { type: "minRows"; value: number }
    | { type: "allRows"; expr: string }
    | { type: "noRows" }
    | { type: "sortedBy"; expr: string; desc?: boolean }
    /** median |predicted − real arrival| as % of the time still to run (sim ground truth) */
    | { type: "predictionError"; target: "next"; maxMedianPct: number };
}

export type Classification = "none" | "provisional" | "official";

export interface OutputSpec {
  id: string; // stable, deterministic (e.g. LIVE_HM_MALE_TOP10)
  name: string;
  folder: string; // e.g. 03_LIVE_RACE
  phase: Phase;
  discipline: string;
  audience: Audience[];
  contestScope: number[] | "all";
  description: string;
  headline2: string;
  columns: ColumnSpec[];
  orders: OrderSpec[];
  filters: FilterSpec[];
  maxRecords?: number;
  multiplier?: string;
  lineDynFmt?: string;
  fontSize?: number;
  landscape?: boolean;
  listHeader?: string;
  refresh: "static" | "live";
  refreshSeconds?: number;
  classification: Classification;
  enabled: boolean;
  approved?: { by: string; at: string };
  target: "list" | "list+presenter" | "list+led";
  validationCases: ValidationCase[];
  /** Filled by the compiler/validator. */
  dependencies?: string[];
  origin: "catalogue" | "ai" | "manual" | "imported";
}

export interface ProposedDependency {
  kind: "ranking" | "udf";
  name: string;
  reason: string;
  definition: RankingDef | UserDefinedField;
}

export type DisplayTarget = "led" | "announcer" | "race_director" | "broadcast" | "podium";

export interface DisplayProfile {
  id: string;
  name: string;
  target: DisplayTarget;
  width: number;
  height: number;
  layout: "single" | "split" | "grid" | "ticker";
  /** Output ids shown in the layout's panels, in panel order. */
  panels: { outputId: string; filter?: string; title?: string }[];
  rows: number;
  rotationSeconds: number;
  refreshSeconds: number;
  fontScale: number;
  highlightLeader: boolean;
  showProvisionalLabel: boolean;
  sponsorText: string;
}

export interface Branding {
  primary: string;
  accent: string;
  background: string;
  text: string;
  font: string;
  eventTitle: string;
  sponsorLine: string;
}

export interface Blueprint {
  projectId: string;
  version: number;
  basedOnSource: string; // source fingerprint
  generatedAt: string;
  outputs: OutputSpec[];
  proposedDependencies: ProposedDependency[];
  notes: string[];
  displays: DisplayProfile[];
  branding: Branding;
}
