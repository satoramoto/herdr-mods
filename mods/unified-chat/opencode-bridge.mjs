// External Node adapter: read-only, authenticated/discovered via OpenCode's CLI.
// The native mod itself has no Node runtime. No config or session mutations.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectOpenCode } from "./metadata.js";

const sessionID = process.argv[2];
if (!/^ses_[a-zA-Z0-9]+$/.test(sessionID ?? "")) throw new Error("Invalid reported OpenCode session ID.");
const exec = promisify(execFile);
async function get(path) {
  const { stdout } = await exec("opencode", ["api", "get", path], { timeout: 12000, maxBuffer: 16 * 1024 * 1024 });
  let response;
  try { response = JSON.parse(stdout); }
  catch { throw new Error(`Incomplete OpenCode API response for ${path.split("?")[0]}.`); }
  if (response.data == null) throw new Error("OpenCode API returned no data.");
  return response.data;
}
try {
  const session = await get(`/api/session/${sessionID}`);
  const [models, messages] = await Promise.all([
    get(`/api/model?location[directory]=${encodeURIComponent(session.location.directory)}`).catch(() => []),
    get(`/api/session/${sessionID}/message?type=assistant&order=desc&limit=3`).catch(() => []),
  ]);
  console.log(JSON.stringify(inspectOpenCode(session, models, messages)));
} catch (error) {
  console.error(String(error.message ?? error));
  process.exitCode = 1;
}
