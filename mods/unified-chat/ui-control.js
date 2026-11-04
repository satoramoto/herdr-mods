import { exec, appHome, writeTextFile } from "herdr";

export async function requestControl(target, input) {
  const helper = `${appHome()}/mods/unified-chat/opencode-control.mjs`;
  const request = JSON.stringify({ ...input, version: 1, terminalID: target.address, sessionID: target.sessionID });
  let argv = [helper, target.bridge.path, request];
  if (["submit", "complete-arguments", "form-reply", "permission-reply"].includes(input.action) || request.length > 16000) {
    const prepared = await exec("node", [helper, "--prepare", appHome()]);
    if (prepared.code !== 0) throw new Error("Private request storage is unavailable. Nothing was sent.");
    const directory = JSON.parse(prepared.stdout).directory;
    const path = `${directory}/request-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    await writeTextFile(path, request, null);
    argv = [helper, "--request-file", path, target.bridge.path];
  }
  const result = await exec("node", argv);
  if (result.code !== 0) throw new Error(result.stderr?.trim() || "OpenCode control failed. Inspect before retrying.");
  return JSON.parse(result.stdout);
}
