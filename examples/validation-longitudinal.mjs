import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { scoreDecomposition } from "./benchmark-recall.mjs";
import { publicExecution } from "./validation-agent.mjs";
import { agentTools, scopedMemory } from "./validation-runtime.mjs";
import { digest, evaluateAnswer, generateScenarios, retrievalMetrics } from "./validation-scenarios.mjs";

const dayMs = 24 * 60 * 60 * 1000;

export function longitudinalBinding(settings, plan) {
  const database = new URL(settings.serverEnvironment.MINDLEAK_DATABASE_URL);
  return { configurationSha256: digest(settings.configuration), scenarioSha256: digest(plan.scenarios.multi_day_learning),
    databaseBinding: digest({ host: database.hostname, port: database.port || "5432", database: database.pathname, user: database.username }) };
}

export async function runLongitudinal({ driver, statePath, day, binding, plan = generateScenarios(), agent = null, clock = null }) {
  if (![1, 2, 30].includes(day)) throw new Error("longitudinal_day_must_be_1_2_or_30");
  const now = clock ?? (() => new Date());
  const current = now();
  if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new Error("invalid_observation_clock");
  const path = resolve(statePath);
  await mkdir(dirname(path), { recursive: true });
  const lock = await open(`${path}.lock`, "wx", 0o600).catch(() => { throw new Error("longitudinal_state_locked"); });
  let state;
  const save = async () => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  };
  try {
    try {
      const source = await readFile(path);
      if (source.length > 65536) throw new Error("invalid_longitudinal_state");
      state = JSON.parse(source);
    } catch (error) {
      if (error.code !== "ENOENT" || day !== 1) throw new Error("longitudinal_state_unavailable");
      state = { schemaVersion: 1, runId: randomUUID(), startedAt: current.toISOString(), ...binding,
        requests: { 1: randomUUID(), 2: randomUUID() }, observations: {} };
      await writeFile(path, JSON.stringify(state, null, 2), { flag: "wx", mode: 0o600 });
    }
    if (state.schemaVersion !== 1 || typeof state.runId !== "string" || !/^[a-f0-9-]{36}$/.test(state.runId)
      || !Number.isFinite(Date.parse(state.startedAt)) || !state.requests || !state.observations
      || Object.entries(binding).some(([key, value]) => state[key] !== value)) throw new Error("longitudinal_state_binding_mismatch");
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if (![1, 2].every(phase => typeof state.requests[phase] === "string" && uuid.test(state.requests[phase]))
      || typeof state.observations !== "object" || Array.isArray(state.observations)) throw new Error("invalid_longitudinal_state");
    const age = current.getTime() - Date.parse(state.startedAt);
    if (age < 0) throw new Error("longitudinal_clock_moved_backwards");
    const earliest = (day - 1) * dayMs;
    const envelope = { reportVersion: 1, mode: "longitudinal", runId: state.runId, day,
      startedAt: state.startedAt, observedAt: current.toISOString(), elapsedDays: age / dayMs,
      clock: clock ? "injected-test-clock-not-real-time-evidence" : "host-wall-clock",
      realMcpProcess: driver.realProcess, binarySha256: driver.binarySha256, server: driver.server };
    if (age < earliest) return { ...envelope, status: "not_due", dueAt: new Date(Date.parse(state.startedAt) + earliest).toISOString(), longTermLearning: null };
    if (day > 1 && !state.observations[1] || day === 30 && !state.observations[2]) throw new Error("longitudinal_previous_checkpoint_missing");
    if (state.observations[day]) return { ...envelope, status: "already_recorded", observation: state.observations[day] };
    const scenario = plan.scenarios.multi_day_learning;
    const memory = scopedMemory(driver, `longitudinal-${state.runId}`, `validation-day-${day}-${state.runId}`);
    if (day !== 30) {
      const fact = scenario.facts[day - 1];
      const receipt = await memory.write(fact.text, { requestId: state.requests[day], context: { sessionId: state.requests[day] } });
      const episode = { id: fact.id, text: fact.text, facts: [fact] };
      state.observations[day] = { recordedAt: current.toISOString(), binarySha256: driver.binarySha256,
        fragments: receipt.fragments.map(fragment => ({ fragmentId: fragment.fragmentId,
          factId: scoreDecomposition(episode, [fragment.text]).verifiedIds[0] ?? null })),
        memoryId: receipt.memoryId, writeAcknowledged: true };
    } else {
      const known = new Map([1, 2].flatMap(phase => state.observations[phase].fragments.map(fragment => [fragment.fragmentId, fragment.factId])));
      const observation = await memory.recall("Project Helios", 5);
      const score = retrievalMetrics(observation.facts.map(fact => known.get(fact.fragmentId) ?? `unverified-${fact.fragmentId}`), scenario.facts.map(fact => fact.id));
      let rawPreserved = true;
      for (const phase of [1, 2]) for (const fragment of state.observations[phase].fragments) {
        const inspected = await memory.inspect(fragment.fragmentId, true);
        rawPreserved &&= inspected.rawText === scenario.facts[phase - 1].text;
      }
      const execution = agent ? await agent.run(scenario.task, agentTools(memory, null)) : null;
      const evaluation = execution ? evaluateAnswer(execution.answer, scenario.rubric) : null;
      state.observations[day] = { recordedAt: current.toISOString(), binarySha256: driver.binarySha256,
        elapsedDays: age / dayMs, rawPreserved, retrieval: score, retrievalMs: observation.elapsedMs,
        agent: execution ? { ...publicExecution(execution), evaluation } : null,
        combinedAnswerSuccess: execution?.status === "completed" ? evaluation.success : null,
        interpretation: "observed-retention-and-combination-not-model-training-or-general-learning" };
    }
    await save();
    return { ...envelope, status: "recorded", observation: state.observations[day],
      longTermLearning: day === 30 && !clock ? state.observations[day].combinedAnswerSuccess : null,
      nextDay: day === 1 ? 2 : day === 2 ? 30 : null };
  } finally {
    await lock.close();
    await rm(`${path}.lock`, { force: true });
  }
}
