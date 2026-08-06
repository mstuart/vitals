/**
 * MCP server exposing the vitals archive over stdio.
 *
 * Wires the tool handlers in `tools.ts` — which contain all the actual
 * logic and are unit-tested directly against a `Store` — into
 * `@modelcontextprotocol/sdk`'s `McpServer` + `StdioServerTransport`. This
 * file itself has no logic beyond that wiring, so it is exercised through
 * the handlers' own tests rather than directly.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { Store } from '../store/api.js';
import {
  vitalsBody,
  vitalsBodyInputSchema,
  vitalsCoverage,
  vitalsCoverageInputSchema,
  vitalsHeart,
  vitalsHeartInputSchema,
  vitalsLogCheckin,
  vitalsLogCheckinInputSchema,
  vitalsSleep,
  vitalsSleepInputSchema,
  vitalsToday,
  vitalsTodayInputSchema,
  vitalsWeeklyReport,
  vitalsWeeklyReportInputSchema,
} from './tools.js';

const SERVER_NAME = 'vitals';
const SERVER_VERSION = '0.1.0';

export async function startMcpServer(store: Store): Promise<void> {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'vitals_today',
    {
      title: "Today's summary",
      description:
        "Today's DailySummary: rhr/hrv/spo2/resp-rate/skin-temp snapshots, sleep, checkin, and any threshold flags.",
      inputSchema: vitalsTodayInputSchema.shape,
    },
    (args) => vitalsToday(store, args),
  );

  server.registerTool(
    'vitals_sleep',
    {
      title: 'Sleep sessions',
      description: 'Sleep sessions over a date range.',
      inputSchema: vitalsSleepInputSchema.shape,
    },
    (args) => vitalsSleep(store, args),
  );

  server.registerTool(
    'vitals_heart',
    {
      title: 'Heart rate series',
      description: 'Resting heart rate and HRV daily series, with rolling baselines and trend.',
      inputSchema: vitalsHeartInputSchema.shape,
    },
    (args) => vitalsHeart(store, args),
  );

  server.registerTool(
    'vitals_body',
    {
      title: 'Body composition series',
      description: 'Weight and body fat percentage daily series.',
      inputSchema: vitalsBodyInputSchema.shape,
    },
    (args) => vitalsBody(store, args),
  );

  server.registerTool(
    'vitals_weekly_report',
    {
      title: 'Weekly health report',
      description: 'The rendered weekly health report text.',
      inputSchema: vitalsWeeklyReportInputSchema.shape,
    },
    (args) => vitalsWeeklyReport(store, args),
  );

  server.registerTool(
    'vitals_log_checkin',
    {
      title: 'Log a check-in',
      description: 'Record a subjective check-in: mood (1-10), an optional note, and tags.',
      inputSchema: vitalsLogCheckinInputSchema.shape,
    },
    (args) => vitalsLogCheckin(store, args),
  );

  server.registerTool(
    'vitals_coverage',
    {
      title: 'Archive coverage',
      description:
        'The date range the local archive actually holds data for. Google drops continuous SpO2 after ~12 days and sleep stages after ~13 nights, so an absent day is not necessarily a zero — check coverage before assuming one.',
      inputSchema: vitalsCoverageInputSchema.shape,
    },
    (args) => vitalsCoverage(store, args),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
