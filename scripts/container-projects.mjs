export function cleanupProjects(projects, removeProject, originalFailure) {
  const failures = originalFailure === undefined ? [] : [originalFailure];
  for (const project of projects) {
    try { removeProject(project); }
    catch (cause) { failures.push(new Error(`Could not remove owned project ${project}`, { cause })); }
  }
  if (failures.length === 1 && failures[0] === originalFailure) throw originalFailure;
  if (failures.length) throw new AggregateError(failures, "Smoke test or owned-project cleanup failed");
}
