import type { Runtime } from '@atoms/shared';

import { SandboxRuntime } from './sandbox';

let instance: Runtime | null = null;

export function getRuntime(): Runtime {
  if (!instance) instance = new SandboxRuntime();
  return instance;
}

export function getSandboxRuntime(): SandboxRuntime {
  if (!(instance instanceof SandboxRuntime)) instance = new SandboxRuntime();
  return instance as SandboxRuntime;
}

export { SandboxRuntime };
