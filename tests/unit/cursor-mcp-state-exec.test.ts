/**
 * Cursor agent (2026.10 builds) sends ExecServerMessage.mcp_state_exec_args (field 36)
 * before invoking a declared MCP tool, preceded by a span_context (field 19). OmniRoute
 * must decode the real variant and answer with mcp_state_exec_result, or the turn stalls
 * on heartbeats until the client times out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeExecServerEvent,
  encodeExecMcpStateResult,
  jsonSchemaToProtobufValue,
} from "../../open-sse/utils/cursorAgentProtobuf";
import { iterateConnectFrames } from "../../open-sse/utils/cursorAgentProtobuf";
import { decodeFields } from "../../open-sse/utils/cursorAgentProtobuf/wire";
import { newStreamCtx, processFrame } from "../../open-sse/executors/cursor";

// AgentServerMessage captured from api2.cursor.sh on 2026-10-05:
// exec_server_message { id: 1, span_context (19) {...}, mcp_state_exec_args (36) {
//   server_identifiers: ["omniroute"] }, accept_hook_additional_contexts (55): false }
const CAPTURED_MCP_STATE_FRAME = Buffer.from(
  "124c08019a01360a2035643966646435323964343435353930623239363434653430383234306134661210" +
    "363765643565633635386264386163321800a2020b0a096f6d6e69726f757465b80300",
  "hex"
);

const weatherTool = {
  name: "get_weather",
  description: "Get weather for a city",
  inputSchemaBytes: jsonSchemaToProtobufValue({
    type: "object",
    properties: { city: { type: "string" } },
  }),
  providerIdentifier: "omniroute",
  toolName: "get_weather",
};

function field(buf: Buffer, n: number): Buffer {
  const f = decodeFields(buf).find((entry) => entry.fieldNumber === n);
  assert.ok(f && "bytes" in f, `field ${n} missing`);
  return (f as { bytes: Buffer }).bytes;
}

test("decodes mcp_state_exec_args behind a leading span_context", () => {
  assert.deepEqual(decodeExecServerEvent(CAPTURED_MCP_STATE_FRAME), {
    kind: "exec_mcp_state",
    execMsgId: 1,
    execId: "",
    serverIdentifiers: ["omniroute"],
  });
});

test("encodes mcp_state_exec_result with the declared tools", () => {
  const [frame] = [
    ...iterateConnectFrames(encodeExecMcpStateResult(1, "", ["omniroute"], [weatherTool])),
  ];
  const payload =
    (frame as { payload?: Buffer; data?: Buffer }).payload ?? (frame as { data: Buffer }).data;
  const ecm = field(payload, 2); // AgentClientMessage.exec_client_message
  const result = field(ecm, 36); // ExecClientMessage.mcp_state_exec_result
  const success = field(result, 1); // McpStateExecResult.success
  const server = field(success, 1); // McpStateSuccess.servers[0]
  assert.equal(field(server, 1).toString("utf8"), "omniroute");
  assert.equal(field(server, 2).toString("utf8"), "omniroute");
  assert.equal(field(field(server, 5), 1).toString("utf8"), "get_weather");
});

test("processFrame answers mcp_state requests instead of stalling", () => {
  const writes: Buffer[] = [];
  const h2Req = { write: (chunk: Buffer) => writes.push(chunk) } as never;
  const ctx = newStreamCtx();
  processFrame(CAPTURED_MCP_STATE_FRAME, ctx, new Set(), { h2Req, mcpTools: [weatherTool] });
  assert.equal(writes.length, 1);
  assert.equal(ctx.endReason, null);
});
