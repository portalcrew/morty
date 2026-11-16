import type { AdapterResolver } from "../../src/engine/acp/native-history/preview-contract.ts";
import { ControlledAcpAdapter } from "./controlled-acp-adapter.ts";

export const acpAdapters: AdapterResolver = (agent, dependencies) => new ControlledAcpAdapter(agent, dependencies);
