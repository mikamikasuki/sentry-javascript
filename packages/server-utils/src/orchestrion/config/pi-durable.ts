import type { InstrumentationConfig } from '../apmTypes';

import { getModuleNames } from './module-names';

// `Harness.open(storage, options, context)` is a method of the exported `Harness` object literal, the
// one entry point to a Harness. Its `options` carry the `models` and `registry` every model request
// and task phase goes through, so wrapping them at `start` covers the whole Harness.
export const piDurableConfig = [
  {
    channelName: 'harnessOpen',
    module: {
      name: '@earendil-works/pi-durable',
      versionRange: '>=1.0.0 <2.0.0',
      filePath: 'dist/harness/harness.js',
    },
    functionQuery: { methodName: 'open', kind: 'Async' as const },
  },
] satisfies InstrumentationConfig[];

export const piDurableModuleNames = getModuleNames(piDurableConfig);

export const piDurableChannels = {
  PI_DURABLE_HARNESS_OPEN: 'orchestrion:@earendil-works/pi-durable:harnessOpen',
} as const;
