// The BUILT engine Worker (dist/), started in a Worker whose OPFS is refused.
// Module order is evaluation order: the prelude patches the root first.
import "./refuse-opfs-prelude.js";
import "@gainratio/browser/worker";
