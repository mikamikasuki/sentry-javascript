import * as diagnosticsChannel from '../utils/diagnosticsChannel';
import type { IntegrationFn } from '@sentry/core';
import { debug, defineIntegration, isObjectLike } from '@sentry/core';
import type { PiDurableOptions } from '../ai/pi-durable';
import { instrumentPiDurableHarnessOptions } from '../ai/pi-durable';
import { PI_DURABLE_INTEGRATION_NAME } from '../ai/pi-durable/constants';
import type { PiHarnessOptions } from '../ai/pi-durable/types';
import { DEBUG_BUILD } from '../debug-build';
import { CHANNELS } from '../orchestrion/channels';
import { piDurableModuleNames } from '../orchestrion/config/pi-durable';
import { invokeOrchestrionInstrumentation } from '../orchestrion/instrumentation';

interface HarnessOpenChannelContext {
  arguments: unknown[];
}

const _piDurableIntegration = ((options: PiDurableOptions = {}) => {
  return {
    name: PI_DURABLE_INTEGRATION_NAME,
    setup(client) {
      // Subscribing opens no span; spans open later, inside task phases.
      invokeOrchestrionInstrumentation(client, piDurableModuleNames, instrumentPiDurable, [options], {
        requiresTracingChannelBinding: false,
      });
    },
  };
}) satisfies IntegrationFn;

function instrumentPiDurable(options: PiDurableOptions): void {
  diagnosticsChannel
    .tracingChannel<HarnessOpenChannelContext>(CHANNELS.PI_DURABLE_HARNESS_OPEN)
    .start.subscribe(message => {
      const args = (message as HarnessOpenChannelContext).arguments;
      try {
        if (args && isObjectLike(args[1])) {
          args[1] = instrumentPiDurableHarnessOptions(args[1] as PiHarnessOptions, options);
        }
      } catch (error) {
        DEBUG_BUILD && debug.error('[instrumentation:pi-durable] failed to instrument Harness options', error);
      }
    });
}

/**
 * Traces `@earendil-works/pi-durable` Harnesses: one `gen_ai.invoke_agent` span per run, with its
 * model requests as `gen_ai.chat` and its tool calls as `gen_ai.execute_tool` children.
 */
export const piDurableIntegration = defineIntegration(_piDurableIntegration);
