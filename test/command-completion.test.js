import { test } from "node:test";
import assert from "node:assert/strict";
import { completeArguments, directorySearch } from "../adapters/opencode/command-completion.js";
import { argumentRange, argumentValue, applyArgumentEdit } from "../mods/unified-chat/completion.js";

function fixture() {
  let session = { id: "ses_owned", location: { directory: "/server/project" } };
  let active = true;
  const calls = [];
  const context = {
    data: { location: { command: { sync: async () => {}, list: () => [{ name: "review" }] } } },
    keymap: { commands: () => [
      { id: "session.cd", slash: { name: "cd", aliases: ["chdir"], arguments: true }, run: () => calls.push("MUST NOT RUN") },
      { id: "plugin.inspect", slash: { name: "inspect", arguments: true }, run: () => calls.push("MUST NOT RUN") },
      { id: "unavailable", slash: { name: "disabled", arguments: true }, enabled: false },
    ] },
    client: { file: { list: async (input) => {
      calls.push(input);
      return { location: input.location, data: [{ path: "Dir with spaces/", type: "directory" }, { path: "document.txt", type: "file" }, { path: ".hidden/", type: "directory" }] };
    } } },
  };
  return { context, calls, selected: () => { if (!active) throw new Error("Recipient changed"); return session; },
    setSession: (value) => { session = value; }, deactivate: () => { active = false; },
    complete(text, cursor) { return completeArguments(context, this.selected, { text, cursor }); } };
}

test("live /cd aliases use only server directories and preserve literal spaces without quoting", async () => {
  const f = fixture();
  const result = await f.complete("/chdir d");
  assert.equal(result.kind, "directory"); assert.equal(result.command.id, "session.cd");
  assert.deepEqual(result.items.map((item) => item.label), ["Dir with spaces/"]);
  assert.equal(applyArgumentEdit("/chdir d", result.items[0].edit), "/chdir Dir with spaces/");
  assert.deepEqual(f.calls, [{ location: { directory: "/server/project" }, path: "/server/project" }]);
});

test("server and plugin command arguments offer paths without executing commands or inventing enums", async () => {
  for (const command of ["review", "inspect"]) {
    const f = fixture(), text = `/${command} d`;
    const result = await f.complete(text);
    assert.equal(result.kind, "path");
    assert.deepEqual(result.items.map((item) => item.label), ["Dir with spaces/", "document.txt"]);
    assert.equal(applyArgumentEdit(text, result.items[0].edit), `/${command} "Dir with spaces/"`);
    assert.ok(!f.calls.includes("MUST NOT RUN"));
  }
});

test("completion replaces the selected argument and preserves later flags and quoted arguments", async () => {
  const f = fixture();
  const text = '/review --out="d" --message "keep 日本語 🌱"';
  const result = await f.complete(text, text.indexOf('d"') + 1);
  assert.equal(applyArgumentEdit(text, result.items[0].edit), '/review --out="Dir with spaces/" --message "keep 日本語 🌱"');
  const single = "/review 'd' later";
  const value = await f.complete(single, single.indexOf("d'") + 1);
  assert.equal(applyArgumentEdit(single, value.items[0].edit), "/review 'Dir with spaces/' later");
});

test("absolute/relative/parent directory navigation uses API-relative entry paths", async () => {
  const f = fixture();
  f.context.client.file.list = async (input) => {
    f.calls.push(input);
    return { location: input.location, data: [{ path: "../sibling/", type: "directory" }] };
  };
  const value = await f.complete("/cd ../s");
  assert.equal(f.calls[0].path, "/server"); assert.equal(value.items[0].label, "../sibling/");
  assert.equal(directorySearch("/srv/ref/di", "/server/project").directory, "/srv/ref");
  assert.equal(directorySearch("..", "/server/project").directory, "/server");
  assert.equal(directorySearch("C:\\work\\di", "C:\\project").directory, "C:\\work");
});

test("exact directories and dotfiles follow prefix filtering; result sets are bounded", async () => {
  const f = fixture();
  assert.ok(!(await f.complete("/cd ")).items.some((item) => item.label.includes("hidden")));
  assert.equal((await f.complete("/cd .")).items[0].label, ".hidden/");
  assert.equal((await f.complete("/cd ../")).items[0].edit.value, "../");
  f.context.client.file.list = async (input) => ({ location: input.location, data: Array.from({ length: 100 }, (_, index) => ({ path: `d${index}/`, type: "directory" })) });
  assert.equal((await f.complete("/cd d")).items.length, 50);
});

test("disabled, missing and non-argument commands never probe the filesystem", async () => {
  const f = fixture();
  for (const text of ["/disabled d", "/missing d", "/cd", "ordinary text"]) assert.deepEqual((await f.complete(text)).items, []);
  assert.equal(f.calls.length, 0);
});

test("argument-taking UI commands win live server-name conflicts, even through aliases", async () => {
  const f = fixture();
  f.context.data.location.command.list = () => [{ name: "chdir" }];
  assert.equal((await f.complete("/chdir d")).kind, "directory");
});

test("route changes during hydration/listing and same-session directory changes fail closed", async () => {
  for (const stage of ["sync", "list", "directory"]) {
    const f = fixture();
    if (stage === "sync") f.context.data.location.command.sync = async () => f.deactivate();
    else f.context.client.file.list = async (input) => {
      if (stage === "directory") f.setSession({ id: "ses_owned", location: { directory: "/different" } });
      else f.deactivate();
      return { location: input.location, data: [] };
    };
    await assert.rejects(f.complete("/cd d"), stage === "directory" ? /directory changed/ : /Recipient changed/);
  }
});

test("API failures propagate, invalid cursors fail, stale edits cannot overwrite newer drafts", async () => {
  const f = fixture();
  await assert.rejects(f.complete("/cd d", 1), /cursor/);
  assert.equal(argumentRange("/review 🌱", "/review ".length + 1), null);
  const [item] = (await f.complete("/cd d")).items;
  assert.throws(() => applyArgumentEdit("/cd newer", item.edit), /Draft changed/);
  f.context.client.file.list = async () => { throw new Error("server unavailable"); };
  await assert.rejects(f.complete("/cd d"), /server unavailable/);
});

test("remote home is never inferred from the local client's environment", async () => {
  const f = fixture();
  const value = await f.complete("/cd ~/d");
  assert.match(value.reason, /no local home directory was guessed/);
  assert.equal(f.calls.length, 0);
});

test("completed generic path tokens quote metacharacters without evaluating them", () => {
  assert.equal(argumentValue("a;literal|name", { directory: false, quote: "" }), '"a;literal|name"');
  assert.equal(argumentValue("$(literal)`name`", { directory: false, quote: "" }), '"\\$(literal)\\`name\\`"');
  assert.equal(argumentValue("a'b", { directory: false, quote: "'" }), "'a'\\''b'");
  assert.equal(argumentValue("a;literal|name/", { directory: true }), "a;literal|name/");
  assert.equal(argumentRange("/review 'a'\\''b'").query, "a'b");
  assert.equal(argumentRange('/review "Dir with spaces/"').query, "Dir with spaces/");
});
