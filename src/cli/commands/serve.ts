/**
 * `vitals serve` — delegates to the MCP server in `src/mcp/`.
 */
import type { Store } from '../../store/api.js';
import { startMcpServer } from '../../mcp/server.js';

export async function runServe(store: Store): Promise<void> {
  await startMcpServer(store);
}
