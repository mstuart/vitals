#!/usr/bin/env node
/**
 * vitals — command surface. Parses args, opens the Store, calls into
 * cli/commands/*.ts, and prints. All rendering logic lives in format.ts /
 * the command modules so it stays testable without spawning this process.
 *
 * Exit codes: 0 normal; 1 when `--quiet` fires flags; 2 on VitalsError.
 */
import { Command } from "commander";
import { VitalsError } from "../types.js";
import { runAuth } from "./commands/auth.js";
import { runBody } from "./commands/body.js";
import { openDefaultStore } from "./commands/context.js";
import { runHeart } from "./commands/heart.js";
import { runNote } from "./commands/note.js";
import { runPull } from "./commands/pull.js";
import { runServe } from "./commands/serve.js";
import { runSleep } from "./commands/sleep.js";
import { runToday } from "./commands/today.js";
import { runWeek } from "./commands/week.js";
import { formatCheckinConfirmation } from "./format.js";

function collectTag(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function printResult(output: string): void {
  if (output.length > 0) {
    process.stdout.write(`${output}\n`);
  }
}

function handleError(err: unknown): void {
  if (err instanceof VitalsError) {
    process.stderr.write(`${err.message}\n`);
    if (err.hint) {
      process.stderr.write(`${err.hint}\n`);
    }
    process.exitCode = 2;
    return;
  }
  console.error(err);
  process.exitCode = 2;
}

async function main(): Promise<void> {
  const program = new Command();
  // Without this, a `--json` (or any flag) declared on both the root
  // program and a subcommand is consumed by the root's definition and never
  // reaches the subcommand's own options object.
  program.enablePositionalOptions();

  program
    .name("vitals")
    .description(
      "Local-first archive and baseline-deviation detector for Google Health API v4 data"
    )
    .option("--quiet", "alerts only; silent when clear, exit 1 when flags fire")
    .option("--json", "structured JSON output")
    .action((opts: { quiet?: boolean; json?: boolean }) => {
      const store = openDefaultStore();
      try {
        const { output, exitCode } = runToday(store, opts);
        printResult(output);
        process.exitCode = exitCode;
      } finally {
        store.close();
      }
    });

  program
    .command("sleep")
    .description("Recent sleep sessions")
    .option("--days <n>", "lookback window in days", "14")
    .option("--json", "structured JSON output")
    .action((opts: { days: string; json?: boolean }) => {
      const store = openDefaultStore();
      try {
        printResult(runSleep(store, opts));
      } finally {
        store.close();
      }
    });

  program
    .command("heart")
    .description("Resting heart rate and HRV over time")
    .option("--days <n>", "lookback window in days", "14")
    .option("--json", "structured JSON output")
    .action((opts: { days: string; json?: boolean }) => {
      const store = openDefaultStore();
      try {
        printResult(runHeart(store, opts));
      } finally {
        store.close();
      }
    });

  program
    .command("body")
    .description("Weight and body fat over time")
    .option("--days <n>", "lookback window in days", "30")
    .option("--json", "structured JSON output")
    .action((opts: { days: string; json?: boolean }) => {
      const store = openDefaultStore();
      try {
        printResult(runBody(store, opts));
      } finally {
        store.close();
      }
    });

  program
    .command("pull")
    .description("Sync data from the Google Health API")
    .option("--since <duration>", "pull window, e.g. 30d, 4w, 2026-06-01")
    .option("--full", "ignore watermarks and re-pull the full window")
    .action(async (opts: { since?: string; full?: boolean }) => {
      const store = openDefaultStore();
      try {
        const { output, exitCode } = await runPull(store, opts);
        printResult(output);
        process.exitCode = exitCode;
      } finally {
        store.close();
      }
    });

  program
    .command("note")
    .description("Log a subjective check-in")
    .requiredOption("--mood <n>", "mood, integer 1-10")
    .option("--tag <tag>", "tag, repeatable", collectTag, [] as string[])
    .argument("[text...]", "free text note")
    .action((text: string[], opts: { mood: string; tag: string[] }) => {
      const store = openDefaultStore();
      try {
        const checkin = runNote(store, {
          mood: opts.mood,
          tag: opts.tag,
          text,
        });
        printResult(formatCheckinConfirmation(checkin));
      } finally {
        store.close();
      }
    });

  program
    .command("week")
    .description("Weekly health report")
    .option("--json", "structured JSON output")
    .action((opts: { json?: boolean }) => {
      const store = openDefaultStore();
      try {
        printResult(runWeek(store, opts));
      } finally {
        store.close();
      }
    });

  program
    .command("auth")
    .description("Connect vitals to your Google account")
    .option("--client-id <id>", "Google OAuth client id (or GOOGLE_CLIENT_ID)")
    .option(
      "--client-secret <secret>",
      "Google OAuth client secret (or GOOGLE_CLIENT_SECRET)"
    )
    .action(async (opts: { clientId?: string; clientSecret?: string }) => {
      printResult(await runAuth(opts));
    });

  program
    .command("serve")
    .description("Run the MCP server")
    .action(async () => {
      const store = openDefaultStore();
      await runServe(store);
    });

  await program.parseAsync(process.argv);
}

main().catch(handleError);
