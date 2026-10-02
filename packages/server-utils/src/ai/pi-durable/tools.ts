import type { Span } from '@sentry/core';
import {
  captureException,
  isObjectLike,
  SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN,
  SPAN_STATUS_ERROR,
  startSpanManual,
  stringify,
  timestampInSeconds,
} from '@sentry/core';
import {
  GEN_AI_CONVERSATION_ID,
  GEN_AI_OPERATION_NAME,
  GEN_AI_TOOL_CALL_ARGUMENTS,
  GEN_AI_TOOL_CALL_RESULT,
  GEN_AI_TOOL_DESCRIPTION,
  GEN_AI_TOOL_NAME,
} from '@sentry/conventions/attributes';
import { GEN_AI_TOOL_CALL_ID_ATTRIBUTE } from '../core/gen-ai-attributes';
import type { GenAiOptions } from '../core/utils';
import { getGenAiSpanOp, resolveAIRecordingOptions } from '../core/utils';
import { piAiContentToString } from '../pi-ai/messages';
import {
  MAX_TRACKED_PI_RUNS,
  PI_CODING_TOOLS_EXTENSION,
  PI_DURABLE_ORIGIN,
  PI_TOOL_RESULT_ENTRY_KIND,
} from './constants';
import type { PiRuns, PiToolCall } from './runs';
import { toSentryConversationId } from './runs';
import type {
  PiAgent,
  PiCommitChange,
  PiEntryToken,
  PiTaskRuntime,
  PiTool,
  PiToolExecutionApi,
  PiToolResultMessage,
} from './types';
import { bound } from './utils';

/**
 * Prepare the runtime of a `pi.tool` phase. The tool task resolves the called tool from its agent,
 * so the runtime hands out traced tools, and it collects the result entries the phase commits.
 * `finish` ends the phase's tool spans with the result the model receives, which pi-durable builds
 * after `execute()` returns: from `api.output()`, through `afterTool` hooks and output limits.
 */
export function instrumentToolPhase(
  runtime: PiTaskRuntime,
  runs: PiRuns,
  wrapTool: (tool: PiTool) => PiTool,
): { runtime: PiTaskRuntime; finish: () => void } {
  const results = new Map<unknown, PiToolResultMessage>();
  runs.toolCalls.set(runtime.taskId, []);

  const agent = (context: unknown): Promise<PiAgent> =>
    runtime.agent(context).then(resolved => {
      if (!resolved?.tools) {
        return resolved;
      }
      markBuiltInTools(resolved, runs);
      return { ...resolved, tools: resolved.tools.map(wrapTool) };
    });

  const commit = (change: PiCommitChange, context: unknown): Promise<void> => {
    let committed: PiToolResultMessage[] = [];
    const observedChange: PiCommitChange = (tx, current) => {
      // A commit can run its change again, so only the attempt that committed counts.
      committed = [];
      return change(observeToolResultEntries(tx, committed), current);
    };
    return runtime.commit(observedChange, context).then(() => {
      for (const message of committed) {
        results.set(message.toolCallId, message);
      }
    });
  };

  return {
    runtime: new Proxy(runtime, {
      get(target, property) {
        if (property === 'agent') {
          return agent;
        }
        return property === 'commit' ? commit : bound(target, property);
      },
    }),
    finish: () => {
      for (const call of runs.toolCalls.get(runtime.taskId) ?? []) {
        finishToolCall(call, call.callId !== undefined ? results.get(call.callId) : undefined);
      }
      runs.toolCalls.delete(runtime.taskId);
    },
  };
}

/** Wrap a tool so each call gets a `gen_ai.execute_tool` span. */
export function instrumentTool(tool: PiTool, runs: PiRuns, options: GenAiOptions): PiTool {
  const execute = (args: unknown, api: PiToolExecutionApi, context: unknown): Promise<unknown> => {
    const { recordInputs, recordOutputs } = resolveAIRecordingOptions(options);
    const calls = runs.toolCalls.get(api?.taskId);

    return startSpanManual(
      {
        name: `execute_tool ${tool.name}`,
        op: getGenAiSpanOp('execute_tool'),
        attributes: {
          [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: PI_DURABLE_ORIGIN,
          [GEN_AI_OPERATION_NAME]: 'execute_tool',
          [GEN_AI_TOOL_NAME]: tool.name,
          ...(tool.description ? { [GEN_AI_TOOL_DESCRIPTION]: tool.description } : {}),
          ...(api?.callId ? { [GEN_AI_TOOL_CALL_ID_ATTRIBUTE]: api.callId } : {}),
          ...(api?.conversationId !== undefined
            ? { [GEN_AI_CONVERSATION_ID]: toSentryConversationId(runs, api.conversationId) }
            : {}),
          ...(recordInputs && args !== undefined ? { [GEN_AI_TOOL_CALL_ARGUMENTS]: stringify(args) } : {}),
        },
      },
      async span => {
        const call: PiToolCall = { span, callId: api?.callId, recordOutputs };
        calls?.push(call);
        try {
          const result = await tool.execute(args, trackOwnedConversations(api, span, runs), context);
          call.endTimestamp = timestampInSeconds();
          if (!calls) {
            // Called outside a tool task phase, so no result entry follows.
            finishToolCall(call, { content: result?.content, isError: result?.isError });
          }
          return result;
        } catch (error) {
          call.endTimestamp = timestampInSeconds();
          call.failed = true;
          // pi-durable turns the throw into an error result for the model, so nothing propagates to
          // the global handlers. An aborted call is not a failure, and the built-in tools throw to
          // report expected failures to the model.
          if ((context as { abortSignal?: AbortSignal } | undefined)?.abortSignal?.aborted) {
            span.setStatus({ code: SPAN_STATUS_ERROR, message: 'cancelled' });
          } else {
            span.setStatus({ code: SPAN_STATUS_ERROR, message: 'internal_error' });
            if (!runs.builtInTools.has(tool)) {
              captureException(error, { mechanism: { handled: true, type: PI_DURABLE_ORIGIN } });
            }
          }
          if (!calls) {
            span.end(call.endTimestamp);
          }
          throw error;
        }
      },
    );
  };

  return new Proxy(tool, {
    get(target, property) {
      return property === 'execute' ? execute : Reflect.get(target, property, target);
    },
  });
}

function finishToolCall(call: PiToolCall, message: PiToolResultMessage | undefined): void {
  if (message) {
    const result = call.recordOutputs ? piAiContentToString(message.content) : undefined;
    if (result) {
      call.span.setAttribute(GEN_AI_TOOL_CALL_RESULT, result);
    }
    if (message.isError && !call.failed) {
      call.span.setStatus({ code: SPAN_STATUS_ERROR, message: 'internal_error' });
    }
  }
  call.span.end(call.endTimestamp);
}

function observeToolResultEntries(tx: object, committed: PiToolResultMessage[]): object {
  return new Proxy(tx, {
    get(target, property) {
      const value = bound(target, property);
      if (property !== 'appendEntry' || typeof value !== 'function') {
        return value;
      }
      return (
        token: PiEntryToken,
        conversationId: unknown,
        draft: { model?: unknown[] } | undefined,
        ...rest: unknown[]
      ) => {
        const message = token?.kind === PI_TOOL_RESULT_ENTRY_KIND ? draft?.model?.[0] : undefined;
        if (isObjectLike(message)) {
          committed.push(message);
        }
        return value(token, conversationId, draft, ...rest);
      };
    },
  });
}

/**
 * Mark the resolved tools that come from the built-in `coding-tools` extension. A later
 * extension's tool replaces an earlier one with the same name, so a tool comes from the last
 * selected extension that has its name. A wrapper from another extension does not change that.
 */
function markBuiltInTools(agent: PiAgent, runs: PiRuns): void {
  const providers = new Map<string, string | undefined>();
  for (const extension of agent.extensions ?? []) {
    for (const tool of extension.tools ?? []) {
      providers.set(tool.name, extension.name);
    }
  }
  for (const tool of agent.tools ?? []) {
    if (providers.get(tool.name) === PI_CODING_TOOLS_EXTENSION) {
      runs.builtInTools.add(tool);
    }
  }
}

/**
 * Record the conversations a tool call creates for itself, the subagent pattern: `api.commit()` with
 * `tx.createConversation({ ownership: { kind: 'task', taskId: api.taskId } })`.
 */
function trackOwnedConversations(api: PiToolExecutionApi, span: Span, runs: PiRuns): PiToolExecutionApi {
  if (typeof api?.commit !== 'function') {
    return api;
  }
  const commit = api.commit.bind(api);

  const trackCreatedConversations = (tx: object): object =>
    new Proxy(tx, {
      get(target, property) {
        const value = bound(target, property);
        if (property !== 'createConversation' || typeof value !== 'function') {
          return value;
        }
        return async (createOptions: { ownership?: { kind?: string } }, ...rest: unknown[]) => {
          const record = (await value(createOptions, ...rest)) as { id?: unknown } | undefined;
          if (createOptions?.ownership?.kind === 'task' && record?.id !== undefined) {
            if (runs.owners.size >= MAX_TRACKED_PI_RUNS) {
              runs.owners.delete(runs.owners.keys().next().value);
            }
            runs.owners.set(record.id, span);
          }
          return record;
        };
      },
    });

  return new Proxy(api, {
    get(target, property) {
      if (property !== 'commit') {
        return Reflect.get(target, property, target);
      }
      return (change: (tx: object) => unknown, context: unknown) =>
        commit((tx: object) => change(trackCreatedConversations(tx)), context);
    },
  });
}
