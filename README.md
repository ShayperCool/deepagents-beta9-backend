# deepagents-beta9-backend

Beta9 sandbox backend for [Deep Agents JavaScript](https://docs.langchain.com/oss/javascript/deepagents/sandboxes). It runs on Bun and uses `@beamcloud/beam-js` as the Beta9 transport client.

## Install

The GitHub release includes a ready-to-install package archive:

```sh
bun add https://github.com/ShayperCool/deepagents-beta9-backend/releases/download/v0.1.0/deepagents-beta9-backend-0.1.0.tgz deepagents
```

To work from a checkout, run `bun install && bun run build`, then add the checkout's absolute path to your application.

## Use

```ts
import { createDeepAgent } from "deepagents";
import { Beta9Sandbox, configureBeta9, Image } from "deepagents-beta9-backend";

configureBeta9({
  token: process.env.BETA9_TOKEN!,
  workspaceId: process.env.BETA9_WORKSPACE_ID!,
  gatewayUrl: process.env.BETA9_GATEWAY_URL!,
});

const backend = await Beta9Sandbox.create({
  name: "my-deep-agent",
  image: new Image({ pythonVersion: "python3.11" }),
  cpu: 1,
  memory: 1024,
  keepWarmSeconds: 300,
});

try {
  const agent = createDeepAgent({
    model: "openai:gpt-5.5",
    backend,
  });
  const input = {
    messages: [{ role: "user", content: "Run pwd in the sandbox" }],
  } as unknown as Parameters<typeof agent.invoke>[0];
  const result = await agent.invoke(input);
  console.log(result.messages.at(-1)?.content);
} finally {
  await backend.terminate();
}
```

Use `Beta9Sandbox.connect(id)` to resume an existing sandbox. The caller controls sandbox creation and termination. `configureBeta9` sets the Beam JS client's process-wide options, so call it once before using the backend. Beta9's gateway URL must point to its HTTP API, usually port 1994.

`Beta9Sandbox` extends Deep Agents' `BaseSandbox`. Deep Agents gets `execute`, `ls`, `read_file`, `write_file`, `edit_file`, `glob`, and `grep` through that contract. The input cast works around a `deepagents@1.13.4` type inference issue in `agent.invoke`; it has no runtime effect.

## Large output

Beta9's upstream worker [raised one gRPC limit to 16 MiB](https://github.com/beam-cloud/beta9/commit/555800c3), but the installed gateway still rejects a direct 5 MiB `exec` response with a 4 MiB receive limit. This backend redirects combined stdout and stderr to a temporary file inside the sandbox, then reads it in 1 MiB chunks. It checks every chunk length, reassembles the bytes, decodes UTF-8, and removes the temporary file. `downloadFiles` uses the same bounded reader. `ExecuteResponse.truncated` stays `false` when all chunks arrive.

The temporary file needs enough free space for the command output. `execute` returns text; use `downloadFiles` for byte-exact binary content.

## Verify against self-hosted Beta9

```sh
bun install
bun run build
export BETA9_GATEWAY_URL=https://your-beta9-gateway.example
export BETA9_TOKEN=...
export BETA9_WORKSPACE_ID=...
bun run test:integration
```

The gateway URL must point to Beta9's HTTP API. The tests skip when these three environment variables are absent. Obtain a token and workspace ID through your own Beta9 deployment; do not commit the token.

Set `BETA9_PROBE_DIRECT=1` to run an additional diagnostic test for direct 5 MiB `exec`. It failed on the Beta9 gateway used for development with `ResourceExhausted`; the default test suite leaves it skipped because the backend does not depend on direct large responses.
