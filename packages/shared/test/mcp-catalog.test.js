import test from "node:test";
import assert from "node:assert/strict";
import {
  MCP_CATALOG,
  catalogEntry,
  isSensitiveTool,
  isSensitiveToolName,
} from "../src/mcp-catalog.ts";

test("catalog entries ship verified and pre-tagged", () => {
  assert.ok(MCP_CATALOG.length >= 1);
  for (const e of MCP_CATALOG) {
    assert.match(e.url, /^https:\/\//);
    assert.ok(Array.isArray(e.sensitiveTools));
  }
  assert.equal(catalogEntry("outagedeck")?.name, "OutageDeck");
  assert.equal(catalogEntry("nope"), null);
});

test("reads sail through, writes ask", () => {
  assert.equal(isSensitiveToolName("get_provider_status"), false);
  assert.equal(isSensitiveToolName("list_active_incidents"), false);
  for (const name of [
    "delete_all",
    "remove_custom_provider",
    "spend_credits",
    "update_billing",
    "subscribe_feed",
    "watch_provider",
    "grant_admin",
    "share_report",
    "send_alerts",
    "publish_post",
  ]) {
    assert.equal(isSensitiveToolName(name), true, name);
  }
});

test("hints and tags gate, unknown means ask", () => {
  assert.equal(
    isSensitiveTool("get_x", { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, []),
    false,
  );
  assert.equal(isSensitiveTool("rename_x", { openWorldHint: true }, []), true);
  assert.equal(isSensitiveTool("drop_x", { destructiveHint: true }, []), true);
  assert.equal(isSensitiveTool("watch_provider", { readOnlyHint: false }, ["watch_provider"]), true);
  assert.equal(isSensitiveTool("mystery_tool", undefined, []), true);
});
