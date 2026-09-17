import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { normalizeRecording } from "./demo-view.mjs";

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
  const { values } = parseArgs({ options: { report: { type: "string" }, "output-dir": { type: "string" }, help: { type: "boolean" } } });
  if (values.help) { console.log("node examples/demo-replay.mjs --report REPORT.json --output-dir NEW_DIRECTORY"); return; }
  if (!values.report || !values["output-dir"]) throw new Error("replay_paths_required");
  const bytes = await readFile(resolve(values.report));
  if (bytes.length > 16 * 1024 * 1024) throw new Error("replay_report_budget");
  console.log(JSON.stringify(await writeDemoReplay(JSON.parse(bytes), values["output-dir"])));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(() => { console.error("replay_failed_check_recording_and_new_output_directory"); process.exitCode = 1; });
}
