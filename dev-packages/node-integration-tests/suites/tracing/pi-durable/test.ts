import {
  GEN_AI_CONVERSATION_ID,
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OPERATION_NAME,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_SYSTEM_INSTRUCTIONS,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_TOOL_DEFINITIONS,
  GEN_AI_TOOL_NAME,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
} from '@sentry/conventions/attributes';
import { afterAll, expect } from 'vitest';
import { conditionalTest } from '../../../utils';
import { cleanupChildProcesses, createEsmAndCjsTests } from '../../../utils/runner';

// The pi packages declare `engines.node >= 22.19`, so they can't live in the package's root
// `devDependencies` (that would break `yarn install` on the 20.19 CI matrix). Install them per-suite
// instead, guarded by the `min: 22` skip below.
const PI_DURABLE_DEPENDENCIES = {
  additionalDependencies: {
    '@earendil-works/pi-durable': '^1.0.0',
    '@earendil-works/pi-ai': '^1.0.0',
    '@earendil-works/chord': '^1.0.0',
  },
};

conditionalTest({ min: 22 })('pi-durable integration', () => {
  afterAll(() => {
    cleanupChildProcesses();
  });

  createEsmAndCjsTests(
    __dirname,
    'scenario.mjs',
    'instrument.mjs',
    (createRunner, test, mode) => {
      // The pi packages are ESM-only: their `exports` maps have no `require` condition.
      if (mode === 'cjs') {
        return;
      }

      test('traces each run as its own invoke_agent trace with chat and execute_tool children', async () => {
        let toolRunTraceId: string | undefined;
        let brokenToolSpanId: string | undefined;
        let errorTraceId: string | undefined;
        let errorSpanId: string | undefined;
        const conversationIds: unknown[] = [];

        await createRunner()
          .unordered()
          .expect({
            span: container => {
              const spans = container.items;
              const agent = spans.find(span => span.is_segment)!;
              expect(agent.name).toBe('invoke_agent');
              expect(spans.filter(span => span.name === 'chat faux-model')).toHaveLength(2);

              expect(agent.attributes['sentry.op']?.value).toBe('gen_ai.invoke_agent');
              expect(agent.attributes['sentry.origin']?.value).toBe('auto.ai.pi_durable');
              expect(agent.attributes[GEN_AI_OPERATION_NAME]?.value).toBe('invoke_agent');
              const conversationId = agent.attributes[GEN_AI_CONVERSATION_ID]?.value;
              // The root conversation's id is `1` in every pi-durable storage, so it is prefixed
              // with a per-Harness id.
              expect(conversationId).toMatch(/^[0-9a-f]{32}:1$/);

              const chats = spans
                .filter(span => span.name === 'chat faux-model')
                .sort((a, b) => a.start_timestamp - b.start_timestamp);
              for (const chat of chats) {
                expect(chat.parent_span_id).toBe(agent.span_id);
                expect(chat.attributes['sentry.op']?.value).toBe('gen_ai.chat');
                expect(chat.attributes['sentry.origin']?.value).toBe('auto.ai.pi_durable');
                expect(chat.attributes[GEN_AI_PROVIDER_NAME]?.value).toBe('faux');
                expect(chat.attributes[GEN_AI_REQUEST_MODEL]?.value).toBe('faux-model');
                expect(chat.attributes[GEN_AI_CONVERSATION_ID]?.value).toBe(conversationId);
                expect(chat.attributes[GEN_AI_USAGE_INPUT_TOKENS]?.value).toBeGreaterThan(0);
                expect(chat.attributes[GEN_AI_USAGE_OUTPUT_TOKENS]?.value).toBeGreaterThan(0);
                // pi-durable sends the prompt and the tools as positional system messages.
                expect(chat.attributes[GEN_AI_SYSTEM_INSTRUCTIONS]?.value).toBe('You are a weather assistant.');
                expect(
                  JSON.parse(String(chat.attributes[GEN_AI_TOOL_DEFINITIONS]?.value)).map(
                    (tool: { name: string }) => tool.name,
                  ),
                ).toEqual(['get_weather', 'broken']);
              }

              // Mapped from pi-ai's shape to the conventions: the tool calls and tool results the
              // second request carries are what Sentry's conversation view renders.
              expect(JSON.parse(String(chats[0]!.attributes[GEN_AI_INPUT_MESSAGES]?.value))).toEqual([
                { role: 'user', parts: [{ type: 'text', content: 'What is the weather in Berlin?' }] },
              ]);
              const answerInput = JSON.parse(String(chats[1]!.attributes[GEN_AI_INPUT_MESSAGES]?.value));
              expect(answerInput.map((message: { role: string }) => message.role)).toEqual([
                'user',
                'assistant',
                'tool',
                'tool',
              ]);
              expect(answerInput[1].parts).toEqual([
                { type: 'tool_call', id: 'call_1', name: 'get_weather', arguments: '{"city":"Berlin"}' },
                { type: 'tool_call', id: 'call_2', name: 'broken', arguments: '{}' },
              ]);
              expect(answerInput[2].parts).toEqual([
                {
                  type: 'tool_call_response',
                  id: 'call_1',
                  name: 'get_weather',
                  result: 'It is 21 degrees and sunny in Berlin.',
                },
              ]);
              expect(chats.map(chat => chat.attributes[GEN_AI_RESPONSE_FINISH_REASONS]?.value).sort()).toEqual([
                '["stop"]',
                '["tool_call"]',
              ]);
              expect(chats.map(chat => chat.attributes[GEN_AI_OUTPUT_MESSAGES]?.value).join()).toContain(
                'It is 21 degrees and sunny in Berlin.',
              );

              const weather = spans.find(span => span.name === 'execute_tool get_weather')!;
              expect(weather.parent_span_id).toBe(agent.span_id);
              expect(weather.status).toBe('ok');
              expect(weather.attributes['sentry.op']?.value).toBe('gen_ai.execute_tool');
              expect(weather.attributes[GEN_AI_TOOL_NAME]?.value).toBe('get_weather');
              expect(weather.attributes['gen_ai.tool.call.id']?.value).toBe('call_1');
              expect(weather.attributes[GEN_AI_TOOL_CALL_ARGUMENTS]?.value).toBe('{"city":"Berlin"}');
              expect(weather.attributes[GEN_AI_TOOL_CALL_RESULT]?.value).toContain('sunny in Berlin');
              expect(weather.attributes[GEN_AI_CONVERSATION_ID]?.value).toBe(conversationId);

              const broken = spans.find(span => span.name === 'execute_tool broken')!;
              expect(broken.parent_span_id).toBe(agent.span_id);
              expect(broken.status).toBe('error');
              // The error result pi-durable gives the model, not the thrown error.
              expect(broken.attributes[GEN_AI_TOOL_CALL_RESULT]?.value).toContain('[error] broken tool');

              toolRunTraceId = agent.trace_id;
              brokenToolSpanId = broken.span_id;
              conversationIds.push(conversationId);
            },
          })
          .expect({
            span: container => {
              const spans = container.items;
              const agent = spans.find(span => span.is_segment)!;
              expect(agent.name).toBe('invoke_agent');
              expect(spans).toHaveLength(2);

              const chat = spans.find(span => span.name === 'chat faux-model')!;
              expect(chat.parent_span_id).toBe(agent.span_id);
              expect(chat.attributes[GEN_AI_OUTPUT_MESSAGES]?.value).toContain('Goodbye.');

              conversationIds.push(agent.attributes[GEN_AI_CONVERSATION_ID]?.value);
            },
          })
          .expect({
            span: container => {
              // The request that opened the Harness and submitted both inputs holds no agent work.
              expect(container.items).toHaveLength(1);
              expect(container.items[0]!.name).toBe('pi-durable-request');
            },
          })
          .expect({
            event: event => {
              const exception = event.exception?.values?.[0];
              expect(exception?.value).toBe('broken tool');
              expect(exception?.mechanism).toEqual({ type: 'auto.ai.pi_durable', handled: true });

              errorTraceId = event.contexts?.trace?.trace_id;
              errorSpanId = event.contexts?.trace?.span_id;
            },
          })
          .start()
          .completed();

        // Both runs belong to the root conversation, so they share one conversation id.
        expect(conversationIds).toHaveLength(2);
        expect(conversationIds[0]).toBe(conversationIds[1]);
        // The tool error is reported on the failing call's span, in the run's trace.
        expect(errorTraceId).toBe(toolRunTraceId);
        expect(errorSpanId).toBe(brokenToolSpanId);
      });
    },
    PI_DURABLE_DEPENDENCIES,
  );

  createEsmAndCjsTests(
    __dirname,
    'scenario-tools.mjs',
    'instrument.mjs',
    (createRunner, test, mode) => {
      if (mode === 'cjs') {
        return;
      }

      test('reports app tool failures but not failures of the built-in coding tools', async () => {
        // Ordered, with spans ignored: a captured failure of the built-in `bash` tool would be an
        // extra event before the sentinel, which the scenario sends once everything else is sent.
        await createRunner()
          .ignore('span')
          .expect({
            event: event => {
              expect(event.exception?.values?.[0]?.value).toBe('Intentional pi-durable tool failure');
            },
          })
          .expect({
            event: event => {
              expect(event.message).toBe('pi-durable tools done');
            },
          })
          .start()
          .completed();
      });

      test('records the tool result the model receives', async () => {
        let errorSpanId: string | undefined;
        let failingToolSpanId: string | undefined;

        await createRunner()
          .unordered()
          .expect({
            event: event => {
              const exception = event.exception?.values?.[0];
              expect(exception?.value).toBe('Intentional pi-durable tool failure');
              expect(exception?.mechanism).toEqual({ type: 'auto.ai.pi_durable', handled: true });
              errorSpanId = event.contexts?.trace?.span_id;
            },
          })
          .expect({
            span: container => {
              const spans = container.items;

              const bash = spans.find(span => span.name === 'execute_tool bash')!;
              expect(bash.status).toBe('error');
              expect(bash.attributes[GEN_AI_TOOL_CALL_RESULT]?.value).toMatch(/Command exited with code \d+/);

              // The streamed output becomes the result, since the tool returns no content.
              const streamer = spans.find(span => span.name === 'execute_tool streamer')!;
              expect(streamer.status).toBe('ok');
              expect(streamer.attributes[GEN_AI_TOOL_CALL_RESULT]?.value).toBe('line 1\nline 2\n');

              const secret = spans.find(span => span.name === 'execute_tool secret')!;
              expect(secret.attributes[GEN_AI_TOOL_CALL_RESULT]?.value).toBe('redacted by afterTool');

              const failNow = spans.find(span => span.name === 'execute_tool fail_now')!;
              expect(failNow.status).toBe('error');
              failingToolSpanId = failNow.span_id;
            },
          })
          .start()
          .completed();

        expect(errorSpanId).toBe(failingToolSpanId);
      });
    },
    PI_DURABLE_DEPENDENCIES,
  );

  createEsmAndCjsTests(
    __dirname,
    'scenario-reports.mjs',
    'instrument.mjs',
    (createRunner, test, mode) => {
      if (mode === 'cjs') {
        return;
      }

      test('captures failures pi-durable does not propagate, and tags idle compaction with its conversation', async () => {
        let runConversationId: unknown;
        let compactionConversationId: unknown;

        await createRunner()
          .unordered()
          .expect({
            event: event => {
              const exception = event.exception?.values?.[0];
              expect(exception?.value).toBe('afterResponse hook failed');
              expect(exception?.mechanism).toEqual({ type: 'auto.ai.pi_durable', handled: true });
            },
          })
          .expect({
            event: event => {
              const exception = event.exception?.values?.[0];
              expect(exception?.value).toBe('card declined');
              expect(exception?.mechanism).toEqual({ type: 'auto.ai.pi_durable', handled: false });
            },
          })
          .expect({
            span: container => {
              const agent = container.items.find(span => span.is_segment)!;
              expect(agent.name).toBe('invoke_agent');
              runConversationId = agent.attributes[GEN_AI_CONVERSATION_ID]?.value;
            },
          })
          .expect({
            span: container => {
              // A compaction started while idle belongs to no run, so its request is a trace of its own.
              expect(container.items).toHaveLength(1);
              const summary = container.items[0]!;
              expect(summary.is_segment).toBe(true);
              expect(summary.attributes['sentry.op']?.value).toBe('gen_ai.chat');
              compactionConversationId = summary.attributes[GEN_AI_CONVERSATION_ID]?.value;
            },
          })
          .start()
          .completed();

        expect(runConversationId).toMatch(/^[0-9a-f]{32}:1$/);
        expect(compactionConversationId).toBe(runConversationId);
      });
    },
    PI_DURABLE_DEPENDENCIES,
  );
});
