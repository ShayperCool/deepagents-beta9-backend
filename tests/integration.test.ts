import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createDeepAgent, isSandboxBackend } from "deepagents";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { Beta9Sandbox, configureBeta9, Image } from "../src/index.ts";

const enabled = Boolean(process.env.BETA9_TOKEN && process.env.BETA9_WORKSPACE_ID && process.env.BETA9_GATEWAY_URL);

class ScriptedToolModel extends BaseChatModel {
  private calls = 0;

  _llmType(): string {
    return "scripted-beta9-test";
  }

  bindTools(): this {
    return this;
  }

  async _generate() {
    const message = this.calls++ === 0
      ? new AIMessage({
          content: "",
          tool_calls: [{
            name: "execute",
            args: { command: "printf 'from-deepagents\\n'" },
            id: "beta9-test-call",
          }],
        })
      : new AIMessage("connected");
    return { generations: [{ message, text: String(message.content) }] };
  }
}

describe.skipIf(!enabled)("live Beta9 sandbox", () => {
  let backend: Beta9Sandbox;

  beforeAll(async () => {
    configureBeta9({
      token: process.env.BETA9_TOKEN!,
      workspaceId: process.env.BETA9_WORKSPACE_ID!,
      gatewayUrl: process.env.BETA9_GATEWAY_URL!,
      timeoutMs: 600_000,
    });
    backend = await Beta9Sandbox.create({
      name: `deepagents-beta9-test-${Date.now()}`,
      image: new Image({
        pythonVersion: "python3.11",
        commands: ["printf beam-js-beta9 > /opt/beam-js-marker"],
      }),
      cpu: 1,
      memory: 1024,
      keepWarmSeconds: 300,
    });
  }, 180_000);

  afterAll(async () => {
    if (backend) await backend.terminate();
  }, 60_000);

  test("connects through Deep Agents and executes a shell command", async () => {
    expect(isSandboxBackend(backend)).toBe(true);
    const response = await backend.execute("printf 'beta9-ok\\n'");
    expect(response).toEqual({ output: "beta9-ok\n", exitCode: 0, truncated: false });
    const agent = createDeepAgent({
      model: new ScriptedToolModel({}),
      backend,
    });
    // Deep Agents 1.13.4 narrows `messages` to `never` in this inferred model type.
    const input = { messages: [new HumanMessage("Say connected")] };
    const result = await agent.invoke(input as unknown as Parameters<typeof agent.invoke>[0]);
    expect(result.messages.at(-1)?.content).toBe("connected");
    expect(result.messages.some((message) => String(message.content).includes("from-deepagents"))).toBe(true);
  }, 120_000);

  test("returns exit status and stderr", async () => {
    const response = await backend.execute("printf 'problem\\n' >&2; exit 23");
    expect(response).toEqual({ output: "problem\n", exitCode: 23, truncated: false });
  }, 120_000);

  test("uploads, downloads, and reconnects with the same filesystem", async () => {
    const path = "/tmp/deepagents-beta9-file.txt";
    const bytes = Buffer.from("Beta9 file round trip: 42\n", "utf8");
    expect(await backend.uploadFiles([[path, bytes]])).toEqual([{ path, error: null }]);
    const connected = await Beta9Sandbox.connect(backend.id);
    const downloaded = await connected.downloadFiles([path]);
    expect(downloaded[0]?.error).toBeNull();
    expect(Buffer.from(downloaded[0]!.content!).equals(bytes)).toBe(true);
    const read = await connected.read(path);
    expect(JSON.stringify(read)).toContain("Beta9 file round trip: 42");
  }, 120_000);

  test("reassembles output and downloaded file exactly beyond 4 MiB", async () => {
    const path = "/tmp/deepagents-beta9-large.bin";
    // Deterministic binary with zero and non-ASCII bytes. Keep the file inside Beta9.
    const generate = await backend.execute(
      `python3 -c 'import hashlib; p=${JSON.stringify(path)}; f=open(p,"wb"); [f.write(hashlib.sha256(str(i).encode()).digest()) for i in range(170000)]; f.close()'`,
    );
    expect(generate.exitCode).toBe(0);
    const original = await backend.downloadFiles([path]);
    expect(original[0]?.error).toBeNull();
    const bytes = original[0]!.content!;
    expect(bytes.length).toBe(5_440_000);
    const expectedHash = createHash("sha256").update(bytes).digest("hex");

    const response = await backend.execute(`cat ${path}`);
    expect(response.exitCode).toBe(0);
    // Shell output is UTF-8 text, so compare byte-perfect data through base64.
    const encoded = await backend.execute(`base64 ${path} | tr -d '\\n'`);
    expect(encoded.exitCode).toBe(0);
    expect(encoded.truncated).toBe(false);
    const restored = Buffer.from(encoded.output, "base64");
    expect(restored.equals(bytes)).toBe(true);
    expect(createHash("sha256").update(restored).digest("hex")).toBe(expectedHash);
  }, 300_000);

  test.skipIf(process.env.BETA9_PROBE_DIRECT !== "1")(
    "probes whether this Beta9 gateway accepts a direct 5 MiB exec response",
    async () => {
      const process = await backend.sandbox.exec(
        ["python3", "-c", "print('x' * 5_000_000, end='')"],
        { wait: true },
      );
      expect(await process.wait()).toBe(0);
      const output = await process.stdout.read();
      expect(Buffer.byteLength(output)).toBe(5_000_000);
    },
    120_000,
  );
});
