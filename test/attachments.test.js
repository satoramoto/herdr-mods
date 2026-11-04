import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, unlink, rm, symlink } from "node:fs/promises";
import { captureFiles, hydrateParts, previewAttachment } from "../mods/unified-chat/attachments.mjs";

test("dropped files are captured immutably and hydrated as bytes for the actual server connection", async () => {
  const home = await mkdtemp("/tmp/opencode/unified-chat-attachments-test-");
  try {
    const path = `${home}/file with 'quotes'.txt`;
    await writeFile(path, "snapshot data");
    const [part] = await captureFiles([path], home);
    await unlink(path);
    const [hydrated] = await hydrateParts([part]);
    assert.equal((await previewAttachment(part)).text, "snapshot data");
    assert.equal(hydrated.name, "file with 'quotes'.txt");
    assert.equal(hydrated.uri, `data:text/plain;base64,${Buffer.from("snapshot data").toString("base64")}`);
    assert.ok(!hydrated.capture);
    await writeFile(part.capture.path, "tampered");
    await assert.rejects(hydrateParts([part]), /changed/);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("explicitly chosen source symlinks are snapshotted, while forged cache references are rejected", async () => {
  const home = await mkdtemp("/tmp/opencode/unified-chat-attachments-test-");
  try {
    await writeFile(`${home}/target`, "data"); await symlink(`${home}/target`, `${home}/link`);
    const [part] = await captureFiles([`${home}/link`], home);
    assert.equal((await hydrateParts([part]))[0].uri, "data:application/octet-stream;base64,ZGF0YQ==");
    await assert.rejects(hydrateParts([{ capture: { path: "/etc/passwd", hash: "x" } }]), /Invalid captured/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
