import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

const evidenceDir = path.dirname(fileURLToPath(import.meta.url));
if (!process.argv[2] || !process.argv[3]) {
  console.error(
    "Usage: node kimi-bridge-smoke.mjs /path/to/bb kimi [/path/to/result.json]",
  );
  process.exit(2);
}
const repo = path.resolve(process.argv[2]);
const kimiExecutable = process.argv[3];
const outputPath = path.resolve(
  process.argv[4] ?? path.join(evidenceDir, "kimi-runtime-validation.json"),
);
const sdkPackage = JSON.parse(
  await readFile(
    path.join(
      repo,
      "packages/provider-bridge-acp/node_modules/@agentclientprotocol/sdk/package.json",
    ),
    "utf8",
  ),
);
const bridgeSource = "packages/provider-bridge-acp/src/bridge/bridge.ts";
const kimiVersion = execFileSync(kimiExecutable, ["--version"], {
  encoding: "utf8",
}).trim();
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
const sourceDirty =
  execFileSync("git", ["status", "--porcelain"], {
    cwd: repo,
    encoding: "utf8",
  }).trim().length > 0;
const bridgeSourceSha256 = createHash("sha256")
  .update(await readFile(path.join(repo, bridgeSource)))
  .digest("hex");
const tempRoot = await mkdtemp(path.join(tmpdir(), "bb-kimi-smoke-"));
const home = path.join(tempRoot, "home");
const cwd = path.join(tempRoot, "workspace");
await mkdir(home);
await mkdir(cwd);
const report = {
  startedAt: new Date().toISOString(),
  kimiVersion,
  sdkVersion: sdkPackage.version,
  provider: "Deterministic local OpenAI-compatible mock on 127.0.0.1",
  remoteModelCalls: 0,
  httpRequests: [],
  rpcOutcomes: [],
  permissions: [],
  sourceCommit,
  sourceDirty,
  bridgeSource,
  bridgeSourceSha256,
  bbPermissionMode: "accept-edits",
  kimiConfiguredPermissionMode: "yolo",
  assertions: {},
  stderr: "",
  passed: false,
};
const sanitize = (value) =>
  JSON.parse(
    JSON.stringify(value)
      .replaceAll(home, "<isolated-kimi-home>")
      .replaceAll(cwd, "<isolated-workspace>")
      .replaceAll(tempRoot, "<isolated-root>")
      .replaceAll(repo, "<bb-repository>"),
  );
const toolSent = new Set();
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const messages = body.messages ?? [];
  const selectedUser = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "user" &&
        JSON.stringify(message.content).includes("BRIDGE_SMOKE_"),
    );
  const input = JSON.stringify(selectedUser?.content ?? "");
  const kind = input.includes("BRIDGE_SMOKE_RESUME")
    ? "resume"
    : input.includes("BRIDGE_SMOKE_DENY")
      ? "deny"
      : input.includes("BRIDGE_SMOKE_ALLOW")
        ? "allow"
        : "text";
  const historyChecks = {
    initialAssistantResponse: messages.some(
      (message) =>
        message.role === "assistant" &&
        JSON.stringify(message.content).includes("BRIDGE_SMOKE_TEXT_OK"),
    ),
    deniedTurnAssistantResponse: messages.some(
      (message) =>
        message.role === "assistant" &&
        JSON.stringify(message.content).includes("BRIDGE_SMOKE_DENY_DONE"),
    ),
    allowedTurnAssistantResponse: messages.some(
      (message) =>
        message.role === "assistant" &&
        JSON.stringify(message.content).includes("BRIDGE_SMOKE_ALLOW_DONE"),
    ),
    deniedToolResult: messages.some(
      (message) =>
        message.role === "tool" && message.tool_call_id === "call_bridge_deny",
    ),
    allowedToolResult: messages.some(
      (message) =>
        message.role === "tool" && message.tool_call_id === "call_bridge_allow",
    ),
  };
  const historySeen = Object.values(historyChecks).every(Boolean);
  let content = "BRIDGE_SMOKE_TEXT_OK";
  let toolCalls;
  if (kind === "resume")
    content = historySeen
      ? "BRIDGE_SMOKE_HISTORY_SEEN"
      : "BRIDGE_SMOKE_HISTORY_MISSING";
  else if (kind === "deny" || kind === "allow") {
    if (!toolSent.has(kind)) {
      toolSent.add(kind);
      content = null;
      toolCalls = [
        {
          index: 0,
          id: `call_bridge_${kind}`,
          type: "function",
          function: {
            name: "Bash",
            arguments: JSON.stringify({
              command: `printf 'BRIDGE_SMOKE_FILE_OK\\n' > bridge-${kind}-marker.txt`,
              timeout: 10,
            }),
          },
        },
      ];
    } else content = `BRIDGE_SMOKE_${kind.toUpperCase()}_DONE`;
  }
  report.httpRequests.push({
    method: req.method,
    path: req.url,
    model: body.model,
    stream: body.stream,
    messageRoles: messages.map((message) => message.role),
    advertisedTools: (body.tools ?? []).map((tool) => tool.function?.name),
    response: toolCalls ? "tool_call:Bash" : content,
    kind,
    historySeen,
    historyChecks,
  });
  if (!req.url?.includes("chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { message: "Mock supports only chat/completions" },
      }),
    );
    return;
  }
  const common = {
    id: "chatcmpl-local-smoke",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
  };
  if (body.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const delta = toolCalls
      ? { role: "assistant", tool_calls: toolCalls }
      : { role: "assistant", content };
    res.write(
      `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
    );
    res.end("data: [DONE]\n\n");
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ...common,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content,
              ...(toolCalls ? { tool_calls: toolCalls } : {}),
            },
            finish_reason: toolCalls ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      }),
    );
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await writeFile(
  path.join(home, "config.toml"),
  `defaultModel = "fake"
telemetry = false
autoSessionTitle = false
default_permission_mode = "yolo"
[models.fake]
name = "fake-model"
protocol = "openai"
baseUrl = "http://127.0.0.1:${port}/v1"
apiKey = "local-smoke-placeholder"
maxContextSize = 32768
capabilities = ["tool_use"]
`,
);
const pluginData = path.join(tempRoot, "plugin-data");
await mkdir(pluginData);
const bridgeEntry = path.join(
  repo,
  "packages/provider-bridge-protocol/src/bridge-worker-entry.ts",
);
const bridgeModule = path.join(
  repo,
  "packages/provider-bridge-acp/src/bridge/bridge.ts",
);
const isolatedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !/^(KIMI_|OPENAI_|ANTHROPIC_|MOONSHOT_)/.test(key),
  ),
);
Object.assign(isolatedEnvironment, {
  HOME: home,
  USERPROFILE: home,
  KIMI_CODE_HOME: home,
  NO_PROXY: "127.0.0.1,localhost",
});
const child = spawn(
  process.execPath,
  [
    "--import",
    path.join(repo, "node_modules/tsx/dist/loader.mjs"),
    bridgeEntry,
    bridgeModule,
    "provider-acp",
    pluginData,
  ],
  { cwd: repo, env: isolatedEnvironment, stdio: "pipe" },
);
let spawnError;
child.on("error", (error) => {
  spawnError = error;
});
child.stderr.on("data", (chunk) => {
  report.stderr += chunk.toString();
});
const messages = [];
let decision = "deny";
createInterface({ input: child.stdout }).on("line", (line) => {
  try {
    const message = JSON.parse(line);
    messages.push(message);
    if (message.method === "interaction/request" && message.id !== undefined) {
      report.permissions.push({ decision });
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { decision, grantedPermissions: null },
        }) + "\n",
      );
    }
  } catch (error) {
    report.stderr += `Unparsed bridge stdout: ${line}\n${String(error)}\n`;
  }
});
const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
let serial = 1;
async function waitFor(check, description) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = check();
    if (result !== undefined) return result;
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Bridge exited: ${report.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${description}`);
}
async function request(method, params) {
  const id = serial++;
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
  );
  const response = await waitFor(
    () =>
      messages.find(
        (message) => message.id === id && message.method === undefined,
      ),
    method,
  );
  report.rpcOutcomes.push({
    method,
    status: response.error ? "failed" : "passed",
    result: sanitize(response.result ?? response.error),
  });
  if (response.error)
    throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  return response.result;
}
const options = {
  permissionMode: "accept-edits",
  permissionScope: "workspace",
  approvalReviewer: "user",
  permissionEscalation: "ask",
  envVars: { KIMI_CODE_HOME: home },
  providerOptions: {
    acpDialect: "kimi",
    acpLaunchSpec: {
      displayName: "Kimi Code",
      command: kimiExecutable,
      args: ["acp"],
      env: { KIMI_CODE_HOME: home },
    },
  },
};
const threadId = "bb-kimi-runtime-smoke";
const boundaryCount = () =>
  messages
    .flatMap((message) => message.params?.deltas ?? [])
    .filter((delta) => delta.kind === "turn.boundary").length;
const textSeen = (text) =>
  messages.some((message) =>
    JSON.stringify(message.params?.deltas ?? []).includes(text),
  );
async function turn(providerThreadId, text) {
  const before = boundaryCount();
  await request("turn/start", {
    threadId,
    providerThreadId,
    clientRequestId: `creq_${String(serial).padStart(10, "2")}`,
    options,
    input: [{ type: "text", text, mentions: [] }],
  });
  await waitFor(
    () => (boundaryCount() > before ? true : undefined),
    `turn completion: ${text}`,
  );
}
try {
  await request("initialize", {
    protocolVersion: 2,
    client: { name: "bb-bridge-smoke", version: "1.0.0" },
    grammarVersions: [3, 3],
  });
  const fresh = await request("thread/start", {
    threadId,
    cwd,
    instructionMode: "append",
    options,
  });
  await turn(fresh.providerThreadId, "BRIDGE_SMOKE_TEXT");
  report.assertions.textReceivedThroughBbBridge = textSeen(
    "BRIDGE_SMOKE_TEXT_OK",
  );
  decision = "deny";
  const beforeDeny = report.permissions.length;
  await turn(fresh.providerThreadId, "BRIDGE_SMOKE_DENY");
  report.assertions.denialReachedBbRuntime =
    report.permissions.length > beforeDeny;
  report.assertions.deniedMarkerAbsent = await readFile(
    path.join(cwd, "bridge-deny-marker.txt"),
    "utf8",
  ).then(
    () => false,
    (error) => {
      if (error.code !== "ENOENT") throw error;
      return true;
    },
  );
  decision = "allow_once";
  const beforeAllow = report.permissions.length;
  await turn(fresh.providerThreadId, "BRIDGE_SMOKE_ALLOW");
  report.assertions.approvalReachedBbRuntime =
    report.permissions.length > beforeAllow;
  report.assertions.allowedMarkerPresent =
    (await readFile(path.join(cwd, "bridge-allow-marker.txt"), "utf8")) ===
    "BRIDGE_SMOKE_FILE_OK\n";
  await request("thread/stop", {
    threadId,
    providerThreadId: fresh.providerThreadId,
    intent: "release",
    activeTurnId: null,
  });
  const resumed = await request("thread/resume", {
    threadId,
    cwd,
    instructionMode: "append",
    options,
    providerThreadId: fresh.providerThreadId,
  });
  report.assertions.sameSessionResumed =
    resumed.providerThreadId === fresh.providerThreadId;
  await turn(resumed.providerThreadId, "BRIDGE_SMOKE_RESUME");
  report.assertions.nonemptyHistorySurvivesBbResume = textSeen(
    "BRIDGE_SMOKE_HISTORY_SEEN",
  );
  const resumeRequest = report.httpRequests.findLast(
    (entry) => entry.kind === "resume",
  );
  for (const [name, preserved] of Object.entries(
    resumeRequest?.historyChecks ?? {},
  )) {
    report.assertions[`resumePreserves_${name}`] = preserved;
  }
  await request("thread/stop", {
    threadId,
    providerThreadId: resumed.providerThreadId,
    intent: "release",
    activeTurnId: null,
  });
  report.passed = Object.values(report.assertions).every(Boolean);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = String(error);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  try {
    const exit = new Promise((resolve) => {
      if (spawnError || child.exitCode !== null || child.signalCode !== null)
        resolve();
      else child.once("exit", resolve);
    });
    child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exit;
    clearTimeout(kill);
    await new Promise((resolve) => server.close(resolve));
    report.stderr = sanitize(report.stderr);
    report.finishedAt = new Date().toISOString();
    report.limitations = [
      "Uses actual BB ACP bridge worker, Kimi CLI and SDK with deterministic localhost model responses; no paid inference or UI launch.",
      "Only harmless marker-file shell commands in an isolated temporary workspace were requested.",
    ];
    const summary = {
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      versions: {
        kimi: report.kimiVersion,
        acpSdk: report.sdkVersion,
        node: process.version,
      },
      source: {
        baselineCommit: report.sourceCommit,
        dirty: report.sourceDirty,
        bridgePath: report.bridgeSource,
        bridgeSha256: report.bridgeSourceSha256,
      },
      fixture: {
        provider: report.provider,
        kimiConfiguredPermissionMode: report.kimiConfiguredPermissionMode,
        bbPermissionMode: report.bbPermissionMode,
      },
      passed: report.passed,
      assertions: report.assertions,
      counts: {
        localHttpRequests: report.httpRequests.length,
        remoteModelCalls: 0,
        approvalRequests: report.permissions.length,
      },
      limitations: report.limitations,
      ...(report.error ? { error: sanitize(report.error) } : {}),
    };
    await writeFile(outputPath, JSON.stringify(summary, null, 2) + "\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify(
    {
      passed: report.passed,
      httpRequests: report.httpRequests.length,
      permissions: report.permissions.length,
      assertions: report.assertions,
      error: report.error,
      result: outputPath,
    },
    null,
    2,
  ),
);
