import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { beamOpts, Image, Sandbox, type SandboxInstance } from "@beamcloud/beam-js";
import {
  BaseSandbox,
  type ExecuteResponse,
  type FileDownloadResponse,
  type FileOperationError,
  type FileUploadResponse,
} from "deepagents";

const CHUNK_SIZE = 1024 * 1024;

class IncompleteFileReadError extends Error {}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function fileError(error: unknown): FileOperationError {
  const message = String(error).toLowerCase();
  if (message.includes("permission") || message.includes("denied")) return "permission_denied";
  if (message.includes("directory") || message.includes("isdir")) return "is_directory";
  if (message.includes("invalid path")) return "invalid_path";
  return "file_not_found";
}

/** Set the global Beam JS client to a Beta9 gateway. Call before creating a sandbox. */
export function configureBeta9(options: {
  token: string;
  workspaceId: string;
  gatewayUrl: string;
  timeoutMs?: number;
}): void {
  beamOpts.token = options.token;
  beamOpts.workspaceId = options.workspaceId;
  beamOpts.gatewayUrl = options.gatewayUrl;
  if (options.timeoutMs !== undefined) beamOpts.timeout = options.timeoutMs;
}

export interface Beta9SandboxOptions {
  /** An already-created Beta9 sandbox from @beamcloud/beam-js. */
  sandbox: SandboxInstance;
}

/** Deep Agents sandbox backend backed by a Beta9 sandbox. */
export class Beta9Sandbox extends BaseSandbox {
  readonly id: string;
  readonly sandbox: SandboxInstance;

  constructor({ sandbox }: Beta9SandboxOptions) {
    super();
    this.sandbox = sandbox;
    this.id = sandbox.sandboxId;
  }

  /** Create a Beta9 sandbox and wrap it. The caller owns its lifecycle. */
  static async create(config: ConstructorParameters<typeof Sandbox>[0]): Promise<Beta9Sandbox> {
    return new Beta9Sandbox({ sandbox: await new Sandbox(config).create() });
  }

  /** Reconnect to a sandbox by ID. */
  static async connect(id: string): Promise<Beta9Sandbox> {
    return new Beta9Sandbox({ sandbox: await Sandbox.connect(id) });
  }

  /** Terminate the underlying Beta9 sandbox. */
  async terminate(): Promise<boolean> {
    return this.sandbox.terminate();
  }

  private async runSmall(command: string): Promise<string> {
    // Beta9 parses exec requests as argv; an explicit shell is needed for pipes and redirects.
    const process = await this.sandbox.exec(["sh", "-lc", command], { wait: true });
    const exitCode = await process.wait();
    const output = await process.stdout.read();
    if (exitCode !== 0) {
      const stderr = await process.stderr.read();
      throw new Error(`Beta9 helper exited ${exitCode}: ${stderr || output}`);
    }
    return output;
  }

  /** Read only bounded slices; a full file response can exceed Beta9's message limit. */
  private async readChunked(path: string): Promise<Buffer> {
    const metadata = await this.sandbox.fs.stat(path);
    if (metadata.isDir) throw new Error(`Is a directory: ${path}`);
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < metadata.size; offset += CHUNK_SIZE) {
      const block = offset / CHUNK_SIZE;
      const encoded = await this.runSmall(
        `dd if=${quote(path)} bs=${CHUNK_SIZE} skip=${block} count=1 status=none | base64 | tr -d '\\n'`,
      );
      const bytes = Buffer.from(encoded.trim(), "base64");
      const expected = Math.min(CHUNK_SIZE, metadata.size - offset);
      if (bytes.length !== expected) {
        throw new IncompleteFileReadError(
          `Incomplete Beta9 file read at byte ${offset}: expected ${expected}, got ${bytes.length}`,
        );
      }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, metadata.size);
  }

  async execute(command: string): Promise<ExecuteResponse> {
    const directory = `/tmp/deepagents-beta9-${randomUUID()}`;
    const outputPath = `${directory}/output`;
    const statusPath = `${directory}/status`;
    // The command runs in a subshell so even `exit` still writes its status.
    // Redirect before Beta9's exec API sees stdout; only bounded reads cross the gateway.
    const wrapped = `mkdir -p ${quote(directory)} && (sh -lc ${quote(command)}) > ${quote(outputPath)} 2>&1; rc=$?; printf '%s' "$rc" > ${quote(statusPath)}`;
    try {
      await this.runSmall(wrapped);
      const [content, status] = await Promise.all([
        this.readChunked(outputPath),
        this.sandbox.fs.readText(statusPath),
      ]);
      const exitCode = Number(status.trim());
      if (!Number.isInteger(exitCode)) throw new Error(`Invalid Beta9 exit status: ${status}`);
      return { output: content.toString("utf8"), exitCode, truncated: false };
    } finally {
      try {
        await this.runSmall(`rm -rf -- ${quote(directory)}`);
      } catch {
        // Preserve the original execution error if cleanup fails.
      }
    }
  }

  async uploadFiles(files: Array<[string, Uint8Array]>): Promise<FileUploadResponse[]> {
    const results: FileUploadResponse[] = [];
    for (const [path, content] of files) {
      try {
        await this.sandbox.fs.mkdir(dirname(path));
      } catch {
        // Parent may already exist. The write below reports real failures.
      }
      try {
        await this.sandbox.fs.writeBytes(path, content);
        results.push({ path, error: null });
      } catch (error) {
        results.push({ path, error: fileError(error) });
      }
    }
    return results;
  }

  async downloadFiles(paths: string[]): Promise<FileDownloadResponse[]> {
    const results: FileDownloadResponse[] = [];
    for (const path of paths) {
      try {
        results.push({ path, content: await this.readChunked(path), error: null });
      } catch (error) {
        if (error instanceof IncompleteFileReadError) throw error;
        results.push({ path, content: null, error: fileError(error) });
      }
    }
    return results;
  }
}

export { Image, Sandbox } from "@beamcloud/beam-js";
