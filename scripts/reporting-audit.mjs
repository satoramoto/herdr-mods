import { execFileSync } from "node:child_process";
import { reportingHealth } from "../adapters/reporting.js";
const call = (args) => JSON.parse(execFileSync("herdr-core", args, { encoding: "utf8", timeout: 10000 }));
// Fail before querying terminals if core is unavailable; never start a core.
call(["server", "status"]);
const results = call(["ls"]).terminals.filter((t) => t.state === "live")
  .map((t) => reportingHealth(call(["get", t.address])));
console.log(JSON.stringify(results, null, 2));
