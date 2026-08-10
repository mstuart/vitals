/**
 * `vitals serve` — delegates to the MCP server in `src/mcp/`.
 */

import { startMcpServer } from "../../mcp/server.js";
import type { Store } from "../../store/api.js";

export async function runServe(store: Store): Promise<void> {
  await startMcpServer(store);
}
