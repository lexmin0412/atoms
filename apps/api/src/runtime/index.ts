import type { Runtime } from '@atoms/shared';
import { SandboxRuntime } from './sandbox';

let instance: Runtime | null = null;

export function getRuntime(): Runtime {
  if (!instance) instance = new SandboxRuntime();
  return instance;
}

export { SandboxRuntime };
