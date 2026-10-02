import type { Scope } from '@sentry/core';
import { getDefaultCurrentScope, withIsolationScope, withScope } from '@sentry/core';

/** Read a member with `this` bound to the original, so getters and methods that use `this` keep working. */
export function bound(target: object, property: PropertyKey): unknown {
  const value: unknown = Reflect.get(target, property, target);
  return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
}

/**
 * Run `callback` with `isolationScope` and a fresh copy of the default current scope. A forked
 * scope would carry over the data of whatever async context last woke the scheduler, such as
 * another conversation's id.
 */
export function withCleanScopes<T>(isolationScope: Scope, callback: () => T): T {
  return withIsolationScope(isolationScope, () => withScope(getDefaultCurrentScope().clone(), callback));
}
