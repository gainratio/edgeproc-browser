import type { EngineClientOptions } from "./client.js";
import { EngineClient } from "./client.js";
/**
 * Spawn the packaged module Worker for direct browser ESM deployments.
 *
 * Bundled applications should keep a one-line Worker entry in consumer source
 * that imports `@gainratio/browser/worker`, then inject it into `EngineClient`.
 * Keeping this URL in an opt-in subpath prevents ordinary client imports from
 * making bundlers emit an unused second Worker asset.
 */
export declare function spawnEngineClient(options?: EngineClientOptions): EngineClient;
//# sourceMappingURL=spawn.d.ts.map