import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Span } from '@sentry/core';
import {
  _INTERNAL_clearAiProviderSkips,
  _INTERNAL_shouldSkipAiProviderWrapping,
  getMainCarrier,
  setCurrentClient,
  spanToStaticSpanJSON,
} from '@sentry/core';
import { instrumentPiDurableHarnessOptions } from '../../../../src/ai/pi-durable';
import type {
  PiCommitChange,
  PiHarnessOptions,
  PiLiveState,
  PiModels,
  PiRegistryReader,
  PiTask,
  PiTaskRuntime,
} from '../../../../src/ai/pi-durable/types';
import { OPENAI_INTEGRATION_NAME } from '../../../../src/ai/openai/constants';
import { getDefaultTestClientOptions, TestClient } from '../../../mocks/client';

const LIVE_DOC = { definition: { kind: 'pi.live' } };

describe('instrumentPiDurableHarnessOptions', () => {
  let endedSpans: Span[];
  let client: TestClient;

  beforeEach(() => {
    _INTERNAL_clearAiProviderSkips();
    getMainCarrier().__SENTRY__ = undefined;
    client = new TestClient(
      getDefaultTestClientOptions({ dsn: 'https://public@dsn.ingest.sentry.io/1337', tracesSampleRate: 1 }),
    );
    setCurrentClient(client);
    client.init();

    endedSpans = [];
    client.on('spanEnd', span => endedSpans.push(span));
  });

  afterEach(() => {
    _INTERNAL_clearAiProviderSkips();
    getMainCarrier().__SENTRY__ = undefined;
  });

  it('wraps the options once and leaves the caller objects untouched', () => {
    const models = { completeSimple: async () => ({}) };
    const options: PiHarnessOptions = { models };

    const instrumented = instrumentPiDurableHarnessOptions(options);

    expect(instrumented).not.toBe(options);
    expect(instrumented.models).not.toBe(models);
    expect(options.models).toBe(models);
    expect(instrumentPiDurableHarnessOptions(instrumented)).toBe(instrumented);
  });

  it('hands members other than model requests through, bound to the original', () => {
    class Models {
      private _provider = 'faux';
      public getProvider(): string {
        return this._provider;
      }
    }

    const instrumented = instrumentPiDurableHarnessOptions({ models: new Models() as PiModels });

    expect((instrumented.models as unknown as Models).getProvider()).toBe('faux');
    expect(endedSpans).toHaveLength(0);
  });

  it('traces a streamed model request and skips the provider SDK integrations', async () => {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Paris.' }],
      model: 'faux-model',
      usage: { input: 10, output: 2, totalTokens: 12 },
      stopReason: 'stop',
    };
    const models: PiModels = { streamSimple: () => ({ result: async () => message }) };
    const instrumented = instrumentPiDurableHarnessOptions({ models });

    await instrumented.models!.streamSimple!(
      { id: 'faux-model', provider: 'faux' },
      { messages: [{ role: 'user', content: 'Capital of France?' }] },
    ).result();

    expect(_INTERNAL_shouldSkipAiProviderWrapping(OPENAI_INTEGRATION_NAME)).toBe(true);
    const chat = spanToStaticSpanJSON(endedSpans[0]!);
    expect(chat.description).toBe('chat faux-model');
    expect(chat.op).toBe('gen_ai.chat');
    expect(chat.data).toMatchObject({
      'gen_ai.provider.name': 'faux',
      'gen_ai.request.model': 'faux-model',
      'gen_ai.response.streaming': true,
      'gen_ai.response.finish_reasons': '["stop"]',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 2,
    });
    expect(chat.data['gen_ai.input.messages']).toBe(
      '[{"role":"user","parts":[{"type":"text","content":"Capital of France?"}]}]',
    );
    expect(chat.data['gen_ai.output.messages']).toBe(
      '[{"role":"assistant","parts":[{"type":"text","content":"Paris."}],"finish_reason":"stop"}]',
    );
  });

  it('reads the system prompt and the tools from the positional system messages', async () => {
    const models: PiModels = {
      streamSimple: () => ({ result: async () => ({ role: 'assistant', content: [], stopReason: 'stop' }) }),
    };
    const instrumented = instrumentPiDurableHarnessOptions({ models });

    // pi-durable never sets `systemPrompt` or `tools`: it sends prompt sections and tool changes as
    // system messages, and each request replays them.
    await instrumented.models!.streamSimple!(
      { id: 'faux-model', provider: 'faux' },
      {
        messages: [
          {
            role: 'system',
            content: '',
            sections: { preamble: 'You help.' },
            toolsAdded: [{ name: 'read' }, { name: 'bash' }],
          },
          { role: 'user', content: 'Hi.' },
          { role: 'system', content: '', sections: { mode: 'Plan only.' }, toolsRemoved: [{ name: 'bash' }] },
        ],
      },
    ).result();

    const chat = spanToStaticSpanJSON(endedSpans[0]!);
    expect(chat.data['gen_ai.system_instructions']).toBe('You help.\n\nPlan only.');
    expect(chat.data['gen_ai.tool.definitions']).toBe('[{"name":"read"}]');
    expect(chat.data['gen_ai.input.messages']).toBe('[{"role":"user","parts":[{"type":"text","content":"Hi."}]}]');
  });

  it('captures the failures pi-durable reports and still hands them to the caller', async () => {
    const reported: unknown[] = [];
    const instrumented = instrumentPiDurableHarnessOptions({ onReport: error => reported.push(error) });
    const error = new Error('afterResponse hook failed');

    instrumented.onReport!(error);
    await client.flush();

    expect(reported).toEqual([error]);
    expect(client.event?.exception?.values?.[0]?.value).toBe('afterResponse hook failed');
    expect(client.event?.exception?.values?.[0]?.mechanism).toEqual({ type: 'auto.ai.pi_durable', handled: true });
  });

  it('returns the same wrapped task for the same definition in every snapshot', () => {
    const generation: PiTask = { definition: { name: 'pi.generation', phases: { prepare: async () => undefined } } };
    const registry: PiRegistryReader = {
      // A new snapshot object per call, as pi-durable publishes one per registry change.
      snapshot: () => ({ task: () => generation, tasks: () => [generation] }),
      subscribe: () => () => undefined,
    };

    const instrumented = instrumentPiDurableHarnessOptions({ registry }).registry!;

    const first = instrumented.snapshot().task('pi.generation');
    expect(first).not.toBe(generation);
    expect(instrumented.snapshot().task('pi.generation')).toBe(first);
    expect(instrumented.snapshot().tasks()[0]).toBe(first);
  });

  describe('runs', () => {
    /** A generation phase that commits each of `states` as the `pi.live` document, in order. */
    function generationPhase(states: (PiLiveState | 'settle-failed')[]): PiTask {
      return {
        definition: {
          name: 'pi.generation',
          phases: {
            request: async (_task, runtime) => {
              for (const state of states) {
                await runtime.commit(async tx => {
                  const draft = (await (tx as { doc: (...args: unknown[]) => Promise<PiLiveState> }).doc(LIVE_DOC, 1))!;
                  if (state === 'settle-failed') {
                    (tx as { settleSubmission: (...args: unknown[]) => void }).settleSubmission(5, {
                      status: 'unanswered',
                      reason: 'model_error',
                    });
                    delete draft.run;
                  } else {
                    draft.run = state.run;
                  }
                  return undefined;
                }, undefined);
              }
            },
          },
        },
      };
    }

    async function runPhase(task: PiTask): Promise<void> {
      const live: PiLiveState = {};
      const tx = { doc: async () => live, settleSubmission: () => undefined };
      const runtime: PiTaskRuntime = {
        taskId: 3,
        conversationId: 1,
        agent: async () => ({}),
        commit: async (change: PiCommitChange) => {
          await change(tx, undefined);
        },
      };
      const registry: PiRegistryReader = {
        snapshot: () => ({ task: () => task, tasks: () => [task] }),
        subscribe: () => () => undefined,
      };

      const instrumented = instrumentPiDurableHarnessOptions({ registry }).registry!;
      await instrumented.snapshot().task('pi.generation')!.definition.phases.request!(undefined, runtime, undefined);
    }

    it('keeps the run open while run control moves to the next generation', async () => {
      await runPhase(generationPhase([{ run: { inputs: [5] } }, { run: { inputs: [5, 6] } }]));

      expect(endedSpans.filter(span => spanToStaticSpanJSON(span).op === 'gen_ai.invoke_agent')).toHaveLength(0);
    });

    it('ends the run with the settlement of its first input', async () => {
      await runPhase(generationPhase([{ run: { inputs: [5] } }, 'settle-failed']));

      const runs = endedSpans.map(span => spanToStaticSpanJSON(span)).filter(span => span.op === 'gen_ai.invoke_agent');
      expect(runs).toHaveLength(1);
      // The settlement reason is not a span status value, so the status reads as `internal_error`.
      expect(runs[0]!.status).toBe('internal_error');
      expect(runs[0]!.data['gen_ai.conversation.id']).toMatch(/^[0-9a-f]{32}:1$/);
    });

    it('ends the run when a queued input starts the next run in the same commit', async () => {
      await runPhase(generationPhase([{ run: { inputs: [5] } }, { run: { inputs: [7] } }]));

      const runs = endedSpans.map(span => spanToStaticSpanJSON(span)).filter(span => span.op === 'gen_ai.invoke_agent');
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe('ok');
    });
  });
});
