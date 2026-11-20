/**
 * .ses importer — RACE RESULT event files are SQLite databases.
 * The file is always opened READ-ONLY; this module never writes to an event file.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  AdditionalField,
  AgeGroup,
  Contest,
  EventModel,
  ExistingList,
  RankingDef,
  ResultDef,
  ResultKind,
  SampleParticipant,
  Split,
  TeamScoreDef,
  UserDefinedField,
} from "../model/types.js";
import { ADDITIONAL_FIELD_TYPE, RR_FIXED, SPLIT_TYPE, TYPE_OF_SPORT, sportLabel, timeModeLabel, TIME_MODE } from "./codes.js";

export const PARSER_VERSION = "ses-parser/1.0.0";

type Row = Record<string, unknown>;
const num = (v: unknown, d = 0): number => (v === null || v === undefined || v === "" ? d : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("select 1 from sqlite_master where type='table' and name=?").get(name);
}
function all(db: DatabaseSync, sql: string): Row[] {
  return db.prepare(sql).all() as Row[];
}

function toMeters(raw: number, unit: string): number {
  const v = raw / RR_FIXED;
  const u = unit.toLowerCase();
  if (u === "km") return v * 1000;
  if (u === "mi" || u === "miles" || u === "mile") return v * 1609.344;
  return v;
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseUserFields(raw: string): UserDefinedField[] {
  const out: UserDefinedField[] = [];
  const push = (fullName: string, expression: string, note = "") => {
    const m = fullName.match(/^([^(]+)\((.*)\)\s*$/);
    const name = (m ? m[1] : fullName).trim();
    const params = m ? m[2].split(";").map((p) => p.trim()).filter(Boolean) : [];
    out.push({ name, params, expression, note });
  };
  const t = raw.trim();
  if (!t) return out;
  if (t.startsWith("[")) {
    for (const f of parseJson<{ Name: string; Expression: string; Note?: string }[]>(t, [])) push(f.Name, f.Expression, f.Note ?? "");
  } else {
    const re = /<Field Name="([^"]*)"[^>]*>([\s\S]*?)<\/Field>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) push(decodeXml(m[1]), decodeXml(m[2]));
  }
  return out;
}

/** Result ids referenced by a formula: Tn, TRn, T(n), TSum(a;b) ranges, [TimeN...]. */
export function resultDependencies(formula: string): number[] {
  const ids = new Set<number>();
  for (const m of formula.matchAll(/\bTR?(\d+)\b/gi)) ids.add(Number(m[1]));
  for (const m of formula.matchAll(/\bTIME(\d+)\b/gi)) ids.add(Number(m[1]));
  for (const m of formula.matchAll(/\bT(?:R)?(?:Sum|Min|Max|Avg|Count|First|Last)\w*\(\s*(\d+)\s*;\s*(\d+)/gi)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (b >= a && b - a < 2000) for (let i = a; i <= b; i++) ids.add(i);
  }
  for (const m of formula.matchAll(/\bTT\w*\(([\d;\s]+)\)/gi)) for (const p of m[1].split(";")) if (p.trim()) ids.add(Number(p));
  return [...ids].sort((a, b) => a - b);
}

function classifyResult(formula: string, location: string, name: string): ResultKind {
  const f = formula.trim();
  if (/^\(RAWDATA\w*\)$/i.test(f)) return "rawdata";
  if (!f && !location) return /^=+/.test(name) ? "separator" : "static";
  if (!f && location) return "rawdata";
  return "formula";
}

export function parseSesFile(filePath: string, opts: { sampleParticipants?: number; displayName?: string } = {}): EventModel {
  const buf = readFileSync(filePath);
  const fingerprint = createHash("sha256").update(buf).digest("hex");
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    return parseDb(db, {
      fileName: opts.displayName ?? path.basename(filePath),
      fingerprint,
      sampleParticipants: opts.sampleParticipants ?? 3000,
    });
  } finally {
    db.close();
  }
}

function parseDb(db: DatabaseSync, meta: { fileName: string; fingerprint: string; sampleParticipants: number }): EventModel {
  for (const t of ["contests", "settings", "participants"]) {
    if (!hasTable(db, t)) throw new Error(`Not a RACE RESULT event file: table "${t}" missing`);
  }

  // settings (Name, ForeignID) → Value. ForeignID 0 is the event-level value.
  const settings: Record<string, string> = {};
  for (const r of all(db, "select Name, Value, ForeignID from settings order by ForeignID")) {
    const key = num(r.ForeignID) === 0 ? str(r.Name) : `${str(r.Name)}#${num(r.ForeignID)}`;
    if (!(key in settings)) settings[key] = str(r.Value);
  }

  const counts: Record<number, number> = {};
  for (const r of all(db, "select Contest, count(*) n from participants group by Contest")) counts[num(r.Contest)] = num(r.n);

  const contests: Contest[] = all(db, "select * from contests order by OrderPos, ID").map((r) => {
    const attrs = parseJson<Record<string, unknown>>(str(r.Attributes) || "{}", {});
    const sort: Contest["sort"] = [];
    for (let i = 1; i <= 4; i++) {
      const e = str(r[`Sort${i}`]);
      if (e) sort.push({ expr: e, desc: !!num(r[`SortDesc${i}`]) });
    }
    return {
      id: num(r.ID),
      name: str(r.Name),
      nameShort: str(r.NameShort),
      startSec: num(r.Start) / RR_FIXED,
      lengthM: toMeters(num(r.Length), str(r.LengthUnit) || "m"),
      laps: num(r.Laps),
      timeFormat: str(r.TimeFormat) || "h:mm:ss",
      timeRounding: num(r.TimeRounding),
      // Contest TimingMode: 0 = gun, 1 = chip (verified: triathlon=gun/0, time trial=chip/1).
      timingMode: num(r.TimingMode) === 1 ? "chip" : "gun",
      startResult: num(r.StartResult),
      finishResult: num(r.FinishResult),
      sort,
      inactive: !!num(r.Inactive),
      color: typeof attrs.Color === "string" ? (attrs.Color as string) : undefined,
      attributes: attrs,
      participantCount: counts[num(r.ID)] ?? 0,
    };
  });

  const timingPoints = hasTable(db, "timingpoints")
    ? all(db, "select * from timingpoints order by OrderPos").map((r) => {
        const [lat, lng] = str(r.Position).split(",").map(Number);
        return { name: str(r.Name), order: num(r.OrderPos), lat: isFinite(lat) ? lat : undefined, lng: isFinite(lng) ? lng : undefined };
      })
    : [];

  const splits = hasTable(db, "splits") ? parseSplits(all(db, "select * from splits order by Contest, OrderPos, ID")) : [];

  const results: ResultDef[] = hasTable(db, "results")
    ? all(db, "select * from results order by ID").map((r) => {
        const formula = str(r.Formula);
        return {
          id: num(r.ID),
          name: str(r.Name),
          formula,
          kind: classifyResult(formula, str(r.Location), str(r.Name)),
          location: str(r.Location),
          timeFormat: str(r.TimeFormat),
          dependsOn: resultDependencies(formula),
        };
      })
    : [];

  const rankings: RankingDef[] = hasTable(db, "rankings")
    ? all(db, "select * from rankings order by ID").map((r) => {
        const sort: RankingDef["sort"] = [];
        for (let i = 1; i <= 4; i++) {
          const e = str(r[`Sort${i}`]);
          if (e) sort.push({ expr: e, desc: !!num(r[`SortDesc${i}`]) });
        }
        return {
          id: num(r.ID),
          name: str(r.Name),
          group: [1, 2, 3, 4].map((i) => str(r[`Group${i}`])).filter(Boolean),
          sort,
          filter: str(r.Filter),
          ties: !!num(r.UseTies),
        };
      })
    : [];

  const ageGroups: AgeGroup[] = hasTable(db, "agegroups")
    ? all(db, "select * from agegroups order by AGSet, Contest, OrderPos").map((r) => ({
        id: num(r.ID),
        set: num(r.AGSet) || 1,
        contestId: num(r.Contest),
        name: str(r.Name),
        short: str(r.ShortName),
        sex: str(r.Sex).toLowerCase(),
        ageFrom: num(r.AgeFrom),
        ageTo: num(r.AgeTo),
        dobFrom: str(r.DoBFrom) && str(r.DoBFrom) !== "0000-00-00" ? str(r.DoBFrom) : undefined,
        dobTo: str(r.DoBTo) && str(r.DoBTo) !== "0000-00-00" ? str(r.DoBTo) : undefined,
        order: num(r.OrderPos),
      }))
    : [];

  const additionalFields: AdditionalField[] = hasTable(db, "customFields")
    ? all(db, "select * from customFields order by OrderPos").map((r) => ({
        name: str(r.Name),
        label: str(r.Label) || str(r.Name),
        type: num(r.FieldType),
        typeName: ADDITIONAL_FIELD_TYPE[num(r.FieldType)] ?? `Type ${num(r.FieldType)}`,
        group: str(r.Group),
        values: str(r.Config) ? str(r.Config).split(";") : [],
      }))
    : [];

  const teamScores: TeamScoreDef[] = hasTable(db, "teamScores")
    ? all(db, "select * from teamScores order by ID").map((r) => ({
        id: num(r.ID),
        name: str(r.Name),
        minTotal: num(r.MinTotal),
        maxTotal: num(r.MaxTotal),
        grouping: str(r.Grouping1),
        assigning: str(r.Assigning1),
        filter: str(r.Filter),
        resultIds: [1, 2, 3, 4].map((i) => num(r[`ResultID${i}`])).filter((v) => v !== 0),
      }))
    : [];

  const lists: ExistingList[] = Object.keys(settings)
    .filter((k) => k.startsWith("List_"))
    .map((k) => {
      const name = k.slice(5);
      const v = settings[k].trim();
      const isJson = v.startsWith("{");
      const [folder, ...rest] = name.split("|");
      return {
        name,
        folder: rest.length ? folder : "",
        title: rest.length ? rest.join("|") : folder,
        format: isJson ? "json" : "xml",
        definition: isJson ? parseJson(v, undefined) : undefined,
      } satisfies ExistingList;
    });

  const participants = parseParticipants(db, additionalFields, meta.sampleParticipants);
  const rawData = hasTable(db, "rawdata") ? num((db.prepare("select count(*) n from rawdata").get() as Row).n) : 0;
  const totalParticipants = num((db.prepare("select count(*) n from participants").get() as Row).n);

  return {
    source: {
      fileName: meta.fileName,
      fingerprint: meta.fingerprint,
      parserVersion: PARSER_VERSION,
      importedAt: new Date().toISOString(),
      rrMinVersion: settings.MinRequiredVersion,
    },
    event: {
      name: settings.Eventname || meta.fileName.replace(/\.ses$/i, ""),
      date: settings.Eventdate || undefined,
      dateUntil: settings.EventDate2 || undefined,
      eventType: settings.EventType ? Number(settings.EventType) : undefined,
      location: settings.EventLocation || undefined,
      timezone: settings.EventTimeZone || undefined,
      attributes: parseJson<Record<string, unknown>>(settings.EventAttributes || "{}", {}),
    },
    contests,
    timingPoints,
    splits,
    results,
    rankings,
    ageGroups,
    udfs: parseUserFields(settings.UserFields ?? ""),
    additionalFields,
    teamScores,
    lists,
    participants,
    stats: {
      participants: totalParticipants,
      rawData,
      statistics: Object.keys(settings).filter((k) => k.startsWith("Statistic_")).length,
      certificates: Object.keys(settings).filter((k) => k.startsWith("Certificate_")).length,
    },
    settings: Object.fromEntries(
      Object.entries(settings).filter(([k]) => !k.startsWith("List_") && !k.startsWith("Certificate") && !k.startsWith("Statistic_")),
    ),
  };
}

function parseSplits(rows: Row[]): Split[] {
  const byContest = new Map<number, Row[]>();
  for (const r of rows) {
    const c = num(r.Contest);
    if (!byContest.has(c)) byContest.set(c, []);
    byContest.get(c)!.push(r);
  }
  const out: Split[] = [];
  for (const [contestId, list] of byContest) {
    const cum = new Map<number, number>(); // split id → cumulative metres
    let prevCum = 0;
    for (const r of list) {
      const kind = SPLIT_TYPE[num(r.SplitType)] ?? "split";
      const sportCode = num(r.TypeOfSport);
      const from = num(r.DistanceFrom);
      const segment = toMeters(num(r.Distance), str(r.DistanceUnit) || "m");
      let distanceM = 0;
      if (kind !== "leg") {
        if (from === 0) distanceM = segment;
        else if (from === -1) distanceM = prevCum + segment;
        else distanceM = (cum.get(from) ?? 0) + segment;
        cum.set(num(r.ID), distanceM);
        prevCum = distanceM;
      }
      const tm = num(r.TimeMode);
      const unit = TIME_MODE[tm]?.unit ?? "sec";
      const conv = (v: number) => (unit === "speed" ? v / RR_FIXED : v / RR_FIXED);
      out.push({
        id: num(r.ID),
        contestId,
        kind,
        name: str(r.Name),
        label: str(r.Label),
        timingPoint: str(r.TimingPoint),
        backup: str(r.Backup),
        backupOffset: num(r.BackupOffset),
        sportCode,
        sport: sportLabel(sportCode),
        isStart: !!TYPE_OF_SPORT[sportCode]?.isStart,
        isPreStart: !!TYPE_OF_SPORT[sportCode]?.isPreStart,
        distanceM,
        distanceFromCode: from,
        timeModeCode: tm,
        timeMode: timeModeLabel(tm),
        min: conv(num(r.PaceMin)),
        max: conv(num(r.PaceMax)),
        order: num(r.OrderPos),
        sectorFrom: num(r.SectorFrom),
        sectorTo: num(r.SectorTo),
        speedOrPace: str(r.SpeedOrPace),
      });
    }
  }
  return out;
}

function parseParticipants(db: DatabaseSync, fields: AdditionalField[], limit: number): SampleParticipant[] {
  const rows = all(
    db,
    `select ID, Bib, Firstname, Lastname, Sex, DateOfBirth, Contest, Club, City, Nation, Status, Transponder1, AgeGroup1
     from participants order by Contest, Bib limit ${Math.max(0, Math.floor(limit))}`,
  );
  const extra = new Map<number, Record<string, string>>();
  if (fields.length && hasTable(db, "customFieldValues")) {
    const ids = new Map<number, string>();
    for (const r of all(db, "select ID, Name from customFields")) ids.set(num(r.ID), str(r.Name));
    for (const r of all(db, "select FieldID, PID, Value from customFieldValues")) {
      const pid = num(r.PID);
      if (!extra.has(pid)) extra.set(pid, {});
      const n = ids.get(num(r.FieldID));
      if (n) extra.get(pid)![n] = str(r.Value);
    }
  }
  return rows.map((r) => ({
    id: num(r.ID),
    bib: num(r.Bib),
    firstName: str(r.Firstname),
    lastName: str(r.Lastname),
    sex: str(r.Sex).toLowerCase(),
    dateOfBirth: str(r.DateOfBirth),
    contestId: num(r.Contest),
    club: str(r.Club),
    city: str(r.City),
    nation: str(r.Nation),
    status: num(r.Status),
    transponder1: str(r.Transponder1),
    ageGroupId: num(r.AgeGroup1),
    extra: extra.get(num(r.ID)) ?? {},
  }));
}

/** Splits of one contest that timing reads resolve against, in course order. */
export function courseSplits(model: EventModel, contestId: number): Split[] {
  return model.splits
    .filter((s) => s.contestId === contestId && s.kind !== "leg")
    .sort((a, b) => a.order - b.order || a.id - b.id);
}

export function contestLegs(model: EventModel, contestId: number): Split[] {
  return model.splits.filter((s) => s.contestId === contestId && s.kind === "leg");
}
