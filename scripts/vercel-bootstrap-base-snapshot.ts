/**
 * Bootstrap a fresh Vercel Sandbox base snapshot from a vanilla Amazon Linux
 * 2023 image (no starting snapshot required). Use this when self-hosting on a
 * Vercel team that does not own the upstream demo snapshot referenced in
 * `apps/web/lib/sandbox/config.ts` — `Sandbox.create()` returns 404 in that
 * case because snapshots are team-scoped.
 *
 * Authentication: this script calls the Vercel Sandbox API via @vercel/sandbox,
 * which authenticates with VERCEL_OIDC_TOKEN (preferred) or with a Vercel
 * access token (VERCEL_TOKEN + VERCEL_TEAM_ID + VERCEL_PROJECT_ID). The
 * easiest way to populate these locally is:
 *
 *     vercel link
 *     vercel env pull .env.development.local
 *     # then export the vars from that file before running this script
 *
 * Default install set is intentionally lean (bun + jq + ripgrep) so the
 * snapshot is fast to build. Layer chromium / agent-browser / code-server on
 * top with `bun run sandbox:snapshot-base -- --from <new-snap> --command "..."`
 * once this initial snapshot exists.
 *
 * Usage:
 *   bun run scripts/vercel-bootstrap-base-snapshot.ts
 *   bun run scripts/vercel-bootstrap-base-snapshot.ts --command "sudo dnf install -y ripgrep"
 *   bun run scripts/vercel-bootstrap-base-snapshot.ts --no-defaults --command "..." --command "..."
 */

import { connectSandbox } from "@open-agents/sandbox";
import {
  DEFAULT_SANDBOX_PORTS,
  DEFAULT_SANDBOX_TIMEOUT_MS,
} from "../apps/web/lib/sandbox/config";

const DEFAULT_BOOTSTRAP_SANDBOX_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_BOOTSTRAP_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;

const DEFAULT_BOOTSTRAP_COMMANDS = [
  "sudo dnf install -y jq ripgrep",
  "curl -fsSL https://bun.sh/install | bash",
  // Make `bun` resolvable in non-interactive shells used by the agent.
  "sudo ln -sf $HOME/.bun/bin/bun /usr/local/bin/bun",
  "bun --version",
  "jq --version",
  "rg --version",
];

interface CliOptions {
  sandboxTimeoutMs: number;
  commandTimeoutMs: number;
  extraCommands: string[];
  useDefaults: boolean;
}

interface HelpResult {
  help: true;
}

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/vercel-bootstrap-base-snapshot.ts
  bun run scripts/vercel-bootstrap-base-snapshot.ts --command "sudo dnf install -y ripgrep"
  bun run scripts/vercel-bootstrap-base-snapshot.ts --no-defaults --command "..."

Options:
  --command <shell-command>    Extra command to run during bootstrap. Repeatable.
  --no-defaults                Skip the default bun + jq + ripgrep install set.
  --sandbox-timeout-ms <ms>    Sandbox lifetime for the bootstrap run (default ${DEFAULT_BOOTSTRAP_SANDBOX_TIMEOUT_MS}).
  --command-timeout-ms <ms>    Per-command timeout (default ${DEFAULT_BOOTSTRAP_COMMAND_TIMEOUT_MS}).
  --help                       Show this message.

Default install set:
${DEFAULT_BOOTSTRAP_COMMANDS.map((c) => `  - ${c}`).join("\n")}`);
}

function requireOptionValue(
  argv: string[],
  index: number,
  option: string,
): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${option}.`);
  }
  return value;
}

function parsePositiveNumber(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${option}: ${value}`);
  }
  return parsed;
}

function parseArgs(argv: string[]): CliOptions | HelpResult {
  let sandboxTimeoutMs = DEFAULT_BOOTSTRAP_SANDBOX_TIMEOUT_MS;
  let commandTimeoutMs = DEFAULT_BOOTSTRAP_COMMAND_TIMEOUT_MS;
  const extraCommands: string[] = [];
  let useDefaults = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }

    if (arg === "--no-defaults") {
      useDefaults = false;
      continue;
    }

    if (arg === "--command") {
      extraCommands.push(requireOptionValue(argv, index, arg));
      index += 1;
      continue;
    }

    if (arg === "--sandbox-timeout-ms") {
      sandboxTimeoutMs = parsePositiveNumber(
        requireOptionValue(argv, index, arg),
        arg,
      );
      index += 1;
      continue;
    }

    if (arg === "--command-timeout-ms") {
      commandTimeoutMs = parsePositiveNumber(
        requireOptionValue(argv, index, arg),
        arg,
      );
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { sandboxTimeoutMs, commandTimeoutMs, extraCommands, useDefaults };
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ("help" in parsed) {
    printUsage();
    return;
  }

  const commands = [
    ...(parsed.useDefaults ? DEFAULT_BOOTSTRAP_COMMANDS : []),
    ...parsed.extraCommands,
  ];

  if (commands.length === 0) {
    throw new Error(
      "No commands to run. Pass --command, or omit --no-defaults to use the default install set.",
    );
  }

  console.log(
    `Creating vanilla sandbox (timeout ${parsed.sandboxTimeoutMs}ms, ports ${DEFAULT_SANDBOX_PORTS.join(", ")}).`,
  );

  const sandboxTimeoutMs = Math.min(
    parsed.sandboxTimeoutMs,
    DEFAULT_SANDBOX_TIMEOUT_MS * 6,
  );

  const sandbox = await connectSandbox({
    state: { type: "vercel" },
    options: {
      timeout: sandboxTimeoutMs,
      persistent: false,
      skipGitWorkspaceBootstrap: true,
      ports: DEFAULT_SANDBOX_PORTS,
    },
  });

  if (!sandbox.snapshot) {
    throw new Error("Configured sandbox provider does not support snapshots.");
  }

  let snapshotCreated = false;

  try {
    for (const [index, command] of commands.entries()) {
      console.log(`[${index + 1}/${commands.length}] $ ${command}`);

      const result = await sandbox.exec(
        command,
        sandbox.workingDirectory,
        parsed.commandTimeoutMs,
      );

      if (result.stdout.trim()) {
        console.log(result.stdout.trim());
      }
      if (result.stderr.trim()) {
        console.error(result.stderr.trim());
      }

      if (!result.success) {
        throw new Error(
          `Command failed (exit ${result.exitCode ?? "n/a"}): ${command}`,
        );
      }
    }

    console.log("Creating snapshot from prepared sandbox.");
    const snapshot = await sandbox.snapshot();
    snapshotCreated = true;

    console.log("");
    console.log(`New base snapshot id: ${snapshot.snapshotId}`);
    console.log("");
    console.log("Set this in your Vercel project Environment Variables:");
    console.log(`  VERCEL_SANDBOX_BASE_SNAPSHOT_ID=${snapshot.snapshotId}`);
    console.log("then redeploy.");
  } finally {
    if (!snapshotCreated) {
      try {
        await sandbox.stop();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to stop bootstrap sandbox: ${message}`);
      }
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
