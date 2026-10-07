// Lists dependencies whose latest release is a new major version, per npm folder.
// Used by .github/workflows/dependency-report.yml; prints a Markdown table (empty if none).
/* global process, console */
import { execSync } from "node:child_process";
const dirs = process.argv.slice(2);
const rows = [];
for (const dir of dirs) {
  let out = "{}";
  try {
    out = execSync("npm outdated --json --long", { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch (e) {
    out = (e.stdout || "").toString() || "{}"; // npm outdated exits 1 when anything is outdated
  }
  for (const [name, v] of Object.entries(JSON.parse(out || "{}"))) {
    const major = (x) => parseInt(String(x || "").replace(/^[^\d]*/, ""), 10);
    if (v.current && v.latest && major(v.latest) > major(v.current)) {
      rows.push(`| \`${dir}\` | ${name} | ${v.current} | ${v.latest} | ${v.type === "devDependencies" ? "dev" : "prod"} |`);
    }
  }
}
if (rows.length) {
  console.log("| Folder | Package | Current | Latest | Type |\n|---|---|---|---|---|\n" + rows.join("\n"));
}
