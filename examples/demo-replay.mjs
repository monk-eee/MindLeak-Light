import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { normalizeRecording, sandboxApplicationPage, labCompletion } from "./demo-view.mjs";
import { digest } from "./validation-scenarios.mjs";

const require = createRequire(import.meta.url);
const directory = dirname(fileURLToPath(import.meta.url));
let assets;

async function viewAssets() {
  if (!assets) assets = Promise.all([
    readFile(join(directory, "demo-view.html"), "utf8"), readFile(join(directory, "demo-view.mjs"), "utf8"),
    readFile(join(dirname(require.resolve("lucide")), "../umd/lucide.min.js"), "utf8"),
    readFile(join(directory, "../assets/mindleak_128x128.png")),
    ...["ibm-plex-sans", "ibm-plex-mono"].map(name => readFile(require.resolve(`@fontsource/${name}/files/${name}-latin-400-normal.woff2`))),
  ]);
  return assets;
}

export async function renderDemoPage({ report = null, live = false, profiles = null, basePath = "", navigation = null } = {}) {
  if (report) normalizeRecording(report);
  const data = JSON.stringify({ report, live, profiles, basePath, navigation }).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  if (Buffer.byteLength(data) > 16 * 1024 * 1024) throw new Error("replay_report_budget");
  const [template, client, icons, logo, sans, mono] = await viewAssets();
  const fonts = [sans, mono].map((font, index) => `@font-face{font-family:'IBM Plex ${index ? "Mono" : "Sans"}';font-style:normal;font-weight:400 700;font-display:swap;src:url(data:font/woff2;base64,${font.toString("base64")}) format('woff2')}`).join("\n");
  const replacements = { DATA: data, CLIENT: client.replace(/<\/script/gi, "<\\/script"), ICONS: icons.replace(/<\/script/gi, "<\\/script"), LOGO: logo.toString("base64"), FONTS: fonts };
  return template.replace(/\{\{(DATA|CLIENT|ICONS|LOGO|FONTS)\}\}/g, (_, key) => replacements[key]);
}

export async function openArtifactBrowser({ executablePath = process.env.MINDLEAK_BROWSER_EXECUTABLE } = {}) {
  const { chromium } = await import("playwright");
  try { return await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); }
  catch { throw new Error("browser_acceptance_unavailable_run_playwright_install_chromium"); }
}

export async function verifyBuildArtifacts(report, { browser: providedBrowser = null, executablePath } = {}) {
  const artifacts = ["application", "controlApplication"].filter(key => report[key]?.html);
  for (const key of artifacts) if (typeof report[key].html !== "string" || Buffer.byteLength(report[key].html) > 2 * 1024 * 1024
    || digest(report[key].html) !== report[key].sha256) throw new Error("artifact_identity_mismatch");
  if (!artifacts.length) return [];
  const browser = providedBrowser ?? await openArtifactBrowser({ executablePath });
  const reviews = [];
  const requireCheck = value => { if (!value) throw new Error("artifact_check_failed"); };
  try {
    for (const artifact of artifacts) for (const viewport of [{ width: 1440, height: 1080 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport, serviceWorkers: "block", acceptDownloads: false });
      const page = await context.newPage();
      page.setDefaultTimeout(3000); page.setDefaultNavigationTimeout(5000);
      let pageErrors = 0; let remoteRequests = 0;
      page.on("pageerror", () => { pageErrors += 1; });
      await context.route(/^https?:\/\//, route => { remoteRequests += 1; return route.abort(); });
      const checks = { "Browser behaviour": [], "Responsive layout": [] };
      const check = async (area, name, operation) => {
        let passed = false;
        try { await operation(); passed = true; } catch {}
        checks[area].push({ name, passed }); return passed;
      };
      try {
        await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
        await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
        await page.setContent(sandboxApplicationPage(report[artifact].html), { waitUntil: "load" });
        const app = page.frameLocator("iframe");
        const rendered = await check("Browser behaviour", "Required controls render", async () => {
          await app.locator("#session-label").waitFor({ state: "visible" });
          await app.locator("#session-ttl").waitFor({ state: "visible" });
          requireCheck(await app.locator(".add-session").isVisible());
          requireCheck(await app.locator("[data-clear-expired]").isVisible());
        });
        const create = async (label, lifetime) => {
          await app.locator("#session-label").fill(label);
          await app.locator("#session-ttl").fill(String(lifetime));
          await app.locator(".add-session").click();
        };
        if (rendered) {
          await check("Browser behaviour", "Create a session", async () => {
            await create("Acceptance review", 60);
            requireCheck(await app.locator("[data-count]").textContent() === "1");
            requireCheck(await app.locator(".session-label").textContent() === "Acceptance review");
          });
          await check("Browser behaviour", "Remove a session", async () => {
            await app.locator("[data-remove]").first().click();
            requireCheck(await app.locator("[data-count]").textContent() === "0");
          });
          await check("Browser behaviour", "Treat labels as text", async () => {
            const label = "<img src=x onerror=alert(1)>";
            await create(label, 60);
            requireCheck(await app.locator(".session-label").textContent() === label);
            requireCheck(await app.locator("[data-sessions] img").count() === 0);
            await app.locator("[data-remove]").first().click();
          });
          await check("Browser behaviour", "Reject an invalid label", async () => {
            await create("", 60);
            requireCheck((await app.locator("[data-error]").textContent()).trim().length > 0);
            requireCheck(await app.locator("[data-count]").textContent() === "0");
          });
          await check("Browser behaviour", "Expire and clear only expired sessions", async () => {
            await create("Short", 1); await create("Long", 60);
            await page.clock.runFor(1000);
            requireCheck(await app.locator("[data-state=expired]").count() === 1);
            await app.locator("[data-clear-expired]").click();
            requireCheck(await app.locator("[data-count]").textContent() === "1");
            requireCheck(await app.locator(".session-label").textContent() === "Long");
          });
        }
        await check("Browser behaviour", "No script errors or external requests", async () => { requireCheck(pageErrors === 0 && remoteRequests === 0); });
        await check("Responsive layout", "No horizontal page overflow", async () => {
          requireCheck(rendered && await app.locator("html").evaluate(node => node.scrollWidth <= node.ownerDocument.defaultView.innerWidth + 1));
        });
        await check("Responsive layout", "Controls fit their viewport", async () => {
          requireCheck(rendered && await app.locator("button,input").evaluateAll(nodes => nodes.length >= 4 && nodes.every(node => {
            const bounds = node.getBoundingClientRect();
            return bounds.width > 0 && bounds.height > 0 && bounds.left >= -1 && bounds.right <= node.ownerDocument.defaultView.innerWidth + 1;
          })));
        });
      } catch {
        checks["Browser behaviour"].push({ name: "Artifact loads in the isolated browser", passed: false });
      } finally {
        for (const [area, results] of Object.entries(checks)) reviews.push({ version: 1, artifact, artifactSha256: report[artifact].sha256,
          area, method: `Playwright Chromium ${browser.version()}; controlled expiry clock`, viewport, checkedAt: new Date().toISOString(),
          checks: results.length || 1, passedChecks: results.filter(result => result.passed).length,
          failures: results.length ? results.filter(result => !result.passed).map(result => result.name) : ["No checks executed"],
          results, scope: "Browser acceptance smoke only; not a security, accessibility or maintainability audit." });
        await context.close();
      }
    }
  } finally { if (!providedBrowser) await browser.close(); }
  return reviews;
}

export async function runBuildWithAcceptance(build, { onEvent = () => {}, openBrowser = openArtifactBrowser, verifyArtifacts = verifyBuildArtifacts, signal } = {}) {
  const started = performance.now();
  signal?.throwIfAborted();
  const browser = await openBrowser();
  const browserPreflightMs = performance.now() - started;
  try {
    signal?.throwIfAborted();
    const buildEvent = event => ({ ...event, type: event.type === "run_finished" ? "build_execution_finished" : event.type,
      atMs: event.atMs + browserPreflightMs });
    const report = await build(event => onEvent(buildEvent(event)));
    report.events = report.events.map(buildEvent);
    report.browserPreflightMs = browserPreflightMs;
    const emit = event => { const record = { ...event, id: report.events.length + 1, atMs: performance.now() - started }; report.events.push(record); onEvent(record); };
    emit({ type: "quality_review_started", agent: "system", scope: "Browser behaviour and responsive layout" });
    const reviewStarted = performance.now();
    try {
      report.qualityReviews = await verifyArtifacts(report, { browser });
      if (report.qualityReviews.some(review => review.passedChecks !== review.checks)) {
        report.status = "partial"; report.failure = "browser_acceptance_failed";
      }
    } catch {
      report.qualityReviews = []; report.status = "partial"; report.failure = "browser_acceptance_incomplete";
    }
    report.qualityCheckMs = performance.now() - reviewStarted;
    if (signal?.aborted) { report.status = "cancelled"; report.failure = "cancelled"; }
    report.elapsedMs = performance.now() - started;
    report.verification = labCompletion(report);
    emit({ type: "quality_review_finished", agent: "system", status: report.verification.quality.status,
      checks: report.qualityReviews.reduce((total, review) => total + review.checks, 0),
      passedChecks: report.qualityReviews.reduce((total, review) => total + review.passedChecks, 0), elapsedMs: report.qualityCheckMs });
    emit({ type: "run_finished", status: report.status });
    return report;
  } finally { await browser.close(); }
}

export async function writeDemoReplay(report, target, { reserved = false } = {}) {
  const html = await renderDemoPage({ report });
  const output = resolve(target);
  if (!reserved) { await mkdir(dirname(output), { recursive: true }); await mkdir(output, { mode: 0o700 }); }
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  await writeFile(join(output, "index.html"), html, { flag: "wx", mode: 0o600 });
  if (report.application?.html) await writeFile(join(output, "session-desk.html"), report.application.html, { flag: "wx", mode: 0o600 });
  if (report.controlApplication?.html) await writeFile(join(output, "session-desk-daleks.html"), report.controlApplication.html, { flag: "wx", mode: 0o600 });
  return { directory: output, replay: join(output, "index.html"), report: join(output, "report.json") };
}

async function main() {
  const { values } = parseArgs({ options: { report: { type: "string" }, "output-dir": { type: "string" }, help: { type: "boolean" }, "verify-build": { type: "boolean" } } });
  if (values.help) { console.log("node examples/demo-replay.mjs --report REPORT.json --output-dir NEW_DIRECTORY [--verify-build]. Browser checks require: npx --prefix examples playwright install chromium. MINDLEAK_BROWSER_EXECUTABLE may select an installed compatible browser."); return; }
  if (!values.report || !values["output-dir"]) throw new Error("replay_paths_required");
  const bytes = await readFile(resolve(values.report));
  if (bytes.length > 16 * 1024 * 1024) throw new Error("replay_report_budget");
  const report = JSON.parse(bytes);
  if (values["verify-build"]) {
    if (report.kind !== "swarm_build" || !report.application?.html && !report.controlApplication?.html) throw new Error("build_artifacts_required");
    report.qualityReviews = await verifyBuildArtifacts(report);
    report.verification = labCompletion(report);
    if (report.qualityReviews.some(review => review.passedChecks !== review.checks)) process.exitCode = 1;
  }
  console.log(JSON.stringify(await writeDemoReplay(report, values["output-dir"])));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(error.message === "browser_acceptance_unavailable_run_playwright_install_chromium" ? error.message : "replay_failed_check_recording_and_new_output_directory"); process.exitCode = 1; });
}
