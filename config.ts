import { parseSesFile } from "./vendor/studio/ses/parser.js";

export function importConfiguration(file: string, filename: string) {
  const model = parseSesFile(file, { sampleParticipants: Number.MAX_SAFE_INTEGER, displayName: filename });
  const contests = model.contests.filter((contest) => !contest.inactive);
  const contestIds = new Set(contests.map((contest) => contest.id));
  const findings: string[] = [];
  const points = new Map(model.timingPoints.filter((point) => point.name.trim()).map((point) => [
    point.name.trim().toLowerCase(), { name: point.name.trim(), passes: [] as Pass[] },
  ]));
  const occurrences = new Map<string, number>();
  for (const split of model.splits) {
    if (split.kind === "leg" || !contestIds.has(split.contestId)) continue;
    const label = split.label || split.name || `Split ${split.id}`;
    const names = new Map([split.timingPoint, split.backup]
      .map((name) => name.trim()).filter(Boolean).map((name) => [name.toLowerCase(), name]));
    if (!split.timingPoint.trim()) findings.push(`${label} has no primary physical timing point.`);
    for (const [pointKey, name] of names) {
      if (!points.has(pointKey)) {
        findings.push(`Timing point “${name}” is referenced by a split and missing from the timing point table.`);
        points.set(pointKey, { name, passes: [] });
      }
      const point = points.get(pointKey)!;
      const role = split.isPreStart ? "check-in" : split.isStart ? "start" : "course";
      const base = JSON.stringify([pointKey, split.distanceM, role, split.distanceM ? "" : label.toLowerCase()]);
      const occurrenceKey = JSON.stringify([base, split.contestId]);
      const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
      occurrences.set(occurrenceKey, occurrence);
      const key = JSON.stringify([base, occurrence]);
      let pass = point.passes.find((entry) => entry.key === key);
      if (!pass) {
        pass = { key, distance: split.distanceM, label, occurrence, splits: [] };
        point.passes.push(pass);
      }
      pass.splits.push({ id: split.id, contestId: split.contestId, label });
      if (occurrence > 1) findings.push(`${point.name} has multiple ${split.distanceM / 1000} km passes for contest ${split.contestId}. Select the named pass explicitly.`);
    }
  }
  const categoryNames = new Map(model.ageGroups.filter((group) => group.set === 1).map((group) => [
    `${group.contestId}:${group.id}`, group.name,
  ]));
  const roster = model.participants.filter((runner) => runner.bib > 0 && contestIds.has(runner.contestId)).map((runner) => ({
    id: runner.id, bib: runner.bib, contestId: runner.contestId, status: runner.status,
    sex: runner.sex.trim().toLowerCase(),
    category: categoryNames.get(`${runner.contestId}:${runner.ageGroupId}`) ?? categoryNames.get(`0:${runner.ageGroupId}`) ?? "Unassigned",
  }));
  if (model.participants.length !== roster.length) {
    findings.push(`${model.participants.length - roster.length} entry or entries have no positive bib or no active contest.`);
  }
  const bibs = new Set<number>();
  const duplicates = new Set<number>();
  for (const runner of roster) {
    if (bibs.has(runner.bib)) duplicates.add(runner.bib);
    bibs.add(runner.bib);
  }
  if (duplicates.size) findings.push(`Repeated bibs: ${[...duplicates].join(", ")}. Verify the contest on the bib button.`);
  const timingPoints = [...points.values()].map((point) => ({
    ...point, passes: point.passes.sort((a, b) => a.distance - b.distance || a.occurrence - b.occurrence),
  }));
  if (!timingPoints.some((point) => point.passes.length)) findings.push("No timing points have mapped splits.");
  return {
    name: model.event.name || filename.replace(/\.ses$/i, ""), date: model.event.date,
    timezone: model.event.timezone, fingerprint: model.source.fingerprint,
    contests: contests.map(({ id, name }) => ({ id, name })), timingPoints, roster, findings,
  };
}

interface Pass {
  key: string;
  distance: number;
  label: string;
  occurrence: number;
  splits: { id: number; contestId: number; label: string }[];
}
