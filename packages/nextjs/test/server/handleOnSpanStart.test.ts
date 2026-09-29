import { HTTP_ROUTE, SENTRY_OP } from '@sentry/conventions/attributes';
import type { Client } from '@sentry/core';
import { addChildSpanToSpan, SentrySpan, spanToStaticSpanJSON } from '@sentry/core';
import { describe, expect, it } from 'vitest';
import { handleOnSpanStart } from '../../src/server/handleOnSpanStart';

const client = { getOptions: () => ({}) } as unknown as Client;

describe('handleOnSpanStart', () => {
  it('names the root span after the middleware when Next.js started the root span', () => {
    const middlewareSpan = new SentrySpan({
      sampled: true,
      name: 'middleware GET',
      attributes: { 'next.span_type': 'Middleware.execute', 'next.span_name': 'middleware GET' },
    });

    handleOnSpanStart(middlewareSpan, client);

    const { description, data } = spanToStaticSpanJSON(middlewareSpan);
    expect(description).toBe('middleware GET');
    expect(data[HTTP_ROUTE]).toBe('middleware GET');
  });

  it('keeps the name of a root span that another SDK started and marks the middleware span', () => {
    const rootSpan = new SentrySpan({
      sampled: true,
      name: 'GET /api/endpoint',
      attributes: { 'http.request.method': 'GET' },
    });
    const middlewareSpan = new SentrySpan({
      sampled: true,
      name: 'middleware GET',
      attributes: { 'next.span_type': 'Middleware.execute', 'next.span_name': 'middleware GET' },
    });
    addChildSpanToSpan(rootSpan, middlewareSpan);

    handleOnSpanStart(middlewareSpan, client);

    const root = spanToStaticSpanJSON(rootSpan);
    expect(root.description).toBe('GET /api/endpoint');
    expect(root.data[HTTP_ROUTE]).toBeUndefined();
    expect(spanToStaticSpanJSON(middlewareSpan).data[SENTRY_OP]).toBe('middleware');
  });
});
