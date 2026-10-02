import type { Span } from '@sentry/core';
import { SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN, SPAN_STATUS_ERROR, startSpanManual, stringify } from '@sentry/core';
import {
  GEN_AI_INPUT_MESSAGES,
  GEN_AI_OPERATION_NAME,
  GEN_AI_OUTPUT_MESSAGES,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_REQUEST_MAX_TOKENS,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_REQUEST_REASONING_LEVEL,
  GEN_AI_REQUEST_TEMPERATURE,
  GEN_AI_RESPONSE_FINISH_REASONS,
  GEN_AI_RESPONSE_ID,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_RESPONSE_STREAMING,
  GEN_AI_SYSTEM_INSTRUCTIONS,
  GEN_AI_TOOL_DEFINITIONS,
} from '@sentry/conventions/attributes';
import type { GenAiOptions } from '../core/utils';
import { getGenAiSpanOp, resolveAIRecordingOptions } from '../core/utils';
import { setUsageAttributes } from '../flue/utils';
import {
  piAiAssistantMessageToGenAiMessage,
  piAiMessagesToGenAiMessages,
  piAiSystemInstructions,
  piAiToolDefinitions,
} from '../pi-ai/messages';
import { PI_DURABLE_ORIGIN } from './constants';
import type { PiAssistantMessage, PiContext, PiEventStream, PiModel, PiModels, PiStreamOptions } from './types';

type ModelCall = (model: PiModel, context: PiContext, options?: PiStreamOptions) => unknown;

const STREAMING_METHODS = new Set(['stream', 'streamSimple']);
const COMPLETE_METHODS = new Set(['complete', 'completeSimple']);

/**
 * Wrap a pi-ai `Models` so every model request it sends gets a `gen_ai.chat` span.
 *
 * The proxy hands every other member through bound to the original, so a `Models` instance whose
 * methods read `this` keeps working, and the caller's own object is never modified.
 */
export function instrumentPiModels<T extends PiModels>(models: T, options: GenAiOptions, onRequest: () => void): T {
  const wrapped = new Map<PropertyKey, unknown>();

  return new Proxy(models, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }

      const cached = wrapped.get(property);
      if (cached) {
        return cached;
      }

      const original = (value as ModelCall).bind(target);
      const streaming = STREAMING_METHODS.has(String(property));
      const instrumented =
        streaming || COMPLETE_METHODS.has(String(property))
          ? (model: PiModel, context: PiContext, callOptions?: PiStreamOptions): unknown => {
              onRequest();
              return traceModelRequest(model, context, callOptions, streaming, options, () =>
                original(model, context, callOptions),
              );
            }
          : original;

      wrapped.set(property, instrumented);
      return instrumented;
    },
  });
}

function traceModelRequest(
  model: PiModel,
  context: PiContext,
  callOptions: PiStreamOptions | undefined,
  streaming: boolean,
  options: GenAiOptions,
  send: () => unknown,
): unknown {
  // Read per request: `dataCollection.genAI` belongs to the current client, which can change.
  const { recordInputs, recordOutputs } = resolveAIRecordingOptions(options);

  return startSpanManual(
    {
      name: model.id ? `chat ${model.id}` : 'chat',
      op: getGenAiSpanOp('chat'),
      attributes: {
        [SEMANTIC_ATTRIBUTE_SENTRY_ORIGIN]: PI_DURABLE_ORIGIN,
        [GEN_AI_OPERATION_NAME]: 'chat',
        ...(model.provider ? { [GEN_AI_PROVIDER_NAME]: model.provider } : {}),
        ...(model.id ? { [GEN_AI_REQUEST_MODEL]: model.id } : {}),
        ...(streaming ? { [GEN_AI_RESPONSE_STREAMING]: true } : {}),
        ...(callOptions?.temperature !== undefined ? { [GEN_AI_REQUEST_TEMPERATURE]: callOptions.temperature } : {}),
        ...(callOptions?.maxTokens !== undefined ? { [GEN_AI_REQUEST_MAX_TOKENS]: callOptions.maxTokens } : {}),
        ...(callOptions?.reasoning ? { [GEN_AI_REQUEST_REASONING_LEVEL]: callOptions.reasoning } : {}),
        ...(recordInputs ? getRequestContentAttributes(context) : {}),
      },
    },
    span => {
      let result: unknown;
      try {
        result = send();
      } catch (error) {
        span.setStatus({ code: SPAN_STATUS_ERROR, message: 'internal_error' });
        span.end();
        throw error;
      }

      // pi-ai never rejects a request: a provider failure or an abort settles as a message with
      // `stopReason` `error` or `aborted`. The rejection handler only covers a broken provider.
      const settled = streaming ? (result as PiEventStream).result() : (result as Promise<PiAssistantMessage>);
      settled.then(
        message => endChatSpan(span, message, recordOutputs),
        () => {
          span.setStatus({ code: SPAN_STATUS_ERROR, message: 'internal_error' });
          span.end();
        },
      );

      return result;
    },
  );
}

function getRequestContentAttributes(context: PiContext): Record<string, string | undefined> {
  const messages = piAiMessagesToGenAiMessages(context.messages);
  const tools = piAiToolDefinitions(context);
  return {
    [GEN_AI_SYSTEM_INSTRUCTIONS]: piAiSystemInstructions(context),
    [GEN_AI_INPUT_MESSAGES]: messages.length ? stringify(messages) : undefined,
    [GEN_AI_TOOL_DEFINITIONS]: tools.length ? stringify(tools) : undefined,
  };
}

function endChatSpan(span: Span, message: PiAssistantMessage, recordOutputs: boolean): void {
  const responseModel = message.responseModel ?? message.model;
  if (responseModel) {
    span.setAttribute(GEN_AI_RESPONSE_MODEL, responseModel);
  }
  if (message.responseId) {
    span.setAttribute(GEN_AI_RESPONSE_ID, message.responseId);
  }

  const finishReason = toFinishReason(message.stopReason);
  if (finishReason) {
    span.setAttribute(GEN_AI_RESPONSE_FINISH_REASONS, stringify([finishReason]));
  }

  const failed = message.stopReason === 'error';
  setUsageAttributes(span, message.usage, failed);

  const output = recordOutputs ? piAiAssistantMessageToGenAiMessage(message, finishReason) : undefined;
  if (output) {
    span.setAttribute(GEN_AI_OUTPUT_MESSAGES, stringify([output], String));
  }

  if (failed) {
    span.setStatus({ code: SPAN_STATUS_ERROR, message: message.errorMessage ?? 'internal_error' });
  } else if (message.stopReason === 'aborted') {
    span.setStatus({ code: SPAN_STATUS_ERROR, message: 'cancelled' });
  }
  span.end();
}

/** pi-ai names a tool-calling stop `toolUse`; the conventions call it `tool_call`. */
function toFinishReason(stopReason: string | undefined): string | undefined {
  return stopReason === 'toolUse' ? 'tool_call' : stopReason;
}
